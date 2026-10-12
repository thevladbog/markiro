import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import type { ReceivingDraft } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { makeUsSixMonthRegularChain } from "../src/modules/traceability/demo/us-six-month-chains";
import { UsReferenceDocumentStore } from "../src/modules/traceability/documents/us-reference-document-store";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import { UsMasterDataStore } from "../src/modules/traceability/master-data/us-master-data-store";
import { UsProductProfileStore } from "../src/modules/traceability/products/us-product-profile-store";
import type { UsMasterDataTransaction } from "../src/modules/traceability/master-data/us-master-data-support";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const chain = makeUsSixMonthRegularChain(259);
const bound = (entries: readonly { key: string; id: string }[], key: string) => {
  const entry = entries.find((item) => item.key === key);
  if (!entry) throw new Error("Expected fixture reference binding");
  return entry.id;
};

describe.skipIf(!base)("Receiving transaction seams on owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let context: Awaited<ReturnType<typeof f.provision>>;
  let references: Awaited<ReturnType<UsDatasetReferenceSeedStore["initialize"]>>;
  let receiving: UsReceivingStore;
  let lots: UsLotStore;
  let documents: UsReferenceDocumentStore;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    f = await createUsDatasetJournalFixture(base);
    console.info(`Owned Receiving seam database: ${f.databaseName}`);
    receiving = new UsReceivingStore(f.db);
    lots = new UsLotStore(f.db);
    documents = new UsReferenceDocumentStore(f.db);
  }, 60_000);
  beforeEach(async () => {
    context = await f.provision();
    references = await new UsDatasetReferenceSeedStore(f.db).initialize(context);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  async function prepare(tx: UsMasterDataTransaction, operationKey: string) {
    const documentIds: string[] = [];
    const createdDocuments = [];
    for (const reference of chain.receiving.references) {
      const matches = chain.documents.filter((item) => item.input.number === reference);
      const definition = matches[0];
      if (matches.length !== 1 || !definition)
        throw new Error("Expected unique Receiving document descriptor");
      const document = await documents.createDocumentInTransaction(
        tx,
        context.tenantId,
        context.actorUserId,
        { ...definition.input, partyId: bound(references.bindings.parties, definition.partyKey) },
        operationKey,
      );
      documentIds.push(document.id);
      createdDocuments.push(document);
    }
    const sourceId = bound(
      references.bindings.locations,
      chain.receiving.previousSourceLocationKey,
    );
    const draft: ReceivingDraft = {
      dateReceived: chain.receiving.eventDate,
      locationId: bound(references.bindings.locations, chain.receiving.receivingLocationKey),
      previousSourceLocationId: sourceId,
      receivedAtNote: null,
      notes: null,
      documentIds,
      items: chain.receiving.lines.map((line) => ({
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
    return { draft, createdDocuments };
  }

  async function compose(
    tx: UsMasterDataTransaction,
    operationKey: string,
    beforeFinalize?: () => Promise<void>,
  ) {
    const { draft, createdDocuments } = await prepare(tx, operationKey);
    const created = await receiving.createDraftCommandInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      { operationKey, draft },
      operationKey,
    );
    if (!("receiptVersion" in created)) throw new Error("Expected new versioned creation");
    const ready = await receiving.checkRevisionReadinessInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      created.eventId,
      { expectedDraftVersion: 1 },
    );
    expect(ready.ruleVersion).toBe("receiving-readiness-v4");
    expect(ready.state).toBe("complete");
    const command = {
      commandVersion: 2,
      operationKey,
      expectedDraftVersion: 1,
      expectedLifecycleVersion: ready.expectedLifecycleVersion,
      previousRevisionId: ready.previousRevisionId,
      expectedInputDigest: ready.inputDigest,
      reviewedExemptLines: [],
    };
    await beforeFinalize?.();
    const finalized = await receiving.finalizeCommandInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      created.eventId,
      command,
      operationKey,
    );
    if (!("receiptVersion" in finalized)) throw new Error("Expected new versioned finalization");
    const live = await receiving.getLiveRecordInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      created.eventId,
    );
    expect(live).toEqual(finalized.record);
    expect(live).toMatchObject({
      status: "finalized",
      revision: 1,
      draftVersion: 1,
      lifecycle: {
        rootId: created.eventId,
        currentEventId: created.eventId,
        lifecycleVersion: 2,
        pendingDraftId: null,
      },
    });
    if (live.content.kind !== "finalized") throw new Error("Expected finalized content");
    const snapshot = live.content.snapshot;
    expect(snapshot).toMatchObject({
      snapshotVersion: 3,
      dateReceived: "2026-09-14",
      locationId: draft.locationId,
      previousSourceLocationId: draft.previousSourceLocationId,
      items: [
        { tlc: "OSS-260914-A1", quantity: "500", unitOfMeasure: "lb" },
        { tlc: "OSS-260914-A2", quantity: "500", unitOfMeasure: "lb" },
      ],
    });
    expect(snapshot.documents.map(({ document }) => document.documentId)).toEqual(
      draft.documentIds,
    );
    const resolvedLots = [];
    for (const line of snapshot.items) {
      const lot = await lots.getLotInTransaction(
        tx,
        context.tenantId,
        context.actorUserId,
        line.lotId,
      );
      expect(lot).toMatchObject({
        id: line.lotId,
        productId: bound(references.bindings.products, "inbound"),
        tlc: line.tlc,
        assignmentBasis: "imported",
        status: "active",
        revision: 1,
        source: { kind: "location", locationId: draft.previousSourceLocationId },
        sourceLockedAt: live.content.finalizedAt,
        createdBy: context.actorUserId,
        updatedBy: context.actorUserId,
      });
      resolvedLots.push(lot);
      expect(
        await receiving.getLotReceivingBasisInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          line.lotId,
          { limit: 10, offset: 0 },
        ),
      ).toEqual({
        lotId: line.lotId,
        basisVersion: 2,
        state: "present",
        supportCount: 1,
        items: [
          {
            rootId: created.eventId,
            eventId: created.eventId,
            eventNumber: live.eventNumber,
            revision: 1,
            lineNos: [line.lineNo],
          },
        ],
        limit: 10,
        offset: 0,
        hasMore: false,
      });
    }
    expect(new Set(resolvedLots.map((lot) => lot.id)).size).toBe(2);
    const audits = await tx
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, context.tenantId),
          eq(schema.tenantAuditEvents.requestId, operationKey),
        ),
      );
    const expectedAudits = [
      ...createdDocuments.map((document) => ({
        action: "traceability.reference_document.created",
        targetType: "traceability_reference_document",
        targetId: document.id,
        before: null,
        after: document,
      })),
      {
        action: "traceability.receiving.draft_created",
        targetType: "traceability_event",
        targetId: created.eventId,
        before: null,
        after: created.record,
      },
      ...resolvedLots.map((lot) => ({
        action: "traceability.lot.created",
        targetType: "traceability_lot",
        targetId: lot.id,
        before: null,
        after: { ...lot, eventId: created.eventId },
      })),
      {
        action: "traceability.receiving.finalized",
        targetType: "traceability_event",
        targetId: created.eventId,
        before: created.record,
        after: {
          rootId: created.eventId,
          revision: 1,
          reason: null,
          result: "finalized",
          effect: null,
          record: live,
          predecessor: null,
          lineLots: {
            before: [],
            after: snapshot.items.map((line) => ({ lineNo: line.lineNo, lotId: line.lotId })),
          },
        },
      },
    ];
    expect(audits).toHaveLength(6);
    for (const expected of expectedAudits)
      expect(audits).toContainEqual(
        expect.objectContaining({
          ...expected,
          organizationId: context.tenantId,
          actorUserId: context.actorUserId,
          outcome: "success",
          requestId: operationKey,
        }),
      );
    const operations = await tx
      .select()
      .from(schema.receivingOperations)
      .where(eq(schema.receivingOperations.tenantId, context.tenantId));
    expect(operations).toHaveLength(2);
    for (const receipt of [created, finalized])
      expect(operations).toContainEqual(
        expect.objectContaining({
          command: receipt.command,
          operationKey,
          inputDigest: receipt.inputDigest,
          eventId: receipt.eventId,
          result: receipt,
        }),
      );
    const stages = await tx
      .select()
      .from(schema.traceabilityDemoDatasetStages)
      .where(eq(schema.traceabilityDemoDatasetStages.tenantId, context.tenantId));
    expect(stages.map((stage) => [stage.unitKey, stage.stage])).toEqual([
      ["references", "references"],
    ]);
    return { draft, created, command, finalized, live, resolvedLots };
  }

  it.each(["repeatable read", "read committed"] as const)(
    "composes documents, commands and current readers in %s",
    async (isolationLevel) => {
      await f.db.transaction((tx) => compose(tx, randomUUID()), { isolationLevel });
    },
  );
  it("rolls back every persisted row after caller abort", async () => {
    const before = await f.snapshot();
    await expect(
      f.db.transaction(async (tx) => {
        await compose(tx, randomUUID());
        throw new Error("receiving_outer_abort");
      }),
    ).rejects.toThrow("receiving_outer_abort");
    expect(await f.snapshot()).toEqual(before);
  });

  it.each([
    ["second document", "reference_documents", "NEW.number = 'BOL-0914-A'"],
    ["draft audit", "tenant_audit_events", "NEW.action = 'traceability.receiving.draft_created'"],
    [
      "first lot audit",
      "tenant_audit_events",
      "NEW.action = 'traceability.lot.created' AND NEW.after->>'tlc' = 'OSS-260914-A1'",
    ],
    [
      "second lot audit",
      "tenant_audit_events",
      "NEW.action = 'traceability.lot.created' AND NEW.after->>'tlc' = 'OSS-260914-A2'",
    ],
    [
      "finalization audit",
      "tenant_audit_events",
      "NEW.action = 'traceability.receiving.finalized'",
    ],
    ["create operation", "receiving_operations", "NEW.command = 'receiving.create'"],
    ["finalize operation", "receiving_operations", "NEW.command = 'receiving.finalize'"],
  ])(
    "aborts the full unit on actual %s failure and retries only after removing the trigger",
    async (_label, table, condition) => {
      const operationKey = randomUUID();
      await f.pool
        .query(`CREATE FUNCTION receiving_seam_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${condition} THEN RAISE EXCEPTION 'receiving_seam_failure'; END IF; RETURN NEW; END $$`);
      await f.pool.query(
        `CREATE TRIGGER receiving_seam_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION receiving_seam_failure()`,
      );
      try {
        const before = await f.snapshot();
        await expect(f.db.transaction((tx) => compose(tx, operationKey))).rejects.toMatchObject({
          cause: { message: "receiving_seam_failure" },
        });
        expect(await f.snapshot()).toEqual(before);
      } finally {
        await f.pool.query(`DROP TRIGGER receiving_seam_failure ON ${table}`);
        await f.pool.query("DROP FUNCTION receiving_seam_failure()");
      }
      await f.db.transaction((tx) => compose(tx, operationKey));
    },
  );

  async function setRole(role: string) {
    await f.db
      .update(schema.member)
      .set({ role })
      .where(
        and(
          eq(schema.member.organizationId, context.tenantId),
          eq(schema.member.userId, context.actorUserId),
        ),
      );
  }
  async function denied(
    run: (tx: UsMasterDataTransaction) => Promise<unknown>,
    status: number,
    code: string,
  ) {
    const before = await f.snapshot();
    await expect(f.db.transaction(run)).rejects.toMatchObject({ status, response: { code } });
    expect(await f.snapshot()).toEqual(before);
  }

  it("commits once and replays exact command bytes with no new writes; changed inputs conflict", async () => {
    const operationKey = randomUUID();
    const result = await f.db.transaction((tx) => compose(tx, operationKey));
    const before = await f.snapshot();
    await f.db.transaction(async (tx) => {
      expect(
        await receiving.createDraftCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          { operationKey, draft: result.draft },
          "replay",
        ),
      ).toEqual(result.created);
      expect(
        await receiving.finalizeCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          result.created.eventId,
          result.command,
          "replay",
        ),
      ).toEqual(result.finalized);
    });
    expect(await f.snapshot()).toEqual(before);
    await denied(
      (tx) =>
        receiving.createDraftCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          { operationKey, draft: { ...result.draft, notes: "Changed" } },
          "conflict",
        ),
      409,
      "receiving_operation_conflict",
    );
    await denied(
      (tx) =>
        receiving.finalizeCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          result.created.eventId,
          { ...result.command, expectedDraftVersion: 2 },
          "conflict",
        ),
      409,
      "receiving_operation_conflict",
    );
  });

  it("allows QA composition according to current capability policy", async () => {
    await setRole("traceability_qa");
    await f.db.transaction((tx) => compose(tx, randomUUID()));
  });

  it("authorizes before malformed write input, including native and public replay", async () => {
    const result = await f.db.transaction((tx) => compose(tx, randomUUID()));
    await setRole("traceability_auditor");
    await denied(
      (tx) =>
        receiving.createDraftCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          {},
          "denied",
        ),
      403,
      "insufficient_permission",
    );
    await denied(
      (tx) =>
        receiving.finalizeCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          "invalid",
          {},
          "denied",
        ),
      403,
      "insufficient_permission",
    );
    await denied(
      (tx) =>
        receiving.createDraftCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          { operationKey: result.created.operationKey, draft: result.draft },
          "denied-replay",
        ),
      403,
      "insufficient_permission",
    );
    await denied(
      (tx) =>
        receiving.finalizeCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          result.created.eventId,
          result.command,
          "denied-replay",
        ),
      403,
      "insufficient_permission",
    );
    const before = await f.snapshot();
    await expect(
      receiving.createDraftCommand(
        context.tenantId,
        context.actorUserId,
        { operationKey: result.created.operationKey, draft: result.draft },
        "denied-replay",
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      receiving.finalizeCommand(
        context.tenantId,
        context.actorUserId,
        result.created.eventId,
        result.command,
        "denied-replay",
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await f.snapshot()).toEqual(before);
  });

  it("denies tenant outsiders before malformed reader or command input", async () => {
    const actor = randomUUID();
    for (const read of [
      (tx: UsMasterDataTransaction) =>
        receiving.getLiveRecordInTransaction(tx, context.tenantId, actor, "invalid"),
      (tx: UsMasterDataTransaction) =>
        receiving.checkRevisionReadinessInTransaction(tx, context.tenantId, actor, "invalid", {}),
      (tx: UsMasterDataTransaction) =>
        receiving.getLotReceivingBasisInTransaction(tx, context.tenantId, actor, "invalid", {}),
      (tx: UsMasterDataTransaction) =>
        lots.getLotInTransaction(tx, context.tenantId, actor, "invalid"),
      (tx: UsMasterDataTransaction) =>
        receiving.createDraftCommandInTransaction(tx, context.tenantId, actor, {}, "denied"),
      (tx: UsMasterDataTransaction) =>
        receiving.finalizeCommandInTransaction(
          tx,
          context.tenantId,
          actor,
          "invalid",
          {},
          "denied",
        ),
    ])
      await denied(read, 403, "insufficient_permission");
  });

  it("rejects malformed authorized inputs without any writes", async () => {
    for (const run of [
      (tx: UsMasterDataTransaction) =>
        receiving.createDraftCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          {},
          "invalid",
        ),
      (tx: UsMasterDataTransaction) =>
        receiving.finalizeCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          "invalid",
          {},
          "invalid",
        ),
      (tx: UsMasterDataTransaction) =>
        receiving.checkRevisionReadinessInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          "invalid",
          {},
        ),
      (tx: UsMasterDataTransaction) =>
        receiving.getLiveRecordInTransaction(tx, context.tenantId, context.actorUserId, "invalid"),
      (tx: UsMasterDataTransaction) =>
        receiving.getLotReceivingBasisInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          "invalid",
          {},
        ),
      (tx: UsMasterDataTransaction) =>
        lots.getLotInTransaction(tx, context.tenantId, context.actorUserId, "invalid"),
    ])
      await denied(run, 400, "invalid_master_data");
  });

  it("keeps historical finalization after void distinct from current live state and missing basis", async () => {
    const result = await f.db.transaction((tx) => compose(tx, randomUUID()));
    await receiving.void(
      context.tenantId,
      context.actorUserId,
      result.created.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        expectedDraftVersion: null,
        reason: "Synthetic void example",
      },
      "void",
    );
    const before = await f.snapshot();
    await f.db.transaction(
      async (tx) => {
        expect(
          await receiving.finalizeCommandInTransaction(
            tx,
            context.tenantId,
            context.actorUserId,
            result.created.eventId,
            result.command,
            "replay",
          ),
        ).toEqual(result.finalized);
        const live = await receiving.getLiveRecordInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          result.created.eventId,
        );
        expect(live).toMatchObject({
          status: "void",
          lifecycle: { currentEventId: null, pendingDraftId: null, lifecycleVersion: 3 },
        });
        expect(live.content).toEqual(result.live.content);
        for (const lot of result.resolvedLots) {
          expect(
            await lots.getLotInTransaction(tx, context.tenantId, context.actorUserId, lot.id),
          ).toEqual(lot);
          expect(
            await receiving.getLotReceivingBasisInTransaction(
              tx,
              context.tenantId,
              context.actorUserId,
              lot.id,
              { limit: 10, offset: 0 },
            ),
          ).toEqual({
            lotId: lot.id,
            basisVersion: 3,
            state: "missing",
            supportCount: 0,
            items: [],
            limit: 10,
            offset: 0,
            hasMore: false,
          });
        }
      },
      { isolationLevel: "repeatable read" },
    );
    expect(await f.snapshot()).toEqual(before);
  });

  it("exposes pending and current amendment independently from historical command replay", async () => {
    const result = await f.db.transaction((tx) => compose(tx, randomUUID()));
    const amendment = await receiving.amend(
      context.tenantId,
      context.actorUserId,
      result.created.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Synthetic correction example",
      },
      "amend",
    );
    const pending = await f.db.transaction(
      async (tx) => {
        expect(
          await receiving.finalizeCommandInTransaction(
            tx,
            context.tenantId,
            context.actorUserId,
            result.created.eventId,
            result.command,
            "replay",
          ),
        ).toEqual(result.finalized);
        return receiving.getLiveRecordInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          amendment.eventId,
        );
      },
      { isolationLevel: "repeatable read" },
    );
    expect(pending).toMatchObject({
      status: "draft",
      revision: 2,
      lifecycle: {
        currentEventId: result.created.eventId,
        pendingDraftId: amendment.eventId,
        lifecycleVersion: 3,
      },
    });
    await f.db.transaction(
      async (tx) => {
        const ready = await receiving.checkRevisionReadinessInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          amendment.eventId,
          { expectedDraftVersion: 1 },
        );
        const final = await receiving.finalizeCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          amendment.eventId,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedDraftVersion: 1,
            expectedLifecycleVersion: ready.expectedLifecycleVersion,
            previousRevisionId: ready.previousRevisionId,
            expectedInputDigest: ready.inputDigest,
            reviewedExemptLines: [],
          },
          "finalize-amendment",
        );
        if (!("receiptVersion" in final)) throw new Error("Expected amendment acknowledgement");
        expect(final.record).toMatchObject({
          status: "finalized",
          revision: 2,
          lifecycle: {
            currentEventId: amendment.eventId,
            pendingDraftId: null,
            lifecycleVersion: 4,
          },
        });
        expect(
          await receiving.getLiveRecordInTransaction(
            tx,
            context.tenantId,
            context.actorUserId,
            result.created.eventId,
          ),
        ).toMatchObject({
          status: "amended",
          lifecycle: {
            currentEventId: amendment.eventId,
            supersededByEventId: amendment.eventId,
            lifecycleVersion: 4,
          },
        });
        for (const lot of result.resolvedLots)
          expect(
            await receiving.getLotReceivingBasisInTransaction(
              tx,
              context.tenantId,
              context.actorUserId,
              lot.id,
              { limit: 10, offset: 0 },
            ),
          ).toMatchObject({
            state: "present",
            supportCount: 1,
            items: [{ rootId: result.created.eventId, eventId: amendment.eventId, revision: 2 }],
          });
      },
      { isolationLevel: "repeatable read" },
    );
    const before = await f.snapshot();
    expect(
      await f.db.transaction((tx) =>
        receiving.finalizeCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          result.created.eventId,
          result.command,
          "historical-replay",
        ),
      ),
    ).toEqual(result.finalized);
    expect(await f.snapshot()).toEqual(before);
  });

  it("preserves public legacy create and legacy finalization bytes through native replay and keeps revision-only parsing strict", async () => {
    const operationKey = randomUUID();
    const { draft } = await f.db.transaction((tx) => prepare(tx, operationKey));
    const created = await receiving.createDraft(
      context.tenantId,
      context.actorUserId,
      { operationKey, draft },
      operationKey,
    );
    const ready = await receiving.checkReadiness(
      context.tenantId,
      context.actorUserId,
      created.id,
      { expectedDraftVersion: 1 },
    );
    const input = { operationKey, expectedDraftVersion: 1, expectedInputDigest: ready.inputDigest };
    const finalized = await receiving.finalize(
      context.tenantId,
      context.actorUserId,
      created.id,
      input,
      operationKey,
    );
    const before = await f.snapshot();
    await f.db.transaction(async (tx) => {
      expect(
        await receiving.createDraftCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          { operationKey, draft },
          "replay",
        ),
      ).toEqual(created);
      expect(
        await receiving.finalizeCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          created.id,
          input,
          "replay",
        ),
      ).toEqual(finalized);
    });
    await expect(
      receiving.finalizeRevision(
        context.tenantId,
        context.actorUserId,
        created.id,
        input,
        "strict",
      ),
    ).rejects.toMatchObject({ status: 400, response: { code: "invalid_master_data" } });
    expect(await f.snapshot()).toEqual(before);
  });

  it.each(["reference", "profile"])(
    "rejects stale readiness after a real %s edit",
    async (edit) => {
      const operationKey = randomUUID();
      const { draft } = await f.db.transaction((tx) => prepare(tx, operationKey));
      const created = await receiving.createDraftCommand(
        context.tenantId,
        context.actorUserId,
        { operationKey, draft },
        operationKey,
      );
      if (!("receiptVersion" in created)) throw new Error("Expected creation acknowledgement");
      const ready = await receiving.checkRevisionReadiness(
        context.tenantId,
        context.actorUserId,
        created.eventId,
        { expectedDraftVersion: 1 },
      );
      if (edit === "profile") {
        const store = new UsProductProfileStore(f.db);
        const productId = bound(references.bindings.products, "inbound");
        const current = await store.getProfile(context.tenantId, context.actorUserId, productId);
        const {
          productId: _productId,
          revision,
          reviewedBy: _reviewedBy,
          reviewedAt: _reviewedAt,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          ...editable
        } = current;
        void [_productId, _reviewedBy, _reviewedAt, _createdAt, _updatedAt];
        await store.putProfile(
          context.tenantId,
          context.actorUserId,
          productId,
          { ...editable, productName: "Synthetic changed profile", expectedRevision: revision },
          "profile-edit",
        );
      } else {
        await new UsMasterDataStore(f.db).updateLocation(
          context.tenantId,
          context.actorUserId,
          draft.previousSourceLocationId,
          { businessName: "Synthetic changed source" },
          "reference-edit",
        );
      }
      await denied(
        (tx) =>
          receiving.finalizeCommandInTransaction(
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
            "stale",
          ),
        409,
        "receiving_readiness_changed",
      );
    },
  );

  it("keeps foreign document, lot and event references tenant scoped", async () => {
    const foreign = await seedCompleteReceiving(f.db);
    const event = await receiving.createDraftCommand(
      foreign.tenant,
      foreign.actor,
      { operationKey: randomUUID(), draft: foreign.draft },
      "foreign-event",
    );
    if (!("receiptVersion" in event)) throw new Error("Expected foreign creation acknowledgement");
    const { draft } = await f.db.transaction((tx) => prepare(tx, randomUUID()));
    await denied(
      (tx) =>
        receiving.createDraftCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          {
            operationKey: randomUUID(),
            draft: { ...draft, documentIds: [foreign.document] },
          },
          "foreign-document",
        ),
      404,
      "receiving_reference_not_found",
    );
    const first = draft.items[0];
    if (!first) throw new Error("Expected first line");
    await denied(
      (tx) =>
        receiving.createDraftCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          {
            operationKey: randomUUID(),
            draft: {
              ...draft,
              items: [{ ...first, lotLinkMode: "link_existing", lotId: foreign.lot }],
            },
          },
          "foreign-lot",
        ),
      404,
      "receiving_reference_not_found",
    );
    for (const run of [
      (tx: UsMasterDataTransaction) =>
        receiving.getLiveRecordInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          event.eventId,
        ),
      (tx: UsMasterDataTransaction) =>
        receiving.checkRevisionReadinessInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          event.eventId,
          { expectedDraftVersion: 1 },
        ),
    ])
      await denied(run, 404, "receiving_draft_not_found");
    await denied(
      (tx) => lots.getLotInTransaction(tx, context.tenantId, context.actorUserId, foreign.lot),
      404,
      "lot_not_found",
    );
    await denied(
      (tx) =>
        receiving.getLotReceivingBasisInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          foreign.lot,
          { limit: 10, offset: 0 },
        ),
      404,
      "lot_not_found",
    );
  });

  it("translates an actual duplicate TLC/source violation and rolls back preceding documents and draft", async () => {
    let baseline: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    await expect(
      f.db.transaction(
        (tx) =>
          compose(tx, randomUUID(), async () => {
            // A separately committed competitor is invisible to this repeatable-read snapshot.
            // The actual unique INSERT, rather than the earlier readiness check, discovers it.
            await lots.createLot(
              context.tenantId,
              context.actorUserId,
              {
                productId: bound(references.bindings.products, "inbound"),
                tlc: "OSS-260914-A2",
                assignmentBasis: "imported",
                source: {
                  kind: "location",
                  locationId: bound(references.bindings.locations, "previous_source"),
                },
              },
              "existing-lot",
            );
            baseline = await f.snapshot();
          }),
        { isolationLevel: "repeatable read" },
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_lot_conflict" } });
    expect(baseline).toBeDefined();
    expect(await f.snapshot()).toEqual(baseline);
  });

  it.each(["40001", "40P01"])(
    "propagates %s from a supplied transaction without retrying it",
    async (code) => {
      await f.pool.query("CREATE SEQUENCE receiving_seam_attempt");
      await f.pool
        .query(`CREATE FUNCTION receiving_seam_no_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM nextval('receiving_seam_attempt'); RAISE EXCEPTION 'receiving_native_retry_forbidden' USING ERRCODE='${code}'; END $$`);
      await f.pool.query(
        "CREATE TRIGGER receiving_seam_no_retry BEFORE INSERT ON receiving_operations FOR EACH ROW WHEN (NEW.command='receiving.finalize') EXECUTE FUNCTION receiving_seam_no_retry()",
      );
      const before = await f.snapshot();
      try {
        await expect(f.db.transaction((tx) => compose(tx, randomUUID()))).rejects.toMatchObject({
          cause: { code, message: "receiving_native_retry_forbidden" },
        });
        expect(await f.snapshot()).toEqual(before);
        expect((await f.pool.query("SELECT last_value FROM receiving_seam_attempt")).rows).toEqual([
          { last_value: "1" },
        ]);
      } finally {
        await f.pool.query("DROP TRIGGER receiving_seam_no_retry ON receiving_operations");
        await f.pool.query("DROP FUNCTION receiving_seam_no_retry()");
        await f.pool.query("DROP SEQUENCE receiving_seam_attempt");
      }
    },
  );
});
