import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeShift } from "../src/host/protocol.js";
import type { FakeOfficeSession } from "./support/office.js";
import { hasRowAction, pressRowAction } from "./support/row-menu.js";
import { chooseText, chooseValue, optionTexts } from "./support/select.js";
import {
  ACTIVE,
  CLOSED,
  expectFocusedNotice,
  freezeToday,
  openShifts,
  pickDate,
  PLANNED,
  SHARED,
  SHARED_NO_REASON,
  shiftsSession,
} from "./support/shifts.js";

const TOKEN = "office-session-token";
const ACTION = "Указать причину смены OCT26-004";
const TITLE = "Причина смены OCT26-004";
const UNITS = new Intl.NumberFormat("ru");
const SUPPLIED: OfficeShift = {
  ...SHARED_NO_REASON,
  closeReasonMissing: undefined,
  closeReasonCode: "equipment_stop",
  rev: 89,
};

function api(code: string, details: Record<string, unknown> = {}, status = 409): HostError {
  return new HostError({ kind: "api", code, status, message: code, details });
}

async function openReason(session: FakeOfficeSession): Promise<HTMLElement> {
  await openShifts(session);
  pressRowAction(screen, ACTION);
  return screen.findByRole("dialog", { name: TITLE });
}

function save(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить причину" }));
}

