import "@markiro/ui/styles.css";
import "../../../src/app/shell.css";
import "../../../src/i18n/index.js";
import "../../../src/floor/floor-kit.css";
import "../../../src/floor/floor-status-bar.css";

import { createRoot } from "react-dom/client";

import { Button, ThemeProvider } from "@markiro/ui";

import type { LocalExecutor } from "../../../src/local/executor.js";
import { ShiftCard, type CardAction } from "../../../src/floor/shifts/ShiftCard.js";
import type { ShiftCopy } from "../../../src/floor/shifts/shift-copies.js";
import { PalletStrip } from "../../../src/floor/pallets/PalletStrip.js";
import { FloorFooter } from "../../../src/floor/shifts/FloorScreen.js";
import { ScanHistory } from "../../../src/floor/work/ScanHistory.js";
import type { ScanHistoryRow } from "../../../src/floor/work/scan-history.js";
import {
  BoxFill,
  FooterAction,
  LastScan,
  ShiftBand,
  WorkFacts,
} from "../../../src/floor/work/WorkInstruments.js";
import "../../../src/floor/work/work-screen.css";

/**
 * A layout harness, not a product screen: the work screen's real components in the work
 * screen's real wrapper markup (WorkScreen.tsx, «return (<section className="work-screen">»),
 * with fixed fixtures, for the layout measurement in `measure.mjs`. Query: `mode`
 * (agg | pallets | check | plain), `capacity`, `items`, `rows`, `theme`.
 */
const query = new URLSearchParams(window.location.search);
const mode = query.get("mode") ?? "pallets";
const capacity = Number(query.get("capacity") ?? "3");
const items = Math.min(capacity, Number(query.get("items") ?? "1"));
const rowCount = Number(query.get("rows") ?? "8");
const validation = mode === "check";
const photoKind = query.get("photo") ?? "none";

/** A bottle-ish picture drawn on a canvas: transparent PNG, opaque PNG (white), or a JPEG. */
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
const fakeLocal: LocalExecutor | undefined =
  photoRow === null
    ? undefined
    : {
        query: (() =>
          Promise.resolve([
            {
              checksum: `fake-${photoKind}`,
              data_base64: photoRow.base64,
              media_type: photoRow.media,
            },
          ])) as LocalExecutor["query"],
        transaction: () => Promise.resolve([]),
      };

const hubCopy = (number: string, name: string): ShiftCopy =>
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
    productGtin14: "04680089900017",
    counterpartyName: "ООО «Атолл»",
    productionDate: "2026-10-16",
    plannedDate: "2026-10-16",
    plannedQty: 600,
    boxCapacity: 12,
    boxTemplateId: "b",
    palletBoxCapacity: null,
    palletTemplateId: null,
    ownerDeviceId: null,
    openedAt: null,
    closedAt: null,
    entered: false,
  }) as unknown as ShiftCopy;
const OPEN: CardAction = { kind: "open", enabled: true };
const pallets = mode === "pallets";
const SERIAL_POOL = [
  "2L=o8Zk3VqXp1",
  "9Qw7TbN0cH4mLd",
  "kP3x/ZaR5vY8",
  "A1b2C3d4E5f6G7h8I9j0",
  "x",
];

const rows: ScanHistoryRow[] = Array.from({ length: rowCount }, (_, index) => {
  const serial = SERIAL_POOL[index % SERIAL_POOL.length] ?? "x";
  return {
    id: `row-${index}`,
    scannedAt: new Date(Date.UTC(2026, 9, 16, 9, 0, 59 - index)).toISOString(),
    verdict: index % 5 === 3 ? "duplicate" : "ok",
    duplicateSource: index % 5 === 3 ? "local" : null,
    operatorName: "Иванов",
    boxPosition: index + 1,
    maskedCode: `04680089900017 …${serial.slice(-4)}`,
    gtin14: "04680089900017",
    serial,
  } as ScanHistoryRow;
});

