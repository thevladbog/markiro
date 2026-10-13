import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { sampleLabelData } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { renderLabel } from "../src/floor/print/label-render.js";
import { readPrintJob, type RenderLabel } from "../src/floor/print/print-jobs.js";
import { printerForAgain } from "../src/floor/print/print-resolution.js";
import {
  createKeyboardWedgeSource,
  type ScanListener,
  type ScanSource,
} from "../src/floor/scan-source.js";
import { NEW_PRINTER, profileOf } from "../src/floor/setup/printer-draft.js";
import { makeTestCode, scannedTestCode, testLabelSpec } from "../src/floor/setup/test-label.js";
import { WorkstationSetup } from "../src/floor/setup/WorkstationSetup.js";
import {
  DEFAULT_WORKSTATION_SETTINGS,
  InvalidSettingsError,
  readWorkstationSettings,
  saveWorkstationSettings,
  type WorkstationSettings,
} from "../src/floor/setup/workstation-settings.js";
import { playSignalTone } from "../src/floor/work/signal-sound.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import {
  closeBoxWithLabel,
  fakeRaster,
  fakeRender,
  jobRows,
  manualRuntime,
  printingSettings,
  printStation,
  setUpPrinting,
  TSC,
  ZEBRA,
} from "./support/printing.js";
import { PAIRING } from "./support/floor-work.js";

// The setup's «Проверить звук» plays the floor's own tone function.
vi.mock("../src/floor/work/signal-sound.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  playSignalTone: vi.fn(),
}));

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

interface Options {
  local?: LocalExecutor;
  shell?: ReturnType<typeof fakeHardware>;
  render?: RenderLabel;
  /** The runtime whose limit the test runs out by hand. */
  runtime?: ReturnType<typeof manualRuntime>;
  /** The floor's real scan source, where the test needs the keyboard wedge itself. */
  source?: ScanSource;
  /** The tab to go to once the setup is read («Принтеры» is where it opens). */
  tab?: "Сканер" | "Звук";
}

async function setup(options: Options = {}) {
  const local = options.local ?? openLocalDb().executor;
  const shell = options.shell ?? fakeHardware();
  const scanner = fakeSource();
  const onSaved = vi.fn<(settings: WorkstationSettings) => void>();
  const onBack = vi.fn();
  render(
    <ThemeProvider>
      <WorkstationSetup
        local={local}
        hardware={shell.hardware}
        printing={(options.runtime ?? manualRuntime(shell.hardware)).runtime}
        source={options.source ?? scanner.source}
        render={options.render ?? fakeRender}
        onSaved={onSaved}
        onBack={onBack}
      />
    </ThemeProvider>,
  );
  await screen.findByRole("heading", { name: "Принтеры" });
  if (options.tab !== undefined) tab(options.tab);
  return { local, shell, scanner, onSaved, onBack };
}

/** A press of one of the setup's tabs (ported from the cloud station: «Сканер», «Принтеры», «Звук»). */
function tab(name: "Сканер" | "Принтеры" | "Звук"): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

