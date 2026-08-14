import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
// @ts-expect-error The UI test tsconfig omits Node globals; Vitest still runs in Node.
import { readFileSync } from "node:fs";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import componentStyles from "virtual:ui-component-styles";

import {
  AdminPage,
  Badge,
  Button,
  Card,
  Checkbox,
  Drawer,
  Field,
  FilterBar,
  FullScreenDialog,
  IconButton,
  Input,
  Pager,
  RadioGroup,
  RowActions,
  Select,
  StatusChip,
  Table,
} from "../src/components/index.js";

const sharedStyles = readFileSync("src/styles.css", "utf8") as string;
const sharedStyleElement = document.createElement("style");
sharedStyleElement.textContent = sharedStyles;
document.head.append(sharedStyleElement);

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

describe("Admin page layout", () => {
  it("provides a full-width page wrapper while preserving native div props", () => {
    render(
      <AdminPage data-testid="admin-page" className="feature-page">
        <h1>Title</h1>
      </AdminPage>,
    );

    const page = screen.getByTestId("admin-page");
    expect(page.classList).toContain("mk-admin-page");
    expect(page.classList).toContain("feature-page");
  });

  it("labels filters, keeps the polite result summary mounted, and exposes reset", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(
      <FilterBar
        label="Shift filters"
        resultSummary="3 shifts"
        resetLabel="Reset"
        onReset={onReset}
      >
        <input aria-label="Status" />
      </FilterBar>,
    );

    expect(screen.getByRole("group", { name: "Shift filters" })).toBeDefined();
    expect(screen.getByText("3 shifts").getAttribute("aria-live")).toBe("polite");
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("keeps row actions visible in a consistent action region", () => {
    render(
      <RowActions data-testid="row-actions">
        <button>Edit</button>
        <button>Delete</button>
      </RowActions>,
    );

    expect(screen.getByTestId("row-actions").classList).toContain("mk-row-actions");
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Edit",
      "Delete",
    ]);
  });
});

