import { describe, expect, it } from "vitest";
import en from "../src/i18n/en.json";
import ru from "../src/i18n/ru.json";

function keys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("i18n dictionaries", () => {
  it("have the same keys in Russian and English", () => {
    expect(keys(en).sort()).toEqual(keys(ru).sort());
  });
});
