import { describe, expect, it } from "vitest";
import {
  parseUsDatasetCorrectedShippingResult,
  usDatasetCorrectedShippingRecordIds,
  datasetCorrectedShippingError,
} from "../src/modules/traceability/demo/us-dataset-corrected-shipping-result.js";
import { parseUsDatasetCorrectedShippingInput } from "../src/modules/traceability/demo/us-dataset-corrected-shipping-contract.js";
import {
  correctedShippingFixture,
  correctedShippingUuid as uuid,
} from "./support/us-dataset-corrected-shipping-result-fixture.js";

// Break caught: absent corrected codec or a full-shipment transition despite ten remaining cases.
it("preserves the active lot after one corrected fifty-case shipment and owns three ordered IDs", () => {
  const raw = correctedShippingFixture();
  expect(parseUsDatasetCorrectedShippingInput(raw.input)).toEqual(raw.input);
  expect(raw.shipments[0]?.finalized.snapshot.items[0]?.quantity).toBe("50");
  const result = parseUsDatasetCorrectedShippingResult(raw);
  expect(result.shipments).toHaveLength(1);
  expect(result.shipments[0]?.finalized.snapshot.items[0]?.quantity).toBe("50");
  expect(result.outputLotAfter.status).toBe("active");
  expect(result).toEqual(raw);
  expect(result.outputLotAfter).toEqual(result.originLot);
  expect(usDatasetCorrectedShippingRecordIds(result)).toHaveLength(3);
  expect(usDatasetCorrectedShippingRecordIds(result)).toEqual([uuid(600), uuid(601), uuid(590)]);
});

function setAt(raw: unknown, path: string, value: unknown): void {
  const parts = path.split(".");
  let target = raw;
  for (const part of parts.slice(0, -1)) {
    if (target === null || typeof target !== "object") throw new Error("Missing fixture path");
    target = Reflect.get(target, part);
  }
  const field = parts.at(-1);
  if (target === null || typeof target !== "object" || !field)
    throw new Error("Missing fixture field");
  Reflect.set(target, field, value);
}
function rejected(raw: unknown): Error {
  try {
    parseUsDatasetCorrectedShippingResult(raw);
  } catch (error) {
    expect(error).toMatchObject({
      message: "us_dataset_corrected_shipping_result_invalid",
      unitKey: "correction_0001",
      stage: "shipping",
    });
    if (!(error instanceof Error)) throw error;
    expect(error.cause).toBeDefined();
    return error;
  }
  throw new Error("Incoherent corrected Shipping receipt accepted");
}

