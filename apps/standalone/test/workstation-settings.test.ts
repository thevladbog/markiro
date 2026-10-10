import { describe, expect, it, vi } from "vitest";

import {
  applySavedScanners,
  DEFAULT_WORKSTATION_SETTINGS,
  InvalidSettingsError,
  MAX_SCANNERS,
  parsePrinters,
  parsePrintTarget,
  printerTargetKey,
  parseScanners,
  readWorkstationSettings,
  resolvePrinter,
  saveWorkstationSettings,
  soundLevel,
  sharedSerialPort,
  type PrinterProfile,
  type WorkstationSettings,
} from "../src/floor/setup/workstation-settings.js";
import type { ScannerConfig } from "../src/hardware/hardware.js";
import { failingWrites, rows } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const ZEBRA: PrinterProfile = {
  id: "zebra",
  name: "Zebra у линии",
  target: { kind: "tcp", host: "192.168.1.50", port: 9100 },
  language: "zpl",
  dpi: 203,
};
const TSC: PrinterProfile = {
  id: "tsc",
  name: "TSC на COM",
  target: { kind: "serial", port: "COM4", baud: 9600 },
  language: "tspl",
  dpi: 300,
};

const SETTINGS: WorkstationSettings = {
  printers: [ZEBRA, TSC],
  assignments: { box: "zebra", pallet: "tsc", duplicate: null },
  scanners: [
    { port: "COM3", baud: 9600 },
    { port: "COM5", baud: 115200 },
  ],
  sound: { muted: false, volume: 40 },
  verifyPrintedLabel: true,
};

