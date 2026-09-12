import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FullScreenDialog } from "@markiro/ui";
import type { ClosedPalletSummary } from "../lib/pallets.js";
import { OtherReasonDialog } from "../ui/exceptions/OtherReasonDialog.js";
import { ReasonPicker } from "../ui/exceptions/ReasonPicker.js";

export type PalletExceptionAction = "reprint" | "disassemble";
export type PalletExceptionStage =
  "action" | "target" | "reason" | "confirm" | "applying" | "result";

export interface PalletExceptionsProps {
  /** Closed, not-yet-disassembled pallets for this shift and terminal. */
  pallets: ClosedPalletSummary[];
  onReprint: (palletId: string, reason: string) => Promise<void>;
  onDisassemble: (palletId: string, reason: string) => Promise<void>;
  onBack: () => void;
  onPendingChange?: (pending: boolean) => void;
}

/**
 * The pallet-scoped sibling of `ExceptionFlow` (which stays box-only): a
 * pallet has at most a handful of closed rows per terminal, never the
 * scan-a-label-off-a-long-list volume boxes reach, so this stays a single
 * reason stage rather than `ExceptionFlow`'s multi-stage scan/search pad.
 * Reused floor components (`ReasonPicker`, `OtherReasonDialog`) keep the
 * wording and the 500-character reason cap consistent with the box flow.
 */
