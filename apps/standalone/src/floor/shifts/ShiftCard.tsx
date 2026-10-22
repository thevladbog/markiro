import { useTranslation } from "react-i18next";

import { Badge, Button, Card, StatusChip, type TagPhase } from "@markiro/ui";

import { isDemoShiftNumber } from "../demo/demo-codes.js";
import { shiftProductTitle } from "../../lib/shift-product.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { LicenseRefusal } from "../license.js";
import { Glyph } from "../kit/StatusIcons.js";
import { ProductPanel } from "./ProductPhoto.js";
import type { ShiftCopy } from "./shift-copies.js";
import { activeOthers, type Participation } from "./shift-participation.js";
import { productMonogram } from "./product-accent.js";
import { shiftProgress } from "./hub-layout.js";
import { formatCivilDate, formatQuantity } from "./shift-text.js";

/**
 * The slots of a line that look all held by the other devices, by the cache (plan 2b): advisory.
 * The host's list names a revoked device's part `active`, but the host gives a revoked device no
 * slot (spec §12.5), and only its answer to an entry decides (PR #775).
 */
export interface LooksFull {
  active: number;
  maxStations: number;
}

/**
 * What the card offers: open a planned shift, continue this station's own part of an active one,
 * join one another device works (plan 2b), finish one the office closed after this station
 * entered it (plan 2a8; no host needed), or nothing — a part the host says is closed, a shift of
 * a host that names no participants (stage 2a's «занята»), one this station is closing.
 * `enabled` is false where the host is needed and away. `full`: by the cache every slot of the
 * line is held; the join (or the resume of a paused part) still asks the host, which decides,
 * and is never made without it (PR #775).
 */
export type CardAction =
  | { kind: "open"; enabled: boolean }
  | { kind: "continue"; enabled: boolean; full?: LooksFull }
  | { kind: "join"; enabled: boolean; full?: LooksFull }
  | { kind: "finish" }
  | { kind: "busy" }
  | { kind: "part_closed" }
  | { kind: "closing" }
  /** A planned shift the site's license does not let open (plan ЛЦ-3): words in place of «Открыть». */
  | { kind: "blocked"; refusal: LicenseRefusal };

/** «Линия занята: N из M» when the other devices hold every slot, by the cache; else `null`. */
function looksFull(participation: Participation, deviceId: string): LooksFull | null {
  const active = activeOthers(participation, deviceId).length;
  return active >= participation.maxStations
    ? { active, maxStations: participation.maxStations }
    : null;
}

/**
 * The action of `copy` on this station (`deviceId`) with the link `online` or not, and with what
 * the host's last read said of its participants (`participation`, plan 2b; `null`: none — a
 * planned shift, or a host that names none). Opening a planned shift needs the host (it freezes
 * the snapshot); continuing needs it only when this station keeps no snapshot; joining always
 * needs it (the host gives the slot and the snapshot). The license guards openings only (host D17).
 * The slots are counted from the cache, which cannot see a revoked device: a line that looks full
 * keeps its join online (the host's answer decides, `shift_line_full` with its numbers when it
 * refuses), and no entry is offered over it without the host (PR #775).
 */
export function cardAction(
  copy: ShiftCopy,
  deviceId: string,
  online: boolean,
  blocked: LicenseRefusal | null = null,
  participation: Participation | null = null,
): CardAction {
  if (copy.localState === "closing") return { kind: "closing" };
  if (copy.status === "closed") return { kind: "finish" };
  if (copy.status === "active") {
    const mine = participation?.myState ?? null;
    if (mine === "closed") return { kind: "part_closed" };
    const resumes = online || copy.entered;
    if (mine === "left") {
      // A paused part takes a slot again: over a line that looks full, only through the host.
      const full = participation === null ? null : looksFull(participation, deviceId);
      return full === null
        ? { kind: "continue", enabled: resumes }
        : { kind: "continue", enabled: online, full };
    }
    // Never closed by the license: the station's own shift goes on (spec §3.3).
    if (mine === "active" || copy.entered || copy.ownerDeviceId === deviceId) {
      return { kind: "continue", enabled: resumes };
    }
    if (participation === null) return { kind: "busy" };
    const full = looksFull(participation, deviceId);
    return full === null
      ? { kind: "join", enabled: online }
      : { kind: "join", enabled: online, full };
  }
  if (blocked !== null) return { kind: "blocked", refusal: blocked };
  return { kind: "open", enabled: online };
}

const PHASE: Record<"planned" | "active" | "closing" | "office_closed", TagPhase> = {
  planned: "planned",
  active: "active",
  closing: "running",
  // Closed in the office, to be finished here: the done tone, as the board draws it (✓).
  office_closed: "done",
};

