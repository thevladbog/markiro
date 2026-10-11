import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BOX_STATE_SQL,
  CLOSED_BOXES_SQL,
  LAST_BOX_JOB_SQL,
  LAST_CODE_SQL,
  NEWEST_CODE_SCAN_SQL,
} from "../src/floor/exceptions/box-exceptions.js";
import {
  CLOSED_PALLETS_SQL,
  DISASSEMBLE_PALLET_SQL,
  LAST_PALLET_JOB_SQL,
  NEWEST_PALLET_JOB_GUARD_SQL,
  PALLET_LABEL_CLOSED_GUARD_SQL,
  PALLET_STATE_SQL,
} from "../src/floor/exceptions/pallet-exceptions.js";
import { outboxStatement, shiftClosedRecord } from "../src/floor/facts.js";
import {
  CONFLICT_COUNT_SQL,
  HEAD_RECORD_SQL,
  RECONCILED_AT_SQL,
  REJECTED_COUNT_SQL,
  SHIFT_PREFIX_SQL,
  UNSENT_COUNT_SQL,
} from "../src/floor/outbox-status.js";
import { CLOSE_SUMMARY_SQL, REFUSED_CLOSES_SQL } from "../src/floor/close/shift-close.js";
import {
  BOX_ONTO_PALLET_SQL,
  CLOSE_PALLET_SQL,
  JOIN_PALLET_SQL,
  OPEN_PALLET_GUARD_SQL,
  OPEN_PALLET_SQL,
  PALLET_LIVE_GUARD_SQL,
  PALLET_SSCC_HELD_SQL,
} from "../src/floor/pallets/pallets.js";
import { OPEN_JOB_READ_SQL } from "../src/floor/print/print-jobs.js";
import { BLOCKS_WITH_ROOM_SQL } from "../src/floor/work/block-supply.js";
import { BOX_CODES_SQL, CLOSED_BOX_SQL } from "../src/floor/work/box-close.js";
import type { LocalExecutor, LocalStatement } from "../src/local/executor.js";
import { attemptStatement, receiptStatements, UNSENT_SQL } from "../src/local/facts-sender.js";
import {
  BLOCKS_SQL,
  DUE_SQL,
  REOPEN_SQL,
  RETIRE_SQL,
  SETTLE_SQL,
  STATUS_SQL,
} from "../src/local/restore-reconcile.js";
import {
  DUE_SHIFTS_SQL,
  PURGE_COPY_SQL,
  purgeTableSql,
  RETAINED_TABLES,
} from "../src/local/retention.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;

const OTHER_DEVICE = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const AT = "2026-10-09T08:00:00.000Z";

/** The tables of this device's own records (migrations `0006`–`0008`; `TableClass::DeviceData`). */
const DEVICE_TABLES = [
  "floor_block_requests",
  "floor_boxes",
  "floor_codes",
  "floor_exceptions",
  "floor_pallet_exceptions",
  "floor_pallets",
  "floor_print_jobs",
  "floor_scans",
  "floor_shifts",
  "floor_sscc_blocks",
  "outbox",
];

function shift(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  const row: Record<string, unknown> = {
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    id,
    number: "OCT26-004",
    status: "planned",
    mode: "aggregation",
    pallets_enabled: 0,
    created_from: "office",
    line_id: LINE_ID,
    product_id: "product-1",
    product_name: "Молоко",
    product_gtin14: "04600682000013",
    production_date: "2026-10-09",
    box_capacity: 12,
    box_template_id: "template-1",
    seen_at: 1_790_000_000_000,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO floor_shifts (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

function box(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  const row: Record<string, unknown> = {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    opened_at: AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO floor_boxes (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

function scan(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  const row: Record<string, unknown> = {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    box_id: "box-1",
    verdict: "ok",
    raw_kind: "km",
    raw_length: 31,
    code_hash: "a".repeat(64),
    gtin14: "04600682000013",
    serial: "abc",
    canonical: "0104600682000013215abc",
    scanned_at: AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO floor_scans (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

function exception(id: string, overrides: Record<string, unknown>): LocalStatement {
  const row: Record<string, unknown> = {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    shift_id: "shift-1",
    box_id: "box-1",
    occurred_at: AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO floor_exceptions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

function record(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  const row: Record<string, unknown> = {
    id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    kind: "scan",
    shift_id: "shift-1",
    payload: JSON.stringify({ id, kind: "scan" }),
    created_at: AT,
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO outbox (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

const BLOCK: LocalStatement = {
  sql:
    "INSERT INTO floor_sscc_blocks (block_id, host_id, device_id, issuer_prefix, extension, " +
    "from_serial, to_serial, next_serial, received_at) VALUES (?, ?, ?, '460068200', 0, 1, 2, ?, ?)",
  values: ["block-1", HOST_ID, DEVICE_ID, 1, AT],
};

async function refused(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).rejects.toMatchObject({ code: "statement_failed" });
}

async function accepted(local: LocalExecutor, statement: LocalStatement): Promise<void> {
  await expect(local.transaction([statement])).resolves.toEqual([1]);
}

describe("the station's own production tables (migration 0006)", () => {
  it("tag every row with its pairing and have no foreign key", async () => {
    const { executor } = openLocalDb();
    const columns = await executor.query(
      'SELECT t.name AS tableName, c.name AS columnName, c."notnull" AS required ' +
        "FROM pragma_table_list AS t, pragma_table_info(t.name) AS c " +
        "WHERE t.schema = 'main' AND c.name IN ('host_id', 'device_id') ORDER BY t.name, c.name",
      [],
      z.object({ tableName: z.string(), columnName: z.string(), required: z.number() }),
    );
    // `floor_restore_epochs` (migration `0009`) is a pairing's own
    // bookkeeping that a forget empties, tagged the same way.
    expect(columns).toEqual(
      [...DEVICE_TABLES, "floor_restore_epochs"].sort().flatMap((tableName) => [
        { tableName, columnName: "device_id", required: 1 },
        { tableName, columnName: "host_id", required: 1 },
      ]),
    );
    const keys = await executor.query(
      "SELECT t.name AS name FROM pragma_table_list AS t, pragma_foreign_key_list(t.name) AS k " +
        "WHERE t.schema = 'main' AND t.type = 'table'",
      [],
      z.object({ name: z.string() }),
    );
    expect(keys).toEqual([]);
  });

  it("keep a snapshot exactly for a shift the station entered, and close only such a shift", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, shift("planned"));
    await accepted(
      executor,
      shift("entered", {
        status: "active",
        snapshot: "{}",
        entered_at: AT,
        local_state: "closing",
      }),
    );
    await refused(executor, shift("snapshot-alone", { snapshot: "{}" }));
    await refused(executor, shift("entry-alone", { entered_at: AT }));
    await refused(executor, shift("closed-unentered", { local_state: "closed" }));
    await refused(executor, shift("bad-json", { snapshot: "{", entered_at: AT }));
    await refused(executor, shift("bad-status", { status: "running" }));
    await refused(
      executor,
      shift("bad-state", { snapshot: "{}", entered_at: AT, local_state: "open" }),
    );
  });

  it("keep one row per shift and pairing, so another pairing to the same host has its own", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, shift("shift-1"));
    await refused(executor, shift("shift-1"));
    await accepted(executor, shift("shift-1", { device_id: OTHER_DEVICE }));
  });

  it("never keep the text of a scan that is no code of marking", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, scan("scan-ok"));
    const invalid = {
      verdict: "invalid",
      raw_kind: "unknown",
      box_id: null,
      code_hash: null,
      gtin14: null,
      serial: null,
      canonical: null,
    };
    await accepted(executor, scan("scan-invalid", invalid));
    await refused(executor, scan("scan-text", { ...invalid, canonical: "MRK-000742" }));
    await refused(executor, scan("scan-serial", { ...invalid, serial: "000742" }));
    await refused(executor, scan("scan-hash", { ...invalid, code_hash: "b".repeat(64) }));
    // A code of marking is never `invalid`, and an `invalid` scan is never one.
    await refused(executor, scan("scan-km-invalid", { verdict: "invalid", box_id: null }));
    await refused(executor, scan("scan-gtin-ok", { ...invalid, verdict: "ok", box_id: "box-1" }));
  });

  it("name a box for an accepted scan only, and a source for a duplicate only", async () => {
    const { executor } = openLocalDb();
    await refused(executor, scan("ok-without-box", { box_id: null }));
    await refused(
      executor,
      scan("duplicate-in-box", { verdict: "duplicate", duplicate_source: "local" }),
    );
    await accepted(
      executor,
      scan("duplicate", { verdict: "duplicate", duplicate_source: "host", box_id: null }),
    );
    await refused(
      executor,
      scan("duplicate-without-source", { verdict: "duplicate", box_id: null }),
    );
    await refused(
      executor,
      scan("wrong-gtin-with-source", {
        verdict: "wrong_gtin",
        duplicate_source: "local",
        box_id: null,
      }),
    );
  });

  it("close a box whole, with its SSCC, block and serial, or keep it open without them", async () => {
    const { executor } = openLocalDb();
    const closed = { closed_at: AT, sscc: "146006820000000017", block_id: "block-1", serial: 1 };
    await accepted(executor, box("box-1"));
    await accepted(executor, box("box-2", { shift_id: "shift-2", ...closed }));
    await refused(executor, box("box-3", { shift_id: "shift-3", closed_at: AT }));
    await refused(executor, box("box-4", { shift_id: "shift-4", sscc: "146006820000000024" }));
    await refused(executor, box("box-5", { shift_id: "shift-5", disassembled_at: AT }));
    await accepted(
      executor,
      box("box-6", {
        shift_id: "shift-6",
        ...closed,
        sscc: "146006820000000031",
        disassembled_at: AT,
      }),
    );
  });

  it("hold one open box per shift and pairing, and an SSCC on one box under any pairing", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, box("open-1"));
    await refused(executor, box("open-2"));
    await accepted(executor, box("open-3", { device_id: OTHER_DEVICE }));
    const closed = { closed_at: AT, block_id: "block-1", serial: 1, sscc: "146006820000000017" };
    await accepted(executor, box("closed-1", closed));
    await accepted(executor, box("closed-2", { ...closed, sscc: "146006820000000024" }));
    await refused(executor, box("closed-3", { ...closed, device_id: OTHER_DEVICE }));
  });

  it("move a block's cursor only from the value read, within the block", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, BLOCK);
    const take = (read: number): LocalStatement => ({
      sql:
        "UPDATE floor_sscc_blocks SET next_serial = next_serial + 1 " +
        "WHERE block_id = ? AND next_serial = ?",
      values: ["block-1", read],
      expectedChanges: 1,
    });
    await expect(executor.transaction([take(1)])).resolves.toEqual([1]);
    // A second writer that read the same cursor loses: the serial is spent.
    await expect(executor.transaction([take(1)])).rejects.toMatchObject({
      code: "changes_mismatch",
    });
    await expect(executor.transaction([take(2)])).resolves.toEqual([1]);
    // The block of serials 1–2 is used up at 3, and goes no further.
    await expect(executor.transaction([take(3)])).rejects.toMatchObject({
      code: "statement_failed",
    });
  });

  it("take an exception with the fields of its kind only", async () => {
    const { executor } = openLocalDb();
    const undo = { kind: "undo", code_hash: "a".repeat(64), target_scanned_at: AT };
    await accepted(executor, exception("undo", undo));
    await refused(executor, exception("undo-reason", { ...undo, reason_code: "other" }));
    await refused(executor, exception("undo-bare", { kind: "undo" }));
    await accepted(executor, exception("clear", { kind: "clear" }));
    await refused(executor, exception("clear-code", { kind: "clear", code_hash: "a".repeat(64) }));
    await accepted(executor, exception("reprint", { kind: "reprint", reason_code: "printer_jam" }));
    await refused(executor, exception("reprint-bare", { kind: "reprint" }));
    await accepted(
      executor,
      exception("other", { kind: "disassemble", reason_code: "other", reason_text: "Брак" }),
    );
    await refused(
      executor,
      exception("words", {
        kind: "disassemble",
        reason_code: "wrong_product",
        reason_text: "Брак",
      }),
    );
    await refused(executor, exception("pallet", { kind: "pallet", reason_code: "other" }));
  });

  it("keep outbox records in their order, with a receipt and its time together", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, record("record-b"));
    await accepted(executor, record("record-a"));
    await accepted(
      executor,
      record("record-c", { outcome: "accepted", acked_at: AT, outcome_details: "{}" }),
    );
    expect(
      await executor.query(
        "SELECT id FROM outbox WHERE acked_at IS NULL ORDER BY seq",
        [],
        z.object({ id: z.string() }),
      ),
    ).toEqual([{ id: "record-b" }, { id: "record-a" }]);
    await refused(executor, record("record-a"));
    await refused(executor, record("no-time", { outcome: "rejected", outcome_code: "x" }));
    await refused(executor, record("no-outcome", { acked_at: AT }));
    await refused(executor, record("code-alone", { outcome_code: "invalid_record" }));
    await refused(executor, record("bad-payload", { payload: "{" }));
    await refused(executor, record("bad-outcome", { outcome: "lost", acked_at: AT }));
    // A kind the pilot's pallets add later needs no new migration.
    await accepted(executor, record("pallet", { kind: "pallet_closed" }));
  });
});

/** An INSERT of `row` into `table`. */
function put(table: string, row: Record<string, unknown>): LocalStatement {
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values: Object.values(row),
  };
}

