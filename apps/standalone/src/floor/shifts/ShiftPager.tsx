import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

import { Glyph } from "../kit/StatusIcons.js";

export interface ShiftPagerProps {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}

/**
 * «‹ Назад  1 / 2  Далее ›» in the hub's title row (the owner-approved board): two 64 px
 * buttons and the page between them. The page is said in full to a screen reader
 * («Страница 1 из 2»), politely, when it changes.
 */
export function ShiftPager({ page, pageCount, onPageChange }: ShiftPagerProps) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("floor.shifts.pagination")} className="shift-pager">
      <Button
        size="floor"
        variant="secondary"
        title={t("floor.shifts.previousPage")}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        icon={<Glyph name="chevron-left" size={24} />}
      >
        {t("floor.shifts.pager.previous")}
      </Button>
      <span className="shift-pager__page" aria-live="polite">
        <span aria-hidden="true">{t("floor.shifts.pager.of", { page, pageCount })}</span>
        <span className="station-visually-hidden">
          {t("floor.shifts.page", { page, pageCount })}
        </span>
      </span>
      <Button
        size="floor"
        variant="secondary"
        title={t("floor.shifts.nextPage")}
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
        icon={<Glyph name="chevron-right" size={24} />}
      >
        {t("floor.shifts.pager.next")}
      </Button>
    </nav>
  );
}
