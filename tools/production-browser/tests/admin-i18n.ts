import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Selector text for the cabinet evidence suites comes from the app's own
 * dictionaries rather than a hand-kept copy: the same key then resolves to
 * whatever the cabinet actually renders in that locale, and a renamed string
 * breaks the test instead of silently shooting the wrong screen. Read as JSON
 * because this project runs with `--ignore-workspace` and cannot import the
 * app's modules.
 */
export type AdminLocale = "ru" | "en";

const DICTIONARIES = new Map<AdminLocale, Record<string, unknown>>();

function dictionary(locale: AdminLocale): Record<string, unknown> {
  const cached = DICTIONARIES.get(locale);
  if (cached) return cached;
  const source = readFileSync(
    join(import.meta.dirname, `../../../apps/admin/src/i18n/${locale}.json`),
    "utf8",
  );
  const parsed = JSON.parse(source) as Record<string, unknown>;
  DICTIONARIES.set(locale, parsed);
  return parsed;
}

export function adminI18n(locale: AdminLocale) {
  const dict = dictionary(locale);
  return {
    t(key: string, params: Record<string, string | number> = {}): string {
      const value = key
        .split(".")
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown> | undefined)?.[part],
          dict,
        );
      if (typeof value !== "string") throw new Error(`Missing admin i18n key: ${locale}/${key}`);
      return value.replaceAll(/\{\{(\w+)\}\}/gu, (match, name: string) =>
        name in params ? String(params[name]) : match,
      );
    },
  };
}
