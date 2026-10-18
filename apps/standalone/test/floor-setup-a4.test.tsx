import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeMonoRaster, type MonoBitmap, type RasterizeTextFn } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import { a4TestSheet } from "../src/floor/setup/a4-test.js";
import { NEW_PRINTER, profileOf, settleDraft, draftOf } from "../src/floor/setup/printer-draft.js";
import { WorkstationSetup } from "../src/floor/setup/WorkstationSetup.js";
import {
  readWorkstationSettings,
  type WorkstationSettings,
} from "../src/floor/setup/workstation-settings.js";
import type { PrintResult, WindowsPrinting } from "../src/hardware/hardware.js";
import { paintMonoRaster } from "../src/labels/sheet-render.js";
import { fakeHardware } from "./support/hardware.js";
import { choicesOf, setField, shownInList, usbListed } from "./support/floor-fields.js";
import { openLocalDb } from "./support/local-db.js";
import {
  fakeRender,
  GODEX_DRIVER,
  HP_A4,
  manualTimers,
  setUpPrinting,
  ZEBRA,
} from "./support/printing.js";

import type * as SheetRenderModule from "../src/labels/sheet-render.js";

// The setup's preview paints on a canvas jsdom does not have: the paint is what is watched.
vi.mock("../src/labels/sheet-render.js", async (importActual) => {
  const actual = await importActual<typeof SheetRenderModule>();
  return { ...actual, paintMonoRaster: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.mocked(paintMonoRaster).mockClear();
});

const LOGO: MonoBitmap = { width: 8, height: 4, stride: 1, pixels: new Uint8Array(4).fill(0xf0) };
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

function fakeSource() {
  let listener: ScanListener | null = null;
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    clearPendingInput: () => undefined,
    setManualTextEntryActive: () => undefined,
  };
  return {
    source,
    read: (raw: string) =>
      act(() => {
        listener?.(raw);
      }),
  };
}

