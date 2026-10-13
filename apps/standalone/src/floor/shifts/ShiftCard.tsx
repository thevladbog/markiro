import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Badge, Button, Card, StatusChip, type TagPhase } from "@markiro/ui";

import type { ShiftCopy } from "./shift-copies.js";
import { hueFromGtin, productMonogram } from "./product-accent.js";
import { formatCivilDate, formatQuantity } from "./shift-text.js";

/**
 * What the card offers: open a planned shift, continue the active one this
 * station opened, finish one the office closed after this station entered it
 * (plan 2a8; no host needed), or nothing for a shift another station opened
 * or one this station is closing. `enabled` is false where the host is
 * needed and away.
 */
export type CardAction =
  | { kind: "open"; enabled: boolean }
  | { kind: "continue"; enabled: boolean }
  | { kind: "finish" }
  | { kind: "busy" }
  | { kind: "closing" };

/**
 * The action of `copy` on this station (`deviceId`) with the link `online`
 * or not: opening a planned shift needs the host (it freezes the snapshot);
 * continuing an active shift of this station needs it only when this
 * station keeps no snapshot of it (a database lost since the entry).
 */
export function cardAction(copy: ShiftCopy, deviceId: string, online: boolean): CardAction {
  if (copy.localState === "closing") return { kind: "closing" };
  if (copy.status === "closed") return { kind: "finish" };
  if (copy.status === "active") {
    if (copy.ownerDeviceId !== deviceId) return { kind: "busy" };
    return { kind: "continue", enabled: online || copy.entered };
  }
  return { kind: "open", enabled: online };
}

const PHASE: Record<"planned" | "active" | "closing" | "office_closed", TagPhase> = {
  planned: "planned",
  active: "active",
  closing: "running",
  office_closed: "attention",
};

export interface ShiftCardProps {
  copy: ShiftCopy;
  /** The host refused this station's close of the shift, with the refusal's code (plan 2a8). */
  refusal?: { code: string | null } | null;
  action: CardAction;
  /** Another entry runs, or this one: every card waits. */
  busy: boolean;
  onAction: () => void;
}

/**
 * One shift of the line, laid out as the cloud station's `ShiftCard`
 * (apps/station/src/ui/ShiftCard.tsx, redesign 2026-09-20, PR #615/#619):
 * the product's panel on its GTIN-derived gradient with the monogram (the
 * standalone keeps no product photos), then the number and the status, the
 * product, the date, the mode and plan as facts, the counterparty, and the
 * 72 px action pinned to the card's last row. What the standalone adds — a
 * shift that needs the host, one the office closed, a close the host
 * refused — is said in the free row above the action.
 */
export function ShiftCard({ copy, refusal = null, action, busy, onAction }: ShiftCardProps) {
  const { t } = useTranslation();
  const phase =
    copy.localState === "closing"
      ? "closing"
      : copy.status === "active"
        ? "active"
        : copy.status === "closed"
          ? "office_closed"
          : "planned";
  const enabled =
    action.kind === "finish" ||
    ((action.kind === "open" || action.kind === "continue") && action.enabled);
  const needsLink = (action.kind === "open" || action.kind === "continue") && !action.enabled;
  const photoStyle = { "--product-hue": String(hueFromGtin(copy.productGtin14)) } as CSSProperties;
  return (
    <Card className="shift-card" padding="var(--sp-1)">
      <div className="shift-card__body">
        <div className="shift-card__photo" data-accent="true" style={photoStyle}>
          <span className="shift-card__photo-monogram" aria-hidden="true">
            {productMonogram(copy.productName)}
          </span>
        </div>
        <div className="shift-card__details">
          <div className="shift-card__heading">
            <span className="shift-card__number">{copy.number}</span>
            <StatusChip
              className="shift-card__status"
              size="office"
              phase={PHASE[phase]}
              label={t(`floor.shifts.status.${phase}`)}
            />
          </div>
          <div className="shift-card__product shift-card__product--only">{copy.productName}</div>
          <div className="shift-card__dates">
            <span className="shift-card__date-part">
              {t("floor.shifts.productionDate", { date: formatCivilDate(copy.productionDate) })}
            </span>
          </div>
          <div className="shift-card__mode">
            <Badge className="shift-card__mode-badge" size="office">
              {t(`floor.shifts.mode.${copy.mode}`)}
            </Badge>
            {copy.mode === "aggregation" && copy.palletsEnabled ? (
              <Badge className="shift-card__pallets" size="office">
                {t("floor.shifts.withPallets")}
              </Badge>
            ) : null}
            <span className="shift-card__plan">
              {copy.plannedQty === null
                ? t("floor.shifts.noPlan")
                : t("floor.shifts.plan", { quantity: formatQuantity(copy.plannedQty) })}
            </span>
          </div>
          <div className="shift-card__counterparty">
            {copy.counterpartyName === null
              ? null
              : t("floor.shifts.counterparty", { name: copy.counterpartyName })}
          </div>
          <div className="shift-card__notes">
            {needsLink && <p className="shift-card__hint">{t("floor.shifts.needsLink")}</p>}
            {action.kind === "finish" && (
              <p className="shift-card__hint">{t("floor.shifts.finishHint")}</p>
            )}
            {refusal !== null && (
              <p className="shift-card__hint">
                {t("floor.shifts.closeRefused", { code: refusal.code ?? "—" })}
              </p>
            )}
          </div>
          <Button
            className="shift-card__action"
            size="floor"
            fullWidth
            variant={
              action.kind === "continue" || action.kind === "finish" ? "primary" : "secondary"
            }
            disabled={busy || !enabled}
            onClick={onAction}
          >
            {t(`floor.shifts.action.${action.kind}`)}
          </Button>
        </div>
      </div>
    </Card>
  );
}
