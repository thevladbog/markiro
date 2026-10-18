import { describe, expect, it } from "vitest";

import { readPrinterState } from "../src/floor/printer-indicator.js";
import {
  DEFAULT_WORKSTATION_SETTINGS,
  onWorkstationSettingsChanged,
  saveWorkstationSettings,
} from "../src/floor/setup/workstation-settings.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { closeBoxWithLabel, printStation } from "./support/printing.js";
import { openLocalDb } from "./support/local-db.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };

describe("the header's printer state", () => {
  it("is «not set» on a workstation with no printer, and not failed outside a shift", async () => {
    const { executor } = openLocalDb();
    expect(await readPrinterState(executor, PAIRING, null)).toEqual({
      configured: false,
      failed: false,
    });
  });

  it("is ready with a printer and a label waiting for nothing, failed once the label failed or is unknown", async () => {
    const at = await printStation();
    const job = await closeBoxWithLabel(at);
    // The label is prepared, waiting for its send: the printer has not failed.
    expect(await readPrinterState(at.local, PAIRING, at.shift.copy.id)).toEqual({
      configured: true,
      failed: false,
    });
    at.db.prepare("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'").run();
    expect(await readPrinterState(at.local, PAIRING, at.shift.copy.id)).toMatchObject({
      failed: true,
    });
    at.db.prepare("UPDATE floor_print_jobs SET state = 'unknown', error_code = 'timeout'").run();
    expect(await readPrinterState(at.local, PAIRING, at.shift.copy.id)).toMatchObject({
      failed: true,
    });
    at.db.prepare("UPDATE floor_print_jobs SET state = 'skipped', error_code = NULL").run();
    expect(await readPrinterState(at.local, PAIRING, at.shift.copy.id)).toMatchObject({
      failed: false,
    });
    // Another shift's failed label is not this shift's printer.
    at.db.prepare("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'").run();
    expect(job.shiftId).toBe(at.shift.copy.id);
    expect(await readPrinterState(at.local, PAIRING, "another-shift")).toMatchObject({
      failed: false,
    });
  });

  it("tells the workstation setup's saves to whoever listens, and stops when told to", async () => {
    const { executor } = openLocalDb();
    let saves = 0;
    const stop = onWorkstationSettingsChanged(() => {
      saves += 1;
    });
    await saveWorkstationSettings(executor, DEFAULT_WORKSTATION_SETTINGS);
    expect(saves).toBe(1);
    stop();
    await saveWorkstationSettings(executor, DEFAULT_WORKSTATION_SETTINGS);
    expect(saves).toBe(1);
  });
});
