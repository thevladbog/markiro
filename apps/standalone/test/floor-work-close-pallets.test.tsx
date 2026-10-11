import { buildSscc, formatSsccHri } from "@markiro/domain";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import {
  sameSummary,
  ShiftClosePanel,
  type ShiftClosePanelProps,
} from "../src/floor/close/ShiftClosePanel.js";
import type { CloseBlocker, CloseSummary } from "../src/floor/close/shift-close.js";
import { PALLET_EXTENSION } from "../src/floor/pallets/pallets.js";
import { saveWorkstationSettings } from "../src/floor/setup/workstation-settings.js";
import type * as PrintResolution from "../src/floor/print/print-resolution.js";
import type { SsccBlockRequest } from "../src/host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import { holdingWrites, km, PREFIX, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { palletStation, type PalletStation } from "./support/pallets.js";
import { printingSettings } from "./support/printing.js";
import { renderWork, type WorkHarness } from "./support/work-screen.js";

const PALLET_SSCC = buildSscc(PALLET_EXTENSION, PREFIX, 0);
const BOX_SSCC = buildSscc(0, PREFIX, 1500);
const CLOSED = "Смена OCT26-004 закрыта на этой станции";
const QUESTION = "На паллете 2 из 40 коробов — закрыть?";
const TITLE = "Закрытие смены OCT26-004";
const STALE = "Пока вы смотрели итоги, смена изменилась: итоги посчитаны заново.";
const AFTER_LABEL = "Паллета закрыта. Смена закроется, как только вы решите по этикетке паллеты.";
const REFUSED = "Скан не принят: смена закрыта на этой станции.";
const MOVED = "Состояние этикетки изменилось — показано текущее.";
const SHIFT_OPEN = "Смена не закрыта: когда паллета закроется, нажмите «Закрыть смену» ещё раз.";
const noPalletPrinter = { assignments: { box: "zebra", pallet: null, duplicate: null } } as const;

// Set by a test: the next check of a label is refused as one its job cannot be checked from.
const unresolvable = vi.hoisted(() => ({ next: false }));
vi.mock("../src/floor/print/print-resolution.js", async (importOriginal) => {
  const real = await importOriginal<typeof PrintResolution>();
  return {
    ...real,
    checkLabel: async (...args: Parameters<typeof real.checkLabel>) => {
      if (unresolvable.next) {
        unresolvable.next = false;
        throw new real.UnresolvableJobError(args[1].id, args[1].state);
      }
      return real.checkLabel(...args);
    },
  };
});

function kinds(at: PalletStation): unknown[] {
  return rows(at.db, "SELECT kind FROM outbox WHERE kind <> 'scan' ORDER BY seq").map(
    (row) => row["kind"],
  );
}

function localState(at: PalletStation): unknown {
  return rows(at.db, "SELECT local_state FROM floor_shifts")[0]?.["local_state"];
}

/** A click that is not a press of the harness: the clock stays where it is. */
function tap(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** An SSCC of a pallet of a former pairing: the serial that makes it cannot label a pallet here. */
function holdSscc(at: PalletStation, serial: number): void {
  at.db
    .prepare(
      "INSERT INTO floor_pallets (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
        "block_id, serial, closed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      `former-${serial}`,
      "former-host",
      "former-device",
      "former-shift",
      "2026-10-01T05:00:00.000Z",
      "2026-10-01T06:00:00.000Z",
      buildSscc(PALLET_EXTENSION, PREFIX, serial),
      "former-block",
      serial,
      "former-operator",
    );
}

/**
 * The local database whose shift's close runs `before` a moment before it is
 * written, in the close's own turn.
 */
function beforeClose(at: PalletStation, before: () => void | Promise<void>): LocalExecutor {
  return {
    query: (sql, params, row) => at.local.query(sql, params, row),
    transaction: async (statements) => {
      if (statements.some((statement) => statement.sql.includes("SET local_state = 'closing'"))) {
        await before();
      }
      return at.local.transaction(statements);
    },
  };
}

/**
 * `beforeClose` that finds the closed pallet open again with its boxes, `times`
 * times (a pallet that changed after the close read the summary): every other
 * statement of the close still holds — the same codes, the same closed boxes,
 * no open box, no label that waits — so only the close's own check of the open
 * pallet can refuse it.
 */
function reopeningBeforeClose(at: PalletStation, times = Number.POSITIVE_INFINITY): LocalExecutor {
  let left = times;
  return beforeClose(at, () => {
    if (left <= 0) return;
    left -= 1;
    at.db.exec(
      "UPDATE floor_pallets SET closed_at = NULL, sscc = NULL, block_id = NULL, serial = NULL",
    );
  });
}

/**
 * The local database whose next skip of a label, once armed, fails: before
 * anything is written, or after it was written (its answer lost).
 */
function failingSkip(
  at: PalletStation,
  when: "before" | "after",
): { executor: LocalExecutor; arm: () => void } {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    executor: {
      query: (sql, params, row) => at.local.query(sql, params, row),
      transaction: async (statements) => {
        const skip = statements.some(
          (statement) =>
            statement.sql.startsWith("UPDATE floor_print_jobs SET state = ?") &&
            statement.values?.[0] === "skipped",
        );
        if (!armed || !skip) return at.local.transaction(statements);
        armed = false;
        if (when === "after") await at.local.transaction(statements);
        throw new LocalDbError("statement_failed", "disk I/O error");
      },
    },
  };
}

