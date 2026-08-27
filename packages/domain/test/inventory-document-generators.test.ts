import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  generateInventoryAggregationXml,
  generateInventoryAggregationXmlV2,
  generateInventoryDisaggregationXml,
  InventoryDocumentGenerationError,
  type InventoryDocumentGenerationMetadata,
  type InventoryDocumentGenerationSource,
} from "../src/inventory/document-generators.js";
import { selectEligibleInventoryFinalBoxes } from "../src/inventory/document-selection.js";
import { renderShiftExport } from "../src/shift-exports.js";

const decoder = new TextDecoder();
const GTIN = "04680089900017";
const km = (serial: string) => `01${GTIN}21${serial}\u001d93crypto`;
const BMP_SERIAL = "\uE000";
const SUPPLEMENTARY_SERIAL = "\u{10000}";
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
const aggregationSourceExample = readFileSync(
  new URL(
    "../../../docs/contracts/inventory-documents/v1/source/aggregation.example.xml",
    import.meta.url,
  ),
  "utf8",
);
const disaggregationCompatibilitySchema = readFileSync(
  new URL("../../../docs/contracts/inventory-documents/v1/LP_base_types_v2.xsd", import.meta.url),
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
    writeOffCandidates: [],
    verified: [
      {
        codeHash: "hash-b",
        canonicalRaw: km("SERIAL-B"),
        observedProductionDate: "2026-08-08",
      },
      {
        codeHash: "hash-a",
        canonicalRaw: km("SERIAL-A"),
        observedProductionDate: "2026-08-08",
      },
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
        productionDate: "2026-08-08",
        codeHashes: ["hash-b", "hash-a"],
      },
      {
        sscc: "046800899000256018",
        oldSsccContext: null,
        state: "invalidated",
        printState: "not_ready",
        productionDate: "2026-08-08",
        codeHashes: [],
      },
      {
        sscc: "046800899000256049",
        oldSsccContext: "046800899000256049",
        state: "closed",
        printState: "printed",
        productionDate: "2026-08-08",
        codeHashes: ["hash-protected"],
      },
    ],
  };
}

function selectionSource(): InventoryDocumentGenerationSource {
  const base = source();
  return {
    ...base,
    writeOffCandidates: base.writeOffCandidates,
    verified: [
      ...base.verified,
      ...["OPEN", "INVALIDATED", "PENDING", "FAILED", "PROTECTED", "DUPLICATE"].map((serial) => ({
        codeHash: `hash-${serial.toLowerCase()}`,
        canonicalRaw: km(serial),
        observedProductionDate: "2026-08-08",
      })),
      {
        codeHash: "hash-missing-date",
        canonicalRaw: km("MISSING-DATE"),
        observedProductionDate: null,
      },
      {
        codeHash: "hash-date-mismatch",
        canonicalRaw: km("DATE-MISMATCH"),
        observedProductionDate: "2026-08-09",
      },
      {
        codeHash: "hash-invalid-date",
        canonicalRaw: km("INVALID-DATE"),
        observedProductionDate: "2026-02-30",
      },
    ],
    protected: base.protected,
    newBoxes: [
      ...base.newBoxes,
      {
        sscc: "046800899000256056",
        oldSsccContext: null,
        state: "open",
        printState: "printed",
        productionDate: "2026-08-08",
        codeHashes: ["hash-open"],
      },
      {
        sscc: "046800899000256063",
        oldSsccContext: null,
        state: "closed",
        printState: "printed",
        productionDate: "2026-08-08",
        codeHashes: [],
      },
      {
        sscc: "046800899000256070",
        oldSsccContext: null,
        state: "invalidated",
        printState: "printed",
        productionDate: "2026-08-08",
        codeHashes: ["hash-invalidated"],
      },
      {
        sscc: "046800899000256087",
        oldSsccContext: null,
        state: "closed",
        printState: "pending",
        productionDate: "2026-08-08",
        codeHashes: ["hash-pending"],
      },
      {
        sscc: "046800899000256094",
        oldSsccContext: null,
        state: "closed",
        printState: "failed",
        productionDate: "2026-08-08",
        codeHashes: ["hash-failed"],
      },
      {
        sscc: "046800899000256100",
        oldSsccContext: null,
        state: "closed",
        printState: "printed",
        productionDate: "2026-08-08",
        codeHashes: ["hash-protected"],
      },
      {
        sscc: "046800899000256117",
        oldSsccContext: null,
        state: "closed",
        printState: "printed",
        productionDate: "2026-08-08",
        codeHashes: ["hash-not-found"],
      },
      {
        sscc: "046800899000256124",
        oldSsccContext: null,
        state: "closed",
        printState: "printed",
        productionDate: "2026-08-08",
        codeHashes: ["hash-duplicate", "hash-duplicate"],
      },
      {
        sscc: "046800899000256131",
        oldSsccContext: null,
        state: "closed",
        printState: "printed",
        productionDate: "2026-08-08",
        codeHashes: ["hash-missing-date"],
      },
      {
        sscc: "046800899000256148",
        oldSsccContext: null,
        state: "closed",
        printState: "printed",
        productionDate: "2026-08-08",
        codeHashes: ["hash-date-mismatch"],
      },
      {
        sscc: "046800899000256155",
        oldSsccContext: null,
        state: "closed",
        printState: "printed",
        productionDate: "2026-02-30",
        codeHashes: ["hash-invalid-date"],
      },
    ],
  };
}