function block(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  return put("floor_sscc_blocks", {
    block_id: id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    issuer_prefix: "460068200",
    extension: 0,
    from_serial: 1,
    to_serial: 2,
    next_serial: 1,
    received_at: AT,
    ...overrides,
  });
}

function request(id: string, overrides: Record<string, unknown> = {}): LocalStatement {
  return put("floor_block_requests", {
    request_id: id,
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    issuer_prefix: "460068200",
    extension: 0,
    requested_at: AT,
    ...overrides,
  });
}

function code(hash: string, overrides: Record<string, unknown> = {}): LocalStatement {
  return put("floor_codes", {
    host_id: HOST_ID,
    device_id: DEVICE_ID,
    code_hash: hash,
    shift_id: "shift-1",
    box_id: "box-1",
    scan_id: "scan-1",
    scanned_at: AT,
    ...overrides,
  });
}

/** The columns of a table as `name TYPE [NOT NULL] [DEFAULT x] [PKn]`, in order. */
const COLUMNS: Record<string, string[]> = {
  floor_shifts: [
    "host_id TEXT NOT NULL PK1",
    "device_id TEXT NOT NULL PK2",
    "id TEXT NOT NULL PK3",
    "number TEXT NOT NULL",
    "status TEXT NOT NULL",
    "mode TEXT NOT NULL",
    "pallets_enabled INTEGER NOT NULL",
    "created_from TEXT NOT NULL",
    "line_id TEXT NOT NULL",
    "product_id TEXT NOT NULL",
    "product_name TEXT NOT NULL",
    "product_gtin14 TEXT NOT NULL",
    "counterparty_name TEXT",
    "production_date TEXT NOT NULL",
    "planned_qty INTEGER",
    "box_capacity INTEGER NOT NULL",
    "box_template_id TEXT NOT NULL",
    "owner_device_id TEXT",
    "opened_at TEXT",
    "closed_at TEXT",
    "snapshot TEXT",
    "entered_at TEXT",
    "local_state TEXT",
    "seen_at INTEGER NOT NULL",
    "pallet_box_capacity INTEGER",
    "pallet_template_id TEXT",
  ],
  floor_sscc_blocks: [
    "block_id TEXT NOT NULL PK1",
    "host_id TEXT NOT NULL",
    "device_id TEXT NOT NULL",
    "issuer_prefix TEXT NOT NULL",
    "extension INTEGER NOT NULL",
    "from_serial INTEGER NOT NULL",
    "to_serial INTEGER NOT NULL",
    "next_serial INTEGER NOT NULL",
    "received_at TEXT NOT NULL",
  ],
  floor_block_requests: [
    "request_id TEXT NOT NULL PK1",
    "host_id TEXT NOT NULL",
    "device_id TEXT NOT NULL",
    "issuer_prefix TEXT NOT NULL",
    "extension INTEGER NOT NULL",
    "requested_at TEXT NOT NULL",
  ],
  floor_boxes: [
    "id TEXT NOT NULL PK1",
    "host_id TEXT NOT NULL",
    "device_id TEXT NOT NULL",
    "shift_id TEXT NOT NULL",
    "opened_at TEXT NOT NULL",
    "closed_at TEXT",
    "sscc TEXT",
    "block_id TEXT",
    "serial INTEGER",
    "item_count INTEGER NOT NULL DEFAULT 0",
    "closed_by TEXT",
    "disassembled_at TEXT",
    "needs_fix INTEGER NOT NULL DEFAULT 0",
    "pallet_id TEXT",
  ],
  floor_pallets: [
    "id TEXT NOT NULL PK1",
    "host_id TEXT NOT NULL",
    "device_id TEXT NOT NULL",
    "shift_id TEXT NOT NULL",
    "opened_at TEXT NOT NULL",
    "closed_at TEXT",
    "sscc TEXT",
    "block_id TEXT",
    "serial INTEGER",
    "closed_by TEXT",
    "disassembled_at TEXT",
  ],
  floor_pallet_exceptions: [
    "id TEXT NOT NULL PK1",
    "host_id TEXT NOT NULL",
    "device_id TEXT NOT NULL",
    "shift_id TEXT NOT NULL",
    "kind TEXT NOT NULL",
    "pallet_id TEXT NOT NULL",
    "reason_code TEXT NOT NULL",
    "reason_text TEXT",
    "occurred_at TEXT NOT NULL",
    "operator_id TEXT",
  ],
  floor_codes: [
    "host_id TEXT NOT NULL PK1",
    "device_id TEXT NOT NULL PK2",
    "code_hash TEXT NOT NULL PK3",
    "shift_id TEXT NOT NULL",
    "box_id TEXT NOT NULL",
    "scan_id TEXT NOT NULL",
    "scanned_at TEXT NOT NULL",
  ],
  // No column holds the text of a scan: the `invalid` ones keep a length and a class.
  floor_scans: [
    "id TEXT NOT NULL PK1",
    "host_id TEXT NOT NULL",
    "device_id TEXT NOT NULL",
    "shift_id TEXT NOT NULL",
    "box_id TEXT",
    "verdict TEXT NOT NULL",
    "duplicate_source TEXT",
    "raw_kind TEXT NOT NULL",
    "raw_length INTEGER NOT NULL",
    "code_hash TEXT",
    "gtin14 TEXT",
    "serial TEXT",
    "canonical TEXT",
    "scanned_at TEXT NOT NULL",
    "operator_id TEXT",
    "conflict INTEGER NOT NULL DEFAULT 0",
  ],
  floor_exceptions: [
    "id TEXT NOT NULL PK1",
    "host_id TEXT NOT NULL",
    "device_id TEXT NOT NULL",
    "shift_id TEXT NOT NULL",
    "kind TEXT NOT NULL",
    "box_id TEXT NOT NULL",
    "code_hash TEXT",
    "target_scanned_at TEXT",
    "reason_code TEXT",
    "reason_text TEXT",
    "occurred_at TEXT NOT NULL",
    "operator_id TEXT",
  ],
  floor_print_jobs: [
    "id TEXT NOT NULL PK1",
    "host_id TEXT NOT NULL",
    "device_id TEXT NOT NULL",
    "shift_id TEXT NOT NULL",
    "purpose TEXT NOT NULL",
    "subject_id TEXT NOT NULL",
    "sscc TEXT NOT NULL",
    "state TEXT NOT NULL",
    "verify INTEGER NOT NULL",
    "template_id TEXT NOT NULL",
    "template_rev INTEGER NOT NULL",
    "fields TEXT NOT NULL",
    "printer TEXT",
    "bytes_base64 TEXT",
    "error_code TEXT",
    "attempts INTEGER NOT NULL DEFAULT 0",
    "operator_id TEXT NOT NULL",
    "created_at TEXT NOT NULL",
    "updated_at TEXT NOT NULL",
  ],
  outbox: [
    "seq INTEGER PK1",
    "id TEXT NOT NULL",
    "host_id TEXT NOT NULL",
    "device_id TEXT NOT NULL",
    "kind TEXT NOT NULL",
    "shift_id TEXT NOT NULL",
    "payload TEXT NOT NULL",
    "created_at TEXT NOT NULL",
    "attempts INTEGER NOT NULL DEFAULT 0",
    "sent_at TEXT",
    "outcome TEXT",
    "outcome_code TEXT",
    "outcome_details TEXT",
    "acked_at TEXT",
  ],
};