/** The real render over a rasterizer that needs no canvas: the test label is ASCII and never asks it. */
const realRender: RenderLabel = (spec, fields, printer) =>
  renderLabel(spec, fields, printer, fakeRaster);

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function click(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("the printer form", () => {
  it("describes a profile, or names the first thing wrong", () => {
    const newId = () => "new-1";
    expect(
      profileOf(
        { ...NEW_PRINTER, name: " Zebra ", host: " 192.168.1.50 ", tcpPort: "9100" },
        newId,
      ),
    ).toEqual({
      profile: {
        id: "new-1",
        name: "Zebra",
        target: { kind: "tcp", host: "192.168.1.50", port: 9100 },
        language: "zpl",
        dpi: 203,
      },
    });
    expect(
      profileOf(
        { ...NEW_PRINTER, id: "tsc", name: "TSC", kind: "serial", serialPort: "com4", dpi: "300" },
        newId,
      ),
    ).toEqual({
      profile: {
        id: "tsc",
        name: "TSC",
        target: { kind: "serial", port: "COM4", baud: 9600 },
        language: "zpl",
        dpi: 300,
      },
    });
    const wrong = (patch: Partial<typeof NEW_PRINTER>) =>
      profileOf({ ...NEW_PRINTER, name: "Zebra", host: "zebra", ...patch }, newId);
    expect(wrong({ name: " " })).toEqual({ error: "name" });
    expect(wrong({ host: "" })).toEqual({ error: "host" });
    expect(wrong({ tcpPort: "0" })).toEqual({ error: "port" });
    expect(wrong({ tcpPort: "65536" })).toEqual({ error: "port" });
    expect(wrong({ tcpPort: "91a" })).toEqual({ error: "port" });
    expect(wrong({ kind: "serial", serialPort: "" })).toEqual({ error: "serialPort" });
    expect(wrong({ kind: "serial", serialPort: "COM4", baud: "0" })).toEqual({ error: "baud" });
    expect(wrong({ kind: "usb", usbPrinter: "" })).toEqual({ error: "usbPrinter" });
  });
});

describe("the test label", () => {
  it("is a random code of unmistakable letters, all ASCII, read back without the scanner's prefix", () => {
    const code = makeTestCode((bytes) => bytes.set([0, 1, 2, 19, 20, 39]));
    expect(code).toBe("MKR-347Y3Y");
    expect(makeTestCode()).toMatch(/^MKR-[34789ACDEFHKMNPRTWXY]{6}$/);
    const spec = testLabelSpec(code, "tspl");
    expect(spec).toMatchObject({ widthMm: 58, heightMm: 40, language: "tspl" });
    expect(JSON.stringify(spec)).toMatch(/^[\x20-\x7e]*$/);
    expect(scannedTestCode(` ]C0${code}\r`)).toBe(code);
  });
});

describe("the workstation setup", () => {
  it("adds a network printer, gives it the box label and stores the settings only on save", async () => {
    const { local, onSaved } = await setup();
    expect(screen.getByText("Принтеров пока нет.")).toBeTruthy();
    click("Добавить принтер");
    type("Название", "Zebra у линии");
    type("Адрес принтера", "192.168.1.50");
    click("Готово");
    expect(screen.getByText("Сеть: 192.168.1.50:9100 · ZPL · 203 dpi")).toBeTruthy();
    const box = screen.getByLabelText("Этикетка короба");
    fireEvent.change(box, {
      target: {
        value: within(box).getByRole("option", { name: "Zebra у линии" }).getAttribute("value"),
      },
    });
    expect((await readWorkstationSettings(local)).printers).toEqual([]);
    expect(screen.getByRole("button", { name: "Назад без сохранения" })).toBeTruthy();
    await act(async () => {
      click("Сохранить");
    });
    expect(await screen.findByText("Настройки сохранены.")).toBeTruthy();
    const stored = await readWorkstationSettings(local);
    expect(stored.printers).toEqual([
      expect.objectContaining({
        name: "Zebra у линии",
        target: { kind: "tcp", host: "192.168.1.50", port: 9100 },
        language: "zpl",
        dpi: 203,
      }),
    ]);
    expect(stored.assignments.box).toBe(stored.printers[0]?.id);
    expect(onSaved).toHaveBeenCalledWith(stored);
    expect(screen.getByRole("button", { name: "Назад" })).toBeTruthy();
  });

  it("refuses a form with a mistake, and a second profile of one printer", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    await setup({ local });
    click("Добавить принтер");
    type("Название", "Ещё Zebra");
    type("Адрес принтера", "192.168.1.50");
    type("Порт", "70000");
    click("Готово");
    expect(screen.getByText("Порт — целое число от 1 до 65 535.")).toBeTruthy();
    type("Порт", "9100");
    click("Готово");
    expect(screen.getByText("Этот принтер уже есть в списке: «Zebra у линии».")).toBeTruthy();
    click("Отмена");
    expect(screen.queryByText("Новый принтер")).toBeNull();
  });

  it("edits a printer, and a removed printer prints nothing any more", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local, {
      assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" },
    });
    await setup({ local });
    click("Изменить принтер «TSC на COM4»");
    fireEvent.change(screen.getByLabelText("Разрешение"), { target: { value: "203" } });
    click("Готово");
    expect(screen.getByText("COM4, 9600 бод · TSPL · 203 dpi")).toBeTruthy();
    click("Удалить принтер «Zebra у линии»");
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    expect(await readWorkstationSettings(local)).toEqual(
      printingSettings({
        printers: [{ ...TSC, dpi: 203 }],
        assignments: { box: null, pallet: null, duplicate: "tsc" },
      }),
    );
  });

  it("lists the Windows queues for a USB printer, and says when the spooler does not answer", async () => {
    const shell = fakeHardware();
    vi.mocked(shell.hardware.listUsbPrinters)
      .mockResolvedValueOnce([{ name: "ZDesigner GK420d", port: "USB001" }])
      .mockRejectedValueOnce(new Error("spooler_unavailable"));
    await setup({ shell });
    click("Добавить принтер");
    type("Название", "Zebra USB");
    fireEvent.change(screen.getByLabelText("Подключение"), { target: { value: "usb" } });
    await screen.findByRole("option", { name: "ZDesigner GK420d" });
    type("Принтер Windows", "ZDesigner GK420d");
    click("Обновить список принтеров");
    expect(await screen.findByText("Служба печати Windows не ответила.")).toBeTruthy();
    click("Готово");
    expect(screen.getByText("Принтер Windows: ZDesigner GK420d · ZPL · 203 dpi")).toBeTruthy();
  });

  it("prints a test label and checks its code by the scanner, never showing another scan", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    // The real render: the test label is ASCII, so no text goes to the rasterizer.
    const render = vi.fn<RenderLabel>((spec, fields, printer) =>
      renderLabel(spec, fields, printer, fakeRaster),
    );
    const { shell, scanner } = await setup({ local, render });
    await act(async () => {
      click("Пробная печать на «Zebra у линии»");
    });
    expect(
      await screen.findByText("Пробная этикетка ушла на «Zebra у линии». Отсканируйте её код."),
    ).toBeTruthy();
    const spec = render.mock.calls[0]?.[0];
    const code = JSON.stringify(spec).match(/MKR-[A-Z0-9]{6}/)?.[0] ?? "";
    expect(spec).toEqual(testLabelSpec(code, "zpl"));
    expect(render.mock.calls[0]?.[2]).toEqual(ZEBRA);
    expect(shell.sends).toEqual([
      { target: ZEBRA.target, text: expect.stringContaining(`^FD${code}^FS`) },
    ]);
    await scanner.read("0042-badge-secret");
    expect(screen.getByText("Это не код пробной этикетки. Отсканируйте её код.")).toBeTruthy();
    expect(screen.queryByText(/badge-secret/)).toBeNull();
    // The check stays open for the right code.
    await scanner.read(`]C0${code}`);
    expect(screen.getByText("Код совпал: принтер и сканер работают.")).toBeTruthy();
  });

  it("says why a test label did not print", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    await setup({ local, shell });
    await act(async () => {
      click("Пробная печать на «TSC на COM4»");
    });
    expect(
      await screen.findByText(
        "Пробная этикетка не напечатана. Принтер не принял задание: этикетка не напечатана.",
      ),
    ).toBeTruthy();
  });

  it("leaves at once, dropping what was not saved", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    const { onBack } = await setup({ local });
    click("Удалить принтер «TSC на COM4»");
    click("Назад без сохранения");
    expect(onBack).toHaveBeenCalledTimes(1);
    expect((await readWorkstationSettings(local)).printers).toEqual([ZEBRA, TSC]);
  });

  it("says when the settings cannot be read, and lets the operator go back", async () => {
    const { executor } = openLocalDb();
    const broken: LocalExecutor = {
      ...executor,
      query: async () => {
        throw new Error("disk I/O error");
      },
    };
    const onBack = vi.fn();
    render(
      <ThemeProvider>
        <WorkstationSetup
          local={broken}
          hardware={fakeHardware().hardware}
          printing={manualRuntime(fakeHardware().hardware).runtime}
          source={fakeSource().source}
          onSaved={vi.fn()}
          onBack={onBack}
        />
      </ThemeProvider>,
    );
    expect(
      await screen.findByText(
        "Настройки рабочего места не прочитались. Вернитесь и откройте их снова.",
      ),
    ).toBeTruthy();
    click("Назад");
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("says a failed save and keeps the changes on the screen", async () => {
    const { executor } = openLocalDb();
    const failing: LocalExecutor = {
      ...executor,
      transaction: async () => {
        throw new Error("database or disk is full");
      },
    };
    await setup({ local: failing });
    click("Добавить принтер");
    type("Название", "Zebra");
    type("Адрес принтера", "zebra.local");
    click("Готово");
    await act(async () => {
      click("Сохранить");
    });
    await waitFor(() =>
      expect(
        screen.getByText("Настройки не сохранились: база этого компьютера не ответила."),
      ).toBeTruthy(),
    );
    expect(screen.getByText("Сеть: zebra.local:9100 · ZPL · 203 dpi")).toBeTruthy();
  });
});

describe("the test label is a sample, never a label of the line", () => {
  it("holds no SSCC, GTIN or code of a product, only its own test code", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    const { shell } = await setup({ local, render: realRender });
    await act(async () => {
      click("Пробная печать на «Zebra у линии»");
    });
    await screen.findByText(/Пробная этикетка ушла/);
    const text = shell.sends[0]?.text ?? "";
    expect(text).toContain("^FDMKR-");
    // The sample data of the model is handed over, but no element reads a field of it.
    expect(text).not.toContain(sampleLabelData().sscc);
    expect(text).not.toMatch(/[0-9]{14}/);
  });
});

