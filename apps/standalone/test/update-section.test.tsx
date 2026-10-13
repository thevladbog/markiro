import { readFileSync } from "node:fs";

import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { HostApi } from "../src/host/api.js";
import type { BackupState } from "../src/host/backups.js";
import { officeShiftSchema, type DeviceRecord, type OfficeShift } from "../src/host/protocol.js";
import type { AboutApi } from "../src/office/info/about-api.js";
import { AboutProvider } from "../src/office/info/about-context.js";
import { UpdateShellProvider } from "../src/office/info/update-context.js";
import { UpdateSection } from "../src/office/info/UpdateSection.js";
import {
  UpdateShellError,
  type FoundPackage,
  type UpdateShell,
  type VerifiedReport,
} from "../src/office/info/update-shell.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { ThisDeviceProvider } from "../src/office/this-device.js";
import { HEALTHY_BACKUPS } from "./support/backups.js";
import { DEVICE_ID, DEVICE_STATUS, SESSION, observation } from "./support/fixtures.js";
import {
  fakeHostApi,
  fakeOfficeSession,
  TECHNOLOGIST,
  type FakeHostApi,
} from "./support/office.js";

const testModuleUrl = import.meta.url;
/** An active shift whose owner is `DEVICE_ID`, this PC. */
const SHIFT: OfficeShift = officeShiftSchema.parse(
  JSON.parse(readFileSync(new URL("../proto/fixtures/office-shift.json", testModuleUrl), "utf8")),
);
const SHA = "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b";
const PATH = "C:\\Users\\Анна\\Documents\\Markiro\\Обновления\\markiro-standalone-0.2.0.update.jws";
const MANIFEST: VerifiedReport["manifest"] = {
  v: 1,
  product: "markiro-standalone",
  version: "0.2.0",
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  sourceSha: "a".repeat(40),
  installer: {
    name: "markiro-standalone-0.2.0-windows-x86_64-setup.exe",
    sha256: SHA,
    sizeBytes: 29,
  },
  protocol: 3,
  minProtocol: 2,
  minUpgradeFrom: "0.1.0",
  notes: ["Лицензия площадки и страница «Информация»"],
};
const FOUND: FoundPackage = {
  path: PATH,
  place: "documents",
  fileName: "markiro-standalone-0.2.0.update.jws",
  manifest: MANIFEST,
  problem: null,
};
const BROKEN: FoundPackage = {
  path: "E:\\broken.update.jws",
  place: "removable",
  fileName: "broken.update.jws",
  manifest: null,
  problem: "manifest_signature",
};
const REPORT: VerifiedReport = {
  path: PATH,
  kid: "test-upd-1",
  manifest: MANIFEST,
  installed: "0.1.0",
  installerPath:
    "C:\\Users\\Анна\\Documents\\Markiro\\Обновления\\markiro-standalone-0.2.0-windows-x86_64-setup.exe",
  comparison: "newer",
  refusal: null,
  confirmations: [],
  host: { version: "0.1.0", protocol: 3, minProtocol: 1 },
};

type FakeShell = { [K in keyof UpdateShell]: Mock<UpdateShell[K]> };

function fakeShell(overrides: Partial<FakeShell> = {}): FakeShell {
  return {
    scan: vi.fn<UpdateShell["scan"]>(async () => [FOUND, BROKEN]),
    verify: vi.fn<UpdateShell["verify"]>(async () => REPORT),
    install: vi.fn<UpdateShell["install"]>(async () => undefined),
    outcome: vi.fn<UpdateShell["outcome"]>(async () => null),
    dismissOutcome: vi.fn<UpdateShell["dismissOutcome"]>(async () => undefined),
    openFolder: vi.fn<UpdateShell["openFolder"]>(async () => undefined),
    ...overrides,
  };
}

function fakeAbout(role: "host" | "station" | "office"): AboutApi {
  return {
    appVersion: async () => "0.1.0",
    installRole: async () => role,
    pairing: async () => DEVICE_STATUS,
    hello: async () => observation(true),
    system: async () => ({ os: "Windows 11", arch: "x64", webview: null }),
    openLink: async () => undefined,
  };
}

