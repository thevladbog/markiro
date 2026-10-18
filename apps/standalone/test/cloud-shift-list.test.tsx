import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeOfficeSession, ORG_PROFILE, renderOffice } from "./support/office.js";
import { freezeToday, pickDate } from "./support/shifts.js";
import "../src/i18n/index.js";

function setup() {
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.listCloudShifts.mockImplementation(async (_token, query) => ({
    items: [],
    total: 0,
    page: query?.page ?? 1,
    pageCount: 1,
  }));
  renderOffice(session, { initialPath: "/cloud-shifts" });
  return session;
}

describe("imported shift list", () => {
  afterEach(() => vi.useRealTimers());
  it("keeps source choices as named route links with exactly one current source", async () => {
    setup();
    await screen.findByText("Облачных смен нет");
    const navigation = screen.getByRole("navigation", { name: "Источник смен" });
    expect(
      within(navigation).getByRole("link", { name: "Местные смены" }).getAttribute("href"),
    ).toBe("/shifts");
    expect(
      within(navigation)
        .getByRole("link", { name: "Облачная история", current: "page" })
        .getAttribute("href"),
    ).toBe("/cloud-shifts");
    expect(within(navigation).getAllByRole("link", { current: "page" })).toHaveLength(1);
  });

  it("distinguishes a filtered empty result and resets the date criteria", async () => {
    freezeToday();
    const session = setup();
    await screen.findByText("Облачных смен нет");
    pickDate("Дата производства с", "1 октября 2026");
    await waitFor(() =>
      expect(session.api.listCloudShifts).toHaveBeenLastCalledWith(expect.any(String), {
        page: 1,
        from: "2026-10-01",
      }),
    );
    expect(await screen.findByText("Ничего не найдено.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить отбор" }));
    await waitFor(() =>
      expect(session.api.listCloudShifts).toHaveBeenLastCalledWith(expect.any(String), { page: 1 }),
    );
    expect(await screen.findByText("Облачных смен нет")).toBeTruthy();
  });
});
