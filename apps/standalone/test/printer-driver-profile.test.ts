import { buildDatedBoxLabelTemplates, decodeMonoRaster } from "@markiro/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import i18n from "../src/i18n/index.js";

import { boxLabelData, renderLabel } from "../src/floor/print/label-render.js";
import { printerFormatText } from "../src/floor/print/printer-format.js";
import { draftOf, NEW_PRINTER, profileOf } from "../src/floor/setup/printer-draft.js";
import {
  DEFAULT_WORKSTATION_SETTINGS,
  parsePrinterProfile,
  printerMode,
  readWorkstationSettings,
  saveWorkstationSettings,
  type PrinterProfile,
} from "../src/floor/setup/workstation-settings.js";
import { rasterizeDriverText, RasterUnavailableError } from "../src/labels/rasterizer.js";
import { enteredShift } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRaster, TSC, ZEBRA } from "./support/printing.js";

/** A box SSCC with a valid check digit: the stock template draws it as a GS1-128 barcode. */
const VALID_SSCC = "046006820000035008";

const GODEX: PrinterProfile = {
  id: "godex",
  name: "Godex через драйвер",
  target: { kind: "usb", printer: "Godex G500" },
  language: "zpl",
  dpi: 203,
  mode: "windows_driver",
};

describe("a printer profile's way of printing", () => {
  it("is RAW for every profile stored before it existed, and is not invented on reading", () => {
    const legacy = { ...ZEBRA };
    expect(parsePrinterProfile(legacy)).toEqual(ZEBRA);
    expect(printerMode(ZEBRA)).toBe("raw");
    expect(parsePrinterProfile({ ...ZEBRA, mode: "raw" })).toEqual({ ...ZEBRA, mode: "raw" });
  });

  it("is the Windows driver only for a Windows queue, and nothing this build does not know", () => {
    expect(parsePrinterProfile(GODEX)).toEqual(GODEX);
    expect(printerMode(GODEX)).toBe("windows_driver");
    expect(parsePrinterProfile({ ...ZEBRA, mode: "windows_driver" })).toBeNull();
    expect(parsePrinterProfile({ ...TSC, mode: "windows_driver" })).toBeNull();
    expect(parsePrinterProfile({ ...GODEX, mode: "postscript" })).toBeNull();
    expect(parsePrinterProfile({ ...GODEX, mode: null })).toBeNull();
  });

  it("is stored and read back with the workstation's printers", async () => {
    const { executor } = openLocalDb();
    const settings = {
      ...DEFAULT_WORKSTATION_SETTINGS,
      printers: [ZEBRA, GODEX],
      assignments: { box: "godex", pallet: "zebra", duplicate: null },
    };
    await saveWorkstationSettings(executor, settings);
    await expect(readWorkstationSettings(executor)).resolves.toEqual(settings);
  });

  it("is refused when written for anything but a Windows queue, or unknown", async () => {
    const { executor } = openLocalDb();
    const save = (printer: unknown) =>
      saveWorkstationSettings(executor, {
        ...DEFAULT_WORKSTATION_SETTINGS,
        // The settings type forbids the broken profiles on purpose: this is the storage's own guard.
        printers: [printer as PrinterProfile],
        assignments: { box: null, pallet: null, duplicate: null },
      });
    await expect(save({ ...ZEBRA, mode: "windows_driver" })).rejects.toThrow();
    await expect(save({ ...GODEX, mode: "postscript" })).rejects.toThrow();
    await expect(save({ ...GODEX, mode: null })).rejects.toThrow();
    await expect(readWorkstationSettings(executor)).resolves.toEqual(DEFAULT_WORKSTATION_SETTINGS);
  });

  it("reads a profile stored with a way of printing this build lacks as no printer at all", async () => {
    const { executor } = openLocalDb();
    await executor.transaction([
      {
        sql: "INSERT INTO workstation_settings (key, value) VALUES (?, ?)",
        values: [
          "printers",
          JSON.stringify({
            printers: [
              { ...GODEX, mode: "postscript" },
              { ...ZEBRA },
              { ...GODEX, id: "g2", target: { kind: "tcp", host: "10.0.0.9", port: 9100 } },
            ],
            assignments: { box: "godex", pallet: "zebra", duplicate: "g2" },
          }),
        ],
      },
    ]);
    const settings = await readWorkstationSettings(executor);
    expect(settings.printers).toEqual([ZEBRA]);
    expect(settings.assignments).toEqual({ box: null, pallet: "zebra", duplicate: null });
  });
});

