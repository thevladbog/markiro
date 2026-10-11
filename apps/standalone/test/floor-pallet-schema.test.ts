import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { LocalExecutor, LocalStatement } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const MIGRATIONS = new URL("../src-tauri/migrations/", testModuleUrl);

const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const AT = "2026-10-09T08:00:00.000Z";
const PALLET_SSCC = "146006820000000409";

function insert(table: string, row: Record<string, unknown>): LocalStatement {
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

function pallet(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  return insert("floor_pallets", {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    opened_at: AT,
    ...overrides,
  });
}

function closedPallet(id: string, sscc: string, overrides: Record<string, unknown> = {}) {
  return pallet(id, { closed_at: AT, sscc, block_id: "block-1", serial: 40, ...overrides });
}

function palletException(id: string, overrides: Record<string, unknown>): LocalStatement {
  return insert("floor_pallet_exceptions", {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    pallet_id: "pallet-1",
    occurred_at: AT,
    ...overrides,
  });
}

function shift(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  return insert("floor_shifts", {
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    id,
    number: "OCT26-004",
    status: "planned",
    mode: "aggregation",
    pallets_enabled: 1,
    created_from: "office",
    line_id: LINE_ID,
    product_id: "product-1",
    product_name: "Молоко",
    product_gtin14: "04600682000013",
    production_date: "2026-10-09",
    box_capacity: 12,
    box_template_id: "template-1",
    pallet_box_capacity: 40,
    pallet_template_id: "pallet-template-1",
    seen_at: 1_790_000_000_000,
    ...overrides,
  });
}

function box(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  return insert("floor_boxes", {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    opened_at: AT,
    ...overrides,
  });
}

async function refused(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).rejects.toMatchObject({ code: "statement_failed" });
}

async function accepted(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).resolves.toEqual([1]);
}

describe("the station's pallets (migration 0008)", () => {
  it("keep a shift's boxes per pallet, a whole number above zero, and its pallet template", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, shift("pallets"));
    await accepted(
      executor,
      shift("boxes", { pallets_enabled: 0, pallet_box_capacity: null, pallet_template_id: null }),
    );
    await refused(executor, shift("none", { pallet_box_capacity: 0 }));
  });

  it("put only a closed box on a pallet", async () => {
    const { executor } = openLocalDb();
    await refused(executor, box("open", { pallet_id: "pallet-1" }));
    await accepted(executor, box("loose"));
    const closed = { closed_at: AT, block_id: "block-1", serial: 1, sscc: "046006820000000017" };
    await accepted(executor, box("on-pallet", { ...closed, pallet_id: "pallet-1" }));
  });

  it("close a pallet whole, with its SSCC of extension 1, block and serial, or keep it open without them", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, pallet("open"));
    await accepted(executor, closedPallet("closed", PALLET_SSCC));
    await refused(executor, pallet("half", { closed_at: AT }));
    await refused(executor, pallet("numbered", { sscc: "146006820000000416" }));
    // A closed pallet has its block and its serial, not only its SSCC.
    const noBlock = { block_id: null };
    await refused(executor, closedPallet("no-block", "146006820000000430", noBlock));
    await refused(executor, closedPallet("no-serial", "146006820000000430", { serial: null }));
    await refused(executor, pallet("apart", { disassembled_at: AT, shift_id: "shift-2" }));
    // A box's SSCC (extension 0) or anything but 18 digits is no pallet's.
    for (const sscc of ["046006820000000417", "14600682000000041", "14600682000000041x"]) {
      await refused(executor, closedPallet(`bad-${sscc}`, sscc, { shift_id: "shift-3" }));
    }
    await accepted(
      executor,
      closedPallet("taken-apart", "146006820000000423", { disassembled_at: AT }),
    );
  });

  it("hold one open pallet per shift and pairing, and an SSCC on one pallet under any pairing", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, pallet("open-1"));
    await refused(executor, pallet("open-2"));
    await accepted(executor, pallet("open-3", { device_id: OTHER_DEVICE }));
    await accepted(executor, pallet("open-4", { shift_id: "shift-2" }));
    await accepted(executor, closedPallet("closed-1", PALLET_SSCC));
    await accepted(executor, closedPallet("closed-2", "146006820000000416"));
    await refused(executor, closedPallet("closed-3", PALLET_SSCC, { device_id: OTHER_DEVICE }));
  });

  it("take a pallet's exception of its two kinds, always with a reason, words only with `other`", async () => {
    const { executor } = openLocalDb();
    await accepted(
      executor,
      palletException("reprint", { kind: "reprint", reason_code: "printer_jam" }),
    );
    await accepted(
      executor,
      palletException("disassemble", {
        kind: "disassemble",
        reason_code: "other",
        reason_text: "Не тот заказ",
      }),
    );
    await refused(executor, palletException("undo", { kind: "undo", reason_code: "other" }));
    await refused(executor, palletException("bare", { kind: "reprint", reason_code: null }));
    await refused(
      executor,
      palletException("words", {
        kind: "disassemble",
        reason_code: "wrong_product",
        reason_text: "Не тот товар",
      }),
    );
  });
});