describe("current inventory final-box selection", () => {
  it("keeps only closed printed boxes whose unique verified members share a valid date", () => {
    const selected = selectEligibleInventoryFinalBoxes(selectionSource());

    expect(selected.map((box) => box.sscc)).toEqual(["046800899000256001"]);
    expect(selected[0]?.codes.map((code) => code.canonicalRaw)).toEqual([
      km("SERIAL-A"),
      km("SERIAL-B"),
    ]);
  });

  it("sorts eligible boxes by their normalized stored SSCC", () => {
    const base = source();
    const valid = base.newBoxes.find((box) => box.sscc === "046800899000256001");
    if (valid === undefined) throw new Error("expected eligible final-box fixture");
    const selected = selectEligibleInventoryFinalBoxes({
      ...base,
      newBoxes: [
        { ...valid, sscc: "046800899000256018", codeHashes: ["hash-b"] },
        { ...valid, sscc: "046800899000256001", codeHashes: ["hash-a"] },
      ],
    });

    expect(selected.map((box) => box.sscc)).toEqual(["046800899000256001", "046800899000256018"]);
  });

  it("sorts eligible box members by canonical UTF-8 bytes", () => {
    const unicode = source();
    const valid = unicode.newBoxes.find((box) => box.sscc === "046800899000256001");
    if (valid === undefined) throw new Error("expected eligible final-box fixture");
    unicode.verified = [
      {
        codeHash: "supplementary",
        canonicalRaw: km(SUPPLEMENTARY_SERIAL),
        observedProductionDate: "2026-08-08",
      },
      {
        codeHash: "bmp",
        canonicalRaw: km(BMP_SERIAL),
        observedProductionDate: "2026-08-08",
      },
    ];
    unicode.newBoxes = [{ ...valid, codeHashes: ["supplementary", "bmp"] }];

    expect(
      selectEligibleInventoryFinalBoxes(unicode)[0]?.codes.map((code) => code.canonicalRaw),
    ).toEqual([km(BMP_SERIAL), km(SUPPLEMENTARY_SERIAL)]);
  });
});

