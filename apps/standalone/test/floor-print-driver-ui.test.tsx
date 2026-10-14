import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";

import { formatSsccHri, sampleLabelData } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import {
  DRIVER_FAILED_CODES,
  PRINT_FAILURE_CODES,
  windowsJobObservationSchema,
  type PrintResult,
  type WindowsPrinting,
} from "../src/hardware/hardware.js";
import { LabelPanel } from "../src/floor/print/LabelPanel.js";
import { FAILED_CODES, UNKNOWN_CODES, type PrintJob } from "../src/floor/print/print-jobs.js";
import {
  createPrintRuntime,
  type PrintRuntime,
  type WindowsQueueCheck,
} from "../src/floor/print/print-runtime.js";
import type { ScanSource } from "../src/floor/scan-source.js";
import { WorkstationSetup } from "../src/floor/setup/WorkstationSetup.js";
import {
  readWorkstationSettings,
  type PrinterProfile,
} from "../src/floor/setup/workstation-settings.js";
import { fakeHardware } from "./support/hardware.js";
import { choicesOf, setField, usbListed } from "./support/floor-fields.js";
import { openLocalDb } from "./support/local-db.js";
import { km } from "./support/floor-work.js";
import { FIRST_SSCC, fakeRender, printStation, setUpPrinting, ZEBRA } from "./support/printing.js";
import { renderWork } from "./support/work-screen.js";

const GODEX: PrinterProfile = {
  id: "godex",
  name: "Godex через драйвер",
  target: { kind: "usb", printer: "Godex G500" },
  language: "zpl",
  dpi: 203,
  mode: "windows_driver",
};
const AT = "2026-10-08T06:20:00.000Z";

function windows(supported: boolean): WindowsPrinting {
  return {
    supportsWindowsPrinting: vi.fn(async () => supported),
    printWindowsRaster: vi.fn(
      async (queue: string, _bytes: Uint8Array, documentName: string): Promise<PrintResult> => ({
        sent: true,
        receipt: { queue, jobId: 3, documentName },
      }),
    ),
    getWindowsPrintJob: vi.fn(async () => ({ state: "absent" as const })),
  };
}

const source: ScanSource = {
  start: () => () => undefined,
  clearPendingInput: () => undefined,
  setManualTextEntryActive: () => undefined,
};

function type(label: string, value: string): void {
  setField(label, value);
}

