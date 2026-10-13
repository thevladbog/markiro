import { readFileSync } from "node:fs";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import { officeConflictPageSchema, type OfficeConflictPage } from "../src/host/review.js";
import { renderOffice, TECHNOLOGIST, type FakeOfficeSession } from "./support/office.js";
import { chooseText, optionTexts, selectTrigger, shownIn, waitForList } from "./support/select.js";
import { ACTIVE, expectFocusedNotice, shiftsSession } from "./support/shifts.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const PAGE: OfficeConflictPage = officeConflictPageSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/office-conflict-page.json", testModuleUrl), "utf8"),
  ),
);
const TOKEN = "office-session-token";
const LATE = "c0000000-0000-4000-8000-000000000002";
const EMPTY: OfficeConflictPage = { items: [], page: 1, pageCount: 1, total: 0 };

function session(page: OfficeConflictPage = PAGE, user = shiftsSession().user): FakeOfficeSession {
  const value = shiftsSession(undefined, user);
  value.api.listConflicts.mockResolvedValue(page);
  return value;
}

/** Opens «Конфликты» from the menu and waits for the list. */
async function openConflicts(value: FakeOfficeSession): Promise<void> {
  renderOffice(value);
  fireEvent.click(await screen.findByRole("link", { name: "Конфликты" }));
  await screen.findByRole("heading", { name: "Конфликты", level: 1 });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

/** The rows of the list, cells by column title. */
function rows(): Record<string, HTMLElement>[] {
  const table = screen.getByRole("table");
  const titles = within(table)
    .getAllByRole("columnheader")
    .map((header) => header.textContent ?? "");
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      Object.fromEntries(
        within(row)
          .getAllByRole("cell")
          .map((cell, index) => [titles[index] ?? String(index), cell]),
      ),
    );
}

