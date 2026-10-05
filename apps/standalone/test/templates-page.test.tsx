import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { matchesTemplateSearch } from "../src/office/templates/template-list.js";
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

/** A template summary: an enabled box template for every category unless told otherwise. */
function summary(id: string, name: string, data: Partial<LabelTemplateSummary> = {}) {
  return {
    id,
    name,
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: false,
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    rev: 60,
    ...data,
  } satisfies LabelTemplateSummary;
}

const BOX_58 = summary("7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c", "Коробка 58×40", { stock: true });
const BOX_100 = summary("8d2f5c3b-0e4a-4f6b-9c7d-2e3f4a5b6c7d", "Коробка 100×100", {
  stock: true,
  widthMm: 100,
  heightMm: 100,
});
const MILK = summary("a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d", "Молоко 58×40", {
  chzProductGroupCodes: [8],
  language: "tspl",
});
/** Disabled, for three categories, one of them unknown to the lookup; a fractional width and no resolution. */
const DRINKS = summary("9e3a6d4c-1f5b-4a7c-8d8e-3f4a5b6c7d8e", "Вода и молоко", {
  enabled: false,
  chzProductGroupCodes: [8, 13, 99],
  widthMm: 58.5,
  dpi: null,
});
const PALLET = summary("0f4b7e5d-2a6c-4b8d-9e9f-4a5b6c7d8e9f", "Паллета 100×150", {
  purpose: "pallet",
  stock: true,
  widthMm: 100,
  heightMm: 150,
});
const DUPLICATE = summary(
  "1a5c8f6e-3b7d-4c9e-8f0a-5b6c7d8e9f0a",
  "Дубликат Data Matrix 58×40 [Полное наименование]",
  { purpose: "product_duplicate", stock: true },
);
/** A layout without a size, a resolution or a language. */
const BARE = summary("2b6d9a7f-4c8e-4d0f-9a1b-6c7d8e9f0a1b", "Импорт без размера", {
  widthMm: null,
  heightMm: null,
  dpi: null,
  language: null,
});

/** The host's own order (names bytewise): the page sorts again. */
const TEMPLATES = [BOX_100, BOX_58, DRINKS, DUPLICATE, BARE, MILK, PALLET];

function session(templates: LabelTemplateSummary[] = TEMPLATES, user = TECHNOLOGIST) {
  const fake = fakeOfficeSession({ user });
  fake.api.listTemplates.mockResolvedValue(templates);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  return fake;
}