describe("corrected native evidence", () => {
  // Break caught: accepting a valid native shape with false recipe, identity, clock or lifecycle claims.
  it.each([
    ["extra", true],
    ["input.extra", true],
    ["input.codec", "us-dataset-shipping-v1"],
    ["input.definitionDigest", "0".repeat(64)],
    ["input.cases.inputDigest", "0".repeat(64)],
    ["input.casesInput.outputLotId", uuid(999)],
    ["input.chain.shipping.0.quantity", "51"],
    ["input.chain.shipping.0.eventDate", "2026-06-13"],
    ["originLot.id", uuid(999)],
    ["originLot.productId", uuid(999)],
    ["originLot.tlc", "OTHER-TLC"],
    ["originLot.source.locationId", uuid(999)],
    ["originLot.sourceLockedAt", null],
    ["originLot.status", "shipped"],
    ["originLot.assignmentBasis", "imported"],
    ["originLot.updatedBy", "other-owner"],
    ["outputLotAfter.status", "shipped"],
    ["outputLotAfter.revision", 2],
    ["outputLotAfter.updatedAt", "2026-10-09T12:00:02.000Z"],
    ["outputLotAfter.productId", uuid(999)],
    ["shipments.0.extra", true],
    ["shipments.0.shipmentNo", 2],
    ["shipments.0.operationKey", uuid(999)],
    ["shipments.0.requestId", `dataset-shipping:${uuid(800)}:2`],
    ["shipments.0.requestId", `dataset-shipping:${uuid(800)}:01`],
    ["shipments.0.requestId", `dataset-shipping:${uuid(800)}:1:extra`],
    ["shipments.0.requestId", `dataset-shipping:${uuid(800).toUpperCase()}:1`],
    ["shipments.0.createInput.operationKey", uuid(999)],
    ["shipments.0.finalizeInput.operationKey", uuid(999)],
    ["shipments.0.finalizeInput.expectedDraftVersion", 2],
    ["shipments.0.finalizeInput.expectedInputDigest", "bad"],
    ["shipments.0.created.id", uuid(999)],
    ["shipments.0.created.revision", 2],
    ["shipments.0.created.draftVersion", 2],
    ["shipments.0.created.updatedBy", "other-owner"],
    ["shipments.0.created.updatedAt", "2026-10-09T12:00:02.000Z"],
    ["shipments.0.created.lifecycle.rootId", uuid(999)],
    ["shipments.0.created.lifecycle.lifecycleVersion", 2],
    ["shipments.0.created.lifecycle.currentEventId", uuid(590)],
    ["shipments.0.created.lifecycle.pendingDraftId", null],
    ["shipments.0.created.lifecycle.previousRevisionId", uuid(999)],
    ["shipments.0.created.lifecycle.amendmentReason", "Correction"],
    ["shipments.0.finalized.eventNumber", "SHP-26-9999"],
    ["shipments.0.finalized.createdBy", "other-owner"],
    ["shipments.0.finalized.updatedBy", "other-owner"],
    ["shipments.0.finalized.timeZone", "UTC"],
    ["shipments.0.finalized.createdAt", "2026-10-09T12:00:02.000Z"],
    ["shipments.0.finalized.updatedAt", "2026-10-09T12:00:03.000Z"],
    ["shipments.0.finalized.lifecycle.lifecycleVersion", 1],
    ["shipments.0.finalized.lifecycle.currentEventId", null],
    ["shipments.0.finalized.lifecycle.pendingDraftId", uuid(590)],
    ["shipments.0.finalized.lifecycle.previousRevisionId", uuid(999)],
    ["shipments.0.finalized.lifecycle.amendmentReason", "Correction"],
    ["shipments.0.finalized.snapshot.extra", true],
    ["shipments.0.finalized.snapshot.eventId", uuid(999)],
    ["shipments.0.finalized.snapshot.eventNumber", "SHP-26-9999"],
    ["shipments.0.finalized.snapshot.revision", 2],
    ["shipments.0.finalized.snapshot.previousRevisionId", uuid(999)],
    ["shipments.0.finalized.snapshot.finalizedBy", "other-owner"],
    ["shipments.0.finalized.snapshot.finalizedAt", "2026-10-09T11:59:59.000Z"],
    ["shipments.0.finalized.snapshot.eventDate", "2026-06-13"],
    ["shipments.0.finalized.snapshot.shipFrom.locationId", uuid(999)],
    ["shipments.0.finalized.snapshot.recipient.locationId", uuid(999)],
    ["shipments.0.finalized.snapshot.items.0.lineNo", 2],
    ["shipments.0.finalized.snapshot.items.0.lotId", uuid(999)],
    ["shipments.0.finalized.snapshot.items.0.quantity", "51"],
    ["shipments.0.finalized.snapshot.items.0.unitOfMeasure", "each"],
    ["shipments.0.finalized.snapshot.items.0.tlc", "OTHER-TLC"],
    ["shipments.0.finalized.snapshot.items.0.source.location.businessName", "Other processor"],
    ["shipments.0.finalized.snapshot.items.0.product.id", uuid(999)],
    ["shipments.0.finalized.snapshot.items.0.product.description.sourceProductId", uuid(999)],
    ["shipments.0.finalized.snapshot.carrierReference", "carrier"],
    ["shipments.0.finalized.snapshot.notes", "Other notes"],
    ["shipments.0.createInput.draft.notes", " Synthetic six-month demo shipment. "],
    ["shipments.0.documents.0.extra", true],
    ["shipments.0.documents.0.key", "other-key"],
    ["shipments.0.documents.0.record.createdBy", "other-owner"],
    ["shipments.0.documents.0.record.createdAt", "2026-10-09T12:00:03.000Z"],
    ["shipments.0.documents.0.record.updatedAt", "2026-10-09T12:00:02.000Z"],
    ["shipments.0.documents.0.record.archivedAt", "2026-10-09T12:00:02.000Z"],
    ["shipments.0.documents.0.record.partyId", null],
    ["shipments.0.documents.0.record.number", "Other-number"],
    ["shipments.0.documents.0.record.issuedOn", "2026-06-13"],
    ["shipments.0.finalized.snapshot.documents.0.id", uuid(999)],
    ["shipments.0.finalized.snapshot.documents.0.type", "invoice"],
    ["shipments.0.finalized.snapshot.documents.0.issuer", null],
  ])("rejects drift at %s", (path, value) => {
    const raw = correctedShippingFixture();
    setAt(raw, path, value);
    rejected(raw);
  });

  it.each([
    "supersededByEventId",
    "supersededAt",
    "supersededBy",
    "voidedAt",
    "voidedBy",
    "voidReason",
  ])("requires null finalized history %s", (field) => {
    const raw = correctedShippingFixture();
    const lifecycle = raw.shipments[0]?.finalized.lifecycle;
    if (!lifecycle) throw new Error("Missing fixture lifecycle");
    Reflect.deleteProperty(lifecycle, field);
    rejected(raw);
  });
  it.each([
    ["supersededByEventId", uuid(999)],
    ["supersededAt", "2026-10-09T12:00:02.000Z"],
    ["supersededBy", "synthetic-owner"],
    ["voidedAt", "2026-10-09T12:00:02.000Z"],
    ["voidedBy", "synthetic-owner"],
    ["voidReason", "Void"],
  ])("rejects non-null created history %s", (field, value) => {
    const raw = correctedShippingFixture();
    setAt(raw, `shipments.0.created.lifecycle.${field}`, value);
    rejected(raw);
  });
  it("accepts explicit null created history and retains the native readiness digest", () => {
    const raw = correctedShippingFixture();
    for (const field of [
      "supersededByEventId",
      "supersededAt",
      "supersededBy",
      "voidedAt",
      "voidedBy",
      "voidReason",
    ])
      setAt(raw, `shipments.0.created.lifecycle.${field}`, null);
    setAt(raw, "shipments.0.finalizeInput.expectedInputDigest", "f".repeat(64));
    expect(
      parseUsDatasetCorrectedShippingResult(raw).shipments[0]?.finalizeInput.expectedInputDigest,
    ).toBe("f".repeat(64));
  });
  it.each(["quantity", "unitOfMeasure", "eventDate"])(
    "rejects coherent native %s drift from the corrected recipe",
    (field) => {
      const raw = correctedShippingFixture();
      const path = field === "eventDate" ? "" : "items.0.";
      const value = field === "quantity" ? "49" : field === "unitOfMeasure" ? "each" : "2026-06-13";
      for (const prefix of [
        "createInput.draft",
        "created.draft",
        "finalized.draft",
        "finalized.snapshot",
      ])
        setAt(raw, `shipments.0.${prefix}.${path}${field}`, value);
      rejected(raw);
    },
  );
  it.each(["documents", "createInput.draft.documentIds", "finalized.snapshot.documents"])(
    "rejects reordered %s",
    (path) => {
      const raw = correctedShippingFixture();
      let target: unknown = raw.shipments[0];
      for (const part of path.split(".")) {
        if (target === null || typeof target !== "object") throw new Error("Missing fixture array");
        target = Reflect.get(target, part);
      }
      if (!Array.isArray(target)) throw new Error("Missing fixture array");
      target.reverse();
      rejected(raw);
    },
  );
  it.each(["empty", "extra"])("rejects %s shipments", (kind) => {
    const raw = correctedShippingFixture();
    if (kind === "empty") raw.shipments.pop();
    else {
      const shipment = raw.shipments[0];
      if (!shipment) throw new Error("Missing fixture shipment");
      raw.shipments.push(structuredClone(shipment));
    }
    rejected(raw);
  });
  it.each([600, 61, 51, 590])("rejects a document ID aliasing existing or owned ID %i", (id) => {
    const raw = correctedShippingFixture();
    for (const path of [
      "documents.1.record.id",
      "createInput.draft.documentIds.1",
      "created.draft.documentIds.1",
      "finalized.draft.documentIds.1",
      "finalized.snapshot.documents.1.id",
    ])
      setAt(raw, `shipments.0.${path}`, uuid(id));
    rejected(raw);
    expect(() => usDatasetCorrectedShippingRecordIds(raw)).toThrow(
      "us_dataset_corrected_shipping_result_invalid",
    );
  });
});

