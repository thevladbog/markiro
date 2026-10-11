import { describe, expect, it } from "vitest";
import {
  buildDefaultLabelTemplates,
  buildLegacyDatedBoxLabelTemplates,
  buildLegacyDateFreeBoxLabelTemplates,
  buildLegacyPrintNameBoxLabelTemplates,
  buildPalletLabelTemplates,
  projectThermalLabelForClient,
  parseLabelTemplate,
  THERMAL_LABEL_BRANDING_PROTOCOL,
} from "../src/index.js";
describe("thermal label client projection", () => {
  it("keeps unchanged legacy models by identity, including preserved raw metadata", () => {
    const legacy = { ...buildDefaultLabelTemplates()[0]!.spec, legacyNote: "saved raw V1" };
    expect(projectThermalLabelForClient(legacy)).toBe(legacy);
  });
  it("returns exact former stock box layouts for absent, unrelated or malformed capabilities", () => {
    for (const old of [
      ...buildLegacyDatedBoxLabelTemplates(),
      ...buildLegacyDateFreeBoxLabelTemplates(),
      ...buildLegacyPrintNameBoxLabelTemplates(),
    ].filter((t) => t.spec.dpi === 203)) {
      const current = buildDefaultLabelTemplates().find((t) => t.name === old.renamedTo)!;
      for (const caps of [
        undefined,
        "pallet-sheet-v2",
        "prefix-" + THERMAL_LABEL_BRANDING_PROTOCOL,
      ]) {
        expect(projectThermalLabelForClient(current.spec, caps)).toEqual(old.spec);
      }
      expect(projectThermalLabelForClient(current.spec, THERMAL_LABEL_BRANDING_PROTOCOL)).toBe(
        current.spec,
      );
    }
  });
  it("removes new kinds, formats and typography for custom and narrow pallet specs without changing mandatory values", () => {
    for (const t of buildPalletLabelTemplates()) {
      const spec = { ...t.spec, elements: t.spec.elements.filter((e) => e.id !== "sep1") };
      const projected = projectThermalLabelForClient(spec);
      expect(parseLabelTemplate(projected)).toEqual(projected);
      expect(JSON.stringify(projected)).not.toMatch(
        /organization_logo|quantity_number|sscc_with_title|sscc_spaced|fontFamily|lineHeight|minFontSizePt|gs1Constraint/,
      );
      expect(projected.elements.filter((e) => e.kind === "barcode")).toEqual(
        spec.elements.filter((e) => e.kind === "barcode"),
      );
      expect(projected.elements.filter((e) => e.kind === "field").map((e) => e.field)).toEqual(
        spec.elements.filter((e) => e.kind === "field").map((e) => e.field),
      );
    }
  });
});
