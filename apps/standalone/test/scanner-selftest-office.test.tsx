import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import {
  ScannerSelfTest,
  useScannerSelfTest,
  type ScannerSelfTestState,
} from "../src/floor/setup/ScannerSelfTest.js";
import { GS } from "../src/floor/setup/scanner-selftest.js";

let state: ScannerSelfTestState;
function Harness({
  print = vi.fn(async () => "sent" as const),
}: {
  print?: (id: string, kind: "plain" | "dm", code: string) => Promise<"sent">;
}) {
  state = useScannerSelfTest();
  return (
    <ThemeProvider>
      <ScannerSelfTest
        presentation="office"
        state={state}
        printers={[{ id: "test", name: "Принтер" }]}
        print={print}
      />
    </ThemeProvider>
  );
}

describe("office scanner presentation", () => {
  it("uses office controls and retains the exact test and extended print actions", async () => {
    const print = vi.fn(async () => "sent" as const);
    render(<Harness print={print} />);
    expect(screen.getByRole("button", { name: "Увеличить" }).classList.contains("mk-btn--md")).toBe(
      true,
    );
    const code = state.code;
    act(() => state.onScan(code, "com"));
    expect(screen.getByRole("alert").textContent).toContain("Проверка пройдена");
    fireEvent.click(screen.getByText("Дополнительно"));
    fireEvent.click(screen.getByRole("button", { name: "Печать на: Принтер" }));
    expect(print).toHaveBeenCalledWith("test", "dm", code);
  });
  it("reports lost GS without accepting a different code", () => {
    render(<Harness />);
    act(() => state.onScan(state.code.replaceAll(GS, ""), "com"));
    expect(screen.getByRole("alert").textContent).toContain("нет разделителей GS");
    expect(screen.getByRole("alert").textContent).toContain("0x1D");
  });
});
