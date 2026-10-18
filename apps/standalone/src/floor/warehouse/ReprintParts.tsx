import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";

import { Button, Input } from "@markiro/ui";

import { WAREHOUSE_REASONS } from "../../host/protocol.js";
import { Glyph, type GlyphName } from "../kit/StatusIcons.js";
import { ModeSegment } from "../kit/ModeSegment.js";
import { NumericKeypad } from "../kit/NumericKeypad.js";
import type { WarehouseJob, WarehouseReason } from "./warehouse-store.js";
import {
  JOURNAL_FILTERS,
  jobCode,
  jobFacts,
  jobRowParts,
  jobTag,
  jobTime,
  type JobKindView,
  type JournalFilter,
  type PrinterView,
  type ResultView,
  type SummaryRow,
  type TagTone,
} from "./warehouse-view.js";
import "./reprint.css";

/**
 * The reprint's presentation (design: station reprint, 2026-10): small, stateless pieces the
 * screen composes — the tag, the banner, the reasons, the printers' summary, the session's journal,
 * the scan zone, the job's detail, the dialog and the typed code with its keypad. They hold no
 * reprint logic: every press is a prop (the screen's guard), every word comes from `warehouse-view`
 * or the screen.
 */

/** What a screen does with a press: its handlers and state (`press` of the screen). */
export type PressProps = Record<string, unknown>;
export type Press = (action: () => void) => PressProps;

const KIND_GLYPH: Record<JobKindView, GlyphName> = {
  box: "box",
  pallet: "layers",
  unit: "qr",
  sheet: "file",
};

export function KindGlyph({ kind, size = 28 }: { kind: JobKindView; size?: number }) {
  return <Glyph name={KIND_GLYPH[kind]} size={size} />;
}

/**
 * A zone that scrolls on its own when its content is taller than its row: the footer is never
 * covered, a track and a thumb of 14 px stand on its right edge (touch and a glove can take them),
 * and a fade at the foot says there is more below (`data-more`, the track and the fade are
 * reprint.css). Touch-drag and the keyboard scroll it natively; a focused control scrolls into view.
 */
export function ScrollColumn({ children, className }: { children: ReactNode; className?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) return undefined;
    const update = () =>
      setMore(
        el.scrollHeight - el.clientHeight > 1 &&
          el.scrollTop + el.clientHeight < el.scrollHeight - 1,
      );
    update();
    el.addEventListener("scroll", update, { passive: true });
    const watcher = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    watcher?.observe(el);
    if (el.firstElementChild !== null) watcher?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      watcher?.disconnect();
    };
  });
  return (
    <div
      className={className === undefined ? "rp-col" : `rp-col ${className}`}
      data-more={more ? "true" : "false"}
    >
      <div className="rp-scroll" ref={scroller}>
        {children}
      </div>
    </div>
  );
}

/** A state as the kit says it: a glyph, a word and a tone (never colour alone), 40 px, not a target. */
export function Tag({
  tone,
  glyph,
  children,
  className,
}: {
  tone: TagTone;
  glyph: GlyphName;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={className === undefined ? "rp-tag" : `rp-tag ${className}`} data-tone={tone}>
      <Glyph name={glyph} size={22} />
      <span>{children}</span>
    </span>
  );
}

/** The message above the zones: a glyph, a short title on the tone and the words. */
export function Banner({
  tone,
  glyph,
  title,
  children,
}: {
  tone: TagTone;
  glyph: GlyphName;
  title?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="rp-banner" data-tone={tone}>
      <Glyph name={glyph} size={30} />
      <div className="rp-banner__text">
        {title === undefined ? null : <strong>{title}</strong>}
        <span>{children}</span>
      </div>
    </div>
  );
}

export interface ReprintHeadingProps {
  eyebrow: string;
  title: string;
  titleId: string;
  actions?: ReactNode;
}

export function ReprintHeading({ eyebrow, title, titleId, actions }: ReprintHeadingProps) {
  return (
    <header className="rp-heading">
      <div className="rp-heading__title">
        <p>{eyebrow}</p>
        <h2 id={titleId}>{title}</h2>
      </div>
      {actions === undefined ? null : <div className="rp-heading__actions">{actions}</div>}
    </header>
  );
}

