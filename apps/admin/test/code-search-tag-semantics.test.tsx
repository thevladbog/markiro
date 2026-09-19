import { describe, expect, it } from "vitest";

import { BOX_STATUS_TO_PHASE } from "../src/pages/code-search/BoxCard.js";
import {
  PALLET_STATUS_TO_PHASE,
  PALLET_KIND_TO_TONE,
} from "../src/pages/code-search/PalletCard.js";
import { CHZ_STATUS_TO_PHASE, CODE_STATUS_TO_PHASE } from "../src/pages/code-search/CodeCard.js";

describe("семантика тегов поиска по коду", () => {
  /**
   * «Открыт» у короба и «Активна» у смены — одно понятие. Раньше короб был
   * синим с глифом синхронизации, а смена зелёной с галочкой.
   */
  it("выравнивает открытый короб и открытую паллету по фазе active", () => {
    expect(BOX_STATUS_TO_PHASE.open).toBe("active");
    expect(PALLET_STATUS_TO_PHASE.open).toBe("active");
  });

  it("даёт закрытому коробу и паллете тон завершения", () => {
    expect(BOX_STATUS_TO_PHASE.closed).toBe("done");
    expect(PALLET_STATUS_TO_PHASE.closed).toBe("done");
  });

  it("отличает расформирование от завершения", () => {
    expect(BOX_STATUS_TO_PHASE.disassembled).toBe("dismantled");
    expect(PALLET_STATUS_TO_PHASE.disassembled).toBe("dismantled");
  });

  it("не оставляет ни одному виду паллеты серый тон", () => {
    const tones = Object.values(PALLET_KIND_TO_TONE);
    expect(new Set(tones).size).toBe(tones.length);
    for (const tone of tones) {
      expect(["violet", "teal", "magenta", "steel"]).toContain(tone);
    }
  });

  /**
   * Уникальность и членство в наборе выше не ловят перестановку: production
   * и warehouse могли бы поменяться тонами местами и тест остался бы
   * зелёным. Закрепляем точную пару.
   */
  it("закрепляет точную пару вид паллеты -> тон", () => {
    expect(PALLET_KIND_TO_TONE.production).toBe("violet");
    expect(PALLET_KIND_TO_TONE.warehouse).toBe("teal");
  });

  it("раскладывает состояния кода по фазам", () => {
    expect(CODE_STATUS_TO_PHASE.free).toBe("active");
    expect(CODE_STATUS_TO_PHASE.aggregated).toBe("done");
    expect(CODE_STATUS_TO_PHASE.written_off).toBe("retired");
  });

  /**
   * До ветки шесть статусов Честного знака различались цветом; плоский
   * `Badge tone="steel"` стёр различие. Три способа выбытия из оборота
   * делят фазу retired, а эмиссия, нанесение и ввод в оборот -- три разных
   * этапа жизни кода -- обязаны остаться различимы.
   */
  it("даёт трём статусам выбытия из оборота одну фазу Честного знака", () => {
    expect(CHZ_STATUS_TO_PHASE.get("RETIRED")).toBe("retired");
    expect(CHZ_STATUS_TO_PHASE.get("WRITTEN_OFF")).toBe("retired");
    expect(CHZ_STATUS_TO_PHASE.get("WITHDRAWN")).toBe("retired");
  });

  it("различает эмиссию, нанесение и ввод в оборот тремя разными фазами", () => {
    const emitted = CHZ_STATUS_TO_PHASE.get("EMITTED");
    const applied = CHZ_STATUS_TO_PHASE.get("APPLIED");
    const introduced = CHZ_STATUS_TO_PHASE.get("INTRODUCED");

    expect(emitted).toBe("planned");
    expect(applied).toBe("running");
    expect(introduced).toBe("active");
    expect(new Set([emitted, applied, introduced]).size).toBe(3);
  });
});
