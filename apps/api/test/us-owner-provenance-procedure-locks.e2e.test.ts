import { randomUUID } from "node:crypto";
import { setTimeout as pollInterval } from "node:timers/promises";
import { createDb } from "@markiro/db";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { UsDevelopmentOwnerStore } from "../src/deployment/us-development-owner";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  abortable,
  connectClient,
  outcome,
  waitBlocked,
  type OwnedClient,
} from "./support/us-transformation-lock-fixture";
import {
  readCandidateLockedSeed,
  readPreviousLockedSeed,
} from "./support/us-owner-provenance-reference";

const base = process.env.US_TEST_DATABASE_URL;
type Fixture = Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
type Reader = "previous" | "candidate";
type Isolation = "read committed" | "repeatable read";

type CleanupWriter = {
  query: (statement: string) => Promise<unknown>;
  release: (destroy?: boolean) => void;
};
async function drainOwnedRows(
  releaseReader: () => void,
  pending: Promise<unknown>[],
  writers: CleanupWriter[],
) {
  const failures: unknown[] = [];
  releaseReader();
  const drained = await Promise.allSettled(pending);
  for (const result of drained) if (result.status === "rejected") failures.push(result.reason);
  for (const writer of writers.reverse()) {
    let rollbackFailed = false;
    try {
      await writer.query("ROLLBACK");
    } catch (error) {
      failures.push(error);
      rollbackFailed = true;
    }
    try {
      writer.release(rollbackFailed);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "owned_row_cleanup_failed");
}

describe.skipIf(!base)("US owner provenance procedural lock schedules in an owned database", () => {
  let f: Fixture;
  let tenantId: string;
  let actorId: string;
  const at = new Date("2026-10-02T10:00:00.000Z");

  it("drains each owned cleanup even after one rollback fails", async () => {
    const steps: string[] = [];
    let release: () => void = () => {};
    const pending = [
      new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => {
        steps.push("reader-drained");
      }),
    ];
    const writers: CleanupWriter[] = [
      {
        query: async () => {
          steps.push("second-rollback");
        },
        release: (destroy) => {
          steps.push(`second-release-${destroy ?? false}`);
        },
      },
      {
        query: async () => {
          steps.push("first-rollback");
          throw new Error("synthetic rollback failure");
        },
        release: (destroy) => {
          steps.push(`first-release-${destroy ?? false}`);
        },
      },
    ];
    await expect(
      drainOwnedRows(
        () => {
          steps.push("gate-release");
          release();
        },
        pending,
        writers,
      ),
    ).rejects.toThrow("owned_row_cleanup_failed");
    expect(steps).toEqual([
      "gate-release",
      "reader-drained",
      "first-rollback",
      "first-release-true",
      "second-rollback",
      "second-release-false",
    ]);
  });

  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US test URL");
    f = await createUsProfileTestDatabase(base);
    const identity = (
      await f.pool.query<{ name: string; owner: string }>(
        "SELECT current_database() AS name,current_user AS owner",
      )
    ).rows[0];
    if (
      !identity ||
      !/^markiro_us_profile_[a-f0-9_]+$/.test(identity.name) ||
      identity.owner !== "markiro_us"
    )
      throw new Error("Owned fixture identity invalid");
    console.info("owned owner lock fixture", identity.name);
  }, 60_000);
  afterAll(async () => {
    if (!f) return;
    const name = (await f.pool.query<{ name: string }>("SELECT current_database() AS name")).rows[0]
      ?.name;
    await f.close();
    if (!name || !base) throw new Error("Owned fixture cleanup identity missing");
    const admin = createDb(base);
    try {
      expect(
        (await admin.pool.query("SELECT datname FROM pg_database WHERE datname=$1", [name])).rows,
      ).toEqual([]);
      expect(
        (await admin.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=$1", [name])).rows,
      ).toEqual([]);
      console.info("disposed owner lock fixture", name, "zero active clients");
    } finally {
      await admin.pool.end();
    }
  });
  beforeEach(async () => {
    await f.pool.query('TRUNCATE public.organization, public."user" CASCADE');
    const owner = await new UsDevelopmentOwnerStore(f.db).provision(
      randomUUID() + randomUUID(),
      randomUUID(),
    );
    tenantId = owner.tenantId;
    actorId = owner.userId;
  });

  function owned(t: TestContext) {
    let writer: OwnedClient | undefined;
    let writerOpen = false;
    const readers: { proceed: () => void; release: () => void; running: Promise<unknown> }[] = [];
    const extraWriters: OwnedClient[] = [];
    const extraPending: Promise<unknown>[] = [];
    // Register before acquiring any connection. A timeout releases the writer,
    // wakes readers, and awaits their actual transaction completion.
    t.onTestFinished(async () => {
      const failures: unknown[] = [];
      if (writerOpen) {
        try {
          await writer?.query("ROLLBACK");
        } catch (error) {
          failures.push(error);
        }
      }
      writerOpen = false;
      try {
        writer?.release(failures.length > 0);
      } catch (error) {
        failures.push(error);
      }
      readers.forEach((r) => {
        r.proceed();
        r.release();
      });
      const drained = await Promise.allSettled(readers.map((r) => r.running));
      for (const result of drained) if (result.status === "rejected") failures.push(result.reason);
      const extraDrained = await Promise.allSettled(extraPending);
      for (const result of extraDrained)
        if (result.status === "rejected") failures.push(result.reason);
      for (const extra of extraWriters.reverse()) {
        let rollbackFailed = false;
        try {
          await extra.query("ROLLBACK");
        } catch (error) {
          failures.push(error);
          rollbackFailed = true;
        }
        try {
          extra.release(rollbackFailed);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, "owned_reader_cleanup_failed");
    });
    return {
      async begin() {
        writer = await connectClient(f.pool);
        await writer.query("BEGIN");
        writerOpen = true;
        return writer;
      },
      async commit() {
        await writer?.query("COMMIT");
        writerOpen = false;
      },
      track(client: OwnedClient) {
        extraWriters.push(client);
      },
      trackPending(pending: Promise<unknown>) {
        extraPending.push(pending);
      },
      read(
        kind: Reader,
        isolation: Isolation = "read committed",
        captureNative = false,
        holdAfterRead = false,
      ) {
        let announce: (pid: number) => void = () => {};
        const ready = new Promise<number>((resolve) => {
          announce = resolve;
        });
        let proceed: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          proceed = resolve;
        });
        let release: () => void = () => {};
        const afterRead = new Promise<void>((resolve) => {
          release = resolve;
        });
        let evaluated: (value: unknown) => void = () => {};
        const resultReady = new Promise<unknown>((resolve) => {
          evaluated = resolve;
        });
        let nativeError: unknown;
        const observedPool = new Proxy(f.pool, {
          get(target, key) {
            if (key === "connect")
              return async () => {
                const client = await target.connect();
                return new Proxy(client, {
                  get(connection, field) {
                    if (field === "query")
                      return async (...args: unknown[]) => {
                        try {
                          return await Reflect.apply(connection.query, connection, args);
                        } catch (error) {
                          nativeError = error;
                          throw error;
                        }
                      };
                    const value: unknown = Reflect.get(connection, field, connection);
                    return typeof value === "function" ? value.bind(connection) : value;
                  },
                });
              };
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const db = captureNative ? drizzle(observedPool) : f.db;
        const running = outcome(
          db.transaction(
            async (tx) => {
              const pid = (
                await tx.execute<{ pid: number }>(
                  sql`SELECT pg_catalog.pg_backend_pid()::pg_catalog.int4 AS pid`,
                )
              ).rows[0]?.pid;
              if (pid === undefined) throw Error("Owned reader pid missing");
              announce(pid);
              await gate;
              const result =
                kind === "candidate"
                  ? readCandidateLockedSeed(tx, tenantId, at, actorId)
                  : readPreviousLockedSeed(tx, tenantId, at, actorId);
              const value = await result;
              evaluated(value);
              if (holdAfterRead) await afterRead;
              return value;
            },
            { isolationLevel: isolation },
          ),
        );
        readers.push({ proceed, release, running });
        const settledResult = holdAfterRead
          ? Promise.race([
              resultReady,
              running.then(({ error }) => {
                throw error ?? new Error("reader_finished_before_result");
              }),
            ])
          : resultReady;
        return {
          ready,
          proceed,
          release,
          resultReady: settledResult,
          running,
          nativeError: () => nativeError,
        };
      },
    };
  }

  for (const variant of ["membership", "credential", "audit"] as const) {
    it(`observes a ${variant} duplicate committed while both readers wait on organization`, async (t) => {
      const work = owned(t);
      const writer = await work.begin();
      const blocker = (await writer.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"))
        .rows[0]?.pid;
      if (blocker === undefined) throw Error("Owned blocker pid missing");
      await writer.query("SELECT id FROM public.organization WHERE id=$1 FOR UPDATE", [tenantId]);
      const previous = work.read("previous"),
        candidate = work.read("candidate");
      const [previousPid, candidatePid] = await Promise.all([previous.ready, candidate.ready]);
      previous.proceed();
      candidate.proceed();
      await waitBlocked(f, blocker, previousPid, t.signal);
      await waitBlocked(f, blocker, candidatePid, t.signal);
      if (variant === "membership") {
        await writer.query(
          "INSERT INTO public.member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'member',now())",
          [randomUUID(), tenantId, actorId],
        );
      } else if (variant === "credential") {
        await writer.query(
          "INSERT INTO public.account(id,account_id,provider_id,user_id,password,updated_at) VALUES($1,$2,'credential',$3,'synthetic-local-hash',now())",
          [randomUUID(), actorId, actorId],
        );
      } else {
        await writer.query(
          "INSERT INTO public.tenant_audit_events(organization_id,action,outcome,target_type,target_id,request_id) VALUES($1,'us.development.owner.provisioned','failure','tenant',$1,$2)",
          [tenantId, randomUUID()],
        );
      }
      await work.commit();
      for (const reader of [previous, candidate]) {
        const result = await reader.running;
        expect(result.error).toBeUndefined();
        expect(result.value).toBeNull();
      }
    });
  }

  it("preserves the prior selected user after a concurrent name update", async (t) => {
    const work = owned(t);
    const writer = await work.begin();
    const blocker = (await writer.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"))
      .rows[0]?.pid;
    if (blocker === undefined) throw Error("Owned blocker pid missing");
    await writer.query("UPDATE public.\"user\" SET name='Changed' WHERE id=$1", [actorId]);
    const previous = work.read("previous"),
      candidate = work.read("candidate");
    const [a, b] = await Promise.all([previous.ready, candidate.ready]);
    previous.proceed();
    candidate.proceed();
    await waitBlocked(f, blocker, a, t.signal);
    await waitBlocked(f, blocker, b, t.signal);
    await work.commit();
    for (const reader of [previous, candidate]) {
      const result = await reader.running;
      expect(result.error).toBeUndefined();
      expect(result.value).toBeNull();
    }
  });

  it("rejects a selected membership deleted and replaced while its row lock is awaited", async (t) => {
    const work = owned(t);
    const writer = await work.begin();
    const blocker = (await writer.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"))
      .rows[0]?.pid;
    if (blocker === undefined) throw Error("Owned blocker pid missing");
    await writer.query("DELETE FROM public.member WHERE organization_id=$1 AND user_id=$2", [
      tenantId,
      actorId,
    ]);
    await writer.query(
      "INSERT INTO public.member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())",
      [randomUUID(), tenantId, actorId],
    );
    const previous = work.read("previous"),
      candidate = work.read("candidate");
    const [a, b] = await Promise.all([previous.ready, candidate.ready]);
    previous.proceed();
    candidate.proceed();
    await waitBlocked(f, blocker, a, t.signal);
    await waitBlocked(f, blocker, b, t.signal);
    await work.commit();
    for (const reader of [previous, candidate]) {
      const result = await reader.running;
      expect(result.error).toBeUndefined();
      expect(result.value).toBeNull();
    }
  });

  for (const direction of ["into", "out of"] as const) {
    it(`observes a credential moving ${direction} its later selector after an organization wait`, async (t) => {
      if (direction === "into")
        await f.pool.query("UPDATE public.account SET provider_id='other' WHERE user_id=$1", [
          actorId,
        ]);
      const work = owned(t);
      const writer = await work.begin();
      const blocker = (await writer.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"))
        .rows[0]?.pid;
      if (blocker === undefined) throw Error("Owned blocker pid missing");
      await writer.query("SELECT id FROM public.organization WHERE id=$1 FOR UPDATE", [tenantId]);
      const previous = work.read("previous", "read committed", false, true),
        candidate = work.read("candidate", "read committed", false, true);
      const [a, b] = await Promise.all([previous.ready, candidate.ready]);
      previous.proceed();
      candidate.proceed();
      await waitBlocked(f, blocker, a, t.signal);
      await waitBlocked(f, blocker, b, t.signal);
      await writer.query("UPDATE public.account SET provider_id=$1 WHERE user_id=$2", [
        direction === "into" ? "credential" : "other",
        actorId,
      ]);
      await work.commit();
      for (const reader of [previous, candidate])
        expect((await reader.resultReady) !== null).toBe(direction === "into");
      const probe = await connectClient(f.pool);
      work.track(probe);
      await probe.query("BEGIN");
      const probePid = (await probe.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"))
        .rows[0]?.pid;
      if (probePid === undefined) throw Error("Owned selector probe pid missing");
      const accountId = (
        await f.pool.query<{ id: string }>("SELECT id FROM public.account WHERE user_id=$1", [
          actorId,
        ])
      ).rows[0]?.id;
      if (!accountId) throw Error("Owned selector account missing");
      const probeUpdate = outcome(
        probe.query("UPDATE public.account SET password='changed' WHERE id=$1", [accountId]),
      );
      work.trackPending(probeUpdate);
      if (direction === "into") {
        let first: typeof previous | typeof candidate | undefined;
        while (!first) {
          t.signal.throwIfAborted();
          const observation = await abortable(
            f.pool.query<{ blockers: number[] }>("SELECT pg_blocking_pids($1::int) AS blockers", [
              probePid,
            ]),
            t.signal,
          );
          if (observation.rows[0]?.blockers.includes(a)) first = previous;
          else if (observation.rows[0]?.blockers.includes(b)) first = candidate;
          else await pollInterval(10, undefined, { signal: t.signal });
        }
        const second = first === previous ? candidate : previous;
        const secondPid = first === previous ? b : a;
        console.info("Observed first selected-account blocker", first === previous ? a : b);
        first.release();
        expect((await first.running).error).toBeUndefined();
        await waitBlocked(f, secondPid, probePid, t.signal);
        second.release();
      } else expect((await abortable(probeUpdate, t.signal)).error).toBeUndefined();
      previous.release();
      candidate.release();
      for (const reader of [previous, candidate]) {
        const result = await reader.running;
        expect(result.error).toBeUndefined();
        expect(result.value !== null).toBe(direction === "into");
      }
      expect((await probeUpdate).error).toBeUndefined();
    });
  }

  it("matches the old reader under REPEATABLE READ's earlier snapshot", async (t) => {
    const work = owned(t);
    const writer = await work.begin();
    const blocker = (await writer.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"))
      .rows[0]?.pid;
    if (blocker === undefined) throw Error("Owned blocker pid missing");
    await writer.query("SELECT id FROM public.organization WHERE id=$1 FOR UPDATE", [tenantId]);
    const previous = work.read("previous", "repeatable read"),
      candidate = work.read("candidate", "repeatable read");
    const [a, b] = await Promise.all([previous.ready, candidate.ready]);
    previous.proceed();
    candidate.proceed();
    await waitBlocked(f, blocker, a, t.signal);
    await waitBlocked(f, blocker, b, t.signal);
    await writer.query(
      "INSERT INTO public.account(id,account_id,provider_id,user_id,password,updated_at) VALUES($1,$2,'credential',$2,'synthetic-local-hash',now())",
      [randomUUID(), actorId],
    );
    await work.commit();
    const prior = await previous.running,
      current = await candidate.running;
    expect(prior.error).toBeUndefined();
    expect(current.error).toBeUndefined();
    expect(current.value).toEqual(prior.value);
    expect(current.value).toMatchObject({ seedId: tenantId });
  });

  for (const changed of ["updated", "deleted"] as const) {
    it(`preserves each execution's native 40001 cause after a selected organization is ${changed} under REPEATABLE READ`, async (t) => {
      const work = owned(t);
      const previous = work.read("previous", "repeatable read", true);
      const candidate = work.read("candidate", "repeatable read", true);
      const [previousPid, candidatePid] = await Promise.all([previous.ready, candidate.ready]);
      const writer = await work.begin();
      const blocker = (await writer.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"))
        .rows[0]?.pid;
      if (blocker === undefined) throw Error("Owned blocker pid missing");
      await writer.query(
        changed === "updated"
          ? "UPDATE public.organization SET name='Changed' WHERE id=$1"
          : "DELETE FROM public.organization WHERE id=$1",
        [tenantId],
      );
      previous.proceed();
      candidate.proceed();
      await waitBlocked(f, blocker, previousPid, t.signal);
      await waitBlocked(f, blocker, candidatePid, t.signal);
      await work.commit();
      for (const reader of [previous, candidate]) {
        const result = await reader.running;
        const native = reader.nativeError();
        expect(native).toMatchObject({ code: "40001" });
        expect(result.error).toMatchObject({ cause: expect.objectContaining({ code: "40001" }) });
        expect((result.error as Error & { cause?: unknown }).cause).toBe(native);
        expect(result.value).toBeUndefined();
      }
    });
  }

  it("returns upstream denial while a later account table holds ACCESS EXCLUSIVE", async (t) => {
    const work = owned(t);
    const writer = await work.begin();
    await writer.query("LOCK TABLE public.account IN ACCESS EXCLUSIVE MODE");
    await f.pool.query("UPDATE public.organization SET name='Changed' WHERE id=$1", [tenantId]);
    for (const kind of ["previous", "candidate"] as const) {
      const reader = work.read(kind);
      await reader.ready;
      reader.proceed();
      const result = await reader.running;
      expect(result.error).toBeUndefined();
      expect(result.value).toBeNull();
    }
    await work.commit();
  });

  for (const stage of ["organization", "user"] as const) {
    it(`retains the ${stage} share lock until transaction exit`, async (t) => {
      let releaseReader: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseReader = resolve;
      });
      const writers: OwnedClient[] = [];
      const pending: Promise<unknown>[] = [];
      t.onTestFinished(() => drainOwnedRows(releaseReader, pending, writers));
      let announce: (pid: number) => void = () => {};
      const ready = new Promise<number>((resolve) => {
        announce = resolve;
      });
      const reader = outcome(
        f.db.transaction(async (tx) => {
          const pid = (
            await tx.execute<{ pid: number }>(
              sql`SELECT pg_catalog.pg_backend_pid()::pg_catalog.int4 AS pid`,
            )
          ).rows[0]?.pid;
          if (pid === undefined) throw Error("Owned reader pid missing");
          expect(await readCandidateLockedSeed(tx, tenantId, at, actorId)).toMatchObject({
            seedId: tenantId,
          });
          announce(pid);
          await gate;
        }),
      );
      pending.push(reader);
      const readerPid = await ready;
      const writer = await connectClient(f.pool);
      writers.push(writer);
      await writer.query("BEGIN");
      const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"))
        .rows[0]?.pid;
      if (writerPid === undefined) throw Error("Owned writer pid missing");
      const update = outcome(
        writer.query(
          stage === "organization"
            ? "UPDATE public.organization SET name='Changed' WHERE id=$1"
            : "UPDATE public.\"user\" SET name='Changed' WHERE id=$1",
          [stage === "organization" ? tenantId : actorId],
        ),
      );
      pending.push(update);
      await waitBlocked(f, readerPid, writerPid, t.signal);
      releaseReader();
      expect((await reader).error).toBeUndefined();
      expect((await update).error).toBeUndefined();
    });
  }

  for (const kind of ["previous", "candidate"] as const) {
    it(`retains pre-savepoint locks and releases later ${kind} locks on rollback to savepoint`, async (t) => {
      let releaseReader: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseReader = resolve;
      });
      const writers: OwnedClient[] = [];
      const pending: Promise<unknown>[] = [];
      t.onTestFinished(() => drainOwnedRows(releaseReader, pending, writers));
      let announce: (pid: number) => void = () => {};
      const ready = new Promise<number>((resolve) => {
        announce = resolve;
      });
      const reader = outcome(
        f.db.transaction(async (tx) => {
          const pid = (
            await tx.execute<{ pid: number }>(
              sql`SELECT pg_catalog.pg_backend_pid()::pg_catalog.int4 AS pid`,
            )
          ).rows[0]?.pid;
          if (pid === undefined) throw Error("Owned reader pid missing");
          await tx.execute(sql`SELECT id FROM public.organization WHERE id=${tenantId} FOR SHARE`);
          await tx.execute(sql`SAVEPOINT owner_proof_boundary`);
          const result =
            kind === "previous"
              ? await readPreviousLockedSeed(tx, tenantId, at, actorId)
              : await readCandidateLockedSeed(tx, tenantId, at, actorId);
          expect(result).toMatchObject({ seedId: tenantId });
          await tx.execute(sql`ROLLBACK TO SAVEPOINT owner_proof_boundary`);
          announce(pid);
          await gate;
        }),
      );
      pending.push(reader);
      const readerPid = await ready;
      const orgWriter = await connectClient(f.pool);
      writers.push(orgWriter);
      await orgWriter.query("BEGIN");
      const orgPid = (await orgWriter.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"))
        .rows[0]?.pid;
      if (orgPid === undefined) throw Error("Owned organization writer pid missing");
      const orgUpdate = outcome(
        orgWriter.query("UPDATE public.organization SET name='Changed' WHERE id=$1", [tenantId]),
      );
      pending.push(orgUpdate);
      await waitBlocked(f, readerPid, orgPid, t.signal);
      const accountWriter = await connectClient(f.pool);
      writers.push(accountWriter);
      await accountWriter.query("BEGIN");
      const accountUpdate = outcome(
        accountWriter.query("UPDATE public.account SET password='changed' WHERE user_id=$1", [
          actorId,
        ]),
      );
      pending.push(accountUpdate);
      const accountResult = await abortable(accountUpdate, t.signal);
      expect(accountResult.error).toBeUndefined();
      releaseReader();
      expect((await reader).error).toBeUndefined();
      expect((await orgUpdate).error).toBeUndefined();
    });
  }

  it("keeps share locks on every duplicate membership through transaction exit", async (t) => {
    let releaseReader: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    const writers: OwnedClient[] = [];
    const pending: Promise<unknown>[] = [];
    t.onTestFinished(() => drainOwnedRows(releaseReader, pending, writers));
    const secondId = randomUUID();
    await f.pool.query(
      "INSERT INTO public.member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'member',now())",
      [secondId, tenantId, actorId],
    );
    const ids = (
      await f.pool.query<{ id: string }>(
        "SELECT id FROM public.member WHERE organization_id=$1 ORDER BY id",
        [tenantId],
      )
    ).rows.map((r) => r.id);
    expect(ids).toHaveLength(2);
    let announce: (value: { pid: number; result: unknown }) => void = () => {};
    const evaluated = new Promise<{ pid: number; result: unknown }>((resolve) => {
      announce = resolve;
    });
    const reader = outcome(
      f.db.transaction(async (tx) => {
        const pid = (
          await tx.execute<{ pid: number }>(
            sql`SELECT pg_catalog.pg_backend_pid()::pg_catalog.int4 AS pid`,
          )
        ).rows[0]?.pid;
        if (pid === undefined) throw Error("Owned reader pid missing");
        const result = await readCandidateLockedSeed(tx, tenantId, at, actorId);
        announce({ pid, result });
        await gate;
        return result;
      }),
    );
    pending.push(reader);
    const { pid, result } = await evaluated;
    expect(result).toBeNull();
    for (const id of ids) {
      const writer = await connectClient(f.pool);
      writers.push(writer);
      await writer.query("BEGIN");
      const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"))
        .rows[0]?.pid;
      if (writerPid === undefined) throw Error("Owned writer pid missing");
      const update = outcome(
        writer.query("UPDATE public.member SET role='member' WHERE id=$1", [id]),
      );
      pending.push(update);
      await waitBlocked(f, pid, writerPid, t.signal);
    }
    releaseReader();
    expect((await reader).error).toBeUndefined();
    await Promise.all(pending);
  });

  for (const variant of ["credential", "audit"] as const) {
    it(`keeps share locks on both ${variant} rows even when one is invalid`, async (t) => {
      let releaseReader: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseReader = resolve;
      });
      const writers: OwnedClient[] = [];
      const pending: Promise<unknown>[] = [];
      t.onTestFinished(() => drainOwnedRows(releaseReader, pending, writers));
      const extraId = randomUUID();
      if (variant === "credential") {
        await f.pool.query(
          "INSERT INTO public.account(id,account_id,provider_id,user_id,password,updated_at) VALUES($1,'wrong','credential',$2,'',now())",
          [extraId, actorId],
        );
      } else {
        await f.pool.query(
          "INSERT INTO public.tenant_audit_events(id,organization_id,action,outcome,target_type,target_id,request_id) VALUES($1,$2,'us.development.owner.provisioned','failure','tenant',$2,$3)",
          [extraId, tenantId, randomUUID()],
        );
      }
      const table = variant === "credential" ? "account" : "tenant_audit_events";
      const ids = (
        await f.pool.query<{ id: string }>(
          `SELECT id FROM public.${table} WHERE ${variant === "credential" ? "user_id" : "organization_id"}=$1 ORDER BY id`,
          [variant === "credential" ? actorId : tenantId],
        )
      ).rows.map((r) => r.id);
      expect(ids).toHaveLength(2);
      let announce: (value: { pid: number; result: unknown }) => void = () => {};
      const evaluated = new Promise<{ pid: number; result: unknown }>((resolve) => {
        announce = resolve;
      });
      const reader = outcome(
        f.db.transaction(async (tx) => {
          const pid = (
            await tx.execute<{ pid: number }>(
              sql`SELECT pg_catalog.pg_backend_pid()::pg_catalog.int4 AS pid`,
            )
          ).rows[0]?.pid;
          if (pid === undefined) throw Error("Owned reader pid missing");
          const result = await readCandidateLockedSeed(tx, tenantId, at, actorId);
          announce({ pid, result });
          await gate;
          return result;
        }),
      );
      pending.push(reader);
      const { pid, result } = await evaluated;
      expect(result).toBeNull();
      for (const id of ids) {
        const writer = await connectClient(f.pool);
        writers.push(writer);
        await writer.query("BEGIN");
        const writerPid = (
          await writer.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid")
        ).rows[0]?.pid;
        if (writerPid === undefined) throw Error("Owned writer pid missing");
        const update = outcome(
          writer.query(
            variant === "credential"
              ? "UPDATE public.account SET password='changed' WHERE id=$1"
              : "UPDATE public.tenant_audit_events SET outcome='changed' WHERE id=$1",
            [id],
          ),
        );
        pending.push(update);
        await waitBlocked(f, pid, writerPid, t.signal);
      }
      releaseReader();
      expect((await reader).error).toBeUndefined();
      await Promise.all(pending);
    });
  }

  for (const rejectedAt of ["user", "membership", "credential"] as const) {
    it(`does not reach audit table ACCESS EXCLUSIVE after ${rejectedAt} denial`, async (t) => {
      if (rejectedAt === "user")
        await f.pool.query("UPDATE public.\"user\" SET name='Changed' WHERE id=$1", [actorId]);
      if (rejectedAt === "membership")
        await f.pool.query("UPDATE public.member SET role='member' WHERE organization_id=$1", [
          tenantId,
        ]);
      if (rejectedAt === "credential")
        await f.pool.query("UPDATE public.account SET password='' WHERE user_id=$1", [actorId]);
      const work = owned(t);
      const writer = await work.begin();
      await writer.query("LOCK TABLE public.tenant_audit_events IN ACCESS EXCLUSIVE MODE");
      for (const kind of ["previous", "candidate"] as const) {
        const reader = work.read(kind);
        await reader.ready;
        reader.proceed();
        const result = await reader.running;
        expect(result.error).toBeUndefined();
        expect(result.value).toBeNull();
      }
      await work.commit();
    });
  }

  it("ignores unreachable missing account on cold and one pinned warm backend, but propagates its executed error", async (t) => {
    if (!base) throw Error("Missing isolated US test URL");
    const work = owned(t);
    const warm = await connectClient(f.pool);
    let warmRunning: Promise<unknown> | undefined;
    t.onTestFinished(async () => {
      try {
        if (warmRunning) await warmRunning;
      } finally {
        warm.release();
      }
    });
    let emittedNativeError: unknown;
    const observedWarm = new Proxy(warm, {
      get(connection, field) {
        if (field === "query")
          return async (...args: unknown[]) => {
            try {
              return await Reflect.apply(connection.query, connection, args);
            } catch (error) {
              emittedNativeError = error;
              throw error;
            }
          };
        const value: unknown = Reflect.get(connection, field, connection);
        return typeof value === "function" ? value.bind(connection) : value;
      },
    });
    const warmDb = drizzle(observedWarm);
    const warmPid = (await warm.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid"))
      .rows[0]?.pid;
    if (warmPid === undefined) throw Error("Pinned warm backend pid missing");
    const warmCall = () => {
      emittedNativeError = undefined;
      const running = warmDb.transaction(async (tx) => {
        const pid = (
          await tx.execute<{ pid: number }>(
            sql`SELECT pg_catalog.pg_backend_pid()::pg_catalog.int4 AS pid`,
          )
        ).rows[0]?.pid;
        expect(pid).toBe(warmPid);
        return readCandidateLockedSeed(tx, tenantId, at, actorId);
      });
      warmRunning = outcome(running);
      return running;
    };
    // Every warm call commits before the later relation is locked or altered.
    for (let i = 0; i < 3; i++) expect(await warmCall()).toMatchObject({ seedId: tenantId });
    await f.pool.query("UPDATE public.organization SET name='Changed' WHERE id=$1", [tenantId]);
    const blocker = await work.begin();
    await blocker.query("LOCK TABLE public.account IN ACCESS EXCLUSIVE MODE");
    expect(await warmCall()).toBeNull();
    await work.commit();
    await f.pool.query("DROP TABLE public.account CASCADE");
    expect(await warmCall()).toBeNull();
    const name = (await f.pool.query<{ name: string }>("SELECT current_database() AS name")).rows[0]
      ?.name;
    if (!name || !/^markiro_us_profile_[a-f0-9_]+$/.test(name))
      throw Error("Owned DB name invalid");
    const url = new URL(base);
    url.pathname = `/${name}`;
    const cold = createDb(url.toString());
    try {
      expect(
        await cold.db.transaction((tx) => readCandidateLockedSeed(tx, tenantId, at, actorId)),
      ).toBeNull();
    } finally {
      await cold.pool.end();
    }
    await f.pool.query(
      "UPDATE public.organization SET name='Synthetic US development' WHERE id=$1",
      [tenantId],
    );
    let failure: unknown;
    try {
      await warmCall();
    } catch (error) {
      failure = error;
    }
    expect(emittedNativeError).toMatchObject({ code: "42P01" });
    expect(failure).toMatchObject({ cause: expect.objectContaining({ code: "42P01" }) });
    if (!(failure instanceof Error)) throw new Error("executed relation failure missing");
    expect(failure.cause).toBe(emittedNativeError);
  });
});