describe("the test print and the limit of a send", () => {
  it("does not start a second test label while one is on its way, and never holds the leaving", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    const shell = fakeHardware();
    shell.holdSends();
    const prepared = vi.fn<RenderLabel>(fakeRender);
    const { onBack } = await setup({ local, shell, render: prepared });
    const test = screen.getByRole("button", { name: "Пробная печать на «Zebra у линии»" });
    await act(async () => {
      fireEvent.click(test);
      fireEvent.click(test);
    });
    await waitFor(() => expect(shell.heldSends()).toBe(1));
    expect(shell.sends).toHaveLength(1);
    // Still on the keyboard, and told in words; a press does nothing.
    expect(test.getAttribute("aria-disabled")).toBe("true");
    expect((test as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Пробная этикетка отправляется…")).toBeTruthy();
    fireEvent.click(test);
    expect(prepared).toHaveBeenCalledTimes(1);
    click("Назад");
    expect(onBack).toHaveBeenCalledTimes(1);
    await act(async () => {
      shell.releaseSend({ sent: true });
    });
    expect(await screen.findByText(/Пробная этикетка ушла/)).toBeTruthy();
    expect(test.getAttribute("aria-disabled")).toBeNull();
    // A second label queued behind the first would go out now: there is none.
    expect(shell.sends).toHaveLength(1);
    expect(prepared).toHaveBeenCalledTimes(1);
  });

  it("says a send that did not answer in time is unknown, and one that never started is busy", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    const shell = fakeHardware();
    shell.holdSends();
    const runtime = manualRuntime(shell.hardware);
    await setup({ local, shell, runtime });
    await act(async () => {
      click("Пробная печать на «Zebra у линии»");
    });
    await waitFor(() => expect(shell.heldSends()).toBe(1));
    await act(async () => {
      runtime.expire();
    });
    expect(
      await screen.findByText(
        "Неизвестно, напечаталась ли пробная этикетка. Принтер не ответил вовремя. Посмотрите, вышла ли этикетка.",
      ),
    ).toBeTruthy();
    // The stuck call still has the printer: the next test label waits behind it, is never given to the shell.
    await act(async () => {
      click("Пробная печать на «Zebra у линии»");
    });
    await act(async () => {
      runtime.expire();
    });
    expect(await screen.findByText(/Принтер ещё занят предыдущим заданием/)).toBeTruthy();
    expect(screen.getByText(/Пробная этикетка не напечатана\./)).toBeTruthy();
    expect(shell.sends).toHaveLength(1);
  });

  it("says a test label that could not be prepared, and sends nothing", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    const shell = fakeHardware();
    await setup({
      local,
      shell,
      render: async () => {
        throw new Error("canvas");
      },
    });
    await act(async () => {
      click("Пробная печать на «Zebra у линии»");
    });
    expect(await screen.findByText("Пробную этикетку не удалось подготовить.")).toBeTruthy();
    expect(shell.sends).toEqual([]);
  });

  it("asks nothing of a scan before a test label went, and ignores a scan after its code matched", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    const { scanner, shell } = await setup({ local, render: realRender });
    await scanner.read("0042-badge-secret");
    expect(screen.queryByText(/Это не код пробной этикетки/)).toBeNull();
    await act(async () => {
      click("Пробная печать на «Zebra у линии»");
    });
    await screen.findByText(/Пробная этикетка ушла/);
    const code = /\^FD(MKR-[A-Z0-9]{6})\^FS/.exec(shell.sends[0]?.text ?? "")?.[1] ?? "";
    await scanner.read(code);
    expect(screen.getByText("Код совпал: принтер и сканер работают.")).toBeTruthy();
    await scanner.read("0042-badge-secret");
    expect(screen.getByText("Код совпал: принтер и сканер работают.")).toBeTruthy();
    expect(screen.queryByText(/badge-secret/)).toBeNull();
  });
});

describe("what a change of the purposes leaves alone", () => {
  it("keeps the printer of a label that waits: another printer for boxes reroutes nothing", async () => {
    const station = await printStation();
    const job = await closeBoxWithLabel(station);
    expect(job.printer?.id).toBe("zebra");
    const before = jobRows(station.db);
    await setup({ local: station.local });
    fireEvent.change(screen.getByLabelText("Этикетка короба"), { target: { value: "tsc" } });
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    const settings = await readWorkstationSettings(station.local);
    expect(settings.assignments.box).toBe("tsc");
    expect(jobRows(station.db)).toEqual(before);
    const kept = await readPrintJob(station.local, PAIRING, "job-1");
    expect(kept).toEqual(job);
    // And a print again of that label goes where it was made for, not to the new box printer.
    expect(printerForAgain(job, settings, null)?.id).toBe("zebra");
  });
});

describe("what the screen says to a reader of it", () => {
  it("keeps its live regions in the page from the start, and puts no alert of its own in them", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    await setup({ local });
    const regions = () => [...document.querySelectorAll('[aria-live="polite"]')];
    expect(regions().length).toBeGreaterThanOrEqual(2);
    expect(regions().every((region) => region.childElementCount === 0)).toBe(true);
    await act(async () => {
      click("Пробная печать на «Zebra у линии»");
    });
    const sent = await screen.findByText(/Пробная этикетка ушла/);
    const region = sent.closest('[aria-live="polite"]');
    expect(region).not.toBeNull();
    // `role="presentation"`: inside a polite region an alert would be read twice.
    expect(sent.closest("[role]")?.getAttribute("role")).toBe("presentation");
    expect(sent.closest('[role="alert"]')).toBeNull();
    fireEvent.change(screen.getByLabelText("Этикетка паллеты"), { target: { value: "tsc" } });
    await act(async () => {
      click("Сохранить");
    });
    const saved = await screen.findByText("Настройки сохранены.");
    expect(saved.closest('[aria-live="polite"]')).not.toBeNull();
    expect(saved.closest('[role="alert"]')).toBeNull();
    expect(saved.closest("[role]")?.getAttribute("role")).toBe("presentation");
  });

  it("puts the focus on the section it shows, and gives it back when the form closes", async () => {
    await setup();
    expect(document.activeElement?.textContent).toBe("Принтеры");
    click("Добавить принтер");
    expect(document.activeElement?.textContent).toBe("Новый принтер");
    click("Отмена");
    expect(document.activeElement?.textContent).toBe("Принтеры");
  });

  it("keeps all its buttons at the floor's size", async () => {
    await setup();
    click("Добавить принтер");
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("mk-btn--floor");
    }
    const selects = [...document.querySelectorAll("select")];
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) {
      expect(select.style.height).toBe("var(--control-floor)");
    }
  });
});

