import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficePalletPage } from "../src/host/pack-cards.js";
import { TECHNOLOGIST } from "./support/office.js";
import { openCodes, packSession, PALLET_PAGE } from "./support/pack-cards.js";
import { chooseText } from "./support/select.js";
import { MILK } from "./support/shifts.js";

const SECOND: OfficePalletPage = {
  items: [
    {
      ...(PALLET_PAGE.items[2] ?? (undefined as never)),
      id: "a0000000-0000-4000-8000-000000000009",
      sscc: "146006820000009002",
    },
  ],
  nextCursor: null,
  stations: PALLET_PAGE.stations,
};

function rows(): HTMLElement[] {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1);
}

/** The first and only page of the pallets: the host has no more to give. */
const ONLY_PAGE: OfficePalletPage = { ...PALLET_PAGE, nextCursor: null };

function session() {
  const value = packSession();
  value.api.listPallets.mockResolvedValue(ONLY_PAGE);
  return value;
}

async function palletsOf(value = session(), path = "/codes/pallets") {
  await openCodes(value, path);
  await screen.findByRole("table");
  return value;
}

describe("«Паллеты» (plan КРТ)", () => {
  it("reads the first page with no filters and no cursor, open pallets first", async () => {
    const value = await palletsOf();
    expect(value.api.listPallets).toHaveBeenCalledWith("office-session-token", {}, null);
    expect(rows()).toHaveLength(3);
    expect(rows()[0]?.textContent).toContain("Открытая");
    expect(rows()[0]?.textContent).toContain("Открыта");
    expect(screen.getByText("Показано: 3")).toBeTruthy();
  });

  it("says in words that the count at the close differs from the boxes standing now", async () => {
    await palletsOf();
    expect(rows()[1]?.textContent).toContain("Закрыта");
    expect(rows()[1]?.textContent).toContain("Состав изменился после закрытия");
    expect(rows()[2]?.textContent).not.toContain("Состав изменился после закрытия");
  });

  it("shows the difference neutrally, saying why, when a box taken apart accounts for it, and as a real one when none does", async () => {
    const value = packSession();
    const [first, second, third] = PALLET_PAGE.items;
    value.api.listPallets.mockResolvedValue({
      ...PALLET_PAGE,
      items: [
        first ?? (undefined as never),
        // Two boxes at the close, one stands, one was taken apart: the owner's repacking.
        { ...(second ?? (undefined as never)), disassembledBoxes: 1 },
        third ?? (undefined as never),
      ],
    });
    await palletsOf(value);
    expect(rows()[1]?.textContent).toContain("Состав изменён расформированием");
    expect(rows()[1]?.textContent).not.toContain("Состав изменился после закрытия");
    const tag = within(rows()[1] as HTMLElement)
      .getByText("Состав изменён расформированием")
      .closest("[title]");
    expect(tag?.getAttribute("title")).toContain("Это не ошибка.");
  });

  it("says a count that differs with no disassembly is a real discrepancy", async () => {
    await palletsOf();
    const tag = within(rows()[1] as HTMLElement)
      .getByText("Состав изменился после закрытия")
      .closest("[title]");
    expect(tag?.getAttribute("title")).toBe(
      "Станция насчитала при закрытии коробов: 2, в базе хоста сейчас: 1. Расформирований коробов этой паллеты нет, поэтому расхождение настоящее: проверьте состав паллеты.",
    );
  });

  it("narrows the list by a product and starts again from the first page", async () => {
    const value = await palletsOf();
    chooseText("Товар", "Молоко 3,2% 0,9 л");
    await waitFor(() =>
      expect(value.api.listPallets).toHaveBeenLastCalledWith(
        "office-session-token",
        { product: MILK.id },
        null,
      ),
    );
  });

  it("reads the next hundred below the cursor on its own while the page shown is not yet full, and adds the rows", async () => {
    const value = packSession();
    value.api.listPallets.mockResolvedValueOnce(PALLET_PAGE).mockResolvedValueOnce(SECOND);
    await palletsOf(value);
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(value.api.listPallets).toHaveBeenLastCalledWith(
      "office-session-token",
      {},
      PALLET_PAGE.nextCursor,
    );
    // No «Показать ещё»: the pages of the table are the way on.
    expect(screen.queryByRole("button", { name: "Показать ещё" })).toBeNull();
    expect(screen.getByText("Показано: 4")).toBeTruthy();
  });

  it("pages the pallets ten at a time over the rows read, reading on while the host has more", async () => {
    const [first] = PALLET_PAGE.items;
    if (first === undefined) throw new Error("the fixture has no pallets");
    const make = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...first,
        id: `a0000000-0000-4000-8000-${String(from + index).padStart(12, "0")}`,
        sscc: `1460068200000${String(from + index).padStart(5, "0")}`,
      }));
    const value = packSession();
    value.api.listPallets
      .mockResolvedValueOnce({ ...PALLET_PAGE, items: make(1, 12), nextCursor: "c1" })
      .mockResolvedValueOnce({ ...PALLET_PAGE, items: make(13, 12), nextCursor: null });
    await palletsOf(value);
    await waitFor(() => expect(rows()).toHaveLength(10));
    const pager = () => screen.getByRole("navigation", { name: "Страницы списка паллет" });
    // 12 rows are read and the host has more: the table does not yet know how many there are.
    expect(screen.getByText("Показано 1–10, есть ещё")).toBeTruthy();
    fireEvent.click(within(pager()).getByRole("button", { name: "Вперёд" }));
    expect(await screen.findByText("Показано 11–20 из 24")).toBeTruthy();
    fireEvent.click(within(pager()).getByRole("button", { name: "Вперёд" }));
    expect(rows()).toHaveLength(4);
    expect(within(pager()).getByRole("button", { name: "Вперёд" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("keeps the stations to choose from while a narrower list is read, and shows no stale rows", async () => {
    const value = packSession();
    value.api.listPallets
      .mockResolvedValueOnce(ONLY_PAGE)
      .mockReturnValueOnce(new Promise(() => undefined));
    await palletsOf(value);
    chooseText("Товар", "Молоко 3,2% 0,9 л");
    await waitFor(() => expect(value.api.listPallets).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Станция" }), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse",
    });
    expect(
      within(screen.getByRole("listbox")).getByText("Станция на линии 2 (отозвана)"),
    ).toBeTruthy();
  });

  it("keeps the rows it has when the next hundred cannot be read, and offers it again", async () => {
    const value = packSession();
    value.api.listPallets
      .mockResolvedValueOnce(PALLET_PAGE)
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "host down" }),
      )
      .mockResolvedValueOnce(SECOND);
    await palletsOf(value);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Нет связи с хостом");
    expect(rows()).toHaveLength(3);
    fireEvent.click(within(alert).getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(rows()).toHaveLength(4));
  });

  it("says nothing of a count while the period asked is backwards", async () => {
    const value = packSession();
    await openCodes(value, "/codes/pallets?from=2026-10-09&to=2026-10-08");
    expect(screen.queryByText(/^Показано:/)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("refuses an SSCC that is not 18 digits without asking the host", async () => {
    const value = await palletsOf();
    value.api.listPallets.mockClear();
    fireEvent.change(screen.getByLabelText("SSCC паллеты"), { target: { value: "12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Показать" }));
    expect(await screen.findByText("SSCC паллеты — 18 цифр")).toBeTruthy();
    expect(value.api.listPallets).not.toHaveBeenCalled();
  });

  it("refuses a box's SSCC: a pallet's starts with 1", async () => {
    const value = await palletsOf();
    value.api.listPallets.mockClear();
    fireEvent.change(screen.getByLabelText("SSCC паллеты"), {
      target: { value: "046006820000015000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Показать" }));
    expect(await screen.findByText("SSCC паллеты — 18 цифр")).toBeTruthy();
    expect(value.api.listPallets).not.toHaveBeenCalled();
  });

  it.each([["(00)146006820000000409"], ["]C100146006820000000409"], ["146006820000000409"]])(
    "reads a scanned label %s as the pallet's 18 digits",
    async (typed) => {
      const value = await palletsOf();
      fireEvent.change(screen.getByLabelText("SSCC паллеты"), { target: { value: typed } });
      fireEvent.click(screen.getByRole("button", { name: "Показать" }));
      await waitFor(() =>
        expect(value.api.listPallets).toHaveBeenLastCalledWith(
          "office-session-token",
          { sscc: "146006820000000409" },
          null,
        ),
      );
    },
  );

  it("names a revoked station as revoked, in the station filter", async () => {
    await palletsOf();
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Станция" }), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse",
    });
    const list = screen.getByRole("listbox");
    expect(within(list).getByText("Станция на линии 2 (отозвана)")).toBeTruthy();
  });

  it("opens a pallet's card from its row", async () => {
    const value = await palletsOf();
    fireEvent.click(rows()[1] as HTMLElement);
    await screen.findByRole("heading", { name: "Паллета (00)146006820000000409" });
    expect(value.api.getPalletCard).toHaveBeenCalledWith(
      "office-session-token",
      "a0000000-0000-4000-8000-000000000001",
    );
  });

  it("clears the filters", async () => {
    const value = await palletsOf(packSession(), `/codes/pallets?product=${MILK.id}`);
    value.api.listPallets.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    await waitFor(() =>
      expect(value.api.listPallets).toHaveBeenCalledWith("office-session-token", {}, null),
    );
  });

  it("says when nothing is found", async () => {
    const value = packSession();
    value.api.listPallets.mockResolvedValue({ items: [], nextCursor: null, stations: [] });
    await openCodes(value, "/codes/pallets");
    expect(await screen.findByText("Паллет по этим условиям нет")).toBeTruthy();
  });

  it("reads a backwards period as nothing to ask", async () => {
    const value = packSession();
    await openCodes(value, "/codes/pallets?from=2026-10-09&to=2026-10-08");
    expect(await screen.findByText("Период кончается раньше, чем начинается")).toBeTruthy();
    expect(value.api.listPallets).not.toHaveBeenCalled();
  });

  it("is open to a technologist", async () => {
    const value = packSession(undefined, TECHNOLOGIST);
    value.api.listPallets.mockResolvedValue(ONLY_PAGE);
    await palletsOf(value);
    expect(rows()).toHaveLength(3);
  });
});
