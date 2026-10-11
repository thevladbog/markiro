import { formatSsccHri, parseScannedSscc } from "@markiro/domain";
import type { TFunction } from "i18next";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input } from "@markiro/ui";

import {
  DISASSEMBLE_REASONS,
  OTHER_REASON,
  REPRINT_REASONS,
  type DisassembleReason,
  type ReprintReason,
} from "../exception-reasons.js";
import { VIEW_GUARD_MS, type PanelSettings } from "../print/LabelPanel.js";
import { resolvePrinter, type PrinterProfile } from "../setup/workstation-settings.js";
import { formatQuantity } from "../shifts/shift-text.js";
import {
  InvalidReasonError,
  reasonWords,
  type ClosedBox,
  type ExceptionReason,
} from "./box-exceptions.js";

/** The four exceptions of a box (stage 2a spec §5.7.6). */
export type ExceptionAction = "undo" | "clear" | "reprint" | "disassemble";

/**
 * How an exception went, as the screen says it: done; a reprint whose new
 * label now waits (the work screen shows it); nothing to take out; the box
 * changed meanwhile; the box is no longer a closed box of the shift; its
 * label still waits (also the answer, never on this screen, of an action whose
 * screen a waiting label took while it queued); its label was made from another revision of the
 * template than the shift holds now; the operator is leaving the shift; or
 * this computer could not write. Nothing but `done` and `label` wrote
 * anything the screen can count on (`failed` may have: the work screen
 * tells the host all the same).
 */
export type ExceptionOutcome =
  | { kind: "done"; action: ExceptionAction }
  | { kind: "label" }
  | { kind: "empty" }
  | { kind: "stale" }
  | { kind: "unavailable" }
  | { kind: "label_waiting" }
  | { kind: "template_changed" }
  | { kind: "leaving" }
  | { kind: "failed" };

/** A reason of its action's list. */
type Reasoned =
  | { action: "reprint"; reason: ExceptionReason<ReprintReason> }
  | { action: "disassemble"; reason: ExceptionReason<DisassembleReason> };

type BoxAction = Reasoned["action"];

type Stage =
  | { kind: "actions" }
  | { kind: "confirm_clear" }
  | { kind: "target"; action: BoxAction; tail: string; note: "not_sscc" | "not_found" | null }
  | { kind: "reason"; action: BoxAction; box: ClosedBox }
  | { kind: "words"; action: BoxAction; box: ClosedBox; text: string; invalid: boolean }
  | { kind: "confirm"; box: ClosedBox; reasoned: Reasoned }
  | { kind: "applying" }
  | { kind: "result"; outcome: ExceptionOutcome };

/**
 * What the box choice made of a scan: the box is picked, the code is no SSCC,
 * or no closed box of the shift has it. `null` — the choice is not open any
 * more (a scan before it was, or after the box was picked): the screen refuses
 * the scan as it refuses every scan while the work is stopped.
 */
export type BoxScanVerdict = "taken" | "not_sscc" | "not_found";

/** The printer a reprint goes to, as the reprint's confirmation knows it. */
type ReprintPrinter =
  { kind: "loading" } | { kind: "ready"; printer: PrinterProfile | null } | { kind: "failed" };

/** The most boxes the list shows at once: more are found by the last digits of their SSCC. */
export const MAX_LISTED_BOXES = 12;

/** The longest tail of digits the pad takes: an SSCC has 18. */
const MAX_TAIL = 18;

/** The boxes whose SSCC ends with `tail`, the first `MAX_LISTED_BOXES` of them, and how many more. */
export function boxesByTail(
  boxes: readonly ClosedBox[],
  tail: string,
): { shown: ClosedBox[]; hidden: number } {
  const matching = boxes.filter((box) => box.sscc.endsWith(tail));
  return {
    shown: matching.slice(0, MAX_LISTED_BOXES),
    hidden: Math.max(0, matching.length - MAX_LISTED_BOXES),
  };
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] as const;

/**
 * The view a stage shows: the guard against a second tap and the focus follow
 * a change of it, not the typing of a digit or of a word into the same view.
 */
function viewOf(stage: Stage): string {
  switch (stage.kind) {
    case "target":
      return `target:${stage.action}`;
    case "reason":
    case "words":
      return `${stage.kind}:${stage.action}:${stage.box.id}`;
    case "confirm":
      return `confirm:${stage.reasoned.action}:${stage.box.id}`;
    case "result":
      return `result:${stage.outcome.kind}`;
    case "actions":
    case "confirm_clear":
    case "applying":
      return stage.kind;
  }
}

