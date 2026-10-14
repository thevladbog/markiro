import type { TFunction } from "i18next";

/**
 * The props that give a `@markiro/ui` `Select` its filter, in the office's
 * words: every list that comes from the host's data (products, categories,
 * lines, counterparties, templates, devices) is searchable, because it grows
 * with the site. A short fixed list (a state filter) stays a plain `Select`.
 */
export function searchableSelect(t: TFunction) {
  return {
    searchable: true,
    searchLabel: t("office.common.selectSearch.label"),
    searchPlaceholder: t("office.common.selectSearch.placeholder"),
    searchEmptyLabel: t("office.common.selectSearch.empty"),
  } as const;
}
