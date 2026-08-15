import { describe, expect, it } from "vitest";
import {
  LEGAL_DOCUMENTS,
  findLegalDocument,
  findLegalRelease,
  formatLegalEffectiveDate,
  legalRevisionFileToken,
  legalVerificationPath,
  legalVerificationUrl,
  type LegalBlock,
  type LegalDocumentCode,
  type LegalLocale,
} from "../src/index.js";

const sectionIds = (code: LegalDocumentCode, locale: LegalLocale): string[] =>
  findLegalDocument(code).content[locale].sections.map(({ id }) => id);

const documentContent = (code: LegalDocumentCode, locale: LegalLocale) =>
  findLegalDocument(code).content[locale];

const blockText = (block: LegalBlock): string => {
  if (block.kind === "paragraph") return block.text;
  if (block.kind === "definition-list") {
    return block.items.map(({ term, detail }) => `${term} — ${detail}`).join(" ");
  }
  return block.items.join(" ");
};

const flattenedDocument = (code: LegalDocumentCode, locale: LegalLocale): string[] => {
  const content = documentContent(code, locale);
  return [
    content.title,
    content.summary,
    ...content.sections.flatMap(({ heading, blocks }) => [heading, ...blocks.map(blockText)]),
  ];
};

const documentText = (code: LegalDocumentCode, locale: LegalLocale): string =>
  flattenedDocument(code, locale).join(" ");

const definitionItems = (code: LegalDocumentCode, locale: LegalLocale) =>
  documentContent(code, locale).sections.flatMap(({ blocks }) =>
    blocks.flatMap((block) => (block.kind === "definition-list" ? block.items : [])),
  );

const expectUnpunctuatedDefinitionTerm = (term: string): void => {
  const trimmedTerm = term.trimEnd();
  expect(term).toBe(trimmedTerm);
  expect(trimmedTerm).not.toMatch(/\p{P}$/u);
};

const sectionText = (code: LegalDocumentCode, locale: LegalLocale, sectionId: string): string => {
  const section = documentContent(code, locale).sections.find(({ id }) => id === sectionId);
  if (!section) throw new Error(`Unknown legal section: ${code}/${locale}/${sectionId}`);
  return [section.heading, ...section.blocks.map(blockText)].join(" ");
};

const allPublicLegalText = (): string[] =>
  LEGAL_DOCUMENTS.flatMap(({ content }) => [
    documentText(content.ru.locale === "ru" ? findCode(content.ru.title) : neverCode(), "ru"),
    documentText(content.en.locale === "en" ? findCode(content.en.title) : neverCode(), "en"),
  ]);

function findCode(title: string): LegalDocumentCode {
  const source = LEGAL_DOCUMENTS.find(
    ({ content }) => content.ru.title === title || content.en.title === title,
  );
  if (!source) throw new Error(`Unknown legal document title: ${title}`);
  return source.releaseKey.slice(0, source.releaseKey.indexOf("/")) as LegalDocumentCode;
}

function neverCode(): never {
  throw new Error("Mismatched document locale marker");
}

