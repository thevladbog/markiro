import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  DEFAULT_HARDWARE_CONFIG,
  loadHardwareConfig,
  saveHardwareConfig,
  type HardwareConfig,
} from "../src/lib/hardware-config.js";

// Same shape as mirror.test.ts's `nodeExecutor`; `applyMigrations` already
// swallows the duplicate-column error the re-runnable ALTER produces.
function nodeExecutor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

async function makeExec(): Promise<SqlExecutor> {
  const exec = nodeExecutor();
  await applyMigrations(exec);
  return exec;
}

const CONFIG: HardwareConfig = {
  scanner: { port: "COM3", baud: 9600 },
  printer: { kind: "tcp", host: "10.0.0.7", port: 9100 },
  printerLanguage: "tspl",
  printerDpi: 203,
  verifyPrintedLabel: true,
};

describe("hardware config", () => {
  it.each([203, 300] as const)(
    "persists the configured printer resolution %s",
    async (printerDpi) => {
      const exec = await makeExec();
      await saveHardwareConfig(exec, { ...CONFIG, printerDpi });
      expect((await loadHardwareConfig(exec)).printerDpi).toBe(printerDpi);
    },
  );
  it.each([undefined, 600, "300"])(
    "does not guess resolution for legacy or invalid hardware settings: %s",
    async (printerDpi) => {
      const exec = await makeExec();
      await exec.run("INSERT INTO station_meta (key,value) VALUES (?,?)", [
        "hardware_config",
        JSON.stringify({ ...CONFIG, printerDpi }),
      ]);
      expect((await loadHardwareConfig(exec)).printerDpi).toBeNull();
    },
  );

  it("defaults to no hardware, ZPL and no print verification when nothing is stored", async () => {
    expect(await loadHardwareConfig(await makeExec())).toEqual(DEFAULT_HARDWARE_CONFIG);
    expect(DEFAULT_HARDWARE_CONFIG).toEqual({
      scanner: null,
      printer: null,
      printerLanguage: "zpl",
      printerDpi: null,
      verifyPrintedLabel: false,
    });
  });

  it("round-trips a full configuration", async () => {
    const exec = await makeExec();
    await saveHardwareConfig(exec, CONFIG);
    expect(await loadHardwareConfig(exec)).toEqual(CONFIG);
  });

  it("round-trips a serial printer target", async () => {
    const exec = await makeExec();
    const serial: HardwareConfig = {
      scanner: null,
      printer: { kind: "serial", port: "COM4", baud: 19200 },
      printerLanguage: "zpl",
      printerDpi: null,
      verifyPrintedLabel: false,
    };
    await saveHardwareConfig(exec, serial);
    expect(await loadHardwareConfig(exec)).toEqual(serial);
  });

  it("falls back to defaults on corrupt stored content", async () => {
    const exec = await makeExec();
    await exec.run("INSERT INTO station_meta (key, value) VALUES (?,?)", [
      "hardware_config",
      "{not json",
    ]);
    expect(await loadHardwareConfig(exec)).toEqual(DEFAULT_HARDWARE_CONFIG);
  });

  it("falls back to defaults for an unknown printer language", async () => {
    const exec = await makeExec();
    await exec.run("INSERT INTO station_meta (key, value) VALUES (?,?)", [
      "hardware_config",
      JSON.stringify({ scanner: null, printer: null, printerLanguage: "postscript" }),
    ]);
    expect((await loadHardwareConfig(exec)).printerLanguage).toBe("zpl");
  });

  it("defaults verifyPrintedLabel to false when the stored value is not a boolean", async () => {
    const exec = await makeExec();
    await exec.run("INSERT INTO station_meta (key, value) VALUES (?,?)", [
      "hardware_config",
      JSON.stringify({ scanner: null, printer: null, printerLanguage: "zpl" }),
    ]);
    expect((await loadHardwareConfig(exec)).verifyPrintedLabel).toBe(false);
  });

  it("never rejects when the table does not exist yet", async () => {
    const failing: SqlExecutor = {
      run: async () => {},
      all: async () => {
        throw new Error("no such table: station_meta");
      },
    };
    await expect(loadHardwareConfig(failing)).resolves.toEqual(DEFAULT_HARDWARE_CONFIG);
  });

  it("round-trips a USB printer target", async () => {
    const exec = await makeExec();
    const usb: HardwareConfig = {
      scanner: null,
      printer: { kind: "usb", printer: "Zebra ZD421" },
      printerLanguage: "tspl",
      printerDpi: null,
      verifyPrintedLabel: false,
    };
    await saveHardwareConfig(exec, usb);
    expect(await loadHardwareConfig(exec)).toEqual(usb);
  });

  it("drops a stored USB printer with an empty queue name", async () => {
    const exec = await makeExec();
    await exec.run("INSERT INTO station_meta (key, value) VALUES (?,?)", [
      "hardware_config",
      JSON.stringify({
        scanner: null,
        printer: { kind: "usb", printer: "" },
        printerLanguage: "zpl",
        verifyPrintedLabel: false,
      }),
    ]);
    expect((await loadHardwareConfig(exec)).printer).toBeNull();
  });

  it("drops a stored USB printer with a whitespace-only queue name", async () => {
    const exec = await makeExec();
    await exec.run("INSERT INTO station_meta (key, value) VALUES (?,?)", [
      "hardware_config",
      JSON.stringify({
        scanner: null,
        printer: { kind: "usb", printer: "   " },
        printerLanguage: "zpl",
        verifyPrintedLabel: false,
      }),
    ]);
    expect((await loadHardwareConfig(exec)).printer).toBeNull();
  });
});

describe("multiple COM scanner configuration", () => {
  it("loads every stored scanner with its own speed", async () => {
    const exec = await makeExec();
    await exec.run("INSERT INTO station_meta (key,value) VALUES (?,?)", [
      "hardware_config",
      JSON.stringify({
        ...CONFIG,
        scanners: [
          { port: "COM3", baud: 9600 },
          { port: "COM4", baud: 115200 },
        ],
      }),
    ]);
    expect((await loadHardwareConfig(exec)).scanners).toEqual([
      { port: "COM3", baud: 9600 },
      { port: "COM4", baud: 115200 },
    ]);
  });

  it("an explicit empty list clears the legacy scanner instead of resurrecting it", async () => {
    const exec = await makeExec();
    await exec.run("INSERT INTO station_meta (key,value) VALUES (?,?)", [
      "hardware_config",
      JSON.stringify({ ...CONFIG, scanners: [] }),
    ]);
    const config = await loadHardwareConfig(exec);
    expect(config.scanners).toEqual([]);
    expect(config.scanner).toBeNull();
  });

  it("keeps valid ports when another persisted entry is malformed or duplicated", async () => {
    const exec = await makeExec();
    await exec.run("INSERT INTO station_meta (key,value) VALUES (?,?)", [
      "hardware_config",
      JSON.stringify({
        ...CONFIG,
        scanners: [
          { port: "com3", baud: 9600 },
          { port: "COM3", baud: 115200 },
          { port: "COM4", baud: 115200 },
          { port: "  ", baud: 9600 },
          { port: "COM5", baud: 0 },
          { port: "COM6", baud: 1.5 },
        ],
      }),
    ]);
    expect((await loadHardwareConfig(exec)).scanners).toEqual([
      { port: "COM3", baud: 9600 },
      { port: "COM4", baud: 115200 },
    ]);
  });
});
