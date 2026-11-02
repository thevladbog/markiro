import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import {
  createKeyboardWedgeSource,
  createComScanSource,
  mergeScanSources,
} from "../src/floor/scan-source.js";
import { readWorkstationSettings } from "../src/floor/setup/workstation-settings.js";
import {
  OfficeScannerProvider,
  useOfficeScanner,
} from "../src/office/scanner/office-scanner-context.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { manualRuntime } from "./support/printing.js";

function Consumer({ onScan }: { onScan: (raw: string) => void }) {
  const scanner = useOfficeScanner();
  useEffect(() => scanner.source?.start(onScan), [scanner.source, onScan]);
  return (
    <button disabled={!scanner.canConfigure} onClick={scanner.openSettings}>
      Settings
    </button>
  );
}

function mount() {
  const shell = fakeHardware();
  const local = openLocalDb().executor;
  const comListeners = new Set<(raw: string) => void>();
  const source = mergeScanSources(
    createKeyboardWedgeSource(),
    createComScanSource(async (listener) => {
      comListeners.add(listener);
      return () => {
        comListeners.delete(listener);
      };
    }),
  );
  const onScan = vi.fn();
  const scanner = {
    source,
    local,
    hardware: shell.hardware,
    printing: manualRuntime(shell.hardware).runtime,
  };
  const ui = render(
    <StrictMode>
      <ThemeProvider>
        <OfficeScannerProvider scanner={scanner}>
          <Consumer onScan={onScan} />
        </OfficeScannerProvider>
      </ThemeProvider>
    </StrictMode>,
  );
  return {
    ...ui,
    source,
    onScan,
    local,
    shell,
    com: (raw: string) =>
      act(() => {
        for (const listener of comListeners) listener(raw);
      }),
  };
}

function wedge(raw: string) {
  for (const key of raw) fireEvent.keyDown(window, { key });
  fireEvent.keyDown(window, { key: "Enter" });
}

describe("Office scanner ownership", () => {
  it("defaults to no scanner outside the app", () => {
    render(<Consumer onScan={vi.fn()} />);
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
  });

  it("gives Office both keyboard and COM scans, then releases all listeners on session unmount", async () => {
    const office = mount();
    await act(async () => undefined);
    wedge("0104601234567890");
    office.com("COM-CODE");
    expect(office.onScan.mock.calls).toEqual([["0104601234567890"], ["COM-CODE"]]);
    office.unmount();
    wedge("AFTER-LOGOUT");
    office.com("AFTER-LOGOUT");
    expect(office.onScan).toHaveBeenCalledTimes(2);
    expect(office.shell.hardware.printBytes).not.toHaveBeenCalled();
  });

  it("hands scans exclusively to the reused scanner checks, saves local COM settings and restores Office ownership", async () => {
    const office = mount();
    for (const key of "PENDING") fireEvent.keyDown(window, { key });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Подключение" });
    expect(screen.getByRole("dialog", { name: "Настройки сканера" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Закрыть настройки сканера" })).toBeTruthy();
    expect(screen.getByText("Сканер в режиме клавиатуры")).toBeTruthy();
    fireEvent.click(screen.getByText("Дополнительно"));
    office.com("CHECK");
    expect(await screen.findByText(/Считано символов: 5/)).toBeTruthy();
    expect(office.onScan).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("COM-порт"), { target: { value: "COM3" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(office.shell.hardware.configureScanners).toHaveBeenCalledWith([
        { port: "COM3", baud: 9600 },
      ]),
    );
    expect((await readWorkstationSettings(office.local)).scanners).toEqual([
      { port: "COM3", baud: 9600 },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    wedge("NEXT");
    office.com("COM-NEXT");
    expect(office.onScan.mock.calls).toEqual([["NEXT"], ["COM-NEXT"]]);
  });

  it("clears pending keyboard input and manual-entry state between Office sessions", () => {
    const office = mount();
    fireEvent.keyDown(window, { key: "X" });
    office.source.setManualTextEntryActive(true);
    office.unmount();
    const onScan = vi.fn();
    const stop = office.source.start(onScan);
    fireEvent.keyDown(window, { key: "Enter" });
    wedge("NEW");
    expect(onScan.mock.calls).toEqual([["NEW"]]);
    stop();
  });
});
