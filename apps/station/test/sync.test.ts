import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createStationClient, REQUEST_TIMEOUT_MS } from "../src/lib/api-client.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { BACKOFF_START_MS, BATCH_SIZE, createSyncEngine, STUCK_AFTER_MS } from "../src/lib/sync.js";
import { addRange, remaining } from "../src/lib/sscc-pool.js";
import {
  closeBox,
  currentBox,
  markPrintSkipped,
  markPrintVerified,
  openBox,
} from "../src/lib/boxes.js";
import { recordScan, type AcceptedCode, type ScanEventRow } from "../src/lib/journal.js";
import { outboxDepth } from "../src/lib/outbox.js";

// Several tests below deliberately fail the POST (or the device DB) to
// exercise the retry path, which logs through `console.error` by design.
// Silence it only for those tests (each spies explicitly) and always
// restore afterwards, so unexpected errors elsewhere still print.
afterEach(() => {
  vi.restoreAllMocks();
});

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

async function seed(
  exec: SqlExecutor,
  n: number,
  scannedAt = "2026-07-28T10:00:00.000Z",
): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await exec.run(
      `INSERT INTO outbox (shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial)
       VALUES (?,?,?,?,?,?,?,?)`,
      ["s1", "t1", `RAW${i}`, "ok", scannedAt, `h${i}`, "04600000000017", `S${i}`],
    );
  }
}

/** Seeds a fixed, known `install_id` so a test can assert an exact batchId. */
async function seedInstallId(exec: SqlExecutor, id: string): Promise<void> {
  await exec.run("INSERT INTO station_meta (key, value) VALUES (?, ?)", ["install_id", id]);
}