describe("the printer form's way of printing", () => {
  const newId = () => "new-1";

  it("writes the driver only for a Windows queue, and RAW as no field at all", () => {
    const usb = { ...NEW_PRINTER, name: "Godex", kind: "usb" as const, usbPrinter: "Godex G500" };
    expect(profileOf({ ...usb, mode: "windows_driver" }, newId)).toEqual({
      profile: { ...GODEX, id: "new-1", name: "Godex" },
    });
    expect(profileOf({ ...usb, mode: "raw" }, newId)).toEqual({
      profile: {
        id: "new-1",
        name: "Godex",
        target: { kind: "usb", printer: "Godex G500" },
        language: "zpl",
        dpi: 203,
      },
    });
    // A printer moved to the network keeps no driver mode.
    expect(
      profileOf({ ...usb, kind: "tcp", host: "10.0.0.7", mode: "windows_driver" }, newId),
    ).toEqual({
      profile: {
        id: "new-1",
        name: "Godex",
        target: { kind: "tcp", host: "10.0.0.7", port: 9100 },
        language: "zpl",
        dpi: 203,
      },
    });
  });

  it("keeps no driver mode for a COM printer either, and no mode key at all for RAW", () => {
    const com = {
      ...NEW_PRINTER,
      name: "TSC",
      kind: "serial" as const,
      serialPort: "COM4",
      mode: "windows_driver" as const,
    };
    const result = profileOf(com, newId);
    expect(result).toHaveProperty("profile");
    if ("profile" in result) expect("mode" in result.profile).toBe(false);
  });

  it("opens a stored profile with its way of printing", () => {
    expect(draftOf(GODEX).mode).toBe("windows_driver");
    expect(draftOf(ZEBRA).mode).toBe("raw");
    expect(NEW_PRINTER.mode).toBe("raw");
  });
});

describe("a label for the Windows driver", () => {
  it("is a mono-raster-v1 page of the template at the printer's resolution", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const fields = boxLabelData(
      shift,
      { sscc: VALID_SSCC, itemCount: 12, closedAt: "2026-10-08T06:20:00.000Z" },
      "Анна",
    );
    const stock = buildDatedBoxLabelTemplates()[0]?.spec;
    if (stock === undefined) throw new Error("the domain has no stock box label");
    const rasterize = vi.fn(fakeRaster);
    for (const dpi of [203, 300] as const) {
      const bytes = await renderLabel(stock, fields, { ...GODEX, dpi }, rasterize);
      expect([...bytes.slice(0, 8)]).toEqual([...new TextEncoder().encode("MKRMNO1\0")]);
      const page = decodeMonoRaster(bytes);
      expect({ dpi: page.dpi, widthMm: page.widthMm, heightMm: page.heightMm }).toEqual({
        dpi,
        widthMm: stock.widthMm,
        heightMm: stock.heightMm,
      });
    }
    expect(rasterize).toHaveBeenCalledWith("Молоко 3,2% 0,9 л", expect.anything());
  });

  it("leaves a RAW printer on the printer's language, driver or not in the profile's other fields", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const fields = boxLabelData(
      shift,
      { sscc: VALID_SSCC, itemCount: 12, closedAt: "2026-10-08T06:20:00.000Z" },
      "Анна",
    );
    const stock = buildDatedBoxLabelTemplates()[0]?.spec;
    if (stock === undefined) throw new Error("the domain has no stock box label");
    const zpl = new TextDecoder("latin1").decode(
      await renderLabel(stock, fields, { language: "zpl", dpi: 203 }, fakeRaster),
    );
    expect(zpl.startsWith("^XA")).toBe(true);
    const rawNamed = new TextDecoder("latin1").decode(
      await renderLabel(stock, fields, { language: "zpl", dpi: 203, mode: "raw" }, fakeRaster),
    );
    expect(rawNamed).toBe(zpl);
    const tspl = new TextDecoder("latin1").decode(
      await renderLabel(stock, fields, { language: "tspl", dpi: 300 }, fakeRaster),
    );
    expect(tspl).toContain("SIZE ");
    expect(tspl).not.toContain("MKRMNO1");
    // A driver profile keeps its stored language but prints a page, whatever it says.
    const page = await renderLabel(stock, fields, { ...GODEX, language: "tspl" }, fakeRaster);
    expect(new TextDecoder("latin1").decode(page.slice(0, 7))).toBe("MKRMNO1");
  });

  it("never draws text with a face it could not load", async () => {
    // jsdom has no `document.fonts`: the driver's rasterizer refuses rather than guess.
    await expect(
      rasterizeDriverText("Молоко", {
        fontFamily: "sans-serif",
        fontSizePx: 20,
        bold: false,
      }),
    ).rejects.toBeInstanceOf(RasterUnavailableError);
  });
});

