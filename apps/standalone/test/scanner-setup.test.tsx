import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import { WorkstationSetup } from "../src/floor/setup/WorkstationSetup.js";
import {
  DEFAULT_WORKSTATION_SETTINGS,
  readWorkstationSettings,
  saveWorkstationSettings,
  type WorkstationSettings,
} from "../src/floor/setup/workstation-settings.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRender, manualRuntime, ZEBRA } from "./support/printing.js";

const FINGERPRINT = "ab".repeat(32);
const PAYLOAD = `markiro-host:1?h=192.168.1.10&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`;

function fakeSource() {
  let listener: ScanListener | null = null;
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    clearPendingInput: () => undefined,
    setManualTextEntryActive: () => undefined,
  };
  return {
    source,
    read: (raw: string) =>
      act(() => {
        listener?.(raw);
      }),
  };
}

/** The workstation setup as the unpaired station opens it: the scanners only. */
async function scannerSetup(local: LocalExecutor = openLocalDb().executor) {
  const shell = fakeHardware();
  const scanner = fakeSource();
  const onSaved = vi.fn<(settings: WorkstationSettings) => void>();
  const onBack = vi.fn();
  render(
    <ThemeProvider>
      <WorkstationSetup
        scope="scanners"
        local={local}
        hardware={shell.hardware}
        printing={manualRuntime(shell.hardware).runtime}
        source={scanner.source}
        render={fakeRender}
        onSaved={onSaved}
        onBack={onBack}
      />
    </ThemeProvider>,
  );
  await screen.findByRole("heading", { name: "Сканеры" });
  return { local, shell, scanner, onSaved, onBack };
}

describe("the scanner settings before pairing (owner feedback, first Windows test)", () => {
  it("shows the scanners and the scan check only, under its own title, with the focus on the scanners", async () => {
    await scannerSetup();
    expect(screen.getByRole("heading", { name: "Настройки сканера" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Принтеры" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Звук" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Проверка этикетки" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Что прочитал сканер" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Проверка сканера" })).toBeTruthy();
    expect(screen.getByLabelText("COM-порт")).toBeTruthy();
    expect(screen.getByLabelText("Скорость, бод")).toBeTruthy();
    // The keyboard scanner is a row of the list: always on, nothing to set.
    expect(screen.getByText("Клавиатурный сканер")).toBeTruthy();
    expect(screen.getByText("Работает всегда, без настройки")).toBeTruthy();
    // The focus is taken by a passive effect, which React flushes after the commit the heading
    // appeared in: wait for the focus itself, not for the heading.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Сканеры" })),
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button.style.height, button.textContent ?? "").toBe("var(--control-floor)");
    }
  });

  it("adds a COM scanner, hands the shell the set and keeps the printers stored on this PC", async () => {
    const local = openLocalDb().executor;
    const stored: WorkstationSettings = {
      ...DEFAULT_WORKSTATION_SETTINGS,
      printers: [ZEBRA],
      assignments: { box: ZEBRA.id, pallet: null, duplicate: null },
      sound: { muted: true, volume: 30 },
    };
    await saveWorkstationSettings(local, stored);
    const { shell, onSaved } = await scannerSetup(local);
    fireEvent.change(screen.getByLabelText("COM-порт"), { target: { value: "com3" } });
    fireEvent.change(screen.getByLabelText("Скорость, бод"), {
      target: { value: "115200" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(shell.hardware.configureScanners).toHaveBeenCalledWith([
        { port: "COM3", baud: 115200 },
      ]),
    );
    expect(await screen.findByText("Настройки сохранены")).toBeTruthy();
    expect(await readWorkstationSettings(local)).toEqual({
      ...stored,
      scanners: [{ port: "COM3", baud: 115200 }],
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("says a scan reached the app and recognizes the office's pairing code", async () => {
    const { scanner } = await scannerSetup();
    expect(screen.getByText("Отсканируйте код с экрана офиса или любой другой код.")).toBeTruthy();
    scanner.read(PAYLOAD);
    expect(
      await screen.findByText("Сканер работает: прочитан код подключения к хосту 192.168.1.10."),
    ).toBeTruthy();
  });

  it("names the Russian layout, the group separator and a garbled frame, never the scan's text", async () => {
    const { scanner } = await scannerSetup();
    scanner.read("ыыы");
    expect(
      await screen.findByText(
        "Сканер работает: считано символов — 3. Это не код подключения. Сканер печатает в русской раскладке: код подключения всё равно прочитается.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/ыыы/)).toBeNull();
    scanner.read("0104600682000013\u001d21abc");
    expect(
      await screen.findByText(
        "Сканер работает: считано символов — 22. Это не код подключения. В скане есть разделитель GS.",
      ),
    ).toBeTruthy();
    scanner.read("��");
    expect(
      await screen.findByText(
        "Скан пришёл искажённым. У COM-сканера проверьте скорость: она должна совпадать с настройкой самого сканера.",
      ),
    ).toBeTruthy();
  });

  it("goes back", async () => {
    const { onBack } = await scannerSetup();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("offers «Проверить сканер» with a test DataMatrix and judges a scan against it, by its channel", async () => {
    const shell = fakeHardware();
    let listener: ((raw: string, channel: "keyboard" | "com" | "unknown") => void) | null = null;
    const source: ScanSource = {
      start: () => () => undefined,
      startTagged(next) {
        listener = next;
        return () => undefined;
      },
      clearPendingInput: () => undefined,
      setManualTextEntryActive: () => undefined,
    };
    render(
      <ThemeProvider>
        <WorkstationSetup
          scope="scanners"
          local={openLocalDb().executor}
          hardware={shell.hardware}
          printing={manualRuntime(shell.hardware).runtime}
          source={source}
          render={fakeRender}
          onSaved={vi.fn()}
          onBack={vi.fn()}
        />
      </ThemeProvider>,
    );
    await screen.findByRole("heading", { name: "Проверка сканера" });
    const code = (screen.getByTestId("self-test-code").textContent ?? "").replaceAll("␝", "\u001d");
    act(() => listener?.(code.replaceAll("\u001d", ""), "com"));
    expect(screen.getByTestId("self-test-verdict").getAttribute("data-tone")).toBe("problem");
    expect(screen.getByTestId("self-test-reason").textContent).toContain("Разделители групп");
    act(() => listener?.(code, "keyboard"));
    expect(screen.getByTestId("self-test-verdict").getAttribute("data-tone")).toBe("ok");
    expect(screen.getByText("сканер как клавиатура")).toBeTruthy();
    // The pairing screen's own check still reads the scan, without its text.
    expect(screen.getByRole("heading", { name: "Что прочитал сканер" })).toBeTruthy();
  });
});
