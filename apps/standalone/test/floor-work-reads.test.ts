import { buildSscc } from "@markiro/domain";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { processScan } from "../src/floor/work/scan-pipeline.js";
import { readOpenBox, readWorkTotals } from "../src/floor/work/work-reads.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import {
  enteredShift,
  km,
  PAIRING,
  PREFIX,
  rows,
  scanContext,
  SHIFT_ID,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const OTHER_DEVICE = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const OTHER_HOST = "6e5d4c3b-2a19-4f8e-9d7c-0b1a2c3d4e5f";
const OTHER_SHIFT = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const BLOCK = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";

interface BoxRow {
  id: string;
  host?: string;
  device?: string;
  shift?: string;
  items?: number;
  /** Closed at this instant with this serial; open when absent. */
  closed?: { at: string; serial: number; disassembled?: string };
}

function insertBox(db: DatabaseSync, box: BoxRow): void {
  const closed = box.closed;
  db.prepare(
    "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
      "block_id, serial, item_count, disassembled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    box.id,
    box.host ?? HOST_ID,
    box.device ?? DEVICE_ID,
    box.shift ?? SHIFT_ID,
    "2026-10-08T06:00:00.000Z",
    closed?.at ?? null,
    closed === undefined ? null : buildSscc(0, PREFIX, closed.serial),
    closed === undefined ? null : BLOCK,
    closed?.serial ?? null,
    box.items ?? 1,
    closed?.disassembled ?? null,
  );
}

function insertCode(
  db: DatabaseSync,
  hash: string,
  where: { host?: string; device?: string; shift?: string } = {},
): void {
  db.prepare(
    "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, scanned_at) " +
      "VALUES (?, ?, ?, ?, 'b', 's', '2026-10-08T06:00:00.000Z')",
  ).run(where.host ?? HOST_ID, where.device ?? DEVICE_ID, hash, where.shift ?? SHIFT_ID);
}

describe("the open box of a shift", () => {
  it("is nothing before the first code, and the box with its count after it", async () => {
    const { db, executor } = openLocalDb();
    await expect(readOpenBox(executor, PAIRING, SHIFT_ID)).resolves.toBeNull();
    insertBox(db, { id: "open-box", items: 7 });
    await expect(readOpenBox(executor, PAIRING, SHIFT_ID)).resolves.toEqual({
      id: "open-box",
      openedAt: "2026-10-08T06:00:00.000Z",
      itemCount: 7,
    });
  });

  it("is not a closed box", async () => {
    const { db, executor } = openLocalDb();
    insertBox(db, { id: "closed-box", closed: { at: "2026-10-08T06:10:00.000Z", serial: 1500 } });
    await expect(readOpenBox(executor, PAIRING, SHIFT_ID)).resolves.toBeNull();
  });

  it("is the shift's own, of this pairing only", async () => {
    const { db, executor } = openLocalDb();
    insertBox(db, { id: "other-shift", shift: OTHER_SHIFT });
    insertBox(db, { id: "other-device", device: OTHER_DEVICE });
    insertBox(db, { id: "other-host", host: OTHER_HOST });
    await expect(readOpenBox(executor, PAIRING, SHIFT_ID)).resolves.toBeNull();
    insertBox(db, { id: "mine", items: 3 });
    await expect(readOpenBox(executor, PAIRING, SHIFT_ID)).resolves.toMatchObject({ id: "mine" });
  });
});

