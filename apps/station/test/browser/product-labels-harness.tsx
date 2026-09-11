import "@markiro/ui/styles.css";
import "../../src/station.css";
import "../../src/i18n/index.js";
import type {} from "./product-labels-types.js";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, Button } from "@markiro/ui";
import { buildDuplicateLabelTemplate, productLabelValueDigest } from "@markiro/domain";
import i18n from "../../src/i18n/index.js";
import { applyMigrations, upsertBundle, type SqlExecutor } from "../../src/lib/mirror.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
} from "../../src/lib/credential-recovery.js";
import { createHardwareScanSource, type HardwareContract } from "../../src/lib/hardware.js";
import { FloorShell } from "../../src/ui/FloorShell.js";
import { NewShift } from "../../src/pages/NewShift.js";
import { createStationClient } from "../../src/lib/api-client.js";
import { WorkScreen } from "../../src/pages/WorkScreen.js";
const query = new URLSearchParams(location.search);
const id = query.get("id");
if (!id) throw new Error("fixture id required");
const verification = query.get("verification") === "none" ? "none" : "required";
const raw = ']d2010460000000001521SERIAL-42\u001d91Key1\u001d92Crypto(93)^FNC1"tail';
const shiftId = "11111111-1111-4111-8111-111111111111";
const operatorId = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";
const productId = "44444444-4444-4444-8444-444444444444";
const template = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Дубликат 58×40",
  spec: buildDuplicateLabelTemplate(),
};
const generation = createCredentialGeneration(`browser-fixture-${id}`);
const listeners = new Set<(raw: string) => void>();
let transport: "sent" | "unknown" | "hold" = "sent";
async function rpc<T>(operation: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await fetch("/__product_labels_sql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-browser-fixture": "product-labels" },
    body: JSON.stringify({ id, operation, sql, params }),
  });
  const body: { value: T[]; error?: string } = await result.json();
  if (body.error) throw new Error(body.error);
  return body.value;
}
const exec: SqlExecutor = {
  run: async (sql, params) => {
    await rpc("run", sql, params);
  },
  all: <T,>(sql: string, params?: unknown[]) => rpc<T>("all", sql, params),
};
const hardware: HardwareContract = {
  listScannerPorts: async () => [],
  listUsbPrinters: async () => [],
  openScanner: async () => {},
  closeScanner: async () => {},
  onScannerStatus: async () => () => {},
  onScan: async (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  print: async (_target, bytes) => {
    const key = `mock-print-${id}`;
    const calls: string[] = JSON.parse(localStorage.getItem(key) ?? "[]");
    calls.push(btoa(String.fromCharCode(...bytes)));
    localStorage.setItem(key, JSON.stringify(calls));
    if (transport === "unknown") throw new Error("mock transport lost");
    if (transport === "hold") await new Promise<void>(() => {});
  },
};
const source = createHardwareScanSource(hardware);
window.__productLabels = {
  scan: (value = raw) => {
    for (const listener of listeners) listener(value);
  },
  ready: () =>
    listeners.size === 1 &&
    document.body.textContent?.includes(i18n.t("productLabels.title")) === true,
  setTransport: (mode) => {
    transport = mode;
  },
  inspect: async () => {
    const [count] = await exec.all<{ n: number }>("SELECT count(*) n FROM codes_mirror");
    const [job] = await exec.all<{ status: string }>(
      "SELECT status FROM product_label_jobs LIMIT 1",
    );
    const attempts = await exec.all<{ attempt_id: string }>(
      "SELECT attempt_id FROM product_label_attempts ORDER BY attempt_no",
    );
    const events = await exec.all<{ kind: string }>(
      "SELECT json_extract(event_json,'$.kind') kind FROM product_label_events ORDER BY sequence",
    );
    return {
      accepted: count?.n ?? 0,
      prints: (JSON.parse(localStorage.getItem(`mock-print-${id}`) ?? "[]") as string[]).length,
      status: job?.status ?? null,
      attempts: attempts.length,
      bytes: JSON.parse(localStorage.getItem(`mock-print-${id}`) ?? "[]") as string[],
      events: events.map((e) => e.kind),
    };
  },
};
const creationClient = createStationClient({
  machineId: "browser-fixture",
  serverUrl: `${location.origin}/__product_labels_api`,
});
function Fixture() {
  const [created, setCreated] = useState(false);

  const [paused, setPaused] = useState(false);
  if (query.get("screen") === "newshift")
    return created ? (
      <p role="status">Смена открыта</p>
    ) : (
      <NewShift
        client={creationClient}
        source={source}
        hardwareConfig={{
          scanner: null,
          printer: { kind: "tcp", host: "mock-printer.invalid", port: 9100 },
          printerLanguage: "zpl",
          printerDpi: 203,
          verifyPrintedLabel: false,
        }}
        onStarted={() => setCreated(true)}
        onBack={() => setPaused(true)}
      />
    );
  return paused ? (
    <Button size="floor" onClick={() => setPaused(false)}>
      Продолжить смену
    </Button>
  ) : (
    <WorkScreen
      exec={exec}
      shiftId={shiftId}
      terminalId="browser-terminal"
      operatorId={operatorId}
      expectedGtin14="04600000000015"
      productName="Кега светлого пива, 30 л"
      source={source}
      sound={{ muted: true, volume: 0 }}
      issuerPrefix={null}
      boxCapacity={null}
      verifyPrintedLabel={false}
      pendingSync={0}
      onExit={() => setPaused(true)}
      productLabelEnvironment={{
        generation,
        deviceId,
        operatorName: "Мария Волкова",
        hardwareConfig: {
          scanner: null,
          printer: { kind: "tcp", host: "mock-printer.invalid", port: 9100 },
          printerLanguage: "zpl",
          printerDpi: 203,
          verifyPrintedLabel: false,
        },
        print: hardware.print,
      }}
    />
  );
}
async function bootstrap() {
  await i18n.changeLanguage(query.get("locale") === "en" ? "en" : "ru");
  await credentialGenerationOwnership(generation);
  await applyMigrations(exec);
  if (!(await exec.all("SELECT id FROM shift_mirror")).length)
    await upsertBundle(exec, {
      shift: {
        id: shiftId,
        status: "active",
        mode: "validation",
        productId,
        productName: "Кега светлого пива, 30 л",
        lineId: null,
        lineName: null,
        counterpartyId: null,
        counterpartyName: null,
        labelTemplateId: null,
        labelTemplateName: null,
        plannedQty: 120,
        plannedDate: "2026-09-08",
        productionDate: "2026-09-08",
        boxCapacity: null,
        palletBoxCapacity: null,
        palletsEnabled: false,
        openedAt: "2026-09-08T10:00:00.000Z",
        number: "SEP26-001",
        validationPrint: {
          mode: "duplicate_dm",
          verification,
          templateId: template.id,
          snapshot: { ...template, digest: productLabelValueDigest(template) },
          policyRevision: "66666666-6666-4666-8666-666666666666",
        },
      },
      product: {
        id: productId,
        name: "Кега светлого пива, 30 л",
        gtin14: "04600000000015",
        productGroup: null,
        boxCapacity: null,
        palletBoxCapacity: null,
        status: "active",
        defaultCounterpartyId: null,
        defaultLabelTemplateId: null,
        printName: null,
        egaisCode: null,
        shelfLifeDays: 30,
      },
      labelTemplate: null,
      boxLabelTemplate: null,
      counterpartyGln: null,
      operators: [],
      sscc: null,
    });
  const root = document.getElementById("root");
  if (!root) throw new Error("fixture root missing");
  createRoot(root).render(
    <ThemeProvider defaultTheme={query.get("theme") === "light" ? "light" : "dark"}>
      <QueryClientProvider client={new QueryClient()}>
        <FloorShell
          stationName="Станция упаковки 01"
          lineName="Линия кег"
          operatorName="Мария Волкова"
          shiftLabel="SEP26-001"
          serverReachability="unreachable"
          scanner="connected"
          printerConfigured
          syncPending={0}
          syncStuck={false}
          conflicts={0}
          statusBarCollapsible
        >
          <Fixture />
        </FloorShell>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}
void bootstrap().catch((error) => {
  document.body.textContent = String(error);
  throw error;
});
