import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../src/i18n/index.js";
import { StatusBar } from "../src/ui/StatusBar.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("StatusBar", () => {
  it("reports the keyboard wedge when no serial scanner is configured", () => {
    render(
      <StatusBar
        online
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={0}
      />,
    );
    expect(screen.getByTestId("scanner-status").textContent).toBe("Keyboard");
  });

  it("reports a connected serial scanner", () => {
    render(
      <StatusBar
        online
        scanner="connected"
        printerConfigured
        syncPending={0}
        syncStuck={false}
        conflicts={0}
      />,
    );
    expect(screen.getByTestId("scanner-status").textContent).toBe("Connected");
  });

  it("raises the alarm when a configured scanner drops", () => {
    render(
      <StatusBar
        online
        scanner="disconnected"
        printerConfigured
        syncPending={0}
        syncStuck={false}
        conflicts={0}
      />,
    );
    expect(screen.getByTestId("scanner-status").textContent).toBe("No signal");
  });

  it("reports a printer that is not configured", () => {
    render(
      <StatusBar
        online
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={0}
      />,
    );
    expect(screen.getByTestId("printer-status").textContent).toBe("Not configured");
  });

  it("reports a configured printer as configured, not connected (a printer cannot be proven alive without printing)", () => {
    render(
      <StatusBar
        online
        scanner="keyboard"
        printerConfigured
        syncPending={0}
        syncStuck={false}
        conflicts={0}
      />,
    );
    expect(screen.getByTestId("printer-status").textContent).toBe("Configured");
  });

  it("shows the pending count", () => {
    render(
      <StatusBar
        online
        scanner="keyboard"
        printerConfigured={false}
        syncPending={42}
        syncStuck={false}
        conflicts={0}
      />,
    );
    expect(screen.getByTestId("sync-status").textContent).toBe("42");
  });

  it("shows zero pending without a warning", () => {
    render(
      <StatusBar
        online
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={0}
      />,
    );
    expect(screen.getByTestId("sync-status").textContent).toBe("0");
  });

  it("warns when the queue has stopped moving", () => {
    render(
      <StatusBar
        online
        scanner="keyboard"
        printerConfigured={false}
        syncPending={7}
        syncStuck
        conflicts={0}
      />,
    );
    expect(screen.getByTestId("sync-status").textContent).toBe("7 — Not syncing");
  });

  it("shows the conflict count in the status bar", () => {
    render(
      <StatusBar
        online
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={3}
      />,
    );
    expect(screen.getByTestId("conflicts-status").textContent).toBe("3");
  });

  it("shows nothing to worry about at zero", () => {
    render(
      <StatusBar
        online
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={0}
      />,
    );
    expect(screen.getByTestId("conflicts-status").textContent).toBe("0");
  });
});
