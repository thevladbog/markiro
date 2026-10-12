import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";

describe("editable A4 starter templates", () => {
  it("provides exactly three stable tenant seed identities", () => {
    expect(domain.buildPalletSheetPresets?.().map((p) => p.key)).toEqual([
      "pallet-a4-portrait",
      "pallet-a4-landscape",
      "pallet-a4-two-a5",
    ]);
  });
  it("separates branding from a larger title on the right in every A4 preset", () => {
    for (const preset of domain.buildPalletSheetPresets()) {
      const content = preset.spec.body[0];
      if (content?.kind !== "stack") throw new Error("Missing content");
      const header = content.children[0];
      if (header?.kind !== "row") throw new Error("Missing header");
      const [brand, title] = header.children;
      expect(brand).toMatchObject({
        id: "brand",
        kind: "row",
        gapMm: preset.spec.page.copies === 2 ? 3 : 5,
      });
      expect(title).toMatchObject({
        id: "label-title",
        kind: "text",
        text: "ПАЛЕТА",
        align: "right",
        fontSizePt: preset.spec.page.copies === 2 ? 12 : 18,
      });
      expect(preset.spec.footer.caption).toMatchObject({
        showInn: true,
        platformText: "Сформировано в Маркиро",
      });
    }
  });
  it("stores real editable content rather than a built-in layout selector", () => {
    for (const preset of domain.buildPalletSheetPresets()) {
      expect(domain.parseStoredLabelTemplate(preset.spec)).toEqual(preset.spec);
      expect(preset.spec.body.length).toBeGreaterThan(0);
      expect(preset.spec.footer).toMatchObject({ kind: "sscc", barHeightMm: 45 });
      expect(preset.spec).not.toHaveProperty("language");
    }
  });
});
