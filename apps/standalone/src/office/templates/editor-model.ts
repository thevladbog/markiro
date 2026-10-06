import {
  assertDuplicateTemplate,
  buildDuplicateLabelTemplate,
  buildPalletLabelTemplates,
  DomainError,
  EGAIS_PRODUCT_GROUP_CODE,
  labelTemplateSpecSchema,
  labelTemplateUsesField,
  type LabelTemplateSpec,
  type PrinterDpi,
} from "@markiro/domain";

import type { TemplatePurpose, TemplateSpec } from "../../host/protocol.js";
import { plainTextRule } from "../../lib/rules.js";
import { sameCategories, scopeCodes, type CategoryScope } from "./category-scope.js";
import { fitSpecElements } from "./label-geometry.js";
import { labelRenderOptions, labelSampleData } from "./label-samples.js";

/** The longest template name the host keeps (`validate::template_name`). */
export const MAX_TEMPLATE_NAME = 200;

/** A template's name: trimmed, 1 to 200 characters, as the host takes it. */
export const templateNameRule = plainTextRule(
  MAX_TEMPLATE_NAME,
  "office.templateEditor.errors.name",
);

/** A new box template: an empty 58×40 label at 203 dpi, filled by an import. */
export const BLANK_SPEC: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [],
};

/**
 * The layout a new template of a purpose starts from, as in the cloud
 * editor: a box an empty label, a product duplicate the domain's duplicate
 * 58×40, a pallet the stock pallet 100×150, whose large SSCC is the point of
 * the label.
 */
export function startingSpec(purpose: TemplatePurpose): LabelTemplateSpec {
  if (purpose === "product_duplicate") return buildDuplicateLabelTemplate();
  if (purpose === "pallet") return buildPalletLabelTemplates()[0]?.spec ?? BLANK_SPEC;
  return BLANK_SPEC;
}

/** The label sizes the size select offers, in millimetres; anything else is «Свой размер». */
export const SIZE_PRESETS = [
  { key: "58x40", widthMm: 58, heightMm: 40 },
  { key: "60x40", widthMm: 60, heightMm: 40 },
  { key: "75x120", widthMm: 75, heightMm: 120 },
  { key: "100x100", widthMm: 100, heightMm: 100 },
  { key: "100x150", widthMm: 100, heightMm: 150 },
] as const;

export type SizePresetKey = (typeof SIZE_PRESETS)[number]["key"];

/** The preset of a size, or `null` when no preset has it. */
export function presetOf(widthMm: number, heightMm: number): SizePresetKey | null {
  return (
    SIZE_PRESETS.find((preset) => preset.widthMm === widthMm && preset.heightMm === heightMm)
      ?.key ?? null
  );
}

/** The bounds the domain puts on a label's width and height (`labelTemplateSpecSchema`). */
export const MIN_SIZE_MM = 10;
export const MAX_SIZE_MM = 300;

/**
 * A typed width or height in millimetres: digits with a comma or a point,
 * within 10–300 mm; `null` for anything else, so an empty, non-numeric or
 * out-of-range entry is refused as what it is instead of reaching the fit.
 */
export function parseSizeMm(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value >= MIN_SIZE_MM && value <= MAX_SIZE_MM ? value : null;
}

/** The resolutions a layout is authored in; the station prints in its printer's own. */
export const DPI_CHOICES: readonly PrinterDpi[] = [203, 300];

/** A select's value as a resolution: 300, else 203. */
export function toDpi(value: string): PrinterDpi {
  return value === "300" ? 300 : 203;
}

/**
 * A stored layout as the domain reads it (`labelTemplateSpecSchema`), or
 * `null` when it is not one. The host keeps a layout as an opaque object and
 * never checks it, so the editor reads it before it shows it.
 */
export function readSpec(spec: TemplateSpec): LabelTemplateSpec | null {
  const parsed = labelTemplateSpecSchema.safeParse(spec);
  return parsed.success ? parsed.data : null;
}

/**
 * The layout a save sends: what `labelTemplateSpecSchema` makes of it, or
 * `null` when it is not a layout. The host never checks a layout, so this is
 * the check (spec §5.5).
 */
