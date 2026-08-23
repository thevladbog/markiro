import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { parseScannedSscc } from "@markiro/domain";
import { Alert, Button, FullScreenDialog } from "@markiro/ui";
import type { ClosedBoxSummary } from "../lib/boxes.js";
import type { ScanSource } from "../lib/scan-source.js";
import { filterBoxesByTail } from "../lib/sscc-tail-filter.js";
import { ShiftBoxesPanel } from "../ui/ShiftBoxesPanel.js";
import { ExceptionActions, type BoxExceptionAction } from "../ui/exceptions/ExceptionActions.js";
import { OtherReasonDialog } from "../ui/exceptions/OtherReasonDialog.js";
import { ReasonPicker } from "../ui/exceptions/ReasonPicker.js";
import { SsccSearchPad } from "../ui/exceptions/SsccSearchPad.js";

export type ExceptionStage = "action" | "target" | "reason" | "confirm" | "applying" | "result";

export interface ExceptionFlowProps {
  boxes: ClosedBoxSummary[];
  canUndo: boolean;
  hasOpenBox: boolean;
  onUndo: () => Promise<void>;
  onClear: () => Promise<void>;
  onReprint: (boxId: string, reason: string) => Promise<void>;
  onDisassemble: (boxId: string, reason: string) => Promise<void>;
  onBack: () => void;
  onPendingChange?: (pending: boolean) => void;
  /** Lets the operator pick the target box by scanning its label instead of tapping the list. */
  scanSource?: ScanSource;
  /**
   * The station's window-mode control, rendered beside «Назад»: leaving
   * fullscreen must not require abandoning a half-done exception to reach
   * the status bar's expanded controls.
   */
  windowControl?: ReactNode;
}