/** The local database whose next reading of the close's summary, once armed, fails. */
function failingSummaryRead(at: PalletStation): { executor: LocalExecutor; arm: () => void } {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    executor: {
      query: (sql, params, row) => {
        if (armed && sql.includes("SELECT s.local_state")) {
          armed = false;
          return Promise.reject(new LocalDbError("statement_failed", "disk I/O error"));
        }
        return at.local.query(sql, params, row);
      },
      transaction: (statements) => at.local.transaction(statements),
    },
  };
}

/** «Продолжить без этикетки» and its confirmation. */
async function skipTwice(work: WorkHarness): Promise<void> {
  await work.press("Продолжить без этикетки");
  await work.press("Продолжить без этикетки");
}

/**
 * Two boxes on the open pallet of 40, then «Закрыть паллету и смену» whose
 * pallet label waits for its check, with the intention to close after it.
 */
async function palletLabelChecked(at: PalletStation): Promise<WorkHarness> {
  const work = renderWork(at);
  await work.scanner.listening();
  await work.settled();
  await work.scan(km("A1"));
  await work.scan(km("A2"));
  await saveWorkstationSettings(
    at.local,
    printingSettings({
      assignments: { box: "zebra", pallet: "zebra", duplicate: null },
      verifyPrintedLabel: true,
    }),
  );
  await work.press("Закрыть смену");
  expect(await screen.findByText(QUESTION)).toBeTruthy();
  await work.press("Производственный брак");
  await work.press("Закрыть паллету и смену");
  expect(screen.getByText("Отсканируйте SSCC на этикетке паллеты.")).toBeTruthy();
  expect(screen.getByText(AFTER_LABEL)).toBeTruthy();
  return work;
}

/** Two boxes of one code each on the open pallet of 40; the close's summary open, its reason chosen. */
async function twoBoxesThenClose(
  at: PalletStation,
  local: LocalExecutor = at.local,
): Promise<WorkHarness> {
  const work = renderWork({ local, shift: at.shift });
  await work.scanner.listening();
  await work.settled();
  await work.scan(km("A1"));
  await work.scan(km("A2"));
  await work.press("Закрыть смену");
  expect(await screen.findByText(QUESTION)).toBeTruthy();
  await work.press("Производственный брак");
  return work;
}

describe("the close of a shift with an open pallet (plan ПЛ-Ц)", () => {
  it("asks «На паллете N из M коробов — закрыть?» and closes the pallet and then the shift with one press", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = await twoBoxesThenClose(at);
    expect(screen.queryByRole("button", { name: "Подтвердить закрытие" })).toBeNull();
    await work.press("Закрыть паллету и смену");
    expect(await screen.findByText(CLOSED)).toBeTruthy();
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed", "shift_closed"]);
    expect(work.shell.sends.at(-1)?.text).toContain(PALLET_SSCC);
    expect(localState(at)).toBe("closing");
    const [closed] = rows(at.db, "SELECT payload FROM outbox WHERE kind = 'shift_closed'");
    expect(JSON.parse(String(closed?.["payload"]))).toMatchObject({
      data: { reasonCode: "production_defect", closedBoxCount: 2, actualQty: 2 },
    });
  });

  it("waits for the pallet's label to be checked, then closes the shift with the reason chosen", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.scan(km("A2"));
    // The pallet's label is to be checked: the setting is on by the time it prints.
    await saveWorkstationSettings(
      at.local,
      printingSettings({
        assignments: { box: "zebra", pallet: "zebra", duplicate: null },
        verifyPrintedLabel: true,
      }),
    );
    await work.press("Закрыть смену");
    expect(await screen.findByText(QUESTION)).toBeTruthy();
    await work.press("Производственный брак");
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText("Отсканируйте SSCC на этикетке паллеты.")).toBeTruthy();
    expect(localState(at)).toBeNull();
    await work.scan(`(00)${PALLET_SSCC}`);
    expect(await screen.findByText(CLOSED)).toBeTruthy();
    expect(kinds(at).slice(-3)).toEqual(["pallet_closed", "pallet_label", "shift_closed"]);
  });

  it("lets an open pallet with no box left not hold the close, and spends no serial on it", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    // The box leaves the pallet by the screen's own way, «Расформировать короб»: the pallet is open and empty.
    await work.press("Исключения");
    await screen.findByRole("button", { name: "Расформировать короб" });
    await work.press("Расформировать короб");
    await work.press(`${formatSsccHri(BOX_SSCC)} · 1 шт.`);
    await work.press("Брак по качеству");
    await work.press("Расформировать");
    expect(await screen.findByText("Короб расформирован, его коды свободны.")).toBeTruthy();
    await work.press("Вернуться к работе");
    await work.press("Закрыть смену");
    expect(await screen.findByRole("button", { name: "Подтвердить закрытие" })).toBeTruthy();
    expect(screen.queryByText(/На паллете/)).toBeNull();
    await work.press("Производственный брак");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED)).toBeTruthy();
    expect(kinds(at)).toEqual(["box_closed", "box_exception", "shift_closed"]);
  });

  it("keeps the shift open and says why when no pallet serial is left", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, palletBlock: false });
    const work = await twoBoxesThenClose(at);
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText("Нет номеров SSCC паллет: паллета не закрыта")).toBeTruthy();
    expect(kinds(at)).toEqual(["box_closed", "box_closed"]);
    expect(localState(at)).toBeNull();
  });
});