export function PalletExceptions({
  pallets,
  onReprint,
  onDisassemble,
  onBack,
  onPendingChange,
}: PalletExceptionsProps) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<PalletExceptionStage>("action");
  const [action, setAction] = useState<PalletExceptionAction | null>(null);
  const [selectedPalletId, setSelectedPalletId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const applying = useRef(false);
  const selectedPallet = pallets.find((p) => p.palletId === selectedPalletId) ?? null;
  const hasPallets = pallets.length > 0;

  useEffect(() => {
    onPendingChange?.(true);
    return () => onPendingChange?.(false);
  }, [onPendingChange]);

  const reasons =
    action === "disassemble"
      ? [
          t("pallet.reasons.disassemble.damagedPallet"),
          t("pallet.reasons.disassemble.wrongBoxes"),
          t("pallet.reasons.disassemble.qualityRejected"),
        ]
      : [
          t("pallet.reasons.reprint.damagedLabel"),
          t("pallet.reasons.reprint.unreadableLabel"),
          t("pallet.reasons.reprint.printerJam"),
          t("pallet.reasons.reprint.qualityRequest"),
        ];

  function selectAction(nextAction: PalletExceptionAction): void {
    setAction(nextAction);
    setReason("");
    if (pallets.length === 1) {
      setSelectedPalletId(pallets[0]?.palletId ?? null);
      setStage("reason");
    } else {
      setSelectedPalletId(null);
      setStage("target");
    }
  }

  function selectPallet(pallet: ClosedPalletSummary): void {
    setSelectedPalletId(pallet.palletId);
    setStage("reason");
  }

  function confirmReason(): void {
    if (!reason.trim()) return;
    if (action === "disassemble") setStage("confirm");
    else void apply();
  }

  function goBack(): void {
    if (stage === "applying") return;
    if (stage === "action") {
      onBack();
    } else if (stage === "target") {
      setAction(null);
      setStage("action");
    } else if (stage === "reason") {
      setSelectedPalletId(null);
      setStage(pallets.length === 1 ? "action" : "target");
    } else if (stage === "confirm") {
      setStage("reason");
    } else {
      reset();
    }
  }

  function reset(): void {
    applying.current = false;
    setSucceeded(false);
    setAction(null);
    setSelectedPalletId(null);
    setReason("");
    setStage("action");
  }

  async function apply(): Promise<void> {
    if (applying.current || !action || !selectedPallet) return;
    const trimmedReason = reason.trim();
    if (!trimmedReason) return;
    applying.current = true;
    setStage("applying");
    try {
      if (action === "reprint") await onReprint(selectedPallet.palletId, trimmedReason);
      else await onDisassemble(selectedPallet.palletId, trimmedReason);
      setSucceeded(true);
    } catch (err) {
      console.error("station: pallet exception action failed", err);
      setSucceeded(false);
    } finally {
      applying.current = false;
      setStage("result");
    }
  }

  const backButton =
    stage === "applying" ? null : (
      <Button size="floor" variant="secondary" onClick={goBack}>
        {t("box.back")}
      </Button>
    );

  const title =
    stage === "action" || stage === "result" || action === null
      ? t("work.exceptions")
      : action === "reprint"
        ? t("pallet.reprintAction")
        : t("pallet.disassembleAction");

  return (
    <section className="pallet-exceptions" aria-labelledby="pallet-exceptions-title">
      <header className="pallet-exceptions__header">
        <h2 id="pallet-exceptions-title">{title}</h2>
        {backButton}
      </header>
      <div className="pallet-exceptions__stage">
        {stage === "action" ? (
          <div data-testid="pallet-exception-stage-action" className="exception-stage">
            <h3>{t("box.chooseAction")}</h3>
            {!hasPallets ? <p>{t("pallet.noPallets")}</p> : null}
            <div className="pallet-exceptions__actions">
              <Button
                size="floor"
                variant="secondary"
                fullWidth
                disabled={!hasPallets}
                onClick={() => selectAction("reprint")}
              >
                {t("pallet.reprintAction")}
              </Button>
              <Button
                size="floor"
                variant="secondary"
                fullWidth
                disabled={!hasPallets}
                onClick={() => selectAction("disassemble")}
              >
                {t("pallet.disassembleAction")}
              </Button>
            </div>
          </div>
        ) : null}

        {stage === "target" ? (
          <div data-testid="pallet-exception-stage-target" className="exception-stage">
            <h3>{t("pallet.selectTarget")}</h3>
            <ul className="pallet-exceptions__list">
              {pallets.map((pallet) => (
                <li key={pallet.palletId}>
                  <Button
                    type="button"
                    size="floor"
                    variant="secondary"
                    className="pallet-exceptions__item"
                    onClick={() => selectPallet(pallet)}
                  >
                    <strong>SSCC {pallet.sscc}</strong>
                    <span>{t("pallet.boxCount", { count: pallet.boxCount })}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {stage === "reason" && selectedPallet ? (
          <div data-testid="pallet-exception-stage-reason" className="exception-stage">
            <h3>{t("box.chooseReason")}</h3>
            <p>SSCC {selectedPallet.sscc}</p>
            <ReasonPicker
              reasons={reasons}
              otherLabel={t("box.reasons.other")}
              onSelect={setReason}
              onOther={() => setOtherOpen(true)}
            />
            <OtherReasonDialog
              open={otherOpen}
              title={t("box.reasons.other")}
              label={t("box.reason")}
              backLabel={t("box.back")}
              useLabel={t("box.useReason")}
              onClose={() => setOtherOpen(false)}
              onUse={(nextReason) => {
                setReason(nextReason);
                setOtherOpen(false);
              }}
            />
            {reason ? <p className="pallet-exceptions__reason">{reason}</p> : null}
            <Button size="floor" disabled={!reason.trim()} onClick={confirmReason}>
              {t("box.confirmAction")}
            </Button>
          </div>
        ) : null}

        {stage === "confirm" && action === "disassemble" && selectedPallet ? (
          <div data-testid="pallet-exception-stage-confirm">
            <FullScreenDialog
              open
              title={t("pallet.disassembleIrreversibleTitle")}
              backLabel={t("box.back")}
              onClose={goBack}
              footer={
                <Button size="floor" variant="destructive" onClick={() => void apply()}>
                  {t("box.confirmDisassemble")}
                </Button>
              }
            >
              <div className="exception-confirm exception-confirm--danger">
                <p>SSCC {selectedPallet.sscc}</p>
                <p>{t("box.disassembleCannotReuse")}</p>
                <p>{reason}</p>
              </div>
            </FullScreenDialog>
          </div>
        ) : null}

        {stage === "applying" ? (
          <div data-testid="pallet-exception-stage-applying" className="exception-stage">
            <h3>{t("box.applying")}</h3>
          </div>
        ) : null}

        {stage === "result" ? (
          <div data-testid="pallet-exception-stage-result" className="exception-stage">
            <p role={succeeded ? "status" : "alert"}>
              {succeeded ? t("box.actionSucceeded") : t("box.actionFailed")}
            </p>
            <Button size="floor" onClick={succeeded ? onBack : reset}>
              {succeeded ? t("work.backToWork") : t("box.chooseAnotherAction")}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
