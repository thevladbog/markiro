import { describe, expect, it } from "vitest";

import {
  clipWithEllipsis,
  estimatedLineCount,
  estimatedTextWidthMm,
  WRAP_ELLIPSIS,
  wrapTextToWidth,
} from "../src/index.js";

/** A deterministic stand-in for a canvas: every glyph is exactly 1 unit wide,
 * so a width is simply a character count and every expectation below can be
 * read off the string. */
const monospace = (s: string) => s.length;

describe("wrapTextToWidth", () => {
  it("returns the text untouched when it already fits", () => {
    expect(wrapTextToWidth("Пиво", monospace, 10)).toEqual(["Пиво"]);
  });

  it("clips to one line with an ellipsis when maxLines defaults to 1", () => {
    const lines = wrapTextToWidth("Пиво светлое пастеризованное", monospace, 10);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(10);
    expect(lines[0]!.endsWith(WRAP_ELLIPSIS)).toBe(true);
  });

  it("wraps on word boundaries up to maxLines", () => {
    expect(wrapTextToWidth("Пиво светлое 0,5 л", monospace, 13, 2)).toEqual([
      "Пиво светлое",
      "0,5 л",
    ]);
  });

  it("ellipsizes the last line when the text needs more lines than allowed", () => {
    const lines = wrapTextToWidth("aaa bbb ccc ddd eee", monospace, 7, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("aaa bbb");
    expect(lines[1]!.endsWith(WRAP_ELLIPSIS)).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(7);
  });

  it("hard-breaks a single word wider than the whole line", () => {
    expect(wrapTextToWidth("Жигулёвскоеоригинальное", monospace, 8, 3)).toEqual([
      "Жигулёвс",
      "коеориги",
      "нальное",
    ]);
  });

  it("never exceeds the width, whatever the input", () => {
    const inputs = [
      "Пиво светлое пастеризованное Жигулёвское Оригинальное 0,5 л",
      "ААААААААААААААААААААААААААААААААААА",
      "a b c d e f g h i j k l m n o p",
      "   ",
      "",
    ];
    for (const text of inputs) {
      for (const maxLines of [1, 2, 4]) {
        for (const line of wrapTextToWidth(text, monospace, 9, maxLines)) {
          expect(line.length, `"${text}" @${maxLines}`).toBeLessThanOrEqual(9);
        }
      }
    }
  });

  it("passes text through unbounded when the width is not usable", () => {
    expect(wrapTextToWidth("anything at all", monospace, 0, 3)).toEqual(["anything at all"]);
    expect(wrapTextToWidth("anything at all", monospace, Number.NaN, 3)).toEqual([
      "anything at all",
    ]);
  });
});

describe("clipWithEllipsis", () => {
  it("always marks the truncation", () => {
    expect(clipWithEllipsis("abcdefgh", monospace, 5)).toBe(`abcd${WRAP_ELLIPSIS}`);
  });

  it("returns empty when not even the ellipsis fits", () => {
    expect(clipWithEllipsis("abcdefgh", monospace, 0)).toBe("");
  });
});

describe("estimatedTextWidthMm / estimatedLineCount", () => {
  it("estimates a 10pt Cyrillic product name well past a 54mm content width", () => {
    const name = "Пиво светлое пастеризованное Жигулёвское Оригинальное 0,5 л";
    expect(estimatedTextWidthMm(name, 10)).toBeGreaterThan(54);
    expect(estimatedLineCount(name, 10, 54, 2)).toBe(2);
  });

  it("is one line without a maxWidthMm, and never more than maxLines", () => {
    expect(estimatedLineCount("x".repeat(500), 10, undefined, 4)).toBe(1);
    expect(estimatedLineCount("x".repeat(500), 10, 10, 4)).toBe(4);
    expect(estimatedLineCount("x", 10, 10, undefined)).toBe(1);
  });

  it("counts lines by actually packing words, the same way wrapTextToWidth does -- not by an aggregate totalWidth/maxWidth ratio", () => {
    // Three 3-char words at a width that fits 6 estimated characters: none of
    // "aaa aaa" (7 chars) fits, so each word needs its own line -- 3 lines.
    // The aggregate calculation this regresses against would instead compute
    // ceil(totalWidth / maxWidth) = ceil(11 chars / 6 chars) = 2, undercounting
    // by a line.
    const fontSizePt = 10;
    const charWidthMm = estimatedTextWidthMm("a", fontSizePt);
    const maxWidthMm = charWidthMm * 6;
    expect(estimatedLineCount("aaa aaa aaa", fontSizePt, maxWidthMm, 3)).toBe(3);
  });
});