function Hub() {
  return (
    <ThemeProvider defaultTheme={query.get("theme") === "dark" ? "dark" : "light"}>
      <div className="standalone-screen">
        <div className="floor-frame">
          <div />
          <section className="station-screen shift-hub">
            {/* The screen's three rows (title, content, actions): the card takes the content row's height. */}
            <header className="station-screen__header" />
            <div className="station-screen__content">
              <div className="shift-selection__grid">
                <ShiftCard
                  copy={hubCopy("№ 12", "Сидр «Яблочный» полусладкий газированный 0,45 л")}
                  action={OPEN}
                  busy={false}
                  onAction={() => undefined}
                  {...(fakeLocal === undefined ? {} : { local: fakeLocal })}
                />
                <ShiftCard
                  copy={hubCopy("№ 13", "Вода")}
                  action={OPEN}
                  busy={false}
                  onAction={() => undefined}
                  {...(fakeLocal === undefined ? {} : { local: fakeLocal })}
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </ThemeProvider>
  );
}

function Harness() {
  return (
    <ThemeProvider defaultTheme={query.get("theme") === "dark" ? "dark" : "light"}>
      <div className="standalone-screen">
        <div className="floor-frame">
          <div className="station-status-bar">
            <span>status</span>
          </div>
          <section className="work-screen" aria-label="Смена">
            <div className="work-screen__content">
              <div className="work-screen__work">
                <ShiftBand
                  productName="Сидр «Яблочный» полусладкий газированный 0,45 л"
                  gtin="04680089900017"
                  number="№ 12"
                  counterpartyName="ООО «Атолл»"
                  {...(fakeLocal === undefined ? {} : { local: fakeLocal, productId: "p" })}
                  accepted={items}
                  plannedQty={600}
                  modeLabel={validation ? "Проверка" : "Агрегация"}
                  {...(validation ? { refused: { duplicates: 1, errors: 0 } } : {})}
                />
                <div
                  className="work-screen__instruments"
                  data-layout={validation ? "validation" : "box"}
                >
                  <div className="work-screen__primary">
                    {validation ? (
                      <LastScan
                        word="Принято"
                        text=""
                        tone="ok"
                        code={null}
                        time="09:00:59"
                        cued={false}
                        lineRef={null}
                      />
                    ) : (
                      <BoxFill
                        items={items}
                        capacity={capacity}
                        acceptedToken={1}
                        serials={rows.map((row) => row.serial ?? "").slice(0, items)}
                        actions={
                          <>
                            <Button size="floor" variant="secondary" data-action="close-box">
                              Закрыть короб
                            </Button>
                            <Button
                              size="floor"
                              variant="secondary"
                              data-action="box-undo"
                              aria-label="Снять последний код"
                            >
                              Снять последний
                            </Button>
                            <Button size="floor" variant="secondary" data-action="box-clear">
                              Очистить короб
                            </Button>
                          </>
                        }
                      />
                    )}
                    {pallets && (
                      <PalletStrip
                        boxCount={0}
                        capacity={2}
                        closeDisabled={false}
                        onClose={() => undefined}
                      />
                    )}
                  </div>
                  <div className="work-screen__secondary">
                    {!validation && (
                      <LastScan
                        word="Принято"
                        text=""
                        tone="ok"
                        code={{ gtin14: "04680089900017", serial: "2L=o8Zk3VqXp1", fallback: "" }}
                        time="09:00:59"
                        cued={false}
                        lineRef={null}
                      />
                    )}
                    <WorkFacts
                      facts={
                        validation
                          ? []
                          : [
                              { term: "Закрыто коробов", value: "4" },
                              { term: "Последний SSCC", value: "(00) 4680089900000012" },
                            ]
                      }
                    />
                    <ScanHistory
                      read={{ kind: "ready", rows, total: Math.max(rows.length, 40) }}
                      onOpenAll={() => undefined}
                    />
                  </div>
                </div>
              </div>
            </div>
            <FloorFooter ariaLabel="Действия" className="work-footer">
              <FooterAction variant="secondary">Исключения</FooterAction>
              <FooterAction variant="warning-outline">Выйти</FooterAction>
              <FooterAction variant="destructive-outline">Закрыть смену</FooterAction>
            </FloorFooter>
          </section>
        </div>
      </div>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  query.get("view") === "hub" ? <Hub /> : <Harness />,
);
