import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
// @ts-expect-error The UI test tsconfig omits Node globals; Vitest still runs in Node.
import { readFileSync } from "node:fs";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Badge,
  Button,
  Card,
  Drawer,
  Field,
  FullScreenDialog,
  Input,
  Pager,
  Select,
  StatusChip,
  Table,
} from "../src/components/index.js";

const sharedStyles = readFileSync("src/styles.css", "utf8") as string;
const sharedStyleElement = document.createElement("style");
sharedStyleElement.textContent = sharedStyles;
document.head.append(sharedStyleElement);

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

  it("renders per-option disabled state and reflects it in the DOM", () => {
    render(
      <Select
        label="Продукты"
        options={[
          { value: "p1", label: "Молоко", disabled: false },
          { value: "p2", label: "Сыр", disabled: true },
          { value: "p3", label: "Йогурт", disabled: false },
        ]}
        value="p1"
      />,
    );

    const milkOption = screen.getByRole("option", { name: "Молоко" }) as HTMLOptionElement;
    const cheeseOption = screen.getByRole("option", { name: "Сыр" }) as HTMLOptionElement;
    const yogurtOption = screen.getByRole("option", { name: "Йогурт" }) as HTMLOptionElement;

    expect(milkOption.disabled).toBe(false);
    expect(cheeseOption.disabled).toBe(true);
    expect(yogurtOption.disabled).toBe(false);
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

  it("renders the empty state when there are no rows", () => {
    render(<Table columns={[{ key: "batch", title: "Партия" }]} rows={[]} empty="Пока пусто" />);

    expect(screen.getByText("Пока пусто")).toBeDefined();
  });

  it("defaults the empty state to the neutral EN 'No data' when `empty` isn't provided", () => {
    render(<Table columns={[{ key: "batch", title: "Партия" }]} rows={[]} />);

    expect(screen.getByText("No data")).toBeDefined();
  });
});
