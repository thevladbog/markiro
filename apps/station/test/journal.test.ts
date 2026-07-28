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
    const result = await recordScan(exec, EVENT, CODE);
    expect(result).toEqual({ storedCode: true, alreadyPresent: false });
    expect(await loadCodeKeys(exec)).toEqual(new Set([CODE.codeHash]));
    const events = await exec.all<{ verdict: string }>("SELECT verdict FROM scan_events_mirror");
    expect(events).toHaveLength(1);
  });

  it("records a rejected scan as an event only", async () => {
    const exec = makeExec();
    const result = await recordScan(exec, { ...EVENT, verdict: "invalid" }, null);
    expect(result).toEqual({ storedCode: false, alreadyPresent: false });
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

  // recordScan no longer uses a transaction (tauri-plugin-sql's pooled
  // connections make multi-call BEGIN/COMMIT unsound — see the doc comment
  // on recordScan). The primary-key constraint on codes_mirror.code_hash is
  // the actual duplicate signal now, and the audit trail must survive it.
  it("reports alreadyPresent on a second scan of the same code, without duplicating the code row", async () => {
    const exec = makeExec();
    await recordScan(exec, EVENT, CODE);

    const result = await recordScan(exec, { ...EVENT, verdict: "ok" }, CODE);

    expect(result).toEqual({ storedCode: false, alreadyPresent: true });
    // Still exactly one code row: the constraint violation prevented a second insert.
    expect(await loadCodeKeys(exec)).toEqual(new Set([CODE.codeHash]));
    // But BOTH scans are journalled: the event row no longer depends on a
    // transaction to survive, and the audit trail is what makes the
    // duplicate diagnosable later.
    const events = await exec.all<{ id: number }>("SELECT id FROM scan_events_mirror");
    expect(events).toHaveLength(2);
  });

  // The stored verdict must reflect what actually happened, not what the
  // caller predicted: the caller always passes "ok" for an accepted-looking
  // scan, but when the code insert hits alreadyPresent the operator was
  // shown a duplicate signal, and the mirror must agree — Plan 06's sync
  // reads scan_events_mirror.verdict and would otherwise double-count accepts.
  it("journals the second scan of an already-present code as duplicate, not the caller's ok", async () => {
    const exec = makeExec();
    await recordScan(exec, EVENT, CODE);
    await recordScan(exec, { ...EVENT, verdict: "ok" }, CODE);

    const events = await exec.all<{ verdict: string }>(
      "SELECT verdict FROM scan_events_mirror ORDER BY id ASC",
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.verdict).toBe("ok");
    expect(events[1]!.verdict).toBe("duplicate");
    // Still exactly one codes_mirror row: the constraint violation prevented
    // a second insert.
    expect(await loadCodeKeys(exec)).toEqual(new Set([CODE.codeHash]));
  });

  it("rethrows a non-constraint write failure instead of reporting a duplicate", async () => {
    const exec = makeExec();
    const boom = new Error("disk I/O error");
    const failingExec: SqlExecutor = {
      ...exec,
      run: async (sql, params) => {
        if (sql.startsWith("INSERT INTO codes_mirror")) throw boom;
        return exec.run(sql, params);
      },
    };
    await expect(recordScan(failingExec, EVENT, CODE)).rejects.toThrow(boom);
  });
});

describe("outbox", () => {
  it("enqueues an accepted scan with its code payload", async () => {
    const exec = makeExec();
    await recordScan(
      exec,
      {
        shiftId: "s1",
        terminalId: "t1",
        raw: "RAW1",
        verdict: "ok",
        scannedAt: "2026-07-28T10:00:00.000Z",
      },
      {
        codeHash: "h1",
        shiftId: "s1",
        gtin14: "04600000000017",
        serial: "AB1",
        scannedAt: "2026-07-28T10:00:00.000Z",
      },
    );

    const rows = await exec.all<{
      shift_id: string;
      verdict: string;
      code_hash: string | null;
      gtin14: string | null;
      serial: string | null;
    }>("SELECT shift_id, verdict, code_hash, gtin14, serial FROM outbox ORDER BY id");
    expect(rows).toEqual([
      { shift_id: "s1", verdict: "ok", code_hash: "h1", gtin14: "04600000000017", serial: "AB1" },
    ]);
  });

  it("enqueues a rejected scan with no code payload", async () => {
    const exec = makeExec();
    await recordScan(
      exec,
      {
        shiftId: "s1",
        terminalId: null,
        raw: "junk",
        verdict: "invalid",
        scannedAt: "2026-07-28T10:00:01.000Z",
      },
      null,
    );

    const rows = await exec.all<{ verdict: string; code_hash: string | null }>(
      "SELECT verdict, code_hash FROM outbox",
    );
    expect(rows).toEqual([{ verdict: "invalid", code_hash: null }]);
  });

  it("enqueues the CORRECTED verdict and no code when the code was already present", async () => {
    const exec = makeExec();
    const code = {
      codeHash: "h1",
      shiftId: "s1",
      gtin14: "04600000000017",
      serial: "AB1",
      scannedAt: "2026-07-28T10:00:00.000Z",
    };
    await recordScan(
      exec,
      { shiftId: "s1", terminalId: null, raw: "RAW1", verdict: "ok", scannedAt: code.scannedAt },
      code,
    );

    // Same code again: the primary key rejects it, so the scan is a duplicate.
    const result = await recordScan(
      exec,
      {
        shiftId: "s1",
        terminalId: null,
        raw: "RAW1",
        verdict: "ok",
        scannedAt: "2026-07-28T10:00:05.000Z",
      },
      { ...code, scannedAt: "2026-07-28T10:00:05.000Z" },
    );
    expect(result.alreadyPresent).toBe(true);

    const rows = await exec.all<{ verdict: string; code_hash: string | null }>(
      "SELECT verdict, code_hash FROM outbox ORDER BY id",
    );
    // The second row must NOT carry a code: this device already queued it once,
    // and sending it again would write a second server row for one physical item.
    expect(rows).toEqual([
      { verdict: "ok", code_hash: "h1" },
      { verdict: "duplicate", code_hash: null },
    ]);
  });

  it("throws when the outbox write fails, rather than losing the scan silently", async () => {
    const exec = makeExec();
    const failing: SqlExecutor = {
      run: async (sql, params) => {
        if (/INTO outbox/i.test(sql)) throw new Error("disk full");
        return exec.run(sql, params);
      },
      all: (sql, params) => exec.all(sql, params),
    };
    await expect(
      recordScan(
        failing,
        {
          shiftId: "s1",
          terminalId: null,
          raw: "RAW1",
          verdict: "invalid",
          scannedAt: "2026-07-28T10:00:00.000Z",
        },
        null,
      ),
    ).rejects.toThrow(/disk full/);
  });
});
