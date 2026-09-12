import { expect, it } from "vitest";
import { readCatalogClassification } from "../src/modules/national-catalog/national-catalog-classification";

const gtin = "04601234567893";
const tnved = { id: 13933, name: "10 знаков ТН ВЭД", value: "2206005901", gtin: null };
const okpd = { id: 900003, name: "Код ОКПД2", value: "11.03.10.110", gtin };
it("reads exact classifier values, retaining leading zeros", () => {
  expect(readCatalogClassification([tnved, okpd], gtin).classification).toEqual({
    tnVedCode: "2206005901",
    okpd2Code: "11.03.10.110",
  });
  expect(
    readCatalogClassification([{ ...tnved, value: "0403905109" }], gtin).classification.tnVedCode,
  ).toBe("0403905109");
});
it("does not guess conflicting, partial, malformed or other-GTIN classifiers", () => {
  for (const attributes of [
    [tnved, { ...tnved, value: "2206008901" }],
    [{ ...tnved, value: "2206" }],
    [{ ...tnved, gtin: "14601234567890" }],
    [{ ...tnved, value: "2206 00 5901" }],
    [{ ...okpd, value: "not a code" }],
    [okpd, { ...okpd, id: 900004 }],
  ]) {
    expect(readCatalogClassification(attributes, gtin).classification).toEqual({
      tnVedCode: null,
      okpd2Code: null,
    });
  }
});
