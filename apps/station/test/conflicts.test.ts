import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { conflictCount, readConflicts, recordConflicts } from "../src/lib/conflicts.js";

async function migratedExec(): Promise<SqlExecutor> {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExecutor = {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  await applyMigrations(exec);
  return exec;
}

const ROW = {
  codeHash: "h1",
  winningTerminalId: "t1",
  winningScannedAt: "2026-07-28T10:00:00.000Z",
};

describe("device conflicts", () => {
  it("records and reads back a conflict", async () => {
    const exec = await migratedExec();
    await recordConflicts(exec, [ROW], "2026-07-28T10:00:09.000Z");
    const rows = await readConflicts(exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ codeHash: "h1", winningTerminalId: "t1" });
    expect(await conflictCount(exec)).toBe(1);
  });

  it("is idempotent on the same code", async () => {
    const exec = await migratedExec();
    await recordConflicts(exec, [ROW], "2026-07-28T10:00:09.000Z");
    await recordConflicts(exec, [ROW], "2026-07-28T10:05:00.000Z");
    expect(await conflictCount(exec)).toBe(1);
  });

  it("carries the item's gtin and serial when the code is still mirrored", async () => {
    const exec = await migratedExec();
    await exec.run(
      `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at) VALUES (?,?,?,?,?)`,
      ["h1", "s1", "04600000000017", "AB1", "2026-07-28T10:00:00.000Z"],
    );
    await recordConflicts(exec, [ROW], "2026-07-28T10:00:09.000Z");
    const [row] = await readConflicts(exec);
    expect(row).toMatchObject({ gtin14: "04600000000017", serial: "AB1" });
  });

  it("still reports a conflict whose code row is gone", async () => {
    const exec = await migratedExec();
    await recordConflicts(exec, [ROW], "2026-07-28T10:00:09.000Z");
    const [row] = await readConflicts(exec);
    expect(row).toMatchObject({ codeHash: "h1", gtin14: null, serial: null });
  });

  it("reports zero on an empty store", async () => {
    expect(await conflictCount(await migratedExec())).toBe(0);
  });

  // The four preceding tests only ever assert on codeHash/winningTerminalId/
  // gtin14/serial via toMatchObject, which never fails on fields it doesn't
  // name. That leaves winningScannedAt and detectedAt — and any accidental
  // swap between the two in the INSERT column list or the SELECT mapping —
  // completely unchecked. This pins the full round trip with toEqual.
  it("round-trips winningScannedAt and detectedAt distinctly", async () => {
    const exec = await migratedExec();
    await recordConflicts(exec, [ROW], "2026-07-28T10:00:09.000Z");
    const [row] = await readConflicts(exec);
    expect(row).toEqual({
      codeHash: "h1",
      winningTerminalId: "t1",
      winningScannedAt: "2026-07-28T10:00:00.000Z",
      detectedAt: "2026-07-28T10:00:09.000Z",
      gtin14: null,
      serial: null,
    });
  });

  // readConflicts is documented as newest-detected-first, but every other
  // test in this file records at most one conflict, so `ORDER BY
  // detected_at DESC` is never actually exercised.
  it("lists conflicts newest-detected first", async () => {
    const exec = await migratedExec();
    await recordConflicts(exec, [{ ...ROW, codeHash: "h1" }], "2026-07-28T10:00:09.000Z");
    await recordConflicts(exec, [{ ...ROW, codeHash: "h2" }], "2026-07-28T10:05:00.000Z");
    const rows = await readConflicts(exec);
    expect(rows.map((r) => r.codeHash)).toEqual(["h2", "h1"]);
  });

  // The server's BatchConflictDto sends `winningTerminalId: string | null`
  // (see apps/api/src/modules/station-scans/dto.ts) — a losing terminal can
  // be unknown. None of the tests above ever pass a null, so a binding bug
  // specific to null (e.g. coercing it to the string "null") would pass.
  it("stores and reads a null winningTerminalId", async () => {
    const exec = await migratedExec();
    await recordConflicts(exec, [{ ...ROW, winningTerminalId: null }], "2026-07-28T10:00:09.000Z");
    const [row] = await readConflicts(exec);
    expect(row).toMatchObject({ winningTerminalId: null });
  });
});
