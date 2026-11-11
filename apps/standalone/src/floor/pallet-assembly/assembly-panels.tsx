import { useTranslation } from "react-i18next";

import { Button, type AlertTone } from "@markiro/ui";

import { Glyph } from "../kit/StatusIcons.js";
import { formatCivilDate, formatQuantity } from "../shifts/shift-text.js";
import type {
  PalletAssemblyBox,
  PalletAssemblyConflict,
  PalletAssemblyPallet,
} from "./contracts.js";

export interface AssemblyFeedback {
  title: string;
  detail?: string | null;
  sscc?: string | null;
  tone: AlertTone;
}

export function Feedback({ title, detail, sscc, tone }: AssemblyFeedback) {
  return (
    <div className="pallet-assembly__feedback" data-tone={tone}>
      <Glyph name={tone === "ok" ? "check" : tone === "info" ? "barcode" : "warning"} size={32} />
      <h3>{title}</h3>
      {sscc && <code>{sscc}</code>}
      {detail && <p>{detail}</p>}
    </div>
  );
}

function BoxSource({ box }: { box: PalletAssemblyBox }) {
  const { t } = useTranslation(undefined, { keyPrefix: "floor.palletAssembly" });
  if (box.shiftNumber !== null) return t("sourceShift", { number: box.shiftNumber });
  return box.productionDate === null
    ? null
    : t("sourceDate", { date: formatCivilDate(box.productionDate) });
}

interface BoxListProps {
  boxes: PalletAssemblyBox[];
  onRemove?: (box: PalletAssemblyBox) => void;
  busy?: boolean;
}

export function BoxList({ boxes, onRemove, busy }: BoxListProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "floor.palletAssembly" });
  return (
    <ul className="pallet-assembly__boxes">
      {boxes.map((box) => {
        const synced = box.syncState === "accepted";
        return (
          <li key={box.sscc}>
            <span className="pallet-assembly__box-identity">
              <code>{box.sscc}</code>
              <small>
                <BoxSource box={box} />
              </small>
            </span>
            <span className="pallet-assembly__badge" data-state={box.syncState}>
              <Glyph name={synced ? "check" : "upload"} size={18} />
              <span className={onRemove === undefined ? "pallet-assembly__sr-only" : undefined}>
                {t(synced ? "boxAccepted" : "boxPending")}
              </span>
            </span>
            {onRemove !== undefined && (
              <Button
                size="floor"
                variant="secondary"
                disabled={busy === true}
                onClick={() => onRemove(box)}
                aria-label={t("removeBox", { sscc: box.sscc })}
              >
                {t("remove")}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function PalletSummary({
  pallet,
  onContents,
  disabled,
}: {
  pallet: PalletAssemblyPallet | null;
  onContents?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "floor.palletAssembly" });
  const count = pallet?.boxes.length ?? 0;
  const capacity = pallet?.product.capacity ?? null;
  return (
    <aside className="pallet-assembly__surface pallet-assembly__summary" aria-label={t("current")}>
      <p>{t("current")}</p>
      {pallet !== null && <h3>{pallet.product.name}</h3>}
      <div className="pallet-assembly__count">
        <strong>{formatQuantity(count)}</strong>
        <span>
          {capacity === null ? t("boxNoun", { count }) : ` / ${t("boxCount", { count: capacity })}`}
        </span>
      </div>
      {capacity !== null && (
        <progress
          aria-label={t("capacity", { current: count, capacity })}
          value={Math.min(count, capacity)}
          max={capacity}
        />
      )}
      {count > 0 && pallet !== null && (
        <div className="pallet-assembly__recent">
          <h4>{t("recentBoxes")}</h4>
          <BoxList boxes={pallet.boxes.slice(-3).reverse()} />
        </div>
      )}
      {onContents !== undefined && count > 0 && (
        <Button size="floor" variant="secondary" disabled={disabled === true} onClick={onContents}>
          {t("contents", { count })}
        </Button>
      )}
    </aside>
  );
}

export function ClosedSummary({ pallet }: { pallet: PalletAssemblyPallet }) {
  const { t } = useTranslation(undefined, { keyPrefix: "floor.palletAssembly" });
  return (
    <aside className="pallet-assembly__surface pallet-assembly__summary">
      <p>{t("palletSscc")}</p>
      <code className="pallet-assembly__sscc">{pallet.sscc}</code>
      <h3>{pallet.product.name}</h3>
      <p>{t("boxCount", { count: pallet.label?.boxCount ?? pallet.boxes.length })}</p>
      <span className="pallet-assembly__badge" data-state={pallet.syncState}>
        {t(`sync_${pallet.syncState}`)}
      </span>
    </aside>
  );
}

export function ConflictList({
  conflicts,
  busy,
  onAbandon,
  onAcknowledge,
}: {
  conflicts: PalletAssemblyConflict[];
  busy: boolean;
  onAbandon: (palletId: string) => void;
  onAcknowledge: (palletId: string) => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "floor.palletAssembly" });
  const { t: all, i18n } = useTranslation();
  const groups = new Map<string, PalletAssemblyConflict[]>();
  for (const conflict of conflicts) {
    const group = groups.get(conflict.palletId);
    if (group === undefined) groups.set(conflict.palletId, [conflict]);
    else group.push(conflict);
  }
  return (
    <div className="pallet-assembly__surface pallet-assembly__long">
      {groups.size === 0 ? <p>{t("noConflicts")}</p> : <p>{t("conflictHelp")}</p>}
      {Array.from(groups, ([id, group]) => {
        const sscc = group.find((conflict) => conflict.palletSscc !== null)?.palletSscc;
        return (
          <article key={id} className="pallet-assembly__conflict">
            {sscc ? (
              <>
                <span>{t("palletSscc")}</span>
                <code>{sscc}</code>
              </>
            ) : (
              <p>{t("palletId", { id })}</p>
            )}
            <ul>
              {group.map((conflict) => {
                const key = `floor.queue.code.${conflict.code}`;
                const reason = i18n.exists(key)
                  ? all(key)
                  : all("floor.queue.code.other", { code: conflict.code });
                return (
                  <li key={`${conflict.boxSscc ?? "pallet"}-${conflict.code}`}>
                    {conflict.closeIssueId && (
                      <p>{t("closeIssue", { id: conflict.closeIssueId })}</p>
                    )}
                    {conflict.boxSscc && <p>{t("rejectedBox", { sscc: conflict.boxSscc })}</p>}
                    <p>{t("conflictReason", { reason })}</p>
                    {conflict.winningPalletSscc && (
                      <p>{t("winningPallet", { sscc: conflict.winningPalletSscc })}</p>
                    )}
                  </li>
                );
              })}
            </ul>
            {group.every((conflict) => conflict.acknowledged) ? (
              <p>{t("acknowledged")}</p>
            ) : (
              <Button
                size="floor"
                variant="secondary"
                disabled={busy}
                onClick={() => onAcknowledge(id)}
              >
                {t("acknowledge")}
              </Button>
            )}
            {group.some((conflict) => conflict.canAbandon) && (
              <Button
                size="floor"
                variant="secondary"
                disabled={busy}
                onClick={() => onAbandon(id)}
              >
                {t("abandon")}
              </Button>
            )}
          </article>
        );
      })}
    </div>
  );
}
