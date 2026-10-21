/**
 * «Системная / светлая / тёмная» on the standalone pages. `public/theme-init.js`
 * applies the saved choice before the first paint; this module keeps the controls,
 * the stored choice and the system preference in step afterwards.
 */

export const THEME_STORAGE_KEY = "markiro:theme";
export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export type ResolvedTheme = "light" | "dark";

const THEME_COLORS: Readonly<Record<ResolvedTheme, string>> = { light: "#fafaf8", dark: "#131216" };

export interface ThemeRuntime {
  readonly prefersDark: () => boolean;
  readonly onSystemChange: (listener: () => void) => () => void;
  readonly load: () => string | null;
  readonly save: (choice: ThemeChoice) => void;
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}

export function initThemeSwitch(root: Document, runtime: ThemeRuntime): () => void {
  const html = root.documentElement;
  const stored = runtime.load();
  let choice: ThemeChoice = isThemeChoice(stored) ? stored : "system";

  const apply = (): void => {
    const resolved = resolveTheme(choice, runtime.prefersDark());
    html.dataset.theme = resolved;
    html.dataset.themeChoice = choice;
    root.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[resolved]);
    for (const option of root.querySelectorAll<HTMLElement>("[data-theme-option]")) {
      option.setAttribute("aria-pressed", String(option.dataset.themeOption === choice));
    }
  };

  const toggles = [...root.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]")];
  const setMenuOpen = (toggle: HTMLButtonElement, open: boolean): void => {
    const menu = root.getElementById(toggle.getAttribute("aria-controls") ?? "");
    toggle.setAttribute("aria-expanded", String(open));
    if (menu !== null) menu.hidden = !open;
  };

  const onClick = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    const option = event.target.closest<HTMLElement>("[data-theme-option]");
    if (option !== null && isThemeChoice(option.dataset.themeOption)) {
      choice = option.dataset.themeOption;
      runtime.save(choice);
      apply();
      for (const toggle of toggles) {
        if (toggle.getAttribute("aria-expanded") === "true") {
          setMenuOpen(toggle, false);
          toggle.focus();
        }
      }
      return;
    }
    const toggle = event.target.closest<HTMLButtonElement>("[data-theme-toggle]");
    if (toggle !== null) {
      setMenuOpen(toggle, toggle.getAttribute("aria-expanded") !== "true");
      return;
    }
    for (const open of toggles) {
      if (open.getAttribute("aria-expanded") !== "true") continue;
      const menu = root.getElementById(open.getAttribute("aria-controls") ?? "");
      if (menu === null || !menu.contains(event.target)) setMenuOpen(open, false);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    for (const toggle of toggles) {
      if (toggle.getAttribute("aria-expanded") === "true") {
        setMenuOpen(toggle, false);
        toggle.focus();
      }
    }
  };

  const stopSystem = runtime.onSystemChange(() => {
    if (choice === "system") apply();
  });

  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKeyDown);
  apply();

  return () => {
    root.removeEventListener("click", onClick);
    root.removeEventListener("keydown", onKeyDown);
    stopSystem();
  };
}

export function browserThemeRuntime(browserWindow: Window & typeof globalThis): ThemeRuntime {
  const query = browserWindow.matchMedia("(prefers-color-scheme: dark)");
  return {
    prefersDark: () => query.matches,
    onSystemChange: (listener) => {
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    load: () => {
      try {
        return browserWindow.localStorage.getItem(THEME_STORAGE_KEY);
      } catch {
        return null;
      }
    },
    save: (choice) => {
      try {
        if (choice === "system") browserWindow.localStorage.removeItem(THEME_STORAGE_KEY);
        else browserWindow.localStorage.setItem(THEME_STORAGE_KEY, choice);
      } catch {
        // The choice then lasts until the page closes.
      }
    },
  };
}
