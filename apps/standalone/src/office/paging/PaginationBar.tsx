import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Input, Select } from "@markiro/ui";

import { isPageSize, PAGE_SIZES, SMALLEST_PAGE_SIZE, type PageSize } from "./page-size.js";

/** Counts with the thousands apart by a no-break space: «1 200». */
const COUNT = new Intl.NumberFormat("ru");

export interface PaginationBarProps {
  /** The navigation's accessible name: whose pages these are. */
  label: string;
  /** The table's own name, to tell the page-size choice of one table from another's. */
  name?: string;
  /** One-based. */
  page: number;
  pageSize: PageSize;
  /** The rows on the page that is shown. */
  shownRows: number;
  /** Every row, when it is known; `null` for a list read a page at a time. */
  total: number | null;
  /** Every page, when it is known. */
  pageCount: number | null;
  /** Whether a page after this one exists (a list of unknown length). */
  hasNext: boolean;
  onPage: (page: number) => void;
  onPageSize: (size: PageSize) => void;
  /** A page is on its way: the controls wait. */
  busy?: boolean;
}

/** From this many pages on, «в начало» and «в конец» are offered beside «Назад» and «Вперёд». */
const MANY_PAGES = 5;

/**
 * «Перейти на страницу»: a small number field beside the pager. Enter or leaving the field jumps;
 * a number outside 1..`pages` is held to the nearest page, and anything that is not a number puts
 * the current page back. It exists only where the page count is known, so a jump never guesses at
 * a list the host still has to read to its end.
 */
function PageJump({
  page,
  pages,
  busy,
  onPage,
}: {
  page: number;
  pages: number;
  busy: boolean;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(String(page));
  useEffect(() => setDraft(String(page)), [page]);
  const commit = () => {
    const typed = draft.trim();
    if (!/^\d+$/.test(typed)) {
      setDraft(String(page));
      return;
    }
    const target = Math.min(Math.max(Number(typed), 1), pages);
    setDraft(String(target));
    if (target !== page) onPage(target);
  };
  return (
    <Input
      className="office-pagination__jump"
      aria-label={t("office.common.pagination.jump", { pages: COUNT.format(pages) })}
      title={t("office.common.pagination.jumpHint")}
      inputMode="numeric"
      mono
      value={draft}
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.target.select()}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

/**
 * The foot of every office table: «Показано N–M из K», the page size, and
 * the pages (previous, next, and first and last when there are many). One
 * component for the tables paged here and the ones the host pages; a list of
 * unknown length (`total: null`) says «есть ещё» and has no «в конец». A table
 * of ten rows or fewer shows nothing: there is nothing to turn.
 */
export function PaginationBar({
  label,
  name,
  page,
  pageSize,
  shownRows,
  total,
  pageCount,
  hasNext,
  onPage,
  onPageSize,
  busy = false,
}: PaginationBarProps) {
  const { t } = useTranslation();
  const visible =
    total !== null
      ? total > SMALLEST_PAGE_SIZE
      : page > 1 || hasNext || shownRows > SMALLEST_PAGE_SIZE;
  if (!visible) return null;
  const from = shownRows === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = shownRows === 0 ? 0 : from + shownRows - 1;
  const known = pageCount !== null;
  const many = known ? pageCount >= MANY_PAGES : page >= MANY_PAGES - 1;
  const last = known ? pageCount : page + (hasNext ? 1 : 0);
  return (
    <div className="office-pagination">
      <p className="office-pagination__range" aria-live="polite">
        {total !== null
          ? t("office.common.pagination.range", {
              from: COUNT.format(from),
              to: COUNT.format(to),
              total: COUNT.format(total),
            })
          : t("office.common.pagination.rangeOpen", {
              from: COUNT.format(from),
              to: COUNT.format(to),
            })}
      </p>
      <div className="office-pagination__size">
        <span className="office-pagination__size-label" aria-hidden="true">
          {t("office.common.pagination.pageSize")}
        </span>
        <Select
          aria-label={
            name === undefined || name === ""
              ? t("office.common.pagination.pageSize")
              : t("office.common.pagination.pageSizeNamed", { table: name })
          }
          options={PAGE_SIZES.map((size) => String(size))}
          value={String(pageSize)}
          disabled={busy}
          onValueChange={(value) => {
            const next = Number(value);
            if (isPageSize(next)) onPageSize(next);
          }}
        />
      </div>
      <nav aria-label={label} className="office-pagination__pages">
        {many && (
          <Button
            variant="secondary"
            aria-label={t("office.common.pagination.first")}
            title={t("office.common.pagination.first")}
            disabled={busy || page <= 1}
            onClick={() => onPage(1)}
          >
            <span aria-hidden="true">«</span>
          </Button>
        )}
        <Button variant="secondary" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>
          {t("office.common.pagination.previous")}
        </Button>
        <span className="office-pagination__page" aria-live="polite">
          {known
            ? t("office.common.pagination.page", { page, pages: COUNT.format(pageCount) })
            : t("office.common.pagination.pageOpen", { page })}
        </span>
        {known && pageCount > 1 && (
          <PageJump page={page} pages={pageCount} busy={busy} onPage={onPage} />
        )}
        <Button
          variant="secondary"
          disabled={busy || page >= last}
          onClick={() => onPage(page + 1)}
        >
          {t("office.common.pagination.next")}
        </Button>
        {many && known && (
          <Button
            variant="secondary"
            aria-label={t("office.common.pagination.last")}
            title={t("office.common.pagination.last")}
            disabled={busy || page >= pageCount}
            onClick={() => onPage(pageCount)}
          >
            <span aria-hidden="true">»</span>
          </Button>
        )}
      </nav>
    </div>
  );
}
