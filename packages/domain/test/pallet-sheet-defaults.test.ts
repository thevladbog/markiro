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
  it("stores real editable content rather than a built-in layout selector", () => {
    for (const preset of domain.buildPalletSheetPresets()) {
      expect(domain.parseStoredLabelTemplate(preset.spec)).toEqual(preset.spec);
      expect(preset.spec.body.length).toBeGreaterThan(0);
      expect(preset.spec.footer).toMatchObject({ kind: "sscc", barHeightMm: 45 });
      expect(preset.spec).not.toHaveProperty("language");
    }
  });
});
