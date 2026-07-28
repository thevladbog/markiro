import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { useSyncEngine, type UseSyncEngineDeps } from "../src/lib/use-sync-engine.js";

// Several tests below deliberately fail the POST to exercise the retry path,
// which logs through `console.error` by design. Silenced per-test (each
// spies explicitly) and always restored, so an unexpected error elsewhere
// still prints.
afterEach(() => {
  vi.restoreAllMocks();
});

/** Real in-memory SQLite (no Tauri/jsdom bridge needed) -- same pattern as sync.test.ts. */
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

async function seedOneRow(exec: SqlExecutor): Promise<void> {
  await exec.run(
    `INSERT INTO outbox (shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial)
     VALUES (?,?,?,?,?,?,?,?)`,
    ["s1", "t1", "RAW1", "ok", new Date().toISOString(), "h1", "04600000000017", "S1"],
  );
}

describe("useSyncEngine", () => {
  it("nudges on mount and drains a seeded row", async () => {
    const exec = await migratedExec();
    await seedOneRow(exec);
    const post = vi.fn().mockResolvedValue({ applied: 1, alreadyApplied: false });

    const { result } = renderHook((deps: UseSyncEngineDeps) => useSyncEngine(deps), {
      initialProps: { exec, client: { post }, machineId: "m1" },
    });

    await waitFor(() => expect(result.current.state.pending).toBe(0));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild the engine when a dependency is unchanged across a re-render (same as App's client/machineId keying)", async () => {
    const exec = await migratedExec();
    await seedOneRow(exec);
    const post = vi.fn().mockResolvedValue({ applied: 1, alreadyApplied: false });
    const client = { post };

    const { rerender } = renderHook((deps: UseSyncEngineDeps) => useSyncEngine(deps), {
      initialProps: { exec, client, machineId: "m1" },
    });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    // A fresh `deps` object, but `client`/`machineId` are the SAME values --
    // must not trigger a second mount-time nudge from a rebuilt engine.
    rerender({ exec, client, machineId: "m1" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it(
    "under StrictMode's mount -> cleanup -> mount double-invoke, a trigger " +
      "after mount still reaches a LIVE engine and drains the row " +
      "(regression guard for Finding 1: pairing create/destroy in one effect, " +
      "not a memo + separate cleanup effect, is what keeps this working)",
    async () => {
      const exec = await migratedExec();
      // Deliberately NOT seeded yet: the mount-time nudge(s) StrictMode's
      // double-invoke fires find an empty queue and do nothing, so neither
      // engine ever schedules a backoff retry. That matters with the
      // Finding 1 backoff fix in place: `nudge()` now does nothing while a
      // retry is scheduled, so a mount-time failure here would make the
      // post-mount trigger below a no-op EITHER way (dead engine: `stopped`;
      // live engine: a pending retry) and this test could no longer tell the
      // two apart.
      const post = vi.fn().mockImplementation(async (_path: string, body: unknown) => {
        const items = (body as { items: unknown[] }).items;
        return { applied: items.length, alreadyApplied: false };
      });

      const { result } = renderHook((deps: UseSyncEngineDeps) => useSyncEngine(deps), {
        wrapper: StrictMode,
        initialProps: { exec, client: { post }, machineId: "m1" },
      });

      // The double-invoke's mount-time nudge(s) have settled on an empty
      // queue -- no post was ever needed.
      await waitFor(() => expect(result.current.state.pending).toBe(0));
      expect(post).not.toHaveBeenCalled();

      // New work queued directly -- standing in for a scan recorded or the
      // `online` listener in App.tsx, both of which call this same
      // `nudge()` long after mount has settled.
      await seedOneRow(exec);
      act(() => {
        result.current.nudge();
      });

      // With construction/teardown paired, this reaches the engine the
      // (post-double-invoke) live setup created, and the row drains. With
      // the split shape, the second setup's `nudge()` would have already
      // been a no-op on an engine `stop()` had permanently killed before
      // this trigger ever ran, and this `waitFor` would time out.
      await waitFor(() => expect(result.current.state.pending).toBe(0));
      expect(post).toHaveBeenCalledTimes(1);
    },
  );
});
