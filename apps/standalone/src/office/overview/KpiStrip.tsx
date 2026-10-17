import { useTranslation } from "react-i18next";

import type { OfficeIconName } from "../OfficeIcon.js";
import { BlockError, Skel } from "./blocks.js";
import type { BlockState } from "./use-overview-data.js";
import type { DayFigures } from "./dashboard-model.js";
import { Glyph, type OverviewIconName } from "./OverviewIcon.js";

const NUMBER = new Intl.NumberFormat("ru-RU");

export interface KpiStripProps {
  state: BlockState;
  error: unknown;
  onRetry: () => void;
  today: DayFigures;
  yesterday: DayFigures;
  /** The unreviewed conflicts: the strip's fourth figure, which reads its own query. */
  conflicts: { state: BlockState; total: number };
  /** The wall time of the data when the link is down: the figures are then «на 13:41». */
  staleAt: string | null;
  /** A site with nothing yet: dashes and «нет данных». */
  empty: boolean;
}

interface Tile {
  id: string;
  icon: OfficeIconName | OverviewIconName;
  label: string;
  value: string;
  zero: boolean;
  hint: { icon: "history" | "clock" | "hourglass" | "minus"; text: string; tone: "muted" | "warn" };
}

/**
 * The four figures of the day under the page header: units accepted, boxes, pallets (by the
 * shifts' own date, the organization's day) and the conflicts waiting for a review. Phase 1
 * compares with the whole of yesterday as text («Вчера: …»): no delta is drawn, because «at the
 * same time yesterday» needs the scans' times, which the host does not give the office yet.
 */
export function KpiStrip({
  state,
  error,
  onRetry,
  today,
  yesterday,
  conflicts,
  staleAt,
  empty,
}: KpiStripProps) {
  const { t } = useTranslation();
  const label = t("office.overview.kpi.label");
  if (state === "error") {
    return (
      <div className="ov-kpi ov-kpi--state">
        <BlockError title={t("office.overview.kpi.errorTitle")} error={error} onRetry={onRetry} />
      </div>
    );
  }
  const loading = state === "loading";
  const figureHint = (value: number): Tile["hint"] =>
    empty
      ? { icon: "minus", text: t("office.overview.kpi.noData"), tone: "muted" }
      : staleAt !== null
        ? { icon: "clock", text: t("office.overview.kpi.atTime", { time: staleAt }), tone: "warn" }
        : {
            icon: "history",
            text: t("office.overview.kpi.yesterday", { value: NUMBER.format(value) }),
            tone: "muted",
          };
  const figure = (value: number) => (empty ? "—" : NUMBER.format(value));
  const conflictHint = (): Tile["hint"] => {
    if (conflicts.state === "error") {
      return { icon: "minus", text: t("office.overview.kpi.unavailable"), tone: "warn" };
    }
    if (staleAt !== null) {
      return {
        icon: "clock",
        text: t("office.overview.kpi.atTime", { time: staleAt }),
        tone: "warn",
      };
    }
    return conflicts.total > 0
      ? { icon: "hourglass", text: t("office.overview.kpi.conflictsWaiting"), tone: "warn" }
      : { icon: "minus", text: t("office.overview.kpi.conflictsNone"), tone: "muted" };
  };
  const tiles: Tile[] = [
    {
      id: "units",
      icon: "scan",
      label: t("office.overview.kpi.units"),
      value: figure(today.units),
      zero: empty || today.units === 0,
      hint: figureHint(yesterday.units),
    },
    {
      id: "boxes",
      icon: "package",
      label: t("office.overview.kpi.boxes"),
      value: figure(today.boxes),
      zero: empty || today.boxes === 0,
      hint: figureHint(yesterday.boxes),
    },
    {
      id: "pallets",
      icon: "layers",
      label: t("office.overview.kpi.pallets"),
      value: figure(today.pallets),
      zero: empty || today.pallets === 0,
      hint: figureHint(yesterday.pallets),
    },
    {
      id: "conflicts",
      icon: "warning",
      label: t("office.overview.kpi.conflicts"),
      value: conflicts.state === "ready" && !empty ? NUMBER.format(conflicts.total) : "—",
      zero: conflicts.state !== "ready" || empty || conflicts.total === 0,
      hint: empty
        ? { icon: "minus", text: t("office.overview.kpi.noData"), tone: "muted" }
        : conflictHint(),
    },
  ];
  return (
    <dl className="ov-kpi" role="group" aria-label={label} aria-busy={loading} aria-live="off">
      {tiles.map((tile) => (
        <div className="ov-kpi__tile" key={tile.id} data-kpi={tile.id}>
          <dt className="ov-kpi__label">
            <Glyph name={tile.icon} />
            <span>{tile.label}</span>
          </dt>
          <dd className="ov-kpi__body">
            {loading ? (
              <>
                <Skel className="ov-skel--value" />
                <Skel className="ov-skel--line" />
              </>
            ) : (
              <>
                <span className={tile.zero ? "ov-kpi__value ov-kpi__value--zero" : "ov-kpi__value"}>
                  {tile.value}
                </span>
                <span className={`ov-kpi__hint ov-kpi__hint--${tile.hint.tone}`}>
                  <Glyph name={tile.hint.icon} size={14} />
                  <span>{tile.hint.text}</span>
                </span>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