describe("the transaction's own check of the open pallet, on every path that closes the shift", () => {
  it("refuses «Подтвердить закрытие» when the pallet turned open again between the summary and the write", async () => {
    const at = await palletStation({ capacity: 1, boxCapacity: 1 });
    const work = renderWork({ local: reopeningBeforeClose(at), shift: at.shift });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    expect(kinds(at)).toEqual(["box_closed", "pallet_closed"]);
    await work.press("Закрыть смену");
    await screen.findByRole("region", { name: TITLE });
    expect(screen.queryByText(/На паллете/)).toBeNull();
    await work.press("Производственный брак");
    await work.press("Подтвердить закрытие");
    expect(screen.getByText(STALE)).toBeTruthy();
    expect(screen.getByText("На паллете 1 из 1 коробов — закрыть?")).toBeTruthy();
    expect(localState(at)).toBeNull();
    expect(kinds(at)).toEqual(["box_closed", "pallet_closed"]);
    expect(screen.queryByText(CLOSED)).toBeNull();
  });

  it("refuses the shift's close that follows «Закрыть паллету и смену» when the pallet is open again at the write", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = await twoBoxesThenClose(at, reopeningBeforeClose(at));
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText(STALE)).toBeTruthy();
    expect(screen.getByText(QUESTION)).toBeTruthy();
    expect(localState(at)).toBeNull();
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed"]);
    expect(screen.queryByText(CLOSED)).toBeNull();
  });

  it("refuses the shift's close that follows the pallet label's check when the pallet is open again at the write", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = renderWork({ local: reopeningBeforeClose(at), shift: at.shift });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.scan(km("A2"));
    await saveWorkstationSettings(
      at.local,
      printingSettings({
        assignments: { box: "zebra", pallet: "zebra", duplicate: null },
        verifyPrintedLabel: true,
      }),
    );
    await work.press("Закрыть смену");
    expect(await screen.findByText(QUESTION)).toBeTruthy();
    await work.press("Производственный брак");
    await work.press("Закрыть паллету и смену");
    await work.scan(`(00)${PALLET_SSCC}`);
    expect(screen.getByText(STALE)).toBeTruthy();
    expect(localState(at)).toBeNull();
    expect(kinds(at)).not.toContain("shift_closed");
    expect(screen.queryByText(CLOSED)).toBeNull();
  });
});

describe("the pallet label's decision that carries the shift's close", () => {
  const verifying = () =>
    printingSettings({
      assignments: { box: "zebra", pallet: "zebra", duplicate: null },
      verifyPrintedLabel: true,
    });

  it("keeps no intention to close after the transaction refused it: a later label's decision closes nothing", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = renderWork({ local: reopeningBeforeClose(at, 1), shift: at.shift });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.scan(km("A2"));
    await saveWorkstationSettings(at.local, verifying());
    await work.press("Закрыть смену");
    expect(await screen.findByText(QUESTION)).toBeTruthy();
    await work.press("Производственный брак");
    await work.press("Закрыть паллету и смену");
    await work.scan(`(00)${PALLET_SSCC}`);
    expect(screen.getByText(STALE)).toBeTruthy();
    expect(screen.queryByText(AFTER_LABEL)).toBeNull();
    await work.press("Назад к работе");
    // Another box closes and its label is checked: that decision is not the pallet's.
    await work.scan(km("A3"));
    expect(screen.getByText("Отсканируйте SSCC на этикетке короба.")).toBeTruthy();
    expect(screen.queryByText(AFTER_LABEL)).toBeNull();
    await work.scan(`(00)${buildSscc(0, PREFIX, 1502)}`);
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
    expect(localState(at)).toBeNull();
    expect(kinds(at)).not.toContain("shift_closed");
  });

  it("says the shift is being closed while the close that follows the label's check is written", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const reachedClose = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const written = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = renderWork({
      local: beforeClose(at, async () => {
        reached();
        await written;
      }),
      shift: at.shift,
    });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.scan(km("A2"));
    await saveWorkstationSettings(at.local, verifying());
    await work.press("Закрыть смену");
    expect(await screen.findByText(QUESTION)).toBeTruthy();
    await work.press("Производственный брак");
    await work.press("Закрыть паллету и смену");
    await act(async () => {
      work.scanner.emit(`(00)${PALLET_SSCC}`);
      await reachedClose;
    });
    expect(screen.getByText("Закрываем смену…")).toBeTruthy();
    expect(work.gate.pending()).toBe(1);
    release();
    await work.settled();
    expect(await screen.findByText(CLOSED)).toBeTruthy();
  });
});

