import { describe, expect, it } from "vitest";

import { SHIFT_STATUS_TO_PHASE, SHIFT_MODE_TO_TONE } from "../src/pages/shifts/index.js";

describe("семантика тегов смены", () => {
  /**
   * Закрытая смена — не архив, а штатно завершённая работа. Серый читается
   * как «сущности больше нет», и именно с этой жалобы начался разбор.
   */
  it("даёт закрытой смене тон завершения, а не серый", () => {
    expect(SHIFT_STATUS_TO_PHASE.closed).toBe("done");
  });

  it("даёт активной смене фазу active, а не галочку", () => {
    expect(SHIFT_STATUS_TO_PHASE.active).toBe("active");
  });

  it("даёт запланированной смене фазу ожидания", () => {
    expect(SHIFT_STATUS_TO_PHASE.planned).toBe("planned");
  });

  /**
   * Валидация и агрегация — два равноправных режима, а не хороший и плохой.
   * Оба обязаны получить категорийный тон; ни один не может быть серым.
   */
  it("красит оба режима смены равногромкими категорийными тонами", () => {
    const tones = [SHIFT_MODE_TO_TONE.validation, SHIFT_MODE_TO_TONE.aggregation];

    expect(new Set(tones).size).toBe(2);
    for (const tone of tones) {
      expect(["violet", "teal", "magenta", "steel"]).toContain(tone);
    }
  });
});
