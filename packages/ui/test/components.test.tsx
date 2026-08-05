import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import componentStyles from "virtual:ui-component-styles";

import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  IconButton,
  Input,
  RadioGroup,
  Select,
  StatusChip,
  Table,
} from "../src/components/index.js";

void (
  (
    // @ts-expect-error RadioGroup requires a visible label or an aria-label.
    <RadioGroup options={[{ value: "production", label: "Производство" }]} />
  )
);

afterEach(() => {
  cleanup();
});

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = componentStyles;
  document.head.append(style);

  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { value: () => false },
    setPointerCapture: { value: () => undefined },
    releasePointerCapture: { value: () => undefined },
    scrollIntoView: { value: () => undefined },
  });
});

describe("Button", () => {
  it("renders variant and size class hooks with the office control height style hook", () => {
    const { rerender } = render(
      <Button variant="primary" size="md">
        Save
      </Button>,
    );
    const primary = screen.getByRole("button", { name: "Save" });
    expect(primary.className).toContain("mk-btn--primary");
    expect(primary.className).toContain("mk-btn--md");
    expect(primary.style.height).toBe("var(--control-md)");

    rerender(
      <Button variant="secondary" size="compact">
        Cancel
      </Button>,
    );
    const secondary = screen.getByRole("button", { name: "Cancel" });
    expect(secondary.className).toContain("mk-btn--secondary");
    expect(secondary.className).toContain("mk-btn--compact");
    expect(secondary.style.height).toBe("var(--control-sm)");

    rerender(<Button variant="destructive">Delete</Button>);
    const destructive = screen.getByRole("button", { name: "Delete" });
    expect(destructive.className).toContain("mk-btn--destructive");
  });

  it("fires onClick when clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click me</Button>);

    await user.click(screen.getByRole("button", { name: "Click me" }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not fire onClick while loading", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} loading>
        Saving
      </Button>,
    );

    await user.click(screen.getByRole("button"));

    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("StatusChip", () => {
  it.each([
    ["ok", "OK"],
    ["error", "Error"],
    ["warn", "Duplicate"],
    ["info", "Syncing"],
    ["neutral", "Neutral"],
  ] as const)("renders an icon glyph and label text for status=%s", (status, label) => {
    render(<StatusChip status={status} />);

    const chip = screen.getByText(label).closest(".mk-chip");
    expect(chip).not.toBeNull();
    // icon glyph must be present alongside the label — never color alone
    expect(chip!.textContent!.length).toBeGreaterThan(label.length);
  });

  it("allows overriding the label text", () => {
    render(<StatusChip status="ok" label="Отправлено" />);
    expect(screen.getByText("Отправлено")).toBeDefined();
  });
});

describe("Field", () => {
  it("associates the label and error with the child input via aria-invalid/aria-describedby", () => {
    render(
      <Field label="GTIN" error="Введите 14 цифр">
        <input />
      </Field>,
    );

    const input = screen.getByLabelText("GTIN");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe("Введите 14 цифр");
  });

  it("wires hint text via aria-describedby when there is no error", () => {
    render(
      <Field label="Партия" hint="Например: 214">
        <input />
      </Field>,
    );

    const input = screen.getByLabelText("Партия");
    expect(input.getAttribute("aria-invalid")).not.toBe("true");

    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe("Например: 214");
  });
});

describe("Input", () => {
  it("renders the label and wires its own error via aria-invalid/aria-describedby", () => {
    render(<Input label="Количество" error="Больше остатка" />);

    const input = screen.getByLabelText("Количество");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby");
    expect(document.getElementById(describedBy!)?.textContent).toBe("Больше остатка");
  });

  it("supports mono styling for codes and quantities", () => {
    render(<Input label="GTIN" mono />);
    const input = screen.getByLabelText("GTIN");
    expect(input.style.fontFamily).toBe("var(--font-mono)");
  });
});

describe("Select", () => {
  it("shows the empty option label for an initial empty value", () => {
    render(
      <Select
        label="Линия"
        options={[
          { value: "", label: "Без линии" },
          { value: "line-1", label: "Линия 1" },
        ]}
        value=""
      />,
    );

    expect(screen.getByRole("combobox", { name: "Линия" }).textContent).toContain("Без линии");
  });

  it("shows the empty option label after clearing a selected value", async () => {
    const user = userEvent.setup();

    function SelectHarness() {
      const [value, setValue] = useState("line-1");

      return (
        <Select
          label="Линия"
          options={[
            { value: "", label: "Без линии" },
            { value: "line-1", label: "Линия 1" },
          ]}
          value={value}
          onValueChange={setValue}
        />
      );
    }

    render(<SelectHarness />);

    await user.click(screen.getByRole("combobox", { name: "Линия" }));
    await user.click(screen.getByRole("option", { name: "Без линии" }));

    expect(screen.getByRole("combobox", { name: "Линия" }).textContent).toContain("Без линии");
  });

  it("uses its public placeholder when no value is selected", () => {
    render(<Select label="Продукт" options={["Молоко"]} placeholder="Выберите продукт" />);

    expect(screen.getByRole("combobox", { name: "Продукт" }).textContent).toContain(
      "Выберите продукт",
    );
  });

  it("wires an error to the trigger and exposes the invalid state", () => {
    render(<Select label="Продукт" options={["Молоко"]} error="Выберите продукт" />);

    const trigger = screen.getByRole("combobox", { name: "Продукт" });
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Выберите продукт",
    );
  });

  it("opens a custom option overlay and calls onValueChange when an option is clicked", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Select
        label="Группа"
        options={["Пиво", "Вода"]}
        value="Пиво"
        onValueChange={onValueChange}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Группа" });
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeDefined();
    await user.click(screen.getByRole("option", { name: "Вода" }));

    expect(onValueChange).toHaveBeenCalledWith("Вода");
  });

  it("selects the next enabled option with ArrowDown and Enter", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Select
        label="Группа"
        options={["Пиво", "Вода"]}
        value="Пиво"
        onValueChange={onValueChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Группа" }));
    await user.keyboard("{ArrowDown}");
    const waterOption = screen.getByRole("option", { name: "Вода" });
    await waitFor(() => expect(document.activeElement).toBe(waterOption));
    await user.keyboard("{Enter}");

    expect(onValueChange).toHaveBeenCalledWith("Вода");
  });

  it("closes on Escape and returns focus to its trigger", async () => {
    const user = userEvent.setup();
    render(<Select label="Группа" options={["Пиво", "Вода"]} value="Пиво" />);

    const trigger = screen.getByRole("combobox", { name: "Группа" });
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeDefined();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not select a disabled option", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Select
        label="Продукты"
        options={[
          { value: "p1", label: "Молоко", disabled: false },
          { value: "p2", label: "Сыр", disabled: true },
          { value: "p3", label: "Йогурт", disabled: false },
        ]}
        value="p1"
        onValueChange={onValueChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Продукты" }));
    const cheeseOption = screen.getByRole("option", { name: "Сыр" });
    expect(cheeseOption.getAttribute("data-disabled")).toBe("");

    await user.click(cheeseOption);

    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe("Checkbox", () => {
  it("toggles when its visible label is clicked", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Паллеты" checked={false} onCheckedChange={onCheckedChange} />);

    await user.click(screen.getByText("Паллеты"));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("toggles from the keyboard", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Паллеты" checked={false} onCheckedChange={onCheckedChange} />);

    await user.tab();
    await user.keyboard(" ");

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("wires an error to the checkbox and exposes the invalid state", () => {
    render(<Checkbox label="Паллеты" error="Выберите значение" />);

    const checkbox = screen.getByRole("checkbox", { name: "Паллеты" });
    expect(checkbox.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(checkbox.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Выберите значение",
    );
  });

  it("uses the shared solid tokenised focus-visible rule", () => {
    render(<Checkbox label="Паллеты" />);

    const focusRule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .find((rule) => rule.cssText.includes(".mk-checkbox__control:focus-visible"));
    expect(focusRule).toBeDefined();
    expect(focusRule!.cssText).toContain("outline: 2px solid var(--focus-ring);");
  });

  it("calls onCheckedChange with true when its labelled control is checked", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Паллеты" checked={false} onCheckedChange={onCheckedChange} />);

    await user.click(screen.getByRole("checkbox", { name: "Паллеты" }));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("does not change while disabled", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Паллеты" checked={false} disabled onCheckedChange={onCheckedChange} />);

    await user.click(screen.getByRole("checkbox", { name: "Паллеты" }));

    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

describe("RadioGroup", () => {
  it("selects an option when its visible label is clicked", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup
        label="Режим смены"
        options={[
          { value: "production", label: "Производство" },
          { value: "rework", label: "Переработка" },
        ]}
        value="production"
        onValueChange={onValueChange}
      />,
    );

    await user.click(screen.getByText("Переработка"));

    expect(onValueChange).toHaveBeenCalledWith("rework");
  });

  it("wires an error to the group and exposes the invalid state", () => {
    render(
      <RadioGroup
        label="Режим смены"
        error="Выберите режим"
        options={[{ value: "production", label: "Производство" }]}
      />,
    );

    const group = screen.getByRole("radiogroup", { name: "Режим смены" });
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(group.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Выберите режим",
    );
  });

  it("uses the shared solid tokenised focus-visible rule", () => {
    render(
      <RadioGroup label="Режим смены" options={[{ value: "production", label: "Производство" }]} />,
    );

    const focusRule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .find((rule) => rule.cssText.includes(".mk-radio-group__control:focus-visible"));
    expect(focusRule).toBeDefined();
    expect(focusRule!.cssText).toContain("outline: 2px solid var(--focus-ring);");
  });

  it("uses aria-label when no visible group label is supplied", () => {
    render(
      <RadioGroup
        aria-label="Режим смены"
        options={[{ value: "production", label: "Производство" }]}
      />,
    );

    expect(screen.getByRole("radiogroup", { name: "Режим смены" })).toBeDefined();
  });

  it("moves the selected choice with ArrowDown", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { rerender } = render(
      <RadioGroup
        label="Режим смены"
        options={[
          { value: "production", label: "Производство" },
          { value: "rework", label: "Переработка" },
        ]}
        value="production"
        onValueChange={onValueChange}
      />,
    );

    await user.tab();
    const production = screen.getByRole("radio", { name: "Производство" });
    expect(document.activeElement).toBe(production);
    fireEvent.keyDown(production, { key: "ArrowDown" });

    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith("rework"));
    fireEvent.keyUp(document, { key: "ArrowDown" });
    rerender(
      <RadioGroup
        label="Режим смены"
        options={[
          { value: "production", label: "Производство" },
          { value: "rework", label: "Переработка" },
        ]}
        value="rework"
        onValueChange={onValueChange}
      />,
    );
    expect(screen.getByRole("radio", { name: "Переработка" }).getAttribute("data-state")).toBe(
      "checked",
    );
  });

  it("does not select a disabled choice", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup
        label="Режим смены"
        options={[
          { value: "production", label: "Производство" },
          { value: "rework", label: "Переработка", disabled: true },
        ]}
        value="production"
        onValueChange={onValueChange}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Переработка" }));

    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe("IconButton", () => {
  it("exposes its required accessible name while rendering only the icon", () => {
    render(<IconButton aria-label="Открыть уведомления" icon={<svg aria-hidden="true" />} />);

    const button = screen.getByRole("button", { name: "Открыть уведомления" });
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("uses a tokenised focus-visible CSS rule for keyboard focus", async () => {
    const user = userEvent.setup();
    render(<IconButton aria-label="Открыть уведомления" icon={<svg aria-hidden="true" />} />);

    await user.tab();

    const button = screen.getByRole("button", { name: "Открыть уведомления" });
    expect(document.activeElement).toBe(button);

    const focusRule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .find((rule) => rule.cssText.includes(".mk-icon-button:focus-visible"));
    expect(focusRule).toBeDefined();
    expect(focusRule!.cssText).toContain("outline: 2px solid var(--focus-ring);");
  });
});

describe("shared control styles", () => {
  it("does not emit a global style tag for every control instance", () => {
    const { container } = render(
      <>
        <Checkbox label="Первый" />
        <Checkbox label="Второй" />
        <RadioGroup label="Режим" options={[{ value: "one", label: "Один" }]} />
        <IconButton aria-label="Добавить" icon={<span aria-hidden="true">+</span>} />
      </>,
    );

    expect(container.querySelector("style")).toBeNull();
  });
});

describe("Card", () => {
  it("renders a title, actions and children", () => {
    render(
      <Card title="Задания" actions={<button>Все</button>}>
        <p>Содержимое</p>
      </Card>,
    );

    expect(screen.getByText("Задания")).toBeDefined();
    expect(screen.getByText("Все")).toBeDefined();
    expect(screen.getByText("Содержимое")).toBeDefined();
  });
});

describe("Badge", () => {
  it("renders its children as a compact mono pill", () => {
    render(<Badge>12</Badge>);
    const badge = screen.getByText("12");
    expect(badge.className).toContain("mk-badge--neutral");
  });
});

describe("Table", () => {
  it("renders an overflow-x:auto wrapper and font-mono nowrap numeric cells", () => {
    const { container } = render(
      <Table
        columns={[
          { key: "batch", title: "Партия" },
          { key: "qty", title: "Кол-во", align: "right", mono: true },
        ]}
        rows={[{ batch: "№ 214", qty: "47 213" }]}
      />,
    );

    const scroll = container.querySelector(".mk-table__scroll");
    expect(scroll).not.toBeNull();
    expect((scroll as HTMLElement).style.overflowX).toBe("auto");

    const numericCell = screen.getByText("47 213");
    expect(numericCell.className).toContain("font-mono");
    expect(numericCell.className).toContain("nowrap");
  });

  it("renders the empty state when there are no rows", () => {
    render(<Table columns={[{ key: "batch", title: "Партия" }]} rows={[]} empty="Пока пусто" />);

    expect(screen.getByText("Пока пусто")).toBeDefined();
  });

  it("defaults the empty state to the neutral EN 'No data' when `empty` isn't provided", () => {
    render(<Table columns={[{ key: "batch", title: "Партия" }]} rows={[]} />);

    expect(screen.getByText("No data")).toBeDefined();
  });
});
