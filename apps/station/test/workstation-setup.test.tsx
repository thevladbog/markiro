import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import type { HardwareContract } from "../src/lib/hardware.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import { WorkstationSetup } from "../src/pages/WorkstationSetup.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const noopExec: SqlExecutor = { run: async () => {}, all: async () => [] };

function hardware(overrides: Partial<HardwareContract> = {}): HardwareContract {
  return {
    listScannerPorts: async () => ["COM3", "COM4"],
    openScanner: async () => {},
    closeScanner: async () => {},
    onScan: async () => () => {},
    print: async () => {},
    ...overrides,
  };
}

describe("WorkstationSetup", () => {
  it("lists the discovered scanner ports", async () => {
    render(
      <WorkstationSetup
        hw={hardware()}
        exec={noopExec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onDone={() => {}}
      />,
    );
    expect(await screen.findByText("COM3")).toBeDefined();
  });

  it("shows a scan received during the test", async () => {
    let emit: (raw: string) => void = () => {};
    const hw = hardware({
      onScan: async (listener) => {
        emit = listener;
        return () => {};
      },
    });
    render(
      <WorkstationSetup
        hw={hw}
        exec={noopExec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onDone={() => {}}
      />,
    );

    await waitFor(() => expect(emit).toBeTypeOf("function"));
    emit("0104600000000015");
    expect(await screen.findByText("0104600000000015")).toBeDefined();
  });

  it("surfaces a printing failure instead of failing silently", async () => {
    const hw = hardware({
      print: async () => {
        throw new Error("printer offline");
      },
    });
    render(
      <WorkstationSetup
        hw={hw}
        exec={noopExec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onDone={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Test print" }));
    expect(await screen.findByText(/printer offline/)).toBeDefined();
  });

  it("persists a mute change", async () => {
    const onSoundChange = vi.fn();
    const runs: string[] = [];
    const exec: SqlExecutor = {
      run: async (sql) => {
        runs.push(sql);
      },
      all: async () => [],
    };
    render(
      <WorkstationSetup
        hw={hardware()}
        exec={exec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={onSoundChange}
        onDone={() => {}}
      />,
    );

    fireEvent.click(screen.getByLabelText("Mute"));
    await waitFor(() => expect(onSoundChange).toHaveBeenCalledWith({ muted: true, volume: 1 }));
    expect(runs.some((sql) => sql.includes("station_meta"))).toBe(true);
  });
});
