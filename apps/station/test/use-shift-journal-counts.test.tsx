import { DatabaseSync } from "node:sqlite";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import type { SqlExecutor } from "../src/lib/mirror.js";
import { useShiftJournalCounts } from "../src/lib/use-shift-journal-counts.js";

function makeExec(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  for (const statement of STATION_MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  return {
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: async <T,>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
}

describe("useShiftJournalCounts", () => {
  it("reads the shift's counts on mount and again on refresh", async () => {
    const exec = makeExec();
    const { result } = renderHook(() => useShiftJournalCounts(exec, "s1"));
    await waitFor(() =>
      expect(result.current.counts).toEqual({ accepted: 0, errors: 0, duplicates: 0 }),
    );
    await exec.run(
      `INSERT INTO scan_events_mirror (shift_id, terminal_id, raw, verdict, scanned_at)
       VALUES ('s1', 't1', 'RAW', 'duplicate', '2026-09-25T09:00:00.000Z')`,
    );
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.counts.duplicates).toBe(1));
  });
});
