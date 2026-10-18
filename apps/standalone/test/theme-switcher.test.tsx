import { act, fireEvent, render, screen } from "@testing-library/react";
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
  return screen.getByRole("radiogroup", { name: "Тема оформления" });
}

describe("the office theme selector", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("starts on «Системная» and is a radio group of exactly the three choices in order, the default marked", () => {
    renderSwitcher();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Системная (по умолчанию)",
      "Светлая",
      "Тёмная",
    ]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    // Each carries its name as a tooltip too, since the segments are icons.
    expect(radios.map((radio) => radio.getAttribute("title"))).toEqual(
      radios.map((radio) => radio.getAttribute("aria-label")),
    );
  });

  it("marks the chosen segment by fill and by state, with an icon in every segment — not by colour alone", () => {
    renderSwitcher();
    const radios = screen.getAllByRole("radio");
    for (const radio of radios) expect(radio.querySelector("svg")).not.toBeNull();
    expect(radios.map((radio) => radio.className.includes("theme-switcher__option--on"))).toEqual([
      true,
      false,
      false,
    ]);
    fireEvent.click(screen.getByRole("radio", { name: "Светлая" }));
    expect(screen.getAllByRole("radio").map((radio) => radio.className.includes("--on"))).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("keeps one tab stop, on the chosen segment", () => {
    renderSwitcher();
    expect(screen.getAllByRole("radio").map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.click(screen.getByRole("radio", { name: "Тёмная" }));
    expect(screen.getAllByRole("radio").map((radio) => radio.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("persists a choice to markiro.theme, applies it, and keeps the focus on the chosen segment", async () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole("radio", { name: "Тёмная" }));
    expect(localStorage.getItem("markiro.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    await act(async () => undefined);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Тёмная" }));
  });

  it("is keyboard operable: arrows move and choose (wrapping), Home and End jump", async () => {
    const group = renderSwitcher();
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Светлая" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "Тёмная" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(
      screen.getByRole("radio", { name: "Системная (по умолчанию)" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.keyDown(group, { key: "End" });
    expect(screen.getByRole("radio", { name: "Тёмная" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(group, { key: "Home" });
    expect(
      screen.getByRole("radio", { name: "Системная (по умолчанию)" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(localStorage.getItem("markiro.theme")).toBe("system");
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
      fireEvent.click(screen.getByRole("radio", { name: "Светлая" }));
      expect(listeners.size).toBe(0);
      expect(document.documentElement.dataset.theme).toBe("light");
    } finally {
      window.matchMedia = original;
    }
  });
});
