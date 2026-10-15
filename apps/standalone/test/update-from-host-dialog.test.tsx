import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { UpdateShellProvider } from "../src/office/info/update-context.js";
import type { UpdateShell, VerifiedReport } from "../src/office/info/update-shell.js";
import type { HostUpdateOffer } from "../src/update/host-offer.js";
import { UpdateFromHostDialog } from "../src/update/UpdateFromHostDialog.js";
import { UpdateError, type UpdatesApi } from "../src/update/updates-api.js";
import { UpdatesProvider } from "../src/update/updates-context.js";

const MANIFEST = {
  version: "0.3.0",
  channel: "beta",
  releasedAt: "2026-11-02T10:00:00Z",
  notes: ["Лицензия площадки", "Раздача обновления через хост"],
  minUpgradeFrom: "0.2.0",
  protocol: 4,
  minProtocol: 3,
  sizeBytes: 200,
};

const OFFER: Extract<HostUpdateOffer, { kind: "available" }> = {
  kind: "available",
  hostVersion: "0.3.0",
  required: false,
  manifest: MANIFEST,
};

const PATH =
  "C:\\Users\\st\\AppData\\Local\\app.markiro.standalone\\updates\\0.3.0\\markiro-standalone-0.3.0.update.jws";

/** `update_verify`'s report of the downloaded package (plan ОБН-2's shape). */
const REPORT: VerifiedReport = {
  path: PATH,
  kid: "test-upd-1",
  manifest: {
    v: 1,
    product: "markiro-standalone",
    version: "0.3.0",
    channel: "beta",
    releasedAt: "2026-11-02T10:00:00Z",
    sourceSha: "0123456789abcdef0123456789abcdef01234567",
    installer: {
      name: "markiro-standalone-0.3.0-windows-x86_64-setup.exe",
      sha256: "7863191bce3b1317a5e56211c00c8a962523cc52264414ba528e791d12c1f1ae",
      sizeBytes: 200,
    },
    protocol: 4,
    minProtocol: 3,
    minUpgradeFrom: "0.2.0",
    notes: MANIFEST.notes,
  },
  installed: "0.2.1",
  installerPath: PATH.replace(".update.jws", "-windows-x86_64-setup.exe"),
  comparison: "newer",
  refusal: null,
  confirmations: [],
  host: { version: "0.3.0", protocol: 4, minProtocol: 3 },
};

function fakeUpdates(overrides: Partial<UpdatesApi> = {}): UpdatesApi {
  return {
    appVersion: vi.fn(async () => "0.2.1"),
    checkManifest: vi.fn(async () => MANIFEST),
    fetch: vi.fn(async (onProgress) => {
      onProgress({ received: 100, total: 200 });
      return { version: "0.3.0", manifestPath: PATH, sizeBytes: 200 };
    }),
    stage: vi.fn(async () => ({ version: "0.3.0", sizeBytes: 200 })),
    ...overrides,
  };
}

function fakeShell(report: VerifiedReport = REPORT): UpdateShell {
  return {
    scan: vi.fn(async () => []),
    verify: vi.fn(async () => report),
    install: vi.fn(async () => undefined),
    outcome: vi.fn(async () => null),
    dismissOutcome: vi.fn(async () => undefined),
    openFolder: vi.fn(async () => undefined),
  };
}

