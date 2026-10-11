import "@markiro/ui/styles.css";
import "../../src/station.css";
import "../../src/i18n/index.js";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@markiro/ui";
import { NewShift, type NewShiftDraft } from "../../src/pages/NewShift.js";
import { createStationClient } from "../../src/lib/api-client.js";
import { applyMigrations, type SqlExecutor } from "../../src/lib/mirror.js";
import { createCredentialGeneration } from "../../src/lib/credential-recovery.js";
import { refreshOrganizationBranding } from "../../src/lib/organization-branding.js";
import { DEFAULT_HARDWARE_CONFIG } from "../../src/lib/hardware-config.js";
const id = new URLSearchParams(location.search).get("id");
if (!id) throw new Error("Fixture ID missing");
async function sql<T>(
  operation: "all" | "run",
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  const response = await fetch("/__product_labels_sql", {
    method: "POST",
    headers: { "content-type": "application/json", "x-browser-fixture": "product-labels" },
    body: JSON.stringify({ id, operation, sql: query, params }),
  });
  const body = (await response.json()) as { value: T[]; error?: string };
  if (body.error) throw new Error(body.error);
  return body.value;
}
const exec: SqlExecutor = {
  all: <T,>(query: string, params?: unknown[]) => sql<T>("all", query, params),
  run: async (query, params) => {
    await sql("run", query, params);
  },
};
await applyMigrations(exec);
const client = createStationClient(
  { machineId: "browser-fixture", serverUrl: `${location.origin}/api`, apiKey: "browser-test-key" },
  { palletSheetSupported: true },
);
const generation = createCredentialGeneration("browser-test-key");
const owner = { exec, tenantId: "tenant-fixture", generation, isCurrent: () => !generation.sealed };
await refreshOrganizationBranding({ ...owner, client });
const draft: NewShiftDraft = {
  product: {
    id: "product",
    name: "Вода питьевая Северный источник",
    gtin14: "04600000000015",
    boxCapacity: 12,
    palletBoxCapacity: 48,
  },
  productionDate: "",
  printEnabled: false,
  verificationRequired: false,
  productTemplateId: null,
  productTemplates: [],
  createdPrintShift: null,
};
const hardwareConfig = {
  ...DEFAULT_HARDWARE_CONFIG,
  printerRouting: {
    printers: [
      {
        id: "office",
        name: "Office A4",
        mode: "windows_driver" as const,
        paper: "a4" as const,
        target: { kind: "usb" as const, printer: "Office" },
        language: "zpl" as const,
        dpi: 300 as const,
      },
      {
        id: "box",
        name: "Box RAW",
        mode: "raw" as const,
        target: { kind: "tcp" as const, host: "fixture-printer", port: 9100 },
        language: "zpl" as const,
        dpi: 203 as const,
      },
    ],
    assignments: { box: "box", duplicate: "box", pallet: "office" },
  },
};
const root = document.getElementById("root");
if (!root) throw new Error("Root missing");
createRoot(root).render(
  <ThemeProvider defaultTheme="dark">
    <NewShift
      client={client}
      sheetBrandingOwner={owner}
      hardwareConfig={hardwareConfig}
      initialDraft={draft}
      source={{ start: () => () => {} }}
      onStarted={() => {
        document.documentElement.dataset.started = "true";
      }}
      onBack={() => {}}
    />
  </ThemeProvider>,
);
document.documentElement.dataset.ready = "true";
