import { describe, expect, it } from "vitest";

import {
  generateInventoryBalancesByProductionDateCsv,
  generateInventoryCurrentStockCsv,
  generateInventoryFinalBoxContentsCsv,
  generateInventoryFinalBoxesTxt,
  generateInventoryWriteOffCsv,
  generateInventoryWriteOffTxt,
  inventoryDocumentFilenamePrefix,
  InventoryDocumentGenerationError,
  type InventoryDocumentGeneratedPart,
  type InventoryDocumentGenerationMetadata,
  type InventoryDocumentGenerationSource,
} from "../src/index.js";

const decoder = new TextDecoder();
const GTIN = "04680089900017";
const km = (serial: string) => `01${GTIN}21${serial}\u001d93crypto`;

const metadata: InventoryDocumentGenerationMetadata = {
  documentId: "11111111-1111-4111-8111-111111111111",
  inventoryNumber: "INV / 2026-0001",
  fileDateTime: "2026-08-27T09:10:11.000Z",
  operationDateTime: "2026-08-26T18:00:00.000Z",
  organizationName: "ООО Пивоварня",
  organizationInn: "9705119097",
};

interface TabularFixtureSource extends InventoryDocumentGenerationSource {
  ineligible: readonly { codeHash: string; canonicalRaw: string }[];
  unknown: readonly { codeHash: string; canonicalRaw: string }[];
  voided: readonly { codeHash: string; canonicalRaw: string }[];
}

function source(): TabularFixtureSource {
  return {
    writeOffCandidates: [
      { codeHash: "missing-b", canonicalRaw: km("MISSING-B") },
      { codeHash: "protected", canonicalRaw: km("PROTECTED") },
      { codeHash: "missing-a", canonicalRaw: km("MISSING-A") },
    ],
    verified: [
      {
        codeHash: "verified-b",
        canonicalRaw: km("VERIFIED-B"),
        observedProductionDate: "2026-08-09",
      },
      {
        codeHash: "verified-a",
        canonicalRaw: km("VERIFIED-A"),
        observedProductionDate: "2026-08-08",
      },
    ],
    protected: [
      {
        codeHash: "protected",
        canonicalRaw: km("PROTECTED"),
        parentSscc: "046800899000256049",
      },
    ],
    oldBoxes: [],
    newBoxes: [
      {
        sscc: "046800899000256018",
        oldSsccContext: null,
        state: "open",
        printState: "printed",
        productionDate: "2026-08-09",
        codeHashes: ["verified-b"],
      },
      {
        sscc: "046800899000256001",
        oldSsccContext: null,
        state: "closed",
        printState: "printed",
        productionDate: "2026-08-08",
        codeHashes: ["verified-a"],
      },
      {
        sscc: "046800899000256049",
        oldSsccContext: null,
        state: "closed",
        printState: "printed",
        productionDate: "2026-08-08",
        codeHashes: ["protected"],
      },
      {
        sscc: "046800899000256025",
        oldSsccContext: null,
        state: "closed",
        printState: "printed",
        productionDate: "2026-08-08",
        codeHashes: ["unknown"],
      },
    ],
    ineligible: [{ codeHash: "ineligible", canonicalRaw: km("INELIGIBLE") }],
    unknown: [{ codeHash: "unknown", canonicalRaw: km("UNKNOWN") }],
    voided: [{ codeHash: "voided", canonicalRaw: km("VOIDED") }],
  };
}

function emptySource(): InventoryDocumentGenerationSource {
  return {
    writeOffCandidates: [],
    verified: [],
    protected: [],
    oldBoxes: [],
    newBoxes: [],
  };
}

function decode(part: InventoryDocumentGeneratedPart | undefined): string {
  if (part === undefined) throw new Error("expected one generated document part");
  return decoder.decode(part.bytes);
}

