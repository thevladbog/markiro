import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { PAGE_ROWS, COMPACT_ROWS } from "../src/floor/work/ScanHistory.js";
import { readScanHistory, SCAN_HISTORY_SQL } from "../src/floor/work/scan-history.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// Bind the module URL before use: the jsdom environment rewrites a literal
// `new URL(..., import.meta.url)` (see test/protocol.test.ts).
const testModuleUrl = import.meta.url;

/**
 * The history read as it stood before the lag fix: the box position's correlated subquery
 * ran for every scan of the shift before the sort and the limit (quadratic in the shift's
 * scans). Kept here word for word as the oracle the paged read must agree with.
 */
const OLD_SCAN_HISTORY_SQL =
  "SELECT s.id AS id, s.scanned_at AS scanned_at, s.verdict AS verdict, " +
  "s.duplicate_source AS duplicate_source, s.gtin14 AS gtin14, s.serial AS serial, " +
  "(SELECT o.name FROM ref_operators AS o WHERE o.id = s.operator_id) AS operator_name, " +
  "CASE WHEN s.box_id IS NULL THEN NULL ELSE " +
  "(SELECT count(*) FROM floor_scans AS p WHERE p.host_id = s.host_id " +
  "AND p.device_id = s.device_id AND p.shift_id = s.shift_id AND p.box_id = s.box_id " +
  "AND p.verdict = 'ok' AND (p.scanned_at < s.scanned_at " +
  "OR (p.scanned_at = s.scanned_at AND p.rowid <= s.rowid))) END AS box_position " +
  "FROM floor_scans AS s WHERE s.host_id = ? AND s.device_id = ? AND s.shift_id = ? " +
  "ORDER BY s.scanned_at DESC, s.rowid DESC LIMIT ? OFFSET ?";

const OTHER_HOST = "11111111-0000-4000-8000-000000000001";
const OTHER_DEVICE = "22222222-0000-4000-8000-000000000002";
const SHIFTS = ["bbbbbbbb-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002"];
const PAIRINGS: [string, string][] = [
  [HOST_ID, DEVICE_ID],
  [HOST_ID, OTHER_DEVICE],
  [OTHER_HOST, DEVICE_ID],
];
const OPERATORS = ["dddddddd-0000-4000-8000-000000000001", "dddddddd-0000-4000-8000-000000000002"];

/** A deterministic generator (mulberry32), so a failing seed reads the same every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Scans of two shifts under three pairings: accepted codes in boxes of several scans (and a
 * validation shift's accepted codes in no box), local and host duplicates, other products and
 * scans that were no code, several scans at the same instant (the rowid breaks the tie), a box
 * whose scans interleave with another box's, operators known, unknown and absent.
 */
function seed(db: DatabaseSync, scans: number, seedNo: number): void {
  db.prepare(
    "INSERT INTO ref_operators (id, login, name, role, pin_phc, rev) VALUES (?, '0042', 'Анна Кузнецова', NULL, 'x', 1)",
  ).run(OPERATORS[0] ?? "");
  const insert = db.prepare(
    "INSERT INTO floor_scans (id, host_id, device_id, shift_id, box_id, verdict, duplicate_source, raw_kind, raw_length, code_hash, gtin14, serial, canonical, scanned_at, operator_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 40, ?, ?, ?, ?, ?, ?)",
  );
  const next = random(seedNo);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  // A shared, coarse clock: many scans land on the same millisecond, in any pairing.
  let at = Date.parse("2026-10-15T06:00:00.000Z");
  const boxes = Array.from(
    { length: 6 },
    (_, index) => `cccccccc-0000-4000-8000-00000000000${index}`,
  );
  for (let index = 0; index < scans; index += 1) {
    if (next() < 0.6) at += Math.floor(next() * 3) * 1000;
    const [hostId, deviceId] = pick(PAIRINGS);
    const shift = pick(SHIFTS);
    const roll = next();
    const verdict =
      roll < 0.6 ? "ok" : roll < 0.75 ? "duplicate" : roll < 0.88 ? "wrong_gtin" : "invalid";
    const km = verdict !== "invalid";
    const box = verdict === "ok" && next() < 0.85 ? pick(boxes) : null;
    const operator = next() < 0.1 ? null : next() < 0.15 ? "unknown-operator" : pick(OPERATORS);
    insert.run(
      `scan-${seedNo}-${index}`,
      hostId,
      deviceId,
      shift,
      box,
      verdict,
      verdict === "duplicate" ? pick(["local", "host"]) : null,
      km ? "km" : pick(["gtin", "sscc", "unknown"]),
      km ? `hash-${index}` : null,
      km ? "04600682000013" : null,
      km ? `SER${String(index).padStart(6, "0")}` : null,
      km ? "canonical" : null,
      new Date(at).toISOString(),
      operator,
    );
  }
}

