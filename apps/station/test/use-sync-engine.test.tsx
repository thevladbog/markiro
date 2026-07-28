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
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const exec = await migratedExec();
        await seedOneRow(exec);

        // Every attempt fails until the gate is lifted, so the row can only
        // ever drain via the EXPLICIT `nudge()` call below -- never merely
        // via whatever automatic nudge(s) StrictMode's double-invoke made
        // during mount itself.
        let allowSuccess = false;
        // Untyped `vi.fn()` (configured via `mockImplementation`, not passed
        // a typed callback directly) so the mock stays assignable to the
        // generic `post<T>(path, body): Promise<T>` signature -- a directly
        // typed arrow function here would narrow to one concrete return
        // type and no longer satisfy that generic.
        const post = vi.fn().mockImplementation(async (_path: string, body: unknown) => {
          if (!allowSuccess) throw new Error("station: simulated network blip");
          const items = (body as { items: unknown[] }).items;
          return { applied: items.length, alreadyApplied: false };
        });

        const { result } = renderHook((deps: UseSyncEngineDeps) => useSyncEngine(deps), {
          wrapper: StrictMode,
          initialProps: { exec, client: { post }, machineId: "m1" },
        });

        // The double-invoke's own mount-time nudge(s) have each failed and
        // published state -- the row is still queued. If construction and
        // teardown were split (create-in-memo, stop-in-a-separate-cleanup-
        // effect), StrictMode's double-invoke would still get this far: the
        // FIRST setup's nudge fails once, exactly like here.
        await waitFor(() => expect(result.current.state.pending).toBe(1));

        // A trigger AFTER mount -- standing in for a scan recorded or the
        // `online` listener in App.tsx, both of which call this same
        // `nudge()` long after mount has settled.
        allowSuccess = true;
        act(() => {
          result.current.nudge();
        });

        // With construction/teardown paired, this reaches the engine the
        // (post-double-invoke) live setup created, and the row drains. With
        // the split shape, the second setup's `nudge()` would have already
        // been a no-op on an engine `stop()` had permanently killed before
        // this trigger ever ran, and this `waitFor` would time out.
        await waitFor(() => expect(result.current.state.pending).toBe(0));
      } finally {
        consoleErrorSpy.mockRestore();
      }
    },
  );
});
