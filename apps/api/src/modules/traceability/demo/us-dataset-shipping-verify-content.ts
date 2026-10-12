import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { createShippingDraftSchema, finalizeShippingSchema } from "@markiro/platform-contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { shippingCommandDigest } from "../shipping/us-shipping-draft.js";
import { readShippingRevisions } from "../shipping/us-shipping-history.js";
import {
  readCurrentShippingBalance,
  listCurrentDownstreamConsumers,
} from "../shipping/us-shipping-balance.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext, UsDatasetIntent } from "./us-dataset-contract.js";
import { usDatasetShippingOperationKey } from "./us-dataset-shipping-contract.js";
import type { UsDatasetShippingStores } from "./us-dataset-shipping-prepare.js";
import type { UsDatasetShippingResultContent } from "./us-dataset-shipping-result-content.js";
import type { UsDatasetReferenceResult } from "./us-dataset-reference-contract.js";

export async function verifyUsDatasetShippingContent(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  result: UsDatasetShippingResultContent,
  bindings: UsDatasetReferenceResult["bindings"],
  mode: "fresh" | "replay",
  stores: UsDatasetShippingStores,
  fail: () => Error,
): Promise<void> {
  const equal = (a: unknown, b: unknown) => {
    if (canonicalExportDigest(a) !== canonicalExportDigest(b)) throw fail();
  };
  const plan = result.plan;
  const bound = (rows: readonly { key: string; id: string }[], key: string) => {
    const row = rows.find((entry) => entry.key === key);
    if (!row) throw fail();
    return row.id;
  };
  const operations = schema.shippingOperations,
    audit = schema.tenantAuditEvents;
  let clock: string | undefined;
  for (const [index, shipment] of result.shipments.entries()) {
    const row = plan[index];
    if (!row) throw fail();
    equal(
      shipment.operationKey,
      usDatasetShippingOperationKey(intent.operationKey, row.shipmentNo),
    );
    equal(shipment.requestId, `dataset-shipping:${intent.operationKey}:${row.shipmentNo}`);
    equal(
      shipment.createInput.draft.shipFromLocationId,
      bound(bindings.locations, row.shippingLocationKey),
    );
    equal(
      shipment.createInput.draft.recipientLocationId,
      bound(bindings.locations, row.recipientLocationKey),
    );
    const saved = await tx
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.tenantId, context.tenantId),
          eq(operations.operationKey, shipment.operationKey),
          inArray(operations.command, ["shipping.create", "shipping.finalize"]),
        ),
      );
    equal(saved.length, 2);
    if (mode === "fresh") {
      // xmin is a 32-bit xid; pg_current_xact_id includes an epoch. Reduce its
      // numeric representation modulo 2^32 rather than equating xid8 text.
      // Only this invocation's private native writes certify fresh evidence.
      const ownXmin = sql<boolean>`xmin::text = (pg_current_xact_id()::text::numeric % 4294967296)::text`;
      const owned = await tx
        .select({ owned: ownXmin })
        .from(operations)
        .where(
          and(
            eq(operations.tenantId, context.tenantId),
            eq(operations.operationKey, shipment.operationKey),
            inArray(operations.command, ["shipping.create", "shipping.finalize"]),
          ),
        );
      if (owned.length !== 2 || owned.some((row) => !row.owned)) throw fail();
      const events = schema.traceabilityEvents,
        documents = schema.referenceDocuments;
      const privateEvents = await tx
        .select({ owned: ownXmin })
        .from(events)
        .where(and(eq(events.tenantId, context.tenantId), eq(events.id, shipment.created.id)));
      const privateDocuments = await tx
        .select({ owned: ownXmin })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, context.tenantId),
            inArray(
              documents.id,
              shipment.documents.map((row) => row.record.id),
            ),
          ),
        );
      const privateAudits = await tx
        .select({ owned: ownXmin })
        .from(audit)
        .where(
          and(eq(audit.organizationId, context.tenantId), eq(audit.requestId, shipment.requestId)),
        );
      if (
        privateEvents.length !== 1 ||
        privateDocuments.length !== 2 ||
        !privateAudits.length ||
        [...privateEvents, ...privateDocuments, ...privateAudits].some((row) => !row.owned)
      )
        throw fail();
    }
    for (const [command, input, response] of [
      ["shipping.create", createShippingDraftSchema.parse(shipment.createInput), shipment.created],
      [
        "shipping.finalize",
        finalizeShippingSchema.parse(shipment.finalizeInput),
        shipment.finalized,
      ],
    ] as const) {
      const op = saved.find((entry) => entry.command === command);
      if (!op) throw fail();
      equal(
        {
          tenantId: op.tenantId,
          eventId: op.eventId,
          command: op.command,
          operationKey: op.operationKey,
          inputDigest: op.inputDigest,
          result: op.result,
        },
        {
          tenantId: context.tenantId,
          eventId: shipment.created.id,
          command,
          operationKey: shipment.operationKey,
          inputDigest: shippingCommandDigest(
            command,
            input,
            command === "shipping.create" ? undefined : shipment.created.id,
          ),
          result: response,
        },
      );
      clock ??= op.createdAt.toISOString();
      equal(op.createdAt.toISOString(), clock);
    }
    // Native historical reader validates full mutable event header and lifecycle;
    // its snapshot is immutable history, so persisted children are checked below.
    equal(
      await stores.shipping.getRecordInTransaction(
        tx,
        context.tenantId,
        context.actorUserId,
        shipment.created.id,
      ),
      shipment.finalized,
    );
    const revisions = await readShippingRevisions(tx, context.tenantId, shipment.created.id, {
      limit: 100,
      offset: 0,
    });
    equal(revisions.items.length, 1);
    equal(revisions.lifecycleVersion, 2);
    const roots = schema.shippingEventRoots,
      events = schema.traceabilityEvents;
    const [root] = await tx
      .select()
      .from(roots)
      .where(and(eq(roots.tenantId, context.tenantId), eq(roots.id, shipment.created.id)));
    const [event] = await tx
      .select()
      .from(events)
      .where(and(eq(events.tenantId, context.tenantId), eq(events.id, shipment.created.id)));
    if (!root || !event) throw fail();
    equal(root.nextRevision, 2);
    equal(event.finalizedBy, context.actorUserId);
    equal(event.finalizedAt?.toISOString(), shipment.finalized.snapshot.finalizedAt);
    equal(event.dateReceived, shipment.createInput.draft.eventDate);
    equal(event.locationId, shipment.createInput.draft.shipFromLocationId);
    equal(event.notes, shipment.createInput.draft.notes);
    const items = schema.shippingEventItems;
    const lines = await tx
      .select()
      .from(items)
      .where(and(eq(items.tenantId, context.tenantId), eq(items.eventId, shipment.created.id)))
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
      shipment.finalized.snapshot.items.map((line) => ({
        lineNo: line.lineNo,
        lotId: line.lotId,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
        tlc: line.tlc,
        product: line.product,
        source: line.source,
      })),
    );
    const links = schema.shippingEventDocuments;
    const documents = await tx
      .select()
      .from(links)
      .where(and(eq(links.tenantId, context.tenantId), eq(links.eventId, shipment.created.id)))
      .orderBy(asc(links.position));
    equal(
      documents.map((doc) => ({ position: doc.position, id: doc.documentId })),
      shipment.documents.map(({ record }, i) => ({ position: i + 1, id: record.id })),
    );
    const details = schema.shippingEventDetails;
    const [detail] = await tx
      .select()
      .from(details)
      .where(and(eq(details.tenantId, context.tenantId), eq(details.eventId, shipment.created.id)));
    if (!detail) throw fail();
    equal(detail.recipientLocationId, shipment.createInput.draft.recipientLocationId);
    equal(detail.carrierReference, null);
    const location = shipment.finalized.snapshot.recipient;
    const address =
      location.address.kind === "street"
        ? location.address.streetAddress
        : `${location.address.latitude}, ${location.address.longitude}`;
    equal(detail.recipientSnapshot, {
      id: location.locationId,
      description: [
        location.businessName,
        address,
        location.city,
        location.stateOrRegion,
        location.zipOrPostalCode,
        location.countryDisplay,
        location.phoneNumber,
      ].join(", "),
      location,
    });
    for (const [position, { key, record }] of shipment.documents.entries()) {
      const definition = result.chain.documents.find((row) => row.key === key);
      if (!definition) throw fail();
      equal(record.partyId, bound(bindings.parties, definition.partyKey));
      const party = await stores.master.getPartyInTransaction(
        tx,
        context.tenantId,
        context.actorUserId,
        record.partyId,
      );
      equal(shipment.finalized.snapshot.documents[position]?.issuer, {
        id: party.id,
        name: party.name,
        legalName: party.legalName,
      });
      equal(
        await stores.documents.getDocumentInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          record.id,
        ),
        record,
      );
    }
    const audits = await tx
      .select()
      .from(audit)
      .where(
        and(eq(audit.organizationId, context.tenantId), eq(audit.requestId, shipment.requestId)),
      );
    const expected = [
      ...shipment.documents.map(({ record }) => ({
        action: "traceability.reference_document.created",
        targetType: "traceability_reference_document",
        targetId: record.id,
        before: null,
        after: record,
      })),
      {
        action: "traceability.shipping.draft_created",
        targetType: "traceability_event",
        targetId: shipment.created.id,
        before: null,
        after: shipment.created,
      },
      {
        action: "traceability.shipping.finalized",
        targetType: "traceability_event",
        targetId: shipment.created.id,
        before: shipment.created,
        after: {
          ...shipment.finalized,
          lotIds: [result.outputLotId],
          statusEffects: row.plannedRemainingAfter === "0" ? [result.outputLotId] : [],
        },
      },
      ...(row.plannedRemainingAfter === "0"
        ? [
            {
              action: "traceability.lot.status_changed",
              targetType: "traceability_lot",
              targetId: result.outputLotId,
              before: result.originLot,
              after: {
                ...result.outputLotAfter,
                reason: `Shipping ${shipment.created.eventNumber} finalized`,
                eventId: shipment.created.id,
                origin: "shipping",
              },
            },
          ]
        : []),
    ].map((entry) => ({
      ...entry,
      organizationId: context.tenantId,
      actorUserId: context.actorUserId,
      outcome: "success",
      requestId: shipment.requestId,
      createdAt: clock,
    }));
    equal(
      audits
        .map(
          ({
            organizationId,
            actorUserId,
            action,
            outcome,
            targetType,
            targetId,
            before,
            after,
            requestId,
            createdAt,
          }) =>
            canonicalExportDigest({
              organizationId,
              actorUserId,
              action,
              outcome,
              targetType,
              targetId,
              before,
              after,
              requestId,
              createdAt: createdAt.toISOString(),
            }),
        )
        .sort(),
      expected.map(canonicalExportDigest).sort(),
    );
  }
  const last = plan.at(-1);
  if (!last) throw fail();
  equal(await readCurrentShippingBalance(tx, context.tenantId, result.outputLotId), {
    state: "known",
    unitOfMeasure: "case",
    supply: result.chain.transformation.output.quantity,
    used: String(
      BigInt(result.chain.transformation.output.quantity) - BigInt(last.plannedRemainingAfter),
    ),
    remaining: last.plannedRemainingAfter,
  });
  const consumers = await listCurrentDownstreamConsumers(tx, context.tenantId, [
    result.outputLotId,
  ]);
  equal(
    consumers
      .map((row) => ({
        lotId: row.lotId,
        eventId: row.eventId,
        rootId: row.rootId,
        revision: row.revision,
      }))
      .sort((a, b) => a.eventId.localeCompare(b.eventId)),
    result.shipments
      .map((row) => ({
        lotId: result.outputLotId,
        eventId: row.created.id,
        rootId: row.created.id,
        revision: 1,
      }))
      .sort((a, b) => a.eventId.localeCompare(b.eventId)),
  );
  if (last.plannedRemainingAfter !== "0") {
    const effects = schema.shippingLotStatusEffects;
    equal(
      (
        await tx
          .select()
          .from(effects)
          .where(and(eq(effects.tenantId, context.tenantId), eq(effects.lotId, result.outputLotId)))
      ).length,
      0,
    );
    equal(
      (
        await tx
          .select()
          .from(audit)
          .where(
            and(
              eq(audit.organizationId, context.tenantId),
              eq(audit.targetId, result.outputLotId),
              eq(audit.action, "traceability.lot.status_changed"),
            ),
          )
      ).length,
      0,
    );
  }
}
