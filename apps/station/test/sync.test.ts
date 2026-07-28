import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { BATCH_SIZE, createSyncEngine, STUCK_AFTER_MS } from "../src/lib/sync.js";

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

async function seed(exec: SqlExecutor, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await exec.run(
      `INSERT INTO outbox (shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial)
       VALUES (?,?,?,?,?,?,?,?)`,
      ["s1", "t1", `RAW${i}`, "ok", "2026-07-28T10:00:00.000Z", `h${i}`, "04600000000017", `S${i}`],
    );
  }
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
    await seed(exec, 2);
    const post = vi.fn().mockResolvedValue({ applied: 2, alreadyApplied: false });

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    await engine.idle();

    expect((post.mock.calls[0]![1] as { batchId: string }).batchId).toBe("m1:2");
    engine.stop();
  });

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

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    await engine.idle();

    const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
    expect(rows[0]!.n).toBe(2);
    engine.stop();
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

  it("reports stuck once nothing has synced for the threshold while work is queued", async () => {
    const exec = await migratedExec();
    await seed(exec, 1);
    const post = vi.fn().mockRejectedValue(new Error("offline"));
    const states: { pending: number; stuck: boolean }[] = [];
    let clock = 1_000_000;

    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId: "m1",
      now: () => clock,
      onState: (s) => states.push({ pending: s.pending, stuck: s.stuck }),
    });
    engine.nudge();
    await engine.idle();
    expect(states.at(-1)).toMatchObject({ pending: 1, stuck: false });

    clock += STUCK_AFTER_MS + 1;
    engine.nudge();
    await engine.idle();
    expect(states.at(-1)).toMatchObject({ pending: 1, stuck: true });
    engine.stop();
  });

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
