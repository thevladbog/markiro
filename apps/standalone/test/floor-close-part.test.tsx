import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import {
  sameSummary,
  ShiftClosedPanel,
  ShiftClosePanel,
} from "../src/floor/close/ShiftClosePanel.js";
import {
  closeShift,
  readCloseSummary,
  readPartState,
  type CloseSummary,
} from "../src/floor/close/shift-close.js";
import { replaceShiftCopies, type WorkShift } from "../src/floor/shifts/shift-copies.js";
import { receiptStatements } from "../src/local/facts-sender.js";
import { formatQuantity } from "../src/floor/shifts/shift-text.js";
import type { ShiftParticipant } from "../src/host/protocol.js";
import { enteredShift, PAIRING, rows, scanContext } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { renderWork } from "./support/work-screen.js";
import {
  enteredOf,
  OTHER_STATION,
  participant,
  sharedShift,
  STATION_ROW,
} from "./support/multi-station.js";

/**
 * This station (no code yet) and another station in `other` state (`"none"`: this station alone),
 * 2 to the line, 1 200 planned.
 */
async function sharedStation(other: ShiftParticipant["state"] | "none", maxStations = 2) {
  const opened = openLocalDb();
  const rowsOf =
    other === "none"
      ? [{ row: STATION_ROW, accepted: 0 }]
      : [
          { row: STATION_ROW, accepted: 0 },
          { row: participant(OTHER_STATION, "Станция линии 2", other), accepted: 300 },
        ];
  const shift: WorkShift = await enteredShift(
    opened.executor,
    enteredOf(sharedShift({ participants: rowsOf, maxStations, myState: "active" })),
  );
  return { ...opened, shift };
}

describe("the summary of this station's part of a shared shift (plan 2b)", () => {
  it("names the whole shift's count and that the shift waits for the others; no reason asked", async () => {
    const { executor, shift } = await sharedStation("active");
    expect(await readCloseSummary(executor, PAIRING, shift.copy.id, true)).toMatchObject({
      plannedQty: 1200,
      actualQty: 0,
      reasonRequired: false,
      blocker: null,
      part: { closesShift: false, total: 300, online: true },
    });
  });

  it("asks the last closer for the reason online, and never offline (spec §12.9)", async () => {
    const { executor, shift } = await sharedStation("closed");
    expect(await readCloseSummary(executor, PAIRING, shift.copy.id, true)).toMatchObject({
      reasonRequired: true,
      part: { closesShift: true, total: 300, online: true },
    });
    expect(await readCloseSummary(executor, PAIRING, shift.copy.id, false)).toMatchObject({
      reasonRequired: false,
      part: { closesShift: true, online: false },
    });
  });

  it("keeps stage 2a's reason, offline too, for a shift only this station ever worked", async () => {
    const { executor, shift } = await sharedStation("none");
    expect(await readCloseSummary(executor, PAIRING, shift.copy.id, false)).toMatchObject({
      reasonRequired: true,
      part: { closesShift: true, total: 0, online: false },
    });
  });

  it("closes the last part offline without a reason: the record carries none, the host marks it", async () => {
    const { db, executor, shift } = await sharedStation("closed");
    const result = await closeShift(scanContext(executor, shift), null, [], false);
    expect(result).toMatchObject({ kind: "closed", record: { reasonCode: null, actualQty: 0 } });
    expect(rows(db, "SELECT kind FROM outbox WHERE shift_id = ?", shift.copy.id)).toEqual([
      { kind: "shift_closed" },
    ]);
  });

  it("refuses the last close online without the reason the panel asks for", async () => {
    const { executor, shift } = await sharedStation("closed");
    expect(await closeShift(scanContext(executor, shift), null, [], true)).toEqual({
      kind: "reason_required",
    });
    expect(
      await closeShift(scanContext(executor, shift), "equipment_stop", [], true),
    ).toMatchObject({ kind: "closed", record: { reasonCode: "equipment_stop" } });
  });
});

