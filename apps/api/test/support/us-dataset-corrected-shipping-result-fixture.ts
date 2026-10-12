import { canonicalExportDigest } from "@markiro/domain";
import {
  createShippingDraftSchema,
  finalizeShippingSchema,
  referenceDocumentSchema,
  shippingDraftRecordSchema,
  shippingFinalizedRecordSchema,
  traceabilityLotSchema,
} from "@markiro/platform-contracts";
import type { UsDatasetCorrectedShippingInput } from "../../src/modules/traceability/demo/us-dataset-corrected-shipping-contract.js";
import {
  makeUsSixMonthSpecialExamples,
  usSixMonthDefinition,
} from "../../src/modules/traceability/demo/us-six-month-definition.js";

export const correctedShippingUuid = (n: number) =>
  `abcdefab-1234-4234-8234-${String(n).padStart(12, "0")}`;
const uuid = correctedShippingUuid;
export const CORRECTED_SHIPPING_STAGE_KEY = uuid(800);
const actor = "synthetic-owner";
const originAt = "2026-10-09T12:00:00.000Z";

function correctedInputFixture(): UsDatasetCorrectedShippingInput {
  const casesInput: UsDatasetCorrectedShippingInput["casesInput"] = {
    codec: "us-dataset-corrected-cases-input-v1",
    version: "us-processor-six-month-v1",
    definitionDigest: usSixMonthDefinition.digest,
    references: {
      datasetId: uuid(1),
      unitKey: "references",
      stage: "references",
      revision: 2,
      operationKey: uuid(2),
      inputDigest: "a".repeat(64),
      resultDigest: "b".repeat(64),
    },
    amendment: {
      datasetId: uuid(1),
      unitKey: "correction_0001",
      stage: "amend_receiving",
      revision: 2,
      operationKey: uuid(3),
      inputDigest: "c".repeat(64),
      resultDigest: "d".repeat(64),
    },
    receivingOrigin: {
      rootId: uuid(90),
      eventId: uuid(91),
      revision: 2,
      lifecycleVersion: 4,
      inputLots: [
        { lineNo: 1, lotId: uuid(40) },
        { lineNo: 2, lotId: uuid(41) },
      ],
    },
    transformation: {
      datasetId: uuid(1),
      unitKey: "correction_0001",
      stage: "transformation",
      revision: 2,
      operationKey: uuid(70),
      inputDigest: "e".repeat(64),
      resultDigest: "f".repeat(64),
    },
    transformationOrigin: { rootId: uuid(60), eventId: uuid(60), revision: 1, lifecycleVersion: 2 },
    outputLotId: uuid(61),
    outputProductId: uuid(51),
    support: {
      capturedAt: "2026-10-09T12:00:00.000Z",
      shiftId: uuid(100),
      numberMonthKey: "OCT26",
      numberSeq: 261,
      boxes: makeUsSixMonthSpecialExamples().correction.correctedChain.cases.map((sscc, index) => ({
        id: uuid(101 + index),
        deviceBoxId: `corrected-case-${index + 1}`,
        sscc,
      })),
    },
  };
  return {
    codec: "us-dataset-corrected-shipping-input-v1",
    version: "us-processor-six-month-v1",
    definitionDigest: usSixMonthDefinition.digest,
    casesInput,
    cases: {
      datasetId: uuid(1),
      unitKey: "correction_0001",
      stage: "cases",
      revision: 2,
      operationKey: uuid(80),
      inputDigest: canonicalExportDigest(casesInput),
      resultDigest: "a".repeat(64),
    },
    chain: makeUsSixMonthSpecialExamples().correction.correctedChain,
  };
}

/** Independently compose corrected native receipts; never build regular input or call a result parser. */
export function correctedShippingFixture() {
  const input = correctedInputFixture();
  const locationIds = new Map([
    ["processor", correctedShippingUuid(30)],
    ["recipient", correctedShippingUuid(31)],
    ...Array.from({ length: 11 }, (_, i): [string, string] => [
      `recipient_${String(i + 2).padStart(2, "0")}`,
      correctedShippingUuid(32 + i),
    ]),
  ]);
  function location(key: string) {
    const locationId = locationIds.get(key);
    if (!locationId) throw new Error("Missing Shipping fixture location");
    return {
      schemaVersion: 1 as const,
      locationId,
      partyId: correctedShippingUuid(
        key === "processor" ? 550 : key === "recipient" ? 551 : 550 + Number(key.slice(-2)),
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
    id: input.casesInput.outputLotId,
    productId: input.casesInput.outputProductId,
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
    const createdAt = `2026-10-09T12:00:0${shipmentNo * 2 - 1}.000Z`;
    const finalizedAt = `2026-10-09T12:00:0${shipmentNo * 2}.000Z`;
    // Canonical digest composition is independent of the production UUID helper.
    const hex = canonicalExportDigest({
      namespace: "us-dataset-shipping-operation-v1",
      operationKey: CORRECTED_SHIPPING_STAGE_KEY,
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
          id: correctedShippingUuid(600 + position * 10 + documentNo),
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
    const eventId = correctedShippingUuid(590 + position);
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
              id: input.casesInput.outputProductId,
              description: {
                snapshotVersion: 1,
                sourceProductId: input.casesInput.outputProductId,
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
      requestId: `dataset-shipping:${CORRECTED_SHIPPING_STAGE_KEY}:${shipmentNo}`,
      documents,
      createInput,
      finalizeInput,
      created,
      finalized,
    };
  });
  const outputLotAfter = traceabilityLotSchema.parse(originLot);
  return structuredClone({ input, originLot, outputLotAfter, shipments });
}
