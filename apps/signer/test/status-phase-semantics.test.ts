import { describe, expect, it } from "vitest";
import { SIGNER_PHASE_TO_TAG_PHASE } from "../src/pages/Status.js";

describe("семантика фаз статуса подписанта", () => {
  it("даёт каждому из шести состояний агента предписанную фазу", () => {
    expect(SIGNER_PHASE_TO_TAG_PHASE.unpaired).toBe("planned");
    expect(SIGNER_PHASE_TO_TAG_PHASE.idle).toBe("active");
    expect(SIGNER_PHASE_TO_TAG_PHASE.reconnecting).toBe("attention");
    expect(SIGNER_PHASE_TO_TAG_PHASE.unavailable).toBe("failed");
    expect(SIGNER_PHASE_TO_TAG_PHASE.working).toBe("running");
    expect(SIGNER_PHASE_TO_TAG_PHASE.degraded).toBe("attention");
  });

  /**
   * Minor 2 (final review): привязка агента ожидается, а не отсутствует --
   * `unpaired` не может быть `none` ("значения нет и не ожидается"). Тот же
   * факт в кабинете (`deviceStatusPhase`'s `awaiting_pairing`) уже даёт
   * `planned`.
   */
  it("не читает непривязанного агента как «значения нет и не ожидается»", () => {
    expect(SIGNER_PHASE_TO_TAG_PHASE.unpaired).not.toBe("none");
  });

  /**
   * Задача 15: подпись `status.phase.degraded` раньше читалась как «ошибка» —
   * ровно определение фазы `failed` в словаре фаз, — хотя сама фаза уже
   * `attention`. Барьер против отката: деградация не должна снова стать
   * неотличимой от подлинной недоступности (`unavailable`, у которой `failed`
   * законно).
   */
  it("не путает деградацию (attention) с недоступностью (failed)", () => {
    expect(SIGNER_PHASE_TO_TAG_PHASE.degraded).not.toBe("failed");
    expect(SIGNER_PHASE_TO_TAG_PHASE.unavailable).toBe("failed");
    expect(SIGNER_PHASE_TO_TAG_PHASE.degraded).not.toBe(SIGNER_PHASE_TO_TAG_PHASE.unavailable);
  });
});