describe("the workstation setup's way of printing", () => {
  it("offers the Windows driver for a Windows queue, hides the language and stores the driver", async () => {
    const { executor } = openLocalDb();
    const shell = fakeHardware();
    vi.mocked(shell.hardware.listUsbPrinters).mockResolvedValue([
      { name: "Godex G500", port: "USB001" },
    ]);
    const printing = createPrintRuntime(shell.hardware.printBytes, { windows: windows(true) });
    render(
      <ThemeProvider>
        <WorkstationSetup
          local={executor}
          hardware={shell.hardware}
          printing={printing}
          source={source}
          render={fakeRender}
          onSaved={() => undefined}
          onBack={() => undefined}
        />
      </ThemeProvider>,
    );
    await screen.findByRole("heading", { name: "Принтеры" });
    fireEvent.click(screen.getByRole("button", { name: "Добавить принтер" }));
    type("Название", "Godex");
    // Not offered for the network.
    expect(screen.queryByLabelText("Способ печати")).toBeNull();
    type("Подключение", "usb");
    await usbListed();
    type("Принтер Windows", "Godex G500");
    await screen.findByLabelText("Способ печати");
    expect(screen.getByLabelText("Язык принтера")).toBeTruthy();
    setField("Способ печати", "windows_driver");
    expect(screen.queryByLabelText("Язык принтера")).toBeNull();
    expect(screen.getByText(/Размер бумаги и разрешение в драйвере/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(
      screen.getByText("Принтер Windows: Godex G500 · Драйвер Windows · 203 dpi"),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    });
    const stored = await readWorkstationSettings(executor);
    expect(stored.printers[0]).toMatchObject({ target: GODEX.target, mode: "windows_driver" });
  });

  it("does not offer the driver where the shell does not print through Windows", async () => {
    const { executor } = openLocalDb();
    const shell = fakeHardware();
    vi.mocked(shell.hardware.listUsbPrinters).mockResolvedValue([
      { name: "Godex G500", port: "USB001" },
    ]);
    render(
      <ThemeProvider>
        <WorkstationSetup
          local={executor}
          hardware={shell.hardware}
          printing={createPrintRuntime(shell.hardware.printBytes, { windows: windows(false) })}
          source={source}
          render={fakeRender}
          onSaved={() => undefined}
          onBack={() => undefined}
        />
      </ThemeProvider>,
    );
    await screen.findByRole("heading", { name: "Принтеры" });
    fireEvent.click(screen.getByRole("button", { name: "Добавить принтер" }));
    type("Подключение", "usb");
    await usbListed();
    expect(screen.queryByLabelText("Способ печати")).toBeNull();
  });
});

describe("the label panel of a driver label in doubt", () => {
  const job: PrintJob = {
    id: "job-1",
    shiftId: "shift-1",
    purpose: "box",
    subjectId: "box-1",
    sscc: "046006820000035007",
    state: "unknown",
    verify: false,
    templateId: "template-1",
    templateRev: 1,
    fields: sampleLabelData(),
    printer: GODEX,
    bytesBase64: "TUtSTU5PMQA=",
    errorCode: "driver_unknown",
    attempts: 1,
    operatorId: "operator-1",
    createdAt: AT,
    updatedAt: AT,
  };
  const settings = async () => ({
    printers: [GODEX, ZEBRA],
    assignments: { box: "godex", pallet: null, duplicate: null },
  });

  function panel(props: { job: PrintJob; checkQueue?: () => Promise<{ state: "absent" }> }) {
    render(
      <ThemeProvider>
        <LabelPanel
          job={props.job}
          busy={false}
          note={null}
          loadSettings={settings}
          onPrintAgain={() => undefined}
          onPrinted={() => undefined}
          onSkip={() => undefined}
          {...(props.checkQueue === undefined ? {} : { checkQueue: props.checkQueue })}
        />
      </ThemeProvider>,
    );
  }

  it("says the driver's doubt, where a reprint goes in words, and asks the Windows queue", async () => {
    const checkQueue = vi.fn(async () => ({ state: "absent" as const }));
    panel({ job, checkQueue });
    expect(screen.getByText(/Windows не подтвердил задание до конца/)).toBeTruthy();
    expect(
      await screen.findByText(
        "Печать пойдёт на принтер: Godex через драйвер · Драйвер Windows · 203 dpi.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить очередь Windows" }));
    expect(
      await screen.findByText(
        "Задания нет в очереди Windows. Это не подтверждает, что этикетка напечаталась.",
      ),
    ).toBeTruthy();
    expect(checkQueue).toHaveBeenCalledTimes(1);
  });

  it("asks no queue for a RAW printer's label", async () => {
    panel({
      job: { ...job, printer: ZEBRA, errorCode: "outcome_unknown" },
      checkQueue: vi.fn(async () => ({ state: "absent" as const })),
    });
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "Проверить очередь Windows" })).toBeNull();
  });
});

