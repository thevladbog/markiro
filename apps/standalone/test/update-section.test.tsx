import { readFileSync } from "node:fs";

import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { HostApi } from "../src/host/api.js";
import type { BackupState } from "../src/host/backups.js";
import { officeShiftSchema, type DeviceRecord, type OfficeShift } from "../src/host/protocol.js";
import type { AboutApi } from "../src/office/info/about-api.js";
import { AboutProvider } from "../src/office/info/about-context.js";
import { UpdateShellProvider } from "../src/office/info/update-context.js";
import { OnlineUpdatesProvider } from "../src/office/info/online-updates-context.js";
import { OnlineUpdateError, type OnlineUpdatesApi } from "../src/office/info/online-updates-api.js";
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
import { UpdateError, type UpdatesApi } from "../src/update/updates-api.js";
import { UpdatesProvider } from "../src/update/updates-context.js";
import { officeUpdateStatusSchema } from "../src/host/distribution.js";
import { chooseText } from "./support/select.js";
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

function fakeAbout(role: "host" | "station" | "office" | "unreadable"): AboutApi {
  return {
    appVersion: async () => "0.1.0",
    installRole: async () => {
      if (role === "unreadable") throw new Error("no shell");
      return role;
    },
    pairing: async () => DEVICE_STATUS,
    hello: async () => observation(true),
    system: async () => ({ os: "Windows 11", arch: "x64", webview: null }),
    openLink: async () => undefined,
  };
}

