export interface PageSlice<T> {
  items: T[];
  page: number;
  pageCount: number;
}

/** Returns a deterministic, one-based page and clamps it to the current dataset. */
export function paginate<T>(
  items: readonly T[],
  requestedPage: number,
  pageSize: number,
): PageSlice<T> {
  const size = Number.isFinite(pageSize) ? Math.max(1, Math.trunc(pageSize)) : 1;
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const finitePage = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1;
  const page = Math.min(pageCount, Math.max(1, finitePage));
  const start = (page - 1) * size;

  return {
    items: items.slice(start, start + size),
    page,
    pageCount,
  };
}
