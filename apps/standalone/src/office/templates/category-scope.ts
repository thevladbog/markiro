import type { ProductGroup } from "../../host/protocol.js";

/** Group names in Russian order, with numbers by value. */
const NAMES = new Intl.Collator("ru", { numeric: true });

/**
 * A template's categories as `CategoryScopeField` edits them: every category,
 * or the chosen ЧЗ product-group codes. The codes stay while «Все категории»
 * is chosen, so switching back brings them back.
 */
export interface CategoryScope {
  mode: "all" | "selected";
  codes: readonly number[];
}

/** The field's value for a template's categories (`null` for every category). */
export function scopeOf(codes: readonly number[] | null): CategoryScope {
  return codes === null ? { mode: "all", codes: [] } : { mode: "selected", codes };
}

/**
 * The categories a write sends: `null` for every category, else the chosen
 * codes ascending. `templateUpdate` takes a reordered list as a change, which
 * would cost a new revision and send the layout to every station again.
 */
export function scopeCodes(scope: CategoryScope): number[] | null {
  return scope.mode === "all" ? null : [...scope.codes].sort((a, b) => a - b);
}

/** Whether two category lists name the same categories in any order (`null` is every category). */
export function sameCategories(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((code) => b.includes(code));
}

/** The groups whose name holds the search without case, by name; a blank search keeps them all. */
export function visibleGroups(groups: readonly ProductGroup[], search: string): ProductGroup[] {
  const text = search.trim().toLocaleLowerCase("ru");
  return groups
    .filter((group) => text === "" || group.name.toLocaleLowerCase("ru").includes(text))
    .sort((a, b) => NAMES.compare(a.name, b.name));
}