/** A mark of the reasons and of a choice: a ring, and a tick in it once chosen. */
function Mark({ chosen }: { chosen: boolean }) {
  return (
    <span className="rp-mark" aria-hidden="true">
      {chosen ? <Glyph name="check" size={20} /> : null}
    </span>
  );
}

/**
 * The reasons as three large rows: the chosen one is a `fg` fill with a tick (kit: selected is a
 * fill and a check, never colour alone). A radio group: the arrows move within it.
 */
export function ReasonList({
  picked,
  onPick,
  press,
  legend,
  hideLegend = false,
}: {
  picked: WarehouseReason | null;
  onPick: (reason: WarehouseReason) => void;
  press: Press;
  legend: string;
  hideLegend?: boolean;
}) {
  const { t } = useTranslation();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, from: number) => {
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const target = (from + step + WAREHOUSE_REASONS.length) % WAREHOUSE_REASONS.length;
    const reason = WAREHOUSE_REASONS[target];
    if (reason === undefined) return;
    onPick(reason);
    refs.current[target]?.focus();
  };
  return (
    <div className="rp-reasons" role="radiogroup" aria-label={legend}>
      <p className={hideLegend ? "rp-label rp-label--hidden" : "rp-label"} aria-hidden="true">
        {legend}
      </p>
      {WAREHOUSE_REASONS.map((reason, index) => {
        const chosen = picked === reason;
        const props = press(() => onPick(reason));
        return (
          <Button
            key={reason}
            ref={(element) => {
              refs.current[index] = element;
            }}
            size="floor"
            variant="secondary"
            role="radio"
            aria-checked={chosen}
            tabIndex={chosen || (picked === null && index === 0) ? 0 : -1}
            className="rp-reason"
            {...props}
            onKeyDown={(event) => move(event, index)}
          >
            <Mark chosen={chosen} />
            <span>{t(`floor.warehouse.reasons.${reason}`)}</span>
          </Button>
        );
      })}
    </div>
  );
}

/** One line of «Что и на чём печатаем»: its words are the screen's (it knows the templates). */
export interface SummaryLine {
  row: SummaryRow;
  detail: string;
}

