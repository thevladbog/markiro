import "@markiro/ui/styles.css";
import "../../src/station.css";
import "../../src/i18n/index.js";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@markiro/ui";
import { applyMigrations, type SqlExecutor } from "../../src/lib/mirror.js";
import { initializeDeviceRecovery } from "../../src/lib/device-recovery.js";
import { createCredentialGeneration } from "../../src/lib/credential-recovery.js";
import { createStationClient } from "../../src/lib/api-client.js";
import { DEFAULT_HARDWARE_CONFIG } from "../../src/lib/hardware-config.js";
import { createWarehousePalletWork } from "../../src/lib/warehouse-reprint/pallet-work.js";
import { PalletConfirmation } from "../../src/ui/warehouse-reprint/PalletConfirmation.js";
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
  "INSERT INTO operators_mirror(operator_id,name,role,pin_hash,active) VALUES(?,'Fixture operator','operator','synthetic',1)",
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
const work = createWarehousePalletWork({
  exec,
  client,
  generation,
  deviceId,
  operatorId,
  hardware: () => hardwareConfig,
  print,
});
await work.initialize();
function View() {
  const state = useSyncExternalStore(work.subscribe, work.getSnapshot);
  return (
    <PalletConfirmation
      exec={exec}
      client={client}
      deviceId={deviceId}
      operatorId={operatorId}
      credentialGeneration={generation}
      hardwareConfig={hardwareConfig}
      source={{ start: () => () => {} }}
      print={print}
      onExit={() => {}}
      state={state}
      work={work}
      onFinish={async () => {
        await work.finish();
      }}
      modeBusy={false}
    />
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Root missing");
createRoot(root).render(
  <ThemeProvider defaultTheme="dark">
    <View />
  </ThemeProvider>,
);
document.documentElement.dataset.ready = "true";
