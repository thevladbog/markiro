import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { ImportSession } from "@markiro/platform-contracts";
import i18n from "../src/i18n/index.js";
import {
  ImportSelection,
  initialItemsQuery,
} from "../src/pages/catalog/national-catalog/ImportSelection.js";
import { sessionFixture, itemsFixture } from "./national-catalog-fixtures.js";

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("ru");
});

function selection(session: Partial<ImportSession>, populated = false) {
  return render(
    <ImportSelection
      session={{ ...sessionFixture, loaded: 0, ...session }}
      data={populated ? itemsFixture : { items: [], nextCursor: null }}
      query={initialItemsQuery}
      onQuery={vi.fn()}
      onSelection={vi.fn()}
      onPrepare={vi.fn()}
      canWrite
      busy={false}
    />,
    { wrapper: MemoryRouter },
  );
}

it.each(["queued", "loading", "partial"] as const)(
  "shows automatic %s work as loading, not an incomplete or empty result",
  (state) => {
    selection({ state, automaticWorkPending: true });
    expect(
      screen.getByRole("status", { name: "Загружаем товары из Национального каталога" }),
    ).toBeDefined();
    expect(
      screen.queryByText("Список загружен не полностью. Доступные товары можно добавить."),
    ).toBeNull();
    expect(screen.queryByText("No data")).toBeNull();
    expect(screen.queryByText("Товары не найдены")).toBeNull();
  },
);

it("shows an empty result only when discovery completed", () => {
  selection({ state: "ready", complete: true, automaticWorkPending: false });
  expect(screen.getByText("Товары не найдены")).toBeDefined();
  expect(
    screen.queryByRole("status", { name: "Загружаем товары из Национального каталога" }),
  ).toBeNull();
});

it("shows a stopped empty discovery as a failure, not no matching products", () => {
  selection({ state: "blocked", complete: false, automaticWorkPending: false });
  expect(screen.getByRole("alert").textContent).toContain("Не удалось загрузить список товаров");
  expect(screen.queryByText("Товары не найдены")).toBeNull();
});

it.each(["ru", "en"])(
  "uses the interface language %s for the start date instead of the browser default",
  async (language) => {
    await i18n.changeLanguage(language);
    const { container } = selection({ state: "ready", complete: true });
    const text = container.querySelector("time")?.textContent ?? "";
    if (language === "ru") {
      expect(text).toMatch(/^09\.09\.2026, \d{2}:\d{2}$/);
      expect(text).not.toMatch(/AM|PM/);
    } else {
      expect(text).toMatch(/^9\/9\/26, /);
    }
  },
);
