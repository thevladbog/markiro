import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { ShiftClosePanel } from "../src/floor/close/ShiftClosePanel.js";
import { closeShift, readCloseSummary, type CloseSummary } from "../src/floor/close/shift-close.js";
import type { WorkShift } from "../src/floor/shifts/shift-copies.js";
import { formatQuantity } from "../src/floor/shifts/shift-text.js";
import type { ShiftParticipant } from "../src/host/protocol.js";
import { enteredShift, PAIRING, rows, scanContext } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
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
function panel(summary: CloseSummary) {
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
});
