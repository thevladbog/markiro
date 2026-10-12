import { act, fireEvent, render, screen, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import {
  WarehouseScreen,
  type WarehouseScreenProps,
} from "../../src/floor/warehouse/WarehouseScreen.js";
import { createWorkGate, type WorkGate } from "../../src/floor/work-gate.js";
import {
  LabelRenderingProvider,
  type LabelRendering,
} from "../../src/office/templates/label-rendering.js";
import type { PrintResult } from "../../src/hardware/hardware.js";
import type { WarehouseLookup, WarehouseLookupResult } from "../../src/host/protocol.js";
import type { WorkstationSettings } from "../../src/floor/setup/workstation-settings.js";
import type { ScanSource } from "../../src/floor/scan-source.js";
import { OPERATOR_ID, PAIRING, rows } from "./floor-work.js";
import { fakeHardware } from "./hardware.js";
import { openLocalDb } from "./local-db.js";
import { manualRuntime, setUpPrinting } from "./printing.js";
import { BOX_SOURCE, seedWarehouseCopies, warehouseRender } from "./warehouse.js";
import { fakeSource, SESSION } from "./work-screen.js";

export { OPERATOR_ID, rows };

/** Longer than the screen's guard after a change of view. */
export const PRESS_PAUSE_MS = 1000;

export interface WarehouseScreenOptions {
  online?: boolean;
  lookup?: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>;
  /** The screen's scanner when the test brings its own (the real keyboard wedge). */
  source?: ScanSource;
  /** A database that is already set up (a restart of the screen); otherwise a fresh one with the copies seeded. */
  seeded?: ReturnType<typeof openLocalDb>;
  /** The printers assigned to the kinds of label; by default the Zebra for boxes and pallets, the TSC for units. */
  assignments?: WorkstationSettings["assignments"];
  /** Whether Anna is among the copies of the operators (default: yes). */
  operatorKnown?: boolean;
  /** How labels are drawn in the template preview (the office's tools); a canvas is not there in jsdom. */
  labels?: LabelRendering;
  /** What the shell answers to a send. */
  answer?: () => Promise<PrintResult>;
  overrides?: Partial<WarehouseScreenProps>;
}

export interface WarehouseHarness {
  view: RenderResult;
  db: ReturnType<typeof openLocalDb>["db"];
  local: ReturnType<typeof openLocalDb>["executor"];
  gate: WorkGate;
  props: WarehouseScreenProps;
  scanner: ReturnType<typeof fakeSource>;
  shell: ReturnType<typeof fakeHardware>;
  runtime: ReturnType<typeof manualRuntime>;
  lookup: ReturnType<typeof vi.fn<(lookup: WarehouseLookup) => Promise<WarehouseLookupResult>>>;
  /** The screen's clock: it moves only when the test lets time pass. */
  clock: { now: number };
  /** The screen again with some props changed. */
  rerender: (next: Partial<WarehouseScreenProps>) => void;
  /** Waits for the work the screen has started. */
  settled: () => Promise<void>;
  /** A scan through the fake scanner, and the work it started. */
  scan: (raw: string) => Promise<void>;
  /** A press of the button named so after the operator's pause, and the work it started. */
  press: (name: string | RegExp) => Promise<void>;
  /** A press at once, with no pause: what a second tap of a double tap is. */
  pressAtOnce: (name: string | RegExp) => Promise<void>;
}

/** The warehouse screen over a fresh station with the copies seeded and the printers set. */
export async function renderWarehouse(
  options: WarehouseScreenOptions = {},
): Promise<WarehouseHarness> {
  const seeded = options.seeded ?? openLocalDb();
  const { db, executor } = seeded;
  if (options.seeded === undefined) {
    seedWarehouseCopies(db, { operator: options.operatorKnown ?? true });
    await setUpPrinting(executor, {
      assignments: options.assignments ?? { box: "zebra", pallet: "zebra", duplicate: "tsc" },
    });
  }
  const gate = createWorkGate();
  const scanner = fakeSource();
  const shell = fakeHardware(options.answer);
  const runtime = manualRuntime(shell.hardware);
  const clock = { now: 0 };
  const lookup = vi.fn<(lookup: WarehouseLookup) => Promise<WarehouseLookupResult>>(
    options.lookup ?? (async () => ({ status: "found", source: BOX_SOURCE })),
  );
  let id = 0;
  const props: WarehouseScreenProps = {
    operator: SESSION,
    local: executor,
    pairing: PAIRING,
    online: options.online ?? true,
    track: gate.track,
    touch: vi.fn(),
    isLeaving: () => false,
    source: options.source ?? scanner.source,
    lookup,
    onHostError: vi.fn(),
    onRecorded: vi.fn(),
    printing: runtime.runtime,
    onLeave: vi.fn(),
    onSetup: vi.fn(),
    render: warehouseRender,
    now: () => new Date("2026-10-09T07:00:00.000Z"),
    newId: () => `00000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`,
    clock: () => clock.now,
    ...options.overrides,
  };
  const wrap = (node: ReactNode) => (
    <ThemeProvider>
      {options.labels === undefined ? (
        node
      ) : (
        <LabelRenderingProvider value={options.labels}>{node}</LabelRenderingProvider>
      )}
    </ThemeProvider>
  );
  const view = render(wrap(<WarehouseScreen {...props} />));
  const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
  return {
    view,
    db,
    local: executor,
    gate,
    props,
    scanner,
    shell,
    runtime,
    lookup,
    clock,
    rerender: (next) => view.rerender(wrap(<WarehouseScreen {...props} {...next} />)),
    settled: () => act(() => gate.drain()),
    scan: async (raw) => {
      await act(async () => {
        scanner.emit(raw);
        await gate.drain();
      });
    },
    press: async (name) => {
      await act(async () => {
        clock.now += PRESS_PAUSE_MS;
        click(name);
        await gate.drain();
      });
    },
    pressAtOnce: async (name) => {
      await act(async () => {
        click(name);
        await gate.drain();
      });
    },
  };
}

/** A started session (reason «Повреждена») with the scanner listening. */
export async function startedWarehouse(
  options: WarehouseScreenOptions = {},
): Promise<WarehouseHarness> {
  const at = await renderWarehouse(options);
  await screen.findByRole("button", { name: "Начать перепечатку" });
  await at.press("Повреждена");
  await at.press("Начать перепечатку");
  if (options.source === undefined) await at.scanner.listening();
  else await at.settled();
  return at;
}
