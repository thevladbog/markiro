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
    listUsbPrinters: async () => [],
    openScanner: async () => {},
    closeScanner: async () => {},
    onScan: async () => () => {},
    onScannerStatus: async () => () => {},
    print: async () => {},
    ...overrides,
  };
}

async function selectSetupTab(name: "Scanner" | "Printer" | "Sound") {
  fireEvent.click(await screen.findByRole("tab", { name }));
}

async function chooseScannerPort(value: string) {
  fireEvent.change(await screen.findByRole("combobox", { name: "Port" }), {
    target: { value },
  });
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

  it("keeps a long discovered scanner list in one bounded floor selector", async () => {
    render(
      <WorkstationSetup
        hw={hardware({
          listScannerPorts: async () => Array.from({ length: 12 }, (_, index) => `COM${index + 1}`),
        })}
        exec={noopExec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );

    const selector = await screen.findByRole("combobox", { name: "Port" });
    expect(selector.className).toContain("mk-select__control");
    expect(selector.querySelectorAll("option")).toHaveLength(13);
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
    expect(await screen.findByText(/0104600000000015/)).toBeDefined();
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

    // Wait for the config-load effect to settle (Finding 4 disables every
    // field, including the transport selector, until it does) before
    // switching to the serial transport to reveal "Printer port".
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "Serial (COM port)" }));
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
    await chooseScannerPort("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "Serial (COM port)" }));
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
    await selectSetupTab("Printer");
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

    await selectSetupTab("Sound");
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

    await selectSetupTab("Sound");
    fireEvent.click(screen.getByLabelText("Mute"));
    expect(await screen.findByText(/database unavailable/)).toBeDefined();
    expect(onSoundChange).toHaveBeenCalledWith({ muted: true, volume: 1 });
  });

  it("does not claim to play a sound while muted or at zero volume", async () => {
    const mutedView = render(
      <WorkstationSetup
        hw={hardware()}
        exec={noopExec}
        sound={{ muted: true, volume: 1 }}
        onSoundChange={() => {}}
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );

    await selectSetupTab("Sound");
    const mutedTest = screen.getByRole("button", { name: "Test sound" }) as HTMLButtonElement;
    expect(mutedTest.disabled).toBe(true);
    expect(screen.getByTestId("setup-result").textContent).toBe(
      "Enable sound and set volume above zero to play a test.",
    );

    mutedView.unmount();

    render(
      <WorkstationSetup
        hw={hardware()}
        exec={noopExec}
        sound={{ muted: false, volume: 0 }}
        onSoundChange={() => {}}
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );

    await selectSetupTab("Sound");
    const zeroTest = screen.getByRole("button", { name: "Test sound" }) as HTMLButtonElement;
    expect(zeroTest.disabled).toBe(true);
    expect(screen.getByTestId("setup-result").textContent).toBe(
      "Enable sound and set volume above zero to play a test.",
    );
  });

  it("reports a non-zero sound test as requested and still persists volume changes", async () => {
    const onSoundChange = vi.fn();
    const runs: [string, unknown[]][] = [];
    const exec: SqlExecutor = {
      run: async (sql, params = []) => {
        runs.push([sql, params]);
      },
      all: async () => [],
    };

    const view = render(
      <WorkstationSetup
        hw={hardware()}
        exec={exec}
        sound={{ muted: false, volume: 0.7 }}
        onSoundChange={onSoundChange}
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );

    await selectSetupTab("Sound");
    const testButton = screen.getByRole("button", { name: "Test sound" }) as HTMLButtonElement;
    expect(testButton.disabled).toBe(false);
    fireEvent.click(testButton);
    expect(screen.getByTestId("setup-result").textContent).toBe("Sound test requested.");

    fireEvent.change(screen.getByRole("slider", { name: "Volume" }), {
      target: { value: "0.4" },
    });
    await waitFor(() => expect(onSoundChange).toHaveBeenCalledWith({ muted: false, volume: 0.4 }));
    expect(
      runs.some(
        ([sql, params]) =>
          sql.includes("station_meta") &&
          params.some((value) => typeof value === "string" && value.includes('"volume":0.4')),
      ),
    ).toBe(true);
    expect(screen.getByTestId("setup-result").textContent).toBe(
      "Set a clearly audible level; visual signals remain available when muted.",
    );

    view.rerender(
      <WorkstationSetup
        hw={hardware()}
        exec={exec}
        sound={{ muted: true, volume: 0.4 }}
        onSoundChange={onSoundChange}
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );
    expect((screen.getByRole("button", { name: "Test sound" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId("setup-result").textContent).toBe(
      "Enable sound and set volume above zero to play a test.",
    );

    view.rerender(
      <WorkstationSetup
        hw={hardware()}
        exec={exec}
        sound={{ muted: false, volume: 0.4 }}
        onSoundChange={onSoundChange}
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );
    expect(screen.getByTestId("setup-result").textContent).toBe(
      "Set a clearly audible level; visual signals remain available when muted.",
    );
    expect(screen.queryByText("Sound test requested.")).toBeNull();
  });

  it("requires explicit confirmation before removing station credentials for re-pairing", async () => {
    const onResetCredential = vi.fn(async () => {});

    render(
      <WorkstationSetup
        hw={hardware()}
        exec={noopExec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onConfigChange={() => {}}
        onResetCredential={onResetCredential}
        onDone={() => {}}
      />,
    );

    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("button", { name: "Re-pair this station" }));

    expect(onResetCredential).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Remove credentials and re-pair?" })).toBeDefined();
    expect(
      screen.getByText(
        "This removes this station's credentials and returns to pairing. Local production records remain preserved.",
      ),
    ).toBeDefined();

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Remove credentials and re-pair" });
    expect(cancel.style.height).toBe("var(--control-floor)");
    expect(confirm.style.height).toBe("var(--control-floor)");

    fireEvent.click(cancel);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onResetCredential).not.toHaveBeenCalled();

    await selectSetupTab("Sound");
    fireEvent.click(screen.getByRole("button", { name: "Re-pair this station" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove credentials and re-pair" }));
    await waitFor(() => expect(onResetCredential).toHaveBeenCalledTimes(1));
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

    await chooseScannerPort("COM3");
    await selectSetupTab("Printer");
    // "No printer" is the default transport; select TCP explicitly.
    fireEvent.click(screen.getByRole("radio", { name: "Network (TCP)" }));
    fireEvent.change(screen.getByLabelText("Printer address"), {
      target: { value: "10.0.0.7" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "TSPL" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const saved = onConfigChange.mock.calls.at(-1)![0] as HardwareConfig;
    expect(saved.scanner).toEqual({ port: "COM3", baud: 9600 });
    expect(saved.printer).toEqual({ kind: "tcp", host: "10.0.0.7", port: 9100 });
    expect(saved.printerLanguage).toBe("tspl");
    expect(runs.some(([sql]) => sql.includes("station_meta"))).toBe(true);
  });

  // Task 13 review, Finding 5: existing fixtures only ever carried
  // `verifyPrintedLabel: false` (or round-tripped a stored value unchanged)
  // -- nothing here actually toggled the checkbox and asserted the SAVED
  // config carries `true`. A printer is configured first: with no printer,
  // the checkbox is disabled and the value is forced to `false` on save
  // (see the checkbox's own comment in WorkstationSetup.tsx), which would
  // make this test pass for the wrong reason.
  it("persists a ticked verify-printed-label checkbox", async () => {
    const exec: SqlExecutor = { run: async () => {}, all: async () => [] };
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

    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "Network (TCP)" }));
    fireEvent.change(screen.getByLabelText("Printer address"), {
      target: { value: "10.0.0.7" },
    });
    fireEvent.click(screen.getByLabelText("Verify each printed label by scanning it back"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const saved = onConfigChange.mock.calls.at(-1)![0] as HardwareConfig;
    expect(saved.verifyPrintedLabel).toBe(true);
  });

  it("disables and force-clears the verify-printed-label checkbox when no printer is configured", async () => {
    const exec: SqlExecutor = { run: async () => {}, all: async () => [] };
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

    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    const checkbox = screen.getByLabelText(
      "Verify each printed label by scanning it back",
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);

    await selectSetupTab("Scanner");
    await chooseScannerPort("COM3");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const saved = onConfigChange.mock.calls.at(-1)![0] as HardwareConfig;
    expect(saved.printer).toBeNull();
    expect(saved.verifyPrintedLabel).toBe(false);
  });

  it("keeps a serial printer's own baud rate when there is no scanner configured", async () => {
    // A documented valid state: no scanner (keyboard wedge), serial printer
    // previously saved at a non-default baud. Reopening Setup and pressing
    // Done without touching anything must round-trip that baud unchanged.
    const stored: HardwareConfig = {
      scanner: null,
      printer: { kind: "serial", port: "COM7", baud: 19200 },
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
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

    await selectSetupTab("Printer");
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

  it("round-trips a stored serial scanner's own baud rate unchanged when Done is pressed without changes", async () => {
    // The fourth documented valid state alongside the two above: a serial
    // scanner previously saved at a non-default baud, no printer configured.
    // Reopening Setup and pressing Done without touching anything must
    // round-trip that baud unchanged.
    const stored: HardwareConfig = {
      scanner: { port: "COM3", baud: 19200 },
      printer: null,
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
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

    // Wait for the seed effect to populate the scanner baud before pressing Done.
    await waitFor(() =>
      expect((screen.getByLabelText("Baud rate") as HTMLInputElement).value).toBe("19200"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const saved = onConfigChange.mock.calls.at(-1)![0] as HardwareConfig;
    expect(saved).toEqual(stored);
  });

  it("renders the no-scanner option even when the discovered port list is empty (Finding 1)", async () => {
    const hw = hardware({ listScannerPorts: async () => [] });
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

    const selector = (await screen.findByRole("combobox", { name: "Port" })) as HTMLSelectElement;
    expect(selector.value).toBe("");
    expect(
      screen.getByRole("option", { name: "No serial scanner (keyboard-wedge)" }),
    ).toBeDefined();
  });

  it("saves scanner: null after choosing the no-scanner option with a stored serial config (Finding 1)", async () => {
    const stored: HardwareConfig = {
      scanner: { port: "COM3", baud: 9600 },
      printer: null,
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
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

    // Wait for the seed effect to restore the stored port before deselecting it.
    await waitFor(() =>
      expect((screen.getByRole("combobox", { name: "Port" }) as HTMLSelectElement).value).toBe(
        "COM3",
      ),
    );
    await chooseScannerPort("");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const saved = onConfigChange.mock.calls.at(-1)![0] as HardwareConfig;
    expect(saved.scanner).toBeNull();
  });

  it("keeps a TCP printer's own port when there is no scanner configured (Finding 6)", async () => {
    // A documented valid state: no scanner (keyboard wedge), TCP printer
    // previously saved at a non-default port. Reopening Setup and pressing
    // Done without touching anything must round-trip that port unchanged.
    const stored: HardwareConfig = {
      scanner: null,
      printer: { kind: "tcp", host: "10.0.0.9", port: 9200 },
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
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

    await selectSetupTab("Printer");
    // Wait for the seed effect to populate the TCP port before pressing Done.
    await waitFor(() =>
      expect((screen.getByLabelText("Printer TCP port") as HTMLInputElement).value).toBe("9200"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const saved = onConfigChange.mock.calls.at(-1)![0] as HardwareConfig;
    expect(saved.scanner).toBeNull();
    expect(saved.printer).toEqual({ kind: "tcp", host: "10.0.0.9", port: 9200 });
  });

  it("shows a stored scanner port as selected when listScannerPorts() no longer reports it, and lets the operator switch away from it (Finding 4)", async () => {
    const stored: HardwareConfig = {
      scanner: { port: "COM3", baud: 9600 },
      printer: null,
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
    };
    const exec: SqlExecutor = {
      run: async () => {},
      all: async <T,>() => [{ value: JSON.stringify(stored) }] as T[],
    };
    const onConfigChange = vi.fn();
    // COM3 is configured but no longer discovered -- e.g. the serial
    // scanner was replaced by a USB HID wedge, exactly the scenario the
    // no-scanner button (Finding 1) was added for.
    const hw = hardware({ listScannerPorts: async () => ["COM9"] });

    render(
      <WorkstationSetup
        hw={hw}
        exec={exec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onConfigChange={onConfigChange}
        onDone={() => {}}
      />,
    );

    // The stored, undetected port must render as its own selected option --
    // not silently absent, and not confusable with the unrelated "no
    // scanner" option, which would otherwise be the only thing on screen.
    const staleOption = await screen.findByRole("option", {
      name: "COM3 (configured, not detected)",
    });
    expect((staleOption as HTMLOptionElement).selected).toBe(true);

    await chooseScannerPort("");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const saved = onConfigChange.mock.calls.at(-1)![0] as HardwareConfig;
    expect(saved.scanner).toBeNull();
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

    await chooseScannerPort("COM3");
    fireEvent.click(screen.getByRole("button", { name: "Connect scanner" }));
    await waitFor(() => expect(calls).toEqual(["close", "open"]));
  });

  it("rejects an out-of-range TCP printer port instead of persisting it (Finding 1)", async () => {
    const runs: string[] = [];
    const exec: SqlExecutor = {
      run: async (sql) => {
        runs.push(sql);
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

    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    // "No printer" is the default transport now (Finding 2, PR12 round 2),
    // so TCP must be selected explicitly before its fields render.
    fireEvent.click(screen.getByRole("radio", { name: "Network (TCP)" }));
    fireEvent.change(screen.getByLabelText("Printer address"), {
      target: { value: "10.0.0.7" },
    });
    // 70000 is above u16::MAX (65535) -- Rust's `print_bytes` cannot
    // deserialize it, so it must never reach `station_meta`.
    fireEvent.change(screen.getByLabelText("Printer TCP port"), {
      target: { value: "70000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(await screen.findByText("Enter a valid number in the allowed range.")).toBeDefined();
    expect(onConfigChange).not.toHaveBeenCalled();
    expect(runs.some((sql) => sql.includes("station_meta"))).toBe(false);
  });

  it("rejects a negative, fractional, or infinite scanner baud instead of persisting it (Finding 1)", async () => {
    const onConfigChange = vi.fn();
    const exec: SqlExecutor = { run: async () => {}, all: async () => [] };

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

    await chooseScannerPort("COM3");

    for (const bad of ["-1", "1.5", "Infinity"]) {
      fireEvent.change(screen.getByLabelText("Baud rate"), { target: { value: bad } });
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(await screen.findByText("Enter a valid number in the allowed range.")).toBeDefined();
      await waitFor(() => expect(onConfigChange).not.toHaveBeenCalled());
    }
  });

  it("disables Back while a scanner open is pending, and re-enables it once settled (Finding 2)", async () => {
    let resolveOpen: () => void = () => {};
    const hw = hardware({
      openScanner: () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve;
        }),
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

    await chooseScannerPort("COM3");
    fireEvent.click(screen.getByRole("button", { name: "Connect scanner" }));

    // The open is still in flight: Back must not be available, or an
    // operator leaving now could race the app's saved-config reconciliation
    // against this abandoned open.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );

    resolveOpen();

    // Once the open settles, Back must be available again -- an operator is
    // never stranded here.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("switching a stored TCP printer's transport to serial persists a serial target, not the stale TCP one (Finding 3)", async () => {
    const stored: HardwareConfig = {
      scanner: null,
      printer: { kind: "tcp", host: "10.0.0.9", port: 9200 },
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
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

    await selectSetupTab("Printer");
    // Wait for the seed effect to restore the stored TCP printer before
    // switching transports.
    await waitFor(() =>
      expect((screen.getByLabelText("Printer address") as HTMLInputElement).value).toBe("10.0.0.9"),
    );

    fireEvent.click(screen.getByRole("radio", { name: "Serial (COM port)" }));
    fireEvent.change(screen.getByLabelText("Printer port"), { target: { value: "COM7" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const saved = onConfigChange.mock.calls.at(-1)![0] as HardwareConfig;
    expect(saved.printer).toEqual({ kind: "serial", port: "COM7", baud: 9600 });
  });

  it("pressing Done before the stored configuration has loaded does not erase it (Finding 4)", async () => {
    const stored: HardwareConfig = {
      scanner: { port: "COM9", baud: 19200 },
      printer: { kind: "serial", port: "COM7", baud: 19200 },
      printerLanguage: "tspl",
      verifyPrintedLabel: false,
    };
    let resolveAll: (rows: unknown[]) => void = () => {};
    const exec: SqlExecutor = {
      run: async () => {},
      all: <T,>() =>
        new Promise<T[]>((resolve) => {
          resolveAll = resolve as (rows: unknown[]) => void;
        }),
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

    // The stored configuration has not resolved yet -- Done must be
    // disabled, so pressing it now must do nothing (rather than persisting
    // the blank defaults this screen starts with and erasing what is
    // actually stored).
    const doneButton = screen.getByRole("button", { name: "Done" }) as HTMLButtonElement;
    expect(doneButton.disabled).toBe(true);
    fireEvent.click(doneButton);
    expect(onConfigChange).not.toHaveBeenCalled();

    // Now let the stored configuration load, and confirm Done persists the
    // actual stored values, not the blank defaults the screen started with.
    resolveAll([{ value: JSON.stringify(stored) }]);
    await waitFor(() => expect(doneButton.disabled).toBe(false));
    fireEvent.click(doneButton);

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const saved = onConfigChange.mock.calls.at(-1)![0] as HardwareConfig;
    expect(saved).toEqual(stored);
  });

  it("rejects a baud of 0 instead of persisting it as a working scanner baud (PR12 round 2, Finding 1)", async () => {
    // Before the fix, `parseBaud` only rejected `n < 0`, so 0 slipped through
    // as "valid" and got persisted. `open_scanner(port, 0)` sets POSIX B0,
    // which does not fail to open -- the status bar would show connected
    // while the scanner never delivers a scan.
    const onConfigChange = vi.fn();
    const exec: SqlExecutor = { run: async () => {}, all: async () => [] };

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

    await chooseScannerPort("COM3");
    fireEvent.change(screen.getByLabelText("Baud rate"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(await screen.findByText("Enter a valid number in the allowed range.")).toBeDefined();
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it("shows an error instead of silently clearing a stored printer when the newly selected transport's field is left empty (PR12 round 2, Finding 2)", async () => {
    // Before the fix, switching from a stored TCP printer to Serial and
    // pressing Done without typing a port persisted `printer: null` with no
    // warning -- the configured printer was silently gone.
    const stored: HardwareConfig = {
      scanner: null,
      printer: { kind: "tcp", host: "10.0.0.9", port: 9200 },
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
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

    await selectSetupTab("Printer");
    await waitFor(() =>
      expect((screen.getByLabelText("Printer address") as HTMLInputElement).value).toBe("10.0.0.9"),
    );

    fireEvent.click(screen.getByRole("radio", { name: "Serial (COM port)" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(
      await screen.findByText(
        'Enter the required printer connection details, or choose "No printer".',
      ),
    ).toBeDefined();
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it("mounts one guided setup panel and makes Next equivalent to direct tab selection", async () => {
    render(
      <WorkstationSetup
        hw={hardware()}
        exec={noopExec}
        sound={{ muted: false, volume: 0.7 }}
        onSoundChange={() => {}}
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );

    await screen.findByText("COM3");
    expect(screen.getByRole("tabpanel", { name: "Scanner" })).toBeDefined();
    expect(screen.queryByLabelText("Printer address")).toBeNull();
    expect(screen.queryByLabelText("Mute")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("tabpanel", { name: "Printer" })).toBeDefined();
    expect(screen.queryByLabelText("Baud rate")).toBeNull();

    await selectSetupTab("Sound");
    expect(screen.getByRole("tabpanel", { name: "Sound" })).toBeDefined();
    expect(screen.getByLabelText("Mute")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  const defaultProps = {
    exec: noopExec,
    sound: { muted: false, volume: 1 },
    onSoundChange: () => {},
    onConfigChange: () => {},
    onDone: () => {},
  };

  it("sends a test print to the selected USB printer", async () => {
    const print = vi.fn<(target: PrintTarget, bytes: Uint8Array) => Promise<void>>(
      async () => {},
    );
    const hw = hardware({
      listUsbPrinters: async () => [
        { name: "Zebra ZD421", port: "USB001" },
        { name: "TSC TE200", port: "USB002" },
      ],
      print,
    });
    render(<WorkstationSetup hw={hw} {...defaultProps} />);
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "USB" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Zebra ZD421 · USB001" }));
    fireEvent.click(screen.getByRole("button", { name: "Test print" }));
    await waitFor(() =>
      expect(print).toHaveBeenCalledWith(
        { kind: "usb", printer: "Zebra ZD421" },
        expect.any(Uint8Array),
      ),
    );
  });

  it("shows the empty hint and refreshes the USB list on demand", async () => {
    const listUsbPrinters = vi
      .fn<() => Promise<{ name: string; port: string }[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: "Zebra ZD421", port: "USB001" }]);
    render(<WorkstationSetup hw={hardware({ listUsbPrinters })} {...defaultProps} />);
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "USB" }));
    expect(await screen.findByText(/No USB printers found/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Refresh list" }));
    expect(await screen.findByRole("radio", { name: "Zebra ZD421 · USB001" })).toBeDefined();
  });

  it("keeps a configured USB printer selectable when detection no longer lists it", async () => {
    const storedExec: SqlExecutor = {
      run: async () => {},
      all: async <T,>() =>
        [
          {
            value: JSON.stringify({
              scanner: null,
              printer: { kind: "usb", printer: "Zebra ZD421" },
              printerLanguage: "tspl",
              verifyPrintedLabel: false,
            }),
          },
        ] as T[],
    };
    render(<WorkstationSetup hw={hardware()} {...defaultProps} exec={storedExec} />);
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    const missing = await screen.findByRole("radio", {
      name: "Zebra ZD421 (configured, not detected)",
    });
    expect((missing as HTMLInputElement).checked).toBe(true);
  });

  it("saves the USB printer into the hardware config", async () => {
    const onConfigChange = vi.fn();
    const hw = hardware({
      listUsbPrinters: async () => [{ name: "TSC TE200", port: "USB002" }],
    });
    render(
      <WorkstationSetup hw={hw} {...defaultProps} onConfigChange={onConfigChange} />,
    );
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "USB" }));
    fireEvent.click(await screen.findByRole("radio", { name: "TSC TE200 · USB002" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(onConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({ printer: { kind: "usb", printer: "TSC TE200" } }),
      ),
    );
  });

  it("rejects finishing with the USB transport and no printer chosen", async () => {
    render(<WorkstationSetup hw={hardware()} {...defaultProps} />);
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "USB" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(
      await screen.findByText(/Enter the required printer connection details/),
    ).toBeDefined();
  });

  it("keeps the test result and exit controls in fixed layout regions", async () => {
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

    await screen.findByText("COM3");
    expect(screen.getByTestId("setup-result").className).toContain("workstation-setup__result");
    expect(screen.getByTestId("setup-footer").className).toContain("workstation-setup__footer");
  });
});
