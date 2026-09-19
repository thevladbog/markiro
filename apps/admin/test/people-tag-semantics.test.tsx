import { describe, expect, it } from "vitest";

import { EMPLOYEE_STATUS_TO_PHASE } from "../src/pages/employees/index.js";
import { DELIVERY_STATUS_TO_PHASE } from "../src/pages/team/TeamPage.js";

describe("семантика тегов людей и устройств", () => {
  it("отличает действующего сотрудника от выведенного", () => {
    expect(EMPLOYEE_STATUS_TO_PHASE.active).toBe("active");
    expect(EMPLOYEE_STATUS_TO_PHASE.archived).toBe("retired");
  });

  /**
   * Доставка приглашения — конвейер, и у него есть фаза «выполняется».
   * Раньше `sending` и `queued` были одинаково синими с глифом синхронизации.
   */
  it("разводит очередь и отправку по разным фазам", () => {
    expect(DELIVERY_STATUS_TO_PHASE.queued).toBe("planned");
    expect(DELIVERY_STATUS_TO_PHASE.sending).toBe("running");
    expect(DELIVERY_STATUS_TO_PHASE.retrying).toBe("attention");
  });

  it("считает доставленным и отправленным одну фазу завершения", () => {
    expect(DELIVERY_STATUS_TO_PHASE.sent).toBe("done");
    expect(DELIVERY_STATUS_TO_PHASE.delivered).toBe("done");
  });

  it("разводит сбой доставки и отмену", () => {
    expect(DELIVERY_STATUS_TO_PHASE.failed).toBe("failed");
    expect(DELIVERY_STATUS_TO_PHASE.canceled).toBe("retired");
  });
});