describe("owned and bounded corrected evidence", () => {
  // Break caught: shallow copies, caller freezing, unsafe property reads or unbounded result traversal.
  it("owns and recursively freezes result and IDs while the caller remains mutable", () => {
    const raw = correctedShippingFixture();
    const parsed = parseUsDatasetCorrectedShippingResult(raw);
    function frozen(value: unknown): void {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) frozen(child);
    }
    frozen(parsed);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Object.isFrozen(raw.shipments[0]?.documents[0]?.record)).toBe(false);
    setAt(raw, "shipments.0.finalized.snapshot.items.0.quantity", "999");
    expect(parsed.shipments[0]?.finalized.snapshot.items[0]?.quantity).toBe("50");
    expect(Object.isFrozen(usDatasetCorrectedShippingRecordIds(parsed))).toBe(true);
    expect(Object.keys(parsed)).toEqual(["input", "originLot", "outputLotAfter", "shipments"]);
  });
  it.each([null, [], "text", 12, undefined])("rejects non-object %s with fixed context", (raw) => {
    rejected(raw);
  });
  it.each(["input", "originLot", "shipments.0.finalized.snapshot"])(
    "rejects getters without reads at %s",
    (path) => {
      const raw = correctedShippingFixture();
      let reads = 0;
      setAt(
        raw,
        path,
        Object.defineProperty({}, "value", {
          enumerable: true,
          get() {
            reads++;
            return 1;
          },
        }),
      );
      rejected(raw);
      expect(reads).toBe(0);
    },
  );
  it("rejects root getters before deriving context", () => {
    let reads = 0;
    const raw = Object.defineProperty({}, "input", {
      enumerable: true,
      get() {
        reads++;
        return correctedShippingFixture().input;
      },
    });
    rejected(raw);
    expect(reads).toBe(0);
  });
  it.each(["sparse", "getter", "extra", "symbol", "prototype"])(
    "rejects %s caller arrays without invoking executable hooks",
    (kind) => {
      const raw = correctedShippingFixture();
      let reads = 0;
      const rows = raw.shipments;
      if (kind === "sparse") Reflect.deleteProperty(rows, "0");
      if (kind === "getter")
        Object.defineProperty(rows, "0", {
          enumerable: true,
          get() {
            reads++;
            return null;
          },
        });
      if (kind === "extra") Object.assign(rows, { extra: true });
      if (kind === "symbol")
        Object.defineProperty(rows, Symbol.iterator, {
          value() {
            reads++;
            throw new Error("Unsafe iterator");
          },
        });
      if (kind === "prototype")
        Object.setPrototypeOf(rows, {
          [Symbol.iterator]() {
            reads++;
            throw new Error("Unsafe iterator");
          },
        });
      rejected(raw);
      expect(reads).toBe(0);
    },
  );
  it.each(["cycle", "symbol", "hidden", "class", "oversize", "secret"])(
    "rejects %s whole-result evidence",
    (kind) => {
      const raw = correctedShippingFixture();
      if (kind === "cycle") Object.assign(raw, { loop: raw });
      if (kind === "symbol") Object.assign(raw, { [Symbol("evidence")]: true });
      if (kind === "hidden") Object.defineProperty(raw, "hidden", { value: true });
      if (kind === "class") Object.setPrototypeOf(raw.originLot, new Date());
      if (kind === "oversize")
        setAt(
          raw,
          "shipments.0.finalized.snapshot.items.0.product.description.productName",
          "x".repeat(256 * 1024),
        );
      if (kind === "secret") Object.assign(raw, { apiToken: "synthetic" });
      const error = rejected(raw);
      if (kind === "oversize")
        expect(error.cause).toMatchObject({ message: "us_demo_json_too_large" });
    },
  );
  it.each([
    "us_dataset_corrected_shipping_result_invalid",
    "us_dataset_corrected_shipping_conflict",
    "us_dataset_corrected_shipping_mismatch",
    "us_dataset_corrected_shipping_prerequisite_incomplete",
  ] as const)("retains cause and fixed context for %s", (code) => {
    const cause = new Error("native-failure");
    const error = datasetCorrectedShippingError(code, cause);
    expect(error).toMatchObject({ message: code, unitKey: "correction_0001", stage: "shipping" });
    expect(error.cause).toBe(cause);
    expect(datasetCorrectedShippingError(code).cause).toBeUndefined();
  });
});
