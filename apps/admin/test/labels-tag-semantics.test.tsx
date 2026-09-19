import { describe, expect, it } from "vitest";

import { PURPOSE_TO_TONE } from "../src/pages/labels/index.js";

describe("семантика тегов карточки шаблона этикетки", () => {
  /**
   * Назначение шаблона — самая широкая категорийная ось в продукте: три
   * равноправных значения. Ни одно из них не может быть серым.
   */
  it("красит три назначения тремя разными категорийными тонами", () => {
    const tones = [PURPOSE_TO_TONE.box, PURPOSE_TO_TONE.product_duplicate, PURPOSE_TO_TONE.pallet];

    expect(new Set(tones).size).toBe(3);
    for (const tone of tones) {
      expect(["violet", "teal", "magenta", "steel"]).toContain(tone);
    }
  });
});
