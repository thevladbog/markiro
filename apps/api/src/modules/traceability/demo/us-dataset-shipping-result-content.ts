import { canonicalExportDigest } from "@markiro/domain";
import {
  platformUuidSchema,
  type TraceabilityLot,
  type ShippingFinalizationSnapshotV1,
} from "@markiro/platform-contracts";
import type {
  UsDatasetShippingPlanRow,
  UsDatasetShippingShipmentResult,
} from "./us-dataset-shipping-contract.js";
import type { UsSixMonthChain } from "./us-six-month-chains.js";

/** Explicit content projection shared by regular and corrected codecs. */
export type UsDatasetShippingResultContent = Readonly<{
  chain: UsSixMonthChain;
  outputLotId: string;
  outputProductId: string;
  plan: readonly UsDatasetShippingPlanRow[];
  originLot: TraceabilityLot;
  outputLotAfter: TraceabilityLot;
  shipments: readonly UsDatasetShippingShipmentResult[];
  operationKeyForShipment: (operationKey: string, shipmentNo: number) => string;
}>;

const uuid = platformUuidSchema.refine((value) => /^[0-9a-f-]+$/.test(value));
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("us_dataset_shipping_evidence_invalid");
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalExportDigest(a) === canonicalExportDigest(b);
}

function atOrAfter(later: string, earlier: string): boolean {
  return Date.parse(later) >= Date.parse(earlier);
}

function checkShipmentLifecycle(shipment: UsDatasetShippingShipmentResult, actor: string): void {
  const { created: first, finalized: last } = shipment;
  const snapshot = last.snapshot;
  valid(first.id === last.id && first.eventNumber === last.eventNumber);
  valid(
    first.revision === 1 &&
      last.revision === 1 &&
      first.draftVersion === 1 &&
      last.draftVersion === 1,
  );
  valid(first.timeZone === "America/Los_Angeles" && last.timeZone === first.timeZone);
  valid(
    first.createdBy === actor &&
      first.updatedBy === actor &&
      last.createdBy === actor &&
      last.updatedBy === actor &&
      snapshot.finalizedBy === actor,
  );
  valid(first.createdAt === first.updatedAt && last.createdAt === first.createdAt);
  valid(
    last.updatedAt === snapshot.finalizedAt && atOrAfter(snapshot.finalizedAt, first.createdAt),
  );
  valid(
    snapshot.eventId === first.id &&
      snapshot.eventNumber === first.eventNumber &&
      snapshot.revision === 1 &&
      snapshot.timeZone === first.timeZone,
  );
  valid(snapshot.previousRevisionId === undefined);
  for (const [record, version, current, pending] of [
    [first, 1, null, first.id],
    [last, 2, last.id, null],
  ] as const) {
    const lifecycle = record.lifecycle;
    valid(lifecycle !== undefined);
    valid(
      lifecycle.rootId === first.id &&
        lifecycle.lifecycleVersion === version &&
        lifecycle.currentEventId === current &&
        lifecycle.pendingDraftId === pending,
    );
    valid(lifecycle.previousRevisionId === null && lifecycle.amendmentReason === null);
    // Native draft reads omit optional historical facts; finalized history reads emit nulls.
    for (const historical of [
      lifecycle.supersededByEventId,
      lifecycle.supersededAt,
      lifecycle.supersededBy,
      lifecycle.voidedAt,
      lifecycle.voidedBy,
      lifecycle.voidReason,
    ])
      valid(historical === null || (record.status === "draft" && historical === undefined));
  }
}

