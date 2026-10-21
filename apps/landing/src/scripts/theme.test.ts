// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  initThemeSwitch as startThemeSwitch,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemeRuntime,
} from "./theme";

const disposers: (() => void)[] = [];
function initThemeSwitch(root: Document, runtime: ThemeRuntime): void {
  disposers.push(startThemeSwitch(root, runtime));
}

function render(): void {
  document.head.innerHTML = '<meta name="theme-color" content="#fafaf8" />';
  document.body.innerHTML = `
    <button type="button" data-theme-toggle aria-controls="theme-menu" aria-expanded="false">Тема</button>
    <div id="theme-menu" role="group" hidden>
      <button type="button" data-theme-option="system">Системная</button>
      <button type="button" data-theme-option="light">Светлая</button>
      <button type="button" data-theme-option="dark">Тёмная</button>
    </div>`;
}

function runtime(saved: string | null, prefersDark = false) {
  const listeners: (() => void)[] = [];
  let dark = prefersDark;
  const value: ThemeRuntime & { flip: () => void } = {
    prefersDark: () => dark,
    onSystemChange: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    load: () => saved,
    save: vi.fn(),
    flip: () => {
      dark = !dark;
      for (const listener of listeners) listener();
    },
  };
  return value;
}

function option(choice: string): HTMLElement {
  return document.querySelector(`[data-theme-option="${choice}"]`) as HTMLElement;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-choice");
});

describe("theme switch", () => {
  it("resolves the system choice from the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("follows the system until the visitor picks a theme", () => {
    render();
    const current = runtime(null, false);
    initThemeSwitch(document, current);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(option("system").getAttribute("aria-pressed")).toBe("true");

    current.flip();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      "#131216",
    );

    option("light").click();
    expect(current.save).toHaveBeenCalledWith("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    current.flip();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("restores a saved choice and ignores a foreign value", () => {
    render();
    initThemeSwitch(document, runtime("dark"));
    expect(document.documentElement.dataset.themeChoice).toBe("dark");
    render();
    initThemeSwitch(document, runtime("sepia", true));
    expect(document.documentElement.dataset.themeChoice).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("opens the header menu, closes it on choice and on Escape", () => {
    render();
    initThemeSwitch(document, runtime(null));
    const toggle = document.querySelector("[data-theme-toggle]") as HTMLButtonElement;
    const menu = document.getElementById("theme-menu") as HTMLElement;
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(menu.hidden).toBe(false);
    option("dark").click();
    expect(menu.hidden).toBe(true);
    toggle.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it("uses the same storage key in the pre-paint script", () => {
    const init = readFileSync(path.join(process.cwd(), "public/theme-init.js"), "utf8");
    expect(init).toContain(`"${THEME_STORAGE_KEY}"`);
  });
});
