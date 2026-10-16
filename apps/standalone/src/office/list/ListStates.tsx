import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button, EmptyState } from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import { OfficeIcon, type OfficeIconName } from "../OfficeIcon.js";

export interface ListEmptyProps {
  /** What the list is: the title says there are none yet («Товаров пока нет.»). */
  title: string;
  hint?: string;
  icon?: OfficeIconName;
  /** The first record's button, when the role may add one. */
  action?: ReactNode;
}

/** The list has no rows at all (nothing the filters could change). */
export function ListEmpty({ title, hint, icon = "list", action }: ListEmptyProps) {
  return (
    <div className="office-list-state" data-state="empty">
      <EmptyState
        icon={<OfficeIcon name={icon} size={32} />}
        title={title}
        {...(hint === undefined ? {} : { hint })}
        {...(action === undefined ? {} : { action })}
      />
    </div>
  );
}

export interface ListNothingProps {
  /** Why no row is shown: the text names the search and the filters, not the list. */
  title?: string;
  onReset?: () => void;
}

/** The filters hide every row: say so and offer to clear them. */
export function ListNothing({ title, onReset }: ListNothingProps) {
  const { t } = useTranslation();
  return (
    <div className="office-list-state" data-state="nothing">
      <EmptyState
        icon={<OfficeIcon name="search" size={32} />}
        title={title ?? t("office.common.listStates.nothingTitle")}
        hint={t("office.common.listStates.nothingHint")}
        {...(onReset === undefined
          ? {}
          : {
              action: (
                <Button
                  variant="secondary"
                  icon={<OfficeIcon name="reset" size={20} />}
                  onClick={onReset}
                >
                  {t("office.common.listStates.resetFilters")}
                </Button>
              ),
            })}
      />
    </div>
  );
}

/** Rows the list is waiting for: static grey bars (no shimmer), and the word for a screen reader. */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  const { t } = useTranslation();
  return (
    <div className="office-list-state office-list-state--loading" data-state="loading">
      <div className="office-skeleton" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="office-skeleton__row">
            <span className="office-skeleton__tile" />
            <span className="office-skeleton__lines">
              <span className="office-skeleton__bar" />
              <span className="office-skeleton__bar office-skeleton__bar--short" />
            </span>
            <span className="office-skeleton__bar office-skeleton__bar--pill" />
          </div>
        ))}
      </div>
      <div className="office-skeleton__word" role="status">
        <span className="office-skeleton__spin mk-spin" aria-hidden="true" />
        {t("office.common.loading")}
      </div>
    </div>
  );
}

export interface ListErrorProps {
  error: unknown;
  onRetry: () => void;
}

/** The read failed: the reason in the host's own words, and «Повторить». */
export function ListError({ error, onRetry }: ListErrorProps) {
  const { t } = useTranslation();
  return (
    <div className="office-list-state" data-state="error">
      <div className="office-list-error" role="alert">
        <OfficeIcon name="circleX" size={24} />
        <div className="office-list-error__text">
          <strong>{t("office.common.listStates.errorTitle")}</strong>
          <span>{t(errorMessageKey(error))}</span>
        </div>
        <Button variant="secondary" onClick={onRetry}>
          {t("office.common.retry")}
        </Button>
      </div>
    </div>
  );
}
