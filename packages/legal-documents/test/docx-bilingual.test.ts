import { unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";

import { renderLegalDocxBilingual } from "../src/artifacts/docx.js";
import { buildTenantAgreement } from "../src/documents/tenant-agreement.js";
import {
  AGREEMENT_MONOLINGUAL_SECTION_IDS,
  pairLocaleContent,
} from "../src/documents/tenant-agreement-bilingual.js";
import type { TenantAgreementFields } from "../src/documents/tenant-agreement-fields.js";

const FILLED: TenantAgreementFields = {
  number: "МКР-2026-0001",
  conclusionDate: "2026-09-11",
  city: "Краснодар",
  customer: {
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
  },
};

const content = pairLocaleContent(
  buildTenantAgreement(FILLED, "ru"),
  buildTenantAgreement(FILLED, "en"),
  AGREEMENT_MONOLINGUAL_SECTION_IDS,
);

let documentXml = "";

beforeAll(async () => {
  const bytes = await renderLegalDocxBilingual({
    code: "MKR-AGR-01",
    revision: "2026.09/01",
    effectiveDate: "2026-09-11",
    locale: "ru",
    verificationUrl: "https://markiro.ru/legal/",
    classLabel: "ПРОЕКТ ДОГОВОРА",
    operatorProfileId: "operator-2026-08-15",
    content,
  });
  const entry = unzipSync(bytes)["word/document.xml"];
  if (!entry) throw new Error("no word/document.xml in the rendered package");
  documentXml = new TextDecoder().decode(entry);
});

describe("renderLegalDocxBilingual", () => {
  it("emits a table per section on top of the metadata table", () => {
    const tables = documentXml.match(/<w:tbl>/g)?.length ?? 0;
    expect(tables).toBeGreaterThanOrEqual(content.sections.length + 1);
  });

  it("carries the agreement number in both columns", () => {
    expect(documentXml.split("МКР-2026-0001").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("renders a Russian accounting form once, not in two columns", () => {
    expect(documentXml.split("Форма счёта на оплату").length - 1).toBe(1);
  });

  it("gives every appendix its own page", () => {
    expect(documentXml).toContain("w:pageBreakBefore");
  });

  it("renders a bilingual heading on both sides", () => {
    expect(documentXml).toContain("Приложение № 9");
    expect(documentXml).toContain("Appendix No. 9");
  });

  it("refuses a step block, which cannot fit a contract column", async () => {
    const withStep = {
      ...content,
      sections: [
        {
          id: "probe",
          bilingual: true,
          ru: { heading: "п", blocks: [{ kind: "step" as const, title: "t", text: "x" }] },
          en: { heading: "p", blocks: [{ kind: "step" as const, title: "t", text: "x" }] },
        },
      ],
    };
    await expect(
      renderLegalDocxBilingual({
        code: "MKR-AGR-01",
        revision: "2026.09/01",
        effectiveDate: "2026-09-11",
        locale: "ru",
        verificationUrl: "https://markiro.ru/legal/",
        classLabel: "ПРОЕКТ ДОГОВОРА",
        operatorProfileId: "operator-2026-08-15",
        content: withStep,
      }),
    ).rejects.toThrow(/step blocks \(probe\)/);
  });
});
