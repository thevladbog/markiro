import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VALIDATION_REPROCESSING_PROTOCOL, productLabelValueDigest } from "@markiro/domain";
import { StationApiError } from "../src/lib/api-client.js";
import {
  applyValidationOutcomes,
  readValidationProcessingState,
  readValidationRejectionReason,
  reconcileValidationOccurrences,
  refreshValidationHistory,
} from "../src/lib/validation-reprocessing.js";
import { openProductLabelWork } from "./support/product-label-work.js";
import { productLabelAcceptanceFixture, seedProductLabelShift } from "./support/product-labels.js";
import { recordProductLabelAcceptance } from "../src/lib/product-labels/acceptance.js";
import { readProductLabelJob } from "../src/lib/product-labels/store.js";
import {
  sendPreparedProductLabel,
  prepareProductLabelReprint,
  verifyProductLabel,
} from "../src/lib/product-labels/printing.js";
import type { ValidationCodeHistory } from "@markiro/domain";
const handles: Awaited<ReturnType<typeof openProductLabelWork>>[] = [];
async function fixture() {
  const h = await openProductLabelWork("none");
  handles.push(h);
  return h;
}
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
function history(
  shiftId: string,
  productId: string,
  patch: Partial<ValidationCodeHistory> = {},
): ValidationCodeHistory {
  return {
    protocol: VALIDATION_REPROCESSING_PROTOCOL,
    shiftId,
    productId,
    snapshot: "a".repeat(64),
    fetchedAt: "2026-09-12T10:00:00.000Z",
    expiresAt: "2026-09-12T11:00:00.000Z",
    nextCursor: null,
    complete: true,
    items: [],
    ...patch,
  };
}
describe("durable validation reprocessing", () => {
  it.each(["closed", "active", "absent"])(
    "trusts confirmed original closure with local source %s",
    async (localStatus) => {
      const h = await fixture();
      await sendPreparedProductLabel(h.deps, h.input.jobId);
      const before = await h.exec.all("SELECT * FROM product_label_jobs WHERE job_id=?", [
        h.input.jobId,
      ]);
      const next = productLabelAcceptanceFixture({ allowPreviouslyAcceptedCodes: true });
      await seedProductLabelShift(h.exec, next);
      const [shift] = await h.exec.all<{ product_id: string }>(
        "SELECT product_id FROM shift_mirror WHERE id=?",
        [next.shiftId],
      );
      if (!shift) throw new Error("Missing shift");
      await refreshValidationHistory(
        h.exec,
        {
          get: vi.fn().mockResolvedValue(
            history(next.shiftId, shift.product_id, {
              items: [
                {
                  codeHash: h.input.codeHash,
                  kind: "original",
                  shiftId: h.input.shiftId,
                  shiftNumber: "SOURCE",
                  shiftStatus: "closed",
                  scannedAt: h.input.acceptedAt,
                },
              ],
            }),
          ),
        },
        next.shiftId,
        shift.product_id,
      );
      if (localStatus === "absent")
        await h.exec.run("DELETE FROM shift_mirror WHERE id=?", [h.input.shiftId]);
      else
        await h.exec.run("UPDATE shift_mirror SET status=? WHERE id=?", [
          localStatus,
          h.input.shiftId,
        ]);
      expect(await readValidationRejectionReason(h.exec, next.shiftId, next.codeHash)).toBe(
        "unconfirmed",
      );
      expect(await recordProductLabelAcceptance(h.exec, next)).toEqual({
        status: "accepted",
        jobId: next.jobId,
      });

      expect(
        await h.exec.all("SELECT * FROM product_label_jobs WHERE job_id=?", [h.input.jobId]),
      ).toEqual(before);
      expect(await h.exec.all("SELECT shift_id FROM codes_mirror")).toEqual([
        { shift_id: h.input.shiftId },
      ]);
      expect(
        await h.exec.all("SELECT * FROM product_label_jobs WHERE shift_id=?", [next.shiftId]),
      ).toHaveLength(1);
    },
  );

  it.each(["false-policy", "unknown-closure", "independent-active"])(
    "refuses %s without a fresh job despite source history",
    async (condition) => {
      const h = await fixture();
      await sendPreparedProductLabel(h.deps, h.input.jobId);
      const next = productLabelAcceptanceFixture({
        allowPreviouslyAcceptedCodes: condition !== "false-policy",
      });
      await seedProductLabelShift(h.exec, next);
      const [shift] = await h.exec.all<{ product_id: string }>(
        "SELECT product_id FROM shift_mirror WHERE id=?",
        [next.shiftId],
      );
      if (!shift) throw new Error("Missing shift");
      const items: ValidationCodeHistory["items"] =
        condition === "unknown-closure"
          ? []
          : [
              {
                codeHash: h.input.codeHash,
                kind: "original",
                shiftId: h.input.shiftId,
                shiftNumber: "SOURCE",
                shiftStatus: "closed",
                scannedAt: h.input.acceptedAt,
              },
            ];
      if (condition === "independent-active") {
        const other = randomUUID();
        await h.exec.run(
          "INSERT INTO validation_occurrences(shift_id,code_hash,scanned_at,credential_ownership,terminal_id,operator_id,source_shift_id,canonical_raw,outcome) VALUES(?,?,?,?,?,?,?,?,'reprocessed')",
          [
            other,
            h.input.codeHash,
            h.input.acceptedAt,
            h.input.credentialOwnership,
            h.input.terminalId,
            h.input.operatorId,
            h.input.shiftId,
            h.input.canonicalRaw,
          ],
        );
        await h.exec.run("DELETE FROM codes_mirror");
      }
      await refreshValidationHistory(
        h.exec,
        { get: vi.fn().mockResolvedValue(history(next.shiftId, shift.product_id, { items })) },
        next.shiftId,
        shift.product_id,
      );
      expect(await recordProductLabelAcceptance(h.exec, next)).toEqual({ status: "duplicate" });
      expect(await readValidationRejectionReason(h.exec, next.shiftId, next.codeHash)).toBe(
        condition === "false-policy" ? "previous" : "active",
      );
      expect(
        await h.exec.all("SELECT * FROM product_label_jobs WHERE shift_id=?", [next.shiftId]),
      ).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "never projects a released historical ordinary receipt after restart and stale replay (tentative repeat=%s)",
    async (tentativeRepeat) => {
      const h = await openProductLabelWork("none", undefined, false, false, true);
      handles.push(h);
      const source = randomUUID();
      if (tentativeRepeat)
        await h.exec.run(
          "INSERT INTO validation_code_history(shift_id,code_hash,kind,source_shift_id,shift_number,shift_status,scanned_at) VALUES(?,?,'original',?,'OLD','closed',?)",
          [h.input.shiftId, h.input.codeHash, source, h.input.acceptedAt],
        );
      await recordProductLabelAcceptance(h.exec, h.input);
      const jobs = await h.exec.all("SELECT * FROM product_label_jobs");
      const queue = await h.exec.all("SELECT * FROM outbox");
      expect((await readValidationProcessingState(h.exec, h.input.shiftId)).processed).toBe(1);
      const receipt = {
        shiftId: h.input.shiftId,
        codeHash: h.input.codeHash,
        scannedAt: h.input.acceptedAt,
        outcome: "first_accepted" as const,
        ownership: "released" as const,
      };
      await applyValidationOutcomes(h.exec, "unrelated-credential-owner", [receipt]);
      await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
        { ...receipt, scannedAt: new Date(Date.parse(receipt.scannedAt) + 1000).toISOString() },
      ]);
      expect((await readValidationProcessingState(h.exec, h.input.shiftId)).processed).toBe(1);
      await expect(
        applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
          { ...receipt, outcome: "reprocessed" },
        ]),
      ).rejects.toThrow();
      await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [receipt]);
      expect(await h.exec.all("SELECT * FROM codes_mirror")).toHaveLength(0);
      expect((await readValidationProcessingState(h.exec, h.input.shiftId)).processed).toBe(0);
      h.restart();
      const { ownership: omitted, ...stale } = receipt;
      void omitted;
      await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
        stale,
        { ...stale, outcome: "pending" },
        { ...stale, outcome: "reprocessed" },
      ]);
      expect(await h.exec.all("SELECT * FROM codes_mirror")).toHaveLength(0);
      expect((await readValidationProcessingState(h.exec, h.input.shiftId)).processed).toBe(0);
      expect(await readValidationRejectionReason(h.exec, h.input.shiftId, h.input.codeHash)).toBe(
        "current",
      );
      expect(await h.exec.all("SELECT * FROM product_label_jobs")).toEqual(jobs);
      expect(await h.exec.all("SELECT * FROM outbox")).toEqual(queue);
      const otherShift = randomUUID();
      await h.exec.run(
        "INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at) VALUES(?,?,?,?,?)",
        [h.input.codeHash, otherShift, h.input.gtin14, h.input.serial, h.input.acceptedAt],
      );
      await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [receipt]);
      expect(await h.exec.all("SELECT shift_id FROM codes_mirror")).toEqual([
        { shift_id: otherShift },
      ]);
      await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
        { ...stale, outcome: "conflict" },
      ]);
      expect((await readValidationProcessingState(h.exec, h.input.shiftId)).conflicts).toBe(1);
      expect(await h.exec.all("SELECT shift_id FROM codes_mirror")).toEqual([
        { shift_id: otherShift },
      ]);
    },
  );

  it("recovers an unknown repeat print after restart and reprints the same bytes without another unit", async () => {
    const h = await openProductLabelWork("none", undefined, false, false, true);
    handles.push(h);
    const source = randomUUID();
    await h.exec.run(
      "INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at) VALUES(?,?,?,?,?)",
      [h.input.codeHash, source, h.input.gtin14, h.input.serial, "2026-09-01T00:00:00.000Z"],
    );
    await h.exec.run(
      "INSERT INTO validation_code_history(shift_id,code_hash,kind,source_shift_id,shift_number,shift_status,scanned_at) VALUES(?,?,'original',?,'OLD','closed',?)",
      [h.input.shiftId, h.input.codeHash, source, "2026-09-01T00:00:00.000Z"],
    );
    await recordProductLabelAcceptance(h.exec, h.input);
    h.print.mockRejectedValueOnce(new Error("reply lost after print"));
    expect((await sendPreparedProductLabel(h.deps, h.input.jobId)).attemptState).toBe(
      "delivery_unknown",
    );
    h.restart();
    expect((await readValidationProcessingState(h.exec, h.input.shiftId)).processed).toBe(1);
    expect(
      await verifyProductLabel(h.exec, {
        ...h.actor,
        jobId: h.input.jobId,
        attemptId: h.input.preparedEvent.attemptId,
        credentialOwnership: h.input.credentialOwnership,
        raw: h.input.raw,
      }),
    ).toBe("match");
    await prepareProductLabelReprint(h.exec, {
      ...h.actor,
      shiftId: h.input.shiftId,
      jobId: h.input.jobId,
      credentialOwnership: h.input.credentialOwnership,
      reason: "damaged",
    });
    await sendPreparedProductLabel(h.deps, h.input.jobId);
    expect(h.print).toHaveBeenCalledTimes(2);
    expect(h.print.mock.calls[0]?.[1]).toEqual(h.print.mock.calls[1]?.[1]);
    expect(await h.exec.all("SELECT shift_id FROM codes_mirror")).toEqual([{ shift_id: source }]);
    expect((await readValidationProcessingState(h.exec, h.input.shiftId)).processed).toBe(1);
    await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
      {
        shiftId: h.input.shiftId,
        codeHash: h.input.codeHash,
        scannedAt: h.input.acceptedAt,
        outcome: "reprocessed",
      },
    ]);
    await h.exec.run("DELETE FROM codes_mirror");
    expect((await readValidationProcessingState(h.exec, h.input.shiftId)).processed).toBe(1);
  });

  it("backfills the effective legacy acceptance after an old release and reacceptance", async () => {
    const h = await fixture();
    await sendPreparedProductLabel(h.deps, h.input.jobId);
    await h.exec.run("DELETE FROM codes_mirror");
    await h.exec.run("DELETE FROM validation_occurrences");
    const laterAt = "2026-09-09T00:00:00.000Z";
    const jobId = randomUUID();
    const later = {
      ...h.input,
      jobId,
      acceptedAt: laterAt,
      preparedEvent: {
        ...h.input.preparedEvent,
        jobId,
        eventId: randomUUID(),
        attemptId: randomUUID(),
        acceptedAt: laterAt,
        occurredAt: laterAt,
      },
    };
    await recordProductLabelAcceptance(h.exec, later);
    // Simulate the pre-migration state: both immutable historical commands exist, only the later registry owner is effective.
    await h.exec.run("DELETE FROM validation_occurrences");
    const backfill = STATION_MIGRATIONS.find((sql) =>
      sql.startsWith("INSERT INTO validation_occurrences"),
    );
    if (!backfill) throw new Error("Missing occurrence backfill");
    await h.exec.run(backfill);
    expect(await h.exec.all("SELECT scanned_at FROM validation_occurrences")).toEqual([
      { scanned_at: laterAt },
    ]);
    expect((await sendPreparedProductLabel(h.deps, later.jobId)).attemptState).toBe("sent");
    expect(await h.exec.all("SELECT * FROM product_label_accept_commands")).toHaveLength(2);
  });

  it.each([
    { pendingReceipt: false, allowPreviouslyAcceptedCodes: false },
    { pendingReceipt: false, allowPreviouslyAcceptedCodes: true },
    { pendingReceipt: true, allowPreviouslyAcceptedCodes: false },
    { pendingReceipt: true, allowPreviouslyAcceptedCodes: true },
  ])(
    "allows new intake after an active shift releases ordinary ownership: %j",
    async ({ pendingReceipt, allowPreviouslyAcceptedCodes }) => {
      const h = await fixture();
      await sendPreparedProductLabel(h.deps, h.input.jobId);
      const identity = {
        shiftId: h.input.shiftId,
        codeHash: h.input.codeHash,
        scannedAt: h.input.acceptedAt,
      };
      await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
        { ...identity, outcome: "first_accepted" },
      ]);
      const next = productLabelAcceptanceFixture({ allowPreviouslyAcceptedCodes });
      await seedProductLabelShift(h.exec, next);
      expect(await readValidationRejectionReason(h.exec, next.shiftId, next.codeHash)).toBe(
        "active",
      );
      // The existing explicit release channel deletes this registry row; retained occurrence evidence survives.
      await h.exec.run("DELETE FROM codes_mirror WHERE code_hash=?", [h.input.codeHash]);
      if (pendingReceipt)
        await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
          { ...identity, outcome: "pending" },
        ]);
      const [shift] = await h.exec.all<{ product_id: string }>(
        "SELECT product_id FROM shift_mirror WHERE id=?",
        [next.shiftId],
      );
      if (!shift) throw new Error("Missing next shift");
      await refreshValidationHistory(
        h.exec,
        { get: vi.fn().mockResolvedValue(history(next.shiftId, shift.product_id)) },
        next.shiftId,
        shift.product_id,
      );
      expect((await readValidationProcessingState(h.exec, h.input.shiftId)).processed).toBe(0);
      expect
        .soft(await readValidationRejectionReason(h.exec, next.shiftId, next.codeHash))
        .toBe(allowPreviouslyAcceptedCodes ? "unconfirmed" : "previous");
      expect(await recordProductLabelAcceptance(h.exec, next)).toEqual({
        status: "accepted",
        jobId: next.jobId,
      });
      expect((await readValidationProcessingState(h.exec, next.shiftId)).processed).toBe(1);
      expect(await h.exec.all("SELECT shift_id FROM codes_mirror")).toEqual([
        { shift_id: next.shiftId },
      ]);
      expect(
        await h.exec.all("SELECT status FROM shift_mirror WHERE id=?", [h.input.shiftId]),
      ).toEqual([{ status: "active" }]);
      expect(
        await h.exec.all(
          "SELECT outcome,receipt_outcome FROM validation_occurrences WHERE shift_id=?",
          [h.input.shiftId],
        ),
      ).toEqual([
        {
          outcome: pendingReceipt ? "pending" : "first_accepted",
          receipt_outcome: "first_accepted",
        },
      ]);
      expect(await h.exec.all("SELECT * FROM product_label_accept_commands")).toHaveLength(2);
    },
  );

  it.each(["pending", "reprocessed"] as const)(
    "retains the other-active-shift blocker for an effective %s occurrence",
    async (outcome) => {
      const h = await openProductLabelWork("none", undefined, true, false, true);
      handles.push(h);
      await sendPreparedProductLabel(h.deps, h.input.jobId);
      if (outcome === "reprocessed") {
        const originalShift = randomUUID();
        await h.exec.run("UPDATE codes_mirror SET shift_id=?", [originalShift]);
        await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
          {
            shiftId: h.input.shiftId,
            codeHash: h.input.codeHash,
            scannedAt: h.input.acceptedAt,
            outcome,
          },
        ]);
        expect(await h.exec.all("SELECT shift_id FROM codes_mirror")).toEqual([
          { shift_id: originalShift },
        ]);
        // Releasing original ownership leaves the accepted repeat effective and blocking.
        await h.exec.run("DELETE FROM codes_mirror WHERE code_hash=?", [h.input.codeHash]);
      }
      const next = productLabelAcceptanceFixture({ allowPreviouslyAcceptedCodes: true });
      await seedProductLabelShift(h.exec, next);
      expect((await readValidationProcessingState(h.exec, h.input.shiftId)).processed).toBe(1);
      expect(await readValidationRejectionReason(h.exec, next.shiftId, next.codeHash)).toBe(
        "active",
      );
      expect(await recordProductLabelAcceptance(h.exec, next)).toEqual({ status: "duplicate" });
      expect(
        await h.exec.all("SELECT * FROM product_label_jobs WHERE shift_id=?", [next.shiftId]),
      ).toHaveLength(0);
      expect((await readValidationProcessingState(h.exec, next.shiftId)).processed).toBe(0);
    },
  );

  it("keeps prior complete history across a failed page and late credential response", async () => {
    const h = await fixture();
    const productId = randomUUID();
    const initial = history(h.input.shiftId, productId, {
      items: [
        {
          codeHash: h.input.codeHash,
          kind: "original",
          shiftId: randomUUID(),
          shiftNumber: "OLD",
          shiftStatus: "closed",
          scannedAt: h.input.acceptedAt,
        },
      ],
    });
    await refreshValidationHistory(
      h.exec,
      { get: vi.fn().mockResolvedValue(initial) },
      h.input.shiftId,
      productId,
    );
    const before = await h.exec.all("SELECT * FROM validation_history_publications");
    const client = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          ...initial,
          snapshot: "b".repeat(64),
          complete: false,
          nextCursor: "page-2",
        })
        .mockRejectedValueOnce(new Error("offline")),
    };
    await expect(
      refreshValidationHistory(h.exec, client, h.input.shiftId, productId),
    ).rejects.toThrow("offline");
    expect(await h.exec.all("SELECT * FROM validation_history_publications")).toEqual(before);
    await refreshValidationHistory(
      h.exec,
      { get: vi.fn().mockResolvedValue(history(h.input.shiftId, productId)) },
      h.input.shiftId,
      productId,
      () => false,
    );
    expect(await h.exec.all("SELECT * FROM validation_history_publications")).toEqual(before);
    expect((await h.exec.all("SELECT * FROM validation_code_history")).length).toBe(1);
  });
  it("publishes original and active repeat entries for one hash together and retries only expiry", async () => {
    const h = await fixture();
    const productId = randomUUID();
    const first = history(h.input.shiftId, productId, {
      items: [
        {
          codeHash: h.input.codeHash,
          kind: "original",
          shiftId: randomUUID(),
          shiftNumber: "OLD",
          shiftStatus: "closed",
          scannedAt: h.input.acceptedAt,
        },
      ],
      complete: false,
      nextCursor: "opaque",
    });
    const item = first.items[0];
    if (!item) throw new Error("fixture history entry missing");
    const second = {
      ...first,
      complete: true,
      nextCursor: null,
      items: [
        {
          ...item,
          kind: "reprocessing" as const,
          shiftId: randomUUID(),
          shiftStatus: "active" as const,
        },
      ],
    };
    const client = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new StationApiError(409, "expired", "VALIDATION_HISTORY_EXPIRED"))
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
    };
    await refreshValidationHistory(h.exec, client, h.input.shiftId, productId);
    expect(client.get.mock.calls[2]?.[0]).toContain(`snapshot=${"a".repeat(64)}&cursor=opaque`);
    expect((await h.exec.all("SELECT * FROM validation_code_history")).length).toBe(2);
    expect((await readValidationProcessingState(h.exec, h.input.shiftId)).fetchedAt).toBe(
      first.fetchedAt,
    );
  });
  it("rolls back publication header and entries when SQLite fails midway", async () => {
    const h = await fixture();
    const productId = randomUUID();
    const initial = history(h.input.shiftId, productId);
    await refreshValidationHistory(
      h.exec,
      { get: vi.fn().mockResolvedValue(initial) },
      h.input.shiftId,
      productId,
    );
    await h.exec.run(
      "CREATE TRIGGER test_history_fault BEFORE INSERT ON validation_code_history BEGIN SELECT RAISE(ABORT,'HISTORY_DISK_FAILURE'); END;",
    );
    const next = {
      ...initial,
      snapshot: "b".repeat(64),
      items: [
        {
          codeHash: h.input.codeHash,
          kind: "original",
          shiftId: randomUUID(),
          shiftNumber: "OLD",
          shiftStatus: "closed",
          scannedAt: h.input.acceptedAt,
        },
      ],
    };
    await expect(
      refreshValidationHistory(
        h.exec,
        { get: vi.fn().mockResolvedValue(next) },
        h.input.shiftId,
        productId,
      ),
    ).rejects.toThrow("HISTORY_DISK_FAILURE");
    expect(await h.exec.all("SELECT snapshot FROM validation_history_publications")).toEqual([
      { snapshot: initial.snapshot },
    ]);
  });
  it("reconciles acknowledged acceptance, preserves physical print facts and never resurrects a conflict", async () => {
    const h = await fixture();
    await sendPreparedProductLabel(h.deps, h.input.jobId);
    const identity = {
      shiftId: h.input.shiftId,
      codeHash: h.input.codeHash,
      scannedAt: h.input.acceptedAt,
    };
    await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
      { ...identity, outcome: "first_accepted" },
    ]);
    const events = await h.exec.all("SELECT * FROM product_label_events");
    const post = vi.fn().mockResolvedValue({
      protocol: VALIDATION_REPROCESSING_PROTOCOL,
      occurrences: [{ ...identity, outcome: "conflict" }],
    });
    await reconcileValidationOccurrences(h.exec, { post }, h.input.credentialOwnership, () => true);
    expect(post).toHaveBeenCalledWith("/station/validation-occurrences/status", {
      occurrences: [identity],
    });
    expect(await readValidationProcessingState(h.exec, h.input.shiftId)).toMatchObject({
      processed: 0,
      conflicts: 1,
      pending: 0,
    });
    expect(await h.exec.all("SELECT * FROM product_label_events")).toEqual(events);
    expect(
      (await readProductLabelJob(h.exec, h.input.credentialOwnership, h.input.jobId))
        ?.ownershipConflict,
    ).toBe(true);
    await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
      { ...identity, outcome: "first_accepted" },
    ]);
    expect((await readValidationProcessingState(h.exec, h.input.shiftId)).conflicts).toBe(1);
  });
  it("removes only provisional ownership when an unknown offline code is confirmed as a repeat", async () => {
    const h = await fixture();
    const identity = {
      shiftId: h.input.shiftId,
      codeHash: h.input.codeHash,
      scannedAt: h.input.acceptedAt,
    };
    await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
      { ...identity, outcome: "reprocessed" },
    ]);
    expect(await h.exec.all("SELECT * FROM codes_mirror")).toHaveLength(0);
    expect((await readValidationProcessingState(h.exec, h.input.shiftId)).processed).toBe(1);
    expect(
      (await readProductLabelJob(h.exec, h.input.credentialOwnership, h.input.jobId))?.canonicalRaw,
    ).toBe(h.input.canonicalRaw);
  });

  it("projects authoritative first acceptance after a previously known owner was released", async () => {
    const h = await fixture();
    const previous = randomUUID();
    await h.exec.run("UPDATE codes_mirror SET shift_id=?", [previous]);
    await h.exec.run("UPDATE validation_occurrences SET source_shift_id=?", [previous]);
    await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
      {
        shiftId: h.input.shiftId,
        codeHash: h.input.codeHash,
        scannedAt: h.input.acceptedAt,
        outcome: "first_accepted",
      },
    ]);
    expect(await h.exec.all("SELECT shift_id,scanned_at FROM codes_mirror")).toEqual([
      { shift_id: h.input.shiftId, scanned_at: h.input.acceptedAt },
    ]);
    expect(await h.exec.all("SELECT source_shift_id FROM validation_occurrences")).toEqual([
      { source_shift_id: null },
    ]);
  });

  it("does not resurrect an explicitly released first acceptance from an old batch receipt replay", async () => {
    const h = await fixture();
    const identity = {
      shiftId: h.input.shiftId,
      codeHash: h.input.codeHash,
      scannedAt: h.input.acceptedAt,
      outcome: "first_accepted" as const,
    };
    await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [identity]);
    await h.exec.run("DELETE FROM codes_mirror");
    await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [identity]);
    expect(await h.exec.all("SELECT * FROM codes_mirror")).toHaveLength(0);
    expect((await readValidationProcessingState(h.exec, h.input.shiftId)).processed).toBe(0);
  });

  it("pending after release retains receipt context without restoring original ownership or count", async () => {
    const h = await fixture();
    const identity = {
      shiftId: h.input.shiftId,
      codeHash: h.input.codeHash,
      scannedAt: h.input.acceptedAt,
    };
    await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
      { ...identity, outcome: "first_accepted" },
    ]);
    await h.exec.run("DELETE FROM codes_mirror");
    await applyValidationOutcomes(h.exec, h.input.credentialOwnership, [
      { ...identity, outcome: "pending" },
    ]);
    expect(await h.exec.all("SELECT outcome,receipt_outcome FROM validation_occurrences")).toEqual([
      { outcome: "pending", receipt_outcome: "first_accepted" },
    ]);
    expect((await readValidationProcessingState(h.exec, h.input.shiftId)).processed).toBe(0);
  });
  it("does not publish a delayed status response after credential sealing", async () => {
    const h = await fixture();
    let current = true;
    const post = vi.fn().mockImplementation(async () => {
      current = false;
      return {
        protocol: VALIDATION_REPROCESSING_PROTOCOL,
        occurrences: [
          {
            shiftId: h.input.shiftId,
            codeHash: h.input.codeHash,
            scannedAt: h.input.acceptedAt,
            outcome: "conflict",
          },
        ],
      };
    });
    await reconcileValidationOccurrences(
      h.exec,
      { post },
      h.input.credentialOwnership,
      () => current,
    );
    expect((await readValidationProcessingState(h.exec, h.input.shiftId)).pending).toBe(1);
  });
  it("reads and replays genuine legacy policy bytes/digest, while accepting only absent/false equivalence", async () => {
    const h = await fixture();
    const { allowPreviouslyAcceptedCodes: omitted, ...legacyPolicy } = h.input.policy;
    void omitted;
    const legacy = { ...h.input, policy: legacyPolicy };
    await h.exec.run(
      "UPDATE product_label_accept_commands SET acceptance_json=?,command_digest=? WHERE job_id=?",
      [JSON.stringify(legacy), productLabelValueDigest(legacy), h.input.jobId],
    );
    await h.exec.run(
      "UPDATE shift_mirror SET validation_print_context=json_remove(validation_print_context,'$.policy.allowPreviouslyAcceptedCodes') WHERE id=?",
      [h.input.shiftId],
    );
    expect(
      (await readProductLabelJob(h.exec, h.input.credentialOwnership, h.input.jobId))?.policy
        .allowPreviouslyAcceptedCodes,
    ).toBe(false);
    expect(await recordProductLabelAcceptance(h.exec, h.input)).toEqual({
      status: "accepted",
      jobId: h.input.jobId,
    });
    await h.exec.run(
      "UPDATE shift_mirror SET validation_print_context=json_set(validation_print_context,'$.policy.allowPreviouslyAcceptedCodes',json('false')) WHERE id=?",
      [h.input.shiftId],
    );
    await expect(
      h.exec.run(
        "UPDATE shift_mirror SET validation_print_context=json_set(validation_print_context,'$.policy.allowPreviouslyAcceptedCodes',json('true')) WHERE id=?",
        [h.input.shiftId],
      ),
    ).rejects.toThrow("PRODUCT_LABEL_POLICY_FROZEN");
    expect(
      await h.exec.all("SELECT acceptance_json,command_digest FROM product_label_accept_commands"),
    ).toEqual([
      { acceptance_json: JSON.stringify(legacy), command_digest: productLabelValueDigest(legacy) },
    ]);
    await sendPreparedProductLabel(h.deps, h.input.jobId);
    expect(h.print).toHaveBeenCalledTimes(1);
  });
});
