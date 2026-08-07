import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
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
});

const status = {
  stationName: "Station 04",
  lineName: "Packing A",
  operatorName: "Alex Morgan",
  shiftLabel: "Shift 17",
  online: true,
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
