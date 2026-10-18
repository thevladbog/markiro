import { readFileSync } from "node:fs";

import type { WorkstationSettings } from "../../src/floor/setup/workstation-settings.js";
import {
  palletStep,
  shiftPallets,
  type PalletContext,
  type ShiftPallets,
} from "../../src/floor/pallets/pallets.js";
import { boxLabelStep } from "../../src/floor/print/print-jobs.js";
import type { WorkShift } from "../../src/floor/shifts/shift-copies.js";
import { closeOpenBox, type CloseResult } from "../../src/floor/work/box-close.js";
import { processScan, type ScanContext } from "../../src/floor/work/scan-pipeline.js";
import { enteredShiftSchema, type EnteredShift } from "../../src/host/protocol.js";
import type { LocalExecutor } from "../../src/local/executor.js";
import { enteredShift, km, PAIRING, scanContext, seedBlock } from "./floor-work.js";
import { openLocalDb } from "./local-db.js";
import { fakeRender, PRINT_BLOCK, setUpPrinting } from "./printing.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const supportModuleUrl = import.meta.url;

/**
 * The active shift of milk with pallets this station entered
 * (`device-shift-entered-pallets.json`): 12 to a box, 40 boxes to a pallet,
 * the pallet template «Паллета 100×150» of revision 63.
 */
export const PALLETS_ENTERED: EnteredShift = enteredShiftSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../../proto/fixtures/device-shift-entered-pallets.json", supportModuleUrl),
      "utf8",
    ),
  ),
);

/** The pallet block of the pallet tests: serials 0–199 of extension 1. */
export const PALLET_BLOCK = "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b";

export interface PalletStation {
  db: ReturnType<typeof openLocalDb>["db"];
  local: LocalExecutor;
  shift: WorkShift;
  pallets: ShiftPallets;
  settings: WorkstationSettings;
}

/**
 * A station with the shift with pallets entered — `capacity` boxes to a
 * pallet, `boxCapacity` codes to a box (12) — a box block from 1500, a pallet
 * block of serials 0–199 unless `palletBlock` is `false`, and the Zebra for
 * boxes and pallets.
 */
export async function palletStation(
  options: {
    capacity?: number;
    boxCapacity?: number;
    palletBlock?: boolean;
    settings?: Partial<WorkstationSettings>;
    /** What the host froze besides the layouts (plan А4): `snapshot.palletSheet` and `.organization`, as the wire has them. */
    frozen?: Record<string, unknown>;
  } = {},
): Promise<PalletStation> {
  const { db, executor } = openLocalDb();
  const shift = await enteredShift(executor, {
    ...PALLETS_ENTERED,
    boxCapacity: options.boxCapacity ?? PALLETS_ENTERED.boxCapacity,
    palletBoxCapacity: options.capacity ?? 3,
    snapshot: { ...PALLETS_ENTERED.snapshot, ...options.frozen },
  });
  const pallets = shiftPallets(shift);
  if (pallets === null) throw new Error("the shift has no pallets");
  seedBlock(db, { blockId: PRINT_BLOCK, from: 1500, to: 3499 });
  if (options.palletBlock !== false) {
    seedBlock(db, { blockId: PALLET_BLOCK, from: 0, to: 199, extension: 1 });
  }
  const settings = await setUpPrinting(executor, {
    assignments: { box: "zebra", pallet: "zebra", duplicate: null },
    ...options.settings,
  });
  return { db, local: executor, shift, pallets, settings };
}

/** A scan's and a pallet close's context over the station: offline, a stepping clock, random ids, the fake render. */
export function palletContext(
  at: Pick<PalletStation, "local" | "shift">,
  overrides: Partial<ScanContext & PalletContext> = {},
): ScanContext & PalletContext {
  return {
    ...scanContext(at.local, at.shift, { newId: () => crypto.randomUUID() }),
    operatorName: "Анна Кузнецова",
    render: fakeRender,
    ...overrides,
  };
}

/**
 * Accepts the codes `serials` into the open box and closes it as the work
 * screen of a shift with pallets does: its label and its pallet in the box's
 * transaction. Answers how the close went.
 */
export async function closeBoxOnPallet(
  at: PalletStation,
  serials: readonly string[],
  context: ScanContext & PalletContext = palletContext(at),
): Promise<CloseResult> {
  for (const serial of serials) await processScan(context, km(serial));
  return closeOpenBox(context, [
    boxLabelStep({
      local: at.local,
      pairing: PAIRING,
      shift: at.shift,
      operatorName: context.operatorName,
      newId: () => crypto.randomUUID(),
      render: fakeRender,
    }),
    palletStep(context, at.pallets),
  ]);
}
