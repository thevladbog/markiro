import { readFileSync } from "node:fs";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { closeShift } from "../src/floor/close/shift-close.js";
import {
  DEFAULT_WORKSTATION_SETTINGS,
  saveWorkstationSettings,
  type PrinterProfile,
} from "../src/floor/setup/workstation-settings.js";
import type { WorkShift } from "../src/floor/shifts/shift-copies.js";
import type { RenderUnitLabel } from "../src/floor/unit-labels/unit-label-render.js";
import { processScan } from "../src/floor/work/scan-pipeline.js";
import { enteredShiftSchema, type EnteredShift } from "../src/host/protocol.js";
import { STATION_SHIFT_ENTER } from "../src/host/requests.js";
import type { LocalExecutor, LocalStatement } from "../src/local/executor.js";
import { fakeHardware } from "./support/hardware.js";
import { enteredShift, km, PAIRING, rows, scanContext } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { TSC, ZEBRA } from "./support/printing.js";
import { lastLine, renderWork, SESSION, type WorkHarness } from "./support/work-screen.js";

/*
 * The station's screen of a validation shift that prints the Data Matrix duplicate (plan РЕЖ,
 * task B6): the label panel beside the validation panel, the window of the printed label's check
 * (the cloud's `ProductLabelVerification`), its reprint with a reason, «История этикеток» in place
 * of «Исключения», a label left unresolved opened on entry, and the close refused while a label of
 * the shift is unresolved. The texts are the cloud station's `productLabels.*`.
 */

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const PRINTING: EnteredShift = enteredShiftSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../proto/fixtures/device-shift-entered-validation-print.json", testModuleUrl),
      "utf8",
    ),
  ),
);
const OTHER_SHIFT_ID = "7b2e4f6a-9c1d-4e8f-a0b2-c4d6e8f0a1b3";

/** The printing shift with its check `verification`. */
function printing(verification: "none" | "required", id = PRINTING.id): EnteredShift {
  const frozen = PRINTING.snapshot.validationPrint;
  if (frozen === undefined || PRINTING.validationPrint?.mode !== "duplicate_dm") {
    throw new Error("the fixture prints no duplicate");
  }
  return enteredShiftSchema.parse({
    ...PRINTING,
    id,
    number: id === PRINTING.id ? PRINTING.number : "OCT26-007",
    validationPrint: { ...PRINTING.validationPrint, verification },
    snapshot: { ...PRINTING.snapshot, validationPrint: { ...frozen, verification } },
  });
}

/** A unit label's bytes as plain text: the printer and the quantity, never the code. */
const unitRender: RenderUnitLabel = async (_spec, fields, printer) => {
  const text = `DUP ${printer.language} ${printer.dpi} ${fields["qty"] ?? ""}`;
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
};

async function assign(local: LocalExecutor, duplicate: PrinterProfile | null): Promise<void> {
  await saveWorkstationSettings(local, {
    ...DEFAULT_WORKSTATION_SETTINGS,
    printers: [ZEBRA, TSC],
    assignments: { box: null, pallet: null, duplicate: duplicate?.id ?? null },
  });
}

async function station(
  options: { verification?: "none" | "required"; printer?: PrinterProfile | null } = {},
) {
  const { db, executor } = openLocalDb();
  await assign(executor, options.printer === undefined ? ZEBRA : options.printer);
  const shift = await enteredShift(executor, printing(options.verification ?? "required"));
  return { db, local: executor, shift };
}

type Station = Awaited<ReturnType<typeof station>>;

function open(
  at: { local: LocalExecutor; shift: WorkShift },
  options: Parameters<typeof renderWork>[1] = {},
): WorkHarness {
  return renderWork(at, {
    ...options,
    overrides: { unitLabelRender: unitRender, ...options.overrides },
  });
}

async function ready(work: WorkHarness): Promise<void> {
  await work.scanner.listening();
  await work.settled();
}

/** Accepts `raw` as a unit with its label outside the screen (an earlier run of the app). */
async function acceptedBefore(at: { local: LocalExecutor; shift: WorkShift }, raw: string) {
  const outcome = await processScan(
    scanContext(at.local, at.shift, {
      unitLabel: { operatorName: SESSION.name, render: unitRender },
    }),
    raw,
  );
  if (outcome.kind !== "accepted" || outcome.boxId !== null || outcome.label === undefined) {
    throw new Error("the unit was not accepted with its label");
  }
  return outcome.label;
}

