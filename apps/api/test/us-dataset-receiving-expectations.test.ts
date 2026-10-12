import { canonicalExportDigest } from "@markiro/domain";
import {
  receivingOperationReceiptV2Schema,
  referenceDocumentSchema,
  traceabilityLotSchema,
} from "@markiro/platform-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  makeUsDatasetReferenceIdentity,
  makeUsDatasetReceivingInput,
  parseUsDatasetReceivingResult,
} from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { parseUsDatasetReferenceResult } from "../src/modules/traceability/demo/us-dataset-reference-contract";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { makeUsSixMonthCatalogue } from "../src/modules/traceability/demo/us-six-month-references";
import * as catalogueFactory from "../src/modules/traceability/demo/us-six-month-references";

// Reuse the codec-valid builders from us-dataset-receiving-contract.test.ts here:
// that file's helpers are private, and its existing assertions stay unchanged.
const stamp = "2026-10-06T12:00:00.000Z";
const actor = "synthetic-owner";
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
function at<T>(rows: readonly T[], index: number): T {
  const row = rows[index];
  if (row === undefined) throw new Error("fixture row missing");
  return row;
}
function referenceStage() {
  const catalogue = makeUsSixMonthCatalogue();
  const parties = catalogue.parties.map(({ key }, i) => ({ key, id: uuid(i + 1) }));
  const locations = catalogue.locations.map(({ key }, i) => ({ key, id: uuid(i + 24) }));
  const products = catalogue.products.map(({ key }, i) => ({ key, id: uuid(i + 47) }));
  const result = parseUsDatasetReferenceResult({
    version: usSixMonthDefinition.version,
    definitionDigest: usSixMonthDefinition.digest,
    bindings: { parties, locations, products },
    evidence: {
      parties: catalogue.parties.map(({ input }, i) => ({
        ...input,
        id: at(parties, i).id,
        archived: false,
        createdAt: stamp,
        updatedAt: stamp,
      })),
      locations: catalogue.locations.map(({ input, partyKey }, i) => ({
        ...input,
        id: at(locations, i).id,
        partyId: at(
          parties.filter(({ key }) => key === partyKey),
          0,
        ).id,
        archived: false,
        createdAt: stamp,
        updatedAt: stamp,
        descriptionStatus: { exportReady: true, issues: [] },
      })),
      products: catalogue.products.map(({ input }, i) => ({
        id: at(products, i).id,
        name: input.name,
        gtin14: null,
        archived: false,
        createdAt: stamp,
        updatedAt: stamp,
      })),
      profiles: catalogue.products.map(({ profile }, i) => {
        const { expectedRevision, ...editable } = profile;
        void expectedRevision;
        return {
          ...editable,
          productId: at(products, i).id,
          revision: 1,
          reviewedBy: actor,
          reviewedAt: stamp,
          createdAt: stamp,
          updatedAt: stamp,
        };
      }),
    },
  });
  const input = {
    version: usSixMonthDefinition.version,
    definitionDigest: usSixMonthDefinition.digest,
    catalogue,
  };
  return {
    unitKey: "references" as const,
    stage: "references" as const,
    revision: 2,
    intent: {
      unitKey: "references",
      stage: "references" as const,
      operationKey: uuid(100),
      input,
      inputDigest: canonicalExportDigest(input),
    },
    receipt: {
      recordIds: [...parties, ...locations, ...products].map(({ id }) => id),
      result,
      resultDigest: canonicalExportDigest(result),
    },
  };
}
function identity() {
  return makeUsDatasetReferenceIdentity(uuid(101), referenceStage());
}
function fixture(index = 259) {
  const input = makeUsDatasetReceivingInput(index, identity());
  const chain = input.chain;
  const source = { kind: "location" as const, locationId: uuid(24) };
  const documents = chain.receiving.references.map((number, i) => {
    const definition = at(
      chain.documents.filter(({ input }) => input.number === number),
      0,
    );
    return {
      key: definition.key,
      record: referenceDocumentSchema.parse({
        ...definition.input,
        id: uuid(110 + i),
        partyId: uuid(1),
        archivedAt: null,
        createdBy: actor,
        createdAt: stamp,
        updatedAt: stamp,
      }),
    };
  });
  const lots = chain.receiving.lines.map((line, i) =>
    traceabilityLotSchema.parse({
      id: uuid(120 + i),
      productId: uuid(47),
      tlc: line.tlc,
      source,
      assignmentBasis: "imported",
      sourceLockedAt: stamp,
      status: "active",
      revision: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt: stamp,
      updatedAt: stamp,
    }),
  );
  const draft = {
    dateReceived: chain.receiving.eventDate,
    locationId: uuid(25),
    previousSourceLocationId: source.locationId,
    receivedAtNote: null,
    notes: null,
    documentIds: documents.map(({ record }) => record.id),
    items: chain.receiving.lines.map((line) => ({
      productId: uuid(47),
      lotLinkMode: "create_on_finalize",
      lotId: null,
      tlc: line.tlc,
      source,
      exemptSupplier: false,
      exemptReason: null,
      supplierLotReference: null,
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
      notes: null,
    })),
  };
  const description = (id: string) => ({
    schemaVersion: 1,
    locationId: id,
    partyId: id === uuid(25) ? uuid(2) : uuid(1),
    businessName: "Synthetic orchard",
    phoneNumber: "+1 509 555 0100",
    address: { kind: "street", streetAddress: "100 Example Rd" },
    city: "Yakima",
    stateOrRegion: "WA",
    zipOrPostalCode: "98901",
    countryCode: "US",
    countryDisplay: "United States",
  });
  const lifecycle = {
    rootId: uuid(130),
    lifecycleVersion: 1,
    previousRevisionId: null,
    supersededByEventId: null,
    currentEventId: null,
    pendingDraftId: uuid(130),
    amendmentReason: null,
    supersededAt: null,
    supersededBy: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
  };
  const record = {
    recordVersion: 2,
    id: uuid(130),
    eventNumber: "REC-26-0001",
    revision: 1,
    draftVersion: 1,
    timeZone: "America/Los_Angeles",
    createdBy: actor,
    updatedBy: actor,
    createdAt: stamp,
    updatedAt: stamp,
    status: "draft",
    lifecycle,
    content: { kind: "draft", draft },
  };
  const created = receivingOperationReceiptV2Schema.parse({
    receiptVersion: 2,
    command: "receiving.create",
    operationKey: uuid(140),
    inputDigest: "a".repeat(64),
    eventId: record.id,
    record,
  });
  const snapshot = {
    snapshotVersion: 3,
    dateReceived: draft.dateReceived,
    locationId: draft.locationId,
    previousSourceLocationId: draft.previousSourceLocationId,
    receivedAtNote: null,
    notes: null,
    profileCode: "US_FSMA204_PROCESSOR",
    baselineVersion: "US-REG-2026-09-03",
    locationDescription: description(uuid(25)),
    previousSourceDescription: description(source.locationId),
    items: draft.items.map((item, i) => {
      const { exemptSupplier, exemptReason, ...common } = item;
      void exemptSupplier;
      void exemptReason;
      return {
        ...common,
        lotId: at(lots, i).id,
        lineNo: i + 1,
        receiptBasis: { kind: "ordinary" },
        lotBinding: { kind: "created" },
        productDescription: {
          snapshotVersion: 1,
          sourceProductId: uuid(47),
          productName: "Fresh-cut apple slices",
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
          reviewedAt: stamp,
        },
        sourceDescription: description(source.locationId),
      };
    }),
    documents: documents.map(({ record }) => {
      const { id, archivedAt, createdBy, createdAt, updatedAt, ...fields } = record;
      void archivedAt;
      void createdBy;
      void createdAt;
      void updatedAt;
      return {
        document: { ...fields, documentId: id, snapshotVersion: 1 },
        issuer: { id: record.partyId, name: "Synthetic supplier", legalName: null },
      };
    }),
    confirmation: {
      ruleVersion: "receiving-readiness-v4",
      inputDigest: "b".repeat(64),
      warnings: [],
      reviewedExemptLines: [],
    },
  };
  const finalized = receivingOperationReceiptV2Schema.parse({
    ...created,
    command: "receiving.finalize",
    inputDigest: "c".repeat(64),
    record: {
      ...record,
      status: "finalized",
      lifecycle: {
        ...lifecycle,
        lifecycleVersion: 2,
        currentEventId: record.id,
        pendingDraftId: null,
      },
      content: { kind: "finalized", finalizedAt: stamp, finalizedBy: actor, snapshot },
    },
  });
  return { input, documents, created, finalized, lots };
}

