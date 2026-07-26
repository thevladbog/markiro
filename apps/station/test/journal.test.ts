import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "@markiro/db";
import type { SqlExecutor } from "../src/lib/mirror.js";
import { appendScanEvent, findFirstSeen, loadCodeKeys, recordScan } from "../src/lib/journal.js";

function makeExec(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  for (const stmt of STATION_MIGRATIONS) {
    try {
      db.exec(stmt);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err))) throw err;
    }
  }
  return {
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
}

const EVENT = {
  shiftId: "s1",
  terminalId: "dev-1",
  raw: "0104600000000015215Ab1",
  verdict: "ok",
  scannedAt: "2026-07-26T10:00:00.000Z",
};
const CODE = {
  codeHash: "0104600000000015215Ab1",
  shiftId: "s1",
  gtin14: "04600000000015",
  serial: "5Ab1",
  scannedAt: "2026-07-26T10:00:00.000Z",
};

describe("journal", () => {
  it("appendScanEvent writes exactly one event row and touches nothing else", async () => {
    const exec = makeExec();
    await appendScanEvent(exec, EVENT);
    const events = await exec.all<{ verdict: string }>("SELECT verdict FROM scan_events_mirror");
    expect(events).toHaveLength(1);
    expect(events[0]!.verdict).toBe(EVENT.verdict);
    expect(await loadCodeKeys(exec)).toEqual(new Set());
  });

  it("records an accepted scan into both tables in one call", async () => {
    const exec = makeExec();
    await recordScan(exec, EVENT, CODE);
    expect(await loadCodeKeys(exec)).toEqual(new Set([CODE.codeHash]));
    const events = await exec.all<{ verdict: string }>("SELECT verdict FROM scan_events_mirror");
    expect(events).toHaveLength(1);
  });

  it("records a rejected scan as an event only", async () => {
    const exec = makeExec();
    await recordScan(exec, { ...EVENT, verdict: "invalid" }, null);
    expect(await loadCodeKeys(exec)).toEqual(new Set());
    const events = await exec.all<{ verdict: string }>("SELECT verdict FROM scan_events_mirror");
    expect(events[0]!.verdict).toBe("invalid");
  });

  it("loads keys device-wide, across shifts", async () => {
    const exec = makeExec();
    await recordScan(exec, EVENT, CODE);
    await recordScan(
      exec,
      { ...EVENT, shiftId: "s2" },
      { ...CODE, codeHash: "other", shiftId: "s2" },
    );
    // codes_mirror.code_hash is a global primary key: a KM identifies one
    // physical item, so a code accepted under a DIFFERENT shift on this same
    // device must still show up as a duplicate. A shift-scoped set would let
    // it pass validation here and then fail the codes_mirror insert instead,
    // losing the journal entry and the operator's signal.
    expect(await loadCodeKeys(exec)).toEqual(new Set([CODE.codeHash, "other"]));
  });

  it("reports when a code was first seen", async () => {
    const exec = makeExec();
    await recordScan(exec, EVENT, CODE);
    expect(await findFirstSeen(exec, CODE.codeHash)).toBe(CODE.scannedAt);
    expect(await findFirstSeen(exec, "never-scanned")).toBeNull();
  });

  it("rolls back both writes when the code insert fails", async () => {
    const exec = makeExec();
    await recordScan(exec, EVENT, CODE);
    await expect(recordScan(exec, { ...EVENT, verdict: "ok" }, CODE)).rejects.toThrow();
    const events = await exec.all<{ id: number }>("SELECT id FROM scan_events_mirror");
    expect(events).toHaveLength(1); // the second event was rolled back with its code
  });
});
