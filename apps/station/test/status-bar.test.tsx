import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../src/i18n/index.js";
import { StatusBar } from "../src/ui/StatusBar.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("StatusBar", () => {
  it("reports the keyboard wedge when no serial scanner is configured", () => {
    render(<StatusBar online scanner="keyboard" printerConfigured={false} />);
    expect(screen.getByTestId("scanner-status").textContent).toBe("Keyboard");
  });

  it("reports a connected serial scanner", () => {
    render(<StatusBar online scanner="connected" printerConfigured />);
    expect(screen.getByTestId("scanner-status").textContent).toBe("Connected");
  });

  it("raises the alarm when a configured scanner drops", () => {
    render(<StatusBar online scanner="disconnected" printerConfigured />);
    expect(screen.getByTestId("scanner-status").textContent).toBe("No signal");
  });

  it("reports a printer that is not configured", () => {
    render(<StatusBar online scanner="keyboard" printerConfigured={false} />);
    expect(screen.getByTestId("printer-status").textContent).toBe("Not configured");
  });

  it("reports a configured printer as connected", () => {
    render(<StatusBar online scanner="keyboard" printerConfigured />);
    expect(screen.getByTestId("printer-status").textContent).toBe("Connected");
  });
});
