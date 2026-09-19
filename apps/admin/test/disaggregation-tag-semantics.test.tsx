import { describe, expect, it } from "vitest";

import {
  DOCUMENT_STATUS_TO_PHASE,
  LINE_STATUS_TO_PHASE,
} from "../src/pages/disaggregation/DocumentDetail.js";

describe("семантика тегов дезагрегации", () => {
  /**
   * Отменённый документ получал тон `warn`, а вместе с ним — глиф дубликата
   * `⧉`. Это самый наглядный случай того, как глиф выводился из тона.
   */
  it("не даёт отменённому документу глиф дубликата", () => {
    expect(DOCUMENT_STATUS_TO_PHASE.cancelled).toBe("retired");
    expect(DOCUMENT_STATUS_TO_PHASE.cancelled).not.toBe("duplicate");
  });

  it("даёт применённому документу тон завершения", () => {
    expect(DOCUMENT_STATUS_TO_PHASE.applied).toBe("done");
  });

  it("оставляет черновик черновиком", () => {
    expect(DOCUMENT_STATUS_TO_PHASE.draft).toBe("draft");
  });

  it("отличает настоящий дубликат строки от прочих предупреждений", () => {
    expect(LINE_STATUS_TO_PHASE.duplicate).toBe("duplicate");
    expect(LINE_STATUS_TO_PHASE.not_closed).toBe("attention");
    expect(LINE_STATUS_TO_PHASE.shift_open).toBe("attention");
  });

  it("разводит ненайденный и списанный код по терминальным фазам", () => {
    expect(LINE_STATUS_TO_PHASE.not_found).toBe("failed");
    expect(LINE_STATUS_TO_PHASE.written_off).toBe("retired");
  });
});
