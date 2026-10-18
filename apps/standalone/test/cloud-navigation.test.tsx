import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeOfficeSession, renderOffice } from "./support/office.js";

describe("cloud history navigation belongs to shifts", () => {
  it.each([
    "/cloud-shifts",
    "/cloud-shifts/example",
    "/cloud-boxes/example",
    "/cloud-pallets/example",
  ])("keeps the menu active and gives a return path on %s", async (path) => {
    renderOffice(fakeOfficeSession(), { initialPath: path });
    const menu = await screen.findByRole("navigation", { name: "Разделы офиса" });
    const shifts = within(menu).getByRole("link", { name: "Смены" });
    expect(shifts.classList.contains("office-menu__link--active")).toBe(true);
    expect(shifts.getAttribute("aria-current")).toBe("page");
    const crumbs = screen.getByRole("navigation", { name: "Вы здесь" });
    expect(within(crumbs).getByRole("link", { name: "Смены" }).getAttribute("href")).toBe(
      "/shifts",
    );
    if (path !== "/cloud-shifts") {
      expect(
        within(crumbs).getByRole("link", { name: "Облачная история" }).getAttribute("href"),
      ).toBe("/cloud-shifts");
    } else {
      expect(within(crumbs).getByText("Облачная история").getAttribute("aria-current")).toBe(
        "page",
      );
    }
  });
});
