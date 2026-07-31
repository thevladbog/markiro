import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Input } from "@markiro/ui";
import type { ClosedBoxSummary } from "../lib/boxes.js";

export interface ShiftBoxesPanelProps {
  boxes: ClosedBoxSummary[];
  onReprint: (boxId: string, reason: string) => void;
  onDisassemble: (boxId: string, reason: string) => void;
  onPendingChange?: (pending: boolean) => void;
}

type PendingAction = { boxId: string; kind: "reprint" | "disassemble" };

/** Actions for closed boxes produced by this terminal during the current shift. */
export function ShiftBoxesPanel({
  boxes,
  onReprint,
  onDisassemble,
  onPendingChange,
}: ShiftBoxesPanelProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const trimmedReason = reason.trim();

  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);

  function startAction(boxId: string, kind: PendingAction["kind"]): void {
    setPending({ boxId, kind });
    setReason("");
    onPendingChange?.(true);
  }

  function confirm(): void {
    if (!pending || !trimmedReason) return;
    if (pending.kind === "reprint") onReprint(pending.boxId, trimmedReason);
    else onDisassemble(pending.boxId, trimmedReason);
    setPending(null);
    setReason("");
    onPendingChange?.(false);
  }

  return (
    <section aria-labelledby="closed-boxes-title" style={{ display: "grid", gap: 12 }}>
      <h2 id="closed-boxes-title" style={{ margin: 0, fontSize: "1.25rem" }}>
        {t("box.closedTitle")}
      </h2>
      {boxes.length === 0 ? (
        <p style={{ margin: 0, opacity: 0.7 }}>{t("box.closedEmpty")}</p>
      ) : (
        <ul style={{ display: "grid", gap: 8, margin: 0, padding: 0, listStyle: "none" }}>
          {boxes.map((box) => (
            <li
              key={box.boxId}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                paddingBlock: 10,
                borderBottom: "1px solid var(--line-subtle)",
              }}
            >
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                SSCC {box.sscc}
              </span>
              <span>{t("box.closedItems", { count: box.itemCount })}</span>
              <Button
                type="button"
                variant="secondary"
                style={{ minHeight: 64, marginInlineStart: "auto" }}
                onClick={() => startAction(box.boxId, "reprint")}
              >
                {t("box.reprint")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                style={{ minHeight: 64 }}
                onClick={() => startAction(box.boxId, "disassemble")}
              >
                {t("box.disassemble")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {pending ? (
        <Alert
          tone={pending.kind === "disassemble" ? "warn" : "info"}
          title={
            pending.kind === "disassemble"
              ? t("box.disassembleConfirmTitle")
              : t("box.reprintConfirmTitle")
          }
        >
          {pending.kind === "disassemble" ? <p>{t("box.disassembleConfirmDetail")}</p> : null}
          <div style={{ display: "grid", gap: 12 }}>
            <Input
              label={t("box.reason")}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              autoFocus
            />
            <div style={{ display: "flex", gap: 12 }}>
              <Button
                type="button"
                style={{ minHeight: 64 }}
                disabled={!trimmedReason}
                onClick={confirm}
              >
                {t("box.confirmAction")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                style={{ minHeight: 64 }}
                onClick={() => {
                  setPending(null);
                  onPendingChange?.(false);
                }}
              >
                {t("box.cancelClear")}
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}
    </section>
  );
}