describe("inventory GISMT aggregation XML", () => {
  it("keeps the checked-in source example structurally aligned with the production serializer", () => {
    expect(aggregationSourceExample).toContain(
      '<unit_pack document_id="11111111-1111-4111-8111-111111111111" VerForm="1.03" file_date_time="2026-08-27T09:10:11.000Z" action_id="30" version="1">',
    );
    expect(aggregationSourceExample).toContain(
      '<Document operation_date_time="2026-08-26T18:00:00.000Z" document_number="INV-EXAMPLE-001">',
    );
    expect(aggregationSourceExample).toContain(
      '<LP_info org_name="ООО «Пример»" LP_TIN="7777777777" />',
    );
  });

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

  it("renders aggregation v2 byte-identically to the shared shift serializer", () => {
    const eligibleBoxes = selectEligibleInventoryFinalBoxes(source());
    const [inventoryPart] = generateInventoryAggregationXmlV2(source(), metadata);
    const [shiftPart] = renderShiftExport({
      formatId: "shift_xml_gismt_aggregation",
      formatVersion: 1,
      productName: "ignored-for-bytes",
      shiftDate: "2026-08-27",
      maxLines: null,
      organizationInn: metadata.organizationInn,
      source: {
        mode: "boxes",
        boxes: eligibleBoxes.map((box) => ({
          sscc: box.sscc,
          codes: box.codes.map((code) => code.canonicalRaw),
        })),
      },
    });

    expect(inventoryPart).toMatchObject({
      partNumber: 1,
      filename: "inventory-INV-2026-0001-aggregation.xml",
      mimeType: "application/xml; charset=utf-8",
      rowCount: 15,
      codeCount: 2,
      boxCount: 1,
    });
    expect(inventoryPart?.bytes).toEqual(shiftPart?.bytes);
  });
});

describe("inventory GISMT disaggregation XML", () => {
  it("checks in the compatibility schema at the exact official include path", () => {
    expect(disaggregationCompatibilitySchema).toContain(
      '<xs:include schemaLocation="source/LP_base_types.xsd"/>',
    );
  });

  it("renders only old boxes used by eligible repacking and omits simple checks and MOVING_BY_UD", () => {
    const withDateMismatch = source();
    withDateMismatch.verified = [
      ...withDateMismatch.verified,
      {
        codeHash: "hash-date-mismatch",
        canonicalRaw: km("DATE-MISMATCH"),
        observedProductionDate: "2026-08-09",
      },
    ];
    withDateMismatch.newBoxes = [
      ...withDateMismatch.newBoxes,
      {
        sscc: "046800899000256018",
        oldSsccContext: "046800899000256025",
        state: "closed",
        printState: "printed",
        productionDate: "2026-08-08",
        codeHashes: ["hash-date-mismatch"],
      },
    ];
    const [part] = generateInventoryDisaggregationXml(withDateMismatch, metadata);

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

  it("renders an empty packings list for zero actionable output instead of failing", () => {
    const onlyProtected = source();
    onlyProtected.newBoxes = onlyProtected.newBoxes.filter(
      (box) => box.oldSsccContext === "046800899000256049",
    );

    const [part] = generateInventoryDisaggregationXml(onlyProtected, metadata);

    expect(part).toMatchObject({
      partNumber: 1,
      filename: "inventory-INV-2026-0001-disaggregation.xml",
      mimeType: "application/xml; charset=utf-8",
      rowCount: 6,
      codeCount: 0,
      boxCount: 0,
    });
    expect(decoder.decode(part?.bytes)).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<disaggregation action_id="31" version="2">',
        `    <trade_participant_inn>${metadata.organizationInn}</trade_participant_inn>`,
        "    <packings_list>",
        "    </packings_list>",
        "</disaggregation>",
        "",
      ].join("\n"),
    );
  });

  it("rejects malformed organization metadata regardless of actionable output", () => {
    expect(() =>
      generateInventoryDisaggregationXml(source(), { ...metadata, organizationInn: "0000000000" }),
    ).toThrow(new InventoryDocumentGenerationError("INVALID_ORGANIZATION_INN"));
  });
});
