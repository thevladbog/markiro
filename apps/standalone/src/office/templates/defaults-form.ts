import { HostError } from "../../host/client.js";
import type {
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

/**
 * The defaults as the page edits them: each organization default as its
 * select holds it (`""` for none) and every category default.
 */
export interface DefaultsDraft {
  defaultBoxTemplateId: string;
  defaultPalletTemplateId: string;
  defaultDuplicateTemplateId: string;
  categories: readonly CategoryTemplateDefault[];
}

/** The draft of a loaded document. */
export function draftOf(document: TemplateDefaults): DefaultsDraft {
  return {
    defaultBoxTemplateId: document.defaultBoxTemplateId ?? "",
    defaultPalletTemplateId: document.defaultPalletTemplateId ?? "",
    defaultDuplicateTemplateId: document.defaultDuplicateTemplateId ?? "",
    categories: document.categories,
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

/**
 * Whether two drafts hold the same defaults: the organization's three, and
 * the same template in the same category slots, in any order.
 */
export function sameDraft(a: DefaultsDraft, b: DefaultsDraft): boolean {
  return (
    a.defaultBoxTemplateId === b.defaultBoxTemplateId &&
    a.defaultPalletTemplateId === b.defaultPalletTemplateId &&
    a.defaultDuplicateTemplateId === b.defaultDuplicateTemplateId &&
    a.categories.length === b.categories.length &&
    a.categories.every((entry) =>
      b.categories.some(
        (other) => slotKey(other) === slotKey(entry) && other.templateId === entry.templateId,
      ),
    )
  );
}

/** `categories.{i}`, `categories.{i}.templateId` or `categories.{i}.chzProductGroupCode`. */
const CATEGORY_FIELD = /^categories\.(\d+)(?:\.(templateId|chzProductGroupCode))?$/;

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
 * show it, so it is the general alert.
 */
export type DefaultsFailure = { kind: "field"; key: string; message: string } | AlertFailure;

export function defaultsFailure(
  error: unknown,
  sent: readonly CategoryTemplateDefault[] = [],
  current: readonly CategoryTemplateDefault[] = sent,
): DefaultsFailure {
  const path = error instanceof HostError ? error.field : null;
  const org = ORG_DEFAULTS.find((each) => each.field === path);
  if (org !== undefined) {
    return { kind: "field", key: org.field, message: "office.templateDefaults.errors.unfit" };
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
