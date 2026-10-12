import { randomUUID } from "node:crypto";
import { setTimeout as pollInterval } from "node:timers/promises";
import { canonicalExportDigest } from "@markiro/domain";
import type { ReceivingDraft } from "@markiro/platform-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import {
  makeUsDatasetReceivingInput,
  makeUsDatasetReferenceIdentity,
  parseUsDatasetReceivingResult,
  usDatasetReceivingRecordIds,
} from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { verifyUsDatasetReceiving } from "../src/modules/traceability/demo/us-dataset-receiving-verify";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { UsCatalogStore } from "../src/modules/traceability/catalog/us-catalog-store";
import { UsReferenceDocumentStore } from "../src/modules/traceability/documents/us-reference-document-store";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import { UsMasterDataStore } from "../src/modules/traceability/master-data/us-master-data-store";
import { UsProductProfileStore } from "../src/modules/traceability/products/us-product-profile-store";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createDb } from "@markiro/db";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const bound = (entries: readonly { key: string; id: string }[], key: string) => {
  const entry = entries.find((item) => item.key === key);
  if (!entry) throw new Error("Missing fixture binding");
  return entry.id;
};
const failUnexpectedApply = async (): Promise<never> => {
  throw new Error("unexpected application");
};

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitForBlocker(query: () => Promise<boolean | undefined>, signal: AbortSignal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  for (;;) {
    deadline.throwIfAborted();
    const blocked = await abortable(query(), deadline);
    if (blocked === true) {
      expect(blocked).toBe(true);
      return;
    }
    await pollInterval(10, undefined, { signal: deadline });
  }
}

function withTestLifecycle(test: TestContext, run: (signal: AbortSignal) => Promise<void>) {
  const pending = Promise.resolve().then(() => run(test.signal));
  // Vitest rejects a timed-out test without awaiting its asynchronous body. Drain its
  // abort-aware cleanup before the next beforeEach can queue a TRUNCATE.
  test.onTestFinished(async () => {
    await pending.catch(() => {});
  });
  return pending;
}

function startAbortObservation(
  test: Pick<TestContext, "signal" | "onTestFinished">,
  work: (signal: AbortSignal, ready: () => Promise<void>) => Promise<void>,
) {
  const abort = new AbortController();
  const signal = AbortSignal.any([test.signal, abort.signal]);
  let announce = () => {};
  let release = () => {};
  const announced = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const observation = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = Promise.resolve()
    .then(() =>
      work(signal, async () => {
        announce();
        await observation;
      }),
    )
    .then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
  const cleanup = async () => {
    abort.abort(new Error("abort_observation_cleanup"));
    release();
    await running;
  };
  // Register before the queued work begins: Vitest can finish a timed-out test
  // without awaiting its body, so normal finally alone cannot protect fixture reset.
  test.onTestFinished(cleanup);
  const ready = abortable(
    Promise.race([
      announced,
      running.then(({ error }) => {
        throw error ?? new Error("worker_finished_before_readiness");
      }),
    ]),
    signal,
  );
  return { abort, ready, running, cleanup };
}

