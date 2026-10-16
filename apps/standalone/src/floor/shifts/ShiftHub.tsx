import { useId, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import type { LocalExecutor } from "../../local/executor.js";
import { Glyph } from "../kit/StatusIcons.js";
import type { LicenseRefusal } from "../license.js";
import { FloorFooter, FloorScreen } from "./FloorScreen.js";
import { hubLayout, hubPage, type QueueBadge } from "./hub-layout.js";
import type { ShiftCopy } from "./shift-copies.js";
import { cardAction, ShiftCard } from "./ShiftCard.js";
import { ShiftPager } from "./ShiftPager.js";

/** What the hub has read of the station's shifts. */
export type HubCopies =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      copies: ShiftCopy[];
      refused: Map<string, string | null>;
      /** The codes this station holds in the shifts that have a plan (the progress rows). */
      accepted: Map<string, number>;
    };

export interface ShiftHubViewProps {
  local?: LocalExecutor;
  copies: HubCopies;
  deviceId: string;
  online: boolean;
  /** The license refuses new shifts (plan ЛЦ-3) with this reason; `null` — none. */
  blocked: LicenseRefusal | null;
  /** One entry runs: every card and button waits. */
  busy: boolean;
  /** No list has come from the host since the app started. */
  notRead: boolean;
  /** The page asked for (one-based); it is clamped to the list. */
  requestedPage: number;
  onPageChange: (page: number) => void;
  /** The polite region's messages (a refusal, the state of the link, an entry running). */
  messages: ReactNode;
  /** The queue button's count; `null` before the outbox was read. */
  badge: QueueBadge | null;
  titleRef?: Ref<HTMLHeadingElement>;
  onChoose: (copy: ShiftCopy) => void;
  onRetry: () => void;
  onNew: () => void;
  onSetup?: () => void;
  onWarehouse?: () => void;
  onQueue?: () => void;
}

/**
 * The hub («Смены линии») as the owner-approved board draws it: the title with its count, the
 * pager and the reprint in the title row, the message banner, the cards filling the zone (one
 * wide card, two columns, or pages of two), and the 84 px footer. Presentation only: the list
 * (`ShiftList`) reads the data and runs the entry; the layout harness feeds this with fixtures.
 */