describe("what the summary and the press say of the open pallet", () => {
  it("shows another question, and closes nothing, when the pallet's boxes changed since the summary", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = await twoBoxesThenClose(at);
    // A box off the pallet: the closed boxes and the codes stay as they were, the question does not.
    at.db.exec(
      "UPDATE floor_boxes SET pallet_id = NULL WHERE id = " +
        "(SELECT id FROM floor_boxes ORDER BY closed_at LIMIT 1)",
    );
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText(STALE)).toBeTruthy();
    expect(screen.getByText("На паллете 1 из 40 коробов — закрыть?")).toBeTruthy();
    expect(kinds(at)).toEqual(["box_closed", "box_closed"]);
    expect(localState(at)).toBeNull();
  });

  it("names the counts, says what the press does, and moves no focus onto a button", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    await twoBoxesThenClose(at);
    expect(
      screen.getByText(
        "Паллета закроется с этими коробами, её этикетка уйдёт на печать, а смена закроется. Отменить это нельзя.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Закрыть паллету и смену" }).className).toContain(
      "mk-btn--floor",
    );
    expect(document.activeElement).toBe(screen.getByRole("region", { name: TITLE }));
  });

  it("does one close for a double press, as one tracked job of the work queue, and says it is closing the pallet", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const held = holdingWrites(at.local);
    const work = await twoBoxesThenClose(at, held.executor);
    held.holdNext();
    work.pause();
    act(() => {
      tap("Закрыть паллету и смену");
      tap("Закрыть паллету и смену");
    });
    await held.reached();
    expect(work.gate.pending()).toBe(1);
    expect(screen.getByText("Закрываем паллету и смену…")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Закрыть паллету и смену" }).getAttribute("aria-disabled"),
    ).toBe("true");
    held.release();
    await work.settled();
    expect(await screen.findByText(CLOSED)).toBeTruthy();
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed", "shift_closed"]);
  });

  it("takes no scan queued behind the close: it meets the closed shift", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const held = holdingWrites(at.local);
    const work = await twoBoxesThenClose(at, held.executor);
    held.holdNext();
    work.pause();
    act(() => tap("Закрыть паллету и смену"));
    await held.reached();
    act(() => work.scanner.emit(km("A3")));
    held.release();
    await work.settled();
    expect(await screen.findByText(CLOSED)).toBeTruthy();
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_codes")[0]?.["n"]).toBe(2);
    expect(document.querySelector(".work-screen__last")?.textContent).toBe(REFUSED);
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed", "shift_closed"]);
  });

  it("starts nothing once the leave began, and a leave that began in the turn closes nothing", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const leaving = { now: false };
    const work = renderWork(at, { overrides: { isLeaving: () => leaving.now } });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.scan(km("A2"));
    await work.press("Закрыть смену");
    await screen.findByText(QUESTION);
    await work.press("Производственный брак");
    leaving.now = true;
    await work.press("Закрыть паллету и смену");
    expect(kinds(at)).toEqual(["box_closed", "box_closed"]);
    expect(localState(at)).toBeNull();
    expect(screen.queryByText(CLOSED)).toBeNull();
  });
});