describe("sync engine", () => {
  it("drains the queue and acknowledges what the server accepted", async () => {
    const exec = await migratedExec();
    await seed(exec, 3);
    const post = vi.fn().mockResolvedValue({ applied: 3, alreadyApplied: false });

    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId: "m1",
      onState: () => {},
    });
    engine.nudge();
    await engine.idle();

    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe("/station/scans");
    expect((body as { items: unknown[] }).items).toHaveLength(3);
    const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
    expect(rows[0]!.n).toBe(0);
    engine.stop();
  });

  it("uses a deterministic batch id so a resend is the same key", async () => {
    const exec = await migratedExec();
    await seedInstallId(exec, "install-1");
    await seed(exec, 2);
    const post = vi.fn().mockResolvedValue({ applied: 2, alreadyApplied: false });

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    await engine.idle();

    expect((post.mock.calls[0]![1] as { batchId: string }).batchId).toBe("m1:install-1:2");
    engine.stop();
  });

  it(
    "pins a failed batch to its original row range, so a later attempt (the engine's own " +
      "retry, or one a nudge triggers) resends the SAME batch id and the SAME row count " +
      "instead of folding in rows queued during the backoff window (Finding 1)",
    async () => {
      const exec = await migratedExec();
      await seedInstallId(exec, "install-1");
      await seed(exec, 2);
      const post = vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ applied: 2, alreadyApplied: false });
      vi.spyOn(console, "error").mockImplementation(() => {});

      const engine = createSyncEngine({
        exec,
        client: { post },
        machineId: "m1",
        onState: () => {},
      });
      engine.nudge();
      await engine.idle();
      expect(post).toHaveBeenCalledTimes(1);
      const firstBody = post.mock.calls[0]![1] as { batchId: string; items: unknown[] };
      expect(firstBody.batchId).toBe("m1:install-1:2");
      expect(firstBody.items).toHaveLength(2);

      // A new scan arrives while the retry backoff is still pending -- the
      // exact Finding 1 trigger. Without a pinned ceiling, the next read
      // would pick up this row too and post all 3 under a FRESH key
      // (`m1:install-1:3`) the server has never recorded, applying the
      // original 2 rows a second time.
      await seed(exec, 1, "2026-07-28T10:05:00.000Z");
      engine.nudge();

      // Whether this nudge did anything immediately (old, buggy behaviour)
      // or nothing at all (fixed behaviour -- see the dedicated backoff test
      // below), the batch that eventually goes out as the "second attempt"
      // must be the pinned one: wait past the scheduled backoff so the
      // engine's own retry has certainly fired, then let anything in flight
      // settle.
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_START_MS + 500));
      await engine.idle();

      // Once the pinned (2-row) batch is acknowledged, the SAME drain loop
      // continues straight on to the 3rd row -- it was deferred, not lost --
      // so by the time the engine goes idle both posts have already
      // happened: the resend of the pinned batch, then a fresh one for the
      // row that arrived during the backoff.
      expect(post).toHaveBeenCalledTimes(3);
      const secondBody = post.mock.calls[1]![1] as { batchId: string; items: unknown[] };
      expect(secondBody.batchId).toBe(firstBody.batchId);
      expect(secondBody.items).toHaveLength(2);
      const thirdBody = post.mock.calls[2]![1] as { batchId: string; items: unknown[] };
      expect(thirdBody.batchId).not.toBe(firstBody.batchId);
      expect(thirdBody.items).toHaveLength(1);

      engine.stop();
    },
    10_000,
  );

  it(
    "persists the pending ceiling in station_meta, so a BRAND-NEW engine over the SAME " +
      "on-device database -- standing in for an app restart, crash, or update -- resends the " +
      "SAME pinned batch id and row count instead of reopening a fresh (and by then grown) " +
      "prefix read (Finding 1)",
    async () => {
      const exec = await migratedExec();
      await seedInstallId(exec, "install-1");
      await seed(exec, 2);
      const post1 = vi.fn().mockRejectedValue(new Error("offline"));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const engine1 = createSyncEngine({
        exec,
        client: { post: post1 },
        machineId: "m1",
        onState: () => {},
      });
      engine1.nudge();
      await engine1.idle();
      expect(post1).toHaveBeenCalledTimes(1);
      const firstBody = post1.mock.calls[0]![1] as { batchId: string; items: unknown[] };
      expect(firstBody.batchId).toBe("m1:install-1:2");
      expect(firstBody.items).toHaveLength(2);

      // A new scan arrives while the (never-fired) retry would still be
      // pending -- standing in for the operator continuing to scan right up
      // to the moment the app restarts.
      await seed(exec, 1, "2026-07-28T10:05:00.000Z");

      // The process dies here WITHOUT ever retrying: `stop()` discards the
      // scheduled backoff timer outright, same as a crash or a shift-end
      // restart would. An in-memory-only ceiling would die with it; the fix
      // under test is that it does not, because the ceiling was persisted to
      // `station_meta` BEFORE the failed post above, not just held in this
      // (about to be destroyed) closure.
      engine1.stop();

      // A BRAND-NEW engine, over the SAME on-device database -- exactly what
      // the app restarting builds. Nothing here shares any in-memory state
      // with `engine1`.
      const post2 = vi.fn().mockResolvedValue({ applied: 2, alreadyApplied: false });
      const engine2 = createSyncEngine({
        exec,
        client: { post: post2 },
        machineId: "m1",
        onState: () => {},
      });
      engine2.nudge();
      await engine2.idle();

      // Without a persisted ceiling, this fresh engine has no memory of the
      // first attempt and would read a plain fresh prefix -- all 3 queued
      // rows -- and post them under a NEW key the server has never recorded,
      // applying the original 2 rows a second time. With it, the very first
      // post from the new engine is the SAME batch id and the SAME row count
      // as the one the dead process pinned.
      expect(post2).toHaveBeenCalledTimes(2);
      const resumedBody = post2.mock.calls[0]![1] as { batchId: string; items: unknown[] };
      expect(resumedBody.batchId).toBe(firstBody.batchId);
      expect(resumedBody.items).toHaveLength(2);
      // The same drain loop continues straight on to the 3rd row afterwards,
      // under a fresh key -- it was deferred by the restart, not lost.
      const freshBody = post2.mock.calls[1]![1] as { batchId: string; items: unknown[] };
      expect(freshBody.batchId).not.toBe(firstBody.batchId);
      expect(freshBody.items).toHaveLength(1);

      engine2.stop();
    },
  );

  it(
    "a nudge while a retry is already scheduled does not produce an extra post, so scan " +
      "load offline cannot bypass the exponential backoff (Finding 1)",
    async () => {
      const exec = await migratedExec();
      await seedInstallId(exec, "install-1");
      await seed(exec, 2);
      // Keeps failing throughout -- this test only cares that a NUDGE never
      // triggers an extra attempt while one is already scheduled, not about
      // eventually succeeding.
      const post = vi.fn().mockRejectedValue(new Error("offline"));
      vi.spyOn(console, "error").mockImplementation(() => {});

      const engine = createSyncEngine({
        exec,
        client: { post },
        machineId: "m1",
        onState: () => {},
      });
      engine.nudge();
      await engine.idle();
      expect(post).toHaveBeenCalledTimes(1); // first attempt failed, retry scheduled

      // Several nudges while that retry is still pending -- standing in for
      // scans arriving while the device is offline. None of these may start
      // a new drain: that is exactly the backoff this finding protects.
      engine.nudge();
      engine.nudge();
      await engine.idle();

      expect(post).toHaveBeenCalledTimes(1);
      // Stop before the real backoff timer (BACKOFF_START_MS) can fire and
      // add a legitimate-but-unrelated attempt after this assertion already
      // ran.
      engine.stop();
    },
  );

  it(
    "keys the batch to this installation, not just the machine id, so a device that lost " +
      "only its local database cannot collide with a batch key the server already " +
      "recorded (Finding 3)",
    async () => {
      // Two separate on-device databases sharing the same machineId -- the
      // "deleted only station-mirror.db, kept station.json" scenario Finding
      // 3 describes: outbox ids restart at 1 in the fresh database, but the
      // machineId half of the key stays the same.
      const execOld = await migratedExec();
      const execNew = await migratedExec();
      await seed(execOld, 1);
      await seed(execNew, 1);

      const postOld = vi.fn().mockResolvedValue({ applied: 1, alreadyApplied: false });
      const postNew = vi.fn().mockResolvedValue({ applied: 1, alreadyApplied: false });

      const engineOld = createSyncEngine({
        exec: execOld,
        client: { post: postOld },
        machineId: "m1",
        onState: () => {},
      });
      engineOld.nudge();
      await engineOld.idle();

      const engineNew = createSyncEngine({
        exec: execNew,
        client: { post: postNew },
        machineId: "m1",
        onState: () => {},
      });
      engineNew.nudge();
      await engineNew.idle();

      const oldBatchId = (postOld.mock.calls[0]![1] as { batchId: string }).batchId;
      const newBatchId = (postNew.mock.calls[0]![1] as { batchId: string }).batchId;

      // Same machineId, same (single) outbox id in each queue -- without a
      // per-installation component these would be the IDENTICAL key, and the
      // server (having already recorded the old database's key) would
      // answer `alreadyApplied: true` for a scan it has never actually seen.
      expect(oldBatchId.startsWith("m1:")).toBe(true);
      expect(newBatchId.startsWith("m1:")).toBe(true);
      expect(newBatchId).not.toBe(oldBatchId);

      engineOld.stop();
      engineNew.stop();
    },
  );

  it("acknowledges an already-applied batch, so a lost response cannot wedge the queue", async () => {
    const exec = await migratedExec();
    await seed(exec, 2);
    const post = vi.fn().mockResolvedValue({ applied: 0, alreadyApplied: true });

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    await engine.idle();

    const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
    expect(rows[0]!.n).toBe(0);
    engine.stop();
  });

  it("leaves the queue intact when the send fails", async () => {
    const exec = await migratedExec();
    await seed(exec, 2);
    const post = vi.fn().mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    await engine.idle();

    const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
    expect(rows[0]!.n).toBe(2);
    engine.stop();
  });

  // Finding 1: a bare `fetch` has no built-in timeout, so a connection that
  // is accepted but whose response never arrives used to hang the drain's
  // `await client.post(...)` forever -- `draining` never clears, so later
  // nudges (a scan, the heartbeat, `online`) only set the "requested" flag
  // and `publishState()` never runs again, freezing the indicator. Uses the
  // REAL `createStationClient` (not a hand-rolled mock) so this proves the
  // actual fix in api-client.ts, not just that the engine's own retry path
  // works when handed an already-rejecting promise.
  it(
    "a stalled request (fetch that never settles on its own) rejects within the client's " +
      "timeout deadline, and the drain treats it as an ordinary failed batch: queue intact, " +
      "retry scheduled (Finding 1)",
    async () => {
      vi.useFakeTimers();
      try {
        const exec = await migratedExec();
        await seed(exec, 2);
        let capturedSignal: AbortSignal | undefined;
        vi.spyOn(globalThis, "fetch").mockImplementation((_url, init?: RequestInit) => {
          capturedSignal = init?.signal ?? undefined;
          // Never resolves or rejects on its own -- only reacts to the abort
          // the client's timeout is now responsible for triggering.
          return new Promise((_resolve, reject) => {
            capturedSignal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          });
        });
        vi.spyOn(console, "error").mockImplementation(() => {});

        const client = createStationClient({
          machineId: "m1",
          apiKey: "k",
          serverUrl: "http://localhost:3000",
        });
        const engine = createSyncEngine({ exec, client, machineId: "m1", onState: () => {} });

        engine.nudge();
        // Let the stalled attempt sit until the client's own deadline, then
        // let the resulting rejection propagate through the drain's catch
        // (which schedules a retry and does not touch the queue) and settle.
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1_000);
        await engine.idle();

        expect(capturedSignal?.aborted).toBe(true);
        // Queue intact -- nothing was acknowledged on the strength of a
        // request that never actually got a response.
        const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
        expect(rows[0]!.n).toBe(2);
        engine.stop();
      } finally {
        vi.useRealTimers();
      }
    },
    15_000,
  );

  it("does not acknowledge a batch when the response does not match the sync contract", async () => {
    const exec = await migratedExec();
    await seed(exec, 2);
    // A 2xx body that parses as JSON but isn't this endpoint's contract —
    // e.g. a captive portal or maintenance shim on the plant network
    // answering instead of the server.
    const post = vi.fn().mockResolvedValue({ status: "ok" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    await engine.idle();

    // Must be treated exactly like a failed send: rows stay queued, nothing
    // is permanently deleted on the strength of an unrecognized body.
    const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
    expect(rows[0]!.n).toBe(2);
    engine.stop();
  });

  it("keeps the drain from becoming an unhandled rejection when the device database throws", async () => {
    const exec = await migratedExec();
    await seed(exec, 1);
    // Simulates the device DB being locked or corrupt: every read/write
    // rejects, including the very first `readBatch` call inside `drain()`,
    // which sits outside the POST's own try/catch.
    const brokenExec: SqlExecutor = {
      run: exec.run,
      all: async () => {
        throw new Error("database is locked");
      },
    };
    const post = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      const engine = createSyncEngine({
        exec: brokenExec,
        client: { post },
        machineId: "m1",
        onState: () => {},
      });
      engine.nudge();
      await engine.idle();
      // Give any unhandled-rejection event queued by the (buggy) behaviour
      // this test guards against a chance to actually surface.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(post).not.toHaveBeenCalled();
      expect(rejections).toHaveLength(0);
      engine.stop();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("runs one drain at a time even when nudged concurrently", async () => {
    const exec = await migratedExec();
    await seed(exec, 2);
    let inFlight = 0;
    let maxInFlight = 0;
    const post = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { applied: 2, alreadyApplied: false };
    });

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    engine.nudge();
    engine.nudge();
    await engine.idle();

    expect(maxInFlight).toBe(1);
    engine.stop();
  });

  it("splits a long queue into batches of BATCH_SIZE", async () => {
    const exec = await migratedExec();
    await seed(exec, BATCH_SIZE + 5);
    const post = vi.fn().mockImplementation(async (_p: string, body: unknown) => ({
      applied: (body as { items: unknown[] }).items.length,
      alreadyApplied: false,
    }));

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    await engine.idle();

    expect(post).toHaveBeenCalledTimes(2);
    expect((post.mock.calls[0]![1] as { items: unknown[] }).items).toHaveLength(BATCH_SIZE);
    expect((post.mock.calls[1]![1] as { items: unknown[] }).items).toHaveLength(5);
    engine.stop();
  });

  it("before any success: is stuck when the oldest queued scan is already older than the threshold on the wall clock", async () => {
    const exec = await migratedExec();
    // Real ISO timestamp, well past the threshold on the actual wall clock.
    // No `now` override here: before any success, the code must measure
    // against `Date.now()`/`Date.parse`, never the injected clock, so this
    // test only proves something if it runs without one.
    const staleScannedAt = new Date(Date.now() - STUCK_AFTER_MS - 60_000).toISOString();
    await seed(exec, 1, staleScannedAt);
    const post = vi.fn().mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const states: { stuck: boolean }[] = [];

    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId: "m1",
      onState: (s) => states.push({ stuck: s.stuck }),
    });
    engine.nudge();
    await engine.idle();

    // This is the behaviour the original in-memory-only fix dropped: a
    // never-synced device with a stale backlog must warn immediately, not
    // fifteen minutes after this process happened to start. A regression to
    // "measure from first observation" would report false here.
    expect(states.at(-1)).toMatchObject({ stuck: true });
    engine.stop();
  });

  it("before any success: is not stuck when the oldest queued scan is fresh", async () => {
    const exec = await migratedExec();
    await seed(exec, 1, new Date().toISOString());
    const post = vi.fn().mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const states: { stuck: boolean }[] = [];

    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId: "m1",
      onState: (s) => states.push({ stuck: s.stuck }),
    });
    engine.nudge();
    await engine.idle();

    // Proves the branch actually compares ages rather than always reporting
    // stuck once any pre-success backlog exists.
    expect(states.at(-1)).toMatchObject({ stuck: false });
    engine.stop();
  });

  it("before any success: is not stuck when the oldest queued scan has an unparseable timestamp", async () => {
    const exec = await migratedExec();
    // An unparseable `scanned_at` makes `Date.parse` yield `NaN`. A NaN
    // comparison against the threshold is always `false`, so without the
    // explicit `Number.isFinite` guard this could read as "very old" only
    // by accident of how the comparison is written — assert it explicitly.
    await seed(exec, 1, "not-a-real-timestamp");
    const post = vi.fn().mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const states: { stuck: boolean }[] = [];

    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId: "m1",
      onState: (s) => states.push({ stuck: s.stuck }),
    });
    engine.nudge();
    await engine.idle();

    expect(states.at(-1)).toMatchObject({ stuck: false });
    engine.stop();
  });

  it(
    "after a success: does NOT report stuck for a freshly queued scan whose upload fails, even " +
      "once the injected clock has crossed the threshold since the last success (Finding 4)",
    async () => {
      const exec = await migratedExec();
      await seed(exec, 1);
      let clock = 1_000_000;
      const post = vi
        .fn()
        .mockResolvedValueOnce({ applied: 1, alreadyApplied: false })
        .mockRejectedValue(new Error("offline"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const states: { pending: number; stuck: boolean }[] = [];

      const engine = createSyncEngine({
        exec,
        client: { post },
        machineId: "m1",
        now: () => clock,
        onState: (s) => states.push({ pending: s.pending, stuck: s.stuck }),
      });
      engine.nudge();
      await engine.idle();
      expect(states.at(-1)).toMatchObject({ pending: 0, stuck: false });
      expect(post).toHaveBeenCalledTimes(1);

      // Queue fresh work (scanned "now" on the real clock) and make the next
      // send fail — this is the exact Finding 4 trigger: `lastSuccessAt` is
      // about to go stale purely because of an IDLE period, not because
      // anything failed to move, and the queue was empty and healthy the
      // whole time before this new scan arrived.
      await seed(exec, 1, new Date().toISOString());
      engine.nudge();
      await engine.idle();
      expect(states.at(-1)).toMatchObject({ pending: 1, stuck: false });

      // Advance only the INJECTED clock (standing in for idle time passing
      // with nothing queued) -- real wall-clock time barely moves, so the
      // freshly-queued scan seeded above is nowhere near STUCK_AFTER_MS old
      // on the wall clock. Before Finding 4's fix, `stuck` was driven solely
      // by `now() - lastSuccessAt`, so this alone was enough to flip it true
      // on the very first failed attempt against the new scan -- exactly the
      // "cries wolf" behaviour this fix removes.
      clock += STUCK_AFTER_MS + 1;
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_START_MS + 500));
      await engine.idle();
      expect(states.at(-1)).toMatchObject({ pending: 1, stuck: false });
      engine.stop();
    },
    10_000,
  );

  it(
    "after a success: reports stuck once an OLD queued scan (stale on the wall clock) has " +
      "failed to move for the threshold on the injected clock too (Finding 4)",
    async () => {
      const exec = await migratedExec();
      await seed(exec, 1);
      let clock = 1_000_000;
      const post = vi
        .fn()
        .mockResolvedValueOnce({ applied: 1, alreadyApplied: false })
        .mockRejectedValue(new Error("offline"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const states: { pending: number; stuck: boolean }[] = [];

      const engine = createSyncEngine({
        exec,
        client: { post },
        machineId: "m1",
        now: () => clock,
        onState: (s) => states.push({ pending: s.pending, stuck: s.stuck }),
      });
      engine.nudge();
      await engine.idle();
      expect(states.at(-1)).toMatchObject({ pending: 0, stuck: false });
      expect(post).toHaveBeenCalledTimes(1);

      // This time the newly queued scan is already old on the REAL wall
      // clock (e.g. a long-buffered backlog item), not merely idle time
      // since the last success.
      const staleScannedAt = new Date(Date.now() - STUCK_AFTER_MS - 60_000).toISOString();
      await seed(exec, 1, staleScannedAt);
      engine.nudge();
      await engine.idle();
      expect(states.at(-1)).toMatchObject({ pending: 1, stuck: false });

      clock += STUCK_AFTER_MS + 1;
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_START_MS + 500));
      await engine.idle();
      // Both conditions now hold: the injected clock crossed the threshold
      // since `lastSuccessAt`, AND the oldest queued scan is itself older
      // than the threshold on the wall clock.
      expect(states.at(-1)).toMatchObject({ pending: 1, stuck: true });
      engine.stop();
    },
    10_000,
  );

  it("records conflicts the server reports and counts them in the state", async () => {
    const exec = await migratedExec();
    await seed(exec, 1);
    const post = vi.fn().mockResolvedValue({
      applied: 1,
      alreadyApplied: false,
      conflicts: [
        { codeHash: "h1", winningTerminalId: "t9", winningScannedAt: "2026-07-28T10:00:00.000Z" },
      ],
    });
    const states: { conflicts: number }[] = [];

    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId: "m1",
      onState: (s) => states.push({ conflicts: s.conflicts }),
    });
    engine.nudge();
    await engine.idle();

    expect(states.at(-1)!.conflicts).toBe(1);
    engine.stop();
  });

  it("still acknowledges when the response carries no conflicts field", async () => {
    const exec = await migratedExec();
    await seed(exec, 1);
    const post = vi.fn().mockResolvedValue({ applied: 1, alreadyApplied: false });

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    await engine.idle();

    const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
    expect(rows[0]!.n).toBe(0);
    engine.stop();
  });

  it(
    "drops a conflict entry whose winningTerminalId is neither a string nor null, instead of " +
      "letting a malformed value reach the device database as a raw SQL parameter -- one bad " +
      "entry is dropped on its own, not the whole batch's conflicts (Finding 2)",
    async () => {
      const exec = await migratedExec();
      await seed(exec, 2);
      const post = vi.fn().mockResolvedValue({
        applied: 2,
        alreadyApplied: false,
        conflicts: [
          {
            codeHash: "h1",
            winningTerminalId: 12345,
            winningScannedAt: "2026-07-28T10:00:00.000Z",
          },
          { codeHash: "h2", winningTerminalId: null, winningScannedAt: "2026-07-28T10:00:00.000Z" },
        ],
      });
      const states: { conflicts: number }[] = [];

      const engine = createSyncEngine({
        exec,
        client: { post },
        machineId: "m1",
        onState: (s) => states.push({ conflicts: s.conflicts }),
      });
      engine.nudge();
      await engine.idle();

      expect(states.at(-1)!.conflicts).toBe(1);
      const rows = await exec.all<{ code_hash: string }>("SELECT code_hash FROM conflicts_mirror");
      expect(rows.map((r) => r.code_hash)).toEqual(["h2"]);
      engine.stop();
    },
  );

  it(
    "drops a conflict entry whose winningScannedAt does not parse to a real instant, instead of " +
      "letting it reach conflicts_mirror unchanged and crash ConflictList's date formatting later " +
      "-- one bad entry is dropped on its own, not the whole batch's conflicts (Finding 2)",
    async () => {
      const exec = await migratedExec();
      await seed(exec, 2);
      const post = vi.fn().mockResolvedValue({
        applied: 2,
        alreadyApplied: false,
        conflicts: [
          { codeHash: "h1", winningTerminalId: "t9", winningScannedAt: "garbage" },
          { codeHash: "h2", winningTerminalId: "t9", winningScannedAt: "2026-07-28T10:00:00.000Z" },
        ],
      });
      const states: { conflicts: number }[] = [];

      const engine = createSyncEngine({
        exec,
        client: { post },
        machineId: "m1",
        onState: (s) => states.push({ conflicts: s.conflicts }),
      });
      engine.nudge();
      await engine.idle();

      expect(states.at(-1)!.conflicts).toBe(1);
      const rows = await exec.all<{ code_hash: string }>("SELECT code_hash FROM conflicts_mirror");
      expect(rows.map((r) => r.code_hash)).toEqual(["h2"]);
      engine.stop();
    },
  );

  it(
    "records conflicts before acknowledging the batch, so a crash between the two device-side " +
      "writes never loses the only local record a conflict existed for that batch (Finding 4)",
    async () => {
      const exec = await migratedExec();
      await seed(exec, 1);
      const post = vi.fn().mockResolvedValue({
        applied: 1,
        alreadyApplied: false,
        conflicts: [
          { codeHash: "h1", winningTerminalId: "t9", winningScannedAt: "2026-07-28T10:00:00.000Z" },
        ],
      });
      const calls: string[] = [];
      const realRun = exec.run.bind(exec);
      const spiedExec: SqlExecutor = {
        ...exec,
        run: async (sql, params) => {
          calls.push(sql);
          return realRun(sql, params);
        },
      };

      const engine = createSyncEngine({
        exec: spiedExec,
        client: { post },
        machineId: "m1",
        onState: () => {},
      });
      engine.nudge();
      await engine.idle();

      const conflictIdx = calls.findIndex((sql) => sql.includes("INSERT INTO conflicts_mirror"));
      const ackIdx = calls.findIndex((sql) => sql.includes("DELETE FROM outbox"));
      expect(conflictIdx).toBeGreaterThanOrEqual(0);
      expect(ackIdx).toBeGreaterThanOrEqual(0);
      expect(conflictIdx).toBeLessThan(ackIdx);
      engine.stop();
    },
  );

  it(
    "acks the batch and keeps delivery moving when recording conflicts fails, so a local " +
      "recording failure cannot wedge every later scan behind a batch that can never ack -- " +
      "the server already durably applied it, so retrying protects nothing (Finding 1)",
    async () => {
      const exec = await migratedExec();
      await seed(exec, 1);
      const post = vi.fn().mockResolvedValue({
        applied: 1,
        alreadyApplied: false,
        conflicts: [
          { codeHash: "h1", winningTerminalId: "t9", winningScannedAt: "2026-07-28T10:00:00.000Z" },
        ],
      });
      const realRun = exec.run.bind(exec);
      const failingExec: SqlExecutor = {
        ...exec,
        run: async (sql, params) => {
          if (sql.includes("INSERT INTO conflicts_mirror")) {
            throw new Error("disk full");
          }
          return realRun(sql, params);
        },
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      const states: { conflicts: number; pending: number }[] = [];

      const engine = createSyncEngine({
        exec: failingExec,
        client: { post },
        machineId: "m1",
        onState: (s) => states.push({ conflicts: s.conflicts, pending: s.pending }),
      });
      engine.nudge();
      await engine.idle();

      // The batch acked despite the recording failure: outbox drained, and
      // the conflict was never recorded (the accepted, permanent loss).
      const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
      expect(rows[0]!.n).toBe(0);
      expect(states.at(-1)).toMatchObject({ pending: 0, conflicts: 0 });

      // Delivery keeps moving for scans recorded after the failure --
      // nothing wedged behind the batch that failed to record.
      await seed(exec, 1, "2026-07-28T10:05:00.000Z");
      engine.nudge();
      await engine.idle();
      const rows2 = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
      expect(rows2[0]!.n).toBe(0);
      expect(post).toHaveBeenCalledTimes(2);

      engine.stop();
    },
  );

  it("is not stuck when the queue is empty, however long since the last sync", async () => {
    const exec = await migratedExec();
    const post = vi.fn();
    const states: { stuck: boolean }[] = [];
    let clock = 1_000_000;

    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId: "m1",
      now: () => clock,
      onState: (s) => states.push({ stuck: s.stuck }),
    });
    clock += STUCK_AFTER_MS * 10;
    engine.nudge();
    await engine.idle();

    expect(post).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ stuck: false });
    engine.stop();
  });
});

