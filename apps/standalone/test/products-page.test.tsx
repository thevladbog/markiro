import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { hasRowAction, pressRowAction } from "./support/row-menu.js";
import { chooseText, optionTexts } from "./support/select.js";

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
  defaultPalletSheetId: null,
  egaisCode: null,
  defaultCounterpartyId: null,
  photoChecksum: null,
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
  renderOffice(fake, { initialPath: "/products" });
  await screen.findByRole("link", { name: "Товары" });
  await screen.findByRole("heading", { name: "Товары" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

function rows(): HTMLElement[] {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1);
}

/** The names column, top to bottom: each product's name, without its print name. */
function names(): (string | null | undefined)[] {
  return rows().map((row) => row.querySelector(".product-name__full")?.textContent);
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

  it("shows the photo of a product that has one as a thumbnail in its row (plan ТОВ, beta 3)", async () => {
    const photo = "ae0e381fa858d6782d6859eb9337b80e670dc0021361fdd55d49299f1b4c26fd";
    const fake = session([{ ...MILK, photoChecksum: photo }, WATER_2]);
    fake.api.getProductPhoto.mockResolvedValue({
      photo: {
        width: 2,
        height: 1,
        dataBase64: "/9j/4AAQSkZJRgABAQ==",
        mediaType: "image/jpeg",
        checksum: photo,
        updatedAt: "2026-10-13T09:00:00.000Z",
      },
    });
    await openProducts(fake);
    const thumbnail = await within(rowOf(MILK.name)).findByRole("img", {
      name: `Фото товара ${MILK.name}`,
    });
    expect(thumbnail.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==");
    expect(within(rowOf(WATER_2.name)).queryByRole("img")).toBeNull();
    // Only the product that has a photo is read.
    expect(fake.api.getProductPhoto).toHaveBeenCalledTimes(1);
    expect(fake.api.getProductPhoto).toHaveBeenCalledWith("office-session-token", MILK.id);
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
    chooseText("Состояние", "Черновик");
    expect(names()).toEqual(["Вода 2"]);
    chooseText("Состояние", "Активен");
    expect(names()).toEqual(["Вода 10", "Молоко 3,2% 0,9 л"]);
    chooseText("Состояние", "В архиве");
    expect(names()).toEqual(["Айран"]);
    chooseText("Состояние", "Все");
    expect(names()).toHaveLength(4);
  });

  it("says nothing was found apart from an empty catalog", async () => {
    await openProducts(session());
    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "кефир" } });
    // The state names the filters, not the catalog, and offers to clear them (design 2026-10).
    expect(screen.getByText("Ничего не найдено.")).toBeTruthy();
    expect(screen.getByText("Измените поиск или отбор.")).toBeTruthy();
    expect(screen.getByText("Найдено: 0 из 4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить отбор" }));
    expect(names()).toHaveLength(4);
    expect((screen.getByLabelText("Поиск") as HTMLInputElement).value).toBe("");
  });

  it("says when the catalog is empty", async () => {
    await openProducts(session([]));
    expect(screen.getByText("Товаров пока нет.")).toBeTruthy();
    expect(screen.queryByText("Ничего не найдено.")).toBeNull();
    // An empty catalog has no filters to change; the way out is the first product.
    expect(screen.queryByLabelText("Поиск")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Добавить товар" })).toHaveLength(2);
  });

  it("pages the list by 10 and goes back to the first page when the search or the filter changes", async () => {
    const many = Array.from({ length: 25 }, (_, n) => ({
      ...MILK,
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      name: `Товар ${n + 1}`,
      printName: null,
    }));
    await openProducts(session(many));
    expect(rows()).toHaveLength(10);
    expect(names()[9]).toBe("Товар 10");
    const pager = () => screen.getByRole("navigation", { name: "Страницы списка товаров" });
    const next = () => within(pager()).getByRole("button", { name: "Вперёд" });
    expect(within(pager()).getByText("Страница 1 из 3")).toBeTruthy();
    // The page label is a live region: a screen reader hears «Вперёд» and «Назад» take effect.
    expect(within(pager()).getByText("Страница 1 из 3").getAttribute("aria-live")).toBe("polite");
    fireEvent.click(next());
    fireEvent.click(next());
    expect(names()).toEqual(["Товар 21", "Товар 22", "Товар 23", "Товар 24", "Товар 25"]);
    expect(next()).toHaveProperty("disabled", true);
    // A new search starts again from the first page, though the pages stay.
    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "Товар" } });
    expect(names()[0]).toBe("Товар 1");
    expect(within(pager()).getByText("Страница 1 из 3")).toBeTruthy();
    // So does a new state filter.
    fireEvent.click(next());
    chooseText("Состояние", "Активен");
    expect(names()[0]).toBe("Товар 1");
    expect(within(pager()).getByText("Страница 1 из 3")).toBeTruthy();
    // A search that leaves two pages shows the first of them.
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
    ]);
    expect(within(pager()).getByText("Страница 1 из 2")).toBeTruthy();
    // A search that leaves one page shows it without the pager.
    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "Товар 2" } });
    expect(names()).toHaveLength(7);
    expect(screen.queryByRole("navigation", { name: "Страницы списка товаров" })).toBeNull();
  });

  it("explains a failed load and loads again; with the groups failed too it is one alert and one «Повторить» that reads both again", async () => {
    const down = () => new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const unreachable = "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.";
    const fake = session();
    fake.api.listProducts.mockRejectedValueOnce(down());
    renderOffice(fake, { initialPath: "/products" });
    await screen.findByRole("link", { name: "Товары" });
    expect(await screen.findByText(unreachable)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Молоко 3,2% 0,9 л")).toBeTruthy();
    // Both reads failing is one failure on the screen: the products' error with one
    // «Повторить», and no warning about the group names of a list that is not shown.
    cleanup();
    const both = session();
    both.api.listProducts.mockRejectedValueOnce(down());
    both.api.listProductGroups.mockRejectedValueOnce(down());
    renderOffice(both, { initialPath: "/products" });
    await screen.findByRole("link", { name: "Товары" });
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
    // The page's first visit, the overview's read of the names, the page's second visit.
    await waitFor(() => expect(fake.api.listProducts).toHaveBeenCalledTimes(3));
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
      const view = renderOffice(fake, { initialPath: "/products" });
      await screen.findByRole("link", { name: "Товары" });
      expect(await screen.findByText("Товаров пока нет.")).toBeTruthy();
      view.unmount();
    }
  });

  describe("row actions (design 2026-10: icon buttons and the «Ещё» menu, no selection column)", () => {
    it("has no selection column and no bulk actions", async () => {
      await openProducts(session());
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
      expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
        "Товар",
        "GTIN",
        "Товарная группа",
        "В коробе, шт.",
        "Состояние",
        "Действия",
      ]);
    });

    it("gives every row an icon button for the edit, named for the product, with a tooltip on focus and hover", async () => {
      await openProducts(session());
      const edit = within(rowOf("Молоко 3,2% 0,9 л")).getByRole("button", {
        name: "Изменить товар «Молоко 3,2% 0,9 л»",
      });
      // An icon button: no text of its own, the name is the label.
      expect(edit.textContent).toBe("");
      fireEvent.mouseEnter(edit);
      expect(screen.getByRole("tooltip").textContent).toBe("Изменить товар «Молоко 3,2% 0,9 л»");
      expect(edit.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
      fireEvent.keyDown(edit, { key: "Escape" });
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.mouseLeave(edit);
      act(() => edit.focus());
      expect(screen.getByRole("tooltip")).toBeTruthy();
      act(() => edit.blur());
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("opens the edit drawer from the icon button", async () => {
      await openProducts(session());
      fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
      expect(await screen.findByRole("dialog", { name: "Товар «Молоко 3,2% 0,9 л»" })).toBeTruthy();
    });

    it("offers «Изменить» and «Убрать в архив» in the «Ещё» menu, moves with the arrows and closes on Escape with the focus back on the button", async () => {
      await openProducts(session());
      const trigger = within(rowOf("Молоко 3,2% 0,9 л")).getByRole("button", {
        name: "Действия: Молоко 3,2% 0,9 л",
      });
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      fireEvent.click(trigger);
      const items = screen.getAllByRole("menuitem");
      expect(items.map((item) => item.textContent)).toEqual(["Изменить", "Убрать в архив"]);
      await waitFor(() => expect(document.activeElement).toBe(items[0]));
      fireEvent.keyDown(items[0] as HTMLElement, { key: "ArrowDown" });
      expect(document.activeElement).toBe(items[1]);
      fireEvent.keyDown(items[1] as HTMLElement, { key: "ArrowDown" });
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(items[0] as HTMLElement, { key: "End" });
      expect(document.activeElement).toBe(items[1]);
      fireEvent.keyDown(items[1] as HTMLElement, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });

    it("asks before archiving, then writes the whole record with archived set and the loaded revision", async () => {
      const fake = session();
      fake.api.updateProduct.mockResolvedValue({ ...MILK, archived: true, rev: 66 });
      await openProducts(fake);
      pressRowAction(
        within(rowOf("Молоко 3,2% 0,9 л")),
        "Убрать товар «Молоко 3,2% 0,9 л» в архив",
      );
      const dialog = await screen.findByRole("dialog", { name: "Убрать товар в архив?" });
      expect(fake.api.updateProduct).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Убрать в архив" }));
      await screen.findByText("Товар «Молоко 3,2% 0,9 л» убран в архив.");
      expect(fake.api.updateProduct).toHaveBeenCalledTimes(1);
      const [token, id, body] = fake.api.updateProduct.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      expect([token, id]).toEqual(["office-session-token", MILK.id]);
      expect(body).toMatchObject({ archived: true, expectedRev: 65, name: MILK.name });
    });

    it("does not archive when the question is cancelled", async () => {
      const fake = session();
      await openProducts(fake);
      pressRowAction(
        within(rowOf("Молоко 3,2% 0,9 л")),
        "Убрать товар «Молоко 3,2% 0,9 л» в архив",
      );
      fireEvent.click(await screen.findByRole("button", { name: "Отмена" }));
      expect(fake.api.updateProduct).not.toHaveBeenCalled();
    });

    it("brings an archived product back from its menu", async () => {
      const fake = session();
      fake.api.updateProduct.mockResolvedValue({ ...AYRAN, archived: false, rev: 73 });
      await openProducts(fake);
      expect(hasRowAction(within(rowOf("Айран")), "Убрать товар «Айран» в архив")).toBe(false);
      pressRowAction(within(rowOf("Айран")), "Вернуть товар «Айран» из архива");
      fireEvent.click(await screen.findByRole("button", { name: "Вернуть" }));
      await screen.findByText("Товар «Айран» возвращён из архива.");
      expect(fake.api.updateProduct.mock.calls[0]?.[2]).toMatchObject({
        archived: false,
        expectedRev: 72,
      });
    });

    it("shows no row actions to a role that cannot edit the catalog", async () => {
      renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }), { initialPath: "/products" });
      await screen.findByRole("heading", { name: "Товары" });
      expect(screen.queryByRole("columnheader", { name: "Действия" })).not.toBeNull();
    });
  });

  it("shows the loading state until the products arrive", async () => {
    const fake = session();
    let arrive: (products: OfficeProduct[]) => void = () => undefined;
    fake.api.listProducts.mockReturnValue(
      new Promise<OfficeProduct[]>((resolve) => {
        arrive = resolve;
      }),
    );
    renderOffice(fake, { initialPath: "/products" });
    await screen.findByRole("link", { name: "Товары" });
    expect(await screen.findByText("Загрузка…")).toBeTruthy();
    // The card stands with its heading while the rows are on their way; no row, no filters.
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
    expect(screen.queryByLabelText("Поиск")).toBeNull();
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
    // The search's hint is its placeholder: a hint under the field would lift it off the bar's line.
    expect(screen.getByPlaceholderText("Название, название для печати или GTIN")).toBeTruthy();
    expect(optionTexts("Состояние")).toEqual(["Все", "Черновик", "Активен", "В архиве"]);
  });

  it("ignores spaces around a search", () => {
    const product = { name: "Молоко 3,2% 0,9 л", printName: null, gtin14: "04600682000013" };
    expect(matchesSearch(product, "  молоко  ")).toBe(true);
    expect(matchesSearch(product, " 3,2% ")).toBe(true);
    expect(matchesSearch(product, " кефир ")).toBe(false);
  });

  it("goes back a page with «Назад», which is off on the first page", async () => {
    await openProducts(session(numbered(15)));
    const previous = () => within(pagerNav()).getByRole("button", { name: "Назад" });
    expect(previous()).toHaveProperty("disabled", true);
    fireEvent.click(within(pagerNav()).getByRole("button", { name: "Вперёд" }));
    expect(names()).toHaveLength(5);
    expect(previous()).toHaveProperty("disabled", false);
    fireEvent.click(previous());
    expect(names()).toHaveLength(10);
    expect(names()[0]).toBe("Товар 1");
    expect(previous()).toHaveProperty("disabled", true);
  });

  it("shows the last page that is left when the list gets shorter under an open page", async () => {
    const many = numbered(15);
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
    queryClient.setQueryData(officeKeys.products, many.slice(0, 10));
    await waitFor(() => expect(names()).toHaveLength(10));
    expect(screen.queryByRole("navigation", { name: "Страницы списка товаров" })).toBeNull();
  });
});
