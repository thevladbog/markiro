import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "@markiro/db";
import type { SqlExecutor } from "../src/lib/mirror.js";
import {
  appendScanEvent,
  findFirstSeen,
  listRecentOperations,
  loadCodeKeys,
  recordScan,
  undoLastScan,
} from "../src/lib/journal.js";

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
  operatorId: null,
};
const CODE = {
  codeHash: "0104600000000015215Ab1",
  shiftId: "s1",
  gtin14: "04600000000015",
  serial: "5Ab1",
  scannedAt: "2026-07-26T10:00:00.000Z",
  boxId: null,
};
/** Alias for the brief's box/operator tests below -- same fixture, read name. */
const acceptedCode = CODE;

/** One scan event, distinguished by `id` only in its raw payload. */
function event(id: string): typeof EVENT {
  return { ...EVENT, raw: `RAW-${id}` };
}

/** Wraps `exec` so any statement matching `pattern` throws instead of running. */
function failingExecOn(exec: SqlExecutor, pattern: RegExp): SqlExecutor {
  return {
    run: async (sql, params) => {
      if (pattern.test(sql)) throw new Error("disk full");
      return exec.run(sql, params);
    },
    all: (sql, params) => exec.all(sql, params),
  };
}

describe("journal", () => {
  it("returns at most six display-safe shift operations in deterministic newest-first order", async () => {
    const exec = makeExec();
    const times = [
      "2026-08-06T10:00:00.000Z",
      "2026-08-06T10:01:00.000Z",
      "2026-08-06T10:02:00.000Z",
      "2026-08-06T10:03:00.000Z",
      "2026-08-06T10:04:00.000Z",
      "2026-08-06T10:05:00.000Z",
      "2026-08-06T10:06:00.000Z",
      "2026-08-06T10:07:00.000Z",
    ];
    for (const [index, scannedAt] of times.entries()) {
      await appendScanEvent(exec, {
        ...EVENT,
        raw: `0104600000000015215SECRET${index}`,
        scannedAt,
        verdict: index % 2 === 0 ? "ok" : "wrong_gtin",
      });
    }
    await appendScanEvent(exec, {
      ...EVENT,
      shiftId: "other-shift",
      raw: "0104600000000015215FOREIGN",
      scannedAt: "2026-08-06T11:00:00.000Z",
    });

    const recent = await listRecentOperations(exec, "s1");

    expect(recent).toHaveLength(6);
    expect(recent.map((item) => item.scannedAt)).toEqual(times.slice(2).reverse());
    expect(recent.map((item) => item.codeSuffix)).toEqual([
      "…RET7",
      "…RET6",
      "…RET5",
      "…RET4",
      "…RET3",
      "…RET2",
    ]);
    expect(JSON.stringify(recent)).not.toContain("SECRET");
    expect(JSON.stringify(recent)).not.toContain("FOREIGN");
  });

  it("sorts equal timestamps by insertion id and degrades malformed timestamps safely", async () => {
    const exec = makeExec();
    await appendScanEvent(exec, {
      ...EVENT,
      raw: "0104600000000015215FIRST",
      scannedAt: "2026-08-06T10:00:00.000Z",
    });
    await appendScanEvent(exec, {
      ...EVENT,
      raw: "0104600000000015215SECOND",
      scannedAt: "2026-08-06T10:00:00.000Z",
      verdict: "duplicate",
    });
    await appendScanEvent(exec, {
      ...EVENT,
      raw: "short",
      scannedAt: "not-a-date",
      verdict: "invalid",
    });

    expect(await listRecentOperations(exec, "s1")).toEqual([
      {
        verdict: "duplicate",
        scannedAt: "2026-08-06T10:00:00.000Z",
        codeSuffix: "…COND",
      },
      { verdict: "ok", scannedAt: "2026-08-06T10:00:00.000Z", codeSuffix: "…IRST" },
      { verdict: "invalid", scannedAt: null, codeSuffix: null },
    ]);
  });

  it("removes scanner control characters from the display suffix", async () => {
    const exec = makeExec();
    await appendScanEvent(exec, {
      ...EVENT,
      raw: "0104600000000015215A\u001dB\u001eC",
    });

    expect(await listRecentOperations(exec, "s1")).toEqual([
      { verdict: "ok", scannedAt: EVENT.scannedAt, codeSuffix: "…5ABC" },
    ]);
  });

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
        operatorId: null,
      },
      {
        codeHash: "h1",
        shiftId: "s1",
        gtin14: "04600000000017",
        serial: "AB1",
        scannedAt: "2026-07-28T10:00:00.000Z",
        boxId: null,
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
        operatorId: null,
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
      boxId: null,
    };
    await recordScan(
      exec,
      {
        shiftId: "s1",
        terminalId: null,
        raw: "RAW1",
        verdict: "ok",
        scannedAt: code.scannedAt,
        operatorId: null,
      },
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
        operatorId: null,
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
          operatorId: null,
        },
        null,
      ),
    ).rejects.toThrow(/disk full/);
  });

  // The finding this closes: an outbox failure used to leave the just-stored
  // code row in place, so the operator's rescan of the same physical item hit
  // the primary key, was reported as alreadyPresent, and was enqueued as
  // "duplicate" with no code payload -- the code could then never reach the
  // server. Compensating the codes_mirror insert away makes the rescan a
  // clean accept instead.
  it("compensates the code row on outbox failure so a rescan is a fresh accept, not a phantom duplicate", async () => {
    const exec = makeExec();
    const failing: SqlExecutor = {
      run: async (sql, params) => {
        if (/INTO outbox/i.test(sql)) throw new Error("disk full");
        return exec.run(sql, params);
      },
      all: (sql, params) => exec.all(sql, params),
    };
    const event = {
      shiftId: "s1",
      terminalId: "t1",
      raw: "RAW1",
      verdict: "ok",
      scannedAt: "2026-07-28T10:00:00.000Z",
      operatorId: null,
    };
    const code = {
      codeHash: "h1",
      shiftId: "s1",
      gtin14: "04600000000017",
      serial: "AB1",
      scannedAt: "2026-07-28T10:00:00.000Z",
      boxId: null,
    };

    await expect(recordScan(failing, event, code)).rejects.toThrow(/disk full/);

    // The compensating delete undid the codes_mirror insert.
    expect(await loadCodeKeys(exec)).toEqual(new Set());

    // The rescan (against the real, non-failing executor) is a fresh accept,
    // not a phantom duplicate, and DOES enqueue the code payload this time.
    const rescan = await recordScan(
      exec,
      { ...event, scannedAt: "2026-07-28T10:00:05.000Z" },
      { ...code, scannedAt: "2026-07-28T10:00:05.000Z" },
    );
    expect(rescan).toEqual({ storedCode: true, alreadyPresent: false });

    const rows = await exec.all<{ verdict: string; code_hash: string | null }>(
      "SELECT verdict, code_hash FROM outbox ORDER BY id",
    );
    expect(rows).toEqual([{ verdict: "ok", code_hash: "h1" }]);
  });

  // Finding 3: `appendScanEvent` (the event write, immediately above the
  // outbox insert in `recordScan`) used to be unguarded. If it threw, the
  // just-stored `codes_mirror` row was left behind with no outbox row -- the
  // operator's rescan would then hit the code primary key, be journalled as
  // a duplicate with no code payload, and that accepted physical code could
  // never reach the server. Same failure the outbox-failure compensation
  // above exists to prevent, reachable through the other write.
  it("compensates the code row when the EVENT write fails, so a rescan is a fresh accept, not a phantom duplicate", async () => {
    const exec = makeExec();
    const failing: SqlExecutor = {
      run: async (sql, params) => {
        if (/INTO scan_events_mirror/i.test(sql)) throw new Error("disk full");
        return exec.run(sql, params);
      },
      all: (sql, params) => exec.all(sql, params),
    };
    const event = {
      shiftId: "s1",
      terminalId: "t1",
      raw: "RAW1",
      verdict: "ok",
      scannedAt: "2026-07-28T10:00:00.000Z",
      operatorId: null,
    };
    const code = {
      codeHash: "h1",
      shiftId: "s1",
      gtin14: "04600000000017",
      serial: "AB1",
      scannedAt: "2026-07-28T10:00:00.000Z",
      boxId: null,
    };

    await expect(recordScan(failing, event, code)).rejects.toThrow(/disk full/);

    // The compensating delete undid the codes_mirror insert.
    expect(await loadCodeKeys(exec)).toEqual(new Set());

    // Nothing was ever enqueued for this attempt -- the event write failed
    // before the outbox insert was even attempted.
    const outboxRows = await exec.all<{ id: number }>("SELECT id FROM outbox");
    expect(outboxRows).toHaveLength(0);

    // The rescan (against the real, non-failing executor) is a fresh accept,
    // not a phantom duplicate.
    const rescan = await recordScan(
      exec,
      { ...event, scannedAt: "2026-07-28T10:00:05.000Z" },
      { ...code, scannedAt: "2026-07-28T10:00:05.000Z" },
    );
    expect(rescan).toEqual({ storedCode: true, alreadyPresent: false });
  });

  it("rethrows the original event error even when the compensating delete also fails", async () => {
    const exec = makeExec();
    const failing: SqlExecutor = {
      run: async (sql, params) => {
        if (/INTO scan_events_mirror/i.test(sql)) throw new Error("disk full");
        if (/DELETE FROM codes_mirror/i.test(sql)) throw new Error("delete also failed");
        return exec.run(sql, params);
      },
      all: (sql, params) => exec.all(sql, params),
    };
    const event = {
      shiftId: "s1",
      terminalId: "t1",
      raw: "RAW1",
      verdict: "ok",
      scannedAt: "2026-07-28T10:00:00.000Z",
      operatorId: null,
    };
    const code = {
      codeHash: "h1",
      shiftId: "s1",
      gtin14: "04600000000017",
      serial: "AB1",
      scannedAt: "2026-07-28T10:00:00.000Z",
      boxId: null,
    };

    await expect(recordScan(failing, event, code)).rejects.toThrow(/disk full/);
  });

  it("does not touch codes_mirror when the event write fails for a scan with no code", async () => {
    const exec = makeExec();
    // Seed an unrelated code row that must survive untouched.
    await recordScan(
      exec,
      {
        shiftId: "s1",
        terminalId: "t1",
        raw: "OTHER",
        verdict: "ok",
        scannedAt: "2026-07-28T09:00:00.000Z",
        operatorId: null,
      },
      {
        codeHash: "other-h",
        shiftId: "s1",
        gtin14: "04600000000017",
        serial: "OTHER1",
        scannedAt: "2026-07-28T09:00:00.000Z",
        boxId: null,
      },
    );

    const failing: SqlExecutor = {
      run: async (sql, params) => {
        if (/INTO scan_events_mirror/i.test(sql)) throw new Error("disk full");
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
          raw: "junk",
          verdict: "invalid",
          scannedAt: "2026-07-28T10:00:01.000Z",
          operatorId: null,
        },
        null,
      ),
    ).rejects.toThrow(/disk full/);

    // The unrelated code row survives: nothing was deleted for a rejected scan.
    expect(await loadCodeKeys(exec)).toEqual(new Set(["other-h"]));
  });

  it("rethrows the original outbox error even when the compensating delete also fails", async () => {
    const exec = makeExec();
    const failing: SqlExecutor = {
      run: async (sql, params) => {
        if (/INTO outbox/i.test(sql)) throw new Error("disk full");
        if (/DELETE FROM codes_mirror/i.test(sql)) throw new Error("delete also failed");
        return exec.run(sql, params);
      },
      all: (sql, params) => exec.all(sql, params),
    };
    const event = {
      shiftId: "s1",
      terminalId: "t1",
      raw: "RAW1",
      verdict: "ok",
      scannedAt: "2026-07-28T10:00:00.000Z",
      operatorId: null,
    };
    const code = {
      codeHash: "h1",
      shiftId: "s1",
      gtin14: "04600000000017",
      serial: "AB1",
      scannedAt: "2026-07-28T10:00:00.000Z",
      boxId: null,
    };

    await expect(recordScan(failing, event, code)).rejects.toThrow(/disk full/);
  });

  it("does not touch codes_mirror on outbox failure for a scan with no code", async () => {
    const exec = makeExec();
    // Seed an unrelated code row that must survive untouched.
    await recordScan(
      exec,
      {
        shiftId: "s1",
        terminalId: "t1",
        raw: "OTHER",
        verdict: "ok",
        scannedAt: "2026-07-28T09:00:00.000Z",
        operatorId: null,
      },
      {
        codeHash: "other-h",
        shiftId: "s1",
        gtin14: "04600000000017",
        serial: "OTHER1",
        scannedAt: "2026-07-28T09:00:00.000Z",
        boxId: null,
      },
    );

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
          raw: "junk",
          verdict: "invalid",
          scannedAt: "2026-07-28T10:00:01.000Z",
          operatorId: null,
        },
        null,
      ),
    ).rejects.toThrow(/disk full/);

    // The unrelated code row survives: nothing was deleted for a rejected scan.
    expect(await loadCodeKeys(exec)).toEqual(new Set(["other-h"]));
  });

  it("does not delete an already-present code when the outbox write fails", async () => {
    const exec = makeExec();
    const code = {
      codeHash: "h1",
      shiftId: "s1",
      gtin14: "04600000000017",
      serial: "AB1",
      scannedAt: "2026-07-28T10:00:00.000Z",
      boxId: null,
    };

    // First scan: the code gets stored.
    await recordScan(
      exec,
      {
        shiftId: "s1",
        terminalId: "t1",
        raw: "RAW1",
        verdict: "ok",
        scannedAt: "2026-07-28T10:00:00.000Z",
        operatorId: null,
      },
      code,
    );

    // Verify the code is in codes_mirror.
    expect(await loadCodeKeys(exec)).toEqual(new Set(["h1"]));

    // Second scan of the same code with a failing outbox executor.
    const failing: SqlExecutor = {
      run: async (sql, params) => {
        if (/INTO outbox/i.test(sql)) throw new Error("disk full");
        return exec.run(sql, params);
      },
      all: (sql, params) => exec.all(sql, params),
    };

    // The second scan hits the primary key (storedCode = false, alreadyPresent = true)
    // and then the outbox insert fails.
    await expect(
      recordScan(
        failing,
        {
          shiftId: "s1",
          terminalId: "t1",
          raw: "RAW1",
          verdict: "ok",
          scannedAt: "2026-07-28T10:00:05.000Z",
          operatorId: null,
        },
        code,
      ),
    ).rejects.toThrow(/disk full/);

    // The code must still be in codes_mirror: the compensating delete only runs
    // when storedCode is true, but this second scan had storedCode = false because
    // the code was already present. If the guard were loosened to just check
    // 'code', the code would be incorrectly deleted, losing the first scan's
    // payload forever.
    expect(await loadCodeKeys(exec)).toEqual(new Set(["h1"]));
  });
});

