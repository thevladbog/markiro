import { describe, expect, it } from "vitest";
import {
  PALLET_EXPORT_FORMATS,
  renderPalletAggregationExport,
  ShiftExportDomainError,
} from "../src/index.js";

/** The document attributes the GISMT aggregation XSD requires. */
const documentFixture = {
  documentId: "11a0e30d-7cf6-4134-9ce5-68a3792ae8b1",
  fileDateTime: "2026-09-18T10:00:00.000Z",
  operationDateTime: "2026-09-17T18:00:00.000Z",
};

const pallet = {
  sscc: "134600682000000017",
  boxSsccs: ["034600682000000018", "034600682000000025"],
};

describe("pallet aggregation export", () => {
  it("advertises one xml format", () => {
    expect(PALLET_EXPORT_FORMATS.map((format) => format.id)).toEqual([
      "pallet_xml_gismt_aggregation",
    ]);
  });

  it("renders only the pallet pack_content with sscc children and no cis", () => {
    const part = renderPalletAggregationExport({
      formatId: "pallet_xml_gismt_aggregation",
      formatVersion: 1,
      organizationInn: "7701234567",
      organizationName: "ООО «Кола»",
      productName: "Cola",
      closedDate: "2026-09-17",
      ...documentFixture,
      pallet,
    });
    const xml = Buffer.from(part.bytes).toString("utf8");
    expect(xml).toContain("<pack_code>00134600682000000017</pack_code>");
    // Box members are `<cis>` carrying their SSCCs: the ЧЗ portal rejects
    // `<sscc>` even though the XSD allows it (see `renderGismtAggregationXml`).
    expect(xml).toContain("<cis>00034600682000000018</cis>");
    expect(xml).toContain("<cis>00034600682000000025</cis>");
    expect(xml).not.toContain("<sscc>");
    expect((xml.match(/<pack_content>/g) ?? []).length).toBe(1);
    expect(part).toMatchObject({
      partNumber: 1,
      codeCount: 0,
      boxCount: 2,
      palletCount: 1,
      mimeType: "application/xml; charset=utf-8",
    });
    expect(part.filename).toBe("Cola_2026-09-17_паллета_00134600682000000017_2_коробов.xml");
  });

  it("refuses an empty pallet, a missing INN and an unknown format", () => {
    const base = {
      formatId: "pallet_xml_gismt_aggregation" as const,
      formatVersion: 1,
      organizationInn: "7701234567",
      organizationName: "ООО «Кола»",
      productName: "Cola",
      closedDate: "2026-09-17",
      ...documentFixture,
    };
    expect(() =>
      renderPalletAggregationExport({ ...base, pallet: { sscc: pallet.sscc, boxSsccs: [] } }),
    ).toThrow(ShiftExportDomainError);
    expect(() => renderPalletAggregationExport({ ...base, organizationInn: "", pallet })).toThrow(
      /ORG_INN_MISSING/,
    );
    expect(() => renderPalletAggregationExport({ ...base, formatVersion: 2, pallet })).toThrow(
      /FORMAT_NOT_FOUND/,
    );
  });

  it("reports a malformed box SSCC as INVALID_BOX_SSCC", () => {
    expect(() =>
      renderPalletAggregationExport({
        formatId: "pallet_xml_gismt_aggregation",
        formatVersion: 1,
        organizationInn: "7701234567",
        organizationName: "ООО «Кола»",
        productName: "Cola",
        closedDate: "2026-09-17",
        ...documentFixture,
        pallet: { sscc: pallet.sscc, boxSsccs: ["nonsense"] },
      }),
    ).toThrow(/INVALID_BOX_SSCC/);
  });
});
