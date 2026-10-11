import { buildSscc, formatSsccHri } from "@markiro/domain";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  boxesByTail,
  ExceptionFlow,
  MAX_LISTED_BOXES,
  type ExceptionFlowProps,
} from "../src/floor/exceptions/ExceptionFlow.js";
import type { ClosedBox } from "../src/floor/exceptions/box-exceptions.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { failingWrites, holdingWrites, km, PREFIX, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import {
  FIRST_SSCC,
  jobRows,
  printStation,
  renderedText,
  setUpPrinting,
  ZEBRA,
} from "./support/printing.js";
import { lastLine, PRESS_PAUSE_MS, renderWork } from "./support/work-screen.js";

type Station = Awaited<ReturnType<typeof printStation>>;
type Work = ReturnType<typeof renderWork>;

const SECOND_SSCC = buildSscc(0, PREFIX, 1501);
const PAUSED = "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.";

async function scanAll(work: Work, serials: readonly string[]): Promise<void> {
  await work.scanner.listening();
  await work.settled();
  for (const serial of serials) await work.scan(km(serial));
}

/** Twelve codes: the box fills, closes by itself, and its label is printed. */
async function fillBox(work: Work, prefix: string): Promise<void> {
  await scanAll(
    work,
    Array.from({ length: 12 }, (_, index) => `${prefix}${index}`),
  );
}

function scans(at: Station): unknown {
  return rows(at.db, "SELECT count(*) AS n FROM floor_scans")[0]?.["n"];
}

function exceptionKinds(at: Station): unknown[] {
  return rows(
    at.db,
    "SELECT kind, reason_code, reason_text FROM floor_exceptions ORDER BY occurred_at",
  );
}

function region() {
  return within(screen.getByRole("region", { name: "Исключения" }));
}

