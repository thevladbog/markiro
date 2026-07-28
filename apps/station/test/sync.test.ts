import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { BACKOFF_START_MS, BATCH_SIZE, createSyncEngine, STUCK_AFTER_MS } from "../src/lib/sync.js";

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

  it("after a success: reports stuck once nothing has synced for the threshold, measured on the injected clock", async () => {
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

    // Queue fresh work (scanned "now" on the real clock, so a regression
    // back to comparing wall-clock ages here could not accidentally pass)
    // and make the next send fail.
    await seed(exec, 1, new Date().toISOString());
    engine.nudge();
    await engine.idle();
    expect(states.at(-1)).toMatchObject({ pending: 1, stuck: false });

    clock += STUCK_AFTER_MS + 1;
    // The failed nudge above already scheduled a retry -- with the Finding 1
    // backoff fix, `nudge()` itself now does nothing while that retry is
    // pending (nudging again here would just restate the stale state), so
    // waiting for the engine's OWN scheduled attempt (which will also fail,
    // and re-publish state regardless) is what actually re-evaluates
    // `stuck` against the now-advanced clock.
    await new Promise((resolve) => setTimeout(resolve, BACKOFF_START_MS + 500));
    await engine.idle();
    // Flips only because the *injected* clock crossed the threshold since
    // `lastSuccessAt`; a regression that dropped this branch (or compared
    // the wrong clock) would leave this false forever.
    expect(states.at(-1)).toMatchObject({ pending: 1, stuck: true });
    engine.stop();
  }, 10_000);

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
