import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../src/i18n/index.js";
import { StatusBar } from "../src/ui/StatusBar.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("StatusBar", () => {
  const context = {
    stationName: "Station 04",
    lineName: "Packing A",
    operatorName: "Alex Morgan",
    shiftLabel: "Shift 17",
  };

  it.each([
    ["checking", "Checking"],
    ["reachable", "Available"],
    ["unreachable", "No connection"],
  ] as const)("shows %s server reachability as %s", (serverReachability, expected) => {
    render(
      <StatusBar
        {...context}
        serverReachability={serverReachability}
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={0}
      />,
    );

    expect(screen.getByTestId("server-status").textContent).toBe(expected);
  });

  it("announces server reachability changes politely", () => {
    render(
      <StatusBar
        {...context}
        serverReachability="unreachable"
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={0}
      />,
    );

    const serverStatus = screen.getByTestId("server-status");
    expect(serverStatus.getAttribute("role")).toBe("status");
    expect(serverStatus.getAttribute("aria-live")).toBe("polite");
  });

  it("shows each live context and operational status exactly once", () => {
    render(
      <StatusBar
        {...context}
        serverReachability="unreachable"
        scanner="connected"
        printerConfigured
        syncPending={5}
        syncStuck={false}
        conflicts={2}
      />,
    );

    expect(screen.getAllByText("Station 04")).toHaveLength(1);
    expect(screen.getAllByText("Packing A")).toHaveLength(1);
    expect(screen.getAllByText("Alex Morgan")).toHaveLength(1);
    expect(screen.getAllByText("Shift 17")).toHaveLength(1);
    expect(screen.getAllByText("No connection")).toHaveLength(1);
    expect(screen.getAllByText("Connected")).toHaveLength(1);
    expect(screen.getAllByText("Configured")).toHaveLength(1);
    expect(screen.getAllByText("5")).toHaveLength(1);
    expect(screen.getAllByText("2")).toHaveLength(1);
  });

  it("renders a shift label combining the shift number and the product", () => {
    render(
      <StatusBar
        {...context}
        shiftLabel="AUG26-003/S · Вода"
        serverReachability="reachable"
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={0}
      />,
    );

    const shiftStatus = screen.getByTestId("shift-status");
    expect(shiftStatus.textContent).toContain("AUG26-003/S");
    expect(shiftStatus.textContent).toContain("Вода");
  });

  it("keeps a semantic update entry point visible with severity metadata", () => {
    render(
      <StatusBar
        {...context}
        serverReachability="reachable"
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={0}
        update={{ severity: "warn", glyph: "!", label: "Update 0.1.0-beta.2", available: true }}
        onOpenUpdates={() => {}}
      />,
    );
    const update = screen.getByRole("button", { name: "! Update 0.1.0-beta.2" });
    expect(update.getAttribute("data-update-severity")).toBe("warn");
    // The compact rail paints the glyph and an availability dot; the words stay
    // in the accessible name, which is what AT and the floor tests read.
    expect(update.textContent).toBe("!");
    expect(update.querySelector(".station-update-indicator__dot")).not.toBeNull();
    expect(update.classList.contains("station-rail-button")).toBe(true);
    expect(update.classList.contains("station-rail-button--icon")).toBe(true);
  });

  it("paints the availability dot only when an update is actually available", () => {
    render(
      <StatusBar
        {...context}
        serverReachability="reachable"
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={0}
        update={{ severity: "none", glyph: "↻", label: "Current version", available: false }}
        onOpenUpdates={() => {}}
      />,
    );
    const current = screen.getByRole("button", { name: "↻ Current version" });
    expect(current.textContent).toBe("↻");
    expect(current.querySelector(".station-update-indicator__dot")).toBeNull();
  });

  it("owns update, operator, and window controls inside one labelled action rail", () => {
    render(
      <StatusBar
        {...context}
        serverReachability="reachable"
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={0}
        update={{ severity: "info", glyph: "↻", label: "Current version", available: false }}
        onOpenUpdates={() => {}}
        operatorControl={<button type="button">Change operator</button>}
        windowControl={<button type="button">Window mode</button>}
      />,
    );

    const header = screen.getByRole("banner", { name: "Station status" });
    const actions = within(header).getByRole("group", { name: "Station actions" });
    expect(
      within(actions)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["↻", "Change operator", "Window mode"]);
    // One row at every width: the rail carries no wrapping modifier class.
    expect(actions.className).toBe("station-status-actions");
    expect(within(actions).getByRole("button", { name: "↻ Current version" })).toBeDefined();
  });

  it("does not invent agent or teammate status without a live source", () => {
    render(
      <StatusBar
        {...context}
        serverReachability="reachable"
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={0}
      />,
    );

    expect(screen.queryByText("Agent")).toBeNull();
    expect(screen.queryByText("Terminals")).toBeNull();
  });

  it("reports the keyboard wedge when no serial scanner is configured", () => {
    render(
      <StatusBar
        {...context}
        serverReachability="reachable"
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
        {...context}
        serverReachability="reachable"
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
        {...context}
        serverReachability="reachable"
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
        {...context}
        serverReachability="reachable"
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={0}
      />,
    );
    expect(screen.getByTestId("printer-status").textContent).toBe("Not configured");
  });

  it("opens the printer list from an explicit routing summary", () => {
    let opened = false;
    render(
      <StatusBar
        stationName="Station"
        lineName={null}
        operatorName="Operator"
        shiftLabel={null}
        serverReachability="reachable"
        scanner="keyboard"
        printerConfigured
        syncPending={0}
        syncStuck={false}
        conflicts={0}
        printerSummary={{
          label: "2 / 3",
          detail: "Box: Zebra; Duplicate: TSC; Pallet: Not assigned",
        }}
        onOpenPrinters={() => {
          opened = true;
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Printers: Box: Zebra; Duplicate: TSC; Pallet: Not assigned",
      }),
    );
    expect(opened).toBe(true);
  });

  it("keeps an incomplete routing summary visible during work without claiming all printers ready", () => {
    render(
      <StatusBar
        stationName="Station"
        lineName={null}
        operatorName="Operator"
        shiftLabel="Shift"
        serverReachability="reachable"
        scanner="keyboard"
        printerConfigured
        syncPending={0}
        syncStuck={false}
        conflicts={0}
        printerSummary={{ label: "2 / 3", detail: "Pallet: Not assigned", complete: false }}
      />,
    );
    const value = screen.getByTestId("printer-status");
    expect(value.textContent).toBe("2 / 3");
    expect(value.closest(".station-status-pill")?.getAttribute("data-value-shown")).toBe("true");
    expect(value.closest(".station-status-pill")?.getAttribute("data-tone")).toBe("neutral");
    expect(value.getAttribute("aria-label")).toBe("Pallet: Not assigned");
  });

  it("reports a configured printer as configured, not connected (a printer cannot be proven alive without printing)", () => {
    render(
      <StatusBar
        {...context}
        serverReachability="reachable"
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
        {...context}
        serverReachability="reachable"
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
        {...context}
        serverReachability="reachable"
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
        {...context}
        serverReachability="reachable"
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
        {...context}
        serverReachability="reachable"
        scanner="keyboard"
        printerConfigured={false}
        syncPending={0}
        syncStuck={false}
        conflicts={3}
      />,
    );
    expect(screen.getByTestId("conflicts-status").textContent).toBe("3");
  });

  it("labels duplicate-code conflicts clearly in Russian", async () => {
    await act(() => i18n.changeLanguage("ru"));
    try {
      render(
        <StatusBar
          {...context}
          serverReachability="reachable"
          scanner="keyboard"
          printerConfigured={false}
          syncPending={0}
          syncStuck={false}
          conflicts={15}
        />,
      );
      expect(screen.getByText("Дубли кодов")).toBeDefined();
      expect(screen.getByText("Дубли")).toBeDefined();
      expect(screen.getByTestId("conflicts-status").textContent).toBe("15");
    } finally {
      await act(() => i18n.changeLanguage("en"));
    }
  });

  it("shows nothing to worry about at zero", () => {
    render(
      <StatusBar
        {...context}
        serverReachability="reachable"
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