/** A click that is not a press of the harness: the clock stays where it is. */
function tap(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("the list of closed boxes by the last digits of their SSCC", () => {
  it("shows the boxes that end with the digits, at most twelve, and counts the rest", () => {
    const boxes: ClosedBox[] = Array.from({ length: 15 }, (_, index) => ({
      id: String(index),
      sscc: buildSscc(0, PREFIX, 1500 + index),
      itemCount: 12,
      closedAt: "2026-10-08T06:15:00.000Z",
    }));
    expect(boxesByTail(boxes, "")).toEqual({ shown: boxes.slice(0, MAX_LISTED_BOXES), hidden: 3 });
    const tail = SECOND_SSCC.slice(-4);
    expect(boxesByTail(boxes, tail)).toEqual({ shown: [boxes[1]], hidden: 0 });
    expect(boxesByTail(boxes, "x")).toEqual({ shown: [], hidden: 0 });
  });
});

describe("the exceptions of the work screen", () => {
  it("takes the last code out of the open box, and the work goes on", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1", "A2", "A3"]);
    await work.press("Исключения");
    expect(await screen.findByRole("region", { name: "Исключения" })).toBeTruthy();
    await work.press("Снять последний код");
    expect(await screen.findByText("Последний код снят из короба.")).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([{ kind: "undo", reason_code: null, reason_text: null }]);
    expect(work.props.onRecorded).toHaveBeenCalled();
    expect(
      region().getByText("Последний код снят из короба.").closest(".mk-alert--ok"),
    ).not.toBeNull();
    await work.press("Вернуться к работе");
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
    expect(screen.getByText("2 из 12")).toBeTruthy();
    await work.scan(km("A3"));
    expect(screen.getByText("3 из 12")).toBeTruthy();
  });

  it("clears the open box only after the operator confirms, the quantity named", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1", "A2"]);
    await work.press("Исключения");
    await work.press("Очистить короб");
    expect(screen.getByText("Очистить короб?")).toBeTruthy();
    expect(screen.getByText(/уйдут все коды \(2 шт\.\)/)).toBeTruthy();
    await work.press("Назад");
    expect(exceptionKinds(at)).toEqual([]);
    await work.press("Очистить короб");
    await work.press("Очистить короб");
    expect(await screen.findByText("Короб очищен.")).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([{ kind: "clear", reason_code: null, reason_text: null }]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 0 }]);
  });

  it("takes apart a box chosen by a scan of its label, with a reason; a scan there is never journalled", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    expect(work.shell.sends).toHaveLength(1);
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    await work.press("Расформировать короб");
    expect(screen.getByText("Какой короб расформировать?")).toBeTruthy();
    await work.scan(km("P99"));
    expect(screen.getByText("Это не код SSCC. Отсканируйте этикетку короба.")).toBeTruthy();
    await work.scan(`]C100${SECOND_SSCC}`);
    expect(screen.getByText("Короба с этим SSCC нет среди закрытых коробов смены.")).toBeTruthy();
    expect(scans(at)).toBe(12);
    await work.scan(`]C100${FIRST_SSCC}`);
    expect(screen.getByText(`Короб ${formatSsccHri(FIRST_SSCC)}`)).toBeTruthy();
    await work.press("Неверное количество");
    expect(screen.getByText("Расформировать короб?")).toBeTruthy();
    // The box and its SSCC are named before anything is destroyed.
    expect(
      screen.getByText((text) => text.includes(`SSCC ${formatSsccHri(FIRST_SSCC)} больше не`)),
    ).toBeTruthy();
    expect(screen.getByText(/Коды короба \(12 шт\.\) снова станут свободны/)).toBeTruthy();
    expect(screen.getByText("Причина: Неверное количество")).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([]);
    await work.press("Расформировать");
    expect(await screen.findByText("Короб расформирован, его коды свободны.")).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([
      { kind: "disassemble", reason_code: "wrong_quantity", reason_text: null },
    ]);
    expect(scans(at)).toBe(12);
    await work.press("Вернуться к работе");
    // The box's codes are free again: scanned again, they are accepted.
    await work.scan(km("P1"));
    expect(screen.getByText("1 из 12")).toBeTruthy();
  });

  it("prints a box's label again chosen by the last digits, with the words of «Другая причина»", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    await fillBox(work, "Q");
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Перепечатать этикетку" });
    await work.press("Перепечатать этикетку");
    const pad = within(screen.getByRole("group", { name: "Последние цифры SSCC" }));
    expect(
      screen.getByRole("button", { name: `${formatSsccHri(SECOND_SSCC)} · 12 шт.` }),
    ).toBeTruthy();
    work.pause();
    for (const digit of FIRST_SSCC.slice(-2))
      fireEvent.click(pad.getByRole("button", { name: digit }));
    // Both digits were taken, though the operator did not pause between them.
    expect(screen.getByText(`Последние цифры SSCC: ${FIRST_SSCC.slice(-2)}`)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: `${formatSsccHri(SECOND_SSCC)} · 12 шт.` }),
    ).toBeNull();
    await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
    await work.press("Другая причина");
    const words = screen.getByLabelText("Причина своими словами (необязательно)");
    fireEvent.focus(words);
    expect(work.scanner.textEntry.at(-1)).toBe(true);
    fireEvent.change(words, { target: { value: "Я".repeat(201) } });
    await work.press("Дальше");
    expect(screen.getByText("Не больше 200 знаков, одной строкой.")).toBeTruthy();
    fireEvent.change(words, { target: { value: "  Смазалась при укладке  " } });
    fireEvent.blur(words);
    expect(work.scanner.textEntry.at(-1)).toBe(false);
    await work.press("Дальше");
    expect(screen.getByText("Причина: Смазалась при укладке")).toBeTruthy();
    await work.press("Перепечатать");
    expect(await screen.findByText("Этикетка отправлена на принтер.")).toBeTruthy();
    expect(work.shell.sends.at(-1)).toEqual({
      target: ZEBRA.target,
      text: renderedText(ZEBRA, FIRST_SSCC),
    });
    expect(exceptionKinds(at)).toEqual([
      { kind: "reprint", reason_code: "other", reason_text: "Смазалась при укладке" },
    ]);
  });

  it("stops at a reprinted label that waits for its check", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    await setUpPrinting(at.local, { verifyPrintedLabel: true });
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Перепечатать этикетку" });
    await work.press("Перепечатать этикетку");
    await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
    await work.press("Этикетка повреждена");
    await work.press("Перепечатать");
    expect(await screen.findByText("Проверьте этикетку")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
    expect(jobRows(at.db).map((job) => job["state"])).toEqual(["sent", "sent"]);
    await work.scan(`]C100${FIRST_SSCC}`);
    expect(screen.queryByText("Проверьте этикетку")).toBeNull();
  });

  it("hands its write to the floor's work gate: leaving the shift waits for it", async () => {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await scanAll(work, ["A1"]);
    await work.press("Исключения");
    held.holdNext();
    work.pause();
    tap("Снять последний код");
    await held.reached();
    expect(work.gate.pending()).toBe(1);
    expect(screen.getByText("Выполняем…")).toBeTruthy();
    held.release();
    await work.settled();
    expect(work.gate.pending()).toBe(0);
    expect(await screen.findByText("Последний код снят из короба.")).toBeTruthy();
  });

  it("takes no ordinary scan while it is open, and says so", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1"]);
    await work.press("Исключения");
    await work.scan(km("A2"));
    expect(lastLine()).toBe(PAUSED);
    expect(scans(at)).toBe(1);
  });

  it("says a failed write and lets the operator choose again or go back to the work", async () => {
    const at = await printStation();
    let broken = false;
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: (statements) =>
        broken ? failingWrites(at.local).transaction(statements) : at.local.transaction(statements),
    };
    const work = renderWork({ local, shift: at.shift });
    await scanAll(work, ["A1"]);
    await work.press("Исключения");
    broken = true;
    await work.press("Снять последний код");
    expect(
      await screen.findByText(
        "Не удалось записать исключение на этом компьютере. Ничего не сделано.",
      ),
    ).toBeTruthy();
    await work.press("Другое действие");
    expect(region().getByRole("button", { name: "Снять последний код" })).toBeTruthy();
    await work.press("Назад");
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
    expect(exceptionKinds(at)).toEqual([]);
  });

  it("opens neither at a label that waits nor while the operator leaves; «Выйти из смены» stays open in it", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const work = renderWork(at, { shell });
    await fillBox(work, "P");
    expect(screen.getByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Исключения" }).hasAttribute("disabled")).toBe(true);
    await work.press("Продолжить без этикетки");
    await work.press("Продолжить без этикетки");
    await work.press("Исключения");
    expect(screen.getByRole("button", { name: "Выйти из смены" }).hasAttribute("disabled")).toBe(
      false,
    );
    await work.press("Назад");
    work.rerender({ leaving: true });
    expect(screen.getByRole("button", { name: "Исключения" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("the order the exceptions keep around a label that waits", () => {
  it("lets the label's panel take the screen when a label waits as the exceptions open", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    expect(screen.queryByText("Этикетка короба не напечатана")).toBeNull();
    // A job of the shift that waits although the screen shows no stop (a state the entry did not see).
    at.db.exec("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'");
    await work.press("Исключения");
    expect(await screen.findByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
    expect(exceptionKinds(at)).toEqual([]);
  });

  it.each([
    ["a disassembly", "Расформировать короб", "Брак по качеству", "Расформировать"],
    ["a reprint", "Перепечатать этикетку", "Замятие в принтере", "Перепечатать"],
  ])(
    "refuses %s of a box while another box's label began to wait, and the label's panel takes the screen",
    async (_name, action, reason, confirm) => {
      const at = await printStation();
      const work = renderWork(at);
      await fillBox(work, "P");
      await fillBox(work, "Q");
      await work.press("Исключения");
      await screen.findByRole("button", { name: action });
      await work.press(action);
      await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
      await work.press(reason);
      // The label of the second box waits, though the screen shows no stop (a state it did not see).
      at.db.exec(
        "UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent' WHERE sscc = '" +
          SECOND_SSCC +
          "'",
      );
      await work.press(confirm);
      expect(await screen.findByText("Этикетка короба не напечатана")).toBeTruthy();
      expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
      expect(exceptionKinds(at)).toEqual([]);
      expect(jobRows(at.db)).toHaveLength(2);
      expect(work.shell.sends).toHaveLength(2);
      expect(
        rows(at.db, "SELECT count(*) AS n FROM floor_boxes WHERE disassembled_at IS NOT NULL"),
      ).toEqual([{ n: 0 }]);
    },
  );

  it.each([
    ["a reprint", "Перепечатать этикетку", "Замятие в принтере", "Перепечатать"],
    ["a disassembly", "Расформировать короб", "Брак по качеству", "Расформировать"],
  ])(
    "says that the box is no longer a closed one when %s finds it taken apart",
    async (_name, action, reason, confirm) => {
      const at = await printStation();
      const work = renderWork(at);
      await fillBox(work, "P");
      await work.press("Исключения");
      await screen.findByRole("button", { name: action });
      await work.press(action);
      await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
      await work.press(reason);
      at.db.exec("UPDATE floor_boxes SET disassembled_at = '2026-10-08T06:30:00.000Z'");
      await work.press(confirm);
      expect(
        await screen.findByText(
          "Этого короба больше нет среди закрытых коробов смены. Ничего не сделано.",
        ),
      ).toBeTruthy();
      expect(exceptionKinds(at)).toEqual([]);
      expect(work.shell.sends).toHaveLength(1);
    },
  );

  it("says the box changed when it was taken apart between the read and the write of a disassembly", async () => {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await fillBox(work, "P");
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    await work.press("Расформировать короб");
    await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
    await work.press("Брак по качеству");
    held.holdNext();
    work.pause();
    tap("Расформировать");
    await held.reached();
    at.db.exec("UPDATE floor_boxes SET disassembled_at = '2026-10-08T06:30:00.000Z'");
    held.release();
    await work.settled();
    expect(
      await screen.findByText("Пока вы выбирали, короб изменился. Ничего не сделано — повторите."),
    ).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([]);
  });

  it("says the label cannot be printed here when the shift holds a newer revision of the template", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    const { boxTemplate } = at.shift.snapshot;
    work.rerender({
      shift: {
        ...at.shift,
        snapshot: {
          ...at.shift.snapshot,
          boxTemplate: { ...boxTemplate, rev: boxTemplate.rev + 1 },
        },
      },
    });
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Перепечатать этикетку" });
    await work.press("Перепечатать этикетку");
    await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
    await work.press("Замятие в принтере");
    await work.press("Перепечатать");
    expect(
      await screen.findByText(
        "Шаблон этикетки обновили после её печати: перепечатать эту этикетку здесь нельзя. Ничего не сделано.",
      ),
    ).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([]);
    expect(work.shell.sends).toHaveLength(1);
  });

  it("says the box changed when another reprint of it landed between the read and the write", async () => {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await fillBox(work, "P");
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Перепечатать этикетку" });
    await work.press("Перепечатать этикетку");
    await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
    await work.press("Замятие в принтере");
    held.holdNext();
    work.pause();
    tap("Перепечатать");
    await held.reached();
    // A newer job of the box lands while the write waits.
    const columns = rows(at.db, "PRAGMA table_info(floor_print_jobs)")
      .map((column) => String(column["name"]))
      .filter((name) => name !== "id");
    const list = columns.join(", ");
    at.db.exec(
      `INSERT INTO floor_print_jobs (id, ${list}) SELECT 'newer-job', ${list} FROM floor_print_jobs`,
    );
    held.release();
    await work.settled();
    expect(
      await screen.findByText("Пока вы выбирали, короб изменился. Ничего не сделано — повторите."),
    ).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([]);
    expect(work.shell.sends).toHaveLength(1);
  });

  it("can print again, from the exceptions, the label of a box the operator went on without", async () => {
    const at = await printStation();
    const answers = [{ sent: false, code: "not_sent" } as const, { sent: true } as const];
    const shell = fakeHardware(async () => answers.shift() ?? { sent: true });
    const work = renderWork(at, { shell });
    await fillBox(work, "P");
    await work.press("Продолжить без этикетки");
    // The text names the place of the reprint, and the place is there.
    expect(screen.getByText(/напечатать этикетку снова можно в «Исключениях»/)).toBeTruthy();
    await work.press("Продолжить без этикетки");
    expect(jobRows(at.db)[0]).toMatchObject({ state: "skipped" });
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Перепечатать этикетку" });
    await work.press("Перепечатать этикетку");
    await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
    await work.press("Этикетка не читается");
    await work.press("Перепечатать");
    expect(await screen.findByText("Этикетка отправлена на принтер.")).toBeTruthy();
    expect(shell.sends.at(-1)?.text).toBe(renderedText(ZEBRA, FIRST_SSCC));
    expect(exceptionKinds(at)).toEqual([
      { kind: "reprint", reason_code: "unreadable_label", reason_text: null },
    ]);
  });
});

describe("what the exceptions guard against on a touch screen", () => {
  it("ignores a press just after the view changed, the second tap of a double tap", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1", "A2"]);
    await work.press("Исключения");
    // The view has just opened: a tap on what is under the finger does nothing.
    tap("Очистить короб");
    expect(screen.queryByText("Очистить короб?")).toBeNull();
    work.pause();
    tap("Очистить короб");
    expect(screen.getByText("Очистить короб?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Очистить короб" }).className).toContain(
      "mk-btn--destructive",
    );
    // The destructive button is under the same finger now: nothing is cleared.
    tap("Очистить короб");
    await work.settled();
    expect(exceptionKinds(at)).toEqual([]);
    expect(screen.getByText("Очистить короб?")).toBeTruthy();
    work.pause();
    await act(async () => {
      tap("Очистить короб");
      await work.gate.drain();
    });
    expect(await screen.findByText("Короб очищен.")).toBeTruthy();
    expect(exceptionKinds(at)).toHaveLength(1);
  });

  it("does an action once however many times it is pressed before the view changes", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1", "A2", "A3"]);
    await work.press("Исключения");
    work.pause();
    const undo = screen.getByRole("button", { name: "Снять последний код" });
    await act(async () => {
      fireEvent.click(undo);
      fireEvent.click(undo);
      await work.gate.drain();
    });
    expect(await screen.findByText("Последний код снят из короба.")).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([{ kind: "undo", reason_code: null, reason_text: null }]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
  });

  it("starts nothing once the operator is leaving, and says so", async () => {
    const at = await printStation();
    let leaving = false;
    const work = renderWork(at, { overrides: { isLeaving: () => leaving } });
    await scanAll(work, ["A1", "A2"]);
    await work.press("Исключения");
    leaving = true;
    await work.press("Снять последний код");
    expect(await screen.findByText("Идёт выход из смены: исключение не выполнено.")).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
    // Nor do the exceptions open.
    await work.press("Вернуться к работе");
    await work.press("Исключения");
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
  });

  it("does not open over a stop that came a moment ago, before the screen showed it", async () => {
    const at = await printStation();
    let broken = false;
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: (statements) =>
        broken ? failingWrites(at.local).transaction(statements) : at.local.transaction(statements),
    };
    const work = renderWork({ local, shift: at.shift });
    await scanAll(work, ["A1"]);
    const open = screen.getByRole("button", { name: "Исключения" });
    broken = true;
    await act(async () => {
      // The failed write has stopped the line, and the screen has not been drawn since.
      work.scanner.emit(km("A2"));
      await work.gate.drain();
      expect(open.hasAttribute("disabled")).toBe(false);
      fireEvent.click(open);
      await work.gate.drain();
    });
    expect(screen.getByText("Скан не записан")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
  });

  it("gives the keyboard back to the scanner when the words are done with by Enter", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    await work.press("Расформировать короб");
    await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
    await work.press("Другая причина");
    const words = screen.getByLabelText("Причина своими словами (необязательно)");
    fireEvent.focus(words);
    expect(work.scanner.textEntry.at(-1)).toBe(true);
    fireEvent.change(words, { target: { value: "Рассыпался" } });
    fireEvent.keyDown(words, { key: "Enter" });
    // The field is gone with no blur: the scanner's keys are its own again.
    expect(screen.getByText("Причина: Рассыпался")).toBeTruthy();
    expect(work.scanner.textEntry.at(-1)).toBe(false);
  });

  it("does not let a scan change the box once it is chosen, and writes nothing for it", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    await fillBox(work, "Q");
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    await work.press("Расформировать короб");
    await work.scan(`]C100${FIRST_SSCC}`);
    expect(screen.getByText(`Короб ${formatSsccHri(FIRST_SSCC)}`)).toBeTruthy();
    // A scan of the other box's label by mistake: said, not taken, not journalled.
    await work.scan(`]C100${SECOND_SSCC}`);
    expect(lastLine()).toBe(PAUSED);
    expect(screen.getByText(`Короб ${formatSsccHri(FIRST_SSCC)}`)).toBeTruthy();
    await work.scan(km("Z1"));
    expect(scans(at)).toBe(24);
    expect(exceptionKinds(at)).toEqual([]);
  });

  it("puts the focus on the view, never on a button, and returns it to the button that opened it", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1"]);
    await work.press("Исключения");
    expect(document.activeElement).toBe(
      within(screen.getByRole("region", { name: "Исключения" })).getByRole("group", {
        name: "Что нужно сделать?",
      }),
    );
    await work.press("Очистить короб");
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Очистить короб?" }));
    await work.press("Назад");
    await work.press("Назад");
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Исключения" }));
  });

  it("keeps every button on 64 px, and every alert out of the live region's way", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    const checkView = () => {
      const view = screen.getByRole("region", { name: "Исключения" });
      for (const button of within(view).getAllByRole("button")) {
        expect(button.style.height, button.textContent ?? "").toBe("var(--control-floor)");
      }
      for (const alert of view.querySelectorAll(".mk-alert")) {
        expect(alert.getAttribute("role")).toBe("presentation");
      }
    };
    checkView();
    await work.press("Расформировать короб");
    checkView();
    await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
    checkView();
    await work.press("Другая причина");
    checkView();
    expect(screen.getByLabelText("Причина своими словами (необязательно)").style.minHeight).toBe(
      "var(--control-floor)",
    );
    fireEvent.change(screen.getByLabelText("Причина своими словами (необязательно)"), {
      target: { value: "Рассыпался" },
    });
    await work.press("Дальше");
    checkView();
    // The button that destroys is at the far end of its row, apart from «Назад».
    const destroy = screen.getByRole("button", { name: "Расформировать" });
    const row = destroy.parentElement;
    expect(row?.classList.contains("exceptions__confirm")).toBe(true);
    expect(row?.firstElementChild?.textContent).toBe("Назад");
    expect(row?.lastElementChild).toBe(destroy);
    expect(destroy.className).toContain("mk-btn--destructive");
    await work.press("Расформировать");
    await screen.findByText("Короб расформирован, его коды свободны.");
    checkView();
  });
});

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
    clock: () => {
      now += PRESS_PAUSE_MS;
      return now;
    },
    ...overrides,
  };
}