export function ShiftHubView({
  local,
  copies,
  deviceId,
  online,
  blocked,
  busy,
  notRead,
  requestedPage,
  onPageChange,
  messages,
  badge,
  titleRef,
  onChoose,
  onRetry,
  onNew,
  onSetup,
  onWarehouse,
  onQueue,
}: ShiftHubViewProps) {
  const { t } = useTranslation();
  const queueBadgeId = useId();
  const cards = copies.kind === "ready" ? copies.copies : [];
  const layout = hubLayout(cards.length);
  // The page is clamped where it is read: a list that got shorter shows its last page.
  const { page, from, to } = hubPage(cards.length, requestedPage);
  const shown = cards.slice(from, to);
  const body = () => {
    if (copies.kind === "loading") {
      return <p className="shift-selection__state">{t("floor.shifts.loading")}</p>;
    }
    if (copies.kind === "failed") {
      return (
        <div className="shift-selection__state">
          <Alert
            tone="error"
            action={
              <Button size="floor" variant="secondary" onClick={onRetry}>
                {t("floor.shifts.retry")}
              </Button>
            }
          >
            {t("floor.shifts.readFailed")}
          </Alert>
        </div>
      );
    }
    if (copies.copies.length === 0) {
      // Static by design, as on the cloud station: a quiet mark, never a control.
      return (
        <div className="shift-selection__state shift-selection__state--empty">
          <span className="shift-selection__empty-mark" aria-hidden="true">
            <Glyph name="clipboard" size={72} />
          </span>
          {notRead ? (
            <p className="shift-selection__empty-title">{t("floor.shifts.notRead")}</p>
          ) : (
            <>
              <p className="shift-selection__empty-title">{t("floor.shifts.emptyTitle")}</p>
              <p className="shift-selection__empty-hint">{t("floor.shifts.emptyHint")}</p>
            </>
          )}
        </div>
      );
    }
    return (
      <div className="shift-selection__grid" data-columns={layout.columns}>
        {shown.map((copy) => (
          <ShiftCard
            key={copy.id}
            copy={copy}
            local={local}
            accepted={copies.accepted.get(copy.id) ?? null}
            refusal={
              copies.refused.has(copy.id) && copy.localState === "closing"
                ? { code: copies.refused.get(copy.id) ?? null }
                : null
            }
            action={cardAction(copy, deviceId, online, blocked)}
            busy={busy}
            onAction={() => onChoose(copy)}
          />
        ))}
      </div>
    );
  };
  // Always present, so that the title does not move (and drop its focus) when the list arrives.
  const subtitle =
    copies.kind !== "ready"
      ? ""
      : (() => {
          const count = copies.copies.length;
          const base =
            count === 0 ? t("floor.shifts.subtitleNone") : t("floor.shifts.subtitle", { count });
          const paged =
            layout.pageCount > 1
              ? t("floor.shifts.subtitlePage", {
                  subtitle: base,
                  page,
                  pageCount: layout.pageCount,
                })
              : base;
          return online ? paged : t("floor.shifts.subtitleStale", { subtitle: paged });
        })();

  return (
    <FloorScreen
      className="shift-hub"
      title={t("floor.shifts.title")}
      subtitle={subtitle}
      {...(titleRef === undefined ? {} : { titleRef })}
      header={
        <div className="shift-selection__header-actions">
          {layout.pageCount > 1 && (
            <ShiftPager page={page} pageCount={layout.pageCount} onPageChange={onPageChange} />
          )}
          {onWarehouse !== undefined && (
            <div className="shift-selection__header-action">
              <Button
                size="floor"
                variant="secondary"
                disabled={busy}
                onClick={onWarehouse}
                icon={<Glyph name="printer" size={24} />}
              >
                {t("floor.warehouse.open")}
              </Button>
            </div>
          )}
        </div>
      }
      actions={
        <FloorFooter ariaLabel={t("floor.shifts.actions")}>
          <div className="shift-hub__primary">
            {blocked === null && (
              <Button
                size="floor"
                className="floor-primary"
                disabled={busy || !online}
                onClick={onNew}
                icon={<Glyph name="plus" size={26} />}
              >
                {t("floor.shifts.new")}
              </Button>
            )}
            {blocked !== null && (
              // In place of «Новая смена» (spec §9.6), from the license the station last heard.
              <p className="shift-hub__hint">{t(`floor.shifts.refused.${blocked}`)}</p>
            )}
            {blocked === null && !online && (
              <p className="shift-hub__hint">{t("floor.shifts.newNeedsLink")}</p>
            )}
          </div>
          <div className="shift-selection__secondary-actions">
            {onSetup !== undefined && (
              <Button
                size="floor"
                variant="secondary"
                disabled={busy}
                onClick={onSetup}
                icon={<Glyph name="gear" size={26} />}
              >
                {t("floor.shifts.setup")}
              </Button>
            )}
            {onQueue !== undefined && (
              <Button
                size="floor"
                variant="secondary"
                disabled={busy}
                onClick={onQueue}
                aria-label={t("floor.shifts.queue")}
                aria-describedby={badge === null ? undefined : queueBadgeId}
                icon={<Glyph name="upload" size={26} />}
              >
                {t("floor.shifts.queue")}
                {badge !== null && (
                  <span
                    id={queueBadgeId}
                    className="shift-hub__queue-badge"
                    data-tone={badge.tone}
                    data-kind={badge.kind}
                  >
                    {badge.kind === "none" && <Glyph name="check" size={18} />}
                    {badge.kind === "none"
                      ? t("floor.shifts.queueBadge.none")
                      : badge.kind === "waiting"
                        ? t("floor.shifts.queueBadge.waiting", { count: badge.n })
                        : t("floor.shifts.queueBadge.rejected", { count: badge.n })}
                  </span>
                )}
              </Button>
            )}
          </div>
        </FloorFooter>
      }
    >
      <div className="shift-selection__content">
        <div className="shift-selection__message" aria-live="polite">
          {messages}
        </div>
        <div className="shift-selection__slot">{body()}</div>
      </div>
    </FloorScreen>
  );
}
