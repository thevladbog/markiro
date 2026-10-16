import { describe, expect, it } from "vitest";

import { AVATAR_TONES, avatarTone, userInitials } from "../src/office/user-avatar.js";

describe("userInitials", () => {
  it("takes the first letters of the first two words, upper case", () => {
    expect(userInitials("Иван Петров")).toBe("ИП");
    expect(userInitials("  анна   Сергеевна  Ли ")).toBe("АС");
  });

  it("gives one letter for a one-word name and a dot for none", () => {
    expect(userInitials("ivan")).toBe("I");
    expect(userInitials("ё")).toBe("Ё");
    expect(userInitials("   ")).toBe("·");
  });

  it("keeps a letter outside the basic plane whole", () => {
    expect(userInitials("𝒜lex")).toBe("𝒜");
  });
});

describe("avatarTone", () => {
  it("is fixed by the name: the sum of the lower-case code points modulo 4", () => {
    // и(1080)+в(1074)+а(1072)+н(1085) = 4311 -> 3 -> steel
    expect(avatarTone("Иван")).toBe("steel");
    expect(avatarTone("ИВАН")).toBe("steel");
    // "a" = 97 -> 1 -> teal; "b" = 98 -> 2 -> magenta; "d" = 100 -> 0 -> violet
    expect(avatarTone("a")).toBe("teal");
    expect(avatarTone("B")).toBe("magenta");
    expect(avatarTone("d")).toBe("violet");
  });

  it("is the same call after call and always one of the four kit tones", () => {
    for (const name of ["Иван Петров", "Ирина Смирнова", "Павел Орлов", "", "x"]) {
      expect(avatarTone(name)).toBe(avatarTone(name));
      expect(AVATAR_TONES).toContain(avatarTone(name));
    }
    expect(avatarTone("")).toBe("violet");
  });
});
