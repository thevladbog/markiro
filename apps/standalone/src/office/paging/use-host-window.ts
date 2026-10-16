import type { QueryKey, UseQueryResult } from "@tanstack/react-query";

import type { HostApi } from "../../host/api.js";
import { useOfficeQuery } from "../office-query.js";
import { hostWindow, windowRows } from "./host-window.js";

/** What a host page of a numbered list carries (`OfficeConflictPage`, `OfficeCodePage`). */
export interface NumberedPage<Row> {
  items: Row[];
  total: number;
  pageCount: number;
}

/**
 * A list the host pages by number with a fixed size (conflicts, code search)
 * shown in pages of the office's size: one host page, or two when a page of
 * 100 spans them. The host's routes are as they were; the office asks for the
 * host pages the window lies on and cuts the rows out. `first` is the read the
 * page waits for and the one whose failure the page shows; `rows` is `undefined`
 * until every host page the window needs has arrived.
 */
export function useHostWindowRows<Row, Page extends NumberedPage<Row>>(options: {
  page: number;
  pageSize: number;
  hostSize: number;
  keyOf: (hostPage: number) => QueryKey;
  read: (api: HostApi, token: string, hostPage: number) => Promise<Page>;
  enabled: boolean;
}): {
  first: UseQueryResult<Page, Error>;
  second: UseQueryResult<Page, Error>;
  rows: Row[] | undefined;
  /** Rows the host can give, never more than its pages reach. */
  reachable: number;
  pageCount: number;
} {
  const { page, pageSize, hostSize, keyOf, read, enabled } = options;
  const window = hostWindow(page, pageSize, hostSize);
  const first = useOfficeQuery(
    keyOf(window.first),
    (api, token) => read(api, token, window.first),
    {
      enabled,
    },
  );
  const reaches = first.data !== undefined && window.last <= first.data.pageCount;
  const needsSecond = window.last !== window.first;
  const second = useOfficeQuery(keyOf(window.last), (api, token) => read(api, token, window.last), {
    enabled: enabled && needsSecond && reaches,
  });
  const reachable =
    first.data === undefined ? 0 : Math.min(first.data.total, first.data.pageCount * hostSize);
  const head = first.data;
  const ready = head !== undefined && (!needsSecond || !reaches || second.data !== undefined);
  return {
    first,
    second,
    rows: ready ? windowRows(window, pageSize, head.items, second.data?.items) : undefined,
    reachable,
    pageCount: Math.max(1, Math.ceil(reachable / pageSize)),
  };
}
