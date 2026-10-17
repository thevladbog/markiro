import "@markiro/ui/styles.css";
import "../../../src/app/shell.css";
import "../../../src/i18n/index.js";
import "../../../src/floor/floor-kit.css";
import "../../../src/floor/floor-status-bar.css";

import { createRoot } from "react-dom/client";
import { useState } from "react";

import { boxLabelFields, palletLabelFields } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import type { HostStatus } from "../../../src/host/protocol.js";
import type { LocalExecutor } from "../../../src/local/executor.js";
import { FloorStatusBar } from "../../../src/floor/FloorStatusBar.js";
import { UNSENT_COUNT_SQL } from "../../../src/floor/outbox-status.js";
import type { PrinterProfile } from "../../../src/floor/setup/workstation-settings.js";
import {
  FinishDialog,
  JobView,
  ManualView,
  ReasonDialog,
  SessionView,
  SetupView,
  type Said,
} from "../../../src/floor/warehouse/ReprintViews.js";
import type { SummaryLine } from "../../../src/floor/warehouse/ReprintParts.js";
import type { WarehouseJob } from "../../../src/floor/warehouse/warehouse-store.js";
import {
  resultView,
  summaryRows,
  type JournalFilter,
} from "../../../src/floor/warehouse/warehouse-view.js";
import {
  UnitLabelPanel,
  type UnitLabelShown,
} from "../../../src/floor/unit-labels/UnitLabelPanel.js";
import "../../../src/floor/work/work-screen.css";
import { t } from "i18next";

/**
 * A layout harness, not a product screen: the reprint's real views in the floor frame's real
 * wrapper markup (and the real status bar), with fixed fixtures, for the measurement in
 * `measure.mjs` and for screenshots against the drawings. Query: `state` (see STATES), `theme`,
 * `online` (0), `scanner` (off), `printer` (error | none).
 */
const query = new URLSearchParams(window.location.search);
const state = query.get("state") ?? "journal";
const online = query.get("online") !== "0";
const scannerOff = query.get("scanner") === "off" || state === "scanner";
const printerQuery = query.get("printer") ?? (state === "failed" ? "error" : "ok");

const ZEBRA: PrinterProfile = {
  id: "zebra",
  name: "Zebra ZT411",
  target: { kind: "tcp", host: "192.168.1.50", port: 9100 },
  language: "zpl",
  dpi: 203,
};
const TSC: PrinterProfile = {
  id: "tsc",
  name: "TSC TE310",
  target: { kind: "serial", port: "COM4", baud: 9600 },
  language: "tspl",
  dpi: 300,
};
const HP: PrinterProfile = {
  id: "hp",
  name: "HP LaserJet А4",
  target: { kind: "usb", printer: "HP LaserJet" },
  language: "zpl",
  dpi: 300,
  mode: "windows_driver",
  paper: "a4",
};

const local: LocalExecutor = {
  query: ((sql: string) => {
    if (sql.includes("FROM floor_print_jobs")) {
      return Promise.resolve(
        printerQuery === "error"
          ? [
              {
                id: "j",
                shift_id: "s",
                purpose: "box",
                subject_id: "b",
                sscc: "0",
                state: "failed",
                verify: 0,
                template_id: "t",
                template_rev: 1,
                fields: "x",
                printer: null,
                bytes_base64: null,
                error_code: "not_sent",
                attempts: 1,
                operator_id: "o",
                created_at: "2026-10-16T06:00:00.000Z",
                updated_at: "2026-10-16T06:00:00.000Z",
              },
            ]
          : [],
      );
    }
    if (sql.includes("FROM workstation_settings")) {
      return Promise.resolve(
        printerQuery === "none"
          ? []
          : [
              {
                key: "printers",
                value: JSON.stringify({
                  printers: [ZEBRA, TSC],
                  assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" },
                }),
              },
            ],
      );
    }
    if (sql.includes("count(*)")) {
      if (sql === UNSENT_COUNT_SQL) return Promise.resolve([{ n: 0 }]);
      return Promise.resolve([{ n: 0 }]);
    }
    return Promise.resolve([]);
  }) as LocalExecutor["query"],
  transaction: () => Promise.resolve([]),
};