function jobs(at: Station) {
  return rows(
    at.db,
    "SELECT shift_id, attempt_no, attempt_state, verification, reason, error_code " +
      "FROM floor_unit_labels ORDER BY rowid",
  );
}

function unitPanel() {
  return within(screen.getByRole("region", { name: "Дубликат Data Matrix" }));
}

/** What the label panel says of the current label. */
function panelState(): string | null {
  return unitPanel().getByRole("status").textContent;
}

function windowOf(name: string): HTMLElement {
  return screen.getByRole("dialog", { name });
}

/**
 * The window the entry opens: the entry's reads may land after the harness's turn (as in
 * `test/validation-screen.test.tsx`), so its render is waited for.
 */
function entryWindow(name: string): Promise<HTMLElement> {
  return screen.findByRole("dialog", { name });
}

function noWindow(): void {
  expect(screen.queryByRole("dialog")).toBeNull();
}

/** The buttons of the open window, in order. */
function windowButtons(dialog: HTMLElement): string[] {
  return within(dialog)
    .getAllByRole("button")
    .map((button) => button.textContent ?? "");
}

const SCAN_TITLE = "Отсканируйте напечатанную этикетку";

describe("the label panel of a shift that prints the duplicate", () => {
  it("says the frozen check before the first scan, with no job yet", async () => {
    for (const [verification, hint] of [
      ["required", "Следующая единица доступна после проверки напечатанной этикетки."],
      [
        "none",
        "Проверка этикетки выключена. После отправки на принтер можно сканировать следующую единицу.",
      ],
    ] as const) {
      const at = await station({ verification });
      const work = open(at);
      await ready(work);
      expect(panelState()).toBe("Ожидание сканирования");
      expect(unitPanel().getByText(hint)).toBeTruthy();
      noWindow();
      work.view.unmount();
    }
  });

  it("puts «История этикеток» in place of «Исключения», as a floor button", async () => {
    const at = await station();
    const work = open(at);
    await ready(work);
    expect(screen.queryByRole("button", { name: "Исключения" })).toBeNull();
    expect(screen.getByRole("button", { name: "История этикеток" }).className).toContain(
      "mk-btn--floor",
    );
    expect(document.querySelector(".work-footer")?.getAttribute("aria-label")).toBe(
      "История этикеток, выход из смены, закрытие смены",
    );
  });

  it("sends the label of an accepted unit and goes on without a check under none", async () => {
    const at = await station({ verification: "none" });
    const work = open(at);
    await ready(work);
    await work.scan(km("N1", { tail: "Zf8K" }));
    expect(work.shell.sends.map((send) => send.text)).toEqual(["DUP zpl 203 1"]);
    noWindow();
    expect(panelState()).toContain("Отправлено на принтер");
    expect(lastLine()).toBe("Принят: в смене 1 шт.");
    await work.scan(km("N2", { tail: "Zf8K" }));
    expect(lastLine()).toBe("Принят: в смене 2 шт.");
    expect(jobs(at)).toEqual([
      expect.objectContaining({ attempt_state: "sent", verification: "not_required" }),
      expect.objectContaining({ attempt_state: "sent", verification: "not_required" }),
    ]);
  });
});

