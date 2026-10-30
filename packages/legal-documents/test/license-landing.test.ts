import { strFromU8, unzipSync } from "fflate";
import { renderLegalDocx } from "../src/artifacts/docx.js";
import { describe, expect, it } from "vitest";
import {
  CURRENT_DEMO_CONSENT_ID,
  findLegalRelease,
  findLegalDocument,
  legalReleaseLocales,
} from "../src/index.js";

describe("license landing legal release", () => {
  it("binds lead consent to the reviewed licensing revision", () => {
    expect(CURRENT_DEMO_CONSENT_ID).toBe("MKR-PD-02/2026.10/01");
    expect(findLegalRelease("MKR-PD-02").revision).toBe("2026.10/01");
    expect(JSON.stringify(findLegalDocument("MKR-PD-02").content.ru)).toContain(
      "Рекламные метки UTM",
    );
  });
  it("keeps a license request separate from the paid license and advertising", () => {
    const offer = JSON.stringify(findLegalDocument("MKR-LIC-01").content.ru);
    const consent = JSON.stringify(findLegalDocument("MKR-PD-02").content.ru);
    expect(offer).toContain("простую (неисключительную) лицензию");
    expect(offer).toContain("не являются акцептом платной лицензии");
    expect(offer).toContain("зачисление полной суммы по счёту");
    expect(offer).toContain("В период правомерного применения НПД");
    expect(consent).toContain("не означает принятие платной оферты, подписку на рекламу");
    expect(consent).toContain(
      "Техническая отправка уведомления Оператором не продлевает этот срок",
    );
    expect(legalReleaseLocales("MKR-LIC-01")).toEqual(["ru"]);
    expect(legalReleaseLocales("MKR-ADV-01")).toEqual(["ru"]);
    expect(legalReleaseLocales("MKR-PD-03")).toEqual(["ru"]);
    expect(findLegalRelease("MKR-PUB-01").routes.ru).toBe("/legal/logo-and-review/");
  });
  it("prints the request consent with one revision table", async () => {
    const bytes = await renderLegalDocx({
      code: "MKR-PD-02",
      revision: "2026.10/01",
      effectiveDate: "2026-10-30",
      locale: "ru",
      kind: "legal-pdf",
      verificationUrl: "https://markiro.app/d/MKR-PD-02/2026.10/01/30.10.2026",
    });
    const xml = unzipSync(bytes)["word/document.xml"];
    if (!xml) throw new Error("Missing Word document XML");
    expect(strFromU8(xml).match(/<w:tbl>/g)).toHaveLength(1);
  });
  it("keeps the authoritative-language notice in the downloadable English consent", async () => {
    const bytes = await renderLegalDocx({
      code: "MKR-PD-02",
      revision: "2026.10/01",
      effectiveDate: "2026-10-30",
      locale: "en",
      kind: "legal-pdf",
      verificationUrl: "https://markiro.app/d/MKR-PD-02/2026.10/01/30.10.2026",
    });
    const xml = unzipSync(bytes)["word/document.xml"];
    if (!xml) throw new Error("Missing Word document XML");
    expect(strFromU8(xml)).toContain("The Russian text is authoritative");
    expect(strFromU8(xml).match(/<w:tbl>/g)).toHaveLength(1);
  });
  it("retains the previous consent and privacy as historical releases", () => {
    for (const code of ["MKR-PD-01", "MKR-PD-02"] as const) {
      expect(findLegalRelease(code, "2026.08/01").status).toBe("superseded");
      expect(findLegalRelease(code, "2026.08/01").routes.ru).toContain("/archive/");
      expect(findLegalDocument(code, "2026.08/01").content.en).toBeDefined();
      expect(legalReleaseLocales(code)).toEqual(["ru", "en"]);
    }
  });
});