const LINK: HostStatus = {
  state: online ? "online" : "offline",
  lastContactAt: online ? null : Date.parse("2026-10-16T05:00:00.000Z"),
  lastError: null,
  seq: 1,
};
const watchScanners = scannerOff
  ? (onSnapshot: (s: never) => void) => {
      (onSnapshot as (s: unknown) => void)({
        revision: 1,
        scanners: [{ port: "COM3", baud: 9600, status: "disconnected" }],
      });
      return Promise.resolve(() => undefined);
    }
  : undefined;

// ---- Fixtures: the jobs of the drawings ----

const KM = "010460701234001621Zq8jFY4nQ2\u001d93AbCd";
const BOX_SSCC = "046070123400004821";
const PALLET_SSCC = "046070123400005107";

const base = {
  productName: "Сидр полусухой «Дикий крест» 0,45 л",
  productPrintName: "Сидр «Дикий крест» 0,45 л",
  gtin14: "04607012340016",
  egaisCode: null,
  shelfLifeDays: 365,
  operatorName: "Анна Кузнецова",
  counterpartyName: "ООО «Северный берег»",
  closedAt: "2026-10-17T11:29:00.000Z",
  productionDate: "2026-10-17",
  shiftNumber: "ОКТ26-004",
};
const boxFields = boxLabelFields({ ...base, sscc: BOX_SSCC, itemCount: 24 });
const palletFields = palletLabelFields({
  ...base,
  sscc: PALLET_SSCC,
  boxCount: 18,
  itemCount: 432,
});
const unitFields = { ...boxLabelFields({ ...base, sscc: "", itemCount: 1 }), "km.code": KM };

function job(over: Partial<WarehouseJob>): WarehouseJob {
  return {
    id: "j",
    sessionId: "s",
    kind: "box",
    subjectId: "subject",
    identity: BOX_SSCC,
    repair: null,
    reason: "damaged",
    state: "sent",
    templateId: "t",
    templateRev: 1,
    templateSpec: "{}",
    fields: boxFields,
    printer: ZEBRA,
    bytesBase64: "XlhB",
    errorCode: null,
    attempts: 1,
    operatorId: "o",
    createdAt: "2026-10-17T11:32:00.000Z",
    updatedAt: "2026-10-17T11:32:00.000Z",
    ...over,
  };
}
const at = (hhmm: string) => `2026-10-17T${hhmm}:00.000Z`;
const JOURNAL: WarehouseJob[] = [
  job({
    id: "1",
    kind: "unit",
    identity: "h1",
    fields: unitFields,
    printer: TSC,
    updatedAt: at("11:32"),
  }),
  job({ id: "2", state: "verified", updatedAt: at("11:29") }),
  job({
    id: "3",
    kind: "pallet",
    identity: PALLET_SSCC,
    fields: palletFields,
    state: "unknown",
    errorCode: "outcome_unknown",
    updatedAt: at("11:21"),
  }),
  job({
    id: "4",
    kind: "pallet",
    identity: PALLET_SSCC,
    fields: palletFields,
    printer: HP,
    updatedAt: at("11:21"),
  }),
  job({
    id: "5",
    state: "failed",
    errorCode: "not_sent",
    identity: "046070123400004798",
    updatedAt: at("11:10"),
  }),
  job({
    id: "6",
    kind: "unit",
    identity: "h6",
    fields: unitFields,
    printer: TSC,
    state: "verified",
    updatedAt: at("11:02"),
  }),
];
const UNIT = JOURNAL[0] as WarehouseJob;
const BOX = JOURNAL[1] as WarehouseJob;
const PALLET = JOURNAL[2] as WarehouseJob;

const noop = () => undefined;
const press = (action: () => void) => ({ onClick: action });
const reasonText = "Причина: Повреждена";
const handlers = {
  onSend: noop,
  onRetry: noop,
  onCancelJob: noop,
  onAgain: noop,
  onNext: noop,
  onVerify: noop,
  onSetup: noop,
  onLeave: noop,
};

const lines = (sheets: boolean, none: boolean): SummaryLine[] =>
  summaryRows({
    printers: none ? [] : [ZEBRA, TSC, HP],
    assignments: none
      ? { box: null, pallet: null, duplicate: null }
      : { box: "zebra", pallet: sheets ? "hp" : "zebra", duplicate: "tsc" },
  }).map((row) => ({
    row,
    detail:
      row.kind === "sheet"
        ? row.printer === null
          ? "Лист «Паллета · стандарт» · принтер не назначен"
          : `Лист «Паллета · стандарт» · ${row.printer.name}`
        : row.state === "sheets_only"
          ? "Принтер паллет печатает листы А4"
          : `«${{ box: "Короб 100×150", pallet: "Паллета 100×150", unit: "Дубликат Data Matrix 40×30" }[row.kind]}» · ${row.printer?.name ?? "принтер не назначен"}`,
  }));

