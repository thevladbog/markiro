import { describe, expect, it } from "vitest";
import { z } from "zod";

import { utf16BoundedString } from "../src/utf16-string.js";

describe("utf16BoundedString", () => {
  const schema = utf16BoundedString(2, 4);

  it("counts UTF-16 units, where an emoji is two and Zod's own max counts one", () => {
    expect(schema.safeParse("😀😀").success).toBe(true);
    expect(schema.safeParse("😀😀x").success).toBe(false);
    // The behaviour this guards against: Zod 4.5+ counts code points.
    expect(z.string().max(4).safeParse("😀😀😀").success).toBe(true);
    expect(schema.safeParse("😀😀😀").success).toBe(false);
  });

  it("takes a Cyrillic or ASCII text by its letters, both ends inclusive", () => {
    expect(schema.safeParse("яя").success).toBe(true);
    expect(schema.safeParse("abcd").success).toBe(true);
    expect(schema.safeParse("a").success).toBe(false);
    expect(schema.safeParse("abcde").success).toBe(false);
  });

  it("counts a lone surrogate as the one unit it is", () => {
    expect(schema.safeParse("\ud800x").success).toBe(true);
    expect(schema.safeParse("\ud800").success).toBe(false);
  });

  it("reports Zod's too_small and too_big issues, with the bound", () => {
    const short = schema.safeParse("😀".slice(0, 1));
    const long = schema.safeParse("😀😀😀");
    expect(short.error?.issues).toEqual([
      expect.objectContaining({ code: "too_small", origin: "string", minimum: 2, path: [] }),
    ]);
    expect(long.error?.issues).toEqual([
      expect.objectContaining({ code: "too_big", origin: "string", maximum: 4, path: [] }),
    ]);
  });

  it("refuses what is not a string, as z.string() does", () => {
    expect(schema.safeParse(42).error?.issues[0]?.code).toBe("invalid_type");
  });
});