export function SummaryList({
  lines,
  press,
  onChange,
  disabled,
}: {
  lines: readonly SummaryLine[];
  press: Press;
  onChange: (kind: JobKindView) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ul className="rp-summary">
      {lines.map(({ row, detail }) => (
        <li key={row.kind} className="rp-summary__row" data-kind={row.kind}>
          <span className="rp-summary__glyph">
            <KindGlyph kind={row.kind} />
          </span>
          <div className="rp-summary__text">
            <strong>{t(`floor.warehouse.summary.kind.${row.kind}`)}</strong>
            {/* Two lines at most; the whole name is the title and the screen reader's label. */}
            <span className="rp-summary__detail" title={detail}>
              {detail}
            </span>
          </div>
          {row.state === "ready" ? (
            <Tag tone="ok" glyph="printer" className="rp-summary__tag">
              {t("floor.warehouse.summary.printerReady")}
            </Tag>
          ) : (
            <Tag tone="warn" glyph="warning" className="rp-summary__tag">
              {t(
                row.state === "sheets_only"
                  ? "floor.warehouse.summary.sheetsOnlyTag"
                  : "floor.warehouse.summary.unassigned",
              )}
            </Tag>
          )}
          <Button
            size="floor"
            variant="secondary"
            aria-label={`${t("floor.warehouse.summary.change")}: ${t(`floor.warehouse.summary.kind.${row.kind}`)}`}
            {...press(() => onChange(row.kind))}
            {...(disabled ? { "aria-disabled": true, style: { opacity: 0.45 } } : {})}
          >
            {t("floor.warehouse.summary.change")}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The session's journal: the segments, then a row to a job, newest first. */
export function Journal({
  jobs,
  filter,
  onFilter,
  onOpen,
  press,
}: {
  jobs: readonly WarehouseJob[];
  filter: JournalFilter;
  onFilter: (filter: JournalFilter) => void;
  onOpen: (job: WarehouseJob) => void;
  press: Press;
}) {
  const { t } = useTranslation();
  return (
    <section className="rp-journal" aria-label={t("floor.warehouse.journal.label")}>
      <ModeSegment
        label={t("floor.warehouse.journal.filterLabel")}
        hideLabel
        reserveHint={false}
        options={JOURNAL_FILTERS.map((value) => ({
          value,
          label: t(`floor.warehouse.journal.filter.${value}`),
        }))}
        value={filter}
        onChange={onFilter}
      />
      {jobs.length === 0 ? (
        <p className="rp-journal__none">{t("floor.warehouse.journal.noneInFilter")}</p>
      ) : (
        <ScrollColumn>
          <ul className="rp-journal__list">
            {jobs.map((job) => {
              const parts = jobRowParts(job);
              const code = jobCode(job);
              const tag = jobTag(job);
              const main =
                code.kind === "unreadable" ? t("floor.warehouse.journal.unreadable") : code.main;
              const state = t(`floor.warehouse.tag.${tag.key}`);
              const count =
                parts.count === null
                  ? null
                  : t(`floor.warehouse.journal.${parts.count.unit}`, { n: parts.count.n });
              return (
                <li key={job.id}>
                  <Button
                    size="floor"
                    variant="ghost"
                    className="rp-journal__row"
                    aria-label={t("floor.warehouse.journal.open", { code: main, state })}
                    {...press(() => onOpen(job))}
                  >
                    <span className="rp-journal__glyph">
                      <KindGlyph kind={parts.kind} />
                    </span>
                    <span className="rp-journal__text">
                      <strong className="rp-journal__code">{main}</strong>
                      <span className="rp-journal__line">
                        {[t(`floor.warehouse.journal.kind.${parts.kind}`), parts.title, count]
                          .filter((piece) => piece !== null && piece !== "")
                          .join(" · ")}
                      </span>
                    </span>
                    <Tag tone={tag.tone} glyph={tag.glyph}>
                      {state}
                    </Tag>
                    <time className="rp-journal__time" dateTime={job.updatedAt}>
                      {jobTime(job.updatedAt)}
                    </time>
                  </Button>
                </li>
              );
            })}
          </ul>
        </ScrollColumn>
      )}
    </section>
  );
}

/** The scan zone's four faces: ready, nothing found, no link (search closed), scanner away. */
export type ZoneVariant = "ready" | "not_found" | "offline" | "scanner";

const ZONE_GLYPH: Record<ZoneVariant, GlyphName> = {
  ready: "barcode",
  not_found: "search-x",
  offline: "wifi-slash",
  scanner: "plugs",
};

export function ScanZone({
  variant,
  manual,
}: {
  variant: ZoneVariant;
  /** The typed code's button: it is the primary one when the scanner is away, shut when no search is. */
  manual: ReactNode;
}) {
  const { t } = useTranslation();
  const title = {
    ready: "readyTitle",
    not_found: "notFoundTitle",
    offline: "offlineTitle",
    scanner: "scannerTitle",
  }[variant];
  const text = {
    ready: "readyText",
    not_found: "notFoundText",
    offline: "offlineText",
    scanner: "scannerText",
  }[variant];
  return (
    <section className="rp-zone" data-variant={variant} aria-label={t("floor.warehouse.prompt")}>
      <span className="rp-zone__glyph">
        <Glyph name={ZONE_GLYPH[variant]} size={80} />
      </span>
      <h3>{t(`floor.warehouse.zone.${title}`)}</h3>
      <p>{t(`floor.warehouse.zone.${text}`)}</p>
      {variant === "offline" ? (
        <Tag tone="warn" glyph="wifi-slash">
          {t("floor.warehouse.zone.offlineTag")}
        </Tag>
      ) : variant === "scanner" ? (
        <Tag tone="error" glyph="plugs">
          {t("floor.warehouse.zone.scannerTag")}
        </Tag>
      ) : (
        <Tag tone="ok" glyph="barcode">
          {t("floor.warehouse.zone.scannerReady")}
        </Tag>
      )}
      {manual}
    </section>
  );
}

/** The empty journal: nothing printed in this session yet. */
export function JournalEmpty() {
  const { t } = useTranslation();
  return (
    <section className="rp-empty" aria-label={t("floor.warehouse.journal.label")}>
      <span className="rp-empty__glyph">
        <Glyph name="inbox" size={64} />
      </span>
      <h3>{t("floor.warehouse.journal.emptyTitle")}</h3>
      <p>{t("floor.warehouse.journal.emptyText")}</p>
    </section>
  );
}

/** The detail's left column: what the label is for, the code first, three facts. */
export function JobSubject({ job }: { job: WarehouseJob }) {
  const { t } = useTranslation();
  const parts = jobRowParts(job);
  const code = jobCode(job);
  return (
    <section className="rp-subject" aria-label={t(`floor.warehouse.detail.kind.${parts.kind}`)}>
      <Tag tone="neutral" glyph={KIND_GLYPH[parts.kind]} className="rp-subject__kind">
        {t(`floor.warehouse.detail.kind.${parts.kind}`)}
      </Tag>
      <p className="rp-label">
        {t(code.kind === "sscc" ? "floor.warehouse.detail.sscc" : "floor.warehouse.detail.serial")}
      </p>
      <p className="rp-subject__code" data-kind={code.kind}>
        {code.kind === "unreadable" ? t("floor.warehouse.journal.unreadable") : code.main}
      </p>
      {code.gtin === null ? null : (
        <p className="rp-subject__gtin">{t("floor.warehouse.detail.gtin", { gtin: code.gtin })}</p>
      )}
      <p className="rp-subject__title">{parts.title}</p>
      <dl className="rp-facts">
        {jobFacts(job).map((fact) => (
          <div key={fact.key} className="rp-facts__row">
            <dt>{t(`floor.warehouse.detail.fact.${fact.key}`)}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export interface JobPrintProps {
  /** The frozen template's name (the job's own), or `null`. */
  templateName: string | null;
  printer: PrinterView;
  reason: string;
  result: ResultView;
  /** The words of the result's body, already chosen by the screen. */
  resultText: string | null;
  /** A line the screen adds under the result (the repaired old label). */
  note: string | null;
}

/** The detail's right column: what goes (template, printer, reason) and where the print stands. */
export function JobPrint({
  templateName,
  printer,
  reason,
  result,
  resultText,
  note,
}: JobPrintProps) {
  const { t } = useTranslation();
  return (
    <section className="rp-print" aria-labelledby="rp-print-title">
      <h3 id="rp-print-title" className="rp-label">
        {t("floor.warehouse.detail.print")}
      </h3>
      <dl className="rp-print__rows">
        <div className="rp-print__row">
          <dt>{t("floor.warehouse.detail.template")}</dt>
          <dd>{templateName ?? t("floor.warehouse.detail.noTemplate")}</dd>
        </div>
        <div className="rp-print__row">
          <dt>{t("floor.warehouse.detail.printer")}</dt>
          <dd>{printer.name ?? t("floor.warehouse.detail.noPrinter")}</dd>
          <Tag
            tone={
              printer.tag === "ready"
                ? "ok"
                : printer.tag === "accepting"
                  ? "info"
                  : printer.tag === "error"
                    ? "error"
                    : "warn"
            }
            glyph={
              printer.tag === "accepting"
                ? "circle-notch"
                : printer.tag === "unassigned"
                  ? "warning"
                  : "printer"
            }
          >
            {t(`floor.warehouse.detail.printerTag.${printer.tag}`)}
          </Tag>
        </div>
        <div className="rp-print__row">
          <dt>{t("floor.warehouse.detail.reason")}</dt>
          <dd>{reason}</dd>
        </div>
      </dl>
      <div className="rp-result" data-tone={result.tone} role="status">
        <span className="rp-result__glyph">
          <Glyph name={result.glyph} size={44} />
        </span>
        <div className="rp-result__text">
          <strong>{t(`floor.warehouse.status.${result.title}`)}</strong>
          {resultText === null ? null : <span>{resultText}</span>}
          {note === null ? null : <span>{note}</span>}
        </div>
      </div>
    </section>
  );
}

/**
 * A question over the screen (design: the level above, one surface with a shadow): a title, a
 * line, the choices, the answers. Focus stays inside it, the first control takes it, and Escape
 * is its «Отмена»; it keeps the screen's own view guard (`dialogRef` is the screen's view).
 */
export function ReprintDialog({
  titleId,
  title,
  dialogRef,
  onCancel,
  children,
  actions,
}: {
  titleId: string;
  title: string;
  dialogRef: Ref<HTMLElement>;
  onCancel: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  const own = useRef<HTMLDivElement | null>(null);
  const keep = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      own.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="rp-overlay">
      <div
        className="rp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={keep}
        ref={(element) => {
          own.current = element;
          if (typeof dialogRef === "function") dialogRef(element);
          else if (dialogRef !== null) dialogRef.current = element;
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="rp-dialog__actions">{actions}</div>
      </div>
    </div>
  );
}

/** The footer: the answers of a screen, the one primary at the right. */
export function ReprintFooter({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <footer className="rp-footer">
      {note === undefined ? null : note}
      <div className="rp-footer__row">{children}</div>
    </footer>
  );
}

/** A footer button with a glyph before its words. */
export function FooterButton({
  glyph,
  children,
  variant = "secondary",
  primary = false,
  end = false,
  ...rest
}: {
  glyph: GlyphName;
  children: ReactNode;
  variant?: "secondary" | "primary";
  primary?: boolean;
  /** Pushed to the right edge of the footer. */
  end?: boolean;
} & PressProps) {
  const style = rest["style"] as CSSProperties | undefined;
  return (
    <Button
      size="floor"
      variant={primary ? "primary" : variant}
      className={
        primary
          ? "floor-primary rp-footer__primary"
          : end
            ? "rp-footer__action rp-footer__end"
            : "rp-footer__action"
      }
      icon={<Glyph name={glyph} size={primary ? 28 : 26} />}
      {...rest}
      {...(style === undefined ? {} : { style })}
    >
      {children}
    </Button>
  );
}

const MANUAL_DIGITS = 18;

/**
 * The typed code: a readout that takes a hardware keyboard too (a unit's code is typed whole), the
 * flat keypad beside it, and the answer. The scanner is quiet while it is open (the screen
 * gives it back on leaving).
 */
export function ManualEntry({
  value,
  onChange,
  onSubmit,
  online,
  submitProps,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  online: boolean;
  submitProps: PressProps;
}) {
  const { t } = useTranslation();
  const digits = /^\d*$/.test(value);
  const need = digits && value.length > 0 && value.length < MANUAL_DIGITS;
  const empty = value.trim() === "";
  return (
    <div className="rp-manual">
      <form
        className="rp-manual__form"
        id="warehouse-manual-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!empty) onSubmit();
        }}
      >
        <Input
          size="floor"
          mono
          label={t("floor.warehouse.manualLabel")}
          value={value}
          autoFocus
          spellCheck={false}
          className="rp-manual__field"
          suffix={
            digits ? (
              <span className="rp-manual__count">
                {t("floor.warehouse.manualCounter", {
                  n: Math.min(value.length, MANUAL_DIGITS),
                  max: MANUAL_DIGITS,
                })}
              </span>
            ) : undefined
          }
          onChange={(event) => onChange(event.target.value)}
        />
        <p className="rp-manual__need">
          {need
            ? t("floor.warehouse.manualNeed", { n: MANUAL_DIGITS - value.length })
            : t("floor.warehouse.manualHint")}
        </p>
        <Tag tone="info" glyph="keyboard" className="rp-manual__muted">
          {t("floor.warehouse.manualMuted")}
        </Tag>
        <p className="rp-manual__host">{online ? t("floor.warehouse.manualHost") : null}</p>
      </form>
      <div className="rp-manual__pad">
        <NumericKeypad
          value={digits ? value : ""}
          onChange={onChange}
          maxLength={MANUAL_DIGITS}
          leadingZero
          disabled={!digits}
          ariaLabel={t("floor.warehouse.manualKeypad")}
          clearLabel={t("floor.warehouse.manualClear")}
          backspaceLabel={t("floor.warehouse.manualBackspace")}
        />
        <Button
          size="floor"
          variant="primary"
          type="submit"
          form="warehouse-manual-form"
          className="floor-primary"
          icon={<Glyph name="search" size={26} />}
          disabled={empty}
          {...submitProps}
        >
          {t("floor.warehouse.manualSubmit")}
        </Button>
      </div>
    </div>
  );
}
