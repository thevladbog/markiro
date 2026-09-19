import { describe, expect, it } from "vitest";

import { CHANNEL_STATE_TO_PHASE } from "../src/pages/integrations/index.js";
import {
  TOKEN_STATUS_TO_PHASE,
  AGENT_STATUS_TO_PHASE,
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

  it("считает недоступность поводом для внимания, а не справкой", () => {
    expect(CHANNEL_STATE_TO_PHASE.unavailable).toBe("attention");
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
});
