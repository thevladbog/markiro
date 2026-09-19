import { describe, expect, it } from "vitest";
import {
  PALLET_EXPORT_FORMATS,
  renderPalletAggregationExport,
  ShiftExportDomainError,
} from "../src/index.js";

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
      productName: "Cola",
      closedDate: "2026-09-17",
      pallet,
    });
    const xml = Buffer.from(part.bytes).toString("utf8");
    expect(xml).toContain("<pack_code>00134600682000000017</pack_code>");
    expect(xml).toContain("<sscc>00034600682000000018</sscc>");
    expect(xml).toContain("<sscc>00034600682000000025</sscc>");
    expect(xml).not.toContain("<cis>");
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
      productName: "Cola",
      closedDate: "2026-09-17",
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
        productName: "Cola",
        closedDate: "2026-09-17",
        pallet: { sscc: pallet.sscc, boxSsccs: ["nonsense"] },
      }),
    ).toThrow(/INVALID_BOX_SSCC/);
  });
});