function fakeWindows(answer?: () => Promise<PrintResult>, supported = true) {
  const prints: { queue: string; bytes: Uint8Array; paper: string | undefined }[] = [];
  const windows: WindowsPrinting = {
    supportsWindowsPrinting: vi.fn(async () => supported),
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

/** The sheet maker of the tests: the real A4 test sheet over a fake text and logo, remembering its SSCC. */
function sheetMaker() {
  const made: string[] = [];
  const a4Sheet: typeof a4TestSheet = (orientation, sscc, words) => {
    made.push(sscc);
    return a4TestSheet(orientation, sscc, words, { rasterize: text, logo: async () => LOGO });
  };
  return { a4Sheet, made };
}

interface Options {
  settings?: Partial<WorkstationSettings>;
  answer?: () => Promise<PrintResult>;
  a4Sheet?: typeof a4TestSheet;
  supported?: boolean;
}

async function setup(options: Options = {}) {
  const local = openLocalDb().executor;
  await setUpPrinting(local, {
    printers: [ZEBRA, HP_A4, GODEX_DRIVER],
    assignments: { box: "zebra", pallet: "hp-a4", duplicate: null },
    ...options.settings,
  });
  const shell = fakeHardware();
  vi.mocked(shell.hardware.listUsbPrinters).mockResolvedValue([
    { name: "HP LaserJet", port: "USB001" },
    { name: "Godex G500", port: "USB002" },
  ]);
  const { windows, prints } = fakeWindows(options.answer, options.supported ?? true);
  const runtime = createPrintRuntime(shell.hardware.printBytes, {
    windows,
    startTimer: manualTimers().startTimer,
  });
  const scanner = fakeSource();
  const sheets = sheetMaker();
  render(
    <ThemeProvider>
      <WorkstationSetup
        local={local}
        hardware={shell.hardware}
        printing={runtime}
        source={scanner.source}
        render={fakeRender}
        a4Sheet={options.a4Sheet ?? sheets.a4Sheet}
        onSaved={() => undefined}
        onBack={() => undefined}
      />
    </ThemeProvider>,
  );
  await screen.findByRole("heading", { name: "Принтеры" });
  return { local, shell, prints, windows, scanner, sheets };
}

function click(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

function choose(label: string, value: string): void {
  setField(label, value);
}

/** The resolution is a segmented control: locked, every one of its segments is off. */
function dpiLocked(): boolean {
  return within(screen.getByLabelText("Разрешение принтера"))
    .getAllByRole("radio")
    .every((radio) => (radio as HTMLButtonElement).disabled);
}

function optionsOf(label: string): string[] {
  return choicesOf(label);
}

describe("the printer form's paper (plan А4)", () => {
  it("describes A4 paper only for a Windows queue in driver mode at 300 dpi", () => {
    const newId = () => "new-1";
    const driver = {
      ...NEW_PRINTER,
      name: "HP",
      kind: "usb" as const,
      usbPrinter: "HP LaserJet",
      mode: "windows_driver" as const,
      dpi: "300" as const,
      paper: "a4" as const,
    };
    expect(profileOf(driver, newId)).toEqual({
      profile: {
        id: "new-1",
        name: "HP",
        target: { kind: "usb", printer: "HP LaserJet" },
        language: "zpl",
        dpi: 300,
        mode: "windows_driver",
        paper: "a4",
      },
    });
    expect(profileOf({ ...driver, dpi: "203" }, newId)).toEqual({ error: "paper" });
    expect(profileOf({ ...driver, mode: "raw" }, newId)).toEqual({ error: "paper" });
    expect(profileOf({ ...driver, kind: "tcp", host: "10.0.0.5" }, newId)).toEqual({
      error: "paper",
    });
    // The label paper is no field at all.
    const label = profileOf({ ...driver, paper: "label" }, newId);
    expect(label).toMatchObject({ profile: { mode: "windows_driver" } });
    expect(label).not.toHaveProperty("profile.paper");
  });

  it("settles a draft: A4 sets 300 dpi, and leaving the driver goes back to the label paper", () => {
    const usb = { ...NEW_PRINTER, kind: "usb" as const, mode: "windows_driver" as const };
    expect(settleDraft(usb, { paper: "a4" })).toMatchObject({ paper: "a4", dpi: "300" });
    expect(settleDraft({ ...usb, paper: "a4", dpi: "300" }, { mode: "raw" })).toMatchObject({
      paper: "label",
    });
    expect(settleDraft({ ...usb, paper: "a4", dpi: "300" }, { kind: "tcp" })).toMatchObject({
      paper: "label",
    });
    // A label driver's dpi is left as it was.
    expect(settleDraft(usb, { dpi: "300" })).toMatchObject({ paper: "label", dpi: "300" });
    expect(settleDraft(usb, { name: "x" })).toMatchObject({ dpi: "203", paper: "label" });
    expect(draftOf(HP_A4)).toMatchObject({ paper: "a4", dpi: "300", mode: "windows_driver" });
    expect(draftOf(ZEBRA)).toMatchObject({ paper: "label" });
  });
});

describe("the workstation setup's A4 printer (plan А4)", () => {
  it("offers the paper only for a Windows queue in driver mode, and A4 sets 300 dpi and locks the resolution", async () => {
    await setup({
      settings: { printers: [], assignments: { box: null, pallet: null, duplicate: null } },
    });
    click("Добавить принтер");
    expect(screen.queryByLabelText("Бумага")).toBeNull();
    choose("Подключение", "usb");
    await usbListed();
    choose("Принтер Windows", "HP LaserJet");
    // A Windows queue, but printing in the printer's language: no paper to choose.
    expect(screen.queryByLabelText("Бумага")).toBeNull();
    choose("Способ печати", "windows_driver");
    expect(optionsOf("Бумага")).toEqual(["Этикетка", "Лист А4"]);
    expect(dpiLocked()).toBe(false);
    choose("Бумага", "a4");
    expect(shownInList("Разрешение принтера")).toBe("300 dpi");
    expect(dpiLocked()).toBe(true);
    // Back to the language: the hidden paper goes back to the label's, and the resolution is free.
    choose("Способ печати", "raw");
    expect(screen.queryByLabelText("Бумага")).toBeNull();
    expect(dpiLocked()).toBe(false);
  });

  it("stores an A4 profile and sums it up by its paper, not by a language and a resolution", async () => {
    const { local } = await setup({
      settings: { printers: [], assignments: { box: null, pallet: null, duplicate: null } },
    });
    click("Добавить принтер");
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "HP на складе" } });
    choose("Подключение", "usb");
    await usbListed();
    choose("Принтер Windows", "HP LaserJet");
    choose("Способ печати", "windows_driver");
    choose("Бумага", "a4");
    click("Готово");
    expect(screen.getByText("Лист А4 · HP LaserJet")).toBeTruthy();
    choose("Этикетка паллеты", "HP на складе");
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены");
    const stored = await readWorkstationSettings(local);
    expect(stored.printers).toEqual([
      expect.objectContaining({ mode: "windows_driver", paper: "a4", dpi: 300 }),
    ]);
    expect(stored.assignments.pallet).toBe(stored.printers[0]?.id);
  });

  it("offers the A4 printer for the pallet label only, never for the box or the duplicate", async () => {
    await setup();
    expect(optionsOf("Этикетка короба")).toEqual(["Не назначен", ZEBRA.name, GODEX_DRIVER.name]);
    expect(optionsOf("Дубль кода")).toEqual(["Не назначен", ZEBRA.name, GODEX_DRIVER.name]);
    expect(optionsOf("Этикетка паллеты")).toEqual([
      "Не назначен",
      ZEBRA.name,
      HP_A4.name,
      GODEX_DRIVER.name,
    ]);
  });

  it("takes the box and the duplicate away from a printer that is made A4, and stores the rest", async () => {
    const { local } = await setup({
      settings: {
        printers: [ZEBRA, GODEX_DRIVER],
        assignments: { box: "godex", pallet: "godex", duplicate: "godex" },
      },
    });
    click("Изменить принтер «Godex через драйвер»");
    choose("Бумага", "a4");
    click("Готово");
    expect(shownInList("Этикетка короба")).toBe("Не назначен");
    expect(shownInList("Дубль кода")).toBe("Не назначен");
    expect(shownInList("Этикетка паллеты")).toBe("Godex через драйвер");
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены");
    expect((await readWorkstationSettings(local)).assignments).toEqual({
      box: null,
      pallet: "godex",
      duplicate: null,
    });
  });

  it("does not offer the paper where the shell does not print through Windows", async () => {
    await setup({
      settings: { printers: [ZEBRA], assignments: { box: null, pallet: null, duplicate: null } },
      supported: false,
    });
    click("Добавить принтер");
    choose("Подключение", "usb");
    await usbListed();
    expect(screen.queryByLabelText("Способ печати")).toBeNull();
    expect(screen.queryByLabelText("Бумага")).toBeNull();
  });
});

