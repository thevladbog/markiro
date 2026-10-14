import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

async function palletsOf(value = packSession(), path = "/codes/pallets") {
  await openCodes(value, path);
  await screen.findByRole("table");
  return value;
}

describe("«Паллеты» (plan КРТ)", () => {
  it("reads the first page with no filters and no cursor, open pallets first", async () => {
    const value = await palletsOf();
    expect(value.api.listPallets).toHaveBeenCalledWith("office-session-token", {}, null);
    expect(rows()).toHaveLength(3);
    expect(rows()[0]?.textContent).toContain("Без SSCC");
    expect(rows()[0]?.textContent).toContain("Открыта");
    expect(screen.getByText("Показано: 3")).toBeTruthy();
  });

  it("says in words that the count at the close differs from the boxes standing now", async () => {
    await palletsOf();
    expect(rows()[1]?.textContent).toContain("Закрыта");
    expect(rows()[1]?.textContent).toContain("Состав изменился после закрытия");
    expect(rows()[2]?.textContent).not.toContain("Состав изменился после закрытия");
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

  it("loads the next hundred below the cursor, adds the rows, and the button goes on the last page", async () => {
    const value = packSession();
    value.api.listPallets.mockResolvedValueOnce(PALLET_PAGE).mockResolvedValueOnce(SECOND);
    await palletsOf(value);
    fireEvent.click(screen.getByRole("button", { name: "Показать ещё" }));
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(value.api.listPallets).toHaveBeenLastCalledWith(
      "office-session-token",
      {},
      PALLET_PAGE.nextCursor,
    );
    expect(screen.queryByRole("button", { name: "Показать ещё" })).toBeNull();
    expect(screen.getByText("Показано: 4")).toBeTruthy();
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
    await palletsOf(packSession(undefined, TECHNOLOGIST));
    expect(rows()).toHaveLength(3);
  });
});