describe.skipIf(!base)("Dataset Receiving actual PostgreSQL locks", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let context: Awaited<ReturnType<typeof f.provision>>;
  let stores: Parameters<typeof verifyUsDatasetReceiving>[4];
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated database");
    f = await createUsDatasetJournalFixture(base);
    stores = {
      journal: new UsDatasetJournalStore(f.db, usSixMonthDefinition),
      master: new UsMasterDataStore(f.db),
      catalog: new UsCatalogStore(f.db),
      profiles: new UsProductProfileStore(f.db),
      documents: new UsReferenceDocumentStore(f.db),
      lots: new UsLotStore(f.db),
      receiving: new UsReceivingStore(f.db),
    };
  }, 60000);
  beforeEach(async () => {
    context = await f.provision();
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  async function compose() {
    const references = await new UsDatasetReferenceSeedStore(f.db).initialize(context);
    const header = await stores.journal.read(context);
    if (!header) throw new Error("Missing header");
    const referenceStage = await stores.journal.readStage(
      context,
      header.id,
      "references",
      "references",
    );
    if (!referenceStage) throw new Error("Missing references");
    const input = makeUsDatasetReceivingInput(
      259,
      makeUsDatasetReferenceIdentity(header.id, referenceStage),
    );
    const operationKey = randomUUID();
    const intent = {
      unitKey: input.chain.unitKey,
      stage: "receiving" as const,
      operationKey,
      input,
      inputDigest: canonicalExportDigest(input),
    };
    await stores.journal.captureIntent(context, header.id, intent);
    const stage = await stores.journal.runAtomicStage(context, header.id, 1, intent, {
      apply: async (tx) => {
        const documents = [];
        for (const number of input.chain.receiving.references) {
          const definitions = input.chain.documents.filter((d) => d.input.number === number);
          const d = definitions[0];
          if (definitions.length !== 1 || !d) throw new Error("Invalid fixture document");
          documents.push({
            key: d.key,
            record: await stores.documents.createDocumentInTransaction(
              tx,
              context.tenantId,
              context.actorUserId,
              { ...d.input, partyId: bound(references.bindings.parties, d.partyKey) },
              operationKey,
            ),
          });
        }
        const sourceId = bound(
          references.bindings.locations,
          input.chain.receiving.previousSourceLocationKey,
        );
        const draft: ReceivingDraft = {
          dateReceived: input.chain.receiving.eventDate,
          locationId: bound(
            references.bindings.locations,
            input.chain.receiving.receivingLocationKey,
          ),
          previousSourceLocationId: sourceId,
          receivedAtNote: null,
          notes: null,
          documentIds: documents.map((d) => d.record.id),
          items: input.chain.receiving.lines.map((line) => ({
            productId: bound(references.bindings.products, line.productKey),
            lotLinkMode: "create_on_finalize",
            lotId: null,
            tlc: line.tlc,
            source: { kind: "location", locationId: sourceId },
            quantity: line.quantity,
            unitOfMeasure: line.unitOfMeasure,
            exemptSupplier: false,
            exemptReason: null,
            exemptReceipt: null,
            supplierLotReference: null,
            notes: null,
          })),
        };
        const created = await stores.receiving.createDraftCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          { operationKey, draft },
          operationKey,
        );
        if (!("receiptVersion" in created)) throw new Error("Missing create receipt");
        const ready = await stores.receiving.checkRevisionReadinessInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          created.eventId,
          { expectedDraftVersion: 1 },
        );
        expect(ready.state).toBe("complete");
        expect(ready.ruleVersion).toBe("receiving-readiness-v4");
        const finalized = await stores.receiving.finalizeCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          created.eventId,
          {
            commandVersion: 2,
            operationKey,
            expectedDraftVersion: 1,
            expectedLifecycleVersion: ready.expectedLifecycleVersion,
            previousRevisionId: ready.previousRevisionId,
            expectedInputDigest: ready.inputDigest,
            reviewedExemptLines: [],
          },
          operationKey,
        );
        if (!("receiptVersion" in finalized) || finalized.record.content.kind !== "finalized")
          throw new Error("Missing final receipt");
        const lots = [];
        for (const line of finalized.record.content.snapshot.items)
          lots.push(
            await stores.lots.getLotInTransaction(
              tx,
              context.tenantId,
              context.actorUserId,
              line.lotId,
            ),
          );
        const result = parseUsDatasetReceivingResult({
          input,
          documents,
          created,
          finalized,
          lots,
        });
        return {
          recordIds: usDatasetReceivingRecordIds(result),
          result,
          resultDigest: canonicalExportDigest(result),
        };
      },
      verify: async () => {},
    });
    if (!stage.receipt) throw new Error("Missing receipt");
    const result = parseUsDatasetReceivingResult(stage.receipt.result);
    const verify = () =>
      stores.journal.runAtomicStage(context, header.id, stage.revision, stage.intent, {
        apply: failUnexpectedApply,
        verify: (tx, c, i, r) => verifyUsDatasetReceiving(tx, c, i, r, stores),
      });
    return { header, stage, result, verify, references };
  }

  function barrier() {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }
  const outcome = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
  async function writer(c: Awaited<ReturnType<typeof compose>>, db: typeof f.db, kind: string) {
    const receiving = new UsReceivingStore(db);
    const args = {
      commandVersion: 2,
      operationKey: randomUUID(),
      expectedLifecycleVersion: 2,
      reason: "Synthetic competing writer",
    };
    if (kind === "amend")
      return () =>
        receiving.amend(
          context.tenantId,
          context.actorUserId,
          c.result.created.eventId,
          args,
          "writer",
        );
    if (kind === "void")
      return () =>
        receiving.void(
          context.tenantId,
          context.actorUserId,
          c.result.created.eventId,
          { ...args, expectedDraftVersion: null },
          "writer",
        );
    if (kind === "profile") {
      const profile = c.references.evidence.profiles[0];
      if (!profile) throw new Error("Missing profile");
      const { productId, revision, reviewedBy, reviewedAt, createdAt, updatedAt, ...editable } =
        profile;
      void [reviewedBy, reviewedAt, createdAt, updatedAt];
      return () =>
        new UsProductProfileStore(db).putProfile(
          context.tenantId,
          context.actorUserId,
          productId,
          { ...editable, productName: "Synthetic changed", expectedRevision: revision },
          "writer",
        );
    }
    if (kind !== "support") throw new Error("Invalid writer kind");
    if (c.result.created.record.content.kind !== "draft") throw new Error("Missing draft");
    const draft = c.result.created.record.content.draft;
    const created = await receiving.createDraftCommand(
      context.tenantId,
      context.actorUserId,
      {
        operationKey: randomUUID(),
        draft: {
          ...draft,
          items: draft.items.map((line, index) => ({
            ...line,
            lotLinkMode: "link_existing",
            lotId: c.result.lots[index]?.id,
          })),
        },
      },
      "support",
    );
    if (!("receiptVersion" in created)) throw new Error("Missing support receipt");
    const ready = await receiving.checkRevisionReadiness(
      context.tenantId,
      context.actorUserId,
      created.eventId,
      { expectedDraftVersion: 1 },
    );
    expect(ready.state).toBe("complete");
    return () =>
      receiving.finalizeCommand(
        context.tenantId,
        context.actorUserId,
        created.eventId,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedLifecycleVersion: ready.expectedLifecycleVersion,
          previousRevisionId: ready.previousRevisionId,
          expectedInputDigest: ready.inputDigest,
          reviewedExemptLines: [],
        },
        "support",
      );
  }

  async function runVerifierFirst(kind: string, signal: AbortSignal) {
    const c = await compose();
    signal.throwIfAborted();
    if (!base) throw new Error("Missing database");
    const url = new URL(base);
    url.pathname = "/" + f.databaseName;
    // Dedicated max-one pools pin the exact verifier and public writer backend identities.
    const verifierConnection = createDb(url.toString(), {
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    const writerConnection = createDb(url.toString(), {
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    const observerConnection = createDb(url.toString(), {
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    const held = barrier(),
      release = barrier();
    let verification: ReturnType<typeof outcome> | undefined;
    let writing: ReturnType<typeof outcome> | undefined;
    try {
      const verifierPid = (
        await verifierConnection.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      const writerPid = (
        await writerConnection.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      if (!verifierPid || !writerPid || verifierPid === writerPid)
        throw new Error("Missing distinct backend identities");
      const write =
        kind === "document"
          ? // Fixture-only negative DB contention; the document store intentionally has no edit API.
            () =>
              writerConnection.pool.query(
                "UPDATE reference_documents SET number='CHANGED' WHERE tenant_id=$1 AND id=$2",
                [context.tenantId, c.result.documents[0]?.record.id],
              )
          : await writer(c, writerConnection.db, kind);
      const journal = new UsDatasetJournalStore(verifierConnection.db, usSixMonthDefinition);
      verification = outcome(
        journal.runAtomicStage(context, c.header.id, c.stage.revision, c.stage.intent, {
          apply: failUnexpectedApply,
          verify: async (tx, checked, intent, receipt) => {
            await verifyUsDatasetReceiving(tx, checked, intent, receipt, stores);
            held.release();
            await release.promise;
          },
        }),
      );
      await abortable(
        Promise.race([
          held.promise,
          verification.then((r) => {
            if (r.error) throw r.error;
          }),
        ]),
        signal,
      );
      writing = outcome<unknown>(write());
      await waitForBlocker(
        async () =>
          (
            await observerConnection.pool.query<{ blocked: boolean }>(
              "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
              [verifierPid, writerPid],
            )
          ).rows[0]?.blocked,
        signal,
      );
      release.release();
      expect((await verification).error).toBeUndefined();
      expect((await writing).error).toBeUndefined();
      const before = await f.snapshot();
      await expect(c.verify()).rejects.toThrow("us_dataset_receiving_mismatch");
      expect(await f.snapshot()).toEqual(before);
    } finally {
      release.release();
      try {
        await Promise.all([verification, writing]);
      } finally {
        await Promise.all([
          verifierConnection.pool.end(),
          writerConnection.pool.end(),
          observerConnection.pool.end(),
        ]);
      }
    }
  }
  it.for(["amend", "void", "support", "document", "profile"])(
    "holds the %s writer until verifier commit and then rejects its new state",
    { timeout: 15000 },
    (kind, test) => withTestLifecycle(test, (signal) => runVerifierFirst(kind, signal)),
  );

  async function runWriterFirst(
    kind: string,
    signal: AbortSignal,
    hooks: { afterObserved?: () => Promise<void>; pids?: (pids: number[]) => void } = {},
  ) {
    const c = await compose();
    signal.throwIfAborted();
    if (!base) throw new Error("Missing database");
    const url = new URL(base);
    url.pathname = "/" + f.databaseName;
    const verifierConnection = createDb(url.toString(), {
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    const writerConnection = createDb(url.toString(), {
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    const gateConnection = createDb(url.toString(), {
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    const gate = await gateConnection.pool.connect();
    let writing: ReturnType<typeof outcome> | undefined;
    let verification: ReturnType<typeof outcome> | undefined;
    try {
      const verifierPid = (
        await verifierConnection.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      const writerPid = (
        await writerConnection.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      if (!verifierPid || !writerPid || !gatePid) throw new Error("Missing backend identity");
      hooks.pids?.([verifierPid, writerPid, gatePid]);
      const write =
        kind === "document"
          ? () =>
              writerConnection.pool.query(
                "UPDATE reference_documents SET number='CHANGED' WHERE tenant_id=$1 AND id=$2",
                [context.tenantId, c.result.documents[0]?.record.id],
              )
          : await writer(c, writerConnection.db, kind);
      const [table, id] =
        kind === "profile"
          ? ["products", c.references.evidence.profiles[0]?.productId]
          : kind === "document"
            ? ["reference_documents", c.result.documents[0]?.record.id]
            : kind === "support"
              ? ["traceability_lots", c.result.lots.map(({ id }) => id).sort()[0]]
              : ["receiving_event_roots", c.result.created.eventId];
      await gate.query("BEGIN");
      await gate.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [
        context.tenantId,
        id,
      ]);
      writing = outcome<unknown>(write());
      const blocks = async (blocker: number, blocked: number) =>
        (
          await gate.query<{ blocked: boolean }>(
            "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
            [blocker, blocked],
          )
        ).rows[0]?.blocked;
      await waitForBlocker(() => blocks(gatePid, writerPid), signal);
      const journal = new UsDatasetJournalStore(verifierConnection.db, usSixMonthDefinition);
      verification = outcome(
        journal.runAtomicStage(context, c.header.id, c.stage.revision, c.stage.intent, {
          apply: failUnexpectedApply,
          verify: (tx, checked, intent, receipt) =>
            verifyUsDatasetReceiving(tx, checked, intent, receipt, stores),
        }),
      );
      // PostgreSQL's lock queue, rather than call timing, proves the writer is first.
      await waitForBlocker(() => blocks(writerPid, verifierPid), signal);
      await abortable(hooks.afterObserved?.() ?? Promise.resolve(), signal);
      await gate.query("COMMIT");
      expect((await writing).error).toBeUndefined();
      expect((await verification).error).toMatchObject({
        message: "us_dataset_receiving_mismatch",
      });
      const before = await f.snapshot();
      await expect(c.verify()).rejects.toThrow("us_dataset_receiving_mismatch");
      expect(await f.snapshot()).toEqual(before);
    } finally {
      try {
        try {
          await gate.query("ROLLBACK");
        } finally {
          gate.release(true);
        }
      } finally {
        try {
          await Promise.all([writing, verification]);
        } finally {
          await Promise.all([
            verifierConnection.pool.end(),
            writerConnection.pool.end(),
            gateConnection.pool.end(),
          ]);
        }
      }
    }
  }

  it.for(["amend", "void", "support", "document", "profile"])(
    "queues behind the %s writer and rejects its committed state without a lock cycle",
    { timeout: 15000 },
    (kind, test) => withTestLifecycle(test, (signal) => runWriterFirst(kind, signal)),
  );

  it.for(["failure", "cancellation"] as const)(
    "settles pre-barrier %s in the abort regression harness and drains owned work",
    async (mode, test) => {
      const testAbort = new AbortController();
      let releaseSetup = () => {};
      let entered = () => {};
      let rescueReady: (() => Promise<void>) | undefined;
      let finish: (() => Promise<void>) | undefined;
      let drained = false;
      let registeredBeforeWork = false;
      let pid = 0;
      const setup = new Promise<void>((resolve) => {
        releaseSetup = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const failure = new Error(`pre_barrier_${mode}`);
      const observation = startAbortObservation(
        {
          signal: AbortSignal.any([test.signal, testAbort.signal]),
          onTestFinished: (cleanup) => {
            finish = async () => {
              await cleanup(test);
            };
            test.onTestFinished(cleanup);
          },
        },
        async (signal, ready) => {
          registeredBeforeWork = finish !== undefined;
          rescueReady = ready;
          const client = await f.pool.connect();
          try {
            await client.query("BEGIN");
            pid =
              (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                ?.pid ?? 0;
            entered();
            if (mode === "failure") throw failure;
            await abortable(setup, signal);
          } finally {
            try {
              await client.query("ROLLBACK");
            } finally {
              client.release(true);
              drained = true;
            }
          }
        },
      );
      let settled = false;
      const readiness = observation.ready
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        )
        .then((result) => {
          settled = true;
          return result;
        });
      try {
        await abortable(started, test.signal);
        if (mode === "cancellation") testAbort.abort(failure);
        await expect.poll(() => settled, { timeout: 500 }).toBe(true);
        expect((await readiness).error).toBe(failure);
        expect(registeredBeforeWork).toBe(true);
        await finish?.();
        expect(drained).toBe(true);
        expect((await observation.running).error).toBe(failure);
        expect(pid).toBeGreaterThan(0);
        expect(
          (
            await f.pool.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=$1",
              [pid],
            )
          ).rows[0]?.n,
        ).toBe(0);
      } finally {
        // Recover the intentionally broken RED without leaving pending DB work.
        observation.abort.abort(failure);
        releaseSetup();
        const rescued = rescueReady?.();
        await observation.cleanup();
        await rescued;
        await readiness;
      }
    },
  );

  it("settles an aborted pending observation and disposes its real profile lock connections", async (test) => {
    let ownedPids: number[] = [];
    let settled = false;
    const observation = startAbortObservation(test, (signal, ready) =>
      runWriterFirst("profile", signal, {
        pids: (pids) => {
          ownedPids = pids;
        },
        afterObserved: ready,
      }),
    );
    const running = observation.running.then((result) => {
      settled = true;
      return result;
    });
    try {
      await observation.ready;
      observation.abort.abort(new Error("injected_test_timeout"));
      // A bounded failure detector, not the proof of lock contention; the helper already
      // established actual gate -> writer -> verifier backend blocking before injection.
      await expect.poll(() => settled, { timeout: 500 }).toBe(true);
      expect((await running).error).toMatchObject({ message: "injected_test_timeout" });
      expect(
        (
          await f.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])",
            [ownedPids],
          )
        ).rows[0]?.n,
      ).toBe(0);
    } finally {
      // Keeps the RED experiment recoverable even when cancellation is not implemented.
      await observation.cleanup();
    }
  }, 15000);
});