/** The panel over `summary`; `pause()` lets the guard after a change of view pass, as an operator's pause does. */
function panel(summary: CloseSummary, extra: Partial<ComponentProps<typeof ShiftClosePanel>> = {}) {
  const onClose = vi.fn();
  const clock = { now: 0 };
  render(
    <ThemeProvider>
      <ShiftClosePanel
        number="OCT26-004"
        productName="Молоко 3,2% 0,9 л"
        summary={summary}
        note={null}
        attempt={0}
        waitingSscc={null}
        busy={false}
        onClose={onClose}
        onBack={vi.fn()}
        onLabel={vi.fn()}
        ownPart
        clock={() => clock.now}
        {...extra}
      />
    </ThemeProvider>,
  );
  return {
    onClose,
    pause: () => {
      clock.now += 1_000;
    },
  };
}

const PART: CloseSummary = {
  plannedQty: 600,
  actualQty: 280,
  closedBoxes: 23,
  reasonRequired: false,
  blocker: null,
  part: { closesShift: false, total: 560, online: true },
};

describe("the close panel of a part (plan 2b)", () => {
  it("names the part, both counts, the whole shift against the plan, and that the others close later", () => {
    const { onClose, pause } = panel(PART);
    expect(
      screen.getByRole("heading", { name: "Закрытие моей части смены OCT26-004" }),
    ).toBeTruthy();
    expect(screen.getByText("Моя станция")).toBeTruthy();
    expect(screen.getByText("Всего в смене")).toBeTruthy();
    expect(screen.getByText("План смены")).toBeTruthy();
    expect(screen.getByText("−40")).toBeTruthy();
    expect(screen.getByText("План не выполнен: не хватает 40 шт.")).toBeTruthy();
    expect(screen.getByText("Смена закроется, когда закроют остальные.")).toBeTruthy();
    expect(
      screen.queryByRole("group", { name: "Факт не совпадает с планом. Выберите причину:" }),
    ).toBeNull();
    pause();
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить закрытие части" }));
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it("asks the last closer online for one of the six reasons before the close", () => {
    const { onClose, pause } = panel({
      ...PART,
      reasonRequired: true,
      part: { closesShift: true, total: 560, online: true },
    });
    expect(
      screen.getByText("Остальные уже закрыли свои части: смена закроется вместе с вашей."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Подтвердить закрытие части" })).toHaveProperty(
      "disabled",
      true,
    );
    pause();
    fireEvent.click(screen.getByRole("button", { name: "Остановка оборудования" }));
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить закрытие части" }));
    expect(onClose).toHaveBeenCalledWith("equipment_stop");
  });

  it("says what an offline close leaves to the host and the office", () => {
    panel({ ...PART, part: { closesShift: true, total: 560, online: false } });
    expect(
      screen.getByText(
        "Нет связи с хостом: ваша часть закроется сейчас, итог смены посчитает хост. Если понадобится причина расхождения, её укажет офис.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(formatQuantity(560))).toBeTruthy();
  });

  it("asks the reason of a shift only this station worked even offline, and says so, not «the office will give it»", () => {
    const { onClose, pause } = panel({
      ...PART,
      reasonRequired: true,
      part: { closesShift: true, total: 280, online: false },
    });
    expect(
      screen.getByText(
        "Нет связи с хостом: ваша часть закроется сейчас, итог смены посчитает хост. Эту смену вела только ваша станция, поэтому выберите причину расхождения с планом.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/её укажет офис/)).toBeNull();
    pause();
    fireEvent.click(screen.getByRole("button", { name: "Остановка оборудования" }));
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить закрытие части" }));
    expect(onClose).toHaveBeenCalledWith("equipment_stop");
  });

  it("closes an open pallet with the part, and says that cannot be taken back", () => {
    const onClosePallet = vi.fn();
    const { onClose, pause } = panel(
      { ...PART, blocker: { kind: "open_pallet", boxes: 4 } },
      { palletCapacity: 12, onClosePallet },
    );
    expect(
      screen.getByText(
        "Паллета закроется с этими коробами, её этикетка уйдёт на печать, а ваша часть смены закроется. Отменить это нельзя.",
      ),
    ).toBeTruthy();
    pause();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть паллету и мою часть" }));
    expect(onClosePallet).toHaveBeenCalledWith(null);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("words the whole panel by the summary it shows, whatever the screen's own idea of the shift", () => {
    const solo: CloseSummary = { ...PART };
    delete solo.part;
    // The summary says solo (the read of the participation failed there): title and body agree.
    const first = render(
      <ThemeProvider>
        <ShiftClosePanel
          number="OCT26-004"
          productName="Молоко"
          summary={solo}
          note={null}
          attempt={0}
          waitingSscc={null}
          busy={false}
          onClose={vi.fn()}
          onBack={vi.fn()}
          onLabel={vi.fn()}
          ownPart
        />
      </ThemeProvider>,
    );
    expect(screen.getByRole("heading", { name: "Закрытие смены OCT26-004" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Подтвердить закрытие" })).toBeTruthy();
    first.unmount();
    // Before the summary is read, the screen's own idea decides.
    panel({ ...PART }, { summary: null });
    expect(
      screen.getByRole("heading", { name: "Закрытие моей части смены OCT26-004" }),
    ).toBeTruthy();
  });
});

describe("a re-read summary says the same (sameSummary, plan 2b)", () => {
  const base: CloseSummary = { ...PART };
  it("ignores the whole shift's count, which moves with the other devices", () => {
    expect(
      sameSummary(base, { ...base, part: { closesShift: false, total: 999, online: true } }),
    ).toBe(true);
  });
  it("differs when the part now closes the shift, when the link changed, or when the shift stopped being shared", () => {
    expect(
      sameSummary(base, { ...base, part: { closesShift: true, total: 560, online: true } }),
    ).toBe(false);
    expect(
      sameSummary(base, { ...base, part: { closesShift: false, total: 560, online: false } }),
    ).toBe(false);
    const solo: CloseSummary = { ...base };
    delete solo.part;
    expect(sameSummary(base, solo)).toBe(false);
    expect(sameSummary(solo, solo)).toBe(true);
  });
});

describe("the work screen's close of a part (plan 2b)", () => {
  it("online: passes the link and the part to the panel — the last closer is asked the reason, then the closed panel waits in the outbox, and after the receipt for the others", async () => {
    const { db, executor, shift } = await sharedStation("active");
    const work = renderWork({ local: executor, shift }, { overrides: { online: true } });
    await work.settled();
    await work.press("Закрыть мою часть");
    expect(
      await screen.findByRole("region", { name: "Закрытие моей части смены OCT26-004" }),
    ).toBeTruthy();
    // The other station is still active: the shift waits for it, no reason is asked.
    expect(screen.getByText("Смена закроется, когда закроют остальные.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: /Факт не совпадает/ })).toBeNull();
    await work.press("Подтвердить закрытие части");
    expect(
      await screen.findByRole("group", { name: "Ваша часть смены OCT26-004 закрыта" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Ваша часть закрыта на этой станции. Данные будут отправлены автоматически.",
      ),
    ).toBeTruthy();
    await answer(executor, db, "accepted", { partClosed: true });
    await act(async () => {
      work.rerender({ outboxVersion: 1 });
    });
    await waitFor(() =>
      expect(
        screen.getByText(
          "Хост принял закрытие вашей части. Смена закроется, когда закроют остальные.",
        ),
      ).toBeTruthy(),
    );
  });

  it("offline: the last closer is not asked, and the panel says the office will give the reason", async () => {
    const { executor, shift } = await sharedStation("closed");
    const work = renderWork({ local: executor, shift }, { overrides: { online: false } });
    await work.settled();
    await work.press("Закрыть мою часть");
    await screen.findByRole("region", { name: "Закрытие моей части смены OCT26-004" });
    expect(screen.getByText(/её укажет офис/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: /Факт не совпадает/ })).toBeNull();
  });

  it("online: asks the last closer the reason", async () => {
    const { executor, shift } = await sharedStation("closed");
    const work = renderWork({ local: executor, shift }, { overrides: { online: true } });
    await work.settled();
    await work.press("Закрыть мою часть");
    await screen.findByRole("region", { name: "Закрытие моей части смены OCT26-004" });
    expect(screen.getByRole("group", { name: /Факт не совпадает/ })).toBeTruthy();
  });
});

/** The part's close record answered `outcome` with `details`, as `sendFactBatch` stores a receipt. */
async function answer(
  executor: Awaited<ReturnType<typeof sharedStation>>["executor"],
  db: Awaited<ReturnType<typeof sharedStation>>["db"],
  outcome: "accepted" | "rejected",
  details?: Record<string, unknown>,
) {
  const [record] = rows(db, "SELECT id FROM outbox WHERE kind = 'shift_closed'");
  const id = String(record?.["id"]);
  await executor.transaction(
    receiptStatements(
      PAIRING,
      JSON.stringify([
        {
          id,
          kind: "shift_closed",
          outcome,
          ...(outcome === "rejected" ? { code: "invalid_record" } : {}),
          ...(details === undefined ? {} : { details }),
        },
      ]),
      "2026-10-08T10:00:00.000Z",
    ),
  );
}

describe("what became of the part's close (plan 2b, host D8)", () => {
  it("waits in the outbox, then waits for the others, then says the shift closed", async () => {
    const { db, executor, shift } = await sharedStation("active");
    await closeShift(scanContext(executor, shift), null, [], false);
    expect(await readPartState(executor, PAIRING, shift.copy.id)).toBe("queued");
    await answer(executor, db, "accepted", { partClosed: true });
    expect(await readPartState(executor, PAIRING, shift.copy.id)).toBe("waiting");
    // The same record sent again after a lost answer gets the same receipt: nothing else changes.
    await answer(executor, db, "accepted", { partClosed: true });
    expect(await readPartState(executor, PAIRING, shift.copy.id)).toBe("waiting");
    const closed = sharedShift({
      participants: [
        { row: participant(STATION_ROW.deviceId, "Станция линии 1", "closed"), accepted: 0 },
        { row: participant(OTHER_STATION, "Станция линии 2", "closed"), accepted: 300 },
      ],
      myState: "closed",
      asOf: "2026-10-08T14:10:05Z",
    });
    await replaceShiftCopies(
      executor,
      PAIRING,
      [{ ...closed, status: "closed", closedAt: "2026-10-08T14:10:00Z" }],
      1_790_000_100_000,
    );
    expect(await readPartState(executor, PAIRING, shift.copy.id)).toBe("shift_closed");
  });

  it("says a last part closed the shift, without the reason it needed, or before it (already closed)", async () => {
    for (const [details, state] of [
      [undefined, "shift_closed"],
      [{ reasonMissing: true }, "reason_missing"],
      [{ alreadyClosed: true }, "shift_closed"],
    ] as const) {
      const { db, executor, shift } = await sharedStation("closed");
      await closeShift(scanContext(executor, shift), null, [], false);
      await answer(executor, db, "accepted", details);
      expect(await readPartState(executor, PAIRING, shift.copy.id)).toBe(state);
    }
  });

  it("says a refused close, and nothing for a shift this station did not close", async () => {
    const { db, executor, shift } = await sharedStation("active");
    expect(await readPartState(executor, PAIRING, shift.copy.id)).toBeNull();
    await closeShift(scanContext(executor, shift), null, [], false);
    await answer(executor, db, "rejected");
    expect(await readPartState(executor, PAIRING, shift.copy.id)).toBe("refused");
  });
});

describe("the closed part's panel (plan 2b)", () => {
  it.each([
    ["queued", "Ваша часть закрыта на этой станции. Данные будут отправлены автоматически."],
    ["waiting", "Хост принял закрытие вашей части. Смена закроется, когда закроют остальные."],
    ["shift_closed", "Смена закрыта: все её части закрыты."],
    ["reason_missing", "Смена закрыта, но без причины расхождения с планом: её укажет офис."],
    [
      "refused",
      "Хост не принял закрытие вашей части. Откройте «Очередь отправки»: там видно, что делать.",
    ],
  ] as const)("says %s in its words", (part, words) => {
    render(
      <ThemeProvider>
        <ShiftClosedPanel
          number="OCT26-004"
          record={{ actualQty: 280, closedBoxCount: 23 }}
          linkHeld={false}
          leaving={false}
          onDone={vi.fn()}
          part={part}
        />
      </ThemeProvider>,
    );
    expect(screen.getByRole("group", { name: "Ваша часть смены OCT26-004 закрыта" })).toBeTruthy();
    expect(screen.getByText(words)).toBeTruthy();
    expect(screen.getByText("Принято: 280 шт., коробов: 23.")).toBeTruthy();
  });
});
