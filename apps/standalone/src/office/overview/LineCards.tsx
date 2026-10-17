import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { Button, StatusChip, type TagPhase } from "@markiro/ui";

import type { OfficeProduct } from "../../host/protocol.js";
import { formatWhen } from "../backups/backup-format.js";
import { BlockError, Skel } from "./blocks.js";
import type { LineCard } from "./dashboard-model.js";
import { relateToToday, zoneClock } from "./overview-time.js";
import { Glyph } from "./OverviewIcon.js";
import { shiftProductTitle } from "../../lib/shift-product.js";
import type { BlockState } from "./use-overview-data.js";
import { OfficeIcon } from "../OfficeIcon.js";

const NUMBER = new Intl.NumberFormat("ru-RU");

const PHASE: Record<LineCard["status"], TagPhase> = {
  running: "active",
  idle: "attention",
  none: "none",
};

export interface LineCardsProps {
  state: BlockState;
  error: unknown;
  onRetry: () => void;
  cards: readonly LineCard[];
  hidden: number;
  products: readonly OfficeProduct[];
  zone: string | null;
  /** The organization's civil today, for «закрыта сегодня в 11:37». */
  today: string;
  /** A site with no line yet: «Линий пока нет» and the way to add one. */
  empty: boolean;
  /** Seats for the skeleton while the lines load. */
  skeletons?: number;
}

function CardView({
  card,
  products,
  zone,
  today,
}: {
  card: LineCard;
  products: readonly OfficeProduct[];
  zone: string | null;
  today: string;
}) {
  const { t } = useTranslation();
  const closedWhen = (instant: string): string => {
    const relation = relateToToday(new Date(instant), zone, today);
    return relation.day === "other"
      ? formatWhen(instant, zone)
      : t(`office.overview.lines.${relation.day}At`, { time: relation.hm });
  };
  const { shift } = card;
  const status = (
    <StatusChip
      phase={PHASE[card.status]}
      label={t(`office.overview.lines.status.${card.status}`)}
    />
  );
  if (shift === null) {
    const planned = card.nextPlanned;
    const plannedProduct =
      planned === null
        ? null
        : shiftProductTitle(products.find((product) => product.id === planned.productId)) || null;
    const details =
      planned === null
        ? null
        : [
            planned.number,
            plannedProduct,
            planned.plannedQty === null ? null : NUMBER.format(planned.plannedQty),
          ]
            .filter((part): part is string => part !== null)
            .join(" · ");
    return (
      <article className="ov-line" aria-label={card.line.name}>
        <header className="ov-line__head">
          <h3 className="ov-line__name">{card.line.name}</h3>
          {status}
        </header>
        <p className="ov-line__strong">{t("office.overview.lines.noShift")}</p>
        {card.lastClosed !== null && card.lastClosed.closedAt !== null && (
          <p className="ov-line__note">
            {t("office.overview.lines.lastClosed", {
              number: card.lastClosed.number,
              when: closedWhen(card.lastClosed.closedAt),
            })}
          </p>
        )}
        {details !== null && (
          <p className="ov-line__note">{t("office.overview.lines.planned", { details })}</p>
        )}
        <Link className="ov-line__link" to="/shifts">
          {t("office.overview.lines.link")}
          <OfficeIcon name="arrowRight" size={16} />
        </Link>
      </article>
    );
  }
  const idle = card.status === "idle";
  return (
    <article className="ov-line" aria-label={card.line.name}>
      <header className="ov-line__head">
        <h3 className="ov-line__name">{card.line.name}</h3>
        {status}
      </header>
      <Link className="ov-line__number" to={`/shifts?shift=${encodeURIComponent(shift.id)}`}>
        {shift.number}
      </Link>
      {card.productTitle !== null && <p className="ov-line__product">{card.productTitle}</p>}
      {card.percent === null ? (
        <p className="ov-line__figures">
          {t("office.overview.lines.progressNoPlan", { done: NUMBER.format(card.done) })}
        </p>
      ) : (
        <>
          <p className="ov-line__figures">
            {t("office.overview.lines.progress", {
              done: NUMBER.format(card.done),
              planned: NUMBER.format(card.planned ?? 0),
              percent: card.percent,
            })}
          </p>
          <span
            className={idle ? "ov-bar ov-bar--idle" : "ov-bar"}
            role="progressbar"
            aria-label={t("office.overview.lines.progressLabel", { number: shift.number })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={card.percent}
          >
            <span className="ov-bar__fill" style={{ width: `${card.percent}%` }} />
          </span>
        </>
      )}
      {idle ? (
        <p className="ov-line__idle">
          <Glyph name="timer" size={16} />
          <span>
            {t("office.overview.lines.noScans", {
              duration: t(`office.overview.duration.minutes`, { count: card.idleMinutes ?? 0 }),
            })}
          </span>
        </p>
      ) : (
        (card.paceHourly !== null || card.etaAt !== null) && (
          <p className="ov-line__pace">
            {card.paceHourly !== null && (
              <span>
                <Glyph name="gauge" size={16} />
                {t("office.overview.lines.pace", { pace: NUMBER.format(card.paceHourly) })}
              </span>
            )}
            {card.etaAt !== null && (
              <span>
                <Glyph name="flag" size={16} />
                {t("office.overview.lines.eta", { time: zoneClock(new Date(card.etaAt), zone).hm })}
              </span>
            )}
          </p>
        )
      )}
    </article>
  );
}

/** The lines as cards: status, shift, product, progress against the plan, pace and the expected end. */
export function LineCards({
  state,
  error,
  onRetry,
  cards,
  hidden,
  products,
  zone,
  today,
  empty,
  skeletons = 3,
}: LineCardsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const title = t("office.overview.lines.title");
  if (state === "error") {
    return (
      <section className="ov-lines ov-lines--state" aria-label={title}>
        <BlockError title={t("office.overview.lines.errorTitle")} error={error} onRetry={onRetry} />
      </section>
    );
  }
  if (state === "loading") {
    return (
      <section className="ov-lines" aria-label={title} aria-busy="true">
        {Array.from({ length: skeletons }, (_, index) => (
          <div className="ov-line" key={index} aria-hidden="true">
            <Skel className="ov-skel--title" />
            <Skel className="ov-skel--line" />
            <Skel className="ov-skel--line" />
            <Skel className="ov-skel--line" />
          </div>
        ))}
      </section>
    );
  }
  if (empty) {
    return (
      <section className="ov-lines ov-lines--state" aria-label={title}>
        <div className="ov-empty">
          <Glyph name="chart" size={28} />
          <div className="ov-empty__text">
            <strong>{t("office.overview.lines.emptyTitle")}</strong>
            <span>{t("office.overview.lines.emptyHint")}</span>
          </div>
          <Button icon={<OfficeIcon name="plus" />} onClick={() => void navigate("/lines")}>
            {t("office.overview.lines.addLine")}
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className="ov-lines" aria-label={title}>
      {cards.map((card) => (
        <CardView key={card.line.id} card={card} products={products} zone={zone} today={today} />
      ))}
      {hidden > 0 && (
        <Link
          className="ov-line ov-line--more"
          to="/lines"
          title={t("office.overview.lines.moreHint")}
        >
          <strong>{t("office.overview.lines.moreLink", { count: hidden })}</strong>
          <span className="ov-line__link">
            {t("office.overview.lines.title")}
            <OfficeIcon name="arrowRight" size={16} />
          </span>
        </Link>
      )}
    </section>
  );
}
