import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeProduct, ProductGroup } from "../src/host/protocol.js";
import { createOfficeQueryClient, officeKeys } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { matchesSearch } from "../src/office/products/product-list.js";
import { ProductsPage } from "../src/office/products/ProductsPage.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const GROUPS: ProductGroup[] = [
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 13, alias: "water", name: "Упакованная вода" },
];

const MILK: OfficeProduct = {
  id: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  gtin14: "04600682000013",
  name: "Молоко 3,2% 0,9 л",
  printName: "Молоко 3,2%",
  chzProductGroupCode: 8,
  boxCapacity: 12,
  palletBoxCapacity: 40,
  shelfLifeDays: 10,
  defaultBoxTemplateId: null,
  defaultPalletTemplateId: null,
  archived: false,
  status: "active",
  rev: 65,
};
/** A draft: no group, no capacities; its print name is its name. */
const WATER_2: OfficeProduct = {
  ...MILK,
  id: "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091",
  gtin14: "04601234000017",
  name: "Вода 2",
  printName: "Вода 2",
  chzProductGroupCode: null,
  boxCapacity: null,
  palletBoxCapacity: null,
  status: "draft",
  rev: 70,
};
/** In a group the host's lookup does not have. */
const WATER_10: OfficeProduct = {
  ...MILK,
  id: "3c4d5e6f-7081-4923-8b4c-5d6e7f809102",
  gtin14: "04602222000026",
  name: "Вода 10",
  printName: null,
  chzProductGroupCode: 99,
  boxCapacity: 6,
  rev: 71,
};
/** Archived and a draft: the list names it by the archive flag, not by the host's status. */
const AYRAN: OfficeProduct = {
  ...MILK,
  id: "4d5e6f70-8192-4a34-9c5d-6e7f80910213",
  gtin14: "04605555000015",
  name: "Айран",
  printName: null,
  boxCapacity: null,
  archived: true,
  status: "draft",
  rev: 72,
};

function session(products: OfficeProduct[] = [WATER_10, WATER_2, MILK, AYRAN]): FakeOfficeSession {
  const fake = fakeOfficeSession();
  // The host's own order (archived last, names bytewise): the page sorts again.
  fake.api.listProducts.mockResolvedValue(products);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  return fake;
}

