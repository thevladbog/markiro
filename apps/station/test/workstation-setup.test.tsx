import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import type { HardwareConfig } from "../src/lib/hardware-config.js";
import type { HardwareContract, PrintTarget } from "../src/lib/hardware.js";
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
    onScannerStatus: async () => () => {},
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
        onConfigChange={() => {}}
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
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );

    await waitFor(() => expect(emit).toBeTypeOf("function"));
    act(() => emit("0104600000000015"));
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
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText("Printer port"), { target: { value: "COM5" } });
    fireEvent.click(screen.getByRole("button", { name: "Test print" }));
    expect(await screen.findByText(/printer offline/)).toBeDefined();
  });

  it("sends a serial print target built from the printer port, not the scanner's port", async () => {
    const print = vi.fn(async (_target: PrintTarget, _bytes: Uint8Array) => {});
    const hw = hardware({ print });
    render(
      <WorkstationSetup
        hw={hw}
        exec={noopExec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );

    // Pick a scanner port — this must NOT end up in the print target.
    fireEvent.click(await screen.findByText("COM3"));
    fireEvent.change(screen.getByLabelText("Printer port"), { target: { value: "COM9" } });
    fireEvent.click(screen.getByRole("button", { name: "Test print" }));

    await waitFor(() => expect(print).toHaveBeenCalled());
    const [target] = print.mock.calls[0]!;
    expect(target).toMatchObject({ kind: "serial", port: "COM9" });
  });

  it("disables test print when neither a printer host nor a printer port is set", async () => {
    render(
      <WorkstationSetup
        hw={hardware()}
        exec={noopExec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );

    // No jest-dom matcher in this project's setup, so assert the DOM
    // attribute directly; wait for the port list to settle first so the
    // effects `render` kicked off don't trigger an act() warning after
    // this test's assertion has already run.
    await screen.findByText("COM3");
    const button = screen.getByRole("button", { name: "Test print" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
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
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );

    fireEvent.click(screen.getByLabelText("Mute"));
    await waitFor(() => expect(onSoundChange).toHaveBeenCalledWith({ muted: true, volume: 1 }));
    expect(runs.some((sql) => sql.includes("station_meta"))).toBe(true);
  });

  it("surfaces a sound-save failure without losing the optimistic UI update", async () => {
    const onSoundChange = vi.fn();
    const exec: SqlExecutor = {
      run: async () => {
        throw new Error("database unavailable");
      },
      all: async () => [],
    };
    render(
      <WorkstationSetup
        hw={hardware()}
        exec={exec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={onSoundChange}
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );

    fireEvent.click(screen.getByLabelText("Mute"));
    expect(await screen.findByText(/database unavailable/)).toBeDefined();
    expect(onSoundChange).toHaveBeenCalledWith({ muted: true, volume: 1 });
  });

  it("saves the chosen scanner, printer and language", async () => {
    const runs: [string, unknown[]][] = [];
    const exec: SqlExecutor = {
      run: async (sql, params = []) => {
        runs.push([sql, params]);
      },
      all: async () => [],
    };
    const onConfigChange = vi.fn();

    render(
      <WorkstationSetup
        hw={hardware()}
        exec={exec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onConfigChange={onConfigChange}
        onDone={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "COM3" }));
    fireEvent.change(screen.getByLabelText("Printer address (leave empty for a serial printer)"), {
      target: { value: "10.0.0.7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "TSPL" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const saved = onConfigChange.mock.calls.at(-1)![0] as HardwareConfig;
    expect(saved.scanner).toEqual({ port: "COM3", baud: 9600 });
    expect(saved.printer).toEqual({ kind: "tcp", host: "10.0.0.7", port: 9100 });
    expect(saved.printerLanguage).toBe("tspl");
    expect(runs.some(([sql]) => sql.includes("station_meta"))).toBe(true);
  });

  it("keeps a serial printer's own baud rate when there is no scanner configured", async () => {
    // A documented valid state: no scanner (keyboard wedge), serial printer
    // previously saved at a non-default baud. Reopening Setup and pressing
    // Done without touching anything must round-trip that baud unchanged.
    const stored: HardwareConfig = {
      scanner: null,
      printer: { kind: "serial", port: "COM7", baud: 19200 },
      printerLanguage: "zpl",
    };
    const exec: SqlExecutor = {
      run: async () => {},
      all: async <T,>() => [{ value: JSON.stringify(stored) }] as T[],
    };
    const onConfigChange = vi.fn();

    render(
      <WorkstationSetup
        hw={hardware()}
        exec={exec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onConfigChange={onConfigChange}
        onDone={() => {}}
      />,
    );

    // Wait for the seed effect to populate the printer port before pressing Done.
    await waitFor(() =>
      expect((screen.getByLabelText("Printer port") as HTMLInputElement).value).toBe("COM7"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const saved = onConfigChange.mock.calls.at(-1)![0] as HardwareConfig;
    expect(saved.scanner).toBeNull();
    expect(saved.printer).toEqual({ kind: "serial", port: "COM7", baud: 19200 });
  });

  it("closes the current scanner before opening another port", async () => {
    const calls: string[] = [];
    const hw = hardware({
      closeScanner: async () => {
        calls.push("close");
      },
      openScanner: async () => {
        calls.push("open");
      },
    });

    render(
      <WorkstationSetup
        hw={hw}
        exec={{ run: async () => {}, all: async () => [] }}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "COM3" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect scanner" }));
    await waitFor(() => expect(calls).toEqual(["close", "open"]));
  });
});
