import { afterEach, beforeAll, describe, expect, it } from "vitest";

import tokenStyles from "virtual:ui-token-styles";

const NEW_TOKENS = [
  "--done-fg",
  "--done-bg",
  "--done-border",
  "--cat-violet-fg",
  "--cat-violet-bg",
  "--cat-violet-border",
  "--cat-teal-fg",
  "--cat-teal-bg",
  "--cat-teal-border",
  "--cat-magenta-fg",
  "--cat-magenta-bg",
  "--cat-magenta-border",
  "--cat-steel-fg",
  "--cat-steel-bg",
  "--cat-steel-border",
] as const;

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = tokenStyles;
  document.head.append(style);
});

afterEach(() => {
  document.documentElement.dataset.theme = "";
});

describe("токены тегов", () => {
  /**
   * Тёмная тема — не украшение: цех и склад работают на ней. Токен, забытый
   * в блоке [data-theme="dark"], молча наследует светлое значение и даёт
   * нечитаемую подпись, поэтому паритет проверяется явно.
   */
  it.each(NEW_TOKENS)("объявляет %s в обеих темах разными значениями", (token) => {
    document.documentElement.dataset.theme = "";
    const light = getComputedStyle(document.documentElement).getPropertyValue(token).trim();

    document.documentElement.dataset.theme = "dark";
    const dark = getComputedStyle(document.documentElement).getPropertyValue(token).trim();

    expect(light).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).not.toBe(light);
  });

  /**
   * Только светлая тема проверялась автоматически; тёмная сверялась вручную
   * и могла молча разойтись со светлой при следующей правке токенов.
   */
  it.each(["light", "dark"] as const)(
    "держит тон done отдельно от ok и от neutral в теме %s",
    (theme) => {
      document.documentElement.dataset.theme = theme === "light" ? "" : theme;
      const root = getComputedStyle(document.documentElement);
      expect(root.getPropertyValue("--done-fg").trim()).not.toBe(
        root.getPropertyValue("--ok-fg").trim(),
      );
      expect(root.getPropertyValue("--done-fg").trim()).not.toBe(
        root.getPropertyValue("--fg-2").trim(),
      );
    },
  );
});
