import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@markiro/ui";
import type { ShiftCloseReasonCode } from "@markiro/domain";

import { shiftProductTitle } from "../../lib/shift-product.js";
import { closeShift, readCloseSummary, type CloseSummary } from "../close/shift-close.js";
import { sameSummary, ShiftClosePanel, type CloseNote } from "../close/ShiftClosePanel.js";
import { readShiftCopy } from "../shifts/shift-copies.js";
import { sharedCount, sharedParticipation } from "../shifts/shift-participation.js";
import { formatQuantity } from "../shifts/shift-text.js";
import { ShiftBand } from "./WorkInstruments.js";
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
import "./set-work.css";

type Assembly = Awaited<ReturnType<typeof readSetAssembly>>;
type Feedback = SetScanResult | "undone" | "failed";

export function SetWorkScreen(props: WorkScreenProps) {
  const { t } = useTranslation();
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
              live.current.onRecorded();
              setClosed(true);
              setPanel(null);
              return;
            }
          }
          setPanel({ summary: await read(), note: "stale", attempt: panel.attempt + 1 });
        } catch {
          const summary = await read().catch(() => null);
          if (summary?.blocker?.kind === "closed") {
            live.current.onRecorded();
            setClosed(true);
            setPanel(null);
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

  const counts = setItemCounts(assembly?.items ?? []);
  const target = recipe.reduce((sum, item) => sum + item.quantity, 0);
  const progress = assembly?.items.length ?? 0;
  const productName = shiftProductTitle(shift.snapshot.product);
  const completed = assembly?.completed ?? 0;
  const shared = sharedPart === null ? null : sharedCount(sharedPart, deviceId, completed, lost);
  const state = progress === target && target > 0 ? "scanSet" : "scanItems";
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
                ) : closed ? (
                  <Alert
                    tone="ok"
                    title={t(
                      sharedPart === null
                        ? "floor.close.done.title"
                        : "floor.close.part.done.title",
                      {
                        number: shift.copy.number,
                      },
                    )}
                  />
                ) : (
                  <>
                    <h2>{t(`floor.setAssembly.${state}`)}</h2>
                    <div
                      className="set-assembly__progress"
                      aria-label={t("floor.setAssembly.scanned")}
                    >
                      {formatQuantity(progress)} / {formatQuantity(target)}
                    </div>
                    <div role="status">
                      {feedback !== null && (
                        <Alert
                          tone={accepted ? "ok" : "warn"}
                          role="presentation"
                          title={t(`floor.setAssembly.feedback.${feedback}`)}
                        />
                      )}
                    </div>
                  </>
                )}
              </section>
              <section
                className="set-assembly__recipe"
                aria-label={t("floor.setAssembly.composition")}
              >
                <h2>{t("floor.setAssembly.composition")}</h2>
                <ul>
                  {recipe.map(({ gtin14, productName: name, quantity }) => (
                    <li key={gtin14}>
                      <span>
                        {name}
                        <small>{gtin14}</small>
                      </span>
                      <strong>
                        {formatQuantity(counts.get(gtin14) ?? 0)} / {formatQuantity(quantity)}
                      </strong>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          )}
        </div>
      </div>
      <footer className="station-floor-footer">
        <Button
          size="floor"
          variant="secondary"
          disabled={progress === 0 || closed || leaving || panel !== null || busy}
          onClick={undo}
        >
          {t("floor.setAssembly.undo")}
        </Button>
        <Button size="floor" variant="secondary" disabled={leaving || busy} onClick={onLeave}>
          {t(closed ? "floor.close.done.toList" : "floor.work.leave")}
        </Button>
        <Button
          size="floor"
          className="floor-primary"
          disabled={closed || leaving || panel !== null || busy || !ready}
          onClick={openClose}
        >
          {t("floor.setAssembly.close")}
        </Button>
      </footer>
    </main>
  );
}