export function ExceptionFlow({
  boxes,
  canUndo,
  hasOpenBox,
  onUndo,
  onClear,
  onReprint,
  onDisassemble,
  onBack,
  onPendingChange,
  scanSource,
  windowControl,
}: ExceptionFlowProps) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<ExceptionStage>("action");
  const [action, setAction] = useState<BoxExceptionAction | null>(null);
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const [scanFeedback, setScanFeedback] = useState<"notSscc" | "notFound" | null>(null);
  // The typed SSCC tail. Scanning is deliberately NOT filtered by it: a scan
  // names one exact box and always wins, whatever digits are on the pad.
  const [searchTail, setSearchTail] = useState("");
  const applying = useRef(false);
  const selectedBox = boxes.find((box) => box.boxId === selectedBoxId) ?? null;
  const tailFilter = filterBoxesByTail(boxes, searchTail);

  // While the target list is up, the work screen's own scan loop is paused
  // (WorkScreen unsubscribes for the whole exception flow), so this is the
  // only consumer: a box-label scan picks the target exactly like a tap.
  // The pad's digits belong to one visit of the target list; a stale filter
  // rediscovered minutes later would read as "boxes disappeared".
  useEffect(() => {
    if (stage !== "target") setSearchTail("");
  }, [stage]);

  useEffect(() => {
    if (stage !== "target" || !scanSource) {
      setScanFeedback(null);
      return;
    }
    return scanSource.start((raw) => {
      const parsed = parseScannedSscc(raw);
      if (parsed === null) {
        setScanFeedback("notSscc");
        return;
      }
      const match = boxes.find((box) => box.sscc === parsed) ?? null;
      if (!match) {
        setScanFeedback("notFound");
        return;
      }
      setScanFeedback(null);
      selectBox(match);
    });
  }, [stage, scanSource, boxes]);

  useEffect(() => {
    onPendingChange?.(true);
    return () => onPendingChange?.(false);
  }, [onPendingChange]);

  useEffect(() => {
    if (selectedBoxId && !boxes.some((box) => box.boxId === selectedBoxId)) {
      setSelectedBoxId(null);
      setReason("");
      if (stage !== "action" && stage !== "result") setStage("target");
    }
  }, [boxes, selectedBoxId, stage]);

  const reasons =
    action === "disassemble"
      ? [
          t("box.reasons.disassemble.wrongProduct"),
          t("box.reasons.disassemble.wrongQuantity"),
          t("box.reasons.disassemble.damagedPackage"),
          t("box.reasons.disassemble.qualityRejected"),
        ]
      : [
          t("box.reasons.reprint.damagedLabel"),
          t("box.reasons.reprint.unreadableLabel"),
          t("box.reasons.reprint.printerJam"),
          t("box.reasons.reprint.qualityRequest"),
        ];

  function selectAction(nextAction: BoxExceptionAction): void {
    setAction(nextAction);
    setSelectedBoxId(null);
    setReason("");
    if (nextAction === "undo") {
      void apply(nextAction);
    } else if (nextAction === "clear") {
      setStage("confirm");
    } else {
      setStage("target");
    }
  }

  function selectBox(box: ClosedBoxSummary | null): void {
    setSelectedBoxId(box?.boxId ?? null);
    if (box) setStage("reason");
  }

  function selectReason(nextReason: string): void {
    setReason(nextReason);
    setOtherOpen(false);
    setStage("confirm");
  }

  function goBack(): void {
    if (stage === "applying") return;
    if (stage === "action") {
      onBack();
    } else if (stage === "target") {
      setAction(null);
      setStage("action");
    } else if (stage === "reason") {
      setSelectedBoxId(null);
      setStage("target");
    } else if (stage === "confirm") {
      if (action === "clear") {
        setAction(null);
        setStage("action");
      } else {
        setReason("");
        setStage("reason");
      }
    } else {
      reset();
    }
  }

  function reset(): void {
    applying.current = false;
    setSucceeded(false);
    setAction(null);
    setSelectedBoxId(null);
    setReason("");
    setStage("action");
  }

  async function apply(requestedAction: BoxExceptionAction | null = action): Promise<void> {
    if (applying.current || !requestedAction) return;
    if (
      (requestedAction === "reprint" || requestedAction === "disassemble") &&
      (!selectedBox || !reason)
    ) {
      return;
    }
    applying.current = true;
    setStage("applying");
    try {
      if (requestedAction === "undo") await onUndo();
      else if (requestedAction === "clear") await onClear();
      else if (requestedAction === "reprint" && selectedBox) {
        await onReprint(selectedBox.boxId, reason);
      } else if (requestedAction === "disassemble" && selectedBox) {
        await onDisassemble(selectedBox.boxId, reason);
      }
      setSucceeded(true);
    } catch (err) {
      console.error("station: box exception action failed", err);
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

  // The title names the operation the operator is inside of, not the section
  // of the app: mid-flow, «Расформировать короб» is the fact that matters.
  const title =
    stage === "action" || stage === "result" || action === null || action === "undo"
      ? t("work.exceptions")
      : action === "clear"
        ? t("box.clear")
        : action === "reprint"
          ? t("box.reprintAction")
          : t("box.disassembleAction");

  return (
    <section className="exception-flow" aria-labelledby="exception-flow-title">
      <header className="exception-flow__header">
        <h2
          id="exception-flow-title"
          data-danger={action === "disassemble" && stage !== "action" ? "true" : undefined}
        >
          {title}
        </h2>
        <div className="exception-flow__controls">
          {windowControl}
          {backButton}
        </div>
      </header>
      <div className="exception-flow__stage">
        {stage === "action" ? (
          <div
            data-testid="exception-stage-action"
            className="exception-stage exception-stage--action"
          >
            <h3>{t("box.chooseAction")}</h3>
            {!canUndo && !hasOpenBox && boxes.length === 0 ? <p>{t("box.noActions")}</p> : null}
            <ExceptionActions
              undo={{ label: t("box.undoLastScan"), hint: t("box.actionHints.undo") }}
              clear={{ label: t("box.clear"), hint: t("box.actionHints.clear") }}
              reprint={{ label: t("box.reprintAction"), hint: t("box.actionHints.reprint") }}
              disassemble={{
                label: t("box.disassembleAction"),
                hint: t("box.actionHints.disassemble"),
              }}
              canUndo={canUndo}
              hasOpenBox={hasOpenBox}
              hasClosedBoxes={boxes.length > 0}
              onSelect={selectAction}
            />
          </div>
        ) : null}

        {stage === "target" ? (
          <div
            data-testid="exception-stage-target"
            className="exception-stage exception-stage--target"
            data-action={action ?? undefined}
          >
            <div className="exception-target__finder">
              {scanSource ? (
                <div className="exception-target__scan">
                  <span aria-hidden="true" className="exception-target__scan-glyph">
                    ⌖
                  </span>
                  <p className="exception-stage__hint">{t("box.scanTargetHint")}</p>
                </div>
              ) : null}
              {scanFeedback === "notSscc" ? (
                <Alert tone="error">{t("box.printNotSscc")}</Alert>
              ) : null}
              {scanFeedback === "notFound" ? (
                <Alert tone="error">{t("box.scanTargetNotFound")}</Alert>
              ) : null}
              <SsccSearchPad
                value={searchTail}
                onChange={setSearchTail}
                labels={{
                  group: t("box.searchTailGroup"),
                  placeholder: t("box.searchTailPlaceholder"),
                  backspace: t("box.searchBackspace"),
                  clear: t("box.searchClear"),
                }}
              />
            </div>
            <ShiftBoxesPanel
              boxes={tailFilter.matched}
              selectedBoxId={selectedBoxId}
              onSelectionChange={selectBox}
              highlightTail={searchTail}
              hiddenCount={tailFilter.hiddenCount}
            />
          </div>
        ) : null}

        {stage === "reason" ? (
          <div data-testid="exception-stage-reason" className="exception-stage">
            <h3>{t("box.chooseReason")}</h3>
            <ReasonPicker
              reasons={reasons}
              otherLabel={t("box.reasons.other")}
              onSelect={selectReason}
              onOther={() => setOtherOpen(true)}
            />
            <OtherReasonDialog
              open={otherOpen}
              title={t("box.reasons.other")}
              label={t("box.reason")}
              backLabel={t("box.back")}
              useLabel={t("box.useReason")}
              onClose={() => setOtherOpen(false)}
              onUse={selectReason}
            />
          </div>
        ) : null}

        {stage === "confirm" && action === "reprint" && selectedBox ? (
          <div data-testid="exception-stage-confirm" className="exception-stage exception-confirm">
            <h3>{t("box.reprintConfirmTitle")}</h3>
            <p>SSCC {selectedBox.sscc}</p>
            <p>{reason}</p>
            <Button size="floor" onClick={() => void apply()}>
              {t("box.confirmReprint")}
            </Button>
          </div>
        ) : null}

        {stage === "confirm" && action === "clear" ? (
          <div data-testid="exception-stage-confirm" className="exception-stage exception-confirm">
            <h3>{t("box.confirmClearTitle")}</h3>
            <p>{t("box.confirmClearDetail")}</p>
            <Button size="floor" variant="destructive" onClick={() => void apply()}>
              {t("box.confirmClear")}
            </Button>
          </div>
        ) : null}

        {stage === "confirm" && action === "disassemble" && selectedBox ? (
          <div data-testid="exception-stage-confirm">
            <FullScreenDialog
              open
              title={t("box.disassembleIrreversibleTitle")}
              backLabel={t("box.back")}
              onClose={goBack}
              footer={
                <Button size="floor" variant="destructive" onClick={() => void apply()}>
                  {t("box.confirmDisassemble")}
                </Button>
              }
            >
              <div className="exception-confirm exception-confirm--danger">
                <p>SSCC {selectedBox.sscc}</p>
                <p>{t("box.disassembleCannotReuse")}</p>
                <p>{reason}</p>
              </div>
            </FullScreenDialog>
          </div>
        ) : null}

        {stage === "applying" ? (
          <div data-testid="exception-stage-applying" className="exception-stage exception-result">
            <h3>{t("box.applying")}</h3>
          </div>
        ) : null}

        {stage === "result" ? (
          <div data-testid="exception-stage-result" className="exception-stage exception-result">
            <Alert tone={succeeded ? "ok" : "error"}>
              {succeeded ? t("box.actionSucceeded") : t("box.actionFailed")}
            </Alert>
            <Button size="floor" onClick={succeeded ? onBack : reset}>
              {succeeded ? t("work.backToWork") : t("box.chooseAnotherAction")}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
