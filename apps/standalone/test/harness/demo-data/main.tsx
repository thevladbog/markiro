import "@markiro/ui/styles.css";
import "../../../src/app/shell.css";
import "../../../src/i18n/index.js";
import "../../../src/floor/floor-kit.css";
import "../../../src/floor/floor-status-bar.css";
import "../../../src/floor/work/work-screen.css";
import "../../../src/floor/shifts/shift-hub.css";

import {
  boxLabelFields,
  buildDefaultLabelTemplates,
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
} from "@markiro/domain";
import { createRoot } from "react-dom/client";

import { Button, ThemeProvider } from "@markiro/ui";

import { FloorChip } from "../../../src/floor/FloorChip.js";
import { LabelPanel } from "../../../src/floor/print/LabelPanel.js";
import type { PrintJob } from "../../../src/floor/print/print-jobs.js";
import { ShiftCard } from "../../../src/floor/shifts/ShiftCard.js";
import type { ShiftCopy } from "../../../src/floor/shifts/shift-copies.js";
import { ShiftBand } from "../../../src/floor/work/WorkInstruments.js";
import type { HostApi } from "../../../src/host/api.js";
import type {
  DemoDataSummary,
  OfficeLine,
  OfficeProduct,
  OfficeShift,
  OrgProfile,
} from "../../../src/host/protocol.js";
import { Office } from "../../../src/office/Office.js";
import type { OfficeSessionValue } from "../../../src/office/office-session.js";
import { BootstrapWizard } from "../../../src/wizard/BootstrapWizard.js";
import i18n from "../../../src/i18n/index.js";
import orgProfile from "../../../proto/fixtures/org-profile.json";
import officeShift from "../../../proto/fixtures/office-shift.json";
import officeLicense from "../../../proto/fixtures/office-license.json";
import exportSettings from "../../../proto/fixtures/export-settings.json";
import backupState from "../../../proto/fixtures/backup-state.json";
import demoProduct from "../../../proto/fixtures/office-product-demo.json";
import realProduct from "../../../proto/fixtures/office-product.json";

/**
 * A harness for the wizard's demo data (spec 2026-10-21), not a product screen: the real
 * components with fixed data, for a look in a browser. `view`: `wizard` (the wizard, the steps
 * done by hand), `office` (the office on a fake host: «Обзор», «Товары», «Смены»; `path`), `station`
 * (a demo shift's card, band, «Демо-код» and the label's preview).
 */
const query = new URLSearchParams(window.location.search);
const view = query.get("view") ?? "wizard";
const theme = query.get("theme") === "dark" ? "dark" : "light";

const LINE: OfficeLine = {
  id: "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  name: "Линия 1",
  archived: false,
  rev: 1,
};
const DEMO_PRODUCT = demoProduct as unknown as OfficeProduct;
const REAL_PRODUCT = realProduct as unknown as OfficeProduct;
const today = new Date().toISOString().slice(0, 10);
const DEMO_SHIFT = {
  ...(officeShift as unknown as OfficeShift),
  id: "9d1f7e2c-3b4a-4c5d-8e6f-7a8b9c0d1e2f",
  number: "DEMO-001",
  status: "planned",
  productId: DEMO_PRODUCT.id,
  lineId: LINE.id,
  counterpartyId: null,
  productionDate: today,
  plannedDate: today,
  plannedQty: 20,
  boxCapacity: 5,
  ownerDeviceId: null,
  openedAt: null,
} as OfficeShift;
const SUMMARY: DemoDataSummary = {
  present: true,
  productId: DEMO_PRODUCT.id,
  shifts: 1,
  boxes: 0,
  pallets: 0,
  codes: 0,
  activeShifts: [],
};
let demoPresent = true;

/** The host's answers the pages read; any other call never settles (the page shows it loading). */
const answers: Partial<Record<keyof HostApi, () => unknown>> = {
  getOrg: () => orgProfile as OrgProfile,
  listShifts: () => (demoPresent ? [DEMO_SHIFT] : []),
  listProducts: () => (demoPresent ? [DEMO_PRODUCT, REAL_PRODUCT] : [REAL_PRODUCT]),
  listLines: () => [LINE],
  listCounterparties: () => [],
  listTemplates: () => [],
  listProductGroups: () => [
    { code: 8, alias: "milk", name: "Молочная продукция" },
    { code: 13, alias: "water", name: "Упакованная вода" },
  ],
  listConflicts: () => ({ items: [], page: 1, pageCount: 1, total: 0 }),
  listDevices: () => [],
  getBackups: () => backupState,
  getLicense: () => officeLicense,
  getExportSettings: () => exportSettings,
  getHostNetwork: () => ({ addresses: [], port: 45710, confirmedAt: "2026-10-21T08:00:00Z" }),
  getDemoData: () =>
    demoPresent ? SUMMARY : { ...SUMMARY, present: false, productId: null, shifts: 0 },
  deleteDemoData: () => {
    demoPresent = false;
    return SUMMARY;
  },
};
const api = new Proxy({} as HostApi, {
  get:
    (_target, name: string) =>
    (..._args: unknown[]) => {
      const answer = answers[name as keyof HostApi];
      return answer === undefined ? new Promise(() => undefined) : Promise.resolve(answer());
    },
});
const session: OfficeSessionValue = {
  user: {
    id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
    login: "admin",
    name: "Ирина Смирнова",
    role: "admin",
  },
  api,
  call: (operation) => operation("token"),
  logout: () => undefined,
  refreshUser: async () => undefined,
} as OfficeSessionValue;