describe("private Receiving expectations", () => {
  it("reuses owned catalogue expectations across real reference identity calls", () => {
    const stage = referenceStage();
    // spyOn forwards the unchanged factory; setup and module initialization are
    // outside the boundary. Reintroducing per-call construction fails this test.
    const factory = vi.spyOn(catalogueFactory, "makeUsSixMonthCatalogue");
    try {
      const first = makeUsDatasetReferenceIdentity(uuid(101), stage);
      const second = makeUsDatasetReferenceIdentity(uuid(101), stage);
      expect(first).toEqual({
        datasetId: uuid(101),
        unitKey: "references",
        stage: "references",
        revision: 2,
        operationKey: uuid(100),
        inputDigest: stage.intent.inputDigest,
        resultDigest: stage.receipt.resultDigest,
      });
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(Object.isFrozen(second)).toBe(true);
      expect(factory).toHaveBeenCalledTimes(0);
    } finally {
      factory.mockRestore();
    }
  });

  it.each([0, 131, 259])("reuses document expectations for real result %i", (index) => {
    const raw = fixture(index);
    const factory = vi.spyOn(catalogueFactory, "makeUsSixMonthCatalogue");
    try {
      const first = parseUsDatasetReceivingResult(raw);
      const second = parseUsDatasetReceivingResult(raw);
      expect(first).toEqual(raw);
      expect(second).toEqual(raw);
      expect(first).not.toBe(second);
      expect(first.documents).not.toBe(raw.documents);
      expect(first.documents).not.toBe(second.documents);
      expect(Object.isFrozen(second.documents)).toBe(true);
      expect(Object.isFrozen(raw.documents)).toBe(false);
      expect(factory).toHaveBeenCalledTimes(0);
    } finally {
      factory.mockRestore();
    }
  });

  it("rechecks mutated reference input even with a freshly recomputed input digest", () => {
    const stage = structuredClone(referenceStage());
    makeUsDatasetReferenceIdentity(uuid(101), stage);
    Object.assign(at(stage.intent.input.catalogue.parties, 0).input, { name: "Changed supplier" });
    stage.intent.inputDigest = canonicalExportDigest(stage.intent.input);
    expect(() => makeUsDatasetReferenceIdentity(uuid(101), stage)).toThrow(
      "us_dataset_receiving_dependency_conflict",
    );
  });

  it("walks a previously valid result again without evaluating newly added accessors", () => {
    const raw = fixture(0);
    parseUsDatasetReceivingResult(raw);
    let reads = 0;
    Object.defineProperty(at(raw.documents, 0).record, "partyId", {
      enumerable: true,
      get() {
        reads++;
        return uuid(1);
      },
    });
    expect(() => parseUsDatasetReceivingResult(raw)).toThrow("us_dataset_receiving_result_invalid");
    expect(reads).toBe(0);
  });
});
