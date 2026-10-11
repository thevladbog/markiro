import { useTranslation } from "react-i18next";

import { Badge, Button, Card, StatusChip, type TagPhase } from "@markiro/ui";

import type { ShiftCopy } from "./shift-copies.js";
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

/** One shift of the line (the cloud station's `ShiftCard` without the photo panel). */
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
  return (
    <Card className="shift-card">
      <div className="shift-card__heading">
        <span className="shift-card__number">{copy.number}</span>
        <StatusChip size="floor" phase={PHASE[phase]} label={t(`floor.shifts.status.${phase}`)} />
      </div>
      <p className="shift-card__product">{copy.productName}</p>
      <p>{t("floor.shifts.productionDate", { date: formatCivilDate(copy.productionDate) })}</p>
      <div className="shift-card__facts">
        <Badge size="floor">{t(`floor.shifts.mode.${copy.mode}`)}</Badge>
        <span>
          {copy.plannedQty === null
            ? t("floor.shifts.noPlan")
            : t("floor.shifts.plan", { quantity: formatQuantity(copy.plannedQty) })}
        </span>
      </div>
      {copy.counterpartyName !== null && (
        <p>{t("floor.shifts.counterparty", { name: copy.counterpartyName })}</p>
      )}
      <Button
        size="floor"
        fullWidth
        variant={action.kind === "continue" || action.kind === "finish" ? "primary" : "secondary"}
        disabled={busy || !enabled}
        onClick={onAction}
      >
        {t(`floor.shifts.action.${action.kind}`)}
      </Button>
      {needsLink && <p className="shift-card__hint">{t("floor.shifts.needsLink")}</p>}
      {action.kind === "finish" && (
        <p className="shift-card__hint">{t("floor.shifts.finishHint")}</p>
      )}
      {refusal !== null && (
        <p className="shift-card__hint">
          {t("floor.shifts.closeRefused", { code: refusal.code ?? "—" })}
        </p>
      )}
    </Card>
  );
}
