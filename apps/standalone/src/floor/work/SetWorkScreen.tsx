import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, VisuallyHidden } from "@markiro/ui";
import type { ShiftCloseReasonCode } from "@markiro/domain";

import { shiftProductTitle } from "../../lib/shift-product.js";
import { closeShift, readCloseSummary, type CloseSummary } from "../close/shift-close.js";
import { sameSummary, ShiftClosePanel, type CloseNote } from "../close/ShiftClosePanel.js";
import { FloorFooter } from "../shifts/FloorScreen.js";
import { SetRecipe } from "../shifts/SetRecipe.js";
import { readShiftCopy } from "../shifts/shift-copies.js";
import { sharedCount, sharedParticipation } from "../shifts/shift-participation.js";
import { formatQuantity } from "../shifts/shift-text.js";
import { FooterAction, ShiftBand } from "./WorkInstruments.js";
import type { WorkScreenProps } from "./WorkScreen.js";
import {
  readLostSets,
  readSetAssembly,
  recordSetScan,
  setItemCounts,
  undoSetItem,
  type SetAssemblyContext,
  type SetScanResult,
} from "./set-assembly.js";
import { useShiftParticipation } from "./use-shift-participation.js";
import { playSignalTone } from "./signal-sound.js";
import { createWorkQueue } from "./work-queue.js";
import "../print/label-panel.css";
import "./set-work.css";

type Assembly = Awaited<ReturnType<typeof readSetAssembly>>;
type Feedback = SetScanResult | "undone" | "failed";

