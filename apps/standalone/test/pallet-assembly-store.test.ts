import { buildPalletLabelTemplates, buildSscc } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";

import { applyPalletRegistryPage } from "../src/floor/pallet-assembly/registry.js";
import {
  readPalletAssemblyCloseIssues,
  reconcilePalletAssemblyCloseIssue,
} from "../src/floor/pallet-assembly/reconcile.js";
import { sendPalletAssemblyBatch } from "../src/floor/pallet-assembly/sender.js";
import { createPalletAssemblyStore } from "../src/floor/pallet-assembly/store.js";
import { countUnsentRecords } from "../src/local/outbox.js";
import { noteRestoreEpoch, reconcileRestore } from "../src/local/restore-reconcile.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { OPERATOR_ID } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { seedWarehouseCopies } from "./support/warehouse.js";

const AT = "2026-11-11T08:00:00.000Z";
const PREFIX = "460068200";
const FIRST = buildSscc(0, PREFIX, 1);
const SECOND = buildSscc(0, PREFIX, 2);
const THIRD = buildSscc(0, PREFIX, 3);
const OTHER = buildSscc(0, PREFIX, 4);
const OWNER = { hostId: HOST_ID, deviceId: DEVICE_ID };

const [template] = buildPalletLabelTemplates();
if (template === undefined) throw new Error("pallet template missing");

function fixture(lots: readonly (string | null)[] = []) {
  const { db, executor: local } = openLocalDb();
  seedWarehouseCopies(db);
  const product = db.prepare(
    "INSERT INTO ref_products (id, gtin14, name, archived, status, rev) VALUES (?, '04600682000013', ?, 0, 'active', 1)",
  );
  product.run("product", "Молоко");
  product.run("other", "Кефир");
  db.prepare("INSERT INTO floor_sscc_blocks VALUES ('block', ?, ?, ?, 1, 40, 50, 40, ?)").run(
    HOST_ID,
    DEVICE_ID,
    PREFIX,
    AT,
  );
  const now = () => new Date(AT);
  const store = () =>
    createPalletAssemblyStore({ local, pairing: OWNER, operatorId: OPERATOR_ID, now });
  const load = () =>
    applyPalletRegistryPage(
      local,
      OWNER,
      {
        until: AT,
        canOpenPallets: true,
        lotNumbersSupported: lots.length !== 0,
        items: [
          { sscc: FIRST, shiftNumber: "1", productId: "product", productionDate: "2026-11-10" },
          { sscc: SECOND, shiftNumber: "2", productId: "product", productionDate: "2026-11-11" },
          { sscc: THIRD, shiftNumber: "2", productId: "other", productionDate: "2026-11-11" },
        ].map((item, index) => ({
          kind: "upsert",
          updatedAt: AT,
          closedAt: AT,
          bottleCount: 12,
          ...item,
          ...(lots[index] == null ? {} : { lotNumber: lots[index] }),
        })),
      },
      { full: true, first: true, now: new Date(AT) },
    );
  return { db, local, now, store, load };
}

