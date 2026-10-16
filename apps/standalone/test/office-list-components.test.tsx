import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { DateRange } from "../src/office/list/ListCard.js";
import { ListEmpty, ListError, ListNothing, ListSkeleton } from "../src/office/list/ListStates.js";
import { RowActionBar, type RowMenuItem } from "../src/office/list/RowActionBar.js";
import { Segmented } from "../src/office/list/Segmented.js";
import { StateFilter } from "../src/office/list/StateFilter.js";
import { HostError } from "../src/host/client.js";

const OPTIONS = [
  { id: "a", label: "Первый" },
  { id: "b", label: "Второй" },
  { id: "c", label: "Третий" },
] as const;

function Controlled({ mode, start }: { mode?: "choice" | "tabs"; start: "a" | "b" | "c" | null }) {
  const [value, setValue] = useState<"a" | "b" | "c" | null>(start);
  return (
    <Segmented
      label="Раздел"
      value={value}
      options={OPTIONS}
      onChange={setValue}
      {...(mode === undefined ? {} : { mode })}
    />
  );
}

describe("Segmented", () => {
  it("is a radio group of choices: the selected one is checked, carries a check mark and is the only tab stop", () => {
    render(<Controlled start="b" />);
    const group = screen.getByRole("radiogroup", { name: "Раздел" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
    // The selected state is a fill and a glyph, not colour alone.
    expect(radios[1]?.querySelector("svg")).not.toBeNull();
    expect(radios[0]?.querySelector("svg")).toBeNull();
    expect(radios[1]?.className).toContain("office-segmented__item--selected");
  });

  it("is a tab list when it names the parts of a page", () => {
    render(<Controlled mode="tabs" start="a" />);
    const tabs = within(screen.getByRole("tablist", { name: "Раздел" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
  });

  it("moves with the arrows, Home and End, wraps, and selects what it moves to", () => {
    render(<Controlled start="a" />);
    const radio = (name: string) => screen.getByRole("radio", { name });
    radio("Первый").focus();
    fireEvent.keyDown(radio("Первый"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(radio("Второй"));
    expect(radio("Второй").getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radio("Второй"), { key: "End" });
    expect(radio("Третий").getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radio("Третий"), { key: "ArrowRight" });
    expect(radio("Первый").getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radio("Первый"), { key: "ArrowLeft" });
    expect(radio("Третий").getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radio("Третий"), { key: "Home" });
    expect(radio("Первый").getAttribute("aria-checked")).toBe("true");
  });

  it("makes the first option the tab stop while none is selected (a custom period)", () => {
    render(<Controlled start={null} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "false",
    ]);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
  });

  it("reports a click", () => {
    const onChange = vi.fn();
    render(<Segmented label="Раздел" value="a" options={OPTIONS} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Третий" }));
    expect(onChange).toHaveBeenCalledWith("c");
  });
});

describe("StateFilter: segments up to three values, a select from four", () => {
  const three = [
    { value: "all", label: "Все" },
    { value: "on", label: "Включены" },
    { value: "off", label: "Выключены" },
  ] as const;

  it("draws three values as segments under the filter's name", () => {
    render(
      <StateFilter label="Состояние" options={three} value="all" onChange={() => undefined} />,
    );
    expect(screen.getByRole("radiogroup", { name: "Состояние" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("draws four values as a select", () => {
    render(
      <StateFilter
        label="Состояние"
        options={[...three, { value: "x", label: "Прочие" }]}
        value="all"
        onChange={() => undefined}
      />,
    );
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Состояние" })).toBeTruthy();
  });
});

describe("RowActionBar", () => {
  function bar(items: RowMenuItem[], onEdit = vi.fn()) {
    render(
      <div>
        <RowActionBar
          actions={[{ key: "edit", label: "Изменить X", icon: "pencil", onSelect: onEdit }]}
          menu={{ label: "Действия: X", items }}
        />
        <button type="button">После строки</button>
      </div>,
    );
    return screen.getByRole("button", { name: "Действия: X" });
  }
  const run = vi.fn();
  const items: RowMenuItem[] = [
    { key: "one", label: "Первое", onSelect: run },
    { key: "two", label: "Второе", onSelect: run, disabled: true },
    { key: "three", label: "Третье", onSelect: run },
    { key: "del", label: "Удалить", onSelect: run, destructive: true },
  ];

  it("gives each action a 40 px icon button named for the record, and the menu button the record's name too", () => {
    const trigger = bar(items);
    const edit = screen.getByRole("button", { name: "Изменить X" });
    expect(edit.textContent).toBe("");
    expect(edit.className).toContain("mk-icon-button");
    expect(edit.style.minHeight).toBe("var(--control-md)");
    expect(trigger.className).toContain("mk-icon-button");
  });

  it("opens on a click with the focus on the first entry, and skips a disabled one on the arrows", async () => {
    const trigger = bar(items);
    fireEvent.click(trigger);
    const entries = screen.getAllByRole("menuitem");
    await vi.waitFor(() => expect(document.activeElement).toBe(entries[0]));
    fireEvent.keyDown(entries[0] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(entries[2]);
    fireEvent.keyDown(entries[2] as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(entries[0]);
    fireEvent.keyDown(entries[0] as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(entries[3]);
  });

  it("sets the destructive entry apart by a rule", () => {
    fireEvent.click(bar(items));
    const menu = screen.getByRole("menu");
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(
      within(menu).getByRole("menuitem", { name: "Удалить" }).getAttribute("data-destructive"),
    ).toBe("true");
  });

  it("closes on Escape with the focus back on the button", () => {
    const trigger = bar(items);
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0] as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a press outside, and on Tab, without choosing anything", () => {
    run.mockClear();
    const trigger = bar(items);
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "После строки" }));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0] as HTMLElement, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("closes the menu and runs the entry on a choice", () => {
    run.mockClear();
    fireEvent.click(bar(items));
    fireEvent.click(screen.getByRole("menuitem", { name: "Третье" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("draws no menu button without entries", () => {
    render(<RowActionBar actions={[]} menu={{ label: "Действия: X", items: [] }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("runs an icon action on a click", () => {
    const onEdit = vi.fn();
    bar(items, onEdit);
    fireEvent.click(screen.getByRole("button", { name: "Изменить X" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});

describe("DateRange", () => {
  it("is one group on one line with the fields' full names and «с» / «по» in place of the empty dates", () => {
    const onFrom = vi.fn();
    render(
      <DateRange
        label="Дата производства"
        fromLabel="Дата производства с"
        toLabel="Дата производства по"
        from=""
        to=""
        onFrom={onFrom}
        onTo={() => undefined}
      />,
    );
    const group = screen.getByRole("group", { name: "Дата производства" });
    const from = within(group).getByRole("button", { name: "Дата производства с" });
    const to = within(group).getByRole("button", { name: "Дата производства по" });
    expect(from.textContent).toContain("с");
    expect(to.textContent).toContain("по");
    expect(group.querySelector(".office-range__row")?.children).toHaveLength(3);
  });

  it("shows a range error on the second date", () => {
    render(
      <DateRange
        label="Период"
        fromLabel="Период с"
        toLabel="Период по"
        from="2026-10-08"
        to="2026-10-01"
        onFrom={() => undefined}
        onTo={() => undefined}
        error="Период заканчивается раньше, чем начинается"
      />,
    );
    expect(screen.getByText("Период заканчивается раньше, чем начинается")).toBeTruthy();
  });
});

describe("the list states", () => {
  it("says the list is empty and offers its first record", () => {
    render(
      <ListEmpty
        title="Товаров пока нет."
        hint="Добавьте первый."
        action={<button type="button">Добавить</button>}
      />,
    );
    expect(screen.getByText("Товаров пока нет.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Добавить" })).toBeTruthy();
  });

  it("says nothing was found and clears the filters", () => {
    const onReset = vi.fn();
    render(<ListNothing onReset={onReset} />);
    expect(screen.getByText("Ничего не найдено.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить отбор" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("offers no reset when there is nothing to reset", () => {
    render(<ListNothing />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a loading mark once, in words, over static bars", () => {
    const { container } = render(<ListSkeleton rows={2} />);
    expect(screen.getAllByText("Загрузка…")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Загрузка…");
    expect(container.querySelectorAll(".office-skeleton__row")).toHaveLength(2);
    expect(container.querySelector(".office-skeleton")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows the failure in the host's words as an alert, with «Повторить»", async () => {
    const onRetry = vi.fn();
    render(
      <ListError
        error={new HostError({ kind: "transport", code: "unreachable", message: "x" })}
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Не удалось загрузить данные")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: "Повторить" }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
