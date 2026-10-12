import { canonicalExportDigest, isValidSscc } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";
import {
  US_DEMO_VERSION,
  usDemoDefinition,
  usDemoDefinitionDigest,
} from "../src/modules/traceability/demo/us-demo-definition.js";

describe("Scenario A demo definition", () => {
  it("preserves fictional parties, locations and 555 contacts", () => {
    expect(US_DEMO_VERSION).toBe("us-processor-demo-v1");
    expect(usDemoDefinition.profile).toBe("US_FSMA204_PROCESSOR");
    expect(usDemoDefinition.timezone).toBe("America/Los_Angeles");
    expect(usDemoDefinition.parties).toEqual([
      { key: "previous_source", name: "Orchard Slice Supply LLC", phone: "+1 509-555-0101" },
      { key: "processor", name: "North River Fresh Foods LLC", phone: "+1 503-555-0120" },
      { key: "recipient", name: "Harbor Market Distribution Center", phone: "+1 206-555-0147" },
    ]);
    expect(usDemoDefinition.locations).toEqual([
      {
        key: "previous_source",
        partyKey: "previous_source",
        address: "100 Example Orchard Rd, Yakima, WA 98901, USA",
      },
      {
        key: "processor",
        partyKey: "processor",
        address: "500 Example River Pkwy, Portland, OR 97203, USA",
      },
      {
        key: "recipient",
        partyKey: "recipient",
        address: "200 Example Harbor Ave, Seattle, WA 98134, USA",
      },
    ]);
    expect(usDemoDefinition.products).toEqual([
      {
        key: "inbound",
        description: "Fresh-Cut Red Delicious Apple Slices",
        brand: "Orchard Slice",
        packaging: "10 lb bag",
      },
      {
        key: "output",
        description: "Fresh-Cut Apple Snack Cups",
        brand: "North River",
        packaging: "6 oz cups, 24 cups/case",
      },
    ]);
  });

  it("keeps the three-event chain in its original civil dates and units", () => {
    expect(usDemoDefinition.receiving.eventDate).toBe("2026-09-14");
    expect(usDemoDefinition.receiving).toMatchObject({
      previousSourceLocationKey: "previous_source",
      receivingLocationKey: "processor",
    });
    expect(usDemoDefinition.receiving.references).toEqual(["ASN-2026-0914-001", "BOL-0914-A"]);
    expect(
      usDemoDefinition.receiving.lines.map((line) => [line.tlc, line.quantity, line.unitOfMeasure]),
    ).toEqual([
      ["OSS-260914-A1", "500", "lb"],
      ["OSS-260914-A2", "500", "lb"],
    ]);
    expect(usDemoDefinition.transformation.eventDate).toBe("2026-09-15");
    expect(usDemoDefinition.transformation.references).toEqual([
      "WO-2026-0915-APPLECUP",
      "BATCH-2026-0915-01",
    ]);
    expect(usDemoDefinition.transformation.inputs).toEqual(usDemoDefinition.receiving.lines);
    expect(usDemoDefinition.transformation.output).toMatchObject({
      productKey: "output",
      tlc: "NRF-260915-APL01",
      quantity: "100",
      unitOfMeasure: "case",
      tlcSourceLocationKey: "processor",
    });
    expect(usDemoDefinition.transformation.locationKey).toBe("processor");
    expect(usDemoDefinition.shipping).toMatchObject({
      eventDate: "2026-09-16",
      tlc: "NRF-260915-APL01",
      quantity: "100",
      unitOfMeasure: "case",
      shippingLocationKey: "processor",
      recipientLocationKey: "recipient",
      references: ["BOL-0916-H", "INV-2026-0916-047"],
    });
    expect(usDemoDefinition.request).toEqual({
      requestDate: "2026-09-17",
      reference: "REQ-2026-APPLE-001",
    });
  });

  it("produces 100 distinct synthetic SSCCs with valid GS1 checksums", () => {
    expect(usDemoDefinition.cases).toHaveLength(100);
    expect(new Set(usDemoDefinition.cases).size).toBe(100);
    expect(usDemoDefinition.cases.every(isValidSscc)).toBe(true);
    expect(usDemoDefinition.cases[0]).toBe("999999990000000013");
    expect(usDemoDefinition.cases[99]).toBe("999999990000001003");
  });

  it("owns a recursively immutable, deterministic definition without runtime or credential state", async () => {
    const checkFrozen = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) checkFrozen(child);
    };
    checkFrozen(usDemoDefinition);
    const firstLine = usDemoDefinition.receiving.lines[0];
    if (!firstLine) throw new Error("missing demo input line");
    expect(Reflect.set(firstLine, "quantity", "1")).toBe(false);
    expect(usDemoDefinition.receiving.lines[0]?.quantity).toBe("500");
    expect(usDemoDefinitionDigest).toBe(canonicalExportDigest(usDemoDefinition));
    const serialized = JSON.stringify(usDemoDefinition);
    expect(serialized).not.toMatch(
      /password|token|cookie|mfa|authorization|privateKey|approvedAt|receivedAt|dueAt|storageKey/i,
    );
    vi.resetModules();
    const reimported = await import("../src/modules/traceability/demo/us-demo-definition.js");
    expect(reimported.usDemoDefinitionDigest).toBe(usDemoDefinitionDigest);
    expect(reimported.usDemoDefinition).toEqual(usDemoDefinition);
  });
});