export function SetWorkScreen(props: WorkScreenProps) {
  const { t } = useTranslation();
  const scanTitleId = useId();
  const scanHintId = useId();
  const { shift, source, awake, officeClosed, leaving, onLeave } = props;
  const recipe = shift.snapshot.product.setItems ?? [];
  const live = useRef(props);
  useLayoutEffect(() => {
    live.current = props;
  }, [props]);
  const [queue] = useState(createWorkQueue);
  const [assembly, setAssembly] = useState<Assembly | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [panel, setPanel] = useState<{
    summary: CloseSummary;
    note: CloseNote | null;
    attempt: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const pausing = useRef(false);
  const ready = assembly !== null;

  const { hostId, deviceId } = props.pairing;
  const participation = useShiftParticipation({
    local: props.local,
    pairing: props.pairing,
    shiftId: shift.copy.id,
    shiftReads: props.shiftReads ?? 0,
    online: props.online,
    ...(props.onRefreshShifts === undefined ? {} : { onRefresh: props.onRefreshShifts }),
  });
  const sharedPart = sharedParticipation(participation);
  const [plannedQty, setPlannedQty] = useState(shift.copy.plannedQty);
  const [lost, setLost] = useState(0);

  useEffect(() => {
    let current = true;
    const pairing = { hostId, deviceId };
    void readShiftCopy(props.local, pairing, shift.copy.id).then(
      (copy) => {
        if (current && copy !== null) setPlannedQty(copy.plannedQty);
      },
      () => undefined,
    );
    void readLostSets(props.local, pairing, shift.copy.id).then(
      (count) => {
        if (current) setLost(count);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [props.local, hostId, deviceId, shift.copy.id, props.shiftReads, props.outboxVersion]);

  function context(): SetAssemblyContext {
    const current = live.current;
    return {
      local: current.local,
      pairing: current.pairing,
      shiftId: current.shift.copy.id,
      setGtin: current.shift.snapshot.product.gtin14,
      recipe: current.shift.snapshot.product.setItems ?? [],
      operatorId: current.operator.id,
      now: () => new Date().toISOString(),
      newId: () => crypto.randomUUID(),
    };
  }

  function leavingNow() {
    return live.current.leaving || live.current.isLeaving?.() === true;
  }

  useEffect(() => awake.hold(), [awake]);
  useEffect(() => {
    let active = true;
    readSetAssembly(context()).then(
      (state) => {
        if (active) setAssembly(state);
      },
      () => {
        if (active) setFeedback("failed");
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    return source.start((raw) => {
      if (leavingNow() || pausing.current || live.current.officeClosed) return;
      live.current.touch();
      void live.current.track(
        queue.run(async () => {
          if (leavingNow() || live.current.officeClosed) return;
          try {
            const current = context();
            const result = await recordSetScan(current, raw);
            if (result === "assembled") live.current.onRecorded();
            setAssembly(await readSetAssembly(current));
            setFeedback(result);
            const tone =
              result === "item" || result === "assembled"
                ? "ok"
                : result === "duplicate"
                  ? "duplicate"
                  : "error";
            (live.current.signal ?? playSignalTone)(tone);
          } catch {
            setFeedback("failed");
            (live.current.signal ?? playSignalTone)("error");
          }
        }),
      );
    });
  }, [queue, ready, source]);

  function undo() {
    if (leavingNow() || pausing.current) return;
    void live.current.track(
      queue.run(async () => {
        if (leavingNow()) return;
        try {
          const current = context();
          await undoSetItem(current);
          setAssembly(await readSetAssembly(current));
          setFeedback("undone");
        } catch {
          setFeedback("failed");
        }
      }),
    );
  }

  function openClose() {
    if (leavingNow() || pausing.current) return;
    pausing.current = true;
    setBusy(true);
    void live.current.track(
      queue.run(async () => {
        try {
          const current = context();
          const summary = await readCloseSummary(
            current.local,
            current.pairing,
            current.shiftId,
            live.current.online,
          );
          setPanel({ summary, note: null, attempt: 0 });
        } catch {
          pausing.current = false;
          setFeedback("failed");
        } finally {
          setBusy(false);
        }
      }),
    );
  }

  function confirmClose(reason: ShiftCloseReasonCode | null) {
    if (leavingNow() || panel === null || busy) return;
    setBusy(true);
    void live.current.track(
      queue.run(async () => {
        if (leavingNow()) {
          setBusy(false);
          return;
        }
        const current = context();
        const online = live.current.online;
        const read = () =>
          readCloseSummary(current.local, current.pairing, current.shiftId, online);
        try {
          const summary = await read();
          if (sameSummary(panel.summary, summary)) {
            const result = await closeShift(
              { ...current, shift: live.current.shift, now: () => new Date() },
              reason,
              [],
              online,
            );
            if (result.kind === "closed") {
              leaveAfterClose();
              return;
            }
          }
          setPanel({ summary: await read(), note: "stale", attempt: panel.attempt + 1 });
        } catch {
          const summary = await read().catch(() => null);
          if (summary?.blocker?.kind === "closed") {
            leaveAfterClose();
          } else {
            setPanel({
              summary: summary ?? panel.summary,
              note: summary === null ? "unknown" : "failed",
              attempt: panel.attempt + 1,
            });
          }
        } finally {
          setBusy(false);
        }
      }),
    );
  }

  function leaveAfterClose() {
    setClosed(true);
    live.current.onRecorded();
    live.current.onLeave();
  }

  const counts = setItemCounts(assembly?.items ?? []);
  const lastGtin = assembly?.items.at(-1)?.gtin14;
  const lastName = recipe.find((item) => item.gtin14 === lastGtin)?.productName;
  const target = recipe.reduce((sum, item) => sum + item.quantity, 0);
  const progress = assembly?.items.length ?? 0;
  const productName = shiftProductTitle(shift.snapshot.product);
  const completed = assembly?.completed ?? 0;
  const shared = sharedPart === null ? null : sharedCount(sharedPart, deviceId, completed, lost);
  const awaitingSetMark = progress === target && target > 0;
  const scanTitle = t(
    awaitingSetMark ? "floor.setAssembly.scanSet" : "floor.setAssembly.scanItems",
  );
  const accepted = feedback === "assembled" || feedback === "item" || feedback === "undone";
  return (
    <main className="work-screen" aria-label={t("floor.setAssembly.mode")}>
      <div className="work-screen__content">
        <div className="work-screen__work">
          <ShiftBand
            productName={productName}
            gtin={shift.snapshot.product.gtin14}
            number={shift.copy.number}
            counterpartyName={shift.snapshot.counterpartyName}
            accepted={completed}
            plannedQty={plannedQty}
            {...(shared === null ? {} : { shared: { ...shared, stale: !props.online } })}
            modeLabel={t("floor.setAssembly.mode")}
            local={props.local}
            productId={shift.copy.productId}
          />
          {panel !== null ? (
            <ShiftClosePanel
              number={shift.copy.number}
              productName={productName}
              summary={panel.summary}
              note={panel.note}
              attempt={panel.attempt}
              waitingSscc={null}
              busy={busy}
              onClose={confirmClose}
              onLabel={() => undefined}
              boxless
              ownPart={sharedPart !== null}
              {...(props.labelClock === undefined ? {} : { clock: props.labelClock })}
              onBack={() => {
                setPanel(null);
                pausing.current = false;
              }}
            />
          ) : (
            <div className="work-screen__instruments set-assembly">
              <section className="set-assembly__status">
                {officeClosed ? (
                  <Alert tone="warn" title={t("floor.work.officeClosed.title")} />
                ) : (
                  <>
                    <section
                      className={
                        awaitingSetMark ? "label-panel__stage set-assembly__scan-stage" : undefined
                      }
                      aria-labelledby={scanTitleId}
                      aria-describedby={awaitingSetMark ? scanHintId : undefined}
                    >
                      {awaitingSetMark && (
                        <div className="label-panel__scanner" aria-hidden="true">
                          <span />
                        </div>
                      )}
                      <h2 id={scanTitleId}>{scanTitle}</h2>
                      {awaitingSetMark && (
                        <p id={scanHintId} className="label-panel__instruction">
                          {t("floor.setAssembly.scanSetHint")}
                        </p>
                      )}
                      <div
                        className="set-assembly__progress"
                        aria-label={t("floor.setAssembly.scanned")}
                      >
                        {formatQuantity(progress)} / {formatQuantity(target)}
                      </div>
                    </section>
                    <div role="status">
                      {awaitingSetMark && <VisuallyHidden>{scanTitle}.</VisuallyHidden>}
                      {feedback !== null && (
                        <Alert
                          tone={accepted ? "ok" : "warn"}
                          role="presentation"
                          title={
                            feedback === "item" && lastName !== undefined
                              ? t("floor.setAssembly.lastProduct", { name: lastName })
                              : t(`floor.setAssembly.feedback.${feedback}`)
                          }
                        />
                      )}
                    </div>
                  </>
                )}
              </section>
              <SetRecipe
                local={props.local}
                items={recipe}
                counts={counts}
                {...(lastGtin === undefined ? {} : { lastGtin })}
              />
            </div>
          )}
        </div>
      </div>
      <FloorFooter className="work-footer" ariaLabel={t("floor.work.layout.actions")}>
        <FooterAction
          variant="secondary"
          disabled={progress === 0 || closed || leaving || panel !== null || busy}
          onClick={undo}
        >
          {t("floor.setAssembly.undo")}
        </FooterAction>
        <FooterAction
          variant="warning-outline"
          disabled={closed || leaving || busy}
          onClick={onLeave}
        >
          {t("floor.setAssembly.pause")}
        </FooterAction>
        <FooterAction
          variant="destructive-outline"
          disabled={closed || leaving || panel !== null || busy || !ready}
          onClick={openClose}
        >
          {t("floor.setAssembly.close")}
        </FooterAction>
      </FloorFooter>
    </main>
  );
}