describe("Button", () => {
  it("keeps the office control minimum height while allowing wrapped labels to grow", () => {
    const { rerender } = render(
      <Button variant="primary" size="md">
        Save
      </Button>,
    );
    const primary = screen.getByRole("button", { name: "Save" });
    expect(primary.className).toContain("mk-btn--primary");
    expect(primary.className).toContain("mk-btn--md");
    expect(primary.style.minHeight).toBe("var(--control-md)");
    expect(primary.style.height).toBe("");

    rerender(
      <Button variant="secondary" size="compact">
        Cancel
      </Button>,
    );
    const secondary = screen.getByRole("button", { name: "Cancel" });
    expect(secondary.className).toContain("mk-btn--secondary");
    expect(secondary.className).toContain("mk-btn--compact");
    expect(secondary.style.minHeight).toBe("var(--control-sm)");
    expect(secondary.style.height).toBe("");

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

  it("renders a disabled floor target without changing office defaults", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button size="floor" disabled onClick={onClick}>
        Start shift
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Start shift" });
    expect(button.className).toContain("mk-btn--floor");
    expect(button.style.height).toBe("var(--control-floor)");
    expect(button.style.minWidth).toBe("var(--control-floor)");
    expect(button.style.font).toBe("var(--floor-body-strong)");
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("generic document reset", () => {
  it("enables full-height layouts without globally hiding overflow", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);

    expect(getComputedStyle(document.documentElement).height).toBe("100%");
    expect(getComputedStyle(document.body).height).toBe("100%");
    expect(getComputedStyle(root).height).toBe("100%");
    expect(getComputedStyle(document.body).margin).toBe("0px");
    expect(getComputedStyle(root).boxSizing).toBe("border-box");
    expect(getComputedStyle(document.body).overflow).not.toBe("hidden");

    root.remove();
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

  it("links a floor-sized input to its label and error", () => {
    render(<Input size="floor" label="Quantity" error="Too large" disabled />);

    const input = screen.getByRole("textbox", { name: "Quantity" });
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect(input.style.fontSize).toBe("20px");
    expect(input.parentElement?.style.height).toBe("var(--control-floor)");
    expect(screen.getByText("Quantity").style.font).toBe("var(--floor-body-strong)");
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Too large",
    );
  });

  it("makes the floor input itself a 64px target and focuses it from the visual field", async () => {
    const user = userEvent.setup();
    render(<Input size="floor" label="Code" prefix="01" suffix="GTIN" />);

    const input = screen.getByRole("textbox", { name: "Code" });
    const visualField = input.parentElement;
    expect(visualField).not.toBeNull();
    expect(input.style.minHeight).toBe("var(--control-floor)");
    expect(input.style.height).toBe("100%");

    await user.click(visualField!);
    expect(document.activeElement).toBe(input);
  });
});

describe("Select", () => {
  it("contains the Radix form proxy within the field instead of the viewport", () => {
    const { container } = render(
      <form>
        <Select label="Группа" options={["Пиво", "Вода"]} value="Пиво" />
      </form>,
    );

    const field = container.querySelector(".mk-field");
    const proxy = field?.querySelector("select[aria-hidden='true']");
    expect(field).toBeInstanceOf(HTMLElement);
    expect(proxy).toBeInstanceOf(HTMLSelectElement);
    if (!(field instanceof HTMLElement) || !(proxy instanceof HTMLSelectElement)) return;
    expect(field.contains(proxy)).toBe(true);
    expect(field.style.position).toBe("relative");
  });

  it("opens with a controlled empty option selected", async () => {
    const user = userEvent.setup();
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
    await user.click(screen.getByRole("combobox", { name: "Линия" }));

    const emptyOption = screen.getByRole("option", { name: "Без линии" });
    expect(emptyOption.getAttribute("data-state")).toBe("checked");
    expect(emptyOption.querySelector("svg")).not.toBeNull();
  });

  it("maps a selected empty option back to the public empty string", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

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
          onValueChange={(nextValue) => {
            onValueChange(nextValue);
            setValue(nextValue);
          }}
        />
      );
    }

    render(<SelectHarness />);

    await user.click(screen.getByRole("combobox", { name: "Линия" }));
    await user.click(screen.getByRole("option", { name: "Без линии" }));

    expect(screen.getByRole("combobox", { name: "Линия" }).textContent).toContain("Без линии");
    expect(onValueChange).toHaveBeenCalledWith("");
  });

  it("submits a controlled empty option as an empty form value", () => {
    render(
      <form data-testid="line-form">
        <Select
          label="Линия"
          name="lineId"
          options={[
            { value: "", label: "Без линии" },
            { value: "line-1", label: "Линия 1" },
          ]}
          value=""
        />
      </form>,
    );

    const data = new FormData(screen.getByTestId("line-form") as HTMLFormElement);
    expect(data.get("lineId")).toBe("");
  });

  it("omits a disabled controlled custom select from form data", () => {
    render(
      <form data-testid="disabled-line-form">
        <Select
          label="Линия"
          name="lineId"
          options={[{ value: "line-1", label: "Линия 1" }]}
          value="line-1"
          disabled
        />
      </form>,
    );

    const data = new FormData(screen.getByTestId("disabled-line-form") as HTMLFormElement);
    expect(data.has("lineId")).toBe(false);
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

  it("keeps external descriptions alongside the active error for custom and native selects", () => {
    render(
      <>
        <p id="shipping-context">Select a product approved for shipping.</p>
        <Select
          label="Custom product"
          options={["Milk"]}
          hint="This hint is hidden by the error"
          error="Choose a product"
          aria-describedby="shipping-context"
        />
        <Select
          native
          label="Native product"
          options={["Milk"]}
          hint="This hint is hidden by the error"
          error="Choose a product"
          aria-describedby="shipping-context"
        />
      </>,
    );

    for (const trigger of screen.getAllByRole("combobox")) {
      const describedBy = trigger.getAttribute("aria-describedby")?.split(" ") ?? [];
      expect(describedBy).toContain("shipping-context");
      expect(describedBy).toHaveLength(2);
      expect(
        document.getElementById(describedBy.find((id) => id !== "shipping-context")!)?.textContent,
      ).toBe("Choose a product");
    }
    expect(screen.queryByText("This hint is hidden by the error")).toBeNull();
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
    const listbox = screen.getByRole("listbox");
    const content = listbox.closest<HTMLElement>("[data-mk-nested-overlay]");
    const viewport = content?.querySelector<HTMLElement>("[data-radix-select-viewport]");
    expect(content).not.toBeNull();
    expect(content?.getAttribute("data-position")).toBe("popper");
    expect(content?.classList.contains("mk-select__content")).toBe(true);
    expect(content?.classList.contains("mk-select__viewport")).toBe(false);
    expect(viewport?.classList.contains("mk-select__viewport")).toBe(true);
    expect(content?.style.zIndex).toBe("var(--z-overlay-popover)");
    await user.click(screen.getByRole("option", { name: "Вода" }));

    expect(onValueChange).toHaveBeenCalledWith("Вода");
  });

  it("contains a long option label inside the bounded menu", async () => {
    const user = userEvent.setup();
    const longLabel = "UnbrokenProductionLineName".repeat(8);
    render(
      <Select label="Линия" options={[{ value: "line-1", label: longLabel }]} value="line-1" />,
    );

    const trigger = screen.getByRole("combobox", { name: "Линия" });
    const triggerValue = trigger.querySelector<HTMLElement>(".mk-select__value");
    expect(triggerValue).not.toBeNull();
    expect(getComputedStyle(triggerValue!).overflow).toBe("hidden");
    expect(getComputedStyle(triggerValue!).textOverflow).toBe("ellipsis");

    await user.click(trigger);
    const content = screen.getByRole("listbox").closest<HTMLElement>("[data-mk-nested-overlay]");
    const viewport = content?.querySelector<HTMLElement>(".mk-select__viewport");
    const option = screen.getByRole("option", { name: longLabel });
    const optionText = option.querySelector<HTMLElement>(".mk-select__item-text");

    expect(content).not.toBeNull();
    expect(getComputedStyle(content!).boxSizing).toBe("border-box");
    expect(viewport).not.toBeNull();
    expect(getComputedStyle(viewport!).boxSizing).toBe("border-box");
    expect(getComputedStyle(viewport!).overflowX).toBe("hidden");
    expect(getComputedStyle(option).minWidth).toBe("0px");
    expect(optionText).not.toBeNull();
    expect(getComputedStyle(optionText!).overflow).toBe("hidden");
    expect(getComputedStyle(optionText!).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(optionText!).whiteSpace).toBe("nowrap");
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

  it("links a floor-sized select to its label and error", () => {
    render(
      <Select
        size="floor"
        label="Line"
        options={["Line 1"]}
        value="Line 1"
        error="Unavailable"
        disabled
      />,
    );

    const select = screen.getByRole("combobox", { name: "Line" });
    expect((select as HTMLSelectElement).disabled).toBe(true);
    expect(select.tagName).toBe("SELECT");
    expect(select.style.height).toBe("var(--control-floor)");
    expect(select.style.font).toBe("var(--floor-body)");
    expect(screen.getByText("Line").style.font).toBe("var(--floor-body-strong)");
    expect(document.getElementById(select.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Unavailable",
    );
  });
});

describe("Pager", () => {
  it("exports an accessible floor pager with deterministic adjacent page requests", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <Pager
        page={2}
        pageCount={4}
        onPageChange={onPageChange}
        ariaLabel="Shift pages"
        previousLabel="Previous"
        nextLabel="Next"
        pageLabel={(page, pageCount) => `Page ${page} of ${pageCount}`}
      />,
    );

    const navigation = screen.getByRole("navigation", { name: "Shift pages" });
    expect(navigation.textContent).toContain("Page 2 of 4");
    const previous = screen.getByRole("button", { name: "Previous" });
    const next = screen.getByRole("button", { name: "Next" });
    expect(previous.style.height).toBe("var(--control-floor)");
    expect(next.style.height).toBe("var(--control-floor)");

    await user.click(previous);
    await user.click(next);
    expect(onPageChange.mock.calls).toEqual([[1], [3]]);
  });

  it("disables both page boundaries and never requests an out-of-range page", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const { rerender } = render(<Pager page={1} pageCount={4} onPageChange={onPageChange} />);

    const previous = screen.getByRole("button", { name: "Previous" });
    expect((previous as HTMLButtonElement).disabled).toBe(true);
    await user.click(previous);

    rerender(<Pager page={4} pageCount={4} onPageChange={onPageChange} />);
    const next = screen.getByRole("button", { name: "Next" });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    await user.click(next);
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("normalizes non-finite and non-positive inputs to finite pages and callbacks", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const { rerender } = render(
      <Pager page={Number.NaN} pageCount={Number.POSITIVE_INFINITY} onPageChange={onPageChange} />,
    );

    expect(screen.getByText("Page 1 of 1")).toBeDefined();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<Pager page={Number.POSITIVE_INFINITY} pageCount={4} onPageChange={onPageChange} />);
    expect(screen.getByText("Page 4 of 4")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    expect(Number.isFinite(onPageChange.mock.calls.at(-1)?.[0])).toBe(true);

    rerender(<Pager page={Number.NEGATIVE_INFINITY} pageCount={0} onPageChange={onPageChange} />);
    expect(screen.getByText("Page 1 of 1")).toBeDefined();
  });
});

describe("FullScreenDialog", () => {
  function DialogHarness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open setup
        </button>
        <FullScreenDialog
          open={open}
          title="Station setup"
          backLabel="Cancel setup"
          onClose={() => setOpen(false)}
          footer={<button type="button">Save setup</button>}
        >
          <input aria-label="Station name" />
        </FullScreenDialog>
      </>
    );
  }

  function NestedDialogHarness() {
    const [outerOpen, setOuterOpen] = useState(false);
    const [innerOpen, setInnerOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOuterOpen(true)}>
          Open outer
        </button>
        <FullScreenDialog
          open={outerOpen}
          title="Outer dialog"
          backLabel="Back from outer"
          onClose={() => setOuterOpen(false)}
          footer={<button type="button">Outer action</button>}
        >
          <button type="button" onClick={() => setInnerOpen(true)}>
            Open inner
          </button>
          <FullScreenDialog
            open={innerOpen}
            title="Inner dialog"
            backLabel="Back from inner"
            onClose={() => setInnerOpen(false)}
            footer={<button type="button">Inner action</button>}
          >
            Inner content
          </FullScreenDialog>
        </FullScreenDialog>
      </>
    );
  }

  function SimultaneousDialogHarness() {
    const [outerOpen, setOuterOpen] = useState(true);
    const [innerOpen, setInnerOpen] = useState(true);
    return (
      <FullScreenDialog
        open={outerOpen}
        title="Simultaneous outer"
        backLabel="Close simultaneous outer"
        onClose={() => setOuterOpen(false)}
        footer={<button type="button">Simultaneous outer action</button>}
      >
        <FullScreenDialog
          open={innerOpen}
          title="Simultaneous inner"
          backLabel="Close simultaneous inner"
          onClose={() => setInnerOpen(false)}
          footer={<button type="button">Simultaneous inner action</button>}
        >
          Inner content
        </FullScreenDialog>
      </FullScreenDialog>
    );
  }

  it("exports a full-screen dialog with an explicit floor-sized back action", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <FullScreenDialog open title="Confirm box" backLabel="Back" onClose={onClose}>
        Confirm content
      </FullScreenDialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "Confirm box" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.style.overflow).not.toBe("auto");
    const back = screen.getByRole("button", { name: "Back" });
    expect(back.className).toContain("mk-btn--floor");
    expect(back.style.height).toBe("var(--control-floor)");
    expect(document.activeElement).toBe(back);
    await user.click(back);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("can initially focus the dialog container before exposing any destructive action", async () => {
    const user = userEvent.setup();
    render(
      <FullScreenDialog
        open
        title="Verify print"
        backLabel="Skip verification"
        onClose={() => undefined}
        initialFocus="dialog"
        footer={<button type="button">Reprint</button>}
      >
        Scan the label
      </FullScreenDialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "Verify print" });
    const skip = screen.getByRole("button", { name: "Skip verification" });
    const reprint = screen.getByRole("button", { name: "Reprint" });
    expect(document.activeElement).toBe(dialog);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(reprint);
    dialog.focus();
    await user.tab();
    expect(document.activeElement).toBe(skip);
  });

  it("can disable both the back action and Escape while blocking work is pending", () => {
    const onClose = vi.fn();
    render(
      <FullScreenDialog open title="Printing" backLabel="Retry" backDisabled onClose={onClose}>
        Printing a box label
      </FullScreenDialog>,
    );

    const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Printing" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("traps focus, closes on Escape, and restores focus to its opener", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "Open setup" });
    await user.click(opener);

    const back = screen.getByRole("button", { name: "Cancel setup" });
    const save = screen.getByRole("button", { name: "Save setup" });
    expect(document.activeElement).toBe(back);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(save);
    await user.tab();
    expect(document.activeElement).toBe(back);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps Escape and Tab scoped to the topmost nested dialog and restores focus by layer", async () => {
    const user = userEvent.setup();
    render(<NestedDialogHarness />);
    const originalOpener = screen.getByRole("button", { name: "Open outer" });
    await user.click(originalOpener);
    const innerOpener = screen.getByRole("button", { name: "Open inner" });
    await user.click(innerOpener);

    const innerBack = screen.getByRole("button", { name: "Back from inner" });
    const innerLast = screen.getByRole("button", { name: "Inner action" });
    expect(document.activeElement).toBe(innerBack);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(innerLast);
    await user.tab();
    expect(document.activeElement).toBe(innerBack);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Inner dialog" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Outer dialog" })).toBeDefined();
    expect(document.activeElement).toBe(innerOpener);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Outer dialog" })).toBeNull();
    expect(document.activeElement).toBe(originalOpener);
  });

  it("coordinates initial focus when nested dialogs are both open on their first render", async () => {
    const originalFocus = document.createElement("button");
    originalFocus.textContent = "Original focus";
    document.body.append(originalFocus);
    originalFocus.focus();

    const user = userEvent.setup();
    render(<SimultaneousDialogHarness />);
    const innerBack = screen.getByRole("button", { name: "Close simultaneous inner" });
    const innerLast = screen.getByRole("button", { name: "Simultaneous inner action" });
    expect(document.activeElement).toBe(innerBack);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(innerLast);
    await user.tab();
    expect(document.activeElement).toBe(innerBack);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Simultaneous inner" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Simultaneous outer" })).toBeDefined();
    const outerBack = screen.getByRole("button", { name: "Close simultaneous outer" });
    const outerLast = screen.getByRole("button", { name: "Simultaneous outer action" });
    expect(document.activeElement).toBe(outerBack);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(outerLast);
    await user.tab();
    expect(document.activeElement).toBe(outerBack);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Simultaneous outer" })).toBeNull();
    expect(document.activeElement).toBe(originalFocus);
    originalFocus.remove();
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

