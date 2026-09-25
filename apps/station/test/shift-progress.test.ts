import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { StationApiError } from "../src/lib/api-client.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  SHIFT_PROGRESS_INTERVAL_MS,
  SHIFT_PROGRESS_META_KEY,
  SHIFT_PROGRESS_STALE_AFTER_MS,
  SHIFT_PROGRESS_UNSUPPORTED_RETRY_MS,
  createShiftProgressTracker,
  shiftTotalView,
  type ShiftProgressSnapshot,
} from "../src/lib/shift-progress.js";

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

const answer = {
  shiftId: "s1",
  acceptedUnits: 1302,
  deviceAcceptedUnits: 302,
  asOf: "2026-09-25T09:00:00.000Z",
};
const NOW = Date.parse("2026-09-25T09:00:30.000Z");
const snapshot = (overrides: Partial<ShiftProgressSnapshot> = {}): ShiftProgressSnapshot => ({
  ...answer,
  fetchedAt: "2026-09-25T09:00:01.000Z",
  ...overrides,
});

describe("shiftTotalView", () => {
  it("shows this terminal's own count before the first server answer", () => {
    expect(
      shiftTotalView({ shiftId: "s1", snapshot: null, local: 302, plannedQty: 9580, nowMs: NOW }),
    ).toEqual({
      scope: "terminal",
      total: 302,
      planned: 9580,
      planRatio: 302 / 9580,
      terminal: null,
      othersAsOf: null,
    });
  });

  it("adds the other terminals' last known share to the live local count", () => {
    expect(
      shiftTotalView({
        shiftId: "s1",
        snapshot: snapshot(),
        local: 310,
        plannedQty: 9580,
        nowMs: NOW,
      }),
    ).toEqual({
      scope: "all",
      total: 1310,
      planned: 9580,
      planRatio: 1310 / 9580,
      terminal: 310,
      othersAsOf: null,
    });
  });

  it("hides the terminal share when no other terminal is counted", () => {
    expect(
      shiftTotalView({
        shiftId: "s1",
        snapshot: snapshot({ acceptedUnits: 302 }),
        local: 305,
        plannedQty: null,
        nowMs: NOW,
      }),
    ).toEqual({
      scope: "all",
      total: 305,
      planned: null,
      planRatio: null,
      terminal: null,
      othersAsOf: null,
    });
  });

  it("marks a stale answer that includes other terminals", () => {
    const fetchedAt = new Date(NOW - SHIFT_PROGRESS_STALE_AFTER_MS - 1).toISOString();
    expect(
      shiftTotalView({
        shiftId: "s1",
        snapshot: snapshot({ fetchedAt }),
        local: 302,
        plannedQty: 9580,
        nowMs: NOW,
      }).othersAsOf,
    ).toBe(fetchedAt);
  });

  it("ignores an answer for another shift and caps the bar at the plan", () => {
    expect(
      shiftTotalView({ shiftId: "s2", snapshot: snapshot(), local: 5, plannedQty: 4, nowMs: NOW }),
    ).toEqual({
      scope: "terminal",
      total: 5,
      planned: 4,
      planRatio: 1,
      terminal: null,
      othersAsOf: null,
    });
  });
});

