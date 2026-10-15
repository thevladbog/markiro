import { schema } from "@markiro/db";
import { canonicalExportDigest, canonicalExportEqual } from "./us-demo-canonical.js";

import {
  createShippingDraftSchema,
  finalizeShippingSchema,
  shippingDraftRecordSchema,
  shippingFinalizedRecordSchema,
  traceabilityLotSchema,
  type TraceabilityLot,
} from "@markiro/platform-contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { shippingCommandDigest } from "../shipping/us-shipping-draft.js";
import {
  readCurrentShippingBalance,
  listCurrentDownstreamConsumers,
} from "../shipping/us-shipping-balance.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import type { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { freshUsDatasetTerminalDependencies } from "./us-dataset-terminal-read-fresh.js";
import type { UsDatasetTransformationDependencies } from "./us-dataset-terminal-read-contract.js";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import {
  makeUsDatasetReferenceIdentity,
  usDatasetReceivingLotIdentity,
} from "./us-dataset-receiving-contract.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import { makeUsDatasetTransformationIdentity } from "./us-dataset-cases-contract.js";
import {
  datasetTransformationError,
  makeUsDatasetReceivingIdentity,
  parseUsDatasetTransformationResult,
  type UsDatasetTransformationResult,
} from "./us-dataset-transformation-contract.js";
import {
  makeUsDatasetShippingInput,
  makeUsDatasetShippingPlan,
  parseUsDatasetShippingInput,
  parseUsDatasetShippingResult,
  usDatasetShippingOperationKey,
} from "./us-dataset-shipping-contract.js";

/** Proves only the native automatic status effect, never completion/adoption of Shipping.
 * Caller holds origin roots and the union of lot locks. No discovered Shipping root is
 * locked here: amend/pending-void can write roots without a lot lock. The final joined
 * root/revision statement supplies one coherent read-committed linearization point. */
export async function verifyUsDatasetShippingOriginStatus(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  journal: UsDatasetJournalStore,
  expected: UsDatasetTransformationResult,
  current: TraceabilityLot,
): Promise<void> {
  return verifyUsDatasetShippingOriginStatusCore(
    tx,
    context,
    freshUsDatasetTerminalDependencies({ journal }),
    expected,
    current,
  );
}

