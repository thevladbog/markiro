import { HostError } from "../../host/client.js";
import type {
  CategoryTemplateDefault,
  TemplateDefaults,
  TemplatePurpose,
} from "../../host/protocol.js";
import type { TemplateDefaultsInput } from "../../host/requests.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";

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

/**
 * A refused save: under the organization default the host names (a template
 * that no longer fits its slot, or no longer exists; `key` is that default's
 * field), else a stale write or an alert (`alertFailure`). The host checks the
 * defaults before the revision, so a template disabled, narrowed or deleted
 * while the page was open is refused on its field, not as `stale_revision`.
 */
export type DefaultsFailure = { kind: "field"; key: string; message: string } | AlertFailure;

export function defaultsFailure(error: unknown): DefaultsFailure {
  const path = error instanceof HostError ? error.field : null;
  const org = ORG_DEFAULTS.find((each) => each.field === path);
  if (org !== undefined) {
    return { kind: "field", key: org.field, message: "office.templateDefaults.errors.unfit" };
  }
  return alertFailure(error);
}
