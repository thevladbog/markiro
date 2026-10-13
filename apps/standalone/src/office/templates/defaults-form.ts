import { HostError } from "../../host/client.js";
import type {
  CategoryPalletSheetDefault,
  CategoryTemplateDefault,
  TemplateDefaults,
  TemplatePurpose,
} from "../../host/protocol.js";
import type { TemplateDefaultsInput } from "../../host/requests.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { PURPOSES } from "./template-text.js";

/** The organization's three defaults: each one's field in the document and its slot's purpose. */
export const ORG_DEFAULTS = [
  { field: "defaultBoxTemplateId", purpose: "box" },
  { field: "defaultPalletTemplateId", purpose: "pallet" },
  { field: "defaultDuplicateTemplateId", purpose: "product_duplicate" },
] as const satisfies readonly { field: keyof TemplateDefaultsInput; purpose: TemplatePurpose }[];

export type OrgDefaultField = (typeof ORG_DEFAULTS)[number]["field"];

/** The organization's A4 sheet in the document, beside its pallet template. */
export const ORG_SHEET_FIELD = "defaultPalletSheetId";

/**
 * The defaults as the page edits them: each organization default as its
 * select holds it (`""` for none) and every category default, the A4 sheets
 * (the organization's and each category's) beside the label templates.
 */
export interface DefaultsDraft {
  defaultBoxTemplateId: string;
  defaultPalletTemplateId: string;
  defaultDuplicateTemplateId: string;
  categories: readonly CategoryTemplateDefault[];
  defaultPalletSheetId: string;
  sheetCategories: readonly CategoryPalletSheetDefault[];
}

/** The draft of a loaded document. */
export function draftOf(document: TemplateDefaults): DefaultsDraft {
  return {
    defaultBoxTemplateId: document.defaultBoxTemplateId ?? "",
    defaultPalletTemplateId: document.defaultPalletTemplateId ?? "",
    defaultDuplicateTemplateId: document.defaultDuplicateTemplateId ?? "",
    categories: document.categories,
    defaultPalletSheetId: document.defaultPalletSheetId ?? "",
    sheetCategories: document.palletSheetCategories,
  };
}

/** `draft` with one organization default chosen (`""` for none). */
export function withOrgDefault(
  draft: DefaultsDraft,
  field: OrgDefaultField,
  id: string,
): DefaultsDraft {
  switch (field) {
    case "defaultBoxTemplateId":
      return { ...draft, defaultBoxTemplateId: id };
    case "defaultPalletTemplateId":
      return { ...draft, defaultPalletTemplateId: id };
    case "defaultDuplicateTemplateId":
      return { ...draft, defaultDuplicateTemplateId: id };
  }
}

/** What `templateDefaultsUpdate` sends: `null` for an organization default left at «Не выбран». */
export function defaultsInput(draft: DefaultsDraft): TemplateDefaultsInput {
  const id = (value: string) => (value === "" ? null : value);
  return {
    defaultBoxTemplateId: id(draft.defaultBoxTemplateId),
    defaultPalletTemplateId: id(draft.defaultPalletTemplateId),
    defaultDuplicateTemplateId: id(draft.defaultDuplicateTemplateId),
    categories: draft.categories,
    defaultPalletSheetId: id(draft.defaultPalletSheetId),
    palletSheetCategories: draft.sheetCategories,
  };
}

/** A category's default sheet's slot, by the code (`8:pallet_sheet`); a label's slot never takes it. */
export function sheetSlotKey(
  entry: Pick<CategoryPalletSheetDefault, "chzProductGroupCode">,
): string {
  return `${String(entry.chzProductGroupCode)}:pallet_sheet`;
}

/** `draft` with the organization's sheet chosen (`""` for none). */
export function withOrgSheet(draft: DefaultsDraft, id: string): DefaultsDraft {
  return { ...draft, defaultPalletSheetId: id };
}

