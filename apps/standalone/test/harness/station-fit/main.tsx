import "@markiro/ui/styles.css";
import "../../../src/app/shell.css";
import "../../../src/i18n/index.js";
import "../../../src/floor/floor-kit.css";
import "../../../src/floor/floor-status-bar.css";

import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@markiro/ui";

import { FloorStatusBar } from "../../../src/floor/FloorStatusBar.js";
import { OperatorSignIn } from "../../../src/floor/OperatorSignIn.js";
import { NewShift } from "../../../src/floor/shifts/NewShift.js";
import { WorkstationSetup } from "../../../src/floor/setup/WorkstationSetup.js";
import { createPrintRuntime } from "../../../src/floor/print/print-runtime.js";
import type { LocalExecutor } from "../../../src/local/executor.js";
import { ENTITY_SET } from "../../../src/local/reference-sync.js";
import type { HostStatus } from "../../../src/host/protocol.js";
import { measureFit } from "./measure-fit.js";

/**
 * A layout harness for the floor screens that share the kit's controls: «Новая смена» and
 * «Рабочее место» (with the status bar above them), over a fake local database. Query: `view`
 * (newshift | setup | signin), `tab` (printer | scanner | sound | station), `pallets` (1 | 0), `long`
 * (long names), `printers` (count), `photo` (none | transparent | png | jpeg), `theme`. The
 * measurement is `measure-fit.ts`; the steps a case takes (a mode, an open keypad) are
 * `measure.mjs`'s, by clicks.
 */
const query = new URLSearchParams(window.location.search);
const view = query.get("view") ?? "newshift";
const long = query.get("long") === "1";
const printerCount = Number(query.get("printers") ?? "3");
const palletsOffered = query.get("pallets") !== "0";
const photoKind = query.get("photo") ?? "transparent";

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
  const media = kind === "jpeg" ? "image/jpeg" : "image/png";
  return { media, base64: canvas.toDataURL(media).split(",")[1] ?? "" };
}
const photoRow = drawPhoto(photoKind);

const HOST = "11111111-1111-4111-8111-111111111111";
const DEVICE = "22222222-2222-4222-8222-222222222222";
const PRODUCT = "33333333-3333-4333-8333-333333333333";
const TEMPLATE = "44444444-4444-4444-8444-444444444444";
const PALLET_TEMPLATE = "55555555-5555-4555-8555-555555555555";
const DUP_TEMPLATE = "66666666-6666-4666-8666-666666666666";

const printers = Array.from({ length: printerCount }, (_, i) => ({
  id: `p${i}`,
  name: long
    ? `Принтер этикеток Zebra ZT411 у линии розлива сидра № ${i + 1} (цех 2)`
    : `Zebra у линии ${i + 1}`,
  target:
    i % 3 === 0
      ? { kind: "tcp", host: `192.168.1.${50 + i}`, port: 9100 }
      : i % 3 === 1
        ? { kind: "windows", name: "ZDesigner ZT411-203dpi ZPL" }
        : { kind: "serial", port: `COM${3 + i}`, baud: 9600 },
  language: "zpl",
  dpi: 203,
}));

const settingsRows = [
  {
    key: "printers",
    value: JSON.stringify({
      printers,
      assignments: { box: printers[0]?.id ?? null, pallet: null, duplicate: null },
    }),
  },
  {
    key: "scanners",
    value: JSON.stringify([
      { port: "COM3", baud: 9600 },
      { port: "COM4", baud: 115200 },
    ]),
  },
];