function decodeCsv(part: InventoryDocumentGeneratedPart | undefined): string {
  if (part === undefined) throw new Error("expected one generated document part");
  expect([...part.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  return decoder.decode(part.bytes.slice(3));
}

describe("inventory tabular document generators", () => {
  it("renders sorted full canonical write-off codes as exact LF TXT and BOM CSV bytes", () => {
    const [txt] = generateInventoryWriteOffTxt(source(), metadata);
    const [csv] = generateInventoryWriteOffCsv(source(), metadata);

    expect(decode(txt)).toBe(`${km("MISSING-A")}\n${km("MISSING-B")}\n`);
    expect(decodeCsv(csv)).toBe(`code\r\n${km("MISSING-A")}\r\n${km("MISSING-B")}\r\n`);
    expect(txt).toMatchObject({
      partNumber: 1,
      filename: "inventory-INV-2026-0001-write-off.txt",
      mimeType: "text/plain; charset=utf-8",
      rowCount: 2,
      codeCount: 2,
      boxCount: 0,
    });
    expect(csv).toMatchObject({
      partNumber: 1,
      filename: "inventory-INV-2026-0001-write-off.csv",
      mimeType: "text/csv; charset=utf-8",
      rowCount: 3,
      codeCount: 2,
      boxCount: 0,
    });
  });

  it("renders only sorted verified current codes with their GS and crypto tails", () => {
    const [part] = generateInventoryCurrentStockCsv(source(), metadata);

    expect(decodeCsv(part)).toBe(`code\r\n${km("VERIFIED-A")}\r\n${km("VERIFIED-B")}\r\n`);
    expect(part).toMatchObject({
      partNumber: 1,
      filename: "inventory-INV-2026-0001-current-stock.csv",
      mimeType: "text/csv; charset=utf-8",
      rowCount: 3,
      codeCount: 2,
      boxCount: 0,
    });
    expect(decodeCsv(part)).not.toMatch(/PROTECTED|INELIGIBLE|UNKNOWN|VOIDED/);
  });

  it("renders only eligible final boxes with 00-prefixed SSCCs and full canonical codes", () => {
    const [contents] = generateInventoryFinalBoxContentsCsv(source(), metadata);
    const [boxes] = generateInventoryFinalBoxesTxt(source(), metadata);

    expect(decodeCsv(contents)).toBe(
      `box_sscc;code\r\n00046800899000256001;${km("VERIFIED-A")}\r\n`,
    );
    expect(decode(boxes)).toBe("00046800899000256001\n");
    expect(contents).toMatchObject({
      partNumber: 1,
      filename: "inventory-INV-2026-0001-final-box-contents.csv",
      mimeType: "text/csv; charset=utf-8",
      rowCount: 2,
      codeCount: 1,
      boxCount: 1,
    });
    expect(boxes).toMatchObject({
      partNumber: 1,
      filename: "inventory-INV-2026-0001-final-boxes.txt",
      mimeType: "text/plain; charset=utf-8",
      rowCount: 1,
      codeCount: 0,
      boxCount: 1,
    });
    expect(`${decodeCsv(contents)}${decode(boxes)}`).not.toMatch(
      /PROTECTED|INELIGIBLE|UNKNOWN|VOIDED|256018|256025|256049/,
    );
  });

  it("groups verified codes directly and eligible boxes by production date", () => {
    const [part] = generateInventoryBalancesByProductionDateCsv(source(), metadata);

    expect(decodeCsv(part)).toBe(
      "production_date;code_count;box_count\r\n2026-08-08;1;1\r\n2026-08-09;1;0\r\n",
    );
    expect(part).toMatchObject({
      partNumber: 1,
      filename: "inventory-INV-2026-0001-balances-by-production-date.csv",
      mimeType: "text/csv; charset=utf-8",
      rowCount: 3,
      codeCount: 2,
      boxCount: 1,
    });
  });

  it("emits zero-byte TXT and BOM-plus-header CSV artifacts for an empty source", () => {
    const empty = emptySource();
    const [writeOffTxt] = generateInventoryWriteOffTxt(empty, metadata);
    const [writeOffCsv] = generateInventoryWriteOffCsv(empty, metadata);
    const [currentStock] = generateInventoryCurrentStockCsv(empty, metadata);
    const [boxContents] = generateInventoryFinalBoxContentsCsv(empty, metadata);
    const [finalBoxes] = generateInventoryFinalBoxesTxt(empty, metadata);
    const [balances] = generateInventoryBalancesByProductionDateCsv(empty, metadata);

    expect(writeOffTxt?.bytes).toHaveLength(0);
    expect(finalBoxes?.bytes).toHaveLength(0);
    expect(decodeCsv(writeOffCsv)).toBe("code\r\n");
    expect(decodeCsv(currentStock)).toBe("code\r\n");
    expect(decodeCsv(boxContents)).toBe("box_sscc;code\r\n");
    expect(decodeCsv(balances)).toBe("production_date;code_count;box_count\r\n");
    expect(writeOffTxt).toMatchObject({ rowCount: 0, codeCount: 0, boxCount: 0 });
    expect(writeOffCsv).toMatchObject({ rowCount: 1, codeCount: 0, boxCount: 0 });
    expect(currentStock).toMatchObject({ rowCount: 1, codeCount: 0, boxCount: 0 });
    expect(boxContents).toMatchObject({ rowCount: 1, codeCount: 0, boxCount: 0 });
    expect(finalBoxes).toMatchObject({ rowCount: 0, codeCount: 0, boxCount: 0 });
    expect(balances).toMatchObject({ rowCount: 1, codeCount: 0, boxCount: 0 });
  });

  it.each([null, "2026/08/08"])(
    "fails closed when a verified code has missing or invalid production date %s",
    (observedProductionDate) => {
      const invalid = emptySource();
      invalid.verified = [
        {
          codeHash: "verified",
          canonicalRaw: km("VERIFIED"),
          observedProductionDate,
        },
      ];

      expect(() => generateInventoryBalancesByProductionDateCsv(invalid, metadata)).toThrow(
        new InventoryDocumentGenerationError("VERIFIED_PRODUCTION_DATE_MISSING"),
      );
    },
  );

  it("exports the shared sanitized inventory filename prefix", () => {
    expect(inventoryDocumentFilenamePrefix(" INV / 2026-0001 ")).toBe("inventory-INV-2026-0001");
  });
});
