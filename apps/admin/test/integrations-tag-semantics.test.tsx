import { describe, expect, it } from "vitest";

import { CHANNEL_STATE_TO_PHASE } from "../src/pages/integrations/index.js";
import {
  TOKEN_STATUS_TO_PHASE,
  AGENT_STATUS_TO_PHASE,
  TOKEN_TYPE_TO_TONE,
} from "../src/pages/integrations/SignerAgentsPanel.js";

describe("семантика тегов интеграций", () => {
  it("отличает работающий канал от молчащего и от сломанного", () => {
    expect(CHANNEL_STATE_TO_PHASE.working).toBe("active");
    expect(CHANNEL_STATE_TO_PHASE.silent).toBe("attention");
    expect(CHANNEL_STATE_TO_PHASE.error).toBe("failed");
  });

  /**
   * Ненастроенный канал — единственный законный случай серого здесь:
   * значения нет и не ожидается.
   */
  it("оставляет ненастроенному каналу фазу отсутствия значения", () => {
    expect(CHANNEL_STATE_TO_PHASE.not_configured).toBe("none");
  });

  /**
   * Барьер против отката: недоступный канал не рисует адаптер, который ещё
   * не построен, как что-то, требующее вмешательства оператора -- у него нет
   * действия, которое можно предпринять с этой карточки (см. комментарий у
   * `CHANNEL_STATE_TO_PHASE`).
   */
  it("не считает недоступный канал поводом для вмешательства", () => {
    expect(CHANNEL_STATE_TO_PHASE.unavailable).not.toBe("attention");
  });

  it("делит фазу отсутствия значения между ненастроенным и недоступным каналом", () => {
    expect(CHANNEL_STATE_TO_PHASE.unavailable).toBe(CHANNEL_STATE_TO_PHASE.not_configured);
    expect(CHANNEL_STATE_TO_PHASE.unavailable).toBe("none");
  });

  it("разводит истекающий и истёкший токен", () => {
    expect(TOKEN_STATUS_TO_PHASE.expiring).toBe("attention");
    expect(TOKEN_STATUS_TO_PHASE.expired).toBe("failed");
    expect(TOKEN_STATUS_TO_PHASE.none).toBe("none");
  });

  it("считает отозванного агента выведенным, а не пустым", () => {
    expect(AGENT_STATUS_TO_PHASE.revoked).toBe("retired");
    expect(AGENT_STATUS_TO_PHASE.active).toBe("active");
  });

  /**
   * Ось типа токена обязана реально работать: JWT и UUID должны получать
   * разные тона, и именно ту пару, что задаёт фиксированный порядок
   * `violet, teal, magenta, steel` -- не только "разные", иначе тест
   * остаётся зелёным при случайной перестановке.
   */
  it("красит тип токена двумя разными категорийными тонами в фиксированном порядке", () => {
    expect(TOKEN_TYPE_TO_TONE.jwt).toBe("violet");
    expect(TOKEN_TYPE_TO_TONE.uuid).toBe("teal");
    expect(TOKEN_TYPE_TO_TONE.jwt).not.toBe(TOKEN_TYPE_TO_TONE.uuid);
  });
});
