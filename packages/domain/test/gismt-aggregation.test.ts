import { describe, expect, it } from "vitest";
import {
  GISMT_AGGREGATION_OVERHEAD_LINE_COUNT,
  GismtAggregationError,
  gismtAggregationBoxLineCount,
  renderGismtAggregationXml,
} from "../src/gismt-aggregation.js";

const decoder = new TextDecoder();
const km = "010468008990001721SERIAL-A\u001d93crypto";

describe("GISMT aggregation XML", () => {
  it("renders the stable XML wire format", () => {
    const rendered = renderGismtAggregationXml({
      organizationInn: "9705119097",
      boxes: [{ sscc: "046800899000256001", codes: [km] }],
    });

    expect(decoder.decode(rendered.bytes)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        "<unit_pack>\n" +
        "    <Document>\n" +
        "        <organisation>\n" +
        "            <id_info>\n" +
        '                <LP_info LP_TIN="9705119097" />\n' +
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
    expect(GISMT_AGGREGATION_OVERHEAD_LINE_COUNT).toBe(10);
    expect(gismtAggregationBoxLineCount({ sscc: "046800899000256001", codes: [km] })).toBe(4);
  });

  it("escapes attribute and text values", () => {
    const rendered = renderGismtAggregationXml({
      organizationInn: 'IN"N&1',
      boxes: [{ sscc: "046800899000256001", codes: [km.replace("SERIAL-A", "A&<B>")] }],
    });

    expect(decoder.decode(rendered.bytes)).toContain('<LP_info LP_TIN="IN&quot;N&amp;1" />');
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
    expect(() => renderGismtAggregationXml(input)).toThrow(new GismtAggregationError(code));
  });
});
