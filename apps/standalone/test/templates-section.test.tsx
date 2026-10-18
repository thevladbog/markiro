import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { fakeOfficeSession, renderOffice } from "./support/office.js";

/** A session whose catalog reads answer empty, so every tab of «Шаблоны» draws. */
function session() {
  const fake = fakeOfficeSession();
  fake.api.listTemplates.mockResolvedValue([]);
  fake.api.listProductGroups.mockResolvedValue([]);
  fake.api.listPalletSheets.mockResolvedValue({ sheets: [], defaultId: null });
  fake.api.getTemplateDefaults.mockResolvedValue({
    defaultBoxTemplateId: null,
    defaultPalletTemplateId: null,
    defaultDuplicateTemplateId: null,
    categories: [],
    defaultPalletSheetId: null,
    palletSheetCategories: [],
    rev: 1,
  });
  return fake;
}

function current(): string[] {
  const tabs = screen.getByRole("tablist", { name: "Разделы шаблонов" });
  return within(tabs)
    .getAllByRole("tab")
    .filter((tab) => tab.getAttribute("aria-selected") === "true")
    .map((tab) => tab.textContent ?? "");
}

describe("«Шаблоны» as one section", () => {
  it("leads the old addresses of the sheets and the defaults to their tabs, so no link breaks", async () => {
    for (const [path, heading, tab] of [
      ["/pallet-sheets", "Листы паллет А4", "Листы А4"],
      ["/template-defaults", "Шаблоны по умолчанию", "По умолчанию"],
      ["/templates", "Шаблоны этикеток", "Этикетки"],
    ] as const) {
      const view = renderOffice(session(), { initialPath: path });
      expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
      expect(current()).toEqual([tab]);
      // The open part is the tab's panel, named as the tab is.
      expect(screen.getByRole("tabpanel", { name: tab })).toBeTruthy();
      // The menu marks «Шаблоны» on every tab.
      expect(screen.getByRole("link", { name: "Шаблоны" }).getAttribute("aria-current")).toBe(
        "page",
      );
      view.unmount();
    }
  });
});
