import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

export interface OfficePagerProps {
  /** The navigation's accessible name: whose pages these are. */
  label: string;
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}

/**
 * A list's pages, in the office's words. The shared `@markiro/ui` `Pager` is
 * not used: its buttons are floor-sized and full width with no size prop, and
 * the office leaves `packages/*` alone (the cloud's own catalog page has a
 * compact pager too).
 */
export function OfficePager({ label, page, pageCount, onPage }: OfficePagerProps) {
  const { t } = useTranslation();
  return (
    <nav aria-label={label} className="office-pager">
      <Button
        variant="secondary"
        size="compact"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        {t("office.common.pager.previous")}
      </Button>
      <span aria-live="polite">{t("office.common.pager.page", { page, pages: pageCount })}</span>
      <Button
        variant="secondary"
        size="compact"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        {t("office.common.pager.next")}
      </Button>
    </nav>
  );
}
