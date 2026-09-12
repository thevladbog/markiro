import { describe, expect, it } from "vitest";
import { DEFAULT_HARDWARE_CONFIG } from "../src/lib/hardware-config.js";
import {
  configuredPrinterRouting,
  resolvePrinter,
  printerTargetKey,
  serializePrinterOutput,
  type PrinterProfile,
} from "../src/lib/printer-routing.js";

const box: PrinterProfile = {
  id: "box-printer",
  name: "Box printer",
  target: { kind: "tcp", host: "10.0.0.1", port: 9100 },
  language: "zpl",
  dpi: 203,
};
const pallet: PrinterProfile = {
  id: "pallet-printer",
  name: "Pallet printer",
  target: { kind: "usb", printer: "Zebra pallet" },
  language: "tspl",
  dpi: 300,
};

describe("printer role routing", () => {
  it("retains the legacy printer for all purposes with a stable local identity", () => {
    const config = {
      ...DEFAULT_HARDWARE_CONFIG,
      printer: box.target,
      printerLanguage: box.language,
      printerDpi: box.dpi,
    };
    const routing = configuredPrinterRouting(config);
    expect(routing.printers).toHaveLength(1);
    expect(new Set(Object.values(routing.assignments)).size).toBe(1);
    for (const purpose of ["box", "duplicate", "pallet"] as const) {
      expect(resolvePrinter(config, purpose)).toMatchObject({
        target: box.target,
        language: "zpl",
        dpi: 203,
      });
    }
    expect(configuredPrinterRouting(config)).toEqual(routing);
  });

  it("routes purposes independently and never falls back from an explicit empty assignment", () => {
    const config = {
      ...DEFAULT_HARDWARE_CONFIG,
      printer: box.target,
      printerRouting: {
        printers: [box, pallet],
        assignments: { box: box.id, duplicate: null, pallet: pallet.id },
      },
    };
    expect(resolvePrinter(config, "box")).toEqual(box);
    expect(resolvePrinter(config, "pallet")).toEqual(pallet);
    expect(resolvePrinter(config, "duplicate")).toBeNull();
    expect(
      resolvePrinter(
        { ...config, printerRouting: { ...config.printerRouting, printers: [box] } },
        "pallet",
      ),
    ).toBeNull();
  });

  it("normalizes duplicate physical endpoints and maps their assignments to one profile", () => {
    const duplicate = {
      ...box,
      id: "alias",
      target: { kind: "tcp" as const, host: " 10.0.0.1 ", port: 9100 },
    };
    const routing = configuredPrinterRouting({
      ...DEFAULT_HARDWARE_CONFIG,
      printerRouting: {
        printers: [box, duplicate],
        assignments: { box: box.id, duplicate: duplicate.id, pallet: null },
      },
    });
    expect(routing.printers).toEqual([box]);
    expect(routing.assignments).toEqual({ box: box.id, duplicate: box.id, pallet: null });
    expect(printerTargetKey({ kind: "serial", port: " com7 ", baud: 9600 })).toBe(
      printerTargetKey({ kind: "serial", port: "COM7", baud: 19200 }),
    );
  });

  it("serializes one physical printer across roles while letting another finish independently", async () => {
    const calls: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = serializePrinterOutput(box.target, async () => {
      calls.push("box-start");
      await held;
      calls.push("box-end");
    });
    const second = serializePrinterOutput(box.target, async () => {
      calls.push("duplicate");
    });
    const other = serializePrinterOutput(pallet.target, async () => {
      calls.push("pallet");
    });
    await other;
    expect(calls).toEqual(["box-start", "pallet"]);
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual(["box-start", "pallet", "box-end", "duplicate"]);
    await expect(
      serializePrinterOutput(box.target, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    await expect(serializePrinterOutput(box.target, async () => "next")).resolves.toBe("next");
  });
});
