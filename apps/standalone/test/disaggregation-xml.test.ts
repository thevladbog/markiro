import { readFileSync } from "node:fs";

import { renderGismtDisaggregationXml } from "@markiro/domain";
import { describe, expect, it } from "vitest";

import { disaggregationReportRowsSchema } from "../src/host/disaggregation.js";
import {
  disaggregationXmlFileName,
  disaggregationXmlFolder,
  formDisaggregationXml,
} from "../src/office/disaggregation/disaggregation-xml.js";

const testModuleUrl = import.meta.url;
const applied = disaggregationReportRowsSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../proto/fixtures/disaggregation-report-rows-boxes.json", testModuleUrl),
      "utf8",
    ),
  ),
);
const decoder = new TextDecoder();

describe("ГИС МТ «Расформирование упаковки» of a document (plan ДЗГ-О)", () => {
  it("is the domain generator's output for the document's SSCCs, boxes and pallets", () => {
    const result = formDisaggregationXml(applied);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = renderGismtDisaggregationXml({
      organizationInn: "7701234567",
      ssccs: ["046007034967000017", "146007034967100014"],
    });
    expect(result.file.bytes).toEqual(expected.bytes);
    expect(result.file.packingCount).toBe(2);
    expect(result.file.name).toBe("disaggregation-DSG-26-0007.xml");
    expect(decoder.decode(result.file.bytes)).toContain(
      "<kitu><![CDATA[146007034967100014]]></kitu>",
    );
  });

  it("names a twice-typed SSCC once", () => {
    const twice = { ...applied, lines: [...applied.lines, ...applied.lines] };
    const result = formDisaggregationXml(twice);
    expect(result.ok && result.file.packingCount).toBe(2);
  });

  it.each([
    [{ ...applied, status: "draft" as const }, "DOCUMENT_NOT_APPLIED"],
    [{ ...applied, organization: { name: "ООО «Атолл»", inn: null } }, "ORG_INN_MISSING"],
    [{ ...applied, organization: { name: "ООО «Атолл»", inn: "  " } }, "ORG_INN_MISSING"],
    [{ ...applied, organization: { name: "ООО «Атолл»", inn: "0000000000" } }, "INVALID_ORG_INN"],
    [{ ...applied, lines: [] }, "NO_PACKINGS"],
  ] as const)("refuses %#: %s", (rows, refusal) => {
    expect(formDisaggregationXml(rows)).toEqual({ ok: false, refusal });
  });

  it("takes a 12-digit INN of an individual entrepreneur (the generator's rule)", () => {
    const result = formDisaggregationXml({
      ...applied,
      organization: { name: "ИП Иванов", inn: "781234567890" },
    });
    expect(result.ok).toBe(true);
  });

  it("saves under Выгрузки\\Дезагрегация in the organization's time", () => {
    expect(
      disaggregationXmlFolder("DSG-26-0007", "2026-10-12T21:30:00.000Z", "Europe/Moscow"),
    ).toEqual([
      "Выгрузки",
      "Дезагрегация",
      "DSG-26-0007",
      "2026-10-13_00-30-00_disaggregation_xml_gismt",
    ]);
    expect(disaggregationXmlFileName("DSG-26-0007")).toBe("disaggregation-DSG-26-0007.xml");
    // A number is written as an export's file name writes a segment.
    expect(disaggregationXmlFileName("DSG/26 0007")).toBe("disaggregation-DSG_26_0007.xml");
  });
});
