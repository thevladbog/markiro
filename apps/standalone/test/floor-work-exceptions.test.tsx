import { buildSscc, formatSsccHri } from "@markiro/domain";
import { act, fireEvent, render, screen, within, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { SignalTone } from "@markiro/ui";

import {
  boxesByTail,
  ExceptionFlow,
  MAX_LISTED_BOXES,
  type BoxScanVerdict,
  type ExceptionFlowProps,
} from "../src/floor/exceptions/ExceptionFlow.js";
import type { ClosedBox } from "../src/floor/exceptions/box-exceptions.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { failingWrites, holdingWrites, km, PREFIX, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import {
  FIRST_SSCC,
  jobRows,
  printingSettings,
  printStation,
  renderedText,
  setUpPrinting,
  TSC,
  ZEBRA,
} from "./support/printing.js";
import { lastLine, openBoxLine, PRESS_PAUSE_MS, renderWork } from "./support/work-screen.js";

type Station = Awaited<ReturnType<typeof printStation>>;
type Work = ReturnType<typeof renderWork>;

const SECOND_SSCC = buildSscc(0, PREFIX, 1501);
const PAUSED = "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.";
const FAILED =
  "Не удалось записать исключение на этом компьютере. Возможно, оно всё же записалось: проверьте исключения и числа смены, прежде чем повторять.";
const STALE =
  "Пока вы выбирали, короб изменился. Проверьте числа короба и повторите, если ещё нужно.";
const ZEBRA_LINE = "Печать пойдёт на принтер: Zebra у линии · ZPL · 203 dpi.";
const TSC_LINE = "Печать пойдёт на принтер: TSC на COM4 · TSPL · 300 dpi.";

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

