import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Combobox } from "../src/components/index.js";

afterEach(() => {
  cleanup();
});

const catalogOptions = [
  {
    value: "production-v3",
    label: "Production V3",
    description: "Catalog offer",
    group: "Catalog",
    keywords: ["production v3"],
  },
  {
    value: "starter",
    label: "Starter",
    description: "Entry plan",
    group: "Catalog",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Individual terms",
    group: "Special",
  },
] as const;

function renderCombobox(overrides: Partial<React.ComponentProps<typeof Combobox>> = {}) {
  return render(
    <Combobox
      label="Offer"
      options={catalogOptions}
      onValueChange={vi.fn()}
      placeholder="Select offer"
      searchPlaceholder="Search offers"
      emptyText="No offers"
      loadingText="Loading offers"
      {...overrides}
    />,
  );
}

describe("Combobox", () => {
  it("filters catalog options by a case-insensitive keyword query", async () => {
    const user = userEvent.setup();
    renderCombobox();

    const trigger = screen.getByRole("combobox", { name: "Offer" });
    await user.click(trigger);
    await user.type(screen.getByRole("searchbox", { name: "Search offers" }), "production v3");

    expect(screen.getByRole("option", { name: /Production V3/i })).toBeDefined();
    expect(screen.queryByRole("option", { name: /Starter/i })).toBeNull();
    expect(screen.queryByRole("option", { name: /Custom/i })).toBeNull();
  });

  it("selects the active filtered option with ArrowDown and Enter", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderCombobox({ onValueChange });

    await user.click(screen.getByRole("combobox", { name: "Offer" }));
    await user.type(screen.getByRole("searchbox", { name: "Search offers" }), "production v3");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onValueChange).toHaveBeenCalledWith("production-v3");
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    renderCombobox();

    const trigger = screen.getByRole("combobox", { name: "Offer" });
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeDefined();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("exposes grouped options with their group labels", async () => {
    const user = userEvent.setup();
    renderCombobox();

    await user.click(screen.getByRole("combobox", { name: "Offer" }));

    expect(screen.getByRole("group", { name: "Catalog" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Special" })).toBeDefined();
  });

  it("distinguishes loading from an empty filtered result", async () => {
    const user = userEvent.setup();
    const { rerender } = renderCombobox({ loading: true });

    await user.click(screen.getByRole("combobox", { name: "Offer" }));
    expect(screen.getByText("Loading offers")).toBeDefined();
    expect(screen.queryByText("No offers")).toBeNull();

    rerender(
      <Combobox
        label="Offer"
        options={catalogOptions}
        onValueChange={vi.fn()}
        placeholder="Select offer"
        searchPlaceholder="Search offers"
        emptyText="No offers"
        loadingText="Loading offers"
      />,
    );
    await user.type(screen.getByRole("searchbox", { name: "Search offers" }), "missing");

    expect(screen.getByText("No offers")).toBeDefined();
    expect(screen.queryByText("Loading offers")).toBeNull();
  });

  it("associates the error message with its combobox trigger", () => {
    renderCombobox({ error: "Offer is required" });

    const trigger = screen.getByRole("combobox", { name: "Offer" });
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Offer is required",
    );
  });
});