const sessionProps = {
  said: null as Said | null,
  online,
  scanner: (scannerOff ? "disconnected" : "connected") as "disconnected" | "connected",
  reasonText,
  sent: 3,
  press,
  leave: press,
  onReason: noop,
  onManual: noop,
  onTemplates: noop,
  onFinish: noop,
  onLeave: noop,
  onOpen: noop,
};
const jobProps = (shown: WarehouseJob, over: { verifying?: boolean; said?: Said | null } = {}) => ({
  job: shown,
  verifying: over.verifying ?? false,
  templateName:
    shown.kind === "unit"
      ? "Дубликат Data Matrix 40×30"
      : shown.kind === "box"
        ? "Короб 100×150"
        : "Паллета 100×150",
  resultText: ((): string | null => {
    const result = resultView(shown, over.verifying ?? false);
    if (result.body === null) return null;
    if (result.body.kind === "hint") return t(`floor.warehouse.hint.${result.body.key}`);
    return t(
      `floor.warehouse.${result.body.code === "printer_a4" ? "printerA4" : "printerUnconfigured"}`,
      {
        defaultValue: "Ничего не напечатано. Проверьте принтер и его настройки, затем повторите.",
      },
    );
  })(),
  note: null,
  said: over.said ?? null,
  online,
  scanner: sessionProps.scanner,
  reasonText,
  press,
  leave: press,
  handlers,
});

function Screen() {
  const [filter, setFilter] = useState<JournalFilter>(
    (query.get("filter") as JournalFilter | null) ?? "all",
  );
  const closeProps = { onClick: noop };
  const dialogRef = { current: null };
  const session = (
    over: Partial<typeof sessionProps> & {
      journal?: WarehouseJob[];
      overlay?: React.ReactNode;
    } = {},
  ) => {
    const { journal, overlay, ...rest } = over;
    return (
      <SessionView
        {...sessionProps}
        {...rest}
        journal={journal ?? JOURNAL}
        filter={filter}
        onFilter={setFilter}
        overlay={overlay}
      />
    );
  };
  switch (state) {
    case "setup":
      return setup(false, false);
    case "setup-sheets":
      return setup(true, false);
    case "setup-none":
      return setup(false, true);
    case "empty":
      return session({ journal: [] });
    case "journal":
    case "scanner":
    case "offline":
      return session();
    case "notfound":
      return session({
        said: { tone: "warn", text: t("floor.warehouse.errors.not_found"), kind: "not_found" },
      });
    case "box-prepared":
      return <JobView {...jobProps({ ...BOX, state: "prepared" })} />;
    case "unit-prepared":
      return <JobView {...jobProps({ ...UNIT, state: "prepared" })} />;
    case "sending":
      return <JobView {...jobProps({ ...BOX, state: "sending" })} />;
    case "sent":
      return <JobView {...jobProps(BOX)} />;
    case "unit-sent":
      return <JobView {...jobProps(UNIT)} />;
    case "unknown":
      return <JobView {...jobProps({ ...UNIT, state: "unknown", errorCode: "outcome_unknown" })} />;
    case "verifying":
      return (
        <JobView
          {...jobProps(
            { ...UNIT, state: "unknown", errorCode: "outcome_unknown" },
            { verifying: true },
          )}
        />
      );
    case "failed":
      return <JobView {...jobProps({ ...BOX, state: "failed", errorCode: "not_sent" })} />;
    case "printer-a4":
      return (
        <JobView
          {...jobProps({ ...PALLET, state: "failed", errorCode: "printer_a4", printer: null })}
        />
      );
    case "again":
      return session({
        overlay: (
          <ReasonDialog
            again
            picked="damaged"
            onPick={noop}
            onConfirm={noop}
            closeProps={closeProps}
            press={press}
            dialogRef={dialogRef}
          />
        ),
      });
    case "finish":
      return session({
        overlay: (
          <FinishDialog
            sent={4}
            waiting={3}
            onConfirm={noop}
            closeProps={closeProps}
            press={press}
            dialogRef={dialogRef}
          />
        ),
      });
    case "manual":
      return <ManualScreen />;
    case "dup":
    case "dup-error":
    case "dup-busy":
    case "dup-none":
      return <Duplicate />;
    default:
      return session();
  }
}

