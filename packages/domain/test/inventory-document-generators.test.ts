import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  generateInventoryAggregationXml,
  generateInventoryDisaggregationXml,
  InventoryDocumentGenerationError,
  type InventoryDocumentGenerationMetadata,
  type InventoryDocumentGenerationSource,
} from "../src/inventory/document-generators.js";

const decoder = new TextDecoder();
const GTIN = "04680089900017";
const km = (serial: string) => `01${GTIN}21${serial}\u001d93crypto`;
const aggregationGolden = readFileSync(
  new URL("../../../docs/contracts/inventory-documents/v1/aggregation.golden.xml", import.meta.url),
  "utf8",
);
const disaggregationGolden = readFileSync(
  new URL(
    "../../../docs/contracts/inventory-documents/v1/disaggregation.golden.xml",
    import.meta.url,
  ),
  "utf8",
);

const metadata: InventoryDocumentGenerationMetadata = {
  documentId: "11111111-1111-4111-8111-111111111111",
  inventoryNumber: "INV-2026-0001",
  fileDateTime: "2026-08-27T09:10:11.000Z",
  operationDateTime: "2026-08-26T18:00:00.000Z",
  organizationName: "ООО «Пивоварня & Ко»",
  organizationInn: "9705119097",
};

function source(): InventoryDocumentGenerationSource {
  return {
    verified: [
      { codeHash: "hash-b", canonicalRaw: km("SERIAL-B") },
      { codeHash: "hash-a", canonicalRaw: km("SERIAL-A") },
    ],
    protected: [
      {
        codeHash: "hash-protected",
        canonicalRaw: km("PROTECTED"),
        parentSscc: "046800899000256049",
      },
    ],
    oldBoxes: [
      { sscc: "046800899000256049" },
      { sscc: "046800899000256032" },
      { sscc: "046800899000256025" },
    ],
    newBoxes: [
      {
        sscc: "046800899000256001",
        oldSsccContext: "046800899000256032",
        state: "closed",
        printState: "printed",
        codeHashes: ["hash-b", "hash-a"],
      },
      {
        sscc: "046800899000256018",
        oldSsccContext: null,
        state: "invalidated",
        printState: "not_ready",
        codeHashes: [],
      },
      {
        sscc: "046800899000256049",
        oldSsccContext: "046800899000256049",
        state: "closed",
        printState: "printed",
        codeHashes: ["hash-protected"],
      },
    ],
  };
}

describe("inventory GISMT aggregation XML", () => {
  it("renders the XSD-required document metadata and only eligible verified new boxes", () => {
    const [part] = generateInventoryAggregationXml(source(), metadata);

    expect(part).toMatchObject({
      partNumber: 1,
      filename: "inventory-INV-2026-0001-aggregation.xml",
      mimeType: "application/xml; charset=utf-8",
      rowCount: 15,
      codeCount: 2,
      boxCount: 1,
    });
    expect(decoder.decode(part?.bytes)).toBe(aggregationGolden);
    expect(decoder.decode(part?.bytes)).not.toContain("PROTECTED");
    expect(decoder.decode(part?.bytes)).not.toContain("00046800899000256049");
  });
});

describe("inventory GISMT disaggregation XML", () => {
  it("renders only old boxes used by eligible repacking and omits simple checks and MOVING_BY_UD", () => {
    const [part] = generateInventoryDisaggregationXml(source(), metadata);

    expect(part).toMatchObject({
      partNumber: 1,
      filename: "inventory-INV-2026-0001-disaggregation.xml",
      mimeType: "application/xml; charset=utf-8",
      rowCount: 9,
      codeCount: 0,
      boxCount: 1,
    });
    expect(decoder.decode(part?.bytes)).toBe(disaggregationGolden);
    expect(decoder.decode(part?.bytes)).not.toContain("046800899000256025");
    expect(decoder.decode(part?.bytes)).not.toContain("046800899000256049");
  });

  it("rejects empty actionable output and malformed organization metadata", () => {
    const onlyProtected = source();
    onlyProtected.newBoxes = onlyProtected.newBoxes.filter(
      (box) => box.oldSsccContext === "046800899000256049",
    );

    expect(() => generateInventoryDisaggregationXml(onlyProtected, metadata)).toThrow(
      new InventoryDocumentGenerationError("EMPTY_SOURCE"),
    );
    expect(() =>
      generateInventoryDisaggregationXml(source(), { ...metadata, organizationInn: "0000000000" }),
    ).toThrow(new InventoryDocumentGenerationError("INVALID_ORGANIZATION_INN"));
  });
});
