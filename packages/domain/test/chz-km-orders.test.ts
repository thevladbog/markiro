import { describe, expect, it } from "vitest";
import {
  buildChzKmOrderBody,
  chzUnitTemplateIdFor,
  kmOrderIssueFileName,
  serializeKmCodesCsv,
  serializeKmCodesTxt,
} from "../src/index.js";

const GS = "\u001d";

describe("chzUnitTemplateIdFor", () => {
  it("maps beer to template 18 and refuses groups with several UNIT templates", () => {
    expect(chzUnitTemplateIdFor("beer")).toBe(18);
    expect(chzUnitTemplateIdFor("nabeer")).toBe(28);
    expect(chzUnitTemplateIdFor("otp")).toBeNull();
    expect(chzUnitTemplateIdFor("unknown")).toBeNull();
  });
});

describe("buildChzKmOrderBody", () => {
  it("is byte-stable and follows the documented key order", () => {
    const body = buildChzKmOrderBody({
      productGroupAlias: "beer",
      gtin14: "04607034690014",
      quantity: 5000,
      templateId: 18,
      contactPerson: "Ковалёва М. А.",
      productionOrderId: "7f2c1a1e-0000-4000-8000-000000000001",
    });
    expect(body).toBe(
      '{"productGroup":"beer","products":[{"gtin":"04607034690014","quantity":5000,' +
        '"serialNumberType":"OPERATOR","templateId":18,"cisType":"UNIT"}],' +
        '"attributes":{"releaseMethodType":"PRODUCTION","contactPerson":"Ковалёва М. А.",' +
        '"productionOrderId":"7f2c1a1e-0000-4000-8000-000000000001"}}',
    );
  });
  it("omits contactPerson when absent", () => {
    const body = buildChzKmOrderBody({
      productGroupAlias: "beer",
      gtin14: "04607034690014",
      quantity: 1,
      templateId: 18,
      productionOrderId: "7f2c1a1e-0000-4000-8000-000000000001",
    });
    expect(JSON.parse(body).attributes).toEqual({
      releaseMethodType: "PRODUCTION",
      productionOrderId: "7f2c1a1e-0000-4000-8000-000000000001",
    });
  });
});

describe("code file serialisers", () => {
  const codes = [`010460703469001421AbC1234${GS}93dGVz`, `010460703469001421XyZ9876${GS}93AAAA`];
  it("writes TXT as one raw code per LF line with the raw GS byte and no BOM", () => {
    const bytes = serializeKmCodesTxt(codes);
    expect(bytes[0]).toBe(0x30);
    const text = Buffer.from(bytes).toString("utf8");
    expect(text).toBe(`${codes[0]}\n${codes[1]}\n`);
    expect(text.includes("\u001d")).toBe(true);
  });
  it("writes CSV with a code header and quoted values", () => {
    const text = Buffer.from(serializeKmCodesCsv([`a"b${GS}c`])).toString("utf8");
    expect(text).toBe(`code\n"a""b${GS}c"\n`);
  });
  it("names the file after the GTIN and the range", () => {
    expect(kmOrderIssueFileName("04607034690014", 1201, 1500, "txt")).toBe(
      "km-04607034690014-1201-1500.txt",
    );
  });
});