describe("the window of the printed label's check", () => {
  it("opens after a sent label under a required check and takes the label's scan", async () => {
    const at = await station();
    const work = open(at);
    await ready(work);
    const unit = km("R1", { tail: "Zf8K" });
    await work.scan(unit);
    const dialog = windowOf(SCAN_TITLE);
    expect(windowButtons(dialog)).toEqual(["Пауза", "Проблема с этикеткой", "Пропустить проверку"]);
    for (const button of within(dialog).getAllByRole("button")) {
      expect(button.className).toContain("mk-btn--floor");
    }
    expect(
      within(dialog).getByText("Пропуск сохранится в журнале. Этикетка останется непроверенной."),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Сканируйте Data Matrix на напечатанной этикетке."),
    ).toBeTruthy();
    // Another code is no label of this unit: said, and the check still waits.
    await work.scan(km("R2", { tail: "Zf8K" }));
    expect(within(windowOf(SCAN_TITLE)).getByText("Код не совпадает")).toBeTruthy();
    expect(work.props.signal).toHaveBeenLastCalledWith("error");
    // The label's own code checks it: the window closes, and the next unit is taken.
    await work.scan(unit);
    noWindow();
    expect(panelState()).toContain("Этикетка подтверждена");
    expect(jobs(at)).toEqual([
      expect.objectContaining({ attempt_state: "sent", verification: "verified" }),
    ]);
    await work.scan(km("R3", { tail: "Zf8K" }));
    expect(lastLine()).toBe("Принят: в смене 2 шт.");
    // The check took no unit: two codes, one journalled scan each.
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
  });

  it("skips the check after a sent label, saved as skipped", async () => {
    const at = await station();
    const work = open(at);
    await ready(work);
    await work.scan(km("S1", { tail: "Zf8K" }));
    await work.press("Пропустить проверку");
    noWindow();
    expect(panelState()).toContain("Проверка пропущена");
    expect(jobs(at)).toEqual([
      expect.objectContaining({ attempt_state: "sent", verification: "skipped" }),
    ]);
  });

  it("prints the label again with the reason the operator chose", async () => {
    const at = await station();
    const work = open(at);
    await ready(work);
    await work.scan(km("P1", { tail: "Zf8K" }));
    await work.press("Проблема с этикеткой");
    const reasons = windowOf("Повторная печать этикетки");
    expect(within(reasons).getByText("Укажите причину повторной печати")).toBeTruthy();
    expect(windowButtons(reasons)).toEqual([
      "Этикетка не напечатана",
      "Этикетка повреждена",
      "Этикетка потеряна",
      "Назад",
      "Напечатать повторно",
    ]);
    // Nothing is printed before a reason is chosen.
    const confirm = within(reasons).getByRole("button", { name: "Напечатать повторно" });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await work.press("Напечатать повторно");
    expect(work.shell.sends).toHaveLength(1);
    await work.press("Этикетка повреждена");
    expect(
      within(windowOf("Повторная печать этикетки"))
        .getByRole("button", { name: "Этикетка повреждена" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await work.press("Напечатать повторно");
    expect(work.shell.sends.map((send) => send.text)).toEqual(["DUP zpl 203 1", "DUP zpl 203 1"]);
    expect(jobs(at)).toEqual([
      expect.objectContaining({
        attempt_no: 2,
        attempt_state: "sent",
        verification: "pending",
        reason: "damaged",
      }),
    ]);
    // The new label waits for its check again.
    expect(windowOf(SCAN_TITLE)).toBeTruthy();
  });

  it("goes back from the reasons without printing", async () => {
    const at = await station();
    const work = open(at);
    await ready(work);
    await work.scan(km("B1", { tail: "Zf8K" }));
    await work.press("Проблема с этикеткой");
    await work.press("Назад");
    expect(windowOf(SCAN_TITLE)).toBeTruthy();
    expect(work.shell.sends).toHaveLength(1);
  });

  it("says an unknown outcome, offers a reprint and no skip, and a scan of the label settles it", async () => {
    const at = await station();
    const shell = fakeHardware(async () => ({ sent: false, code: "outcome_unknown" as const }));
    const work = open(at, { shell });
    await ready(work);
    const unit = km("U1", { tail: "Zf8K" });
    await work.scan(unit);
    const dialog = windowOf("Печать требует уточнения");
    expect(windowButtons(dialog)).toEqual(["Пауза", "Напечатать повторно"]);
    expect(
      within(dialog).getByText(
        "Результат печати неизвестен. Сканируйте этикетку, если она вышла, или напечатайте повторно с указанием причины.",
      ),
    ).toBeTruthy();
    await work.scan(unit);
    noWindow();
    expect(jobs(at)).toEqual([
      expect.objectContaining({ attempt_state: "delivery_unknown", verification: "verified" }),
    ]);
  });

  it("refuses a new unit while the label waits, in words", async () => {
    const at = await station();
    const shell = fakeHardware(async () => ({ sent: false, code: "outcome_unknown" as const }));
    const work = open(at, { shell });
    await ready(work);
    await work.scan(km("W1", { tail: "Zf8K" }));
    // An unreadable code is no label: said in the window, and nothing is journalled.
    await work.scan("MRK-000742");
    expect(
      within(windowOf("Печать требует уточнения")).getByText(
        "Не удалось прочитать полный Data Matrix",
      ),
    ).toBeTruthy();
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 1 }]);
  });

  it("says a unit refused by its label, nothing written and no window", async () => {
    const at = await station();
    const work = open(at, {
      overrides: {
        unitLabelRender: vi.fn<RenderUnitLabel>(async () => {
          throw new Error("raster too large");
        }),
      },
    });
    await ready(work);
    // A code without its crypto tail cannot be duplicated.
    await work.scan(`]d201${PRINTING.productGtin14}21NOTAIL`);
    expect(lastLine()).toBe("Не удалось прочитать полный Data Matrix");
    expect(work.props.signal).toHaveBeenLastCalledWith("error");
    // A label that does not render for the duplicate printer.
    await work.scan(km("RF1", { tail: "Zf8K" }));
    expect(lastLine()).toBe(
      "Этикетку не удалось подготовить для принтера дубликата. Код не принят.",
    );
    noWindow();
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 0 }]);
    expect(
      within(screen.getByRole("region", { name: "Проверка" }))
        .getAllByRole("listitem")
        .map((item) => item.querySelector(".work-validation__word")?.textContent),
    ).toEqual([
      "Этикетку не удалось подготовить для принтера дубликата. Код не принят.",
      "Не удалось прочитать полный Data Matrix",
    ]);
  });

  it("leaves the shift by «Пауза», the label kept for the next entry", async () => {
    const at = await station();
    const onLeave = vi.fn();
    const work = open(at, { onLeave });
    await ready(work);
    await work.scan(km("L1", { tail: "Zf8K" }));
    await work.press("Пауза");
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(jobs(at)).toEqual([expect.objectContaining({ verification: "pending" })]);
  });

  it("keeps «Пауза» on the keyboard while the leave waits, and a press then does nothing", async () => {
    const at = await station();
    const onLeave = vi.fn();
    const work = open(at, { onLeave });
    await ready(work);
    await work.scan(km("K1", { tail: "Zf8K" }));
    work.rerender({ leaving: true });
    const pause = within(windowOf(SCAN_TITLE)).getByRole("button", { name: "Пауза" });
    expect(pause.hasAttribute("disabled")).toBe(false);
    await work.press("Пауза");
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("keeps the focus in the window when its view changes under the pressed button", async () => {
    const at = await station();
    await acceptedBefore(at, km("V1", { tail: "Zf8K" }));
    const work = open(at);
    await ready(work);
    await entryWindow("Печать этикетки");
    // The operator's tap focuses the button, which the next view no longer has.
    const send = screen.getByRole("button", { name: "Отправить сохранённую этикетку" });
    await act(async () => {
      work.pause();
      send.focus();
      fireEvent.click(send);
      await work.gate.drain();
    });
    expect(send.isConnected).toBe(false);
    const dialog = windowOf(SCAN_TITLE);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("moves the focus into the window when it opens", async () => {
    const at = await station();
    const work = open(at);
    await ready(work);
    await work.scan(km("F1", { tail: "Zf8K" }));
    const dialog = windowOf(SCAN_TITLE);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });
});

describe("a label left unresolved, on entry", () => {
  it("opens the window of a prepared label at once and sends it only when asked", async () => {
    const at = await station();
    await acceptedBefore(at, km("E1", { tail: "Zf8K" }));
    const work = open(at);
    await ready(work);
    const dialog = await entryWindow("Печать этикетки");
    expect(
      within(dialog).getByText("Задание сохранено. Автоматическая повторная отправка выключена."),
    ).toBeTruthy();
    expect(work.shell.sends).toEqual([]);
    // A scan while the label waits for its send is no unit and no check: refused in words.
    await work.scan(km("E9", { tail: "Zf8K" }));
    expect(lastLine()).toBe(
      "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.",
    );
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 1 }]);
    await work.press("Отправить сохранённую этикетку");
    expect(work.shell.sends).toHaveLength(1);
    expect(windowOf(SCAN_TITLE)).toBeTruthy();
  });

  it("makes a send the app lost unknown and sends nothing", async () => {
    const at = await station();
    await acceptedBefore(at, km("E2", { tail: "Zf8K" }));
    at.db.prepare("UPDATE floor_unit_labels SET attempt_state = 'sending'").run();
    const work = open(at);
    await ready(work);
    expect(await entryWindow("Печать требует уточнения")).toBeTruthy();
    expect(work.shell.sends).toEqual([]);
    expect(jobs(at)).toEqual([
      expect.objectContaining({ attempt_state: "delivery_unknown", error_code: "interrupted" }),
    ]);
  });

  it("says another shift's label and takes no unit", async () => {
    const at = await station();
    const other = await enteredShift(at.local, printing("required", OTHER_SHIFT_ID));
    await acceptedBefore({ local: at.local, shift: other }, km("O1", { tail: "Zf8K" }));
    const work = open(at);
    await ready(work);
    const dialog = await entryWindow("Дубликат Data Matrix");
    expect(
      within(dialog).getByText(
        "На станции осталась незавершённая этикетка другой смены. Вернитесь к выбору смены.",
      ),
    ).toBeTruthy();
    await work.scan(km("O2", { tail: "Zf8K" }));
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_scans WHERE shift_id = ?", at.shift.copy.id),
    ).toEqual([{ n: 0 }]);
    expect(work.shell.sends).toEqual([]);
  });

  it("finishes the label in a shift the office closed: the check, but no skip and no new unit", async () => {
    const at = await station();
    const work = open(at);
    await ready(work);
    const unit = km("C1", { tail: "Zf8K" });
    await work.scan(unit);
    work.view.unmount();
    const again = open(at, { overrides: { officeClosed: true } });
    await ready(again);
    const dialog = await entryWindow(SCAN_TITLE);
    expect(windowButtons(dialog)).toEqual(["Пауза", "Проблема с этикеткой"]);
    expect(
      within(dialog).getByText(
        "Смена закрыта. Завершите работу с этой этикеткой; приём новой продукции недоступен.",
      ),
    ).toBeTruthy();
    await again.scan(unit);
    noWindow();
    await again.scan(km("C2", { tail: "Zf8K" }));
    expect(lastLine()).toBe("Скан не принят: смену закрыли в офисе.");
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 1 }]);
  });
});