export interface ShiftCardProps {
  copy: ShiftCopy;
  /** The host refused this station's close of the shift, with the refusal's code (plan 2a8). */
  refusal?: { code: string | null } | null;
  action: CardAction;
  /** Another entry runs, or this one: every card waits. */
  busy: boolean;
  onAction: () => void;
  /** The station's database, for the product's photo; without it the monogram stands. */
  local?: LocalExecutor;
  /**
   * The codes the progress row counts («Принято N из M»): this station's own, or the whole
   * shift's for a shift several devices work (plan 2b); `null` (the default): no count was read,
   * and the progress row is not drawn.
   */
  accepted?: number | null;
  /** This station's device id: the participants line names it «эта станция» (plan 2b). */
  deviceId?: string;
  /** What the host's last read said of the shift's participants (plan 2b); `null`: none. */
  participation?: Participation | null;
}

/**
 * One shift of the line, as the owner-approved «Смены линии» board draws it (2026-10, kit): the
 * left half is the product's panel the full height of the card: a cut-out photo (or one whose
 * kind is not known yet) or the monogram fitted whole on the kit's one brand gradient, a photo
 * with its own background filling the panel (owner, 2026-10-20), and the tags (mode, pallets) as
 * chips on it; on the right the status chip and the shift's
 * number, the product's print name, who it is for, the dates and the plan as label and value,
 * the progress where both counters exist locally, and the 84 px action pinned to the bottom.
 * What the standalone adds — a shift that needs the host, one the office closed, a close the
 * host refused, who else works a shared shift and a line whose slots look all held (plan 2b) — is
 * said in the free row above the action; a closed part has no action, a line that looks full
 * keeps its join (the host decides, PR #775).
 */
