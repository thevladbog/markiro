import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { ackThrough, oldestQueuedAt, outboxDepth, readBatch } from "../src/lib/outbox.js";

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

async function seed(exec: SqlExecutor, n: number, withCode = true): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await exec.run(
      `INSERT INTO outbox (shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        "s1",
        "t1",
        `RAW${i}`,
        "ok",
        `2026-07-28T10:00:0${i}.000Z`,
        withCode ? `h${i}` : null,
        withCode ? "04600000000017" : null,
        withCode ? `S${i}` : null,
      ],
    );
  }
}

describe("outbox", () => {
  it("reads in id order and never more than the limit", async () => {
    const exec = await migratedExec();
    await seed(exec, 5);
    const batch = await readBatch(exec, 3);
    expect(batch.map((i) => i.raw)).toEqual(["RAW1", "RAW2", "RAW3"]);
    expect(batch[0]!.id).toBeLessThan(batch[2]!.id);
  });

  it("shapes an accepted item with its code and a rejected one without", async () => {
    const exec = await migratedExec();
    await seed(exec, 1);
    await seed(exec, 1, false);
    const [accepted, rejected] = await readBatch(exec, 10);
    expect(accepted!.code).toEqual({ codeHash: "h1", gtin14: "04600000000017", serial: "S1" });
    expect(rejected!.code).toBeNull();
  });

  it("acknowledges exactly through the given id", async () => {
    const exec = await migratedExec();
    await seed(exec, 5);
    const batch = await readBatch(exec, 3);
    await ackThrough(exec, batch[2]!.id);
    expect((await readBatch(exec, 10)).map((i) => i.raw)).toEqual(["RAW4", "RAW5"]);
  });

  it("reports depth and the oldest queued timestamp", async () => {
    const exec = await migratedExec();
    expect(await outboxDepth(exec)).toBe(0);
    expect(await oldestQueuedAt(exec)).toBeNull();
    await seed(exec, 3);
    expect(await outboxDepth(exec)).toBe(3);
    expect(await oldestQueuedAt(exec)).toBe("2026-07-28T10:00:01.000Z");
  });

  it("leaves the queue intact when nothing is acknowledged", async () => {
    const exec = await migratedExec();
    await seed(exec, 4);
    await readBatch(exec, 4);
    expect(await outboxDepth(exec)).toBe(4);
  });
});
