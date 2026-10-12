import { canonicalExportDigest } from "@markiro/domain";
import {
  createShippingDraftSchema,
  finalizeShippingSchema,
  referenceDocumentSchema,
  shippingDraftRecordSchema,
  shippingFinalizedRecordSchema,
  traceabilityLotSchema,
} from "@markiro/platform-contracts";
import { makeUsDatasetShippingInput } from "../../src/modules/traceability/demo/us-dataset-shipping-contract.js";

export const shippingFixtureUuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const SHIPPING_FIXTURE_STAGE_KEY = shippingFixtureUuid(200);
const actor = "synthetic-owner";
const originAt = "2026-10-08T12:00:00.000Z";

/** Independently compose complete native response shapes; never call the result parser. */
export function shippingResultFixture(index = 0) {
  const unitKey = `chain_${String(index).padStart(4, "0")}`;
  const references = {
    datasetId: shippingFixtureUuid(1),
    unitKey: "references" as const,
    stage: "references" as const,
    revision: 2 as const,
    operationKey: shippingFixtureUuid(2),
    inputDigest: "a".repeat(64),
    resultDigest: "b".repeat(64),
  };
  const input = makeUsDatasetShippingInput(
    index,
    references,
    { ...references, unitKey, stage: "receiving", operationKey: shippingFixtureUuid(3) },
    { ...references, unitKey, stage: "transformation", operationKey: shippingFixtureUuid(4) },
    shippingFixtureUuid(5),
    shippingFixtureUuid(6),
  );
  const locationIds = new Map([
    ["processor", shippingFixtureUuid(30)],
    ["recipient", shippingFixtureUuid(31)],
    ...Array.from({ length: 11 }, (_, i): [string, string] => [
      `recipient_${String(i + 2).padStart(2, "0")}`,
      shippingFixtureUuid(32 + i),
    ]),
  ]);
  function location(key: string) {
    const locationId = locationIds.get(key);
    if (!locationId) throw new Error("Missing Shipping fixture location");
    return {
      schemaVersion: 1 as const,
      locationId,
      partyId: shippingFixtureUuid(
        key === "processor" ? 50 : key === "recipient" ? 51 : 50 + Number(key.slice(-2)),
      ),
      businessName: `Synthetic ${key}`,
      phoneNumber: "+1 509 555 0100",
      address: { kind: "street" as const, streetAddress: "100 Example Rd" },
      city: "Yakima",
      stateOrRegion: "WA",
      zipOrPostalCode: "98901",
      countryCode: "US",
      countryDisplay: "United States",
    };
  }
  const shipFrom = location("processor");
  const originLot = traceabilityLotSchema.parse({
    id: input.outputLotId,
    productId: input.outputProductId,
    tlc: input.chain.transformation.output.tlc,
    source: { kind: "location", locationId: shipFrom.locationId },
    assignmentBasis: "transformation",
    sourceLockedAt: originAt,
    status: "active",
    revision: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt: originAt,
    updatedAt: originAt,
  });
  const shipments = input.chain.shipping.map((recipe, position) => {
    const shipmentNo = position + 1;
    const createdAt = `2026-10-08T12:00:0${shipmentNo * 2 - 1}.000Z`;
    const finalizedAt = `2026-10-08T12:00:0${shipmentNo * 2}.000Z`;
    // Canonical digest composition is independent of the production UUID helper.
    const hex = canonicalExportDigest({
      namespace: "us-dataset-shipping-operation-v1",
      operationKey: SHIPPING_FIXTURE_STAGE_KEY,
      shipmentNo,
    }).slice(0, 32);
    const variant = ((Number.parseInt(hex.charAt(16), 16) & 3) | 8).toString(16);
    const operationKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
    const documents = recipe.references.map((number, documentNo) => {
      const definition = input.chain.documents.find((entry) => entry.input.number === number);
      if (!definition) throw new Error("Missing Shipping fixture document");
      return {
        key: definition.key,
        record: referenceDocumentSchema.parse({
          ...definition.input,
          id: shippingFixtureUuid(100 + position * 10 + documentNo),
          partyId: location(definition.partyKey).partyId,
          archivedAt: null,
          createdBy: actor,
          createdAt,
          updatedAt: createdAt,
        }),
      };
    });
    const recipient = location(recipe.recipientLocationKey);
    const createInput = createShippingDraftSchema.parse({
      operationKey,
      draft: {
        eventDate: recipe.eventDate,
        shipFromLocationId: shipFrom.locationId,
        recipientLocationId: recipient.locationId,
        carrierReference: null,
        notes: "Synthetic six-month demo shipment.",
        items: [{ lotId: originLot.id, quantity: recipe.quantity, unitOfMeasure: "case" }],
        documentIds: documents.map(({ record }) => record.id),
      },
    });
    const eventId = shippingFixtureUuid(90 + position);
    const lifecycle = {
      rootId: eventId,
      lifecycleVersion: 1,
      currentEventId: null,
      pendingDraftId: eventId,
      previousRevisionId: null,
      amendmentReason: null,
    };
    const created = shippingDraftRecordSchema.parse({
      id: eventId,
      eventNumber: `SHP-26-000${shipmentNo}`,
      revision: 1,
      draftVersion: 1,
      timeZone: "America/Los_Angeles",
      createdBy: actor,
      updatedBy: actor,
      createdAt,
      updatedAt: createdAt,
      status: "draft",
      draft: createInput.draft,
      lifecycle,
    });
    const finalizeInput = finalizeShippingSchema.parse({
      operationKey,
      expectedDraftVersion: 1,
      expectedInputDigest: (position === 0 ? "c" : "d").repeat(64),
    });
    const finalized = shippingFinalizedRecordSchema.parse({
      ...created,
      status: "finalized",
      updatedAt: finalizedAt,
      lifecycle: {
        ...lifecycle,
        lifecycleVersion: 2,
        currentEventId: eventId,
        pendingDraftId: null,
        supersededByEventId: null,
        supersededAt: null,
        supersededBy: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
      },
      snapshot: {
        snapshotVersion: 1,
        eventId,
        eventNumber: created.eventNumber,
        revision: 1,
        eventDate: recipe.eventDate,
        timeZone: created.timeZone,
        shipFrom,
        recipient,
        carrierReference: null,
        notes: createInput.draft.notes,
        items: [
          {
            lineNo: 1,
            lotId: originLot.id,
            quantity: recipe.quantity,
            unitOfMeasure: "case",
            tlc: originLot.tlc,
            source: { kind: "location", location: shipFrom },
            product: {
              id: input.outputProductId,
              description: {
                snapshotVersion: 1,
                sourceProductId: input.outputProductId,
                productName: "Synthetic apple slices",
                brandName: null,
                commodity: null,
                variety: null,
                packagingSize: null,
                packagingStyle: null,
                gtin: null,
              },
              coverage: {
                coverageStatus: "covered",
                coverageRationale: "Synthetic review",
                ftlCategory: "Fruits (fresh-cut)",
                ftlSourceUrl: "https://www.fda.gov/food/",
                ftlSourceVersion: "synthetic-v1",
                reviewedBy: actor,
                reviewedAt: originAt,
              },
            },
          },
        ],
        documents: documents.map(({ record }) => ({
          id: record.id,
          type: record.type,
          number: record.number,
          issuer: { id: record.partyId, name: recipient.businessName, legalName: null },
        })),
        finalizedBy: actor,
        finalizedAt,
      },
    });
    return {
      shipmentNo,
      operationKey,
      requestId: `dataset-shipping:${SHIPPING_FIXTURE_STAGE_KEY}:${shipmentNo}`,
      documents,
      createInput,
      finalizeInput,
      created,
      finalized,
    };
  });
  const shipped = input.chain.shipping.reduce((sum, row) => sum + BigInt(row.quantity), 0n);
  const full = shipped === BigInt(input.chain.transformation.output.quantity);
  const last = shipments.at(-1);
  if (!last) throw new Error("Missing Shipping fixture shipment");
  const outputLotAfter = traceabilityLotSchema.parse(
    full
      ? {
          ...originLot,
          status: "shipped",
          revision: 2,
          updatedAt: last.finalized.snapshot.finalizedAt,
        }
      : originLot,
  );
  return structuredClone({ input, originLot, outputLotAfter, shipments });
}