function renderUpdate(options: {
  online?: OnlineUpdatesApi;
  updates?: Partial<UpdatesApi>;
  shell?: FakeShell;
  api?: FakeHostApi;
  role?: "host" | "station" | "office" | "unreadable";
  technologist?: boolean;
}) {
  const shell = options.shell ?? fakeShell();
  const updates: UpdatesApi = {
    appVersion: vi.fn(async () => "0.1.0"),
    checkManifest: vi.fn(async () => {
      throw new Error("unexpected manifest check");
    }),
    fetch: vi.fn(async () => {
      throw new Error("unexpected host download");
    }),
    stage: vi.fn(async () => ({ version: MANIFEST.version, sizeBytes: 29 })),
    ...options.updates,
  };
  const api =
    options.api ??
    fakeHostApi({
      listShifts: vi.fn<HostApi["listShifts"]>(async () => []),
      recordUpdateStarted: vi.fn<HostApi["recordUpdateStarted"]>(async () => undefined),
    });
  const session = fakeOfficeSession(
    options.technologist === true ? { api, user: TECHNOLOGIST } : { api },
  );
  const view = render(
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={createOfficeQueryClient()}>
        <OfficeSessionProvider value={session}>
          <ThisDeviceProvider deviceId={DEVICE_ID}>
            <AboutProvider value={fakeAbout(options.role ?? "station")}>
              <UpdateShellProvider value={shell}>
                <OnlineUpdatesProvider value={options.online ?? onlineApi()}>
                  <UpdatesProvider value={updates}>
                    <UpdateSection />
                  </UpdatesProvider>
                </OnlineUpdatesProvider>
              </UpdateShellProvider>
            </AboutProvider>
          </ThisDeviceProvider>
        </OfficeSessionProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { shell, api, updates, unmount: view.unmount };
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

/** The check button of the signed package names its file (one «Проверить» per row). */
const CHECK = "Проверить: markiro-standalone-0.2.0.update.jws";

async function checkAndOpenTheDialog() {
  fireEvent.click(await screen.findByRole("button", { name: CHECK }));
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
    fireEvent.click(await screen.findByRole("button", { name: CHECK }));
    await screen.findByText("Эта версия старее установленной (0.3.0): понижать версию нельзя.");
    expect(screen.getByRole("button", { name: "Установить обновление" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("says that the host runs another version than a package from the host", async () => {
    renderUpdate({
      shell: fakeShell({
        verify: vi.fn<UpdateShell["verify"]>(async () => ({
          ...REPORT,
          refusal: { code: "host_differs", hostVersion: "0.2.9" },
        })),
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: CHECK }));
    await screen.findByText(
      "Хост работает на версии 0.2.9, а пакет — другой: установка отменена. Проверьте хост.",
    );
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

  it("names the package each check button checks, and the checked package in its card", async () => {
    renderUpdate({});
    const check = await screen.findByRole("button", { name: CHECK });
    expect(check.textContent).toBe("Проверить");
    fireEvent.click(check);
    await screen.findByText("Подпись проверена: выпуск Маркиро.");
    expect(screen.getAllByText("markiro-standalone-0.2.0.update.jws").length).toBe(2);
  });

  it("installs nothing while this PC's role is unknown: the host's PC would skip its copy", async () => {
    const { shell, api } = renderUpdate({ role: "unreadable" });
    fireEvent.click(await screen.findByRole("button", { name: CHECK }));
    await screen.findByText(/Роль этого ПК не удалось определить/);
    expect(screen.getByRole("button", { name: "Установить обновление" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(api.recordUpdateStarted).not.toHaveBeenCalled();
    expect(shell.install).not.toHaveBeenCalled();
  });

  it("cancels at the confirmation and starts nothing", async () => {
    const { shell, api } = renderUpdate({});
    const dialog = await checkAndOpenTheDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.recordUpdateStarted).not.toHaveBeenCalled();
    expect(shell.install).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Установить обновление" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("moves the focus to the reason when the install fails", async () => {
    const shell = fakeShell({
      install: vi.fn<UpdateShell["install"]>(async () => {
        throw new UpdateShellError("launch_failed", "update_install: launch_failed");
      }),
    });
    renderUpdate({ shell });
    const dialog = await checkAndOpenTheDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Установить" }));
    const reason = await screen.findByText(
      "Windows не запустила установщик. Запустите его вручную (ниже).",
    );
    await waitFor(() => expect(document.activeElement?.contains(reason)).toBe(true));
  });

  it("announces the phases in the polite live region", async () => {
    let finish: () => void = () => undefined;
    const shell = fakeShell({
      install: vi.fn<UpdateShell["install"]>(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    renderUpdate({ shell });
    const dialog = await checkAndOpenTheDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Установить" }));
    const phase = await screen.findByText("Запуск установщика. Программа закроется.");
    expect(phase.getAttribute("aria-live")).toBe("polite");
    finish();
  });
});

function onlineApi(): OnlineUpdatesApi {
  return {
    check: vi.fn(async () => ({
      manifest: {
        version: MANIFEST.version,
        channel: "stable",
        releasedAt: MANIFEST.releasedAt,
        notes: MANIFEST.notes,
        minUpgradeFrom: "0.1.0",
        protocol: 3,
        minProtocol: 2,
        sizeBytes: 29,
      },
      newer: true,
      compatible: true,
    })),
    download: vi.fn(async (_channel, _version, progress) => {
      progress({ received: 29, total: 29 });
      return { version: MANIFEST.version, manifestPath: PATH, sizeBytes: 29 };
    }),
  };
}
describe("online releases in the existing update section", () => {
  it("checks explicitly, keeps manual import, downloads and requires the existing confirmation", async () => {
    const online = onlineApi();
    const { shell, api } = renderUpdate({
      online,
      role: "host",
      api: fakeHostApi({
        listDevices: vi.fn(async () => []),
        listShifts: vi.fn(async () => []),
        startBackup: vi.fn(async () => ({
          ...HEALTHY_BACKUPS,
          local: {
            ...HEALTHY_BACKUPS.local,
            lastAttempt: { at: new Date().toISOString(), trigger: "manual", ok: true, code: null },
          },
        })),
        getBackups: vi.fn(async () => ({
          ...HEALTHY_BACKUPS,
          local: {
            ...HEALTHY_BACKUPS.local,
            lastAttempt: {
              at: new Date(Date.now() + 1_000).toISOString(),
              trigger: "manual",
              ok: true,
              code: null,
            },
          },
        })),
        recordUpdateStarted: vi.fn(async () => undefined),
      }),
    });
    await screen.findByRole("button", { name: "Искать снова" });
    expect(online.check).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Проверить обновления" }));
    await screen.findByRole("button", { name: "Скачать обновление" });
    expect(online.check).toHaveBeenCalledWith("stable");
    fireEvent.click(screen.getByRole("button", { name: "Скачать обновление" }));
    await screen.findByText("Подпись проверена: выпуск Маркиро.");
    expect(shell.verify).toHaveBeenCalledWith(PATH);
    expect(shell.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Установить обновление" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(shell.install).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    expect(shell.install).not.toHaveBeenCalled();
    expect(api.startBackup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Установить обновление" }));
    const confirmed = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirmed).getByRole("button", { name: "Установить" }));
    await waitFor(() => expect(shell.install).toHaveBeenCalledWith(PATH, []));
    expect(api.startBackup).toHaveBeenCalledOnce();
    expect(api.recordUpdateStarted).toHaveBeenCalledOnce();
  });
  it("shows current version, channel selection and recoverable network errors", async () => {
    const online = onlineApi();
    vi.mocked(online.check)
      .mockRejectedValueOnce(new OnlineUpdateError("unreachable"))
      .mockResolvedValueOnce({
        manifest: {
          version: "0.1.0",
          channel: "beta",
          releasedAt: MANIFEST.releasedAt,
          notes: [],
          minUpgradeFrom: "0.1.0",
          protocol: 3,
          minProtocol: 2,
          sizeBytes: 29,
        },
        newer: false,
        compatible: true,
      });
    renderUpdate({ online });
    await screen.findByRole("combobox", { name: "Канал обновлений" });
    chooseText("Канал обновлений", "Бета-версии");
    expect(online.check).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Проверить обновления" }));
    await screen.findByText(
      "Не удалось связаться с сервером обновлений. Проверьте интернет и попробуйте снова.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Проверить обновления" }));
    await screen.findByText("У вас установлена актуальная версия.");
    expect(online.check).toHaveBeenLastCalledWith("beta");
    expect(screen.queryByRole("button", { name: "Скачать обновление" })).toBeNull();
  });
  it("keeps a failed download retryable without exposing an install action", async () => {
    const online = onlineApi();
    vi.mocked(online.download).mockRejectedValueOnce(new OnlineUpdateError("interrupted"));
    const { shell } = renderUpdate({ online });
    fireEvent.click(await screen.findByRole("button", { name: "Проверить обновления" }));
    fireEvent.click(await screen.findByRole("button", { name: "Скачать обновление" }));
    await screen.findByText("Загрузка прервана. Повторное скачивание продолжит загрузку.");
    expect(screen.queryByRole("button", { name: "Установить обновление" })).toBeNull();
    expect(shell.verify).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Скачать обновление" }));
    await screen.findByText("Подпись проверена: выпуск Маркиро.");
    expect(online.download).toHaveBeenCalledTimes(2);
    expect(shell.install).not.toHaveBeenCalled();
  });
  it("does not verify or install a download completed after leaving the section", async () => {
    const online = onlineApi();
    let finish: ((value: Awaited<ReturnType<OnlineUpdatesApi["download"]>>) => void) | undefined;
    vi.mocked(online.download).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { shell, unmount } = renderUpdate({ online });
    fireEvent.click(await screen.findByRole("button", { name: "Проверить обновления" }));
    fireEvent.click(await screen.findByRole("button", { name: "Скачать обновление" }));
    unmount();
    finish?.({ version: "0.2.0", manifestPath: PATH, sizeBytes: 29 });
    await Promise.resolve();
    expect(shell.verify).not.toHaveBeenCalled();
    expect(shell.install).not.toHaveBeenCalled();
  });
  it("does not offer internet access to a technologist", async () => {
    const online = onlineApi();
    renderUpdate({ online, technologist: true });
    await screen.findByText("Обновление устанавливает администратор.");
    expect(screen.queryByRole("button", { name: "Проверить обновления" })).toBeNull();
    expect(online.check).not.toHaveBeenCalled();
  });
});

async function downloadOnline() {
  fireEvent.click(await screen.findByRole("button", { name: "Проверить обновления" }));
  fireEvent.click(await screen.findByRole("button", { name: "Скачать обновление" }));
}
const HOST_PACKAGE = officeUpdateStatusSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/office-update-status.json", testModuleUrl), "utf8"),
  ),
);

describe("automatic staging after an internet download", () => {
  it.each(["host", "office"] as const)(
    "verifies and stages once with the administrator session on a %s PC, without installing",
    async (role) => {
      const { shell, updates } = renderUpdate({ role });
      await downloadOnline();
      await screen.findByText(
        "Пакет 0.2.0 на хосте. Другие устройства смогут скачать его, когда хост будет работать на этой версии.",
      );
      expect(updates.stage).toHaveBeenCalledExactlyOnceWith(PATH, SESSION.token);
      expect(vi.mocked(shell.verify).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(updates.stage).mock.invocationCallOrder[0] ?? 0,
      );
      expect(shell.install).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Загрузить пакет на хост" })).toBeNull();
    },
  );
  it("retains manual upload for a manually checked file", async () => {
    const { updates } = renderUpdate({});
    fireEvent.click(await screen.findByRole("button", { name: CHECK }));
    await screen.findByText("Подпись проверена: выпуск Маркиро.");
    expect(updates.stage).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Загрузить пакет на хост" })).toBeTruthy();
  });
  it("retries the local package after transfer failure without downloading it again", async () => {
    const online = onlineApi();
    const stage = vi
      .fn<UpdatesApi["stage"]>()
      .mockRejectedValueOnce(new UpdateError("unreachable", "x"))
      .mockResolvedValueOnce({ version: MANIFEST.version, sizeBytes: 29 });
    const { shell } = renderUpdate({ online, updates: { stage } });
    await downloadOnline();
    await screen.findByText(/Пакет скачан, но передать его на хост не удалось/);
    fireEvent.click(screen.getByRole("button", { name: "Повторить передачу на хост" }));
    await screen.findByText(
      "Пакет 0.2.0 на хосте. Другие устройства смогут скачать его, когда хост будет работать на этой версии.",
    );
    expect(stage).toHaveBeenCalledTimes(2);
    expect(online.download).toHaveBeenCalledOnce();
    expect(shell.verify).toHaveBeenCalledOnce();
    expect(shell.install).not.toHaveBeenCalled();
  });
  it("does not stage a package whose local verification failed", async () => {
    const shell = fakeShell({
      verify: vi.fn(async () => {
        throw new UpdateShellError("installer_mismatch", "x");
      }),
    });
    const { updates } = renderUpdate({ shell });
    await downloadOnline();
    await waitFor(() => expect(shell.verify).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Проверить обновления" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(updates.stage).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Установить обновление" })).toBeNull();
  });
  it("keeps installation disabled while the host transfer runs", async () => {
    let finish: ((value: { version: string; sizeBytes: number }) => void) | undefined;
    const stage = vi.fn<UpdatesApi["stage"]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { shell } = renderUpdate({ updates: { stage } });
    await downloadOnline();
    await waitFor(() => expect(stage).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "Установить обновление" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(shell.install).not.toHaveBeenCalled();
    finish?.({ version: MANIFEST.version, sizeBytes: 29 });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Установить обновление" }).hasAttribute("disabled"),
      ).toBe(false),
    );
  });
  it.each(["current", "staged"] as const)(
    "accepts a confirmed %s copy already on the host after a repeated upload",
    async (place) => {
      const stage = vi.fn<UpdatesApi["stage"]>(async () => {
        throw new UpdateError("package_not_newer", "x");
      });
      const api = fakeHostApi({
        getUpdateStatus: vi.fn(async () => ({
          ...HOST_PACKAGE,
          package: {
            ...HOST_PACKAGE.package,
            version: place === "current" ? MANIFEST.version : HOST_PACKAGE.package.version,
            staged: place === "staged" ? MANIFEST.version : null,
          },
        })),
      });
      renderUpdate({ api, updates: { stage } });
      await downloadOnline();
      await screen.findByText(
        "Пакет 0.2.0 на хосте. Другие устройства смогут скачать его, когда хост будет работать на этой версии.",
      );
      expect(stage).toHaveBeenCalledOnce();
    },
  );
  it("does not send a package when verification finishes after leaving the section", async () => {
    let finish: ((report: VerifiedReport) => void) | undefined;
    const shell = fakeShell({
      verify: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const { updates, unmount } = renderUpdate({ shell });
    await downloadOnline();
    await waitFor(() => expect(shell.verify).toHaveBeenCalledOnce());
    unmount();
    await act(async () => {
      finish?.(REPORT);
    });
    expect(updates.stage).not.toHaveBeenCalled();
    expect(shell.install).not.toHaveBeenCalled();
  });
  it("does not call another host version a successful transfer", async () => {
    const stage = vi.fn<UpdatesApi["stage"]>(async () => {
      throw new UpdateError("package_not_newer", "x");
    });
    const api = fakeHostApi({ getUpdateStatus: vi.fn(async () => HOST_PACKAGE) });
    renderUpdate({ api, updates: { stage } });
    await downloadOnline();
    await screen.findByText(/Пакет скачан, но передать его на хост не удалось/);
    expect(
      screen.queryByText(
        "Пакет 0.2.0 на хосте. Другие устройства смогут скачать его, когда хост будет работать на этой версии.",
      ),
    ).toBeNull();
  });
});
