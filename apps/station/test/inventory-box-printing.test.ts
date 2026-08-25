import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { LabelTemplateSpec, StationInventoryBundleManifest } from "@markiro/domain";

import {
  attemptInventoryBoxPrint,
  listInventoryBoxPrintAttempts,
  recoverInterruptedInventoryPrint,
} from "../src/lib/inventory-box-printing.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { makeExec } from "./support/sqlite-exec.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const OPERATOR_ID = "44444444-4444-4444-8444-444444444444";
const BOX_ID = "55555555-5555-4555-8555-555555555555";
const ATTEMPT_ID = "66666666-6666-4666-8666-666666666666";
const EVENT_ID = "77777777-7777-4777-8777-777777777777";
const SSCC = "046006820000621515";
const TEMPLATE: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [],
};
const MANIFEST = {
  inventoryId: INVENTORY_ID,
  inventoryNumber: "ИНВ-42",
  snapshotId: SNAPSHOT_ID,
  snapshotRevision: 1,
  snapshotFixedAt: "2026-08-25T01:00:00.000Z",
  combinedDigest: "a".repeat(64),
  contentDigest: "b".repeat(64),
  codeCount: 2,
  productId: "88888888-8888-4888-8888-888888888888",
  productName: "Пиво светлое",
  productPrintName: "Пиво",
  gtin14: "04680089900038",
  egaisCode: null,
  shelfLifeDays: 184,
  boxCapacity: 2,
  mode: "repack",
  lineId: "99999999-9999-4999-8999-999999999999",
  lineName: "Линия 1",
  productionDateFrom: "2026-08-01",
  productionDateTo: "2026-08-31",
  boxLabelTemplate: {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Короб",
    spec: TEMPLATE,
  },
  limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
  sscc: null,
  ssccRevokedFrom: [],
  ssccRevokedBlocks: [],
} as unknown as StationInventoryBundleManifest & { mode: "repack" };

async function setup(
  overrides: { state?: string; printState?: string; owner?: string; count?: number } = {},
) {
  const db = new DatabaseSync(":memory:");
  const exec = makeExec(db);
  await applyMigrations(exec);
  db.prepare(
    `INSERT INTO inventory_terminal_state
       (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
        open_repack_box_id, next_device_sequence, updated_at)
     VALUES (?, ?, ?, ?, '2026-08-19', ?, 1, '2026-08-25T10:00:00.000Z')`,
  ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID, BOX_ID);
  const state = overrides.state ?? "closed";
  const printState = overrides.printState ?? "pending";
  db.prepare(
    `INSERT INTO inventory_repack_boxes_mirror
       (inventory_id, snapshot_id, box_id, opened_event_id, closed_event_id,
        old_sscc_context, new_sscc, owner_device_id, capacity, production_date,
        state, print_state, opened_at, closed_at, invalidated_at, updated_at)
     VALUES (?, ?, ?, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
       'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '346006820000000014', ?, ?, 2,
       '2026-08-19', ?, ?, '2026-08-25T09:00:00.000Z',
       '2026-08-25T10:00:00.000Z', ?, '2026-08-25T10:00:00.000Z')`,
  ).run(
    INVENTORY_ID,
    SNAPSHOT_ID,
    BOX_ID,
    SSCC,
    overrides.owner ?? DEVICE_ID,
    state,
    printState,
    state === "invalidated" ? "2026-08-25T10:00:00.000Z" : null,
  );
  for (let index = 0; index < (overrides.count ?? 2); index += 1) {
    db.prepare(
      `INSERT INTO inventory_repack_items_mirror
         (inventory_id, snapshot_id, item_id, source_event_id, box_id, code_hash,
          position, production_date, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-08-19', '2026-08-25T09:00:00.000Z')`,
    ).run(
      INVENTORY_ID,
      SNAPSHOT_ID,
      `${index + 1}`.repeat(8) + "-1111-4111-8111-" + `${index + 1}`.repeat(12),
      `${index + 2}`.repeat(8) + "-2222-4222-8222-" + `${index + 2}`.repeat(12),
      BOX_ID,
      String(index + 1).repeat(64),
      index + 1,
    );
  }
  return { db, exec };
}

