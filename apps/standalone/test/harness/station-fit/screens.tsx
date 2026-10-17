import "@markiro/ui/styles.css";
import "../../../src/app/shell.css";
import "../../../src/i18n/index.js";
import "../../../src/floor/floor-kit.css";
import "../../../src/floor/floor-status-bar.css";
import "../../../src/floor/work/work-screen.css";

import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@markiro/ui";

import { FloorStatusBar } from "../../../src/floor/FloorStatusBar.js";
import { Reconfirm } from "../../../src/floor/Reconfirm.js";
import { ShiftClosePanel, ShiftClosedPanel } from "../../../src/floor/close/ShiftClosePanel.js";
import type { CloseSummary } from "../../../src/floor/close/shift-close.js";
import { ExceptionFlow } from "../../../src/floor/exceptions/ExceptionFlow.js";
import { FloorFooter } from "../../../src/floor/shifts/FloorScreen.js";
import { UnitLabelHistory } from "../../../src/floor/unit-labels/UnitLabelHistory.js";
import { FooterAction } from "../../../src/floor/work/WorkInstruments.js";
import { ScanHistoryScreen } from "../../../src/floor/work/ScanHistory.js";
import type { LocalExecutor } from "../../../src/local/executor.js";
import { ENTITY_SET } from "../../../src/local/reference-sync.js";
import type { HostStatus } from "../../../src/host/protocol.js";
import { measureFit } from "./measure-fit.js";

/**
 * A layout harness, not a product screen: the work screen's stages (exceptions, the close and the
 * closed shift, the full scan history, the labels' history) in the work screen's real wrapper
 * markup (section.work-screen > the overlays' stage + the footer), and the re-confirmation card,
 * with the real status bar, over fixed fixtures; for the measuring guard (`measure-screens.mjs`).
 * Query: `view` (exceptions | close | closed | history | unithistory | reconfirm), `variant`,
 * `theme`.
 */
const query = new URLSearchParams(window.location.search);
const view = query.get("view") ?? "exceptions";
const variant = query.get("variant") ?? "";

const HOST = "11111111-1111-4111-8111-111111111111";
const DEVICE = "22222222-2222-4222-8222-222222222222";
const SHIFT = "77777777-7777-4777-8777-777777777777";
const PAIRING = { hostId: HOST, deviceId: DEVICE };
const SERIALS = ["2L=o8Zk3VqXp1", "9Qw7TbN0cH4mLd", "kP3x/ZaR5vY8", "A1b2C3d4E5f6G7h8I9j0", "x"];

const scanRows = Array.from({ length: 30 }, (_, index) => ({
  id: `row-${index}`,
  scanned_at: new Date(Date.UTC(2026, 9, 16, 9, 0, 59 - index)).toISOString(),
  verdict: index % 5 === 3 ? "duplicate" : "ok",
  duplicate_source: index % 5 === 3 ? "local" : null,
  gtin14: "04680089900017",
  serial: SERIALS[index % SERIALS.length] ?? "x",
  operator_name: "Иванов Иван Иванович",
  box_position: index + 1,
}));

const local: LocalExecutor = {
  query: ((sql: string, params: unknown[]) => {
    if (sql.includes("FROM sync_state")) {
      return Promise.resolve([
        { key: "last_rev", value: "100" },
        { key: "host_id", value: HOST },
        { key: "device_id", value: DEVICE },
        { key: "entity_set", value: ENTITY_SET },
      ]);
    }
    if (sql.includes("FROM floor_scans AS s")) {
      const limit = Number(params[3] ?? 7);
      const offset = Number(params[4] ?? 0);
      return Promise.resolve(scanRows.slice(offset, offset + limit));
    }
    if (sql.includes("count(*) AS n FROM floor_scans")) {
      return Promise.resolve([{ n: scanRows.length }]);
    }
    if (sql.includes("ref_operators") && sql.includes("count(*)"))
      return Promise.resolve([{ n: 3 }]);
    if (sql.includes("SELECT o.id, o.login, o.name FROM ref_operators")) {
      return Promise.resolve([{ id: "o1", login: "0042", name: "Анна Кузнецова" }]);
    }
    if (sql.includes("count(*)")) return Promise.resolve([{ n: 0 }]);
    return Promise.resolve([]);
  }) as LocalExecutor["query"],
  transaction: () => Promise.resolve([]),
};

const source = {
  start: () => () => undefined,
  clearPendingInput: () => undefined,
  setManualTextEntryActive: () => undefined,
};

const LINK: HostStatus = { state: "online", lastContactAt: null, lastError: null, seq: 1 };