/** What a view is called: the heading of the view and the name of the group the focus lands on. */
function stageLabel(stage: Stage, t: TFunction): string {
  switch (stage.kind) {
    case "actions":
      return t("floor.exceptions.choose");
    case "confirm_clear":
      return t("floor.exceptions.confirm.clear.title");
    case "target":
      return t(`floor.exceptions.target.title.${stage.action}`);
    case "reason":
      return t("floor.exceptions.reason.title");
    case "words":
      return t(`floor.exceptions.reasons.${stage.action}.other`);
    case "confirm":
      return t(`floor.exceptions.confirm.${stage.reasoned.action}.title`);
    case "applying":
      return t("floor.exceptions.applying");
    case "result":
      return t(
        stage.outcome.kind === "done"
          ? `floor.exceptions.result.done.${stage.outcome.action}`
          : `floor.exceptions.result.${stage.outcome.kind}`,
      );
  }
}

const realClock = () => performance.now();

export interface ExceptionFlowProps {
  /** Codes in the shift's open box: «Снять последний код» and «Очистить короб» need some. */
  openItems: number;
  /** The shift's closed boxes not taken apart, the last first; `null` while they are read. */
  boxes: readonly ClosedBox[] | null;
  onUndo: () => Promise<ExceptionOutcome>;
  onClear: () => Promise<ExceptionOutcome>;
  onReprint: (boxId: string, reason: ExceptionReason<ReprintReason>) => Promise<ExceptionOutcome>;
  onDisassemble: (
    boxId: string,
    reason: ExceptionReason<DisassembleReason>,
  ) => Promise<ExceptionOutcome>;
  /**
   * The workstation's settings: which printer «Короб» has now, the printer a
   * reprint goes to (the same choice `reprintBox` makes), read when the
   * exceptions open.
   */
  loadSettings: () => Promise<PanelSettings>;
  /** The workstation setup, offered where no printer is assigned; absent where the floor gives none. */
  onSetup?: () => void;
  /**
   * Hands the work screen the scan listener of the box choice (`null` — none):
   * while a box is chosen a scan of its label picks it, and is never
   * journalled. It answers what it made of the scan, so that the screen gives
   * it its tone and its words, or `null` when the choice is not open.
   */
  registerScan: (listener: ((raw: string) => BoxScanVerdict | null) | null) => void;
  /** A text field takes typing (`true`) or gives it back: a keyboard scanner's keys are not a scan then. */
  onTextEntry: (active: boolean) => void;
  /** Back to the work: never held, whatever the screen shows. */
  onBack: () => void;
  /** Milliseconds from a clock that does not go back; the guard after a change of view reads it. */
  clock?: () => number;
}

/**
 * The exceptions of the work screen (stage 2a spec §5.7.6, the cloud
 * station's `ExceptionFlow`): take the last code out of the open box, clear
 * it, print a closed box's label again, take a closed box apart. A closed
 * box is chosen by a scan of its label or by the last digits of its SSCC on
 * a pad of 64 px keys (a text field would take a keyboard scanner's keys); a
 * reprint and a disassembly need a reason of their list, with words only for
 * «Другая причина»; a clear, a reprint and a disassembly are confirmed, the
 * box and its SSCC named, the button that destroys apart from «Назад»; a
 * reprint names the printer «Короб» has now before it is confirmed (or says
 * that none is assigned, and what follows), a disassembly says that it cannot
 * be undone. Each
 * action runs as the line's next piece of work, once, and says how it went.
 * «Назад» is there at every step but while an action writes. A press is
 * ignored for `VIEW_GUARD_MS` after the screen changed its view (the second
 * tap of a gloved double tap lands on whatever the new view put under the
 * finger), and the focus goes to the view itself, never to a button. It sits
 * in the work screen's polite region, so its alerts have no role of their own.
 */
