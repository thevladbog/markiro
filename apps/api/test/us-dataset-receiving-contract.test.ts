import { canonicalExportDigest } from "@markiro/domain";
import {
  receivingOperationReceiptV2Schema,
  referenceDocumentSchema,
  traceabilityLotSchema,
} from "@markiro/platform-contracts";
import { describe, expect, it } from "vitest";
import {
  datasetReceivingError,
  makeUsDatasetReferenceIdentity,
  makeUsDatasetReceivingInput,
  parseUsDatasetReceivingInput,
  parseUsDatasetReceivingResult,
  usDatasetReceivingLotIdentity,
  usDatasetReceivingRecordIds,
} from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { parseUsDatasetReferenceResult } from "../src/modules/traceability/demo/us-dataset-reference-contract";
import { parseUsDemoReceipt } from "../src/modules/traceability/demo/us-demo-journal-contract";
import { makeUsSixMonthRegularChain } from "../src/modules/traceability/demo/us-six-month-chains";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { makeUsSixMonthCatalogue } from "../src/modules/traceability/demo/us-six-month-references";

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

describe("immutable bounded dataset Receiving contract", () => {
  it.each([0, 131, 259])("preserves exact regular descriptor %i in owned frozen input", (index) => {
    const references = identity();
    const input = makeUsDatasetReceivingInput(index, references);
    expect(input.chain).toEqual(makeUsSixMonthRegularChain(index));
    expect(input.chain.unitKey).toBe(`chain_${String(index).padStart(4, "0")}`);
    if (index === 259)
      expect(input.chain.receiving.lines.map((x) => x.quantity)).toEqual(["500", "500"]);
    expect(parseUsDatasetReceivingInput(input)).toEqual(input);
    expect(Object.isFrozen(input.chain.receiving.lines)).toBe(true);
  });
  it.each([-1, 260, 0.5, NaN])("rejects nonregular index %s", (index) => {
    expect(() => makeUsDatasetReceivingInput(index, identity())).toThrow(
      "us_dataset_receiving_input_invalid",
    );
  });
  it("binds a complete revision-2 prerequisite and rejects forged receipt/digest/records", () => {
    const stage = referenceStage();
    expect(identity()).toEqual({
      datasetId: uuid(101),
      unitKey: "references",
      stage: "references",
      revision: 2,
      operationKey: uuid(100),
      inputDigest: stage.intent.inputDigest,
      resultDigest: stage.receipt.resultDigest,
    });
    for (const patch of [{ revision: 1 }, { receipt: null }])
      expect(() => makeUsDatasetReferenceIdentity(uuid(101), { ...stage, ...patch })).toThrow(
        "us_dataset_receiving_prerequisite_incomplete",
      );
    const bad = referenceStage();
    bad.receipt.resultDigest = "0".repeat(64);
    expect(() => makeUsDatasetReferenceIdentity(uuid(101), bad)).toThrow(
      "us_dataset_receiving_dependency_conflict",
    );
    bad.receipt.resultDigest = canonicalExportDigest(bad.receipt.result);
    bad.receipt.recordIds[0] = uuid(999);
    expect(() => makeUsDatasetReferenceIdentity(uuid(101), bad)).toThrow(
      "us_dataset_receiving_dependency_conflict",
    );
  });
  it.each([
    "codec",
    "version",
    "digest",
    "dependency",
    "dependency unit",
    "normalization",
    "correction",
    "orphan",
    "quantity",
    "extra",
  ])("rejects input substitution %s", (kind) => {
    const input = structuredClone(makeUsDatasetReceivingInput(259, identity()));
    if (kind === "codec") Object.assign(input, { codec: "other" });
    if (kind === "version") Object.assign(input, { version: "other" });
    if (kind === "digest") Object.assign(input, { definitionDigest: "0".repeat(64) });
    if (kind === "dependency") Object.assign(input.references, { revision: 1 });
    if (kind === "dependency unit") Object.assign(input.references, { unitKey: "chain_0259" });
    if (kind === "normalization")
      Object.assign(input.references, { operationKey: "ABCDEFAB-0000-4000-8000-000000000100" });
    if (kind === "correction" || kind === "orphan")
      Object.assign(input.chain, { unitKey: `${kind}_0000` });
    if (kind === "quantity") Object.assign(at(input.chain.receiving.lines, 0), { quantity: "501" });
    if (kind === "extra") Object.assign(input.chain.receiving, { extra: true });
    expect(() => parseUsDatasetReceivingInput(input)).toThrow("us_dataset_receiving_input_invalid");
  });
  it.each([0, 131, 259])(
    "round trips platform-valid result %i and deduplicates only root/event alias",
    (index) => {
      const raw = fixture(index);
      const parsed = parseUsDatasetReceivingResult(raw);
      expect(parsed).toEqual(raw);
      expect(usDatasetReceivingRecordIds(parsed)).toEqual([
        uuid(110),
        uuid(111),
        uuid(130),
        uuid(120),
        uuid(121),
      ]);
      expect(Object.isFrozen(parsed.finalized.record)).toBe(true);
      expect(Object.isFrozen(raw)).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThan(256 * 1024);
    },
  );
  it.each([
    "key",
    "document",
    "document-parent",
    "archive",
    "order",
    "operation",
    "root",
    "lot",
    "collision",
    "product",
    "source",
    "date",
    "quantity",
    "snapshot",
    "lifecycle",
    "extra",
    "normalize",
  ])("rejects result %s even with recomputed outer digest", (kind) => {
    const raw = fixture();
    const first = at(raw.documents, 0).record;
    const lot = at(raw.lots, 0);
    const created = raw.created.record.content;
    const final = raw.finalized.record.content;
    if (created.kind !== "draft" || final.kind !== "finalized") throw new Error("fixture content");
    if (kind === "key") at(raw.documents, 0).key = "foreign";
    if (kind === "document") first.id = uuid(999);
    if (kind === "document-parent") first.partyId = uuid(999);
    if (kind === "archive") first.archivedAt = stamp;
    if (kind === "order") raw.documents.reverse();
    if (kind === "operation") raw.finalized.operationKey = uuid(999);
    if (kind === "root") raw.finalized.record.lifecycle.rootId = uuid(999);
    if (kind === "lot") lot.id = uuid(999);
    if (kind === "collision") lot.id = first.id;
    if (kind === "product") lot.productId = uuid(999);
    if (kind === "source") lot.source = { kind: "location", locationId: uuid(999) };
    if (kind === "date") created.draft.dateReceived = "2026-09-01";
    if (kind === "quantity") at(final.snapshot.items, 0).quantity = "501";
    if (kind === "snapshot") Object.assign(final.snapshot, { snapshotVersion: 2 });
    if (kind === "lifecycle") raw.finalized.record.lifecycle.lifecycleVersion = 3;
    if (kind === "extra") Object.assign(at(final.snapshot.items, 0), { extra: true });
    if (kind === "normalize")
      lot.productId = lot.productId.toUpperCase().replace("00000000", "ABCDEFAB");
    const receipt = { result: raw, resultDigest: canonicalExportDigest(raw) };
    expect(() => parseUsDatasetReceivingResult(receipt.result)).toThrow(
      "us_dataset_receiving_result_invalid",
    );
  });
  it("rejects unsafe raw input and result before evaluating accessors", () => {
    let reads = 0;
    const cycle: Record<string, unknown> = {};
    cycle["child"] = cycle;
    for (const parse of [parseUsDatasetReceivingInput, parseUsDatasetReceivingResult]) {
      const accessor = Object.defineProperty({}, "codec", {
        enumerable: true,
        get() {
          reads++;
          return "x";
        },
      });
      for (const raw of [
        accessor,
        { [Symbol("hidden")]: true },
        cycle,
        { value: Infinity },
        { padding: "x".repeat(256 * 1024) },
      ])
        expect(() => parse(raw)).toThrow();
    }
    expect(reads).toBe(0);
  });
  it.each(["foreign source-description parent", "conflicting line source-description parents"])(
    "rejects %s with a valid recomputed receipt digest",
    (kind) => {
      const raw = fixture();
      const content = raw.finalized.record.content;
      if (content.kind !== "finalized") throw new Error("fixture content");
      at(content.snapshot.items, 0).sourceDescription.partyId = uuid(999);
      if (kind === "conflicting line source-description parents")
        at(content.snapshot.items, 1).sourceDescription.partyId = uuid(998);
      // Shared schemas correlate location UUIDs, but do not certify the parent correlation.
      expect(receivingOperationReceiptV2Schema.parse(raw.finalized)).toEqual(raw.finalized);
      const receipt = parseUsDemoReceipt({
        recordIds: usDatasetReceivingRecordIds(raw),
        result: raw,
        resultDigest: canonicalExportDigest(raw),
      });
      expect(() => parseUsDatasetReceivingResult(receipt.result)).toThrow(
        "us_dataset_receiving_result_invalid",
      );
    },
  );
  it.each([
    "missing document",
    "extra document",
    "missing lot",
    "extra lot",
    "duplicate lot",
    "duplicate document",
  ])("rejects incomplete or duplicated owned IDs: %s", (kind) => {
    const raw = fixture();
    if (kind === "missing document") raw.documents.pop();
    if (kind === "extra document") raw.documents.push(at(raw.documents, 0));
    if (kind === "missing lot") raw.lots.pop();
    if (kind === "extra lot") raw.lots.push(at(raw.lots, 0));
    if (kind === "duplicate lot") at(raw.lots, 1).id = at(raw.lots, 0).id;
    if (kind === "duplicate document")
      at(raw.documents, 1).record.id = at(raw.documents, 0).record.id;
    expect(() => parseUsDatasetReceivingResult(raw)).toThrow("us_dataset_receiving_result_invalid");
  });
  it("record ID extraction rejects collisions instead of silently deduplicating them", () => {
    const raw = fixture();
    at(raw.lots, 0).id = at(raw.documents, 0).record.id;
    expect(() => usDatasetReceivingRecordIds(raw)).toThrow("us_dataset_receiving_result_invalid");
  });
  it("stable lot identity ignores modification stamps but detects business drift", () => {
    const lot = at(fixture().lots, 0);
    const original = usDatasetReceivingLotIdentity(lot);
    expect(
      usDatasetReceivingLotIdentity({
        ...lot,
        updatedBy: "downstream",
        updatedAt: "2026-10-07T12:00:00.000Z",
      }),
    ).toEqual(original);
    for (const patch of [
      { status: "archived" as const },
      { tlc: "changed" },
      { source: null },
      { revision: 2 },
      { assignmentBasis: "transformation" as const },
      { sourceLockedAt: null },
    ])
      expect(usDatasetReceivingLotIdentity({ ...lot, ...patch })).not.toEqual(original);
    expect(original).toEqual({
      id: uuid(120),
      productId: uuid(47),
      tlc: lot.tlc,
      source: { kind: "location", locationId: uuid(24) },
      assignmentBasis: "imported",
      sourceLockedAt: stamp,
      status: "active",
      revision: 1,
      createdBy: actor,
      createdAt: stamp,
    });
  });
  it.each([
    "lot creation time",
    "document actor",
    "creation update",
    "distinct symbolic locations",
  ])("rejects inconsistent original evidence: %s", (kind) => {
    const raw = fixture();
    if (kind === "lot creation time") at(raw.lots, 0).createdAt = "2026-10-07T12:00:00.000Z";
    if (kind === "document actor") at(raw.documents, 0).record.createdBy = "foreign-owner";
    if (kind === "creation update") raw.created.record.updatedBy = "foreign-owner";
    if (kind === "distinct symbolic locations") {
      const created = raw.created.record.content;
      const final = raw.finalized.record.content;
      if (created.kind !== "draft" || final.kind !== "finalized")
        throw new Error("fixture content");
      created.draft.locationId = created.draft.previousSourceLocationId;
      final.snapshot.locationId = final.snapshot.previousSourceLocationId;
      final.snapshot.locationDescription = final.snapshot.previousSourceDescription;
    }
    expect(() => parseUsDatasetReceivingResult(raw)).toThrow("us_dataset_receiving_result_invalid");
  });
  it("accepts exactly 256 KiB result evidence and rejects one byte over before traversal", () => {
    const raw = fixture();
    const content = raw.finalized.record.content;
    const original = raw.created.record.content;
    if (content.kind !== "finalized" || original.kind !== "draft")
      throw new Error("fixture content");
    const warning = {
      severity: "warning" as const,
      group: "header" as const,
      line: null,
      field: "location" as const,
      code: "incomplete_description" as const,
      detail: "businessName" as const,
    };
    const remaining = 256 * 1024 - Buffer.byteLength(JSON.stringify(raw));
    const rowBytes = Buffer.byteLength(JSON.stringify(warning)) + 1;
    content.snapshot.confirmation.warnings = Array.from(
      { length: Math.floor(remaining / rowBytes) },
      () => ({ ...warning }),
    );
    // Notes occur twice; the baseline marker absorbs the possible single byte remainder.
    content.snapshot.receivedAtNote = "x";
    original.draft.receivedAtNote = "x";
    const deficit = 256 * 1024 - Buffer.byteLength(JSON.stringify(raw));
    content.snapshot.receivedAtNote += "x".repeat(Math.floor(deficit / 2));
    original.draft.receivedAtNote = content.snapshot.receivedAtNote;
    content.snapshot.baselineVersion += "x".repeat(deficit % 2);
    expect(Buffer.byteLength(JSON.stringify(raw))).toBe(256 * 1024);
    expect(parseUsDatasetReceivingResult(raw)).toEqual(raw);
    content.snapshot.baselineVersion += "x";
    expect(Buffer.byteLength(JSON.stringify(raw))).toBe(256 * 1024 + 1);
    expect(() => parseUsDatasetReceivingResult(raw)).toThrow("us_dataset_receiving_result_invalid");
  });
  it("carries exact unit/stage and the original cause", () => {
    const cause = new Error("synthetic dependency");
    expect(
      datasetReceivingError("us_dataset_receiving_mismatch", "chain_0259", cause),
    ).toMatchObject({
      message: "us_dataset_receiving_mismatch",
      unitKey: "chain_0259",
      stage: "receiving",
      cause,
    });
  });
  it("retains known unit context when a nested shared schema rejects evidence", () => {
    const raw = fixture();
    Object.assign(raw.finalized, { receiptVersion: 1 });
    try {
      parseUsDatasetReceivingResult(raw);
      throw new Error("unexpected valid result");
    } catch (error) {
      expect(error).toMatchObject({
        message: "us_dataset_receiving_result_invalid",
        unitKey: "chain_0259",
        stage: "receiving",
      });
    }
  });
  it("retains regular unit context for invalid input headers and builders", () => {
    const raw = structuredClone(makeUsDatasetReceivingInput(259, identity()));
    Object.assign(raw, { codec: "other" });
    const dependency = structuredClone(identity());
    Object.assign(dependency, { revision: 1 });
    for (const parse of [
      () => parseUsDatasetReceivingInput(raw),
      () => makeUsDatasetReceivingInput(259, dependency),
    ]) {
      try {
        parse();
        throw new Error("unexpected valid input");
      } catch (error) {
        expect(error).toMatchObject({
          message: "us_dataset_receiving_input_invalid",
          unitKey: "chain_0259",
          stage: "receiving",
        });
      }
    }
  });
});
