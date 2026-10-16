import "@markiro/ui/styles.css";
import "../../../src/app/shell.css";
import "../../../src/i18n/index.js";
import "../../../src/floor/floor-kit.css";
import "../../../src/floor/floor-status-bar.css";

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Alert } from "@markiro/ui";
import { ThemeProvider } from "@markiro/ui";

import type { HostStatus } from "../../../src/host/protocol.js";
import type { LocalExecutor } from "../../../src/local/executor.js";
import { FloorStatusBar } from "../../../src/floor/FloorStatusBar.js";
import { ShiftHubView } from "../../../src/floor/shifts/ShiftHub.js";
import type { HubCopies } from "../../../src/floor/shifts/ShiftHub.js";
import type { ShiftCopy } from "../../../src/floor/shifts/shift-copies.js";
import { queueBadge } from "../../../src/floor/shifts/hub-layout.js";
import { UNSENT_COUNT_SQL } from "../../../src/floor/outbox-status.js";

/**
 * A layout harness, not a product screen: the floor's real status bar and the hub's real view in
 * the floor frame's real wrapper markup, with a fake local database and fixed fixtures, for the
 * measurement in `measure.mjs` and for screenshots. Query: `view` (hub | work | signin), `shifts`
 * (0..4), `page`, `offline`, `long` (long names), `queue`, `rejected`, `printer`
 * (ok | error | none), `scanner` (ok | partial | off), `photo`, `theme`.
 */
const query = new URLSearchParams(window.location.search);
const view = query.get("view") ?? "hub";
const shiftCount = Number(query.get("shifts") ?? "3");
const offline = query.get("offline") === "1";
const long = query.get("long") === "1";
const queue = Number(query.get("queue") ?? "0");
const rejected = Number(query.get("rejected") ?? "0");
const printer = query.get("printer") ?? "ok";
const scanner = query.get("scanner") ?? "ok";
const photoKind = query.get("photo") ?? "none";

function drawPhoto(kind: string): { media: string; base64: string } | null {
  if (kind === "none") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 480;
  const context = canvas.getContext("2d")!;
  if (kind !== "transparent") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 320, 480);
  }
  context.fillStyle = "#2d7a3a";
  context.fillRect(110, 40, 100, 400);
  context.fillStyle = "#e9c46a";
  context.fillRect(100, 180, 120, 120);
  const media = kind === "jpeg" ? "image/jpeg" : "image/png";
  return { media, base64: canvas.toDataURL(media).split(",")[1] ?? "" };
}
const photoRow = drawPhoto(photoKind);

const ZEBRA = {
  id: "zebra",
  name: "Zebra у линии",
  target: { kind: "tcp", host: "192.168.1.50", port: 9100 },
  language: "zpl",
  dpi: 203,
};

/** Rows by the statement's text: just what the bar and the hub read. */
const local: LocalExecutor = {
  query: ((sql: string) => {
    if (sql.includes("ref_product_photos")) {
      return Promise.resolve(
        photoRow === null
          ? []
          : [
              {
                checksum: `fake-${photoKind}`,
                data_base64: photoRow.base64,
                media_type: photoRow.media,
              },
            ],
      );
    }
    if (sql.includes("FROM floor_print_jobs")) {
      // A job this build cannot read still waits: the printer chip says an error.
      return Promise.resolve(
        printer === "error"
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
        printer === "none"
          ? []
          : [
              {
                key: "printers",
                value: JSON.stringify({
                  printers: [ZEBRA],
                  assignments: { box: "zebra", pallet: null, duplicate: null },
                }),
              },
            ],
      );
    }
    if (sql.includes("count(*)")) {
      if (sql === UNSENT_COUNT_SQL) return Promise.resolve([{ n: queue }]);
      if (sql.includes("outcome = 'rejected'")) return Promise.resolve([{ n: rejected }]);
      return Promise.resolve([{ n: 0 }]);
    }
    return Promise.resolve([]);
  }) as LocalExecutor["query"],
  transaction: () => Promise.resolve([]),
};

const copy = (
  number: string,
  name: string,
  over: Partial<ShiftCopy> & { accepted?: number },
): ShiftCopy =>
  ({
    id: number,
    number,
    status: "planned",
    localState: null,
    mode: "aggregation",
    palletsEnabled: false,
    createdFrom: "office",
    lineId: "l",
    productId: "p",
    productName: name,
    productPrintName: null,
    productGtin14: "04680089900017",
    counterpartyName: "ООО «Северный берег»",
    productionDate: "2026-10-08",
    plannedDate: "2026-10-09",
    plannedQty: 1200,
    boxCapacity: 12,
    boxTemplateId: "b",
    palletBoxCapacity: null,
    palletTemplateId: null,
    ownerDeviceId: null,
    openedAt: null,
    closedAt: null,
    entered: false,
    ...over,
  }) as ShiftCopy;

