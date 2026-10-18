import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { ProductGroup } from "../src/host/protocol.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import {
  sameCategories,
  scopeCodes,
  scopeOf,
  visibleGroups,
  type CategoryScope,
} from "../src/office/templates/category-scope.js";
import { CategoryScopeField } from "../src/office/templates/CategoryScopeField.js";
import { fakeOfficeSession, type FakeOfficeSession } from "./support/office.js";

const GROUPS: ProductGroup[] = [
  { code: 13, alias: "water", name: "Упакованная вода" },
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 3, alias: "tobacco", name: "Альтернативная табачная продукция" },
];

function session(): FakeOfficeSession {
  const fake = fakeOfficeSession();
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  return fake;
}

/** The field as a form holds it; `changes` records every value it reports. */
function renderField(fake: FakeOfficeSession, initial: CategoryScope, error?: string) {
  const changes: CategoryScope[] = [];
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <CategoryScopeField
        value={value}
        onChange={(next) => {
          changes.push(next);
          setValue(next);
        }}
        {...(error === undefined ? {} : { error })}
      />
    );
  }
  render(
    <QueryClientProvider client={createOfficeQueryClient()}>
      <OfficeSessionProvider value={fake}>
        <Harness />
      </OfficeSessionProvider>
    </QueryClientProvider>,
  );
  return changes;
}

/** The groups the list offers, top to bottom, and whether each is checked. */
function offered(): [string | null, string | null][] {
  return within(screen.getByRole("group", { name: "Категории на выбор" }))
    .getAllByRole("checkbox")
    .map((box) => [
      document.getElementById(box.getAttribute("aria-labelledby") ?? "")?.textContent ?? null,
      box.getAttribute("aria-checked"),
    ]);
}