function cell(row: number, title: string): HTMLElement {
  const found = rows()[row]?.[title];
  if (found === undefined) throw new Error(`no cell ${title} in row ${String(row)}`);
  return found;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function lastQuery(value: FakeOfficeSession): unknown {
  return value.api.listConflicts.mock.calls.at(-1)?.[1];
}

describe("«Конфликты» in the office (plan КНФ)", () => {
  it("is in the production menu after «Смены» and asks the unreviewed ones first", async () => {
    const value = session();
    await openConflicts(value);
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links[links.indexOf("Смены") + 1]).toBe("Конфликты");
    expect(value.api.listConflicts).toHaveBeenCalledWith(TOKEN, { reviewed: false, page: 1 });
    expect(screen.getByText(/Код остаётся за самым ранним сканом/)).toBeTruthy();
    expect(screen.getByText("Найдено: 2")).toBeTruthy();
    // One page: no pages to turn.
    expect(screen.queryByRole("navigation", { name: "Страницы конфликтов" })).toBeNull();
  });

  it("names the code by GTIN and serial and both scans with shift, station, operator, instant and box", async () => {
    await openConflicts(session());
    expect(cell(0, "Код").textContent).toBe("GTIN 04600682000013 · серийный S000007");
    expect(cell(0, "Что произошло").textContent).toMatch(/^Вытеснение: /);
    const loser = cell(0, "Проигравший скан");
    for (const text of [
      "Смена OCT26-004",
      "Станция А",
      "Оператор: Анна Кузнецова",
      "08.10.2026, 09:01:40",
      "Короб (00)046006820000015001",
    ]) {
      expect(within(loser).getByText(text)).toBeTruthy();
    }
    const winner = cell(0, "Победивший скан");
    expect(within(winner).getByText("Короб ещё открыт")).toBeTruthy();
    expect(within(winner).getByText("Оператор не указан")).toBeTruthy();
    expect(within(winner).getByText("08.10.2026, 09:00:50")).toBeTruthy();
    expect(cell(1, "Что произошло").textContent).toMatch(/^Поздний скан: /);
    expect(within(cell(1, "Проигравший скан")).getByText("Без короба")).toBeTruthy();
    expect(cell(0, "Обнаружен").textContent).toBe("08.10.2026, 10:12:03");
    // The code's hash is a key, never shown.
    for (const conflict of PAGE.items) {
      expect(document.body.textContent).not.toContain(conflict.codeHash);
    }
  });

  it("links the loser's box in its shift's card by its SSCC, and only the shift without one", async () => {
    await openConflicts(session());
    const named = screen.getByRole("link", {
      name: "Короб проигравшего в карточке смены OCT26-004",
    });
    expect(named.getAttribute("href")).toBe(
      "/shifts/5a0c9e1e-3d4f-4b8a-9c2d-1e0f9a8b7c6d?box=046006820000015001",
    );
    const bare = within(cell(1, "Проигравший скан")).getByRole("link", {
      name: "Короб проигравшего в карточке смены OCT26-005/S",
    });
    expect(bare.getAttribute("href")).toBe("/shifts/6b1d0f2f-4e5a-4c9b-8d3e-2f1a0b9c8d7e");
  });

  it("says who reviewed a conflict and when, and offers the review only for an unreviewed one", async () => {
    await openConflicts(session());
    const done = cell(0, "Состояние");
    expect(within(done).getByText("Разобран")).toBeTruthy();
    expect(within(done).getByText("Ирина Смирнова, 08.10.2026, 12:00:00")).toBeTruthy();
    expect(within(done).queryByRole("button")).toBeNull();
    const open = cell(1, "Состояние");
    expect(within(open).getByText("Не разобран")).toBeTruthy();
    const button = within(open).getByRole("button", {
      name: "Отметить разобранным конфликт кода S000008",
    });
    expect(button.tagName).toBe("BUTTON");
  });

  it("marks a conflict reviewed once, focuses the notice and reads the list again", async () => {
    const value = session();
    const reviewed = PAGE.items[1];
    if (reviewed === undefined) throw new Error("fixture");
    const answer = deferred<typeof reviewed>();
    value.api.reviewConflict.mockReturnValue(answer.promise);
    await openConflicts(value);
    expect(value.api.listConflicts).toHaveBeenCalledTimes(1);
    const button = screen.getByRole("button", {
      name: "Отметить разобранным конфликт кода S000008",
    });
    fireEvent.click(button);
    // A second press while the host answers sends nothing more.
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    fireEvent.click(button);
    answer.resolve({
      ...reviewed,
      reviewedAt: "2026-10-08T10:00:00Z",
      reviewedByName: "Ирина Смирнова",
    });
    await expectFocusedNotice("Конфликт кода S000008 отмечен разобранным.");
    expect(value.api.reviewConflict).toHaveBeenCalledTimes(1);
    expect(value.api.reviewConflict).toHaveBeenCalledWith(TOKEN, LATE);
    await waitFor(() => expect(value.api.listConflicts).toHaveBeenCalledTimes(2));
  });

  it("explains a refused review above the list without reading it again, and lets it be tried again", async () => {
    const value = session();
    const answer = deferred<never>();
    value.api.reviewConflict.mockReturnValue(answer.promise);
    await openConflicts(value);
    const button = screen.getByRole("button", {
      name: "Отметить разобранным конфликт кода S000008",
    });
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    answer.reject(
      new HostError({ kind: "api", code: "not_found", status: 404, message: "no such conflict" }),
    );
    expect(await screen.findByText("Запись не найдена.")).toBeTruthy();
    expect(value.api.listConflicts).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText(/отмечен разобранным/)).toBeNull();
    // The alert stands above the table.
    const alert = screen.getByText("Запись не найдена.");
    expect(
      alert.compareDocumentPosition(screen.getByRole("table")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("narrows by state and by the losing shift in the address, and resets", async () => {
    const value = session();
    await openConflicts(value);
    expect(
      screen.getByText(
        "Смена, чей скан проиграл. Конфликты, где эта смена выиграла код, сюда не попадают.",
      ),
    ).toBeTruthy();
    chooseText("Состояние", "Все");
    await waitFor(() => expect(lastQuery(value)).toEqual({ page: 1 }));
    chooseText("Состояние", "Не разобранные");
    await waitFor(() => expect(lastQuery(value)).toEqual({ reviewed: false, page: 1 }));
    await waitForList(() => expect(optionTexts("Смена")).toContain(ACTIVE.number));
    chooseText("Смена", ACTIVE.number);
    await waitFor(() =>
      expect(lastQuery(value)).toEqual({ shiftId: ACTIVE.id, reviewed: false, page: 1 }),
    );
    // A filter on page 2 goes back to the first page.
    chooseText("Состояние", "Разобранные");
    await waitFor(() =>
      expect(lastQuery(value)).toEqual({ shiftId: ACTIVE.id, reviewed: true, page: 1 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    await waitFor(() => expect(lastQuery(value)).toEqual({ reviewed: false, page: 1 }));
    expect(screen.queryByRole("button", { name: "Сбросить" })).toBeNull();
    expect(shownIn("Смена")).toBe("Все смены");
    expect(shownIn("Состояние")).toBe("Не разобранные");
  });

  it("names a shift a link brought that the list does not hold", async () => {
    const value = session();
    renderOffice(value, { initialPath: "/conflicts?shift=9e8d7c6b-5a49-4f3e-8d2c-1b0a9f8e7d6c" });
    await screen.findByRole("heading", { name: "Конфликты", level: 1 });
    await waitFor(() => expect(shownIn("Смена")).toBe("Смена из ссылки"));
    expect(lastQuery(value)).toEqual({
      shiftId: "9e8d7c6b-5a49-4f3e-8d2c-1b0a9f8e7d6c",
      reviewed: false,
      page: 1,
    });
  });

  it("names the shift of a link even when the list of shifts does not load", async () => {
    const value = session();
    value.api.listShifts.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    renderOffice(value, { initialPath: `/conflicts?shift=${ACTIVE.id}` });
    await screen.findByRole("heading", { name: "Конфликты", level: 1 });
    await waitFor(() => expect(shownIn("Смена")).toBe("Смена из ссылки"));
  });

  it("pages through the conflicts", async () => {
    const value = session({ ...PAGE, pageCount: 3, total: 120 });
    await openConflicts(value);
    const pager = screen.getByRole("navigation", { name: "Страницы конфликтов" });
    expect(within(pager).getByRole("button", { name: "Назад" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.click(within(pager).getByRole("button", { name: "Вперёд" }));
    await waitFor(() => expect(lastQuery(value)).toEqual({ reviewed: false, page: 2 }));
  });

  it("says there are none, and none with the filter", async () => {
    const value = session(EMPTY);
    await openConflicts(value);
    expect(screen.getByText("Конфликтов нет")).toBeTruthy();
    chooseText("Состояние", "Разобранные");
    expect(await screen.findByText("Нет конфликтов с таким отбором")).toBeTruthy();
  });

  it("offers to read again when the list did not load", async () => {
    const value = session();
    value.api.listConflicts.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    renderOffice(value);
    fireEvent.click(await screen.findByRole("link", { name: "Конфликты" }));
    fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(value.api.listConflicts).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("lets a technologist review, and reaches the review from the filters with the keyboard", async () => {
    const value = session(PAGE, TECHNOLOGIST);
    await openConflicts(value);
    const button = screen.getByRole("button", {
      name: "Отметить разобранным конфликт кода S000008",
    });
    // Everything between the filters and the button can take the focus in order.
    const state = selectTrigger("Состояние");
    expect(state.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.getAttribute("tabindex")).not.toBe("-1");
    expect(button.hasAttribute("disabled")).toBe(false);
    // (jsdom has no Tab order and the package has no user-event: the order is checked in the DOM.)
    const reviewed = PAGE.items[1];
    if (reviewed === undefined) throw new Error("fixture");
    value.api.reviewConflict.mockResolvedValue({
      ...reviewed,
      reviewedAt: "2026-10-08T10:00:00Z",
      reviewedByName: TECHNOLOGIST.name,
    });
    button.focus();
    fireEvent.click(button);
    await expectFocusedNotice("Конфликт кода S000008 отмечен разобранным.");
    expect(value.api.reviewConflict).toHaveBeenCalledWith(TOKEN, LATE);
  });
});