describe("sync engine: pools and closures", () => {
  const SHIFT = "s1";
  const ISO = "2026-07-29T10:00:00.000Z";
  // A 9-digit GS1 issuer prefix -- see sscc-pool.ts's doc comment for why
  // the pool is keyed by prefix, not by GLN (the brief that seeded these
  // tests predates that correction).
  const ISSUER_PREFIX = "460123456";
  const SSCC = "004601234560000017";
  const TERMINAL = "t1";

  /** One scan event, distinguished by `id` only in its raw payload. */
  function event(id: string): ScanEventRow {
    return {
      shiftId: SHIFT,
      terminalId: TERMINAL,
      raw: `RAW-${id}`,
      verdict: "ok",
      scannedAt: ISO,
      operatorId: null,
    };
  }

  /** One accepted code, named into `boxId` (or null for none). `id` IS the codeHash. */
  function code(id: string, boxId: string | null): AcceptedCode {
    return {
      codeHash: id,
      shiftId: SHIFT,
      gtin14: "04600000000015",
      serial: id,
      scannedAt: ISO,
      boxId,
    };
  }

  /** Wraps `exec` so any `run` whose SQL matches `pattern` throws instead of writing. */
  function failingExecOn(exec: SqlExecutor, pattern: RegExp): SqlExecutor {
    const realRun = exec.run.bind(exec);
    return {
      ...exec,
      run: async (sql, params) => {
        if (pattern.test(sql)) throw new Error("simulated failure");
        return realRun(sql, params);
      },
    };
  }

  async function outboxCount(execToCount: SqlExecutor): Promise<number> {
    return outboxDepth(execToCount);
  }

  let exec: SqlExecutor;
  let post = vi.fn();

  beforeEach(async () => {
    exec = await migratedExec();
    post = vi.fn().mockResolvedValue({ applied: 1, alreadyApplied: false, conflicts: [] });
    // A default queued scan so every `drainOnce()` below has a batch to
    // send, even in tests that otherwise queue nothing of their own (the
    // pool-reporting tests) or only close a box.
    await seed(exec, 1);
  });

  function mockPost(response: unknown): void {
    post.mockResolvedValue(response);
  }

  /**
   * The body of the most recent POST made by the most recent `drainOnce()`
   * call, or an empty-batch stand-in if that call made no POST at all (there
   * was genuinely nothing left to send -- see "does not resend a box
   * already acknowledged" below, which relies on exactly this to prove a
   * SECOND drain carries no box).
   */
  function lastBody(): string {
    const call = post.mock.calls.at(-1);
    return JSON.stringify(call ? call[1] : { items: [], boxes: [] });
  }

  /**
   * Drains once against `execForDrain` (defaulting to the shared `exec`),
   * via a fresh engine bound to the shared `post` mock. `post.mockClear()`
   * runs first so `lastBody()` reflects only THIS call, not a previous one.
   */
  async function drainOnce(execForDrain: SqlExecutor = exec): Promise<void> {
    post.mockClear();
    const engine = createSyncEngine({
      exec: execForDrain,
      client: { post },
      machineId: "m1",
      onState: () => {},
    });
    engine.nudge();
    await engine.idle();
    engine.stop();
  }

  it("applies a serial block carried by the sync response", async () => {
    mockPost({
      applied: 1,
      alreadyApplied: false,
      conflicts: [],
      ssccBlock: { issuerPrefix: ISSUER_PREFIX, extensionDigit: 0, fromSerial: 5, toSerial: 9 },
    });
    await drainOnce();
    expect(await remaining(exec, ISSUER_PREFIX, 0)).toBe(5);
  });

  it("reports how many serials are left in the batch it sends", async () => {
    await addRange(exec, {
      issuerPrefix: ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 1,
      toSerial: 3,
    });
    await drainOnce();
    expect(JSON.parse(lastBody()).serialsLeft).toBe(3);
  });

  it("sends a closed box with its serial", async () => {
    await openBox(exec, SHIFT, "b1", ISO, TERMINAL);
    await closeBox(exec, "b1", SSCC, ISO, null);
    await drainOnce();
    expect(JSON.parse(lastBody()).boxes).toEqual([
      {
        boxId: "b1",
        shiftId: SHIFT,
        terminalId: TERMINAL,
        sscc: SSCC,
        closedAt: ISO,
        operatorId: null,
        printVerifiedAt: null,
        printSkippedAt: null,
      },
    ]);
  });

  // Task 13 review, Finding 6: `boxes_mirror.print_verified_at`/
  // `print_skipped_at` (Task 9's columns, idle until now) must actually
  // reach the closure payload, not just exist on the device.
  it("carries the print-verification outcome recorded on boxes_mirror into the closure payload", async () => {
    await openBox(exec, SHIFT, "b1", ISO, TERMINAL);
    await closeBox(exec, "b1", SSCC, ISO, null);
    await markPrintVerified(exec, "b1", ISO);
    await drainOnce();
    const boxes = JSON.parse(lastBody()).boxes;
    expect(boxes).toEqual([
      {
        boxId: "b1",
        shiftId: SHIFT,
        terminalId: TERMINAL,
        sscc: SSCC,
        closedAt: ISO,
        operatorId: null,
        printVerifiedAt: ISO,
        printSkippedAt: null,
      },
    ]);
  });

  it("carries a skipped print verification into the closure payload", async () => {
    await openBox(exec, SHIFT, "b1", ISO, TERMINAL);
    await closeBox(exec, "b1", SSCC, ISO, null);
    await markPrintSkipped(exec, "b1", ISO);
    await drainOnce();
    const boxes = JSON.parse(lastBody()).boxes;
    expect(boxes).toEqual([
      {
        boxId: "b1",
        shiftId: SHIFT,
        terminalId: TERMINAL,
        sscc: SSCC,
        closedAt: ISO,
        operatorId: null,
        printVerifiedAt: null,
        printSkippedAt: ISO,
      },
    ]);
  });

  // Task 9 threaded `box_id`/`operator_id` onto the outbox row itself; this
  // pins the OTHER half, that `readBatch`/`toPayload` actually carry them
  // through to the request body rather than silently dropping them there --
  // the box-membership and operator-attribution bookkeeping those columns
  // exist for would otherwise never reach the server despite being recorded
  // correctly on the device.
  it("carries a scan's box id and operator id from the outbox row into the request body", async () => {
    const OPERATOR = "22222222-2222-2222-2222-222222222222";
    await openBox(exec, SHIFT, "b1", ISO, TERMINAL);
    await recordScan(exec, { ...event("a"), operatorId: OPERATOR }, code("aa", "b1"));
    await drainOnce();
    const items = JSON.parse(lastBody()).items as Array<{
      boxId: string | null;
      operatorId: string | null;
      code: { codeHash: string } | null;
    }>;
    const item = items.find((i) => i.code?.codeHash === "aa");
    expect(item).toMatchObject({ boxId: "b1", operatorId: OPERATOR });
  });

  it("does not resend a box already acknowledged", async () => {
    await openBox(exec, SHIFT, "b1", ISO, TERMINAL);
    await closeBox(exec, "b1", SSCC, ISO, null);
    await drainOnce();
    await drainOnce();
    expect(JSON.parse(lastBody()).boxes).toEqual([]);
  });

  // A box can close well after its last item was drained -- the shift's
  // last box, with nothing left queued behind it. This pins the path with
  // no outbox maxId at all (batch.length === 0, boxes.length > 0): the
  // batchId falls back to the box's own rowid, and the ack skips
  // `ackThrough` entirely (there is no outbox range to acknowledge) while
  // still marking the box itself acknowledged.
  it("sends a closed box on its own once the queue has otherwise drained", async () => {
    await drainOnce(); // drains away the default seeded row, leaving the outbox empty.
    await openBox(exec, SHIFT, "b1", ISO, TERMINAL);
    await closeBox(exec, "b1", SSCC, ISO, null);
    await drainOnce();
    const body = JSON.parse(lastBody());
    expect(body.items).toEqual([]);
    expect(body.boxes).toEqual([
      {
        boxId: "b1",
        shiftId: SHIFT,
        terminalId: TERMINAL,
        sscc: SSCC,
        closedAt: ISO,
        operatorId: null,
        printVerifiedAt: null,
        printSkippedAt: null,
      },
    ]);
  });

  it("still acknowledges when applying a serial block fails", async () => {
    const failing = failingExecOn(exec, /INSERT INTO sscc_pool/);
    mockPost({
      applied: 1,
      alreadyApplied: false,
      conflicts: [],
      ssccBlock: { issuerPrefix: ISSUER_PREFIX, extensionDigit: 0, fromSerial: 5, toSerial: 9 },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await drainOnce(failing);
    expect(await outboxCount(exec)).toBe(0);
  });

  it("still rejects a response that is not this endpoint's shape", async () => {
    mockPost({
      status: "ok",
      ssccBlock: { issuerPrefix: ISSUER_PREFIX, extensionDigit: 0, fromSerial: 5, toSerial: 9 },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await drainOnce();
    expect(await outboxCount(exec)).toBe(1);
    expect(await remaining(exec, ISSUER_PREFIX, 0)).toBe(0);
  });

  it("drops a lost code from the box that is still open", async () => {
    await openBox(exec, SHIFT, "b1", ISO, TERMINAL);
    await recordScan(exec, event("a"), code("aa", "b1"));
    await recordScan(exec, event("b"), code("bb", "b1"));
    mockPost({
      applied: 2,
      alreadyApplied: false,
      conflicts: [{ codeHash: "aa", winningTerminalId: "t9", winningScannedAt: ISO }],
    });
    await drainOnce();
    expect((await currentBox(exec, SHIFT))?.itemCount).toBe(1);
  });

  it("leaves a closed box alone when one of its codes is lost", async () => {
    await openBox(exec, SHIFT, "b1", ISO, TERMINAL);
    await recordScan(exec, event("a"), code("aa", "b1"));
    await closeBox(exec, "b1", SSCC, ISO, null);
    mockPost({
      applied: 1,
      alreadyApplied: false,
      conflicts: [{ codeHash: "aa", winningTerminalId: "t9", winningScannedAt: ISO }],
    });
    await drainOnce();
    const rows = await exec.all<{ box_id: string }>(
      `SELECT box_id FROM codes_mirror WHERE code_hash = ?`,
      ["aa"],
    );
    expect(rows[0]!.box_id).toBe("b1");
  });
});