describe("the shape of the production tables (migration 0006)", () => {
  it("fixes every column: its type, whether it is required, its default and its key", async () => {
    const { executor } = openLocalDb();
    const found: Record<string, string[]> = {};
    for (const tableName of DEVICE_TABLES) {
      const columns = await executor.query(
        'SELECT name, type, "notnull" AS required, dflt_value AS fallback, pk ' +
          "FROM pragma_table_info(?) ORDER BY cid",
        [tableName],
        z.object({
          name: z.string(),
          type: z.string(),
          required: z.number(),
          fallback: z.string().nullable(),
          pk: z.number(),
        }),
      );
      found[tableName] = columns.map(
        (column) =>
          `${column.name} ${column.type}${column.required === 1 ? " NOT NULL" : ""}` +
          `${column.fallback === null ? "" : ` DEFAULT ${column.fallback}`}` +
          `${column.pk === 0 ? "" : ` PK${column.pk}`}`,
      );
    }
    expect(found).toEqual(COLUMNS);
  });

  it("fixes the indexes: which are unique, which are partial", async () => {
    const { executor } = openLocalDb();
    const names = DEVICE_TABLES.map((name) => `'${name}'`).join(", ");
    const indexes = await executor.query(
      'SELECT t.name AS tableName, i.name AS name, i."unique" AS isUnique, i.partial AS isPartial ' +
        "FROM pragma_table_list AS t, pragma_index_list(t.name) AS i " +
        `WHERE t.schema = 'main' AND i.origin = 'c' AND t.name IN (${names}) ORDER BY i.name`,
      [],
      z.object({
        tableName: z.string(),
        name: z.string(),
        isUnique: z.number(),
        isPartial: z.number(),
      }),
    );
    expect(indexes).toEqual([
      { tableName: "floor_boxes", name: "floor_boxes_open", isUnique: 1, isPartial: 1 },
      { tableName: "floor_boxes", name: "floor_boxes_pallet", isUnique: 0, isPartial: 1 },
      { tableName: "floor_boxes", name: "floor_boxes_shift", isUnique: 0, isPartial: 0 },
      { tableName: "floor_boxes", name: "floor_boxes_sscc", isUnique: 1, isPartial: 1 },
      { tableName: "floor_codes", name: "floor_codes_box", isUnique: 0, isPartial: 0 },
      { tableName: "floor_codes", name: "floor_codes_shift", isUnique: 0, isPartial: 0 },
      {
        tableName: "floor_exceptions",
        name: "floor_exceptions_shift",
        isUnique: 0,
        isPartial: 0,
      },
      {
        tableName: "floor_pallet_exceptions",
        name: "floor_pallet_exceptions_shift",
        isUnique: 0,
        isPartial: 0,
      },
      { tableName: "floor_pallets", name: "floor_pallets_open", isUnique: 1, isPartial: 1 },
      { tableName: "floor_pallets", name: "floor_pallets_shift", isUnique: 0, isPartial: 0 },
      { tableName: "floor_pallets", name: "floor_pallets_sscc", isUnique: 1, isPartial: 1 },
      {
        tableName: "floor_print_jobs",
        name: "floor_print_jobs_open",
        isUnique: 1,
        isPartial: 1,
      },
      {
        tableName: "floor_print_jobs",
        name: "floor_print_jobs_shift",
        isUnique: 0,
        isPartial: 0,
      },
      { tableName: "floor_scans", name: "floor_scans_shift", isUnique: 0, isPartial: 0 },
      { tableName: "floor_shifts", name: "floor_shifts_line", isUnique: 0, isPartial: 0 },
      {
        tableName: "floor_sscc_blocks",
        name: "floor_sscc_blocks_prefix",
        isUnique: 0,
        isPartial: 0,
      },
      { tableName: "outbox", name: "outbox_settled", isUnique: 0, isPartial: 1 },
      { tableName: "outbox", name: "outbox_shift", isUnique: 0, isPartial: 0 },
      { tableName: "outbox", name: "outbox_unsent", isUnique: 0, isPartial: 1 },
    ]);
  });

  // The plans are those of node:sqlite (SQLite 3.53 in the test runtime); the
  // shell bundles SQLite 3.46, whose planner can differ. The same reads are
  // pinned on the shell's own SQLite in `tests/local_db.rs`
  // (`the_floors_repeating_reads_search_an_index`): keep the two lists alike.
  it("serve the reads the floor makes from an index", () => {
    const { db } = openLocalDb();
    const plan = (sql: string): string =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: sql.split("?").length - 1 }, () => "x"))
        .map((step) => String(step["detail"]))
        .join("\n");
    // The sender and the forget's count read a pairing's unsent records in order.
    expect(
      plan(
        "SELECT id FROM outbox WHERE host_id = ? AND device_id = ? AND acked_at IS NULL " +
          "AND shift_id <> ? ORDER BY seq",
      ),
    ).toContain("outbox_unsent");
    expect(
      plan(
        "SELECT id, kind, payload FROM outbox WHERE host_id = ? AND device_id = ? " +
          "AND acked_at IS NULL ORDER BY seq LIMIT ?",
      ),
    ).toContain("outbox_unsent");
    expect(
      plan("SELECT id FROM floor_shifts WHERE host_id = ? AND device_id = ? AND line_id = ?"),
    ).toContain("floor_shifts_line");
    expect(
      plan("SELECT id FROM floor_scans WHERE host_id = ? AND device_id = ? AND shift_id = ?"),
    ).toContain("floor_scans_shift");
    // The status bar re-counts the outbox after every scan, as three counts (one
    // FILTER scan would read every record, payload included), reads the oldest
    // record not delivered while a send fails, and the serials left of the shift's
    // prefix. The statements are the bar's own (`src/floor/outbox-status.ts`).
    expect(plan(UNSENT_COUNT_SQL)).toContain("outbox_unsent");
    for (const sql of [REJECTED_COUNT_SQL, CONFLICT_COUNT_SQL]) {
      expect(plan(sql)).toContain("outbox_settled (host_id=? AND device_id=? AND outcome=?)");
    }
    expect(plan(HEAD_RECORD_SQL)).toContain("outbox_unsent (host_id=? AND device_id=?)");
    expect(plan(SHIFT_PREFIX_SQL)).toContain(
      "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)",
    );
    expect(plan(BLOCKS_WITH_ROOM_SQL)).toContain(
      "floor_sscc_blocks_prefix (host_id=? AND device_id=? AND issuer_prefix=? AND extension=?)",
    );
    for (const sql of [
      UNSENT_COUNT_SQL,
      REJECTED_COUNT_SQL,
      CONFLICT_COUNT_SQL,
      HEAD_RECORD_SQL,
      SHIFT_PREFIX_SQL,
      BLOCKS_WITH_ROOM_SQL,
    ]) {
      expect(
        plan(sql)
          .split("\n")
          .filter((step) => step.startsWith("SCAN ") || step.includes("TEMP B-TREE")),
        sql,
      ).toEqual([]);
    }
    // The totals of the work screen: the codes and the closed boxes of a shift,
    // and the last SSCC.
    expect(
      plan("SELECT count(*) FROM floor_codes WHERE host_id = ? AND device_id = ? AND shift_id = ?"),
    ).toContain("floor_codes_shift (host_id=? AND device_id=? AND shift_id=?)");
    expect(
      plan(
        "SELECT count(*) FROM floor_boxes WHERE host_id = ? AND device_id = ? AND shift_id = ? " +
          "AND closed_at IS NOT NULL AND disassembled_at IS NULL",
      ),
    ).toContain("floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?");
    expect(
      plan(
        "SELECT sscc FROM floor_boxes WHERE host_id = ? AND device_id = ? AND shift_id = ? " +
          "AND closed_at IS NOT NULL ORDER BY closed_at DESC, serial DESC LIMIT 1",
      ),
    ).toContain("floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?");
    // The digest of a closing box reads its codes (the statement is the close's own).
    expect(plan(BOX_CODES_SQL)).toContain(
      "floor_codes_box (host_id=? AND device_id=? AND box_id=?)",
    );
    expect(plan(BOX_CODES_SQL)).not.toContain("TEMP B-TREE");
    // A box closed whose answer was lost is read back by its own key.
    expect(plan(CLOSED_BOX_SQL)).toContain("sqlite_autoindex_floor_boxes_1 (id=?)");
    // The box exceptions (plan 2a8): the last code of the open box and the newest scan
    // among its codes search the box's own codes (the sort of a box's few codes is
    // the capacity's worth), the closed boxes of a shift the shift's index, a box
    // is read by its key and the box's newest print job through the shift's jobs.
    for (const sql of [LAST_CODE_SQL, NEWEST_CODE_SCAN_SQL]) {
      expect(plan(sql)).toContain("floor_codes_box (host_id=? AND device_id=? AND box_id=?)");
    }
    expect(plan(CLOSED_BOXES_SQL)).toContain(
      "floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?",
    );
    expect(plan(BOX_STATE_SQL)).toContain("sqlite_autoindex_floor_boxes_1 (id=?)");
    expect(plan(LAST_BOX_JOB_SQL)).toContain(
      "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)",
    );
    for (const sql of [NEWEST_CODE_SCAN_SQL, BOX_STATE_SQL, LAST_BOX_JOB_SQL]) {
      expect(plan(sql), sql).not.toContain("TEMP B-TREE");
    }
    // The pallets (plan ПЛ-Ц), read and written on every box close and render of a shift with
    // pallets: the open pallet with its two counts through the shift's open pallet and the
    // pallet's boxes; a pallet's close and a box joining it by their keys (the close counts the
    // pallet's boxes through the same index); the shift close's check and its summary, which
    // search the open pallet and its boxes instead of the pairing's boxes (the planner walked
    // `floor_boxes_shift` of the whole pairing for a join); and the label queue's read through
    // the shift's jobs, sorted for the few that wait: the one temporary structure allowed.
    const OPEN_PALLET_INDEX = "floor_pallets_open (host_id=? AND device_id=? AND shift_id=?)";
    const PALLET_BOXES_INDEX = "floor_boxes_pallet (pallet_id=?)";
    const SHIFT_KEY = "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)";
    for (const [sql, keys] of [
      [OPEN_PALLET_SQL, [OPEN_PALLET_INDEX, PALLET_BOXES_INDEX]],
      [CLOSE_PALLET_SQL, ["sqlite_autoindex_floor_pallets_1 (id=?)", PALLET_BOXES_INDEX]],
      [JOIN_PALLET_SQL, ["sqlite_autoindex_floor_pallets_1 (id=?)"]],
      [BOX_ONTO_PALLET_SQL, ["sqlite_autoindex_floor_boxes_1 (id=?)"]],
      [PALLET_SSCC_HELD_SQL, ["floor_pallets_sscc (sscc=?)"]],
      // The exceptions of a pallet (task 4): the closed pallets of a shift through the shift's
      // pallets with their boxes counted through the pallet's boxes, a pallet by its key
      // (with its boxes counted), its disassembly and the reprint's comparison by the same
      // key, the pallet's newest job through the shift's jobs and the comparison against a
      // newer one through the job's own key and the same index.
      [
        CLOSED_PALLETS_SQL,
        ["floor_pallets_shift (host_id=? AND device_id=? AND shift_id=?)", PALLET_BOXES_INDEX],
      ],
      [PALLET_STATE_SQL, ["sqlite_autoindex_floor_pallets_1 (id=?)", PALLET_BOXES_INDEX]],
      [DISASSEMBLE_PALLET_SQL, ["sqlite_autoindex_floor_pallets_1 (id=?)"]],
      [PALLET_LIVE_GUARD_SQL, ["sqlite_autoindex_floor_pallets_1 (id=?)"]],
      // The disassembly's check that no job of the pallet's label is open: the pallet by its key
      // and the open job by the open-job index, which holds exactly that rule.
      [
        PALLET_LABEL_CLOSED_GUARD_SQL,
        [
          "sqlite_autoindex_floor_pallets_1 (id=?)",
          "floor_print_jobs_open (host_id=? AND device_id=? AND purpose=? AND subject_id=?)",
        ],
      ],
      [LAST_PALLET_JOB_SQL, ["floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)"]],
      [
        NEWEST_PALLET_JOB_GUARD_SQL,
        [
          "sqlite_autoindex_floor_print_jobs_1 (id=?)",
          "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?",
        ],
      ],
      [OPEN_PALLET_GUARD_SQL, [SHIFT_KEY, OPEN_PALLET_INDEX, PALLET_BOXES_INDEX]],
      [CLOSE_SUMMARY_SQL, [SHIFT_KEY, OPEN_PALLET_INDEX, PALLET_BOXES_INDEX]],
      [OPEN_JOB_READ_SQL, ["floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)"]],
    ] as const) {
      for (const key of keys) expect(plan(sql), sql).toContain(key);
      expect(
        plan(sql)
          .split("\n")
          .filter((step) => step.startsWith("SCAN ")),
        sql,
      ).toEqual([]);
    }
    expect(
      plan(OPEN_JOB_READ_SQL)
        .split("\n")
        .filter((step) => step.includes("TEMP")),
    ).toEqual(["USE TEMP B-TREE FOR ORDER BY"]);
    // The closed pallets of a shift are sorted, the few pallets of one shift; the others sort
    // nothing: a pallet's newest job is read by the rowid the index ends with.
    expect(
      plan(CLOSED_PALLETS_SQL)
        .split("\n")
        .filter((step) => step.includes("TEMP")),
    ).toEqual(["USE TEMP B-TREE FOR ORDER BY"]);
    for (const sql of [
      PALLET_STATE_SQL,
      DISASSEMBLE_PALLET_SQL,
      PALLET_LIVE_GUARD_SQL,
      PALLET_LABEL_CLOSED_GUARD_SQL,
      LAST_PALLET_JOB_SQL,
      NEWEST_PALLET_JOB_GUARD_SQL,
    ]) {
      expect(plan(sql), sql).not.toContain("TEMP B-TREE");
    }
    for (const sql of [
      OPEN_PALLET_SQL,
      CLOSE_PALLET_SQL,
      OPEN_PALLET_GUARD_SQL,
      CLOSE_SUMMARY_SQL,
      CLOSED_PALLETS_SQL,
      PALLET_STATE_SQL,
    ]) {
      expect(plan(sql), sql).not.toContain("floor_boxes_shift (host_id=? AND device_id=?)");
    }
    // The scan pipeline's own reads and its one UPDATE, on every scan: the
    // station's registry of a code (the key of `floor_codes`), the open box of
    // a shift, and the open box's count by the box's own key.
    expect(
      plan(
        "SELECT scanned_at FROM floor_codes WHERE host_id = ? AND device_id = ? AND code_hash = ?",
      ),
    ).toContain("sqlite_autoindex_floor_codes_1 (host_id=? AND device_id=? AND code_hash=?)");
    expect(
      plan(
        "SELECT id, opened_at, item_count FROM floor_boxes WHERE host_id = ? AND device_id = ? " +
          "AND shift_id = ? AND closed_at IS NULL",
      ),
    ).toContain("floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?");
    expect(
      plan(
        "UPDATE floor_boxes SET item_count = item_count + 1 " +
          "WHERE id = ? AND host_id = ? AND device_id = ? AND closed_at IS NULL",
      ),
    ).toContain("sqlite_autoindex_floor_boxes_1 (id=?)");
    // The close of a box: the next serial of the earliest block with room (a
    // few blocks of the prefix, ordered after the search), whether a box already
    // holds the SSCC (the global unique key), the cursor's compare-and-set by the
    // block's key and the box's own close by its key.
    expect(
      plan(
        "SELECT block_id, next_serial FROM floor_sscc_blocks WHERE host_id = ? AND device_id = ? " +
          "AND issuer_prefix = ? AND extension = ? AND next_serial <= to_serial " +
          "ORDER BY from_serial, block_id LIMIT 1",
      ),
    ).toContain(
      "floor_sscc_blocks_prefix (host_id=? AND device_id=? AND issuer_prefix=? AND extension=?)",
    );
    expect(plan("SELECT 1 AS n FROM floor_boxes WHERE sscc = ? LIMIT 1")).toContain(
      "floor_boxes_sscc (sscc=?)",
    );
    expect(
      plan(
        "UPDATE floor_sscc_blocks SET next_serial = next_serial + 1 " +
          "WHERE block_id = ? AND next_serial = ?",
      ),
    ).toContain("sqlite_autoindex_floor_sscc_blocks_1 (block_id=?)");
    expect(
      plan(
        "UPDATE floor_boxes SET closed_at = ?, sscc = ?, block_id = ?, serial = ?, closed_by = ? " +
          "WHERE id = ? AND host_id = ? AND device_id = ? AND closed_at IS NULL AND item_count = ?",
      ),
    ).toContain("sqlite_autoindex_floor_boxes_1 (id=?)");
    // The supply of SSCC blocks: the newest block of the prefix (the half rule),
    // whether a block shares serials with one kept, and a request's removal by its key
    // (the blocks with room, which the serials left come from, are pinned above). The waiting request's own read scans the one
    // small table of requests (below).
    const prefixIndex =
      "floor_sscc_blocks_prefix (host_id=? AND device_id=? AND issuer_prefix=? AND extension=?)";
    expect(
      plan(
        "SELECT from_serial, to_serial, next_serial FROM floor_sscc_blocks WHERE host_id = ? " +
          "AND device_id = ? AND issuer_prefix = ? AND extension = ? ORDER BY from_serial DESC LIMIT 1",
      ),
    ).toContain(prefixIndex);
    expect(
      plan(
        "SELECT 1 AS n FROM floor_sscc_blocks WHERE host_id = ? AND device_id = ? " +
          "AND issuer_prefix = ? AND extension = ? AND block_id <> ? " +
          "AND from_serial <= ? AND to_serial >= ? LIMIT 1",
      ),
    ).toContain(prefixIndex);
    expect(plan("DELETE FROM floor_block_requests WHERE request_id = ?")).toContain(
      "sqlite_autoindex_floor_block_requests_1 (request_id=?)",
    );
    // At most one request waits per pairing and prefix: the read takes the table whole.
    expect(
      plan(
        "SELECT request_id, issuer_prefix, extension FROM floor_block_requests " +
          "WHERE host_id = ? AND device_id = ? AND issuer_prefix = ? AND extension = ? " +
          "ORDER BY requested_at, request_id LIMIT 1",
      )
        .split("\n")
        .filter((step) => step.startsWith("SCAN ")),
    ).toEqual(["SCAN floor_block_requests"]);
    // What the sender writes, taken from the sender itself (a copy of its text
    // would not notice a change to the statement it runs): each statement looks
    // its few records up by their own key. The planner would rather walk the
    // `(host_id, device_id, …)` prefix of `outbox_unsent`, `floor_scans_shift`
    // or `floor_boxes_shift` — every unsent record, scan and box of the pairing
    // for each batch (9 s for the outbox's own statement with 100,000 records).
    const pairing = { hostId: HOST_ID, deviceId: DEVICE_ID };
    const attempt = attemptStatement(pairing, "[]", "x");
    expect(plan(attempt.sql)).toContain(
      "SEARCH outbox USING INDEX sqlite_autoindex_outbox_1 (id=?)",
    );
    const [settle, mark, fix, close] = receiptStatements(pairing, "[]", "x");
    expect(plan(settle?.sql ?? "")).toContain(
      "SEARCH outbox USING INDEX sqlite_autoindex_outbox_1 (id=?)",
    );
    expect(plan(mark?.sql ?? "")).toContain(
      "SEARCH floor_scans USING INDEX sqlite_autoindex_floor_scans_1 (id=?)",
    );
    expect(plan(fix?.sql ?? "")).toContain(
      "SEARCH floor_boxes USING INDEX sqlite_autoindex_floor_boxes_1 (id=?)",
    );
    expect(plan(fix?.sql ?? "")).toContain(
      "SEARCH floor_scans USING INDEX sqlite_autoindex_floor_scans_1 (id=?)",
    );
    // The close a receipt gives its shift (plan 2a8) looks the batch's records up by their key
    // too: the planner would rather walk `outbox_settled`, every settled record of the pairing.
    expect(plan(close?.sql ?? "")).toContain(
      "SEARCH outbox USING INDEX sqlite_autoindex_outbox_1 (id=?)",
    );
    expect(plan(close?.sql ?? "")).toContain(
      "SEARCH floor_shifts USING INDEX sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)",
    );
    for (const statement of [attempt, settle, mark, fix, close]) {
      for (const slow of [
        "outbox_unsent",
        "outbox_settled",
        "floor_scans_shift",
        "floor_boxes_shift",
      ]) {
        expect(plan(statement?.sql ?? "")).not.toContain(slow);
      }
    }
    expect(plan(UNSENT_SQL)).toContain("outbox_unsent");
    // Every record the floor writes (each scan too) is written by `outboxStatement`, whose
    // guard looks the shift of the pairing up to see whether this station has closed it
    // (plan 2a8): by the shift's own key, not by a walk over the pairing's shifts.
    const guarded = outboxStatement(
      shiftClosedRecord(
        { id: "5d3c2b1a-9e8f-4a7b-8c6d-5e4f3a2b1c0d", shiftId: LINE_ID, operatorId: DEVICE_ID },
        {
          plannedQtySnapshot: null,
          actualQty: 0,
          closedBoxCount: 0,
          reasonCode: null,
          closedAt: AT,
        },
      ),
      pairing,
      AT,
    );
    const guardPlan = plan(guarded.sql);
    expect(guardPlan).toContain(
      "SEARCH floor_shifts USING INDEX sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)",
    );
    expect(guardPlan.split("\n").filter((step) => step.startsWith("SCAN floor_"))).toEqual([]);
    // The retention pass (plan 2a8), once an hour. The due select starts from the accepted
    // closes: its first step walks `outbox_settled` once, and each close it finds costs a search
    // of the shift's unsent records (`outbox_shift`, migration `0010`, the index alone), of the
    // shift's jobs and of the shift's copy by its key. Asking per copy instead walked the
    // pairing's accepted records once for every shift (shifts × records: 6.5 s at 600 000 rows
    // and 70 shifts). The only temporary structure allowed is the one of its `DISTINCT`. An index
    // by shift led by the pairing would become this first step (a walk of every record of the
    // pairing): `outbox_shift` is led by the shift on purpose (plan ХП, Д1).
    const due = plan(DUE_SHIFTS_SQL).split("\n");
    expect(due[0], DUE_SHIFTS_SQL).toBe(
      "SEARCH o USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)",
    );
    expect(due.filter((step) => step.includes("outbox_settled"))).toHaveLength(1);
    expect(due.filter((step) => step.startsWith("SCAN "))).toEqual([]);
    expect(due.filter((step) => step.includes("TEMP"))).toEqual(["USE TEMP B-TREE FOR DISTINCT"]);
    for (const key of [
      "outbox_shift (shift_id=? AND host_id=? AND device_id=? AND acked_at=?)",
      "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)",
      "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)",
    ]) {
      expect(due.join("\n"), key).toContain(key);
    }
    // The delete of a copy searches the one shift's own records: its accepted close and its
    // unsent records through `outbox_shift`, its jobs, the copy by its key; no temporary one.
    const purge = plan(PURGE_COPY_SQL);
    for (const key of [
      "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)",
      "outbox_shift (shift_id=? AND host_id=? AND device_id=? AND acked_at<?)",
      "outbox_shift (shift_id=? AND host_id=? AND device_id=? AND acked_at=?)",
      "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)",
    ]) {
      expect(purge, key).toContain(key);
    }
    expect(purge.split("\n").filter((step) => step.startsWith("SCAN "))).toEqual([]);
    expect(purge).not.toContain("TEMP");
    // The refused closes of the shift list (plan 2a8), read again on every bump of the outbox
    // while the list is shown, a reconnect's every batch included: the pairing's refused records
    // through `outbox_settled`, in `seq` order with no sort of its own.
    const refused = plan(REFUSED_CLOSES_SQL).split("\n");
    expect(refused[0], REFUSED_CLOSES_SQL).toBe(
      "SEARCH outbox USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)",
    );
    expect(refused.filter((step) => step.startsWith("SCAN ") || step.includes("TEMP"))).toEqual([]);
    // The deletes of a purged shift's records search the table's index by shift: every table of
    // `RETAINED_TABLES` has one since migration `0010` (plan ХП), and a table that joins the list
    // needs one too, or this fails.
    const bySearch: ReadonlyMap<string, string> = new Map([
      ["floor_scans", "floor_scans_shift (host_id=? AND device_id=? AND shift_id=?"],
      ["floor_codes", "floor_codes_shift (host_id=? AND device_id=? AND shift_id=?"],
      ["floor_print_jobs", "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?"],
      ["floor_boxes", "floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?"],
      ["floor_pallets", "floor_pallets_shift (host_id=? AND device_id=? AND shift_id=?"],
      ["floor_exceptions", "floor_exceptions_shift (shift_id=? AND host_id=? AND device_id=?"],
      [
        "floor_pallet_exceptions",
        "floor_pallet_exceptions_shift (shift_id=? AND host_id=? AND device_id=?",
      ],
      ["outbox", "outbox_shift (shift_id=? AND host_id=? AND device_id=?"],
    ]);
    for (const table of RETAINED_TABLES) {
      const steps = plan(purgeTableSql(table)).split("\n");
      expect(steps.join("\n"), table).toContain(bySearch.get(table) ?? `${table}: no index`);
      expect(
        steps.filter((step) => step.startsWith("SCAN ")),
        table,
      ).toEqual([]);
    }
  });

  // The same for what the status bar reads.
  it("are pinned on the shell's SQLite with the status bar's and the work screen's own statements", () => {
    const source = readFileSync(new URL("../src-tauri/tests/local_db.rs", testModuleUrl), "utf8")
      // A line continuation of a Rust string drops the newline and the next line's indent.
      .replace(/\\\n\s*/g, "");
    const statements = [
      UNSENT_COUNT_SQL,
      REJECTED_COUNT_SQL,
      CONFLICT_COUNT_SQL,
      HEAD_RECORD_SQL,
      SHIFT_PREFIX_SQL,
      BLOCKS_WITH_ROOM_SQL,
      CLOSED_BOX_SQL,
      BOX_CODES_SQL,
      LAST_CODE_SQL,
      NEWEST_CODE_SCAN_SQL,
      CLOSED_BOXES_SQL,
      BOX_STATE_SQL,
      LAST_BOX_JOB_SQL,
      OPEN_PALLET_SQL,
      CLOSE_PALLET_SQL,
      JOIN_PALLET_SQL,
      BOX_ONTO_PALLET_SQL,
      PALLET_SSCC_HELD_SQL,
      OPEN_PALLET_GUARD_SQL,
      CLOSE_SUMMARY_SQL,
      OPEN_JOB_READ_SQL,
      CLOSED_PALLETS_SQL,
      PALLET_STATE_SQL,
      DISASSEMBLE_PALLET_SQL,
      PALLET_LIVE_GUARD_SQL,
      PALLET_LABEL_CLOSED_GUARD_SQL,
      LAST_PALLET_JOB_SQL,
      NEWEST_PALLET_JOB_GUARD_SQL,
    ];
    expect(new Set(statements).size).toBe(28);
    for (const sql of statements) expect(source).toContain(`"${sql}"`);
    // The retention pass's statements, as `tests/local_db.rs` plans them (the refused closes' read
    // among them): the long ones as constants, every table's delete by shift as a literal (each
    // searches an index by shift since migration `0010`, plan ХП).
    const retention = [
      DUE_SHIFTS_SQL,
      PURGE_COPY_SQL,
      REFUSED_CLOSES_SQL,
      ...RETAINED_TABLES.map(purgeTableSql),
    ];
    expect(new Set(retention).size).toBe(11);
    for (const sql of retention) expect(source).toContain(`"${sql}"`);
  });

  // The shell's list (`tests/local_db.rs`) is written by hand: it must hold the
  // exact text of every statement the sender runs, or its plans pin another text.
  it("are pinned on the shell's SQLite with the sender's own statements", () => {
    const pairing = { hostId: HOST_ID, deviceId: DEVICE_ID };
    const source = readFileSync(new URL("../src-tauri/tests/local_db.rs", testModuleUrl), "utf8")
      // A line continuation of a Rust string drops the newline and the next line's indent.
      .replace(/\\\n\s*/g, "");
    const statements = [
      UNSENT_SQL,
      attemptStatement(pairing, "[]", "x").sql,
      ...receiptStatements(pairing, "[]", "x").map((statement) => statement.sql),
    ];
    expect(statements).toHaveLength(6);
    for (const sql of statements) expect(source).toContain(`"${sql}"`);
  });

  // What a station owes a restored host (plan РК-С; `src/local/restore-reconcile.ts`): the
  // status bar reads the obligation on every bump, the reconciliation runs once per restore
  // but over everything the station keeps, so none of its statements may read a table whole.
  // Pinned on the shell's SQLite too (`the_floors_repeating_reads_search_an_index`), with the
  // same texts.
  it("serve the reconciliation after a restore from an index", () => {
    const { db } = openLocalDb();
    const plan = (sql: string): string[] =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: sql.split("?").length - 1 }, () => "x"))
        .map((step) => String(step["detail"]));
    const OWN = "sqlite_autoindex_floor_restore_epochs_1 (host_id=? AND device_id=?)";
    // The stuck line's clamp after a restore (`src/floor/outbox-status.ts`) reads it the same way.
    for (const sql of [DUE_SQL, STATUS_SQL, SETTLE_SQL, RECONCILED_AT_SQL]) {
      expect(plan(sql), sql).toEqual([`SEARCH floor_restore_epochs USING INDEX ${OWN}`]);
    }
    // Every block of the pairing, sorted once in memory (a pairing keeps some hundreds).
    expect(plan(BLOCKS_SQL)).toEqual([
      "SEARCH floor_sscc_blocks USING INDEX floor_sscc_blocks_prefix (host_id=? AND device_id=?)",
      "USE TEMP B-TREE FOR ORDER BY",
    ]);
    // The refused blocks are found among the pairing's own, the ids from a JSON list.
    const retire = plan(RETIRE_SQL);
    expect(retire[0]).toBe(
      "SEARCH floor_sscc_blocks USING INDEX floor_sscc_blocks_prefix (host_id=? AND device_id=?)",
    );
    expect(
      retire.filter((step) => step.startsWith("SCAN ") && !step.includes("json_each")),
    ).toEqual([]);
    // The records to send again are the pairing's settled ones, not the whole outbox.
    const reopen = plan(REOPEN_SQL);
    expect(reopen[0]).toBe(
      "SEARCH outbox USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome>?)",
    );
    expect(reopen.filter((step) => step.startsWith("SCAN ") || step.includes("TEMP"))).toEqual([]);
  });

  it("are pinned on the shell's SQLite with the reconciliation's own statements", () => {
    const source = readFileSync(new URL("../src-tauri/tests/local_db.rs", testModuleUrl), "utf8")
      // A line continuation of a Rust string drops the newline and the next line's indent.
      .replace(/\\\n\s*/g, "");
    const statements = [
      DUE_SQL,
      STATUS_SQL,
      BLOCKS_SQL,
      RETIRE_SQL,
      REOPEN_SQL,
      SETTLE_SQL,
      RECONCILED_AT_SQL,
    ];
    expect(new Set(statements).size).toBe(7);
    for (const sql of statements) expect(source).toContain(`"${sql}"`);
  });
});

