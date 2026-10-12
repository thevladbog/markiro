import "@markiro/ui/styles.css";
import "../../src/station.css";
import "../../src/i18n/index.js";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@markiro/ui";
import { applyMigrations, type SqlExecutor } from "../../src/lib/mirror.js";
import { initializeDeviceRecovery } from "../../src/lib/device-recovery.js";
import { createCredentialGeneration } from "../../src/lib/credential-recovery.js";
import { createStationClient } from "../../src/lib/api-client.js";
import { DEFAULT_HARDWARE_CONFIG } from "../../src/lib/hardware-config.js";
import i18n from "../../src/i18n/index.js";
import { WarehouseReprint } from "../../src/pages/WarehouseReprint.js";
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
const deviceId = "00000000-0000-4000-8000-000000000010",
  operatorId = "00000000-0000-4000-8000-000000000011";
const config = {
  machineId: "pallet-browser",
  tenantId: "tenant-fixture",
  deviceId,
  serverUrl: `${location.origin}/api`,
  apiKey: "browser-test-key",
};
await initializeDeviceRecovery(exec, config);
await exec.run(
  "INSERT INTO operators_mirror(operator_id,name,role,pin_hash,active) VALUES(?,'Fixture operator','operator','synthetic',1) ON CONFLICT(operator_id) DO UPDATE SET active=1",
  [operatorId],
);
await exec.run("UPDATE station_meta SET value='0' WHERE key='operators_blocked'");
const generation = createCredentialGeneration(config.apiKey),
  client = createStationClient(config, { palletSheetSupported: true });
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
    ],
    assignments: { box: "office", duplicate: "office", pallet: "office" },
  },
};
const print = async () => {
  throw new Error("RAW forbidden in A4 fixture");
};
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") === "en" ? "en" : "ru");
function View() {
  return (
    <div style={{ height: "100dvh" }}>
      <WarehouseReprint
        exec={exec}
        client={client}
        deviceId={deviceId}
        operatorId={operatorId}
        credentialGeneration={generation}
        hardwareConfig={hardwareConfig}
        source={{ start: () => () => {} }}
        print={print}
        onExit={() => {}}
      />
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Root missing");
createRoot(root).render(
  <ThemeProvider defaultTheme={params.get("theme") === "light" ? "light" : "dark"}>
    <View />
  </ThemeProvider>,
);
document.documentElement.dataset.ready = "true";