describe("what the work screen shows of a shift", () => {
  it("is empty before the first code", async () => {
    const { executor } = openLocalDb();
    await expect(readWorkTotals(executor, PAIRING, SHIFT_ID)).resolves.toEqual({
      openBox: null,
      accepted: 0,
      closedBoxes: 0,
      lastSscc: null,
    });
  });

  it("has no last SSCC while only an open box exists", async () => {
    const { db, executor } = openLocalDb();
    insertBox(db, { id: "only-open", items: 4 });
    await expect(readWorkTotals(executor, PAIRING, SHIFT_ID)).resolves.toEqual({
      openBox: { id: "only-open", openedAt: "2026-10-08T06:00:00.000Z", itemCount: 4 },
      accepted: 0,
      closedBoxes: 0,
      lastSscc: null,
    });
  });

  it("counts the codes held, the boxes closed and not taken apart, and the last SSCC", async () => {
    const { db, executor } = openLocalDb();
    insertBox(db, { id: "first", closed: { at: "2026-10-08T06:10:00.000Z", serial: 1500 } });
    insertBox(db, { id: "second", closed: { at: "2026-10-08T06:20:00.000Z", serial: 1501 } });
    insertBox(db, {
      id: "taken-apart",
      closed: {
        at: "2026-10-08T06:15:00.000Z",
        serial: 1502,
        disassembled: "2026-10-08T06:30:00Z",
      },
    });
    insertBox(db, { id: "open", items: 2 });
    for (const hash of ["a", "b", "c", "d", "e"]) insertCode(db, hash);
    await expect(readWorkTotals(executor, PAIRING, SHIFT_ID)).resolves.toEqual({
      openBox: { id: "open", openedAt: "2026-10-08T06:00:00.000Z", itemCount: 2 },
      accepted: 5,
      closedBoxes: 2,
      lastSscc: buildSscc(0, PREFIX, 1501),
    });
  });

  it("takes the box closed last, and the higher serial when two closed in one instant", async () => {
    const { db, executor } = openLocalDb();
    const at = "2026-10-08T06:10:00.000Z";
    insertBox(db, { id: "low", closed: { at, serial: 1500 } });
    insertBox(db, { id: "high", closed: { at, serial: 1501 } });
    insertBox(db, { id: "early", closed: { at: "2026-10-08T06:05:00.000Z", serial: 1999 } });
    await expect(readWorkTotals(executor, PAIRING, SHIFT_ID)).resolves.toMatchObject({
      lastSscc: buildSscc(0, PREFIX, 1501),
    });
  });

  it("counts the shift's own and this pairing's only", async () => {
    const { db, executor } = openLocalDb();
    insertBox(db, {
      id: "elsewhere-1",
      shift: OTHER_SHIFT,
      closed: { at: "2026-10-08T07:00:00.000Z", serial: 1600 },
    });
    insertBox(db, {
      id: "elsewhere-2",
      device: OTHER_DEVICE,
      closed: { at: "2026-10-08T07:00:00.000Z", serial: 1601 },
    });
    insertBox(db, {
      id: "elsewhere-3",
      host: OTHER_HOST,
      closed: { at: "2026-10-08T07:00:00.000Z", serial: 1602 },
    });
    insertCode(db, "other-shift", { shift: OTHER_SHIFT });
    insertCode(db, "other-device", { device: OTHER_DEVICE });
    insertCode(db, "other-host", { host: OTHER_HOST });
    await expect(readWorkTotals(executor, PAIRING, SHIFT_ID)).resolves.toEqual({
      openBox: null,
      accepted: 0,
      closedBoxes: 0,
      lastSscc: null,
    });
    insertCode(db, "mine");
    await expect(readWorkTotals(executor, PAIRING, SHIFT_ID)).resolves.toMatchObject({
      accepted: 1,
    });
  });

  it("follows the scans: a code in, a duplicate out", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const context = scanContext(executor, shift, { newId: () => crypto.randomUUID() });
    await processScan(context, km("T1"));
    await processScan(context, km("T2"));
    await processScan(context, km("T1"));
    await expect(readWorkTotals(executor, PAIRING, SHIFT_ID)).resolves.toMatchObject({
      accepted: 2,
      openBox: { itemCount: 2 },
    });
  });
});

/**
 * Wraps `local` so that every statement the code under test sends is kept,
 * to be asked for its query plan afterwards.
 */
function recording(local: LocalExecutor) {
  const reads = new Map<string, readonly unknown[]>();
  const writes = new Map<string, readonly unknown[]>();
  const executor: LocalExecutor = {
    query: (sql, params, row) => {
      reads.set(sql, params);
      return local.query(sql, params, row);
    },
    transaction: (statements) => {
      for (const statement of statements) writes.set(statement.sql, statement.values ?? []);
      return local.transaction(statements);
    },
  };
  return { executor, reads, writes };
}

describe("the statements the scan pipeline repeats on every scan", () => {
  // node:sqlite's planner (3.53); the shell's own (3.46) is pinned in
  // `tests/local_db.rs` (`the_floors_repeating_reads_search_an_index`), whose
  // list carries the same statements.
  it("search an index of the floor's tables, never scan one", async () => {
    const { db, executor } = openLocalDb();
    const recorder = recording(executor);
    const shift = await enteredShift(executor);
    const context = scanContext(recorder.executor, shift, {
      online: () => true,
      newId: () => crypto.randomUUID(),
    });
    // The first scan opens a box, the next ones grow it, a repeated one is a
    // duplicate, and the totals are read: every statement of the repeated path.
    await processScan(context, km("P1"));
    await processScan(context, km("P2"));
    await processScan(context, km("P1"));
    await readWorkTotals(recorder.executor, PAIRING, SHIFT_ID);

    const plan = (sql: string, values: readonly unknown[]): string[] =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...values.map((value) => (typeof value === "number" ? value : String(value))))
        .map((step) => String(step["detail"]));
    const statements = [...recorder.reads, ...recorder.writes].filter(([sql]) =>
      /^(SELECT|UPDATE|DELETE)/.test(sql),
    );
    // Every statement of the repeated path, each with the index it must search.
    const expected: [string, string][] = [
      [
        "SELECT scanned_at FROM floor_codes",
        "INDEX sqlite_autoindex_floor_codes_1 (host_id=? AND device_id=? AND code_hash=?)",
      ],
      [
        "SELECT id, opened_at, item_count FROM floor_boxes",
        "INDEX floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?",
      ],
      ["UPDATE floor_boxes SET item_count", "INDEX sqlite_autoindex_floor_boxes_1 (id=?)"],
      [
        "SELECT count(*) AS n FROM floor_codes",
        "INDEX floor_codes_shift (host_id=? AND device_id=? AND shift_id=?)",
      ],
      [
        "SELECT count(*) AS n FROM floor_boxes",
        "INDEX floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?",
      ],
      [
        "SELECT sscc FROM floor_boxes",
        "INDEX floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?",
      ],
    ];
    expect(statements.length).toBe(expected.length);
    for (const [prefix, index] of expected) {
      const found = statements.filter(([sql]) => sql.startsWith(prefix));
      expect(found, prefix).toHaveLength(1);
      const [sql, values] = found[0] ?? ["", []];
      const steps = plan(sql, values);
      expect(steps.join("\n"), sql).toContain(index);
      expect(
        steps.filter((step) => step.startsWith("SCAN ")),
        sql,
      ).toEqual([]);
    }
    expect(rows(db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
  });
});