const local: LocalExecutor = {
  query: ((sql: string) => {
    if (sql.includes("FROM sync_state")) {
      return Promise.resolve([
        { key: "last_rev", value: "100" },
        { key: "host_id", value: HOST },
        { key: "device_id", value: DEVICE },
        { key: "entity_set", value: ENTITY_SET },
      ]);
    }
    if (sql.includes("FROM ref_products")) {
      return Promise.resolve([
        {
          id: PRODUCT,
          gtin14: "04680089900017",
          name: long ? "Сидр полусухой «Дикий крест» яблочный 0,45 л стекло" : "Молоко 3,2% 0,9 л",
          print_name: null,
          chz_group_code: 5,
          box_capacity: 12,
          default_box_template_id: TEMPLATE,
          pallet_box_capacity: palletsOffered ? 2 : null,
          default_pallet_template_id: palletsOffered ? PALLET_TEMPLATE : null,
        },
      ]);
    }
    if (sql.includes("FROM ref_templates") && sql.includes("category_codes")) {
      return Promise.resolve([
        { id: TEMPLATE, name: "Короб 100x150", purpose: "box", enabled: 1, category_codes: null },
        {
          id: PALLET_TEMPLATE,
          name: "Паллета 100x150",
          purpose: "pallet",
          enabled: 1,
          category_codes: null,
        },
        {
          id: DUP_TEMPLATE,
          name: "Дубликат Data Matrix 40x30",
          purpose: "product_duplicate",
          enabled: 1,
          category_codes: null,
        },
      ]);
    }
    if (sql.includes("FROM ref_template_defaults")) return Promise.resolve([]);
    if (sql.includes("FROM ref_org")) {
      return Promise.resolve([
        {
          time_zone: "Europe/Moscow",
          default_box_template_id: null,
          default_pallet_template_id: null,
        },
      ]);
    }
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
    if (sql.includes("FROM workstation_settings")) return Promise.resolve(settingsRows);
    if (sql.includes("ref_operators") && sql.includes("count(*)"))
      return Promise.resolve([{ n: 3 }]);
    if (sql.includes("SELECT o.id, o.login, o.name FROM ref_operators")) {
      return Promise.resolve([
        { id: "o1", login: "0042", name: "Анна Кузнецова" },
        { id: "o2", login: "0043", name: "Пётр Иванов" },
        { id: "o3", login: "0044", name: "Богатырёва Анастасия Владиславовна" },
      ]);
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

const hardware = {
  listUsbPrinters: () => Promise.resolve([]),
  listSerialPorts: () => Promise.resolve(["COM3", "COM4", "COM7"]),
  configureScanners: () => Promise.resolve(undefined),
  watchScanners: (onSnapshot: (s: unknown) => void) => {
    onSnapshot({
      revision: 1,
      scanners: [
        { port: "COM3", baud: 9600, status: "connected" },
        { port: "COM4", baud: 115200, status: "disconnected" },
      ],
    });
    return Promise.resolve(() => undefined);
  },
} as never;

const printing = createPrintRuntime(() => Promise.resolve({ sent: true }));

const LINK: HostStatus = { state: "online", lastContactAt: null, lastError: null, seq: 1 };

function Page() {
  return (
    <ThemeProvider defaultTheme={query.get("theme") === "dark" ? "dark" : "light"}>
      <div className="standalone-screen">
        <div className="floor-frame">
          <FloorStatusBar
            local={local}
            pairing={{ hostId: HOST, deviceId: DEVICE }}
            lineId={null}
            operator={
              view === "signin"
                ? null
                : { id: "o", login: "0042", name: "Анна Кузнецова", role: null }
            }
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
          {view === "signin" && (
            <OperatorSignIn
              local={local}
              pairing={{ hostId: HOST, deviceId: DEVICE }}
              lineId={null}
              sync={{ kind: "done", synced: 1, failure: null, quarantined: 0 }}
              notice={null}
              source={source}
              onSignedIn={() => undefined}
              onSync={() => undefined}
              onOffice={() => undefined}
              onScannerSettings={() => undefined}
            />
          )}
          {view === "newshift" && (
            <NewShift
              local={local}
              pairing={{ hostId: HOST, deviceId: DEVICE }}
              online
              source={source}
              create={() => Promise.reject(new Error("harness"))}
              enter={() => Promise.reject(new Error("harness"))}
              onEntered={() => undefined}
              onHostError={() => undefined}
              onBack={() => undefined}
            />
          )}
          {view === "setup" && (
            <WorkstationSetup
              local={local}
              hardware={hardware}
              printing={printing}
              source={source}
              facts={{
                name: "Станция 1 · Линия 1",
                device: "7f3a1c2e…c21d",
                host: "192.168.1.10:8443",
              }}
              onSaved={() => undefined}
              onBack={() => undefined}
              initialTab={(query.get("tab") ?? "printer") as "printer"}
            />
          )}
        </div>
      </div>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);

(window as unknown as { __inspect: () => unknown }).__inspect = measureFit;
