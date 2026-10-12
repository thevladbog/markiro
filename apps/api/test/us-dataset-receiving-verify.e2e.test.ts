import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import type { ReceivingDraft } from "@markiro/platform-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
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

describe.skipIf(!base)("Dataset Receiving canonical current verification", () => {
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

  it("verifies real service evidence without any writes", async () => {
    const c = await compose();
    const before = await f.snapshot();
    expect(await c.verify()).toEqual(c.stage);
    expect(await f.snapshot()).toEqual(before);
  });
  it("rejects changed current document without repairing it", async () => {
    const c = await compose();
    await f.pool.query(
      "UPDATE reference_documents SET number='CORRUPTED' WHERE tenant_id=$1 AND id=$2",
      [context.tenantId, c.result.documents[0]?.record.id],
    );
    const before = await f.snapshot();
    await expect(c.verify()).rejects.toThrow("us_dataset_receiving_mismatch");
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(["pending amendment", "replacement", "void", "archived lot"])(
    "rejects public %s despite historical acknowledgements",
    async (change) => {
      const c = await compose();
      const args = {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Synthetic drift",
      };
      if (change === "archived lot")
        await stores.lots.changeStatus(
          context.tenantId,
          context.actorUserId,
          c.result.lots[0]?.id,
          { status: "archived", expectedRevision: 1, reason: "Synthetic drift" },
          "archive",
        );
      else if (change === "void")
        await stores.receiving.void(
          context.tenantId,
          context.actorUserId,
          c.result.created.eventId,
          { ...args, expectedDraftVersion: null },
          "void",
        );
      else {
        const amended = await stores.receiving.amend(
          context.tenantId,
          context.actorUserId,
          c.result.created.eventId,
          args,
          "amend",
        );
        if (change === "replacement") {
          const ready = await stores.receiving.checkRevisionReadiness(
            context.tenantId,
            context.actorUserId,
            amended.eventId,
            { expectedDraftVersion: 1 },
          );
          await stores.receiving.finalizeCommand(
            context.tenantId,
            context.actorUserId,
            amended.eventId,
            {
              commandVersion: 2,
              operationKey: randomUUID(),
              expectedDraftVersion: 1,
              expectedLifecycleVersion: ready.expectedLifecycleVersion,
              previousRevisionId: ready.previousRevisionId,
              expectedInputDigest: ready.inputDigest,
              reviewedExemptLines: [],
            },
            "replacement",
          );
        }
      }
      const before = await f.snapshot();
      await expect(c.verify()).rejects.toThrow("us_dataset_receiving_mismatch");
      expect(await f.snapshot()).toEqual(before);
    },
  );

  it.each([
    ["lot TLC", "traceability_lots", "tlc='CORRUPTED'", "id", "lot"],
    [
      "lot source lock",
      "traceability_lots",
      "source_locked_at=source_locked_at + interval '1 second'",
      "id",
      "lot",
    ],
    [
      "snapshot quantity",
      "traceability_events",
      "finalization_snapshot=jsonb_set(finalization_snapshot, '{items,0,quantity}', '\"499\"')",
      "id",
      "event",
    ],
    ["event date", "traceability_events", "event_date='2026-09-13'", "id", "event"],
    ["saved line quantity", "receiving_event_items", "quantity='499'", "event_id", "event"],
    [
      "saved source",
      "receiving_event_items",
      "source_location_id=(SELECT id FROM traceability_locations WHERE tenant_id=receiving_event_items.tenant_id AND id<>receiving_event_items.source_location_id ORDER BY id LIMIT 1)",
      "event_id",
      "event",
    ],
    ["document parent", "reference_documents", "party_id=NULL", "id", "document"],
    ["document metadata", "reference_documents", "notes='Changed metadata'", "id", "document"],
    ["audit actor", "tenant_audit_events", "actor_user_id=NULL", "request_id", "key"],
    ["audit before", "tenant_audit_events", "before='{}'::jsonb", "request_id", "key"],
    ["audit outcome", "tenant_audit_events", "outcome='failure'", "request_id", "key"],
    ["audit target", "tenant_audit_events", "target_id='changed'", "request_id", "key"],
    ["audit action", "tenant_audit_events", "action='changed'", "request_id", "key"],
    ["audit request", "tenant_audit_events", "request_id='changed'", "request_id", "key"],
    ["audit after", "tenant_audit_events", "after='{}'::jsonb", "request_id", "key"],
    [
      "operation digest",
      "receiving_operations",
      "input_digest=repeat('0',64)",
      "operation_key",
      "key",
    ],
  ])("rejects independently corrupted %s", async (_name, table, set, column, id) => {
    const c = await compose();
    const key =
      id === "lot"
        ? c.result.lots[0]?.id
        : id === "event"
          ? c.result.created.eventId
          : id === "document"
            ? c.result.documents[0]?.record.id
            : c.stage.intent.operationKey;
    // Negative-only database evidence: service-created immutable history is deliberately corrupted.
    const client = await f.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      await client.query(
        `UPDATE ${table} SET ${set} WHERE ${table === "tenant_audit_events" ? "organization_id" : "tenant_id"}=$1 AND ${column}=$2`,
        [context.tenantId, key],
      );
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const before = await f.snapshot();
    await expect(c.verify()).rejects.toThrow("us_dataset_receiving_mismatch");
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(["party", "location", "profile"])("rejects public %s parent edits", async (kind) => {
    const c = await compose();
    if (kind === "party")
      await stores.master.updateParty(
        context.tenantId,
        context.actorUserId,
        c.references.bindings.parties[0]?.id,
        { name: "Synthetic changed" },
        "parent",
      );
    else if (kind === "location")
      await stores.master.updateLocation(
        context.tenantId,
        context.actorUserId,
        c.references.bindings.locations[0]?.id,
        { businessName: "Synthetic changed" },
        "parent",
      );
    else {
      const profile = c.references.evidence.profiles[0];
      if (!profile) throw new Error("Missing profile");
      const { productId, revision, reviewedBy, reviewedAt, createdAt, updatedAt, ...editable } =
        profile;
      void [reviewedBy, reviewedAt, createdAt, updatedAt];
      await stores.profiles.putProfile(
        context.tenantId,
        context.actorUserId,
        productId,
        { ...editable, expectedRevision: revision, productName: "Synthetic changed" },
        "parent",
      );
    }
    const before = await f.snapshot();
    await expect(c.verify()).rejects.toThrow("us_dataset_receiving_mismatch");
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(["unit", "key", "dependency", "dependency input digest", "dependency result digest"])(
    "rejects recomputed-digest %s substitution",
    async (kind) => {
      const c = await compose();
      const intent = {
        ...c.stage.intent,
        unitKey: kind === "unit" ? "chain_0000" : c.stage.intent.unitKey,
      };
      const key = kind === "key" ? randomUUID() : c.result.created.operationKey;
      const result = {
        ...c.result,
        created: { ...c.result.created, operationKey: key },
        finalized: { ...c.result.finalized, operationKey: key },
        input: {
          ...c.result.input,
          references: {
            ...c.result.input.references,
            operationKey:
              kind === "dependency" ? randomUUID() : c.result.input.references.operationKey,
            inputDigest:
              kind === "dependency input digest"
                ? "0".repeat(64)
                : c.result.input.references.inputDigest,
            resultDigest:
              kind === "dependency result digest"
                ? "0".repeat(64)
                : c.result.input.references.resultDigest,
          },
        },
      };
      const receipt = {
        recordIds: usDatasetReceivingRecordIds(result),
        result,
        resultDigest: canonicalExportDigest(result),
      };
      const substitutedIntent = kind.startsWith("dependency")
        ? { ...intent, input: result.input, inputDigest: canonicalExportDigest(result.input) }
        : intent;
      const before = await f.snapshot();
      await expect(
        stores.journal.runAtomicStage(context, c.header.id, c.stage.revision, c.stage.intent, {
          apply: failUnexpectedApply,
          verify: (tx, checked) =>
            verifyUsDatasetReceiving(tx, checked, substitutedIntent, receipt, stores),
        }),
      ).rejects.toThrow("us_dataset_receiving_mismatch");
      expect(await f.snapshot()).toEqual(before);
    },
  );

  it("accepts actual downstream Transformation consumption and an independent reference", async () => {
    const c = await compose();
    const chain = c.result.input.chain;
    const ids = c.result.lots.map(({ id }) => id);
    const tokens = () =>
      f.pool.query(
        "SELECT id, current_dependency_version FROM traceability_lots WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
        [context.tenantId, ids],
      );
    const beforeTokens = (await tokens()).rows;
    const documentIds = [];
    for (const number of chain.transformation.references) {
      const d = chain.documents.find((entry) => entry.input.number === number);
      if (!d) throw new Error("Missing transformation document");
      documentIds.push(
        (
          await stores.documents.createDocument(
            context.tenantId,
            context.actorUserId,
            { ...d.input, partyId: bound(c.references.bindings.parties, d.partyKey) },
            "downstream",
          )
        ).id,
      );
    }
    const transformation = new UsTransformationStore(f.db);
    const saved = await transformation.createDraft(
      context.tenantId,
      context.actorUserId,
      {
        operationKey: randomUUID(),
        draft: {
          eventDate: chain.transformation.eventDate,
          processorLocationId: bound(
            c.references.bindings.locations,
            chain.transformation.locationKey,
          ),
          reason: "commingling_and_repacking",
          reasonNote: null,
          notes: null,
          documentIds,
          inputs: chain.transformation.inputs.map((line, index) => ({
            kind: "ftl_lot",
            lotId: ids[index],
            quantity: line.quantity,
            unitOfMeasure: line.unitOfMeasure,
          })),
          outputs: [
            {
              productId: bound(
                c.references.bindings.products,
                chain.transformation.output.productKey,
              ),
              tlc: chain.transformation.output.tlc,
              quantity: chain.transformation.output.quantity,
              unitOfMeasure: chain.transformation.output.unitOfMeasure,
            },
          ],
        },
      },
      "downstream",
    );
    const ready = await transformation.checkReadiness(
      context.tenantId,
      context.actorUserId,
      saved.id,
      { expectedDraftVersion: 1 },
    );
    expect(ready.state).toBe("complete");
    await transformation.finalize(
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
    expect((await tokens()).rows).not.toEqual(beforeTokens);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM lot_genealogy_edges WHERE tenant_id=$1 AND event_id=$2",
          [context.tenantId, saved.id],
        )
      ).rows[0]?.n,
    ).toBe(2);
    await stores.documents.createDocument(
      context.tenantId,
      context.actorUserId,
      {
        type: "invoice",
        typeOtherLabel: null,
        number: "INDEPENDENT",
        issuedOn: "2026-09-30",
        notes: null,
        partyId: null,
      },
      "independent",
    );
    await stores.master.createParty(
      context.tenantId,
      context.actorUserId,
      { name: "Independent synthetic reference" },
      "independent-party",
    );
    const before = await f.snapshot();
    expect(await c.verify()).toEqual(c.stage);
    expect(await f.snapshot()).toEqual(before);
  });
});
