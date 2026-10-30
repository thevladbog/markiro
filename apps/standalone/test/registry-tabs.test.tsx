import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TECHNOLOGIST } from "./support/office.js";
import { chooseTab, openCodes, packSession, PALLET_PAGE } from "./support/pack-cards.js";
import { MILK } from "./support/shifts.js";

describe("the parts of «Поиск кодов» (plan КРТ)", () => {
  it("are three tabs over one menu item, the codes' first", async () => {
    await openCodes(packSession());
    const tabs = screen.getByRole("tablist", { name: "Разделы поиска кодов" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Коды", "Короба", "Палеты"]);
    expect(within(tabs).getByRole("tab", { name: "Коды" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(
      within(screen.getByRole("navigation", { name: "Разделы офиса" }))
        .getByRole("link", { name: "Поиск кодов" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("keep the menu item lit on the boxes, the pallets and a card", async () => {
    const session = packSession();
    await openCodes(session);
    for (const tab of ["Короба", "Палеты"] as const) {
      chooseTab(tab);
      await screen.findByRole("tab", { name: tab, selected: true });
      expect(
        within(screen.getByRole("navigation", { name: "Разделы офиса" }))
          .getByRole("link", { name: "Поиск кодов" })
          .getAttribute("aria-current"),
      ).toBe("page");
    }
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    fireEvent.click(
      screen.getAllByRole("link", { name: "(00)146006820000000409" })[0] as HTMLElement,
    );
    await screen.findByRole("heading", { name: "Палет (00)146006820000000409" });
    expect(
      within(screen.getByRole("navigation", { name: "Разделы офиса" }))
        .getByRole("link", { name: "Поиск кодов" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("move with the arrow keys, and the tab found on the next page has the focus", async () => {
    await openCodes(packSession());
    const first = screen.getByRole("tab", { name: "Коды" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const second = await screen.findByRole("tab", { name: "Короба", selected: true });
    await waitFor(() => expect(document.activeElement).toBe(second));
  });

  it("remember the filters a part was left with", async () => {
    const session = packSession();
    await openCodes(session, `/codes/pallets?product=${MILK.id}`);
    await waitFor(() =>
      expect(session.api.listPallets).toHaveBeenCalledWith(
        "office-session-token",
        { product: MILK.id },
        null,
      ),
    );
    chooseTab("Коды");
    await screen.findByRole("tab", { name: "Коды", selected: true });
    session.api.listPallets.mockClear();
    chooseTab("Палеты");
    await screen.findByRole("tab", { name: "Палеты", selected: true });
    await waitFor(() =>
      expect(session.api.listPallets).toHaveBeenCalledWith(
        "office-session-token",
        { product: MILK.id },
        null,
      ),
    );
    expect(PALLET_PAGE.items.length).toBeGreaterThan(0);
  });

  it("are open to a technologist", async () => {
    await openCodes(packSession(undefined, TECHNOLOGIST));
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });
});