describe("the pallet's label and the pallet's serial inside the close", () => {
  it("writes the pallet's label job before the shift can close, and closes the shift once the label is skipped", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, settings: noPalletPrinter });
    const work = await twoBoxesThenClose(at);
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText("Этикетка паллеты не напечатана")).toBeTruthy();
    expect(screen.getByText(AFTER_LABEL)).toBeTruthy();
    expect(
      rows(at.db, "SELECT purpose, state FROM floor_print_jobs WHERE purpose = 'pallet'"),
    ).toEqual([{ purpose: "pallet", state: "failed" }]);
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed"]);
    expect(localState(at)).toBeNull();
    await work.press("Продолжить без этикетки");
    await work.press("Продолжить без этикетки");
    expect(await screen.findByText(CLOSED)).toBeTruthy();
    expect(screen.queryByText(AFTER_LABEL)).toBeNull();
    expect(kinds(at).slice(-3)).toEqual(["pallet_closed", "pallet_label", "shift_closed"]);
  });

  it("closes no shift when the leave began while the pallet's label was decided", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, settings: noPalletPrinter });
    const held = holdingWrites(at.local);
    const leaving = { now: false };
    const work = renderWork(
      { local: held.executor, shift: at.shift },
      { overrides: { isLeaving: () => leaving.now } },
    );
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.scan(km("A2"));
    await work.press("Закрыть смену");
    await screen.findByText(QUESTION);
    await work.press("Производственный брак");
    await work.press("Закрыть паллету и смену");
    await work.press("Продолжить без этикетки");
    held.holdNext();
    work.pause();
    act(() => tap("Продолжить без этикетки"));
    await held.reached();
    leaving.now = true;
    held.release();
    await work.settled();
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed", "pallet_label"]);
    expect(localState(at)).toBeNull();
    expect(screen.queryByText(CLOSED)).toBeNull();
  });

  it("says the pallet did not close when its serial was lost, keeps the shift open, and takes the next serial on «Повторить»", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    holdSscc(at, 0);
    const work = await twoBoxesThenClose(at);
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText("Паллета не закрыта")).toBeTruthy();
    // The stop of the shift's close says the shift is NOT closed (the intention is dropped).
    expect(screen.getByText(SHIFT_OPEN)).toBeTruthy();
    expect(kinds(at)).toEqual(["box_closed", "box_closed"]);
    expect(localState(at)).toBeNull();
    expect(document.activeElement).toBe(document.querySelector(".work-screen__last"));
    await work.press("Повторить");
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed"]);
    expect(screen.queryByText("Паллета не закрыта")).toBeNull();
    expect(screen.queryByText(SHIFT_OPEN)).toBeNull();
    // The intention to close is not kept: the shift is open, and the operator presses again.
    expect(localState(at)).toBeNull();
  });

  it("keeps saying the shift is not closed on «Повторить» and when the link brings a block that cannot label a pallet", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, palletBlock: false });
    holdSscc(at, 0);
    const work = await twoBoxesThenClose(at);
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText("Нет номеров SSCC паллет: паллета не закрыта")).toBeTruthy();
    expect(screen.getByText(SHIFT_OPEN)).toBeTruthy();
    // «Повторить» with the serials still missing: the stop is the close's still.
    await work.press("Повторить");
    expect(screen.getByText("Нет номеров SSCC паллет: паллета не закрыта")).toBeTruthy();
    expect(screen.getByText(SHIFT_OPEN)).toBeTruthy();
    // The link brings a block whose first serial is held: the close's stop, in the failed words.
    const requestBlock = vi.fn(async (request: SsccBlockRequest) => ({
      id: "d6e0b0c4-0f7a-4f4e-9d0f-5a3b7f7f3c11",
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: 0,
      toSerial: 199,
    }));
    work.rerender({ online: true, requestBlock });
    await work.settled();
    expect(await screen.findByText("Паллета не закрыта")).toBeTruthy();
    expect(screen.getByText(SHIFT_OPEN)).toBeTruthy();
    expect(kinds(at)).toEqual(["box_closed", "box_closed"]);
    expect(localState(at)).toBeNull();
  });

  it("puts the focus on a safe place when no pallet serial is left", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, palletBlock: false });
    const work = await twoBoxesThenClose(at);
    await work.press("Закрыть паллету и смену");
    expect(document.activeElement).toBe(document.querySelector(".work-screen__last"));
  });

  it("focuses the closed shift's panel after the pallet and the shift closed", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = await twoBoxesThenClose(at);
    await work.press("Закрыть паллету и смену");
    expect(await screen.findByText(CLOSED)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: CLOSED }));
  });
});

