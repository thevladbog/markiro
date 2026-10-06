import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { LabelTemplate, LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { createOfficeQueryClient, officeKeys } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { matchesTemplateSearch } from "../src/office/templates/template-list.js";
import { TemplatesPage } from "../src/office/templates/TemplatesPage.js";
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

  it("titles the seven columns, the last one «Действия», and calls the resolution the layout's", async () => {
    await openTemplates(session());
    const headers = within(screen.getByRole("table")).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual([
      "Название",
      "Назначение",
      "Размер",
      "Разрешение макета",
      "Категории",
      "Состояние",
      "Действия",
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

  it("sets the size and the resolution in the mono face, and lets the name and the categories wrap; the cell with the two action buttons stays on one line", async () => {
    await openTemplates(session());
    const row = within(rowOf("Коробка 58×40")).getAllByRole("cell");
    expect(row.map((cell) => cell.classList.contains("font-mono"))).toEqual([
      false,
      false,
      true,
      true,
      false,
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

  it("shows a template's name and a group's name with markup characters as plain text, in the cell and in the title", async () => {
    // `t()` does not escape what it interpolates (`escapeValue: false`): a name is shown as a React child or an attribute, never as HTML.
    const name = '<b>Тест</b> & "кавычки"';
    const group = '<i>Группа</i> & "x"';
    const fake = session([
      summary("3c7e0b8a-5d9f-4e1a-8b2c-7d8e9f0a1b2c", name, { chzProductGroupCodes: [21] }),
    ]);
    fake.api.listProductGroups.mockResolvedValue([
      ...GROUPS,
      { code: 21, alias: "odd", name: group },
    ]);
    await openTemplates(fake);
    const row = rowOf(name);
    expect(row.querySelector("b, i")).toBeNull();
    expect(within(row).getByText(group).getAttribute("title")).toBe(group);
  });
});

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function hostError(code: string, status: number, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status, message: code, details });
}

/**
 * The host's answer to a template write: the template with its layout. The
 * layout's size differs from the summary's on purpose: a row keeps the size it
 * has, since a switch or a change of categories never touches the layout.
 */
function answer(template: LabelTemplateSummary, data: Partial<LabelTemplate>): LabelTemplate {
  return {
    id: template.id,
    name: template.name,
    purpose: template.purpose,
    enabled: template.enabled,
    chzProductGroupCodes: template.chzProductGroupCodes,
    stock: template.stock,
    spec: { widthMm: 999, heightMm: 999, dpi: 600, language: "tspl", elements: [] },
    rev: template.rev + 1,
    ...data,
  };
}

/** Two passes of the scheduler: an effect that would read again has run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("office label templates: switching on and off", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("lets both office roles switch templates, each button named after its template", async () => {
    for (const user of [TECHNOLOGIST, { ...TECHNOLOGIST, role: "admin" as const }]) {
      const view = renderOffice(session(TEMPLATES, user));
      fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
      expect(
        await screen.findByRole("button", { name: "Выключить шаблон «Коробка 58×40»" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Включить шаблон «Вода и молоко»" })).toBeTruthy();
      view.unmount();
    }
  });

  it("switches a template off after asking, sending only the flag with the opened row's revision, and shows the answer in the row without reading the list again", async () => {
    const fake = session();
    fake.api.updateTemplate.mockResolvedValue(answer(MILK, { enabled: false }));
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
    expect(screen.getByRole("dialog", { name: "Выключить шаблон?" })).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "Шаблон «Молоко 58×40» перестанет предлагаться для товаров и умолчаний, а станции получат изменение. Включить его снова можно здесь же.",
      ),
    ).toBeTruthy();
    const submit = within(dialog()).getByRole("button", { name: "Выключить" });
    // Switching off takes the template out of use: the destructive variant.
    expect(submit.classList.contains("mk-btn--destructive")).toBe(true);
    fireEvent.click(submit);
    expect(await screen.findByText("Шаблон «Молоко 58×40» выключен.")).toBeTruthy();
    expect(fake.api.updateTemplate.mock.calls).toStrictEqual([
      ["office-session-token", MILK.id, { enabled: false, expectedRev: 60 }],
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cells("Молоко 58×40").slice(0, 6)).toEqual([
      "Молоко 58×40",
      "Короб",
      "58 × 40 мм",
      "203 dpi",
      "Молочная продукция",
      "✕Выключен",
    ]);
    expect(screen.getByRole("button", { name: "Включить шаблон «Молоко 58×40»" })).toBeTruthy();
    await settle();
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(1);
  });

  it("keeps the cached list a list of summaries: the answer goes into its row, and its layout stays out", async () => {
    const fake = session();
    fake.api.updateTemplate.mockResolvedValue(answer(MILK, { enabled: false }));
    const queryClient = createOfficeQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <OfficeSessionProvider value={fake}>
          <MemoryRouter>
            <TemplatesPage />
          </MemoryRouter>
        </OfficeSessionProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    await screen.findByText("Шаблон «Молоко 58×40» выключен.");
    expect(queryClient.getQueryData(officeKeys.templates)).toStrictEqual(
      TEMPLATES.map((each) => (each.id === MILK.id ? { ...MILK, enabled: false, rev: 61 } : each)),
    );
  });

  it("switches a disabled template on after a light confirmation, and the notice goes when the next dialog opens", async () => {
    const fake = session();
    fake.api.updateTemplate.mockResolvedValue(answer(DRINKS, { enabled: true }));
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Включить шаблон «Вода и молоко»" }));
    expect(screen.getByRole("dialog", { name: "Включить шаблон?" })).toBeTruthy();
    expect(
      within(dialog()).getByText(
        "Шаблон «Вода и молоко» снова будет предлагаться для товаров и умолчаний, а станции получат изменение.",
      ),
    ).toBeTruthy();
    const submit = within(dialog()).getByRole("button", { name: "Включить" });
    expect(submit.classList.contains("mk-btn--primary")).toBe(true);
    fireEvent.click(submit);
    expect(await screen.findByText("Шаблон «Вода и молоко» включён.")).toBeTruthy();
    expect(fake.api.updateTemplate.mock.calls).toStrictEqual([
      ["office-session-token", DRINKS.id, { enabled: true, expectedRev: 60 }],
    ]);
    expect(within(rowOf("Вода и молоко")).getByText("Включён")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Коробка 58×40»" }));
    expect(screen.queryByText("Шаблон «Вода и молоко» включён.")).toBeNull();
  });

  it("explains why a default stays on: the organization's default and the categories by name or code, and where to choose another; the row stays as it was", async () => {
    const fake = session();
    fake.api.updateTemplate.mockRejectedValue(
      hostError("conflict", 409, {
        constraint: "template_is_default",
        organizationDefault: true,
        categoryDefaults: [8, 99],
      }),
    );
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Коробка 58×40»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    expect(
      await within(dialog()).findByText(
        "Шаблон выбран по умолчанию для организации. Шаблон выбран по умолчанию для категорий: Молочная продукция, Код 99. Сначала выберите другой шаблон на странице «Умолчания шаблонов».",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Выключить шаблон?" })).toBeTruthy();
    expect(within(rowOf("Коробка 58×40")).getByText("Включён")).toBeTruthy();
  });

  it("offers to load the templates again after a stale switch, closing the dialog", async () => {
    const fake = session();
    fake.api.updateTemplate.mockRejectedValue(hostError("stale_revision", 409, { currentRev: 61 }));
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    expect(
      await within(dialog()).findByText(
        "Данные изменились, пока вы их редактировали. Обновите их и повторите.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });

  it("explains any other failure by its code and takes it away when the next try starts", async () => {
    const fake = session();
    let release: (template: LabelTemplate) => void = () => undefined;
    fake.api.updateTemplate.mockRejectedValueOnce(hostError("internal", 500)).mockReturnValueOnce(
      new Promise<LabelTemplate>((resolve) => {
        release = resolve;
      }),
    );
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    expect(
      await within(dialog()).findByText("На хосте произошла ошибка. Повторите попытку."),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    await waitFor(() =>
      expect(screen.queryByText("На хосте произошла ошибка. Повторите попытку.")).toBeNull(),
    );
    await act(async () => {
      release(answer(MILK, { enabled: false }));
    });
    expect(await screen.findByText("Шаблон «Молоко 58×40» выключен.")).toBeTruthy();
  });

  it("sends one request for a double click, and «Отмена» closes the dialog without one", async () => {
    const fake = session();
    let release: (template: LabelTemplate) => void = () => undefined;
    fake.api.updateTemplate.mockReturnValue(
      new Promise<LabelTemplate>((resolve) => {
        release = resolve;
      }),
    );
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Коробка 100×100»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.api.updateTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
    const submit = within(dialog()).getByRole("button", { name: "Выключить" });
    // Both clicks in one `act`: only the dialog's own guard drops the second.
    act(() => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    await waitFor(() => expect(submit).toHaveProperty("disabled", true));
    expect(fake.api.updateTemplate).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(answer(MILK, { enabled: false }));
    });
    expect(await screen.findByText("Шаблон «Молоко 58×40» выключен.")).toBeTruthy();
    expect(fake.api.updateTemplate).toHaveBeenCalledTimes(1);
  });

  // Beyond the plan: each test below kills a mutant the plan's tests let through.

  it("keeps what was typed and picked in the search and both filters through a failed reload and its retry", async () => {
    const fake = session();
    fake.api.updateTemplate.mockRejectedValue(hostError("stale_revision", 409, { currentRev: 61 }));
    await openTemplates(fake);
    fireEvent.change(screen.getByLabelText("Поиск"), { target: { value: "58×40" } });
    fireEvent.change(screen.getByLabelText("Назначение"), { target: { value: "box" } });
    fireEvent.change(screen.getByLabelText("Состояние"), { target: { value: "enabled" } });
    expect(names()).toEqual(["Коробка 58×40", "Молоко 58×40"]);
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    await within(dialog()).findByText(
      "Данные изменились, пока вы их редактировали. Обновите их и повторите.",
    );
    // The reload fails once: the error takes the place of the filters and the table.
    fake.api.listTemplates.mockRejectedValueOnce(down());
    fireEvent.click(screen.getByRole("button", { name: "Загрузить заново" }));
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    expect(screen.queryByLabelText("Поиск")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(screen.queryByText(UNREACHABLE)).toBeNull());
    await waitFor(() => expect(names()).toEqual(["Коробка 58×40", "Молоко 58×40"]));
    expect(screen.getByLabelText("Поиск")).toHaveProperty("value", "58×40");
    expect(screen.getByLabelText("Назначение")).toHaveProperty("value", "box");
    expect(screen.getByLabelText("Состояние")).toHaveProperty("value", "enabled");
    expect(screen.getByText("Найдено: 2 из 7")).toBeTruthy();
  });

  it("says the action in each button's own text, which its accessible name starts with, as a compact secondary button", async () => {
    await openTemplates(session());
    for (const [name, label] of [
      ["Коробка 58×40", "Выключить"],
      ["Вода и молоко", "Включить"],
    ] as const) {
      // The row has a second button, «Категории»: the state button is the one whose name starts with its text.
      const button = within(rowOf(name)).getByRole("button", { name: new RegExp(`^${label}`) });
      expect(button.textContent).toBe(label);
      expect(button.getAttribute("aria-label")).toBe(`${label} шаблон «${name}»`);
      // A screen has one primary action, and a row's button is not it.
      expect(button.classList.contains("mk-btn--secondary")).toBe(true);
      expect(button.classList.contains("mk-btn--compact")).toBe(true);
    }
  });

  it("sends the revision of the row as it was opened, even when the list is read again under the dialog", async () => {
    const fake = session();
    fake.api.updateTemplate.mockRejectedValue(hostError("stale_revision", 409, { currentRev: 61 }));
    const queryClient = createOfficeQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <OfficeSessionProvider value={fake}>
          <MemoryRouter>
            <TemplatesPage />
          </MemoryRouter>
        </OfficeSessionProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Выключить шаблон «Молоко 58×40»" }));
    // Someone else narrowed the template to two categories (revision 61), and the list is read again while the dialog is open.
    fake.api.listTemplates.mockResolvedValueOnce(
      TEMPLATES.map((each) =>
        each.id === MILK.id ? { ...MILK, chzProductGroupCodes: [8, 13], rev: 61 } : each,
      ),
    );
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: officeKeys.templates });
    });
    // The page has taken the new row in; the dialog keeps the one it was opened with.
    expect(await screen.findByText("Категорий: 2")).toBeTruthy();
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(2);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    expect(
      await within(dialog()).findByText(
        "Данные изменились, пока вы их редактировали. Обновите их и повторите.",
      ),
    ).toBeTruthy();
    expect(fake.api.updateTemplate.mock.calls).toStrictEqual([
      ["office-session-token", MILK.id, { enabled: false, expectedRev: 60 }],
    ]);
  });

  it("shows the notice as a success and the explanation of a default as an error", async () => {
    const fake = session();
    fake.api.updateTemplate
      .mockRejectedValueOnce(
        hostError("conflict", 409, {
          constraint: "template_is_default",
          organizationDefault: true,
          categoryDefaults: [],
        }),
      )
      .mockResolvedValueOnce(answer(BOX_58, { enabled: false }));
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Выключить шаблон «Коробка 58×40»" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    const refusal = await within(dialog()).findByText(
      "Шаблон выбран по умолчанию для организации. Сначала выберите другой шаблон на странице «Умолчания шаблонов».",
    );
    expect(refusal.closest(".mk-alert")?.classList.contains("mk-alert--error")).toBe(true);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    const notice = await screen.findByText("Шаблон «Коробка 58×40» выключен.");
    expect(notice.closest(".mk-alert")?.classList.contains("mk-alert--ok")).toBe(true);
  });

  it("shows a name with markup characters as plain text in the button's name, the dialog, the explanation of a default and the notice", async () => {
    // `t()` does not escape what it interpolates (`escapeValue: false`): a name is shown as a React child or an attribute, never as HTML.
    const name = '<b>Тест</b> & "кавычки"';
    const group = '<i>Группа</i> & "x"';
    const odd = summary("3c7e0b8a-5d9f-4e1a-8b2c-7d8e9f0a1b2c", name, {
      chzProductGroupCodes: [21],
    });
    const fake = session([odd]);
    fake.api.listProductGroups.mockResolvedValue([
      ...GROUPS,
      { code: 21, alias: "odd", name: group },
    ]);
    fake.api.updateTemplate
      .mockRejectedValueOnce(
        hostError("conflict", 409, {
          constraint: "template_is_default",
          organizationDefault: false,
          categoryDefaults: [21],
        }),
      )
      .mockResolvedValueOnce(answer(odd, { enabled: false }));
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: `Выключить шаблон «${name}»` }));
    expect(
      within(dialog()).getByText(
        `Шаблон «${name}» перестанет предлагаться для товаров и умолчаний, а станции получат изменение. Включить его снова можно здесь же.`,
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    expect(
      await within(dialog()).findByText(
        `Шаблон выбран по умолчанию для категорий: ${group}. Сначала выберите другой шаблон на странице «Умолчания шаблонов».`,
      ),
    ).toBeTruthy();
    expect(dialog().querySelector("b, i")).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    const notice = await screen.findByText(`Шаблон «${name}» выключен.`);
    expect(notice.closest(".mk-alert")?.querySelector("b, i")).toBeNull();
  });
});

describe("office label templates: categories", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  /**
   * Opens the templates page, then a template's «Категории» dialog, and asserts
   * the dialog is there. It does not wait for the group lookup: a test that
   * reads a group's checkbox right after relies on `openTemplates` having
   * returned after the groups loaded.
   */
  async function openCategories(fake: FakeOfficeSession, name: string): Promise<void> {
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: `Категории шаблона «${name}»` }));
    expect(screen.getByRole("dialog", { name: `Категории шаблона «${name}»` })).toBeTruthy();
  }

  function save(): HTMLElement {
    return within(dialog()).getByRole("button", { name: "Сохранить" });
  }

  it("narrows a template to the chosen categories: the codes go ascending with the opened row's revision, and the row counts them", async () => {
    const fake = session();
    fake.api.updateTemplate.mockResolvedValue(answer(BOX_100, { chzProductGroupCodes: [8, 13] }));
    await openCategories(fake, "Коробка 100×100");
    expect(
      within(dialog()).getByText(
        "Шаблон будет предлагаться только товарам выбранных категорий. Умолчанием организации может быть только шаблон для всех категорий.",
      ),
    ).toBeTruthy();
    expect(save()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("radio", { name: "Только выбранные" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Упакованная вода" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Молочная продукция" }));
    fireEvent.click(save());
    expect(await screen.findByText("Категории шаблона «Коробка 100×100» сохранены.")).toBeTruthy();
    expect(fake.api.updateTemplate.mock.calls).toStrictEqual([
      ["office-session-token", BOX_100.id, { chzProductGroupCodes: [8, 13], expectedRev: 60 }],
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    const scope = within(rowOf("Коробка 100×100")).getByText("Категорий: 2");
    expect(scope.getAttribute("title")).toBe("Молочная продукция, Упакованная вода");
    expect(cells("Коробка 100×100")[2]).toBe("100 × 100 мм");
    await settle();
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(1);
  });

  it("widens a template to every category with null", async () => {
    const fake = session();
    fake.api.updateTemplate.mockResolvedValue(answer(MILK, { chzProductGroupCodes: null }));
    await openCategories(fake, "Молоко 58×40");
    fireEvent.click(screen.getByRole("radio", { name: "Все категории" }));
    fireEvent.click(save());
    expect(await screen.findByText("Категории шаблона «Молоко 58×40» сохранены.")).toBeTruthy();
    expect(fake.api.updateTemplate.mock.calls).toStrictEqual([
      ["office-session-token", MILK.id, { chzProductGroupCodes: null, expectedRev: 60 }],
    ]);
    expect(within(rowOf("Молоко 58×40")).getByText("Все категории")).toBeTruthy();
  });

  it("shows a category the lookup lacks as «Код 99» in the dialog, and takes it off the template when unticked", async () => {
    const fake = session();
    fake.api.updateTemplate.mockResolvedValue(answer(DRINKS, { chzProductGroupCodes: [8, 13] }));
    await openCategories(fake, "Вода и молоко");
    const unnamed = await screen.findByRole("checkbox", { name: "Код 99" });
    expect(unnamed.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Выбрано: 3")).toBeTruthy();
    fireEvent.click(unnamed);
    expect(screen.queryByRole("checkbox", { name: "Код 99" })).toBeNull();
    fireEvent.click(save());
    expect(await screen.findByText("Категории шаблона «Вода и молоко» сохранены.")).toBeTruthy();
    expect(fake.api.updateTemplate.mock.calls).toStrictEqual([
      [
        "office-session-token",
        DRINKS.id,
        { chzProductGroupCodes: [8, 13], expectedRev: DRINKS.rev },
      ],
    ]);
  });

  it("asks for at least one category before sending, and keeps «Сохранить» off while the categories are the row's in any order", async () => {
    const reversed = summary("3c7e0b8a-5d9f-4e1a-8b2c-7d8e9f0a1b2c", "Обратный порядок", {
      chzProductGroupCodes: [13, 8],
    });
    const fake = session([...TEMPLATES, reversed]);
    fake.api.updateTemplate.mockResolvedValue(answer(reversed, { chzProductGroupCodes: [13] }));
    await openCategories(fake, "Обратный порядок");
    await screen.findByRole("checkbox", { name: "Молочная продукция" });
    // The same categories in another order are no change: nothing would be sent.
    expect(save()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Молочная продукция" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Упакованная вода" }));
    expect(save()).toHaveProperty("disabled", false);
    fireEvent.click(save());
    const message = await screen.findByText(
      "Выберите хотя бы одну категорию или переключитесь на «Все категории».",
    );
    expect(
      screen.getByRole("radiogroup", { name: "Категории" }).getAttribute("aria-describedby"),
    ).toBe(message.id);
    expect(fake.api.updateTemplate).not.toHaveBeenCalled();
    // A change of the categories takes the message away; the back-sorted list goes ascending.
    fireEvent.click(screen.getByRole("checkbox", { name: "Упакованная вода" }));
    expect(
      screen.queryByText("Выберите хотя бы одну категорию или переключитесь на «Все категории»."),
    ).toBeNull();
    fireEvent.click(save());
    await waitFor(() => expect(fake.api.updateTemplate).toHaveBeenCalledTimes(1));
    expect(fake.api.updateTemplate.mock.calls[0]?.[2]).toStrictEqual({
      chzProductGroupCodes: [13],
      expectedRev: 60,
    });
  });

  it("explains a refused narrowing of a default: the categories by name, and where to choose another", async () => {
    const fake = session();
    fake.api.updateTemplate.mockRejectedValue(
      hostError("conflict", 409, {
        constraint: "template_is_default",
        organizationDefault: false,
        categoryDefaults: [8],
      }),
    );
    await openCategories(fake, "Коробка 58×40");
    fireEvent.click(screen.getByRole("radio", { name: "Только выбранные" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Упакованная вода" }));
    fireEvent.click(save());
    expect(
      await within(dialog()).findByText(
        "Шаблон выбран по умолчанию для категорий: Молочная продукция. Сначала выберите другой шаблон на странице «Умолчания шаблонов».",
      ),
    ).toBeTruthy();
    expect(within(rowOf("Коробка 58×40")).getByText("Все категории")).toBeTruthy();
  });

  it("offers to load the templates again after a stale change of the categories, closing the dialog", async () => {
    const fake = session();
    fake.api.updateTemplate.mockRejectedValue(hostError("stale_revision", 409, { currentRev: 61 }));
    await openCategories(fake, "Молоко 58×40");
    fireEvent.click(screen.getByRole("radio", { name: "Все категории" }));
    fireEvent.click(save());
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });

  // Beyond the plan: each test below kills a mutant the plan's tests let through.

  it("lets both office roles open «Категории» from the button named after the «Коробка 58×40» template", async () => {
    for (const user of [TECHNOLOGIST, { ...TECHNOLOGIST, role: "admin" as const }]) {
      const view = renderOffice(session(TEMPLATES, user));
      fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Категории шаблона «Коробка 58×40»" }),
      );
      expect(
        screen.getByRole("dialog", { name: "Категории шаблона «Коробка 58×40»" }),
      ).toBeTruthy();
      view.unmount();
    }
  });

  it("puts a row's two actions in one box, the switch first and «Категории» second, each a compact secondary button named after its template", async () => {
    await openTemplates(session());
    for (const [name, label] of [
      ["Коробка 58×40", "Выключить"],
      ["Вода и молоко", "Включить"],
    ] as const) {
      const buttons = within(rowOf(name)).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual([label, "Категории"]);
      expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
        `${label} шаблон «${name}»`,
        `Категории шаблона «${name}»`,
      ]);
      expect(buttons[0]?.parentElement).toBe(buttons[1]?.parentElement);
      for (const button of buttons) {
        expect(button.parentElement?.classList.contains("mk-row-actions")).toBe(true);
        expect(button.classList.contains("mk-btn--secondary")).toBe(true);
        expect(button.classList.contains("mk-btn--compact")).toBe(true);
      }
    }
  });

  it("closes the dialog with «Отмена» without a request or a notice, and the next opening starts from the row's categories", async () => {
    const fake = session();
    await openCategories(fake, "Молоко 58×40");
    fireEvent.click(screen.getByRole("radio", { name: "Все категории" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.api.updateTemplate).not.toHaveBeenCalled();
    expect(screen.queryByText("Категории шаблона «Молоко 58×40» сохранены.")).toBeNull();
    expect(within(rowOf("Молоко 58×40")).getByText("Молочная продукция")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Категории шаблона «Молоко 58×40»" }));
    expect(
      screen.getByRole("radio", { name: "Только выбранные" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(save()).toHaveProperty("disabled", true);
  });

  it("sends the revision and compares the categories of the row as it was opened, even when the list is read again under the dialog", async () => {
    const fake = session();
    fake.api.updateTemplate.mockRejectedValue(hostError("stale_revision", 409, { currentRev: 61 }));
    const queryClient = createOfficeQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <OfficeSessionProvider value={fake}>
          <MemoryRouter>
            <TemplatesPage />
          </MemoryRouter>
        </OfficeSessionProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Категории шаблона «Молоко 58×40»" }),
    );
    // Someone else narrowed the template to two categories (revision 61), and the list is read again while the dialog is open.
    fake.api.listTemplates.mockResolvedValueOnce(
      TEMPLATES.map((each) =>
        each.id === MILK.id ? { ...MILK, chzProductGroupCodes: [8, 13], rev: 61 } : each,
      ),
    );
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: officeKeys.templates });
    });
    // The page has taken the new row in; the dialog keeps the one it was opened with.
    expect(await screen.findByText("Категорий: 2")).toBeTruthy();
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(2);
    expect(save()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("radio", { name: "Все категории" }));
    fireEvent.click(save());
    expect(
      await within(dialog()).findByText(
        "Данные изменились, пока вы их редактировали. Обновите их и повторите.",
      ),
    ).toBeTruthy();
    expect(fake.api.updateTemplate.mock.calls).toStrictEqual([
      ["office-session-token", MILK.id, { chzProductGroupCodes: null, expectedRev: 60 }],
    ]);
  });

  it("takes the explanation of a failed try away when the next try starts, and asks for a category instead", async () => {
    const fake = session();
    fake.api.updateTemplate.mockRejectedValueOnce(hostError("internal", 500));
    await openCategories(fake, "Коробка 58×40");
    fireEvent.click(screen.getByRole("radio", { name: "Только выбранные" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Упакованная вода" }));
    fireEvent.click(save());
    expect(
      await within(dialog()).findByText("На хосте произошла ошибка. Повторите попытку."),
    ).toBeTruthy();
    // The next try has no category: the host's failure goes, the dialog's own question stays, and nothing is sent.
    fireEvent.click(screen.getByRole("checkbox", { name: "Упакованная вода" }));
    fireEvent.click(save());
    expect(
      await within(dialog()).findByText(
        "Выберите хотя бы одну категорию или переключитесь на «Все категории».",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("На хосте произошла ошибка. Повторите попытку.")).toBeNull();
    expect(fake.api.updateTemplate).toHaveBeenCalledTimes(1);
  });

  it("shows a name with markup characters as plain text in the button's name, the dialog's title, the groups to choose from and the notice", async () => {
    // `t()` does not escape what it interpolates (`escapeValue: false`): a name is shown as a React child or an attribute, never as HTML.
    const name = '<b>Тест</b> & "кавычки"';
    const group = '<i>Группа</i> & "x"';
    const odd = summary("3c7e0b8a-5d9f-4e1a-8b2c-7d8e9f0a1b2c", name, {
      chzProductGroupCodes: [21],
    });
    const fake = session([odd]);
    fake.api.listProductGroups.mockResolvedValue([
      ...GROUPS,
      { code: 21, alias: "odd", name: group },
    ]);
    fake.api.updateTemplate.mockResolvedValue(answer(odd, { chzProductGroupCodes: [8, 21] }));
    // `openCategories` finds the button, and the dialog, by the name as plain text.
    await openCategories(fake, name);
    expect(dialog().querySelector("b, i")).toBeNull();
    expect(
      within(dialog()).getByRole("checkbox", { name: group }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "Молочная продукция" }));
    fireEvent.click(save());
    const notice = await screen.findByText(`Категории шаблона «${name}» сохранены.`);
    expect(notice.closest(".mk-alert")?.querySelector("b, i")).toBeNull();
  });
});