const ALL: ShiftCopy[] = [
  copy("ОКТ26-004", "Молоко 3,2% 0,9 л", {
    status: "active",
    ownerDeviceId: "dev",
    entered: true,
    palletsEnabled: true,
  }),
  copy("ОКТ26-005/S", "Сидр полусухой «Дикий крест» 0,45 л", {
    counterpartyName: "ООО «Южные горы и партнёры»",
    plannedDate: "2026-10-09",
    plannedQty: null,
    mode: "validation",
  }),
  copy("ОКТ26-003", "Напиток «Тархун» 1,5 л", {
    status: "closed",
    ownerDeviceId: "dev",
    entered: true,
    plannedQty: 2400,
    plannedDate: "2026-10-08",
    productionDate: "2026-10-07",
  }),
  copy("ОКТ26-002", "Квас хлебный натуральный нефильтрованный непастеризованный 2 л", {
    entered: false,
    plannedQty: 600,
  }),
];
const LONG_NAME =
  "Напиток безалкогольный сильногазированный «Байкал» со вкусом хвои и лимона в стеклянной бутылке 0,5 л";
const shown = ALL.slice(0, shiftCount).map((c, i) =>
  long && i === 0 ? { ...c, productName: LONG_NAME } : c,
);
const accepted = new Map<string, number>([
  ["ОКТ26-004", 840],
  ["ОКТ26-003", 2400],
]);
const copies: HubCopies = {
  kind: "ready",
  copies: shown,
  refused: new Map(),
  accepted,
};

const LINK: HostStatus = {
  state: offline ? "offline" : "online",
  lastContactAt: offline ? Date.parse("2026-10-16T05:00:00.000Z") : null,
  lastError: null,
  seq: 1,
};

const watchScanners =
  scanner === "ok"
    ? undefined
    : (onSnapshot: (s: never) => void) => {
        const statuses = scanner === "partial" ? ["connected", "disconnected"] : ["disconnected"];
        (onSnapshot as (s: unknown) => void)({
          revision: 1,
          scanners: statuses.map((status, i) => ({ port: `COM${i + 3}`, baud: 9600, status })),
        });
        return Promise.resolve(() => undefined);
      };