export function checkUsDatasetShippingResultContent(content: UsDatasetShippingResultContent): void {
  const {
    chain,
    outputLotId,
    outputProductId,
    plan,
    originLot: lot,
    outputLotAfter: after,
    shipments,
    operationKeyForShipment,
  } = content;
  valid(shipments.length === plan.length);
  valid(
    lot.id === outputLotId &&
      lot.productId === outputProductId &&
      lot.tlc === chain.transformation.output.tlc,
  );
  valid(lot.assignmentBasis === "transformation" && lot.status === "active" && lot.revision === 1);
  valid(lot.source?.kind === "location" && lot.sourceLockedAt === lot.createdAt);
  const sourceLocationId = lot.source.locationId;
  valid(lot.updatedBy === lot.createdBy && lot.updatedAt === lot.createdAt);
  const actor = lot.createdBy;
  const locations = new Map<string, ShippingFinalizationSnapshotV1["shipFrom"]>();
  const parties = new Map<string, string>();
  const issuers = new Map<string, ShippingFinalizationSnapshotV1["documents"][number]["issuer"]>();
  const ownedIds: string[] = [];
  const nativeKeys: string[] = [];
  const eventNumbers: string[] = [];
  let rootKey: string | undefined;
  let previousTime = lot.createdAt;
  let product: ShippingFinalizationSnapshotV1["items"][number]["product"] | undefined;
  function location(key: string, value: ShippingFinalizationSnapshotV1["shipFrom"]): void {
    const prior = locations.get(key);
    valid(prior === undefined || equal(prior, value));
    locations.set(key, value);
    const party = parties.get(key);
    valid(party === undefined || party === value.partyId);
    parties.set(key, value.partyId);
  }
  shipments.forEach((shipment, index) => {
    const expected = plan[index];
    valid(expected !== undefined);
    const { created: first, finalized: last, createInput, finalizeInput } = shipment;
    const draft = first.draft,
      snapshot = last.snapshot;
    valid(shipment.shipmentNo === index + 1);
    const request =
      /^dataset-shipping:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([12])$/.exec(
        shipment.requestId,
      );
    valid(
      request !== null && request[1] !== undefined && request[2] === String(shipment.shipmentNo),
    );
    const stageKey = uuid.parse(request[1]);
    valid(rootKey === undefined || rootKey === stageKey);
    rootKey = stageKey;
    valid(shipment.operationKey === operationKeyForShipment(stageKey, shipment.shipmentNo));
    valid(
      createInput.operationKey === shipment.operationKey &&
        finalizeInput.operationKey === shipment.operationKey &&
        finalizeInput.expectedDraftVersion === 1,
    );
    // Keep the native readiness digest; its original stock facts are not present in this receipt.
    valid(equal(createInput.draft, draft) && equal(last.draft, draft));
    checkShipmentLifecycle(shipment, actor);
    valid(atOrAfter(first.createdAt, previousTime));
    valid(draft.eventDate === expected.eventDate && snapshot.eventDate === expected.eventDate);
    valid(
      draft.carrierReference === null &&
        snapshot.carrierReference === null &&
        draft.notes === "Synthetic six-month demo shipment." &&
        snapshot.notes === draft.notes,
    );
    valid(
      draft.shipFromLocationId === snapshot.shipFrom.locationId &&
        draft.recipientLocationId === snapshot.recipient.locationId,
    );
    location(expected.shippingLocationKey, snapshot.shipFrom);
    location(expected.recipientLocationKey, snapshot.recipient);
    valid(snapshot.shipFrom.locationId === sourceLocationId);
    valid(
      draft.items.length === 1 &&
        snapshot.items.length === 1 &&
        draft.documentIds.length === 2 &&
        snapshot.documents.length === 2,
    );
    const line = draft.items[0],
      frozen = snapshot.items[0];
    valid(line !== undefined && frozen !== undefined);
    valid(
      equal(line, {
        lotId: lot.id,
        quantity: expected.quantity,
        unitOfMeasure: expected.unitOfMeasure,
      }),
    );
    valid(
      frozen.lineNo === 1 &&
        frozen.lotId === lot.id &&
        frozen.quantity === expected.quantity &&
        frozen.unitOfMeasure === expected.unitOfMeasure &&
        frozen.tlc === lot.tlc,
    );
    valid(frozen.source.kind === "location" && equal(frozen.source.location, snapshot.shipFrom));
    valid(
      frozen.product.id === lot.productId &&
        frozen.product.description.sourceProductId === lot.productId,
    );
    valid(product === undefined || equal(product, frozen.product));
    product = frozen.product;
    shipment.documents.forEach(({ key, record }, documentIndex) => {
      const definitions = chain.documents.filter(
        (entry) => entry.input.number === expected.references[documentIndex],
      );
      const definition = definitions[0],
        saved = snapshot.documents[documentIndex];
      valid(definitions.length === 1 && definition !== undefined && saved !== undefined);
      valid(
        key === definition.key &&
          record.archivedAt === null &&
          record.partyId !== null &&
          record.createdBy === actor,
      );
      valid(
        record.updatedAt === record.createdAt &&
          atOrAfter(record.createdAt, previousTime) &&
          atOrAfter(first.createdAt, record.createdAt),
      );
      const { id, partyId, archivedAt, createdBy, createdAt, updatedAt, ...fields } = record;
      void archivedAt;
      void createdBy;
      void createdAt;
      void updatedAt;
      valid(equal(fields, definition.input));
      valid(
        draft.documentIds[documentIndex] === id &&
          saved.id === id &&
          saved.type === (record.type === "other" ? record.typeOtherLabel : record.type) &&
          saved.number === record.number,
      );
      valid(saved.issuer !== null && saved.issuer.id === partyId);
      const priorParty = parties.get(definition.partyKey);
      valid(priorParty === undefined || priorParty === partyId);
      parties.set(definition.partyKey, partyId);
      const priorIssuer = issuers.get(definition.partyKey);
      valid(priorIssuer === undefined || equal(priorIssuer, saved.issuer));
      issuers.set(definition.partyKey, saved.issuer);
      ownedIds.push(id);
    });
    ownedIds.push(first.id);
    nativeKeys.push(shipment.operationKey);
    eventNumbers.push(first.eventNumber);
    previousTime = snapshot.finalizedAt;
  });
  valid(new Set([...locations.values()].map((value) => value.locationId)).size === locations.size);
  valid(new Set(parties.values()).size === parties.size);
  const distinct = [lot.id, lot.productId, ...ownedIds, ...nativeKeys];
  valid(new Set(distinct.map((id) => id.toLowerCase())).size === distinct.length);
  valid(new Set(eventNumbers).size === eventNumbers.length);
  const full = plan.at(-1)?.plannedRemainingAfter === "0";
  if (full) {
    valid(
      equal(after, {
        ...lot,
        status: "shipped",
        revision: 2,
        updatedBy: actor,
        updatedAt: after.updatedAt,
      }),
    );
    // Native status effects take a later, separate clock sample after finalization.
    valid(atOrAfter(after.updatedAt, previousTime));
  } else valid(equal(after, lot));
}
