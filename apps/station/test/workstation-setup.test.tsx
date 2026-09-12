import { DatabaseSync } from "node:sqlite";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { saveHardwareConfig, type HardwareConfig } from "../src/lib/hardware-config.js";
import type { HardwareContract, PrintTarget, ScannerConnection } from "../src/lib/hardware.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { WorkstationSetup } from "../src/pages/WorkstationSetup.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const noopExec: SqlExecutor = { run: async () => {}, all: async () => [] };

// Same shape as hardware-config.test.ts's `nodeExecutor`: a real migrated
// in-memory SQLite instance, seeded through the actual `saveHardwareConfig`
// write path rather than a hand-crafted row shape.
async function storedHardwareExec(config: HardwareConfig): Promise<SqlExecutor> {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExecutor = {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  await applyMigrations(exec);
  await saveHardwareConfig(exec, config);
  return exec;
}

function hardware(overrides: Partial<HardwareContract> = {}): HardwareContract {
  return {
    listScannerPorts: async () => ["COM3", "COM4"],
    listUsbPrinters: async () => [],
    configureScanners: async () => {},
    closeScanner: async () => {},
    onScan: async () => () => {},
    onScannerConnections: async () => () => {},
    onScannerStatus: async () => () => {},
    print: async () => {},
    ...overrides,
  };
}

async function selectSetupTab(name: "Scanner" | "Printer" | "Sound") {
  fireEvent.click(await screen.findByRole("tab", { name: name === "Printer" ? "Printers" : name }));
  if (name === "Printer") {
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Add printer" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    const edit = screen.queryAllByRole("button", { name: /^Edit / })[0];
    fireEvent.click(edit ?? screen.getByRole("button", { name: "Add printer" }));
  }
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

  it("verifies a scan against the on-screen code and rejects any other code", async () => {
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
    const code = screen.getByTestId("scanner-test-code").textContent ?? "";
    expect(code).toMatch(/^MKR-[34789ACDEFHKMNPRTWXY]{6}$/);

    act(() => emit("something-else"));
    const mismatch = screen.getByTestId("scanner-check-result");
    expect(mismatch.getAttribute("data-tone")).toBe("error");
    expect(mismatch.textContent).toContain("something-else");

    act(() => emit(code));
    expect(screen.getByTestId("scanner-check-result").getAttribute("data-tone")).toBe("ok");
    expect(screen.getByTestId("scanner-check-result").textContent).toContain(
      "the scanner works correctly",
    );

    // A new code invalidates the old verdict AND the old code.
    fireEvent.click(screen.getByRole("button", { name: "New code" }));
    expect(screen.queryByTestId("scanner-check-result")).toBeNull();
    const next = screen.getByTestId("scanner-test-code").textContent ?? "";
    act(() => emit(code === next ? "stale" : code));
    expect(screen.getByTestId("scanner-check-result").getAttribute("data-tone")).toBe("error");
  });

  it("prints a barcode test label and verifies the scanned label against it", async () => {
    let emit: (raw: string) => void = () => {};
    const printed: Uint8Array[] = [];
    const hw = hardware({
      onScan: async (listener) => {
        emit = listener;
        return () => {};
      },
      print: async (_target, bytes) => {
        printed.push(bytes);
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
    await screen.findByText("COM3");
    await waitFor(() => expect(emit).toBeTypeOf("function"));
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "Serial (COM port)" }));
    fireEvent.change(screen.getByLabelText("Printer port"), { target: { value: "COM9" } });
    fireEvent.click(screen.getByRole("button", { name: "Test print" }));
    await waitFor(() => expect(printed).toHaveLength(1));

    // The label preview names the printed code, and the ZPL bytes carry it.
    const label = await screen.findByTestId("printer-test-label");
    const code = label.querySelector("code")?.textContent ?? "";
    expect(code).toMatch(/^MKR-/);
    expect(new TextDecoder().decode(printed[0])).toContain(code);

    // A wrong scan fails the check; scanning the printed code passes it.
    act(() => emit("not-that-label"));
    expect(screen.getByTestId("printer-check-result").getAttribute("data-tone")).toBe("error");
    act(() => emit(code));
    const verdict = screen.getByTestId("printer-check-result");
    expect(verdict.getAttribute("data-tone")).toBe("ok");
    expect(verdict.textContent).toContain("the printer works");
  });

  it("prints the test label at the configured printer resolution", async () => {
    const printed: Uint8Array[] = [];
    const hw = hardware({
      print: async (_target, bytes) => {
        printed.push(bytes);
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
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "Serial (COM port)" }));
    fireEvent.change(screen.getByLabelText("Printer port"), { target: { value: "COM9" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Printer resolution" }), {
      target: { value: "300" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test print" }));
    await waitFor(() => expect(printed).toHaveLength(1));
    // 58×40 mm at 300 dpi; a 203 dpi print would open with ^PW464.
    expect(new TextDecoder().decode(printed[0])).toContain("^PW685");
    expect(
      screen.getByText(
        "Every label prints at this resolution. Until it is set, box labels print at the template's resolution and duplicate printing is unavailable.",
      ),
    ).toBeDefined();
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

    fireEvent.click(await screen.findByRole("tab", { name: "Printers" }));
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
    fireEvent.change(screen.getByRole("combobox", { name: "Printer resolution" }), {
      target: { value: "300" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const saved = onConfigChange.mock.calls.at(-1)![0] as HardwareConfig;
    expect(saved.scanner).toEqual({ port: "COM3", baud: 9600 });
    expect(saved.printer).toEqual({ kind: "tcp", host: "10.0.0.7", port: 9100 });
    expect(saved.printerLanguage).toBe("tspl");
    expect(saved.printerDpi).toBe(300);
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
    fireEvent.click(screen.getByRole("button", { name: "Save printer" }));
    fireEvent.click(screen.getByLabelText("Verify each box label by scanning it back"));
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
    fireEvent.click(await screen.findByRole("tab", { name: "Printers" }));
    const checkbox = screen.getByLabelText(
      "Verify each box label by scanning it back",
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
    expect(saved).toEqual(
      expect.objectContaining({ ...stored, scanners: [stored.scanner], printerDpi: null }),
    );
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

  it("reconciles the selected scanners without globally closing healthy readers", async () => {
    const calls: string[] = [];
    const hw = hardware({
      closeScanner: async () => {
        calls.push("close");
      },
      configureScanners: async () => {
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
    await waitFor(() => expect(calls).toEqual(["open"]));
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
      configureScanners: () =>
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
    expect(saved).toEqual(
      expect.objectContaining({ ...stored, scanners: [stored.scanner], printerDpi: null }),
    );
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
      await screen.findByText("Enter the required printer connection details, or cancel editing."),
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
    expect(screen.getByRole("tabpanel", { name: "Printers" })).toBeDefined();
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
    const print = vi.fn<(target: PrintTarget, bytes: Uint8Array) => Promise<void>>(async () => {});
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
    fireEvent.click(screen.getByRole("radio", { name: "Windows (USB)" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Windows printer" }), {
      target: { value: "Zebra ZD421" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test print" }));
    await waitFor(() =>
      expect(print).toHaveBeenCalledWith(
        { kind: "usb", printer: "Zebra ZD421" },
        expect.any(Uint8Array),
      ),
    );
  });

  it("keeps the Windows printer selector visible and refreshes its options on demand", async () => {
    const listUsbPrinters = vi
      .fn<() => Promise<{ name: string; port: string }[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: "Zebra ZD421", port: "USB001" }]);
    render(<WorkstationSetup hw={hardware({ listUsbPrinters })} {...defaultProps} />);
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "Windows (USB)" }));
    const emptySelector = await screen.findByRole("combobox", { name: "Windows printer" });
    expect((emptySelector as HTMLSelectElement).disabled).toBe(true);
    expect(
      screen.getByRole("option", { name: /No installed Windows printers found/ }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Refresh list" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("combobox", { name: "Windows printer" }) as HTMLSelectElement).disabled,
      ).toBe(false),
    );
    expect(screen.getByRole("option", { name: "Zebra ZD421 · USB001" })).toBeDefined();
  });

  it("offers an installed printer whose Windows port is not named USB", async () => {
    render(
      <WorkstationSetup
        hw={hardware({
          listUsbPrinters: async () => [{ name: "TSC TE200", port: "TSC_DRIVER_PORT" }],
        })}
        {...defaultProps}
      />,
    );
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "Windows (USB)" }));

    expect(
      await screen.findByRole("option", { name: "TSC TE200 · TSC_DRIVER_PORT" }),
    ).toBeDefined();
  });

  it("keeps a configured USB printer selectable when detection no longer lists it", async () => {
    const storedExec = await storedHardwareExec({
      scanner: null,
      printer: { kind: "usb", printer: "Zebra ZD421" },
      printerLanguage: "tspl",
      verifyPrintedLabel: false,
    });
    render(<WorkstationSetup hw={hardware()} {...defaultProps} exec={storedExec} />);
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    const selector = await screen.findByRole("combobox", { name: "Windows printer" });
    expect((selector as HTMLSelectElement).value).toBe("Zebra ZD421");
    expect(
      screen.getByRole("option", { name: "Zebra ZD421 (configured, not detected)" }),
    ).toBeDefined();
  });

  it("saves the USB printer into the hardware config", async () => {
    const onConfigChange = vi.fn();
    const hw = hardware({
      listUsbPrinters: async () => [{ name: "TSC TE200", port: "USB002" }],
    });
    render(<WorkstationSetup hw={hw} {...defaultProps} onConfigChange={onConfigChange} />);
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "Windows (USB)" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Windows printer" }), {
      target: { value: "TSC TE200" },
    });
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
    fireEvent.click(screen.getByRole("radio", { name: "Windows (USB)" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText(/Enter the required printer connection details/)).toBeDefined();
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

describe("multiple scanner setup", () => {
  it("saves and reloads two ports with independent baud rates", async () => {
    const exec = await storedHardwareExec({
      scanner: { port: "COM3", baud: 9600 },
      printer: null,
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
    });
    const onConfigChange = vi.fn();
    const view = render(
      <WorkstationSetup
        hw={hardware()}
        exec={exec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onConfigChange={onConfigChange}
        onDone={() => {}}
      />,
    );
    await waitFor(() =>
      expect((screen.getByRole("combobox", { name: "Port" }) as HTMLSelectElement).value).toBe(
        "COM3",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add scanner" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Port 2" }), {
      target: { value: "COM4" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Baud rate 2" }), {
      target: { value: "115200" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(onConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({
          scanners: [
            { port: "COM3", baud: 9600 },
            { port: "COM4", baud: 115200 },
          ],
        }),
      ),
    );
    view.unmount();
    render(
      <WorkstationSetup
        hw={hardware()}
        exec={exec}
        sound={{ muted: false, volume: 1 }}
        onSoundChange={() => {}}
        onConfigChange={() => {}}
        onDone={() => {}}
      />,
    );
    await waitFor(() =>
      expect((screen.getByRole("combobox", { name: "Port 2" }) as HTMLSelectElement).value).toBe(
        "COM4",
      ),
    );
    expect((screen.getByRole("textbox", { name: "Baud rate 2" }) as HTMLInputElement).value).toBe(
      "115200",
    );
  });
});

it("connects both selected COM ports in one configuration request", async () => {
  const configure = vi.fn(async () => {});
  render(
    <WorkstationSetup
      hw={hardware({ configureScanners: configure })}
      exec={noopExec}
      sound={{ muted: false, volume: 1 }}
      onSoundChange={() => {}}
      onConfigChange={() => {}}
      onDone={() => {}}
    />,
  );
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  await chooseScannerPort("COM3");
  fireEvent.click(screen.getByRole("button", { name: "Add scanner" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Port 2" }), { target: { value: "COM4" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Baud rate 2" }), {
    target: { value: "115200" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect scanner" }));
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith([
      { port: "COM3", baud: 9600 },
      { port: "COM4", baud: 115200 },
    ]),
  );
});

it("rejects duplicate ports before connecting or saving", async () => {
  const configure = vi.fn(async () => {});
  const onConfigChange = vi.fn();
  render(
    <WorkstationSetup
      hw={hardware({ configureScanners: configure })}
      exec={noopExec}
      sound={{ muted: false, volume: 1 }}
      onSoundChange={() => {}}
      onConfigChange={onConfigChange}
      onDone={() => {}}
    />,
  );
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  await chooseScannerPort("COM3");
  fireEvent.click(screen.getByRole("button", { name: "Add scanner" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Port 2" }), { target: { value: "COM3" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect scanner" }));
  expect(screen.getByRole("alert").textContent).toContain("COM3");
  expect(configure).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onConfigChange).not.toHaveBeenCalled();
});

it("shows each port's connection state independently", async () => {
  const exec = await storedHardwareExec({
    scanner: null,
    scanners: [
      { port: "COM3", baud: 9600 },
      { port: "COM4", baud: 115200 },
    ],
    printer: null,
    printerLanguage: "zpl",
    verifyPrintedLabel: false,
  });
  let publish: (connections: ScannerConnection[]) => void = () => {};
  render(
    <WorkstationSetup
      hw={hardware({
        onScannerConnections: async (listener) => {
          publish = listener;
          return () => {};
        },
      })}
      exec={exec}
      sound={{ muted: false, volume: 1 }}
      onSoundChange={() => {}}
      onConfigChange={() => {}}
      onDone={() => {}}
    />,
  );
  await screen.findByRole("combobox", { name: "Port 2" });
  act(() =>
    publish([
      { port: "COM3", baud: 9600, status: "disconnected" },
      { port: "COM4", baud: 115200, status: "connected" },
    ]),
  );
  expect(screen.getByRole("status", { name: "Scanner COM3 status" }).textContent).toContain(
    "reconnecting",
  );
  expect(screen.getByRole("status", { name: "Scanner COM4 status" }).textContent).toBe("Connected");
});

it("removes a saved secondary port without losing the remaining scanner", async () => {
  const exec = await storedHardwareExec({
    scanner: null,
    scanners: [
      { port: "COM3", baud: 9600 },
      { port: "COM4", baud: 115200 },
    ],
    printer: null,
    printerLanguage: "zpl",
    verifyPrintedLabel: false,
  });
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
  fireEvent.click(await screen.findByRole("button", { name: "Remove scanner 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        scanner: { port: "COM3", baud: 9600 },
        scanners: [{ port: "COM3", baud: 9600 }],
      }),
    ),
  );
});

describe("printer profiles and assignments", () => {
  it("adds three profiles, retains assignments during test printing, and reloads explicit routes", async () => {
    const exec = await storedHardwareExec({
      scanner: null,
      printer: null,
      printerLanguage: "zpl",
      verifyPrintedLabel: false,
    });
    const print = vi.fn(async (_target: PrintTarget, _bytes: Uint8Array) => {});
    const props = {
      hw: hardware({ print }),
      exec,
      sound: { muted: false, volume: 1 },
      onSoundChange: () => {},
      onConfigChange: vi.fn(),
      onDone: () => {},
    };
    const view = render(<WorkstationSetup {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Printers" }));
    for (const [name, host] of [
      ["Boxes", "10.0.0.1"],
      ["Duplicates", "10.0.0.2"],
      ["Pallets", "10.0.0.3"],
    ]) {
      fireEvent.click(await screen.findByRole("button", { name: "Add printer" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Printer name" }), {
        target: { value: name },
      });
      fireEvent.click(screen.getByRole("radio", { name: "Network (TCP)" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Printer address" }), {
        target: { value: host },
      });
      fireEvent.change(screen.getByRole("combobox", { name: "Printer resolution" }), {
        target: { value: "300" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save printer" }));
    }
    const boxes = screen.getByRole("combobox", { name: "Box" }) as HTMLSelectElement;
    const boxId = boxes.value;
    const duplicateId = Array.from(boxes.options).find((o) => o.text === "Duplicates")?.value;
    const palletId = Array.from(boxes.options).find((o) => o.text === "Pallets")?.value;
    expect(duplicateId).toBeTypeOf("string");
    expect(palletId).toBeTypeOf("string");
    expect(
      (screen.getByRole("combobox", { name: "Code duplicate" }) as HTMLSelectElement).value,
    ).toBe(boxId);
    fireEvent.change(screen.getByRole("combobox", { name: "Code duplicate" }), {
      target: { value: duplicateId },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Pallet" }), {
      target: { value: palletId },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit Duplicates" }));
    fireEvent.click(screen.getByRole("button", { name: "Test print" }));
    await waitFor(() =>
      expect(print).toHaveBeenCalledWith(
        { kind: "tcp", host: "10.0.0.2", port: 9100 },
        expect.any(Uint8Array),
      ),
    );
    expect(new TextDecoder().decode(print.mock.calls[0]?.[1])).toContain("^PW685");
    fireEvent.click(screen.getByRole("button", { name: "Save printer" }));
    expect((screen.getByRole("combobox", { name: "Box" }) as HTMLSelectElement).value).toBe(boxId);
    fireEvent.change(screen.getByRole("combobox", { name: "Pallet" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(props.onConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({
          printerRouting: {
            printers: expect.arrayContaining([
              expect.objectContaining({ name: "Boxes" }),
              expect.objectContaining({ name: "Duplicates" }),
              expect.objectContaining({ name: "Pallets" }),
            ]),
            assignments: { box: boxId, duplicate: duplicateId, pallet: null },
          },
        }),
      ),
    );
    view.unmount();
    render(<WorkstationSetup {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Printers" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("combobox", { name: "Code duplicate" }) as HTMLSelectElement).value,
      ).toBe(duplicateId),
    );
    expect((screen.getByRole("combobox", { name: "Pallet" }) as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Edit Pallets" })).toBeDefined();
  });
});

it("rejects a duplicate endpoint, preserves edits by ID, and removes only the requested profile and its assignments", async () => {
  const printers = [
    {
      id: "box-printer",
      name: "Boxes",
      target: { kind: "tcp" as const, host: "box.local", port: 9100 },
      language: "zpl" as const,
      dpi: 203 as const,
    },
    {
      id: "duplicate-printer",
      name: "Duplicates",
      target: { kind: "serial" as const, port: "COM9", baud: 9600 },
      language: "tspl" as const,
      dpi: 300 as const,
    },
  ];
  const exec = await storedHardwareExec({
    scanner: null,
    printer: null,
    printerLanguage: "zpl",
    verifyPrintedLabel: false,
    printerRouting: {
      printers,
      assignments: { box: "box-printer", duplicate: "duplicate-printer", pallet: "box-printer" },
    },
  });
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
  fireEvent.click(await screen.findByRole("tab", { name: "Printers" }));
  await screen.findByRole("button", { name: "Edit Boxes" });
  fireEvent.click(screen.getByRole("button", { name: "Add printer" }));
  fireEvent.click(screen.getByRole("radio", { name: "Network (TCP)" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Printer address" }), {
    target: { value: "BOX.LOCAL." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save printer" }));
  expect(screen.getByRole("alert").textContent).toContain("already used by Boxes");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit Duplicates" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Printer name" }), {
    target: { value: "Units" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save printer" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit Boxes" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove printer" }));
  const dialog = screen.getByRole("dialog", { name: "Remove this printer?" });
  expect(dialog.textContent).toContain("Prepared print jobs keep their saved destination");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove printer" }));
  expect(screen.queryByRole("button", { name: "Edit Boxes" })).toBeNull();
  expect((screen.getByRole("combobox", { name: "Box" }) as HTMLSelectElement).value).toBe("");
  expect((screen.getByRole("combobox", { name: "Pallet" }) as HTMLSelectElement).value).toBe("");
  expect(
    (screen.getByRole("combobox", { name: "Code duplicate" }) as HTMLSelectElement).value,
  ).toBe("duplicate-printer");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        printer: null,
        printerRouting: {
          printers: [{ ...printers[1], name: "Units" }],
          assignments: { box: null, duplicate: "duplicate-printer", pallet: null },
        },
      }),
    ),
  );
});
