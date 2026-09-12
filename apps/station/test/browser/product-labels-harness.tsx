import {
  applyValidationOutcomes,
  refreshValidationHistory,
} from "../../src/lib/validation-reprocessing.js";
import "@markiro/ui/styles.css";
import "../../src/station.css";
import "../../src/i18n/index.js";
import type {} from "./product-labels-types.js";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, Button } from "@markiro/ui";
import {
  buildDuplicateLabelTemplate,
  productLabelValueDigest,
  kmHash,
  parseDuplicateKm,
  validationPrintInputSchema,
} from "@markiro/domain";
import i18n from "../../src/i18n/index.js";
import { applyMigrations, upsertBundle, type SqlExecutor } from "../../src/lib/mirror.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
} from "../../src/lib/credential-recovery.js";
import { createHardwareScanSource, type HardwareContract } from "../../src/lib/hardware.js";
import { FloorShell } from "../../src/ui/FloorShell.js";
import { NewShift } from "../../src/pages/NewShift.js";
import { createStationClient, type StationClient } from "../../src/lib/api-client.js";
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
  configureScanners: async () => {},
  closeScanner: async () => {},
  onScannerConnections: async () => () => {},
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
    const [count] = await exec.all<{ n: number }>(
      "SELECT count(*) n FROM station_processed_codes WHERE shift_id='11111111-1111-4111-8111-111111111111'",
    );
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
const routedCreationClient = createStationClient({
  machineId: "browser-fixture",
  serverUrl: `${location.origin}/__product_labels_api`,
});
// Opt-in standalone fixture for visible browser actions; default keeps Playwright routing intact.
let fixtureCreateBody: unknown = null;
let fixturePrint = validationPrintInputSchema.parse({ mode: "none" });
const creationClient: StationClient =
  query.get("api") === "fixture"
    ? {
        async get<T>(path: string): Promise<T> {
          if (path.startsWith("/products?"))
            return {
              items: [
                {
                  id: productId,
                  gtin14: "04600000000015",
                  name: "Кега светлого пива, 30 л",
                  boxCapacity: null,
                },
              ],
            } as T;
          if (path.startsWith("/shifts/planning-config?"))
            return {
              validationPrintProtocol: "validation-dm-duplicate-v1",
              ...(query.get("support") === "legacy"
                ? {}
                : { validationReprocessingProtocol: "validation-reprocessing-v1" }),
            } as T;
          if (path.startsWith("/shifts/product-label-templates"))
            return {
              items: [
                { id: template.id, name: template.name, widthMm: 58, heightMm: 40, dpi: 203 },
              ],
            } as T;
          throw new Error("Unexpected standalone fixture GET");
        },
        async post<T>(path: string, body?: unknown): Promise<T> {
          if (path === "/products/gtin-check")
            return { gtin14: "04600000000015", owner: "own" } as T;
          if (path === "/shifts") {
            fixtureCreateBody = structuredClone(body);
            if (typeof body !== "object" || body === null || !("validationPrint" in body))
              throw new Error("Expected fixture print policy");
            fixturePrint = validationPrintInputSchema.parse(body.validationPrint);
            return {
              id: shiftId,
              productionDate: "productionDate" in body ? body.productionDate : null,
            } as T;
          }
          if (path === `/shifts/${shiftId}/open`)
            return {
              id: shiftId,
              status: "active",
              mode: "validation",
              validationPrint:
                fixturePrint.mode === "duplicate_dm"
                  ? {
                      ...fixturePrint,
                      snapshot: { ...template, digest: productLabelValueDigest(template) },
                      policyRevision: "66666666-6666-4666-8666-666666666666",
                    }
                  : {
                      mode: "none",
                      verification: "none",
                      templateId: null,
                      snapshot: null,
                      policyRevision: null,
                    },
            } as T;
          throw new Error("Unexpected standalone fixture POST");
        },
        async download() {
          return new Blob();
        },
        async whoami() {
          return { ok: true };
        },
      }
    : routedCreationClient;
