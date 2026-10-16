import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Table, type TableProps } from "@markiro/ui";

import { PaginationBar } from "./PaginationBar.js";
import type { PageSize } from "./page-size.js";

export interface CursorTableProps<Row> extends Omit<
  TableProps<Row>,
  "page" | "pageCount" | "onPage" | "rows"
> {
  /** The page that is shown, from `useCursorPaging`. */
  paging: {
    page: number;
    pageSize: PageSize;
    pageCount: number | null;
    total: number | null;
    hasNext: boolean;
    rows: Row[];
    setPage: (page: number) => void;
    setPageSize: (size: PageSize) => void;
  };
  /** The pages' accessible name. */
  pagerLabel: string;
  /** The next page is on its way: the page controls wait. */
  busy?: boolean;
  /** What stands between the table and its pagination (a failed read with its «Повторить»). */
  notice?: ReactNode;
}

/**
 * A table of a list the host pages itself (`useCursorPaging`): the page that is
 * shown, and the same `PaginationBar` as every client-paged table has.
 */
export function CursorTable<Row>({
  paging,
  pagerLabel,
  busy = false,
  notice,
  scrollLabel,
  tableLabel,
  ...table
}: CursorTableProps<Row>) {
  const { t } = useTranslation();
  const name = scrollLabel ?? tableLabel;
  return (
    <div className="office-paged">
      <Table
        {...table}
        rows={paging.rows}
        scrollLabel={name ?? t("office.common.pagination.table")}
        {...(tableLabel === undefined ? {} : { tableLabel })}
      />
      {notice}
      <PaginationBar
        label={pagerLabel}
        {...(name === undefined ? {} : { name })}
        page={paging.page}
        pageSize={paging.pageSize}
        shownRows={paging.rows.length}
        total={paging.total}
        pageCount={paging.pageCount}
        hasNext={paging.hasNext}
        busy={busy}
        onPage={paging.setPage}
        onPageSize={paging.setPageSize}
      />
    </div>
  );
}