function input(exec: SqlExecutor) {
  return {
    exec,
    manifest: MANIFEST,
    inventoryId: INVENTORY_ID,
    snapshotId: SNAPSHOT_ID,
    deviceId: DEVICE_ID,
    operatorId: OPERATOR_ID,
    boxId: BOX_ID,
    attemptId: ATTEMPT_ID,
    eventId: EVENT_ID,
    attemptedAt: "2026-08-25T10:01:00.000Z",
    completedAt: () => "2026-08-25T10:01:01.000Z",
    printing: {
      target: { kind: "tcp" as const, host: "10.0.0.5", port: 9100 },
      language: "zpl" as const,
      print: vi.fn(async () => {}),
    },
    render: vi.fn(async (_template, fields) => {
      expect(fields).toMatchObject({ sscc: SSCC, qty: "2", date: "19.08.2026" });
      return new Uint8Array([1, 2, 3]);
    }),
  };
}

describe("durable inventory box printing", () => {
  it("rejects an invalid SSCC check digit before render or hardware", async () => {
    const { db, exec } = await setup();
    db.prepare("UPDATE inventory_repack_boxes_mirror SET new_sscc = '046006820000621519'").run();
    const configured = input(exec);
    await expect(attemptInventoryBoxPrint(configured)).rejects.toThrow(
      "inventory box is not printable",
    );
    expect(configured.render).not.toHaveBeenCalled();
    expect(configured.printing.print).not.toHaveBeenCalled();
  });

  it("claims once before I/O, marks printed only after transport, and clears the pointer", async () => {
    const { db, exec } = await setup();
    const configured = input(exec);
    await expect(attemptInventoryBoxPrint(configured)).resolves.toMatchObject({
      state: "printed",
      sscc: SSCC,
      quantity: 2,
    });
    expect(configured.printing.print).toHaveBeenCalledOnce();
    expect(
      db
        .prepare("SELECT print_state, print_attempt_count FROM inventory_repack_boxes_mirror")
        .get(),
    ).toEqual({
      print_state: "printed",
      print_attempt_count: 1,
    });
    expect(db.prepare("SELECT open_repack_box_id FROM inventory_terminal_state").get()).toEqual({
      open_repack_box_id: null,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_outbox").get()).toEqual({
      count: 1,
    });
  });

  it.each([
    ["foreign", { owner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["empty", { count: 0 }],
    ["open", { state: "open" }],
    ["invalidated", { state: "invalidated", printState: "failed" }],
    ["over-capacity", { count: 3 }],
  ] as const)("rejects %s boxes before claiming hardware", async (_name, overrides) => {
    const { exec } = await setup(overrides);
    const configured = input(exec);
    await expect(attemptInventoryBoxPrint(configured)).rejects.toThrow(
      "inventory box is not printable",
    );
    expect(configured.printing.print).not.toHaveBeenCalled();
  });

  it("rejects a mixed-date box before claiming hardware", async () => {
    const { db, exec } = await setup();
    db.prepare(
      "UPDATE inventory_repack_items_mirror SET production_date = '2026-08-20' WHERE position = 2",
    ).run();
    const configured = input(exec);
    await expect(attemptInventoryBoxPrint(configured)).rejects.toThrow(
      "inventory box is not printable",
    );
    expect(configured.printing.print).not.toHaveBeenCalled();
  });

  it("durably classifies missing printer and transport failure without raw details", async () => {
    const missing = await setup();
    await expect(
      attemptInventoryBoxPrint({ ...input(missing.exec), printing: null }),
    ).resolves.toMatchObject({
      state: "failed",
      errorCode: "printer_unconfigured",
    });
    const transport = await setup();
    const configured = input(transport.exec);
    configured.printing.print.mockRejectedValueOnce(new Error("COM3 secret"));
    await expect(attemptInventoryBoxPrint(configured)).resolves.toMatchObject({
      state: "failed",
      errorCode: "transport_failed",
    });
    expect(
      JSON.stringify(
        await listInventoryBoxPrintAttempts(transport.exec, INVENTORY_ID, SNAPSHOT_ID, BOX_ID),
      ),
    ).not.toContain("COM3 secret");
  });

  it("durably classifies missing templates and render failures", async () => {
    const missing = await setup();
    await expect(
      attemptInventoryBoxPrint({
        ...input(missing.exec),
        manifest: { ...MANIFEST, boxLabelTemplate: null },
      }),
    ).resolves.toMatchObject({ state: "failed", errorCode: "template_missing" });

    const renderFailure = await setup();
    const configured = input(renderFailure.exec);
    configured.render.mockRejectedValueOnce(new Error("private label bytes"));
    await expect(attemptInventoryBoxPrint(configured)).resolves.toMatchObject({
      state: "failed",
      errorCode: "render_failed",
    });
    expect(configured.printing.print).not.toHaveBeenCalled();
  });

  it("records a retryable persistence failure after one successful physical transport", async () => {
    const { exec } = await setup();
    let failJournalOnce = true;
    const flakyExec: SqlExecutor = {
      all: (sql, params) => exec.all(sql, params),
      run: async (sql, params) => {
        if (failJournalOnce && sql.includes("inventory_repack_print_journal")) {
          failJournalOnce = false;
          throw new Error("private sqlite failure");
        }
        await exec.run(sql, params);
      },
    };
    const configured = input(flakyExec);
    await expect(attemptInventoryBoxPrint(configured)).resolves.toMatchObject({
      state: "failed",
      errorCode: "persistence_failed",
      sscc: SSCC,
    });
    expect(configured.printing.print).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(await listInventoryBoxPrintAttempts(exec, INVENTORY_ID, SNAPSHOT_ID, BOX_ID)),
    ).not.toContain("private sqlite failure");
  });

  it("retries a durable failed attempt with the same SSCC after restart", async () => {
    const { exec } = await setup();
    const unavailable = input(exec);
    await expect(
      attemptInventoryBoxPrint({ ...unavailable, printing: null }),
    ).resolves.toMatchObject({
      state: "failed",
      attemptNumber: 1,
      sscc: SSCC,
    });

    const configured = input(exec);
    await expect(
      attemptInventoryBoxPrint({
        ...configured,
        attemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        attemptedAt: "2026-08-25T10:02:00.000Z",
        completedAt: () => "2026-08-25T10:02:01.000Z",
      }),
    ).resolves.toMatchObject({
      state: "printed",
      attemptNumber: 2,
      sscc: SSCC,
    });
    expect(configured.printing.print).toHaveBeenCalledOnce();
  });

  it("serializes two retry clicks into one physical attempt", async () => {
    const { exec } = await setup();
    const configured = input(exec);
    let release!: () => void;
    configured.printing.print.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = attemptInventoryBoxPrint(configured);
    await vi.waitFor(() => expect(configured.printing.print).toHaveBeenCalledOnce());
    const second = attemptInventoryBoxPrint({
      ...configured,
      attemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    release();
    await expect(first).resolves.toMatchObject({ state: "printed" });
    await expect(second).rejects.toThrow("inventory box is not printable");
    expect(configured.printing.print).toHaveBeenCalledOnce();
  });

  it("durably consumes one exact failed reprint recovery across concurrent callers", async () => {
    const { db, exec } = await setup({ printState: "printed" });
    db.prepare(
      `INSERT INTO inventory_repack_print_attempts
        (inventory_id, snapshot_id, attempt_id, box_id, kind, attempt_number, state, attempted_at)
       VALUES (?, ?, ?, ?, 'reprint', 1, 'printing', '2026-08-25T10:01:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, ATTEMPT_ID, BOX_ID);
    db.prepare(
      `UPDATE inventory_repack_print_attempts
          SET state = 'failed', error_code = 'transport_failed',
              completed_at = '2026-08-25T10:01:01.000Z', event_id = ?
        WHERE attempt_id = ?`,
    ).run(EVENT_ID, ATTEMPT_ID);
    db.prepare(
      `UPDATE inventory_repack_boxes_mirror
          SET print_error_code = 'transport_failed'
        WHERE box_id = ?`,
    ).run(BOX_ID);

    const configured = input(exec);
    let release!: () => void;
    configured.printing.print.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = attemptInventoryBoxPrint({
      ...configured,
      attemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      kind: "reprint",
      recoveryOfAttemptId: ATTEMPT_ID,
    });
    await vi.waitFor(() => expect(configured.printing.print).toHaveBeenCalledOnce());
    const stale = attemptInventoryBoxPrint({
      ...configured,
      attemptId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      eventId: "12121212-1212-4212-8212-121212121212",
      kind: "reprint",
      recoveryOfAttemptId: ATTEMPT_ID,
    });
    release();

    await expect(first).resolves.toMatchObject({ state: "printed", attemptNumber: 2 });
    await expect(stale).rejects.toThrow("inventory print recovery is stale");
    expect(configured.render).toHaveBeenCalledOnce();
    expect(configured.printing.print).toHaveBeenCalledOnce();
    expect(
      db
        .prepare(
          "SELECT kind, attempt_number, state FROM inventory_repack_print_attempts ORDER BY attempt_number",
        )
        .all(),
    ).toEqual([
      { kind: "reprint", attempt_number: 1, state: "failed" },
      { kind: "reprint", attempt_number: 2, state: "printed" },
    ]);
  });

  it("recovers an interrupted printing claim as a durable retryable failure", async () => {
    const { db, exec } = await setup();
    db.prepare(
      `INSERT INTO inventory_repack_print_attempts
        (inventory_id, snapshot_id, attempt_id, box_id, kind, attempt_number, state, attempted_at)
       VALUES (?, ?, ?, ?, 'initial', 1, 'printing', '2026-08-25T10:01:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, ATTEMPT_ID, BOX_ID);
    await recoverInterruptedInventoryPrint(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      operatorId: OPERATOR_ID,
      boxId: BOX_ID,
      attemptId: ATTEMPT_ID,
      eventId: EVENT_ID,
      completedAt: "2026-08-25T10:02:00.000Z",
    });
    expect(
      db.prepare("SELECT print_state, print_error_code FROM inventory_repack_boxes_mirror").get(),
    ).toEqual({
      print_state: "failed",
      print_error_code: "persistence_failed",
    });
  });

  it("reprints the original SSCC with identical frozen fields and an append-only outcome", async () => {
    const { db, exec } = await setup();
    const configured = input(exec);
    const fields: Array<Record<string, string>> = [];
    configured.render.mockImplementation(async (_template, nextFields) => {
      fields.push({ ...nextFields });
      return new Uint8Array([1, 2, 3]);
    });
    await attemptInventoryBoxPrint(configured);
    db.prepare("UPDATE inventory_terminal_state SET active_production_date = '2026-08-31'").run();

    await expect(
      attemptInventoryBoxPrint({
        ...configured,
        attemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        attemptedAt: "2026-08-25T10:02:00.000Z",
        completedAt: () => "2026-08-25T10:02:01.000Z",
        kind: "reprint",
      }),
    ).resolves.toMatchObject({
      state: "printed",
      sscc: SSCC,
      productionDate: "2026-08-19",
      quantity: 2,
      attemptNumber: 2,
    });
    await expect(
      attemptInventoryBoxPrint({
        ...configured,
        attemptId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        eventId: "12121212-1212-4212-8212-121212121212",
        attemptedAt: "2026-08-25T10:03:00.000Z",
        completedAt: () => "2026-08-25T10:03:01.000Z",
        kind: "reprint",
      }),
    ).resolves.toMatchObject({ state: "printed", attemptNumber: 3, sscc: SSCC });
    expect(fields).toHaveLength(3);
    expect(fields[1]).toEqual(fields[0]);
    expect(fields[2]).toEqual(fields[0]);
    expect(
      db
        .prepare(
          "SELECT kind, attempt_number FROM inventory_repack_print_attempts ORDER BY attempt_number",
        )
        .all(),
    ).toEqual([
      { kind: "initial", attempt_number: 1 },
      { kind: "reprint", attempt_number: 2 },
      { kind: "reprint", attempt_number: 3 },
    ]);
    expect(db.prepare("SELECT new_sscc FROM inventory_repack_boxes_mirror").get()).toEqual({
      new_sscc: SSCC,
    });
  });
});
