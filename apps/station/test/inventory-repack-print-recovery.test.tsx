// @vitest-environment jsdom

import { DatabaseSync } from "node:sqlite";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { StationInventoryBundleManifest } from "@markiro/domain";

import i18n from "../src/i18n/index.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
import { InventoryWorkScreen } from "../src/pages/InventoryWorkScreen.js";
import { makeExec } from "./support/sqlite-exec.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const OPERATOR_ID = "44444444-4444-4444-8444-444444444444";
const BOX_ID = "55555555-5555-4555-8555-555555555555";
const SSCC = "046006820000621515";

const manifest: StationInventoryBundleManifest & { mode: "repack" } = {
  inventoryId: INVENTORY_ID,
  inventoryNumber: "ИНВ-Р-42",
  snapshotId: SNAPSHOT_ID,
  snapshotRevision: 1,
  snapshotFixedAt: "2026-08-25T01:00:00.000Z",
  combinedDigest: "a".repeat(64),
  contentDigest: "b".repeat(64),
  codeCount: 1,
  productId: "66666666-6666-4666-8666-666666666666",
  productName: "Пиво светлое",
  productPrintName: "Пиво светлое",
  gtin14: "04600000000015",
  egaisCode: null,
  shelfLifeDays: 180,
  boxCapacity: 1,
  mode: "repack",
  lineId: "77777777-7777-4777-8777-777777777777",
  lineName: "Линия 1",
  productionDateFrom: "2026-08-19",
  productionDateTo: "2026-09-19",
  boxLabelTemplate: {
    id: "88888888-8888-4888-8888-888888888888",
    name: "Короб",
    spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
  },
  limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
  sscc: null,
  ssccRevokedFrom: [],
  ssccRevokedBlocks: [],
};

function scanner() {
  let listener: ScanListener | null = null;
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  return { source, active: () => listener !== null };
}