describe("the duplicate printer", () => {
  it("is asked for on entry when none is assigned, and leads to the workstation", async () => {
    const at = await station({ printer: null });
    const onSetup = vi.fn();
    const work = open(at, { overrides: { onSetup } });
    await ready(work);
    const dialog = await entryWindow("Настройки принтера");
    expect(windowButtons(dialog)).toEqual(["Пауза", "Повторить", "Настройки принтера"]);
    await work.scan(km("X1", { tail: "Zf8K" }));
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 0 }]);
    await work.press("Настройки принтера");
    expect(onSetup).toHaveBeenCalledTimes(1);
    // Assigned meanwhile: «Повторить» lets the work go on.
    await assign(at.local, ZEBRA);
    await work.press("Повторить");
    noWindow();
    await work.scan(km("X2", { tail: "Zf8K" }));
    expect(work.shell.sends).toHaveLength(1);
  });

  it("says a label not sent when the printer changed, with the workstation and a reprint", async () => {
    const at = await station();
    await acceptedBefore(at, km("T1", { tail: "Zf8K" }));
    await assign(at.local, TSC);
    const onSetup = vi.fn();
    const work = open(at, { overrides: { onSetup } });
    await ready(work);
    await entryWindow("Печать этикетки");
    await work.press("Отправить сохранённую этикетку");
    const dialog = windowOf("Этикетка не отправлена");
    expect(windowButtons(dialog)).toEqual(["Пауза", "Напечатать повторно", "Настройки принтера"]);
    expect(
      within(dialog).getByText(
        "Проверьте подключение, язык и разрешение принтера, затем повторите печать.",
      ),
    ).toBeTruthy();
    expect(work.shell.sends).toEqual([]);
  });
});