const template = buildDefaultLabelTemplates().find(
  (each) => each.name === DEFAULT_BOX_LABEL_TEMPLATE_NAME,
);
const JOB: PrintJob = {
  id: "job-1",
  shiftId: DEMO_SHIFT.id,
  purpose: "box",
  subjectId: "box-1",
  sscc: "029000000000000014",
  state: "failed",
  verify: false,
  templateId: "template-1",
  templateRev: 1,
  fields: boxLabelFields({
    sscc: "029000000000000014",
    itemCount: 5,
    productName: DEMO_PRODUCT.name,
    productPrintName: DEMO_PRODUCT.printName,
    gtin14: DEMO_PRODUCT.gtin14,
    egaisCode: null,
    shelfLifeDays: 365,
    operatorName: "Анна Кузнецова",
    counterpartyName: null,
    closedAt: new Date().toISOString(),
    productionDate: today,
    shiftNumber: "DEMO-001",
  }),
  printer: null,
  bytesBase64: null,
  errorCode: "printer_unconfigured",
  attempts: 0,
  operatorId: "operator-1",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const COPY = {
  id: DEMO_SHIFT.id,
  number: "DEMO-001",
  status: "planned",
  localState: null,
  mode: "aggregation",
  palletsEnabled: true,
  createdFrom: "office",
  lineId: LINE.id,
  productId: DEMO_PRODUCT.id,
  productName: DEMO_PRODUCT.name,
  productGtin14: DEMO_PRODUCT.gtin14,
  counterpartyName: null,
  productionDate: today,
  plannedDate: today,
  plannedQty: 20,
  boxCapacity: 5,
  boxTemplateId: "b",
  palletBoxCapacity: 2,
  palletTemplateId: "p",
  ownerDeviceId: null,
  openedAt: null,
  closedAt: null,
  entered: false,
} as unknown as ShiftCopy;

function Station() {
  const t = i18n.t.bind(i18n);
  const stage = query.get("stage") ?? "work";
  return (
    <div className="standalone-screen">
      <div className="floor-frame">
        <div className="station-status-bar" style={{ display: "flex", gap: 12, padding: 12 }}>
          <span>Линия 1 · Смена DEMO-001</span>
          <FloorChip
            kind="demo"
            tone="warn"
            icon="barcode"
            text={t("floor.demo.chip")}
            form="full"
          />
        </div>
        {stage === "hub" ? (
          <section className="station-screen shift-hub">
            <header className="station-screen__header" />
            <div className="station-screen__content">
              <div className="shift-selection__grid">
                <ShiftCard
                  copy={COPY}
                  action={{ kind: "open", enabled: true }}
                  busy={false}
                  onAction={() => undefined}
                />
              </div>
            </div>
          </section>
        ) : (
          <section className="work-screen" aria-label="Смена">
            <div className="work-screen__content">
              {stage === "label" && template !== undefined ? (
                <div className="work-screen__stage work-screen__label-stage" data-centred="true">
                  <LabelPanel
                    job={JOB}
                    busy={false}
                    note={null}
                    loadSettings={async () => ({
                      printers: [],
                      assignments: { box: null, pallet: null, duplicate: null },
                    })}
                    onPrintAgain={() => undefined}
                    onPrinted={() => undefined}
                    onSkip={() => window.alert("Готово: работа продолжается")}
                    demoPreview={template.spec}
                  />
                </div>
              ) : (
                <div className="work-screen__work">
                  <ShiftBand
                    productName={DEMO_PRODUCT.name}
                    gtin={DEMO_PRODUCT.gtin14}
                    number="DEMO-001"
                    counterpartyName={null}
                    accepted={3}
                    plannedQty={20}
                    modeLabel={t("floor.work.mode.aggregation")}
                  />
                  <div className="work-screen__demo" role="note">
                    <p>{t("floor.demo.work.body")}</p>
                    <Button size="floor" variant="secondary">
                      {t("floor.demo.work.code")}
                    </Button>
                  </div>
                  <div className="work-screen__instruments" data-layout="box" />
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Harness() {
  return (
    <ThemeProvider defaultTheme={theme}>
      {view === "office" ? (
        <Office session={session} initialPath={query.get("path") ?? "/"} />
      ) : view === "station" ? (
        <Station />
      ) : (
        <div className="standalone-screen" style={{ padding: 24 }}>
          <BootstrapWizard
            onSubmit={async (request) => window.alert(JSON.stringify(request.demoData))}
          />
        </div>
      )}
    </ThemeProvider>
  );
}

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<Harness />);
