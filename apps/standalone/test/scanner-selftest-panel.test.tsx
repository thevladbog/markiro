import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import {
  ScannerSelfTest,
  useScannerSelfTest,
  type ScannerSelfTestState,
  type SelfTestPrintResult,
} from "../src/floor/setup/ScannerSelfTest.js";
import { GS, GS_MARK } from "../src/floor/setup/scanner-selftest.js";
import type { ScanChannel } from "../src/floor/scan-source.js";

let state: ScannerSelfTestState;

function Harness(props: {
  print?: (printerId: string, kind: string, code: string) => Promise<SelfTestPrintResult>;
  save?: (blob: Blob, name: string) => void;
  printers?: { id: string; name: string }[];
}) {
  state = useScannerSelfTest(() => new Date(2026, 9, 14, 9, 5, 3));
  return (
    <ThemeProvider>
      <ScannerSelfTest
        state={state}
        printers={props.printers ?? [{ id: "zebra", name: "Zebra у линии" }]}
        print={props.print ?? (async () => "sent")}
        {...(props.save ? { save: props.save } : {})}
      />
    </ThemeProvider>
  );
}

/** The code on the screen as the scanner should hand it over: the visible mark back to GS. */
function shownCode(): string {
  return (screen.getByTestId("self-test-code").textContent ?? "").replaceAll(GS_MARK, GS);
}

const scan = (raw: string, channel: ScanChannel = "keyboard") =>
  act(() => {
    state.onScan(raw, channel);
  });

describe("«Проверить сканер»", () => {
  it("shows a DataMatrix test code marked ТЕСТ, in words with a visible separator, and waits for a scan", () => {
    render(<Harness />);
    expect(screen.getByRole("heading", { name: "Проверка сканера" })).toBeTruthy();
    expect(screen.getByTestId("self-test-symbol").querySelector("svg")).toBeTruthy();
    expect(screen.getByText("ТЕСТ")).toBeTruthy();
    expect(screen.getByText(/Не код продукции/)).toBeTruthy();
    expect(screen.getByTestId("self-test-code").textContent).toContain(GS_MARK);
    expect(screen.getByTestId("self-test-code").textContent).not.toContain(GS);
    expect(screen.getByTestId("self-test-expected-structure").textContent).toContain("AI 92");
    expect(screen.getByTestId("self-test-waiting")).toBeTruthy();
  });

  it("says ОК for the code that arrived whole, with the channel, the separators and the KM structure, and hides the code", () => {
    render(<Harness />);
    const code = shownCode();
    scan(code, "com");
    const verdict = screen.getByTestId("self-test-verdict");
    expect(verdict.getAttribute("data-tone")).toBe("ok");
    expect(within(verdict).getByText(/ОК/)).toBeTruthy();
    expect(within(verdict).getByText("COM-порт")).toBeTruthy();
    expect(within(verdict).getByText("пришло 2 из 2")).toBeTruthy();
    expect(within(verdict).getByText("код маркировки (КМ)")).toBeTruthy();
    expect(screen.getByTestId("self-test-structure").textContent).toContain(
      "контрольная цифра верна",
    );
    const masked = screen.getByTestId("self-test-masked").textContent ?? "";
    expect(masked).toContain(GS_MARK);
    expect(masked).not.toContain("TEST");
    expect(screen.getByTestId("self-test-history").children).toHaveLength(1);
  });

  it("names a lost separator and what to set on the scanner", () => {
    render(<Harness />);
    scan(shownCode().replaceAll(GS, ""));
    const verdict = screen.getByTestId("self-test-verdict");
    expect(verdict.getAttribute("data-tone")).toBe("problem");
    expect(within(verdict).getByText(/ПРОБЛЕМА/)).toBeTruthy();
    expect(screen.getByTestId("self-test-reason").textContent).toContain(
      "Разделители групп (GS) не пришли",
    );
    expect(screen.getByTestId("self-test-reason").textContent).toContain("Ctrl+]");
  });

  it("warns, not fails, for a symbology prefix", () => {
    render(<Harness />);
    scan(`]d2${shownCode()}`);
    expect(screen.getByTestId("self-test-verdict").getAttribute("data-tone")).toBe("warning");
    expect(screen.getByTestId("self-test-reason").textContent).toContain("«]d2»");
  });

  it("a new code clears the verdict and an old scan no longer passes", () => {
    render(<Harness />);
    const old = shownCode();
    fireEvent.click(screen.getByRole("button", { name: "Новый код" }));
    expect(screen.getByTestId("self-test-waiting")).toBeTruthy();
    expect(shownCode()).not.toBe(old);
    scan(old);
    expect(screen.getByTestId("self-test-verdict").getAttribute("data-tone")).toBe("problem");
  });

  it("switches to the plain code and checks it exactly", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Простой код" }));
    const code = shownCode();
    expect(code).toMatch(/^MKR-/);
    scan(code);
    expect(screen.getByTestId("self-test-verdict").getAttribute("data-tone")).toBe("ok");
  });

  it("keeps the last five results", () => {
    render(<Harness />);
    for (let n = 0; n < 7; n++) scan("12345678901");
    expect(screen.getByTestId("self-test-history").children).toHaveLength(5);
  });

  it("shows the code large on the screen and closes it", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Показать на экране" }));
    expect(screen.getByTestId("self-test-symbol-big")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByTestId("self-test-symbol-big")).toBeNull();
  });

  it("saves a PDF of the code and prints it on the printer", async () => {
    const save = vi.fn<(blob: Blob, name: string) => void>();
    const print = vi.fn(async () => "sent" as const);
    render(<Harness save={save} print={print} />);
    fireEvent.click(screen.getByRole("button", { name: "Скачать PDF" }));
    await screen.findByText("Файл сохранён в загрузки.");
    expect(save.mock.calls[0]?.[1]).toBe("markiro-test-datamatrix.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Печать на: Zebra у линии" }));
    await screen.findByText("Тестовый код отправлен на печать.");
    expect(print).toHaveBeenCalledWith("zebra", "dm", shownCode());
  });

  it("explains a missing printer and keeps every control at the touch height", () => {
    render(<Harness printers={[]} />);
    expect(screen.getByText(/добавьте принтер/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Печать" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button.style.height, button.textContent ?? "").toBe("var(--control-floor)");
    }
  });
});
