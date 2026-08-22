import { describe, expect, it } from "vitest";
import {
  dadataAddressSuggestionSchema,
  dadataBankSuggestionSchema,
  dadataOrganizationSuggestionSchema,
  dadataSuggestionStatusSchema,
} from "../src/index.js";

describe("DaData platform contracts", () => {
  it("accepts only normalized internal organization, address, bank, and status fields", () => {
    expect(dadataSuggestionStatusSchema.options).toEqual([
      "ready",
      "unconfigured",
      "unavailable",
      "no_results",
    ]);
    expect(
      dadataOrganizationSuggestionSchema.safeParse({
        value: "ООО Ромашка",
        kind: "legal_entity",
        fullName: "Общество с ограниченной ответственностью Ромашка",
        displayName: "ООО Ромашка",
        inn: "7700000000",
        kpp: "770001001",
        ogrn: "1027700000000",
        ogrnip: null,
        legalAddress: null,
      }).success,
    ).toBe(true);
    expect(
      dadataAddressSuggestionSchema.safeParse({
        value: "г Москва",
        fiasId: null,
        kladrId: null,
        postalCode: null,
        region: "г Москва",
        city: "г Москва",
        settlement: null,
        street: null,
        house: null,
        block: null,
        flat: null,
        latitude: null,
        longitude: null,
        qualityCode: null,
        completenessCode: null,
      }).success,
    ).toBe(true);
    expect(
      dadataBankSuggestionSchema.safeParse({
        value: "ПАО Сбербанк",
        bic: "044525225",
        bankName: "ПАО Сбербанк",
        correspondentAccount: "30101810400000000225",
      }).success,
    ).toBe(true);
    expect(
      dadataBankSuggestionSchema.safeParse({
        value: "ПАО Сбербанк",
        bic: "044525225",
        bankName: "ПАО Сбербанк",
        correspondentAccount: null,
        rawProviderData: { token: "must-not-survive" },
      }).success,
    ).toBe(false);
  });
});