describe("«История этикеток»", () => {
  it("says there is none yet", async () => {
    const at = await station();
    const work = open(at);
    await ready(work);
    await work.press("История этикеток");
    expect(screen.getByRole("heading", { name: "История этикеток" })).toBeTruthy();
    expect(screen.getByText("В этой смене ещё нет напечатанных этикеток.")).toBeTruthy();
    await work.press("Назад");
    expect(screen.queryByRole("heading", { name: "История этикеток" })).toBeNull();
    expect(screen.getByRole("button", { name: "История этикеток" })).toBe(document.activeElement);
  });

  it("lists the shift's labels with their attempts and prints one again with a reason", async () => {
    const at = await station({ verification: "none" });
    const work = open(at);
    await ready(work);
    await work.scan(km("H00001", { tail: "Zf8K" }));
    await work.scan(km("H00002", { tail: "Zf8K" }));
    await work.press("История этикеток");
    const history = within(screen.getByRole("region", { name: "История этикеток" }));
    const items = history.getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("code")?.textContent)).toEqual([
      "…H00002",
      "…H00001",
    ]);
    expect(items[0]?.textContent).toContain("Отправлено на принтер · Попытка 1");
    // A scan while the history is open is not taken.
    await work.scan(km("H00003", { tail: "Zf8K" }));
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
    const second = items[1];
    if (second === undefined) throw new Error("no second row");
    await act(async () => {
      work.pause();
      fireEvent.click(within(second).getByRole("button", { name: "Напечатать повторно" }));
      await work.gate.drain();
    });
    await work.press("Этикетка потеряна");
    await work.press("Напечатать повторно");
    expect(work.shell.sends).toHaveLength(3);
    expect(jobs(at)[0]).toEqual(
      expect.objectContaining({ attempt_no: 2, reason: "lost", attempt_state: "sent" }),
    );
    // Back at the work: the history closed with the reprint.
    expect(screen.queryByRole("region", { name: "История этикеток" })).toBeNull();
  });
});

