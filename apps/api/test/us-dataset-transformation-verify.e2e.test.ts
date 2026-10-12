import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  composeDatasetTransformation,
  prepareDatasetTransformation,
} from "./support/us-dataset-transformation-fixture";
import { withOwnedWork, ownClient } from "./support/us-transformation-lock-fixture";
import { lockUsDatasetTransformation } from "../src/modules/traceability/demo/us-dataset-transformation-locks";
import { UsDatasetReceivingSeedStore } from "../src/modules/traceability/demo/us-dataset-receiving-seed";
import { verifyUsDatasetTransformation } from "../src/modules/traceability/demo/us-dataset-transformation-verify";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Dataset Transformation canonical verification", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated database");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  it("verifies real native evidence without changing a single persisted row", async () => {
    const context = await f.provision();
    const c = await composeDatasetTransformation(f.db, context);
    const before = await f.snapshot();
    await f.db.transaction((tx) =>
      verifyUsDatasetTransformation(tx, context, c.intent, c.receipt, c.stores, "replay"),
    );
    expect(await f.snapshot()).toEqual(before);
  }, 30000);
  it.for([0, 123, 259])(
    "verifies private native writes and subsequent canonical replay for chain %i",
    async (index) => {
      const context = await f.provision();
      const c = await prepareDatasetTransformation(f.db, context, index);
      const receipt = await f.db.transaction(async (tx) => {
        await lockUsDatasetTransformation(tx, context, {
          receiving: c.receiving,
          transformation: null,
        });
        const receipt = await c.apply(tx);
        await verifyUsDatasetTransformation(tx, context, c.intent, receipt, c.stores, "fresh");
        return receipt;
      });
      expect(receipt.result.finalized.snapshot.inputs.map((line) => line.quantity)).toEqual(
        c.input.chain.transformation.inputs.map((line) => line.quantity),
      );
      const before = await f.snapshot();
      await f.db.transaction((tx) =>
        verifyUsDatasetTransformation(tx, context, c.intent, receipt, c.stores, "replay"),
      );
      expect(await f.snapshot()).toEqual(before);
    },
  );

  it.for(["pending amendment", "finalized amendment", "void", "archive"] as const)(
    "rejects native %s without repairing rows",
    async (kind) => {
      const context = await f.provision();
      const c = await composeDatasetTransformation(f.db, context);
      const args = {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Synthetic verification drift",
      };
      if (kind === "archive")
        await c.stores.lots.changeStatus(
          context.tenantId,
          context.actorUserId,
          c.result.outputLot.id,
          { status: "archived", expectedRevision: 1, reason: args.reason },
          "archive-output",
        );
      else if (kind === "void")
        await c.stores.transformation.void(
          context.tenantId,
          context.actorUserId,
          c.result.created.id,
          args,
          "void-output",
        );
      else {
        const amended = await c.stores.transformation.amend(
          context.tenantId,
          context.actorUserId,
          c.result.created.id,
          args,
          "amend-output",
        );
        if (kind === "finalized amendment") {
          const ready = await c.stores.transformation.checkReadiness(
            context.tenantId,
            context.actorUserId,
            amended.eventId,
            { expectedDraftVersion: 1 },
          );
          expect(ready.state).toBe("complete");
          await c.stores.transformation.finalize(
            context.tenantId,
            context.actorUserId,
            amended.eventId,
            {
              operationKey: randomUUID(),
              expectedDraftVersion: 1,
              expectedInputDigest: ready.inputDigest,
            },
            "finalize-amendment",
          );
        }
      }
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          verifyUsDatasetTransformation(tx, context, c.intent, c.receipt, c.stores, "replay"),
        ),
      ).rejects.toThrow("us_dataset_transformation_mismatch");
      expect(await f.snapshot()).toEqual(before);
    },
  );

  it.for([
    ["output TLC", "traceability_lots", "tlc='CORRUPTED'", "id", "lot"],
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
      "source_locked_at=source_locked_at + interval '1 second'",
      "id",
      "lot",
    ],
    ["saved input", "transformation_event_inputs", "quantity='1'", "event_id", "event"],
    ["saved output", "transformation_event_outputs", "quantity='1'", "event_id", "event"],
    ["saved reason", "transformation_event_details", "reason='processing'", "event_id", "event"],
    ["event date", "traceability_events", "event_date='2026-09-13'", "id", "event"],
    [
      "frozen snapshot",
      "traceability_events",
      "finalization_snapshot=jsonb_set(finalization_snapshot,'{outputs,0,quantity}','\"1\"')",
      "id",
      "event",
    ],
    [
      "created time",
      "traceability_events",
      "created_at=created_at - interval '1 second'",
      "id",
      "event",
    ],
    ["document metadata", "reference_documents", "notes='Corrupted metadata'", "id", "document"],
    ["document issuer", "reference_documents", "party_id=NULL", "id", "document"],
    ["catalogue", "products", "name='Corrupted catalogue'", "id", "product"],
    [
      "operation digest",
      "transformation_operations",
      "input_digest=repeat('0',64)",
      "operation_key",
      "key",
    ],
    [
      "operation transaction clock",
      "transformation_operations",
      "created_at=created_at + interval '1 second'",
      "operation_key",
      "key",
    ],
    [
      "audit transaction clock",
      "tenant_audit_events",
      "created_at=created_at + interval '1 second'",
      "request_id",
      "key",
    ],
    [
      "operation response",
      "transformation_operations",
      "result=jsonb_set(result,'{eventNumber}','\"TRN-26-9999\"')",
      "operation_key",
      "key",
    ],
    ["audit actor", "tenant_audit_events", "actor_user_id=NULL", "request_id", "key"],
    ["audit before", "tenant_audit_events", "before='{}'::jsonb", "request_id", "key"],
    ["audit after", "tenant_audit_events", "after='{}'::jsonb", "request_id", "key"],
    ["audit action", "tenant_audit_events", "action='changed'", "request_id", "key"],
    ["audit outcome", "tenant_audit_events", "outcome='failure'", "request_id", "key"],
    ["audit target", "tenant_audit_events", "target_id='changed'", "request_id", "key"],
    ["audit request", "tenant_audit_events", "request_id='changed'", "request_id", "key"],
    [
      "genealogy substitution",
      "lot_genealogy_edges",
      "input_lot_id=(SELECT id FROM traceability_lots WHERE tenant_id=lot_genealogy_edges.tenant_id AND id NOT IN (SELECT input_lot_id FROM lot_genealogy_edges WHERE event_id=lot_genealogy_edges.event_id) AND id<>lot_genealogy_edges.output_lot_id LIMIT 1)",
      "event_id",
      "event",
    ],
  ] as const)(
    "rejects deliberately corrupted %s with full-row snapshot equality",
    async ([name, table, set, column, id]) => {
      const context = await f.provision();
      const c = await composeDatasetTransformation(f.db, context);
      if (name === "genealogy substitution") {
        await new UsDatasetReceivingSeedStore(f.db).initialize(context, 0);
      }
      const key =
        id === "lot"
          ? c.result.outputLot.id
          : id === "event"
            ? c.result.created.id
            : id === "document"
              ? c.result.documents[0]?.record.id
              : id === "product"
                ? c.result.outputLot.productId
                : c.intent.operationKey;
      // Only deliberately corrupt already native-created evidence in an owned child.
      await withOwnedWork(async (own) => {
        const client = await f.pool.connect();
        ownClient(own, client, "corruption-rollback", () => client.query("ROLLBACK"));
        await client.query("BEGIN");
        await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
        const filter = name === "genealogy substitution" ? " AND input_lot_id=$3" : "";
        await client.query(
          `UPDATE ${table} SET ${set} WHERE ${table === "tenant_audit_events" ? "organization_id" : "tenant_id"}=$1 AND ${column}=$2${filter}`,
          name === "genealogy substitution"
            ? [context.tenantId, key, c.result.inputLots[0]?.lotId]
            : [context.tenantId, key],
        );
        await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
        await client.query("COMMIT");
      });
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          verifyUsDatasetTransformation(tx, context, c.intent, c.receipt, c.stores, "replay"),
        ),
      ).rejects.toThrow("us_dataset_transformation_mismatch");
      expect(await f.snapshot()).toEqual(before);
    },
  );

  it("rejects a second current origin without following its foreign root", async () => {
    const context = await f.provision();
    const c = await composeDatasetTransformation(f.db, context);
    // Genuine second native root; only its output binding is corrupted afterwards.
    const saved = await c.stores.transformation.createDraft(
      context.tenantId,
      context.actorUserId,
      {
        ...c.result.createInput,
        operationKey: randomUUID(),
        draft: {
          ...c.result.createInput.draft,
          outputs: c.result.createInput.draft.outputs.map((line) => ({
            ...line,
            tlc: "NEGATIVE-SECOND-ORIGIN",
          })),
        },
      },
      "extra-origin",
    );
    const ready = await c.stores.transformation.checkReadiness(
      context.tenantId,
      context.actorUserId,
      saved.id,
      { expectedDraftVersion: 1 },
    );
    await c.stores.transformation.finalize(
      context.tenantId,
      context.actorUserId,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "extra-origin",
    );
    await withOwnedWork(async (own) => {
      const client = await f.pool.connect();
      ownClient(own, client, "extra-origin-corruption-rollback", () => client.query("ROLLBACK"));
      await client.query("BEGIN");
      await client.query("ALTER TABLE transformation_event_outputs DISABLE TRIGGER USER");
      await client.query(
        "UPDATE transformation_event_outputs SET lot_id=$3 WHERE tenant_id=$1 AND event_id=$2",
        [context.tenantId, saved.id, c.result.outputLot.id],
      );
      await client.query("ALTER TABLE transformation_event_outputs ENABLE TRIGGER USER");
      await client.query("COMMIT");
    });
    await withOwnedWork(async (own) => {
      const client = await f.pool.connect();
      ownClient(own, client, "foreign-root-rollback", () => client.query("ROLLBACK"));
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM transformation_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [context.tenantId, saved.id],
      );
      const before = await f.snapshot();
      await expect(
        f.db.transaction(async (tx) => {
          await tx.execute((await import("drizzle-orm")).sql`SET LOCAL lock_timeout='500ms'`);
          await verifyUsDatasetTransformation(tx, context, c.intent, c.receipt, c.stores, "replay");
        }),
      ).rejects.toThrow("us_dataset_transformation_mismatch");
      expect(await f.snapshot()).toEqual(before);
    });
  });

  it.for([
    "readiness digest",
    "operation key",
    "reference identity",
    "receiving identity",
  ] as const)("rejects rehashed %s receipt substitution", async (kind) => {
    const context = await f.provision();
    const c = await composeDatasetTransformation(f.db, context);
    const key = kind === "operation key" ? randomUUID() : c.intent.operationKey;
    const result = {
      ...c.result,
      createInput: { ...c.result.createInput, operationKey: key },
      finalizeInput: {
        ...c.result.finalizeInput,
        operationKey: key,
        expectedInputDigest:
          kind === "readiness digest" ? "0".repeat(64) : c.result.finalizeInput.expectedInputDigest,
      },
      input: {
        ...c.result.input,
        references: {
          ...c.result.input.references,
          operationKey:
            kind === "reference identity" ? randomUUID() : c.result.input.references.operationKey,
        },
        receiving: {
          ...c.result.input.receiving,
          operationKey:
            kind === "receiving identity" ? randomUUID() : c.result.input.receiving.operationKey,
        },
      },
    };
    const intent = {
      ...c.intent,
      operationKey: result.createInput.operationKey,
      input: result.input,
      inputDigest: canonicalExportDigest(result.input),
    };
    const receipt = { ...c.receipt, result, resultDigest: canonicalExportDigest(result) };
    const before = await f.snapshot();
    await expect(
      f.db.transaction((tx) =>
        verifyUsDatasetTransformation(tx, context, intent, receipt, c.stores, "replay"),
      ),
    ).rejects.toThrow("us_dataset_transformation_mismatch");
    expect(await f.snapshot()).toEqual(before);
  });

  it("accepts real downstream output consumption after dependency counters change", async () => {
    const context = await f.provision();
    const c = await composeDatasetTransformation(f.db, context);
    const tokens = () =>
      f.pool.query(
        "SELECT current_dependency_version FROM traceability_lots WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, c.result.outputLot.id],
      );
    const oldTokens = (await tokens()).rows;
    const saved = await c.stores.transformation.createDraft(
      context.tenantId,
      context.actorUserId,
      {
        operationKey: randomUUID(),
        draft: {
          ...c.result.createInput.draft,
          inputs: [
            { kind: "ftl_lot", lotId: c.result.outputLot.id, quantity: "1", unitOfMeasure: "case" },
          ],
          outputs: [
            {
              ...c.result.createInput.draft.outputs[0],
              tlc: "LEGITIMATE-DOWNSTREAM",
              quantity: "1",
            },
          ],
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
    expect((await tokens()).rows).not.toEqual(oldTokens);
    const before = await f.snapshot();
    await f.db.transaction((tx) =>
      verifyUsDatasetTransformation(tx, context, c.intent, c.receipt, c.stores, "replay"),
    );
    expect(await f.snapshot()).toEqual(before);
  });
  it("allows an unrelated public save command to reuse the UUID in its independent namespace", async () => {
    const context = await f.provision();
    const c = await composeDatasetTransformation(f.db, context);
    const draft = {
      eventDate: null,
      processorLocationId: null,
      reason: null,
      reasonNote: null,
      notes: null,
      inputs: [],
      outputs: [],
      documentIds: [],
    };
    const unrelated = await c.stores.transformation.createDraft(
      context.tenantId,
      context.actorUserId,
      { operationKey: randomUUID(), draft },
      "unrelated-native-create",
    );
    await c.stores.transformation.saveDraft(
      context.tenantId,
      context.actorUserId,
      unrelated.id,
      {
        operationKey: c.intent.operationKey,
        expectedDraftVersion: 1,
        draft: { ...draft, notes: "Unrelated command scope" },
      },
      "unrelated-native-save",
    );
    const operations = await f.pool.query<{ command: string; event_id: string }>(
      "SELECT command,event_id FROM transformation_operations WHERE tenant_id=$1 AND operation_key=$2 ORDER BY command",
      [context.tenantId, c.intent.operationKey],
    );
    expect(operations.rows).toEqual([
      { command: "transformation.create", event_id: c.result.created.id },
      { command: "transformation.finalize", event_id: c.result.created.id },
      { command: "transformation.save", event_id: unrelated.id },
    ]);
    const before = await f.snapshot();
    await f.db.transaction((tx) =>
      verifyUsDatasetTransformation(tx, context, c.intent, c.receipt, c.stores, "replay"),
    );
    expect(await f.snapshot()).toEqual(before);
  });
});
