import { describe, expect, it } from "vitest";
import { orgInitials } from "../src/pages/auth/org-initials.js";

describe("orgInitials", () => {
  it.each([
    ["ООО РЭБЕЛ ЭППЛ", "РЭ"],
    ['ООО "РЭБЕЛ ЭППЛ"', "РЭ"],
    ["Тестовый тенант", "ТТ"],
    ["ИП Иванов", "ИВ"],
    ["Атолл", "АТ"],
    ["ООО", "ОО"],
    ['"', "?"],
  ])("%s → %s", (name, expected) => {
    expect(orgInitials(name)).toBe(expected);
  });
});
