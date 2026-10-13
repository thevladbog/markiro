import { canonicalExportDigest } from "@markiro/domain";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi, type TestContext } from "vitest";
import { UsDatasetCorrectedTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-transformation-seed";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetSpecialSeedStore } from "../src/modules/traceability/demo/us-dataset-special-seed";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { transformationCommandDigest } from "../src/modules/traceability/transformation/us-transformation-operations";
import { verifyUsDatasetCorrectedTransformation } from "../src/modules/traceability/demo/us-dataset-corrected-transformation-verify";
import { specialFixture, consumeSpecial } from "./support/us-dataset-special-fixture";
import {
  prepareDatasetCorrectedTransformation,
  correctedTransformationFault,
  corruptCorrectedTransformation,
  consumeCorrectedTransformation,
} from "./support/us-dataset-corrected-transformation-fixture";
import { outcome, barrier, abortable } from "./support/us-transformation-lock-fixture";
import { snapshotUsDatasetTables } from "./support/us-dataset-snapshot";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Corrected Transformation atomic execution", () => {
  const h = specialFixture(base);
  const seed = () => new UsDatasetCorrectedTransformationSeedStore(h.f.db);
  const journal = () => new UsDatasetJournalStore(h.f.db, usSixMonthDefinition);
  async function capture() {
    const c = await prepareDatasetCorrectedTransformation(h.f.db, h.context);
    const stage = await c.stores.journal.captureIntent(h.context, c.header.id, c.intent);
    return { ...c, stage };
  }
  it(
    "streams every public table with unchanged row hashes and bounded SQL round trips",
    h.phase(async () => {
      await h.f.pool.query(
        "CREATE TABLE public.us_snapshot_cursor_test_rows (body jsonb); CREATE TABLE public.us_snapshot_cursor_test_empty (body jsonb)",
      );
      try {
        await h.f.pool.query(
          "INSERT INTO public.us_snapshot_cursor_test_rows SELECT jsonb_build_object('index', n, 'unicode', 'Árbol 🌿', 'nullable', NULL) FROM generate_series(1, 129) n",
        );
        const tables = await h.f.pool.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        );
        const expected: Record<string, string> = {};
        let rowCount = 0;
        for (const { tablename } of tables.rows) {
          if (!/^[a-z_][a-z0-9_]*$/.test(tablename))
            throw new Error("Invalid owned snapshot table");
          const rows = await h.f.pool.query<{ body: unknown }>(
            `SELECT to_jsonb(t) AS body FROM public."${tablename}" t ORDER BY to_jsonb(t)::text`,
          );
          rowCount += rows.rows.length;
          Object.defineProperty(expected, tablename, {
            value: createHash("sha256")
              .update(JSON.stringify(rows.rows.map(({ body }) => body)))
              .digest("hex"),
            enumerable: true,
          });
        }
        const client = await h.f.pool.connect();
        const queries = vi.spyOn(client, "query");
        try {
          expect(await snapshotUsDatasetTables({ connect: async () => client })).toEqual(expected);
          expect(queries.mock.calls).toHaveLength(6 + Math.ceil(rowCount / 64));
          expect(
            queries.mock.calls
              .filter(([query]) => typeof query === "string" && query.startsWith("FETCH "))
              .every(([query]) => query === "FETCH 64 FROM dataset_snapshot"),
          ).toBe(true);
          expect(expected.us_snapshot_cursor_test_empty).toBe(
            createHash("sha256").update("[]").digest("hex"),
          );
        } finally {
          queries.mockRestore();
        }
      } finally {
        await h.f.pool.query(
          "DROP TABLE public.us_snapshot_cursor_test_rows; DROP TABLE public.us_snapshot_cursor_test_empty",
        );
      }
    }),
  );
  it(
    "installs actual amended 300/400 lb to 60 case and publishes its receipt atomically",
    h.phase(async () => {
      const c = await prepareDatasetCorrectedTransformation(h.f.db, h.context);
      const response = await outcome(
        new UsDatasetCorrectedTransformationSeedStore(h.f.db).initialize(h.context),
      );
      expect(response.error).toBeUndefined();
      const result = response.value;
      if (!result) throw new Error("Missing corrected result");
      expect(result.input.receivingOrigin).toEqual({
        rootId: c.original.created.eventId,
        eventId: c.lifecycle.finalized.eventId,
        revision: 2,
        lifecycleVersion: 4,
        inputLots: c.original.lots.map((lot, i) => ({ lineNo: i + 1, lotId: lot.id })),
      });
      expect(result.finalized.snapshot.eventDate).toBe("2026-06-11");
      expect(
        result.finalized.snapshot.inputs.map(({ quantity, unitOfMeasure }) => ({
          quantity,
          unitOfMeasure,
        })),
      ).toEqual([
        { quantity: "300", unitOfMeasure: "lb" },
        { quantity: "400", unitOfMeasure: "lb" },
      ]);
      expect(
        result.finalized.snapshot.outputs.map(({ quantity, unitOfMeasure }) => ({
          quantity,
          unitOfMeasure,
        })),
      ).toEqual([{ quantity: "60", unitOfMeasure: "case" }]);
      expect(c.original.finalized.record.content.kind).toBe("finalized");
      if (c.original.finalized.record.content.kind !== "finalized")
        throw new Error("Missing original snapshot");
      expect(
        c.original.finalized.record.content.snapshot.items.map(({ quantity }) => quantity),
      ).toEqual(["250", "400"]);
      expect(result.documents).toHaveLength(2);
      expect(
        (
          await h.f.pool.query(
            "SELECT (SELECT count(*)::int FROM transformation_event_roots) roots,(SELECT count(*)::int FROM traceability_lots WHERE assignment_basis='transformation') lots,(SELECT count(*)::int FROM lot_genealogy_edges) edges",
          )
        ).rows,
      ).toEqual([{ roots: 1, lots: 1, edges: 2 }]);
      const stage = await c.stores.journal.readStage(
        h.context,
        c.header.id,
        "correction_0001",
        "transformation",
      );
      expect(stage?.revision).toBe(2);
      expect(stage?.receipt).toEqual({
        result,
        resultDigest: canonicalExportDigest(result),
        recordIds: [
          ...result.documents.map(({ record }) => record.id),
          result.created.id,
          result.outputLot.id,
        ],
      });
      const key = result.createInput.operationKey;
      expect(
        (
          await h.f.pool.query(
            "SELECT tenant_id,command,operation_key,event_id,input_digest,result FROM transformation_operations ORDER BY command",
          )
        ).rows,
      ).toEqual([
        {
          tenant_id: h.context.tenantId,
          command: "transformation.create",
          operation_key: key,
          event_id: result.created.id,
          input_digest: transformationCommandDigest("transformation.create", result.createInput),
          result: result.created,
        },
        {
          tenant_id: h.context.tenantId,
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
      ].map((row) => ({
        ...row,
        organization_id: h.context.tenantId,
        actor_user_id: h.context.actorUserId,
        outcome: "success",
        request_id: key,
      }));
      expect(
        (
          await h.f.pool.query(
            "SELECT organization_id,actor_user_id,action,target_type,target_id,before,after,outcome,request_id FROM tenant_audit_events WHERE request_id=$1",
            [key],
          )
        ).rows
          .map(canonicalExportDigest)
          .sort(),
      ).toEqual(expectedAudits.map(canonicalExportDigest).sort());
      const basis = await c.stores.receiving.getLotReceivingBasis(
        h.context.tenantId,
        h.context.actorUserId,
        result.inputLots[0]?.lotId,
        { limit: 100, offset: 0 },
      );
      expect(basis.state).toBe("present");
      expect(basis.supportCount).toBe(1);
      expect(basis.items).toEqual([
        {
          rootId: c.original.created.eventId,
          eventId: c.lifecycle.finalized.eventId,
          eventNumber: c.lifecycle.finalized.record.eventNumber,
          revision: 2,
          lineNos: [1],
        },
      ]);
      const before = await h.f.snapshot();
      const seed = new UsDatasetCorrectedTransformationSeedStore(h.f.db);
      expect(await seed.verify(h.context)).toEqual(result);
      expect(await seed.initialize(h.context)).toEqual(result);
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );

  it.for([
    "missing dataset",
    "missing references",
    "pending references",
    "missing original",
    "pending original",
    "missing amendment",
    "pending amendment",
  ])(
    "rejects %s without installing prerequisites",
    h.phase(async (kind) => {
      if (kind !== "missing dataset") {
        const header = kind.includes("references")
          ? await journal().initialize(h.context)
          : (await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context),
            await journal().read(h.context));
        if (!header) throw new Error("Missing fixture header");
        if (kind.includes("amendment"))
          await new UsDatasetSpecialSeedStore(h.f.db).initializeReceiving(h.context, "correction");
        if (kind.startsWith("pending")) {
          const stage =
            kind === "pending references"
              ? "references"
              : kind === "pending original"
                ? "receiving"
                : "amend_receiving";
          await journal().captureIntent(h.context, header.id, {
            unitKey: stage === "references" ? "references" : "correction_0001",
            stage,
            operationKey: randomUUID(),
            input: {},
            inputDigest: canonicalExportDigest({}),
          });
        }
      }
      const before = await h.f.snapshot();
      await expect(seed().initialize(h.context)).rejects.toThrow(
        "us_dataset_corrected_transformation_prerequisite_incomplete",
      );
      await expect(seed().verify(h.context)).rejects.toThrow(
        "us_dataset_corrected_transformation_prerequisite_incomplete",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it(
    "verify does not capture absent work or apply pending intent",
    h.phase(async () => {
      const c = await prepareDatasetCorrectedTransformation(h.f.db, h.context);
      const absent = await h.f.snapshot();
      await expect(seed().verify(h.context)).rejects.toThrow(
        "us_dataset_corrected_transformation_prerequisite_incomplete",
      );
      expect(await h.f.snapshot()).toEqual(absent);
      await c.stores.journal.captureIntent(h.context, c.header.id, c.intent);
      const pending = await h.f.snapshot();
      await expect(seed().verify(h.context)).rejects.toThrow(
        "us_dataset_corrected_transformation_prerequisite_incomplete",
      );
      expect(await h.f.snapshot()).toEqual(pending);
    }),
  );
  it.for(["actor", "tenant", "database", "user", "role", "provenance", "profile"])(
    "denies wrong %s before evidence or mutations",
    h.phase(async (kind) => {
      await capture();
      const target = {
        ...h.context,
        ...(kind === "actor"
          ? { actorUserId: randomUUID() }
          : kind === "tenant"
            ? { tenantId: randomUUID() }
            : kind === "database"
              ? { expectedDatabaseName: "markiro_us_dev" }
              : {}),
      };
      if (kind === "role")
        await h.f.pool.query("UPDATE member SET role='viewer' WHERE organization_id=$1", [
          h.context.tenantId,
        ]);
      if (kind === "provenance")
        await h.f.pool.query(
          "UPDATE tenant_audit_events SET outcome='failure' WHERE organization_id=$1 AND action='us.development.owner.provisioned'",
          [h.context.tenantId],
        );
      if (kind === "profile")
        await h.f.pool.query("UPDATE org_profiles SET time_zone='UTC' WHERE tenant_id=$1", [
          h.context.tenantId,
        ]);
      const db = kind === "user" ? await h.f.alternateRole() : h.f.db;
      const before = await h.f.snapshot();
      await expect(
        new UsDatasetCorrectedTransformationSeedStore(db).initialize(target),
      ).rejects.toThrow("us_dataset_target_invalid");
      await expect(
        new UsDatasetCorrectedTransformationSeedStore(db).verify(target),
      ).rejects.toThrow("us_dataset_target_invalid");
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );

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
    "rolls back all tables at %s and resumes the captured key",
    h.phase(async ([name, table, action, condition], test) => {
      if (!name || !table || !action || !condition) throw new Error("Missing fault definition");
      const c = await capture();
      const code = name === "40001" || name === "40P01" ? name : "P0001";
      const remove = await correctedTransformationFault(
        h.f,
        table,
        action,
        condition,
        code,
        name === "verifier",
      );
      const before = await h.f.snapshot();
      let originalFailure: unknown;
      const actual = UsTransformationStore.prototype.finalizeInTransaction;
      const finalization = vi
        .spyOn(UsTransformationStore.prototype, "finalizeInTransaction")
        .mockImplementation(async function (this: UsTransformationStore, ...args) {
          try {
            return await actual.apply(this, args);
          } catch (error) {
            originalFailure = error;
            throw error;
          }
        });
      const create = vi.spyOn(UsTransformationStore.prototype, "createDraftInTransaction");
      let worker: ReturnType<typeof outcome> | undefined;
      const cleanup = async () => {
        await worker;
        create.mockRestore();
        finalization.mockRestore();
        await remove();
      };
      test.onTestFinished(cleanup);
      try {
        worker = outcome(seed().initialize(h.context));
        const response = await abortable(worker, test.signal);
        if (name === "verifier")
          expect(response.error).toMatchObject({
            message: "us_dataset_corrected_transformation_mismatch",
          });
        else
          expect(response.error).toMatchObject({
            cause: { code },
            unitKey: "correction_0001",
            stage: "transformation",
          });
        if (name === "40001" || name === "40P01") expect(response.error).toBe(originalFailure);
        expect(create).toHaveBeenCalledTimes(name === "second document" ? 0 : 1);
        expect(await h.f.snapshot()).toEqual(before);
        expect(
          await c.stores.journal.readStage(
            h.context,
            c.header.id,
            "correction_0001",
            "transformation",
          ),
        ).toEqual(c.stage);
      } finally {
        await cleanup();
      }
      expect((await seed().initialize(h.context)).createInput.operationKey).toBe(
        c.intent.operationKey,
      );
    }),
  );

  it(
    "concurrent captures converge on one actual root, output and receipt",
    h.phase(async (_test: TestContext) => {
      await prepareDatasetCorrectedTransformation(h.f.db, h.context);
      const arrived = barrier(),
        release = barrier();
      let count = 0;
      const actual = UsDatasetJournalStore.prototype.captureIntent;
      const spy = vi
        .spyOn(UsDatasetJournalStore.prototype, "captureIntent")
        .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
          count++;
          if (count === 2) arrived.release();
          await release.promise;
          return actual.apply(this, args);
        });
      const workers: ReturnType<typeof outcome>[] = [];
      const cleanup = async () => {
        release.release();
        await Promise.allSettled(workers);
        spy.mockRestore();
      };
      _test.onTestFinished(cleanup);
      try {
        workers.push(outcome(seed().initialize(h.context)), outcome(seed().initialize(h.context)));
        await abortable(
          Promise.race([
            arrived.promise,
            ...workers.map((worker) =>
              worker.then((r) => {
                if (r.error) throw r.error;
              }),
            ),
          ]),
          _test.signal,
        );
        release.release();
        const responses = await Promise.all(workers);
        expect(responses.map((r) => r.error)).toEqual([undefined, undefined]);
        expect(JSON.stringify(responses[0]?.value)).toBe(JSON.stringify(responses[1]?.value));
        expect(count).toBe(2);
        expect(
          (
            await h.f.pool.query(
              "SELECT (SELECT count(*)::int FROM transformation_event_roots) roots,(SELECT count(*)::int FROM traceability_lots) lots,(SELECT count(*)::int FROM traceability_demo_dataset_stages WHERE stage='transformation') receipts",
            )
          ).rows,
        ).toEqual([{ roots: 1, lots: 3, receipts: 1 }]);
      } finally {
        await cleanup();
      }
    }),
  );
  it(
    "native failure leaves only its newly durable pending intent and resumes the same operation",
    h.phase(async () => {
      const c = await prepareDatasetCorrectedTransformation(h.f.db, h.context);
      const before = await h.f.snapshot();
      const remove = await correctedTransformationFault(
        h.f,
        "reference_documents",
        "INSERT",
        "(SELECT count(*) FROM reference_documents)=3",
      );
      try {
        await expect(seed().initialize(h.context)).rejects.toMatchObject({
          cause: { code: "P0001" },
        });
      } finally {
        await remove();
      }
      const after = await h.f.snapshot();
      const { traceability_demo_dataset_stages: _beforeStages, ...beforeBusiness } = before;
      const { traceability_demo_dataset_stages: _afterStages, ...afterBusiness } = after;
      void [_beforeStages, _afterStages];
      expect(afterBusiness).toEqual(beforeBusiness);
      expect(after.traceability_demo_dataset_stages).not.toBe(
        before.traceability_demo_dataset_stages,
      );
      const pending = await c.stores.journal.readStage(
        h.context,
        c.header.id,
        "correction_0001",
        "transformation",
      );
      expect(pending?.revision).toBe(1);
      expect(pending?.receipt).toBeNull();
      expect(pending?.intent.input).toEqual(c.input);
      expect((await seed().initialize(h.context)).createInput.operationKey).toBe(
        pending?.intent.operationKey,
      );
    }),
  );
  it(
    "recovers the committed receipt after lost acknowledgement without new writes",
    h.phase(async () => {
      const c = await capture();
      const actual = UsDatasetJournalStore.prototype.runAtomicStage;
      const failure = new Error("Synthetic lost post-commit acknowledgement");
      const spy = vi
        .spyOn(UsDatasetJournalStore.prototype, "runAtomicStage")
        .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
          await actual.apply(this, args);
          throw failure;
        });
      try {
        await expect(seed().initialize(h.context)).rejects.toBe(failure);
      } finally {
        spy.mockRestore();
      }
      const stage = await c.stores.journal.readStage(
        h.context,
        c.header.id,
        "correction_0001",
        "transformation",
      );
      expect(stage?.receipt).not.toBeNull();
      const before = await h.f.snapshot();
      expect(await seed().initialize(h.context)).toEqual(stage?.receipt?.result);
      expect(await seed().verify(h.context)).toEqual(stage?.receipt?.result);
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );

  it(
    "rejects unreceipted native writes instead of adopting their commands/documents/output",
    h.phase(async () => {
      const c = await capture();
      await h.f.db.transaction(c.apply);
      const before = await h.f.snapshot();
      await expect(seed().initialize(h.context)).rejects.toThrow(
        "us_dataset_corrected_transformation_conflict",
      );
      await expect(seed().verify(h.context)).rejects.toThrow(
        "us_dataset_corrected_transformation_prerequisite_incomplete",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it.for(["document", "output"])(
    "rejects preexisting recipe %s conflict without adoption",
    h.phase(async (kind) => {
      const c = await capture();
      if (kind === "document") {
        const d = c.input.chain.documents.find(
          (d) => d.input.number === c.input.chain.transformation.references[0],
        );
        const partyId = c.references.bindings.parties.find((e) => e.key === d?.partyKey)?.id;
        if (!d || !partyId) throw new Error("Missing document binding");
        await c.stores.documents.createDocument(
          h.context.tenantId,
          h.context.actorUserId,
          { ...d.input, partyId },
          randomUUID(),
        );
      } else {
        const sourceLocationId = c.references.bindings.locations.find(
          (e) => e.key === c.input.chain.transformation.locationKey,
        )?.id;
        const productId = c.references.bindings.products.find(
          (e) => e.key === c.input.chain.transformation.output.productKey,
        )?.id;
        if (!sourceLocationId || !productId) throw new Error("Missing output binding");
        await c.stores.lots.createLot(
          h.context.tenantId,
          h.context.actorUserId,
          {
            productId,
            tlc: c.input.chain.transformation.output.tlc,
            assignmentBasis: "imported",
            source: { kind: "location", locationId: sourceLocationId },
          },
          randomUUID(),
        );
      }
      const before = await h.f.snapshot();
      await expect(seed().initialize(h.context)).rejects.toThrow(
        "us_dataset_corrected_transformation_conflict",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );

  it.for([
    "pending transformation",
    "finalized transformation",
    "void transformation",
    "pending receiving",
    "archive",
  ])(
    "rejects actual current %s drift without writes",
    h.phase(async (kind) => {
      const c = await prepareDatasetCorrectedTransformation(h.f.db, h.context);
      const result = await seed().initialize(h.context);
      const args = {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Synthetic lifecycle drift",
      };
      if (kind === "archive")
        await c.stores.lots.changeStatus(
          h.context.tenantId,
          h.context.actorUserId,
          result.outputLot.id,
          { status: "archived", expectedRevision: 1, reason: args.reason },
          randomUUID(),
        );
      else if (kind === "pending receiving")
        await c.stores.receiving.amend(
          h.context.tenantId,
          h.context.actorUserId,
          c.lifecycle.finalized.eventId,
          { ...args, commandVersion: 2, expectedLifecycleVersion: 4 },
          randomUUID(),
        );
      else if (kind === "void transformation")
        await c.stores.transformation.void(
          h.context.tenantId,
          h.context.actorUserId,
          result.created.id,
          args,
          randomUUID(),
        );
      else {
        const amended = await c.stores.transformation.amend(
          h.context.tenantId,
          h.context.actorUserId,
          result.created.id,
          args,
          randomUUID(),
        );
        if (kind === "finalized transformation") {
          const ready = await c.stores.transformation.checkReadiness(
            h.context.tenantId,
            h.context.actorUserId,
            amended.eventId,
            { expectedDraftVersion: 1 },
          );
          expect(ready.state).toBe("complete");
          await c.stores.transformation.finalize(
            h.context.tenantId,
            h.context.actorUserId,
            amended.eventId,
            {
              operationKey: randomUUID(),
              expectedDraftVersion: 1,
              expectedInputDigest: ready.inputDigest,
            },
            randomUUID(),
          );
        }
      }
      const before = await h.f.snapshot();
      await expect(seed().initialize(h.context)).rejects.toThrow(
        "us_dataset_corrected_transformation_mismatch",
      );
      await expect(seed().verify(h.context)).rejects.toThrow(
        "us_dataset_corrected_transformation_mismatch",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );

  it.for(["pending", "finalized", "void"])(
    "rejects %s Receiving origin before applying a captured stage",
    h.phase(async (kind) => {
      const c = await capture();
      const args = {
        commandVersion: 2 as const,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 4,
        reason: "Synthetic stale current origin",
      };
      if (kind === "void")
        await c.stores.receiving.void(
          h.context.tenantId,
          h.context.actorUserId,
          c.lifecycle.finalized.eventId,
          { ...args, expectedDraftVersion: null },
          randomUUID(),
        );
      else {
        const pending = await c.stores.receiving.amend(
          h.context.tenantId,
          h.context.actorUserId,
          c.lifecycle.finalized.eventId,
          args,
          randomUUID(),
        );
        if (kind === "finalized") {
          const ready = await c.stores.receiving.checkRevisionReadiness(
            h.context.tenantId,
            h.context.actorUserId,
            pending.eventId,
            { expectedDraftVersion: pending.record.draftVersion },
          );
          expect(ready.state).toBe("complete");
          await c.stores.receiving.finalizeRevision(
            h.context.tenantId,
            h.context.actorUserId,
            pending.eventId,
            {
              commandVersion: 2,
              operationKey: randomUUID(),
              expectedDraftVersion: ready.draftVersion,
              expectedLifecycleVersion: ready.expectedLifecycleVersion,
              previousRevisionId: ready.previousRevisionId,
              reviewedExemptLines: [],
              expectedInputDigest: ready.inputDigest,
            },
            randomUUID(),
          );
        }
      }
      const before = await h.f.snapshot();
      await expect(seed().initialize(h.context)).rejects.toThrow(
        "us_dataset_corrected_transformation_mismatch",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );

  it.for([
    ["output TLC", "traceability_lots", "tlc='Synthetic-corrupted'", "id", "lot"],
    [
      "output product",
      "traceability_lots",
      "product_id=(SELECT id FROM products WHERE tenant_id=traceability_lots.tenant_id AND id<>traceability_lots.product_id LIMIT 1)",
      "id",
      "lot",
    ],
    [
      "output source",
      "traceability_lots",
      "source_location_id=(SELECT id FROM traceability_locations WHERE tenant_id=traceability_lots.tenant_id AND id<>traceability_lots.source_location_id LIMIT 1)",
      "id",
      "lot",
    ],
    [
      "source lock",
      "traceability_lots",
      "source_locked_at=source_locked_at+interval '1 second'",
      "id",
      "lot",
    ],
    ["saved input", "transformation_event_inputs", "quantity='1'", "event_id", "event"],
    ["saved output", "transformation_event_outputs", "quantity='1'", "event_id", "event"],
    [
      "frozen history",
      "traceability_events",
      "finalization_snapshot=jsonb_set(finalization_snapshot,'{outputs,0,quantity}','\"1\"')",
      "id",
      "event",
    ],
    ["document metadata", "reference_documents", "notes='Synthetic drift'", "id", "document"],
    [
      "operation digest",
      "transformation_operations",
      "input_digest=repeat('0',64)",
      "operation_key",
      "key",
    ],
    [
      "operation response",
      "transformation_operations",
      "result=jsonb_set(result,'{eventNumber}','\"TRN-26-9999\"')",
      "operation_key",
      "key",
    ],
    [
      "operation clock",
      "transformation_operations",
      "created_at=created_at+interval '1 second'",
      "operation_key",
      "key",
    ],
    [
      "audit clock",
      "tenant_audit_events",
      "created_at=created_at+interval '1 second'",
      "request_id",
      "key",
    ],
    ["audit actor", "tenant_audit_events", "actor_user_id=NULL", "request_id", "key"],
    ["audit action", "tenant_audit_events", "action='changed'", "request_id", "key"],
    ["audit target", "tenant_audit_events", "target_id='changed'", "request_id", "key"],
    ["audit result", "tenant_audit_events", "after='{}'::jsonb", "request_id", "key"],
    ["audit before", "tenant_audit_events", "before='{}'::jsonb", "request_id", "key"],
    ["audit request", "tenant_audit_events", "request_id='changed'", "request_id", "key"],
    ["audit outcome", "tenant_audit_events", "outcome='failure'", "request_id", "key"],
    ["genealogy removal", "lot_genealogy_edges", "", "event_id", "event"],
  ])(
    "rejects changed business evidence %s and repairs nothing",
    h.phase(async ([name, table, set, column, id]) => {
      if (!table || !column) throw new Error("Missing drift definition");
      await prepareDatasetCorrectedTransformation(h.f.db, h.context);
      const result = await seed().initialize(h.context);
      const key =
        id === "lot"
          ? result.outputLot.id
          : id === "event"
            ? result.created.id
            : id === "document"
              ? result.documents[0]?.record.id
              : result.createInput.operationKey;
      await corruptCorrectedTransformation(
        h.f,
        table,
        name === "genealogy removal"
          ? "DELETE FROM lot_genealogy_edges WHERE tenant_id=$1 AND event_id=$2"
          : `UPDATE ${table} SET ${set} WHERE ${table === "tenant_audit_events" ? "organization_id" : "tenant_id"}=$1 AND ${column}=$2`,
        [h.context.tenantId, key],
      );
      const before = await h.f.snapshot();
      await expect(seed().verify(h.context)).rejects.toThrow(
        "us_dataset_corrected_transformation_mismatch",
      );
      await expect(seed().initialize(h.context)).rejects.toThrow(
        "us_dataset_corrected_transformation_mismatch",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );

  it.for(["input digest", "result digest", "amendment identity"])(
    "rejects forged stored journal %s without repair",
    h.phase(async (kind) => {
      const c = await capture();
      await seed().initialize(h.context);
      const stage = kind === "amendment identity" ? "amend_receiving" : "transformation";
      const set =
        kind === "input digest"
          ? "input_digest=repeat('0',64)"
          : kind === "result digest"
            ? "receipt=jsonb_set(receipt,'{resultDigest}',to_jsonb(repeat('0',64)))"
            : "operation_key=$3";
      await corruptCorrectedTransformation(
        h.f,
        "traceability_demo_dataset_stages",
        "UPDATE traceability_demo_dataset_stages SET " +
          set +
          " WHERE tenant_id=$1 AND stage=$2 AND unit_key='correction_0001'",
        kind === "amendment identity"
          ? [h.context.tenantId, stage, randomUUID()]
          : [h.context.tenantId, stage],
      );
      const before = await h.f.snapshot();
      await expect(seed().initialize(h.context)).rejects.toThrow();
      await expect(seed().verify(h.context)).rejects.toThrow();
      expect(await h.f.snapshot()).toEqual(before);
      expect(await journal().read(h.context)).toEqual(c.header);
    }),
  );

  it.for([
    "readiness digest",
    "operation key",
    "references",
    "amendment",
    "different stage",
    "orphan",
  ])(
    "rejects rehashed forged %s evidence without writes",
    h.phase(async (kind) => {
      const c = await capture();
      const result = await seed().initialize(h.context);
      const input = {
        ...result.input,
        references: {
          ...result.input.references,
          operationKey: kind === "references" ? randomUUID() : result.input.references.operationKey,
        },
        amendment: {
          ...result.input.amendment,
          operationKey: kind === "amendment" ? randomUUID() : result.input.amendment.operationKey,
        },
      };
      const key = kind === "operation key" ? randomUUID() : result.createInput.operationKey;
      const forged = {
        ...result,
        input,
        createInput: { ...result.createInput, operationKey: key },
        finalizeInput: {
          ...result.finalizeInput,
          operationKey: key,
          expectedInputDigest:
            kind === "readiness digest" ? "0".repeat(64) : result.finalizeInput.expectedInputDigest,
        },
      };
      const intent = {
        ...c.intent,
        unitKey: kind === "orphan" ? "orphan_0001" : c.intent.unitKey,
        stage: kind === "different stage" ? ("receiving" as const) : c.intent.stage,
        operationKey: key,
        input,
        inputDigest: canonicalExportDigest(input),
      };
      const receipt = {
        result: forged,
        resultDigest: canonicalExportDigest(forged),
        recordIds: [
          ...result.documents.map(({ record }) => record.id),
          result.created.id,
          result.outputLot.id,
        ],
      };
      const before = await h.f.snapshot();
      await expect(
        h.f.db.transaction((tx) =>
          verifyUsDatasetCorrectedTransformation(
            tx,
            h.context,
            intent,
            receipt,
            c.stores,
            "replay",
          ),
        ),
      ).rejects.toThrow("us_dataset_corrected_transformation_mismatch");
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it(
    "accepts legitimate downstream technical token changes and rejects an orphan attempt by rollback",
    h.phase(async () => {
      await prepareDatasetCorrectedTransformation(h.f.db, h.context);
      const result = await seed().initialize(h.context);
      const tokens = () =>
        h.f.pool.query(
          "SELECT current_dependency_version,receiving_basis_version FROM traceability_lots WHERE id=$1",
          [result.outputLot.id],
        );
      const old = (await tokens()).rows;
      await consumeCorrectedTransformation(h.f.db, h.context, result);
      expect((await tokens()).rows).not.toEqual(old);
      const before = await h.f.snapshot();
      expect(await seed().initialize(h.context)).toEqual(result);
      expect(await seed().verify(h.context)).toEqual(result);
      expect(await h.f.snapshot()).toEqual(before);
      const orphan = await new UsDatasetSpecialSeedStore(h.f.db).initialize(h.context, "orphan");
      const orphanBefore = await h.f.snapshot();
      await expect(consumeSpecial(h.f.db, h.context, orphan)).rejects.toThrow();
      expect(await h.f.snapshot()).toEqual(orphanBefore);
    }),
  );
  it(
    "rejects an extra current origin without acquiring its unrelated root",
    h.phase(async () => {
      const c = await capture();
      const result = await seed().initialize(h.context);
      const consumer = await consumeCorrectedTransformation(h.f.db, h.context, result);
      await corruptCorrectedTransformation(
        h.f,
        "transformation_event_outputs",
        "UPDATE transformation_event_outputs SET lot_id=$3 WHERE tenant_id=$1 AND event_id=$2",
        [h.context.tenantId, consumer.id, result.outputLot.id],
      );
      const gate = await h.f.pool.connect();
      try {
        await gate.query("BEGIN");
        await gate.query(
          "SELECT id FROM transformation_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [h.context.tenantId, consumer.id],
        );
        const before = await h.f.snapshot();
        await expect(
          h.f.db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
            await verifyUsDatasetCorrectedTransformation(
              tx,
              h.context,
              c.intent,
              {
                result,
                resultDigest: canonicalExportDigest(result),
                recordIds: [
                  ...result.documents.map(({ record }) => record.id),
                  result.created.id,
                  result.outputLot.id,
                ],
              },
              c.stores,
              "replay",
            );
          }),
        ).rejects.toThrow("us_dataset_corrected_transformation_mismatch");
        expect(await h.f.snapshot()).toEqual(before);
      } finally {
        try {
          await gate.query("ROLLBACK");
        } finally {
          gate.release();
        }
      }
    }),
  );
});