describe("the A4 test print (plan А4)", () => {
  it("sends the sheet as A4 pages through the driver, shows it, and takes the scan of its SSCC", async () => {
    const { prints, scanner, sheets, shell } = await setup();
    await act(async () => {
      click("Пробная печать на «HP LaserJet А4»");
    });
    expect(
      await screen.findByText(
        "Пробный лист ушёл на «HP LaserJet А4». Отсканируйте SSCC внизу листа.",
      ),
    ).toBeTruthy();
    expect(prints).toHaveLength(1);
    expect(prints[0]).toMatchObject({ queue: "HP LaserJet", paper: "a4" });
    expect(decodeMonoRaster(prints[0]?.bytes ?? new Uint8Array())).toMatchObject({
      widthMm: 210,
      heightMm: 297,
      dpi: 300,
    });
    expect(shell.sends).toEqual([]);
    const sscc = sheets.made[0] ?? "";
    expect(sscc).toMatch(/^9999[0-9]{14}$/);
    // The preview is the sheet that went, painted at a sixth.
    const preview = screen.getByRole("img", { name: "Предпросмотр тестового листа А4" });
    await waitFor(() => expect(paintMonoRaster).toHaveBeenCalledTimes(1));
    const [canvas, raster, factor] = vi.mocked(paintMonoRaster).mock.calls[0] ?? [];
    expect(canvas).toBe(preview);
    expect(Array.from(raster?.pixels ?? [])).toEqual(
      Array.from(decodeMonoRaster(prints[0]?.bytes ?? new Uint8Array()).pixels),
    );
    expect(factor).toBe(6);
    // Another SSCC, a label's code and a badge are no match; the right one is, however it is wrapped.
    await scanner.read("0042-badge-secret");
    expect(
      screen.getByText("Это не SSCC пробного листа. Отсканируйте SSCC внизу листа."),
    ).toBeTruthy();
    expect(screen.queryByText(/badge-secret/)).toBeNull();
    await scanner.read("999900000000000008");
    expect(screen.getByText(/Это не SSCC пробного листа/)).toBeTruthy();
    await scanner.read(`]C100${sscc}`);
    expect(screen.getByText("Код совпал: принтер и сканер работают.")).toBeTruthy();
  });

  it("makes a new SSCC for every test", async () => {
    const { sheets } = await setup();
    await act(async () => {
      click("Пробная печать на «HP LaserJet А4»");
    });
    await screen.findByText(/Пробный лист ушёл/);
    await act(async () => {
      click("Пробная печать на «HP LaserJet А4»");
    });
    await waitFor(() => expect(sheets.made).toHaveLength(2));
    expect(sheets.made[0]).not.toBe(sheets.made[1]);
  });

  it("still tests a label printer with a label, a Code 128 and the old words", async () => {
    const { prints, shell } = await setup();
    await act(async () => {
      click("Пробная печать на «Zebra у линии»");
    });
    expect(
      await screen.findByText("Пробная этикетка ушла на «Zebra у линии». Отсканируйте её код."),
    ).toBeTruthy();
    expect(shell.sends).toHaveLength(1);
    expect(prints).toEqual([]);
    expect(screen.queryByRole("img", { name: "Предпросмотр тестового листа А4" })).toBeNull();
  });

  it("says why the sheet did not print, and that a send in doubt is in doubt", async () => {
    const failed = await setup({
      answer: async () => ({ sent: false, code: "geometry_mismatch" }),
    });
    await act(async () => {
      click("Пробная печать на «HP LaserJet А4»");
    });
    expect(await screen.findByText(/Пробный лист не напечатан\. Размер бумаги/)).toBeTruthy();
    expect(failed.scanner).toBeDefined();
    cleanup();
    await setup({ answer: async () => ({ sent: false, code: "driver_unknown" }) });
    await act(async () => {
      click("Пробная печать на «HP LaserJet А4»");
    });
    expect(await screen.findByText(/Неизвестно, напечатался ли пробный лист\./)).toBeTruthy();
  });

  it("gives the measured numbers of a refused sheet and a button that copies them (beta 3.2)", async () => {
    const diagnostic =
      "reason=printable_too_small dpi=600x600 page_mm=210x297 printable_mm=159.2x246.2 needs_mm=190x277";
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await setup({ answer: async () => ({ sent: false, code: "geometry_mismatch", diagnostic }) });
    await act(async () => {
      click("Пробная печать на «HP LaserJet А4»");
    });
    expect((await screen.findByTestId("print-diagnostic")).textContent).toBe(diagnostic);
    await act(async () => {
      click("Копия диагностики");
    });
    expect(writeText).toHaveBeenCalledWith(diagnostic);
    expect(await screen.findByRole("button", { name: "Скопировано" })).toBeTruthy();
  });

  it("says that a sheet was moved or drawn smaller to fit the printer (beta 3.2)", async () => {
    await setup({
      answer: async () => ({
        sent: true,
        receipt: { queue: "HP", jobId: 5, documentName: "Markiro:x" },
        adjusted: { percent: 97, shiftXMm: 0, shiftYMm: -3.2 },
      }),
    });
    await act(async () => {
      click("Пробная печать на «HP LaserJet А4»");
    });
    expect(
      await screen.findByText(/Лист напечатан уменьшенным до 97 %.*Лист сдвинут на 3,2 мм/),
    ).toBeTruthy();
  });

  it("says a sheet that could not be made, sends nothing and shows no preview", async () => {
    const { prints } = await setup({
      a4Sheet: async () => {
        throw new Error("no font");
      },
    });
    await act(async () => {
      click("Пробная печать на «HP LaserJet А4»");
    });
    expect(await screen.findByText("Пробный лист не удалось подготовить.")).toBeTruthy();
    expect(prints).toEqual([]);
    expect(screen.queryByRole("img", { name: "Предпросмотр тестового листа А4" })).toBeNull();
  });

  it("drops the failure of a sheet that was being made when the paper changed", async () => {
    let fail: (error: Error) => void = () => undefined;
    const slow: typeof a4TestSheet = () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      });
    const { prints } = await setup({ a4Sheet: slow });
    await act(async () => {
      click("Пробная печать на «HP LaserJet А4»");
    });
    click("Изменить принтер «HP LaserJet А4»");
    choose("Бумага", "label");
    click("Готово");
    await act(async () => {
      fail(new Error("no font"));
    });
    expect(screen.queryByText("Пробный лист не удалось подготовить.")).toBeNull();
    expect(prints).toEqual([]);
  });

  it("forgets the result and the preview when the printer's paper changes", async () => {
    const { scanner, sheets } = await setup();
    await act(async () => {
      click("Пробная печать на «HP LaserJet А4»");
    });
    await screen.findByText(/Пробный лист ушёл/);
    expect(screen.getByRole("img", { name: "Предпросмотр тестового листа А4" })).toBeTruthy();
    click("Изменить принтер «HP LaserJet А4»");
    choose("Бумага", "label");
    click("Готово");
    expect(screen.queryByText(/Пробный лист ушёл/)).toBeNull();
    expect(screen.queryByRole("img", { name: "Предпросмотр тестового листа А4" })).toBeNull();
    // The sheet's SSCC is no longer awaited.
    await scanner.read(`]C100${sheets.made[0] ?? ""}`);
    expect(screen.queryByText("Код совпал: принтер и сканер работают.")).toBeNull();
  });

  it("keeps the result of another printer's test when an A4 printer's paper changes", async () => {
    await setup();
    await act(async () => {
      click("Пробная печать на «Zebra у линии»");
    });
    await screen.findByText(/Пробная этикетка ушла/);
    click("Изменить принтер «HP LaserJet А4»");
    choose("Бумага", "label");
    click("Готово");
    expect(screen.getByText(/Пробная этикетка ушла/)).toBeTruthy();
  });

  it("drops the answer of a test that was on its way when the paper changed", async () => {
    let release: (result: PrintResult) => void = () => undefined;
    const pending = new Promise<PrintResult>((resolve) => {
      release = resolve;
    });
    const { windows } = await setup({ answer: () => pending });
    await act(async () => {
      click("Пробная печать на «HP LaserJet А4»");
    });
    await waitFor(() => expect(windows.printWindowsRaster).toHaveBeenCalledTimes(1));
    click("Изменить принтер «HP LaserJet А4»");
    choose("Бумага", "label");
    click("Готово");
    await act(async () => {
      release({ sent: true });
    });
    expect(screen.queryByText(/Пробный лист ушёл/)).toBeNull();
    expect(screen.queryByText(/Пробная этикетка ушла/)).toBeNull();
  });

  it("forgets the test of a printer that is removed", async () => {
    await setup();
    await act(async () => {
      click("Пробная печать на «HP LaserJet А4»");
    });
    await screen.findByText(/Пробный лист ушёл/);
    click("Удалить принтер «HP LaserJet А4»");
    expect(screen.queryByText(/Пробный лист ушёл/)).toBeNull();
    expect(screen.queryByRole("img", { name: "Предпросмотр тестового листа А4" })).toBeNull();
  });
});
