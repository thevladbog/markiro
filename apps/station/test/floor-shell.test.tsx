import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { FloorFooter } from "../src/ui/FloorFooter.js";
import { FloorShell } from "../src/ui/FloorShell.js";
import { StationScreen } from "../src/ui/StationScreen.js";
import "../src/station.css";

const repositoryRoot = existsSync(resolve(process.cwd(), "apps/station/src/station.css"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");
const stationCss = readFileSync(resolve(repositoryRoot, "apps/station/src/station.css"), "utf8");

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("StationScreen", () => {
  it("keeps header, content, and actions in distinct fixed slots", () => {
    render(
      <StationScreen title="Select a shift" header={<p>Monday</p>} actions={<button>Back</button>}>
        <p>Shift cards</p>
      </StationScreen>,
    );

    const screenRegion = screen.getByRole("main", { name: "Select a shift" });
    expect(screenRegion.querySelector(".station-screen__header")?.textContent).toContain("Monday");
    expect(screenRegion.querySelector(".station-screen__content")?.textContent).toContain(
      "Shift cards",
    );
    expect(screenRegion.querySelector(".station-screen__actions")?.textContent).toContain("Back");
  });

  it("does not nest a second panel behind its footer actions", () => {
    const scopedFooterRule =
      /\.station-screen__actions > \.station-floor-footer\s*\{([^}]*)\}/.exec(stationCss)?.[1];

    expect(scopedFooterRule).toContain("padding: 0");
    expect(scopedFooterRule).toContain("border-top: 0");
    expect(scopedFooterRule).toContain("background: transparent");
  });
});

const status = {
  stationName: "Station 04",
  lineName: "Packing A",
  operatorName: "Alex Morgan",
  shiftLabel: "Shift 17",
  serverReachability: "reachable" as const,
  scanner: "connected" as const,
  printerConfigured: true,
  syncPending: 2,
  syncStuck: false,
  conflicts: 1,
};

function CurrentFloorScreen() {
  return (
    <main aria-label="Current work screen">
      <p>Current work</p>
    </main>
  );
}

describe("FloorShell", () => {
  it("renders the station root with the bundled UI family as its computed default", () => {
    const bundledUiFamily = '"IBM Plex Sans", system-ui, -apple-system, sans-serif';
    document.documentElement.style.setProperty("--font-ui", bundledUiFamily);
    const stylesheet = document.createElement("style");
    stylesheet.textContent = stationCss;
    document.head.append(stylesheet);

    const { container } = render(
      <FloorShell {...status}>
        <CurrentFloorScreen />
      </FloorShell>,
    );

    const root = container.querySelector(".station-root");
    expect(root).not.toBeNull();
    expect(getComputedStyle(document.documentElement).getPropertyValue("--font-ui")).toBe(
      bundledUiFamily,
    );
    expect(getComputedStyle(root as Element).fontFamily).toBe("var(--font-ui)");

    stylesheet.remove();
    document.documentElement.style.removeProperty("--font-ui");
  });

  it("provides one persistent status banner and one labelled active screen region", () => {
    render(
      <FloorShell {...status} tasks={[]} activeTaskId="" onSelectTask={vi.fn()}>
        <CurrentFloorScreen />
      </FloorShell>,
    );

    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    const activeScreen = screen.getByRole("region", { name: "Active station screen" });
    expect(activeScreen.textContent).toContain("Current work");
  });

  it("keeps the window control in the normal-flow status header", () => {
    const stylesheet = document.createElement("style");
    stylesheet.textContent = stationCss;
    document.head.append(stylesheet);

    const { container } = render(
      <FloorShell {...status} windowControl={<button>Window mode</button>}>
        <CurrentFloorScreen />
      </FloorShell>,
    );
    const header = screen.getByRole("banner", { name: "Station status" });
    const windowControl = within(header).getByRole("button", { name: "Window mode" });

    expect(windowControl).toBeDefined();
    expect(container.querySelector(".station-floor-window-chrome")).toBeNull();
    expect(getComputedStyle(header).display).toBe("grid");
    expect(getComputedStyle(windowControl).position).toBe("static");

    stylesheet.remove();
  });

  it("starts an active-shift header collapsed and restores its controls on demand", () => {
    render(
      <FloorShell
        {...status}
        statusBarCollapsible
        operatorControl={<button>Change operator</button>}
        windowControl={<button>Window mode</button>}
      >
        <CurrentFloorScreen />
      </FloorShell>,
    );

    const collapsedHeader = screen.getByRole("banner", { name: "Station status" });
    expect(collapsedHeader.getAttribute("data-collapsed")).toBe("true");
    expect(within(collapsedHeader).getByTestId("line-status").textContent).toBe("Packing A");
    expect(within(collapsedHeader).getByTestId("shift-status").textContent).toBe("Shift 17");
    expect(within(collapsedHeader).getByTestId("server-status").textContent).toBe("Available");
    expect(within(collapsedHeader).getByTestId("sync-status").textContent).toBe("2");
    expect(within(collapsedHeader).getByTestId("conflicts-status").textContent).toBe("1");
    expect(within(collapsedHeader).getByTestId("scanner-status").textContent).toBe("Connected");
    expect(within(collapsedHeader).getByTestId("printer-status").textContent).toBe("Configured");
    expect(within(collapsedHeader).queryByTestId("operator-status")).toBeNull();
    expect(within(collapsedHeader).queryByRole("button", { name: "Change operator" })).toBeNull();
    expect(within(collapsedHeader).queryByRole("button", { name: "Window mode" })).toBeNull();

    fireEvent.click(within(collapsedHeader).getByRole("button", { name: "Expand status panel" }));

    const expandedHeader = screen.getByRole("banner", { name: "Station status" });
    expect(expandedHeader.getAttribute("data-collapsed")).toBe("false");
    expect(within(expandedHeader).getByTestId("operator-status").textContent).toBe("Alex Morgan");
    expect(within(expandedHeader).getByRole("button", { name: "Change operator" })).toBeDefined();
    expect(within(expandedHeader).getByRole("button", { name: "Window mode" })).toBeDefined();
  });

  it("does not offer header collapse outside an active shift", () => {
    render(
      <FloorShell {...status} shiftLabel={null} statusBarCollapsible>
        <CurrentFloorScreen />
      </FloorShell>,
    );

    expect(screen.queryByRole("button", { name: "Collapse status panel" })).toBeNull();
    expect(
      screen.getByRole("banner", { name: "Station status" }).getAttribute("data-collapsed"),
    ).toBe("false");
  });

  it("does not render an empty task navigation", () => {
    render(
      <FloorShell {...status} tasks={[]} activeTaskId="" onSelectTask={vi.fn()}>
        <p>Current work</p>
      </FloorShell>,
    );

    expect(screen.queryByRole("navigation", { name: "Tasks" })).toBeNull();
  });

  it("renders task navigation only when there are real tasks", () => {
    render(
      <FloorShell
        {...status}
        tasks={[
          { id: "scan", label: "Scan" },
          { id: "exceptions", label: "Corrections" },
        ]}
        activeTaskId="scan"
        onSelectTask={vi.fn()}
      >
        <p>Current work</p>
      </FloorShell>,
    );

    const navigation = screen.getByRole("navigation", { name: "Tasks" });
    expect(navigation.textContent).toContain("Scan");
    expect(navigation.textContent).toContain("Corrections");
  });

  it("adds the fixed action footer only when supplied", () => {
    const { rerender } = render(
      <FloorShell {...status}>
        <p>Current work</p>
      </FloorShell>,
    );
    expect(screen.queryByRole("contentinfo", { name: "Floor actions" })).toBeNull();

    rerender(
      <FloorShell
        {...status}
        footer={
          <FloorFooter ariaLabel="Floor actions">
            <button type="button">Pause</button>
          </FloorFooter>
        }
      >
        <p>Current work</p>
      </FloorShell>,
    );

    expect(screen.getByRole("contentinfo", { name: "Floor actions" }).textContent).toContain(
      "Pause",
    );
  });
});