describe("Drawer", () => {
  function DrawerHarness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open drawer
        </button>
        <Drawer open={open} title="Device setup" onClose={() => setOpen(false)}>
          <button type="button">Save device</button>
        </Drawer>
      </>
    );
  }

  it("keeps keyboard focus in a labelled modal dialog and restores its opener when closed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Open device</button>
        <Drawer open title="Device setup" onClose={onClose} closeLabel="Close drawer">
          <input aria-label="Device name" />
          <button type="button">Save device</button>
        </Drawer>
      </>,
    );

    const dialog = screen.getByRole("dialog", { name: "Device setup" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("Close drawer"));

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save device" }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("restores focus to its opener after Escape closes it", async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    const opener = screen.getByRole("button", { name: "Open drawer" });
    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("locks document background scrolling only while open and restores it after close", () => {
    const { rerender } = render(
      <Drawer open title="Device setup" onClose={() => undefined}>
        Content
      </Drawer>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    rerender(
      <Drawer open={false} title="Device setup" onClose={() => undefined}>
        Content
      </Drawer>,
    );
    expect(document.body.style.overflow).toBe("");
  });

  it("closes from its overlay and its close control", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(
      <Drawer open title="Device setup" onClose={onClose} closeLabel="Close drawer">
        Content
      </Drawer>,
    );

    await user.click(screen.getByLabelText("Close drawer"));
    expect(onClose).toHaveBeenCalledOnce();

    await user.click(container.querySelector(".mk-drawer-overlay")!);
    expect(onClose).toHaveBeenCalledTimes(2);
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

  it("moves a labeled horizontal region with keyboard arrow keys", () => {
    render(
      <Table
        columns={[
          { key: "batch", title: "Партия", width: 400 },
          { key: "qty", title: "Кол-во", width: 400 },
        ]}
        rows={[{ batch: "№ 214", qty: "47 213" }]}
        scrollLabel="Партии"
      />,
    );

    const scroll = screen.getByRole("region", { name: "Партии" });
    Object.defineProperties(scroll, {
      clientWidth: { configurable: true, value: 320 },
      scrollWidth: { configurable: true, value: 800 },
    });
    scroll.focus();

    expect(document.activeElement).toBe(scroll);
    expect(fireEvent.keyDown(scroll, { key: "ArrowRight" })).toBe(false);
    expect(scroll.scrollLeft).toBeGreaterThan(0);
    expect(fireEvent.keyDown(scroll, { key: "ArrowLeft" })).toBe(false);
    expect(scroll.scrollLeft).toBe(0);
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
