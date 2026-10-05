import type { TFunction } from "i18next";

import type { OfficeProduct, ProductGroup } from "../../host/protocol.js";

/** A product as the list names it: archived, or else the host's status. */
export type ProductState = "draft" | "active" | "archived";

export function productState(product: Pick<OfficeProduct, "archived" | "status">): ProductState {
  return product.archived ? "archived" : product.status;
}

/** What the state filter keeps. */
export type ProductFilter = "all" | ProductState;

/** Rows on one page of the list. */
export const PAGE_SIZE = 25;

/**
 * Whether `product` matches the search: its name or print name holds the
 * text, without case, or its GTIN holds the text with its spaces taken out,
 * so «4600 682» finds 04600682000013. A blank search matches every product.
 */
export function matchesSearch(
  product: Pick<OfficeProduct, "name" | "printName" | "gtin14">,
  search: string,
): boolean {
  const text = search.trim().toLocaleLowerCase("ru");
  if (text === "") return true;
  return (
    product.name.toLocaleLowerCase("ru").includes(text) ||
    (product.printName?.toLocaleLowerCase("ru").includes(text) ?? false) ||
    product.gtin14.includes(text.replace(/\s+/g, ""))
  );
}

/** The products the search and the state filter keep, in the order given. */
export function findProducts<T extends OfficeProduct>(
  products: readonly T[],
  search: string,
  filter: ProductFilter,
): T[] {
  return products.filter(
    (product) =>
      (filter === "all" || productState(product) === filter) && matchesSearch(product, search),
  );
}

/**
 * How the office names a product group: its name from the host's lookup;
 * its code when the lookup does not have it or did not load; none.
 */
export function groupLabel(
  groups: readonly ProductGroup[] | undefined,
  code: number | null,
  t: TFunction,
): string {
  if (code === null) return t("office.common.none");
  const group = groups?.find((each) => each.code === code);
  return group === undefined ? t("office.products.unknownGroup", { code }) : group.name;
}