/** `draft` with `entry` as its category's default sheet: in place, or added at the end. */
export function withSheetCategoryDefault(
  draft: DefaultsDraft,
  entry: CategoryPalletSheetDefault,
): DefaultsDraft {
  const code = entry.chzProductGroupCode;
  return {
    ...draft,
    sheetCategories: draft.sheetCategories.some((each) => each.chzProductGroupCode === code)
      ? draft.sheetCategories.map((each) => (each.chzProductGroupCode === code ? entry : each))
      : [...draft.sheetCategories, entry],
  };
}

/** `draft` without the default sheet of the category `code`: saving it clears that default. */
export function withoutSheetCategoryDefault(draft: DefaultsDraft, code: number): DefaultsDraft {
  return {
    ...draft,
    sheetCategories: draft.sheetCategories.filter((each) => each.chzProductGroupCode !== code),
  };
}

/** A category default's slot, its category and purpose, as the feed keys it (`8:box`). */
export function slotKey(
  entry: Pick<CategoryTemplateDefault, "chzProductGroupCode" | "purpose">,
): string {
  return `${entry.chzProductGroupCode}:${entry.purpose}`;
}

/** `draft` with `entry` in its slot: in place of the slot's default, or added at the end. */
export function withCategoryDefault(
  draft: DefaultsDraft,
  entry: CategoryTemplateDefault,
): DefaultsDraft {
  const slot = slotKey(entry);
  return {
    ...draft,
    categories: draft.categories.some((each) => slotKey(each) === slot)
      ? draft.categories.map((each) => (slotKey(each) === slot ? entry : each))
      : [...draft.categories, entry],
  };
}

/** `draft` without the category default of `slot`: saving it clears that default. */
export function withoutCategoryDefault(draft: DefaultsDraft, slot: string): DefaultsDraft {
  return { ...draft, categories: draft.categories.filter((each) => slotKey(each) !== slot) };
}

/** The purposes a category has no default of yet, in the order the office offers them. */
export function freePurposes(
  categories: readonly CategoryTemplateDefault[],
  code: number,
): TemplatePurpose[] {
  return PURPOSES.filter(
    (purpose) =>
      !categories.some((each) => each.chzProductGroupCode === code && each.purpose === purpose),
  );
}

/** What a category default prints: a label of a purpose, or the pallet's A4 sheet. */
export type DefaultKind = TemplatePurpose | "pallet_sheet";

/**
 * The kinds a category has no default of yet, in the order the office offers
 * them: the A4 sheet right after the pallet label, its alternative.
 */
export function freeKinds(
  categories: readonly CategoryTemplateDefault[],
  sheetCategories: readonly CategoryPalletSheetDefault[],
  code: number,
): DefaultKind[] {
  const purposes = freePurposes(categories, code);
  const kinds: DefaultKind[] = [];
  for (const purpose of PURPOSES) {
    if (purposes.includes(purpose)) kinds.push(purpose);
    if (
      purpose === "pallet" &&
      !sheetCategories.some((each) => each.chzProductGroupCode === code)
    ) {
      kinds.push("pallet_sheet");
    }
  }
  return kinds;
}

/**
 * Whether two drafts hold the same defaults: the organization's three and
 * its sheet, the same template in the same category slots and the same sheet
 * for the same categories, in any order.
 */
export function sameDraft(a: DefaultsDraft, b: DefaultsDraft): boolean {
  return (
    a.defaultBoxTemplateId === b.defaultBoxTemplateId &&
    a.defaultPalletTemplateId === b.defaultPalletTemplateId &&
    a.defaultDuplicateTemplateId === b.defaultDuplicateTemplateId &&
    a.defaultPalletSheetId === b.defaultPalletSheetId &&
    a.categories.length === b.categories.length &&
    a.categories.every((entry) =>
      b.categories.some(
        (other) => slotKey(other) === slotKey(entry) && other.templateId === entry.templateId,
      ),
    ) &&
    a.sheetCategories.length === b.sheetCategories.length &&
    a.sheetCategories.every((entry) =>
      b.sheetCategories.some(
        (other) =>
          other.chzProductGroupCode === entry.chzProductGroupCode &&
          other.sheetId === entry.sheetId,
      ),
    )
  );
}

