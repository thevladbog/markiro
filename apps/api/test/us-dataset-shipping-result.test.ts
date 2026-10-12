import { describe, expect, it } from "vitest";
import * as contract from "../src/modules/traceability/demo/us-dataset-shipping-contract.js";
import {
  SHIPPING_FIXTURE_STAGE_KEY,
  shippingFixtureUuid as uuid,
  shippingResultFixture,
} from "./support/us-dataset-shipping-result-fixture.js";

// An absent response boundary must fail an assertion after fixture validation/collection.
it("provides a result parser for complete native Shipping evidence", () => {
  const raw = shippingResultFixture(0);
  expect(raw.shipments.map((row) => row.finalized.snapshot.items[0]?.quantity)).toEqual([
    "22",
    "23",
  ]);
  expect(
    contract
      .parseUsDatasetShippingResult(raw)
      .shipments.map((row) => row.finalized.snapshot.items[0]?.quantity),
  ).toEqual(["22", "23"]);
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
function rejected(raw: unknown, unitKey = "chain_0000") {
  try {
    contract.parseUsDatasetShippingResult(raw);
  } catch (error) {
    expect(error).toMatchObject({
      message: "us_dataset_shipping_result_invalid",
      stage: "shipping",
      unitKey,
    });
    return;
  }
  throw new Error("Incoherent Shipping evidence was accepted");
}

describe("native result coherence", () => {
  it("accepts the real native created lifecycle without optional historical fields", () => {
    const raw = shippingResultFixture();
    expect(Object.keys(raw.shipments[0]?.created.lifecycle ?? {})).toEqual([
      "rootId",
      "lifecycleVersion",
      "currentEventId",
      "pendingDraftId",
      "previousRevisionId",
      "amendmentReason",
    ]);
    expect(
      contract
        .parseUsDatasetShippingResult(raw)
        .shipments.map((shipment) => shipment.finalized.snapshot.items[0]?.quantity),
    ).toEqual(["22", "23"]);
  });

  it("accepts a separately sampled lot update after the finalization clock", () => {
    const raw = shippingResultFixture(259);
    raw.outputLotAfter.updatedAt = "2026-10-08T12:00:02.001Z";
    expect(contract.parseUsDatasetShippingResult(raw).outputLotAfter.updatedAt).toBe(
      "2026-10-08T12:00:02.001Z",
    );
  });
  it("rejects a lot update before the finalization clock", () => {
    const raw = shippingResultFixture(259);
    raw.outputLotAfter.updatedAt = "2026-10-08T12:00:01.999Z";
    rejected(raw, "chain_0259");
  });
  it("accepts explicit null historical fields on a created receipt", () => {
    const raw = shippingResultFixture();
    for (const shipment of raw.shipments) {
      for (const field of [
        "supersededByEventId",
        "supersededAt",
        "supersededBy",
        "voidedAt",
        "voidedBy",
        "voidReason",
      ])
        setAt(shipment, `created.lifecycle.${field}`, null);
    }
    expect(
      contract
        .parseUsDatasetShippingResult(raw)
        .shipments.map((shipment) => shipment.finalized.snapshot.items[0]?.quantity),
    ).toEqual(["22", "23"]);
  });
  it.each([
    ["supersededByEventId", uuid(302)],
    ["supersededAt", "2026-10-08T12:00:04.000Z"],
    ["supersededBy", "synthetic-owner"],
    ["voidedAt", "2026-10-08T12:00:04.000Z"],
    ["voidedBy", "synthetic-owner"],
    ["voidReason", "Void"],
  ])("rejects a created receipt with non-null %s", (field, value) => {
    const raw = shippingResultFixture();
    setAt(raw, `shipments.0.created.lifecycle.${field}`, value);
    rejected(raw);
  });
  it.each([
    "supersededByEventId",
    "supersededAt",
    "supersededBy",
    "voidedAt",
    "voidedBy",
    "voidReason",
  ])("requires native finalized null %s", (field) => {
    const raw = shippingResultFixture();
    const lifecycle = raw.shipments[0]?.finalized.lifecycle;
    if (!lifecycle) throw new Error("Missing finalized fixture lifecycle");
    Reflect.deleteProperty(lifecycle, field);
    rejected(raw);
  });
  it.each([
    [0, ["22", "23"], "active", 1],
    [1, ["26", "39"], "shipped", 2],
    [258, ["60"], "shipped", 2],
    [259, ["100"], "shipped", 2],
  ] as const)(
    "retains exact shipment lines and actual lot transition for chain %i",
    (index, quantities, status, revision) => {
      const parsed = contract.parseUsDatasetShippingResult(shippingResultFixture(index));
      expect(parsed.shipments.map((row) => row.finalized.snapshot.items[0]?.quantity)).toEqual(
        quantities,
      );
      expect(parsed.outputLotAfter).toMatchObject({ status, revision });
    },
  );

  // Removing any corresponding coherence check accepts a valid native shape with a false claim.
  it.each([
    ["shipments.0.shipmentNo", 2],
    ["shipments.0.operationKey", uuid(300)],
    ["shipments.0.operationKey", "B3B7AC12-007A-516E-975F-7BCB2FF116FB"],
    ["shipments.0.requestId", `dataset-shipping:${SHIPPING_FIXTURE_STAGE_KEY}:2`],
    ["shipments.1.requestId", `dataset-shipping:${uuid(301)}:2`],
    ["shipments.0.requestId", "dataset-shipping:AAAAAAAA-0000-4000-8000-000000000200:1"],
    ["shipments.0.requestId", `dataset-shipping:${SHIPPING_FIXTURE_STAGE_KEY}:01`],
    ["shipments.0.requestId", `dataset-shipping:${SHIPPING_FIXTURE_STAGE_KEY}:1:extra`],
    ["shipments.0.createInput.operationKey", uuid(302)],
    ["shipments.0.finalizeInput.operationKey", uuid(302)],
    ["shipments.0.finalizeInput.expectedDraftVersion", 2],
    ["shipments.0.finalizeInput.expectedInputDigest", "invalid"],
    ["shipments.0.created.id", uuid(302)],
    ["shipments.0.created.revision", 2],
    ["shipments.0.finalized.revision", 2],
    ["shipments.0.created.draftVersion", 2],
    ["shipments.0.finalized.draftVersion", 2],
    ["shipments.0.finalized.eventNumber", "SHP-26-9001"],
    ["shipments.0.finalized.createdBy", "other-owner"],
    ["shipments.0.created.updatedBy", "other-owner"],
    ["shipments.0.finalized.updatedBy", "other-owner"],
    ["shipments.0.created.updatedAt", "2026-10-08T12:00:02.000Z"],
    ["shipments.0.finalized.createdAt", "2026-10-08T12:00:02.000Z"],
    ["shipments.0.finalized.updatedAt", "2026-10-08T12:00:03.000Z"],
    ["shipments.0.finalized.timeZone", "UTC"],
    ["shipments.0.created.lifecycle.rootId", uuid(302)],
    ["shipments.0.created.lifecycle.lifecycleVersion", 2],
    ["shipments.0.created.lifecycle.currentEventId", uuid(90)],
    ["shipments.0.created.lifecycle.pendingDraftId", null],
    ["shipments.0.created.lifecycle.previousRevisionId", uuid(302)],
    ["shipments.0.created.lifecycle.amendmentReason", "Correction"],
    ["shipments.0.finalized.lifecycle.lifecycleVersion", 1],
    ["shipments.0.finalized.lifecycle.currentEventId", null],
    ["shipments.0.finalized.lifecycle.pendingDraftId", uuid(90)],
    ["shipments.0.finalized.lifecycle.previousRevisionId", uuid(302)],
    ["shipments.0.finalized.lifecycle.amendmentReason", "Correction"],
    ["shipments.0.finalized.lifecycle.supersededByEventId", uuid(302)],
    ["shipments.0.finalized.lifecycle.supersededAt", "2026-10-08T12:00:04.000Z"],
    ["shipments.0.finalized.lifecycle.supersededBy", "synthetic-owner"],
    ["shipments.0.finalized.lifecycle.voidedAt", "2026-10-08T12:00:04.000Z"],
    ["shipments.0.finalized.lifecycle.voidedBy", "synthetic-owner"],
    ["shipments.0.finalized.lifecycle.voidReason", "Void"],
    ["shipments.0.finalized.snapshot.previousRevisionId", uuid(302)],
    ["shipments.0.finalized.snapshot.eventId", uuid(302)],
    ["shipments.0.finalized.snapshot.eventNumber", "SHP-26-9001"],
    ["shipments.0.finalized.snapshot.revision", 2],
    ["shipments.0.finalized.snapshot.timeZone", "UTC"],
    ["shipments.0.finalized.snapshot.finalizedBy", "other-owner"],
    ["shipments.0.finalized.snapshot.finalizedAt", "2026-10-08T12:00:00.000Z"],
    ["shipments.0.finalized.snapshot.eventDate", "2026-04-04"],
    ["shipments.0.finalized.snapshot.shipFrom.locationId", uuid(303)],
    ["shipments.0.finalized.snapshot.recipient.locationId", uuid(303)],
    ["shipments.0.finalized.snapshot.items.0.lineNo", 2],
    ["shipments.0.finalized.snapshot.items.0.lotId", uuid(303)],
    ["shipments.0.finalized.snapshot.items.0.quantity", "23"],
    ["shipments.0.finalized.snapshot.items.0.unitOfMeasure", "each"],
    ["shipments.0.finalized.snapshot.items.0.tlc", "ANOTHER-TLC"],
    ["shipments.0.finalized.snapshot.items.0.source.location.locationId", uuid(303)],
    ["shipments.0.finalized.snapshot.items.0.source.location.businessName", "Another processor"],
    ["shipments.0.finalized.snapshot.carrierReference", "carrier"],
    ["shipments.0.finalized.snapshot.notes", "Other notes"],
    ["shipments.0.documents.0.key", "other-key"],
    ["shipments.0.documents.0.record.createdBy", "other-owner"],
    ["shipments.0.documents.0.record.createdAt", "2026-10-08T12:00:03.000Z"],
    ["shipments.0.documents.0.record.updatedAt", "2026-10-08T12:00:02.000Z"],
    ["shipments.0.documents.0.record.archivedAt", "2026-10-08T12:00:02.000Z"],
    ["shipments.0.documents.0.record.partyId", uuid(303)],
    ["shipments.0.documents.0.record.partyId", null],
    ["shipments.0.documents.0.record.number", "Other-number"],
    ["shipments.0.documents.0.record.issuedOn", "2026-04-04"],
    ["shipments.0.finalized.snapshot.documents.0.id", uuid(303)],
    ["shipments.0.finalized.snapshot.documents.0.type", "invoice"],
    ["shipments.0.finalized.snapshot.documents.0.number", "Other-number"],
    ["shipments.0.finalized.snapshot.documents.0.issuer", null],
    ["shipments.0.finalized.snapshot.documents.0.issuer.id", uuid(303)],
    ["originLot.id", uuid(303)],
    ["originLot.productId", uuid(303)],
    ["originLot.tlc", "Other-TLC"],
    ["originLot.source.locationId", uuid(303)],
    ["originLot.source", null],
    ["originLot.assignmentBasis", "imported"],
    ["originLot.status", "shipped"],
    ["originLot.revision", 2],
    ["originLot.updatedBy", "other-owner"],
    ["originLot.sourceLockedAt", null],
    ["outputLotAfter.source.locationId", uuid(303)],
    ["outputLotAfter.productId", uuid(303)],
    ["outputLotAfter.createdAt", "2026-10-08T12:00:04.000Z"],
    ["outputLotAfter.updatedAt", "2026-10-08T12:00:04.000Z"],
    ["outputLotAfter.status", "shipped"],
    ["outputLotAfter.revision", 2],
    ["shipments.0.created.draft.notes", " Synthetic six-month demo shipment. "],
    ["shipments.0.finalized.draft.notes", "Other notes"],
    ["shipments.0.createInput.draft.items.0.quantity", "23"],
    ["shipments.0.createInput.draft.documentIds.0", uuid(303)],
  ])("rejects drift at %s", (path, value) => {
    const raw = shippingResultFixture();
    setAt(raw, path, value);
    rejected(raw);
  });

  it.each(["shipments", "shipments.0.documents", "shipments.0.finalized.snapshot.documents"])(
    "rejects reordered %s",
    (path) => {
      const raw = shippingResultFixture();
      let rows: unknown = raw;
      for (const part of path.split(".")) {
        if (typeof rows !== "object" || rows === null) throw new Error("Missing array path");
        rows = Reflect.get(rows, part);
      }
      if (!Array.isArray(rows)) throw new Error("Missing fixture array");
      rows.reverse();
      rejected(raw);
    },
  );

  it("rejects omitted recipe shipments", () => {
    const raw = shippingResultFixture();
    raw.shipments.pop();
    rejected(raw);
  });
  it("rejects shared document IDs across otherwise coherent shipments", () => {
    const raw = shippingResultFixture();
    for (const path of [
      "documents.0.record.id",
      "createInput.draft.documentIds.0",
      "created.draft.documentIds.0",
      "finalized.draft.documentIds.0",
      "finalized.snapshot.documents.0.id",
    ])
      setAt(raw, `shipments.1.${path}`, uuid(100));
    rejected(raw);
  });
  it("rejects shared event IDs across otherwise coherent shipments", () => {
    const raw = shippingResultFixture();
    for (const path of [
      "created.id",
      "created.lifecycle.rootId",
      "created.lifecycle.pendingDraftId",
      "finalized.id",
      "finalized.lifecycle.rootId",
      "finalized.lifecycle.currentEventId",
      "finalized.snapshot.eventId",
    ])
      setAt(raw, `shipments.1.${path}`, uuid(90));
    rejected(raw);
  });
  it("rejects a new document that aliases the pre-existing lot", () => {
    const raw = shippingResultFixture();
    for (const path of [
      "documents.0.record.id",
      "createInput.draft.documentIds.0",
      "created.draft.documentIds.0",
      "finalized.draft.documentIds.0",
      "finalized.snapshot.documents.0.id",
    ])
      setAt(raw, `shipments.0.${path}`, uuid(5));
    rejected(raw);
  });
  it("rejects a coherent command and snapshot quantity that differs from the recipe", () => {
    const raw = shippingResultFixture();
    for (const path of [
      "createInput.draft.items.0.quantity",
      "created.draft.items.0.quantity",
      "finalized.draft.items.0.quantity",
      "finalized.snapshot.items.0.quantity",
    ])
      setAt(raw, `shipments.0.${path}`, "21");
    rejected(raw);
  });
  it("rejects changed product descriptions across shipments even when IDs agree", () => {
    const raw = shippingResultFixture();
    setAt(
      raw,
      "shipments.1.finalized.snapshot.items.0.product.description.productName",
      "Another product",
    );
    rejected(raw);
  });
  it("rejects equal recipe location keys resolving to different descriptions", () => {
    const raw = shippingResultFixture();
    setAt(raw, "shipments.1.finalized.snapshot.shipFrom.businessName", "Other processor");
    setAt(
      raw,
      "shipments.1.finalized.snapshot.items.0.source.location.businessName",
      "Other processor",
    );
    rejected(raw);
  });
  it("rejects different recipe recipient keys resolving to one location", () => {
    const raw = shippingResultFixture();
    const recipient = raw.shipments[0]?.finalized.snapshot.recipient;
    if (!recipient) throw new Error("Missing recipient");
    for (const path of [
      "createInput.draft.recipientLocationId",
      "created.draft.recipientLocationId",
      "finalized.draft.recipientLocationId",
    ])
      setAt(raw, `shipments.1.${path}`, recipient.locationId);
    setAt(raw, "shipments.1.finalized.snapshot.recipient", recipient);
    rejected(raw);
  });
  it("retains an arbitrary valid native readiness digest rather than reconstructing old stock", () => {
    const raw = shippingResultFixture();
    setAt(raw, "shipments.0.finalizeInput.expectedInputDigest", "f".repeat(64));
    expect(
      contract.parseUsDatasetShippingResult(raw).shipments[0]?.finalizeInput.expectedInputDigest,
    ).toBe("f".repeat(64));
    expect(Object.keys(contract.parseUsDatasetShippingResult(raw))).toEqual([
      "input",
      "originLot",
      "outputLotAfter",
      "shipments",
    ]);
  });
});

describe("derived native operation ownership", () => {
  it.each([
    [1, "b3b7ac12-007a-516e-975f-7bcb2ff116fb"],
    [2, "f88b7927-1262-59ee-8e57-530dec0aafd2"],
  ])("derives the literal golden operation UUID for shipment %i", (shipmentNo, want) => {
    expect(contract.usDatasetShippingOperationKey(SHIPPING_FIXTURE_STAGE_KEY, shipmentNo)).toBe(
      want,
    );
  });
  it("owns only new documents and event roots, excluding the existing output lot", () => {
    const raw = shippingResultFixture();
    const actual = contract.usDatasetShippingRecordIds(raw);
    expect(actual).toEqual([uuid(100), uuid(101), uuid(90), uuid(110), uuid(111), uuid(91)]);
    expect(actual).not.toContain(raw.originLot.id);
    expect(Object.isFrozen(actual)).toBe(true);
  });

  it.each([0, -0, 3, -1, 1.5, NaN, Infinity, -Infinity])(
    "rejects non-shipment ordinal %s before deriving a UUID",
    (number) => {
      expect(() =>
        contract.usDatasetShippingOperationKey(SHIPPING_FIXTURE_STAGE_KEY, number),
      ).toThrow();
    },
  );
  it.each([
    "invalid",
    " 00000000-0000-4000-8000-000000000200",
    "AAAAAAAA-0000-4000-8000-000000000200",
  ])("rejects noncanonical stage UUID %s", (key) => {
    expect(() => contract.usDatasetShippingOperationKey(key, 1)).toThrow();
  });
  it("refuses ID ownership from unvalidated result evidence", () => {
    const raw = shippingResultFixture();
    setAt(raw, "shipments.0.finalized.snapshot.items.0.quantity", "23");
    expect(() => contract.usDatasetShippingRecordIds(raw)).toThrow(
      "us_dataset_shipping_result_invalid",
    );
  });
});

describe("bounded descriptor-safe evidence", () => {
  it.each([null, [], "text", 12, undefined])("rejects non-object root %s", (raw) =>
    rejected(raw, "unknown"),
  );
  it.each([
    "",
    "input",
    "originLot",
    "shipments.0",
    "shipments.0.finalized.snapshot",
    "shipments.0.finalized.snapshot.items.0.product.description",
  ])("rejects unknown fields at %s", (path) => {
    const raw = shippingResultFixture();
    setAt(raw, path ? `${path}.unexpected` : "unexpected", true);
    rejected(raw, path === "input" ? "unknown" : "chain_0000");
  });
  it.each(["input", "originLot", "shipments.0.finalized.snapshot"])(
    "rejects nested getters before executing them at %s",
    (path) => {
      const raw = shippingResultFixture();
      let reads = 0;
      const value = Object.defineProperty({}, "index", {
        enumerable: true,
        get() {
          reads++;
          return 0;
        },
      });
      setAt(raw, path, value);
      rejected(raw, "unknown");
      expect(reads).toBe(0);
    },
  );
  it("rejects a diagnostic root getter without invoking it", () => {
    let reads = 0;
    const raw = Object.defineProperty({}, "input", {
      enumerable: true,
      get() {
        reads++;
        return shippingResultFixture().input;
      },
    });
    rejected(raw, "unknown");
    expect(reads).toBe(0);
  });
  it.each([
    "originLot",
    "shipments.0.finalized.snapshot.items.0",
    "shipments.0.documents.0.record",
  ])("rejects custom object prototypes at %s", (path) => {
    const raw = shippingResultFixture();
    let value: unknown = raw;
    for (const part of path.split(".")) {
      if (typeof value !== "object" || value === null) throw new Error("Missing fixture object");
      value = Reflect.get(value, part);
    }
    if (typeof value !== "object" || value === null) throw new Error("Missing fixture object");
    Object.setPrototypeOf(value, { inherited: true });
    rejected(raw, "unknown");
  });
  it.each(["shipments", "shipments.0.documents", "shipments.0.finalized.snapshot.items"])(
    "rejects custom arrays at %s",
    (path) => {
      const raw = shippingResultFixture();
      let rows: unknown = raw;
      for (const part of path.split(".")) {
        if (typeof rows !== "object" || rows === null) throw new Error("Missing fixture array");
        rows = Reflect.get(rows, part);
      }
      if (!Array.isArray(rows)) throw new Error("Missing fixture array");
      Object.setPrototypeOf(rows, Object.create(Array.prototype));
      rejected(raw, "unknown");
    },
  );
  it("rejects sparse arrays", () => {
    const raw = shippingResultFixture();
    Reflect.deleteProperty(raw.shipments, "0");
    rejected(raw, "unknown");
  });
  it("rejects an accessor on an array item without invoking it", () => {
    const raw = shippingResultFixture();
    let reads = 0;
    Object.defineProperty(raw.shipments, "0", {
      enumerable: true,
      get() {
        reads++;
        return null;
      },
    });
    rejected(raw, "unknown");
    expect(reads).toBe(0);
  });
  it("rejects hidden and symbol fields", () => {
    for (const key of ["hidden", Symbol("hidden")]) {
      const raw = shippingResultFixture();
      Object.defineProperty(raw.originLot, key, { value: true });
      rejected(raw, "unknown");
    }
  });
  it("rejects cycles before parsing", () => {
    const raw = shippingResultFixture();
    Reflect.set(raw, "cycle", raw);
    rejected(raw, "unknown");
  });
  it("rejects JSON larger than 256 KiB before native schema parsing", () => {
    const raw = shippingResultFixture();
    setAt(raw, "shipments.0.finalized.snapshot.notes", "a".repeat(256 * 1024));
    rejected(raw, "unknown");
  });
  it("rejects JSON deeper than 16 levels before native schema parsing", () => {
    const raw = shippingResultFixture();
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 17; i++) nested = { child: nested };
    Reflect.set(raw, "nested", nested);
    rejected(raw, "unknown");
  });
  it("returns deeply frozen owned copies without aliases to caller evidence", () => {
    const raw = shippingResultFixture();
    const parsed = contract.parseUsDatasetShippingResult(raw);
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) walk(child);
    };
    walk(parsed);
    setAt(raw, "shipments.0.finalized.snapshot.items.0.quantity", "999");
    expect(parsed.shipments[0]?.finalized.snapshot.items[0]?.quantity).toBe("22");
    expect(parsed.input).not.toBe(raw.input);
    expect(parsed.outputLotAfter).not.toBe(raw.outputLotAfter);
  });
  it("preserves driver error identity in the Shipping error cause", () => {
    const cause = new Error("driver failure");
    const error = contract.datasetShippingError(
      "us_dataset_shipping_conflict",
      "chain_0000",
      cause,
    );
    expect(error).toMatchObject({
      message: "us_dataset_shipping_conflict",
      stage: "shipping",
      unitKey: "chain_0000",
    });
    expect(error.cause).toBe(cause);
    expect(
      Object.hasOwn(
        contract.datasetShippingError("us_dataset_shipping_mismatch", "chain_0000"),
        "cause",
      ),
    ).toBe(false);
  });
});
