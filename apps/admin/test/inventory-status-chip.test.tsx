import { describe, expect, it } from "vitest";

import { INVENTORY_STATUS_TO_PHASE } from "../src/pages/inventory/status.js";

describe("inventory status chips", () => {
  it("gives every status a distinct phase", () => {
    const phases = Object.values(INVENTORY_STATUS_TO_PHASE);
    expect(new Set(phases).size).toBe(phases.length);
  });

  it("separates closed from ready and keeps running green", () => {
    // `ready` -- «готова к запуску», ожидание старта человеком -- `planned`,
    // не завершённый результат (`done`), которым было бы одноимённое
    // состояние прогона документа.
    expect(INVENTORY_STATUS_TO_PHASE.ready).toBe("planned");
    // Отмена возможна только до старта подсчёта: решение человека, а не сбой
    // системы -- `retired`, не `failed`.
    expect(INVENTORY_STATUS_TO_PHASE.cancelled).toBe("retired");
    // Счёт окончен, но администратор ещё обязан обработать поздние события и
    // закрыть инвентаризацию -- `closed` остаётся отдельным от `ready` и от
    // `completed`.
    expect(INVENTORY_STATUS_TO_PHASE.closed).not.toBe(INVENTORY_STATUS_TO_PHASE.ready);
    expect(INVENTORY_STATUS_TO_PHASE.closed).not.toBe(INVENTORY_STATUS_TO_PHASE.completed);
    // Буквальный статус «В работе» -- подсчёт идёт на линии прямо сейчас, тот
    // же смысл, что у активной смены: `active`, зелёный.
    expect(INVENTORY_STATUS_TO_PHASE.running).toBe("active");
  });
});