function renderUpdate(options: {
  shell?: FakeShell;
  api?: FakeHostApi;
  role?: "host" | "station" | "office";
  technologist?: boolean;
}) {
  const shell = options.shell ?? fakeShell();
  const api =
    options.api ??
    fakeHostApi({
      listShifts: vi.fn<HostApi["listShifts"]>(async () => []),
      recordUpdateStarted: vi.fn<HostApi["recordUpdateStarted"]>(async () => undefined),
    });
  const session = fakeOfficeSession(
    options.technologist === true ? { api, user: TECHNOLOGIST } : { api },
  );
  render(
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={createOfficeQueryClient()}>
        <OfficeSessionProvider value={session}>
          <ThisDeviceProvider deviceId={DEVICE_ID}>
            <AboutProvider value={fakeAbout(options.role ?? "station")}>
              <UpdateShellProvider value={shell}>
                <UpdateSection />
              </UpdateShellProvider>
            </AboutProvider>
          </ThisDeviceProvider>
        </OfficeSessionProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { shell, api };
}

const RUNNING: BackupState = {
  ...HEALTHY_BACKUPS,
  running: { trigger: "manual", startedAt: "2026-10-09T14:21:00Z" },
};
function copied(ok: boolean, code: string | null = null): BackupState {
  return {
    ...HEALTHY_BACKUPS,
    local: {
      ...HEALTHY_BACKUPS.local,
      lastAttempt: { at: "2026-10-09T14:21:04Z", trigger: "manual", ok, code },
    },
  };
}

async function checkAndOpenTheDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
  await screen.findByText("Подпись проверена: выпуск Маркиро.");
  fireEvent.click(screen.getByRole("button", { name: "Установить обновление" }));
  // `ConfirmDialog` of @markiro/ui is an alert dialog.
  return screen.findByRole("alertdialog");
}