function setup(sheets: boolean, none: boolean) {
  return (
    <SetupView
      reason="damaged"
      lines={lines(sheets, none)}
      press={press}
      leave={press}
      onPick={noop}
      onChangeTemplates={noop}
      onLeave={noop}
      onSetup={noop}
      onStart={noop}
    />
  );
}

function ManualScreen() {
  const [value, setValue] = useState(query.get("typed") ?? "046070123400");
  return (
    <ManualView
      value={value}
      onChange={setValue}
      online={online}
      reasonText={reasonText}
      press={press}
      onCancel={noop}
      onSubmit={noop}
      submitProps={{}}
    />
  );
}

/** The duplicate's panel as the work screen carries it, under a stub of the hero (a measure of its room). */
function Duplicate() {
  const shown = (
    attemptState: UnitLabelShown["attemptState"],
    verification: UnitLabelShown["verification"],
    policy: UnitLabelShown["verificationPolicy"],
  ): UnitLabelShown => ({
    id: "u",
    attemptNo: 1,
    attemptState,
    verificationPolicy: policy,
    verification,
    fields: { "km.code": KM } as UnitLabelShown["fields"],
  });
  const variants: Record<
    string,
    { job: UnitLabelShown; busy: boolean; policy: "none" | "required" }
  > = {
    dup: { job: shown("sent", "pending", "required"), busy: false, policy: "required" },
    "dup-error": {
      job: shown("failed_before_send", "pending", "required"),
      busy: false,
      policy: "required",
    },
    "dup-busy": {
      job: shown("failed_before_send", "pending", "required"),
      busy: true,
      policy: "required",
    },
    "dup-none": { job: shown("sent", "not_required", "none"), busy: false, policy: "none" },
  };
  const v = variants[state] as (typeof variants)[string];
  return (
    <section className="work-screen">
      <div className="work-screen__content">
        <div className="work-screen__instruments" data-layout="validation">
          <div className="work-screen__primary">
            <div className="work-scan-result">
              <p style={{ margin: 0, font: "var(--floor-title)" }}>ПРИНЯТ · …nQ2</p>
            </div>
            <UnitLabelPanel job={v.job} busy={v.busy} verification={v.policy} onRecover={noop} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Page() {
  return (
    <ThemeProvider defaultTheme={query.get("theme") === "dark" ? "dark" : "light"}>
      <div className="standalone-screen">
        <div className="floor-frame">
          <FloorStatusBar
            local={local}
            pairing={{ hostId: "h", deviceId: "dev" }}
            lineId={null}
            operator={{ id: "o", login: "0042", name: "Анна Кузнецова", role: null }}
            link={LINK}
            sync={{ kind: "done", synced: 1, failure: null, quarantined: 0 }}
            deviceName="Станция 1"
            shiftId={null}
            deviceNotSaved={false}
            refusalHeld={false}
            outboxVersion={0}
            factsFailure={null}
            {...(watchScanners === undefined ? {} : { watchScanners: watchScanners as never })}
            onSwitchOperator={() => undefined}
            tools={{
              retry: () => undefined,
              lastSyncedAt: null,
              windowMode: {
                snapshot: { mode: "windowed", pending: false, error: null },
                enter: () => Promise.resolve(),
                exit: () => Promise.resolve(),
                clearError: () => undefined,
              },
              source: {} as never,
              onMute: () => undefined,
            }}
          />
          <Screen />
        </div>
      </div>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);

/**
 * The page's own measurement (`window.__inspect()`), run by `measure.mjs` in every viewport and
 * by hand in a browser pane: structural problems as strings, and the figures behind them.
 */
(window as unknown as { __inspect: () => unknown }).__inspect = () => {
  const problems: string[] = [];
  const doc = document.documentElement;
  const box = (el: Element) => el.getBoundingClientRect();
  if (doc.scrollHeight - doc.clientHeight > 0)
    problems.push(`page scrolls vertically by ${doc.scrollHeight - doc.clientHeight}px`);
  if (doc.scrollWidth - doc.clientWidth > 0)
    problems.push(`page scrolls sideways by ${doc.scrollWidth - doc.clientWidth}px`);
  // Every touch target: 64 px at least both ways.
  const targets: Array<{ label: string; w: number; h: number }> = [];
  for (const el of document.querySelectorAll(
    "button, a[href], [role=button], [role=radio], input",
  )) {
    const b = box(el);
    if (b.width === 0 || b.height === 0) continue;
    const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30);
    targets.push({ label, w: Math.round(b.width), h: Math.round(b.height) });
    if (b.height < 63.5 || b.width < 63.5)
      problems.push(`target under 64px: ${label} ${b.width}x${b.height}`);
  }
  // The one primary of a screen is the kit's 84 px.
  for (const el of document.querySelectorAll(
    ".warehouse-reprint .floor-primary, .rp-footer .mk-btn",
  )) {
    // On a 640 px window the footer's answers are the hub's 72 px, the rest of the floor's 84.
    const want = window.matchMedia("(max-height: 700px)").matches ? 72 : 84;
    if (Math.abs(box(el).height - want) > 0.5)
      problems.push(`answer not ${want}px: ${box(el).height}`);
  }
  // Nothing runs past the window or out of its own box.
  const frame = document.querySelector(".warehouse-reprint, .work-screen");
  const out: Record<string, unknown> = { targets: targets.length };
  if (frame) {
    const f = box(frame);
    out.frame = { w: Math.round(f.width), h: Math.round(f.height), bottom: Math.round(f.bottom) };
    if (f.bottom > window.innerHeight + 0.5)
      problems.push(`frame past the window by ${f.bottom - window.innerHeight}px`);
    for (const el of frame.querySelectorAll(
      ".rp-footer, .rp-footer > *, .rp-journal__row, .rp-tag, .rp-summary__row",
    )) {
      const b = box(el);
      if (b.width === 0) continue;
      // The journal's list is a scroll region: a row below its edge is reached by scrolling it.
      if (el.closest(".rp-journal__list")) continue;
      if (b.right > f.right + 0.5 || b.left < f.left - 0.5) {
        problems.push(`${el.className.toString().split(" ")[0]} leaves the frame sideways`);
      }
      if (b.bottom > f.bottom + 0.5)
        problems.push(`${el.className.toString().split(" ")[0]} leaves the frame below`);
    }
    for (const el of frame.querySelectorAll(
      ".rp-tag, .rp-banner__text, .rp-subject__code, .rp-print__row dd, .rp-journal__code",
    )) {
      if (el.scrollWidth - el.clientWidth > 1 && getComputedStyle(el).overflow === "visible") {
        problems.push(`${el.className.toString().split(" ")[0]} overflows sideways`);
      }
    }
    // The footer's buttons: one line of words, no clipped label.
    for (const el of frame.querySelectorAll(".rp-footer .mk-btn")) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()];
      const lines = new Set(rects.map((r) => Math.round(r.top / 6))).size;
      if (lines > 1) problems.push(`footer button wraps: ${(el.textContent ?? "").trim()}`);
      if (el.scrollWidth - el.clientWidth > 1)
        problems.push(`footer button clipped: ${(el.textContent ?? "").trim()}`);
    }
    const list = frame.querySelector(".rp-journal__list");
    if (list) {
      out.journal = {
        listH: Math.round(box(list).height),
        scrolls: list.scrollHeight - list.clientHeight,
      };
      if (box(list).bottom > f.bottom + 0.5) problems.push("journal list leaves the frame below");
    }
    // The zones and the footer keep their own rows: nothing of the body runs into the footer.
    const footer = frame.querySelector(".rp-footer");
    const body = frame.querySelector(".rp-body, .rp-zones, .rp-manual");
    if (footer && body && box(body).bottom > box(footer).top + 0.5) {
      problems.push(
        `body (${Math.round(box(body).bottom)}) runs into the footer (${Math.round(box(footer).top)})`,
      );
    }
    for (const zone of frame.querySelectorAll(
      ".rp-zone, .rp-empty, .rp-print, .rp-subject, .rp-setup-reasons, .rp-summary",
    )) {
      if (
        zone.scrollHeight - zone.clientHeight > 1 &&
        getComputedStyle(zone).overflowY === "visible"
      ) {
        const inner = [...zone.children].at(-1);
        if (inner && box(inner).bottom > (footer ? box(footer).top : f.bottom) + 0.5) {
          problems.push(`${zone.className.toString().split(" ")[0]} runs below its row`);
        }
      }
    }
  }
  out.problems = problems;
  return out;
};
