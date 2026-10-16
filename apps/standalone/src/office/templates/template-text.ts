import type { TFunction } from "i18next";
import { z } from "zod";

import type { BadgeTone } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { LabelTemplateSummary, ProductGroup, TemplatePurpose } from "../../host/protocol.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";

/** The purposes in the order the office offers them (filters, choices). */
export const PURPOSES: readonly TemplatePurpose[] = ["box", "pallet", "product_duplicate"];

/**
 * A purpose's category tone, as the cloud's `PURPOSE_TO_TONE` gives it: the
 * domain's union order (box, product duplicate, pallet) takes violet, teal
 * and magenta. A purpose is a kind, not a phase, so it is a `Badge`.
 */
export const PURPOSE_TONE = {
  box: "violet",
  product_duplicate: "teal",
  pallet: "magenta",
} as const satisfies Record<TemplatePurpose, BadgeTone>;

/** Millimetres as the office writes them: «58», «58,5». */
const MM = new Intl.NumberFormat("ru", { maximumFractionDigits: 2 });

/** «58 × 40 мм»; none when the layout gives no width or no height. */
export function sizeText(
  template: Pick<LabelTemplateSummary, "widthMm" | "heightMm">,
  t: TFunction,
): string {
  if (template.widthMm === null || template.heightMm === null) return t("office.common.none");
  return t("office.templates.size", {
    width: MM.format(template.widthMm),
    height: MM.format(template.heightMm),
  });
}

/** A product group's name from the lookup; its code when the lookup lacks it or did not load. */
export function groupName(
  groups: readonly ProductGroup[] | undefined,
  code: number,
  t: TFunction,
): string {
  return (
    groups?.find((group) => group.code === code)?.name ?? t("office.templates.groupCode", { code })
  );
}

/**
 * A template's categories in words, after the cloud's `describeTemplateScope`:
 * every category; one group's name; or how many, since ЧЗ group names run
 * long. `title` carries the names whenever there is a list; «Шаблоны» also
 * puts a count's names in the cell for a screen reader.
 */
export function describeScope(
  codes: readonly number[] | null,
  groups: readonly ProductGroup[] | undefined,
  t: TFunction,
): { label: string; title: string | null } {
  if (codes === null) return { label: t("office.templates.scope.all"), title: null };
  const names = codes.map((code) => groupName(groups, code, t)).join(", ");
  if (codes.length === 1) return { label: names, title: names };
  return { label: t("office.templates.scope.count", { n: codes.length }), title: names };
}

/**
 * The defaults a refused template write names (`conflict` with
 * `constraint: template_is_default`): the organization's default of the
 * template's purpose, and the categories whose default it is.
 */
export interface DefaultConflict {
  organization: boolean;
  categories: number[];
}

const CATEGORY_CODES = z.array(z.number().int().nonnegative());

/** The defaults a refusal names, or `null` when it is any other failure. */
export function defaultConflict(error: unknown): DefaultConflict | null {
  if (
    !(error instanceof HostError) ||
    error.code !== "conflict" ||
    error.details.constraint !== "template_is_default"
  ) {
    return null;
  }
  const categories = CATEGORY_CODES.safeParse(error.details.categoryDefaults);
  return {
    organization: error.details.organizationDefault === true,
    categories: categories.success ? categories.data : [],
  };
}

/**
 * The refusal in words, after the cloud's `describeDefaultConflict`: whose
 * default the template is, the categories by name, and where to choose
 * another template first.
 */
export function describeDefaultConflict(
  conflict: DefaultConflict,
  groups: readonly ProductGroup[] | undefined,
  t: TFunction,
): string {
  const parts: string[] = [];
  if (conflict.organization) parts.push(t("office.templates.conflict.organization"));
  if (conflict.categories.length > 0) {
    parts.push(
      t("office.templates.conflict.categories", {
        categories: conflict.categories.map((code) => groupName(groups, code, t)).join(", "),
      }),
    );
  }
  parts.push(t("office.templates.conflict.hint"));
  return parts.join(" ");
}

/** A refused template write: the defaults in its way, or what `alertFailure` makes of it. */
export type TemplateFailure = AlertFailure | { kind: "default"; conflict: DefaultConflict };

/**
 * A refused write of a row's template: the defaults in its way, a template
 * deleted on another workstation since the list was read (`not_found`), or
 * what `alertFailure` makes of it.
 */
export function templateFailure(error: unknown): TemplateFailure {
  const conflict = defaultConflict(error);
  if (conflict !== null) return { kind: "default", conflict };
  if (error instanceof HostError && error.code === "not_found") {
    return { kind: "alert", message: "office.templateEditor.errors.missing" };
  }
  return alertFailure(error);
}