/** `categories.{i}`, `categories.{i}.templateId` or `categories.{i}.chzProductGroupCode`. */
const CATEGORY_FIELD = /^categories\.(\d+)(?:\.(templateId|chzProductGroupCode))?$/;

/** The same of a category's default sheet: `palletSheetCategories.{i}`, `.sheetId`, `.chzProductGroupCode`. */
const SHEET_CATEGORY_FIELD = /^palletSheetCategories\.(\d+)(?:\.(sheetId|chzProductGroupCode))?$/;

/**
 * A refused save: under the organization default the host names, or under
 * the category default it names by its index in the categories the page sent
 * (`sent`, which keeps the page's own order, not the order it shows), else a
 * stale write or an alert (`alertFailure`). `key` is the organization
 * default's field or the category default's slot (`slotKey`). The host checks
 * the defaults before the revision, so a template disabled, narrowed or
 * deleted while the page was open is refused on its field, not as
 * `stale_revision`. A refusal for a category default the page no longer holds
 * (`current`, the page's draft now; `sent` unless given) has no control to
 * show it, so it is the general alert. The sheets go the same way: the
 * organization's sheet under its select (`ORG_SHEET_FIELD`), a category's by
 * its index in the sheets sent (`sentSheets`; `sheetSlotKey`).
 */
export type DefaultsFailure = { kind: "field"; key: string; message: string } | AlertFailure;

export function defaultsFailure(
  error: unknown,
  sent: readonly CategoryTemplateDefault[] = [],
  current: readonly CategoryTemplateDefault[] = sent,
  sentSheets: readonly CategoryPalletSheetDefault[] = [],
  currentSheets: readonly CategoryPalletSheetDefault[] = sentSheets,
): DefaultsFailure {
  const path = error instanceof HostError ? error.field : null;
  const org = ORG_DEFAULTS.find((each) => each.field === path);
  if (org !== undefined) {
    return { kind: "field", key: org.field, message: "office.templateDefaults.errors.unfit" };
  }
  if (path === ORG_SHEET_FIELD) {
    return {
      kind: "field",
      key: ORG_SHEET_FIELD,
      message: "office.templateDefaults.errors.sheetUnfit",
    };
  }
  const sheetCategory = path === null ? null : SHEET_CATEGORY_FIELD.exec(path);
  const sheetEntry = sheetCategory === null ? undefined : sentSheets[Number(sheetCategory[1])];
  if (
    sheetCategory !== null &&
    sheetEntry !== undefined &&
    currentSheets.some((each) => each.chzProductGroupCode === sheetEntry.chzProductGroupCode)
  ) {
    const message =
      sheetCategory[2] === "sheetId"
        ? "office.templateDefaults.errors.sheetUnfit"
        : sheetCategory[2] === "chzProductGroupCode"
          ? "office.templateDefaults.errors.category"
          : "office.templateDefaults.errors.twice";
    return { kind: "field", key: sheetSlotKey(sheetEntry), message };
  }
  const category = path === null ? null : CATEGORY_FIELD.exec(path);
  const entry = category === null ? undefined : sent[Number(category[1])];
  if (
    category !== null &&
    entry !== undefined &&
    current.some((each) => slotKey(each) === slotKey(entry))
  ) {
    const message =
      category[2] === "templateId"
        ? "office.templateDefaults.errors.unfit"
        : category[2] === "chzProductGroupCode"
          ? "office.templateDefaults.errors.category"
          : "office.templateDefaults.errors.twice";
    return { kind: "field", key: slotKey(entry), message };
  }
  return alertFailure(error);
}