describe("box id and operator id", () => {
  it("stores the box id on the code row and on the outbox row", async () => {
    const exec = makeExec();
    await recordScan(exec, event("a"), { ...acceptedCode, boxId: "b1" });
    const code = await exec.all<{ box_id: string }>(`SELECT box_id FROM codes_mirror`);
    const out = await exec.all<{ box_id: string }>(`SELECT box_id FROM outbox`);
    expect(code[0]!.box_id).toBe("b1");
    expect(out[0]!.box_id).toBe("b1");
  });

  it("compensates the code row away when the outbox write fails, box id and all", async () => {
    const exec = makeExec();
    const failing = failingExecOn(exec, /INSERT INTO outbox/);
    await expect(
      recordScan(failing, event("a"), { ...acceptedCode, boxId: "b1" }),
    ).rejects.toThrow();
    expect(await exec.all(`SELECT 1 FROM codes_mirror`)).toHaveLength(0);
  });

  it("stores the operator on the journal row and on the outbox row", async () => {
    const exec = makeExec();
    await recordScan(exec, { ...event("a"), operatorId: "op-1" }, { ...acceptedCode, boxId: "b1" });
    const ev = await exec.all<{ operator_id: string }>(
      `SELECT operator_id FROM scan_events_mirror`,
    );
    const out = await exec.all<{ operator_id: string }>(`SELECT operator_id FROM outbox`);
    expect(ev[0]!.operator_id).toBe("op-1");
    expect(out[0]!.operator_id).toBe("op-1");
  });
});

