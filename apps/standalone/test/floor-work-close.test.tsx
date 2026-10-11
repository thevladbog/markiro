import { formatSsccHri } from "@markiro/domain";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { averagePerBox, deviation, sameSummary } from "../src/floor/close/ShiftClosePanel.js";
import type { CloseSummary } from "../src/floor/close/shift-close.js";
import { OPEN_JOB_READ_SQL } from "../src/floor/print/print-jobs.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import {
  ENTERED,
  enteredShift,
  failingWrites,
  holdingWrites,
  km,
  rows,
  SHIFT_ID,
} from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { FIRST_SSCC, printStation } from "./support/printing.js";
import { lastLine, renderWork, type WorkHarness } from "./support/work-screen.js";

type Station = Awaited<ReturnType<typeof printStation>>;

const TITLE = "Закрытие смены OCT26-004";
const CLOSED_TITLE = "Смена OCT26-004 закрыта на этой станции";
const CLOSED_BODY = "Смена закрыта на этой станции. Данные будут отправлены автоматически.";
const REFUSED = "Скан не принят: смена закрыта на этой станции.";
const PAUSED = "Скан не принят: работа остановлена — сначала ответьте на сообщение на экране.";
const FAILED = "Не удалось записать закрытие на этом компьютере. Смена не закрыта — повторите.";
const STALE = "Пока вы смотрели итоги, смена изменилась: итоги посчитаны заново.";
const UNKNOWN =
  "Не удалось записать закрытие или проверить, записалось ли оно. Смена могла закрыться: нажмите «Подтвердить закрытие» ещё раз — программа проверит.";

async function scanAll(work: WorkHarness, serials: readonly string[]): Promise<void> {
  await work.scanner.listening();
  await work.settled();
  for (const serial of serials) await work.scan(km(serial));
}

/** Twelve codes: the box fills, closes by itself, and its label goes to the printer. */
async function fillBox(work: WorkHarness, prefix = "P"): Promise<void> {
  await scanAll(
    work,
    Array.from({ length: 12 }, (_, index) => `${prefix}${index}`),
  );
}

/** The summary of the close, as the screen shows it. */
function summary() {
  return within(screen.getByRole("region", { name: TITLE }));
}

function fact(name: string): string | null {
  const term = summary()
    .getAllByText(name)
    .find((element) => element.tagName === "DT");
  return term?.nextElementSibling?.textContent ?? null;
}

/** «Закрыть смену» pressed and the summary read. */
async function openSummary(work: WorkHarness): Promise<void> {
  await work.press("Закрыть смену");
  await screen.findByRole("region", { name: TITLE });
}

