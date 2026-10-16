import { useCallback, useState } from "react";

/** The page sizes an office table offers, and the one it opens with. */
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 10;
/** A table with no more rows than this has one page whatever the size: it shows no pager. */
export const SMALLEST_PAGE_SIZE: number = PAGE_SIZES[0];

const KEY_PREFIX = "markiro.office.pageSize.";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A webview with storage turned off: every table opens on the default.
    return null;
  }
}

export function isPageSize(value: unknown): value is PageSize {
  return PAGE_SIZES.some((size) => size === value);
}

/** The size kept for the table `id`; the default for a table never set or a damaged value. */
export function readPageSize(id: string): PageSize {
  try {
    const raw = storage()?.getItem(KEY_PREFIX + id) ?? null;
    // Digits only: «1e2» and «100.0» are not what this module wrote.
    const kept = raw !== null && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
    return isPageSize(kept) ? kept : DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

/** Keeps the size of the table `id` in the webview's storage; a refused write is not an error. */
export function writePageSize(id: string, size: PageSize): void {
  try {
    storage()?.setItem(KEY_PREFIX + id, String(size));
  } catch {
    // Storage full or refused: the size holds until the page is left.
  }
}

/** The table's page size, read once and kept as it is changed. */
export function usePageSize(id: string): [PageSize, (size: PageSize) => void] {
  const [size, setSize] = useState<PageSize>(() => readPageSize(id));
  const change = useCallback(
    (next: PageSize) => {
      writePageSize(id, next);
      setSize(next);
    },
    [id],
  );
  return [size, change];
}