describe("the rules of the production tables the first examples leave open", () => {
  it("refuse a row whose key is missing, in every table", async () => {
    const { executor } = openLocalDb();
    await refused(executor, box("box-null", { id: null }));
    await refused(executor, scan("x", { id: null }));
    await refused(executor, exception("x", { id: null, kind: "clear" }));
    await refused(executor, block("x", { block_id: null }));
    await refused(executor, request("x", { request_id: null }));
    await refused(executor, shift("x", { id: null }));
    await refused(executor, code("x", { code_hash: null }));
    await refused(executor, record("x", { id: null }));
  });

  it("limit a shift's flags, origin and numbers", async () => {
    const { executor } = openLocalDb();
    for (const status of ["planned", "active", "closed"]) {
      await accepted(executor, shift(`status-${status}`, { status }));
    }
    await accepted(executor, shift("pallets", { pallets_enabled: 1 }));
    await accepted(executor, shift("station", { created_from: "station" }));
    await accepted(executor, shift("planned-qty", { planned_qty: 1 }));
    await accepted(executor, shift("capacity-one", { box_capacity: 1 }));
    await refused(executor, shift("pallets-2", { pallets_enabled: 2 }));
    await refused(executor, shift("pallets-text", { pallets_enabled: "yes" }));
    await refused(executor, shift("from-cloud", { created_from: "cloud" }));
    await refused(executor, shift("qty-zero", { planned_qty: 0 }));
    await refused(executor, shift("qty-negative", { planned_qty: -5 }));
    await refused(executor, shift("capacity-zero", { box_capacity: 0 }));
    await refused(executor, shift("capacity-negative", { box_capacity: -1 }));
    // A closed shift the station entered is read as closed, however it closed.
    await accepted(
      executor,
      shift("closed-here", {
        status: "active",
        snapshot: "{}",
        entered_at: AT,
        local_state: "closed",
      }),
    );
  });

  it("limit an SSCC block's serials and its cursor", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, block("whole"));
    await accepted(executor, block("single", { from_serial: 5, to_serial: 5, next_serial: 5 }));
    await accepted(executor, block("from-zero", { from_serial: 0, to_serial: 0, next_serial: 0 }));
    await accepted(executor, block("used-up", { next_serial: 3 }));
    await accepted(executor, block("extension", { extension: 1 }));
    await refused(executor, block("whole"));
    await refused(executor, block("extension-2", { extension: 2 }));
    await refused(executor, block("from-negative", { from_serial: -1, next_serial: 0 }));
    await refused(executor, block("reversed", { from_serial: 3, to_serial: 2, next_serial: 3 }));
    await refused(executor, block("before-block", { next_serial: 0 }));
    await refused(executor, block("past-block", { next_serial: 4 }));
  });

  it("keep a block request once and with its own extension", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, request("request-1"));
    await accepted(executor, request("request-2", { extension: 1 }));
    await refused(executor, request("request-1"));
    await refused(executor, request("request-3", { extension: 2 }));
  });

  it("close a box only whole: each of the SSCC, the block and the serial, and nothing before", async () => {
    const { executor } = openLocalDb();
    const closed = { closed_at: AT, sscc: "146006820000000017", block_id: "block-1", serial: 1 };
    await accepted(executor, box("whole", { shift_id: "shift-1", ...closed }));
    for (const [shiftId, missing] of [
      ["no-sscc", "sscc"],
      ["no-block", "block_id"],
      ["no-serial", "serial"],
    ] as const) {
      await refused(
        executor,
        box(`closed-${shiftId}`, {
          shift_id: shiftId,
          ...closed,
          sscc: "146006820000000024",
          [missing]: null,
        }),
      );
    }
    // An open box names no block and no serial either.
    await refused(executor, box("open-block", { shift_id: "s-block", block_id: "block-1" }));
    await refused(executor, box("open-serial", { shift_id: "s-serial", serial: 7 }));
    await refused(executor, box("open-sscc", { shift_id: "s-sscc", sscc: "146006820000000031" }));
    await refused(executor, box("whole", { shift_id: "s-again" }));
    await refused(executor, box("count", { shift_id: "s-count", item_count: -1 }));
    await refused(executor, box("fix", { shift_id: "s-fix", needs_fix: 2 }));
    await accepted(
      executor,
      box("counted", { shift_id: "s-counted", item_count: 12, needs_fix: 1 }),
    );
    // A box starts empty and not to be fixed.
    expect(
      await executor.query(
        "SELECT item_count AS itemCount, needs_fix AS needsFix FROM floor_boxes WHERE id = 'whole'",
        [],
        z.object({ itemCount: z.number(), needsFix: z.number() }),
      ),
    ).toEqual([{ itemCount: 0, needsFix: 0 }]);
  });

  it("hold a code once per pairing, and the same code under another pairing", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, code("hash-1"));
    await accepted(executor, code("hash-2"));
    await refused(executor, code("hash-1", { shift_id: "shift-2", box_id: "box-2" }));
    await accepted(executor, code("hash-1", { device_id: OTHER_DEVICE }));
    await accepted(executor, code("hash-1", { host_id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" }));
  });

  it("take a scan only as one of the four verdicts, with a known source, kind and size", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, scan("scan-ok"));
    await refused(executor, scan("scan-ok", { shift_id: "shift-2" }));
    // Rows that keep every other rule, so only the list of verdicts refuses them.
    await refused(executor, scan("verdict", { verdict: "maybe", box_id: null }));
    await refused(
      executor,
      scan("source", { verdict: "duplicate", duplicate_source: "cloud", box_id: null }),
    );
    const bare = {
      verdict: "invalid",
      box_id: null,
      code_hash: null,
      gtin14: null,
      serial: null,
      canonical: null,
    };
    await refused(executor, scan("kind", { ...bare, raw_kind: "qr" }));
    await accepted(executor, scan("empty", { ...bare, raw_kind: "unknown", raw_length: 0 }));
    await refused(executor, scan("length", { ...bare, raw_kind: "unknown", raw_length: -1 }));
    await refused(executor, scan("conflict", { conflict: 2 }));
    await accepted(executor, scan("conflicting", { conflict: 1 }));
    // A wrong GTIN is a code of marking, kept whole, in no box.
    await accepted(executor, scan("wrong", { verdict: "wrong_gtin", box_id: null }));
    await refused(executor, scan("wrong-in-box", { verdict: "wrong_gtin", box_id: "box-1" }));
    await accepted(
      executor,
      scan("duplicate-local", { verdict: "duplicate", duplicate_source: "local", box_id: null }),
    );
  });

  it("keep a code of marking whole: its hash, GTIN, serial and canonical form together", async () => {
    const { executor } = openLocalDb();
    for (const missing of ["code_hash", "gtin14", "serial", "canonical"]) {
      await refused(executor, scan(`km-no-${missing}`, { [missing]: null }));
    }
  });

  it("keep nothing of a scan that is no code of marking, of any class", async () => {
    const { executor } = openLocalDb();
    for (const rawKind of ["gtin", "sscc", "unknown"]) {
      const bare = {
        verdict: "invalid",
        raw_kind: rawKind,
        box_id: null,
        code_hash: null,
        gtin14: null,
        serial: null,
        canonical: null,
      };
      await accepted(executor, scan(`bare-${rawKind}`, bare));
      for (const [field, value] of [
        ["code_hash", "c".repeat(64)],
        ["gtin14", "04600682000013"],
        ["serial", "000742"],
        ["canonical", "4600682000013"],
      ] as const) {
        await refused(executor, scan(`${rawKind}-${field}`, { ...bare, [field]: value }));
      }
      // Such a scan is never `ok`, or a wrong GTIN, or a duplicate.
      await refused(executor, scan(`${rawKind}-wrong`, { ...bare, verdict: "wrong_gtin" }));
    }
  });

  it("take an exception with every field of its kind and none of another", async () => {
    const { executor } = openLocalDb();
    const undo = { kind: "undo", code_hash: "a".repeat(64), target_scanned_at: AT };
    await refused(executor, exception("undo-no-hash", { ...undo, code_hash: null }));
    await refused(executor, exception("undo-no-time", { ...undo, target_scanned_at: null }));
    await refused(executor, exception("clear-time", { kind: "clear", target_scanned_at: AT }));
    await refused(executor, exception("clear-reason", { kind: "clear", reason_code: "other" }));
    for (const kind of ["reprint", "disassemble"]) {
      await refused(
        executor,
        exception(`${kind}-hash`, { kind, reason_code: "other", code_hash: "a".repeat(64) }),
      );
      await refused(
        executor,
        exception(`${kind}-time`, { kind, reason_code: "other", target_scanned_at: AT }),
      );
      await accepted(executor, exception(`${kind}-other`, { kind, reason_code: "other" }));
      await accepted(
        executor,
        exception(`${kind}-words`, { kind, reason_code: "other", reason_text: "Брак" }),
      );
      await refused(
        executor,
        exception(`${kind}-stray-words`, { kind, reason_code: "jam", reason_text: "Брак" }),
      );
    }
  });

  it("settle an outbox record with a known outcome, and details only with an outcome", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, record("accepted", { outcome: "accepted", acked_at: AT }));
    await accepted(
      executor,
      record("conflict", {
        outcome: "conflict",
        acked_at: AT,
        outcome_code: "pallet_conflict",
        outcome_details: '{"reason":"x"}',
      }),
    );
    await accepted(
      executor,
      record("rejected", { outcome: "rejected", acked_at: AT, outcome_code: "invalid_record" }),
    );
    await refused(executor, record("details-alone", { outcome_details: "{}" }));
    await refused(
      executor,
      record("bad-details", { outcome: "accepted", acked_at: AT, outcome_details: "{" }),
    );
    await refused(executor, record("attempts", { attempts: -1 }));
    await refused(executor, record("no-payload", { payload: null }));
    await accepted(executor, record("tried", { attempts: 3, sent_at: AT }));
  });

  it("keep a record, a snapshot and receipt details as objects only", async () => {
    const { executor } = openLocalDb();
    const real = {
      id: "record-1",
      kind: "scan",
      shiftId: "shift-1",
      operatorId: null,
      data: { codeHash: "ab" },
    };
    const snapshot = {
      issuerPrefix: "4600682",
      product: { name: "Молоко", gtin14: "04600682000013" },
    };
    // Valid JSON that is no object: an array, a string, a number, a null.
    const notObjects = ["[]", "[1]", '"x"', "5", "null", "true"];
    await accepted(executor, record("empty", { payload: "{}" }));
    await accepted(executor, record("real", { payload: JSON.stringify(real) }));
    await accepted(
      executor,
      shift("entered", { snapshot: JSON.stringify(snapshot), entered_at: AT, status: "active" }),
    );
    await accepted(
      executor,
      record("details", {
        outcome: "conflict",
        acked_at: AT,
        outcome_details: JSON.stringify({ winner: "box-1" }),
      }),
    );
    await accepted(
      executor,
      record("details-empty", { outcome: "accepted", acked_at: AT, outcome_details: "{}" }),
    );
    for (const [index, value] of notObjects.entries()) {
      await refused(executor, record(`payload-${index}`, { payload: value }));
      await refused(executor, shift(`snapshot-${index}`, { snapshot: value, entered_at: AT }));
      await refused(
        executor,
        record(`details-${index}`, { outcome: "conflict", acked_at: AT, outcome_details: value }),
      );
    }
  });

  it("keep the whole record in the payload, as long as the host takes it", async () => {
    const { executor } = openLocalDb();
    const whole = JSON.stringify({
      id: "record-1",
      kind: "scan",
      shiftId: "shift-1",
      operatorId: "operator-1",
      data: { note: "Ё".repeat(60_000) },
    });
    await accepted(executor, record("record-1", { payload: whole }));
    expect(
      await executor.query(
        "SELECT payload FROM outbox WHERE id = 'record-1'",
        [],
        z.object({ payload: z.string() }),
      ),
    ).toEqual([{ payload: whole }]);
  });
});

