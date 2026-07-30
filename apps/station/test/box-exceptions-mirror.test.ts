import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  ackExceptionsThrough,
  insertException,
  readExceptions,
  type ExceptionInput,
} from "../src/lib/box-exceptions-mirror.js";

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

/** A minimal valid exception, overridable per-call the way outbox.test.ts's `seed` builds rows. */
function makeException(overrides: Partial<ExceptionInput> = {}): ExceptionInput {
  return {
    kind: "undo",
    boxId: "b1",
    codeHash: "hash1",
    shiftId: "s1",
    terminalId: null,
    operatorId: null,
    reason: null,
    at: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("box-exceptions-mirror", () => {
  it("inserts, reads oldest-first, and hard-deletes on ack", async () => {
    const exec = await migratedExec();
    await insertException(exec, makeException({ kind: "undo", at: "2026-07-30T00:00:00.000Z" }));
    await insertException(
      exec,
      makeException({
        kind: "clear",
        codeHash: null,
        reason: "wrong box",
        at: "2026-07-30T00:01:00.000Z",
      }),
    );

    const first = await readExceptions(exec, 1);
    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe("undo");

    await ackExceptionsThrough(exec, first[0]!.id);
    const remaining = await readExceptions(exec, 10);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.kind).toBe("clear");
  });

  it("shapes a row back with every field, ids in insertion order", async () => {
    const exec = await migratedExec();
    await insertException(
      exec,
      makeException({
        kind: "disassemble",
        boxId: "b7",
        codeHash: null,
        shiftId: "s9",
        terminalId: "t1",
        operatorId: "op1",
        reason: "damaged box",
        at: "2026-07-29T12:00:00.000Z",
      }),
    );
    const [row] = await readExceptions(exec, 10);
    expect(row).toEqual({
      id: expect.any(Number),
      kind: "disassemble",
      boxId: "b7",
      codeHash: null,
      shiftId: "s9",
      terminalId: "t1",
      operatorId: "op1",
      reason: "damaged box",
      at: "2026-07-29T12:00:00.000Z",
    });
  });

  it("never reads more than the given limit", async () => {
    const exec = await migratedExec();
    for (let i = 0; i < 5; i++) {
      await insertException(
        exec,
        makeException({ boxId: `b${i}`, at: `2026-07-30T00:0${i}:00.000Z` }),
      );
    }
    const batch = await readExceptions(exec, 3);
    expect(batch).toHaveLength(3);
    expect(batch.map((e) => e.boxId)).toEqual(["b0", "b1", "b2"]);
  });

  it(
    "readExceptions respects a ceilingId, the same way outbox.readBatch does " +
      "(a retry must re-read the exact same set, not a set grown by rows queued since)",
    async () => {
      const exec = await migratedExec();
      await insertException(exec, makeException({ boxId: "b1", codeHash: "h1", at: "t1" }));
      const [firstRow] = await readExceptions(exec, 1);

      await insertException(exec, makeException({ boxId: "b2", codeHash: "h2", at: "t2" }));

      const pinned = await readExceptions(exec, 10, firstRow!.id);
      expect(pinned).toHaveLength(1);
      expect(pinned[0]?.boxId).toBe("b1");

      const fresh = await readExceptions(exec, 10);
      expect(fresh.map((e) => e.boxId)).toEqual(["b1", "b2"]);
    },
  );

  it("leaves the queue intact when nothing is acknowledged", async () => {
    const exec = await migratedExec();
    await insertException(exec, makeException());
    await insertException(exec, makeException({ boxId: "b2" }));
    await readExceptions(exec, 10);
    expect(await readExceptions(exec, 10)).toHaveLength(2);
  });

  it("acknowledges exactly through the given id, never past it", async () => {
    const exec = await migratedExec();
    for (let i = 0; i < 3; i++) {
      await insertException(exec, makeException({ boxId: `b${i}` }));
    }
    const batch = await readExceptions(exec, 2);
    await ackExceptionsThrough(exec, batch[1]!.id);
    const remaining = await readExceptions(exec, 10);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.boxId).toBe("b2");
  });
});