describe("migration 0008 over a database of 0007", () => {
  function migrate(db: DatabaseSync, from: string, to: string): void {
    const files = readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith(".sql") && name >= from && name <= to)
      .sort();
    for (const name of files) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
  }

  it("keeps the shifts, boxes and records of a station on 0007, with no pallet in them", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "0001", "0007_zzz");
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'floor_pallet%'").get(),
    ).toEqual({ n: 0 });
    const pairing = [HOST_ID, DEVICE_ID];
    db.prepare(
      "INSERT INTO floor_shifts (host_id, device_id, id, number, status, mode, pallets_enabled, " +
        "created_from, line_id, product_id, product_name, product_gtin14, production_date, " +
        "box_capacity, box_template_id, seen_at, entered_at, snapshot, local_state) " +
        "VALUES (?, ?, 'shift-1', 'OCT26-004', 'active', 'aggregation', 0, 'office', ?, " +
        "'product-1', 'Молоко', '04600682000013', '2026-10-09', 12, 'template-1', 1790000000000, " +
        "'2026-10-09T07:00:00.000Z', '{}', 'closing')",
    ).run(...pairing, LINE_ID);
    db.prepare(
      "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
        "block_id, serial, item_count) VALUES ('box-1', ?, ?, 'shift-1', ?, ?, " +
        "'046006820000000017', 'block-1', 1, 12)",
    ).run(...pairing, AT, AT);
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        "VALUES ('record-1', ?, ?, 'box_closed', 'shift-1', '{}', ?)",
    ).run(...pairing, AT);

    migrate(db, "0008", "0008_zzz");

    expect(db.prepare("SELECT * FROM floor_shifts").all()).toMatchObject([
      {
        id: "shift-1",
        status: "active",
        pallets_enabled: 0,
        local_state: "closing",
        box_capacity: 12,
        pallet_box_capacity: null,
        pallet_template_id: null,
      },
    ]);
    expect(db.prepare("SELECT * FROM floor_boxes").all()).toMatchObject([
      { id: "box-1", sscc: "046006820000000017", item_count: 12, pallet_id: null },
    ]);
    expect(db.prepare("SELECT id, kind, shift_id FROM outbox").all()).toEqual([
      { id: "record-1", kind: "box_closed", shift_id: "shift-1" },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM floor_pallets").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM floor_pallet_exceptions").get()).toEqual({ n: 0 });
    // The old shift takes a pallet's box afterwards: the new column is writable on old rows.
    db.prepare("UPDATE floor_boxes SET pallet_id = 'pallet-1' WHERE id = 'box-1'").run();
    expect(db.prepare("SELECT pallet_id FROM floor_boxes").all()).toEqual([
      { pallet_id: "pallet-1" },
    ]);
    db.close();
  });
});
