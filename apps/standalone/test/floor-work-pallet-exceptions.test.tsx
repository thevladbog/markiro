import { buildSscc, formatSsccHri } from "@markiro/domain";
import { act, fireEvent, render, screen, within, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  boxesByTail,
  ExceptionFlow,
  MAX_LISTED_BOXES,
  type BoxScanVerdict,
  type ExceptionFlowProps,
  type ExceptionOutcome,
} from "../src/floor/exceptions/ExceptionFlow.js";
import type { ClosedPallet } from "../src/floor/exceptions/pallet-exceptions.js";
import { PALLET_EXTENSION } from "../src/floor/pallets/pallets.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { failingWrites, holdingWrites, km, PREFIX, rows } from "./support/floor-work.js";
import { palletStation, type PalletStation } from "./support/pallets.js";
import { printingSettings, printStation, renderedText, TSC, ZEBRA } from "./support/printing.js";
import { lastLine, PRESS_PAUSE_MS, renderWork } from "./support/work-screen.js";

const FIRST_PALLET = buildSscc(PALLET_EXTENSION, PREFIX, 0);
const SECOND_PALLET = buildSscc(PALLET_EXTENSION, PREFIX, 1);
const FIRST_BOX = buildSscc(0, PREFIX, 1500);
const PAUSED = "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.";
const STALE = "Пока вы выбирали, паллета изменилась. Ничего не сделано — повторите.";
const GONE = "Этой паллеты больше нет среди закрытых паллет смены. Ничего не сделано.";
const WAITING = "Этикетка этой паллеты ещё ждёт решения на рабочем экране. Ничего не сделано.";
const FAILED =
  "Не удалось записать исключение на этом компьютере. Возможно, оно всё же записалось: проверьте исключения и числа смены, прежде чем повторять.";

const option = (sscc: string, boxes = 1) => `${formatSsccHri(sscc)} · коробов: ${boxes}`;

function palletExceptions(at: PalletStation) {
  return rows(
    at.db,
    "SELECT kind, reason_code, reason_text FROM floor_pallet_exceptions ORDER BY occurred_at",
  );
}

function outboxKinds(at: PalletStation): unknown[] {
  return rows(at.db, "SELECT kind FROM outbox WHERE kind <> 'scan' ORDER BY seq").map(
    (row) => row["kind"],
  );
}

function disassembledPallets(at: PalletStation): unknown {
  return rows(
    at.db,
    "SELECT count(*) AS n FROM floor_pallets WHERE disassembled_at IS NOT NULL",
  )[0]?.["n"];
}

