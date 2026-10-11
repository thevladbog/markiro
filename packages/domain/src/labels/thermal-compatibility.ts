import { productLabelValueDigest } from "../product-labels/km.js";
import {
  buildDefaultLabelTemplates,
  buildLegacyDatedBoxLabelTemplates,
  buildLegacyDateFreeBoxLabelTemplates,
  buildLegacyPrintNameBoxLabelTemplates,
} from "./defaults.js";
import { buildLegacyPalletLabelSpec, buildPalletLabelTemplates } from "./pallet-defaults.js";
import type { LabelTemplateSpec } from "./model.js";

export const THERMAL_LABEL_BRANDING_PROTOCOL = "thermal-label-branding-v1";
let formerStock: Map<string, LabelTemplateSpec> | undefined;
function stock(): Map<string, LabelTemplateSpec> {
  if (formerStock) return formerStock;
  const current = buildDefaultLabelTemplates();
  const result = new Map<string, LabelTemplateSpec>();
  for (const old of [
    ...buildLegacyDatedBoxLabelTemplates(),
    ...buildLegacyDateFreeBoxLabelTemplates(),
    ...buildLegacyPrintNameBoxLabelTemplates(),
  ].filter((t) => t.spec.dpi === 203)) {
    const next = current.find((t) => t.name === old.renamedTo);
    if (next) result.set(productLabelValueDigest(next.spec), old.spec);
  }
  const pallet = buildPalletLabelTemplates()[0];
  if (pallet) result.set(productLabelValueDigest(pallet.spec), buildLegacyPalletLabelSpec());
  formerStock = result;
  return result;
}
/** Read projection only. Never writes or recalculates a historical print snapshot. */
export function projectThermalLabelForClient(
  spec: LabelTemplateSpec,
  capabilities?: string,
): LabelTemplateSpec {
  if (capabilities?.split(",").some((token) => token.trim() === THERMAL_LABEL_BRANDING_PROTOCOL))
    return spec;
  if (
    !spec.gs1Constraint &&
    !spec.elements.some(
      (element) =>
        element.kind === "organization_logo" ||
        ((element.kind === "text" || element.kind === "field") &&
          (element.fontFamily !== undefined ||
            element.lineHeight !== undefined ||
            element.minFontSizePt !== undefined ||
            (element.kind === "field" &&
              ["quantity_number", "sscc_with_title", "sscc_spaced"].includes(
                element.textFormat ?? "",
              )))),
    )
  )
    return spec;
  const old = stock().get(productLabelValueDigest(spec));
  if (old) return old;
  const { gs1Constraint: ignored, ...base } = spec;
  void ignored;
  return {
    ...base,
    elements: spec.elements.flatMap<LabelTemplateSpec["elements"][number]>((element) => {
      if (element.kind === "organization_logo") return [];
      if (element.kind !== "text" && element.kind !== "field") return [element];
      const { fontFamily, lineHeight, minFontSizePt, ...plain } = element;
      void fontFamily;
      void lineHeight;
      void minFontSizePt;
      if (
        plain.kind === "field" &&
        ["quantity_number", "sscc_with_title", "sscc_spaced"].includes(plain.textFormat ?? "")
      ) {
        const { textFormat, ...legacy } = plain;
        void textFormat;
        return [legacy];
      }
      return [plain];
    }),
  };
}
