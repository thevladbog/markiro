import { act, fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";

import { ThemeProvider, type SignalTone } from "@markiro/ui";

import type { FloorSession } from "../../src/app/shell.js";
import type { PrintRuntime } from "../../src/floor/print/print-runtime.js";
import type { ScanListener, ScanSource } from "../../src/floor/scan-source.js";
import type { WorkShift } from "../../src/floor/shifts/shift-copies.js";
import { createWorkGate, type WorkGate } from "../../src/floor/work-gate.js";
import { WorkScreen, type WorkScreenProps } from "../../src/floor/work/WorkScreen.js";
import { createSystemAwake } from "../../src/hardware/awake.js";
import type { CodeCheck, SsccBlockRequest } from "../../src/host/protocol.js";
import type { LocalExecutor } from "../../src/local/executor.js";
import { OPERATOR_ID, PAIRING } from "./floor-work.js";
import { fakeHardware } from "./hardware.js";
import { manualRuntime, renderedText } from "./printing.js";

/** Anna's session on the floor. */
export const SESSION: FloorSession = {
  id: OPERATOR_ID,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
  sessionId: 1,
};

/** Longer than the panels' guard after a change of view. */
export const PRESS_PAUSE_MS = 1000;

/** A scanner the test reads codes into; it knows whether the screen asked for text entry. */
export function fakeSource() {
  let listener: ScanListener | null = null;
  const textEntry: boolean[] = [];
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    clearPendingInput: () => undefined,
    setManualTextEntryActive: (active) => {
      textEntry.push(active);
    },
  };
  return {
    source,
    textEntry,
    listening: () =>
      waitFor(() => {
        if (listener === null) throw new Error("the work screen does not listen yet");
      }),
    emit: (raw: string) => listener?.(raw),
  };
}

export interface WorkOptions {
  shell?: ReturnType<typeof fakeHardware>;
  runtime?: PrintRuntime;
  onLeave?: () => void;
  overrides?: Partial<WorkScreenProps>;
}

/** What a test drives the work screen with. */
export interface WorkHarness {
  view: RenderResult;
  gate: WorkGate;
  props: WorkScreenProps;
  scanner: ReturnType<typeof fakeSource>;
  shell: ReturnType<typeof fakeHardware>;
  /** The panels' clock: it moves only when the test lets time pass. */
  clock: { now: number };
  /** The screen again with some props changed. */
  rerender: (next: Partial<WorkScreenProps>) => void;
  /** Waits for the work the screen has started. */
  settled: () => Promise<void>;
  /** Lets the guard after a change of view pass, as an operator's pause does. */
  pause: () => void;
  /** A scan, and the work it started. */
  scan: (raw: string) => Promise<void>;
  /** A press, after the pause of an operator's deliberate one, of the button named so, and the work it started. */
  press: (name: string) => Promise<void>;
}

/**
 * The work screen of `at.shift` over `at.local`, printing through `shell` (a
 * printer that takes every label by default) with a render that writes
 * plain text; `scan` and `press` act and wait for the work they started.
 */
export function renderWork(
  at: { local: LocalExecutor; shift: WorkShift },
  options: WorkOptions = {},
): WorkHarness {
  const gate = createWorkGate();
  const scanner = fakeSource();
  const shell = options.shell ?? fakeHardware();
  const runtime = options.runtime ?? manualRuntime(shell.hardware).runtime;
  const clock = { now: 0 };
  const props: WorkScreenProps = {
    shift: at.shift,
    operator: SESSION,
    pairing: PAIRING,
    local: at.local,
    online: false,
    track: gate.track,
    touch: vi.fn(),
    onLeave: options.onLeave ?? vi.fn(),
    leaving: false,
    source: scanner.source,
    checkCode: vi.fn(async (): Promise<CodeCheck> => ({ status: "free" })),
    requestBlock: vi.fn(async (request: SsccBlockRequest) => ({
      id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: 1500,
      toSerial: 3499,
    })),
    onHostError: vi.fn(),
    onRecorded: vi.fn(),
    signal: vi.fn<(tone: SignalTone) => void>(),
    printing: runtime,
    awake: createSystemAwake(vi.fn(async (_awake: boolean) => undefined)),
    labelClock: () => clock.now,
    render: async (spec, fields, printer) => {
      const text = renderedText(printer, fields.sscc, `${spec.widthMm}x${spec.heightMm}`);
      const bytes = new Uint8Array(text.length);
      for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
      return bytes;
    },
    ...options.overrides,
  };
  const view = render(
    <ThemeProvider>
      <WorkScreen {...props} />
    </ThemeProvider>,
  );
  return {
    view,
    gate,
    props,
    scanner,
    shell,
    clock,
    rerender: (next: Partial<WorkScreenProps>) =>
      view.rerender(
        <ThemeProvider>
          <WorkScreen {...props} {...next} />
        </ThemeProvider>,
      ),
    settled: () =>
      act(async () => {
        await gate.drain();
      }),
    pause: () => {
      clock.now += PRESS_PAUSE_MS;
    },
    scan: (raw: string) =>
      act(async () => {
        scanner.emit(raw);
        await gate.drain();
      }),
    press: (name: string) =>
      act(async () => {
        clock.now += PRESS_PAUSE_MS;
        fireEvent.click(screen.getByRole("button", { name }));
        await gate.drain();
      }),
  };
}

/** The last scan, as the screen says it. */
export function lastLine(): string | null {
  return document.querySelector(".work-screen__last")?.textContent ?? null;
}