describe("an intention to close that outlives its pallet's label never closes the shift", () => {
  const verifying = () =>
    printingSettings({
      assignments: { box: "zebra", pallet: "zebra", duplicate: null },
      verifyPrintedLabel: true,
    });

  it("closes nothing on another pallet's label after the pallet's own check found its label moved", async () => {
    const at = await palletStation({ capacity: 2, boxCapacity: 1 });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await saveWorkstationSettings(at.local, verifying());
    await work.press("Закрыть смену");
    expect(await screen.findByText("На паллете 1 из 2 коробов — закрыть?")).toBeTruthy();
    await work.press("Производственный брак");
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText("Отсканируйте SSCC на этикетке паллеты.")).toBeTruthy();
    expect(screen.getByText(AFTER_LABEL)).toBeTruthy();
    // The pallet's job moves under the screen: its check meets a label that changed.
    at.db.exec("UPDATE floor_print_jobs SET state = 'verified' WHERE purpose = 'pallet'");
    await work.scan(`(00)${PALLET_SSCC}`);
    expect(screen.queryByText("Отсканируйте SSCC на этикетке паллеты.")).toBeNull();
    // The work goes on; another pallet fills and its label fails at a printer that is gone.
    await saveWorkstationSettings(
      at.local,
      printingSettings({ assignments: { box: "zebra", pallet: null, duplicate: null } }),
    );
    await work.scan(km("A2"));
    await work.scan(km("A3"));
    expect(screen.getByText("Этикетка паллеты не напечатана")).toBeTruthy();
    const saidAfterLabel = screen.queryByText(AFTER_LABEL) !== null;
    await work.press("Продолжить без этикетки");
    await work.press("Продолжить без этикетки");
    await work.settled();
    expect(kinds(at)).not.toContain("shift_closed");
    expect(localState(at)).toBeNull();
    expect(screen.queryByText(CLOSED)).toBeNull();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
    // «Смена закроется…» was never said over the label it did not concern.
    expect(saidAfterLabel).toBe(false);
  });

  it("drops the intention when the pallet's check finds its label moved but still waiting, and closes nothing on its decision", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = await palletLabelChecked(at);
    // The job fails under the screen: the check meets a label that changed, and is shown again.
    at.db.exec(
      "UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent' WHERE purpose = 'pallet'",
    );
    await work.scan(`(00)${PALLET_SSCC}`);
    expect(screen.getByText(MOVED)).toBeTruthy();
    expect(screen.getByText("Этикетка паллеты не напечатана")).toBeTruthy();
    expect(screen.queryByText(AFTER_LABEL)).toBeNull();
    await skipTwice(work);
    expect(kinds(at).slice(-2)).toEqual(["pallet_closed", "pallet_label"]);
    expect(localState(at)).toBeNull();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });

  it("drops the intention when the pallet's check cannot be resolved, and closes nothing on its next check", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const work = await palletLabelChecked(at);
    unresolvable.next = true;
    await work.scan(`(00)${PALLET_SSCC}`);
    expect(screen.getByText(MOVED)).toBeTruthy();
    expect(screen.getByText("Отсканируйте SSCC на этикетке паллеты.")).toBeTruthy();
    expect(screen.queryByText(AFTER_LABEL)).toBeNull();
    await work.scan(`(00)${PALLET_SSCC}`);
    await work.settled();
    expect(kinds(at).slice(-2)).toEqual(["pallet_closed", "pallet_label"]);
    expect(localState(at)).toBeNull();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });

  it("drops the intention when the pallet label's decision finds it moved but still waiting, and closes nothing on the next decision", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, settings: noPalletPrinter });
    const work = await twoBoxesThenClose(at);
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText(AFTER_LABEL)).toBeTruthy();
    // Another try counted under the screen: the decision meets a label that changed, still failed.
    at.db.exec("UPDATE floor_print_jobs SET attempts = attempts + 1 WHERE purpose = 'pallet'");
    await skipTwice(work);
    expect(screen.getByText(MOVED)).toBeTruthy();
    expect(screen.queryByText(AFTER_LABEL)).toBeNull();
    expect(kinds(at)).not.toContain("pallet_label");
    await skipTwice(work);
    expect(kinds(at).slice(-2)).toEqual(["pallet_closed", "pallet_label"]);
    expect(localState(at)).toBeNull();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });

  it("drops the intention when the pallet label's decision stops on a system error, and closes nothing when the label is decided again", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, settings: noPalletPrinter });
    const failing = failingSkip(at, "before");
    const work = await twoBoxesThenClose(at, failing.executor);
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText(AFTER_LABEL)).toBeTruthy();
    failing.arm();
    await skipTwice(work);
    expect(screen.getByText("Состояние этикетки не прочитано")).toBeTruthy();
    await work.press("Понятно");
    // Nothing was written: the same label stands again, and nothing says the shift closes after it.
    expect(screen.getByText("Этикетка паллеты не напечатана")).toBeTruthy();
    expect(screen.queryByText(AFTER_LABEL)).toBeNull();
    await skipTwice(work);
    expect(kinds(at).slice(-2)).toEqual(["pallet_closed", "pallet_label"]);
    expect(localState(at)).toBeNull();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });

  it("closes nothing on a later box label after the pallet label's decision was written and its answer lost", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, settings: noPalletPrinter });
    const failing = failingSkip(at, "after");
    const work = await twoBoxesThenClose(at, failing.executor);
    await work.press("Закрыть паллету и смену");
    failing.arm();
    await skipTwice(work);
    expect(screen.getByText("Состояние этикетки не прочитано")).toBeTruthy();
    expect(kinds(at).slice(-2)).toEqual(["pallet_closed", "pallet_label"]);
    await work.press("Понятно");
    expect(screen.queryByText("Этикетка паллеты не напечатана")).toBeNull();
    // Another box closes and its label's check is decided.
    await saveWorkstationSettings(
      at.local,
      printingSettings({
        assignments: { box: "zebra", pallet: null, duplicate: null },
        verifyPrintedLabel: true,
      }),
    );
    await work.scan(km("A3"));
    expect(screen.getByText("Отсканируйте SSCC на этикетке короба.")).toBeTruthy();
    expect(screen.queryByText(AFTER_LABEL)).toBeNull();
    await work.scan(`(00)${buildSscc(0, PREFIX, 1502)}`);
    await work.settled();
    expect(kinds(at)).not.toContain("shift_closed");
    expect(localState(at)).toBeNull();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });

  it("drops the intention when another label takes the screen after the pallet's, and closes nothing on that label's decision", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, settings: noPalletPrinter });
    const work = await twoBoxesThenClose(at);
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText(AFTER_LABEL)).toBeTruthy();
    // A box's label failed under the screen: it waits behind the pallet's, the same numbers.
    at.db.exec(
      "UPDATE floor_print_jobs SET state = 'failed', error_code = 'not_sent' WHERE id = " +
        "(SELECT id FROM floor_print_jobs WHERE purpose = 'box' ORDER BY created_at LIMIT 1)",
    );
    await skipTwice(work);
    expect(kinds(at).slice(-2)).toEqual(["pallet_closed", "pallet_label"]);
    expect(screen.getByText("Этикетка короба не напечатана")).toBeTruthy();
    expect(screen.queryByText(AFTER_LABEL)).toBeNull();
    await skipTwice(work);
    expect(kinds(at)).not.toContain("shift_closed");
    expect(localState(at)).toBeNull();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
  });

  it("decides nothing and closes nothing once the leave began while the pallet's label stands", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, settings: noPalletPrinter });
    const leaving = { now: false };
    const work = renderWork(at, { overrides: { isLeaving: () => leaving.now } });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.scan(km("A2"));
    await work.press("Закрыть смену");
    await screen.findByText(QUESTION);
    await work.press("Производственный брак");
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText(AFTER_LABEL)).toBeTruthy();
    leaving.now = true;
    await skipTwice(work);
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed"]);
    expect(localState(at)).toBeNull();
    expect(screen.queryByText(CLOSED)).toBeNull();
  });

  it("shows the summary read again instead of closing when the numbers changed while the pallet's label waited", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, settings: noPalletPrinter });
    const work = await twoBoxesThenClose(at);
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText(AFTER_LABEL)).toBeTruthy();
    // A code is gone under the screen: the operator was shown 2, the station has 1.
    at.db.exec("DELETE FROM floor_codes WHERE rowid = (SELECT min(rowid) FROM floor_codes)");
    await skipTwice(work);
    expect(screen.getByText(STALE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Подтвердить закрытие" })).toBeTruthy();
    expect(kinds(at).slice(-2)).toEqual(["pallet_closed", "pallet_label"]);
    expect(localState(at)).toBeNull();
    expect(screen.queryByText(CLOSED)).toBeNull();
  });

  it("says the close failed, and closes nothing, when the summary cannot be read again after the pallet's label", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1, settings: noPalletPrinter });
    const failing = failingSummaryRead(at);
    const work = await twoBoxesThenClose(at, failing.executor);
    await work.press("Закрыть паллету и смену");
    failing.arm();
    await skipTwice(work);
    expect(
      screen.getByText(
        "Не удалось записать закрытие на этом компьютере. Смена не закрыта — повторите.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Состояние этикетки не прочитано")).toBeNull();
    expect(kinds(at).slice(-2)).toEqual(["pallet_closed", "pallet_label"]);
    expect(localState(at)).toBeNull();
  });

  it("keeps the intention and its words while the pallet's label fails again on «Напечатать снова», then closes on its skip", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 1 });
    const printer = { ok: true };
    const shell = fakeHardware(async () =>
      printer.ok ? { sent: true } : { sent: false, code: "not_sent" },
    );
    const work = renderWork(at, { shell });
    await work.scanner.listening();
    await work.settled();
    await work.scan(km("A1"));
    await work.scan(km("A2"));
    printer.ok = false;
    await work.press("Закрыть смену");
    expect(await screen.findByText(QUESTION)).toBeTruthy();
    await work.press("Производственный брак");
    await work.press("Закрыть паллету и смену");
    expect(screen.getByText("Этикетка паллеты не напечатана")).toBeTruthy();
    expect(screen.getByText(AFTER_LABEL)).toBeTruthy();
    const sent = shell.sends.length;
    await work.press("Напечатать снова");
    expect(shell.sends.length).toBe(sent + 1);
    expect(screen.getByText("Этикетка паллеты не напечатана")).toBeTruthy();
    expect(screen.getByText(AFTER_LABEL)).toBeTruthy();
    expect(screen.queryByRole("region", { name: TITLE })).toBeNull();
    expect(kinds(at)).not.toContain("shift_closed");
    await skipTwice(work);
    expect(await screen.findByText(CLOSED)).toBeTruthy();
    expect(kinds(at).slice(-3)).toEqual(["pallet_closed", "pallet_label", "shift_closed"]);
  });
});