describe("undoLastScan", () => {
  it("deletes the code from codes_mirror, journals it as undone, and queues the exception fact", async () => {
    const exec = makeExec();
    await recordScan(
      exec,
      {
        shiftId: "s1",
        terminalId: null,
        raw: "raw1",
        verdict: "ok",
        scannedAt: "t1",
        operatorId: null,
      },
      {
        codeHash: "hash1",
        shiftId: "s1",
        gtin14: "04006381333931",
        serial: "1",
        scannedAt: "t1",
        boxId: "b1",
      },
    );

    await undoLastScan(exec, {
      boxId: "b1",
      codeHash: "hash1",
      scannedAt: "t1",
      shiftId: "s1",
      terminalId: null,
      operatorId: null,
      at: "t2",
    });

    const codes = await exec.all("SELECT * FROM codes_mirror WHERE code_hash = ?", ["hash1"]);
    expect(codes).toHaveLength(0);

    const events = await exec.all<{ verdict: string }>(
      "SELECT verdict FROM scan_events_mirror ORDER BY id DESC LIMIT 1",
    );
    expect(events[0]?.verdict).toBe("undone");

    const pending = await exec.all("SELECT * FROM box_exceptions_mirror");
    expect(pending).toHaveLength(1);
  });

  it("does not delete a newer local rescan when an old undo target arrives", async () => {
    const exec = makeExec();
    await recordScan(
      exec,
      {
        shiftId: "s1",
        terminalId: null,
        raw: "new scan",
        verdict: "ok",
        scannedAt: "t2",
        operatorId: null,
      },
      {
        codeHash: "hash1",
        shiftId: "s1",
        gtin14: "04006381333931",
        serial: "1",
        scannedAt: "t2",
        boxId: "b1",
      },
    );

    await undoLastScan(exec, {
      boxId: "b1",
      codeHash: "hash1",
      scannedAt: "t1",
      shiftId: "s1",
      terminalId: null,
      operatorId: null,
      at: "t3",
    });

    const codes = await exec.all<{ scanned_at: string }>(
      "SELECT scanned_at FROM codes_mirror WHERE code_hash = ?",
      ["hash1"],
    );
    expect(codes).toEqual([{ scanned_at: "t2" }]);
  });
});
