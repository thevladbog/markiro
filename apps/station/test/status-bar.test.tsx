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
    expect(screen.getByText("Keyboard")).toBeDefined();
  });

  it("reports a connected serial scanner", () => {
    // printerConfigured is false here (rather than the task brief's `true`
    // shorthand) so the printer indicator doesn't also render "Connected" —
    // the Agent indicator is unconditionally "Not configured" in this slice,
    // and a connected printer would collide with the scanner's own
    // "Connected" text, making getByText ambiguous for a check that is only
    // about the scanner.
    render(<StatusBar online scanner="connected" printerConfigured={false} />);
    expect(screen.getByText("Connected")).toBeDefined();
  });

  it("raises the alarm when a configured scanner drops", () => {
    render(<StatusBar online scanner="disconnected" printerConfigured />);
    expect(screen.getByText("No signal")).toBeDefined();
  });

  it("reports a printer that is not configured", () => {
    // Two elements legitimately read "Not configured" here: the Agent
    // indicator (unconditionally so in this slice) and the Printer
    // indicator under test — hence getAllByText with an explicit count
    // rather than the brief's single getByText.
    render(<StatusBar online scanner="keyboard" printerConfigured={false} />);
    expect(screen.getAllByText("Not configured")).toHaveLength(2);
  });
});