/** A click that is not a press of the harness: the clock stays where it is. */
function tap(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

function outboxKinds(at: Station): unknown[] {
  return rows(at.db, "SELECT kind FROM outbox WHERE shift_id = ? ORDER BY seq", SHIFT_ID).map(
    (row) => row["kind"],
  );
}

function localState(at: Station): unknown {
  return rows(at.db, "SELECT local_state FROM floor_shifts WHERE id = ?", SHIFT_ID)[0]?.[
    "local_state"
  ];
}

function closedRecords(at: Station): { data: Record<string, unknown> }[] {
  return rows(at.db, "SELECT payload FROM outbox WHERE kind = 'shift_closed'").map((row) =>
    JSON.parse(String(row["payload"])),
  );
}

/** How many times the screen has told the floor of a record so far. */
function recorded(work: WorkHarness): number {
  return vi.mocked(work.props.onRecorded).mock.calls.length;
}

function codes(at: Station): unknown {
  return rows(at.db, "SELECT count(*) AS n FROM floor_codes")[0]?.["n"];
}

/** A code of the closed box lost from outside the work queue (a writer the screen does not know). */
function loseACode(at: Station): void {
  at.db.exec("DELETE FROM floor_codes WHERE rowid = (SELECT max(rowid) FROM floor_codes)");
}

function pairingShifts(local: LocalExecutor, onQuery: (sql: string) => void): LocalExecutor {
  return {
    query: (sql, params, row) => {
      onQuery(sql);
      return local.query(sql, params, row);
    },
    transaction: (statements) => local.transaction(statements),
  };
}

describe("the close of a shift on the work screen", () => {
  it("shows the summary, asks one of the six reasons when the plan is not met, and closes without the host", async () => {
    const at = await printStation();
    const onLeave = vi.fn();
    const work = renderWork(at, { onLeave });
    await fillBox(work);
    await openSummary(work);
    expect(fact("Товар")).toBe("Молоко 3,2% 0,9 л");
    expect(fact("План")).toBe("1\u00a0200");
    expect(fact("Факт")).toBe("12");
    expect(fact("Отклонение")).toBe("−1\u00a0188");
    expect(fact("Коробов закрыто")).toBe("1");
    expect(fact("В среднем в коробе")).toBe("12");
    // The plan's result in words, and what the press cannot take back.
    expect(summary().getByText("План не выполнен: не хватает 1 188 шт.")).toBeTruthy();
    expect(
      summary().getByText("Закрытие нельзя отменить: в смену больше нельзя сканировать."),
    ).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Подтвердить закрытие" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await work.press("Недостаток сырья");
    expect(
      screen.getByRole("button", { name: "Недостаток сырья" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Остановка оборудования" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: "Подтвердить закрытие" }).hasAttribute("disabled"),
    ).toBe(false);
    const before = recorded(work);
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(screen.getByText(CLOSED_BODY)).toBeTruthy();
    expect(screen.getByText("Принято: 12 шт., коробов: 1.")).toBeTruthy();
    expect(outboxKinds(at).at(-1)).toBe("shift_closed");
    expect(closedRecords(at)).toHaveLength(1);
    expect(closedRecords(at)[0]).toMatchObject({
      data: {
        plannedQtySnapshot: 1_200,
        actualQty: 12,
        closedBoxCount: 1,
        reasonCode: "material_shortage",
      },
    });
    expect(localState(at)).toBe("closing");
    expect(recorded(work)).toBe(before + 1);
    // A closed shift takes no scan again, and says so by flash and by tone.
    vi.mocked(work.props.signal ?? vi.fn()).mockClear();
    await work.scan(km("Z1"));
    expect(lastLine()).toBe(REFUSED);
    expect(vi.mocked(work.props.signal ?? vi.fn()).mock.calls).toEqual([["error"]]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 12 }]);
    await work.press("К списку смен");
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("asks no reason when the plan is met", async () => {
    const at = await printStation();
    const shift = await enteredShift(at.local, { ...ENTERED, plannedQty: 12 });
    const work = renderWork({ local: at.local, shift });
    await fillBox(work);
    await openSummary(work);
    expect(fact("Отклонение")).toBe("0");
    expect(summary().getByText("План выполнен.")).toBeTruthy();
    expect(
      screen.queryByRole("group", { name: "Факт не совпадает с планом. Выберите причину:" }),
    ).toBeNull();
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(closedRecords(at)[0]).toMatchObject({ data: { reasonCode: null, actualQty: 12 } });
  });

  it("is kept open by an open box with codes and sends the operator back to the work", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1", "A2"]);
    await openSummary(work);
    expect(
      await screen.findByText(
        "В открытом коробе 2 шт. Сначала закройте его или очистите в «Исключениях».",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Подтвердить закрытие" })).toBeNull();
    await work.press("Назад к работе");
    await work.scan(km("A3"));
    expect(screen.getByText("3 из 12")).toBeTruthy();
    expect(localState(at)).toBeNull();
  });

  it("waits for a label that waits; once it is skipped the shift closes", async () => {
    const at = await printStation();
    const shell = fakeHardware(async () => ({ sent: false, code: "not_sent" }));
    const work = renderWork(at, { shell });
    await fillBox(work);
    expect(screen.getByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Закрыть смену" }).hasAttribute("disabled")).toBe(
      true,
    );
    await work.press("Продолжить без этикетки");
    await work.press("Продолжить без этикетки");
    await openSummary(work);
    await work.press("Остановка оборудования");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(outboxKinds(at).slice(-2)).toEqual(["box_label", "shift_closed"]);
  });

  it("counts the scan taken before the press: the summary waits for it and finds its box open", async () => {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await fillBox(work);
    held.holdNext();
    act(() => work.scanner.emit(km("Q1")));
    await held.reached();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть смену" }));
    // The summary waits for the scan in the queue, however long the write takes.
    await act(async () => {
      for (let turn = 0; turn < 10; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
    expect(screen.getByText("Считаем итоги смены…")).toBeTruthy();
    held.release();
    await work.settled();
    expect(
      await screen.findByText(
        "В открытом коробе 1 шт. Сначала закройте его или очистите в «Исключениях».",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Подтвердить закрытие" })).toBeNull();
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 13 }]);
  });

  it("puts the scan pressed before «Закрыть смену» into the record: its box closes first, the summary counts it", async () => {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await scanAll(
      work,
      Array.from({ length: 11 }, (_, index) => `P${index}`),
    );
    // The twelfth code is on its way into the database when «Закрыть смену» is pressed.
    held.holdNext();
    act(() => work.scanner.emit(km("P11")));
    await held.reached();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть смену" }));
    await act(async () => {
      for (let turn = 0; turn < 10; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
    expect(screen.getByText("Считаем итоги смены…")).toBeTruthy();
    expect(outboxKinds(at)).not.toContain("shift_closed");
    held.release();
    await work.settled();
    await screen.findByRole("region", { name: TITLE });
    expect(fact("Факт")).toBe("12");
    expect(fact("Коробов закрыто")).toBe("1");
    await work.press("Недостаток сырья");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(closedRecords(at)).toHaveLength(1);
    expect(closedRecords(at)[0]).toMatchObject({ data: { actualQty: 12, closedBoxCount: 1 } });
    expect(codes(at)).toBe(12);
    // And nothing of the shift follows the record.
    expect(outboxKinds(at).at(-1)).toBe("shift_closed");
  });

  it("refuses a scan that arrives while the summary is read or shown, and writes nothing for it", async () => {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await fillBox(work);
    held.holdNext();
    act(() => work.scanner.emit(km("Q1")));
    await held.reached();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть смену" }));
    act(() => work.scanner.emit(km("Q2")));
    held.release();
    await work.settled();
    await screen.findByRole("region", { name: TITLE });
    expect(lastLine()).toBe(PAUSED);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 13 }]);
    await work.scan(km("Q3"));
    expect(lastLine()).toBe(PAUSED);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 13 }]);
  });

  it("never holds the operator: «Выйти из смены» stays open on the summary and after the close", async () => {
    const at = await printStation();
    const onLeave = vi.fn();
    const work = renderWork(at, { onLeave });
    await fillBox(work);
    await openSummary(work);
    await work.press("Выйти из смены");
    expect(onLeave).toHaveBeenCalledTimes(1);
    await work.press("Ошибка в плановом количестве");
    await work.press("Подтвердить закрытие");
    await screen.findByText(CLOSED_TITLE);
    await work.press("Выйти из смены");
    expect(onLeave).toHaveBeenCalledTimes(2);
  });

  it("says a failed write, leaves the shift open, and lets the operator go back to the work", async () => {
    const at = await printStation();
    let broken = false;
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: (statements) =>
        broken ? failingWrites(at.local).transaction(statements) : at.local.transaction(statements),
    };
    const work = renderWork({ local, shift: at.shift });
    await fillBox(work);
    await openSummary(work);
    await work.press("Производственный брак");
    const before = recorded(work);
    broken = true;
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(localState(at)).toBeNull();
    expect(outboxKinds(at)).not.toContain("shift_closed");
    // Nothing was recorded: the status bar is not told of a record.
    expect(recorded(work)).toBe(before);
    broken = false;
    await work.press("Назад к работе");
    await work.scan(km("A1"));
    expect(screen.getByText("1 из 12")).toBeTruthy();
  });

  it("can try the close again after a failed write, and is not held by the first try", async () => {
    const at = await printStation();
    let broken = true;
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: (statements) =>
        broken ? failingWrites(at.local).transaction(statements) : at.local.transaction(statements),
    };
    const work = renderWork({ local, shift: at.shift });
    broken = false;
    await fillBox(work);
    await openSummary(work);
    await work.press("Производственный брак");
    broken = true;
    await work.press("Подтвердить закрытие");
    await screen.findByText(FAILED);
    // The buttons are alive again after the failed write.
    const confirm = screen.getByRole("button", { name: "Подтвердить закрытие" });
    expect(confirm.getAttribute("aria-disabled")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Назад к работе" }).getAttribute("aria-disabled"),
    ).toBe(null);
    broken = false;
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(closedRecords(at)).toHaveLength(1);
  });

  it("finds the shift closed when the write committed and its answer was lost: the closed stop, not an error", async () => {
    const at = await printStation();
    const lose = { now: false };
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: async (statements) => {
        await at.local.transaction(statements);
        if (lose.now) throw new LocalDbError("statement_failed", "the answer was lost");
        return [];
      },
    };
    const work = renderWork({ local, shift: at.shift });
    await fillBox(work);
    await openSummary(work);
    await work.press("Производственный брак");
    const before = recorded(work);
    lose.now = true;
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(screen.getByText("Принято: 12 шт., коробов: 1.")).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(closedRecords(at)).toHaveLength(1);
    expect(localState(at)).toBe("closing");
    // The record is there to be sent: the status bar is told.
    expect(recorded(work)).toBe(before + 1);
    await work.scan(km("Z1"));
    expect(lastLine()).toBe(REFUSED);
  });

  it("shows the closed stop when the shift was closed meanwhile by another writer, and writes no second record", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work);
    await openSummary(work);
    await work.press("Производственный брак");
    const before = recorded(work);
    at.db.exec("UPDATE floor_shifts SET local_state = 'closing'");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(closedRecords(at)).toHaveLength(0);
    // This screen wrote no record, but the close it found may not have been told: the floor is
    // told once, which is harmless when the record has been told already.
    expect(recorded(work)).toBe(before + 1);
  });

  it("shows the closed stop at once when «Закрыть смену» finds the shift closed, and tells the floor", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work);
    const before = recorded(work);
    at.db.exec("UPDATE floor_shifts SET local_state = 'closing'");
    await work.press("Закрыть смену");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(screen.getByText("Принято: 12 шт., коробов: 1.")).toBeTruthy();
    // Not a summary with «Назад к работе»: a live screen on a closed shift takes no scan.
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
    expect(screen.queryByRole("button", { name: "Назад к работе" })).toBeNull();
    expect(recorded(work)).toBe(before + 1);
    await work.scan(km("Z1"));
    expect(lastLine()).toBe(REFUSED);
  });

  it("does not claim the shift open when the write's answer was lost and the shift could not be read back: a second press finds it closed and tells the floor", async () => {
    const at = await printStation();
    const lose = { now: false, blind: false };
    const local: LocalExecutor = {
      query: (sql, params, row) => {
        if (lose.blind) throw new LocalDbError("statement_failed", "the database does not answer");
        return at.local.query(sql, params, row);
      },
      transaction: async (statements) => {
        await at.local.transaction(statements);
        if (lose.now) {
          lose.blind = true;
          throw new LocalDbError("statement_failed", "the answer was lost");
        }
        return [];
      },
    };
    const work = renderWork({ local, shift: at.shift });
    await fillBox(work);
    await openSummary(work);
    await work.press("Производственный брак");
    const before = recorded(work);
    lose.now = true;
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(UNKNOWN)).toBeTruthy();
    // The write did commit; the screen does not say that the shift is open.
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(localState(at)).toBe("closing");
    expect(recorded(work)).toBe(before);
    expect(screen.getByRole("button", { name: "Подтвердить закрытие" })).toBeTruthy();
    // A second press that cannot read it back either shows the same note again; the tap that
    // follows at once is the echo of the first, and the shift stays as the screen shows it.
    await work.press("Подтвердить закрытие");
    expect(screen.getByText(UNKNOWN)).toBeTruthy();
    lose.now = false;
    lose.blind = false;
    tap("Подтвердить закрытие");
    await work.settled();
    expect(screen.queryByText(CLOSED_TITLE)).toBeNull();
    expect(recorded(work)).toBe(before);
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(closedRecords(at)).toHaveLength(1);
    // The fresh read found the close: the status bar and the outbox are told of its record.
    expect(recorded(work)).toBe(before + 1);
  });

  it("names the label that waits when the shift is shown again after a failed write", async () => {
    const at = await printStation();
    const lose = { now: false };
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: async (statements) => {
        if (lose.now) {
          // The write fails, and a label turns to wait meanwhile.
          at.db.exec("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'");
          throw new LocalDbError("statement_failed", "disk");
        }
        return at.local.transaction(statements);
      },
    };
    const work = renderWork({ local, shift: at.shift });
    await fillBox(work);
    await openSummary(work);
    await work.press("Производственный брак");
    lose.now = true;
    await work.press("Подтвердить закрытие");
    expect(
      await screen.findByText(
        `Этикетка короба ${formatSsccHri(FIRST_SSCC)} ещё ждёт решения. Решите её, затем закройте смену.`,
      ),
    ).toBeTruthy();
    expect(screen.getByText(FAILED)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Перейти к этикетке" })).toBeTruthy();
  });

  it("restarts the guard over «Подтвердить закрытие» at every showing of the summary, two alike in a row too", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work);
    await openSummary(work);
    await work.press("Производственный брак");
    loseACode(at);
    await work.press("Подтвердить закрытие");
    await vi.waitFor(() => expect(fact("Факт")).toBe("11"));
    expect(screen.getByText(STALE)).toBeTruthy();
    // The second showing says the same: the note is the same, the blocker is the same.
    work.pause();
    loseACode(at);
    await work.press("Подтвердить закрытие");
    await vi.waitFor(() => expect(fact("Факт")).toBe("10"));
    expect(screen.getByText(STALE)).toBeTruthy();
    // A second tap, as the first one's echo, lands on the button the new summary put there.
    tap("Подтвердить закрытие");
    await work.settled();
    expect(localState(at)).toBeNull();
    expect(closedRecords(at)).toHaveLength(0);
    expect(screen.queryByText(CLOSED_TITLE)).toBeNull();
    work.clock.now += 399;
    tap("Подтвердить закрытие");
    await work.settled();
    expect(localState(at)).toBeNull();
    work.clock.now += 1;
    tap("Подтвердить закрытие");
    await work.settled();
    expect(await screen.findByText("Принято: 10 шт., коробов: 1.")).toBeTruthy();
    expect(closedRecords(at)).toHaveLength(1);
  });

  it("does not leave an unhandled rejection when the screen cannot tell the floor of the close: the stop says the write failed", async () => {
    const at = await printStation();
    const onRecorded = vi.fn();
    const work = renderWork(at, { overrides: { onRecorded } });
    await fillBox(work);
    await openSummary(work);
    await work.press("Производственный брак");
    onRecorded.mockImplementation(() => {
      throw new Error("the status bar is gone");
    });
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText("Скан не записан")).toBeTruthy();
    // The close itself was written: the shift is closing and its record waits in the outbox.
    expect(localState(at)).toBe("closing");
    expect(closedRecords(at)).toHaveLength(1);
    // The close gate is open again: nothing keeps the work from ending.
    await work.settled();
    expect(work.gate.pending()).toBe(0);
  });

  it("never closes on numbers the operator did not see: a code lost since the summary shows a new summary", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work);
    await openSummary(work);
    expect(fact("Факт")).toBe("12");
    await work.press("Производственный брак");
    loseACode(at);
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(STALE)).toBeTruthy();
    // The note is an alert of the work screen's polite region: it has no role of its own.
    expect(screen.getByText(STALE).closest(".mk-alert")?.getAttribute("role")).toBe("presentation");
    expect(fact("Факт")).toBe("11");
    expect(localState(at)).toBeNull();
    expect(outboxKinds(at)).not.toContain("shift_closed");
    // The reason chosen for the old numbers stands while the plan is still unmet; the new numbers close.
    expect(
      screen.getByRole("button", { name: "Производственный брак" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText("Принято: 11 шт., коробов: 1.")).toBeTruthy();
    expect(closedRecords(at)[0]).toMatchObject({
      data: { actualQty: 11, reasonCode: "production_defect" },
    });
  });

  it("never closes on stale numbers when the shift changes inside the write: the model's stale re-reads the summary", async () => {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await fillBox(work);
    await openSummary(work);
    await work.press("Производственный брак");
    held.holdNext();
    act(() => tap("Подтвердить закрытие"));
    await held.reached();
    loseACode(at);
    held.release();
    await work.settled();
    expect(await screen.findByText(STALE)).toBeTruthy();
    expect(fact("Факт")).toBe("11");
    expect(localState(at)).toBeNull();
    expect(outboxKinds(at)).not.toContain("shift_closed");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText("Принято: 11 шт., коробов: 1.")).toBeTruthy();
    expect(closedRecords(at)).toHaveLength(1);
  });

  it("drops the reason the new numbers do not need, and sends none", async () => {
    const at = await printStation();
    const shift = await enteredShift(at.local, { ...ENTERED, plannedQty: 11 });
    const work = renderWork({ local: at.local, shift });
    await fillBox(work);
    await openSummary(work);
    expect(fact("Отклонение")).toBe("+1");
    expect(summary().getByText("Принято больше плана на 1 шт.")).toBeTruthy();
    await work.press("Недостаток сырья");
    loseACode(at);
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(STALE)).toBeTruthy();
    expect(fact("Отклонение")).toBe("0");
    expect(
      screen.queryByRole("group", { name: "Факт не совпадает с планом. Выберите причину:" }),
    ).toBe(null);
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(closedRecords(at)[0]).toMatchObject({ data: { actualQty: 11, reasonCode: null } });
  });

  it("asks for a reason when the plan turns unmet between the summary and the write", async () => {
    const at = await printStation();
    const shift = await enteredShift(at.local, { ...ENTERED, plannedQty: 12 });
    let copyReads = 0;
    const local = pairingShifts(at.local, (sql) => {
      if (sql.includes("FROM floor_shifts WHERE host_id")) {
        copyReads += 1;
        // The summary, the screen's own check before the write, and then the model's.
        if (copyReads === 3) at.db.exec("UPDATE floor_shifts SET planned_qty = 1200");
      }
    });
    const work = renderWork({ local, shift });
    await fillBox(work);
    await openSummary(work);
    expect(fact("Отклонение")).toBe("0");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText("Выберите причину расхождения.")).toBeTruthy();
    expect(fact("План")).toBe("1\u00a0200");
    expect(
      screen.getByRole("button", { name: "Подтвердить закрытие" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(localState(at)).toBeNull();
    expect(closedRecords(at)).toHaveLength(0);
    await work.press("Недостаток сырья");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(closedRecords(at)[0]).toMatchObject({
      data: { plannedQtySnapshot: 1_200, reasonCode: "material_shortage" },
    });
  });

  it("names the label that waits, sends the operator to it, and closes once it is decided", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work);
    // A label turns to wait behind the screen's back (the screen is on its work, no stop stands).
    at.db.exec("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'");
    await openSummary(work);
    expect(
      await screen.findByText(
        `Этикетка короба ${formatSsccHri(FIRST_SSCC)} ещё ждёт решения. Решите её, затем закройте смену.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Подтвердить закрытие" })).toBeNull();
    await work.press("Перейти к этикетке");
    expect(await screen.findByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
    await work.press("Продолжить без этикетки");
    await work.press("Продолжить без этикетки");
    await openSummary(work);
    await work.press("Остановка оборудования");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
  });

  it("ignores a second tap just after the summary appears: a double tap closes nothing", async () => {
    const at = await printStation();
    const shift = await enteredShift(at.local, { ...ENTERED, plannedQty: 12 });
    const work = renderWork({ local: at.local, shift });
    await fillBox(work);
    await work.press("Закрыть смену");
    await screen.findByRole("region", { name: TITLE });
    // The plan is met: «Подтвердить закрытие» is live the moment the summary is up.
    expect(
      screen.getByRole("button", { name: "Подтвердить закрытие" }).hasAttribute("disabled"),
    ).toBe(false);
    tap("Подтвердить закрытие");
    await work.settled();
    expect(localState(at)).toBeNull();
    expect(screen.queryByText(CLOSED_TITLE)).toBeNull();
    expect(closedRecords(at)).toHaveLength(0);
    // 399 ms are still too soon, 400 are an operator's own press.
    work.clock.now += 399;
    tap("Подтвердить закрытие");
    await work.settled();
    expect(localState(at)).toBeNull();
    work.clock.now += 1;
    tap("Подтвердить закрытие");
    await work.settled();
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
  });

  it("ignores a stray tap on a reason, on «Назад к работе» and on «К списку смен» just after their view appears", async () => {
    const at = await printStation();
    const onLeave = vi.fn();
    const work = renderWork(at, { onLeave });
    await fillBox(work);
    await work.press("Закрыть смену");
    await screen.findByRole("region", { name: TITLE });
    tap("Недостаток сырья");
    expect(
      screen.getByRole("button", { name: "Недостаток сырья" }).getAttribute("aria-pressed"),
    ).toBe("false");
    tap("Назад к работе");
    expect(screen.getByRole("region", { name: TITLE })).toBeTruthy();
    await work.press("Недостаток сырья");
    await work.press("Подтвердить закрытие");
    await screen.findByText(CLOSED_TITLE);
    tap("К списку смен");
    expect(onLeave).not.toHaveBeenCalled();
    await work.press("К списку смен");
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("does one close for a double press, and one job in the work queue", async () => {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await fillBox(work);
    await openSummary(work);
    await work.press("Недостаток сырья");
    held.holdNext();
    work.clock.now += 1_000;
    act(() => {
      tap("Подтвердить закрытие");
      tap("Подтвердить закрытие");
    });
    await held.reached();
    expect(work.gate.pending()).toBe(1);
    held.release();
    await work.settled();
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(closedRecords(at)).toHaveLength(1);
  });

  it("starts no close once the leave began, and a leave in the middle of the summary writes nothing", async () => {
    const at = await printStation();
    const leaving = { now: false };
    const work = renderWork(at, { overrides: { isLeaving: () => leaving.now } });
    await fillBox(work);
    await openSummary(work);
    await work.press("Недостаток сырья");
    leaving.now = true;
    await work.press("Подтвердить закрытие");
    expect(localState(at)).toBeNull();
    expect(closedRecords(at)).toHaveLength(0);
    expect(screen.queryByText(CLOSED_TITLE)).toBeNull();
    // The buttons that go away stay on the keyboard.
    work.rerender({ leaving: true });
    expect(screen.getByRole("button", { name: "Закрыть смену" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("opens no summary once the leave began", async () => {
    const at = await printStation();
    const leaving = { now: false };
    const work = renderWork(at, { overrides: { isLeaving: () => leaving.now } });
    await fillBox(work);
    leaving.now = true;
    await work.press("Закрыть смену");
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
    expect(screen.queryByText("Считаем итоги смены…")).toBeNull();
    // And the button itself says so once the screen is told: nothing else stops the work here.
    work.rerender({ leaving: true });
    expect(screen.getByRole("button", { name: "Закрыть смену" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("keeps «К списку смен» and «Выйти из смены» of the closed shift on the keyboard while the leave waits", async () => {
    const at = await printStation();
    const onLeave = vi.fn();
    const work = renderWork(at, { onLeave });
    await fillBox(work);
    await openSummary(work);
    await work.press("Недостаток сырья");
    await work.press("Подтвердить закрытие");
    await screen.findByText(CLOSED_TITLE);
    work.rerender({ leaving: true });
    for (const name of ["К списку смен", "Выйти из смены"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled"), name).toBe("true");
      expect(button.hasAttribute("disabled"), name).toBe(false);
    }
    await work.press("К списку смен");
    await work.press("Выйти из смены");
    expect(onLeave).not.toHaveBeenCalled();
    expect(screen.getByText("Дожидаемся окончания начатой работы…")).toBeTruthy();
  });

  it("closes without the host and says, when the link is held, that the data goes later", async () => {
    const at = await printStation();
    const work = renderWork(at, { overrides: { online: false, linkHeld: true } });
    await fillBox(work);
    await openSummary(work);
    await work.press("Недостаток сырья");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(
      screen.getByText(
        "Связь с хостом остановлена до выхода из смены, поэтому данные уйдут позже. Выйдите из смены: экран покажет, что делать дальше.",
      ),
    ).toBeTruthy();
    expect(work.props.checkCode).not.toHaveBeenCalled();
    expect(work.props.requestBlock).not.toHaveBeenCalled();
    expect(closedRecords(at)).toHaveLength(1);
  });

  it("moves the focus to the view, never to a button, and back to «Закрыть смену»", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work);
    await openSummary(work);
    expect(document.activeElement).toBe(screen.getByRole("region", { name: TITLE }));
    await work.press("Назад к работе");
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Закрыть смену" }));
    await openSummary(work);
    await work.press("Недостаток сырья");
    await work.press("Подтвердить закрытие");
    await screen.findByText(CLOSED_TITLE);
    expect(document.activeElement).toBe(screen.getByRole("group", { name: CLOSED_TITLE }));
  });

  it("keeps every button on 64 px, every alert out of the live region's way, and marks the chosen reason beyond colour", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work);
    await openSummary(work);
    const checkButtons = () => {
      for (const button of screen.getAllByRole("button")) {
        expect(button.style.height, button.textContent ?? "").toBe("var(--control-floor)");
      }
      for (const alert of document.querySelectorAll(".mk-alert")) {
        expect(alert.getAttribute("role")).toBe("presentation");
      }
    };
    checkButtons();
    expect(summary().getAllByRole("button")).toHaveLength(8);
    const reason = screen.getByRole("button", { name: "Недостаток сырья" });
    expect(reason.textContent).not.toContain("✓");
    await work.press("Недостаток сырья");
    const chosen = screen.getByRole("button", { name: "Недостаток сырья" });
    expect(chosen.textContent).toContain("✓");
    expect(chosen.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Остановка оборудования" }).textContent,
    ).not.toContain("✓");
    checkButtons();
    await work.press("Подтвердить закрытие");
    await screen.findByText(CLOSED_TITLE);
    checkButtons();
  });

  it("says a read that failed as the system's error, with a way back", async () => {
    const at = await printStation();
    let broken = false;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        broken && sql.includes("AS waiting")
          ? Promise.reject(new LocalDbError("statement_failed", "disk"))
          : at.local.query(sql, params, row),
      transaction: (statements) => at.local.transaction(statements),
    };
    const work = renderWork({ local, shift: at.shift });
    await fillBox(work);
    broken = true;
    await work.press("Закрыть смену");
    expect(await screen.findByText("Смена не прочитана")).toBeTruthy();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
    broken = false;
    await work.press("Понятно");
    await work.scan(km("A1"));
    expect(screen.getByText("1 из 12")).toBeTruthy();
  });
});

describe("the close of a shift on the work screen, in its races", () => {
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
    const open = screen.getByRole("button", { name: "Закрыть смену" });
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
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
    expect(screen.queryByText("Считаем итоги смены…")).toBeNull();
  });

  it("does not bring the summary back after the operator went back from it while it was read", async () => {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await fillBox(work);
    held.holdNext();
    act(() => work.scanner.emit(km("Q1")));
    await held.reached();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть смену" }));
    expect(screen.getByText("Считаем итоги смены…")).toBeTruthy();
    work.pause();
    tap("Назад к работе");
    expect(screen.queryByText("Считаем итоги смены…")).toBeNull();
    held.release();
    await work.settled();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
    expect(screen.getByText("1 из 12")).toBeTruthy();
    await work.scan(km("Q2"));
    expect(screen.getByText("2 из 12")).toBeTruthy();
  });

  it("ignores a second tap on the summary that replaced the one pressed: the new numbers are read first", async () => {
    const at = await printStation();
    const shift = await enteredShift(at.local, { ...ENTERED, plannedQty: 11 });
    const work = renderWork({ local: at.local, shift });
    await fillBox(work);
    await openSummary(work);
    await work.press("Недостаток сырья");
    loseACode(at);
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(STALE)).toBeTruthy();
    // The plan is met now, and «Подтвердить закрытие» is under the finger again.
    expect(
      screen.getByRole("button", { name: "Подтвердить закрытие" }).hasAttribute("disabled"),
    ).toBe(false);
    tap("Подтвердить закрытие");
    await work.settled();
    expect(localState(at)).toBeNull();
    expect(closedRecords(at)).toHaveLength(0);
    work.pause();
    tap("Подтвердить закрытие");
    await work.settled();
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
  });

  it("takes the plan-reached notice away when the summary opens", async () => {
    const at = await printStation();
    const shift = await enteredShift(at.local, { ...ENTERED, plannedQty: 12 });
    const work = renderWork({ local: at.local, shift });
    await fillBox(work);
    expect(screen.getByText("План выполнен: принято 12 из 12.")).toBeTruthy();
    await openSummary(work);
    expect(screen.queryByText("План выполнен: принято 12 из 12.")).toBeNull();
  });

  it("closes on the plan the operator saw: a plan the office changed since shows a new summary", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work);
    await openSummary(work);
    expect(fact("План")).toBe("1\u00a0200");
    await work.press("Производственный брак");
    at.db.exec("UPDATE floor_shifts SET planned_qty = 600");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(STALE)).toBeTruthy();
    expect(fact("План")).toBe("600");
    expect(fact("Отклонение")).toBe("−588");
    expect(localState(at)).toBeNull();
    expect(closedRecords(at)).toHaveLength(0);
  });

  it("shows a label that began to wait since the summary, by its SSCC, instead of closing", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await fillBox(work);
    await openSummary(work);
    await work.press("Производственный брак");
    at.db.exec("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'");
    await work.press("Подтвердить закрытие");
    expect(
      await screen.findByText(
        `Этикетка короба ${formatSsccHri(FIRST_SSCC)} ещё ждёт решения. Решите её, затем закройте смену.`,
      ),
    ).toBeTruthy();
    expect(screen.getByText(STALE)).toBeTruthy();
    expect(localState(at)).toBeNull();
    expect(closedRecords(at)).toHaveLength(0);
  });

  it("says the label waits without its SSCC when the job cannot be read, and still sends the operator to it", async () => {
    const at = await printStation();
    let unreadable = false;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        unreadable && sql === OPEN_JOB_READ_SQL
          ? Promise.reject(new LocalDbError("statement_failed", "the job is unreadable"))
          : at.local.query(sql, params, row),
      transaction: (statements) => at.local.transaction(statements),
    };
    const work = renderWork({ local, shift: at.shift });
    await fillBox(work);
    at.db.exec("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'");
    unreadable = true;
    await openSummary(work);
    expect(
      await screen.findByText("Этикетка короба ещё ждёт решения. Решите её, затем закройте смену."),
    ).toBeTruthy();
    unreadable = false;
    await work.press("Перейти к этикетке");
    expect(await screen.findByText("Этикетка короба не напечатана")).toBeTruthy();
  });

  it("shows the closed stop, and writes no second record, when the model finds the shift closed in its own read", async () => {
    const at = await printStation();
    const shift = await enteredShift(at.local, { ...ENTERED, plannedQty: 12 });
    let copyReads = 0;
    const local = pairingShifts(at.local, (sql) => {
      if (sql.includes("FROM floor_shifts WHERE host_id")) {
        copyReads += 1;
        if (copyReads === 3) at.db.exec("UPDATE floor_shifts SET local_state = 'closing'");
      }
    });
    const work = renderWork({ local, shift });
    await fillBox(work);
    await openSummary(work);
    const before = recorded(work);
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(closedRecords(at)).toHaveLength(0);
    // The close it found was not written by this screen and may not have been told yet.
    expect(recorded(work)).toBe(before + 1);
  });

  it("shows a label that began to wait inside the write, and closes nothing", async () => {
    const at = await printStation();
    const shift = await enteredShift(at.local, { ...ENTERED, plannedQty: 12 });
    let copyReads = 0;
    const local = pairingShifts(at.local, (sql) => {
      if (sql.includes("FROM floor_shifts WHERE host_id")) {
        copyReads += 1;
        if (copyReads === 3) {
          at.db.exec("UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent'");
        }
      }
    });
    const work = renderWork({ local, shift });
    await fillBox(work);
    await openSummary(work);
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(STALE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Перейти к этикетке" })).toBeTruthy();
    expect(localState(at)).toBeNull();
    expect(closedRecords(at)).toHaveLength(0);
  });

  it("keeps the summary it showed when the write failed and the summary cannot be read again", async () => {
    const at = await printStation();
    let broken = false;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        broken && sql.includes("AS waiting")
          ? Promise.reject(new LocalDbError("statement_failed", "disk"))
          : at.local.query(sql, params, row),
      transaction: (statements) =>
        broken ? failingWrites(at.local).transaction(statements) : at.local.transaction(statements),
    };
    const work = renderWork({ local, shift: at.shift });
    await fillBox(work);
    await openSummary(work);
    await work.press("Производственный брак");
    broken = true;
    await work.press("Подтвердить закрытие");
    // Neither "closed" nor "not closed" is known: the note hedges, and does not call the shift open.
    expect(await screen.findByText(UNKNOWN)).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(fact("Факт")).toBe("12");
    expect(screen.getByRole("button", { name: "Подтвердить закрытие" })).toBeTruthy();
    broken = false;
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
  });

  it("shows the numbers read after a failed write, not those of before it", async () => {
    const at = await printStation();
    const lose = { now: false };
    const local: LocalExecutor = {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: async (statements) => {
        if (lose.now) {
          // The write fails, and the shift changed meanwhile.
          loseACode(at);
          throw new LocalDbError("statement_failed", "disk");
        }
        return at.local.transaction(statements);
      },
    };
    const work = renderWork({ local, shift: at.shift });
    await fillBox(work);
    await openSummary(work);
    await work.press("Производственный брак");
    lose.now = true;
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(fact("Факт")).toBe("11");
  });

  it("ignores a tap just after the summary appears, however long it was read for", async () => {
    const at = await printStation();
    const shift = await enteredShift(at.local, { ...ENTERED, plannedQty: 12 });
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift });
    await scanAll(
      work,
      Array.from({ length: 11 }, (_, index) => `P${index}`),
    );
    held.holdNext();
    act(() => work.scanner.emit(km("P11")));
    await held.reached();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть смену" }));
    expect(screen.getByText("Считаем итоги смены…")).toBeTruthy();
    // The summary has been waited for longer than the guard lasts.
    work.clock.now += 5_000;
    held.release();
    await work.settled();
    await screen.findByRole("region", { name: TITLE });
    expect(
      screen.getByRole("button", { name: "Подтвердить закрытие" }).hasAttribute("disabled"),
    ).toBe(false);
    tap("Подтвердить закрытие");
    await work.settled();
    expect(localState(at)).toBeNull();
    work.pause();
    tap("Подтвердить закрытие");
    await work.settled();
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
  });

  it("holds every button of the summary while the close writes, «Назад к работе» included, and the shift closes all the same", async () => {
    const at = await printStation();
    const held = holdingWrites(at.local);
    const work = renderWork({ local: held.executor, shift: at.shift });
    await fillBox(work);
    await openSummary(work);
    await work.press("Недостаток сырья");
    held.holdNext();
    work.clock.now += 1_000;
    act(() => tap("Подтвердить закрытие"));
    await held.reached();
    expect(screen.getByText("Закрываем смену…")).toBeTruthy();
    work.clock.now += 1_000;
    for (const name of ["Назад к работе", "Подтвердить закрытие", "Остановка оборудования"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-disabled"), name).toBe("true");
      tap(name);
    }
    expect(screen.getByRole("region", { name: TITLE })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Недостаток сырья" }).getAttribute("aria-pressed"),
    ).toBe("true");
    // The way out of the shift is not among them.
    expect(
      screen.getByRole("button", { name: "Выйти из смены" }).getAttribute("aria-disabled"),
    ).toBe(null);
    held.release();
    await work.settled();
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
  });
});

describe("what a summary read twice says alike", () => {
  const base: CloseSummary = {
    plannedQty: 1_200,
    actualQty: 12,
    closedBoxes: 1,
    reasonRequired: true,
    blocker: null,
  };

  it("is the same when nothing the operator reads has changed", () => {
    expect(sameSummary(base, { ...base })).toBe(true);
    expect(
      sameSummary(
        { ...base, blocker: { kind: "open_box", items: 2 } },
        { ...base, blocker: { kind: "open_box", items: 2 } },
      ),
    ).toBe(true);
    expect(
      sameSummary({ ...base, blocker: { kind: "label" } }, { ...base, blocker: { kind: "label" } }),
    ).toBe(true);
    expect(sameSummary({ ...base, plannedQty: null }, { ...base, plannedQty: null })).toBe(true);
  });

  it.each([
    ["the plan", { plannedQty: 600 }],
    ["a plan that appeared", { plannedQty: null }],
    ["the fact", { actualQty: 11 }],
    ["the closed boxes", { closedBoxes: 2 }],
    ["whether a reason is needed", { reasonRequired: false }],
    ["a blocker that appeared", { blocker: { kind: "label" } }],
    ["the blocker", { blocker: { kind: "open_box", items: 1 } }],
  ] satisfies [string, Partial<CloseSummary>][])("differs by %s", (_, change) => {
    expect(sameSummary(base, { ...base, ...change })).toBe(false);
    expect(sameSummary({ ...base, ...change }, base)).toBe(false);
  });

  it("tells one blocker from another, and the items of an open box", () => {
    const label = { ...base, blocker: { kind: "label" } } satisfies CloseSummary;
    const open = { ...base, blocker: { kind: "open_box", items: 2 } } satisfies CloseSummary;
    expect(sameSummary(label, open)).toBe(false);
    expect(sameSummary(open, label)).toBe(false);
    expect(sameSummary(open, { ...base, blocker: { kind: "open_box", items: 3 } })).toBe(false);
  });
});

describe("the figures of the summary", () => {
  it("averages the units per closed box to one decimal, and says nothing without boxes", () => {
    expect(averagePerBox(12, 0)).toBeNull();
    expect(averagePerBox(25, 2)).toBe("12,5");
    expect(averagePerBox(36, 3)).toBe("12");
  });

  it("signs the deviation: «+5», «−3», «0»", () => {
    expect(deviation(10, 15)).toBe("+5");
    expect(deviation(10, 7)).toBe("−3");
    expect(deviation(10, 10)).toBe("0");
    expect(deviation(1_200, 12)).toBe("−1\u00a0188");
  });
});

describe("a shift the office closed while the station worked in it", () => {
  it("takes no new code, but closes the box with its label and the shift as usual", async () => {
    const at = await printStation();
    const work = renderWork(at);
    await scanAll(work, ["A1", "A2"]);
    work.rerender({ officeClosed: true });
    expect(screen.getByText("Смену закрыли в офисе")).toBeTruthy();
    await work.scan(km("A3"));
    expect(lastLine()).toBe("Скан не принят: смену закрыли в офисе.");
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_scans")).toEqual([{ n: 2 }]);
    await work.press("Закрыть короб");
    await work.press("Закрыть короб");
    expect(work.shell.sends).toHaveLength(1);
    await work.press("Закрыть смену");
    await screen.findByText(TITLE);
    await work.press("Изменение производственного задания");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED_TITLE)).toBeTruthy();
    expect(screen.queryByText("Смену закрыли в офисе")).toBeNull();
    expect(outboxKinds(at)).toEqual(["scan", "scan", "box_closed", "shift_closed"]);
  });
});
