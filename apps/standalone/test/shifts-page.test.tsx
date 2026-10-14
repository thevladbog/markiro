import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SHIFT_CLOSE_REASON_CODES } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { OfficeShift } from "../src/host/protocol.js";
import { fakeOfficeSession, renderOffice, TECHNOLOGIST } from "./support/office.js";
import {
  ACTIVE,
  AYRAN_ARCHIVED,
  BOX_58,
  CLOSED,
  freezeToday,
  KEFIR_DRAFT,
  LINE_10,
  LINE_2,
  MILK,
  MILK_BOX,
  NORTH,
  OLD_BOX,
  openShifts,
  OLD_LINE,
  PALLET,
  pickDate,
  PLANNED,
  shiftRow,
  shiftRows,
  shiftsSession,
  WATER,
} from "./support/shifts.js";
import { chooseText, optionTexts, shownIn } from "./support/select.js";

const SESSION_TOKEN = "office-session-token";

/** The text of the cells of the shift numbered `number`, left to right. */
function cells(number: string): (string | null)[] {
  return within(shiftRow(number))
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
}

/** `count` planned shifts numbered OCT26-001… on line 2. */
function numbered(count: number): OfficeShift[] {
  return Array.from({ length: count }, (_, n) => ({
    ...PLANNED,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    number: `OCT26-${String(n + 1).padStart(3, "0")}`,
  }));
}

