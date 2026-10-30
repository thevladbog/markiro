import { describe, expect, it } from "vitest";
import { findLegalDocument, findLegalRelease, requireLegalContent } from "../src/index.js";

describe("handheld warehouse instruction after host protocol 8", () => {
  it("reissues both translations instead of changing the published edition", () => {
    expect(findLegalRelease("MKR-INS-14").revision).toBe("2026.10/03");
  });

  it.each([
    {
      locale: "ru" as const,
      obsolete: "линию в офисе назначают только станциям",
      protocol: /протокол 8/u,
      warehouse: /своей закрытой складской паллет/u,
      acknowledged: /закрытие.*подтверждено хостом/u,
      received: /после приёма записи/u,
      excluded: /паллет.*производственной смены/iu,
    },
    {
      locale: "en" as const,
      obsolete: "the office assigns a line only to stations",
      protocol: /protocol 8/u,
      warehouse: /your own closed warehouse pallet/u,
      acknowledged: /closure.*acknowledged by the host/u,
      received: /after accepting the record/u,
      excluded: /production-shift pallets/iu,
    },
  ])("documents line assignment and the disassembly boundary in $locale", (expected) => {
    const content = requireLegalContent(findLegalDocument("MKR-INS-14"), expected.locale);
    const pairing = JSON.stringify(content.sections.find(({ id }) => id === "pairing"));
    expect(pairing).toContain("Линия");
    const faq = JSON.stringify(content.sections.find(({ id }) => id === "faq"));
    expect(faq).not.toContain(expected.obsolete);
    const disassembly = content.sections.find(({ id }) => id === "warehouse-disassembly");
    expect(disassembly).toBeDefined();
    const text = JSON.stringify(disassembly);
    expect(text).toMatch(expected.protocol);
    expect(text).toMatch(expected.warehouse);
    expect(text).toMatch(expected.acknowledged);
    expect(text).toMatch(expected.received);
    expect(text).toMatch(expected.excluded);
  });
});