describe("the shift closed without its reason (plan 2b, spec §12.9)", () => {
  it("is marked in the list, with the action to give the reason", async () => {
    await openShifts(shiftsSession([SHARED_NO_REASON]));
    expect(screen.getByText("Причина не указана")).toBeTruthy();
    expect(hasRowAction(screen, ACTION)).toBe(true);
  });

  it("offers the action for a closed shift that lacks the reason only", async () => {
    await openShifts(shiftsSession([SHARED, CLOSED]));
    expect(hasRowAction(screen, ACTION)).toBe(false);
    expect(hasRowAction(screen, "Указать причину смены OCT26-001/S")).toBe(false);
    expect(screen.queryByText("Причина не указана")).toBeNull();
  });

  it("offers it on the card too", async () => {
    await openShifts(shiftsSession([SHARED_NO_REASON]));
    fireEvent.click(screen.getByRole("link", { name: "Карточка смены OCT26-004" }));
    await screen.findByRole("heading", { name: "Смена OCT26-004" });
    fireEvent.click(screen.getByRole("button", { name: "Указать причину" }));
    expect(await screen.findByRole("dialog", { name: TITLE })).toBeTruthy();
  });

  it("says the plan and what was accepted, and lists the six reasons in the station's words", async () => {
    const dialog = await openReason(shiftsSession([SHARED_NO_REASON]));
    // Testing Library collapses the no-break space of «1 200» to a plain one in the text it reads.
    const intro = `План смены — ${UNITS.format(1200)} шт, принято 547 шт. Устройства закрыли смену, не назвав причину расхождения с планом. Выберите её из списка: она попадёт в журнал действий.`;
    expect(within(dialog).getByText(intro.replace(/\s/g, " "))).toBeTruthy();
    expect(optionTexts("Причина расхождения")).toEqual([
      "Производственный брак",
      "Недостаток сырья",
      "Остановка оборудования",
      "Изменение производственного задания",
      "Ошибка в плановом количестве",
      "Другое производственное отклонение",
    ]);
  });

  it("asks for a choice and sends nothing without one", async () => {
    const session = shiftsSession([SHARED_NO_REASON]);
    const dialog = await openReason(session);
    save(dialog);
    expect(await within(dialog).findByText("Выберите причину из списка")).toBeTruthy();
    expect(session.api.setShiftCloseReason).not.toHaveBeenCalled();
  });

  it("sends the code over the loaded revision, says so and reads the list again", async () => {
    const session = shiftsSession([SHARED_NO_REASON]);
    session.api.setShiftCloseReason.mockResolvedValue(SUPPLIED);
    const dialog = await openReason(session);
    chooseValue("Причина расхождения", "equipment_stop");
    save(dialog);
    await waitFor(() =>
      expect(session.api.setShiftCloseReason).toHaveBeenCalledWith(TOKEN, SHARED_NO_REASON.id, {
        reasonCode: "equipment_stop",
        expectedRev: 88,
      }),
    );
    await expectFocusedNotice("Причина смены OCT26-004 указана.");
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("says it is already set when the office or another PC gave it first, and reads the list again", async () => {
    const session = shiftsSession([SHARED_NO_REASON]);
    session.api.setShiftCloseReason.mockRejectedValue(
      api("conflict", { constraint: "close_reason_not_missing" }),
    );
    const dialog = await openReason(session);
    chooseValue("Причина расхождения", "equipment_stop");
    save(dialog);
    expect(
      await within(dialog).findByText("Причина уже указана. Список смен обновлён."),
    ).toBeTruthy();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    expect(within(dialog).getByRole("button", { name: "Сохранить причину" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("offers to load the data again after a stale write and never retries with the host's revision", async () => {
    const session = shiftsSession([SHARED_NO_REASON]);
    session.api.setShiftCloseReason.mockRejectedValue(api("stale_revision", { currentRev: 90 }));
    const dialog = await openReason(session);
    chooseValue("Причина расхождения", "equipment_stop");
    save(dialog);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(session.api.setShiftCloseReason).toHaveBeenCalledTimes(1);
  });

  it("puts a code the host did not take under the field", async () => {
    const session = shiftsSession([SHARED_NO_REASON]);
    session.api.setShiftCloseReason.mockRejectedValue(
      api("validation_failed", { field: "reasonCode" }, 400),
    );
    const dialog = await openReason(session);
    chooseValue("Причина расхождения", "equipment_stop");
    save(dialog);
    expect(
      await within(dialog).findByText("Хост не принял это значение. Проверьте его."),
    ).toBeTruthy();
  });

  it("is not offered for an active shift", async () => {
    await openShifts(shiftsSession([ACTIVE]));
    expect(hasRowAction(screen, ACTION)).toBe(false);
  });
});

/**
 * `SHARED_NO_REASON` made in January: out of the default list's 31 days and of any period around
 * October. A host of this build adds it to every list while the reason is owed (spec §12.9).
 */
const OLD_NO_REASON: OfficeShift = {
  ...SHARED_NO_REASON,
  productionDate: "2026-01-10",
  plannedDate: "2026-01-10",
  closedAt: "2026-01-10T14:10:00Z",
};
const BEYOND =
  "Смены, закрытые без причины, показаны и вне периода, пока причина не указана (таких: 1). В итог они не входят.";
const totalsText = () => screen.getByText(/^Итого по выбранным сменам/).textContent;

describe("a shift closed without its reason outside the period the list shows", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is listed with its mark and its action, says why it is there, and stays out of the totals", async () => {
    freezeToday();
    await openShifts(shiftsSession([PLANNED, OLD_NO_REASON]));
    expect(screen.getByText("Причина не указана")).toBeTruthy();
    expect(hasRowAction(screen, ACTION)).toBe(true);
    expect(screen.getByText(BEYOND)).toBeTruthy();
    expect(totalsText()).toBe(
      "Итого по выбранным сменам: смен 1 · выпуск 0 шт · коробов 0 · паллет 0",
    );
  });

  it("follows the status filter like any shift", async () => {
    freezeToday();
    await openShifts(shiftsSession([PLANNED, OLD_NO_REASON]));
    chooseText("Статус", "Запланирована");
    expect(screen.queryByText("Причина не указана")).toBeNull();
    expect(screen.queryByText(BEYOND)).toBeNull();
  });

  it("is told apart from the shifts of a chosen period", async () => {
    freezeToday();
    const session = shiftsSession([PLANNED, OLD_NO_REASON]);
    await openShifts(session);
    session.api.listShifts.mockResolvedValue([CLOSED, OLD_NO_REASON]);
    pickDate("Дата производства с", "1 октября 2026");
    pickDate("Дата производства по", "8 октября 2026");
    await screen.findByText("Показаны смены с датой производства с 01.10.2026 по 08.10.2026.");
    await waitFor(() => expect(screen.getByText(BEYOND)).toBeTruthy());
    expect(totalsText()).toMatch(/^Итого по выбранным сменам: смен 1 · /);
  });

  it("says nothing more of a shift owing a reason that is inside the list's own window", async () => {
    freezeToday();
    await openShifts(shiftsSession([PLANNED, SHARED_NO_REASON]));
    expect(screen.getByText("Причина не указана")).toBeTruthy();
    expect(screen.queryByText(BEYOND)).toBeNull();
    expect(totalsText()).toMatch(/^Итого по выбранным сменам: смен 2 · /);
  });
});