export function ExceptionFlow({
  openItems,
  boxes,
  onUndo,
  onClear,
  onReprint,
  onDisassemble,
  loadSettings,
  onSetup,
  registerScan,
  onTextEntry,
  onBack,
  clock = realClock,
}: ExceptionFlowProps) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>({ kind: "actions" });
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // What a scan of the box choice reads when it lands.
  const current = useRef({ stage, boxes });
  useLayoutEffect(() => {
    current.current = { stage, boxes };
  });

  const choosing = stage.kind === "target";
  useEffect(() => {
    if (!choosing) return;
    registerScan((raw) => {
      const now = current.current.stage;
      // Not the choice any more, though no render has said so yet: the screen refuses the scan.
      if (now.kind !== "target") return null;
      // The next stage is known at once, so that a second scan before the render finds the choice made.
      const take = (next: Stage): void => {
        current.current = { stage: next, boxes: current.current.boxes };
        setStage(next);
      };
      const sscc = parseScannedSscc(raw);
      if (sscc === null) {
        take({ ...now, note: "not_sscc" });
        return "not_sscc";
      }
      const box = current.current.boxes?.find((candidate) => candidate.sscc === sscc);
      if (box === undefined) {
        take({ ...now, note: "not_found" });
        return "not_found";
      }
      take({ kind: "reason", action: now.action, box });
      return "taken";
    });
    return () => registerScan(null);
  }, [choosing, registerScan]);

  // The printer a reprint goes to, read once when the exceptions open (the setup is another
  // screen: nothing changes it while this one is up), the choice `reprintBox` makes.
  const [reprintPrinter, setReprintPrinter] = useState<ReprintPrinter>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    loadSettings().then(
      (settings) => {
        if (!cancelled) {
          setReprintPrinter({ kind: "ready", printer: resolvePrinter(settings, "box") });
        }
      },
      () => {
        if (!cancelled) setReprintPrinter({ kind: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadSettings]);

  // The words field takes the keyboard from the scanner while its view is up
  // — and gives it back when the view goes, however it goes (a blur does not
  // come when the field is removed by Enter).
  const typing = stage.kind === "words";
  useEffect(() => {
    if (!typing) return;
    return () => onTextEntry(false);
  }, [typing, onTextEntry]);

  // The view, its guard and its focus.
  const view = viewOf(stage);
  const viewChangedAt = useRef<number>(Number.NEGATIVE_INFINITY);
  const viewRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    viewChangedAt.current = clock();
  }, [view, clock]);
  useEffect(() => {
    viewRef.current?.focus();
  }, [view]);

  /** Props of a button: a press just after the view changed does nothing. */
  const press = (action: () => void) => ({
    onClick: () => {
      const since = clock() - viewChangedAt.current;
      if (since >= 0 && since < VIEW_GUARD_MS) return;
      action();
    },
  });

  // One action at a time: a second press before the first one's view is up does nothing.
  const running = useRef(false);
  const run = (work: () => Promise<ExceptionOutcome>) => {
    if (running.current) return;
    running.current = true;
    setStage({ kind: "applying" });
    work().then(
      (outcome) => {
        running.current = false;
        if (alive.current) setStage({ kind: "result", outcome });
      },
      () => {
        running.current = false;
        if (alive.current) setStage({ kind: "result", outcome: { kind: "failed" } });
      },
    );
  };

  const apply = (box: ClosedBox, reasoned: Reasoned) => {
    run(() =>
      reasoned.action === "reprint"
        ? onReprint(box.id, reasoned.reason)
        : onDisassemble(box.id, reasoned.reason),
    );
  };

  const pick = (action: BoxAction, box: ClosedBox, code: string, text: string | null) => {
    if (action === "reprint") {
      const reason = REPRINT_REASONS.find((candidate) => candidate === code);
      if (reason !== undefined) {
        setStage({ kind: "confirm", box, reasoned: { action, reason: { code: reason, text } } });
      }
      return;
    }
    const reason = DISASSEMBLE_REASONS.find((candidate) => candidate === code);
    if (reason !== undefined) {
      setStage({ kind: "confirm", box, reasoned: { action, reason: { code: reason, text } } });
    }
  };

  const back = (to: Stage | null) => (
    <Button
      size="floor"
      variant="secondary"
      {...press(() => (to === null ? onBack() : setStage(to)))}
    >
      {t("floor.exceptions.back")}
    </Button>
  );

  const title = t("floor.exceptions.title");
  const label = stageLabel(stage, t);
  const printerLine =
    reprintPrinter.kind === "loading" ? null : (
      <p>
        {reprintPrinter.kind === "failed"
          ? t("floor.print.target.unknown")
          : reprintPrinter.printer === null
            ? t("floor.exceptions.confirm.reprint.noPrinter")
            : t("floor.print.target.label", {
                name: reprintPrinter.printer.name,
                language: reprintPrinter.printer.language.toUpperCase(),
                dpi: reprintPrinter.printer.dpi,
              })}
      </p>
    );
  const body = () => {
    switch (stage.kind) {
      case "actions": {
        const closed = boxes ?? [];
        const nothing = openItems === 0 && boxes !== null && closed.length === 0;
        return (
          <>
            <h4>{label}</h4>
            {boxes === null && <p>{t("floor.exceptions.loading")}</p>}
            {nothing && <p>{t("floor.exceptions.none")}</p>}
            <div className="exceptions__choices">
              <Button
                size="floor"
                variant="secondary"
                disabled={openItems === 0}
                {...press(() => run(onUndo))}
              >
                {t("floor.exceptions.actions.undo")}
              </Button>
              <Button
                size="floor"
                variant="secondary"
                // The quantity it names is trusted once the numbers were read (`boxes` come after them).
                disabled={openItems === 0 || boxes === null}
                {...press(() => setStage({ kind: "confirm_clear" }))}
              >
                {t("floor.exceptions.actions.clear")}
              </Button>
              <Button
                size="floor"
                variant="secondary"
                disabled={closed.length === 0}
                {...press(() =>
                  setStage({ kind: "target", action: "reprint", tail: "", note: null }),
                )}
              >
                {t("floor.exceptions.actions.reprint")}
              </Button>
              <Button
                size="floor"
                variant="secondary"
                disabled={closed.length === 0}
                {...press(() =>
                  setStage({ kind: "target", action: "disassemble", tail: "", note: null }),
                )}
              >
                {t("floor.exceptions.actions.disassemble")}
              </Button>
            </div>
            <div className="standalone-form__actions">{back(null)}</div>
          </>
        );
      }
      case "confirm_clear":
        return (
          <Alert tone="warn" role="presentation" title={label}>
            <p>
              {t("floor.exceptions.confirm.clear.body", { quantity: formatQuantity(openItems) })}
            </p>
            <div className="standalone-form__actions exceptions__confirm">
              {back({ kind: "actions" })}
              <Button size="floor" variant="destructive" {...press(() => run(onClear))}>
                {t("floor.exceptions.confirm.clear.action")}
              </Button>
            </div>
          </Alert>
        );
      case "target": {
        const { shown, hidden } = boxesByTail(boxes ?? [], stage.tail);
        const type = (tail: string) => setStage({ ...stage, tail, note: null });
        return (
          <>
            <h4>{label}</h4>
            <p>{t("floor.exceptions.target.hint")}</p>
            {stage.note !== null && (
              <p role="alert">{t(`floor.exceptions.target.${stage.note}`)}</p>
            )}
            <p>
              {stage.tail === ""
                ? t("floor.exceptions.target.tailEmpty")
                : t("floor.exceptions.target.tail", { tail: stage.tail })}
            </p>
            <div
              className="standalone-form__actions exceptions__pad"
              role="group"
              aria-label={t("floor.exceptions.target.pad")}
            >
              {DIGITS.map((digit) => (
                <Button
                  key={digit}
                  size="floor"
                  variant="secondary"
                  disabled={stage.tail.length >= MAX_TAIL}
                  {...press(() => type(stage.tail + digit))}
                >
                  {digit}
                </Button>
              ))}
              <Button
                size="floor"
                variant="secondary"
                disabled={stage.tail === ""}
                {...press(() => type(stage.tail.slice(0, -1)))}
              >
                {t("floor.exceptions.target.erase")}
              </Button>
            </div>
            {shown.length === 0 ? (
              <p>{t("floor.exceptions.target.nothing")}</p>
            ) : (
              <div className="exceptions__choices">
                {shown.map((box) => (
                  <Button
                    key={box.id}
                    size="floor"
                    variant="secondary"
                    {...press(() => setStage({ kind: "reason", action: stage.action, box }))}
                  >
                    {t("floor.exceptions.target.box", {
                      sscc: formatSsccHri(box.sscc),
                      quantity: formatQuantity(box.itemCount),
                    })}
                  </Button>
                ))}
              </div>
            )}
            {hidden > 0 && (
              <p>{t("floor.exceptions.target.more", { number: formatQuantity(hidden) })}</p>
            )}
            <div className="standalone-form__actions">{back({ kind: "actions" })}</div>
          </>
        );
      }
      case "reason": {
        const reasons = stage.action === "reprint" ? REPRINT_REASONS : DISASSEMBLE_REASONS;
        return (
          <>
            <h4>{label}</h4>
            <p>{t("floor.exceptions.reason.box", { sscc: formatSsccHri(stage.box.sscc) })}</p>
            <div className="exceptions__choices">
              {reasons.map((code) => (
                <Button
                  key={code}
                  size="floor"
                  variant="secondary"
                  {...press(() =>
                    code === OTHER_REASON
                      ? setStage({ ...stage, kind: "words", text: "", invalid: false })
                      : pick(stage.action, stage.box, code, null),
                  )}
                >
                  {t(`floor.exceptions.reasons.${stage.action}.${code}`)}
                </Button>
              ))}
            </div>
            <div className="standalone-form__actions">
              {back({ kind: "target", action: stage.action, tail: "", note: null })}
            </div>
          </>
        );
      }
      case "words": {
        const next = () => {
          try {
            pick(stage.action, stage.box, OTHER_REASON, reasonWords(stage.text));
          } catch (error) {
            if (!(error instanceof InvalidReasonError)) throw error;
            setStage({ ...stage, invalid: true });
          }
        };
        return (
          <>
            <h4>{label}</h4>
            <p>{t("floor.exceptions.reason.box", { sscc: formatSsccHri(stage.box.sscc) })}</p>
            <Input
              size="floor"
              label={t("floor.exceptions.words.label")}
              hint={t("floor.exceptions.words.hint")}
              value={stage.text}
              {...(stage.invalid ? { error: t("floor.exceptions.words.invalid") } : {})}
              onChange={(event) =>
                setStage({ ...stage, text: event.currentTarget.value, invalid: false })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  next();
                }
              }}
              onFocus={() => onTextEntry(true)}
              onBlur={() => onTextEntry(false)}
            />
            <div className="standalone-form__actions">
              {back({ kind: "reason", action: stage.action, box: stage.box })}
              <Button size="floor" {...press(next)}>
                {t("floor.exceptions.words.next")}
              </Button>
            </div>
          </>
        );
      }
      case "confirm": {
        const { box, reasoned } = stage;
        const reasonText =
          reasoned.reason.text ??
          t(`floor.exceptions.reasons.${reasoned.action}.${reasoned.reason.code}`);
        return (
          <Alert
            tone={reasoned.action === "disassemble" ? "error" : "warn"}
            role="presentation"
            title={label}
          >
            <p>
              {t(`floor.exceptions.confirm.${reasoned.action}.body`, {
                sscc: formatSsccHri(box.sscc),
                quantity: formatQuantity(box.itemCount),
              })}
            </p>
            {reasoned.action === "disassemble" && (
              <p>{t("floor.exceptions.confirm.disassemble.final")}</p>
            )}
            <p>{t("floor.exceptions.confirm.reason", { reason: reasonText })}</p>
            {reasoned.action === "reprint" && printerLine}
            <div className="standalone-form__actions exceptions__confirm">
              {back({ kind: "reason", action: reasoned.action, box })}
              {reasoned.action === "reprint" &&
                reprintPrinter.kind === "ready" &&
                reprintPrinter.printer === null &&
                onSetup !== undefined && (
                  <Button size="floor" variant="secondary" {...press(onSetup)}>
                    {t("floor.print.setup")}
                  </Button>
                )}
              <Button
                size="floor"
                variant={reasoned.action === "disassemble" ? "destructive" : "primary"}
                // A reprint is confirmed once the operator can see where it goes.
                disabled={reasoned.action === "reprint" && reprintPrinter.kind === "loading"}
                {...press(() => apply(box, reasoned))}
              >
                {t(`floor.exceptions.confirm.${reasoned.action}.action`)}
              </Button>
            </div>
          </Alert>
        );
      }
      case "applying":
        return <p>{label}</p>;
      case "result": {
        const { outcome } = stage;
        const tone =
          outcome.kind === "done" || outcome.kind === "label"
            ? "ok"
            : outcome.kind === "failed"
              ? "error"
              : "warn";
        return (
          <Alert tone={tone} role="presentation" title={label}>
            {outcome.kind === "done" && outcome.action === "undo" && (
              <p>{t("floor.exceptions.result.hint.undo")}</p>
            )}
            <div className="standalone-form__actions">
              <Button size="floor" {...press(onBack)}>
                {t("floor.exceptions.result.back")}
              </Button>
              <Button
                size="floor"
                variant="secondary"
                {...press(() => setStage({ kind: "actions" }))}
              >
                {t("floor.exceptions.result.again")}
              </Button>
            </div>
          </Alert>
        );
      }
    }
  };

  const content = body();
  return (
    <section className="exceptions" aria-label={title}>
      <h3>{title}</h3>
      <div className="exceptions__view" role="group" aria-label={label} tabIndex={-1} ref={viewRef}>
        {content}
      </div>
    </section>
  );
}
