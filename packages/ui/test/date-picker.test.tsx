import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DatePicker } from "../src/components/index.js";
import { getEffectivePopoverOpen } from "../src/components/DatePicker.js";

afterEach(() => {
  cleanup();
});

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { value: () => false },
    setPointerCapture: { value: () => undefined },
    releasePointerCapture: { value: () => undefined },
    scrollIntoView: { value: () => undefined },
  });
});

describe("DatePicker", () => {
  it("derives a closed effective popover state whenever disabled", () => {
    expect(getEffectivePopoverOpen(true, true)).toBe(false);
    expect(getEffectivePopoverOpen(false, true)).toBe(false);
    expect(getEffectivePopoverOpen(true, false)).toBe(true);
  });

  it("selects a Russian calendar day and emits an ISO date", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<DatePicker label="Плановая дата" value="2026-08-05" onValueChange={onValueChange} />);

    await user.click(screen.getByRole("button", { name: /^плановая дата$/i }));

    expect(screen.getByRole("heading", { name: "Август 2026" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "6 августа 2026" }));

    expect(onValueChange).toHaveBeenCalledWith("2026-08-06");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clears a selected date through an accessible custom action", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<DatePicker label="Плановая дата" value="2026-08-05" onValueChange={onValueChange} />);

    await user.click(screen.getByRole("button", { name: "Очистить дату: Плановая дата" }));

    expect(onValueChange).toHaveBeenCalledWith(undefined);
  });

  it("navigates months with Russian headings", async () => {
    const user = userEvent.setup();
    render(<DatePicker label="Плановая дата" value="2026-08-05" />);

    await user.click(screen.getByRole("button", { name: /^плановая дата$/i }));
    await user.click(screen.getByRole("button", { name: "Следующий месяц" }));
    expect(screen.getByRole("heading", { name: "Сентябрь 2026" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Предыдущий месяц" }));
    expect(screen.getByRole("heading", { name: "Август 2026" })).toBeDefined();
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<DatePicker label="Плановая дата" value="2026-08-05" />);

    const trigger = screen.getByRole("button", { name: /^плановая дата$/i });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeDefined();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not open or emit values while disabled", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<DatePicker label="Плановая дата" disabled onValueChange={onValueChange} />);

    const trigger = screen.getByRole("button", { name: /^плановая дата$/i });
    expect(trigger.getAttribute("disabled")).toBe("");
    await user.click(trigger);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("closes its calendar and blocks date selection when disabled while open", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { rerender } = render(
      <DatePicker label="Плановая дата" value="2026-08-05" onValueChange={onValueChange} />,
    );

    await user.click(screen.getByRole("button", { name: /^плановая дата$/i }));
    expect(screen.getByRole("dialog")).toBeDefined();

    rerender(
      <DatePicker
        label="Плановая дата"
        value="2026-08-05"
        disabled
        onValueChange={onValueChange}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Следующий месяц" })).toBeNull();
    expect(screen.queryByRole("button", { name: "6 августа 2026" })).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("treats an invalid ISO value as empty instead of displaying an invalid date", () => {
    render(<DatePicker label="Плановая дата" value="2026-02-31" />);

    const trigger = screen.getByRole("button", { name: /^плановая дата$/i });
    expect(trigger.textContent).toContain("Выберите дату");
    expect(trigger.textContent).not.toContain("31 февраля");
  });
});
