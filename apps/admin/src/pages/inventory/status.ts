import type { TagPhase } from "@markiro/ui";

import type { Inventory } from "./schemas.js";

/**
 * Единая карта статус → фаза чипа для инвентаризации во всём разделе
 * (список, деталь, шапка «в работе»).
 *
 * `ready` здесь — «готова к запуску», ожидание старта человеком, а значит
 * `planned`, а не `done`: не путать с одноимённым статусом прогона документа
 * (`InventoryDocuments.tsx`, `statusPhase`), где `ready` означает завершённый
 * артефакт.
 *
 * `preparing` — идёт активная сборка выписок ЧЗ и параметров (`draft` и
 * `preparing` вместе составляют `MUTABLE_INVENTORY_STATUSES` на бэкенде), это
 * ещё не готовность и не сам счёт, а текущая обработка — `running`, как и у
 * прогона документа в статусе `processing`.
 *
 * `running` (буквальный статус инвентаризации, «В работе») — сам подсчёт идёт
 * на линии прямо сейчас: тот же смысл, что у активной смены
 * (`SHIFT_STATUS_TO_PHASE.active` в `pages/shifts/index.tsx`), поэтому
 * `active`, а не одноимённая фаза `running`.
 *
 * `closed` — подсчёт окончен, но администратор ещё может обработать поздние
 * события и обязан перевести инвентаризацию в `completed`
 * (`InventoryLateEvents` включает возможность исключения решений только пока
 * статус `closed`); это состояние, требующее действия, а не финал —
 * `attention`, а не `done`.
 *
 * `cancelled` — отмена возможна только до старта подсчёта
 * (`InventoryLifecycleService.cancel`), решение человека без тревоги
 * (`retired`), а не сбой (`failed`).
 */
export const INVENTORY_STATUS_TO_PHASE: Record<Inventory["status"], TagPhase> = {
  draft: "draft",
  preparing: "running",
  ready: "planned",
  cancelled: "retired",
  running: "active",
  closed: "attention",
  completed: "done",
};

export function inventoryStatusChipProps(status: Inventory["status"]): { phase: TagPhase } {
  return { phase: INVENTORY_STATUS_TO_PHASE[status] };
}
