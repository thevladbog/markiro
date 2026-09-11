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

  it("translates the body", () => {
    const byId = new Map(
      buildTenantAgreement(FILLED, "en").sections.map((section) => [section.id, section]),
    );
    expect(byId.get("predmet")?.heading).toBe("1. Subject matter and structure of the agreement");
    expect(byId.get("tsena")?.heading).toBe("4. Price, settlements and tax status");
    expect(byId.get("rekvizity")?.heading).toBe("12. Requisites and signatures");
    expect(JSON.stringify(byId.get("dokumenty")?.blocks)).toContain(
      "the Russian text shall prevail",
    );
    // The preamble carries the agreement number in both columns.
    expect(byId.get("storony")?.heading).toContain("МКР-2026-0001");
  });

  it("keeps the filled fields and the unfilled placeholders in the English column", () => {
    const filled = JSON.stringify(buildTenantAgreement(FILLED, "en").sections);
    expect(filled).toContain("Краснодар");
    expect(filled).toContain("11.09.2026");
    // A blank customer keeps English placeholders rather than Russian ones.
    const blank = JSON.stringify(buildTenantAgreement(BLANK, "en").sections);
    expect(blank).toContain("[full name of the legal entity / sole proprietor]");
    expect(blank).not.toContain("[полное наименование юридического лица / ИП]");
  });

  it("translates appendices 1 and 2", () => {
    const byId = new Map(
      buildTenantAgreement(FILLED, "en").sections.map((section) => [section.id, section]),
    );
    expect(byId.get("prilozhenie-1")?.heading).toBe(
      "Appendix No. 1. Order for the grant of rights and access",
    );
    expect(byId.get("prilozhenie-2")?.heading).toBe(
      "Appendix No. 2. Support and wind-down regulations",
    );
    // The appendix refers back to its own agreement, so the number is filled…
    expect(JSON.stringify(byId.get("prilozhenie-1")?.blocks)).toContain("МКР-2026-0001");
    // …while the order's own number stays a placeholder: it is assigned later.
    expect(JSON.stringify(byId.get("prilozhenie-1")?.blocks)).toContain("[order number]");
  });

  it("translates appendices 3 and 4 in 152-FZ vocabulary", () => {
    const byId = new Map(
      buildTenantAgreement(FILLED, "en").sections.map((section) => [section.id, section]),
    );
    expect(byId.get("prilozhenie-3")?.heading).toBe(
      "Appendix No. 3. Personal data processing instruction",
    );
    expect(byId.get("prilozhenie-4")?.heading).toBe(
      "Appendix No. 4. Assignment for services / works",
    );
    const roles = JSON.stringify(byId.get("prilozhenie-3-roli")?.blocks);
    expect(roles).toContain("Federal Law No. 152-FZ");
    // The Customer is the operator in the 152-FZ sense, never a "controller"
    // borrowed from the GDPR, which would misdescribe the obligation.
    expect(roles).toContain("is the operator");
    expect(JSON.stringify(buildTenantAgreement(FILLED, "en").sections)).not.toContain(
      "data controller",
    );
  });

  it("translates appendices 9 and 10 and leaves the accounting forms Russian", () => {
    const byId = new Map(
      buildTenantAgreement(FILLED, "en").sections.map((section) => [section.id, section]),
    );
    expect(byId.get("prilozhenie-9")?.heading).toBe(
      "Appendix No. 9. Contacts and electronic interaction",
    );
    expect(byId.get("prilozhenie-10")?.heading).toBe(
      "Appendix No. 10. Form of confirmation of data transfer and deletion",
    );
    for (const id of AGREEMENT_MONOLINGUAL_SECTION_IDS) {
      expect(byId.get(id)?.heading).toMatch(/^Приложение № /);
    }
  });

  it("leaves nothing but the four accounting forms untranslated", () => {
    // The blank template, not the filled one: a Cyrillic agreement number
    // substituted into a heading is data, not untranslated text.
    const en = buildTenantAgreement(BLANK, "en");
    const stillRussian = en.sections
      .filter((section) => /[А-Яа-я]/.test(section.heading))
      .map((section) => section.id);
    expect(stillRussian.sort()).toEqual([...AGREEMENT_MONOLINGUAL_SECTION_IDS].sort());
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