describe("office shifts: the list", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is in the menu under «Производство», right after «Линии», for both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = renderOffice(fakeOfficeSession(user === undefined ? {} : { user }));
      await screen.findByRole("link", { name: "Смены" });
      const links = screen.getAllByRole("link").map((link) => link.textContent);
      expect(links[links.indexOf("Линии") + 1]).toBe("Смены");
      expect(screen.getByText("Производство")).toBeTruthy();
      view.unmount();
    }
  });

  it("lists the shifts in the host's order with their date, line, product, mode, plan and status", async () => {
    const session = shiftsSession();
    await openShifts(session);
    expect(session.api.listShifts).toHaveBeenCalledWith(SESSION_TOKEN);
    expect(shiftRows().map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      "OCT26-005",
      "OCT26-004",
      "OCT26-001/S",
    ]);
    // The actions, for those who may plan, follow in the last column.
    expect(cells("OCT26-005").slice(0, 7)).toEqual([
      "OCT26-005",
      "09.10.2026",
      "Линия 10",
      "Вода 0,5 л",
      "Агрегация",
      "—",
      "◷Запланирована",
    ]);
    expect(cells("OCT26-004").slice(0, 7)).toEqual([
      "OCT26-004",
      "08.10.2026",
      "Линия 2",
      "Молоко 3,2% 0,9 лдля: ООО «Северный берег»",
      "Агрегация",
      // A no-break space between the thousands.
      "1\u00a0200",
      "▸Активна",
    ]);
    expect(screen.getByText("Показано 3 из 3")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Выпуск" })).toBeTruthy();
    expect(
      screen.getByText(
        "Показаны запланированные и активные смены и закрытые за последний 31 день. Чтобы найти другие, выберите период.",
      ),
    ).toBeTruthy();
  });

  it("shows what an active and a closed shift put in closed boxes, and nothing for a planned one", async () => {
    const big: OfficeShift = {
      ...ACTIVE,
      id: "10000000-0000-4000-8000-000000000009",
      number: "B-1",
      totals: {
        ...ACTIVE.totals,
        acceptedUnits: 12_010,
        unitsInClosedBoxes: 12_000,
        closedBoxes: 1000,
      },
    };
    await openShifts(shiftsSession([PLANNED, ACTIVE, CLOSED, big]));
    expect(cells("OCT26-005")[7]).toBe("—");
    // The codes in closed boxes, not every accepted code: one box of the active shift is open.
    expect(cells("OCT26-004")[7]).toBe("540 шт · 45 кор.");
    expect(cells("OCT26-001/S")[7]).toBe("492 шт · 41 кор.");
    // A no-break space between the thousands.
    expect(cells("B-1")[7]).toBe("12\u00a0000 шт · 1\u00a0000 кор.");
  });

  it("says why a closed shift closed, with data after closing, a station's reason in words and the office's in its own", async () => {
    const byOffice: OfficeShift = {
      ...ACTIVE,
      id: "3e1b7a5d-9f4a-4c6b-8d0e-5a8f1b4c7d9e",
      number: "OCT26-002",
      status: "closed",
      closeReasonText: "Станция линии 2 вышла из строя",
      closedAt: "2026-10-08T15:00:00Z",
    };
    const newerCode: OfficeShift = {
      ...CLOSED,
      id: "4f2c8b6e-0a5b-4d7c-9e1f-6b9a2c5d8e0f",
      number: "OCT26-003/S",
      closeReasonCode: "power_cut",
      lateDataAt: null,
    };
    await openShifts(shiftsSession([CLOSED, byOffice, newerCode]));
    expect(cells("OCT26-001/S")[6]).toBe(
      "✓Закрыта!Данные после закрытияПричина расхождения: Остановка оборудования",
    );
    expect(cells("OCT26-002")[6]).toBe("✓ЗакрытаЗакрыта в офисе: Станция линии 2 вышла из строя");
    // A code a newer host adds is shown as it is.
    expect(cells("OCT26-003/S")[6]).toBe("✓ЗакрытаПричина расхождения: power_cut");
  });

  it("marks a planned shift a station will not open: an archived or draft product, a template off or not of the product's group", async () => {
    const shifts: OfficeShift[] = [
      {
        ...PLANNED,
        id: "10000000-0000-4000-8000-000000000001",
        number: "A-1",
        productId: AYRAN_ARCHIVED.id,
      },
      {
        ...PLANNED,
        id: "10000000-0000-4000-8000-000000000002",
        number: "A-2",
        productId: KEFIR_DRAFT.id,
      },
      {
        ...PLANNED,
        id: "10000000-0000-4000-8000-000000000003",
        number: "A-3",
        boxTemplateId: OLD_BOX.id,
      },
      // Milk's template on water: water is not of group 8.
      {
        ...PLANNED,
        id: "10000000-0000-4000-8000-000000000004",
        number: "A-4",
        boxTemplateId: MILK_BOX.id,
      },
      { ...PLANNED, id: "10000000-0000-4000-8000-000000000005", number: "A-5" },
      // Pallets: a pallet template that is off, or a box one, keeps the shift closed (plan О-Ф).
      {
        ...PLANNED,
        id: "10000000-0000-4000-8000-000000000007",
        number: "A-7",
        palletsEnabled: true,
        palletBoxCapacity: 40,
        palletTemplateId: OLD_BOX.id,
      },
      {
        ...PLANNED,
        id: "10000000-0000-4000-8000-000000000008",
        number: "A-8",
        palletsEnabled: true,
        palletBoxCapacity: 40,
        palletTemplateId: PALLET.id,
      },
      // An open shift has its layout in its snapshot: no mark.
      {
        ...ACTIVE,
        id: "10000000-0000-4000-8000-000000000006",
        number: "A-6",
        boxTemplateId: OLD_BOX.id,
      },
    ];
    await openShifts(shiftsSession(shifts));
    expect(cells("A-1")[6]).toBe("◷Запланирована!Не откроется: товар в архиве");
    expect(cells("A-2")[6]).toBe("◷Запланирована!Не откроется: товар — черновик");
    expect(cells("A-3")[6]).toBe(
      "◷Запланирована!Не откроется: шаблон выключен или не подходит товару",
    );
    expect(cells("A-4")[6]).toBe(
      "◷Запланирована!Не откроется: шаблон выключен или не подходит товару",
    );
    expect(cells("A-5")[6]).toBe("◷Запланирована");
    expect(cells("A-7")[6]).toBe(
      "◷Запланирована!Не откроется: шаблон паллеты выключен или не подходит товару",
    );
    expect(cells("A-8")[6]).toBe("◷Запланирована");
    expect(cells("A-6")[6]).toBe("▸Активна");
    // A warning is a sentence of its own under the status chip, never a chip: a long warning in
    // a chip is a tall box in a narrow column.
    const warning = screen.getByText("Не откроется: товар в архиве");
    expect(warning.closest(".shift-cell__warn")).not.toBeNull();
    expect(warning.closest(".mk-chip")).toBeNull();
    expect(warning.closest(".shift-cell")?.querySelectorAll(".mk-chip")).toHaveLength(1);
  });

  it("keeps the list when a list of names does not load, names records by their ids and claims no mark it cannot check", async () => {
    const session = shiftsSession([{ ...PLANNED, boxTemplateId: OLD_BOX.id }, ACTIVE]);
    session.api.listLines.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    session.api.listTemplates.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    await openShifts(session);
    await screen.findByText(/Не все справочники загрузились/);
    expect(cells("OCT26-005").slice(2, 4)).toEqual(["Линия 0b7e7dcb…", "Вода 0,5 л"]);
    expect(cells("OCT26-005")[6]).toBe("◷Запланирована");
    session.api.listLines.mockResolvedValue([LINE_10, LINE_2]);
    session.api.listTemplates.mockResolvedValue([BOX_58, OLD_BOX]);
    session.api.listProducts.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(cells("OCT26-005")[2]).toBe("Линия 10"));
    expect(cells("OCT26-005")[6]).toBe(
      "◷Запланирована!Не откроется: шаблон выключен или не подходит товару",
    );
    expect(screen.queryByText(/Не все справочники загрузились/)).toBeNull();
    // Only what failed is read again.
    expect(session.api.listProducts).not.toHaveBeenCalled();
  });

  it("names an archived line and counterparty as archived, and an unknown product by its id", async () => {
    const shift: OfficeShift = {
      ...ACTIVE,
      lineId: "9b2e4a6c-1d3f-4e5a-8b7c-6d5e4f3a2b1c",
      counterpartyId: "e3c8d0f2-5a4b-4c7d-9e6f-0a1b2c3d4e5f",
      productId: "5e6f7081-92a3-4b45-8d6e-7f8091a2b3c4",
    };
    await openShifts(shiftsSession([shift]));
    expect(cells("OCT26-004").slice(2, 4)).toEqual([
      "Линия 1 (в архиве)",
      "Товар 5e6f7081…для: ООО «Юг» (в архиве)",
    ]);
  });

  it("shows only an error with «Повторить» when the shifts do not load, and reads them again", async () => {
    const session = shiftsSession();
    session.api.listShifts.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    renderOffice(session);
    fireEvent.click(await screen.findByRole("link", { name: "Смены" }));
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("OCT26-004")).toBeTruthy();
    expect(session.api.listShifts).toHaveBeenCalledTimes(2);
  });

  it("filters by status and line and searches the number and the product's name, without case", async () => {
    await openShifts(shiftsSession());
    const numbers = () =>
      shiftRows().map((row) => within(row).getAllByRole("cell")[0]?.textContent);
    chooseText("Статус", "Активна");
    expect(numbers()).toEqual(["OCT26-004"]);
    chooseText("Статус", "Все статусы");
    chooseText("Линия", LINE_10.name);
    expect(numbers()).toEqual(["OCT26-005"]);
    chooseText("Линия", "Все линии");
    fireEvent.change(screen.getByLabelText("Поиск по номеру и товару"), {
      target: { value: "мОЛОКО" },
    });
    expect(numbers()).toEqual(["OCT26-004", "OCT26-001/S"]);
    fireEvent.change(screen.getByLabelText("Поиск по номеру и товару"), {
      target: { value: " /s " },
    });
    expect(numbers()).toEqual(["OCT26-001/S"]);
    expect(screen.getByText("Показано 1 из 3")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Поиск по номеру и товару"), {
      target: { value: "кефир" },
    });
    expect(screen.getByText("Ничего не найдено. Измените отбор.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(numbers()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Сбросить" })).toBeNull();
  });

  it("says when there are no shifts at all", async () => {
    await openShifts(shiftsSession([]));
    expect(screen.getByText("Смен пока нет.")).toBeTruthy();
  });

  it("pages 25 shifts at a time, and a new filter goes back to the first page", async () => {
    await openShifts(shiftsSession(numbered(26)));
    expect(shiftRows()).toHaveLength(25);
    const pager = screen.getByRole("navigation", { name: "Страницы списка смен" });
    fireEvent.click(within(pager).getByRole("button", { name: "Вперёд" }));
    expect(shiftRows().map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      "OCT26-026",
    ]);
    expect(within(pager).getByText("Страница 2 из 2")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Поиск по номеру и товару"), {
      target: { value: "OCT26" },
    });
    expect(shiftRows()).toHaveLength(25);
  });

  it("asks the host for a chosen period of production dates, and for its own list again once both dates are cleared", async () => {
    const session = shiftsSession();
    await openShifts(session);
    pickDate("Дата производства с", "1 сентября 2026", 1);
    // One date is not a period: the list stays and nothing more is asked.
    expect(screen.getByText("Укажите обе даты периода. Пока показан прежний список.")).toBeTruthy();
    expect(session.api.listShifts).toHaveBeenCalledTimes(1);
    pickDate("Дата производства по", "8 октября 2026");
    await waitFor(() =>
      expect(session.api.listShifts).toHaveBeenLastCalledWith(SESSION_TOKEN, {
        from: "2026-09-01",
        to: "2026-10-08",
      }),
    );
    expect(
      await screen.findByText("Показаны смены с датой производства с 01.09.2026 по 08.10.2026."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Очистить дату: Дата производства с" }));
    fireEvent.click(screen.getByRole("button", { name: "Очистить дату: Дата производства по" }));
    await screen.findByText(/Показаны запланированные и активные смены/);
    // The host's own list is cached: shown again at once and read again in the background.
    await waitFor(() => expect(session.api.listShifts).toHaveBeenLastCalledWith(SESSION_TOKEN));
  });

  it("refuses a period that ends before it starts or is longer than 366 days, and asks nothing", async () => {
    const session = shiftsSession();
    await openShifts(session);
    pickDate("Дата производства с", "8 октября 2026");
    pickDate("Дата производства по", "1 октября 2026");
    expect(screen.getByText("Период заканчивается раньше, чем начинается")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Очистить дату: Дата производства с" }));
    pickDate("Дата производства с", "30 сентября 2025", 12);
    expect(screen.getByText("Период — не больше 366 дней")).toBeTruthy();
    expect(session.api.listShifts).toHaveBeenCalledTimes(1);
    // 366 days with both ends, 1 October 2025 to 1 October 2026: asked.
    fireEvent.click(screen.getByRole("button", { name: "Очистить дату: Дата производства с" }));
    pickDate("Дата производства с", "1 октября 2025", 12);
    await waitFor(() =>
      expect(session.api.listShifts).toHaveBeenLastCalledWith(SESSION_TOKEN, {
        from: "2025-10-01",
        to: "2026-10-01",
      }),
    );
    expect(screen.queryByText("Период — не больше 366 дней")).toBeNull();
  });

  it("shows names with markup as text", async () => {
    const session = shiftsSession([{ ...ACTIVE, closeReasonText: null }]);
    session.api.listProducts.mockResolvedValue([{ ...MILK, name: "<b>Молоко</b>" }, WATER]);
    await openShifts(session);
    expect(screen.getByText("<b>Молоко</b>")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
  });
});

// Added by the task 3 implementer: what the plan's tests above leave to one-line mutants.
describe("office shifts: the list, boundaries and states", () => {
  const unreachable = () => new HostError({ kind: "transport", code: "unreachable", message: "x" });
  const numbersOnScreen = () =>
    shiftRows().map((row) => within(row).getAllByRole("cell")[0]?.textContent);
  /** 30 planned shifts on line 10, then 30 active ones on line 2: three pages. */
  const sixty = (): OfficeShift[] => [
    ...numbered(30),
    ...Array.from({ length: 30 }, (_, n) => ({
      ...ACTIVE,
      id: `00000000-0000-4000-8000-${String(n + 100).padStart(12, "0")}`,
      number: `ACT-${String(n + 1).padStart(3, "0")}`,
    })),
  ];

  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the host's order, whatever the numbers and the dates say", async () => {
    await openShifts(shiftsSession([CLOSED, PLANNED, ACTIVE]));
    expect(numbersOnScreen()).toEqual(["OCT26-001/S", "OCT26-005", "OCT26-004"]);
  });

  it("shows no pager up to 25 shifts, and 25 a page after that: 24, 25, 26 and 51", async () => {
    for (const [count, rows, pages] of [
      [24, 24, null],
      [25, 25, null],
      [26, 25, 2],
      [51, 25, 3],
    ] as const) {
      await openShifts(shiftsSession(numbered(count)));
      expect(shiftRows()).toHaveLength(rows);
      const pager = screen.queryByRole("navigation", { name: "Страницы списка смен" });
      if (pages === null) expect(pager).toBeNull();
      else expect(within(pager ?? document.body).getByText(`Страница 1 из ${pages}`)).toBeTruthy();
      cleanup();
    }
  });

  it("walks the pages forward and back, and disables the button at either end", async () => {
    await openShifts(shiftsSession(numbered(51)));
    const pager = screen.getByRole("navigation", { name: "Страницы списка смен" });
    const back = within(pager).getByRole("button", { name: "Назад" });
    const forward = within(pager).getByRole("button", { name: "Вперёд" });
    expect(within(pager).getByText("Страница 1 из 3")).toBeTruthy();
    expect((back as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(forward);
    fireEvent.click(forward);
    expect(within(pager).getByText("Страница 3 из 3")).toBeTruthy();
    expect(numbersOnScreen()).toEqual(["OCT26-051"]);
    expect((forward as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(back);
    expect(within(pager).getByText("Страница 2 из 3")).toBeTruthy();
    expect(numbersOnScreen()).toHaveLength(25);
    expect(numbersOnScreen()[0]).toBe("OCT26-026");
  });

  it("goes back to the first page when the status, the line, the search or a date changes", async () => {
    await openShifts(shiftsSession(sixty()));
    const pager = () => screen.getByRole("navigation", { name: "Страницы списка смен" });
    const second = () => {
      fireEvent.click(within(pager()).getByRole("button", { name: "Вперёд" }));
      expect(within(pager()).getByText("Страница 2 из 3")).toBeTruthy();
    };
    second();
    chooseText("Статус", "Запланирована");
    expect(within(pager()).getByText("Страница 1 из 2")).toBeTruthy();
    chooseText("Статус", "Все статусы");
    expect(within(pager()).getByText("Страница 1 из 3")).toBeTruthy();
    second();
    chooseText("Линия", LINE_10.name);
    expect(within(pager()).getByText("Страница 1 из 2")).toBeTruthy();
    chooseText("Линия", "Все линии");
    second();
    fireEvent.change(screen.getByLabelText("Поиск по номеру и товару"), {
      target: { value: "OCT26" },
    });
    expect(within(pager()).getByText("Страница 1 из 2")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Поиск по номеру и товару"), { target: { value: "" } });
    second();
    // The first date of a period, then the second.
    pickDate("Дата производства с", "1 сентября 2026", 1);
    expect(within(pager()).getByText("Страница 1 из 3")).toBeTruthy();
    second();
    pickDate("Дата производства по", "8 октября 2026");
    expect(await screen.findByText("Страница 1 из 3")).toBeTruthy();
  });

  it("goes back to the first page of the whole list when «Сбросить» clears a filter", async () => {
    await openShifts(shiftsSession(sixty()));
    const pager = () => screen.getByRole("navigation", { name: "Страницы списка смен" });
    chooseText("Статус", "Запланирована");
    fireEvent.click(within(pager()).getByRole("button", { name: "Вперёд" }));
    expect(within(pager()).getByText("Страница 2 из 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(within(pager()).getByText("Страница 1 из 3")).toBeTruthy();
  });

  it("keeps a shift only when the status, the line and the search all keep it, and finds a number without case", async () => {
    await openShifts(shiftsSession());
    const search = screen.getByLabelText("Поиск по номеру и товару");
    chooseText("Статус", "Закрыта");
    fireEvent.change(search, { target: { value: "молоко" } });
    expect(numbersOnScreen()).toEqual(["OCT26-001/S"]);
    chooseText("Линия", LINE_10.name);
    expect(screen.getByText("Ничего не найдено. Измените отбор.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    fireEvent.change(search, { target: { value: "oct26-005" } });
    expect(numbersOnScreen()).toEqual(["OCT26-005"]);
    fireEvent.change(search, { target: { value: "вода" } });
    expect(numbersOnScreen()).toEqual(["OCT26-005"]);
  });

  it("offers «Сбросить» for each filter on its own, not for blank search, and puts everything back", async () => {
    const session = shiftsSession();
    await openShifts(session);
    const reset = () => screen.queryByRole("button", { name: "Сбросить" });
    const search = screen.getByLabelText("Поиск по номеру и товару");
    fireEvent.change(search, { target: { value: "   " } });
    expect(reset()).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    chooseText("Статус", "Активна");
    expect(reset()).not.toBeNull();
    chooseText("Статус", "Все статусы");
    expect(reset()).toBeNull();
    chooseText("Линия", LINE_2.name);
    expect(reset()).not.toBeNull();
    chooseText("Линия", "Все линии");
    fireEvent.change(search, { target: { value: "x" } });
    expect(reset()).not.toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    pickDate("Дата производства с", "1 сентября 2026", 1);
    expect(reset()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Очистить дату: Дата производства с" }));
    expect(reset()).toBeNull();
    pickDate("Дата производства по", "8 октября 2026");
    expect(reset()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Очистить дату: Дата производства по" }));
    expect(reset()).toBeNull();

    // Everything at once, then back to the host's own list.
    chooseText("Статус", "Закрыта");
    chooseText("Линия", LINE_2.name);
    fireEvent.change(search, { target: { value: "молоко" } });
    pickDate("Дата производства с", "1 сентября 2026", 1);
    pickDate("Дата производства по", "8 октября 2026");
    await screen.findByText("Показаны смены с датой производства с 01.09.2026 по 08.10.2026.");
    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(shownIn("Статус")).toBe("Все статусы");
    expect(shownIn("Линия")).toBe("Все линии");
    expect((search as HTMLInputElement).value).toBe("");
    for (const label of ["Дата производства с", "Дата производства по"]) {
      expect(screen.getByRole("button", { name: label }).textContent).toContain("Не выбрана");
    }
    await screen.findByText(/Показаны запланированные и активные смены/);
    expect(reset()).toBeNull();
  });

  it("keeps the list of the period last asked for while the dates are half or wrong, and asks nothing", async () => {
    const session = shiftsSession();
    await openShifts(session);
    pickDate("Дата производства с", "1 сентября 2026", 1);
    pickDate("Дата производства по", "8 октября 2026");
    await screen.findByText("Показаны смены с датой производства с 01.09.2026 по 08.10.2026.");
    await screen.findByText("OCT26-004");
    expect(session.api.listShifts).toHaveBeenCalledTimes(2);
    // Half a period.
    fireEvent.click(screen.getByRole("button", { name: "Очистить дату: Дата производства по" }));
    expect(screen.getByText("Укажите обе даты периода. Пока показан прежний список.")).toBeTruthy();
    expect(numbersOnScreen()).toHaveLength(3);
    // A wrong one.
    pickDate("Дата производства по", "31 августа 2026", 2);
    expect(screen.getByText("Период заканчивается раньше, чем начинается")).toBeTruthy();
    expect(
      screen.getByText("Показаны смены с датой производства с 01.09.2026 по 08.10.2026."),
    ).toBeTruthy();
    expect(numbersOnScreen()).toHaveLength(3);
    expect(session.api.listShifts).toHaveBeenCalledTimes(2);
  });

  it("takes only a second date for half a period", async () => {
    const session = shiftsSession();
    await openShifts(session);
    pickDate("Дата производства по", "8 октября 2026");
    expect(screen.getByText("Укажите обе даты периода. Пока показан прежний список.")).toBeTruthy();
    expect(session.api.listShifts).toHaveBeenCalledTimes(1);
  });

  it("shows nothing but «Загрузка…» while the shifts load", async () => {
    const session = shiftsSession();
    session.api.listShifts.mockReturnValue(new Promise(() => undefined));
    renderOffice(session);
    fireEvent.click(await screen.findByRole("link", { name: "Смены" }));
    await screen.findByRole("heading", { name: "Смены" });
    expect(await screen.findByText("Загрузка…")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/Показано \d+ из/)).toBeNull();
    expect(screen.queryByText(/Не все справочники загрузились/)).toBeNull();
  });

  it("shows only the error when the shifts and a list of names fail, and one «Повторить» reads both again", async () => {
    const session = shiftsSession();
    session.api.listShifts.mockRejectedValueOnce(unreachable());
    session.api.listLines.mockRejectedValueOnce(unreachable());
    renderOffice(session);
    fireEvent.click(await screen.findByRole("link", { name: "Смены" }));
    const retry = await screen.findByRole("button", { name: "Повторить" });
    expect(screen.queryByText(/Не все справочники загрузились/)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    session.api.listProducts.mockClear();
    fireEvent.click(retry);
    expect(await screen.findByText("OCT26-004")).toBeTruthy();
    expect(session.api.listShifts).toHaveBeenCalledTimes(2);
    expect(session.api.listLines).toHaveBeenCalledTimes(2);
    expect(session.api.listProducts).not.toHaveBeenCalled();
    expect(cells("OCT26-005")[2]).toBe("Линия 10");
  });

  it("names records by their ids and claims no mark when the products and the counterparties do not load", async () => {
    const session = shiftsSession([
      ACTIVE,
      {
        ...PLANNED,
        id: "10000000-0000-4000-8000-000000000007",
        number: "A-7",
        productId: AYRAN_ARCHIVED.id,
      },
    ]);
    session.api.listProducts.mockRejectedValue(unreachable());
    session.api.listCounterparties.mockRejectedValue(unreachable());
    await openShifts(session);
    await screen.findByText(/Не все справочники загрузились/);
    expect(cells("OCT26-004").slice(2, 4)).toEqual([
      "Линия 2",
      "Товар f1e2d3c4…для: Контрагент d2b7c9e1…",
    ]);
    expect(cells("A-7")[3]).toBe("Товар 4d5e6f70…");
    expect(cells("A-7")[6]).toBe("◷Запланирована");
  });

  it("searches the product's own name only, never the placeholder or the mark that stand in for it", async () => {
    // The products do not load: every shift is named «Товар xxxxxxxx…», which nobody searches for.
    const lost = shiftsSession();
    lost.api.listProducts.mockRejectedValue(unreachable());
    await openShifts(lost);
    await screen.findByText(/Не все справочники загрузились/);
    const search = screen.getByLabelText("Поиск по номеру и товару");
    fireEvent.change(search, { target: { value: "товар" } });
    expect(screen.getByText("Ничего не найдено. Измените отбор.")).toBeTruthy();
    // The number still finds a shift.
    fireEvent.change(search, { target: { value: "oct26-004" } });
    expect(shiftRows()).toHaveLength(1);
    cleanup();
    // An archived product is marked «(в архиве)» in the list; the mark is not its name.
    const marked = shiftsSession([
      { ...PLANNED, id: "10000000-0000-4000-8000-000000000007", productId: AYRAN_ARCHIVED.id },
    ]);
    await openShifts(marked);
    expect(cells("OCT26-005")[3]).toBe("Айран (в архиве)");
    const again = screen.getByLabelText("Поиск по номеру и товару");
    fireEvent.change(again, { target: { value: "в архиве" } });
    expect(screen.getByText("Ничего не найдено. Измените отбор.")).toBeTruthy();
    fireEvent.change(again, { target: { value: "айран" } });
    expect(shiftRows()).toHaveLength(1);
  });

  it("says only what can be wrong when just one list of names did not load", async () => {
    const session = shiftsSession();
    session.api.listTemplates.mockRejectedValue(unreachable());
    await openShifts(session);
    // Names that came in stay names; what is missing is shown by the start of its code.
    expect(
      await screen.findByText(
        "Не все справочники загрузились: названия, которых нет, показаны началами кодов, а смены, которые не откроются, могут быть не помечены.",
      ),
    ).toBeTruthy();
    expect(cells("OCT26-005")[3]).toBe("Вода 0,5 л");
  });

  it("names a line the loaded list lacks by its id, and an archived line in the filter as archived", async () => {
    const session = shiftsSession([ACTIVE]);
    session.api.listLines.mockResolvedValue([LINE_10, OLD_LINE]);
    await openShifts(session);
    expect(cells("OCT26-004")[2]).toBe("Линия 5f0c6a52…");
    expect(optionTexts("Линия")).toEqual(["Все линии", "Линия 10", "Линия 1 (в архиве)"]);
  });

  it("says in words every reason a station closes a shift for", async () => {
    const shifts = SHIFT_CLOSE_REASON_CODES.map((code, n) => ({
      ...CLOSED,
      id: `00000000-0000-4000-8000-${String(n + 200).padStart(12, "0")}`,
      number: `R-${n + 1}`,
      closeReasonCode: code,
    }));
    await openShifts(shiftsSession(shifts));
    const said = shifts.map((shift) => cells(shift.number)[6]);
    for (const [n, code] of SHIFT_CLOSE_REASON_CODES.entries()) {
      expect(said[n]).not.toContain(code);
      expect(said[n]).toContain("Причина расхождения: ");
    }
    expect(said[0]).toContain("Производственный брак");
    expect(said[1]).toContain("Недостаток сырья");
    expect(said[3]).toContain("Изменение производственного задания");
    expect(said[4]).toContain("Ошибка в плановом количестве");
    expect(said[5]).toContain("Другое производственное отклонение");
  });

  it("shows a mode in its own tone", async () => {
    const validation: OfficeShift = {
      ...ACTIVE,
      id: "10000000-0000-4000-8000-000000000008",
      number: "V-1",
      mode: "validation",
      counterpartyId: NORTH.id,
    };
    await openShifts(shiftsSession([validation, ACTIVE]));
    expect(within(shiftRow("V-1")).getByText("Проверка").className).toContain("mk-badge--violet");
    expect(within(shiftRow("OCT26-004")).getByText("Агрегация").className).toContain(
      "mk-badge--teal",
    );
  });

  it("asks again when only the second date of a period changes, and when only the first does", async () => {
    const session = shiftsSession();
    await openShifts(session);
    pickDate("Дата производства с", "1 сентября 2026", 1);
    pickDate("Дата производства по", "8 октября 2026");
    await waitFor(() =>
      expect(session.api.listShifts).toHaveBeenLastCalledWith(SESSION_TOKEN, {
        from: "2026-09-01",
        to: "2026-10-08",
      }),
    );
    await screen.findByText("OCT26-004");
    fireEvent.click(screen.getByRole("button", { name: "Очистить дату: Дата производства по" }));
    pickDate("Дата производства по", "9 октября 2026");
    await waitFor(() =>
      expect(session.api.listShifts).toHaveBeenLastCalledWith(SESSION_TOKEN, {
        from: "2026-09-01",
        to: "2026-10-09",
      }),
    );
    await screen.findByText("Показаны смены с датой производства с 01.09.2026 по 09.10.2026.");
    await screen.findByText("OCT26-004");
    fireEvent.click(screen.getByRole("button", { name: "Очистить дату: Дата производства с" }));
    pickDate("Дата производства с", "2 сентября 2026", 1);
    await waitFor(() =>
      expect(session.api.listShifts).toHaveBeenLastCalledWith(SESSION_TOKEN, {
        from: "2026-09-02",
        to: "2026-10-09",
      }),
    );
    expect(session.api.listShifts).toHaveBeenCalledTimes(4);
  });

  it("lists the lines in the filter active first, each group by name", async () => {
    const session = shiftsSession();
    session.api.listLines.mockResolvedValue([OLD_LINE, LINE_10, LINE_2]);
    await openShifts(session);
    expect(optionTexts("Линия")).toEqual([
      "Все линии",
      "Линия 2",
      "Линия 10",
      "Линия 1 (в архиве)",
    ]);
  });

  it("opens for a technologist too, with the same list", async () => {
    const session = { ...shiftsSession(), user: TECHNOLOGIST };
    await openShifts(session);
    expect(numbersOnScreen()).toEqual(["OCT26-005", "OCT26-004", "OCT26-001/S"]);
  });
});
