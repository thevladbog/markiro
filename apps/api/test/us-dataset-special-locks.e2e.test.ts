import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetSpecialSeedStore } from "../src/modules/traceability/demo/us-dataset-special-seed";
import { verifyUsDatasetSpecial } from "../src/modules/traceability/demo/us-dataset-special-verify";
import type { UsDatasetSpecialKind } from "../src/modules/traceability/demo/us-dataset-special-contract";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import { specialFixture, specialStores } from "./support/us-dataset-special-fixture";
import {
  abortable,
  barrier,
  outcome,
  waitBlocked,
  type OwnedClient,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Special Receiving transaction locks", { timeout: 30_000 }, () => {
  const h = specialFixture(base);
  async function prepare(state: "initial" | "corrected" | "void") {
    const kind: UsDatasetSpecialKind = state === "void" ? "orphan" : "correction";
    await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
    const seed = new UsDatasetSpecialSeedStore(h.f.db);
    const result =
      state === "initial"
        ? await seed.initializeReceiving(h.context, kind)
        : await seed.initialize(h.context, kind);
    const stores = specialStores(h.f.db);
    const header = await stores.journal.read(h.context);
    if (!header) throw new Error("Missing header");
    const stage = await stores.journal.readStage(
      h.context,
      header.id,
      kind === "correction" ? "correction_0001" : "orphan_0001",
      result.stage,
    );
    if (!stage?.receipt) throw new Error("Missing stage");
    return { kind, result, stores, header, stage };
  }
  function connections() {
    if (!base) throw new Error("Missing fixture base");
    const url = new URL(base);
    url.pathname = "/" + h.f.databaseName;
    const options = { max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10_000 };
    return {
      verifier: createDb(url.toString(), options),
      writer: createDb(url.toString(), options),
      observer: createDb(url.toString(), options),
    };
  }
  async function end(c: ReturnType<typeof connections>) {
    const settled = await Promise.allSettled(
      Object.values(c).map((connection) => connection.pool.end()),
    );
    const failures = settled.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Owned pools failed to close",
      );
  }
  async function pids(c: ReturnType<typeof connections>) {
    const verifier = (await c.verifier.pool.query<{ pid: number }>("SELECT pg_backend_pid() pid"))
      .rows[0]?.pid;
    const writer = (await c.writer.pool.query<{ pid: number }>("SELECT pg_backend_pid() pid"))
      .rows[0]?.pid;
    if (!verifier || !writer || verifier === writer)
      throw new Error("Missing distinct backend identities");
    return { verifier, writer };
  }
  function publicWrite(
    prepared: Awaited<ReturnType<typeof prepare>>,
    c: ReturnType<typeof connections>,
  ) {
    const result = prepared.result;
    if (result.stage === "void_receiving") {
      const lot = result.lots[0];
      if (!lot) throw new Error("Missing lot");
      return () =>
        new UsLotStore(c.writer.db).changeStatus(
          h.context.tenantId,
          h.context.actorUserId,
          lot.id,
          {
            status: "archived",
            expectedRevision: lot.revision,
            reason: "Synthetic public archive",
          },
          randomUUID(),
        );
    }
    const record = result.finalized.record;
    return () =>
      new UsReceivingStore(c.writer.db).amend(
        h.context.tenantId,
        h.context.actorUserId,
        record.id,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: record.lifecycle.lifecycleVersion,
          reason: "Synthetic competing public amendment",
        },
        randomUUID(),
      );
  }
  async function verify(
    prepared: Awaited<ReturnType<typeof prepare>>,
    connection: ReturnType<typeof createDb>,
    held?: ReturnType<typeof barrier>,
    release?: ReturnType<typeof barrier>,
  ) {
    const stores = specialStores(connection.db);
    return stores.journal.runAtomicStage(
      h.context,
      prepared.header.id,
      prepared.stage.revision,
      prepared.stage.intent,
      {
        apply: async () => {
          throw new Error("Unexpected replay writer");
        },
        verify: async (tx, context, intent, receipt) => {
          await verifyUsDatasetSpecial(tx, context, intent, receipt, stores);
          held?.release();
          await release?.promise;
        },
      },
    );
  }
  it.for(["initial", "corrected", "void"] as const)(
    "holds actual %s public writer until verification commit",
    h.phase(async (state, test) => {
      const prepared = await prepare(state);
      const c = connections();
      const held = barrier(),
        release = barrier();
      let verifying: ReturnType<typeof outcome> | undefined,
        writing: ReturnType<typeof outcome> | undefined;
      try {
        const pid = await pids(c);
        verifying = outcome(verify(prepared, c.verifier, held, release));
        await abortable(
          Promise.race([
            held.promise,
            verifying.then((r) => {
              if (r.error) throw r.error;
            }),
          ]),
          test.signal,
        );
        writing = outcome<unknown>(publicWrite(prepared, c)());
        await waitBlocked(c.observer, pid.verifier, pid.writer, test.signal);
        release.release();
        expect((await verifying).error).toBeUndefined();
        expect((await writing).error).toBeUndefined();
        const before = await h.f.snapshot();
        await expect(
          new UsDatasetSpecialSeedStore(h.f.db).verifyReceiving(h.context, prepared.kind),
        ).rejects.toThrow("us_dataset_special_mismatch");
        expect(await h.f.snapshot()).toEqual(before);
      } finally {
        release.release();
        try {
          await Promise.allSettled([verifying, writing]);
        } finally {
          await end(c);
        }
      }
    }),
  );
  it.for(["initial", "corrected", "void"] as const)(
    "queues behind actual %s public mutation and rejects committed drift",
    h.phase(async (state, test) => {
      const prepared = await prepare(state);
      const c = connections();
      let gate: OwnedClient | undefined;
      let writing: ReturnType<typeof outcome> | undefined,
        verifying: ReturnType<typeof outcome> | undefined;
      try {
        const pid = await pids(c);
        gate = await c.observer.pool.connect();
        const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0]
          ?.pid;
        if (!gatePid) throw new Error("Missing gate identity");
        const result = prepared.result;
        const table = state === "void" ? "traceability_lots" : "receiving_event_roots";
        const id =
          state === "void"
            ? result.lots[0]?.id
            : result.stage === "receiving"
              ? result.created.eventId
              : result.original.created.eventId;
        await gate.query("BEGIN");
        await gate.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [
          h.context.tenantId,
          id,
        ]);
        writing = outcome<unknown>(publicWrite(prepared, c)());
        // Observe each actual lock queue edge, using the already-acquired gate client.
        const observe = async (blocker: number, blocked: number) => {
          const deadline = AbortSignal.any([test.signal, AbortSignal.timeout(5000)]);
          for (;;) {
            deadline.throwIfAborted();
            if (
              (
                await gate?.query<{ blocked: boolean }>(
                  "SELECT $1::int=ANY(pg_blocking_pids($2::int)) blocked",
                  [blocker, blocked],
                )
              )?.rows[0]?.blocked
            )
              return;
            await abortable(new Promise<void>((resolve) => setTimeout(resolve, 10)), deadline);
          }
        };
        await observe(gatePid, pid.writer);
        verifying = outcome(verify(prepared, c.verifier));
        await observe(pid.writer, pid.verifier);
        await gate.query("COMMIT");
        expect((await writing).error).toBeUndefined();
        expect((await verifying).error).toMatchObject({ message: "us_dataset_special_mismatch" });
      } finally {
        try {
          if (gate)
            try {
              await gate.query("ROLLBACK");
            } finally {
              gate.release(true);
            }
        } finally {
          try {
            await Promise.allSettled([writing, verifying]);
          } finally {
            await end(c);
          }
        }
      }
    }),
  );
  it.for(["correction", "orphan"] as const)(
    "concurrent %s full initializations have one canonical winner",
    h.phase(async (kind, test) => {
      await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      const arrivals = barrier(),
        release = barrier();
      let count = 0;
      const actual = UsDatasetJournalStore.prototype.captureIntent;
      const spy = vi
        .spyOn(UsDatasetJournalStore.prototype, "captureIntent")
        .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
          if (args[2].stage === "receiving") {
            count++;
            if (count === 2) arrivals.release();
            await release.promise;
          }
          return actual.apply(this, args);
        });
      let a: ReturnType<typeof outcome> | undefined, b: ReturnType<typeof outcome> | undefined;
      try {
        a = outcome(new UsDatasetSpecialSeedStore(h.f.db).initialize(h.context, kind));
        b = outcome(new UsDatasetSpecialSeedStore(h.f.db).initialize(h.context, kind));
        await abortable(
          Promise.race([
            arrivals.promise,
            a.then((r) => {
              if (r.error) throw r.error;
            }),
            b.then((r) => {
              if (r.error) throw r.error;
            }),
          ]),
          test.signal,
        );
        release.release();
        const results = await Promise.all([a, b]);
        expect(count).toBe(2);
        expect(results.map((r) => r.error)).toEqual([undefined, undefined]);
        expect(results[0]?.value).toEqual(results[1]?.value);
        expect(
          (
            await h.f.pool.query(
              "SELECT (SELECT count(*)::int FROM receiving_event_roots) roots,(SELECT count(*)::int FROM traceability_events) revisions,(SELECT count(*)::int FROM traceability_lots) lots,(SELECT count(*)::int FROM reference_documents) docs,(SELECT count(*)::int FROM receiving_operations) operations",
            )
          ).rows,
        ).toEqual([
          {
            roots: 1,
            revisions: kind === "correction" ? 2 : 1,
            lots: 2,
            docs: 2,
            operations: kind === "correction" ? 5 : 3,
          },
        ]);
        const before = await h.f.snapshot();
        expect(await new UsDatasetSpecialSeedStore(h.f.db).verify(h.context, kind)).toEqual(
          results[0]?.value,
        );
        expect(await h.f.snapshot()).toEqual(before);
      } finally {
        release.release();
        try {
          await Promise.allSettled([a, b]);
        } finally {
          spy.mockRestore();
        }
      }
    }),
  );
});