describe("«Обновление»", () => {
  it("shows a technologist this PC's version and who installs, and searches nothing", async () => {
    const { shell } = renderUpdate({ technologist: true });
    await screen.findByText("Обновление устанавливает администратор.");
    expect(await screen.findByText("0.1.0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Искать снова" })).toBeNull();
    expect(shell.scan).not.toHaveBeenCalled();
  });

  it("lists what an administrator's search found: a version for a signed package, a reason for another", async () => {
    const { shell } = renderUpdate({});
    const list = await screen.findByRole("list", { name: "Найденные пакеты обновления" });
    expect(within(list).getByText("markiro-standalone-0.2.0.update.jws")).toBeTruthy();
    expect(within(list).getByText("0.2.0 — установщик не проверен")).toBeTruthy();
    expect(
      within(list).getByText(
        "Подпись пакета не сходится: файл изменён после выпуска. Запросите пакет заново.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Документы\\Markiro\\Обновления/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Искать снова" }));
    await waitFor(() => expect(shell.scan).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Открыть папку" }));
    await waitFor(() => expect(shell.openFolder).toHaveBeenCalledTimes(1));
  });

  it("tells what a checked package is, and on a station reports the start before the shell starts it", async () => {
    const { shell, api } = renderUpdate({ role: "station" });
    const dialog = await checkAndOpenTheDialog();
    expect(shell.verify).toHaveBeenCalledWith(PATH);
    expect(screen.getByText("0.2.0 (сейчас 0.1.0)")).toBeTruthy();
    expect(screen.getByText("02.11.2026")).toBeTruthy();
    expect(screen.getByText("Лицензия площадки и страница «Информация»")).toBeTruthy();
    expect(within(dialog).getByText("Установить версию 0.2.0?")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Окно программы закроется на 1–3 минуты; Windows спросит права администратора. После установки программа откроется снова.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Установить" }));
    await screen.findByText("Запуск установщика. Программа закроется.");
    expect(api.recordUpdateStarted).toHaveBeenCalledWith(SESSION.token, {
      from: "0.1.0",
      to: "0.2.0",
      installerSha256: SHA,
      source: "file",
    });
    expect(shell.install).toHaveBeenCalledWith(PATH, []);
    expect(shell.install.mock.invocationCallOrder[0]).toBeGreaterThan(
      api.recordUpdateStarted.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(api.startBackup).not.toHaveBeenCalled();
    expect(api.listDevices).not.toHaveBeenCalled();
  });

  it("on the host's PC names the devices that will not connect and this PC's open shift, and copies first", async () => {
    const station = (
      name: string,
      protocol: number,
      revokedAt: string | null = null,
    ): DeviceRecord => ({
      id:
        name === "Станция линии 2"
          ? "00000000-0000-4000-8000-000000000002"
          : "00000000-0000-4000-8000-000000000003",
      kind: "station",
      name,
      lineId: null,
      appVersion: "0.1.0",
      protocol,
      versionSeenAt: null,
      pairedAt: "2026-09-26T09:15:00Z",
      lastSeenAt: null,
      revokedAt,
    });
    const api = fakeHostApi({
      listDevices: vi.fn<HostApi["listDevices"]>(async () => [
        station("Станция линии 2", 1),
        station("Списанная станция", 1, "2026-10-01T10:00:00Z"),
      ]),
      listShifts: vi.fn<HostApi["listShifts"]>(async () => [SHIFT]),
      startBackup: vi.fn<HostApi["startBackup"]>(async () => RUNNING),
      getBackups: vi.fn<HostApi["getBackups"]>(async () => copied(true)),
      recordUpdateStarted: vi.fn<HostApi["recordUpdateStarted"]>(async () => undefined),
    });
    const { shell } = renderUpdate({ role: "host", api });
    const dialog = await checkAndOpenTheDialog();
    expect(
      within(dialog).getByText(
        "После обновления хоста эти устройства не подключатся, пока их не обновят: Станция линии 2.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "На этом ПК открыта смена OCT26-004: программа закроется на 1–3 минуты, смена продолжится после.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/Это ПК хоста: перед установкой хост сделает резервную копию/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Установить" }));
    await waitFor(() => expect(shell.install).toHaveBeenCalledWith(PATH, []));
    expect(api.startBackup.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      api.recordUpdateStarted.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("stops at a failed copy with its reason and starts nothing", async () => {
    const api = fakeHostApi({
      listDevices: vi.fn<HostApi["listDevices"]>(async () => []),
      listShifts: vi.fn<HostApi["listShifts"]>(async () => []),
      startBackup: vi.fn<HostApi["startBackup"]>(async () => RUNNING),
      getBackups: vi.fn<HostApi["getBackups"]>(async () => copied(false, "disk_full")),
      recordUpdateStarted: vi.fn<HostApi["recordUpdateStarted"]>(async () => undefined),
    });
    const { shell } = renderUpdate({ role: "host", api });
    const dialog = await checkAndOpenTheDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Установить" }));
    await screen.findByText(
      "Резервная копия не получилась (disk_full): обновление не запущено. Проверьте «Резервные копии».",
    );
    expect(api.recordUpdateStarted).not.toHaveBeenCalled();
    expect(shell.install).not.toHaveBeenCalled();
  });

  it("says why a package is refused and offers no install", async () => {
    renderUpdate({
      shell: fakeShell({
        verify: vi.fn<UpdateShell["verify"]>(async () => ({
          ...REPORT,
          installed: "0.3.0",
          comparison: "older",
          refusal: { code: "older", installed: "0.3.0" },
        })),
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
    await screen.findByText("Эта версия старее установленной (0.3.0): понижать версию нельзя.");
    expect(screen.getByRole("button", { name: "Установить обновление" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("passes a confirmed reinstall on, and says so when Windows refused the rights", async () => {
    const shell = fakeShell({
      verify: vi.fn<UpdateShell["verify"]>(async () => ({
        ...REPORT,
        installed: "0.2.0",
        comparison: "same",
        confirmations: ["reinstall"],
      })),
      install: vi.fn<UpdateShell["install"]>(async () => {
        throw new UpdateShellError("uac_cancelled", "update_install: uac_cancelled");
      }),
    });
    renderUpdate({ shell });
    const dialog = await checkAndOpenTheDialog();
    expect(within(dialog).getByText("Переустановить версию 0.2.0?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Установить" }));
    await screen.findByText("Обновление не запущено: Windows не дала прав администратора.");
    expect(shell.install).toHaveBeenCalledWith(PATH, ["reinstall"]);
  });

  it("reports an update that did not finish until it is hidden", async () => {
    const outcome = vi
      .fn<UpdateShell["outcome"]>()
      .mockResolvedValueOnce({
        kind: "not_finished",
        from: "0.1.0",
        to: "0.2.0",
        startedAtMs: 1760000000000,
      })
      .mockResolvedValue(null);
    const shell = fakeShell({ outcome });
    renderUpdate({ shell });
    const text =
      "Обновление до версии 0.2.0 не завершилось: установлена версия 0.1.0. Найдите пакет и запустите установку снова.";
    await screen.findByText(text);
    fireEvent.click(screen.getByRole("button", { name: "Скрыть" }));
    await waitFor(() => expect(screen.queryByText(text)).toBeNull());
    expect(shell.dismissOutcome).toHaveBeenCalledTimes(1);
  });
});