describe("the category scope of a template", () => {
  it("sends null for every category and the chosen codes ascending, and compares categories in any order", () => {
    expect(scopeOf(null)).toStrictEqual({ mode: "all", codes: [] });
    expect(scopeOf([13, 8])).toStrictEqual({ mode: "selected", codes: [13, 8] });
    expect(scopeCodes({ mode: "all", codes: [8] })).toBeNull();
    const codes = [13, 100, 8];
    expect(scopeCodes({ mode: "selected", codes })).toStrictEqual([8, 13, 100]);
    expect(codes).toStrictEqual([13, 100, 8]);
    expect(sameCategories(null, null)).toBe(true);
    expect(sameCategories([8, 13], [13, 8])).toBe(true);
    expect(sameCategories([8], [8, 13])).toBe(false);
    expect(sameCategories([8, 13], [8, 15])).toBe(false);
    expect(sameCategories([], null)).toBe(false);
    expect(sameCategories(null, [8])).toBe(false);
  });

  it("finds groups by name without case and spaces around the search, by name in Russian order", () => {
    expect(visibleGroups(GROUPS, "").map((group) => group.code)).toStrictEqual([3, 8, 13]);
    expect(visibleGroups(GROUPS, "  ПРОДУКЦ ").map((group) => group.code)).toStrictEqual([3, 8]);
    expect(visibleGroups(GROUPS, "кефир")).toStrictEqual([]);
  });

  it("offers every category or only the chosen ones, and lists the groups by name only for the chosen ones", async () => {
    const changes = renderField(session(), scopeOf(null));
    expect(screen.getByRole("radiogroup", { name: "Категории" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Все категории" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.queryByRole("group", { name: "Категории на выбор" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Только выбранные" }));
    expect(changes).toStrictEqual([{ mode: "selected", codes: [] }]);
    await screen.findByRole("group", { name: "Категории на выбор" });
    expect(offered()).toStrictEqual([
      ["Альтернативная табачная продукция", "false"],
      ["Молочная продукция", "false"],
      ["Упакованная вода", "false"],
    ]);
    expect(screen.getByText("Выбрано: 0").getAttribute("aria-live")).toBe("polite");
  });

  it("checks the template's categories, adds and takes away codes, and counts them", async () => {
    const changes = renderField(session(), scopeOf([13]));
    await screen.findByRole("group", { name: "Категории на выбор" });
    expect(offered()).toStrictEqual([
      ["Альтернативная табачная продукция", "false"],
      ["Молочная продукция", "false"],
      ["Упакованная вода", "true"],
    ]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Молочная продукция" }));
    expect(changes.at(-1)).toStrictEqual({ mode: "selected", codes: [13, 8] });
    expect(screen.getByText("Выбрано: 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Упакованная вода" }));
    expect(changes.at(-1)).toStrictEqual({ mode: "selected", codes: [8] });
    expect(screen.getByText("Выбрано: 1")).toBeTruthy();
  });

  it("searches the list, says when nothing matches, and a checked group the search hides stays chosen", async () => {
    const changes = renderField(session(), scopeOf([13]));
    await screen.findByRole("group", { name: "Категории на выбор" });
    const search = screen.getByLabelText("Поиск категории");
    fireEvent.change(search, { target: { value: " МОЛОЧ " } });
    expect(offered()).toStrictEqual([["Молочная продукция", "false"]]);
    fireEvent.change(search, { target: { value: "кефир" } });
    expect(screen.getByText("Категорий с таким названием нет.")).toBeTruthy();
    expect(screen.getByText("Выбрано: 1")).toBeTruthy();
    expect(changes).toStrictEqual([]);
  });

  it("keeps the chosen codes while every category is chosen, so switching back brings them back", async () => {
    const changes = renderField(session(), scopeOf([8]));
    await screen.findByRole("group", { name: "Категории на выбор" });
    fireEvent.click(screen.getByRole("radio", { name: "Все категории" }));
    expect(changes.at(-1)).toStrictEqual({ mode: "all", codes: [8] });
    expect(screen.queryByRole("group", { name: "Категории на выбор" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Только выбранные" }));
    expect(changes.at(-1)).toStrictEqual({ mode: "selected", codes: [8] });
    expect(
      screen.getByRole("checkbox", { name: "Молочная продукция" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("says why it lists nothing while the groups load or when they fail, keeps the codes, and loads them again", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    const changes = renderField(fake, scopeOf([8]));
    expect(screen.getByText("Загружаем справочник категорий…")).toBeTruthy();
    expect(
      await screen.findByText(
        "Справочник категорий не загрузился: выбрать категории сейчас нельзя.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Выбрано: 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByRole("group", { name: "Категории на выбор" });
    expect(
      screen.getByRole("checkbox", { name: "Молочная продукция" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(changes).toStrictEqual([]);
  });

  it("shows an error under the choice and ties it to the radio group", async () => {
    renderField(session(), scopeOf([]), "Выберите хотя бы одну категорию");
    const message = screen.getByText("Выберите хотя бы одну категорию");
    const choice = screen.getByRole("radiogroup", { name: "Категории" });
    expect(choice.getAttribute("aria-describedby")).toBe(message.id);
    expect(choice.getAttribute("aria-invalid")).toBe("true");
    await screen.findByRole("group", { name: "Категории на выбор" });
  });

  // Beyond the plan: each test below kills a mutant the plan's tests let through.

  it("orders the groups by name in Russian order with numbers by value, whatever their codes", () => {
    // The names run against the codes, and against the code points («Ёж» is U+0401, before every capital А).
    const groups: ProductGroup[] = [
      { code: 40, alias: "ten", name: "Группа 10" },
      { code: 20, alias: "nine", name: "Группа 9" },
      { code: 10, alias: "hedgehog", name: "Ёж" },
      { code: 30, alias: "spruce", name: "Елка" },
      { code: 50, alias: "beetle", name: "Жук" },
    ];
    expect(visibleGroups(groups, "").map((group) => group.name)).toStrictEqual([
      "Группа 9",
      "Группа 10",
      "Ёж",
      "Елка",
      "Жук",
    ]);
    expect(visibleGroups(groups, "группа").map((group) => group.code)).toStrictEqual([20, 40]);
  });

  it("lists «Все категории» before «Только выбранные» and checks the one the value names", async () => {
    renderField(session(), scopeOf([13]));
    await screen.findByRole("group", { name: "Категории на выбор" });
    const choices = () =>
      within(screen.getByRole("radiogroup", { name: "Категории" }))
        .getAllByRole("radio")
        .map((radio) => [
          document.getElementById(radio.getAttribute("aria-labelledby") ?? "")?.textContent ?? null,
          radio.getAttribute("aria-checked"),
        ]);
    expect(choices()).toStrictEqual([
      ["Все категории", "false"],
      ["Только выбранные", "true"],
    ]);
    fireEvent.click(screen.getByRole("radio", { name: "Все категории" }));
    expect(choices()).toStrictEqual([
      ["Все категории", "true"],
      ["Только выбранные", "false"],
    ]);
  });

  it("says a failed lookup as an error with a compact secondary «Повторить», and brings the list back without the failure or the loading note", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    renderField(fake, scopeOf([8]));
    const failed = await screen.findByText(
      "Справочник категорий не загрузился: выбрать категории сейчас нельзя.",
    );
    expect(failed.closest(".mk-alert")?.classList.contains("mk-alert--error")).toBe(true);
    const retry = screen.getByRole("button", { name: "Повторить" });
    expect(retry.classList.contains("mk-btn--secondary")).toBe(true);
    expect(retry.classList.contains("mk-btn--compact")).toBe(true);
    expect(screen.queryByText("Загружаем справочник категорий…")).toBeNull();
    expect(screen.queryByLabelText("Поиск категории")).toBeNull();
    expect(screen.queryByRole("group", { name: "Категории на выбор" })).toBeNull();
    fireEvent.click(retry);
    await screen.findByRole("group", { name: "Категории на выбор" });
    expect(
      screen.queryByText("Справочник категорий не загрузился: выбрать категории сейчас нельзя."),
    ).toBeNull();
    expect(screen.queryByText("Загружаем справочник категорий…")).toBeNull();
  });

  it("keeps the search as it was typed, spaces and case included, and brings the whole list back when it is cleared", async () => {
    renderField(session(), scopeOf([]));
    await screen.findByRole("group", { name: "Категории на выбор" });
    const search = screen.getByLabelText("Поиск категории");
    fireEvent.change(search, { target: { value: " ВОДА " } });
    expect(search).toHaveProperty("value", " ВОДА ");
    expect(offered()).toStrictEqual([["Упакованная вода", "false"]]);
    fireEvent.change(search, { target: { value: "" } });
    expect(offered()).toHaveLength(3);
  });

  it("keeps the field and its list in the boxes the stylesheet lays out", async () => {
    renderField(session(), scopeOf([13]));
    const list = await screen.findByRole("group", { name: "Категории на выбор" });
    expect(list.classList.contains("category-scope__list")).toBe(true);
    // The choice, the count and the search sit in the one box that holds the list.
    const field = list.closest(".category-scope");
    expect(field).not.toBeNull();
    expect(field?.contains(screen.getByRole("radiogroup", { name: "Категории" }))).toBe(true);
    expect(field?.contains(screen.getByText("Выбрано: 1"))).toBe(true);
    expect(field?.contains(screen.getByLabelText("Поиск категории"))).toBe(true);
  });

  it("cancels Enter in the search box so the form around the field is never submitted, and leaves other keys alone", async () => {
    // A dialog's form has «Сохранить» for its only submit button, so the browser would take
    // Enter in the search box as a click on it and save a half-made choice. jsdom does no
    // implicit submission; `fireEvent` returns false when a handler cancelled the default.
    renderField(session(), scopeOf([13]));
    await screen.findByRole("group", { name: "Категории на выбор" });
    const search = screen.getByLabelText("Поиск категории");
    expect(fireEvent.keyDown(search, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(search, { key: "a" })).toBe(true);
  });

  it("lists a code the lookup lacks after the named groups, in code order, shows it with the search empty, finds it by its text, and takes it away when unchecked", async () => {
    const changes = renderField(session(), scopeOf([120, 8, 99]));
    await screen.findByRole("group", { name: "Категории на выбор" });
    expect(offered()).toStrictEqual([
      ["Альтернативная табачная продукция", "false"],
      ["Молочная продукция", "true"],
      ["Упакованная вода", "false"],
      ["Код 99", "true"],
      ["Код 120", "true"],
    ]);
    expect(screen.getByText("Выбрано: 3")).toBeTruthy();
    const search = screen.getByLabelText("Поиск категории");
    fireEvent.change(search, { target: { value: " КОД 9 " } });
    expect(offered()).toStrictEqual([["Код 99", "true"]]);
    fireEvent.change(search, { target: { value: "молоч" } });
    expect(offered()).toStrictEqual([["Молочная продукция", "true"]]);
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Код 99" }));
    expect(changes.at(-1)).toStrictEqual({ mode: "selected", codes: [120, 8] });
    expect(screen.getByText("Выбрано: 2")).toBeTruthy();
    expect(offered().map(([name]) => name)).toStrictEqual([
      "Альтернативная табачная продукция",
      "Молочная продукция",
      "Упакованная вода",
      "Код 120",
    ]);
  });

  it("lists no code of its own when the lookup names every chosen group", async () => {
    renderField(session(), scopeOf([8, 13]));
    await screen.findByRole("group", { name: "Категории на выбор" });
    expect(offered().map(([name]) => name)).toStrictEqual([
      "Альтернативная табачная продукция",
      "Молочная продукция",
      "Упакованная вода",
    ]);
  });

  it("moves focus to the search box when the retried lookup brings the list back, so Escape and Tab stay in the dialog", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    renderField(fake, scopeOf([8]));
    const retry = await screen.findByRole("button", { name: "Повторить" });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    await screen.findByRole("group", { name: "Категории на выбор" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Поиск категории")),
    );
  });

  it("does not move focus when the list loads without a retry", async () => {
    renderField(session(), scopeOf([8]));
    await screen.findByRole("group", { name: "Категории на выбор" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(document.activeElement).toBe(document.body);
  });
});