describe("createShiftProgressTracker", () => {
  it("fetches the watched shift, persists the answer and reloads it after a restart", async () => {
    const exec = await migratedExec();
    const get = vi.fn().mockResolvedValue(answer);
    const tracker = createShiftProgressTracker({ exec, client: { get }, now: () => 1_000_000 });
    tracker.watch("s1");
    await tracker.refresh(() => true);
    // Display-only: a CORS refusal by an older server must not paint the
    // header's server pill «Нет связи» after every drain.
    expect(get).toHaveBeenCalledWith("/station/shifts/s1/progress", { displayOnly: true });
    expect(await tracker.current()).toMatchObject(answer);

    const restarted = createShiftProgressTracker({ exec, client: {}, now: () => 1_000_000 });
    restarted.watch("s1");
    expect(await restarted.current()).toMatchObject(answer);
    restarted.watch("s2");
    expect(await restarted.current()).toBeNull();
  });

  it("asks at most once per interval and never without a watched shift", async () => {
    const exec = await migratedExec();
    const get = vi.fn().mockResolvedValue(answer);
    let clock = 1_000_000;
    const tracker = createShiftProgressTracker({ exec, client: { get }, now: () => clock });
    await tracker.refresh(() => true);
    expect(get).not.toHaveBeenCalled();
    tracker.watch("s1");
    await tracker.refresh(() => true);
    clock += SHIFT_PROGRESS_INTERVAL_MS - 1;
    await tracker.refresh(() => true);
    expect(get).toHaveBeenCalledTimes(1);
    clock += 1;
    await tracker.refresh(() => true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer through failures and bad answers, and suspends on 404", async () => {
    const exec = await migratedExec();
    let clock = 1_000_000;
    const get = vi
      .fn()
      .mockResolvedValueOnce(answer)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ ...answer, shiftId: "s2" })
      .mockRejectedValueOnce(new StationApiError(404, "Not Found"));
    const tracker = createShiftProgressTracker({ exec, client: { get }, now: () => clock });
    tracker.watch("s1");
    await tracker.refresh(() => true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      clock += SHIFT_PROGRESS_INTERVAL_MS;
      await tracker.refresh(() => true).catch(() => undefined);
    }
    expect(await tracker.current()).toMatchObject(answer);
    clock += SHIFT_PROGRESS_INTERVAL_MS;
    await tracker.refresh(() => true);
    expect(get).toHaveBeenCalledTimes(5);
    clock += SHIFT_PROGRESS_UNSUPPORTED_RETRY_MS - 1;
    await tracker.refresh(() => true);
    expect(get).toHaveBeenCalledTimes(5);
  });

  it("drops an answer that arrives after the engine stopped wanting it", async () => {
    const exec = await migratedExec();
    const tracker = createShiftProgressTracker({
      exec,
      client: { get: vi.fn().mockResolvedValue(answer) },
      now: () => 1_000_000,
    });
    tracker.watch("s1");
    await tracker.refresh(() => false);
    expect(await tracker.current()).toBeNull();
  });

  it("treats a damaged cache (invalid JSON) as no cached answer, then replaces it after a refresh", async () => {
    const exec = await migratedExec();
    await exec.run("INSERT INTO station_meta (key, value) VALUES (?, ?)", [
      SHIFT_PROGRESS_META_KEY,
      "{not json",
    ]);
    const get = vi.fn().mockResolvedValue(answer);
    const tracker = createShiftProgressTracker({ exec, client: { get }, now: () => 1_000_000 });
    tracker.watch("s1");
    expect(await tracker.current()).toBeNull();
    await tracker.refresh(() => true);
    expect(await tracker.current()).toMatchObject(answer);
  });

  it("treats a damaged cache (schema-invalid answer) as no cached answer, then replaces it after a refresh", async () => {
    const exec = await migratedExec();
    await exec.run("INSERT INTO station_meta (key, value) VALUES (?, ?)", [
      SHIFT_PROGRESS_META_KEY,
      JSON.stringify({
        shiftId: "s1",
        acceptedUnits: 5,
        deviceAcceptedUnits: 10, // invalid: exceeds acceptedUnits
        asOf: "2026-09-25T09:00:00.000Z",
        fetchedAt: "2026-09-25T09:00:01.000Z",
      }),
    ]);
    const get = vi.fn().mockResolvedValue(answer);
    const tracker = createShiftProgressTracker({ exec, client: { get }, now: () => 1_000_000 });
    tracker.watch("s1");
    expect(await tracker.current()).toBeNull();
    await tracker.refresh(() => true);
    expect(await tracker.current()).toMatchObject(answer);
  });

  it("shares one in-flight load across concurrent current() calls instead of racing separate reads", async () => {
    const exec = await migratedExec();
    const seed = createShiftProgressTracker({
      exec,
      client: { get: vi.fn().mockResolvedValue(answer) },
      now: () => 1_000_000,
    });
    seed.watch("s1");
    await seed.refresh(() => true);

    // A fresh tracker instance (as after a station restart) has not loaded
    // station_meta yet. Gate the read so it is still in flight when the
    // second current() call starts; both calls must wait for the same read
    // and see the persisted answer rather than the second one short-
    // circuiting past an in-progress load and returning null.
    let releaseRead: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const gatedExec: SqlExecutor = {
      run: exec.run,
      async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        await gate;
        return exec.all<T>(sql, params);
      },
    };
    const tracker = createShiftProgressTracker({
      exec: gatedExec,
      client: {},
      now: () => 1_000_000,
    });
    tracker.watch("s1");
    const first = tracker.current();
    const second = tracker.current();
    releaseRead?.();
    expect(await first).toMatchObject(answer);
    expect(await second).toMatchObject(answer);
  });

  it("does not let a load that resolves late overwrite an answer refresh() already stored", async () => {
    const exec = await migratedExec();
    let releaseFirstRead: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let firstRead = true;
    const staleRow = {
      value: JSON.stringify({
        shiftId: "s1",
        acceptedUnits: 1,
        deviceAcceptedUnits: 1,
        asOf: "2020-01-01T00:00:00.000Z",
        fetchedAt: "2020-01-01T00:00:00.000Z",
      }),
    };
    const gatedExec: SqlExecutor = {
      run: exec.run,
      async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        if (firstRead) {
          firstRead = false;
          // Simulate the SELECT having started (and captured a stale row)
          // before refresh() writes a fresh answer, but not resolving to
          // its caller until released below — well after refresh() stored
          // the fresh answer.
          await gate;
          return [staleRow] as T[];
        }
        return exec.all<T>(sql, params);
      },
    };
    const get = vi.fn().mockResolvedValue(answer);
    const tracker = createShiftProgressTracker({
      exec: gatedExec,
      client: { get },
      now: () => 1_000_000,
    });
    tracker.watch("s1");

    const currentBeforeLoad = tracker.current();
    await tracker.refresh(() => true);
    releaseFirstRead?.();

    expect(await currentBeforeLoad).toMatchObject(answer);
    expect(await tracker.current()).toMatchObject(answer);
  });

  it("degrades to no cached answer, without rejecting, when the station_meta read fails", async () => {
    const exec = await migratedExec();
    const failingExec: SqlExecutor = {
      run: exec.run,
      all: () => Promise.reject(new Error("disk read failed")),
    };
    const tracker = createShiftProgressTracker({
      exec: failingExec,
      client: {},
      now: () => 1_000_000,
    });
    tracker.watch("s1");
    await expect(tracker.current()).resolves.toBeNull();
    // A later call must not keep rejecting either.
    await expect(tracker.current()).resolves.toBeNull();
  });
});