async function openTemplates(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake);
  fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
  await screen.findByRole("heading", { name: "Шаблоны этикеток" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

function rows(): HTMLElement[] {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1);
}

/** The names column, top to bottom, without the «Типовой» tag. */
function names(): (string | null | undefined)[] {
  return rows().map(
    (row) => within(row).getAllByRole("cell")[0]?.firstElementChild?.firstElementChild?.textContent,
  );
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** The text of the row's cells, left to right. */
function cells(name: string): (string | null)[] {
  return within(rowOf(name))
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
}

const down = () => new HostError({ kind: "transport", code: "unreachable", message: "down" });
const UNREACHABLE = "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.";

describe("office label templates", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is in the menu under «Каталог» right after «Товары», for both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = renderOffice(fakeOfficeSession(user === undefined ? {} : { user }));
      const menu = await screen.findByRole("navigation", { name: "Разделы офиса" });
      const items = within(menu)
        .getAllByRole("listitem")
        .map((item) => item.textContent);
      const catalog = items.indexOf("Каталог");
      expect(items.slice(catalog, catalog + 3)).toEqual(["Каталог", "Товары", "Шаблоны"]);
      view.unmount();
    }
  });

  it("lists the templates by name with numbers by value, whatever order the host sends", async () => {
    await openTemplates(session());
    expect(names()).toEqual([
      "Вода и молоко",
      "Дубликат Data Matrix 58×40 [Полное наименование]",
      "Импорт без размера",
      "Коробка 58×40",
      "Коробка 100×100",
      "Молоко 58×40",
      "Паллета 100×150",
    ]);
  });

  it("shows the purpose in words, the size, the layout's resolution, the categories and the state in words with its glyph, and tags a stock template", async () => {
    await openTemplates(session());
    // The six columns of the list; the write buttons have a column of their own.
    expect(cells("Коробка 58×40").slice(0, 6)).toEqual([
      "Коробка 58×40Типовой",
      "Короб",
      "58 × 40 мм",
      "203 dpi",
      "Все категории",
      "▸Включён",
    ]);
    expect(cells("Молоко 58×40").slice(0, 6)).toEqual([
      "Молоко 58×40",
      "Короб",
      "58 × 40 мм",
      "203 dpi",
      "Молочная продукция",
      "▸Включён",
    ]);
    expect(cells("Вода и молоко").slice(0, 6)).toEqual([
      "Вода и молоко",
      "Короб",
      "58,5 × 40 мм",
      "—",
      "Категорий: 3",
      "✕Выключен",
    ]);
    expect(cells("Импорт без размера").slice(0, 6)).toEqual([
      "Импорт без размера",
      "Короб",
      "—",
      "—",
      "Все категории",
      "▸Включён",
    ]);
    expect(cells("Паллета 100×150").slice(0, 3)).toEqual([
      "Паллета 100×150Типовой",
      "Паллета",
      "100 × 150 мм",
    ]);
    expect(cells("Дубликат Data Matrix 58×40 [Полное наименование]")[1]).toBe("Дубликат товара");
    expect(screen.getAllByText("Типовой")).toHaveLength(4);
  });

  it("names every category in a title when it counts them, and names one category or a code the lookup lacks", async () => {
    await openTemplates(session());
    const scope = within(rowOf("Вода и молоко")).getByText("Категорий: 3");
    expect(scope.getAttribute("title")).toBe("Молочная продукция, Упакованная вода, Код 99");
    expect(
      within(rowOf("Молоко 58×40")).getByText("Молочная продукция").getAttribute("title"),
    ).toBe("Молочная продукция");
    expect(within(rowOf("Коробка 58×40")).getByText("Все категории").hasAttribute("title")).toBe(
      false,
    );
  });

  it("finds templates by name, without case and spaces around the search", async () => {
    await openTemplates(session());
    const search = screen.getByLabelText("Поиск");
    fireEvent.change(search, { target: { value: " КОРОБКА " } });
    expect(names()).toEqual(["Коробка 58×40", "Коробка 100×100"]);
    expect(screen.getByText("Найдено: 2 из 7")).toBeTruthy();
    fireEvent.change(search, { target: { value: "58×40" } });
    expect(names()).toEqual([
      "Дубликат Data Matrix 58×40 [Полное наименование]",
      "Коробка 58×40",
      "Молоко 58×40",
    ]);
    fireEvent.change(search, { target: { value: "" } });
    expect(names()).toHaveLength(7);
    expect(matchesTemplateSearch({ name: "Молоко 58×40" }, "  ")).toBe(true);
    expect(matchesTemplateSearch({ name: "Молоко 58×40" }, "кефир")).toBe(false);
  });

  it("keeps one purpose or one state with the filters, and both together", async () => {
    await openTemplates(session());
    const purpose = screen.getByLabelText("Назначение");
    const state = screen.getByLabelText("Состояние");
    fireEvent.change(purpose, { target: { value: "pallet" } });
    expect(names()).toEqual(["Паллета 100×150"]);
    fireEvent.change(purpose, { target: { value: "product_duplicate" } });
    expect(names()).toEqual(["Дубликат Data Matrix 58×40 [Полное наименование]"]);
    fireEvent.change(purpose, { target: { value: "box" } });
    expect(names()).toEqual([
      "Вода и молоко",
      "Импорт без размера",
      "Коробка 58×40",
      "Коробка 100×100",
      "Молоко 58×40",
    ]);
    fireEvent.change(state, { target: { value: "disabled" } });
    expect(names()).toEqual(["Вода и молоко"]);
    fireEvent.change(state, { target: { value: "enabled" } });
    expect(names()).toEqual([
      "Импорт без размера",
      "Коробка 58×40",
      "Коробка 100×100",
      "Молоко 58×40",
    ]);
    fireEvent.change(purpose, { target: { value: "all" } });
    fireEvent.change(state, { target: { value: "all" } });
    expect(names()).toHaveLength(7);
  });

  it("says nothing was found apart from an empty list", async () => {
    await openTemplates(session());
    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "кефир" } });
    expect(screen.getByText("Ничего не найдено. Измените поиск или отбор.")).toBeTruthy();
    expect(screen.getByText("Найдено: 0 из 7")).toBeTruthy();
    expect(screen.queryByText("Шаблонов пока нет.")).toBeNull();
  });

  it("says when there are no templates", async () => {
    await openTemplates(session([]));
    expect(screen.getByText("Шаблонов пока нет.")).toBeTruthy();
    expect(screen.queryByText("Ничего не найдено. Измените поиск или отбор.")).toBeNull();
  });

  it("explains a failed load and loads again; with the groups failed too it is one alert and one «Повторить» that reads both again", async () => {
    const fake = session();
    fake.api.listTemplates.mockRejectedValueOnce(down());
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Молоко 58×40")).toBeTruthy();
    cleanup();
    const both = session();
    both.api.listTemplates.mockRejectedValueOnce(down());
    both.api.listProductGroups.mockRejectedValueOnce(down());
    renderOffice(both);
    fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    await waitFor(() => expect(both.api.listProductGroups).toHaveBeenCalledTimes(1));
    // Two passes of the scheduler: the groups' failure has been taken in too.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Молоко 58×40")).toBeTruthy();
    await waitFor(() => expect(both.api.listProductGroups).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(both.api.listTemplates).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(rowOf("Молоко 58×40")).getByText("Молочная продукция")).toBeTruthy();
  });

  it("keeps the list when the product groups do not load, shows their codes and loads them again", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValueOnce(down());
    await openTemplates(fake);
    expect(
      await screen.findByText(
        "Справочник товарных групп не загрузился: вместо названий категорий видны коды.",
      ),
    ).toBeTruthy();
    expect(within(rowOf("Молоко 58×40")).getByText("Код 8")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await within(rowOf("Молоко 58×40")).findByText("Молочная продукция")).toBeTruthy();
  });

  it("reads the templates on every visit and the product groups once while they are cached", async () => {
    const fake = session();
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("link", { name: "Обзор" }));
    fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
    await screen.findByText("Молоко 58×40");
    // Two passes of the scheduler: an effect that would read again has run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.api.listProductGroups).toHaveBeenCalledTimes(1);
  });

  it("tags each purpose with its own category tone and the state with its phase: a disabled template is retired, not an alarm", async () => {
    await openTemplates(session());
    const tag = (name: string, label: string) => within(rowOf(name)).getByText(label);
    expect(tag("Коробка 58×40", "Короб").classList.contains("mk-badge--violet")).toBe(true);
    expect(tag("Паллета 100×150", "Паллета").classList.contains("mk-badge--magenta")).toBe(true);
    expect(
      tag("Дубликат Data Matrix 58×40 [Полное наименование]", "Дубликат товара").classList.contains(
        "mk-badge--teal",
      ),
    ).toBe(true);
    expect(tag("Коробка 58×40", "Типовой").classList.contains("mk-badge--steel")).toBe(true);
    const chip = (name: string, label: string) => tag(name, label).closest(".mk-chip");
    expect(chip("Коробка 58×40", "Включён")?.classList.contains("mk-chip--active")).toBe(true);
    expect(chip("Вода и молоко", "Выключен")?.classList.contains("mk-chip--retired")).toBe(true);
  });

  it("names the table, the search controls and both filters, with their choices in order", async () => {
    await openTemplates(session());
    expect(screen.getByRole("region", { name: "Шаблоны этикеток" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Поиск и отбор шаблонов" })).toBeTruthy();
    expect(screen.getByText("Название шаблона")).toBeTruthy();
    const options = (label: string) =>
      within(screen.getByLabelText(label))
        .getAllByRole("option")
        .map((option) => [option.getAttribute("value"), option.textContent]);
    expect(options("Назначение")).toEqual([
      ["all", "Все"],
      ["box", "Короб"],
      ["pallet", "Паллета"],
      ["product_duplicate", "Дубликат товара"],
    ]);
    expect(options("Состояние")).toEqual([
      ["all", "Все"],
      ["enabled", "Включённые"],
      ["disabled", "Выключенные"],
    ]);
  });

  it("opens for the administrator too", async () => {
    await openTemplates(session(TEMPLATES, { ...TECHNOLOGIST, role: "admin" }));
    expect(names()).toHaveLength(7);
  });

  // Beyond the plan: each test below kills a mutant the plan's tests let through.

  it("titles the six columns, and calls the resolution the layout's", async () => {
    await openTemplates(session());
    const headers = within(screen.getByRole("table")).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual([
      "Название",
      "Назначение",
      "Размер",
      "Разрешение макета",
      "Категории",
      "Состояние",
    ]);
  });

  it("warns, and does not fail, when only the product groups do not load: the list stays whole", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValueOnce(down());
    await openTemplates(fake);
    const warning = await screen.findByText(
      "Справочник товарных групп не загрузился: вместо названий категорий видны коды.",
    );
    expect(warning.closest(".mk-alert")?.classList.contains("mk-alert--warn")).toBe(true);
    expect(names()).toHaveLength(7);
  });

  it("ignores the spaces on both sides of the search and keeps the ones inside it", async () => {
    await openTemplates(session());
    const search = screen.getByLabelText("Поиск");
    fireEvent.change(search, { target: { value: "  молоко  " } });
    expect(names()).toEqual(["Вода и молоко", "Молоко 58×40"]);
    fireEvent.change(search, { target: { value: "и молоко" } });
    expect(names()).toEqual(["Вода и молоко"]);
    expect(matchesTemplateSearch({ name: "Вода и молоко" }, " молоко ")).toBe(true);
    expect(matchesTemplateSearch({ name: "Вода и молоко" }, "имолоко")).toBe(false);
  });

  it("keeps a template's name and its «Типовой» tag in the box the stylesheet lays out", async () => {
    await openTemplates(session());
    const name = within(rowOf("Коробка 58×40")).getByText("Коробка 58×40");
    expect(name.parentElement?.classList.contains("template-name")).toBe(true);
    expect(name.nextElementSibling?.textContent).toBe("Типовой");
  });

  it("sets the size and the resolution in the mono face, and lets the name and the categories wrap", async () => {
    await openTemplates(session());
    const row = within(rowOf("Коробка 58×40")).getAllByRole("cell");
    expect(row.map((cell) => cell.classList.contains("font-mono"))).toEqual([
      false,
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(row.map((cell) => cell.style.whiteSpace)).toEqual([
      "normal",
      "nowrap",
      "nowrap",
      "nowrap",
      "normal",
      "nowrap",
    ]);
  });

  it("lists two templates of one name as two rows, the lower id first, with no key clash", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const twin = (id: string, enabled: boolean) => summary(id, "Коробка 70×50", { enabled });
      await openTemplates(
        session([
          twin("f0000000-0000-4000-8000-00000000000b", false),
          twin("f0000000-0000-4000-8000-00000000000a", true),
        ]),
      );
      const states = () =>
        rows().map((row) => within(row).getByText(/^(Включён|Выключен)$/).textContent);
      expect(states()).toEqual(["Включён", "Выключен"]);
      fireEvent.change(screen.getByLabelText("Состояние"), { target: { value: "disabled" } });
      expect(states()).toEqual(["Выключен"]);
      fireEvent.change(screen.getByLabelText("Состояние"), { target: { value: "all" } });
      expect(states()).toEqual(["Включён", "Выключен"]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("shows the loading note, and no table, until the templates arrive", async () => {
    const fake = session();
    let arrive: (templates: LabelTemplateSummary[]) => void = () => undefined;
    fake.api.listTemplates.mockReturnValueOnce(
      new Promise<LabelTemplateSummary[]>((resolve) => {
        arrive = resolve;
      }),
    );
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
    expect(await screen.findByText("Загрузка…")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    arrive(TEMPLATES);
    expect(await screen.findByText("Молоко 58×40")).toBeTruthy();
    expect(screen.queryByText("Загрузка…")).toBeNull();
  });
});
