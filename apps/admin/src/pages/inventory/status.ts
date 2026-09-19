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
 * Критерий, отделяющий фазу `running` от фазы `active` в этой таблице:
 * `running` — обработка на стороне системы с исходом, не известным заранее
 * (job); `active` — открытая операционная деятельность людей с видимым
 * ходом, а не системный job. Ниже — почему `preparing` подпадает под первое,
 * а буквальный статус `running` — под второе, хотя слово совпадает только со
 * вторым.
 *
 * `preparing` — окно загрузки выписок ЧЗ: каждая загрузка запускает разбор
 * файла на бэкенде (`InventoriesService.importEvidence` →
 * `parseChzImport`), результат которого заранее не известен (успех или
 * `ChzImportError` с кодом), а выход из `preparing` в `ready` происходит
 * через ещё одну системную обработку с непредсказуемым исходом
 * (`InventorySnapshotService.fix` — повторный разбор всех файлов,
 * дедупликация кодов, может бросить `INVENTORY_SNAPSHOT_IMPORT_INVALID` и
 * другие коды). Человек в этом окне может отредактировать параметры
 * (`draft` и `preparing` вместе составляют `MUTABLE_INVENTORY_STATUSES` на
 * бэкенде), но не редактирование определяет состояние — его определяет
 * системная обработка с неизвестным исходом. Тот же критерий, что у
 * `processing` в прогоне документа. → `running`.
 *
 * `running` (буквальный статус инвентаризации, «В работе») — сам подсчёт идёт
 * на линии прямо сейчас силами операторов сканирования: открытая
 * операционная деятельность людей с видимым ходом, а не системный job с
 * неопределённым исходом. Тот же смысл, что у активной смены
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
