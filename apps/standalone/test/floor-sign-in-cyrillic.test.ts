import { describe, expect, it } from "vitest";

import {
  CYRILLIC_ROWS,
  eraseLetter,
  typeLetter,
  typeSpace,
} from "../src/floor/kit/cyrillic-keyboard.js";
import { NAME_QUERY_MAX_LENGTH } from "../src/floor/operator-search.js";

describe("the flat Cyrillic keyboard", () => {
  it("is ЙЦУКЕН in three rows, every letter once", () => {
    expect(CYRILLIC_ROWS.map((row) => row.join(""))).toEqual([
      "ЙЦУКЕНГШЩЗХЪ",
      "ФЫВАПРОЛДЖЭЁ",
      "ЯЧСМИТЬБЮ",
    ]);
    const letters = CYRILLIC_ROWS.flat();
    expect(new Set(letters).size).toBe(letters.length);
    // Every letter of the alphabet an operator's name is written with.
    for (const letter of "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ") expect(letters).toContain(letter);
  });

  it("writes a name as it is spelled: a capital at the start and after a space, small letters between", () => {
    let query = "";
    for (const letter of "АННА") query = typeLetter(query, letter);
    expect(query).toBe("Анна");
    query = typeSpace(query);
    for (const letter of "КУЗНЕЦОВА") query = typeLetter(query, letter);
    expect(query).toBe("Анна Кузнецова");
  });

  it("takes a space only after a letter, once, and never at the end of a full field", () => {
    expect(typeSpace("")).toBe("");
    expect(typeSpace("Анна ")).toBe("Анна ");
    expect(typeSpace("Анна")).toBe("Анна ");
    const full = "а".repeat(NAME_QUERY_MAX_LENGTH);
    expect(typeSpace(full)).toBe(full);
    expect(typeLetter(full, "Б")).toBe(full);
  });

  it("«Стереть» drops the last character, a space included, and nothing from an empty field", () => {
    expect(eraseLetter("Анна К")).toBe("Анна ");
    expect(eraseLetter("Анна ")).toBe("Анна");
    expect(eraseLetter("")).toBe("");
    // A letter outside the BMP is one character.
    expect(eraseLetter("А\u{1F600}")).toBe("А");
  });

  it("does not write a character that is not a key of the layout", () => {
    expect(typeLetter("", "Q")).toBe("");
    expect(typeLetter("", "1")).toBe("");
  });
});
