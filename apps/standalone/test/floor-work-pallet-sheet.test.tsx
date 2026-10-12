import { buildPalletSheetPresets, decodeMonoRaster, type RasterizeTextFn } from "@markiro/domain";
import type { MonoBitmap } from "@markiro/domain";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { shiftLabelRender } from "../src/floor/print/shift-render.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import type { PrintResult, WindowsPrinting } from "../src/hardware/hardware.js";
import { logoToWire } from "../src/labels/logo.js";
import { km, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { palletStation, type PalletStation } from "./support/pallets.js";
import { fakeRaster, GODEX_DRIVER, HP_A4, manualTimers, ZEBRA } from "./support/printing.js";
import { renderWork } from "./support/work-screen.js";

const LOGO: MonoBitmap = { width: 16, height: 8, stride: 2, pixels: new Uint8Array(16).fill(0xff) };
const [PORTRAIT] = buildPalletSheetPresets();
if (PORTRAIT === undefined) throw new Error("no stock sheet");
const FROZEN = {
  palletSheet: {
    id: "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b",
    name: PORTRAIT.name,
    revision: 1,
    spec: PORTRAIT.spec,
  },
  organization: { name: "ООО «Молочный завод»", inn: "7701234567", logo: logoToWire(LOGO) },
};

const text: RasterizeTextFn = async (value, options) => {
  const width = Math.max(1, Math.min(value.length * 4, options.maxWidthPx ?? value.length * 4));
  const height = Math.ceil(options.fontSizePx * (options.lineHeight ?? 1.5));
  const stride = Math.ceil(width / 8);
  return {
    width,
    height,
    bytesPerRow: stride,
    totalBytes: stride * height,
    hex: "00".repeat(stride * height),
  };
};

function fakeWindows(answer?: () => Promise<PrintResult>) {
  const prints: { queue: string; bytes: Uint8Array; paper: string | undefined }[] = [];
  const windows: WindowsPrinting = {
    supportsWindowsPrinting: vi.fn(async () => true),
    printWindowsRaster: vi.fn(
      async (queue: string, bytes: Uint8Array, documentName: string, paper?: "a4") => {
        prints.push({ queue, bytes, paper });
        return answer !== undefined
          ? answer()
          : ({ sent: true, receipt: { queue, jobId: 5, documentName } } satisfies PrintResult);
      },
    ),
    getWindowsPrintJob: vi.fn(async () => ({ state: "absent" as const })),
  };
  return { windows, prints };
}

/** One box fills a pallet; the pallet's label goes to the A4 printer. */
async function station(frozen: Record<string, unknown> = FROZEN) {
  return palletStation({
    capacity: 1,
    boxCapacity: 1,
    frozen,
    settings: {
      printers: [ZEBRA, HP_A4, GODEX_DRIVER],
      assignments: { box: "zebra", pallet: "hp-a4", duplicate: null },
    },
  });
}

function work(at: PalletStation, answer?: () => Promise<PrintResult>) {
  const shell = fakeHardware();
  const { windows, prints } = fakeWindows(answer);
  const runtime = createPrintRuntime(shell.hardware.printBytes, {
    windows,
    startTimer: manualTimers().startTimer,
  });
  const harness = renderWork(at, {
    shell,
    runtime,
    overrides: {
      render: shiftLabelRender(at.shift, { rasterize: fakeRaster, sheetRasterize: text }),
    },
  });
  return { harness, shell, prints };
}

describe("the work screen prints a pallet's sheet (plan А4)", () => {
  it("sends the box label to its printer and the pallet's A4 sheet, after it, through the driver once", async () => {
    const at = await station();
    const { harness, shell, prints } = work(at);
    await harness.scanner.listening();
    await harness.settled();
    await harness.scan(km("A1"));
    // The box's label is the thermal 58 x 40 mm one; the pallet's is not among the RAW sends.
    expect(shell.sends).toHaveLength(1);
    expect(shell.sends[0]?.text).toContain("^PW464\n^LL320");
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({ queue: "HP LaserJet", paper: "a4" });
    expect(decodeMonoRaster(prints[0]?.bytes ?? new Uint8Array())).toMatchObject({
      widthMm: 210,
      heightMm: 297,
    });
    expect(
      rows(at.db, "SELECT purpose, state, attempts FROM floor_print_jobs ORDER BY purpose"),
    ).toEqual([
      { purpose: "box", state: "sent", attempts: 1 },
      { purpose: "pallet", state: "sent", attempts: 1 },
    ]);
    expect(screen.queryByText("Этикетка паллеты не напечатана")).toBeNull();
  });

  it("offers every printer for a pallet's «Другой принтер», prints the thermal label on a label printer, and sends no second sheet", async () => {
    const at = await station();
    const { harness, shell, prints } = work(at, async () => ({
      sent: false,
      code: "queue_unavailable",
    }));
    await harness.scanner.listening();
    await harness.settled();
    await harness.scan(km("A1"));
    expect(await screen.findByText("Этикетка паллеты не напечатана")).toBeTruthy();
    expect(prints).toHaveLength(1);
    await harness.press("Другой принтер");
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(
      expect.arrayContaining([
        "Zebra у линии · ZPL · 203 dpi",
        "HP LaserJet А4 · Лист А4 · 300 dpi",
        "Godex через драйвер · Драйвер Windows · 203 dpi",
      ]),
    );
    await harness.press("Zebra у линии · ZPL · 203 dpi");
    // The thermal pallet label of the snapshot's 100 x 150 mm layout, not a sheet.
    expect(shell.sends.at(-1)?.text).toContain("^PW799\n^LL1199");
    expect(prints).toHaveLength(1);
    expect(screen.queryByText("Этикетка паллеты не напечатана")).toBeNull();
  });

  it("keeps a pallet whose shift froze no sheet closed, says the label did not render, and prints a label elsewhere", async () => {
    const at = await station({ organization: FROZEN.organization });
    const { harness, shell, prints } = work(at);
    await harness.scanner.listening();
    await harness.settled();
    await harness.scan(km("A1"));
    expect(await screen.findByText("Этикетка паллеты не напечатана")).toBeTruthy();
    expect(screen.getByText(/Этикетку не удалось подготовить для этого принтера/)).toBeTruthy();
    expect(prints).toEqual([]);
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'pallet_closed'")).toEqual([
      { n: 1 },
    ]);
    await harness.press("Другой принтер");
    await harness.press("Zebra у линии · ZPL · 203 dpi");
    // The thermal pallet label of the snapshot's 100 x 150 mm layout, not a sheet.
    expect(shell.sends.at(-1)?.text).toContain("^PW799\n^LL1199");
    expect(prints).toEqual([]);
  });

  it("waits for the operator after a sheet in doubt: the sheet is not sent again by itself", async () => {
    const at = await station();
    const { harness, prints } = work(at, async () => ({ sent: false, code: "driver_unknown" }));
    await harness.scanner.listening();
    await harness.settled();
    await harness.scan(km("A1"));
    expect(await screen.findByText("Неизвестно, напечаталась ли этикетка")).toBeTruthy();
    await harness.settled();
    await harness.settled();
    expect(prints).toHaveLength(1);
    expect(
      rows(
        at.db,
        "SELECT state, error_code, attempts FROM floor_print_jobs WHERE purpose = 'pallet'",
      ),
    ).toEqual([{ state: "unknown", error_code: "driver_unknown", attempts: 1 }]);
  });

  it("never offers the A4 printer for a box's «Другой принтер»", async () => {
    const at = await station();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const { windows } = fakeWindows();
    const runtime = createPrintRuntime(shell.hardware.printBytes, {
      windows,
      startTimer: manualTimers().startTimer,
    });
    const harness = renderWork(at, {
      shell,
      runtime,
      overrides: {
        render: shiftLabelRender(at.shift, { rasterize: fakeRaster, sheetRasterize: text }),
      },
    });
    await harness.scanner.listening();
    await harness.settled();
    await harness.scan(km("A1"));
    expect(await screen.findByText("Этикетка короба не напечатана")).toBeTruthy();
    await harness.press("Другой принтер");
    const names = screen.getAllByRole("button").map((button) => button.textContent);
    expect(names).toContain("Zebra у линии · ZPL · 203 dpi");
    expect(names).toContain("Godex через драйвер · Драйвер Windows · 203 dpi");
    expect(names.some((name) => name?.includes("Лист А4"))).toBe(false);
  });
});
