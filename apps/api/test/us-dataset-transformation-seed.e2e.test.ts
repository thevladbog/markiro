import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { createDb } from "@markiro/db";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type TestContext,
} from "vitest";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { transformationCommandDigest } from "../src/modules/traceability/transformation/us-transformation-operations";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { UsDatasetTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-transformation-seed";
import { parseUsDatasetTransformationResult } from "../src/modules/traceability/demo/us-dataset-transformation-contract";
import { prepareDatasetTransformation } from "./support/us-dataset-transformation-fixture";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  barrier,
  abortable,
  outcome,
  withOwnedWork,
  ownClient,
  startObservation,
  waitBlocked,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Dataset Transformation atomic application", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let context: Awaited<ReturnType<typeof f.provision>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated database");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  beforeEach(async () => {
    context = await f.provision();
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  const journal = () => new UsDatasetJournalStore(f.db, usSixMonthDefinition);
  async function withOwnedBody(
    test: TestContext,
    run: (phase: <T>(name: string, work: () => Promise<T>) => Promise<T>) => Promise<void>,
  ) {
    const worker = outcome(
      run(async (_phase, work) => {
        test.signal.throwIfAborted();
        return await work();
      }),
    );
    const drain = async () => {
      await worker;
    };
    test.onTestFinished(drain);
    try {
      const response = await abortable(worker, test.signal);
      if (response.error !== undefined) throw response.error;
    } finally {
      await drain();
    }
  }
  async function capture(index = 259) {
    const c = await prepareDatasetTransformation(f.db, context, index);
    const stage = await c.stores.journal.captureIntent(context, c.header.id, c.intent);
    return { ...c, stage };
  }
  it.each([0, 131, 259])("installs chain %i and replays without writes", async (index) => {
    const prepared = await prepareDatasetTransformation(f.db, context, index);
    const seed = new UsDatasetTransformationSeedStore(f.db);
    const result = await seed.initialize(context, index);
    expect(result.documents).toHaveLength(2);
    expect(result.inputLots.map(({ lotId }) => lotId)).toEqual(
      prepared.receiving.lots.map(({ id }) => id),
    );
    expect(parseUsDatasetTransformationResult(result)).toEqual(result);
    expect(result.finalized.snapshot.eventDate).toBe(result.input.chain.transformation.eventDate);
    if (index !== 259) {
      expect(result.finalized.snapshot.eventDate).toBe(index === 0 ? "2026-04-02" : "2026-07-10");
      expect(
        result.finalized.snapshot.inputs.map(({ quantity, unitOfMeasure }) => ({
          quantity,
          unitOfMeasure,
        })),
      ).toEqual(
        index === 0
          ? [
              { quantity: "300", unitOfMeasure: "lb" },
              { quantity: "400", unitOfMeasure: "lb" },
            ]
          : [
              { quantity: "425.5", unitOfMeasure: "lb" },
              { quantity: "525", unitOfMeasure: "lb" },
            ],
      );
      expect(
        result.finalized.snapshot.outputs.map(({ quantity, unitOfMeasure }) => ({
          quantity,
          unitOfMeasure,
        })),
      ).toEqual([{ quantity: index === 0 ? "55" : "70", unitOfMeasure: "case" }]);
    }
    expect(result.finalized.eventNumber).toMatch(
      new RegExp(
        `^TRN-${new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "2-digit" }).format(new Date())}-0001$`,
      ),
    );
    if (index === 259) {
      expect(result.finalized.snapshot.eventDate).toBe("2026-09-15");
      expect(
        result.finalized.snapshot.inputs.map(({ quantity, unitOfMeasure }) => ({
          quantity,
          unitOfMeasure,
        })),
      ).toEqual([
        { quantity: "500", unitOfMeasure: "lb" },
        { quantity: "500", unitOfMeasure: "lb" },
      ]);
      expect(
        result.finalized.snapshot.outputs.map(({ quantity, unitOfMeasure }) => ({
          quantity,
          unitOfMeasure,
        })),
      ).toEqual([{ quantity: "100", unitOfMeasure: "case" }]);
    }
    const key = result.createInput.operationKey;
    expect(
      (
        await f.pool.query(
          "SELECT command,operation_key,event_id,input_digest,result FROM transformation_operations WHERE tenant_id=$1 ORDER BY command",
          [context.tenantId],
        )
      ).rows,
    ).toEqual([
      {
        command: "transformation.create",
        operation_key: key,
        event_id: result.created.id,
        input_digest: transformationCommandDigest("transformation.create", result.createInput),
        result: result.created,
      },
      {
        command: "transformation.finalize",
        operation_key: key,
        event_id: result.created.id,
        input_digest: transformationCommandDigest(
          "transformation.finalize",
          result.finalizeInput,
          result.created.id,
        ),
        result: result.finalized,
      },
    ]);
    const expectedAudits = [
      ...result.documents.map(({ record }) => ({
        action: "traceability.reference_document.created",
        target_type: "traceability_reference_document",
        target_id: record.id,
        before: null,
        after: record,
      })),
      {
        action: "traceability.transformation.draft_created",
        target_type: "traceability_event",
        target_id: result.created.id,
        before: null,
        after: result.created,
      },
      {
        action: "traceability.lot.created",
        target_type: "traceability_lot",
        target_id: result.outputLot.id,
        before: null,
        after: { ...result.outputLot, eventId: result.created.id },
      },
      {
        action: "traceability.transformation.finalized",
        target_type: "traceability_event",
        target_id: result.created.id,
        before: result.created,
        after: result.finalized,
      },
    ].map((a) => ({
      ...a,
      organization_id: context.tenantId,
      actor_user_id: context.actorUserId,
      outcome: "success",
      request_id: key,
    }));
    const audits = (
      await f.pool.query(
        "SELECT organization_id,actor_user_id,action,target_type,target_id,outcome,request_id,before,after FROM tenant_audit_events WHERE request_id=$1",
        [key],
      )
    ).rows;
    expect(audits.map(canonicalExportDigest).sort()).toEqual(
      expectedAudits.map(canonicalExportDigest).sort(),
    );
    expect(
      (
        await f.pool.query(
          "SELECT input_lot_id,output_lot_id FROM lot_genealogy_edges WHERE event_id=$1 ORDER BY input_lot_id",
          [result.created.id],
        )
      ).rows,
    ).toEqual(
      result.inputLots
        .map(({ lotId }) => ({ input_lot_id: lotId, output_lot_id: result.outputLot.id }))
        .sort((a, b) => a.input_lot_id.localeCompare(b.input_lot_id)),
    );
    const stage = await journal().readStage(
      context,
      prepared.header.id,
      result.input.chain.unitKey,
      "transformation",
    );
    expect(stage?.receipt?.recordIds).toEqual([
      ...result.documents.map(({ record }) => record.id),
      result.created.id,
      result.outputLot.id,
    ]);
    const before = await f.snapshot();
    expect(await seed.verify(context, index)).toEqual(result);
    expect(await seed.initialize(context, index)).toEqual(result);
    expect(await f.snapshot()).toEqual(before);
  });
  it.each([
    "missing dataset",
    "missing references",
    "pending references",
    "missing receiving",
    "pending receiving",
  ])("rejects %s without installing prerequisites", async (kind) => {
    if (kind !== "missing dataset") {
      const header =
        kind === "missing receiving" || kind === "pending receiving"
          ? (await new UsDatasetReferenceSeedStore(f.db).initialize(context),
            await journal().read(context))
          : await journal().initialize(context);
      if (!header) throw new Error("Missing header");
      if (kind.startsWith("pending")) {
        const unitKey = kind === "pending references" ? "references" : "chain_0259";
        await journal().captureIntent(context, header.id, {
          unitKey,
          stage: kind === "pending references" ? "references" : "receiving",
          operationKey: randomUUID(),
          input: {},
          inputDigest: canonicalExportDigest({}),
        });
      }
    }
    const before = await f.snapshot();
    await expect(
      new UsDatasetTransformationSeedStore(f.db).initialize(context, 259),
    ).rejects.toThrow("us_dataset_transformation_prerequisite_incomplete");
    await expect(new UsDatasetTransformationSeedStore(f.db).verify(context, 259)).rejects.toThrow(
      "us_dataset_transformation_prerequisite_incomplete",
    );
    expect(await f.snapshot()).toEqual(before);
  });
  it.each([-1, 260, 1.5, NaN, Infinity, "correction", "orphan"])(
    "rejects invalid index %s without writes",
    async (index) => {
      await new UsDatasetReferenceSeedStore(f.db).initialize(context);
      const before = await f.snapshot();
      await expect(
        new UsDatasetTransformationSeedStore(f.db).initialize(context, index as number),
      ).rejects.toThrow("us_dataset_transformation_input_invalid");
      expect(await f.snapshot()).toEqual(before);
    },
  );
  it.each(["actor", "tenant", "database", "user", "role", "provenance"])(
    "authorizes %s before malformed index or command evidence",
    async (kind) => {
      await capture();
      const target = {
        ...context,
        ...(kind === "actor"
          ? { actorUserId: randomUUID() }
          : kind === "tenant"
            ? { tenantId: randomUUID() }
            : kind === "database"
              ? { expectedDatabaseName: "markiro_us_dev" }
              : {}),
      };
      if (kind === "role")
        await f.pool.query("UPDATE member SET role='viewer' WHERE organization_id=$1", [
          context.tenantId,
        ]);
      if (kind === "provenance")
        await f.pool.query(
          "UPDATE tenant_audit_events SET outcome='failure' WHERE organization_id=$1 AND action='us.development.owner.provisioned'",
          [context.tenantId],
        );
      const db = kind === "user" ? await f.alternateRole() : f.db;
      const before = await f.snapshot();
      await expect(
        new UsDatasetTransformationSeedStore(db).initialize(target, NaN),
      ).rejects.toThrow("us_dataset_target_invalid");
      expect(await f.snapshot()).toEqual(before);
    },
  );
  it("verify neither captures absent work nor applies pending intent", async () => {
    const c = await prepareDatasetTransformation(f.db, context);
    const before = await f.snapshot();
    await expect(new UsDatasetTransformationSeedStore(f.db).verify(context, 259)).rejects.toThrow(
      "us_dataset_transformation_prerequisite_incomplete",
    );
    expect(await f.snapshot()).toEqual(before);
    await c.stores.journal.captureIntent(context, c.header.id, c.intent);
    const pending = await f.snapshot();
    await expect(new UsDatasetTransformationSeedStore(f.db).verify(context, 259)).rejects.toThrow(
      "us_dataset_transformation_prerequisite_incomplete",
    );
    expect(await f.snapshot()).toEqual(pending);
  });
  it.for([
    [
      "second document",
      "reference_documents",
      "INSERT",
      "(SELECT count(*) FROM reference_documents)=3",
    ],
    ["draft", "transformation_event_details", "INSERT", "true"],
    ["output lot", "traceability_lots", "INSERT", "NEW.assignment_basis='transformation'"],
    ["genealogy", "lot_genealogy_edges", "INSERT", "true"],
    [
      "audit",
      "tenant_audit_events",
      "INSERT",
      "NEW.action='traceability.transformation.finalized'",
    ],
    ["operation", "transformation_operations", "INSERT", "NEW.command='transformation.finalize'"],
    [
      "verifier",
      "tenant_audit_events",
      "INSERT",
      "NEW.action='traceability.transformation.finalized'",
    ],
    ["receipt", "traceability_demo_dataset_stages", "UPDATE", "NEW.stage='transformation'"],
    ["40001", "transformation_operations", "INSERT", "NEW.command='transformation.finalize'"],
    ["40P01", "transformation_operations", "INSERT", "NEW.command='transformation.finalize'"],
  ])(
    "rolls back every persisted table at %s and externally retries the same key",
    async ([name, table, action, condition], test) => {
      const c = await capture();
      const code = name === "40001" || name === "40P01" ? name : "P0001";
      const corrupt = name === "verifier";
      const spy = vi.spyOn(UsTransformationStore.prototype, "createDraftInTransaction");
      test.onTestFinished(() => spy.mockRestore());
      let originalFailure: unknown;
      const nativeFinalize = UsTransformationStore.prototype.finalizeInTransaction;
      const finalization = vi
        .spyOn(UsTransformationStore.prototype, "finalizeInTransaction")
        .mockImplementation(async function (this: UsTransformationStore, ...args) {
          try {
            return await nativeFinalize.apply(this, args);
          } catch (error) {
            originalFailure = error;
            throw error;
          }
        });
      test.onTestFinished(() => finalization.mockRestore());
      await withOwnedWork(async (own) => {
        await f.pool.query(
          `CREATE FUNCTION synthetic_transformation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${corrupt ? "UPDATE reference_documents SET notes='Trigger drift';" : `RAISE EXCEPTION 'synthetic_transformation_failure' USING ERRCODE='${code}';`} END IF; RETURN NEW; END $$`,
        );
        own("function", async () => {
          await f.pool.query("DROP FUNCTION synthetic_transformation_failure()");
        });
        await f.pool.query(
          `CREATE TRIGGER synthetic_transformation_failure ${corrupt ? "AFTER" : "BEFORE"} ${action} ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_transformation_failure()`,
        );
        own("trigger", async () => {
          await f.pool.query(`DROP TRIGGER synthetic_transformation_failure ON ${table}`);
        });
        const before = await f.snapshot();
        const worker = outcome(new UsDatasetTransformationSeedStore(f.db).initialize(context, 259));
        test.onTestFinished(async () => {
          await worker;
        });
        own("worker-drain", async () => {
          await worker;
        });
        const response = await abortable(worker, test.signal);
        if (corrupt)
          expect(response.error).toMatchObject({ message: "us_dataset_transformation_mismatch" });
        else
          expect(response.error).toMatchObject({
            cause: { code },
            unitKey: c.intent.unitKey,
            stage: "transformation",
          });
        if (name === "40001" || name === "40P01") expect(response.error).toBe(originalFailure);
        expect(await f.snapshot()).toEqual(before);
        expect(spy).toHaveBeenCalledTimes(name === "second document" ? 0 : 1);
        expect(
          await journal().readStage(context, c.header.id, c.input.chain.unitKey, "transformation"),
        ).toEqual(c.stage);
      });
      spy.mockRestore();
      finalization.mockRestore();
      const result = await new UsDatasetTransformationSeedStore(f.db).initialize(context, 259);
      expect(result.createInput.operationKey).toBe(c.intent.operationKey);
      expect(result.finalizeInput.operationKey).toBe(c.intent.operationKey);
    },
  );
  it("capture racers converge on one root/output/receipt and simultaneous readers replay", async (test) => {
    await prepareDatasetTransformation(f.db, context);
    const gate = barrier();
    let arrivals = 0;
    const original = UsDatasetJournalStore.prototype.captureIntent;
    const spy = vi
      .spyOn(UsDatasetJournalStore.prototype, "captureIntent")
      .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
        if (++arrivals === 2) gate.release();
        await abortable(gate.promise, test.signal);
        return original.apply(this, args);
      });
    test.onTestFinished(() => {
      gate.release();
      spy.mockRestore();
    });
    const workers = [0, 1].map(() =>
      outcome(new UsDatasetTransformationSeedStore(f.db).initialize(context, 259)),
    );
    test.onTestFinished(async () => {
      gate.release();
      await Promise.all(workers);
    });
    const responses = await Promise.all(workers);
    spy.mockRestore();
    for (const response of responses) expect(response.error).toBeUndefined();
    expect(JSON.stringify(responses[0]?.value)).toBe(JSON.stringify(responses[1]?.value));
    expect(arrivals).toBe(2);
    expect(
      (
        await f.pool.query(
          "SELECT (SELECT count(*)::int FROM transformation_event_roots) AS roots,(SELECT count(*)::int FROM traceability_lots) AS lots,(SELECT count(*)::int FROM traceability_demo_dataset_stages WHERE stage='transformation') AS receipts",
        )
      ).rows,
    ).toEqual([{ roots: 1, lots: 3, receipts: 1 }]);
    const before = await f.snapshot();
    const results = await Promise.all([
      new UsDatasetTransformationSeedStore(f.db).initialize(context, 259),
      new UsDatasetTransformationSeedStore(f.db).verify(context, 259),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await f.snapshot()).toEqual(before);
  });
  it("recovers actual committed receipt after lost acknowledgement without business writes", async () => {
    await prepareDatasetTransformation(f.db, context);
    const original = UsDatasetJournalStore.prototype.runAtomicStage;
    const spy = vi
      .spyOn(UsDatasetJournalStore.prototype, "runAtomicStage")
      .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
        await original.apply(this, args);
        throw new Error("lost committed acknowledgement");
      });
    try {
      await expect(
        new UsDatasetTransformationSeedStore(f.db).initialize(context, 259),
      ).rejects.toThrow("lost committed acknowledgement");
    } finally {
      spy.mockRestore();
    }
    const header = await journal().read(context);
    if (!header) throw new Error("Missing header");
    const committed = await journal().readStage(context, header.id, "chain_0259", "transformation");
    if (!committed?.receipt) throw new Error("Missing committed receipt");
    const before = await f.snapshot();
    expect(await new UsDatasetTransformationSeedStore(f.db).initialize(context, 259)).toEqual(
      committed.receipt.result,
    );
    expect(await new UsDatasetTransformationSeedStore(f.db).verify(context, 259)).toEqual(
      committed.receipt.result,
    );
    expect(await f.snapshot()).toEqual(before);
  });
  it.each(["wrong chain", "wrong digest", "descriptor"])(
    "rejects captured %s without recapture or native writes",
    async (kind) => {
      const c = await capture();
      const wrong =
        kind === "wrong chain" ? await prepareDatasetTransformation(f.db, context, 0) : c;
      const input = {
        ...c.input,
        ...(kind === "wrong chain"
          ? { receiving: wrong.input.receiving }
          : kind === "wrong digest"
            ? { receiving: { ...c.input.receiving, resultDigest: "a".repeat(64) } }
            : {
                chain: {
                  ...c.input.chain,
                  transformation: { ...c.input.chain.transformation, eventDate: "2026-01-01" },
                },
              }),
      };
      await f.pool.query(
        "UPDATE traceability_demo_dataset_stages SET input=$1,input_digest=$2 WHERE stage='transformation'",
        [input, canonicalExportDigest(input)],
      );
      const before = await f.snapshot();
      await expect(
        new UsDatasetTransformationSeedStore(f.db).initialize(context, 259),
      ).rejects.toThrow("us_dataset_transformation_dependency_conflict");
      expect(await f.snapshot()).toEqual(before);
    },
  );
  it.each(["references", "receiving"])(
    "rechecks %s dependency after capture inside atomic transaction",
    async (dependency) => {
      await capture();
      const original = UsDatasetJournalStore.prototype.runAtomicStage;
      let changed: Awaited<ReturnType<typeof f.snapshot>> | undefined;
      const spy = vi
        .spyOn(UsDatasetJournalStore.prototype, "runAtomicStage")
        .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
          await f.pool.query(
            "UPDATE traceability_demo_dataset_stages SET operation_key=$1 WHERE stage=$2",
            [randomUUID(), dependency],
          );
          changed = await f.snapshot();
          return original.apply(this, args);
        });
      try {
        await expect(
          new UsDatasetTransformationSeedStore(f.db).initialize(context, 259),
        ).rejects.toThrow("us_dataset_transformation_dependency_conflict");
        expect(await f.snapshot()).toEqual(changed);
      } finally {
        spy.mockRestore();
      }
    },
  );
  it.each(["document", "lot", "operation"])(
    "rejects preexisting %s without adopting business evidence",
    async (kind) => {
      const c = await capture();
      const bound = (entries: readonly { key: string; id: string }[], key: string) => {
        const entry = entries.find((e) => e.key === key);
        if (!entry) throw new Error("Missing fixture binding");
        return entry.id;
      };
      if (kind === "document") {
        const doc = c.input.chain.documents.find(
          (d) => d.input.number === c.input.chain.transformation.references[0],
        );
        if (!doc) throw new Error("Missing fixture document");
        await c.stores.documents.createDocument(
          context.tenantId,
          context.actorUserId,
          { ...doc.input, partyId: bound(c.references.bindings.parties, doc.partyKey) },
          "preexisting",
        );
      } else if (kind === "lot")
        await c.stores.lots.createLot(
          context.tenantId,
          context.actorUserId,
          {
            productId: bound(
              c.references.bindings.products,
              c.input.chain.transformation.output.productKey,
            ),
            tlc: c.input.chain.transformation.output.tlc,
            assignmentBasis: "imported",
            source: {
              kind: "location",
              locationId: bound(
                c.references.bindings.locations,
                c.input.chain.transformation.locationKey,
              ),
            },
          },
          "preexisting",
        );
      else
        await c.stores.transformation.createDraft(
          context.tenantId,
          context.actorUserId,
          {
            operationKey: c.intent.operationKey,
            draft: {
              eventDate: null,
              processorLocationId: null,
              reason: null,
              reasonNote: null,
              notes: null,
              documentIds: [],
              inputs: [],
              outputs: [],
            },
          },
          "preexisting",
        );
      const before = await f.snapshot();
      await expect(
        new UsDatasetTransformationSeedStore(f.db).initialize(context, 259),
      ).rejects.toThrow("us_dataset_transformation_conflict");
      expect(await f.snapshot()).toEqual(before);
    },
  );
  it("allows unrelated save UUID namespace during fresh application", async (test) =>
    withOwnedBody(test, async (phase) => {
      const c = await phase("prerequisites-capture", () => capture());
      const draft = {
        eventDate: null,
        processorLocationId: null,
        reason: null,
        reasonNote: null,
        notes: null,
        documentIds: [],
        inputs: [],
        outputs: [],
      };
      const unrelated = await phase("unrelated-create", () =>
        c.stores.transformation.createDraft(
          context.tenantId,
          context.actorUserId,
          { operationKey: randomUUID(), draft },
          "unrelated-create",
        ),
      );
      await phase("unrelated-save", () =>
        c.stores.transformation.saveDraft(
          context.tenantId,
          context.actorUserId,
          unrelated.id,
          {
            operationKey: c.intent.operationKey,
            expectedDraftVersion: 1,
            draft: { ...draft, notes: "Unrelated command scope" },
          },
          "unrelated-save",
        ),
      );
      const result = await phase("seed-initialize", () =>
        new UsDatasetTransformationSeedStore(f.db).initialize(context, 259),
      );
      expect(result.createInput.operationKey).toBe(c.intent.operationKey);
      const before = await phase("snapshot-before", () => f.snapshot());
      expect(
        await phase("seed-replay", () =>
          new UsDatasetTransformationSeedStore(f.db).verify(context, 259),
        ),
      ).toEqual(result);
      expect(await phase("snapshot-after", () => f.snapshot())).toEqual(before);
    }));
  it.for(["pending amendment", "void", "archive", "identity"])(
    "completed replay rejects %s without repair",
    async (kind, test) =>
      withOwnedBody(test, async (phase) => {
        const c = await phase("prerequisites", () => prepareDatasetTransformation(f.db, context));
        const result = await phase("seed-initialize", () =>
          new UsDatasetTransformationSeedStore(f.db).initialize(context, 259),
        );
        const args = {
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          reason: "Synthetic drift",
        };
        if (kind === "pending amendment")
          await phase("native-amend", () =>
            c.stores.transformation.amend(
              context.tenantId,
              context.actorUserId,
              result.created.id,
              args,
              "drift",
            ),
          );
        else if (kind === "void")
          await c.stores.transformation.void(
            context.tenantId,
            context.actorUserId,
            result.created.id,
            args,
            "drift",
          );
        else if (kind === "archive")
          await c.stores.lots.changeStatus(
            context.tenantId,
            context.actorUserId,
            result.outputLot.id,
            { status: "archived", expectedRevision: 1, reason: args.reason },
            "drift",
          );
        else
          await withOwnedWork(async (own) => {
            const client = await f.pool.connect();
            ownClient(own, client, "corruption-rollback", () => client.query("ROLLBACK"));
            await client.query("BEGIN");
            await client.query("ALTER TABLE traceability_lots DISABLE TRIGGER USER");
            await client.query("UPDATE traceability_lots SET tlc='ALTERED' WHERE id=$1", [
              result.outputLot.id,
            ]);
            await client.query("ALTER TABLE traceability_lots ENABLE TRIGGER USER");
            await client.query("COMMIT");
          });
        const before = await phase("snapshot-before", () => f.snapshot());
        await expect(
          phase("seed-replay-initialize", () =>
            new UsDatasetTransformationSeedStore(f.db).initialize(context, 259),
          ),
        ).rejects.toThrow("us_dataset_transformation_mismatch");
        await expect(
          phase("seed-replay-verify", () =>
            new UsDatasetTransformationSeedStore(f.db).verify(context, 259),
          ),
        ).rejects.toThrow("us_dataset_transformation_mismatch");
        expect(await phase("snapshot-after", () => f.snapshot())).toEqual(before);
      }),
  );
  it.for(["extensible", "frozen", "sealed", "non-error"] as const)(
    "preserves original %s failure identity while rolling back native writes",
    async (kind, test) => {
      const c = await capture();
      const before = await f.snapshot();
      const error = new Error("synthetic_native_error");
      const failure =
        kind === "frozen"
          ? Object.freeze(error)
          : kind === "sealed"
            ? Object.seal(error)
            : kind === "non-error"
              ? "synthetic_non_error"
              : error;
      const original = UsTransformationStore.prototype.createDraftInTransaction;
      const spy = vi
        .spyOn(UsTransformationStore.prototype, "createDraftInTransaction")
        .mockImplementation(async function (this: UsTransformationStore, ...args) {
          await original.apply(this, args);
          throw failure;
        });
      const worker = outcome(new UsDatasetTransformationSeedStore(f.db).initialize(context, 259));
      test.onTestFinished(async () => {
        await worker;
        spy.mockRestore();
      });
      try {
        const response = await abortable(worker, test.signal);
        expect(response.error).toBe(failure);
        if (kind === "extensible")
          expect(response.error).toMatchObject({
            unitKey: c.input.chain.unitKey,
            stage: "transformation",
          });
        expect(await f.snapshot()).toEqual(before);
      } finally {
        await worker;
        spy.mockRestore();
      }
    },
  );
  it("legitimate native downstream consumption retains original bytes and write-free replay", async () => {
    const c = await prepareDatasetTransformation(f.db, context);
    const seed = new UsDatasetTransformationSeedStore(f.db);
    const result = await seed.initialize(context, 259);
    const output = result.createInput.draft.outputs[0];
    if (!output) throw new Error("Missing output");
    const saved = await c.stores.transformation.createDraft(
      context.tenantId,
      context.actorUserId,
      {
        operationKey: randomUUID(),
        draft: {
          ...result.createInput.draft,
          inputs: [
            { kind: "ftl_lot", lotId: result.outputLot.id, quantity: "1", unitOfMeasure: "case" },
          ],
          outputs: [{ ...output, tlc: "LEGITIMATE-DOWNSTREAM", quantity: "1" }],
        },
      },
      "downstream",
    );
    const ready = await c.stores.transformation.checkReadiness(
      context.tenantId,
      context.actorUserId,
      saved.id,
      { expectedDraftVersion: 1 },
    );
    expect(ready.state).toBe("complete");
    await c.stores.transformation.finalize(
      context.tenantId,
      context.actorUserId,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "downstream",
    );
    const before = await f.snapshot();
    expect(await seed.verify(context, 259)).toEqual(result);
    expect(await seed.initialize(context, 259)).toEqual(result);
    expect(await f.snapshot()).toEqual(before);
  });
  it.for(["failure", "cancellation"] as const)(
    "drains actual private writes on %s before readiness",
    async (kind, test) => {
      await capture();
      const before = await f.snapshot();
      const failure = new Error("owned_seed_pre_readiness_" + kind);
      const aborted = new AbortController();
      const entered = barrier();
      const original = UsTransformationStore.prototype.createDraftInTransaction;
      const observation = startObservation(
        {
          signal: AbortSignal.any([test.signal, aborted.signal]),
          onTestFinished: test.onTestFinished,
        },
        async (signal, ready) => {
          const spy = vi
            .spyOn(UsTransformationStore.prototype, "createDraftInTransaction")
            .mockImplementation(async function (this: UsTransformationStore, ...args) {
              const created = await original.apply(this, args);
              entered.release();
              if (kind === "failure") throw failure;
              await abortable(ready(), signal);
              return created;
            });
          try {
            await new UsDatasetTransformationSeedStore(f.db).initialize(context, 259);
          } finally {
            spy.mockRestore();
          }
        },
      );
      const readiness = outcome(observation.ready);
      try {
        await abortable(entered.promise, test.signal);
        if (kind === "cancellation") {
          await observation.ready;
          aborted.abort(failure);
        }
        expect((await observation.running).error).toBe(failure);
      } finally {
        await observation.cleanup();
      }
      await readiness;
      expect(await f.snapshot()).toEqual(before);
      const retried = await new UsDatasetTransformationSeedStore(f.db).initialize(context, 259);
      expect(retried.finalized.status).toBe("finalized");
    },
  );
  it(
    "cancels while native application is actually blocked and disposes owned backends",
    { timeout: 20000 },
    async (test) => {
      const c = await capture();
      const before = await f.snapshot();
      const aborted = new AbortController();
      const failure = new Error("owned_seed_blocked_cancellation");
      let workerPid = 0,
        blockerPid = 0;
      const observation = startObservation(
        {
          signal: AbortSignal.any([test.signal, aborted.signal]),
          onTestFinished: test.onTestFinished,
        },
        (signal, ready) =>
          withOwnedWork(async (own) => {
            if (!base) throw new Error("Missing isolated database");
            const url = new URL(base);
            url.pathname = "/" + f.databaseName;
            const connection = createDb(url.toString(), { max: 1, statement_timeout: 10000 });
            own("worker-pool", () => connection.pool.end());
            workerPid =
              (await connection.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
                .rows[0]?.pid ?? 0;
            const blocker = await f.pool.connect();
            ownClient(own, blocker, "blocker-rollback", () => blocker.query("ROLLBACK"));
            blockerPid =
              (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                ?.pid ?? 0;
            await blocker.query("BEGIN");
            await blocker.query(
              "SELECT id FROM receiving_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
              [context.tenantId, c.receiving.created.eventId],
            );
            const worker = outcome(
              new UsDatasetTransformationSeedStore(connection.db).initialize(context, 259),
            );
            own("worker-cancel-drain", async () => {
              try {
                await f.pool.query("SELECT pg_cancel_backend($1)", [workerPid]);
              } finally {
                await worker;
              }
            });
            await waitBlocked({ ...connection, pool: f.pool }, blockerPid, workerPid, signal);
            await abortable(ready(), signal);
          }),
      );
      try {
        await observation.ready;
        aborted.abort(failure);
        expect((await observation.running).error).toBe(failure);
      } finally {
        await observation.cleanup();
      }
      expect(await f.snapshot()).toEqual(before);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=ANY($1::int[])",
            [[workerPid, blockerPid]],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    },
  );
});