const SUMMARY: CloseSummary = {
  plannedQty: null,
  actualQty: 2,
  closedBoxes: 2,
  reasonRequired: false,
  blocker: null,
};

/** What each blocker says in the summary's blocked view; the type makes a new blocker fail here too. */
const BLOCKED_WORDS: Record<CloseBlocker["kind"], { blocker: CloseBlocker; words: string }> = {
  open_box: {
    blocker: { kind: "open_box", items: 3 },
    words: "В открытом коробе 3 шт. Сначала закройте его или очистите в «Исключениях».",
  },
  label: {
    blocker: { kind: "label" },
    words: "Этикетка короба ещё ждёт решения. Решите её, затем закройте смену.",
  },
  open_pallet: {
    blocker: { kind: "open_pallet", boxes: 2 },
    words: "Коробов на открытой паллете: 2. Сначала закройте её.",
  },
  closed: {
    blocker: { kind: "closed" },
    words: "Смена уже закрыта на этой станции.",
  },
};

function renderPanel(props: Partial<ShiftClosePanelProps> = {}, clock = { now: 0 }) {
  const handlers = { onClose: vi.fn(), onBack: vi.fn(), onLabel: vi.fn() };
  const view = render(
    <ThemeProvider>
      <ShiftClosePanel
        number="OCT26-004"
        productName="Молоко"
        summary={SUMMARY}
        note={null}
        attempt={0}
        waitingSscc={null}
        busy={false}
        clock={() => clock.now}
        {...handlers}
        {...props}
      />
    </ThemeProvider>,
  );
  clock.now += 1000;
  return { view, handlers };
}