function open(
  updates: UpdatesApi,
  shell: UpdateShell,
  start = vi.fn<(report: VerifiedReport) => Promise<void>>(async () => undefined),
  size?: "floor",
) {
  const onClose = vi.fn();
  const view = (isOpen: boolean, offer = OFFER) => (
    <ThemeProvider defaultTheme="dark">
      <UpdatesProvider value={updates}>
        <UpdateShellProvider value={shell}>
          <UpdateFromHostDialog
            open={isOpen}
            offer={offer}
            onClose={onClose}
            start={start}
            {...(size === undefined ? {} : { size })}
          />
        </UpdateShellProvider>
      </UpdatesProvider>
    </ThemeProvider>
  );
  const { rerender } = render(view(true));
  return {
    onClose,
    start,
    reopen: (isOpen: boolean, offer?: typeof OFFER) => rerender(view(isOpen, offer)),
  };
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe("«Обновить с хоста»", () => {
  it("shows the notes as text, downloads, checks the package again and starts it", async () => {
    const updates = fakeUpdates();
    const shell = fakeShell();
    const { onClose, start } = open(updates, shell);
    expect(screen.getByText("Бета-версия")).toBeTruthy();
    expect(screen.getByText("Раздача обновления через хост")).toBeTruthy();
    await click("Скачать с хоста");
    expect(updates.fetch).toHaveBeenCalledTimes(1);
    expect(shell.verify).toHaveBeenCalledWith(PATH);
    await click("Установить обновление");
    expect(start).toHaveBeenCalledWith(REPORT);
    expect(onClose).toHaveBeenCalled();
  });

  it("explains a refused download and moves the focus to it", async () => {
    open(
      fakeUpdates({
        fetch: vi.fn(async () => Promise.reject(new UpdateError("update_busy", "x"))),
      }),
      fakeShell(),
    );
    await click("Скачать с хоста");
    const alert = screen.getByText(
      "С хоста уже скачивают обновление три устройства. Повторите через полминуты.",
    );
    expect(alert.closest("[tabindex='-1']")).toBe(document.activeElement);
  });

  it("asks before installing while the host is silent", async () => {
    const shell = fakeShell({ ...REPORT, host: null, confirmations: ["host_unreachable"] });
    const { start } = open(fakeUpdates(), shell);
    await click("Скачать с хоста");
    expect(screen.getByText(/Хост не отвечает/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Установить обновление" })).toBeNull();
    await click("Установить без проверки хоста");
    expect(start).toHaveBeenCalledWith({
      ...REPORT,
      host: null,
      confirmations: ["host_unreachable"],
    });
  });

  it("refuses a package the host no longer runs, with no button to install", async () => {
    const shell = fakeShell({ ...REPORT, refusal: { code: "host_differs", hostVersion: "0.2.9" } });
    const { start } = open(fakeUpdates(), shell);
    await click("Скачать с хоста");
    expect(screen.getByText(/Хост работает на версии 0\.2\.9, а пакет — другой/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Установить обновление" })).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("starts over on reopening after a start, with Cancel enabled", async () => {
    const { reopen } = open(fakeUpdates(), fakeShell());
    await click("Скачать с хоста");
    await click("Установить обновление");
    act(() => reopen(false));
    act(() => reopen(true));
    expect(screen.getByRole("button", { name: "Скачать с хоста" })).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Отмена" });
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
  });

  it("forgets a checked package of an older version when the offer moves on", async () => {
    const { reopen } = open(fakeUpdates(), fakeShell());
    await click("Скачать с хоста");
    expect(screen.getByRole("button", { name: "Установить обновление" })).toBeTruthy();
    act(() =>
      reopen(true, { ...OFFER, hostVersion: "0.4.0", manifest: { ...MANIFEST, version: "0.4.0" } }),
    );
    expect(screen.queryByRole("button", { name: "Установить обновление" })).toBeNull();
    expect(screen.getByRole("button", { name: "Скачать с хоста" })).toBeTruthy();
  });

  it("shows the download as a progress bar and keeps only the phase text live", async () => {
    let finish: (() => void) | undefined;
    const updates = fakeUpdates({
      fetch: vi.fn(async (onProgress) => {
        onProgress({ received: 100, total: 200 });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { version: "0.3.0", manifestPath: PATH, sizeBytes: 200 };
      }),
    });
    open(updates, fakeShell());
    await click("Скачать с хоста");
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(bar.closest("[aria-live]")).toBeNull();
    await act(async () => finish?.());
  });

  it("is all floor-sized when opened from the station, with no small close control", () => {
    open(fakeUpdates(), fakeShell(), undefined, "floor");
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.className).toContain("mk-btn--floor");
    expect(screen.queryByRole("button", { name: "Закрыть" })).toBeNull();
  });
});
