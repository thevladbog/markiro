import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SetupTabs, type SetupTabId } from "../src/ui/setup/SetupTabs.js";
import { TouchRange } from "../src/ui/setup/TouchRange.js";

const tabs = [
  { id: "scanner" as const, label: "Scanner", panel: <p>Scanner panel</p> },
  { id: "printer" as const, label: "Printer", panel: <p>Printer panel</p> },
  { id: "sound" as const, label: "Sound", panel: <p>Sound panel</p> },
];

function Harness() {
  const [activeTab, setActiveTab] = useState<SetupTabId>("scanner");
  return <SetupTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />;
}

describe("SetupTabs", () => {
  it("uses semantic roving tabs and mounts only the selected panel", () => {
    render(<Harness />);

    const scanner = screen.getByRole("tab", { name: "Scanner" });
    const printer = screen.getByRole("tab", { name: "Printer" });
    expect(scanner.getAttribute("aria-selected")).toBe("true");
    expect(scanner.getAttribute("tabindex")).toBe("0");
    expect(printer.getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("tabpanel", { name: "Scanner" })).toBeDefined();
    expect(screen.queryByText("Printer panel")).toBeNull();

    fireEvent.click(printer);
    expect(screen.getByRole("tabpanel", { name: "Printer" })).toBeDefined();
    expect(screen.queryByText("Scanner panel")).toBeNull();
  });

  it("moves selection and focus with arrow, Home, and End keys", () => {
    render(<Harness />);

    const scanner = screen.getByRole("tab", { name: "Scanner" });
    scanner.focus();
    fireEvent.keyDown(scanner, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Sound" })).toBe(document.activeElement);
    expect(screen.getByRole("tabpanel", { name: "Sound" })).toBeDefined();

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(screen.getByRole("tab", { name: "Scanner" })).toBe(document.activeElement);

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("tab", { name: "Sound" })).toBe(document.activeElement);
  });
});

describe("TouchRange", () => {
  it("keeps a semantic slider, exposes its value, and handles keyboard steps", () => {
    const onChange = vi.fn();
    const view = render(
      <TouchRange label="Volume" value={0.5} min={0} max={1} step={0.1} onChange={onChange} />,
    );

    const slider = screen.getByRole("slider", { name: "Volume" });
    expect(slider.tagName).toBe("INPUT");
    expect(screen.getByText("0.5").tagName).toBe("OUTPUT");

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(0.6);

    view.rerender(
      <TouchRange label="Volume" value={1} min={0} max={1} step={0.1} onChange={onChange} />,
    );
    fireEvent.keyDown(screen.getByRole("slider", { name: "Volume" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });
});
