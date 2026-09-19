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

  /**
   * `LINE_STATUS_TO_PHASE` -- индексная сигнатура `Record<string, TagPhase>`,
   * а не замкнутый союз, потому что строка документа может прийти с любым
   * значением статуса от API. Единственный барьер, который ловит незнакомое
   * значение, стоит в точке вызова: `LINE_STATUS_TO_PHASE[line.status] ??
   * "none"`. Без этого теста опечатка в статусе тихо роняет тег в
   * `undefined`, а не в безопасный `none`.
   */
  it("сворачивает незнакомый статус строки в фазу none на точке вызова", () => {
    expect(LINE_STATUS_TO_PHASE["unknown_status_from_api"]).toBeUndefined();
    expect(LINE_STATUS_TO_PHASE["unknown_status_from_api"] ?? "none").toBe("none");
  });
});
