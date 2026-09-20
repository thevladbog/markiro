import { describe, expect, it } from "vitest";
import {
  formatGismtAggregationSscc,
  GISMT_AGGREGATION_OVERHEAD_LINE_COUNT,
  GismtAggregationError,
  gismtAggregationBoxLineCount,
  gismtAggregationPalletLineCount,
  renderGismtAggregationXml,
} from "../src/gismt-aggregation.js";

const decoder = new TextDecoder();
const km = "010468008990001721SERIAL-A\u001d93crypto";

/**
 * Every attribute the `Формирование упаковки` v1.03 XSD marks `use="required"`.
 * Omitting any of them is what the ЧЗ portal rejects as «Передаваемый файл XML
 * не соответствует XSD-схеме», so the fixture always carries all of them.
 */
const documentFixture = {
  documentId: "11a0e30d-7cf6-4134-9ce5-68a3792ae8b1",
  documentNumber: "SEP26-003",
  fileDateTime: "2026-09-20T10:00:00.000Z",
  operationDateTime: "2026-09-19T18:00:00.000Z",
  organizationName: "ООО «Пивоварня»",
} as const;

describe("GISMT aggregation XML", () => {
  it("renders the stable XML wire format", () => {
    const rendered = renderGismtAggregationXml({
      organizationInn: "9705119097",
      document: documentFixture,
      boxes: [{ sscc: "046800899000256001", codes: [km] }],
    });

    expect(decoder.decode(rendered.bytes)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<unit_pack document_id="11a0e30d-7cf6-4134-9ce5-68a3792ae8b1" VerForm="1.03"' +
        ' file_date_time="2026-09-20T10:00:00.000Z" action_id="30" version="1">\n' +
        '    <Document operation_date_time="2026-09-19T18:00:00.000Z" document_number="SEP26-003">\n' +
        "        <organisation>\n" +
        "            <id_info>\n" +
        '                <LP_info org_name="ООО «Пивоварня»" LP_TIN="9705119097" />\n' +
        "            </id_info>\n" +
        "        </organisation>\n" +
        "        <pack_content>\n" +
        "            <pack_code>00046800899000256001</pack_code>\n" +
        "            <cis>010468008990001721SERIAL-A</cis>\n" +
        "        </pack_content>\n" +
        "    </Document>\n" +
        "</unit_pack>\n",
    );
    expect(rendered).toMatchObject({ physicalLineCount: 14, codeCount: 1, boxCount: 1 });
    // The attributes ride on lines that already existed, so the part-splitting
    // arithmetic every caller depends on is untouched.
    expect(GISMT_AGGREGATION_OVERHEAD_LINE_COUNT).toBe(10);
    expect(gismtAggregationBoxLineCount({ sscc: "046800899000256001", codes: [km] })).toBe(4);
  });

  it("escapes attribute and text values", () => {
    const rendered = renderGismtAggregationXml({
      organizationInn: "9705119097",
      document: { ...documentFixture, organizationName: 'ООО "Ф&Б" <1>' },
      boxes: [{ sscc: "046800899000256001", codes: [km.replace("SERIAL-A", "A&<B>")] }],
    });

    expect(decoder.decode(rendered.bytes)).toContain(
      'org_name="ООО &quot;Ф&amp;Б&quot; &lt;1&gt;"',
    );
    expect(decoder.decode(rendered.bytes)).toContain(
      "<cis>010468008990001721A&amp;&lt;B&gt;</cis>",
    );
  });

  it.each([
    [
      "missing INN",
      { organizationInn: "", boxes: [{ sscc: "046800899000256001", codes: [km] }] },
      "ORG_INN_MISSING",
    ],
    [
      // A twelve-digit sole-proprietor INN does not fit `LP_TIN_type`; the
      // renderer refuses it rather than emit a file the portal will reject.
      "a non legal-entity INN",
      { organizationInn: "770123456789", boxes: [{ sscc: "046800899000256001", codes: [km] }] },
      "INVALID_ORG_INN",
    ],
    [
      "invalid SSCC",
      { organizationInn: "9705119097", boxes: [{ sscc: "invalid", codes: [km] }] },
      "INVALID_SSCC",
    ],
    [
      "invalid KM",
      { organizationInn: "9705119097", boxes: [{ sscc: "046800899000256001", codes: ["KM-1"] }] },
      "INVALID_CIS",
    ],
    [
      "XML-illegal CIS character",
      {
        organizationInn: "9705119097",
        boxes: [{ sscc: "046800899000256001", codes: [km.replace("SERIAL-A", "A\u0000B")] }],
      },
      "INVALID_CIS",
    ],
  ] as const)("rejects %s", (_case, input, code) => {
    expect(() => renderGismtAggregationXml({ ...input, document: documentFixture })).toThrow(
      new GismtAggregationError(code),
    );
  });

  it.each([
    ["a blank document number", { documentNumber: "   " }],
    ["a blank organization name", { organizationName: "" }],
    ["an over-long document id", { documentId: "x".repeat(151) }],
    ["a non-canonical file timestamp", { fileDateTime: "2026-09-20T10:00:00+03:00" }],
    ["an unparsable operation timestamp", { operationDateTime: "20.09.2026" }],
  ] as const)("rejects %s", (_case, override) => {
    expect(() =>
      renderGismtAggregationXml({
        organizationInn: "9705119097",
        document: { ...documentFixture, ...override },
        boxes: [{ sscc: "046800899000256001", codes: [km] }],
      }),
    ).toThrow(new GismtAggregationError("INVALID_DOCUMENT_METADATA"));
  });
});

