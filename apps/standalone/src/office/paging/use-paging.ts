import { useEffect, useState } from "react";

import { usePageSize, type PageSize } from "./page-size.js";

export interface Paging {
  /** One-based, always inside the pages there are. */
  page: number;
  pageSize: PageSize;
  setPage: (page: number) => void;
  setPageSize: (size: PageSize) => void;
}

/**
 * The page and the page size of one office table, apart from where the rows
 * come from. The size is the table's own and kept (`usePageSize`); the page
 * goes back to the first when the size changes or when `resetKey` does (a
 * filter, a search, a tab).
 */
export function usePaging(tableId: string, resetKey: string | number = ""): Paging {
  const [pageSize, keepPageSize] = usePageSize(tableId);
  const [state, setState] = useState({ page: 1, key: resetKey });
  // A new key is read in this very render, not after an effect: no flash of the old page.
  const fresh = state.key === resetKey;
  if (!fresh) setState({ page: 1, key: resetKey });
  return {
    page: fresh ? state.page : 1,
    pageSize,
    setPage: (page) => setState({ page: Math.max(1, page), key: resetKey }),
    setPageSize: (size) => {
      keepPageSize(size);
      setState({ page: 1, key: resetKey });
    },
  };
}

/** The rows of a list kept whole in the webview, cut into the page that is shown. */
export function useClientPaging<Row>(
  tableId: string,
  rows: readonly Row[],
  resetKey: string | number = "",
) {
  const paging = usePaging(tableId, resetKey);
  const pageCount = Math.max(1, Math.ceil(rows.length / paging.pageSize));
  const page = Math.min(paging.page, pageCount);
  const start = (page - 1) * paging.pageSize;
  return {
    ...paging,
    page,
    pageCount,
    total: rows.length,
    rows: rows.slice(start, start + paging.pageSize),
  };
}

/**
 * A list the host gives a page at a time after a cursor, cut into the pages
 * that are shown (the scan history, the pallets). `paging` is made first
 * (`usePaging`), because a host that takes a `limit` is asked for the page
 * size. The rows read so far stay in the webview, so «Назад» needs no
 * request; one row past the page is always kept read (when the host has it),
 * so «Вперёд» is known to lead somewhere and the list needs no «Показать ещё».
 */
export function useCursorPaging<Row>(
  paging: Paging,
  options: {
    /** Every row read so far, in the host's order. */
    rows: readonly Row[];
    hasMore: boolean;
    /** Any read is on its way (the first page, a refresh, the next page). */
    fetching: boolean;
    /** A read that failed: nothing is read again until the person asks (a retry). */
    failed: boolean;
    fetchMore: () => void;
  },
) {
  const { rows, hasMore, fetching, failed, fetchMore } = options;
  const { page, pageSize } = paging;
  const needed = page * pageSize + 1;
  useEffect(() => {
    if (hasMore && !fetching && !failed && rows.length < needed) fetchMore();
  }, [hasMore, fetching, failed, rows.length, needed, fetchMore]);
  const pageCount = hasMore ? null : Math.max(1, Math.ceil(rows.length / pageSize));
  const shownPage = pageCount === null ? page : Math.min(page, pageCount);
  const start = (shownPage - 1) * pageSize;
  return {
    ...paging,
    page: shownPage,
    pageCount,
    total: hasMore ? null : rows.length,
    // Only a row that is read says a next page exists: «Вперёд» never leads to an empty page.
    hasNext: rows.length > shownPage * pageSize,
    rows: rows.slice(start, start + pageSize),
  };
}
