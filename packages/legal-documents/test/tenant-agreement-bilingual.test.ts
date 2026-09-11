import { describe, expect, it } from "vitest";

import { buildTenantAgreement } from "../src/documents/tenant-agreement.js";
import {
  AGREEMENT_MONOLINGUAL_SECTION_IDS,
  pairLocaleContent,
} from "../src/documents/tenant-agreement-bilingual.js";
import type { TenantAgreementFields } from "../src/documents/tenant-agreement-fields.js";

const ORG_CUSTOMER: TenantAgreementFields["customer"] = {
  kind: "legal_entity",
  name: "ООО «Пример»",
  inn: "7701234567",
  kpp: "770101001",
  ogrn: "1027700000000",
  address: "101000, Москва, ул. Примерная, д. 1",
  email: "buh@example.ru",
  phone: "+7 495 000-00-00",
  bankName: "АО «Банк»",
  bic: "044525000",
  settlementAccount: "40702810000000000001",
  correspondentAccount: "30101810000000000002",
  taxRegime: null,
};

export const FILLED: TenantAgreementFields = {
  number: "МКР-2026-0001",
  conclusionDate: "2026-09-11",
  city: "Краснодар",
  customer: ORG_CUSTOMER,
};

const BLANK: TenantAgreementFields = {
  customer: { ...ORG_CUSTOMER, name: "", inn: null, kpp: null },
};

const pair = (fields: TenantAgreementFields) =>
  pairLocaleContent(
    buildTenantAgreement(fields, "ru"),
    buildTenantAgreement(fields, "en"),
    AGREEMENT_MONOLINGUAL_SECTION_IDS,
  );

describe("bilingual agreement", () => {
  for (const [label, fields] of [
    ["filled", FILLED],
    ["blank", BLANK],
  ] as const) {
    it(`pairs the ${label} agreement without structural divergence`, () => {
      expect(() => pair(fields)).not.toThrow();
    });
  }

  it("marks exactly the four Russian accounting forms as monolingual", () => {
    expect([...AGREEMENT_MONOLINGUAL_SECTION_IDS].sort()).toEqual([
      "prilozhenie-5",
      "prilozhenie-6",
      "prilozhenie-7",
      "prilozhenie-8",
    ]);
  });

  it("every monolingual id exists in the document", () => {
    const ids = new Set(buildTenantAgreement(FILLED, "ru").sections.map((section) => section.id));
    for (const id of AGREEMENT_MONOLINGUAL_SECTION_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("renders monolingual sections once, across both columns", () => {
    const paired = pair(FILLED);
    expect(paired.sections.find((section) => section.id === "prilozhenie-5")?.bilingual).toBe(false);
    expect(paired.sections.find((section) => section.id === "storony")?.bilingual).toBe(true);
  });

  it("throws when a section is missing from one side", () => {
    const en = buildTenantAgreement(FILLED, "en");
    expect(() =>
      pairLocaleContent(
        buildTenantAgreement(FILLED, "ru"),
        { ...en, sections: en.sections.slice(0, -1) },
        AGREEMENT_MONOLINGUAL_SECTION_IDS,
      ),
    ).toThrow(/section count/i);
  });

  it("throws when block kinds diverge at the same position", () => {
    const en = buildTenantAgreement(FILLED, "en");
    const mangled = {
      ...en,
      sections: en.sections.map((section, index) =>
        index === 1
          ? { ...section, blocks: [{ kind: "callout", tone: "info", text: "x" } as const] }
          : section,
      ),
    };
    expect(() =>
      pairLocaleContent(
        buildTenantAgreement(FILLED, "ru"),
        mangled,
        AGREEMENT_MONOLINGUAL_SECTION_IDS,
      ),
    ).toThrow(/predmet/);
  });
});
