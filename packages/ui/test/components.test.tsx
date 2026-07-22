import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  StatusChip,
  Table,
} from "../src/components/index.js";

afterEach(() => {
  cleanup();
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
  it("renders options and calls onChange with the selected value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select label="Группа" options={["Пиво", "Вода"]} value="Пиво" onChange={onChange} />);

    const select = screen.getByLabelText("Группа");
    await user.selectOptions(select, "Вода");

    expect(onChange).toHaveBeenCalledWith("Вода");
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
});