const SLICES = [
  { limit: COMPACT_ROWS, offset: 0 },
  { limit: COMPACT_ROWS - 1, offset: 0 },
  { limit: 2, offset: 3 },
  { limit: PAGE_ROWS, offset: 0 },
  { limit: PAGE_ROWS, offset: PAGE_ROWS },
  { limit: 5, offset: 37 },
  { limit: 1000, offset: 0 },
  { limit: 8, offset: 100000 },
];

describe("the work screen's history read pages first (scan lag fix)", () => {
  it("returns byte-identical rows to the old read, for every pairing, shift and slice", async () => {
    for (const [seedNo, scans] of [
      [1, 40],
      [2, 300],
      [3, 900],
    ] as const) {
      const { db, executor } = openLocalDb();
      seed(db, scans, seedNo);
      for (const [hostId, deviceId] of [...PAIRINGS, [OTHER_HOST, OTHER_DEVICE] as const]) {
        for (const shift of SHIFTS) {
          for (const slice of SLICES) {
            const params = [hostId, deviceId, shift, slice.limit, slice.offset];
            const old = db.prepare(OLD_SCAN_HISTORY_SQL).all(...params);
            const paged = db.prepare(SCAN_HISTORY_SQL).all(...params);
            expect(JSON.stringify(paged), JSON.stringify({ seedNo, hostId, shift, slice })).toBe(
              JSON.stringify(old),
            );
            // The executor's read, as the screens call it, gives the same rows.
            const read = await readScanHistory(executor, { hostId, deviceId }, shift, slice);
            expect(read.rows.map((row) => [row.id, row.boxPosition, row.operatorName])).toEqual(
              old.map((row) => [row["id"], row["box_position"], row["operator_name"]]),
            );
          }
        }
      }
      // The seeds hold what the oracle must be compared over: ties in time, boxes of many
      // scans, refused scans and box-less accepted codes.
      expect(
        db
          .prepare(
            "SELECT count(*) AS n FROM (SELECT 1 FROM floor_scans GROUP BY host_id, device_id, shift_id, scanned_at HAVING count(*) > 1)",
          )
          .get()?.["n"],
      ).toBeGreaterThan(0);
      const kinds = db
        .prepare(
          "SELECT count(DISTINCT verdict) AS v, sum(box_id IS NULL AND verdict = 'ok') AS boxless FROM floor_scans",
        )
        .get();
      expect(kinds?.["v"]).toBe(4);
      expect(Number(kinds?.["boxless"])).toBeGreaterThan(0);
      expect(
        db
          .prepare(
            "SELECT max(n) AS n FROM (SELECT count(*) AS n FROM floor_scans WHERE box_id IS NOT NULL GROUP BY host_id, device_id, shift_id, box_id)",
          )
          .get()?.["n"],
      ).toBeGreaterThan(2);
    }
  });

  // The plan of node:sqlite (SQLite 3.53); the shell's SQLite 3.46 is pinned in
  // `tests/local_db.rs` (`the_scan_history_reads_its_page_first`) with the same text.
  it("runs the box position's subquery for the page's rows only, never for the whole shift", () => {
    const { db } = openLocalDb();
    const steps = db
      .prepare(`EXPLAIN QUERY PLAN ${SCAN_HISTORY_SQL}`)
      .all("x", "x", "x", 8, 0)
      .map((step) => ({
        id: Number(step["id"]),
        parent: Number(step["parent"]),
        detail: String(step["detail"]),
      }));
    const text = steps.map((step) => step.detail).join("\n");
    const byId = new Map(steps.map((step) => [step.id, step]));
    const within = (step: { parent: number }, ancestor: { id: number }): boolean => {
      for (let at = byId.get(step.parent); at !== undefined; at = byId.get(at.parent)) {
        if (at.id === ancestor.id) return true;
      }
      return false;
    };
    // The page is chosen first, on its own (a co-routine or a materialized subquery)...
    const page = steps.find((step) => /^(CO-ROUTINE|MATERIALIZE) page$/.test(step.detail));
    expect(page, text).toBeDefined();
    if (page === undefined) return;
    // ...then each of its rows is read back by its rowid, and only then are the two
    // correlated subqueries (the operator's name, the place in the box) run: outside the page.
    expect(text).toContain("SEARCH s USING INTEGER PRIMARY KEY (rowid=?)");
    const correlated = steps.filter((step) => step.detail.startsWith("CORRELATED SCALAR SUBQUERY"));
    expect(correlated, text).toHaveLength(2);
    for (const step of correlated) expect(within(step, page), text).toBe(false);
    // Nothing walks the scans whole.
    expect(
      steps.filter((step) => /^SCAN (s|p|floor_scans)\b/.test(step.detail)),
      text,
    ).toEqual([]);
  });

  it("is pinned on the shell's SQLite with the same text", () => {
    const source = readFileSync(new URL("../src-tauri/tests/local_db.rs", testModuleUrl), "utf8")
      // A line continuation of a Rust string drops the newline and the next line's indent.
      .replace(/\\\n\s*/g, "");
    expect(source).toContain(`"${SCAN_HISTORY_SQL}"`);
  });
});