describe("saving", () => {
  it("does nothing with nothing to save, and once while a save runs, and still lets the operator leave", async () => {
    const { executor } = openLocalDb();
    const statements: unknown[] = [];
    let finish: () => void = () => undefined;
    const slow: LocalExecutor = {
      ...executor,
      transaction: (batch) => {
        statements.push(batch);
        return new Promise((resolve) => {
          finish = () => resolve(executor.transaction(batch));
        });
      },
    };
    const { onBack } = await setup({ local: slow });
    const save = screen.getByRole("button", { name: "Сохранить" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(save);
    expect(statements).toHaveLength(0);
    click("Добавить принтер");
    type("Название", "Zebra");
    type("Адрес принтера", "zebra.local");
    // The form is open: nothing is saved from under it.
    expect((save as HTMLButtonElement).disabled).toBe(true);
    click("Готово");
    expect(save.getAttribute("aria-disabled")).toBeNull();
    await act(async () => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    expect(statements).toHaveLength(1);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    click("Назад без сохранения");
    expect(onBack).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    expect(await screen.findByText("Настройки сохранены.")).toBeTruthy();
  });

  it("takes «Настройки сохранены» back once something is changed again", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    await setup({ local });
    fireEvent.change(screen.getByLabelText("Этикетка паллеты"), { target: { value: "tsc" } });
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    fireEvent.change(screen.getByLabelText("Дубль кода"), { target: { value: "tsc" } });
    expect(screen.queryByText("Настройки сохранены.")).toBeNull();
    expect(screen.getByRole("button", { name: "Назад без сохранения" })).toBeTruthy();
  });

  it("writes every key in one transaction", async () => {
    const { executor } = openLocalDb();
    const batches: number[] = [];
    const counting: LocalExecutor = {
      ...executor,
      transaction: (batch) => {
        batches.push(batch.length);
        return executor.transaction(batch);
      },
    };
    await setup({ local: counting });
    click("Добавить принтер");
    type("Название", "Zebra");
    type("Адрес принтера", "zebra.local");
    click("Готово");
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    expect(batches).toEqual([4]);
  });

  it("says settings the build would not read back are refused, and keeps the changes", async () => {
    const { executor } = openLocalDb();
    const refusing: LocalExecutor = {
      ...executor,
      transaction: async () => {
        throw new InvalidSettingsError("printers");
      },
    };
    await setup({ local: refusing });
    click("Добавить принтер");
    type("Название", "Zebra");
    type("Адрес принтера", "zebra.local");
    click("Готово");
    await act(async () => {
      click("Сохранить");
    });
    expect(
      await screen.findByText("Настройки не сохранены: проверьте принтеры и сканеры."),
    ).toBeTruthy();
    expect(screen.getByText("Сеть: zebra.local:9100 · ZPL · 203 dpi")).toBeTruthy();
  });
});

describe("the list of Windows printers", () => {
  function later<T>() {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  it("says it is asking, and hears only the newest answer", async () => {
    const shell = fakeHardware();
    const first = later<{ name: string; port: string }[]>();
    const second = later<{ name: string; port: string }[]>();
    vi.mocked(shell.hardware.listUsbPrinters)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await setup({ shell });
    click("Добавить принтер");
    fireEvent.change(screen.getByLabelText("Подключение"), { target: { value: "usb" } });
    expect(screen.getByText("Спрашиваем у Windows список принтеров…")).toBeTruthy();
    click("Обновить список принтеров");
    await act(async () => {
      second.resolve([{ name: "Новый", port: "USB002" }]);
    });
    await screen.findByRole("option", { name: "Новый" });
    expect(screen.queryByText("Спрашиваем у Windows список принтеров…")).toBeNull();
    // The first, slower answer is stale: it must not replace the newer list.
    await act(async () => {
      first.resolve([{ name: "Старый", port: "USB001" }]);
    });
    expect(screen.queryByRole("option", { name: "Старый" })).toBeNull();
    expect(screen.getByRole("option", { name: "Новый" })).toBeTruthy();
  });

  it("does not let an old failure undo a newer list", async () => {
    const shell = fakeHardware();
    const first = later<{ name: string; port: string }[]>();
    const second = later<{ name: string; port: string }[]>();
    vi.mocked(shell.hardware.listUsbPrinters)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await setup({ shell });
    click("Добавить принтер");
    fireEvent.change(screen.getByLabelText("Подключение"), { target: { value: "usb" } });
    click("Обновить список принтеров");
    await act(async () => {
      second.resolve([{ name: "Новый", port: "USB002" }]);
    });
    await screen.findByRole("option", { name: "Новый" });
    await act(async () => {
      first.reject(new Error("spooler_unavailable"));
    });
    expect(screen.queryByText("Служба печати Windows не ответила.")).toBeNull();
    expect(screen.getByRole("option", { name: "Новый" })).toBeTruthy();
  });

  it("keeps the printer that was chosen when the spooler stops answering, and says so", async () => {
    const shell = fakeHardware();
    vi.mocked(shell.hardware.listUsbPrinters).mockRejectedValue(new Error("spooler_unavailable"));
    await setup({ shell });
    click("Добавить принтер");
    type("Название", "Zebra USB");
    fireEvent.change(screen.getByLabelText("Подключение"), { target: { value: "usb" } });
    expect(await screen.findByText("Служба печати Windows не ответила.")).toBeTruthy();
    expect(screen.queryByText("Спрашиваем у Windows список принтеров…")).toBeNull();
    click("Готово");
    expect(screen.getByText("Выберите принтер Windows.")).toBeTruthy();
  });

  it("says when Windows has no printer at all", async () => {
    const shell = fakeHardware();
    await setup({ shell });
    click("Добавить принтер");
    fireEvent.change(screen.getByLabelText("Подключение"), { target: { value: "usb" } });
    expect(await screen.findByText("Принтеров Windows не найдено.")).toBeTruthy();
  });
});

describe("the scanners, the sound and the label check of the setup", () => {
  it("adds a COM scanner, gives the shell the whole set on save, and shows its connection", async () => {
    const { local, shell } = await setup({ tab: "Сканер" });
    type("COM-порт сканера", "com3");
    click("Добавить сканер");
    expect(screen.getByText("COM3, 9600 бод")).toBeTruthy();
    expect(screen.getByText("Подключится после сохранения.")).toBeTruthy();
    expect(shell.hardware.configureScanners).not.toHaveBeenCalled();
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    expect(shell.hardware.configureScanners).toHaveBeenCalledWith([{ port: "COM3", baud: 9600 }]);
    expect((await readWorkstationSettings(local)).scanners).toEqual([{ port: "COM3", baud: 9600 }]);
    act(() => {
      shell.scannerStatus({
        revision: 1,
        scanners: [{ port: "COM3", baud: 9600, status: "disconnected" }],
      });
    });
    expect(screen.getByText("Нет связи: проверьте кабель и порт.")).toBeTruthy();
    act(() => {
      shell.scannerStatus({
        revision: 2,
        scanners: [{ port: "COM3", baud: 9600, status: "connected" }],
      });
    });
    expect(screen.getByText("Подключён.")).toBeTruthy();
    // Removed and saved: the shell gets the empty set, which closes the port.
    click("Удалить сканер COM3");
    await act(async () => {
      click("Сохранить");
    });
    await waitFor(() => expect(shell.hardware.configureScanners).toHaveBeenLastCalledWith([]));
  });

  it("refuses a scanner without a port, with a wrong speed or on a port it has", async () => {
    await setup({ tab: "Сканер" });
    click("Добавить сканер");
    expect(screen.getByText("Укажите COM-порт.")).toBeTruthy();
    type("COM-порт сканера", "COM3");
    type("Скорость сканера, бод", "0");
    click("Добавить сканер");
    expect(screen.getByText("Скорость — целое число больше нуля.")).toBeTruthy();
    type("Скорость сканера, бод", "9600");
    click("Добавить сканер");
    type("COM-порт сканера", "com3");
    click("Добавить сканер");
    expect(screen.getByText("Сканер на COM3 уже есть.")).toBeTruthy();
  });

  it("lists the computer's COM ports on request, and says when they cannot be read", async () => {
    const shell = fakeHardware();
    vi.mocked(shell.hardware.listSerialPorts)
      .mockResolvedValueOnce(["COM3", "COM4"])
      .mockRejectedValueOnce(new Error("serial_unavailable"));
    await setup({ shell, tab: "Сканер" });
    click("Показать COM-порты");
    expect(await screen.findByText("COM-порты этого компьютера: COM3, COM4.")).toBeTruthy();
    click("Показать COM-порты");
    expect(await screen.findByText("Список COM-портов не прочитался.")).toBeTruthy();
  });

  it("keeps the saved settings when the shell refuses the scanners, and says so", async () => {
    const shell = fakeHardware();
    vi.mocked(shell.hardware.configureScanners).mockRejectedValueOnce(
      new Error("invalid_scanners"),
    );
    const { local, onSaved } = await setup({ shell, tab: "Сканер" });
    type("COM-порт сканера", "COM3");
    click("Добавить сканер");
    await act(async () => {
      click("Сохранить");
    });
    expect(
      await screen.findByText(
        "Настройки сохранены, но оболочка не приняла сканеры. Проверьте COM-порты.",
      ),
    ).toBeTruthy();
    expect((await readWorkstationSettings(local)).scanners).toEqual([{ port: "COM3", baud: 9600 }]);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("sets the tones' level and the label check, tries the sound, and stores both", async () => {
    const local = openLocalDb().executor;
    const shell = fakeHardware();
    const playTone = vi.fn<(level: number) => void>();
    const scanner = fakeSource();
    render(
      <ThemeProvider>
        <WorkstationSetup
          local={local}
          hardware={shell.hardware}
          printing={manualRuntime(shell.hardware).runtime}
          source={scanner.source}
          playTone={playTone}
          onSaved={vi.fn()}
          onBack={vi.fn()}
        />
      </ThemeProvider>,
    );
    await screen.findByRole("heading", { name: "Принтеры" });
    tab("Звук");
    expect(screen.getByText("Громкость сигналов: 80 %.")).toBeTruthy();
    click("Тише");
    click("Тише");
    expect(screen.getByText("Громкость сигналов: 60 %.")).toBeTruthy();
    click("Проверить звук");
    expect(playTone).toHaveBeenLastCalledWith(0.6);
    click("Без звука");
    expect(screen.getByText("Сигналы без звука.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Тише" }).getAttribute("aria-disabled")).toBe("true");
    click("Проверить звук");
    expect(playTone).toHaveBeenLastCalledWith(0);
    tab("Принтеры");
    expect(screen.getByText("Проверка этикетки выключена.")).toBeTruthy();
    click("Проверять этикетку короба");
    expect(
      screen
        .getByRole("button", { name: "Проверять этикетку короба" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    const stored = await readWorkstationSettings(local);
    expect(stored.sound).toEqual({ muted: true, volume: 60 });
    expect(stored.verifyPrintedLabel).toBe(true);
  });
});

function later<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("a COM port is one thing's at a time", () => {
  it("refuses a scanner on the port of a serial printer, and a serial printer on a scanner's port", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local, { scanners: [{ port: "COM3", baud: 9600 }] });
    await setup({ local, tab: "Сканер" });
    type("COM-порт сканера", "com4");
    click("Добавить сканер");
    expect(
      screen.getByText("Порт COM4 занят принтером «TSC на COM4»: сканер и принтер не делят порт."),
    ).toBeTruthy();
    expect(screen.queryByText("COM4, 9600 бод")).toBeNull();
    type("COM-порт сканера", "");
    tab("Принтеры");
    click("Добавить принтер");
    type("Название", "Второй TSC");
    fireEvent.change(screen.getByLabelText("Подключение"), { target: { value: "serial" } });
    type("COM-порт", "com3");
    click("Готово");
    expect(
      screen.getByText("Порт COM3 занят сканером: принтер и сканер не делят порт."),
    ).toBeTruthy();
    type("COM-порт", "COM5");
    click("Готово");
    expect(screen.getByText("COM5, 9600 бод · ZPL · 203 dpi")).toBeTruthy();
  });

  it("frees the port of a printer that was removed, for a scanner", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    await setup({ local });
    click("Удалить принтер «TSC на COM4»");
    tab("Сканер");
    type("COM-порт сканера", "COM4");
    click("Добавить сканер");
    expect(screen.getByText("COM4, 9600 бод")).toBeTruthy();
  });
});

describe("what the shell would refuse is refused here first", () => {
  it("refuses a port name the shell would not take, and more scanners than it takes", async () => {
    const local = openLocalDb().executor;
    await saveWorkstationSettings(local, {
      ...DEFAULT_WORKSTATION_SETTINGS,
      scanners: Array.from({ length: 32 }, (_, index) => ({ port: `COM${index + 1}`, baud: 9600 })),
    });
    await setup({ local, tab: "Сканер" });
    type("COM-порт сканера", "COM\u00853");
    click("Добавить сканер");
    expect(
      screen.getByText("Название порта — до 256 символов, без служебных знаков."),
    ).toBeTruthy();
    type("COM-порт сканера", "C".repeat(257));
    click("Добавить сканер");
    expect(
      screen.getByText("Название порта — до 256 символов, без служебных знаков."),
    ).toBeTruthy();
    type("COM-порт сканера", "COM33");
    click("Добавить сканер");
    expect(screen.getByText("Сканеров может быть не больше 32.")).toBeTruthy();
    expect(screen.queryByText("COM33, 9600 бод")).toBeNull();
  });

  it("does not save a port that was typed but never added, and says so", async () => {
    const { local, shell } = await setup({ tab: "Сканер" });
    type("COM-порт сканера", "COM3");
    const save = screen.getByRole("button", { name: "Сохранить" });
    expect(save.getAttribute("aria-disabled")).toBeNull();
    await act(async () => {
      fireEvent.click(save);
    });
    expect(
      screen.getByText(
        "Нажмите «Добавить сканер» или очистите поле порта: сканер ещё не добавлен.",
      ),
    ).toBeTruthy();
    expect(shell.hardware.configureScanners).not.toHaveBeenCalled();
    expect((await readWorkstationSettings(local)).scanners).toEqual([]);
    type("COM-порт сканера", "");
    expect(
      screen.queryByText(
        "Нажмите «Добавить сканер» или очистите поле порта: сканер ещё не добавлен.",
      ),
    ).toBeNull();
  });

  it("keeps a scanner that works while a refused set is not stored, and writes nothing then", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local, { scanners: [{ port: "COM3", baud: 9600 }] });
    const refusing: LocalExecutor = {
      ...local,
      transaction: async () => {
        throw new InvalidSettingsError("scanners");
      },
    };
    const { shell } = await setup({ local: refusing, tab: "Сканер" });
    click("Удалить сканер COM3");
    type("COM-порт сканера", "COM7");
    click("Добавить сканер");
    await act(async () => {
      click("Сохранить");
    });
    expect(
      await screen.findByText("Настройки не сохранены: проверьте принтеры и сканеры."),
    ).toBeTruthy();
    // The shell was not asked: the scanner that worked is still the one it runs.
    expect(shell.hardware.configureScanners).not.toHaveBeenCalled();
  });
});

describe("the connection of a scanner, as far as it is known", () => {
  it("says a scanner is not the shell's until it is saved, and for a changed speed too", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local, { scanners: [{ port: "COM3", baud: 9600 }] });
    const { shell } = await setup({ local, tab: "Сканер" });
    act(() => {
      shell.scannerStatus({
        revision: 1,
        scanners: [{ port: "COM3", baud: 9600, status: "connected" }],
      });
    });
    expect(screen.getByText("Подключён.")).toBeTruthy();
    click("Удалить сканер COM3");
    type("COM-порт сканера", "COM3");
    type("Скорость сканера, бод", "19200");
    click("Добавить сканер");
    expect(screen.getByText("COM3, 19200 бод")).toBeTruthy();
    expect(screen.getByText("Подключится после сохранения.")).toBeTruthy();
    expect(screen.queryByText("Подключён.")).toBeNull();
  });

  it("says it is asking until the first answer, and that it could not ask when it cannot", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local, { scanners: [{ port: "COM3", baud: 9600 }] });
    const shell = fakeHardware();
    const first = later<() => void>();
    vi.mocked(shell.hardware.watchScanners).mockReturnValueOnce(first.promise);
    await setup({ local, shell, tab: "Сканер" });
    expect(screen.getByText("Проверяем связь…")).toBeTruthy();
    cleanup();
    vi.mocked(shell.hardware.watchScanners).mockRejectedValueOnce(new Error("invalid_response"));
    await setup({ local, shell, tab: "Сканер" });
    expect(await screen.findByText("Состояние связи не прочиталось.")).toBeTruthy();
    expect(screen.queryByText(/invalid_response/)).toBeNull();
  });

  it("offers to give the shell a saved scanner it never got, and does so without rewriting the settings", async () => {
    const { executor } = openLocalDb();
    await setUpPrinting(executor, { scanners: [{ port: "COM3", baud: 9600 }] });
    const batches: number[] = [];
    const counting: LocalExecutor = {
      ...executor,
      transaction: (batch) => {
        batches.push(batch.length);
        return executor.transaction(batch);
      },
    };
    const { shell } = await setup({ local: counting, tab: "Сканер" });
    expect(
      screen.getByText("Оболочка ещё не открыла этот порт. Нажмите «Сохранить»."),
    ).toBeTruthy();
    const save = screen.getByRole("button", { name: "Сохранить" });
    expect(save.getAttribute("aria-disabled")).toBeNull();
    await act(async () => {
      fireEvent.click(save);
    });
    await screen.findByText("Настройки сохранены.");
    expect(shell.hardware.configureScanners).toHaveBeenCalledWith([{ port: "COM3", baud: 9600 }]);
    expect(batches).toEqual([]);
    // Given: what is left is the shell's own snapshot, and nothing more to press.
    expect(screen.getByText("Оболочка ещё не открыла этот порт.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Сохранить" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("lets the operator give the shell the scanners again after it refused them", async () => {
    const { executor } = openLocalDb();
    const batches: number[] = [];
    const counting: LocalExecutor = {
      ...executor,
      transaction: (batch) => {
        batches.push(batch.length);
        return executor.transaction(batch);
      },
    };
    const shell = fakeHardware();
    vi.mocked(shell.hardware.configureScanners).mockRejectedValueOnce(
      new Error("invalid_scanners"),
    );
    await setup({ local: counting, shell, tab: "Сканер" });
    type("COM-порт сканера", "COM3");
    click("Добавить сканер");
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText(
      "Настройки сохранены, но оболочка не приняла сканеры. Проверьте COM-порты.",
    );
    expect(screen.queryByText(/invalid_scanners/)).toBeNull();
    const save = screen.getByRole("button", { name: "Сохранить" });
    expect(save.getAttribute("aria-disabled")).toBeNull();
    await act(async () => {
      fireEvent.click(save);
    });
    await screen.findByText("Настройки сохранены.");
    expect(shell.hardware.configureScanners).toHaveBeenCalledTimes(2);
    // The settings were written once: the second press only asked the shell again.
    expect(batches).toEqual([4]);
    act(() => {
      shell.scannerStatus({
        revision: 1,
        scanners: [{ port: "COM3", baud: 9600, status: "connected" }],
      });
    });
    expect(screen.getByRole("button", { name: "Сохранить" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("lets the operator give the shell the scanners again when its state cannot be read either", async () => {
    const shell = fakeHardware();
    vi.mocked(shell.hardware.watchScanners).mockRejectedValue(new Error("invalid_response"));
    vi.mocked(shell.hardware.configureScanners).mockRejectedValueOnce(new Error("unknown"));
    await setup({ shell, tab: "Сканер" });
    type("COM-порт сканера", "COM3");
    click("Добавить сканер");
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText(
      "Настройки сохранены, но оболочка не приняла сканеры. Проверьте COM-порты.",
    );
    expect(
      screen.getByRole("button", { name: "Сохранить" }).getAttribute("aria-disabled"),
    ).toBeNull();
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    expect(screen.getByRole("button", { name: "Сохранить" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("asks the shell once for two presses of «Сохранить», and gives it the set that was saved", async () => {
    const shell = fakeHardware();
    const answer = later<undefined>();
    vi.mocked(shell.hardware.configureScanners).mockReturnValueOnce(answer.promise);
    const { onBack } = await setup({ shell, tab: "Сканер" });
    type("COM-порт сканера", "COM3");
    click("Добавить сканер");
    const save = screen.getByRole("button", { name: "Сохранить" });
    await act(async () => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    expect(shell.hardware.configureScanners).toHaveBeenCalledTimes(1);
    // A scanner added while the shell still answers is not the saved set.
    type("COM-порт сканера", "COM4");
    click("Добавить сканер");
    expect(shell.hardware.configureScanners).toHaveBeenLastCalledWith([
      { port: "COM3", baud: 9600 },
    ]);
    // Leaving is never held by the shell's answer.
    click("Назад без сохранения");
    expect(onBack).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer.resolve(undefined);
    });
  });

  it("stops listening to the shell when it is left, even if the first answer was still on its way", async () => {
    const shell = fakeHardware();
    const first = later<() => void>();
    vi.mocked(shell.hardware.watchScanners).mockReturnValueOnce(first.promise);
    await setup({ shell });
    cleanup();
    const stop = vi.fn();
    await act(async () => {
      first.resolve(stop);
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops listening when the screen goes away after the first answer too", async () => {
    const shell = fakeHardware();
    const stop = vi.fn();
    vi.mocked(shell.hardware.watchScanners).mockResolvedValueOnce(stop);
    await setup({ shell });
    cleanup();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("the list of COM ports", () => {
  it("says it is asking, and hears only the newest answer", async () => {
    const shell = fakeHardware();
    const first = later<string[]>();
    const second = later<string[]>();
    vi.mocked(shell.hardware.listSerialPorts)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await setup({ shell, tab: "Сканер" });
    click("Показать COM-порты");
    expect(screen.getByText("Спрашиваем у системы список COM-портов…")).toBeTruthy();
    click("Показать COM-порты");
    await act(async () => {
      second.resolve(["COM8"]);
    });
    expect(await screen.findByText("COM-порты этого компьютера: COM8.")).toBeTruthy();
    expect(screen.queryByText("Спрашиваем у системы список COM-портов…")).toBeNull();
    await act(async () => {
      first.resolve(["COM1"]);
    });
    expect(screen.getByText("COM-порты этого компьютера: COM8.")).toBeTruthy();
  });

  it("does not let an old failure undo a newer list, and says when there is no port", async () => {
    const shell = fakeHardware();
    const first = later<string[]>();
    const second = later<string[]>();
    vi.mocked(shell.hardware.listSerialPorts)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await setup({ shell, tab: "Сканер" });
    click("Показать COM-порты");
    click("Показать COM-порты");
    await act(async () => {
      second.resolve([]);
    });
    expect(await screen.findByText("COM-портов не найдено.")).toBeTruthy();
    await act(async () => {
      first.reject(new Error("serial_unavailable"));
    });
    expect(screen.queryByText("Список COM-портов не прочитался.")).toBeNull();
    expect(screen.getByText("COM-портов не найдено.")).toBeTruthy();
  });
});

describe("the tones' level and the check of a label", () => {
  it("plays the floor's own tone at the draft's level when no tone is given", async () => {
    const local = openLocalDb().executor;
    await saveWorkstationSettings(local, {
      ...DEFAULT_WORKSTATION_SETTINGS,
      sound: { muted: false, volume: 30 },
    });
    render(
      <ThemeProvider>
        <WorkstationSetup
          local={local}
          hardware={fakeHardware().hardware}
          printing={manualRuntime(fakeHardware().hardware).runtime}
          source={fakeSource().source}
          onSaved={vi.fn()}
          onBack={vi.fn()}
        />
      </ThemeProvider>,
    );
    await screen.findByRole("heading", { name: "Принтеры" });
    tab("Звук");
    expect(screen.getByText("Громкость сигналов: 30 %.")).toBeTruthy();
    vi.mocked(playSignalTone).mockClear();
    click("Проверить звук");
    expect(playSignalTone).toHaveBeenLastCalledWith("ok", undefined, 0.3);
    click("Громче");
    click("Проверить звук");
    expect(playSignalTone).toHaveBeenLastCalledWith("ok", undefined, 0.4);
    click("Без звука");
    click("Проверить звук");
    expect(playSignalTone).toHaveBeenLastCalledWith("ok", undefined, 0);
  });

  it("steps the level between silence and full, never past them, and keeps the focus on its button", async () => {
    const local = openLocalDb().executor;
    await saveWorkstationSettings(local, {
      ...DEFAULT_WORKSTATION_SETTINGS,
      sound: { muted: false, volume: 10 },
    });
    await setup({ local });
    // The screen's own focus effect has run, so it cannot take the focus back.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Принтеры"));
    tab("Звук");
    const quieter = screen.getByRole("button", { name: "Тише" });
    quieter.focus();
    fireEvent.click(quieter);
    expect(screen.getByText("Сигналы без звука.")).toBeTruthy();
    expect(quieter.getAttribute("aria-disabled")).toBe("true");
    // A press at silence does nothing, and the button does not leave the keyboard.
    fireEvent.click(quieter);
    expect(screen.getByText("Сигналы без звука.")).toBeTruthy();
    expect(document.activeElement).toBe(quieter);
    const louder = screen.getByRole("button", { name: "Громче" });
    for (let step = 0; step < 12; step += 1) fireEvent.click(louder);
    expect(screen.getByText("Громкость сигналов: 100 %.")).toBeTruthy();
    expect(louder.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    expect((await readWorkstationSettings(local)).sound).toEqual({ muted: false, volume: 100 });
  });

  it("leaves the level alone while the sound is muted, and brings it back when it is not", async () => {
    await setup({ tab: "Звук" });
    click("Без звука");
    expect(screen.getByText("Сигналы без звука.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Громче" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    click("Громче");
    click("Без звука");
    expect(screen.getByRole("button", { name: "Без звука" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByText("Громкость сигналов: 80 %.")).toBeTruthy();
  });

  it("says a level of nothing is no sound, as a muted one is", async () => {
    const local = openLocalDb().executor;
    await saveWorkstationSettings(local, {
      ...DEFAULT_WORKSTATION_SETTINGS,
      sound: { muted: false, volume: 0 },
    });
    await setup({ local, tab: "Звук" });
    expect(screen.getByText("Сигналы без звука.")).toBeTruthy();
  });

  it("turns the label check on and off with a button that says which it is, and says what it changes", async () => {
    const local = openLocalDb().executor;
    await saveWorkstationSettings(local, {
      ...DEFAULT_WORKSTATION_SETTINGS,
      verifyPrintedLabel: true,
    });
    await setup({ local });
    const toggle = screen.getByRole("button", { name: "Проверять этикетку короба" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Проверка этикетки включена.")).toBeTruthy();
    expect(
      screen.getByText("Действует для этикеток, которые будут напечатаны после сохранения."),
    ).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Проверка этикетки выключена.")).toBeTruthy();
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    expect((await readWorkstationSettings(local)).verifyPrintedLabel).toBe(false);
  });
});

describe("saving what is not about the printers", () => {
  it("leaves the label that waits as it was: its printer, its bytes and its check", async () => {
    const station = await printStation();
    const job = await closeBoxWithLabel(station);
    const before = jobRows(station.db);
    const { shell } = await setup({ local: station.local, tab: "Сканер" });
    type("COM-порт сканера", "COM3");
    click("Добавить сканер");
    tab("Звук");
    click("Без звука");
    tab("Принтеры");
    click("Проверять этикетку короба");
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    const settings = await readWorkstationSettings(station.local);
    expect(settings.verifyPrintedLabel).toBe(true);
    expect(settings.scanners).toEqual([{ port: "COM3", baud: 9600 }]);
    expect(shell.hardware.configureScanners).toHaveBeenCalledWith([{ port: "COM3", baud: 9600 }]);
    expect(jobRows(station.db)).toEqual(before);
    expect(await readPrintJob(station.local, PAIRING, "job-1")).toEqual(job);
    expect(printerForAgain(job, settings, null)?.id).toBe("zebra");
  });
});

describe("what the scanners, the sound and the check say to a reader of them", () => {
  it("keeps every message in a polite region with no alert of its own, and every button at the floor's size", async () => {
    const shell = fakeHardware();
    vi.mocked(shell.hardware.listSerialPorts).mockResolvedValue(["COM3"]);
    await setup({ shell, tab: "Сканер" });
    click("Добавить сканер");
    const empty = screen.getByText("Укажите COM-порт.");
    expect(empty.closest('[aria-live="polite"]')).not.toBeNull();
    expect(empty.closest('[role="alert"]')).toBeNull();
    expect(empty.closest("[role]")?.getAttribute("role")).toBe("presentation");
    click("Показать COM-порты");
    const ports = await screen.findByText("COM-порты этого компьютера: COM3.");
    expect(ports.closest('[aria-live="polite"]')).not.toBeNull();
    type("COM-порт сканера", "COM3");
    click("Добавить сканер");
    const status = screen.getByText("Подключится после сохранения.");
    expect(status.closest('[aria-live="polite"]')).not.toBeNull();
    // With a scanner on the list too: its «Удалить» and every other button, on every tab.
    const floorSized = () => {
      for (const button of screen.getAllByRole("button")) {
        expect(button.className).toContain("mk-btn--floor");
      }
    };
    floorSized();
    tab("Звук");
    expect(screen.getByText("Громкость сигналов: 80 %.").getAttribute("aria-live")).toBe("polite");
    floorSized();
    tab("Принтеры");
    expect(screen.getByText("Проверка этикетки выключена.").getAttribute("aria-live")).toBe(
      "polite",
    );
    floorSized();
  });

  it("hands the focus to the scanners' heading when the scanner it was on is removed", async () => {
    const local = openLocalDb().executor;
    await saveWorkstationSettings(local, {
      ...DEFAULT_WORKSTATION_SETTINGS,
      scanners: [{ port: "COM3", baud: 9600 }],
    });
    await setup({ local });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Принтеры"));
    tab("Сканер");
    const remove = screen.getByRole("button", { name: "Удалить сканер COM3" });
    remove.focus();
    fireEvent.click(remove);
    expect(screen.queryByRole("button", { name: "Удалить сканер COM3" })).toBeNull();
    expect(document.activeElement?.textContent).toBe("Сканеры COM-портов");
  });
});

/** The keys of a typist or of a scanner, one by one, on `target` (they bubble to the window). */
function typeKeys(target: Element | Window, text: string): void {
  for (const key of text) fireEvent.keyDown(target, { key });
}

/** The closing Enter; `true` when nothing stopped its default (a field keeps its own Enter). */
function pressEnter(target: Element | Window): boolean {
  return fireEvent.keyDown(target, { key: "Enter" });
}

describe("the setup's fields and the keyboard wedge", () => {
  it("reads the first scan of a test label as its code after the operator typed in a field", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    const wedge = createKeyboardWedgeSource();
    const { shell } = await setup({ local, render: realRender, source: wedge, tab: "Сканер" });
    const field = screen.getByLabelText("COM-порт сканера");
    act(() => field.focus());
    typeKeys(field, "COM3");
    type("COM-порт сканера", "COM3");
    // Another tab takes the field away with the focus on it: no blur comes.
    tab("Принтеры");
    // As a touch or a mouse does it: the press moves the focus off the field.
    const test = screen.getByRole("button", { name: "Пробная печать на «Zebra у линии»" });
    act(() => test.focus());
    await act(async () => {
      fireEvent.click(test);
    });
    await screen.findByText(/Пробная этикетка ушла/);
    const code = /\^FD(MKR-[A-Z0-9]{6})\^FS/.exec(shell.sends[0]?.text ?? "")?.[1] ?? "";
    typeKeys(window, code);
    pressEnter(window);
    expect(screen.getByText("Код совпал: принтер и сканер работают.")).toBeTruthy();
    expect(screen.queryByText(/Это не код пробной этикетки/)).toBeNull();
  });

  it("drops what was typed ahead on a list before the test label goes, so its scan stands alone", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    const wedge = createKeyboardWedgeSource();
    const { shell } = await setup({ local, render: realRender, source: wedge });
    // A letter typed on a list (it picks an entry) is no field, but the wedge hears it.
    const list = screen.getByLabelText("Этикетка короба");
    act(() => list.focus());
    typeKeys(list, "ZZ");
    const test = screen.getByRole("button", { name: "Пробная печать на «Zebra у линии»" });
    act(() => test.focus());
    await act(async () => {
      fireEvent.click(test);
    });
    await screen.findByText(/Пробная этикетка ушла/);
    const code = /\^FD(MKR-[A-Z0-9]{6})\^FS/.exec(shell.sends[0]?.text ?? "")?.[1] ?? "";
    typeKeys(window, code);
    pressEnter(window);
    expect(screen.getByText("Код совпал: принтер и сканер работают.")).toBeTruthy();
  });

  it("leaves every text field its own keys and its Enter, and scans again once the focus leaves it", async () => {
    const wedge = createKeyboardWedgeSource();
    const scanned = vi.fn<ScanListener>();
    const stop = wedge.start(scanned);
    await setup({ source: wedge });
    const fields: { label: string; open?: () => void }[] = [
      { label: "COM-порт сканера", open: () => tab("Сканер") },
      { label: "Скорость сканера, бод" },
      {
        label: "Название",
        open: () => {
          tab("Принтеры");
          click("Добавить принтер");
        },
      },
      { label: "Адрес принтера" },
      { label: "Порт" },
      {
        label: "COM-порт",
        open: () =>
          fireEvent.change(screen.getByLabelText("Подключение"), { target: { value: "serial" } }),
      },
      { label: "Скорость, бод" },
    ];
    for (const { label, open } of fields) {
      open?.();
      const field = screen.getByLabelText(label);
      act(() => field.focus());
      typeKeys(field, "AB");
      expect(pressEnter(field), label).toBe(true);
      expect(scanned, label).not.toHaveBeenCalled();
      act(() => field.blur());
      typeKeys(window, "C");
      pressEnter(window);
      expect(scanned, label).toHaveBeenCalledTimes(1);
      expect(scanned, label).toHaveBeenCalledWith("C");
      scanned.mockClear();
    }
    stop();
  });

  it("scans again when a field goes away with the focus on it", async () => {
    const wedge = createKeyboardWedgeSource();
    const scanned = vi.fn<ScanListener>();
    const stop = wedge.start(scanned);
    await setup({ source: wedge });
    click("Добавить принтер");
    act(() => screen.getByLabelText("Название").focus());
    typeKeys(window, "AB");
    // The form closes under the focus: a removed field sends no blur.
    click("Отмена");
    typeKeys(window, "D");
    pressEnter(window);
    expect(scanned).toHaveBeenCalledTimes(1);
    expect(scanned).toHaveBeenCalledWith("D");
    stop();
  });

  it("scans again when the setup itself goes away with the focus on a field", async () => {
    const wedge = createKeyboardWedgeSource();
    const scanned = vi.fn<ScanListener>();
    const stop = wedge.start(scanned);
    await setup({ source: wedge, tab: "Сканер" });
    act(() => screen.getByLabelText("COM-порт сканера").focus());
    cleanup();
    typeKeys(window, "E");
    pressEnter(window);
    expect(scanned).toHaveBeenCalledTimes(1);
    expect(scanned).toHaveBeenCalledWith("E");
    stop();
  });
});

describe("the setup's tabs (the cloud station's layout)", () => {
  it("opens on «Принтеры», shows one panel at a time and moves between tabs with the arrows", async () => {
    await setup();
    const printers = screen.getByRole("tab", { name: "Принтеры" });
    expect(printers.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Принтеры" })).toBeTruthy();
    expect(screen.queryByLabelText("COM-порт сканера")).toBeNull();
    act(() => printers.focus());
    fireEvent.keyDown(printers, { key: "ArrowLeft" });
    const scanners = screen.getByRole("tab", { name: "Сканер" });
    expect(scanners.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(scanners);
    expect(screen.getByLabelText("COM-порт сканера")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Добавить принтер" })).toBeNull();
    fireEvent.keyDown(scanners, { key: "End" });
    expect(screen.getByRole("tab", { name: "Звук" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Проверить звук" })).toBeTruthy();
  });

  it("opens on the tab it is asked for", async () => {
    const shell = fakeHardware();
    render(
      <ThemeProvider>
        <WorkstationSetup
          local={openLocalDb().executor}
          hardware={shell.hardware}
          printing={manualRuntime(shell.hardware).runtime}
          source={fakeSource().source}
          render={fakeRender}
          initialTab="scanner"
          onSaved={vi.fn()}
          onBack={vi.fn()}
        />
      </ThemeProvider>,
    );
    expect(await screen.findByLabelText("COM-порт сканера")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Сканер" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the printer's form on screen until it is applied or cancelled: the tabs do nothing then", async () => {
    await setup();
    click("Добавить принтер");
    const scanners = screen.getByRole("tab", { name: "Сканер" });
    expect((scanners as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(scanners);
    expect(screen.getByLabelText("Название")).toBeTruthy();
    expect(screen.queryByLabelText("COM-порт сканера")).toBeNull();
    click("Отмена");
    fireEvent.click(scanners);
    expect(screen.getByLabelText("COM-порт сканера")).toBeTruthy();
  });

  it("keeps the draft of every tab across the tabs, and saves it all at once", async () => {
    const { local } = await setup({ tab: "Сканер" });
    type("COM-порт сканера", "COM3");
    click("Добавить сканер");
    tab("Звук");
    click("Тише");
    tab("Сканер");
    expect(screen.getByText("COM3, 9600 бод")).toBeTruthy();
    await act(async () => {
      click("Сохранить");
    });
    await screen.findByText("Настройки сохранены.");
    const stored = await readWorkstationSettings(local);
    expect(stored.scanners).toEqual([{ port: "COM3", baud: 9600 }]);
    expect(stored.sound).toEqual({ muted: false, volume: 70 });
  });
});
