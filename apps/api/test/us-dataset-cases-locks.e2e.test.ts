import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import { composeDatasetCases } from "./support/us-dataset-cases-fixture";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";
import { parseUsDatasetTransformationResult } from "../src/modules/traceability/demo/us-dataset-transformation-contract";
import { parseUsDatasetReceivingResult } from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { parseUsDatasetReferenceResult } from "../src/modules/traceability/demo/us-dataset-reference-contract";
import { verifyUsDatasetCases } from "../src/modules/traceability/demo/us-dataset-cases-verify";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { lockCaseOperation } from "../src/modules/traceability/cases/us-case-operations";
import {
  abortable,
  barrier,
  outcome,
  startObservation,
  waitBlocked,
  withOwnedWork,
  ownClient,
  type OwnCleanup,
  type CleanupEvidence,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Dataset Cases current verifier locks", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing US fixture");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  type Kind =
    | "link"
    | "same-key link"
    | "unlink"
    | "void"
    | "amend"
    | "finalize amendment"
    | "lot"
    | "source"
    | "product"
    | "document";
  function connections(own: OwnCleanup) {
    if (!base) throw new Error("Missing US fixture");
    const url = new URL(base);
    url.pathname = "/" + f.databaseName;
    const take = (name: string) => {
      const c = createDb(url.toString(), {
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 8000,
      });
      own("pool-" + name, () => c.pool.end());
      return c;
    };
    return { replay: take("replay"), writer: take("writer"), gate: take("gate") };
  }
  async function pid(c: ReturnType<typeof createDb>) {
    const n = (await c.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    if (!n) throw new Error("Missing owned PID");
    return n;
  }
  async function schedule(
    kind: Kind,
    order: "verifier first" | "writer first",
    signal: AbortSignal,
    ready: () => Promise<void>,
    reportPids: (pids: number[]) => void = () => {},
  ) {
    const context = await f.provision(),
      c = await composeDatasetCases(f, context, 0);
    const t = await c.stores.journal.readStage(
        context,
        c.datasetId,
        c.intent.unitKey,
        "transformation",
      ),
      r = await c.stores.journal.readStage(context, c.datasetId, c.intent.unitKey, "receiving"),
      refs = await c.stores.journal.readStage(context, c.datasetId, "references", "references");
    if (!t?.receipt || !r?.receipt || !refs?.receipt) throw new Error("Missing prerequisite");
    const transformation = parseUsDatasetTransformationResult(t.receipt.result),
      receiving = parseUsDatasetReceivingResult(r.receipt.result),
      references = parseUsDatasetReferenceResult(refs.receipt.result);
    let amendment: { eventId: string; digest: string } | undefined;
    if (kind === "finalize amendment") {
      // Amendment start is a separate sequential public command, explicitly not
      // presented as the contested finalization. Pending state must be rejected.
      const changed = await c.stores.transformation.amend(
        context.tenantId,
        context.actorUserId,
        transformation.created.id,
        {
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          reason: "Synthetic pending amendment",
        },
        "start-amendment",
      );
      const checked = await c.stores.transformation.checkReadiness(
        context.tenantId,
        context.actorUserId,
        changed.eventId,
        { expectedDraftVersion: 1 },
      );
      expect(checked.state).toBe("complete");
      amendment = { eventId: changed.eventId, digest: checked.inputDigest };
    }
    signal.throwIfAborted();
    await withOwnedWork(async (own) => {
      const pools = connections(own),
        replayPid = await pid(pools.replay),
        writerPid = await pid(pools.writer),
        gatePid = await pid(pools.gate);
      reportPids([replayPid, writerPid, gatePid]);
      const acquired = barrier(),
        release = barrier();
      const workers: { replay?: ReturnType<typeof outcome>; writer?: ReturnType<typeof outcome> } =
        {};
      const verify = () =>
        pools.replay.db.transaction(async (tx) => {
          const result = await outcome(
            verifyUsDatasetCases(
              tx,
              context,
              c.intent,
              c.receipt,
              "replay",
              datasetTransformationStores(pools.replay.db),
            ),
          );
          if (kind === "finalize amendment")
            expect(result.error).toMatchObject({ message: "us_dataset_cases_mismatch" });
          else if (result.error) throw result.error;
          acquired.release();
          if (order === "verifier first") await release.promise;
        });
      const write = async (): Promise<unknown> => {
        const stores = datasetTransformationStores(pools.writer.db),
          cases = new UsCaseStore(pools.writer.db),
          args = {
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            reason: "Synthetic competing writer",
          },
          first = c.result.linked.created[0];
        if (!first) throw new Error("Missing case");
        if (kind === "link" || kind === "same-key link")
          return cases.link(
            context.tenantId,
            context.actorUserId,
            c.input.outputLotId,
            {
              operationKey: kind === "same-key link" ? c.intent.operationKey : args.operationKey,
              ssccs: [first.ssccAtLink],
            },
            "public-link",
          );
        if (kind === "unlink")
          return cases.unlink(
            context.tenantId,
            context.actorUserId,
            c.input.outputLotId,
            first.linkId,
            { operationKey: args.operationKey, reason: args.reason },
            "public-unlink",
          );
        if (kind === "void" || kind === "amend")
          return stores.transformation[kind](
            context.tenantId,
            context.actorUserId,
            transformation.created.id,
            args,
            "public-lifecycle",
          );
        if (kind === "finalize amendment") {
          if (!amendment) throw new Error("Missing amendment");
          return stores.transformation.finalize(
            context.tenantId,
            context.actorUserId,
            amendment.eventId,
            {
              operationKey: args.operationKey,
              expectedDraftVersion: 1,
              expectedInputDigest: amendment.digest,
            },
            "public-finalize",
          );
        }
        if (kind === "lot")
          return stores.lots.changeStatus(
            context.tenantId,
            context.actorUserId,
            c.input.outputLotId,
            { status: "archived", expectedRevision: 1, reason: args.reason },
            "public-lot",
          );
        if (kind === "source")
          return stores.lots.changeSource(
            context.tenantId,
            context.actorUserId,
            c.input.outputLotId,
            { source: transformation.outputLot.source, expectedRevision: 1, reason: args.reason },
            "public-source",
          );
        if (kind === "product")
          return stores.catalog.updateProduct(
            context.tenantId,
            context.actorUserId,
            c.input.outputProductId,
            { name: "Changed synthetic catalogue" },
            "public-product",
          );
        // Documents have no public edit API. This is labelled constrained SQL drift.
        return pools.writer.pool.query(
          "UPDATE reference_documents SET notes='Changed synthetic document' WHERE tenant_id=$1 AND id=$2",
          [context.tenantId, transformation.documents[0]?.record.id],
        );
      };
      if (order === "verifier first") {
        own("release-before-actual-drain", async () => {
          release.release();
          await Promise.all([workers.replay, workers.writer]);
        });
        workers.replay = outcome(verify());
        await abortable(
          Promise.race([
            acquired.promise,
            workers.replay.then(({ error }) => {
              throw error ?? new Error("Verifier ended before barrier");
            }),
          ]),
          signal,
        );
        workers.writer = outcome(Promise.resolve().then(write));
        await waitBlocked(f, replayPid, writerPid, signal);
        await abortable(ready(), signal);
        release.release();
        expect((await workers.replay).error).toBeUndefined();
      } else {
        const lifecycle = kind === "void" || kind === "amend" || kind === "finalize amendment";
        if (lifecycle) {
          own("workers-drain", async () => {
            await Promise.all([workers.writer, workers.replay]);
          });
          const gate = await pools.gate.pool.connect();
          ownClient(own, gate, "root-gate-release", () => gate.query("ROLLBACK"));
          await gate.query("BEGIN");
          await gate.query(
            "SELECT id FROM traceability_events WHERE tenant_id=$1 AND id=$2 FOR SHARE",
            [context.tenantId, amendment?.eventId ?? transformation.created.id],
          );
          workers.writer = outcome(Promise.resolve().then(write));
          await waitBlocked(f, gatePid, writerPid, signal);
          workers.replay = outcome(verify());
          await waitBlocked(f, writerPid, replayPid, signal);
          await withOwnedWork(async (ownProbe) => {
            const probe = await f.pool.connect();
            ownClient(ownProbe, probe, "probe-rollback", () => probe.query("ROLLBACK"));
            await probe.query("BEGIN");
            const lots = await probe.query(
              "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE NOWAIT",
              [context.tenantId, [...receiving.lots.map((lot) => lot.id), c.input.outputLotId]],
            );
            expect(lots.rowCount).toBe(3);
          });
          await abortable(ready(), signal);
          await gate.query("ROLLBACK");
        } else if (kind === "source" || kind === "same-key link") {
          // These commands deny without a write. Queue the actual public attempt
          // ahead of verification at its real lot/operation lock, then release.
          own("queued-workers-drain", async () => {
            await Promise.all([workers.writer, workers.replay]);
          });
          const gate = await pools.gate.pool.connect();
          ownClient(own, gate, "queued-command-gate-release", () => gate.query("ROLLBACK"));
          await gate.query("BEGIN");
          if (kind === "source")
            await gate.query(
              "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
              [context.tenantId, c.input.outputLotId],
            );
          else
            await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              JSON.stringify(["us-case", context.tenantId, "case.link", c.intent.operationKey]),
            ]);
          workers.writer = outcome(Promise.resolve().then(write));
          await waitBlocked(f, gatePid, writerPid, signal);
          workers.replay = outcome(verify());
          await waitBlocked(f, writerPid, replayPid, signal);
          await abortable(ready(), signal);
          await gate.query("ROLLBACK");
        } else {
          const table =
            kind === "product"
              ? "products"
              : kind === "document"
                ? "reference_documents"
                : kind === "link"
                  ? "tenant_audit_events"
                  : "traceability_lots";
          const id =
            kind === "product"
              ? c.input.outputProductId
              : kind === "document"
                ? transformation.documents[0]?.record.id
                : c.input.outputLotId;
          const name = "cases_gate_" + randomUUID().replaceAll("-", ""),
            key = Math.floor(Math.random() * 1000000000) + 1;
          own("drop-function", async () => {
            await f.pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
          });
          own("drop-trigger", async () => {
            await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
          });
          own("workers-drain", async () => {
            await Promise.all([workers.writer, workers.replay]);
          });
          const gate = await pools.gate.pool.connect();
          ownClient(own, gate, "writer-gate-release", () =>
            gate.query("SELECT pg_advisory_unlock($1)", [key]),
          );
          await gate.query("SELECT pg_advisory_lock($1)", [key]);
          await f.pool.query(
            `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`,
          );
          const condition =
            kind === "link"
              ? `NEW.organization_id='${context.tenantId}' AND NEW.action='case.link' AND NEW.request_id='public-link'`
              : `NEW.tenant_id='${context.tenantId}' AND NEW.id='${id}'::uuid`;
          await f.pool.query(
            `CREATE TRIGGER ${name} BEFORE ${kind === "link" ? "INSERT" : "UPDATE"} ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION ${name}()`,
          );
          workers.writer = outcome(Promise.resolve().then(write));
          await waitBlocked(f, gatePid, writerPid, signal);
          workers.replay = outcome(verify());
          await waitBlocked(f, writerPid, replayPid, signal);
          await abortable(ready(), signal);
          await gate.query("SELECT pg_advisory_unlock($1)", [key]);
        }
        if (
          kind === "link" ||
          kind === "finalize amendment" ||
          kind === "source" ||
          kind === "same-key link"
        )
          expect((await workers.replay).error).toBeUndefined();
        else
          expect((await workers.replay).error).toMatchObject({
            message: "us_dataset_cases_mismatch",
          });
      }
      const writer = await workers.writer;
      if (kind === "same-key link")
        expect(writer?.error).toMatchObject({ response: { code: "case_operation_conflict" } });
      else if (kind === "source")
        expect(writer?.error).toMatchObject({ response: { code: "lot_source_locked" } });
      else expect(writer?.error).toBeUndefined();
      const before = await f.snapshot();
      const checked = await outcome(
        f.db.transaction((tx) =>
          verifyUsDatasetCases(tx, context, c.intent, c.receipt, "replay", c.stores),
        ),
      );
      if (["link", "same-key link", "source"].includes(kind)) expect(checked.error).toBeUndefined();
      else expect(checked.error).toMatchObject({ message: "us_dataset_cases_mismatch" });
      expect(await f.snapshot()).toEqual(before);
      void references;
    });
  }
  for (const order of ["verifier first", "writer first"] as const) {
    const kinds: Kind[] =
      order === "verifier first"
        ? [
            "link",
            "same-key link",
            "unlink",
            "void",
            "amend",
            "finalize amendment",
            "lot",
            "source",
            "product",
            "document",
          ]
        : [
            "link",
            "same-key link",
            "unlink",
            "void",
            "amend",
            "finalize amendment",
            "lot",
            "source",
            "product",
            "document",
          ];
    it.for(kinds)(
      `${order}: real PID-observed %s contention`,
      { timeout: 20000 },
      async (kind, test) => {
        const observation = startObservation(test, (signal, ready) =>
          schedule(kind, order, signal, ready),
        );
        try {
          await observation.ready;
          observation.proceed();
          expect((await observation.running).error).toBeUndefined();
        } finally {
          await observation.cleanup();
        }
      },
    );
  }

  it(
    "completed verifier arbitrates the actual operation before any root or lot lock",
    { timeout: 15000 },
    async (test) => {
      const observation = startObservation(test, (signal, ready) =>
        withOwnedWork(async (own) => {
          const context = await f.provision(),
            c = await composeDatasetCases(f, context, 0),
            pools = connections(own),
            holderPid = await pid(pools.writer),
            verifierPid = await pid(pools.replay);
          const acquired = barrier(),
            release = barrier();
          const workers: {
            holder?: ReturnType<typeof outcome>;
            verifier?: ReturnType<typeof outcome>;
          } = {};
          own("release-before-drain", async () => {
            release.release();
            await Promise.all([workers.holder, workers.verifier]);
          });
          workers.holder = outcome(
            pools.writer.db.transaction(async (tx) => {
              await lockCaseOperation(tx, context.tenantId, "case.link", c.intent.operationKey);
              acquired.release();
              await release.promise;
            }),
          );
          await abortable(
            Promise.race([
              acquired.promise,
              workers.holder.then(({ error }) => {
                throw error;
              }),
            ]),
            signal,
          );
          workers.verifier = outcome(
            pools.replay.db.transaction((tx) =>
              verifyUsDatasetCases(
                tx,
                context,
                c.intent,
                c.receipt,
                "replay",
                datasetTransformationStores(pools.replay.db),
              ),
            ),
          );
          await waitBlocked(f, holderPid, verifierPid, signal);
          expect(
            (
              await f.pool.query(
                "SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE l.pid=$1 AND c.relname IN ('receiving_event_roots','transformation_event_roots','traceability_events','traceability_lots')",
                [verifierPid],
              )
            ).rows,
          ).toEqual([]);
          await ready();
          release.release();
          expect((await workers.holder).error).toBeUndefined();
          expect((await workers.verifier).error).toBeUndefined();
        }),
      );
      try {
        await observation.ready;
        observation.proceed();
        expect((await observation.running).error).toBeUndefined();
      } finally {
        await observation.cleanup();
      }
    },
  );

  const timedOut: {
    phase: string;
    aborted: boolean;
    sameReason: boolean;
    observed: boolean;
    absent: boolean;
  }[] = [];
  it.fails(
    "runner timeout cancels actual signal before readiness",
    { timeout: 400 },
    async (test) => {
      let workerPid = 0;
      const observation = startObservation(test, (signal) =>
        withOwnedWork(async (own) => {
          const client = await f.pool.connect();
          ownClient(own, client, "timeout-rollback", () => client.query("ROLLBACK"));
          await client.query("BEGIN");
          workerPid =
            (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ??
            0;
          await abortable(barrier().promise, signal);
        }),
      );
      const readiness = outcome(observation.ready);
      test.onTestFinished(async () => {
        await observation.cleanup();
        const result = await observation.running;
        await readiness;
        const n = (
          await f.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=$1",
            [workerPid],
          )
        ).rows[0]?.n;
        timedOut.push({
          phase: "before readiness",
          aborted: test.signal.aborted,
          sameReason: result.error === test.signal.reason,
          observed: workerPid > 0,
          absent: n === 0,
        });
      });
      await observation.ready;
    },
  );
  it.fails(
    "runner timeout cancels actual signal with a PID-observed native waiter",
    { timeout: 5000 },
    async (test) => {
      let observed = false;
      let pids: number[] = [];
      const observation = startObservation(test, (signal, ready) =>
        schedule("void", "writer first", signal, ready, (owned) => {
          pids = owned;
        }),
      );
      test.onTestFinished(async () => {
        await observation.cleanup();
        const result = await observation.running;
        const n = (
          await f.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])",
            [pids],
          )
        ).rows[0]?.n;
        timedOut.push({
          phase: "while blocked",
          aborted: test.signal.aborted,
          sameReason: result.error === test.signal.reason,
          observed: observed && pids.length === 3,
          absent: n === 0,
        });
      });
      await observation.ready;
      observed = true;
      const result = await observation.running;
      if (result.error) throw result.error;
    },
  );
  it("proves intended timeout phases, actual signal reason and backend disposal", () => {
    expect(timedOut).toEqual([
      { phase: "before readiness", aborted: true, sameReason: true, observed: true, absent: true },
      { phase: "while blocked", aborted: true, sameReason: true, observed: true, absent: true },
    ]);
  });
  it("keeps primary failure after independently attempted cleanup failures", async () => {
    const primary = new Error("owned primary"),
      cleanup = new Error("injected cleanup failure"),
      seen: string[] = [],
      pids: number[] = [];
    let report: CleanupEvidence | undefined;
    await expect(
      withOwnedWork(
        async (own) => {
          const second = await f.pool.connect();
          ownClient(own, second, "independent-client", async () => {
            seen.push("last");
            return second.query("ROLLBACK");
          });
          await second.query("BEGIN");
          const first = await f.pool.connect();
          ownClient(own, first, "broken", async () => {
            await first.query("ROLLBACK");
            seen.push("broken");
            throw cleanup;
          });
          await first.query("BEGIN");
          for (const client of [first, second]) {
            const value = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
              .rows[0]?.pid;
            if (!value) throw new Error("Missing owned cleanup PID");
            pids.push(value);
          }
          own("first", async () => {
            seen.push("first");
          });
          throw primary;
        },
        (evidence) => {
          report = evidence;
        },
      ),
    ).rejects.toBe(primary);
    expect(seen).toEqual(["first", "broken", "last"]);
    expect(report).toEqual({
      primaryError: primary,
      cleanupFailures: [{ phase: "broken", error: cleanup }],
    });
    expect(pids).toHaveLength(2);
    expect(
      (
        await f.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])",
          [pids],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });
});
