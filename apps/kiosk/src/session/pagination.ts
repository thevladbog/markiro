export function pageSizeFor(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 5;
  return height > width ? 5 : 3;
}

function safePageSize(pageSize: number): number {
  return Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 1;
}

export function pageCount(itemCount: number, pageSize: number): number {
  const count = Number.isInteger(itemCount) && itemCount > 0 ? itemCount : 0;
  return Math.max(1, Math.ceil(count / safePageSize(pageSize)));
}

export function clampPage(page: number, itemCount: number, pageSize: number): number {
  const safe = Number.isInteger(page) && page >= 0 ? page : 0;
  return Math.min(safe, pageCount(itemCount, pageSize) - 1);
}

export function pageItems<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const size = safePageSize(pageSize);
  const bounded = clampPage(page, items.length, size);
  return items.slice(bounded * size, bounded * size + size);
}
