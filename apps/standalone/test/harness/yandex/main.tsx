/** Browser-only evidence harness: production components, synthetic native/Host boundary.
 * Live provider I/O is tested independently by host/tests/yandex_live.rs.
 */
import "@markiro/ui/styles.css";
import "../../../src/app/shell.css";
import "../../../src/i18n/index.js";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@markiro/ui";
import { createHostApi } from "../../../src/host/api.js";
import type { HostClient } from "../../../src/host/client.js";
import { yandexBackupStatusSchema } from "../../../src/host/yandex-backups.js";
import { yandexNative } from "../../../src/host/yandex-native.js";
import { OfficeSessionProvider } from "../../../src/office/office-session.js";
import { createOfficeQueryClient } from "../../../src/office/office-query.js";
import { BackupsPage } from "../../../src/office/backups/BackupsPage.js";
import { YandexRestoreWizard } from "../../../src/wizard/YandexRestoreWizard.js";
import { HEALTHY_BACKUPS } from "../../support/backups.js";
const params = new URLSearchParams(location.search);
const generation = "11111111-1111-4111-8111-111111111111";
const snapshot = "22222222-2222-4222-8222-222222222222";
const clientId = "dacd86d869664a09847d6a54e6f26fac";
const at = new Date().toISOString();
const stale = new Date(Date.now() - 30 * 3600000).toISOString();
const scenario = params.get("scenario");
let status = yandexBackupStatusSchema.parse({
  connectionGeneration: scenario ? generation : null,
  state: scenario === "revoked" ? "reauth_required" : scenario ? "connected" : "disconnected",
  clientId: scenario ? clientId : null,
  accountId: null,
  accountLabel: scenario ? "Тестовое предприятие" : null,
  deliveryState: scenario === "confirmed" ? "confirmed" : scenario === "quota" ? "failed" : "idle",
  pendingSince: null,
  lastAttemptAt: null,
  lastConfirmedSnapshotId: scenario === "confirmed" ? snapshot : null,
  lastConfirmedAt: scenario === "confirmed" ? at : null,
  lastConfirmedCopyCreatedAt: scenario === "confirmed" ? stale : null,
  errorCode:
    scenario === "quota" ? "quota_exceeded" : scenario === "revoked" ? "reauth_required" : null,
  progressBytes: 0,
  nextAttemptAt: null,
});
const client: HostClient = {
  async request(method, path, options) {
    let value: unknown;
    if (path === "/v1/office/org")
      value = {
        name: "Синтетическое предприятие",
        inn: "7701234567",
        gln: "4600682000013",
        gs1Prefixes: ["4600682"],
        timeZone: "Europe/Moscow",
        rev: 1,
      };
    else if (path === "/v1/office/backups/yandex") value = status;
    else if (path === "/v1/office/backups") value = HEALTHY_BACKUPS;
    else if (path === "/v1/office/backups/yandex/connection" && method === "DELETE") {
      status = {
        ...status,
        state: "disconnected",
        deliveryState: "idle",
        clientId: null,
        errorCode: null,
      };
      value = status;
    } else if (path === "/v1/office/backups/yandex/retry") {
      status = { ...status, errorCode: null, deliveryState: "queued" };
      value = status;
    } else throw new Error(`Harness refuses unexpected Host call: ${method} ${path}`);
    return options.schema.parse(value);
  },
};
const api = createHostApi(client);
yandexNative.connect = async (id) => {
  status = { ...status, clientId: id, connectionGeneration: generation, state: "connected" };
  return status;
};
yandexNative.cancel = async () => {};
yandexNative.importProfile = async () => ({
  format: 1,
  provider: "yandex_disk",
  clientId,
  redirectUri: "http://127.0.0.1:45711/oauth/yandex/callback",
  scopes: ["cloud_api:disk.app_folder", "login:info"],
});
yandexNative.exportProfile = async () => "yandex-connection.json (тестовый адаптер)";
yandexNative.registration = async () => {};
yandexNative.auth = async () => "Синтетический аккаунт";
yandexNative.list = async () => [
  {
    hostId: generation,
    snapshotId: snapshot,
    organizationLabel: "Синтетическое предприятие — проверка длинного названия организации",
    inn: "7701234567",
    appVersion: "1.1.0",
    createdAt: at,
    sizeBytes: 12 * 1048576,
  },
];
yandexNative.download = async () => {};
yandexNative.restore = async () => {};
yandexNative.resume = async () => {};
function Harness() {
  const [query] = useState(createOfficeQueryClient);
  return (
    <ThemeProvider defaultTheme={params.get("theme") === "dark" ? "dark" : "light"}>
      <QueryClientProvider client={query}>
        <MemoryRouter>
          <OfficeSessionProvider
            value={{
              user: {
                id: generation,
                login: "synthetic",
                name: "Тестовый пользователь",
                role: params.get("role") === "reader" ? "technologist" : "admin",
              },
              api,
              call: (operation) => operation("synthetic-session"),
              logout: () => {},
              refreshUser: async () => {},
            }}
          >
            <main style={{ maxWidth: 1100, margin: "24px auto", padding: 16 }}>
              <p>
                Браузерная проверка: синтетический Host/native-адаптер. Реальные секреты не вводить.
              </p>
              {params.get("view") === "restore" ? (
                <YandexRestoreWizard onBack={() => {}} onRestored={() => {}} />
              ) : (
                <BackupsPage />
              )}
            </main>
          </OfficeSessionProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