/** The jsdom canvas's `getContext` as `test/setup.ts` left it. */
const realGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");

/** A canvas that draws nothing: the face check, not the drawing, is under test. */
function fakeCanvas(): void {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: function getContext() {
      return {
        font: "",
        fillStyle: "",
        textBaseline: "",
        measureText: (line: string) => ({ width: line.length * 10 }),
        fillRect: () => undefined,
        fillText: () => undefined,
        getImageData: (_x: number, _y: number, width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4).fill(255),
        }),
      };
    },
  });
}

function fakeFonts(fonts: { load: unknown; check: unknown }): void {
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
}

const OPTIONS = { fontFamily: "sans-serif", fontSizePx: 20, bold: false } as const;

describe("the driver's text rasterizer", () => {
  afterEach(() => {
    if (realGetContext === undefined) throw new Error("test/setup.ts defines no canvas getContext");
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", realGetContext);
    Reflect.deleteProperty(document, "fonts");
  });

  it("draws a text once its face is loaded and usable, asking for the text's own script", async () => {
    fakeCanvas();
    const load = vi.fn(async () => [{}]);
    const check = vi.fn(() => true);
    fakeFonts({ load, check });
    const raster = await rasterizeDriverText("Молоко", OPTIONS);
    expect(raster.width).toBeGreaterThan(0);
    expect(load).toHaveBeenCalledWith("400 20px IBM Plex Sans, sans-serif", "Молоко");
    expect(check).toHaveBeenCalledWith("400 20px IBM Plex Sans, sans-serif", "Молоко");
    // An empty text is checked with a Cyrillic sample, not with nothing.
    await rasterizeDriverText("", OPTIONS);
    expect(load).toHaveBeenLastCalledWith("400 20px IBM Plex Sans, sans-serif", "Аа");
    expect(check).toHaveBeenLastCalledWith("400 20px IBM Plex Sans, sans-serif", "Аа");
  });

  it("refuses without document.fonts, though the canvas would draw", async () => {
    fakeCanvas();
    await expect(rasterizeDriverText("Молоко", OPTIONS)).rejects.toBeInstanceOf(
      RasterUnavailableError,
    );
  });

  it("refuses a face that loaded nothing", async () => {
    fakeCanvas();
    fakeFonts({ load: async () => [], check: () => true });
    await expect(rasterizeDriverText("Молоко", OPTIONS)).rejects.toBeInstanceOf(
      RasterUnavailableError,
    );
  });

  it("refuses a face the webview does not report as usable", async () => {
    fakeCanvas();
    fakeFonts({ load: async () => [{}], check: () => false });
    await expect(rasterizeDriverText("Молоко", OPTIONS)).rejects.toBeInstanceOf(
      RasterUnavailableError,
    );
  });

  it("lets a failed face load fail the label instead of drawing with a fallback", async () => {
    fakeCanvas();
    fakeFonts({
      load: async () => {
        throw new Error("the face file is missing");
      },
      check: () => true,
    });
    await expect(rasterizeDriverText("Молоко", OPTIONS)).rejects.toThrow(
      "the face file is missing",
    );
  });

  it("is what a driver label draws its text with unless told otherwise, and RAW is not so strict", async () => {
    fakeCanvas();
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const fields = boxLabelData(
      shift,
      { sscc: VALID_SSCC, itemCount: 12, closedAt: "2026-10-08T06:20:00.000Z" },
      "Анна",
    );
    const stock = buildDatedBoxLabelTemplates()[0]?.spec;
    if (stock === undefined) throw new Error("the domain has no stock box label");
    // No `document.fonts`: the driver page is refused, the printer's own language is still made.
    await expect(renderLabel(stock, fields, GODEX)).rejects.toBeInstanceOf(RasterUnavailableError);
    await expect(renderLabel(stock, fields, { language: "zpl", dpi: 203 })).resolves.toBeInstanceOf(
      Uint8Array,
    );
    fakeFonts({ load: async () => [{}], check: () => true });
    const page = await renderLabel(stock, fields, GODEX);
    expect(decodeMonoRaster(page).dpi).toBe(203);
  });
});

describe("a printer's format in words", () => {
  const t = i18n.t.bind(i18n);

  it("is the language for RAW and the driver for the Windows driver", () => {
    expect(printerFormatText(t, ZEBRA)).toBe("ZPL");
    expect(printerFormatText(t, { ...ZEBRA, language: "tspl" })).toBe("TSPL");
    expect(printerFormatText(t, GODEX)).toBe("Драйвер Windows");
  });
});