function Page() {
  const [page, setPage] = useState(Number(query.get("page") ?? "1"));
  const operator =
    view === "signin"
      ? null
      : {
          id: "o",
          login: "0042",
          name: long ? "Богатырёва Анастасия Владиславовна" : "Анна Кузнецова",
          role: null,
        };
  return (
    <ThemeProvider defaultTheme={query.get("theme") === "dark" ? "dark" : "light"}>
      <div className="standalone-screen">
        <div className="floor-frame">
          <FloorStatusBar
            local={local}
            pairing={{ hostId: "h", deviceId: "dev" }}
            lineId={null}
            operator={operator}
            link={LINK}
            sync={{ kind: "done", synced: 1, failure: null, quarantined: 0 }}
            deviceName={long ? "Станция упаковки № 3 · Линия розлива сидра" : "Станция 1"}
            shiftId={view === "work" ? "s" : null}
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
          {view === "hub" && (
            <ShiftHubView
              local={local}
              copies={copies}
              deviceId="dev"
              online={!offline}
              blocked={null}
              busy={false}
              notRead={false}
              requestedPage={page}
              onPageChange={setPage}
              messages={
                offline ? (
                  <Alert tone="warn" role="presentation">
                    Нет связи с хостом: показаны смены, полученные раньше. Продолжить можно смену,
                    которую эта станция уже открыла.
                  </Alert>
                ) : null
              }
              badge={queueBadge({ unsent: queue, rejected })}
              onChoose={() => undefined}
              onRetry={() => undefined}
              onNew={() => undefined}
              onSetup={() => undefined}
              onWarehouse={() => undefined}
              onQueue={() => undefined}
            />
          )}
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

  // Every touch target: 64 px at least both ways; the one primary 84 px.
  const targets: Array<{ label: string; w: number; h: number }> = [];
  for (const el of document.querySelectorAll("button, a[href], [role=button], input, select")) {
    const b = box(el);
    if (b.width === 0 || b.height === 0) continue;
    const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30);
    targets.push({ label, w: Math.round(b.width), h: Math.round(b.height) });
    if (b.height < 63.5 || b.width < 63.5)
      problems.push(`target under 64px: ${label} ${b.width}x${b.height}`);
  }
  for (const el of document.querySelectorAll(
    ".floor-primary, .shift-hub .station-floor-footer .mk-btn",
  )) {
    // On a 640 px window the card's action is the floor's smallest target, 64 px, the footer's 72.
    const short = window.matchMedia("(max-height: 700px)").matches;
    const want = short ? (el.classList.contains("shift-card__action") ? 64 : 72) : 84;
    if (Math.abs(box(el).height - want) > 0.5)
      problems.push(`primary not ${want}px: ${box(el).height}`);
  }

  // The header: one row of 73 px, nothing past its edges, the identity and the rail apart.
  const bar = document.querySelector(".station-status-bar");
  const out: Record<string, unknown> = { targets: targets.length };
  if (bar) {
    const bb = box(bar);
    out.bar = { h: Math.round(bb.height), w: Math.round(bb.width) };
    const row = bar.querySelector(".floor-bar__rail");
    const identity = bar.querySelector(".station-status-identity");
    if (row && identity) {
      const r = box(row);
      const i = box(identity);
      out.rail = { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
      out.identity = { right: Math.round(i.right), w: Math.round(i.width) };
      if (i.right > r.left + 0.5)
        problems.push(`identity (${i.right}) runs under the rail (${r.left})`);
      if (r.right > bb.right + 0.5)
        problems.push(`rail runs past the bar by ${r.right - bb.right}px`);
      if (r.height > 64.5) problems.push(`rail ${r.height}px high: wrapped`);
    }
    if (bar.scrollWidth - bar.clientWidth > 1) problems.push("header overflows sideways");
    const rowHeight = Math.round(box(bar.querySelector(".floor-bar__rail")!).height);
    out.railHeight = rowHeight;
    out.chips = [...bar.querySelectorAll("[data-chip]")].map((c) => ({
      kind: c.getAttribute("data-chip"),
      form: c.getAttribute("data-form"),
      w: Math.round(box(c).width),
      h: Math.round(box(c).height),
    }));
    for (const c of bar.querySelectorAll("[data-chip]")) {
      if (Math.abs(box(c).height - 40) > 0.5)
        problems.push(`chip ${c.getAttribute("data-chip")} ${box(c).height}px high`);
    }
    const operator = [...bar.querySelectorAll(".station-status-actions .mk-btn")].find((b) =>
      (b.getAttribute("aria-label") ?? b.textContent ?? "").includes("Сменить оператора"),
    );
    out.operatorButton = operator ? (operator.textContent?.trim() === "" ? "icon" : "text") : null;
    out.nameCut = [...bar.querySelectorAll(".station-status-identity dd")].some(
      (d) => d.scrollWidth - d.clientWidth > 1,
    );
  }

  // The hub: the cards in the zone, nothing clipped that should be whole.
  const screen = document.querySelector(".shift-hub");
  if (screen) {
    const footer = screen.querySelector(".station-floor-footer");
    const grid = screen.querySelector(".shift-selection__grid");
    if (footer && grid) {
      const f = box(footer);
      out.footer = {
        top: Math.round(f.top),
        bottom: Math.round(f.bottom),
        h: Math.round(f.height),
      };
      if (f.bottom > window.innerHeight + 0.5)
        problems.push(`footer past the window by ${f.bottom - window.innerHeight}px`);
      for (const card of grid.querySelectorAll(".shift-card")) {
        const c = box(card);
        if (c.bottom > f.top + 0.5)
          problems.push(`card (${c.bottom}) runs into the footer (${f.top})`);
      }
    }
    out.cards = [...document.querySelectorAll(".shift-card")].map((card) => {
      const details = card.querySelector(".shift-card__details")!;
      const photo = card.querySelector(".shift-card__photo")!;
      const action = card.querySelector(".shift-card__action");
      const title = card.querySelector(".shift-card__product")!;
      const entry = {
        w: Math.round(box(card).width),
        h: Math.round(box(card).height),
        photoW: Math.round(box(photo).width),
        photoH: Math.round(box(photo).height),
        detailsOverflow: details.scrollHeight - details.clientHeight,
        titleLines: Math.round(box(title).height / parseFloat(getComputedStyle(title).lineHeight)),
        titleClipped: title.scrollHeight - title.clientHeight > 1,
        actionBottomGap: action ? Math.round(box(details).bottom - box(action).bottom) : null,
        facts: [...card.querySelectorAll(".shift-card__fact")].map((f) => ({
          label: f.querySelector("dt")?.textContent,
          clipped: f.querySelector("dd")!.scrollWidth - f.querySelector("dd")!.clientWidth > 1,
        })),
      };
      if (entry.detailsOverflow > 1)
        problems.push(`card details overflow by ${entry.detailsOverflow}px`);
      if (Math.abs(entry.photoH - entry.h) > 2)
        problems.push(`photo ${entry.photoH} high in a ${entry.h} card`);
      if (entry.facts.some((f) => f.clipped)) problems.push("a fact is cut with an ellipsis");
      if (action && entry.actionBottomGap !== null && entry.actionBottomGap < 0)
        problems.push("action runs out of the card");
      const tags = card.querySelector(".shift-card__tags");
      if (tags && box(tags).bottom > box(photo).bottom + 0.5)
        problems.push("tags run out of the panel");
      return entry;
    });
    const states = screen.querySelector(".shift-selection__state--empty");
    if (states) out.empty = { w: Math.round(box(states).width), h: Math.round(box(states).height) };
  }
  return { problems, ...out };
};