describe("GISMT aggregation XML pallets", () => {
  const boxA = "046800899000256001";
  const boxB = "046800899000256018";
  const palletA = "046800899000256025";
  const km1 = "010468008990001721SERIAL-A93crypto";
  const km2 = "010468008990001721SERIAL-B93crypto";
  const boxes = [
    { sscc: boxA, codes: [km1] },
    { sscc: boxB, codes: [km2] },
  ];

  it("emits every box before any pallet", () => {
    const xml = decoder.decode(
      renderGismtAggregationXml({
        organizationInn: "7701234567",
        document: documentFixture,
        boxes,
        pallets: [{ sscc: palletA, boxSsccs: [boxA, boxB] }],
      }).bytes,
    );
    expect(xml.indexOf(formatGismtAggregationSscc(palletA))).toBeGreaterThan(
      xml.indexOf(formatGismtAggregationSscc(boxB)),
    );
  });

  it("nests boxes under a pallet as sscc children, not cis", () => {
    const xml = decoder.decode(
      renderGismtAggregationXml({
        organizationInn: "7701234567",
        document: documentFixture,
        boxes,
        pallets: [{ sscc: palletA, boxSsccs: [boxA, boxB] }],
      }).bytes,
    );
    expect(xml).toContain(`<sscc>${formatGismtAggregationSscc(boxA)}</sscc>`);
    expect(xml).toContain(`<sscc>${formatGismtAggregationSscc(boxB)}</sscc>`);
    expect(xml).not.toContain(`<cis>${boxA}`);
  });

  it("prefixes every pallet SSCC with the 00 application identifier", () => {
    const xml = decoder.decode(
      renderGismtAggregationXml({
        organizationInn: "7701234567",
        document: documentFixture,
        boxes,
        pallets: [{ sscc: palletA, boxSsccs: [boxA, boxB] }],
      }).bytes,
    );
    expect(xml).toContain(`<pack_code>00${palletA}</pack_code>`);
  });

  it("renders exactly today's document when no pallets are given", () => {
    const before = renderGismtAggregationXml({
      organizationInn: "7701234567",
      document: documentFixture,
      boxes,
    });
    const after = renderGismtAggregationXml({
      organizationInn: "7701234567",
      document: documentFixture,
      boxes,
      pallets: [],
    });
    expect(decoder.decode(after.bytes)).toBe(decoder.decode(before.bytes));
  });

  it("counts a pallet block as one plus its boxes plus its two wrapper lines", () => {
    const baseline = renderGismtAggregationXml({
      organizationInn: "7701234567",
      document: documentFixture,
      boxes,
    });
    const pallet3 = { sscc: palletA, boxSsccs: [boxA, boxB, "046800899000256032"] };
    const result = renderGismtAggregationXml({
      organizationInn: "7701234567",
      document: documentFixture,
      boxes,
      pallets: [pallet3],
    });
    expect(gismtAggregationPalletLineCount(pallet3)).toBe(6);
    expect(result.physicalLineCount).toBe(baseline.physicalLineCount + 1 + 3 + 2);
  });

  it("does not count pallets towards codeCount or boxCount", () => {
    const result = renderGismtAggregationXml({
      organizationInn: "7701234567",
      document: documentFixture,
      boxes,
      pallets: [{ sscc: palletA, boxSsccs: [boxA, boxB] }],
    });
    expect(result).toMatchObject({ codeCount: 2, boxCount: 2 });
  });

  it("rejects a malformed pallet SSCC", () => {
    expect(() =>
      renderGismtAggregationXml({
        organizationInn: "7701234567",
        document: documentFixture,
        boxes,
        pallets: [{ sscc: "not-an-sscc", boxSsccs: [boxA] }],
      }),
    ).toThrow(new GismtAggregationError("INVALID_SSCC"));
  });

  it("rejects a pallet naming a malformed member box SSCC", () => {
    expect(() =>
      renderGismtAggregationXml({
        organizationInn: "7701234567",
        document: documentFixture,
        boxes,
        pallets: [{ sscc: palletA, boxSsccs: ["not-an-sscc"] }],
      }),
    ).toThrow(new GismtAggregationError("INVALID_SSCC"));
  });
});
