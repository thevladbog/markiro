import { useTranslation } from "react-i18next";

import { Table, type TableProps } from "@markiro/ui";

import { PaginationBar } from "./PaginationBar.js";
import { useClientPaging } from "./use-paging.js";

export interface PagedTableProps<Row> extends Omit<
  TableProps<Row>,
  "page" | "pageCount" | "onPage"
> {
  /**
   * The table's name for its kept page size: one per table of the office
   * («shifts», «shift-boxes»), the same on every visit.
   */
  tableId: string;
  /** The pages' accessible name; the table's own name by default. */
  pagerLabel?: string;
  /** The table goes back to its first page when this changes (a filter, a search). */
  resetKey?: string | number;
}

/**
 * An office table whose rows are all in the webview, shown a page at a time:
 * `Table` of `@markiro/ui` with the office's `PaginationBar` under it. The
 * page size (10 by default, 10 / 25 / 50 / 100) is kept per table. A table
 * the host pages itself uses `Table` with `PaginationBar` and the cursor or
 * window hooks of this folder instead.
 */
export function PagedTable<Row>({
  tableId,
  pagerLabel,
  resetKey,
  rows,
  scrollLabel,
  tableLabel,
  ...table
}: PagedTableProps<Row>) {
  const { t } = useTranslation();
  const paging = useClientPaging(tableId, rows, resetKey);
  const name = scrollLabel ?? tableLabel;
  return (
    <div className="office-paged">
      <Table
        {...table}
        rows={paging.rows}
        // Every table is a keyboard-reachable scroll region with a name, as wide as its columns need.
        scrollLabel={name ?? t("office.common.pagination.table")}
        {...(tableLabel === undefined ? {} : { tableLabel })}
      />
      <PaginationBar
        label={
          pagerLabel ??
          (name === undefined
            ? t("office.common.pagination.navDefault")
            : t("office.common.pagination.nav", { table: name }))
        }
        {...(name === undefined ? {} : { name })}
        page={paging.page}
        pageSize={paging.pageSize}
        shownRows={paging.rows.length}
        total={paging.total}
        pageCount={paging.pageCount}
        hasNext={paging.page < paging.pageCount}
        onPage={paging.setPage}
        onPageSize={paging.setPageSize}
      />
    </div>
  );
}
