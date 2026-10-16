import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import "../src/i18n/index.js";
import { ThemeSwitcher } from "../src/office/ThemeSwitcher.js";

function renderSwitcher(defaultTheme: "system" | "dark" = "system") {
  render(
    <ThemeProvider defaultTheme={defaultTheme}>
      <ThemeSwitcher />
    </ThemeProvider>,
  );
}

describe("the office theme selector", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("starts on «Системная» and lists exactly the three choices in order, the default marked", () => {
    renderSwitcher();
    const trigger = screen.getByRole("button", { name: "Тема оформления: Системная" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = within(screen.getByRole("menu")).getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      "Системная (по умолчанию)✓выбрано",
      "Светлая",
      "Тёмная",
    ]);
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
  });

  it("marks the current choice with a check and text, not by colour alone", () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Тема оформления/ }));
    const on = screen.getByRole("menuitemradio", { checked: true });
    expect(on.textContent).toContain("✓");
    expect(on.textContent).toContain("выбрано");
    for (const off of screen.getAllByRole("menuitemradio", { checked: false })) {
      expect(off.textContent).not.toContain("✓");
      expect(off.textContent).not.toContain("выбрано");
    }
  });

  it("persists a choice to markiro.theme, applies it, closes and returns focus to the trigger", () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Тема оформления/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Тёмная/ }));
    expect(localStorage.getItem("markiro.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.queryByRole("menu")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Тема оформления: Тёмная" });
    expect(document.activeElement).toBe(trigger);
  });

  it("is keyboard operable: arrows move (wrapping), Escape closes to the trigger", () => {
    renderSwitcher();
    const trigger = screen.getByRole("button", { name: /Тема оформления/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const [system, light, dark] = screen.getAllByRole("menuitemradio");
    expect(document.activeElement).toBe(system);
    fireEvent.keyDown(system as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(light);
    fireEvent.keyDown(light as HTMLElement, { key: "ArrowUp" });
    fireEvent.keyDown(system as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(dark);
    fireEvent.keyDown(dark as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(system);
    fireEvent.keyDown(system as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(dark);
    fireEvent.keyDown(dark as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(localStorage.getItem("markiro.theme")).toBeNull();
  });

  it("has 44px targets", () => {
    renderSwitcher();
    const trigger = screen.getByRole("button", { name: /Тема оформления/ });
    expect(trigger.style.minHeight).toBe("44px");
    fireEvent.click(trigger);
    for (const item of screen.getAllByRole("menuitemradio")) {
      expect((item as HTMLElement).style.minHeight).toBe("44px");
    }
  });

  it("«Системная» follows the OS live", () => {
    let dark = false;
    const listeners = new Set<() => void>();
    const original = window.matchMedia;
    window.matchMedia = (() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    })) as unknown as typeof window.matchMedia;
    try {
      renderSwitcher();
      expect(document.documentElement.dataset.theme).toBe("light");
      act(() => {
        dark = true;
        listeners.forEach((fn) => fn());
      });
      expect(document.documentElement.dataset.theme).toBe("dark");
      // An explicit choice stops following.
      fireEvent.click(screen.getByRole("button", { name: /Тема оформления/ }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: /Светлая/ }));
      expect(listeners.size).toBe(0);
      expect(document.documentElement.dataset.theme).toBe("light");
    } finally {
      window.matchMedia = original;
    }
  });
});
