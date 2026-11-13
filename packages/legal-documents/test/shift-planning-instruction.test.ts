import { describe, expect, it } from "vitest";
import { findLegalDocument, requireLegalContent } from "../src/index.js";

describe("office shift planning instruction", () => {
  it.each([
    {
      locale: "ru" as const,
      preservation: "Регистр и ведущие нули сохраняются",
      template: "номер целиком помещается",
      cutoff: "Изменить или убрать его можно до открытия смены",
    },
    {
      locale: "en" as const,
      preservation: "Letter case and leading zeros are preserved",
      template: "the whole number fits",
      cutoff: "change or clear it before the shift opens",
    },
  ])("explains lot number setup, validation and editing in $locale", (expected) => {
    const content = requireLegalContent(findLegalDocument("MKR-INS-08"), expected.locale);
    const planning = content.sections.find(({ id }) => id === "plan");
    const images = planning?.blocks.flatMap((block) =>
      block.kind === "step" && block.image ? [block.image.id] : [],
    );
    const text = JSON.stringify(planning);

    expect(images).toEqual(expect.arrayContaining(["org-lot-numbers", "shift-lot-number"]));
    expect(text).toContain("Использовать номера партий");
    expect(text).toContain("Номер партии (необязательно)");
    expect(text).toContain(expected.preservation);
    expect(text).toContain(expected.template);
    expect(text).toContain(expected.cutoff);
  });
});
