import { describe, expect, it } from "vitest";

import { PICKUP_STATUS_TO_PHASE, DEVICE_KIND_TO_TONE } from "../src/pages/pickup/index.js";

describe("семантика тегов самовывоза", () => {
  /**
   * Ожидающая заявка — не предупреждение. Тон `warn` давал ей глиф дубликата
   * и уравнивал очередь с неисправностью.
   */
  it("не считает ожидание проблемой", () => {
    expect(PICKUP_STATUS_TO_PHASE.pending).toBe("planned");
  });

  it("даёт выданной заявке тон завершения", () => {
    expect(PICKUP_STATUS_TO_PHASE.punched).toBe("done");
  });

  it("разводит списание и отмену в одну терминальную фазу без тревоги", () => {
    expect(PICKUP_STATUS_TO_PHASE.writtenoff).toBe("retired");
    expect(PICKUP_STATUS_TO_PHASE.cancelled).toBe("retired");
  });

  it("красит виды устройства равногромкими категорийными тонами", () => {
    const tones = Object.values(DEVICE_KIND_TO_TONE);
    expect(new Set(tones).size).toBe(tones.length);
    for (const tone of tones) {
      expect(["violet", "teal", "magenta", "steel"]).toContain(tone);
    }
  });

  /**
   * Уникальность и членство в наборе выше не ловят перестановку: kiosk и
   * handheld могли бы поменяться тонами местами и тест остался бы зелёным.
   * Закрепляем точную пару.
   */
  it("закрепляет точную пару вид устройства -> тон", () => {
    expect(DEVICE_KIND_TO_TONE.kiosk).toBe("violet");
    expect(DEVICE_KIND_TO_TONE.handheld).toBe("teal");
  });
});