export async function verifyUsDatasetShippingOriginStatusCore(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  stores: Pick<UsDatasetTransformationDependencies, "journal" | "points">,
  expected: UsDatasetTransformationResult,
  current: TraceabilityLot,
): Promise<void> {
  // Current actual target and owner are checked before any caller evidence field.
  const header = await stores.journal.readHeaderInTransaction(tx, context);
  if (!header) throw new Error("us_dataset_conflict");
  const result = parseUsDatasetTransformationResult(expected);
  const unitKey = result.input.chain.unitKey;
  const fail = () => datasetTransformationError("us_dataset_transformation_mismatch", unitKey);
  const equal = (a: unknown, b: unknown) => {
    if (!canonicalExportEqual(a, b)) throw fail();
  };
  assertBoundedSyntheticJson(current);
  const lot = traceabilityLotSchema.parse(current);
  equal(lot, current);
  const original = result.outputLot;
  const originalIdentity = usDatasetReceivingLotIdentity(original);
  const actualIdentity = usDatasetReceivingLotIdentity(lot);
  if (canonicalExportEqual(actualIdentity, originalIdentity)) return;
  equal(original.status, "active");
  equal(original.revision, 1);
  equal(actualIdentity, { ...originalIdentity, status: "shipped", revision: 2 });
  equal(lot.updatedBy, context.actorUserId);
  equal(original.createdBy, context.actorUserId);
  equal(result.input.references.datasetId, header.id);
  const [references, receiving, transformation, shipping] =
    await stores.journal.readStagesInTransaction(tx, context, header.id, [
      { unitKey: "references", stage: "references" },
      { unitKey: unitKey, stage: "receiving" },
      { unitKey: unitKey, stage: "transformation" },
      { unitKey: unitKey, stage: "shipping" },
    ]);
  if (!references?.receipt || !receiving?.receipt || !transformation?.receipt || !shipping)
    throw fail();
  equal(transformation.receipt.result, result);
  const input = parseUsDatasetShippingInput(shipping.intent.input);
  equal(
    input,
    makeUsDatasetShippingInput(
      Number(unitKey.slice(6)),
      makeUsDatasetReferenceIdentity(header.id, references),
      makeUsDatasetReceivingIdentity(header.id, receiving),
      makeUsDatasetTransformationIdentity(header.id, transformation),
      original.id,
      original.productId,
    ),
  );
  equal(shipping.intent.inputDigest, canonicalExportDigest(input));
  const plan = makeUsDatasetShippingPlan(input);
  const completed =
    shipping.receipt === null ? null : parseUsDatasetShippingResult(shipping.receipt.result);
  if (completed) equal(completed.input, input);
  equal(plan.at(-1)?.plannedRemainingAfter, "0");
  const { tenantId, actorUserId } = context;
  const bindings = parseUsDatasetReferenceResult(references.receipt.result).bindings;
  const bound = (rows: readonly { key: string; id: string }[], key: string) => {
    const row = rows.find((entry) => entry.key === key);
    if (!row) throw fail();
    return row.id;
  };
  const operations = schema.shippingOperations;
  const saved = await tx
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.tenantId, tenantId),
        inArray(
          operations.operationKey,
          plan.map((row) =>
            usDatasetShippingOperationKey(shipping.intent.operationKey, row.shipmentNo),
          ),
        ),
        inArray(operations.command, ["shipping.create", "shipping.finalize"]),
      ),
    );
  equal(saved.length, plan.length * 2);
  const transactionClock = saved[0]?.createdAt.toISOString();
  if (!transactionClock) throw fail();
  for (const operation of saved) equal(operation.createdAt.toISOString(), transactionClock);
  const native = [];
  for (const row of plan) {
    const key = usDatasetShippingOperationKey(shipping.intent.operationKey, row.shipmentNo);
    const create = saved.find((op) => op.operationKey === key && op.command === "shipping.create");
    const finalize = saved.find(
      (op) => op.operationKey === key && op.command === "shipping.finalize",
    );
    if (!create || !finalize) throw fail();
    const created = shippingDraftRecordSchema.parse(create.result);
    const finalized = shippingFinalizedRecordSchema.parse(finalize.result);
    equal(created.id, create.eventId);
    equal(finalized.id, created.id);
    equal(finalize.eventId, created.id);
    equal(created.createdBy, actorUserId);
    equal(created.updatedBy, actorUserId);
    equal(finalized.createdBy, actorUserId);
    equal(finalized.updatedBy, actorUserId);
    equal(finalized.snapshot.finalizedBy, actorUserId);
    equal(created.draftVersion, 1);
    equal(finalized.draftVersion, 1);
    equal(created.revision, 1);
    equal(finalized.revision, 1);
    equal(finalized.draft, created.draft);
    equal(created.timeZone, "America/Los_Angeles");
    equal(finalized.timeZone, created.timeZone);
    equal(created.createdAt, created.updatedAt);
    equal(finalized.createdAt, created.createdAt);
    equal(finalized.updatedAt, finalized.snapshot.finalizedAt);
    if (
      Date.parse(finalized.snapshot.finalizedAt) < Date.parse(created.createdAt) ||
      Date.parse(lot.updatedAt) < Date.parse(finalized.snapshot.finalizedAt)
    )
      throw fail();
    equal(create.createdAt.toISOString(), finalize.createdAt.toISOString());
    // Native operation rows are immutable receipts. Finalize's readiness input is
    // deliberately not recreated from current stock (the operation saves only its
    // digest/result); the create command can be derived exactly from its saved draft.
    equal(
      create.inputDigest,
      shippingCommandDigest(
        "shipping.create",
        createShippingDraftSchema.parse({ operationKey: key, draft: created.draft }),
      ),
    );
    if (!/^[a-f0-9]{64}$/.test(finalize.inputDigest)) throw fail();
    if (completed) {
      const frozen = completed.shipments[row.shipmentNo - 1];
      if (!frozen) throw fail();
      equal(
        finalize.inputDigest,
        shippingCommandDigest(
          "shipping.finalize",
          finalizeShippingSchema.parse(frozen.finalizeInput),
          frozen.created.id,
        ),
      );
      equal(frozen.created, created);
      equal(frozen.finalized, finalized);
    }
    const documents = [];
    for (const [position, number] of row.references.entries()) {
      const definition = input.chain.documents.find((entry) => entry.input.number === number);
      const documentId = created.draft.documentIds[position];
      if (!definition || !documentId) throw fail();
      const document = await stores.points.document(tx, tenantId, documentId);
      if (!document) throw fail();
      equal(
        {
          type: document.type,
          typeOtherLabel: document.typeOtherLabel,
          number: document.number,
          issuedOn: document.issuedOn,
          notes: document.notes,
        },
        definition.input,
      );
      equal(document.partyId, bound(bindings.parties, definition.partyKey));
      equal(document.archivedAt, null);
      equal(document.createdBy, actorUserId);
      equal(document.updatedAt.toISOString(), document.createdAt.toISOString());
      if (
        document.createdAt > new Date(created.createdAt) ||
        document.createdAt < new Date(original.createdAt)
      )
        throw fail();
      const snapshotDocument = finalized.snapshot.documents[position];
      if (!snapshotDocument?.issuer) throw fail();
      equal(
        {
          id: snapshotDocument.id,
          number: snapshotDocument.number,
          type: snapshotDocument.type,
          issuerId: snapshotDocument.issuer.id,
        },
        {
          id: document.id,
          number: document.number,
          type: document.type === "other" ? document.typeOtherLabel : document.type,
          issuerId: document.partyId,
        },
      );
      documents.push(documentId);
    }
    equal(created.draft, {
      eventDate: row.eventDate,
      shipFromLocationId: bound(bindings.locations, row.shippingLocationKey),
      recipientLocationId: bound(bindings.locations, row.recipientLocationKey),
      carrierReference: null,
      notes: "Synthetic six-month demo shipment.",
      items: [{ lotId: original.id, quantity: row.quantity, unitOfMeasure: "case" }],
      documentIds: documents,
    });
    const snapshot = finalized.snapshot;
    equal(snapshot.eventId, created.id);
    equal(snapshot.revision, 1);
    equal(snapshot.eventNumber, created.eventNumber);
    equal(snapshot.timeZone, created.timeZone);
    if (snapshot.previousRevisionId !== undefined) throw fail();
    equal(snapshot.eventDate, row.eventDate);
    equal(snapshot.shipFrom.locationId, created.draft.shipFromLocationId);
    equal(snapshot.recipient.locationId, created.draft.recipientLocationId);
    equal(snapshot.notes, created.draft.notes);
    equal(snapshot.carrierReference, null);
    equal(snapshot.items.length, 1);
    const line = snapshot.items[0];
    if (!line) throw fail();
    equal(line.product.description.sourceProductId, original.productId);
    equal(
      {
        lineNo: line.lineNo,
        lotId: line.lotId,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
        tlc: line.tlc,
        productId: line.product.id,
        source: line.source,
      },
      {
        lineNo: 1,
        lotId: original.id,
        quantity: row.quantity,
        unitOfMeasure: "case",
        tlc: original.tlc,
        productId: original.productId,
        source: { kind: "location", location: snapshot.shipFrom },
      },
    );
    equal(
      snapshot.documents.map((entry) => entry.id),
      documents,
    );
    const requestId = `dataset-shipping:${shipping.intent.operationKey}:${row.shipmentNo}`;
    const audit = schema.tenantAuditEvents;
    const eventAudits = await tx
      .select()
      .from(audit)
      .where(
        and(
          eq(audit.organizationId, tenantId),
          eq(audit.targetType, "traceability_event"),
          eq(audit.targetId, created.id),
        ),
      );
    equal(
      eventAudits
        .map(
          ({
            organizationId,
            actorUserId,
            action,
            outcome,
            targetType,
            targetId,
            requestId,
            before,
            after,
            createdAt,
          }) =>
            canonicalExportDigest({
              organizationId,
              actorUserId,
              action,
              outcome,
              targetType,
              targetId,
              requestId,
              before,
              after,
              createdAt: createdAt.toISOString(),
            }),
        )
        .sort(),
      [
        { action: "traceability.shipping.draft_created", before: null, after: created },
        {
          action: "traceability.shipping.finalized",
          before: created,
          after: {
            ...finalized,
            lotIds: [original.id],
            statusEffects: row.plannedRemainingAfter === "0" ? [original.id] : [],
          },
        },
      ]
        .map((audit) =>
          canonicalExportDigest({
            ...audit,
            organizationId: tenantId,
            actorUserId,
            outcome: "success",
            targetType: "traceability_event",
            targetId: created.id,
            requestId,
            createdAt: finalize.createdAt.toISOString(),
          }),
        )
        .sort(),
    );
    native.push({ created, finalized, requestId, clock: finalize.createdAt.toISOString() });
  }
  if (new Set(native.map((row) => row.created.id)).size !== native.length) throw fail();
  equal(await readCurrentShippingBalance(tx, tenantId, original.id), {
    state: "known",
    unitOfMeasure: "case",
    supply: input.chain.transformation.output.quantity,
    used: input.chain.transformation.output.quantity,
    remaining: "0",
  });
  const consumers = await listCurrentDownstreamConsumers(tx, tenantId, [original.id]);
  equal(
    consumers
      .map((row) => ({
        lotId: row.lotId,
        eventId: row.eventId,
        rootId: row.rootId,
        revision: row.revision,
      }))
      .sort((a, b) => a.eventId.localeCompare(b.eventId)),
    native
      .map(({ created }) => ({
        lotId: original.id,
        eventId: created.id,
        rootId: created.id,
        revision: 1,
      }))
      .sort((a, b) => a.eventId.localeCompare(b.eventId)),
  );
  const last = native.at(-1);
  if (!last) throw fail();
  const effects = schema.shippingLotStatusEffects;
  const ownedEffects = await tx
    .select()
    .from(effects)
    .where(and(eq(effects.tenantId, tenantId), eq(effects.lotId, original.id)));
  equal(ownedEffects.length, 1);
  const effect = ownedEffects[0];
  if (!effect) throw fail();
  equal(
    {
      eventId: effect.eventId,
      priorStatus: effect.priorStatus,
      newStatus: effect.newStatus,
      compensatedAt: effect.compensatedAt?.toISOString() ?? null,
      compensationReason: effect.compensationReason,
      createdAt: effect.createdAt.toISOString(),
    },
    {
      eventId: last.created.id,
      priorStatus: "active",
      newStatus: "shipped",
      compensatedAt: null,
      compensationReason: null,
      createdAt: last.clock,
    },
  );
  const audit = schema.tenantAuditEvents;
  const audits = await tx
    .select()
    .from(audit)
    .where(
      and(
        eq(audit.organizationId, tenantId),
        eq(audit.targetType, "traceability_lot"),
        eq(audit.targetId, original.id),
        eq(audit.action, "traceability.lot.status_changed"),
      ),
    );
  equal(audits.length, 1);
  const statusAudit = audits[0];
  if (!statusAudit) throw fail();
  equal(
    {
      organizationId: statusAudit.organizationId,
      actorUserId: statusAudit.actorUserId,
      action: statusAudit.action,
      outcome: statusAudit.outcome,
      targetType: statusAudit.targetType,
      targetId: statusAudit.targetId,
      requestId: statusAudit.requestId,
      before: statusAudit.before,
      after: statusAudit.after,
      clock: statusAudit.createdAt.toISOString(),
    },
    {
      organizationId: tenantId,
      actorUserId,
      action: "traceability.lot.status_changed",
      outcome: "success",
      targetType: "traceability_lot",
      targetId: original.id,
      requestId: last.requestId,
      before: original,
      after: {
        ...lot,
        reason: `Shipping ${last.created.eventNumber} finalized`,
        eventId: last.created.id,
        origin: "shipping",
      },
      clock: last.clock,
    },
  );
  // One SQL snapshot observes every native root and all its revisions together.
  // Root-only amendment/void cannot yield a torn root/event view; lot consumers
  // and effect writers remain blocked by the caller's lot lock. Do not use a
  // getter that reads root and event in separate read-committed statements here.
  const roots = schema.shippingEventRoots,
    events = schema.traceabilityEvents;
  const coherent = await tx
    .select({ root: roots, event: events })
    .from(roots)
    .innerJoin(events, and(eq(events.tenantId, roots.tenantId), eq(events.rootEventId, roots.id)))
    .where(
      and(
        eq(roots.tenantId, tenantId),
        inArray(
          roots.id,
          native.map(({ created }) => created.id),
        ),
      ),
    )
    .orderBy(asc(roots.id), asc(events.id));
  equal(coherent.length, native.length);
  for (const { root, event } of coherent) {
    const savedNative = native.find(({ created }) => created.id === root.id);
    if (!savedNative) throw fail();
    const { created, finalized } = savedNative;
    equal(
      {
        current: root.currentEventId,
        pending: root.pendingDraftId,
        version: root.lifecycleVersion,
        next: root.nextRevision,
        number: root.eventNumber,
      },
      { current: created.id, pending: null, version: 2, next: 2, number: created.eventNumber },
    );
    equal(
      {
        id: event.id,
        root: event.rootEventId,
        type: event.type,
        status: event.status,
        revision: event.revision,
        draftVersion: event.draftVersion,
        timeZone: event.timeZone,
        createdBy: event.createdBy,
        updatedBy: event.updatedBy,
        createdAt: event.createdAt.toISOString(),
        updatedAt: event.updatedAt.toISOString(),
        finalizedBy: event.finalizedBy,
        finalizedAt: event.finalizedAt?.toISOString(),
        snapshot: event.finalizationSnapshot,
        previous: event.previousRevisionId,
        amendment: event.amendmentReason,
        superseded: event.supersededByEventId,
        supersededAt: event.supersededAt,
        supersededBy: event.supersededBy,
        voidedAt: event.voidedAt,
        voidedBy: event.voidedBy,
        voidReason: event.voidReason,
      },
      {
        id: created.id,
        root: created.id,
        type: "shipping",
        status: "finalized",
        revision: 1,
        draftVersion: 1,
        timeZone: finalized.timeZone,
        createdBy: actorUserId,
        updatedBy: actorUserId,
        createdAt: finalized.createdAt,
        updatedAt: finalized.updatedAt,
        finalizedBy: actorUserId,
        finalizedAt: finalized.snapshot.finalizedAt,
        snapshot: finalized.snapshot,
        previous: null,
        amendment: null,
        superseded: null,
        supersededAt: null,
        supersededBy: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
      },
    );
    equal(finalized.lifecycle, {
      rootId: root.id,
      lifecycleVersion: 2,
      currentEventId: root.id,
      pendingDraftId: null,
      previousRevisionId: null,
      amendmentReason: null,
      supersededByEventId: null,
      supersededAt: null,
      supersededBy: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
    });
    equal(created.lifecycle, {
      rootId: root.id,
      lifecycleVersion: 1,
      currentEventId: null,
      pendingDraftId: root.id,
      previousRevisionId: null,
      amendmentReason: null,
    });
    const items = schema.shippingEventItems;
    const lines = await tx
      .select()
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.eventId, root.id)))
      .orderBy(asc(items.lineNo));
    equal(
      lines.map((line) => ({
        lineNo: line.lineNo,
        lotId: line.lotId,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
        tlc: line.tlcSnapshot,
        product: line.productSnapshot,
        source: line.sourceSnapshot,
      })),
      finalized.snapshot.items.map((line) => ({
        lineNo: line.lineNo,
        lotId: line.lotId,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
        tlc: line.tlc,
        product: line.product,
        source: line.source,
      })),
    );
  }
}