describe("the texts of the driver's codes and of the Windows queue", () => {
  it("has a text for every code a job can end with and every answer of the queue check", () => {
    const codes = [
      ...FAILED_CODES,
      ...UNKNOWN_CODES,
      ...PRINT_FAILURE_CODES,
      ...DRIVER_FAILED_CODES,
      "driver_unknown",
    ];
    // The four driver codes are among those a job stores.
    for (const code of ["queue_unavailable", "geometry_mismatch", "driver_not_started"]) {
      expect(FAILED_CODES).toContain(code);
    }
    expect(UNKNOWN_CODES).toContain("driver_unknown");
    for (const code of codes) {
      expect(i18n.exists(`floor.print.codes.${code}`), code).toBe(true);
    }
    const observed = windowsJobObservationSchema.options.map((option) => option.shape.state.value);
    expect(observed.sort()).toEqual(["absent", "identity_mismatch", "present", "unavailable"]);
    for (const state of [...observed, "no_receipt"]) {
      expect(i18n.exists(`floor.print.queue.${state}`), state).toBe(true);
    }
  });
});

describe("the label panel's Windows queue check", () => {
  const job: PrintJob = {
    id: "job-1",
    shiftId: "shift-1",
    purpose: "box",
    subjectId: "box-1",
    sscc: "046006820000035007",
    state: "unknown",
    verify: false,
    templateId: "template-1",
    templateRev: 1,
    fields: sampleLabelData(),
    printer: GODEX,
    bytesBase64: "TUtSTU5PMQA=",
    errorCode: "driver_unknown",
    attempts: 1,
    operatorId: "operator-1",
    createdAt: AT,
    updatedAt: AT,
  };
  const loadSettings = async () => ({
    printers: [GODEX, ZEBRA],
    assignments: { box: "godex", pallet: null, duplicate: null },
  });
  const QUEUE = "Проверить очередь Windows";

  async function mount(
    props: {
      job?: PrintJob;
      busy?: boolean;
      clock?: () => number;
      checkQueue?: (() => Promise<WindowsQueueCheck>) | null;
    } = {},
  ) {
    const checkQueue =
      props.checkQueue === undefined
        ? vi.fn(async (): Promise<WindowsQueueCheck> => ({ state: "absent" }))
        : props.checkQueue;
    render(
      <ThemeProvider>
        <LabelPanel
          job={props.job ?? job}
          busy={props.busy ?? false}
          note={null}
          loadSettings={loadSettings}
          onPrintAgain={() => undefined}
          onPrinted={() => undefined}
          onSkip={() => undefined}
          {...(props.clock === undefined ? {} : { clock: props.clock })}
          {...(checkQueue === null ? {} : { checkQueue })}
        />
      </ThemeProvider>,
    );
    // The panel reads the settings when it opens: let the answer in before the test goes on.
    await act(async () => undefined);
    return checkQueue;
  }

  it.each<[string, WindowsQueueCheck, string]>([
    [
      "present",
      { state: "present", statusFlags: 0 },
      "Задание находится в очереди Windows: этикетка ещё может напечататься.",
    ],
    [
      "identity_mismatch",
      { state: "identity_mismatch" },
      "Номер задания уже принадлежит другому заданию Windows.",
    ],
    ["unavailable", { state: "unavailable" }, "Очередь Windows недоступна."],
    [
      "no_receipt",
      { state: "no_receipt" },
      "Номер задания Windows неизвестен: посмотрите очередь принтера в Windows.",
    ],
  ])("says the queue's answer %s in words and decides nothing", async (_name, answer, text) => {
    await mount({ checkQueue: vi.fn(async () => answer) });
    fireEvent.click(screen.getByRole("button", { name: QUEUE }));
    expect(await screen.findByText(text)).toBeTruthy();
    // The label is still in doubt: the decisions are still the operator's.
    expect(screen.getByRole("button", { name: "Этикетка напечаталась" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Напечатать снова" })).toBeTruthy();
  });

  it("says the queue is unavailable when the check itself fails", async () => {
    await mount({
      checkQueue: vi.fn(async (): Promise<WindowsQueueCheck> => {
        throw new Error("ipc");
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: QUEUE }));
    expect(await screen.findByText("Очередь Windows недоступна.")).toBeTruthy();
  });

  it("says it is asking, ignores a second press meanwhile, and asks again once answered", async () => {
    let answer: (check: WindowsQueueCheck) => void = () => undefined;
    const checkQueue = vi.fn(
      () =>
        new Promise<WindowsQueueCheck>((resolve) => {
          answer = resolve;
        }),
    );
    await mount({ checkQueue });
    const button = screen.getByRole("button", { name: QUEUE });
    fireEvent.click(button);
    expect(await screen.findByText("Спрашиваем очередь Windows…")).toBeTruthy();
    fireEvent.click(button);
    expect(checkQueue).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer({ state: "absent" });
    });
    expect(
      screen.getByText(
        "Задания нет в очереди Windows. Это не подтверждает, что этикетка напечаталась.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Спрашиваем очередь Windows…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: QUEUE }));
    await waitFor(() => expect(checkQueue).toHaveBeenCalledTimes(2));
    await act(async () => {
      answer({ state: "present", statusFlags: 0 });
    });
  });

  it("is a floor-sized button that the keyboard reaches", async () => {
    await mount();
    const button = screen.getByRole("button", { name: QUEUE });
    expect(button.getAttribute("tabindex")).not.toBe("-1");
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.className).toMatch(/floor/);
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it("is offered only while the label may exist, for a printer in driver mode, when the screen can ask", async () => {
    // A label that failed before the spooler took it: nothing to look for in the queue.
    const failed = { ...job, state: "failed" as const, errorCode: "geometry_mismatch" as const };
    await mount({ job: failed });
    expect(screen.queryByRole("button", { name: QUEUE })).toBeNull();
    expect(screen.getByText(/Размер бумаги или разрешение в драйвере Windows/)).toBeTruthy();
  });

  it("is not offered without the screen's way to ask, or for a job without a printer", async () => {
    await mount({ checkQueue: null });
    expect(screen.queryByRole("button", { name: QUEUE })).toBeNull();
  });

  it("is not offered for a job whose printer is unknown", async () => {
    await mount({ job: { ...job, printer: null } });
    expect(screen.queryByRole("button", { name: QUEUE })).toBeNull();
  });

  it("is offered while the scan check of a sent driver label waits, and says the answer there", async () => {
    const checking: PrintJob = { ...job, state: "sent", verify: true, errorCode: null };
    const checkQueue = await mount({ job: checking });
    fireEvent.click(screen.getByRole("button", { name: QUEUE }));
    expect(
      await screen.findByText(
        "Задания нет в очереди Windows. Это не подтверждает, что этикетка напечаталась.",
      ),
    ).toBeTruthy();
    expect(checkQueue).toHaveBeenCalledTimes(1);
    // The scan check is still the way to close the label.
    expect(screen.getByRole("button", { name: "Пропустить проверку" })).toBeTruthy();
  });

  it("is not offered for a RAW printer's label that waits for its scan", async () => {
    await mount({ job: { ...job, state: "sent", verify: true, errorCode: null, printer: ZEBRA } });
    expect(screen.queryByRole("button", { name: QUEUE })).toBeNull();
  });

  it("ignores a press that lands right after the panel changed its view, like every button of it", async () => {
    const clock = { now: 1_000 };
    const checkQueue = await mount({ clock: () => clock.now });
    // A view opens (the reasons) and closes again: the guard starts at the second change.
    fireEvent.click(screen.getByRole("button", { name: "Напечатать снова" }));
    clock.now = 2_000;
    fireEvent.click(await screen.findByRole("button", { name: "Назад" }));
    clock.now = 2_399;
    fireEvent.click(await screen.findByRole("button", { name: QUEUE }));
    expect(checkQueue).not.toHaveBeenCalled();
    clock.now = 2_400;
    fireEvent.click(screen.getByRole("button", { name: QUEUE }));
    await waitFor(() => expect(checkQueue).toHaveBeenCalledTimes(1));
  });

  it("names a driver printer in words in the list of printers to choose from", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Другой принтер" }));
    expect(
      await screen.findByRole("button", {
        name: "Godex через драйвер · Драйвер Windows · 203 dpi",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zebra у линии · ZPL · 203 dpi" })).toBeTruthy();
  });

  it("does nothing while a decision runs", async () => {
    const checkQueue = await mount({ busy: true });
    const button = screen.getByRole("button", { name: QUEUE });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(checkQueue).not.toHaveBeenCalled();
  });
});

describe("the workstation setup's driver controls", () => {
  const USB = [{ name: "Godex G500", port: "USB001" }];

  function setup(args: {
    local: ReturnType<typeof openLocalDb>["executor"];
    shell: ReturnType<typeof fakeHardware>;
    printing: PrintRuntime;
    renderLabel?: typeof fakeRender;
  }) {
    const ui = (printing: PrintRuntime) => (
      <ThemeProvider>
        <WorkstationSetup
          local={args.local}
          hardware={args.shell.hardware}
          printing={printing}
          source={source}
          render={args.renderLabel ?? fakeRender}
          onSaved={() => undefined}
          onBack={() => undefined}
        />
      </ThemeProvider>
    );
    const view = render(ui(args.printing));
    return { rerenderWith: (printing: PrintRuntime) => view.rerender(ui(printing)) };
  }

  it("offers the way of printing only for a Windows queue, never for a COM port", async () => {
    const { executor } = openLocalDb();
    const shell = fakeHardware();
    const printing = createPrintRuntime(shell.hardware.printBytes, { windows: windows(true) });
    setup({ local: executor, shell, printing });
    await screen.findByRole("heading", { name: "Принтеры" });
    fireEvent.click(screen.getByRole("button", { name: "Добавить принтер" }));
    await waitFor(() => expect(printing.supportsWindowsDriver).toBeDefined());
    type("Подключение", "serial");
    expect(screen.queryByLabelText("Способ печати")).toBeNull();
    type("Подключение", "usb");
    // The shell's answer arrives after the form opened: wait for it.
    expect(await screen.findByLabelText("Способ печати")).toBeTruthy();
    const options = choicesOf("Способ печати");
    expect(options).toContain("На языке принтера (ZPL / TSPL)");
    expect(options).toContain("Через драйвер Windows");
    setField("Способ печати", "windows_driver");
    expect(screen.queryByLabelText("Язык принтера")).toBeNull();
    // The way of printing is a Windows queue's: a COM port keeps its language, and no driver hint.
    type("Подключение", "serial");
    expect(screen.queryByLabelText("Способ печати")).toBeNull();
    expect(screen.getByLabelText("Язык принтера")).toBeTruthy();
    expect(screen.queryByText(/Размер бумаги и разрешение в драйвере/)).toBeNull();
  });

  it("lets a profile already in driver mode go back to RAW where the shell cannot print through Windows", async () => {
    const { executor } = openLocalDb();
    const shell = fakeHardware();
    await setUpPrinting(executor, {
      printers: [GODEX],
      assignments: { box: "godex", pallet: null, duplicate: null },
    });
    const printing = createPrintRuntime(shell.hardware.printBytes, { windows: windows(false) });
    setup({ local: executor, shell, printing });
    fireEvent.click(
      await screen.findByRole("button", { name: "Изменить принтер «Godex через драйвер»" }),
    );
    const mode = await screen.findByLabelText("Способ печати");
    expect(mode.textContent).toBe("Через драйвер Windows");
    expect(screen.queryByLabelText("Язык принтера")).toBeNull();
    setField("Способ печати", "raw");
    expect(screen.getByLabelText("Язык принтера")).toBeTruthy();
    expect(screen.queryByText(/Размер бумаги и разрешение в драйвере/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(screen.getByText("Принтер Windows: Godex G500 · ZPL · 203 dpi")).toBeTruthy();
  });

  it("asks the shell again for a new print runtime and drops the answer of an old one", async () => {
    const { executor } = openLocalDb();
    const shell = fakeHardware();
    vi.mocked(shell.hardware.listUsbPrinters).mockResolvedValue(USB);
    let late: (supported: boolean) => void = () => undefined;
    const slow = windows(true);
    vi.mocked(slow.supportsWindowsPrinting).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          late = resolve;
        }),
    );
    const view = setup({
      local: executor,
      shell,
      printing: createPrintRuntime(shell.hardware.printBytes, { windows: slow }),
    });
    // The runtime is replaced before the first answer comes: only the new one is heard.
    view.rerenderWith(createPrintRuntime(shell.hardware.printBytes, { windows: windows(false) }));
    await act(async () => {
      late(true);
    });
    await screen.findByRole("heading", { name: "Принтеры" });
    fireEvent.click(screen.getByRole("button", { name: "Добавить принтер" }));
    type("Подключение", "usb");
    await usbListed();
    expect(screen.queryByLabelText("Способ печати")).toBeNull();
    // And a runtime of the shell that can print through Windows is asked, too.
    view.rerenderWith(createPrintRuntime(shell.hardware.printBytes, { windows: windows(true) }));
    expect(await screen.findByLabelText("Способ печати")).toBeTruthy();
  });

  describe("the test print", () => {
    async function open(sendAnswer?: (queue: string, name: string) => Promise<PrintResult>) {
      const { executor } = openLocalDb();
      const shell = fakeHardware();
      await setUpPrinting(executor, {
        printers: [GODEX, ZEBRA],
        assignments: { box: "godex", pallet: null, duplicate: null },
      });
      const shellWindows = windows(true);
      if (sendAnswer !== undefined) {
        vi.mocked(shellWindows.printWindowsRaster).mockImplementation(async (queue, _bytes, name) =>
          sendAnswer(queue, name),
        );
      }
      const rendered: Parameters<typeof fakeRender>[2][] = [];
      const renderLabel: typeof fakeRender = async (spec, fields, printer) => {
        rendered.push(printer);
        return fakeRender(spec, fields, printer);
      };
      setup({
        local: executor,
        shell,
        printing: createPrintRuntime(shell.hardware.printBytes, { windows: shellWindows }),
        renderLabel,
      });
      await screen.findByRole("heading", { name: "Принтеры" });
      return { shell, shellWindows, rendered };
    }

    it("goes through the Windows driver for a driver printer, once, and waits for its code", async () => {
      const { shell, shellWindows, rendered } = await open();
      fireEvent.click(
        screen.getByRole("button", { name: "Пробная печать на «Godex через драйвер»" }),
      );
      expect(
        await screen.findByText(/Пробная этикетка ушла на «Godex через драйвер»/),
      ).toBeTruthy();
      expect(shellWindows.printWindowsRaster).toHaveBeenCalledTimes(1);
      const call = vi.mocked(shellWindows.printWindowsRaster).mock.calls[0];
      expect(call?.[0]).toBe("Godex G500");
      expect(call?.[2]).toMatch(/^Markiro:[0-9a-f-]{36}$/);
      expect(shell.hardware.printBytes).not.toHaveBeenCalled();
      expect(rendered[0]?.mode).toBe("windows_driver");
    });

    it("keeps a RAW printer's test print on the printer's language", async () => {
      const { shell, shellWindows } = await open();
      fireEvent.click(screen.getByRole("button", { name: "Пробная печать на «Zebra у линии»" }));
      expect(await screen.findByText(/Пробная этикетка ушла на «Zebra у линии»/)).toBeTruthy();
      expect(shell.hardware.printBytes).toHaveBeenCalledTimes(1);
      expect(shellWindows.printWindowsRaster).not.toHaveBeenCalled();
    });

    it("says an unknown outcome in the driver's own words and never sends it again by itself", async () => {
      const { shellWindows } = await open(async () => ({ sent: false, code: "driver_unknown" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Пробная печать на «Godex через драйвер»" }),
      );
      expect(
        await screen.findByText(/Неизвестно, напечаталась ли пробная этикетка\./),
      ).toBeTruthy();
      expect(screen.getByText(/Windows не подтвердил задание до конца/)).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(shellWindows.printWindowsRaster).toHaveBeenCalledTimes(1);
    });

    it("says a refusal before the start as a label that was not printed", async () => {
      await open(async () => ({ sent: false, code: "geometry_mismatch" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Пробная печать на «Godex через драйвер»" }),
      );
      expect(await screen.findByText(/Пробная этикетка не напечатана\./)).toBeTruthy();
      expect(screen.getByText(/Размер бумаги или разрешение в драйвере Windows/)).toBeTruthy();
    });

    it("sends one test label at a time: a second press while it is on its way does nothing", async () => {
      let release: (result: PrintResult) => void = () => undefined;
      const { shellWindows } = await open(
        () =>
          new Promise<PrintResult>((resolve) => {
            release = resolve;
          }),
      );
      const button = screen.getByRole("button", {
        name: "Пробная печать на «Godex через драйвер»",
      });
      fireEvent.click(button);
      expect(await screen.findByText("Пробная этикетка отправляется…")).toBeTruthy();
      expect(button.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(button);
      expect(shellWindows.printWindowsRaster).toHaveBeenCalledTimes(1);
      await act(async () => {
        release({ sent: true });
      });
    });
  });
});

describe("the work screen with a label that went through the Windows driver", () => {
  const GODEX_BOX = {
    printers: [GODEX, ZEBRA],
    assignments: { box: "godex", pallet: null, duplicate: null },
  };

  async function fillBox(work: ReturnType<typeof renderWork>): Promise<void> {
    await work.scanner.listening();
    await work.settled();
    for (let index = 0; index < 12; index += 1) await work.scan(km(`P${index}`));
  }

  it("asks the Windows queue about the job it stopped for, and about no other", async () => {
    const at = await printStation(GODEX_BOX);
    const shell = fakeHardware();
    const shellWindows = windows(true);
    vi.mocked(shellWindows.printWindowsRaster).mockImplementation(
      async (queue, _bytes, documentName): Promise<PrintResult> => ({
        sent: false,
        code: "driver_unknown",
        receipt: { queue, jobId: 5, documentName },
      }),
    );
    vi.mocked(shellWindows.getWindowsPrintJob).mockResolvedValue({
      state: "present",
      statusFlags: 0,
    });
    const printing = createPrintRuntime(shell.hardware.printBytes, { windows: shellWindows });
    const work = renderWork(at, { shell, runtime: printing });
    await fillBox(work);
    expect(screen.getByText("Неизвестно, напечаталась ли этикетка")).toBeTruthy();
    expect(screen.getByText(/Windows не подтвердил задание до конца/)).toBeTruthy();
    expect(shell.sends).toHaveLength(0);
    await work.press("Проверить очередь Windows");
    expect(
      await screen.findByText(
        "Задание находится в очереди Windows: этикетка ещё может напечататься.",
      ),
    ).toBeTruthy();
    // The spooler was asked for the receipt of this job's own send, and nothing was printed again.
    expect(shellWindows.getWindowsPrintJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(shellWindows.getWindowsPrintJob).mock.calls[0]?.[0]).toMatchObject({
      queue: "Godex G500",
      jobId: 5,
    });
    expect(shellWindows.printWindowsRaster).toHaveBeenCalledTimes(1);
  });

  it("names the driver printer on the confirmation of a box reprint", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work);
    await setUpPrinting(at.local, GODEX_BOX);
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Перепечатать этикетку" });
    await work.press("Перепечатать этикетку");
    await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
    await work.press("Замятие в принтере");
    expect(
      await screen.findByText(
        "Печать пойдёт на принтер: Godex через драйвер · Драйвер Windows · 203 dpi.",
      ),
    ).toBeTruthy();
  });
});