describe("the open box's own «Снять последний код» and «Очистить короб» (the cloud's box instrument)", () => {
  const box = () => within(screen.getByRole("region", { name: "Открытый короб" }));

  it("offers both under the box only while it holds codes and nothing stops the work", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, []);
    expect(box().getByRole("button", { name: "Снять последний код" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(box().getByRole("button", { name: "Очистить короб" })).toHaveProperty("disabled", true);
    await work.scan(km("A1"));
    const undo = box().getByRole("button", { name: "Снять последний код" });
    expect(undo).toHaveProperty("disabled", false);
    expect(undo.style.height).toBe("var(--control-floor)");
    expect(box().getByRole("button", { name: "Очистить короб" })).toHaveProperty("disabled", false);
    work.rerender({ leaving: true });
    expect(box().getByRole("button", { name: "Снять последний код" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("takes the last code out by the exception's own way and words, and the focus comes back to it", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1", "A2", "A3"]);
    await work.press("Снять последний код");
    expect(await screen.findByText("Последний код снят из короба.")).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([{ kind: "undo", reason_code: null, reason_text: null }]);
    expect(work.props.onRecorded).toHaveBeenCalled();
    await work.press("Вернуться к работе");
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
    expect(openBoxLine()).toBe("2 из 12");
    expect(document.activeElement).toBe(box().getByRole("button", { name: "Снять последний код" }));
  });

  it("clears the box only after the exception's own confirmation, the quantity named", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1", "A2"]);
    await work.press("Очистить короб");
    expect(screen.getByRole("group", { name: "Очистить короб?" })).toBeTruthy();
    expect(screen.getByText(/уйдут все коды \(2 шт\.\)/)).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([]);
    await work.press("Очистить короб");
    expect(await screen.findByText("Короб очищен.")).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([{ kind: "clear", reason_code: null, reason_text: null }]);
    await work.press("Вернуться к работе");
    expect(openBoxLine()).toBe("Короб откроется с первым кодом");
  });

  it("goes back from the confirmation with nothing cleared", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1"]);
    await work.press("Очистить короб");
    await work.press("Назад");
    await work.press("Назад");
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
    expect(exceptionKinds(at)).toEqual([]);
    expect(openBoxLine()).toBe("1 из 12");
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
    expect(openBoxLine()).toBe("2 из 12");
    await work.scan(km("A3"));
    expect(openBoxLine()).toBe("3 из 12");
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
    expect(openBoxLine()).toBe("1 из 12");
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
    expect(await screen.findByText(FAILED)).toBeTruthy();
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
    // The leave button never uses `disabled`: it says `aria-disabled` while the leave waits.
    const leave = screen.getByRole("button", { name: "Выйти из смены" });
    expect(leave.hasAttribute("aria-disabled")).toBe(false);
    expect(region().queryByRole("button", { name: "Выйти из смены" })).toBeNull();
    await work.press("Назад");
    work.rerender({ leaving: true });
    expect(screen.getByRole("button", { name: "Исключения" }).hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Выйти из смены" }).getAttribute("aria-disabled"),
    ).toBe("true");
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
    expect(await screen.findByText(STALE)).toBeTruthy();
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
    expect(await screen.findByText(STALE)).toBeTruthy();
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

/** Reaches the confirmation of a reprint of the first box. */
async function toReprintConfirm(work: Work): Promise<void> {
  await work.press("Исключения");
  await screen.findByRole("button", { name: "Перепечатать этикетку" });
  await work.press("Перепечатать этикетку");
  await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
  await work.press("Замятие в принтере");
}

describe("what the reprint says of its printer before it is confirmed", () => {
  it("names the printer the new label will go to, and sends it there", async () => {
    const at = await printStation();
    const work = renderWork(at, { overrides: { onSetup: vi.fn() } });
    await fillBox(work, "P");
    await toReprintConfirm(work);
    expect(await region().findByText(ZEBRA_LINE)).toBeTruthy();
    // A printer is assigned: nothing to set up.
    expect(region().queryByRole("button", { name: "Настроить принтер" })).toBeNull();
    expect(work.shell.sends).toHaveLength(1);
    await work.press("Перепечатать");
    expect(await screen.findByText("Этикетка отправлена на принтер.")).toBeTruthy();
    expect(work.shell.sends.at(-1)?.target).toEqual(ZEBRA.target);
  });

  it("names the printer «Короб» has now, not the one the box's first label came out on", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    expect(work.shell.sends[0]?.target).toEqual(ZEBRA.target);
    await setUpPrinting(at.local, { assignments: { box: "tsc", pallet: null, duplicate: null } });
    await toReprintConfirm(work);
    expect(await region().findByText(TSC_LINE)).toBeTruthy();
    expect(region().queryByText(ZEBRA_LINE)).toBeNull();
    await work.press("Перепечатать");
    expect(await screen.findByText("Этикетка отправлена на принтер.")).toBeTruthy();
    expect(work.shell.sends.at(-1)?.target).toEqual(TSC.target);
  });

  it("says before the confirmation that no printer is assigned, offers the setup, and still writes the exception", async () => {
    const at = await printStation();
    const onSetup = vi.fn();
    const work = renderWork(at, { overrides: { onSetup } });
    await fillBox(work, "P");
    await setUpPrinting(at.local, { assignments: { box: null, pallet: null, duplicate: null } });
    await toReprintConfirm(work);
    const none = await region().findByText(
      /Принтер для этикетки короба не назначен, поэтому она не напечатается/,
    );
    expect(none.textContent).toMatch(/Исключение всё равно будет записано/);
    expect(none.textContent).toMatch(/останется на экране работы/);
    expect(region().queryByText(/Печать пойдёт на принтер/)).toBeNull();
    expect(exceptionKinds(at)).toEqual([]);
    await work.press("Настроить принтер");
    expect(onSetup).toHaveBeenCalledTimes(1);
    expect(exceptionKinds(at)).toEqual([]);
    // Confirmed all the same: the exception and its record are written, the label panel takes over.
    await work.press("Перепечатать");
    expect(await screen.findByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(exceptionKinds(at)).toEqual([
      { kind: "reprint", reason_code: "printer_jam", reason_text: null },
    ]);
    expect(work.shell.sends).toHaveLength(1);
  });

  it("names no printer for a disassembly, which prints nothing", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    await work.press("Расформировать короб");
    await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
    await work.press("Брак по качеству");
    expect(screen.getByText("Расформировать короб?")).toBeTruthy();
    expect(region().queryByText(/Печать пойдёт на принтер/)).toBeNull();
    expect(region().queryByText(/Принтер для этикетки короба не назначен/)).toBeNull();
  });
});

describe("what the exceptions do while the screen has not yet read the shift", () => {
  /** A third code of the open box is being written while the exceptions open behind it. */
  async function openBehindHeldScan() {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await fillBox(work, "P");
    await scanAll(work, ["A1", "A2"]);
    held.holdNext();
    await act(async () => {
      work.scanner.emit(km("A3"));
      await held.reached();
    });
    work.pause();
    tap("Исключения");
    return { at, held, work };
  }

  it("refuses an undo pressed before the opening was settled once a label took the screen, and says so", async () => {
    const { at, held, work } = await openBehindHeldScan();
    work.pause();
    tap("Снять последний код");
    // The label of the first box fails while the third code is still being written.
    at.db.exec("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'");
    held.release();
    await work.settled();
    // Said at once, over the label's panel: the undo was not done.
    expect(screen.getByText("ИСКЛЮЧЕНИЕ НЕ ВЫПОЛНЕНО")).toBeTruthy();
    expect(screen.getByText("Сначала ответьте на сообщение на экране.")).toBeTruthy();
    expect(work.props.signal).toHaveBeenLastCalledWith("error");
    expect(await screen.findByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Исключения" })).toBeNull();
    expect(exceptionKinds(at)).toEqual([]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes")).toEqual([{ n: 15 }]);
  });

  it("does not offer «Очистить короб» before the numbers were read, and names the real quantity after", async () => {
    const { held, work } = await openBehindHeldScan();
    // The screen still shows the two codes it knew; the third is being written.
    expect(openBoxLine()).toBe("2 из 12");
    expect(screen.getByRole("button", { name: "Очистить короб" }).hasAttribute("disabled")).toBe(
      true,
    );
    held.release();
    await work.settled();
    expect(screen.getByRole("button", { name: "Очистить короб" }).hasAttribute("disabled")).toBe(
      false,
    );
    await work.press("Очистить короб");
    expect(screen.getByText(/уйдут все коды \(3 шт\.\)/)).toBeTruthy();
  });
});

describe("what the box choice says of a scan", () => {
  it("takes the first of two scans that land before the screen is drawn, and refuses the second in words", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    await fillBox(work, "Q");
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    await work.press("Расформировать короб");
    await act(async () => {
      work.scanner.emit(`]C100${FIRST_SSCC}`);
      work.scanner.emit(`]C100${SECOND_SSCC}`);
      await work.gate.drain();
    });
    expect(screen.getByText(`Короб ${formatSsccHri(FIRST_SSCC)}`)).toBeTruthy();
    expect(screen.queryByText(`Короб ${formatSsccHri(SECOND_SSCC)}`)).toBeNull();
    expect(lastLine()).toBe(PAUSED);
    expect(exceptionKinds(at)).toEqual([]);
  });

  it("gives every verdict on a scan of the box choice its tone and its words, like the label's check", async () => {
    const at = await printStation();
    const signal = vi.fn<(tone: SignalTone) => void>();
    const work = renderWork(at, { overrides: { signal } });
    await fillBox(work, "P");
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    await work.press("Расформировать короб");
    signal.mockClear();
    await work.scan(km("P99"));
    expect(signal).toHaveBeenLastCalledWith("error");
    expect(screen.getByText("НЕ SSCC")).toBeTruthy();
    signal.mockClear();
    await work.scan(`]C100${SECOND_SSCC}`);
    expect(signal).toHaveBeenLastCalledWith("error");
    expect(screen.getByText("НЕ НАЙДЕНО СРЕДИ ЗАКРЫТЫХ")).toBeTruthy();
    signal.mockClear();
    await work.scan(`]C100${FIRST_SSCC}`);
    expect(signal).toHaveBeenLastCalledWith("ok");
    expect(screen.getByText(`Короб ${formatSsccHri(FIRST_SSCC)}`)).toBeTruthy();
  });
});

describe("what the exceptions tell the operator cannot be undone", () => {
  it("tells to scan the code again after an undo, and that a disassembly cannot be undone", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work, "P");
    await scanAll(work, ["A1"]);
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    await work.press("Расформировать короб");
    await work.press(`${formatSsccHri(FIRST_SSCC)} · 12 шт.`);
    await work.press("Брак по качеству");
    expect(region().getByText("Отменить это нельзя: снимите этикетку с короба.")).toBeTruthy();
    await work.press("Назад");
    await work.press("Назад");
    await work.press("Назад");
    await work.press("Снять последний код");
    await screen.findByText("Последний код снят из короба.");
    expect(region().getByText("Если сняли по ошибке — отсканируйте этот код снова.")).toBeTruthy();
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

describe("the exceptions screen by itself", () => {
  it("says there is nothing to do when the box is empty and no box is closed, and offers nothing", async () => {
    await mount(<ExceptionFlow {...flowProps()} />);
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

  it("does not call the work done while the closed boxes are read", async () => {
    await mount(<ExceptionFlow {...flowProps({ openItems: 0, boxes: null })} />);
    expect(screen.getByText("Читаем закрытые короба…")).toBeTruthy();
    expect(screen.queryByText(/Сейчас исключений нет/)).toBeNull();
  });

  it("waits for the closed boxes without calling the work done, and offers only the open box's undo", async () => {
    await mount(<ExceptionFlow {...flowProps({ openItems: 3, boxes: null })} />);
    expect(screen.getByText("Читаем закрытые короба…")).toBeTruthy();
    expect(screen.queryByText(/Сейчас исключений нет/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Снять последний код" }).hasAttribute("disabled"),
    ).toBe(false);
    // The quantity it would name is not trusted before the numbers were read.
    expect(screen.getByRole("button", { name: "Очистить короб" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(
      screen.getByRole("button", { name: "Перепечатать этикетку" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("lists twelve boxes at most and says how many more the digits will find", async () => {
    const boxes: ClosedBox[] = Array.from({ length: 15 }, (_, index) => ({
      id: `box-${index}`,
      sscc: buildSscc(0, PREFIX, 1500 + index),
      itemCount: 12,
      closedAt: "2026-10-08T06:15:00.000Z",
    }));
    await mount(<ExceptionFlow {...flowProps({ boxes })} />);
    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку" }));
    expect(screen.getAllByRole("button", { name: /шт\.$/ })).toHaveLength(MAX_LISTED_BOXES);
    expect(screen.getByText("Ещё коробов: 3. Наберите больше цифр.")).toBeTruthy();
  });

  it("takes no more digits than an SSCC has, and erases them one by one", async () => {
    await mount(
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

  it("listens for a scan only while a box is chosen, and gives the listener up after", async () => {
    const registerScan = vi.fn();
    await mount(
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

  /** The confirmation of a reprint of the one closed box, by the buttons. */
  function toConfirm(): void {
    fireEvent.click(screen.getByRole("button", { name: "Перепечатать этикетку" }));
    fireEvent.click(screen.getByRole("button", { name: `${formatSsccHri(FIRST_SSCC)} · 12 шт.` }));
    fireEvent.click(screen.getByRole("button", { name: "Замятие в принтере" }));
  }
  const ONE_BOX = [{ id: "a", sscc: FIRST_SSCC, itemCount: 12, closedAt: "x" }];

  it("waits for the printer's name before a reprint can be confirmed", async () => {
    let answer: (settings: ReturnType<typeof printingSettings>) => void = () => undefined;
    const loadSettings = vi.fn(
      () =>
        new Promise<ReturnType<typeof printingSettings>>((resolve) => {
          answer = resolve;
        }),
    );
    await mount(<ExceptionFlow {...flowProps({ boxes: ONE_BOX, loadSettings })} />);
    toConfirm();
    expect(screen.getByRole("button", { name: "Перепечатать" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.queryByText(/Печать пойдёт на принтер/)).toBeNull();
    await act(async () => {
      answer(printingSettings());
    });
    expect(screen.getByText(ZEBRA_LINE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Перепечатать" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("says that the printers could not be read, and lets the operator decide", async () => {
    const loadSettings = vi.fn(async () => {
      throw new Error("the database does not answer");
    });
    const onReprint = vi.fn(async () => ({ kind: "done", action: "reprint" }) as const);
    await mount(<ExceptionFlow {...flowProps({ boxes: ONE_BOX, loadSettings, onReprint })} />);
    toConfirm();
    expect(await screen.findByText("Не удалось прочитать настройку принтеров.")).toBeTruthy();
    expect(screen.queryByText(/Печать пойдёт на принтер/)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Перепечатать" }));
    });
    expect(onReprint).toHaveBeenCalledTimes(1);
  });

  it("offers the setup of the printers only where a setup is given", async () => {
    const none = async () =>
      printingSettings({ assignments: { box: null, pallet: null, duplicate: null } });
    const first = await mount(
      <ExceptionFlow {...flowProps({ boxes: ONE_BOX, loadSettings: none })} />,
    );
    toConfirm();
    expect(await screen.findByText(/Принтер для этикетки короба не назначен/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Настроить принтер" })).toBeNull();
    first.unmount();
    const onSetup = vi.fn();
    await mount(<ExceptionFlow {...flowProps({ boxes: ONE_BOX, loadSettings: none, onSetup })} />);
    toConfirm();
    fireEvent.click(await screen.findByRole("button", { name: "Настроить принтер" }));
    expect(onSetup).toHaveBeenCalledTimes(1);
  });

  it("answers a scan of the box choice with its verdict, and hands back one that comes after the choice", async () => {
    const registerScan = vi.fn<ExceptionFlowProps["registerScan"]>();
    const second = buildSscc(0, PREFIX, 1501);
    await mount(
      <ExceptionFlow
        {...flowProps({
          registerScan,
          boxes: [
            { id: "a", sscc: FIRST_SSCC, itemCount: 12, closedAt: "x" },
            { id: "b", sscc: second, itemCount: 12, closedAt: "x" },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Расформировать короб" }));
    const listener = registerScan.mock.calls.at(-1)?.[0];
    if (listener === null || listener === undefined) throw new Error("no listener");
    const verdicts: (BoxScanVerdict | null)[] = [];
    act(() => {
      verdicts.push(listener(km("P1")));
      verdicts.push(listener(`]C100${buildSscc(0, PREFIX, 1999)}`));
      // Two labels in one tick: the first picks the box, the second is not the choice any more.
      verdicts.push(listener(`]C100${FIRST_SSCC}`));
      verdicts.push(listener(`]C100${second}`));
    });
    expect(verdicts).toEqual(["not_sscc", "not_found", "taken", null]);
    expect(screen.getByText(`Короб ${formatSsccHri(FIRST_SSCC)}`)).toBeTruthy();
  });

  it("says an action whose work rejected as a failed write", async () => {
    const onUndo = vi.fn(async () => {
      throw new Error("nobody answered");
    });
    await mount(<ExceptionFlow {...flowProps({ openItems: 1, onUndo })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Снять последний код" }));
    });
    expect(await screen.findByText(FAILED)).toBeTruthy();
  });

  it("ignores a press for 400 ms after a view opened, and takes it at 400", async () => {
    const clock = { now: 5000 };
    const onUndo = vi.fn(async () => ({ kind: "done", action: "undo" }) as const);
    await mount(<ExceptionFlow {...flowProps({ openItems: 1, onUndo, clock: () => clock.now })} />);
    clock.now = 5399;
    fireEvent.click(screen.getByRole("button", { name: "Снять последний код" }));
    expect(onUndo).not.toHaveBeenCalled();
    clock.now = 5400;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Снять последний код" }));
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("gives the keyboard back to the scanner when it goes away with the words field open", async () => {
    const onTextEntry = vi.fn();
    const view = await mount(
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
    expect(await screen.findByText(STALE)).toBeTruthy();
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
    const failed = await screen.findByText(FAILED);
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