export function ShiftCard({
  copy,
  refusal = null,
  action,
  busy,
  onAction,
  local,
  accepted = null,
  deviceId = "",
  participation = null,
}: ShiftCardProps) {
  const { t } = useTranslation();
  const phase =
    copy.localState === "closing"
      ? "closing"
      : copy.status === "active"
        ? "active"
        : copy.status === "closed"
          ? "office_closed"
          : "planned";
  const title = shiftProductTitle({ name: copy.productName, printName: copy.productPrintName });
  const takesAction =
    action.kind === "open" || action.kind === "continue" || action.kind === "join";
  const enabled = action.kind === "finish" || (takesAction && action.enabled);
  const needsLink = takesAction && !action.enabled;
  const hasButton = action.kind !== "blocked" && action.kind !== "part_closed";
  const full = action.kind === "join" || action.kind === "continue" ? (action.full ?? null) : null;
  const progress = shiftProgress({
    plannedQty: copy.plannedQty,
    accepted,
    entered: copy.entered,
  });
  // Who works a shared shift now (plan 2b): said only when another device is among them, so a
  // station alone on its line sees its card as before.
  const working = participation?.participants.filter((row) => row.state === "active") ?? [];
  const participantsLine =
    participation === null || !working.some((row) => row.deviceId !== deviceId)
      ? null
      : t("floor.shifts.participants", {
          active: formatQuantity(working.length),
          max: formatQuantity(participation.maxStations),
          names: working
            .map((row) =>
              row.deviceId === deviceId
                ? t("floor.shifts.thisStation")
                : t("floor.shifts.participant", {
                    name: row.deviceName,
                    kind: t(`floor.shifts.deviceKind.${row.deviceKind}`),
                  }),
            )
            .join(", "),
        });
  return (
    <Card className="shift-card" padding={0} data-phase={phase}>
      <div className="shift-card__body">
        <ProductPanel
          local={local}
          productId={copy.productId}
          className="shift-card__photo"
          fallback={
            <span className="shift-card__photo-monogram" aria-hidden="true">
              {productMonogram(title)}
            </span>
          }
          overlay={
            <div className="shift-card__tags">
              <Badge
                className="shift-card__mode-badge"
                size="floor"
                tone={copy.mode === "aggregation" ? "violet" : "steel"}
              >
                {t(`floor.shifts.mode.${copy.mode}`)}
              </Badge>
              {copy.mode === "aggregation" && copy.palletsEnabled ? (
                <Badge className="shift-card__pallets" size="floor" tone="teal">
                  {t("floor.shifts.withPallets")}
                </Badge>
              ) : null}
            </div>
          }
        />
        <div className="shift-card__details">
          <div className="shift-card__heading">
            <StatusChip
              className="shift-card__status"
              size="floor"
              phase={PHASE[phase]}
              label={t(`floor.shifts.status.${phase}`)}
            />
            <span className="shift-card__number">{copy.number}</span>
            {isDemoShiftNumber(copy.number) && (
              <Badge size="floor" tone="magenta">
                {t("floor.demo.badge")}
              </Badge>
            )}
          </div>
          <div className="shift-card__product shift-card__product--only" title={title}>
            {title}
          </div>
          <div
            className="shift-card__counterparty"
            {...(copy.counterpartyName === null
              ? {}
              : { title: t("floor.shifts.counterparty", { name: copy.counterpartyName }) })}
          >
            {copy.counterpartyName === null
              ? null
              : t("floor.shifts.counterparty", { name: copy.counterpartyName })}
          </div>
          <dl className="shift-card__facts">
            <div className="shift-card__fact">
              <dt>{t("floor.shifts.fact.productionDate")}</dt>
              <dd>{formatCivilDate(copy.productionDate)}</dd>
            </div>
            {copy.plannedDate === null ? null : (
              <div className="shift-card__fact">
                <dt>{t("floor.shifts.fact.plannedDate")}</dt>
                <dd>{formatCivilDate(copy.plannedDate)}</dd>
              </div>
            )}
            <div className="shift-card__fact">
              <dt>{t("floor.shifts.fact.plan")}</dt>
              <dd className={copy.plannedQty === null ? "shift-card__plan--none" : undefined}>
                {copy.plannedQty === null
                  ? t("floor.shifts.fact.planNone")
                  : t("floor.shifts.fact.planValue", { quantity: formatQuantity(copy.plannedQty) })}
              </dd>
            </div>
          </dl>
          {progress === null ? null : (
            <div className="shift-card__progress">
              <div className="shift-card__progress-line">
                <span>{t("floor.shifts.progress.label")}</span>
                <span className="shift-card__progress-count">
                  {t("floor.shifts.progress.count", {
                    accepted: formatQuantity(progress.accepted),
                    planned: formatQuantity(progress.planned),
                  })}
                </span>
              </div>
              <div
                className="shift-card__progress-bar"
                role="progressbar"
                aria-label={t("floor.shifts.progress.label")}
                aria-valuemin={0}
                aria-valuemax={progress.planned}
                aria-valuenow={Math.min(progress.accepted, progress.planned)}
                aria-valuetext={t("floor.shifts.progress.count", {
                  accepted: formatQuantity(progress.accepted),
                  planned: formatQuantity(progress.planned),
                })}
              >
                <span style={{ width: `${(progress.ratio * 100).toFixed(1)}%` }} />
              </div>
            </div>
          )}
          <div className="shift-card__notes">
            {participantsLine !== null && (
              <p className="shift-card__participants" title={participantsLine}>
                {participantsLine}
              </p>
            )}
            {needsLink && <p className="shift-card__hint">{t("floor.shifts.needsLink")}</p>}
            {action.kind === "blocked" && (
              // In place of «Открыть» (spec §9.6): the host would refuse, and the operator is told why.
              <p className="shift-card__hint">{t(`floor.shifts.refused.${action.refusal}`)}</p>
            )}
            {full !== null && !needsLink && (
              // Advisory (PR #775): the host decides, `shift_line_full` with its numbers if it refuses.
              // Without the link the hint says what blocks the join instead; the participants line
              // still says «В смене N из M» (and a third note would squash it at 1024x640).
              <p className="shift-card__hint">
                {t("floor.shifts.lineFull", {
                  active: formatQuantity(full.active),
                  max: formatQuantity(full.maxStations),
                })}
              </p>
            )}
            {action.kind === "part_closed" && (
              <p className="shift-card__hint">{t("floor.shifts.partClosed")}</p>
            )}
            {action.kind === "finish" && (
              <p className="shift-card__hint">{t("floor.shifts.finishHint")}</p>
            )}
            {refusal !== null && (
              <p className="shift-card__hint">
                {t("floor.shifts.closeRefused", { code: refusal.code ?? "—" })}
              </p>
            )}
          </div>
          {hasButton && (
            <Button
              className="shift-card__action floor-primary"
              size="floor"
              fullWidth
              variant={
                action.kind === "continue" || action.kind === "join" ? "primary" : "secondary"
              }
              disabled={busy || !enabled}
              onClick={onAction}
              {...(action.kind === "continue" || action.kind === "join"
                ? { icon: <Glyph name="arrow-right" size={26} /> }
                : action.kind === "finish"
                  ? { icon: <Glyph name="check" size={26} /> }
                  : {})}
            >
              {t(`floor.shifts.action.${action.kind}`)}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