async function openProducts(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake);
  fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
  await screen.findByRole("heading", { name: "Товары" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

function rows(): HTMLElement[] {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1);
}

/** The names column, top to bottom: each product's name, without its print name. */
function names(): (string | null | undefined)[] {
  return rows().map(
    (row) => within(row).getAllByRole("cell")[1]?.firstElementChild?.firstElementChild?.textContent,
  );
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** `count` active products named «Товар 1», «Товар 2», …: two pages from 26. */
function numbered(count: number): OfficeProduct[] {
  return Array.from({ length: count }, (_, n) => ({
    ...MILK,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `Товар ${n + 1}`,
    printName: null,
  }));
}

/** The list's pager. */
function pagerNav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Страницы списка товаров" });
}

describe("office products", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is in the menu under «Каталог» for both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = renderOffice(fakeOfficeSession(user === undefined ? {} : { user }));
      expect(await screen.findByRole("link", { name: "Товары" })).toBeTruthy();
      expect(screen.getByText("Каталог")).toBeTruthy();
      view.unmount();
    }
  });

  it("lists the products active first, by name with numbers in order, archived ones last", async () => {
    await openProducts(session());
    expect(names()).toEqual(["Вода 2", "Вода 10", "Молоко 3,2% 0,9 л", "Айран"]);
  });

  it("shows the GTIN, the group's name or its code, the box capacity and the state in words", async () => {
    await openProducts(session());
    const milk = within(rowOf("Молоко 3,2% 0,9 л"));
    expect(milk.getByText("04600682000013")).toBeTruthy();
    expect(milk.getByText("Молочная продукция")).toBeTruthy();
    expect(milk.getByText("12")).toBeTruthy();
    expect(milk.getByText("Активен")).toBeTruthy();
    const draft = within(rowOf("Вода 2"));
    expect(draft.getAllByText("—")).toHaveLength(2);
    expect(draft.getByText("Черновик")).toBeTruthy();
    expect(within(rowOf("Вода 10")).getByText("Код 99")).toBeTruthy();
    expect(within(rowOf("Айран")).getByText("В архиве")).toBeTruthy();
  });

  it("shows the print name as a second line only when it differs from the name", async () => {
    await openProducts(session());
    expect(within(rowOf("Молоко 3,2% 0,9 л")).getByText("Для печати: Молоко 3,2%")).toBeTruthy();
    expect(screen.queryByText("Для печати: Вода 2")).toBeNull();
    expect(screen.getAllByText(/^Для печати:/)).toHaveLength(1);
  });

  it("finds products by name, print name or GTIN, without case and with spaces in a GTIN", async () => {
    await openProducts(session());
    const search = screen.getByLabelText("Поиск");
    fireEvent.change(search, { target: { value: "ВОДА" } });
    expect(names()).toEqual(["Вода 2", "Вода 10"]);
    expect(screen.getByText("Найдено: 2 из 4")).toBeTruthy();
    fireEvent.change(search, { target: { value: " 4602 222 " } });
    expect(names()).toEqual(["Вода 10"]);
    fireEvent.change(search, { target: { value: "3,2%" } });
    expect(names()).toEqual(["Молоко 3,2% 0,9 л"]);
    fireEvent.change(search, { target: { value: "" } });
    expect(names()).toHaveLength(4);
  });

  it("matches a search the way the list does", () => {
    const product = { name: "Молоко 3,2% 0,9 л", printName: "Молоко", gtin14: "04600682000013" };
    for (const text of ["", "  ", "молоко", "МОЛОКО 3,2", "4600 682", "04600682000013", "0013"]) {
      expect(matchesSearch(product, text), text).toBe(true);
    }
    expect(matchesSearch(product, "4 600682 000013"), "EAN-13 as printed").toBe(true);
    for (const text of ["кефир", "4601", "460 0x"]) {
      expect(matchesSearch(product, text), text).toBe(false);
    }
    expect(matchesSearch({ ...product, name: "Йогурт", printName: "Молочный" }, "молоч")).toBe(
      true,
    );
  });

  it("keeps only the drafts, the active or the archived products with the state filter", async () => {
    await openProducts(session());
    const filter = screen.getByLabelText("Состояние");
    fireEvent.change(filter, { target: { value: "draft" } });
    expect(names()).toEqual(["Вода 2"]);
    fireEvent.change(filter, { target: { value: "active" } });
    expect(names()).toEqual(["Вода 10", "Молоко 3,2% 0,9 л"]);
    fireEvent.change(filter, { target: { value: "archived" } });
    expect(names()).toEqual(["Айран"]);
    fireEvent.change(filter, { target: { value: "all" } });
    expect(names()).toHaveLength(4);
  });

  it("says nothing was found apart from an empty catalog", async () => {
    await openProducts(session());
    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "кефир" } });
    expect(screen.getByText("Ничего не найдено. Измените поиск или отбор.")).toBeTruthy();
    expect(screen.getByText("Найдено: 0 из 4")).toBeTruthy();
  });

  it("says when the catalog is empty", async () => {
    await openProducts(session([]));
    expect(screen.getByText("Товаров пока нет.")).toBeTruthy();
    expect(screen.queryByText("Ничего не найдено. Измените поиск или отбор.")).toBeNull();
  });

  it("pages the list by 25 and goes back to the first page when the search or the filter changes", async () => {
    const many = Array.from({ length: 30 }, (_, n) => ({
      ...MILK,
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      name: `Товар ${n + 1}`,
      printName: null,
    }));
    await openProducts(session(many));
    expect(rows()).toHaveLength(25);
    expect(names()[24]).toBe("Товар 25");
    const pager = () => screen.getByRole("navigation", { name: "Страницы списка товаров" });
    const next = () => within(pager()).getByRole("button", { name: "Вперёд" });
    expect(within(pager()).getByText("Страница 1 из 2")).toBeTruthy();
    // The page label is a live region: a screen reader hears «Вперёд» and «Назад» take effect.
    expect(within(pager()).getByText("Страница 1 из 2").getAttribute("aria-live")).toBe("polite");
    fireEvent.click(next());
    expect(names()).toEqual(["Товар 26", "Товар 27", "Товар 28", "Товар 29", "Товар 30"]);
    expect(next()).toHaveProperty("disabled", true);
    // A new search starts again from the first page, though both pages stay.
    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "Товар" } });
    expect(names()[0]).toBe("Товар 1");
    expect(within(pager()).getByText("Страница 1 из 2")).toBeTruthy();
    // So does a new state filter.
    fireEvent.click(next());
    fireEvent.change(screen.getByLabelText("Состояние"), { target: { value: "active" } });
    expect(names()[0]).toBe("Товар 1");
    expect(within(pager()).getByText("Страница 1 из 2")).toBeTruthy();
    // A search that leaves one page shows it without the pager.
    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "Товар 1" } });
    expect(names()).toEqual([
      "Товар 1",
      "Товар 10",
      "Товар 11",
      "Товар 12",
      "Товар 13",
      "Товар 14",
      "Товар 15",
      "Товар 16",
      "Товар 17",
      "Товар 18",
      "Товар 19",
    ]);
    expect(screen.queryByRole("navigation", { name: "Страницы списка товаров" })).toBeNull();
  });

  it("explains a failed load and loads again; with the groups failed too it is one alert and one «Повторить» that reads both again", async () => {
    const down = () => new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const unreachable = "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.";
    const fake = session();
    fake.api.listProducts.mockRejectedValueOnce(down());
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
    expect(await screen.findByText(unreachable)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Молоко 3,2% 0,9 л")).toBeTruthy();
    // Both reads failing is one failure on the screen: the products' error with one
    // «Повторить», and no warning about the group names of a list that is not shown.
    cleanup();
    const both = session();
    both.api.listProducts.mockRejectedValueOnce(down());
    both.api.listProductGroups.mockRejectedValueOnce(down());
    renderOffice(both);
    fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
    expect(await screen.findByText(unreachable)).toBeTruthy();
    await waitFor(() => expect(both.api.listProductGroups).toHaveBeenCalledTimes(1));
    // Two passes of the scheduler: the groups' failure has been taken in too.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Повторить" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Молоко 3,2% 0,9 л")).toBeTruthy();
    // That one click read both again, each exactly once, and nothing is left to warn about.
    await waitFor(() => expect(both.api.listProductGroups).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(both.api.listProducts).toHaveBeenCalledTimes(2);
    expect(both.api.listProductGroups).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(rowOf("Молоко 3,2% 0,9 л")).getByText("Молочная продукция")).toBeTruthy();
  });

  it("keeps the list when the product groups do not load, shows their codes and loads them again", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    await openProducts(fake);
    expect(
      await screen.findByText(
        "Справочник товарных групп не загрузился: в списке видны коды групп.",
      ),
    ).toBeTruthy();
    expect(within(rowOf("Молоко 3,2% 0,9 л")).getByText("Код 8")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await within(rowOf("Молоко 3,2% 0,9 л")).findByText("Молочная продукция")).toBeTruthy();
  });

  it("reads the product groups once while they are cached, and the products on every visit", async () => {
    const fake = session();
    await openProducts(fake);
    fireEvent.click(screen.getByRole("link", { name: "Обзор" }));
    fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
    await waitFor(() => expect(fake.api.listProducts).toHaveBeenCalledTimes(2));
    await screen.findByText("Молоко 3,2% 0,9 л");
    // Two passes of the scheduler: an effect that would read again has run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.api.listProductGroups).toHaveBeenCalledTimes(1);
  });

  it("opens for both roles, not only for the administrator", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const fake = fakeOfficeSession(user === undefined ? {} : { user });
      fake.api.listProducts.mockResolvedValue([]);
      fake.api.listProductGroups.mockResolvedValue([]);
      const view = renderOffice(fake);
      fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
      expect(await screen.findByText("Товаров пока нет.")).toBeTruthy();
      view.unmount();
    }
  });

  it("shows the loading state until the products arrive", async () => {
    const fake = session();
    let arrive: (products: OfficeProduct[]) => void = () => undefined;
    fake.api.listProducts.mockReturnValue(
      new Promise<OfficeProduct[]>((resolve) => {
        arrive = resolve;
      }),
    );
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
    expect(await screen.findByText("Загрузка…")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    arrive([MILK]);
    expect(await screen.findByText("Молоко 3,2% 0,9 л")).toBeTruthy();
    expect(screen.queryByText("Загрузка…")).toBeNull();
  });

  it("marks each state with its phase: archived is retired, not an alarm", async () => {
    await openProducts(session());
    const chip = (name: string, label: string) =>
      within(rowOf(name)).getByText(label).closest(".mk-chip");
    expect(chip("Молоко 3,2% 0,9 л", "Активен")?.classList.contains("mk-chip--active")).toBe(true);
    expect(chip("Вода 2", "Черновик")?.classList.contains("mk-chip--draft")).toBe(true);
    expect(chip("Айран", "В архиве")?.classList.contains("mk-chip--retired")).toBe(true);
  });

  it("names the table, the search controls and the state filter", async () => {
    await openProducts(session());
    expect(screen.getByRole("region", { name: "Товары" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Поиск и отбор товаров" })).toBeTruthy();
    expect(screen.getByText("Название, название для печати или GTIN")).toBeTruthy();
    const options = within(screen.getByLabelText("Состояние")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Все",
      "Черновик",
      "Активен",
      "В архиве",
    ]);
  });

  it("ignores spaces around a search", () => {
    const product = { name: "Молоко 3,2% 0,9 л", printName: null, gtin14: "04600682000013" };
    expect(matchesSearch(product, "  молоко  ")).toBe(true);
    expect(matchesSearch(product, " 3,2% ")).toBe(true);
    expect(matchesSearch(product, " кефир ")).toBe(false);
  });

  it("goes back a page with «Назад», which is off on the first page", async () => {
    await openProducts(session(numbered(30)));
    const previous = () => within(pagerNav()).getByRole("button", { name: "Назад" });
    expect(previous()).toHaveProperty("disabled", true);
    fireEvent.click(within(pagerNav()).getByRole("button", { name: "Вперёд" }));
    expect(names()).toHaveLength(5);
    expect(previous()).toHaveProperty("disabled", false);
    fireEvent.click(previous());
    expect(names()).toHaveLength(25);
    expect(names()[0]).toBe("Товар 1");
    expect(previous()).toHaveProperty("disabled", true);
  });

  it("shows the last page that is left when the list gets shorter under an open page", async () => {
    const many = numbered(30);
    const queryClient = createOfficeQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <OfficeSessionProvider value={session(many)}>
          <ProductsPage />
        </OfficeSessionProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("Товар 1");
    fireEvent.click(within(pagerNav()).getByRole("button", { name: "Вперёд" }));
    expect(names()).toHaveLength(5);
    // A write can shrink the FOUND list under an open page (a row archived under
    // «Активен», or renamed out of a search); it never shortens the cached list, which
    // it replaces in place or appends to. The test stands in for that shrinking by
    // setting a shorter cached list with `setQueryData`.
    queryClient.setQueryData(officeKeys.products, many.slice(0, 20));
    await waitFor(() => expect(names()).toHaveLength(20));
    expect(screen.queryByRole("navigation", { name: "Страницы списка товаров" })).toBeNull();
  });
});