describe("the workstation's settings", () => {
  it("read as the defaults on a computer that has none: no printer, no scanner, no check", async () => {
    const { executor } = openLocalDb();
    await expect(readWorkstationSettings(executor)).resolves.toEqual(DEFAULT_WORKSTATION_SETTINGS);
    expect(resolvePrinter(DEFAULT_WORKSTATION_SETTINGS, "box")).toBeNull();
  });

  it("are stored in one transaction under four keys and read back exactly", async () => {
    const { db, executor } = openLocalDb();
    await saveWorkstationSettings(executor, SETTINGS);
    expect(rows(db, "SELECT key FROM workstation_settings ORDER BY key")).toEqual([
      { key: "printers" },
      { key: "scanners" },
      { key: "sound" },
      { key: "verify_printed_label" },
    ]);
    await expect(readWorkstationSettings(executor)).resolves.toEqual(SETTINGS);
    expect(resolvePrinter(SETTINGS, "box")).toEqual(ZEBRA);
    expect(resolvePrinter(SETTINGS, "pallet")).toEqual(TSC);
    expect(resolvePrinter(SETTINGS, "duplicate")).toBeNull();
    // A second save replaces every key.
    await saveWorkstationSettings(executor, DEFAULT_WORKSTATION_SETTINGS);
    await expect(readWorkstationSettings(executor)).resolves.toEqual(DEFAULT_WORKSTATION_SETTINGS);
  });

  it("refuse to store what would read back otherwise, and write nothing then", async () => {
    const { db, executor } = openLocalDb();
    const refused = async (settings: WorkstationSettings) => {
      await expect(saveWorkstationSettings(executor, settings)).rejects.toBeInstanceOf(
        InvalidSettingsError,
      );
    };
    await refused({ ...SETTINGS, assignments: { ...SETTINGS.assignments, box: "missing" } });
    await refused({ ...SETTINGS, printers: [ZEBRA, { ...TSC, target: ZEBRA.target }] });
    await refused({ ...SETTINGS, printers: [{ ...ZEBRA, name: " " }] });
    await refused({
      ...SETTINGS,
      scanners: [
        { port: "COM3", baud: 9600 },
        { port: "com3", baud: 9600 },
      ],
    });
    await refused({ ...SETTINGS, scanners: [{ port: "COM3", baud: 0 }] });
    await refused({ ...SETTINGS, sound: { muted: false, volume: 101 } });
    expect(rows(db, "SELECT count(*) AS n FROM workstation_settings")).toEqual([{ n: 0 }]);
  });

  it("read each key on its own: one damaged value is its default, the others stay", async () => {
    const { db, executor } = openLocalDb();
    await saveWorkstationSettings(executor, SETTINGS);
    db.prepare("UPDATE workstation_settings SET value = ? WHERE key = 'sound'").run('"loud"');
    db.prepare("UPDATE workstation_settings SET value = ? WHERE key = 'scanners'").run(
      JSON.stringify([{ port: "COM3", baud: 9600 }, { port: "", baud: 9600 }, "COM9"]),
    );
    const read = await readWorkstationSettings(executor);
    expect(read.sound).toEqual(DEFAULT_WORKSTATION_SETTINGS.sound);
    expect(read.scanners).toEqual([{ port: "COM3", baud: 9600 }]);
    expect(read.printers).toEqual(SETTINGS.printers);
    expect(read.verifyPrintedLabel).toBe(true);
  });

  it("read a key with the wrong shape as its default only, and a port stored twice once", async () => {
    const { db, executor } = openLocalDb();
    await saveWorkstationSettings(executor, SETTINGS);
    db.prepare("UPDATE workstation_settings SET value = ? WHERE key = 'sound'").run(
      JSON.stringify({ muted: "yes", volume: 50 }),
    );
    db.prepare("UPDATE workstation_settings SET value = ? WHERE key = 'scanners'").run(
      JSON.stringify([
        { port: "COM3", baud: 9600 },
        { port: "com3", baud: 115200 },
      ]),
    );
    const read = await readWorkstationSettings(executor);
    expect(read.printers).toEqual(SETTINGS.printers);
    expect(read.sound).toEqual(DEFAULT_WORKSTATION_SETTINGS.sound);
    // A port stored twice is read once, the first.
    expect(read.scanners).toEqual([{ port: "COM3", baud: 9600 }]);
    expect(read.verifyPrintedLabel).toBe(true);
  });

  it("read a stored text that is not JSON as that key's default (the table forbids it, the reader does not trust it)", async () => {
    const { executor } = openLocalDb();
    const damaged = {
      ...executor,
      query: async () => [
        { key: "printers", value: "{not json" },
        { key: "verify_printed_label", value: "true" },
      ],
    } as unknown as typeof executor;
    const read = await readWorkstationSettings(damaged);
    expect(read.printers).toEqual([]);
    expect(read.verifyPrintedLabel).toBe(true);
  });

  it("write all four keys or none: a failure on one leaves the others unwritten", async () => {
    const { db, executor } = openLocalDb();
    db.exec(
      "CREATE TRIGGER refuse_sound BEFORE INSERT ON workstation_settings " +
        "WHEN NEW.key = 'sound' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    await expect(saveWorkstationSettings(executor, SETTINGS)).rejects.toBeDefined();
    expect(rows(db, "SELECT count(*) AS n FROM workstation_settings")).toEqual([{ n: 0 }]);
  });

  it("turn the label check on only for a stored `true`", async () => {
    const { db, executor } = openLocalDb();
    for (const value of ['"true"', "1", "null", "{}"]) {
      db.prepare(
        "INSERT INTO workstation_settings (key, value) VALUES ('verify_printed_label', ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run(value);
      expect((await readWorkstationSettings(executor)).verifyPrintedLabel).toBe(false);
    }
  });

  it("reject a database that cannot be read, rather than read defaults over it", async () => {
    const { executor } = openLocalDb();
    const broken = {
      ...executor,
      query: async () => {
        throw new Error("disk I/O error");
      },
    };
    await expect(readWorkstationSettings(broken)).rejects.toThrow("disk I/O error");
    await expect(saveWorkstationSettings(failingWrites(executor), SETTINGS)).rejects.toMatchObject({
      code: "statement_failed",
    });
  });
});

describe("the printers of the settings", () => {
  it("read a target as the shell takes it, COM names in capitals", () => {
    expect(parsePrintTarget({ kind: "tcp", host: " zebra.local ", port: 9100 })).toEqual({
      kind: "tcp",
      host: "zebra.local",
      port: 9100,
    });
    expect(parsePrintTarget({ kind: "serial", port: "com4", baud: 9600 })).toEqual({
      kind: "serial",
      port: "COM4",
      baud: 9600,
    });
    expect(parsePrintTarget({ kind: "usb", printer: "ZDesigner GK420d" })).toEqual({
      kind: "usb",
      printer: "ZDesigner GK420d",
    });
    for (const bad of [
      null,
      { kind: "tcp", host: "zebra", port: 0 },
      { kind: "tcp", host: "zebra", port: 65_536 },
      { kind: "tcp", host: "", port: 9100 },
      { kind: "serial", port: "COM4", baud: 1.5 },
      { kind: "usb", printer: "a\0b" },
      { kind: "lpt", port: "LPT1" },
    ]) {
      expect(parsePrintTarget(bad)).toBeNull();
    }
  });

  it("give one key to one address, however it is written", () => {
    expect(printerTargetKey({ kind: "tcp", host: "Zebra.Local.", port: 9100 })).toBe(
      printerTargetKey({ kind: "tcp", host: "zebra.local", port: 9100 }),
    );
    expect(printerTargetKey({ kind: "tcp", host: "zebra", port: 9100 })).not.toBe(
      printerTargetKey({ kind: "tcp", host: "zebra", port: 9101 }),
    );
    expect(printerTargetKey({ kind: "serial", port: "com4", baud: 9600 })).toBe(
      printerTargetKey({ kind: "serial", port: "COM4", baud: 115200 }),
    );
    expect(printerTargetKey({ kind: "usb", printer: "TSC TE200" })).toBe(
      printerTargetKey({ kind: "usb", printer: "tsc te200" }),
    );
  });

  it("keep the first profile of an id and drop a later one of the same id", () => {
    const read = parsePrinters({
      printers: [ZEBRA, { ...TSC, id: ZEBRA.id }],
      assignments: { box: "zebra", pallet: null, duplicate: null },
    });
    expect(read.printers).toEqual([ZEBRA]);
    expect(read.assignments.box).toBe("zebra");
  });

  it("drop a profile it cannot print with, and give a duplicate address's purposes to the first", () => {
    const read = parsePrinters({
      printers: [
        ZEBRA,
        { ...TSC, dpi: 600 },
        { ...ZEBRA, id: "zebra-again", name: "Та же Zebra", target: { ...ZEBRA.target } },
        { ...TSC, id: "tsc-2", language: "pdf" },
        { ...TSC, id: "tsc-3" },
      ],
      assignments: { box: "zebra-again", pallet: "tsc", duplicate: "tsc-3" },
    });
    expect(read.printers).toEqual([ZEBRA, { ...TSC, id: "tsc-3" }]);
    // `tsc` was dropped (600 dpi): its purpose is unassigned, never guessed.
    expect(read.assignments).toEqual({ box: "zebra", pallet: null, duplicate: "tsc-3" });
  });
});

describe("the scanners the shell would take", () => {
  it("read a port name as the shell takes it: no control character, at most 256 characters", () => {
    expect(parseScanners([{ port: "COM\n3", baud: 9600 }])).toEqual([]);
    expect(parseScanners([{ port: "COM\u00853", baud: 9600 }])).toEqual([]);
    expect(parseScanners([{ port: "C".repeat(257), baud: 9600 }])).toEqual([]);
    expect(parseScanners([{ port: "C".repeat(256), baud: 9600 }])).toHaveLength(1);
  });

  it("keep at most as many scanners as the shell takes, and refuse to store more", async () => {
    const many = Array.from({ length: MAX_SCANNERS + 1 }, (_, index) => ({
      port: `COM${index + 1}`,
      baud: 9600,
    }));
    expect(parseScanners(many)).toHaveLength(MAX_SCANNERS);
    const { db, executor } = openLocalDb();
    await expect(
      saveWorkstationSettings(executor, { ...DEFAULT_WORKSTATION_SETTINGS, scanners: many }),
    ).rejects.toBeInstanceOf(InvalidSettingsError);
    await saveWorkstationSettings(executor, {
      ...DEFAULT_WORKSTATION_SETTINGS,
      scanners: many.slice(0, MAX_SCANNERS),
    });
    expect(rows(db, "SELECT count(*) AS n FROM workstation_settings")).toEqual([{ n: 4 }]);
  });

  it("name a COM port that a serial printer and a scanner would both open, in whatever case", () => {
    expect(sharedSerialPort([ZEBRA, TSC], [{ port: "COM3", baud: 9600 }])).toBeNull();
    expect(sharedSerialPort([ZEBRA, TSC], [{ port: "COM4", baud: 9600 }])).toBe("COM4");
    expect(sharedSerialPort([TSC], [{ port: "com4", baud: 115200 }])).toBe("COM4");
    expect(sharedSerialPort([], [{ port: "COM4", baud: 9600 }])).toBeNull();
  });

  it("refuse to store a scanner on the port of a serial printer, and write nothing", async () => {
    const { db, executor } = openLocalDb();
    await expect(
      saveWorkstationSettings(executor, {
        ...SETTINGS,
        scanners: [{ port: "COM4", baud: 9600 }],
      }),
    ).rejects.toBeInstanceOf(InvalidSettingsError);
    expect(rows(db, "SELECT count(*) AS n FROM workstation_settings")).toEqual([{ n: 0 }]);
  });
});

describe("the sound and the scanners of the settings", () => {
  it("give a tone's gain from the level, and none when muted", () => {
    expect(soundLevel({ muted: false, volume: 40 })).toBe(0.4);
    expect(soundLevel({ muted: true, volume: 40 })).toBe(0);
  });

  it("give the shell the saved scanners when the app starts, and an empty set when there are none", async () => {
    const { executor } = openLocalDb();
    const configure = vi.fn<(scanners: readonly ScannerConfig[]) => Promise<void>>(
      async () => undefined,
    );
    await expect(applySavedScanners(executor, configure)).resolves.toBe(true);
    expect(configure).toHaveBeenLastCalledWith([]);
    await saveWorkstationSettings(executor, SETTINGS);
    await expect(applySavedScanners(executor, configure)).resolves.toBe(true);
    expect(configure).toHaveBeenLastCalledWith(SETTINGS.scanners);
  });

  it("answer false, never throw, when the shell refuses the scanners or the database fails", async () => {
    const { executor } = openLocalDb();
    const refusing = vi.fn(async () => {
      throw new Error("invalid_scanners");
    });
    await expect(applySavedScanners(executor, refusing)).resolves.toBe(false);
    const broken = {
      ...executor,
      query: async () => {
        throw new Error("local_db_unavailable");
      },
    };
    const configure = vi.fn(async () => undefined);
    await expect(applySavedScanners(broken, configure)).resolves.toBe(false);
    expect(configure).not.toHaveBeenCalled();
  });
});