export function checkedSpec(spec: LabelTemplateSpec): TemplateSpec | null {
  const parsed = labelTemplateSpecSchema.safeParse(spec);
  return parsed.success ? parsed.data : null;
}

/**
 * The layout at a new size with every element moved inside it
 * (`fitSpecElements`, measured with the purpose's sample data), or `null`
 * when an element is larger than the new label: the old layout stays, so a
 * size never cuts content.
 */
export function resizedSpec(
  spec: LabelTemplateSpec,
  widthMm: number,
  heightMm: number,
  purpose: TemplatePurpose,
): LabelTemplateSpec | null {
  const fitted = fitSpecElements(
    { ...spec, widthMm, heightMm },
    labelSampleData(purpose),
    labelRenderOptions(purpose),
  );
  return fitted.ok ? fitted.spec : null;
}

/**
 * Whether a product duplicate's layout breaks the domain's duplicate rule
 * (`assertDuplicateTemplate`: one Data Matrix of the full code inside the
 * label, no SSCC). Another purpose has no such rule.
 */
export function duplicateLayoutInvalid(spec: LabelTemplateSpec, purpose: TemplatePurpose): boolean {
  if (purpose !== "product_duplicate") return false;
  try {
    assertDuplicateTemplate(spec);
  } catch (error) {
    if (error instanceof DomainError) return true;
    throw error;
  }
  return false;
}

/**
 * Whether the layout prints the EGAIS code while the template is narrowed to
 * categories without beer (`EGAIS_PRODUCT_GROUP_CODE`): only beer has the
 * code, so the field would print empty, as the cloud editor warns.
 */
export function egaisOutsideScope(spec: LabelTemplateSpec, scope: CategoryScope): boolean {
  return (
    scope.mode === "selected" &&
    !scope.codes.includes(EGAIS_PRODUCT_GROUP_CODE) &&
    labelTemplateUsesField(spec, "product.egais")
  );
}

/** What the editor holds of a template. */
export interface TemplateDraft {
  name: string;
  purpose: TemplatePurpose;
  enabled: boolean;
  scope: CategoryScope;
  spec: LabelTemplateSpec;
}

/**
 * Whether the draft differs from the opened one in something a save would
 * send: the name as typed, the purpose, the flag, the categories as the host
 * reads them (`scopeCodes`; the order of codes and the codes kept under «Все
 * категории» do not count) or the layout.
 */
export function draftChanged(opened: TemplateDraft, draft: TemplateDraft): boolean {
  return (
    opened.name !== draft.name ||
    opened.purpose !== draft.purpose ||
    opened.enabled !== draft.enabled ||
    !sameCategories(scopeCodes(opened.scope), scopeCodes(draft.scope)) ||
    JSON.stringify(opened.spec) !== JSON.stringify(draft.spec)
  );
}

/**
 * The downloadable JSON of a template: `{ name, purpose, spec }` pretty
 * printed, in that order, with a final newline — the body the import's JSON
 * format takes back, as the cloud's `buildJsonBlob` writes it.
 */
export function templateJson(
  name: string,
  purpose: TemplatePurpose,
  spec: LabelTemplateSpec,
): string {
  return `${JSON.stringify({ name, purpose, spec }, null, 2)}\n`;
}

/** Everything but letters, digits, `_` and `-`: what a file name made of a template name drops. */
const UNSAFE_FILE_CHARACTERS = /[^\p{L}\p{N}_-]+/gu;

/**
 * A download's file name stem from a template's name: each run of other
 * characters becomes one `-`, edge dashes go, and a name with nothing left
 * is «label». Unlike the cloud's `safeFileName` it keeps Cyrillic letters,
 * since a Russian site's every template would otherwise download as
 * «label».
 */
export function templateFileName(name: string): string {
  const stem = name
    .trim()
    .replace(UNSAFE_FILE_CHARACTERS, "-")
    .replace(/^-+|-+$/g, "");
  return stem === "" ? "label" : stem;
}