describe("warehouse pallet assembly", () => {
  it("freezes one product from different shifts and a unique SSCC, with mixed dates blank", async () => {
    const { db, store, load } = fixture();
    await expect(store().add(FIRST)).resolves.toEqual({ kind: "registry_required" });
    await load();
    const added = await store().add(FIRST);
    if (added.kind !== "added") throw new Error(added.kind);
    await expect(store().add(FIRST)).resolves.toEqual({ kind: "duplicate" });
    await expect(store().add(THIRD)).resolves.toEqual({ kind: "different_product" });
    await expect(store().add(OTHER)).resolves.toEqual({ kind: "unknown_box" });
    await expect(store().add(SECOND)).resolves.toMatchObject({ kind: "added" });
    const closes = await Promise.all([
      store().close(added.pallet.id, PREFIX, template.spec),
      store().close(added.pallet.id, PREFIX, template.spec),
    ]);
    expect(closes.filter(({ kind }) => kind === "closed")).toHaveLength(1);
    expect(db.prepare("SELECT next_serial FROM floor_sscc_blocks").get()?.["next_serial"]).toBe(41);
    await expect(store().get(added.pallet.id)).resolves.toMatchObject({
      sscc: buildSscc(1, PREFIX, 40),
      label: { boxCount: 2, itemCount: 24, productionDate: null },
      boxes: [
        { sscc: FIRST, shiftNumber: "1" },
        { sscc: SECOND, shiftNumber: "2" },
      ],
    });
  });

  it.each([
    [["0042Бк07A", "0042Бк07A"], "0042Бк07A", false],
    [["0042Бк07A", "0042Бк07A"], "0042Бк07A", true],
    [["0042Бк07A", "0042БК07A"], undefined, false],
    [["0042Бк07A", null], undefined, false],
  ] as const)(
    "freezes the lot across source shifts only when every box has the same value",
    async (lots, expected, refreshing) => {
      const { db, store, load } = fixture(lots);
      await load();
      const added = await store().add(FIRST);
      if (added.kind !== "added") throw new Error(added.kind);
      await store().add(SECOND);
      if (refreshing) db.exec("DELETE FROM pallet_registry_state");
      const result = await store().close(added.pallet.id, PREFIX, template.spec);
      expect(result.kind).toBe("closed");
      expect((await store().get(added.pallet.id))?.label?.lotNumber).toBe(expected);
      expect(
        db
          .prepare(
            "SELECT payload -> '$.data.lotNumber' AS lot FROM pallet_assembly_outbox WHERE kind = 'warehouse_pallet_closed'",
          )
          .get()?.["lot"],
      ).toBe(JSON.stringify(expected ?? null));
    },
  );

  it("recovers a started print as uncertain and requires an explicit retry", async () => {
    const { store, load } = fixture();
    await load();
    const added = await store().add(FIRST);
    if (added.kind !== "added") throw new Error(added.kind);
    const id = added.pallet.id;
    await store().close(id, PREFIX, template.spec);
    await expect(store().startPrint(id, 0)).resolves.toBe(true);
    await store().recoverPrints([id]);
    await expect(store().get(id)).resolves.toMatchObject({ printState: "printing" });
    await store().recoverPrints([]);
    await expect(store().deferPrint(id)).resolves.toBe(true);
    await expect(store().get(id)).resolves.toMatchObject({ printState: "unknown", deferred: true });
    await expect(store().startPrint(id, 0)).resolves.toBe(false);
    await expect(store().startPrint(id, 0, true)).resolves.toBe(true);
    await expect(store().finishPrint(id, "sent")).resolves.toBe(true);
    await expect(store().confirmPrint(id, 0)).resolves.toBe(true);
    await expect(store().read()).resolves.toMatchObject({ pendingLabels: [] });
  });

  it("keeps rejected receipts visible and never sends a later pallet past a rejected close", async () => {
    const { store, load, local, now } = fixture();
    await load();
    const first = await store().add(FIRST);
    if (first.kind !== "added") throw new Error(first.kind);
    await store().close(first.pallet.id, PREFIX, template.spec);
    const second = await store().add(SECOND);
    if (second.kind !== "added") throw new Error(second.kind);
    const send = vi.fn(async (records: readonly unknown[]) =>
      records.map((_record, index) =>
        index === 0
          ? { id: null, outcome: "accepted" as const }
          : {
              id: null,
              outcome: "rejected" as const,
              code: index === 1 ? "box_on_pallet" : "pallet_count_mismatch",
              details: { palletSscc: buildSscc(1, PREFIX, 43) },
            },
      ),
    );
    await sendPalletAssemblyBatch(local, OWNER, send, now);
    await sendPalletAssemblyBatch(local, OWNER, send, now);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toHaveLength(3);
    await expect(store().read()).resolves.toMatchObject({
      open: { id: second.pallet.id },
      conflicts: expect.arrayContaining([
        expect.objectContaining({ boxSscc: FIRST, winningPalletSscc: buildSscc(1, PREFIX, 43) }),
        expect.objectContaining({ palletId: first.pallet.id, blocksAssembly: true }),
      ]),
    });
    await expect(store().add(THIRD)).resolves.toEqual({ kind: "blocked" });
  });

  it("sends an office-approved replacement close before later pallets and freezes the corrected label", async () => {
    const { store, load, local, now } = fixture();
    await load();
    const first = await store().add(FIRST);
    if (first.kind !== "added") throw new Error(first.kind);
    const id = first.pallet.id;
    await store().add(SECOND);
    await store().close(id, PREFIX, template.spec);
    await store().startPrint(id, 0);
    await store().finishPrint(id, "sent");
    await store().confirmPrint(id, 0);
    await store().add(THIRD);
    await sendPalletAssemblyBatch(
      local,
      OWNER,
      async (records) =>
        records.map((_record, index) => {
          if (index < 3) return { id: null, outcome: "accepted" };
          return {
            id: null,
            outcome: "rejected",
            code: "pallet_count_mismatch",
            details: { closeIssueId: "issue" },
          };
        }),
      now,
    );
    await expect(readPalletAssemblyCloseIssues(local, OWNER)).resolves.toEqual(["issue"]);
    await expect(
      reconcilePalletAssemblyCloseIssue(
        local,
        OWNER,
        {
          id: "issue",
          palletId: id,
          sscc: buildSscc(1, PREFIX, 40),
          code: "pallet_count_mismatch",
          status: "approved",
          reportedBoxes: 2,
          currentBoxes: 1,
          currentBoxSsccs: [FIRST],
          approvedBoxes: 1,
          approvedBoxSsccs: [FIRST],
          createdAt: AT,
        },
        now,
      ),
    ).resolves.toBe(true);
    await expect(store().get(id)).resolves.toMatchObject({
      printState: "confirmed",
      label: { boxCount: 2 },
      boxes: [{ sscc: FIRST }, { sscc: SECOND }],
    });
    await expect(store().startPrint(id, 0)).resolves.toBe(false);
    const send = vi.fn(async (records: readonly unknown[]) =>
      records.map(() => ({ id: null, outcome: "accepted" as const })),
    );
    await expect(sendPalletAssemblyBatch(local, OWNER, send, now)).resolves.toMatchObject({
      sent: 1,
      more: true,
    });
    expect(send.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        kind: "warehouse_pallet_closed",
        data: expect.objectContaining({
          palletId: id,
          boxCount: 1,
          sscc: buildSscc(1, PREFIX, 40),
        }),
      }),
    ]);
    await expect(store().get(id)).resolves.toMatchObject({
      printState: "pending",
      deferred: true,
      syncState: "accepted",
      labelVersion: 1,
      isCorrection: true,
      label: { boxCount: 1, itemCount: 12, productionDate: "2026-11-10" },
      boxes: [{ sscc: FIRST }],
    });
    await expect(readPalletAssemblyCloseIssues(local, OWNER)).resolves.toEqual([]);
    await expect(store().startPrint(id, 0)).resolves.toBe(false);
    await expect(store().startPrint(id, 1)).resolves.toBe(true);
    await expect(store().finishPrint(id, "sent")).resolves.toBe(true);
    await expect(store().confirmPrint(id, 0)).resolves.toBe(false);
    await expect(store().confirmPrint(id, 1, true)).resolves.toBe(false);
    await expect(store().confirmPrint(id, 1)).resolves.toBe(true);
  });

  it("allows re-adding after an unsent removal on the same pallet but refuses foreign ownership", async () => {
    const { store, load, local } = fixture();
    await load();
    const first = await store().add(FIRST);
    if (first.kind !== "added") throw new Error(first.kind);
    const id = first.pallet.id;
    await applyPalletRegistryPage(
      local,
      OWNER,
      {
        until: AT,
        canOpenPallets: true,
        items: [
          {
            sscc: FIRST,
            kind: "upsert",
            productId: "product",
            closedAt: AT,
            updatedAt: AT,
            palletId: id,
            palletActive: true,
          },
          {
            sscc: SECOND,
            kind: "upsert",
            productId: "product",
            closedAt: AT,
            updatedAt: AT,
            palletId: "foreign",
            palletActive: true,
          },
        ],
      },
      { first: true, full: false },
    );
    await expect(store().remove(id, FIRST)).resolves.toBe(true);
    await expect(store().add(SECOND)).resolves.toEqual({ kind: "occupied", palletSscc: null });
    await expect(store().add(FIRST)).resolves.toMatchObject({ kind: "added", pallet: { id } });
  });

  it("keeps a rejected draft's close reachable for office reconciliation while later pallets wait", async () => {
    const { store, load, local, now } = fixture();
    await load();
    const first = await store().add(FIRST);
    if (first.kind !== "added") throw new Error(first.kind);
    const id = first.pallet.id;
    await store().close(id, PREFIX, template.spec);
    await store().add(THIRD);
    // Simulate a batch ending immediately after open, e.g. the original add
    // was created in an earlier send from the floor before the close.
    await local.transaction([
      {
        sql:
          "UPDATE pallet_assembly_outbox SET acked_at = ?, outcome = 'rejected', outcome_code = 'feature_disabled' " +
          "WHERE pallet_id = ? AND kind = 'warehouse_pallet_opened'",
        values: [AT, id],
      },
    ]);
    const send = vi.fn(async (records: readonly unknown[]) =>
      records.map(() => ({
        id: null,
        outcome: "rejected" as const,
        code: "pallet_unknown",
        details: { closeIssueId: "issue" },
      })),
    );
    await expect(sendPalletAssemblyBatch(local, OWNER, send, now)).resolves.toEqual({
      sent: 1,
      more: false,
    });
    expect(send.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ kind: "warehouse_pallet_closed" }),
    ]);
    await expect(store().abandonOpenConflict(id)).resolves.toBe(false);
    await expect(
      reconcilePalletAssemblyCloseIssue(
        local,
        OWNER,
        {
          id: "issue",
          palletId: id,
          sscc: buildSscc(1, PREFIX, 40),
          code: "pallet_unknown",
          status: "cancelled",
          reportedBoxes: 1,
          currentBoxes: 0,
          currentBoxSsccs: [],
          createdAt: AT,
        },
        now,
      ),
    ).resolves.toBe(true);
    await expect(store().get(id)).resolves.toMatchObject({
      cancelled: true,
      label: { boxCount: 1 },
    });
    await expect(store().startPrint(id, 0)).resolves.toBe(false);
    await expect(countUnsentRecords(local, OWNER)).resolves.toBe(2);
  });

  it("replays a restored pallet's older prerequisite events and keeps the physical print confirmation", async () => {
    const { store, load, local, now } = fixture();
    await load();
    const first = await store().add(FIRST);
    if (first.kind !== "added") throw new Error(first.kind);
    const id = first.pallet.id;
    await store().close(id, PREFIX, template.spec);
    await store().startPrint(id, 0);
    await store().finishPrint(id, "sent");
    await store().confirmPrint(id, 0);
    const send = vi.fn(async (records: readonly unknown[]) =>
      records.map(() => ({ id: null, outcome: "accepted" as const })),
    );
    await sendPalletAssemblyBatch(local, OWNER, send, now);
    await sendPalletAssemblyBatch(local, OWNER, send, now);
    await local.transaction([
      {
        sql: "UPDATE pallet_assembly_outbox SET acked_at = '2026-08-01T00:00:00.000Z' WHERE kind = 'warehouse_pallet_opened'",
      },
    ]);
    await noteRestoreEpoch(local, OWNER, "epoch", now());
    await reconcileRestore({
      local,
      pairing: OWNER,
      now,
      register: async () => ({
        results: [{ id: "block", outcome: "known", code: null }],
      }),
    });
    await expect(countUnsentRecords(local, OWNER)).resolves.toBe(4);
    await sendPalletAssemblyBatch(local, OWNER, send, now);
    await sendPalletAssemblyBatch(local, OWNER, send, now);
    expect(send.mock.calls[2]?.[0]).toEqual(send.mock.calls[0]?.[0]);
    expect(send.mock.calls[3]?.[0]).toEqual(send.mock.calls[1]?.[0]);
    await expect(store().get(id)).resolves.toMatchObject({
      printState: "confirmed",
      syncState: "accepted",
    });
  });

  it("replays a rejected close lost to restore before delivering any later pallet", async () => {
    const { store, load, local, now } = fixture();
    await load();
    const first = await store().add(FIRST);
    if (first.kind !== "added") throw new Error(first.kind);
    const id = first.pallet.id;
    await store().close(id, PREFIX, template.spec, [FIRST]);
    await store().add(THIRD);
    const failedClose = (issueId: string) =>
      vi.fn(async (records: readonly unknown[]) =>
        records.map((_record, index) =>
          index < 2
            ? { id: null, outcome: "accepted" as const }
            : {
                id: null,
                outcome: "rejected" as const,
                code: "pallet_count_mismatch",
                details: { closeIssueId: issueId },
              },
        ),
      );
    const initial = failedClose("first-issue");
    await sendPalletAssemblyBatch(local, OWNER, initial, now);
    await noteRestoreEpoch(local, OWNER, "new-epoch", now());
    await reconcileRestore({
      local,
      pairing: OWNER,
      now,
      register: async () => ({
        results: [{ id: "block", outcome: "known", code: null }],
      }),
    });
    await expect(readPalletAssemblyCloseIssues(local, OWNER)).resolves.toEqual([]);
    await expect(store().add(SECOND)).resolves.toEqual({ kind: "blocked" });
    const replay = failedClose("restored-issue");
    await expect(sendPalletAssemblyBatch(local, OWNER, replay, now)).resolves.toEqual({
      sent: 3,
      more: false,
    });
    expect(replay.mock.calls[0]?.[0]).toEqual(initial.mock.calls[0]?.[0]);
    await expect(readPalletAssemblyCloseIssues(local, OWNER)).resolves.toEqual(["restored-issue"]);
  });

  it("refuses to close a composition changed after the operator confirmed it", async () => {
    const { store, load, db } = fixture();
    await load();
    const first = await store().add(FIRST);
    if (first.kind !== "added") throw new Error(first.kind);
    const id = first.pallet.id;
    await store().add(SECOND);
    await store().remove(id, SECOND);
    await expect(store().close(id, PREFIX, template.spec, [FIRST, SECOND])).resolves.toEqual({
      kind: "stale",
    });
    expect(db.prepare("SELECT next_serial FROM floor_sscc_blocks").get()?.["next_serial"]).toBe(40);
  });

  it("does not mistake a delayed pre-close registry page for a release", async () => {
    const { store, load, local, now } = fixture();
    await load();
    const first = await store().add(FIRST);
    if (first.kind !== "added") throw new Error(first.kind);
    await store().close(first.pallet.id, PREFIX, template.spec, [FIRST]);
    await sendPalletAssemblyBatch(
      local,
      OWNER,
      async (records) => records.map(() => ({ id: null, outcome: "accepted" })),
      now,
    );
    const free = {
      until: AT,
      canOpenPallets: true,
      items: [
        { sscc: FIRST, kind: "upsert" as const, productId: "product", closedAt: AT, updatedAt: AT },
      ],
    };
    const later = new Date(now().getTime() + 1000);
    await applyPalletRegistryPage(local, OWNER, free, {
      first: true,
      full: false,
      startedAt: new Date(now().getTime() - 1000),
      now: later,
    });
    await expect(store().add(FIRST)).resolves.toEqual({
      kind: "occupied",
      palletSscc: buildSscc(1, PREFIX, 40),
    });
    await applyPalletRegistryPage(local, OWNER, free, {
      first: true,
      full: false,
      startedAt: later,
      now: later,
    });
    await expect(store().add(FIRST)).resolves.toMatchObject({ kind: "added" });
  });
});