/** A click that is not a press of the harness: the clock stays where it is. */
function tap(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

type Work = ReturnType<typeof renderWork>;

/** A shift of one code to a box and one box to a pallet: each scan closes a box and its pallet. */
async function pallets(at: PalletStation, codes: readonly string[]): Promise<Work> {
  const work = renderWork(at);
  await work.scanner.listening();
  await work.settled();
  for (const code of codes) await work.scan(km(code));
  return work;
}

async function openExceptions(work: Work): Promise<void> {
  await work.press("Исключения");
  await screen.findByRole("button", { name: "Расформировать паллету" });
}

async function twoPallets(at: PalletStation): Promise<Work> {
  const work = await pallets(at, ["A1", "A2"]);
  await openExceptions(work);
  return work;
}

async function onePallet(at: PalletStation): Promise<Work> {
  const work = await pallets(at, ["A1"]);
  await openExceptions(work);
  return work;
}

/** The label job of the pallet `sscc` waits at the printer, though the screen shows no stop. */
function failPalletLabel(at: PalletStation, sscc: string): void {
  at.db.exec(
    "UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent' WHERE sscc = '" +
      sscc +
      "'",
  );
}

describe("the exceptions of a pallet on the work screen (plan ПЛ-Ц)", () => {
  it("takes apart a pallet chosen by a scan of its label, with a reason; its boxes stay closed", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await twoPallets(at);
    await work.press("Расформировать паллету");
    expect(screen.getByText("Какую паллету расформировать?")).toBeTruthy();
    await work.scan(km("A9"));
    expect(screen.getByText("Это не код SSCC. Отсканируйте этикетку паллеты.")).toBeTruthy();
    await work.scan(`]C100${FIRST_BOX}`);
    expect(screen.getByText("Паллеты с этим SSCC нет среди закрытых паллет смены.")).toBeTruthy();
    // The flash of the scan is neutral: the subject may be a pallet, and the box is no pallet.
    expect(screen.getByText("НЕ НАЙДЕНО СРЕДИ ЗАКРЫТЫХ")).toBeTruthy();
    await work.scan(`]C100${FIRST_PALLET}`);
    expect(screen.getByText(`Паллета ${formatSsccHri(FIRST_PALLET)}`)).toBeTruthy();
    await work.press("Не тот товар");
    expect(screen.getByText("Расформировать паллету?")).toBeTruthy();
    await work.press("Расформировать");
    expect(
      await screen.findByText("Паллета расформирована, её короба остались закрытыми."),
    ).toBeTruthy();
    expect(palletExceptions(at)).toEqual([
      { kind: "disassemble", reason_code: "wrong_product", reason_text: null },
    ]);
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE disassembled_at IS NULL"),
    ).toEqual([{ n: 2 }]);
    expect(
      rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE pallet_id IS NOT NULL"),
    ).toEqual([{ n: 2 }]);
    // The scans of the choice were never journalled.
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 2 }]);
    // The host is told: a fact of the pallet, once, after the two pallets and their boxes.
    expect(outboxKinds(at).at(-1)).toBe("pallet_exception");
    expect(work.props.onRecorded).toHaveBeenCalled();
    // The pallet taken apart is not among the closed ones any more.
    await work.press("Другое действие");
    await work.press("Расформировать паллету");
    expect(screen.queryByRole("button", { name: option(FIRST_PALLET) })).toBeNull();
    expect(screen.getByRole("button", { name: option(SECOND_PALLET) })).toBeTruthy();
  });

  it("prints a pallet's label again, chosen by the last digits of its SSCC", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await twoPallets(at);
    await work.press("Перепечатать этикетку паллеты");
    expect(screen.getByRole("button", { name: option(SECOND_PALLET) })).toBeTruthy();
    const pad = within(screen.getByRole("group", { name: "Последние цифры SSCC" }));
    work.pause();
    for (const digit of FIRST_PALLET.slice(-2)) {
      fireEvent.click(pad.getByRole("button", { name: digit }));
    }
    // Both digits were taken, though the operator did not pause between them.
    expect(screen.getByText(`Последние цифры SSCC: ${FIRST_PALLET.slice(-2)}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: option(SECOND_PALLET) })).toBeNull();
    await work.press(option(FIRST_PALLET));
    await work.press("Замятие в принтере");
    expect(screen.getByText("Перепечатать этикетку паллеты?")).toBeTruthy();
    await work.press("Перепечатать");
    expect(await screen.findByText("Этикетка паллеты отправлена на принтер.")).toBeTruthy();
    expect(work.shell.sends.at(-1)).toEqual({
      target: ZEBRA.target,
      text: renderedText(ZEBRA, FIRST_PALLET, "100x150"),
    });
    expect(palletExceptions(at)).toEqual([
      { kind: "reprint", reason_code: "printer_jam", reason_text: null },
    ]);
  });

  it("offers no pallet's exception in a shift without pallets", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    expect(screen.queryByRole("button", { name: "Перепечатать этикетку паллеты" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Расформировать паллету" })).toBeNull();
  });

  it("offers a pallet's exceptions disabled while no pallet is closed, and the box's own as before", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = await pallets(at, ["A1"]);
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать паллету" });
    // One box on an open pallet: no closed pallet yet, a closed box.
    expect(
      screen.getByRole("button", { name: "Расформировать паллету" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Перепечатать этикетку паллеты" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Расформировать короб" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.queryByText(/Сейчас исключений нет/)).toBeNull();
  });
});

describe("the choice of the pallet never acts on a guess", () => {
  it("lists every pallet that ends with the digits, and acts on none until one is pressed", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const codes = Array.from({ length: 11 }, (_, index) => `C${index}`);
    const work = await pallets(at, codes);
    await openExceptions(work);
    await work.press("Расформировать паллету");
    const sscc = Array.from({ length: 11 }, (_, serial) =>
      buildSscc(PALLET_EXTENSION, PREFIX, serial),
    );
    // Eleven pallets, ten digits: two of them end with the same digit.
    const digit = sscc
      .map((each) => each.slice(-1))
      .find((last, index, all) => all.indexOf(last) !== index);
    if (digit === undefined) throw new Error("no two pallets share a last digit");
    const same = sscc.filter((each) => each.endsWith(digit));
    expect(same.length).toBeGreaterThanOrEqual(2);
    work.pause();
    fireEvent.click(
      within(screen.getByRole("group", { name: "Последние цифры SSCC" })).getByRole("button", {
        name: digit,
      }),
    );
    for (const each of same) {
      expect(screen.getByRole("button", { name: option(each) })).toBeTruthy();
    }
    // Still the choice: no reason is asked, nothing is written.
    expect(screen.getByText("Какую паллету расформировать?")).toBeTruthy();
    expect(screen.queryByText("Укажите причину")).toBeNull();
    expect(disassembledPallets(at)).toBe(0);
    // The pallet pressed is the pallet the reason is asked for.
    const chosen = same[1];
    if (chosen === undefined) throw new Error("no second pallet");
    await work.press(option(chosen));
    expect(screen.getByText(`Паллета ${formatSsccHri(chosen)}`)).toBeTruthy();
    expect(disassembledPallets(at)).toBe(0);
  });

  it("lists the pallets whose SSCC ENDS with the digits, not those that only contain them", () => {
    const items = [{ sscc: "100234" }, { sscc: "234100" }, { sscc: "123400" }];
    expect(boxesByTail(items, "234")).toEqual({ shown: [items[0]], hidden: 0 });
    expect(boxesByTail(items, "100")).toEqual({ shown: [items[1]], hidden: 0 });
  });

  it("finds the pallet by its whole SSCC only: a scan that merely ends alike is not found", () => {
    const pallets = [FIRST_PALLET, SECOND_PALLET].map((sscc, index) => ({
      id: String(index),
      sscc,
      boxCount: 1,
    }));
    expect(boxesByTail(pallets, FIRST_PALLET.slice(-3)).shown).toEqual([pallets[0]]);
    expect(boxesByTail(pallets, "").shown).toEqual(pallets);
    expect(boxesByTail(pallets, "9".repeat(18))).toEqual({ shown: [], hidden: 0 });
  });

  it("does not let a scan change the pallet once it is chosen, and writes nothing for it", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await twoPallets(at);
    await work.press("Расформировать паллету");
    await work.scan(`]C100${FIRST_PALLET}`);
    expect(screen.getByText(`Паллета ${formatSsccHri(FIRST_PALLET)}`)).toBeTruthy();
    await work.scan(`]C100${SECOND_PALLET}`);
    expect(lastLine()).toBe(PAUSED);
    expect(screen.getByText(`Паллета ${formatSsccHri(FIRST_PALLET)}`)).toBeTruthy();
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 2 }]);
    expect(disassembledPallets(at)).toBe(0);
  });

  it("keeps the box choice among the boxes in a shift with pallets: a pallet's label is not a box", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await twoPallets(at);
    await work.press("Расформировать короб");
    await work.scan(`]C100${FIRST_PALLET}`);
    expect(screen.getByText("Короба с этим SSCC нет среди закрытых коробов смены.")).toBeTruthy();
    await work.scan(`]C100${FIRST_BOX}`);
    expect(screen.getByText(`Короб ${formatSsccHri(FIRST_BOX)}`)).toBeTruthy();
  });
});

describe("a pallet's disassembly is confirmed, with a reason, and cannot be undone", () => {
  it("writes nothing until the confirmation is pressed, names the pallet, its boxes and the reason, and says it cannot be undone", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await onePallet(at);
    await work.press("Расформировать паллету");
    await work.press(option(FIRST_PALLET));
    // Reasons are asked first; nothing is written by choosing the pallet.
    expect(screen.getByText("Укажите причину")).toBeTruthy();
    expect(disassembledPallets(at)).toBe(0);
    await work.press("Повреждена упаковка");
    expect(screen.getByText("Расформировать паллету?")).toBeTruthy();
    // The warning is said by its colour and by its words: an error, not a plain warning.
    expect(screen.getByText("Расформировать паллету?").closest(".mk-alert--error")).not.toBeNull();
    expect(
      screen.getByText((text) => text.includes(`SSCC ${formatSsccHri(FIRST_PALLET)} больше не`)),
    ).toBeTruthy();
    expect(screen.getByText(/Короба паллеты \(1\) останутся закрытыми/)).toBeTruthy();
    expect(screen.getByText("Отменить это нельзя: снимите этикетку с паллеты.")).toBeTruthy();
    expect(screen.getByText("Причина: Повреждена упаковка")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Расформировать" }).className).toContain(
      "mk-btn--destructive",
    );
    expect(disassembledPallets(at)).toBe(0);
    expect(palletExceptions(at)).toEqual([]);
    // «Назад» leaves it undone.
    await work.press("Назад");
    expect(screen.getByText("Укажите причину")).toBeTruthy();
    expect(disassembledPallets(at)).toBe(0);
    await work.press("Повреждена упаковка");
    await work.press("Расформировать");
    expect(
      await screen.findByText("Паллета расформирована, её короба остались закрытыми."),
    ).toBeTruthy();
    expect(disassembledPallets(at)).toBe(1);
  });

  it("ignores the second tap of a double tap on the confirmation, and runs the disassembly once", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await onePallet(at);
    await work.press("Расформировать паллету");
    await work.press(option(FIRST_PALLET));
    work.pause();
    tap("Повреждена упаковка");
    // The destructive button is under the same finger now: the tap does nothing.
    tap("Расформировать");
    await work.settled();
    expect(disassembledPallets(at)).toBe(0);
    expect(screen.getByText("Расформировать паллету?")).toBeTruthy();
    work.pause();
    const confirm = screen.getByRole("button", { name: "Расформировать" });
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      await work.gate.drain();
    });
    expect(
      await screen.findByText("Паллета расформирована, её короба остались закрытыми."),
    ).toBeTruthy();
    expect(palletExceptions(at)).toHaveLength(1);
  });

  it.each([
    ["Не тот товар", "wrong_product"],
    ["Неверное количество", "wrong_quantity"],
    ["Повреждена упаковка", "damaged_package"],
    ["Брак по качеству", "quality_rejected"],
  ])("records the reason «%s» of a disassembly as %s", async (name, code) => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await onePallet(at);
    await work.press("Расформировать паллету");
    await work.press(option(FIRST_PALLET));
    await work.press(name);
    expect(screen.getByText(`Причина: ${name}`)).toBeTruthy();
    await work.press("Расформировать");
    await screen.findByText("Паллета расформирована, её короба остались закрытыми.");
    expect(palletExceptions(at)).toEqual([
      { kind: "disassemble", reason_code: code, reason_text: null },
    ]);
  });

  it("records the words of «Другая причина» trimmed, and refuses words that are too long", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await onePallet(at);
    await work.press("Расформировать паллету");
    await work.press(option(FIRST_PALLET));
    await work.press("Другая причина");
    const words = screen.getByLabelText("Причина своими словами (необязательно)");
    fireEvent.focus(words);
    expect(work.scanner.textEntry.at(-1)).toBe(true);
    fireEvent.change(words, { target: { value: "Я".repeat(201) } });
    await work.press("Дальше");
    expect(screen.getByText("Не больше 200 знаков, одной строкой.")).toBeTruthy();
    fireEvent.change(words, { target: { value: "  Паллета рассыпалась  " } });
    fireEvent.keyDown(words, { key: "Enter" });
    expect(work.scanner.textEntry.at(-1)).toBe(false);
    expect(screen.getByText("Причина: Паллета рассыпалась")).toBeTruthy();
    await work.press("Расформировать");
    await screen.findByText("Паллета расформирована, её короба остались закрытыми.");
    expect(palletExceptions(at)).toEqual([
      { kind: "disassemble", reason_code: "other", reason_text: "Паллета рассыпалась" },
    ]);
  });

  it("moves the focus to each view, never to a button", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await onePallet(at);
    await work.press("Расформировать паллету");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Какую паллету расформировать?",
    );
    await work.press(option(FIRST_PALLET));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Укажите причину");
    await work.press("Не тот товар");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Расформировать паллету?");
    expect(document.activeElement?.tagName).not.toBe("BUTTON");
  });

  it("makes every button of the pallet's exceptions a 64 px floor button", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await onePallet(at);
    const floor = () =>
      within(screen.getByRole("region", { name: "Исключения" }))
        .getAllByRole("button")
        .map((button) => button.className.includes("mk-btn--floor"));
    expect(floor().every(Boolean)).toBe(true);
    await work.press("Расформировать паллету");
    expect(floor().every(Boolean)).toBe(true);
    await work.press(option(FIRST_PALLET));
    expect(floor().every(Boolean)).toBe(true);
    await work.press("Не тот товар");
    expect(floor().every(Boolean)).toBe(true);
  });
});

describe("a pallet's reprint says where it goes and keeps the reason it was given", () => {
  it.each([
    ["Этикетка повреждена", "damaged_label"],
    ["Этикетка не читается", "unreadable_label"],
    ["Замятие в принтере", "printer_jam"],
    ["Требование контроля качества", "quality_request"],
  ])("records the reason «%s» of a reprint as %s", async (name, code) => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await onePallet(at);
    await work.press("Перепечатать этикетку паллеты");
    await work.press(option(FIRST_PALLET));
    await work.press(name);
    await work.press("Перепечатать");
    await screen.findByText("Этикетка паллеты отправлена на принтер.");
    expect(palletExceptions(at)).toEqual([
      { kind: "reprint", reason_code: code, reason_text: null },
    ]);
  });

  it("records the words of «Другая причина» of a reprint", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await onePallet(at);
    await work.press("Перепечатать этикетку паллеты");
    await work.press(option(FIRST_PALLET));
    await work.press("Другая причина");
    fireEvent.change(screen.getByLabelText("Причина своими словами (необязательно)"), {
      target: { value: "Склеилась лента" },
    });
    await work.press("Дальше");
    await work.press("Перепечатать");
    await screen.findByText("Этикетка паллеты отправлена на принтер.");
    expect(palletExceptions(at)).toEqual([
      { kind: "reprint", reason_code: "other", reason_text: "Склеилась лента" },
    ]);
  });

  it("names the printer of the pallet's purpose, not the box's, and sends the label there", async () => {
    const at = await palletStation({
      capacity: 1,
      boxCapacity: 1,
      settings: { assignments: { box: "zebra", pallet: "tsc", duplicate: null } },
    });
    const work = await onePallet(at);
    await work.press("Перепечатать этикетку паллеты");
    await work.press(option(FIRST_PALLET));
    await work.press("Этикетка повреждена");
    expect(
      await screen.findByText("Печать пойдёт на принтер: TSC на COM4 · TSPL · 300 dpi."),
    ).toBeTruthy();
    expect(screen.queryByText(/Zebra у линии/)).toBeNull();
    await work.press("Перепечатать");
    await screen.findByText("Этикетка паллеты отправлена на принтер.");
    expect(work.shell.sends.at(-1)).toEqual({
      target: TSC.target,
      text: renderedText(TSC, FIRST_PALLET, "100x150"),
    });
  });

  it("says that no printer is assigned to pallets, and that the label then waits on the work screen", async () => {
    const at = await palletStation({
      capacity: 1,
      boxCapacity: 1,
      settings: { assignments: { box: "zebra", pallet: null, duplicate: null } },
    });
    const work = await pallets(at, ["A1"]);
    // The pallet's own label already waits for a printer: decide it, then the exceptions open.
    await work.press("Продолжить без этикетки");
    await work.press("Продолжить без этикетки");
    await openExceptions(work);
    await work.press("Перепечатать этикетку паллеты");
    await work.press(option(FIRST_PALLET));
    await work.press("Этикетка повреждена");
    expect(
      await screen.findByText(
        "Принтер для этикетки паллеты не назначен, поэтому она не напечатается. Исключение всё равно будет записано, а этикетка останется на экране работы: напечатайте её, когда принтер будет настроен.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Принтер для этикетки короба не назначен/)).toBeNull();
  });

  it("hands a reprint that waits for its check to the work screen, and offers no exception while it waits", async () => {
    const at = await palletStation({
      capacity: 1,
      boxCapacity: 1,
      settings: { verifyPrintedLabel: true },
    });
    const work = await pallets(at, ["A1"]);
    // The box's and the pallet's label are checked first.
    await work.scan(`]C100${FIRST_BOX}`);
    await work.scan(`]C100${FIRST_PALLET}`);
    await openExceptions(work);
    await work.press("Перепечатать этикетку паллеты");
    await work.press(option(FIRST_PALLET));
    await work.press("Замятие в принтере");
    await work.press("Перепечатать");
    expect(await screen.findByText("Отсканируйте SSCC на этикетке паллеты.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
    // While the label waits the pallet cannot be taken apart: the exceptions are shut.
    expect(screen.getByRole("button", { name: "Исключения" }).hasAttribute("disabled")).toBe(true);
    expect(disassembledPallets(at)).toBe(0);
    expect(palletExceptions(at)).toEqual([
      { kind: "reprint", reason_code: "printer_jam", reason_text: null },
    ]);
  });
});

describe("the errors of a pallet's exception are told by their class", () => {
  it.each([
    ["a disassembly", "Расформировать паллету", "Брак по качеству", "Расформировать"],
    ["a reprint", "Перепечатать этикетку паллеты", "Замятие в принтере", "Перепечатать"],
  ])(
    "refuses %s while a label waits, and the label's panel takes the screen",
    async (_name, action, reason, confirm) => {
      const at = await palletStation({ capacity: 1, boxCapacity: 1 });
      const work = await twoPallets(at);
      await work.press(action);
      await work.press(option(FIRST_PALLET));
      await work.press(reason);
      // The label of the other pallet waits, though the screen shows no stop (a state it did not see).
      failPalletLabel(at, SECOND_PALLET);
      await work.press(confirm);
      expect(await screen.findByText("Этикетка паллеты не напечатана")).toBeTruthy();
      expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
      expect(palletExceptions(at)).toEqual([]);
      expect(disassembledPallets(at)).toBe(0);
      expect(rows(at.db, "SELECT count(*) AS n FROM floor_print_jobs")).toEqual([{ n: 4 }]);
      expect(work.shell.sends).toHaveLength(4);
    },
  );

  it("refuses a disassembly of the pallet whose own label waits", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await onePallet(at);
    await work.press("Расформировать паллету");
    await work.press(option(FIRST_PALLET));
    await work.press("Не тот товар");
    failPalletLabel(at, FIRST_PALLET);
    await work.press("Расформировать");
    expect(await screen.findByText("Этикетка паллеты не напечатана")).toBeTruthy();
    expect(disassembledPallets(at)).toBe(0);
    expect(palletExceptions(at)).toEqual([]);
    expect(outboxKinds(at)).not.toContain("pallet_exception");
  });

  it("refuses a disassembly while a box's label waits, though the pallet's label is done", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await onePallet(at);
    await work.press("Расформировать паллету");
    await work.press(option(FIRST_PALLET));
    await work.press("Не тот товар");
    failPalletLabel(at, FIRST_BOX);
    await work.press("Расформировать");
    expect(await screen.findByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(disassembledPallets(at)).toBe(0);
  });

  it.each([
    ["a reprint", "Перепечатать этикетку паллеты", "Замятие в принтере", "Перепечатать"],
    ["a disassembly", "Расформировать паллету", "Брак по качеству", "Расформировать"],
  ])(
    "says that the pallet is no longer a closed one when %s finds it taken apart",
    async (_name, action, reason, confirm) => {
      const at = await palletStation({ capacity: 1, boxCapacity: 1 });
      const work = await onePallet(at);
      await work.press(action);
      await work.press(option(FIRST_PALLET));
      await work.press(reason);
      at.db.exec("UPDATE floor_pallets SET disassembled_at = '2026-10-08T06:30:00.000Z'");
      await work.press(confirm);
      expect(await screen.findByText(GONE)).toBeTruthy();
      expect(palletExceptions(at)).toEqual([]);
      expect(work.shell.sends).toHaveLength(2);
    },
  );

  it("says the pallet changed when it was taken apart between the read and the write of a disassembly", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await openExceptions(work);
    await work.press("Расформировать паллету");
    await work.press(option(FIRST_PALLET));
    await work.press("Брак по качеству");
    held.holdNext();
    work.pause();
    tap("Расформировать");
    await held.reached();
    at.db.exec("UPDATE floor_pallets SET disassembled_at = '2026-10-08T06:30:00.000Z'");
    held.release();
    await work.settled();
    expect(await screen.findByText(STALE)).toBeTruthy();
    expect(palletExceptions(at)).toEqual([]);
  });

  it("says the pallet changed when another reprint of it landed between the read and the write", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await openExceptions(work);
    await work.press("Перепечатать этикетку паллеты");
    await work.press(option(FIRST_PALLET));
    await work.press("Замятие в принтере");
    held.holdNext();
    work.pause();
    tap("Перепечатать");
    await held.reached();
    // A newer job of the pallet lands while the write waits.
    const columns = rows(at.db, "PRAGMA table_info(floor_print_jobs)")
      .map((column) => String(column["name"]))
      .filter((name) => name !== "id");
    const list = columns.join(", ");
    at.db.exec(
      `INSERT INTO floor_print_jobs (id, ${list}) SELECT 'newer-job', ${list} FROM floor_print_jobs WHERE purpose = 'pallet'`,
    );
    held.release();
    await work.settled();
    expect(await screen.findByText(STALE)).toBeTruthy();
    expect(palletExceptions(at)).toEqual([]);
    expect(work.shell.sends).toHaveLength(2);
  });

  it("says the label cannot be printed here (the template, not an absent pallet) when the shift holds a newer revision of the pallet template", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = await pallets(at, ["A1"]);
    const { palletTemplate } = at.shift.snapshot;
    if (palletTemplate === null) throw new Error("the shift has no pallet template");
    work.rerender({
      shift: {
        ...at.shift,
        snapshot: {
          ...at.shift.snapshot,
          palletTemplate: { ...palletTemplate, rev: palletTemplate.rev + 1 },
        },
      },
    });
    await openExceptions(work);
    await work.press("Перепечатать этикетку паллеты");
    await work.press(option(FIRST_PALLET));
    await work.press("Замятие в принтере");
    await work.press("Перепечатать");
    expect(
      await screen.findByText(
        "Шаблон этикетки обновили после её печати: перепечатать эту этикетку здесь нельзя. Ничего не сделано.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(GONE)).toBeNull();
    expect(palletExceptions(at)).toEqual([]);
    expect(work.shell.sends).toHaveLength(2);
  });

  it("says a failed write and lets the operator choose again", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    let broken = false;
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: (statements) =>
        broken ? failingWrites(at.local).transaction(statements) : at.local.transaction(statements),
    };
    const work = renderWork({ local, shift: at.shift });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await openExceptions(work);
    await work.press("Расформировать паллету");
    await work.press(option(FIRST_PALLET));
    await work.press("Не тот товар");
    broken = true;
    await work.press("Расформировать");
    expect(await screen.findByText(FAILED)).toBeTruthy();
    await work.press("Другое действие");
    expect(screen.getByRole("button", { name: "Расформировать паллету" })).toBeTruthy();
    expect(disassembledPallets(at)).toBe(0);
  });

  it("hands its write to the floor's work gate: leaving the shift waits for it", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await openExceptions(work);
    await work.press("Расформировать паллету");
    await work.press(option(FIRST_PALLET));
    await work.press("Не тот товар");
    held.holdNext();
    work.pause();
    tap("Расформировать");
    await held.reached();
    expect(work.gate.pending()).toBe(1);
    expect(screen.getByText("Выполняем…")).toBeTruthy();
    held.release();
    await work.settled();
    expect(work.gate.pending()).toBe(0);
    expect(
      await screen.findByText("Паллета расформирована, её короба остались закрытыми."),
    ).toBeTruthy();
  });

  it("starts nothing once the operator is leaving, and says so", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    let leaving = false;
    const work = renderWork(at, { overrides: { isLeaving: () => leaving } });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await openExceptions(work);
    await work.press("Расформировать паллету");
    await work.press(option(FIRST_PALLET));
    await work.press("Не тот товар");
    leaving = true;
    await work.press("Расформировать");
    expect(await screen.findByText("Идёт выход из смены: исключение не выполнено.")).toBeTruthy();
    expect(disassembledPallets(at)).toBe(0);
    expect(palletExceptions(at)).toEqual([]);
  });
});

/** The flow rendered and its first read of the settings let in, as the floor's screen has it. */
async function mount(node: ReactElement): Promise<RenderResult> {
  let view: RenderResult | undefined;
  await act(async () => {
    view = render(node);
  });
  if (view === undefined) throw new Error("the flow was not rendered");
  return view;
}

function flowProps(overrides: Partial<ExceptionFlowProps> = {}): ExceptionFlowProps {
  const done = async () => ({ kind: "done", action: "undo" }) as const;
  // Every look at the clock is a pause longer than the guard after a view.
  let now = 0;
  return {
    openItems: 0,
    boxes: [],
    onUndo: vi.fn(done),
    onClear: vi.fn(done),
    onReprint: vi.fn(done),
    onDisassemble: vi.fn(done),
    registerScan: vi.fn(),
    onTextEntry: vi.fn(),
    onBack: vi.fn(),
    loadSettings: async () => printingSettings(),
    clock: () => {
      now += PRESS_PAUSE_MS;
      return now;
    },
    ...overrides,
  };
}

const ONE_PALLET: ClosedPallet[] = [
  { id: "p1", sscc: FIRST_PALLET, boxCount: 3, closedAt: "2026-10-08T06:15:00.000Z" },
];

describe("the pallet's part of the exceptions screen by itself", () => {
  it.each<[string, ExceptionOutcome, string]>([
    ["stale", { kind: "stale" }, STALE],
    ["unavailable", { kind: "unavailable" }, GONE],
    ["label_waiting", { kind: "label_waiting" }, WAITING],
    [
      "template_changed",
      { kind: "template_changed" },
      "Шаблон этикетки обновили после её печати: перепечатать эту этикетку здесь нельзя. Ничего не сделано.",
    ],
    ["leaving", { kind: "leaving" }, "Идёт выход из смены: исключение не выполнено."],
    ["failed", { kind: "failed" }, FAILED],
    ["label", { kind: "label" }, "Новая этикетка ждёт решения на рабочем экране."],
  ])(
    "says the outcome %s of a pallet's action in the pallet's words",
    async (_kind, outcome, words) => {
      const onPalletDisassemble = vi.fn(async () => outcome);
      await mount(<ExceptionFlow {...flowProps({ pallets: ONE_PALLET, onPalletDisassemble })} />);
      fireEvent.click(screen.getByRole("button", { name: "Расформировать паллету" }));
      fireEvent.click(screen.getByRole("button", { name: option(FIRST_PALLET, 3) }));
      fireEvent.click(screen.getByRole("button", { name: "Не тот товар" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Расформировать" }));
      });
      expect(screen.getByText(words)).toBeTruthy();
      expect(onPalletDisassemble).toHaveBeenCalledWith("p1", { code: "wrong_product", text: null });
    },
  );

  it("says a box's outcome in the box's words, whatever the shift holds", async () => {
    const onDisassemble = vi.fn(async () => ({ kind: "label_waiting" }) as const);
    await mount(
      <ExceptionFlow
        {...flowProps({
          pallets: ONE_PALLET,
          boxes: [{ id: "b1", sscc: FIRST_BOX, itemCount: 12, closedAt: "x" }],
          onDisassemble,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Расформировать короб" }));
    fireEvent.click(screen.getByRole("button", { name: `${formatSsccHri(FIRST_BOX)} · 12 шт.` }));
    fireEvent.click(screen.getByRole("button", { name: "Не тот товар" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Расформировать" }));
    });
    expect(
      screen.getByText("Этикетка короба ещё ждёт решения на рабочем экране. Ничего не сделано."),
    ).toBeTruthy();
  });

  it("does nothing, and says the pallet is not there, when the floor gives no handler for the action", async () => {
    await mount(<ExceptionFlow {...flowProps({ pallets: ONE_PALLET })} />);
    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку паллеты" }));
    fireEvent.click(screen.getByRole("button", { name: option(FIRST_PALLET, 3) }));
    fireEvent.click(screen.getByRole("button", { name: "Этикетка повреждена" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Перепечатать" }));
    });
    expect(screen.getByText(GONE)).toBeTruthy();
  });

  it("does not call the work done while a closed pallet is left to take apart, nor while the pallets are read", async () => {
    const view = await mount(<ExceptionFlow {...flowProps({ pallets: ONE_PALLET })} />);
    // Every box of the pallet was taken apart, the pallet is closed all the same.
    expect(screen.queryByText(/Сейчас исключений нет/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Расформировать паллету" }).hasAttribute("disabled"),
    ).toBe(false);
    await act(async () => {
      view.rerender(<ExceptionFlow {...flowProps({ pallets: null })} />);
    });
    expect(screen.queryByText(/Сейчас исключений нет/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Расформировать паллету" }).hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => {
      view.rerender(<ExceptionFlow {...flowProps({ pallets: [] })} />);
    });
    expect(screen.getByText(/Сейчас исключений нет/)).toBeTruthy();
  });

  it("lists twelve pallets at most, says how many more the digits will find, and what is read or not found", async () => {
    const many: ClosedPallet[] = Array.from({ length: 15 }, (_, index) => ({
      id: `pallet-${index}`,
      sscc: buildSscc(PALLET_EXTENSION, PREFIX, index),
      boxCount: 2,
      closedAt: "2026-10-08T06:15:00.000Z",
    }));
    const view = await mount(<ExceptionFlow {...flowProps({ pallets: many })} />);
    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку паллеты" }));
    expect(screen.getAllByRole("button", { name: /коробов: 2$/ })).toHaveLength(MAX_LISTED_BOXES);
    expect(screen.getByText("Ещё паллет: 3. Наберите больше цифр.")).toBeTruthy();
    expect(
      screen.getByText("Отсканируйте этикетку паллеты или наберите последние цифры её SSCC."),
    ).toBeTruthy();
    const pad = within(screen.getByRole("group", { name: "Последние цифры SSCC" }));
    for (const digit of "9999") fireEvent.click(pad.getByRole("button", { name: digit }));
    expect(screen.getByText("Нет закрытых паллет с такими цифрами.")).toBeTruthy();
    await act(async () => {
      view.rerender(<ExceptionFlow {...flowProps({ pallets: null })} />);
    });
    expect(screen.getByText("Читаем закрытые паллеты…")).toBeTruthy();
  });

  it("reads a scan against the pallets for a pallet's action and against the boxes for a box's", async () => {
    const registerScan = vi.fn();
    await mount(
      <ExceptionFlow
        {...flowProps({
          registerScan,
          pallets: ONE_PALLET,
          boxes: [{ id: "b1", sscc: FIRST_BOX, itemCount: 12, closedAt: "x" }],
        })}
      />,
    );
    type Listener = (raw: string) => BoxScanVerdict | null;
    const listening = (): Listener => {
      const listener = registerScan.mock.lastCall?.[0] as Listener | null | undefined;
      if (listener === null || listener === undefined) throw new Error("no scan listener");
      return listener;
    };
    const scan = (raw: string, listener: Listener = listening()): BoxScanVerdict | null => {
      let verdict: BoxScanVerdict | null = null;
      act(() => {
        verdict = listener(raw);
      });
      return verdict;
    };
    fireEvent.click(screen.getByRole("button", { name: "Расформировать паллету" }));
    expect(scan(`]C100${FIRST_BOX}`)).toBe("not_found");
    expect(scan(km("A9"))).toBe("not_sscc");
    const choice = listening();
    expect(scan(`]C100${FIRST_PALLET}`, choice)).toBe("taken");
    // The choice is made: a second scan, before any render, is not the choice's to read.
    expect(scan(`]C100${FIRST_PALLET}`, choice)).toBeNull();
    expect(registerScan.mock.lastCall?.[0]).toBeNull();
    expect(screen.getByText(`Паллета ${formatSsccHri(FIRST_PALLET)}`)).toBeTruthy();
    // A box's action takes the box, not the pallet.
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: "Расформировать короб" }));
    expect(scan(`]C100${FIRST_PALLET}`)).toBe("not_found");
    expect(scan(`]C100${FIRST_BOX}`)).toBe("taken");
  });

  it("goes back from the reason to the choice of the pallet, not of a box", async () => {
    await mount(<ExceptionFlow {...flowProps({ pallets: ONE_PALLET })} />);
    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку паллеты" }));
    fireEvent.click(screen.getByRole("button", { name: option(FIRST_PALLET, 3) }));
    expect(screen.getByText("Укажите причину")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByText("Какую паллету перепечатать?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: option(FIRST_PALLET, 3) }));
    fireEvent.click(screen.getByRole("button", { name: "Другая причина" }));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByText("Укажите причину")).toBeTruthy();
    expect(screen.getByText(`Паллета ${formatSsccHri(FIRST_PALLET)}`)).toBeTruthy();
  });

  it("offers the setup where no printer is assigned to pallets, though one is to boxes, and not the other way round", async () => {
    const onSetup = vi.fn();
    const noPalletPrinter = async () =>
      printingSettings({ assignments: { box: "zebra", pallet: null, duplicate: null } });
    const view = await mount(
      <ExceptionFlow
        {...flowProps({ pallets: ONE_PALLET, loadSettings: noPalletPrinter, onSetup })}
      />,
    );
    const toConfirm = () => {
      fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку паллеты" }));
      fireEvent.click(screen.getByRole("button", { name: option(FIRST_PALLET, 3) }));
      fireEvent.click(screen.getByRole("button", { name: "Этикетка повреждена" }));
    };
    toConfirm();
    expect(screen.getByText(/Принтер для этикетки паллеты не назначен/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Настроить принтер" })).toBeTruthy();
    view.unmount();
    const noBoxPrinter = async () =>
      printingSettings({ assignments: { box: null, pallet: "zebra", duplicate: null } });
    await mount(
      <ExceptionFlow
        {...flowProps({ pallets: ONE_PALLET, loadSettings: noBoxPrinter, onSetup })}
      />,
    );
    toConfirm();
    expect(
      screen.getByText("Печать пойдёт на принтер: Zebra у линии · ZPL · 203 dpi."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Настроить принтер" })).toBeNull();
  });
});