describe("bilingual legal document sources", () => {
  it("formats localized legal identity display and verification paths", () => {
    const release = findLegalRelease("MKR-PD-01");

    expect(formatLegalEffectiveDate(release.effectiveDate, "ru")).toBe("15.08.2026");
    expect(formatLegalEffectiveDate(release.effectiveDate, "en")).toBe("15 August 2026");
    expect(legalRevisionFileToken(release.revision)).toBe("2026.08-01");
    expect(legalVerificationPath(release)).toBe("/d/MKR-PD-01/2026.08/01/15.08.2026");
    expect(legalVerificationUrl(release)).toBe(
      "https://markiro.app/d/MKR-PD-01/2026.08/01/15.08.2026",
    );
  });

  it("uses the normalized product name in each localized legal document", () => {
    const bilingualFirstUse = "Маркиро (англ. — Markiro)";

    for (const source of LEGAL_DOCUMENTS) {
      const code = findCode(source.content.ru.title);
      const russian = documentText(code, "ru");
      const russianMentions = russian.match(/Маркиро(?: \(англ\. — Markiro\))?|Markiro/gu) ?? [];

      expect(russian.match(/Маркиро \(англ\. — Markiro\)/gu)).toHaveLength(1);
      expect(russianMentions[0]).toBe(bilingualFirstUse);
      expect(russianMentions.slice(1)).toEqual(
        Array.from({ length: russianMentions.length - 1 }, () => "Маркиро"),
      );

      const english = documentText(code, "en");
      expect(english).toContain("Markiro");
      expect(english).not.toContain("Маркиро");
    }
  });

  it("uses dash-separated definitions with unpunctuated source terms", () => {
    for (const source of LEGAL_DOCUMENTS) {
      const code = findCode(source.content.ru.title);
      for (const locale of ["ru", "en"] as const) {
        const text = documentText(code, locale);
        for (const { term, detail } of definitionItems(code, locale)) {
          expectUnpunctuatedDefinitionTerm(term);
          expect(text).toContain(`${term} — ${detail}`);
        }
      }
    }
  });

  it.each(["Tenant)", "Термин—", "Term "])(
    "rejects a definition term with trailing Unicode punctuation or whitespace: %j",
    (term) => {
      expect(() => expectUnpunctuatedDefinitionTerm(term)).toThrow();
    },
  );

  it("uses the localized revision and effective-date wording in public prose", () => {
    for (const source of LEGAL_DOCUMENTS) {
      const code = findCode(source.content.ru.title);
      const russian = documentText(code, "ru");
      const english = documentText(code, "en");

      expect(russian).toContain("2026.08/01");
      expect(russian).toContain("15.08.2026");
      expect(russian).not.toContain("2026-08-15");
      expect(english).toContain("2026.08/01");
      expect(english).toContain("15 August 2026");
      expect(english).not.toContain("2026-08-15");
    }
  });

  it("uses stable section identifiers for the privacy policy", () => {
    const expected = [
      "general",
      "principles",
      "subjects-and-data",
      "purposes-and-bases",
      "operations",
      "retention-and-destruction",
      "processors",
      "localization-and-transfer",
      "security-and-incidents",
      "subject-rights",
      "cookies-and-captcha",
      "tenant-data",
      "revisions",
    ];
    expect(sectionIds("MKR-PD-01", "ru")).toEqual(expected);
    expect(sectionIds("MKR-PD-01", "en")).toEqual(expected);
  });

  it("uses stable section identifiers for the website consent", () => {
    const expected = [
      "operator",
      "data-and-purposes",
      "operations-and-processors",
      "term-and-withdrawal",
      "confirmation",
    ];
    expect(sectionIds("MKR-PD-02", "ru")).toEqual(expected);
    expect(sectionIds("MKR-PD-02", "en")).toEqual(expected);
  });

  it("uses stable section identifiers for the tenant instruction and letterhead", () => {
    const tenantExpected = [
      "template-status",
      "roles",
      "tenant-duties",
      "instructions",
      "processor-duties",
      "subprocessors",
      "incidents-and-assistance",
      "return-and-deletion",
      "independent-processing",
      "execution-and-numbering",
    ];
    const brandExpected = [
      "template-status",
      "permitted-use",
      "placeholders",
      "document-control",
      "prohibited-elements",
    ];
    expect(sectionIds("MKR-DPA-01", "ru")).toEqual(tenantExpected);
    expect(sectionIds("MKR-DPA-01", "en")).toEqual(tenantExpected);
    expect(sectionIds("MKR-BRD-01", "ru")).toEqual(brandExpected);
    expect(sectionIds("MKR-BRD-01", "en")).toEqual(brandExpected);
  });

  it("pins the public demo data, purposes, retention, and operator contact facts", () => {
    const privacy = documentText("MKR-PD-01", "ru");
    expect(privacy).toContain("имя");
    expect(privacy).toContain("компания");
    expect(privacy).toContain("адрес электронной почты");
    expect(privacy).toContain("необязательный номер телефона");
    expect(privacy).toContain("исходная страница");
    expect(privacy).toContain("идентификатор запроса");
    expect(privacy).toContain("версия согласия");
    expect(privacy).toContain("не более одного года с последнего содержательного контакта");
    expect(privacy).toContain("hello@v-b.tech");
    expect(privacy).toContain(
      "353745, Краснодарский край, Ленинградский район, ст. Ленинградская, ул. Грузская, д. 26",
    );
    expect(privacy).toMatch(/ответ на запрос.*демонстрац.*транзакционн.*защит/iu);
  });

  it("states the technical, localization, transfer, and language boundaries", () => {
    const privacyRu = documentText("MKR-PD-01", "ru");
    expect(privacyRu).toMatch(/IP-адрес.*сетев.*браузер.*устройств.*реферер.*часов.*токен/isu);
    expect(privacyRu).toContain("SmartCaptcha");
    expect(privacyRu).toMatch(/баз данных.*территории Российской Федерации/iu);
    expect(privacyRu).toMatch(/трансграничн.*не планируется/isu);

    for (const source of LEGAL_DOCUMENTS) {
      const english = documentText(findCode(source.content.en.title), "en");
      expect(english).toMatch(/Russian.*authoritative/isu);
      expect(source.content.ru.sections.map(({ id }) => id)).toEqual(
        source.content.en.sections.map(({ id }) => id),
      );
    }
  });

  it("keeps tenant/operator and Markiro/processor duties separate", () => {
    const tenant = documentText("MKR-DPA-01", "ru");
    expect(tenant).toMatch(/тенант.*оператор/isu);
    expect(tenant).toMatch(/законн.*основан.*уведомлен.*соглас.*точност.*цел.*объем/isu);
    expect(tenant).toMatch(
      /Markiro.*обработк.*поручени.*конфиденциальност.*безопасност.*субподряд.*инцидент.*содейств.*удален/isu,
    );
    expect(tenant).toMatch(
      /самостоятельн.*биллинг.*безопасност.*злоупотреблен.*обязательн.*учет/isu,
    );
  });

  it("makes the consent standalone and binds it to the exact revision", () => {
    const consent = documentText("MKR-PD-02", "ru");
    expect(consent).toContain("Я даю согласие");
    expect(consent).toContain("MKR-PD-02/2026.08/01");
    expect(consent).toContain("+7 934 355-14-90");
    expect(consent).toMatch(/автоматизированн.*без использования средств автоматизации/isu);
    expect(consent).toMatch(/отозв.*hello@v-b\.tech.*почтов/isu);
    expect(consent).toMatch(/не отменяет законность.*до отзыва/isu);
  });

  it("marks the editable letterhead as a non-operative template", () => {
    const letterhead = documentText("MKR-BRD-01", "ru");
    expect(letterhead).toContain("ШАБЛОН — НЕ ЯВЛЯЕТСЯ ДЕЙСТВУЮЩИМ ДОКУМЕНТОМ");
    expect(letterhead).toMatch(/не содержит.*контрагент.*подпис.*печат.*утвержден/isu);
  });

  it.each([
    ["MKR-PD-01", "revisions"],
    ["MKR-BRD-01", "document-control"],
  ] as const)("keeps %s embedded control metadata aligned with its release", (code, sectionId) => {
    const release = findLegalRelease(code);
    for (const locale of ["ru", "en"] as const) {
      const text = sectionText(code, locale, sectionId);
      expect(text).toContain(release.code);
      expect(text).toContain(release.revision);
      expect(text).toContain(formatLegalEffectiveDate(release.effectiveDate, locale));
    }
  });

  it("contains no unapproved claims, placeholders, or purposes", () => {
    for (const text of allPublicLegalText()) {
      expect(text).not.toMatch(
        /уведомлени[ея] подан|в реестре Роскомнадзора|сертифицирован[а-я]* Markiro/i,
      );
      expect(text).not.toMatch(
        /соглас(?:ен|ие).{0,40}(?:маркетинг|рассылк)|переда(?:м|ча).{0,40}CRM/i,
      );
      expect(text).not.toContain("TODO");
    }
  });
});
