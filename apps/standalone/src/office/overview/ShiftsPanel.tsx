import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { StatusChip } from "@markiro/ui";

import { OfficeIcon } from "../OfficeIcon.js";
import { BlockError, PanelHead, Skel } from "./blocks.js";
import type { ShiftDayRow } from "./dashboard-model.js";
import type { BlockState } from "./use-overview-data.js";

const NUMBER = new Intl.NumberFormat("ru-RU");

export interface ShiftsPanelProps {
  state: BlockState;
  error: unknown;
  onRetry: () => void;
  today: ShiftDayRow;
  tomorrow: ShiftDayRow;
}

function DayRow({ label, row }: { label: string; row: ShiftDayRow }) {
  const { t } = useTranslation();
  const empty = row.active + row.planned + row.closed === 0;
  return (
    <li className="ov-days__row">
      <Link className="ov-days__link" to="/shifts">
        <span className="ov-days__label">{label}</span>
        <span className="ov-days__chips">
          {empty && <span className="ov-days__none">{t("office.overview.shifts.none")}</span>}
          {row.active > 0 && (
            <StatusChip
              phase="active"
              label={t("office.overview.shifts.active", { count: row.active })}
            />
          )}
          {row.planned > 0 && (
            <StatusChip
              phase="planned"
              label={t("office.overview.shifts.planned", { count: row.planned })}
            />
          )}
          {row.closed > 0 && (
            <StatusChip
              phase="done"
              label={t("office.overview.shifts.closed", { count: row.closed })}
            />
          )}
          {row.planSum !== null && (
            <span className="ov-days__plan">
              {t("office.overview.shifts.plan", { planned: NUMBER.format(row.planSum) })}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

/** «Смены»: today's and tomorrow's by phase. Counts, not bars: the shifts have no planned times yet. */
export function ShiftsPanel({ state, error, onRetry, today, tomorrow }: ShiftsPanelProps) {
  const { t } = useTranslation();
  const title = t("office.overview.shifts.title");
  const icon = <OfficeIcon name="calendarCheck" size={20} />;
  if (state === "error") {
    return (
      <section className="ov-panel ov-days" aria-label={title}>
        <PanelHead icon={icon} title={title} />
        <BlockError
          title={t("office.overview.shifts.errorTitle")}
          error={error}
          onRetry={onRetry}
        />
      </section>
    );
  }
  return (
    <section className="ov-panel ov-days" aria-label={title} aria-busy={state === "loading"}>
      <PanelHead icon={icon} title={title}>
        <Link className="ov-panel__link" to="/shifts">
          {t("office.overview.shifts.all")}
          <OfficeIcon name="arrowRight" size={16} />
        </Link>
      </PanelHead>
      {state === "loading" ? (
        <ul className="ov-days__list" aria-hidden="true">
          {[0, 1].map((index) => (
            <li className="ov-days__row" key={index}>
              <Skel className="ov-skel--line" />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="ov-days__list">
          <DayRow label={t("office.overview.shifts.today")} row={today} />
          <DayRow label={t("office.overview.shifts.tomorrow")} row={tomorrow} />
        </ul>
      )}
    </section>
  );
}
