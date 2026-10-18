/**
 * Where a page of `size` rows lies among the host's fixed pages of
 * `hostSize` rows. The host pages its lists by number with a size of its own
 * (50), so a page of 10, 25 or 50 is a part of one host page and a page of
 * 100 is two of them; the office asks the host for the pages it needs and cuts
 * the rows out.
 */
export interface HostWindow {
  /** The first host page the rows lie on (one-based). */
  first: number;
  /** The last one: the same page, or the next. */
  last: number;
  /** Where the rows start among those of `first`. */
  offset: number;
}

export function hostWindow(page: number, size: number, hostSize: number): HostWindow {
  const start = (page - 1) * size;
  const first = Math.floor(start / hostSize) + 1;
  const last = Math.floor((start + size - 1) / hostSize) + 1;
  return { first, last, offset: start - (first - 1) * hostSize };
}

/** The rows of a window: those of its host pages together, from its offset, `size` of them. */
export function windowRows<Row>(
  window: HostWindow,
  size: number,
  firstRows: readonly Row[],
  lastRows: readonly Row[] | undefined,
): Row[] {
  const joined = window.last === window.first ? firstRows : [...firstRows, ...(lastRows ?? [])];
  return joined.slice(window.offset, window.offset + size);
}