describe("the restore obligation (migration 0009)", () => {
  const EPOCH = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
  function obligation(overrides: Record<string, unknown> = {}): LocalStatement {
    const row: Record<string, unknown> = {
      host_id: HOST_ID,
      device_id: DEVICE_ID,
      epoch: EPOCH,
      seen_at: AT,
      ...overrides,
    };
    const columns = Object.keys(row);
    return {
      sql:
        `INSERT INTO floor_restore_epochs (${columns.join(", ")}) ` +
        `VALUES (${columns.map(() => "?").join(", ")})`,
      values: Object.values(row),
    };
  }

  it("fixes every column: its type, whether it is required, its default and its key", async () => {
    const { executor } = openLocalDb();
    const columns = await executor.query(
      'SELECT name, type, "notnull" AS required, dflt_value AS fallback, pk ' +
        "FROM pragma_table_info('floor_restore_epochs') ORDER BY cid",
      [],
      z.object({
        name: z.string(),
        type: z.string(),
        required: z.number(),
        fallback: z.string().nullable(),
        pk: z.number(),
      }),
    );
    expect(
      columns.map(
        (column) =>
          `${column.name} ${column.type}${column.required === 1 ? " NOT NULL" : ""}` +
          `${column.fallback === null ? "" : ` DEFAULT ${column.fallback}`}` +
          `${column.pk === 0 ? "" : ` PK${column.pk}`}`,
      ),
    ).toEqual([
      "host_id TEXT NOT NULL PK1",
      "device_id TEXT NOT NULL PK2",
      "epoch TEXT NOT NULL",
      "seen_at TEXT NOT NULL",
      "reconciled_at TEXT",
      "refused INTEGER NOT NULL DEFAULT 0",
      "refused_blocks TEXT NOT NULL DEFAULT '[]'",
    ]);
  });

  it("keeps one row per pairing, owed until it is settled, with a count that is never negative", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, obligation());
    expect(
      await executor.query(
        "SELECT reconciled_at AS settled, refused FROM floor_restore_epochs",
        [],
        z.object({ settled: z.string().nullable(), refused: z.number() }),
      ),
    ).toEqual([{ settled: null, refused: 0 }]);
    // The same pairing has one epoch at a time; another device or host has its own.
    await refused(executor, obligation({ epoch: "other" }));
    await accepted(executor, obligation({ device_id: "device-2" }));
    await accepted(executor, obligation({ host_id: "host-2" }));
    await accepted(executor, obligation({ device_id: "device-3", refused: 64 }));
    await accepted(executor, obligation({ device_id: "device-4", reconciled_at: AT }));
    await refused(executor, obligation({ device_id: "device-5", refused: -1 }));
    await refused(executor, obligation({ device_id: "device-6", epoch: null }));
    await refused(executor, obligation({ device_id: "device-7", seen_at: null }));
    await refused(executor, obligation({ device_id: null }));
    await refused(executor, obligation({ host_id: null }));
  });

  it("keeps the refused blocks and their codes as a JSON list, empty until a refusal", async () => {
    const { executor } = openLocalDb();
    await accepted(executor, obligation());
    expect(
      await executor.query(
        "SELECT refused_blocks FROM floor_restore_epochs",
        [],
        z.object({ refused_blocks: z.string() }),
      ),
    ).toEqual([{ refused_blocks: "[]" }]);
    await accepted(
      executor,
      obligation({
        device_id: "device-2",
        refused: 1,
        refused_blocks: '[{"id":"block-1","code":"block_overlap"}]',
      }),
    );
    await refused(executor, obligation({ device_id: "device-3", refused_blocks: "[" }));
    await refused(executor, obligation({ device_id: "device-4", refused_blocks: null }));
  });
});