/** An SSCC-18: the extension digit, a company prefix, a serial, and the GS1 check digit. */
function sscc(serial: number): string {
  const body = `0468008990${String(serial).padStart(7, "0")}`;
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    sum += Number(body[16 - index]) * (index % 2 === 0 ? 3 : 1);
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

const boxes = Array.from({ length: 5 }, (_, index) => ({
  id: `box-${index}`,
  sscc: sscc(10 + index),
  itemCount: 12,
  closedAt: "2026-10-16T09:00:00.000Z",
}));
const pallets = Array.from({ length: 2 }, (_, index) => ({
  id: `pallet-${index}`,
  sscc: sscc(120 + index),
  boxCount: 2,
  closedAt: "2026-10-16T09:00:00.000Z",
}));

const PLAIN: CloseSummary = {
  plannedQty: 600,
  actualQty: 600,
  closedBoxes: 50,
  reasonRequired: false,
  blocker: null,
};
const SUMMARIES: Record<string, CloseSummary> = {
  plain: PLAIN,
  reason: { ...PLAIN, actualQty: 540, closedBoxes: 45, reasonRequired: true },
  openbox: {
    ...PLAIN,
    actualQty: 545,
    closedBoxes: 45,
    reasonRequired: true,
    blocker: { kind: "open_box", items: 5 },
  },
  label: {
    ...PLAIN,
    actualQty: 540,
    closedBoxes: 45,
    reasonRequired: true,
    blocker: { kind: "label" },
  },
  pallet: {
    ...PLAIN,
    actualQty: 540,
    closedBoxes: 45,
    reasonRequired: true,
    blocker: { kind: "open_pallet", boxes: 1 },
  },
};

const unitEntries = Array.from({ length: 6 }, (_, index) => ({
  id: `job-${index}`,
  shiftId: SHIFT,
  codeHash: "x",
  scanId: `s${index}`,
  attemptNo: 1 + (index % 2),
  attemptState: index === 4 ? "prepared" : "sent",
  verificationPolicy: "none",
  verification: { kind: "none" },
  reason: null,
  errorCode: null,
  printMode: "raw",
  language: "zpl",
  dpi: 203,
  bytesDigest: "d",
  payloadDigest: "p",
  templateId: "t",
  templateRev: 1,
  fields: { "km.code": `0104680089900017215Zk3VqXp${index}` },
  operatorId: "o1",
  createdAt: "2026-10-16T09:00:00.000Z",
  updatedAt: "2026-10-16T09:00:00.000Z",
}));

function Stage() {
  const noop = () => undefined;
  return (
    <>
      {view === "exceptions" && (
        <ExceptionFlow
          openItems={variant === "empty" ? 0 : 5}
          boxes={variant === "empty" ? [] : boxes}
          {...(variant === "nopallets" ? {} : { pallets })}
          onUndo={() => Promise.resolve({ kind: "done", action: "undo" })}
          onClear={() => Promise.resolve({ kind: "done", action: "clear" })}
          onReprint={() => Promise.resolve({ kind: "label" })}
          onDisassemble={() => Promise.resolve({ kind: "done", action: "disassemble" })}
          onPalletReprint={() => Promise.resolve({ kind: "label" })}
          onPalletDisassemble={() =>
            Promise.resolve({ kind: "done", action: "pallet_disassemble" })
          }
          loadSettings={() =>
            Promise.resolve({
              printers: [
                {
                  id: "p1",
                  name: "Zebra у линии 1",
                  target: { kind: "tcp", host: "192.168.1.50", port: 9100 },
                  language: "zpl",
                  dpi: 203,
                },
              ],
              assignments: variant === "noprinter" ? {} : { box: "p1" },
            } as never)
          }
          onSetup={noop}
          registerScan={noop}
          onTextEntry={noop}
          onBack={noop}
        />
      )}
      {view === "close" && (
        <ShiftClosePanel
          number="№ 12"
          productName="Сидр «Яблочный» полусладкий газированный 0,45 л"
          summary={SUMMARIES[variant === "" ? "plain" : variant] ?? PLAIN}
          note={variant === "note" ? "failed" : null}
          attempt={0}
          waitingSscc={variant === "label" ? sscc(11) : null}
          busy={false}
          onClose={noop}
          onBack={noop}
          onLabel={noop}
          palletCapacity={variant === "pallet" || variant === "reason" ? 2 : null}
          onClosePallet={noop}
        />
      )}
      {view === "closed" && (
        <ShiftClosedPanel
          number="№ 12"
          record={{ actualQty: 540, closedBoxCount: 45 }}
          linkHeld={variant === "held"}
          leaving={false}
          onDone={noop}
        />
      )}
      {view === "history" && (
        <ScanHistoryScreen
          local={local}
          pairing={PAIRING}
          shiftId={SHIFT}
          refreshKey={0}
          onBack={noop}
        />
      )}
      {view === "unithistory" && (
        <UnitLabelHistory
          entries={variant === "empty" ? [] : (unitEntries as never)}
          failure={null}
          busy={false}
          blocked={false}
          closed={variant === "closed"}
          onReprint={noop}
          onBack={noop}
        />
      )}
    </>
  );
}

function Page() {
  return (
    <ThemeProvider defaultTheme={query.get("theme") === "dark" ? "dark" : "light"}>
      <div className="standalone-screen">
        <div className="floor-frame">
          <FloorStatusBar
            local={local}
            pairing={PAIRING}
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
          <section className="work-screen" aria-label="Смена">
            <div className="work-screen__content" />
            <div className="work-screen__overlays">
              {view === "close" || view === "closed" ? (
                <div className="work-screen__stage" data-centred="true">
                  <Stage />
                </div>
              ) : (
                <div className="work-screen__stage">
                  <Stage />
                </div>
              )}
            </div>
            <FloorFooter ariaLabel="Действия" className="work-footer">
              <FooterAction variant="secondary">Исключения</FooterAction>
              <FooterAction variant="warning-outline">Выйти</FooterAction>
              <FooterAction variant="destructive-outline">Закрыть смену</FooterAction>
            </FloorFooter>
          </section>
          {view === "reconfirm" && (
            <Reconfirm
              open
              title="Выйти из полноэкранного режима?"
              detail="Подтвердите, что это вы: приложите бейдж или введите номер и PIN."
              confirmLabel="Выйти из режима"
              local={local}
              pairing={PAIRING}
              source={source as never}
              onMute={() => undefined}
              expectedOperatorId={null}
              onConfirmed={() => undefined}
              onCancel={() => undefined}
            />
          )}
        </div>
      </div>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
(window as unknown as { __inspect: () => unknown }).__inspect = measureFit;