function FixtureControls() {
  const [summary, setSummary] = useState("");
  const [expanded, setExpanded] = useState(false);
  const inspectSummary = async () => {
    const { bytes: omitted, ...facts } = await window.__productLabels.inspect();
    void omitted;
    setSummary(
      JSON.stringify({
        ...facts,
        ...(fixtureCreateBody ? { createRequest: fixtureCreateBody } : {}),
      }),
    );
  };
  async function receipt(outcome: "reprocessed" | "conflict") {
    const owner = await credentialGenerationOwnership(generation);
    if (!owner) return;
    const rows = await exec.all<{ shiftId: string; codeHash: string; scannedAt: string }>(
      "SELECT shift_id AS shiftId,code_hash AS codeHash,scanned_at AS scannedAt FROM validation_occurrences",
    );
    await applyValidationOutcomes(
      exec,
      owner,
      rows.map((row) => ({ ...row, outcome })),
    );
    await inspectSummary();
  }
  return (
    <aside
      aria-label="Тестовый стенд"
      style={{
        position: "fixed",
        top: 8,
        right: 8,
        zIndex: 10000,
        maxWidth: "min(440px,calc(100vw - 16px))",
        padding: 8,
        background: "var(--color-bg-primary, #202428)",
        border: "1px solid gray",
      }}
    >
      <Button onClick={() => setExpanded((value) => !value)}>
        {expanded ? "Скрыть тестовый стенд" : "Тестовый стенд"}
      </Button>
      {expanded ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 8 }}>
          <Button
            onClick={() =>
              window.__productLabels.scan(
                query.get("screen") === "newshift" ? "04600000000015" : raw,
              )
            }
          >
            {query.get("screen") === "newshift" ? "Сканировать GTIN" : "Сканировать тестовый КМ"}
          </Button>
          <Button
            onClick={() => {
              transport = "unknown";
            }}
          >
            Потеря ответа принтера
          </Button>
          <Button onClick={() => void receipt("reprocessed")}>Сервер: повтор принят</Button>
          <Button onClick={() => void receipt("conflict")}>Сервер: конфликт</Button>
          <Button onClick={() => void inspectSummary()}>Проверить факты</Button>
          <output style={{ overflowWrap: "anywhere", width: "100%" }}>{summary}</output>
        </div>
      ) : null}
    </aside>
  );
}
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
          allowPreviouslyAcceptedCodes: query.get("repeat") === "true",
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
  const scenario = query.get("history");
  if (
    scenario &&
    scenario !== "unknown" &&
    !(await exec.all("SELECT shift_id FROM validation_history_publications")).length
  ) {
    const hash = kmHash(parseDuplicateKm(raw));
    const sourceShift = "77777777-7777-4777-8777-777777777777";
    if (scenario === "closed")
      await exec.run(
        "INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
        [hash, sourceShift, "04600000000015", "SERIAL-42", "2026-09-01T10:00:00.000Z"],
      );
    const page = {
      protocol: "validation-reprocessing-v1",
      shiftId,
      productId,
      snapshot: "a".repeat(64),
      fetchedAt: "2026-09-12T10:00:00.000Z",
      expiresAt: "2026-09-12T11:00:00.000Z",
      complete: true,
      nextCursor: null,
      items: [
        {
          codeHash: hash,
          kind: scenario === "active" ? "reprocessing" : "original",
          shiftId: sourceShift,
          shiftNumber: "SEP26-000",
          shiftStatus: scenario === "active" ? "active" : "closed",
          scannedAt: "2026-09-01T10:00:00.000Z",
        },
      ],
    };
    await refreshValidationHistory(exec, { get: async <T,>() => page as T }, shiftId, productId);
  }
  const root = document.getElementById("root");
  if (!root) throw new Error("fixture root missing");
  createRoot(root).render(
    <ThemeProvider defaultTheme={query.get("theme") === "light" ? "light" : "dark"}>
      <QueryClientProvider client={new QueryClient()}>
        <FixtureControls />
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
