import { buildSscc } from "@markiro/domain";
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
import type { LocalExecutor } from "../src/local/executor.js";
import { holdingWrites, km, PREFIX, rows } from "./support/floor-work.js";
import { palletStation, type PalletStation } from "./support/pallets.js";
import { printingSettings } from "./support/printing.js";
import { renderWork, type WorkHarness } from "./support/work-screen.js";

const PALLET_SSCC = buildSscc(PALLET_EXTENSION, PREFIX, 0);
const CLOSED = "Смена OCT26-004 закрыта на этой станции";
const QUESTION = "На паллете 2 из 40 коробов — закрыть?";
const TITLE = "Закрытие смены OCT26-004";
const STALE = "Пока вы смотрели итоги, смена изменилась: итоги посчитаны заново.";
const AFTER_LABEL = "Паллета закрыта. Смена закроется, как только вы решите по этикетке паллеты.";
const REFUSED = "Скан не принят: смена закрыта на этой станции.";

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
    at.db.prepare("UPDATE floor_boxes SET disassembled_at = closed_at").run();
    at.db.prepare("DELETE FROM floor_codes").run();
    await work.press("Закрыть смену");
    expect(await screen.findByRole("button", { name: "Подтвердить закрытие" })).toBeTruthy();
    expect(screen.queryByText(/На паллете/)).toBeNull();
    await work.press("Производственный брак");
    await work.press("Подтвердить закрытие");
    expect(await screen.findByText(CLOSED)).toBeTruthy();
    expect(kinds(at)).toEqual(["box_closed", "shift_closed"]);
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
  const noPalletPrinter = { assignments: { box: "zebra", pallet: null, duplicate: null } } as const;

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
    expect(kinds(at)).toEqual(["box_closed", "box_closed"]);
    expect(localState(at)).toBeNull();
    expect(document.activeElement).toBe(document.querySelector(".work-screen__last"));
    await work.press("Повторить");
    expect(kinds(at)).toEqual(["box_closed", "box_closed", "pallet_closed"]);
    expect(screen.queryByText("Паллета не закрыта")).toBeNull();
    // The intention to close is not kept: the shift is open, and the operator presses again.
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
    words: "На открытой паллете 2 коробов. Сначала закройте её.",
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
