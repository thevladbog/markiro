import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  GismtDisaggregationError,
  renderGismtDisaggregationXml,
} from "../src/gismt-disaggregation.js";

const decoder = new TextDecoder();
const golden = readFileSync(
  new URL(
    "../../../docs/contracts/inventory-documents/v1/disaggregation.golden.xml",
    import.meta.url,
  ),
  "utf8",
);

describe("ГИС МТ «Расформирование упаковки»", () => {
  it("is the inventory's golden for its one package", () => {
    const rendered = renderGismtDisaggregationXml({
      organizationInn: "9705119097",
      ssccs: ["046800899000256032"],
    });
    expect(decoder.decode(rendered.bytes)).toBe(golden);
    expect(rendered).toMatchObject({ physicalLineCount: 9, packingCount: 1 });
  });

  it("names each package once, sorted as the inventory sorts them", () => {
    const text = decoder.decode(
      renderGismtDisaggregationXml({
        organizationInn: "781234567890",
        ssccs: ["146007034967100014", "046007034967000017", "146007034967100014"],
      }).bytes,
    );
    expect(text.match(/<packing>/g)).toHaveLength(2);
    expect(text.indexOf("046007034967000017")).toBeLessThan(text.indexOf("146007034967100014"));
    expect(text).toContain("<trade_participant_inn>781234567890</trade_participant_inn>");
  });

  it.each([
    [{ organizationInn: "0000000000", ssccs: ["046007034967000017"] }, "INVALID_ORGANIZATION_INN"],
    [{ organizationInn: "7701234567", ssccs: ["00046007034967000017"] }, "INVALID_SSCC"],
    [{ organizationInn: "7701234567", ssccs: [] }, "EMPTY_SOURCE"],
  ] as const)("refuses %j with %s", (input, code) => {
    expect(() => renderGismtDisaggregationXml(input)).toThrow(new GismtDisaggregationError(code));
  });
});
