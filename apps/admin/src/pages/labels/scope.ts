import type { TFunction } from "i18next";

import type { ChzProductGroupDto } from "../catalog/api.js";

/** Human label for a template's product-group scope; `title` carries the full list when it is abbreviated. */
export function describeTemplateScope(
  codes: readonly number[] | null,
  groups: readonly ChzProductGroupDto[],
  t: TFunction,
): { label: string; title: string | null } {
  if (codes === null) return { label: t("pages.labels.scopeAll"), title: null };
  const names = codes.map(
    (code) => groups.find((group) => group.code === code)?.name ?? String(code),
  );
  const full = names.join(", ");
  if (names.length <= 2) return { label: full, title: null };
  return { label: t("pages.labels.scopeCount", { count: names.length }), title: full };
}

/** Text for the 409 `LABEL_TEMPLATE_IS_DEFAULT` body (`ApiRequestError.details`). */
export function describeDefaultConflict(
  details: unknown,
  groups: readonly ChzProductGroupDto[],
  t: TFunction,
): string {
  const body =
    details && typeof details === "object"
      ? (details as { organizationDefault?: unknown; categoryDefaults?: unknown })
      : {};
  const parts: string[] = [];
  if (body.organizationDefault === true) parts.push(t("pages.labels.defaultConflict.organization"));
  const codes = Array.isArray(body.categoryDefaults)
    ? body.categoryDefaults.filter((code): code is number => typeof code === "number")
    : [];
  if (codes.length > 0) {
    parts.push(
      t("pages.labels.defaultConflict.categories", {
        categories: codes
          .map((code) => groups.find((group) => group.code === code)?.name ?? String(code))
          .join(", "),
      }),
    );
  }
  parts.push(t("pages.labels.defaultConflict.hint"));
  return parts.join(" ");
}