describe("the summary's blocked view", () => {
  it.each(Object.entries(BLOCKED_WORDS))(
    "says the %s blocker in its own words",
    (kind, { blocker, words }) => {
      renderPanel({ summary: { ...SUMMARY, blocker } });
      expect(screen.getByText(words)).toBeTruthy();
      for (const [other, said] of Object.entries(BLOCKED_WORDS)) {
        if (other !== kind) expect(screen.queryByText(said.words)).toBeNull();
      }
    },
  );

  it("says an open pallet in words and offers no close where the screen gives no way to close it", () => {
    renderPanel({ summary: { ...SUMMARY, blocker: { kind: "open_pallet", boxes: 2 } } });
    expect(screen.queryByRole("button", { name: "Закрыть паллету и смену" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Подтвердить закрытие" })).toBeNull();
  });

  it("falls back to the blocked view when the pallet's capacity is not known", () => {
    renderPanel({
      summary: { ...SUMMARY, blocker: { kind: "open_pallet", boxes: 2 } },
      onClosePallet: vi.fn(),
      palletCapacity: null,
    });
    expect(screen.getByText(BLOCKED_WORDS.open_pallet.words)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Закрыть паллету и смену" })).toBeNull();
  });

  it("asks about the open pallet under the whole summary and presses «Закрыть паллету и смену», not the plain close", () => {
    const onClosePallet = vi.fn();
    const clock = { now: 0 };
    const { handlers } = renderPanel(
      {
        summary: { ...SUMMARY, blocker: { kind: "open_pallet", boxes: 2 } },
        onClosePallet,
        palletCapacity: 40,
      },
      clock,
    );
    expect(screen.getByText("Коробов закрыто")).toBeTruthy();
    expect(screen.getByText(QUESTION)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Подтвердить закрытие" })).toBeNull();
    tap("Закрыть паллету и смену");
    expect(onClosePallet).toHaveBeenCalledExactlyOnceWith(null);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it("keeps «Подтвердить закрытие» for a summary with no open pallet, even where the screen can close one", () => {
    const onClosePallet = vi.fn();
    const { handlers } = renderPanel({ onClosePallet, palletCapacity: 40 });
    expect(screen.queryByText(/На паллете/)).toBeNull();
    tap("Подтвердить закрытие");
    expect(handlers.onClose).toHaveBeenCalledExactlyOnceWith(null);
    expect(onClosePallet).not.toHaveBeenCalled();
  });
});

describe("whether two readings of the summary say the same of the open pallet", () => {
  const open = (boxes: number): CloseSummary => ({
    ...SUMMARY,
    blocker: { kind: "open_pallet", boxes },
  });

  it("compares the boxes of the open pallet, and nothing else about it", () => {
    expect(sameSummary(open(2), open(2))).toBe(true);
    expect(sameSummary(open(2), open(3))).toBe(false);
    expect(sameSummary(open(3), open(2))).toBe(false);
    expect(sameSummary(open(2), SUMMARY)).toBe(false);
    expect(sameSummary(SUMMARY, open(2))).toBe(false);
    expect(sameSummary(open(2), { ...SUMMARY, blocker: { kind: "label" } })).toBe(false);
    expect(sameSummary({ ...SUMMARY, blocker: { kind: "label" } }, open(2))).toBe(false);
  });
});
