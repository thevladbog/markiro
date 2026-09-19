import { describe, expect, it } from "vitest";

import { BOX_STATUS_TO_PHASE } from "../src/pages/code-search/BoxCard.js";
import {
  PALLET_STATUS_TO_PHASE,
  PALLET_KIND_TO_TONE,
} from "../src/pages/code-search/PalletCard.js";
import { CODE_STATUS_TO_PHASE } from "../src/pages/code-search/CodeCard.js";

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

  it("раскладывает состояния кода по фазам", () => {
    expect(CODE_STATUS_TO_PHASE.free).toBe("active");
    expect(CODE_STATUS_TO_PHASE.aggregated).toBe("done");
    expect(CODE_STATUS_TO_PHASE.written_off).toBe("retired");
  });
});
