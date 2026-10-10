import type { RasterizeTextFn } from "@markiro/domain";
import type { DatabaseSync } from "node:sqlite";

import { vi } from "vitest";

import { latin1ToBytes } from "../../src/floor/print/label-render.js";
import type { RenderLabel } from "../../src/floor/print/print-jobs.js";
import { createPrintRuntime, type StartTimer } from "../../src/floor/print/print-runtime.js";
import {
  DEFAULT_WORKSTATION_SETTINGS,
  saveWorkstationSettings,
  type PrinterProfile,
  type WorkstationSettings,
} from "../../src/floor/setup/workstation-settings.js";
import type { HardwareApi } from "../../src/hardware/hardware.js";
import type { LocalExecutor } from "../../src/local/executor.js";
import { rows } from "./floor-work.js";

/** A rasterizer that draws every text as the same 8 x 2 bitmap: jsdom has no canvas. */
export const fakeRaster: RasterizeTextFn = async () => ({
  hex: "FF00",
  totalBytes: 2,
  bytesPerRow: 1,
  width: 8,
  height: 2,
});

/** The Zebra at the line: ZPL, 203 dpi, on the network. */
export const ZEBRA: PrinterProfile = {
  id: "zebra",
  name: "Zebra у линии",
  target: { kind: "tcp", host: "192.168.1.50", port: 9100 },
  language: "zpl",
  dpi: 203,
};

/** A TSC on a COM port: TSPL, 300 dpi. */
export const TSC: PrinterProfile = {
  id: "tsc",
  name: "TSC на COM4",
  target: { kind: "serial", port: "COM4", baud: 9600 },
  language: "tspl",
  dpi: 300,
};

/** Settings with the Zebra for boxes and the TSC on the side. */
export function printingSettings(
  overrides: Partial<WorkstationSettings> = {},
): WorkstationSettings {
  return {
    ...DEFAULT_WORKSTATION_SETTINGS,
    printers: [ZEBRA, TSC],
    assignments: { box: "zebra", pallet: null, duplicate: null },
    ...overrides,
  };
}

/** Stores `printingSettings(overrides)` on this computer. */
export async function setUpPrinting(
  local: LocalExecutor,
  overrides: Partial<WorkstationSettings> = {},
): Promise<WorkstationSettings> {
  const settings = printingSettings(overrides);
  await saveWorkstationSettings(local, settings);
  return settings;
}

/**
 * A render that writes what it was asked in plain ASCII: the language, the
 * resolution, the layout's size and element count, the SSCC — so a test sees
 * which printer and which layout a label's bytes were made for.
 */
export const fakeRender: RenderLabel = async (spec, fields, printer) =>
  latin1ToBytes(
    `^XA ${printer.language} ${printer.dpi} ${spec.widthMm}x${spec.heightMm} ` +
      `${spec.elements.length} ${fields.sscc} ^XZ`,
  );

/** The text `fakeRender` writes for this printer, layout size and SSCC. */
export function renderedText(
  printer: Pick<PrinterProfile, "language" | "dpi">,
  sscc: string,
  size = "58x40",
  elements = 1,
): string {
  return `^XA ${printer.language} ${printer.dpi} ${size} ${elements} ${sscc} ^XZ`;
}

/** The base64 of `renderedText`, as a job keeps it. */
export function renderedBase64(
  printer: Pick<PrinterProfile, "language" | "dpi">,
  sscc: string,
  size = "58x40",
  elements = 1,
): string {
  return btoa(renderedText(printer, sscc, size, elements));
}

/** Timers the test fires by hand: nothing waits for real time. */
export function manualTimers() {
  const timers: { ms: number; fire: () => void; live: boolean }[] = [];
  const startTimer: StartTimer = (ms, fire) => {
    const timer = { ms, fire, live: true };
    timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  return {
    startTimer,
    timers,
    /** Fires every timer still running, as if the limit ran out now. */
    expire: () => {
      for (const timer of timers.filter((candidate) => candidate.live)) {
        timer.live = false;
        timer.fire();
      }
    },
  };
}

/** A runtime over `hardware` whose limit runs out only when the test says. */
export function manualRuntime(hardware: Pick<HardwareApi, "printBytes">) {
  const timers = manualTimers();
  return {
    runtime: createPrintRuntime(hardware.printBytes, { startTimer: timers.startTimer }),
    expire: timers.expire,
  };
}

/** The print jobs as stored, oldest first, with the columns a test reads. */
export function jobRows(db: DatabaseSync): Record<string, unknown>[] {
  return rows(
    db,
    "SELECT id, purpose, subject_id, sscc, state, verify, template_id, template_rev, printer, " +
      "bytes_base64, error_code, attempts, operator_id, created_at FROM floor_print_jobs " +
      "ORDER BY created_at, id",
  );
}

/** Lets the promise callbacks queued so far run. */
export async function flushPromises(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

/** A shell spy for one test: `vi.fn` over a real answer. */
export function spyRender(render: RenderLabel = fakeRender) {
  return vi.fn<RenderLabel>(render);
}
