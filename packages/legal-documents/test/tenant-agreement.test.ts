import { describe, expect, it } from "vitest";

import { buildTenantAgreement } from "../src/documents/tenant-agreement.js";
import type { TenantAgreementFields } from "../src/documents/tenant-agreement-fields.js";
import { referredAs } from "../src/documents/tenant-agreement-ru.js";

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

const CONTRACTOR: NonNullable<TenantAgreementFields["contractor"]> = {
  ...IP_CUSTOMER,
  name: "ИП Богатырев Владислав Сергеевич",
  inn: "230400000001",
};

const withName = (name: string): TenantAgreementFields["customer"] => ({ ...ORG_CUSTOMER, name });

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

  it("reads the representative as a clause, not a comma-separated list", () => {
    const text = flatten({
      customer: ORG_CUSTOMER,
      signatory: {
        position: "Генерального директора",
        fullName: "Иванова Ивана Ивановича",
        authorityBasis: "Устава",
      },
    });
    expect(text).toContain(
      "в лице Генерального директора Иванова Ивана Ивановича, действующего на основании Устава",
    );
    // The old join produced "в лице Генеральный директор, Иванов И. И., Устав".
    expect(text).not.toContain("Иванова Ивана Ивановича, Устава");
  });

  it("names both parties in the appendices instead of leaving placeholders", () => {
    const text = flatten({ number: "МКР-2026-0001", customer: ORG_CUSTOMER });
    // Appendix 3 is the processing instruction; the customer is the operator
    // there, so leaving it blank made the appendix meaningless.
    expect(text).toContain("3-А.1. Заказчик — ООО «Пример», ИНН 7701234567");
    expect(text).toContain("Заказчик: ООО «Пример», ИНН 7701234567");
    expect(text).not.toContain("[наименование, ИНН, адрес]");
  });

  it("names the processor in the dative in appendix 3 · 1", () => {
    const text = flatten({ customer: ORG_CUSTOMER, contractor: CONTRACTOR });
    // "поручает ИП Богатырев …, ИНН … обработку" left the processor in the
    // nominative, so the sentence had no addressee.
    expect(text).toContain(
      "— поручает Исполнителю (ИП Богатырев Владислав Сергеевич, ИНН 230400000001) обработку перечисленных ниже персональных данных",
    );
    expect(text).not.toContain("поручает ИП Богатырев");
  });

  it("agrees the customer's participle in the preamble with its legal form", () => {
    const suffix = "именуемое «Заказчик», а в лицензионных отношениях — «Лицензиат»";
    expect(
      flatten({ customer: withName("Общество с ограниченной ответственностью «Атолл»") }),
    ).toContain(`, ${suffix}`);
    expect(flatten({ customer: withName("Компания «Пример Лтд»") })).toContain(
      "именуемая «Заказчик», а в лицензионных отношениях — «Лицензиат»",
    );
    expect(flatten({ customer: IP_CUSTOMER })).toContain(
      "именуемый «Заказчик», а в лицензионных отношениях — «Лицензиат»",
    );
    // The contractor is always a sole proprietor, whatever the customer is.
    expect(
      flatten({ customer: withName("Общество с ограниченной ответственностью «Атолл»") }),
    ).toContain("именуемый «Исполнитель»");
    // Customers are routinely entered under the abbreviated form.
    expect(flatten({ customer: ORG_CUSTOMER })).toContain(
      "именуемое «Заказчик», а в лицензионных отношениях — «Лицензиат»",
    );
  });

  it("starts the requisites on their own page", () => {
    const section = buildTenantAgreement({ customer: ORG_CUSTOMER }, "ru").sections.find(
      (candidate) => candidate.id === "rekvizity",
    );
    // A page break through the signature block strands a signature.
    expect(section?.startsPage).toBe(true);
  });

  it("fills appendix 4.3 with the standard model rather than empty brackets", () => {
    const text = flatten({ customer: ORG_CUSTOMER });
    expect(text).toContain("Исключительное право остаётся у Исполнителя");
    expect(text).toContain("Простая (неисключительная) лицензия");
    expect(text).toContain("Передача результата и полная оплата задания");
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

describe("referredAs", () => {
  it.each([
    ["Общество с ограниченной ответственностью «Атолл»", "именуемое"],
    ["Акционерное общество «Завод»", "именуемое"],
    ["Публичное акционерное общество «Сбербанк России»", "именуемое"],
    ["Товарищество собственников жилья «Дом»", "именуемое"],
    ["Партнёрство «Союз»", "именуемое"],
    ["ООО «Пример»", "именуемое"],
    ["АО «Завод»", "именуемое"],
    ["ПАО «Сбербанк России»", "именуемое"],
    ["Компания «Пример Лтд»", "именуемая"],
    ["Фирма «Весна»", "именуемая"],
    ["Корпорация «Ростех»", "именуемая"],
    ["Организация «Пример»", "именуемая"],
  ])("reads %s as %s", (name, participle) => {
    expect(referredAs(withName(name))).toBe(participle);
  });

  it("matches the legal form regardless of case and ё", () => {
    // ЕГРЮЛ spells full names in capitals, and «партнерство» is routinely typed without ё.
    expect(referredAs(withName("ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ «АТОЛЛ»"))).toBe(
      "именуемое",
    );
    expect(referredAs(withName("  Партнерство «Союз»"))).toBe("именуемое");
  });

  it("matches a whole word, not a prefix of a longer one", () => {
    expect(referredAs(withName("Фирмачи «Пример»"))).toBe("именуемый");
    // «АО» is two letters, so a name merely starting with them must not match.
    expect(referredAs(withName("Аорта «Мед»"))).toBe("именуемый");
  });

  it("keeps the masculine form for a person and for an unknown legal form", () => {
    expect(referredAs(IP_CUSTOMER)).toBe("именуемый");
    expect(referredAs({ ...IP_CUSTOMER, kind: "individual", name: "Иванова Анна Петровна" })).toBe(
      "именуемый",
    );
    // A sole proprietor named like an organisation is still a person.
    expect(referredAs({ ...IP_CUSTOMER, name: "Общество «Не юрлицо»" })).toBe("именуемый");
    expect(referredAs(withName("Кооператив «Урожай»"))).toBe("именуемый");
    // The blank template has no name to agree with.
    expect(referredAs(withName(""))).toBe("именуемый");
  });
});