async function seedClosedBox(state: "pending" | "printed", reprintState?: "printing" | "failed") {
  const db = new DatabaseSync(":memory:");
  const exec = makeExec(db);
  await applyMigrations(exec);
  db.prepare(
    `INSERT INTO inventory_terminal_state
       (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
        open_repack_box_id, next_device_sequence, updated_at)
     VALUES (?, ?, ?, ?, '2026-08-19', ?, 1, '2026-08-25T10:00:00.000Z')`,
  ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID, state === "pending" ? BOX_ID : null);
  db.prepare(
    `INSERT INTO inventory_repack_boxes_mirror
       (inventory_id, snapshot_id, box_id, opened_event_id, closed_event_id,
        old_sscc_context, new_sscc, owner_device_id, capacity, production_date,
        state, print_state, print_attempt_count, opened_at, closed_at, printed_at, updated_at)
     VALUES (?, ?, ?, '99999999-9999-4999-8999-999999999999',
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '346006820000000014', ?, ?, 1,
       '2026-08-19', 'closed', ?, 0, '2026-08-25T09:00:00.000Z',
       '2026-08-25T10:00:00.000Z', ?, '2026-08-25T10:00:00.000Z')`,
  ).run(
    INVENTORY_ID,
    SNAPSHOT_ID,
    BOX_ID,
    SSCC,
    DEVICE_ID,
    state,
    state === "printed" ? "2026-08-25T10:00:01.000Z" : null,
  );
  db.prepare(
    `INSERT INTO inventory_repack_items_mirror
       (inventory_id, snapshot_id, item_id, source_event_id, box_id, code_hash,
        position, production_date, added_at)
     VALUES (?, ?, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
       'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ?, ?, 1,
       '2026-08-19', '2026-08-25T09:30:00.000Z')`,
  ).run(INVENTORY_ID, SNAPSHOT_ID, BOX_ID, "d".repeat(64));
  if (state === "printed") {
    db.prepare(
      `UPDATE inventory_repack_boxes_mirror
          SET print_state = 'pending', printed_at = NULL
        WHERE box_id = ?`,
    ).run(BOX_ID);
    db.prepare(
      `INSERT INTO inventory_repack_print_attempts
         (inventory_id, snapshot_id, attempt_id, box_id, kind, attempt_number,
          state, attempted_at)
       VALUES (?, ?, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', ?, 'initial', 1,
         'printing', '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, BOX_ID);
    db.prepare(
      `UPDATE inventory_repack_print_attempts
          SET state = 'printed', completed_at = '2026-08-25T10:00:01.000Z',
              event_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
        WHERE attempt_number = 1`,
    ).run();
    db.prepare(
      `UPDATE inventory_repack_boxes_mirror
          SET print_state = 'printed', print_attempt_count = 1,
              printed_at = '2026-08-25T10:00:01.000Z'
        WHERE box_id = ?`,
    ).run(BOX_ID);
  }
  if (reprintState) {
    db.prepare(
      `INSERT INTO inventory_repack_print_attempts
         (inventory_id, snapshot_id, attempt_id, box_id, kind, attempt_number,
          state, error_code, attempted_at, completed_at, event_id)
       VALUES (?, ?, 'ffffffff-ffff-4fff-8fff-ffffffffffff', ?, 'reprint', 2,
         ?, ?, '2026-08-25T10:02:00.000Z', ?, ?)`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      BOX_ID,
      reprintState,
      reprintState === "failed" ? "transport_failed" : null,
      reprintState === "failed" ? "2026-08-25T10:02:01.000Z" : null,
      reprintState === "failed" ? "12121212-1212-4212-8212-121212121212" : null,
    );
    db.prepare(
      `UPDATE inventory_repack_boxes_mirror
          SET print_attempt_count = 2, print_error_code = ?
        WHERE box_id = ?`,
    ).run(reprintState === "failed" ? "transport_failed" : null, BOX_ID);
  }
  return { db, exec };
}

function renderWork(exec: SqlExecutor, source: ScanSource, print: () => Promise<void>) {
  return render(
    <InventoryWorkScreen
      exec={exec}
      inventory={manifest}
      deviceId={DEVICE_ID}
      operatorId={OPERATOR_ID}
      source={source}
      printing={{
        target: { kind: "usb", printer: "Zebra" },
        language: "zpl",
        print,
      }}
      createEventId={() => crypto.randomUUID()}
      now={() => "2026-08-25T10:03:00.000Z"}
    />,
  );
}

beforeAll(async () => i18n.changeLanguage("ru"));
afterEach(cleanup);

describe("repack print recovery across restart and persistence faults", () => {
  it.each(["printing", "failed"] as const)(
    "hydrates a %s reprint, blocks scans, and retries exact kind/SSCC",
    async (attemptState) => {
      const { db, exec } = await seedClosedBox("printed", attemptState);
      const scan = scanner();
      const print = vi.fn(async () => {});
      renderWork(exec, scan.source, print);

      expect(await screen.findByText("Этикетка не напечатана")).toBeDefined();
      expect(scan.active()).toBe(false);
      expect(screen.getByText(SSCC)).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Повторить печать" }));
      await waitFor(() => expect(print).toHaveBeenCalledOnce());
      expect(
        db
          .prepare(
            `SELECT kind, attempt_number, state
               FROM inventory_repack_print_attempts
              ORDER BY attempt_number DESC LIMIT 1`,
          )
          .get(),
      ).toEqual({ kind: "reprint", attempt_number: 3, state: "printed" });
      expect(db.prepare("SELECT new_sscc FROM inventory_repack_boxes_mirror").get()).toEqual({
        new_sscc: SSCC,
      });
    },
  );

  it("exposes a retry in the same mount when durable claim fails before hardware", async () => {
    const seeded = await seedClosedBox("pending");
    let failClaim = true;
    const exec: SqlExecutor = {
      all: (sql, params) => seeded.exec.all(sql, params),
      run: async (sql, params) => {
        if (failClaim && sql.includes("INSERT INTO inventory_repack_print_attempts")) {
          failClaim = false;
          throw new Error("private claim failure");
        }
        await seeded.exec.run(sql, params);
      },
    };
    const scan = scanner();
    const print = vi.fn(async () => {});
    renderWork(exec, scan.source, print);

    expect(await screen.findByText("Этикетка не напечатана")).toBeDefined();
    expect(print).not.toHaveBeenCalled();
    expect(scan.active()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Повторить печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(
      seeded.db.prepare("SELECT print_state FROM inventory_repack_boxes_mirror").get(),
    ).toEqual({ print_state: "printed" });
  });

  it("recovers dual finalization failure after transport and retries in the same mount", async () => {
    const seeded = await seedClosedBox("pending");
    let journalFailures = 2;
    const exec: SqlExecutor = {
      all: (sql, params) => seeded.exec.all(sql, params),
      run: async (sql, params) => {
        if (journalFailures > 0 && sql.includes("inventory_repack_print_journal")) {
          journalFailures -= 1;
          throw new Error("private finalization failure");
        }
        await seeded.exec.run(sql, params);
      },
    };
    const scan = scanner();
    const print = vi.fn(async () => {});
    renderWork(exec, scan.source, print);

    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(await screen.findByText("Этикетка не напечатана")).toBeDefined();
    expect(scan.active()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Повторить печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
    expect(
      seeded.db.prepare("SELECT print_state FROM inventory_repack_boxes_mirror").get(),
    ).toEqual({ print_state: "printed" });
  });
});
