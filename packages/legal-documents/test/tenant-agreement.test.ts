import { describe, expect, it } from "vitest";

import { buildTenantAgreement } from "../src/documents/tenant-agreement.js";
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

const IP_CUSTOMER: TenantAgreementFields["customer"] = {
  ...ORG_CUSTOMER,
  kind: "sole_proprietor",
  name: "ИП Иванов Иван Иванович",
  inn: "770123456789",
  kpp: null,
  ogrn: "312770000000001",
};

const flatten = (fields: TenantAgreementFields): string =>
  buildTenantAgreement(fields, "ru")
    .sections.flatMap(({ heading, blocks }) => [
      heading,
      ...blocks.flatMap((block) => {
        if (block.kind === "paragraph" || block.kind === "callout") return [block.text];
        if (block.kind === "table") return [...block.columns, ...block.rows.flat()];
        if (block.kind === "definition-list")
          return block.items.map(({ term, detail }) => `${term} ${detail}`);
        if (block.kind === "ordered-list" || block.kind === "unordered-list") return block.items;
        return [];
      }),
    ])
    .join("\n");

describe("buildTenantAgreement", () => {
  it("substitutes the header fields", () => {
    const text = flatten({
      number: "МКР-2026-0001",
      conclusionDate: "2026-09-11",
      city: "Краснодар",
      customer: ORG_CUSTOMER,
    });
    expect(text).toContain("МКР-2026-0001");
    expect(text).toContain("11.09.2026");
    expect(text).toContain("г. Краснодар");
    expect(text).not.toContain("Договор № [номер]");
    expect(text).not.toContain("К договору № [номер]");
    expect(text).not.toContain("[город]");
  });

  it("fills the appendix references to this agreement but not to other documents", () => {
    const text = flatten({
      number: "МКР-2026-0001",
      conclusionDate: "2026-09-11",
      customer: ORG_CUSTOMER,
    });
    expect(text).toContain("К договору № МКР-2026-0001 от 11.09.2026");
    // A counter's own number is not this agreement's number.
    expect(text).toContain("Счёт № [номер]");
    expect(text).toContain("Задание № [номер]");
    expect(text).toContain("заказ № [номер]");
  });

  it("keeps the original placeholder for an unfilled field", () => {
    const text = flatten({ customer: ORG_CUSTOMER });
    expect(text).toContain("Договор № [номер]");
    expect(text).toContain("г. [город]");
    expect(text).toContain("[дата заключения]");
  });

  it("renders КПП as a value for an organisation and as не применяется for an ИП", () => {
    expect(flatten({ customer: ORG_CUSTOMER })).toContain("КПП: 770101001");
    const ip = flatten({ customer: IP_CUSTOMER });
    expect(ip).toContain("КПП: не применяется");
    expect(ip).not.toContain("[для организации; для ИП — не применяется]");
  });

  it("leaves appendix 1 and 3 placeholders untouched", () => {
    const text = flatten({ number: "МКР-2026-0001", customer: ORG_CUSTOMER });
    expect(text).toContain("[идентификатор; при первичном подключении");
    expect(text).toContain("[Старт / Цех / Производство / индивидуальный]");
  });

  it("states that the Russian text prevails and that the forms stay Russian", () => {
    const text = flatten({ customer: ORG_CUSTOMER });
    expect(text).toContain("преимущественную силу имеет русский текст");
    expect(text).toContain("Приложениях № 5–8");
  });

  it("builds an English tree of the same shape", () => {
    const en = buildTenantAgreement({ customer: ORG_CUSTOMER }, "en");
    expect(en.locale).toBe("en");
    expect(en.sections).toHaveLength(
      buildTenantAgreement({ customer: ORG_CUSTOMER }, "ru").sections.length,
    );
  });
});