describe("the exceptions screen by itself", () => {
  it("says there is nothing to do when the box is empty and no box is closed, and offers nothing", () => {
    render(<ExceptionFlow {...flowProps()} />);
    expect(screen.getByText(/Сейчас исключений нет/)).toBeTruthy();
    for (const name of [
      "Снять последний код",
      "Очистить короб",
      "Перепечатать этикетку",
      "Расформировать короб",
    ]) {
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
  });

  it("does not call the work done while the closed boxes are read", () => {
    render(<ExceptionFlow {...flowProps({ openItems: 0, boxes: null })} />);
    expect(screen.getByText("Читаем закрытые короба…")).toBeTruthy();
    expect(screen.queryByText(/Сейчас исключений нет/)).toBeNull();
  });

  it("waits for the closed boxes without calling the work done, and offers the open box's actions", () => {
    render(<ExceptionFlow {...flowProps({ openItems: 3, boxes: null })} />);
    expect(screen.getByText("Читаем закрытые короба…")).toBeTruthy();
    expect(screen.queryByText(/Сейчас исключений нет/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Снять последний код" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Очистить короб" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(
      screen.getByRole("button", { name: "Перепечатать этикетку" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("lists twelve boxes at most and says how many more the digits will find", () => {
    const boxes: ClosedBox[] = Array.from({ length: 15 }, (_, index) => ({
      id: `box-${index}`,
      sscc: buildSscc(0, PREFIX, 1500 + index),
      itemCount: 12,
      closedAt: "2026-10-08T06:15:00.000Z",
    }));
    render(<ExceptionFlow {...flowProps({ boxes })} />);
    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку" }));
    expect(screen.getAllByRole("button", { name: /шт\.$/ })).toHaveLength(MAX_LISTED_BOXES);
    expect(screen.getByText("Ещё коробов: 3. Наберите больше цифр.")).toBeTruthy();
  });

  it("takes no more digits than an SSCC has, and erases them one by one", () => {
    render(
      <ExceptionFlow
        {...flowProps({ boxes: [{ id: "a", sscc: FIRST_SSCC, itemCount: 12, closedAt: "x" }] })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Расформировать короб" }));
    const pad = within(screen.getByRole("group", { name: "Последние цифры SSCC" }));
    for (const digit of FIRST_SSCC) fireEvent.click(pad.getByRole("button", { name: digit }));
    expect(screen.getByText(`Последние цифры SSCC: ${FIRST_SSCC}`)).toBeTruthy();
    expect(pad.getByRole("button", { name: "1" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(pad.getByRole("button", { name: "Стереть цифру" }));
    expect(screen.getByText(`Последние цифры SSCC: ${FIRST_SSCC.slice(0, -1)}`)).toBeTruthy();
  });

  it("listens for a scan only while a box is chosen, and gives the listener up after", () => {
    const registerScan = vi.fn();
    render(
      <ExceptionFlow
        {...flowProps({
          registerScan,
          boxes: [{ id: "a", sscc: FIRST_SSCC, itemCount: 12, closedAt: "x" }],
        })}
      />,
    );
    expect(registerScan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Расформировать короб" }));
    expect(registerScan).toHaveBeenLastCalledWith(expect.any(Function));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(registerScan).toHaveBeenLastCalledWith(null);
  });

  it("says an action whose work rejected as a failed write", async () => {
    const onUndo = vi.fn(async () => {
      throw new Error("nobody answered");
    });
    render(<ExceptionFlow {...flowProps({ openItems: 1, onUndo })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Снять последний код" }));
    });
    expect(
      await screen.findByText(
        "Не удалось записать исключение на этом компьютере. Ничего не сделано.",
      ),
    ).toBeTruthy();
  });

  it("ignores a press for 400 ms after a view opened, and takes it at 400", async () => {
    const clock = { now: 5000 };
    const onUndo = vi.fn(async () => ({ kind: "done", action: "undo" }) as const);
    render(<ExceptionFlow {...flowProps({ openItems: 1, onUndo, clock: () => clock.now })} />);
    clock.now = 5399;
    fireEvent.click(screen.getByRole("button", { name: "Снять последний код" }));
    expect(onUndo).not.toHaveBeenCalled();
    clock.now = 5400;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Снять последний код" }));
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("gives the keyboard back to the scanner when it goes away with the words field open", () => {
    const onTextEntry = vi.fn();
    const view = render(
      <ExceptionFlow
        {...flowProps({
          onTextEntry,
          boxes: [{ id: "a", sscc: FIRST_SSCC, itemCount: 12, closedAt: "x" }],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Расформировать короб" }));
    fireEvent.click(screen.getByRole("button", { name: `${formatSsccHri(FIRST_SSCC)} · 12 шт.` }));
    fireEvent.click(screen.getByRole("button", { name: "Другая причина" }));
    fireEvent.focus(screen.getByLabelText("Причина своими словами (необязательно)"));
    expect(onTextEntry).toHaveBeenLastCalledWith(true);
    view.unmount();
    expect(onTextEntry).toHaveBeenLastCalledWith(false);
  });
});

describe("how the exceptions say what went wrong", () => {
  it("says an open box with no code in it as nothing to take out", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1"]);
    await work.press("Исключения");
    // The code is gone from under the screen (the numbers on it are still the old ones).
    at.db.exec("DELETE FROM floor_codes; UPDATE floor_boxes SET item_count = 0");
    await work.press("Снять последний код");
    const text = await screen.findByText("Открытый короб пуст: снимать нечего.");
    expect(text.closest(".mk-alert--warn")).not.toBeNull();
    expect(exceptionKinds(at)).toEqual([]);
  });

  it("says a box that changed under the operator's hand as to be done again, and writes nothing", async () => {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await scanAll(work, ["A1", "A2"]);
    await work.press("Исключения");
    await work.press("Очистить короб");
    held.holdNext();
    work.pause();
    tap("Очистить короб");
    await held.reached();
    at.db.exec("UPDATE floor_boxes SET item_count = item_count + 1 WHERE closed_at IS NULL");
    held.release();
    await work.settled();
    expect(
      await screen.findByText("Пока вы выбирали, короб изменился. Ничего не сделано — повторите."),
    ).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 2 }]);
  });

  it("says a failed write as an error, and a done one as done", async () => {
    const at = await printStation();
    let broken = false;
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: (statements) =>
        broken ? failingWrites(at.local).transaction(statements) : at.local.transaction(statements),
    };
    const work = renderWork({ local, shift: at.shift });
    await scanAll(work, ["A1", "A2"]);
    await work.press("Исключения");
    broken = true;
    vi.mocked(work.props.onRecorded).mockClear();
    await work.press("Снять последний код");
    const failed = await screen.findByText(
      "Не удалось записать исключение на этом компьютере. Ничего не сделано.",
    );
    expect(failed.closest(".mk-alert--error")).not.toBeNull();
    // A failed write may have been written all the same: the host is asked once more.
    expect(work.props.onRecorded).toHaveBeenCalled();
    broken = false;
    await work.press("Другое действие");
    await work.press("Снять последний код");
    const done = await screen.findByText("Последний код снят из короба.");
    expect(done.closest(".mk-alert--ok")).not.toBeNull();
  });

  it("leaves the boxes already taken apart out of the list that follows", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    await fillBox(work, "Q");
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    await work.press("Расформировать короб");
    await work.scan(`]C100${FIRST_SSCC}`);
    await work.press("Брак по качеству");
    await work.press("Расформировать");
    await screen.findByText("Короб расформирован, его коды свободны.");
    await work.press("Другое действие");
    await work.press("Перепечатать этикетку");
    expect(
      screen.queryByRole("button", { name: `${formatSsccHri(FIRST_SSCC)} · 12 шт.` }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: `${formatSsccHri(SECOND_SSCC)} · 12 шт.` }),
    ).toBeTruthy();
  });

  it("stops the line with the shift unread when the closed boxes cannot be read", async () => {
    const at = await printStation();
    let broken = false;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        broken && sql.includes("disassembled_at IS NULL ORDER BY closed_at")
          ? Promise.reject(new Error("the database does not answer"))
          : at.local.query(sql, params, row),
      transaction: (statements) => at.local.transaction(statements),
    };
    const work = renderWork({ local, shift: at.shift });
    await scanAll(work, ["A1"]);
    broken = true;
    await work.press("Исключения");
    expect(await screen.findByText("Смена не прочитана")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
  });
});
