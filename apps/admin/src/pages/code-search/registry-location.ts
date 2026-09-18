/**
 * Remembers where the manager last was inside the code-search section.
 *
 * The three registries (`/codes`, `/boxes`, `/pallets`) keep their filters in
 * the URL query, so the browser's own Back restores them. What the URL alone
 * cannot do is bring the manager back to the *right tab with its filters*
 * from a code/box/pallet card, or from another tab -- the card's «← Поиск
 * кодов» link and the tab switch need to know the last address of each tab.
 * That is what this module stores: one entry per tab plus the tab the manager
 * was on most recently. `sessionStorage` scopes it to the browser tab and
 * forgets it when the tab closes, which is exactly the lifetime of "where I
 * was a moment ago".
 */

export type RegistryTab = "codes" | "boxes" | "pallets";

export const REGISTRY_PATHS: Record<RegistryTab, string> = {
  codes: "/codes",
  boxes: "/boxes",
  pallets: "/pallets",
};

const TAB_KEY_PREFIX = "markiro.codeSearch.registry.";
const LAST_TAB_KEY = "markiro.codeSearch.lastTab";

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Storage access can throw under a blocked-storage browser policy; the
    // section then simply behaves as before (no memory between pages).
    return null;
  }
}

function readItem(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Quota or policy failure: losing the memory is harmless.
  }
}

function isRegistryTab(value: string | null): value is RegistryTab {
  return value === "codes" || value === "boxes" || value === "pallets";
}

/**
 * Called by a registry page on every render whose location changed. `search`
 * is the location's `?…` string (empty when there are no filters).
 */
export function rememberRegistryLocation(tab: RegistryTab, search: string): void {
  writeItem(`${TAB_KEY_PREFIX}${tab}`, search);
  writeItem(LAST_TAB_KEY, tab);
}

/** Href of a tab as it was last seen, or its bare path if never visited. */
export function registryHref(tab: RegistryTab): string {
  const search = readItem(`${TAB_KEY_PREFIX}${tab}`) ?? "";
  return `${REGISTRY_PATHS[tab]}${search}`;
}

/**
 * Href for a card's «← Поиск кодов» link: the tab the manager came from, with
 * its filters. Falls back to the code registry for deep links opened fresh.
 */
export function lastRegistryHref(): string {
  const tab = readItem(LAST_TAB_KEY);
  return registryHref(isRegistryTab(tab) ? tab : "codes");
}

/** Test-only helper: forgets everything this module stored. */
export function forgetRegistryLocations(): void {
  const store = storage();
  if (!store) return;
  for (const tab of Object.keys(REGISTRY_PATHS)) store.removeItem(`${TAB_KEY_PREFIX}${tab}`);
  store.removeItem(LAST_TAB_KEY);
}
