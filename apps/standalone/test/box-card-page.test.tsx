import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import { renderOffice, TECHNOLOGIST } from "./support/office.js";
import {
  BOX_CARD,
  BOX_ROWS,
  CARD_SHIFT,
  CODE_CARD,
  packSession,
  SHIFT_BOXES,
} from "./support/pack-cards.js";
import { openShifts } from "./support/shifts.js";

const PATH = `/codes/box/${BOX_CARD.id}`;
const TITLE = "Короб (00)046006820000015000";

afterEach(() => {
  vi.useRealTimers();
});

function section(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { name });
  const found = heading.closest("section");
  if (found === null) throw new Error(`no section ${name}`);
  return found;
}

async function boxCard(value = packSession()) {
  renderOffice(value, { initialPath: PATH });
  await screen.findByRole("heading", { name: TITLE });
  return value;
}

describe("the card of a box (plan КРТ)", () => {
  it("says where the box stands: its state, operator, shift, station and pallet", async () => {
    await boxCard();
    const facts = Object.fromEntries(
      screen
        .getAllByRole("term")
        .map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]),
    );
    expect(facts["Оператор"]).toBe("Анна Кузнецова");
    expect(facts["Смена"]).toBe("OCT26-003");
    expect(facts["Станция"]).toBe("Станция на линии 1");
    expect(facts["Линия"]).toBe("Линия 1");
    expect(facts["Дата производства"]).toBe("08.10.2026");
    expect(facts["Кодов в коробе"]).toBe("1");
    expect(facts["Станция насчитала при закрытии"]).toBe("2");
    // The state chip and the term of the closing time are both «Закрыт».
    expect(screen.getAllByText("Закрыт")).toHaveLength(2);
    const pallet = screen.getByRole("link", { name: "(00)146006820000000409" });
    expect(pallet.getAttribute("href")).toBe(`/codes/pallet/${BOX_CARD.pallet?.id ?? ""}`);
    expect(screen.getByRole("link", { name: "OCT26-003" }).getAttribute("href")).toBe(
      `/shifts/${BOX_CARD.shift.id}`,
    );
  });

  it("lists every code the box ever had, newest first, each in the state it stands in", async () => {
    await boxCard();
    const rows = within(section("Состав")).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("010460068200001321S000003"),
      expect.stringContaining("010460068200001321S000002"),
      expect.stringContaining("010460068200001321S000001"),
    ]);
    expect(rows[0]?.textContent).toContain("Изъят из короба");
    expect(rows[1]?.textContent).toContain("Забран другим сканом");
    expect(rows[2]?.textContent).toContain("В коробе");
    // The host's instant of the second is in the organization's zone: Moscow is UTC+3.
    expect(rows[1]?.textContent).toContain("25.10.2026, 12:00:00");
    expect(rows[1]?.textContent).toContain("Анна Кузнецова");
  });

  it("shows no full code: no group separator, no crypto tail", async () => {
    await boxCard();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("<GS>");
    expect(text).not.toContain("Tail");
    expect(text).not.toContain("\u001d");
  });

  it("tells the station's exceptions in words, with the code an undo took", async () => {
    await boxCard();
    const items = within(section("Исключения")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain(
      "Отмена последнего скана (код 010460068200001321S000003)",
    );
    expect(items[0]?.textContent).toContain("получено хостом");
    expect(items[1]?.textContent).toContain(
      "Перепечатка этикетки (причина — Смазалась при укладке)",
    );
    expect(items[1]?.textContent).toContain("Анна Кузнецова");
  });

  it("has no section of documents until a document took the box apart", async () => {
    await boxCard();
    expect(screen.queryByRole("heading", { name: "Документы дезагрегации" })).toBeNull();
  });

  it("lists the applied documents that took the box apart, linked to their pages, and says which items they took out", async () => {
    const value = packSession();
    value.api.getBoxCard.mockResolvedValue({
      ...BOX_CARD,
      disassembledAt: "2026-10-26T09:00:00.000Z",
      items: BOX_CARD.items.map((item) =>
        item.state === "packed"
          ? { ...item, state: "removed", leftAt: "2026-10-26T09:00:00.000Z" }
          : item,
      ),
      documents: [
        {
          id: "d0c00000-0000-4000-8000-000000000001",
          docNo: "DSG-26-0001",
          appliedAt: "2026-10-26T09:00:00Z",
          reasonName: "Неверное количество",
          appliedByName: "Ирина Смирнова",
        },
      ],
    });
    await boxCard(value);
    const item = within(section("Документы дезагрегации")).getByRole("listitem");
    const link = within(item).getByRole("link", { name: "Открыть документ DSG-26-0001" });
    expect(link.getAttribute("href")).toBe("/disaggregation/d0c00000-0000-4000-8000-000000000001");
    expect(item.textContent).toContain("проведён 26.10.2026, 12:00:00");
    expect(item.textContent).toContain("Неверное количество");
    expect(item.textContent).toContain("Ирина Смирнова");
    // The item the document took out says so; the ones the station took out do not.
    const rows = within(section("Состав")).getAllByRole("row").slice(1);
    expect(rows[2]?.textContent).toContain("по документу DSG-26-0001");
    expect(rows[0]?.textContent).not.toContain("по документу");
  });

  it("says in words that a box was taken apart, and when", async () => {
    const value = packSession();
    value.api.getBoxCard.mockResolvedValue({
      ...BOX_CARD,
      disassembledAt: "2026-10-08T07:00:00.000Z",
    });
    await boxCard(value);
    expect(screen.getByText("Расформирован")).toBeTruthy();
    expect(screen.getByText("Расформирован 08.10.2026, 10:00:00")).toBeTruthy();
  });

  it("warns, in words, of a close whose members did not match", async () => {
    const value = packSession();
    value.api.getBoxCard.mockResolvedValue({ ...BOX_CARD, digestMatches: false });
    await boxCard(value);
    expect(screen.getByText("Состав при закрытии не сошёлся")).toBeTruthy();
  });

  it("prints «Состав короба» of this box, as the shift's card does", async () => {
    const value = packSession();
    value.api.getBoxReportRows.mockResolvedValue(BOX_ROWS);
    await boxCard(value);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Состав короба" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Состав короба" }));
    await screen.findByRole("dialog", { name: `Состав короба (00)046006820000015000` });
    await waitFor(() =>
      expect(value.api.getBoxReportRows).toHaveBeenCalledWith("office-session-token", BOX_CARD.id),
    );
    expect(value.api.getShift).toHaveBeenCalledWith("office-session-token", CARD_SHIFT.id);
  });

  it("opens a code's own card from its link in the composition", async () => {
    const value = packSession();
    value.api.getCodeCard.mockResolvedValue(CODE_CARD);
    await boxCard(value);
    const hash = BOX_CARD.items[2]?.codeHash ?? "";
    fireEvent.click(
      screen.getByRole("link", { name: "Открыть карточку кода 010460068200001321S000001" }),
    );
    await screen.findByRole("heading", { name: "Поиск кодов", level: 1 });
    await waitFor(() =>
      expect(value.api.getCodeCard).toHaveBeenCalledWith("office-session-token", hash),
    );
  });

  it("goes back to the page it was opened from, the shift's card", async () => {
    const value = packSession();
    value.api.getShift.mockResolvedValue(CARD_SHIFT);
    value.api.listShiftBoxes.mockResolvedValue(SHIFT_BOXES.slice(0, 1));
    await openShifts(value);
    fireEvent.click(screen.getByRole("link", { name: `Карточка смены ${CARD_SHIFT.number}` }));
    await screen.findByRole("heading", { name: `Смена ${CARD_SHIFT.number}` });
    fireEvent.click(await screen.findByRole("link", { name: "(00)046006820000015000" }));
    await screen.findByRole("heading", { name: TITLE });
    fireEvent.click(screen.getByRole("link", { name: "← Назад" }));
    await screen.findByRole("heading", { name: `Смена ${CARD_SHIFT.number}` });
  });

  it("goes to the last part of «Поиск кодов» when it was opened with no page before", async () => {
    await boxCard();
    fireEvent.click(screen.getByRole("link", { name: "← Назад" }));
    await screen.findByRole("tab", { name: "Коды", selected: true });
  });

  it("says a box the host never saw is not found", async () => {
    const value = packSession();
    value.api.getBoxCard.mockRejectedValue(
      new HostError({ kind: "api", code: "not_found", message: "no such box", status: 404 }),
    );
    renderOffice(value, { initialPath: PATH });
    await screen.findByText("Короб не найден");
    expect(screen.getByText(/Хост знает только то, что собрали станции/)).toBeTruthy();
  });

  it("says an address that is no id names no box, without a retry", async () => {
    const value = packSession();
    value.api.getBoxCard.mockRejectedValue(new RangeError("not a box id"));
    renderOffice(value, { initialPath: "/codes/box/not-an-id" });
    await screen.findByText("Короб не найден");
    expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
  });

  it("is open to a technologist", async () => {
    await boxCard(packSession(undefined, TECHNOLOGIST));
  });
});