describe("the close of a shift with an unresolved label", () => {
  it("is refused with the cloud's words and leads to the label", async () => {
    const at = await station();
    const work = open(at);
    await ready(work);
    await work.press("Закрыть смену");
    await screen.findByRole("region", { name: "Закрытие смены OCT26-006" });
    // A label of the shift became unresolved after the summary was read (an earlier run's).
    await act(async () => {
      await acceptedBefore(at, km("Z1", { tail: "Zf8K" }));
    });
    await work.press("Недостаток сырья");
    await work.press("Подтвердить закрытие");
    expect(
      await screen.findByText("Сначала завершите сохранённые задания печати этой смены."),
    ).toBeTruthy();
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'shift_closed'")).toEqual([
      { n: 0 },
    ]);
    await work.press("Перейти к этикетке");
    await waitFor(() => expect(windowOf("Печать этикетки")).toBeTruthy());
  });

  it("is refused by the close's own write when the label comes after its read", async () => {
    const at = await station({ verification: "none" });
    const shift = at.shift;
    // A label the printer took: resolved, the shift could close.
    await acceptedBefore(at, km("G1", { tail: "Zf8K" }));
    at.db.prepare("UPDATE floor_unit_labels SET attempt_state = 'sent'").run();
    let injected = false;
    // Between the close's read of the summary and its transaction the label becomes unresolved
    // (its outcome unknown) and nothing else changes: no code, no box, no plan.
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: async (statements: readonly LocalStatement[]) => {
        if (!injected && statements.some((s) => s.sql.includes("SET local_state = 'closing'"))) {
          injected = true;
          at.db
            .prepare(
              "UPDATE floor_unit_labels SET attempt_state = 'delivery_unknown', " +
                "error_code = 'interrupted'",
            )
            .run();
        }
        return at.local.transaction(statements);
      },
    };
    const context = (executor: LocalExecutor) => ({
      local: executor,
      pairing: PAIRING,
      shift,
      operatorId: SESSION.id,
      now: () => new Date("2026-10-08T09:00:00.000Z"),
      newId: () => crypto.randomUUID(),
    });
    const result = await closeShift(context(local), "material_shortage");
    expect(injected).toBe(true);
    expect(result).toEqual({ kind: "stale" });
    expect(rows(at.db, "SELECT local_state FROM floor_shifts")).toEqual([{ local_state: null }]);
    expect(rows(at.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'shift_closed'")).toEqual([
      { n: 0 },
    ]);
    // Read again, the summary names the label.
    expect(await closeShift(context(at.local), "material_shortage")).toEqual({
      kind: "blocked",
      blocker: { kind: "label_unresolved" },
    });
  });
});

describe("the entry", () => {
  it("names the duplicate print among what this station works", () => {
    expect(STATION_SHIFT_ENTER).toEqual({
      supports: ["validation-v1", "validation-dm-duplicate-v1"],
    });
  });
});
