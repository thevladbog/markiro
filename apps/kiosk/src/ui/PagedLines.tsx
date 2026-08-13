import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { clampPage, pageCount, pageItems } from "../session/pagination.js";

export interface PagedLinesProps<T> {
  items: readonly T[];
  pageSize: number;
  page: number;
  onPageChange: (page: number) => void;
  renderItem: (item: T) => React.ReactNode;
}

export function PagedLines<T>({
  items,
  pageSize,
  page,
  onPageChange,
  renderItem,
}: PagedLinesProps<T>): React.JSX.Element {
  const { t } = useTranslation();
  const boundedPage = clampPage(page, items.length, pageSize);
  const pages = pageCount(items.length, pageSize);

  useEffect(() => {
    if (boundedPage !== page) onPageChange(boundedPage);
  }, [boundedPage, onPageChange, page]);

  return (
    <div className="kiosk-paged-lines">
      <ul className="kiosk-paged-lines__list">
        {pageItems(items, boundedPage, pageSize).map((item, index) => (
          <li key={boundedPage * pageSize + index}>{renderItem(item)}</li>
        ))}
      </ul>
      <nav className="kiosk-pager" aria-label={t("cart.pagination")}>
        <button
          className="kiosk-control kiosk-pager__button"
          type="button"
          disabled={boundedPage === 0}
          onClick={() => onPageChange(boundedPage - 1)}
        >
          {t("cart.previous")}
        </button>
        <span className="kiosk-pager__count" aria-live="polite">
          {boundedPage + 1} / {pages}
        </span>
        <button
          className="kiosk-control kiosk-pager__button"
          type="button"
          disabled={boundedPage >= pages - 1}
          onClick={() => onPageChange(boundedPage + 1)}
        >
          {t("cart.next")}
        </button>
      </nav>
    </div>
  );
}
