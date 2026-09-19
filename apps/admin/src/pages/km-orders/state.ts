import type { TagPhase } from "@markiro/ui";

import type { KmOrderState } from "./schemas.js";

/**
 * Единая карта состояние заказа → фаза чипа, общая для списка и карточки,
 * как `../inventory/status.ts` для своего раздела.
 *
 * Все шесть состояний в полёте — `running`, и по тому же критерию, каким
 * пользуется инвентаризация: `running` — это обработка на стороне системы с
 * заранее неизвестным исходом, а `active` — открытая работа людей. Здесь
 * работает фоновый воркер: подписать, отправить в СУЗ, дождаться буфера,
 * вытянуть коды. Оператор не может повлиять ни на одно из них, только ждать,
 * поэтому различие между «Подписание» и «Ожидание буфера» несёт переведённая
 * подпись, а не цвет.
 *
 * `created` тоже `running`, а не `planned`: заказ ставится в очередь тем же
 * запросом, что его создаёт, так что ожидания решения человека здесь нет.
 *
 * `rejected` и `failed` оба `failed`: исход терминальный и отрицательный.
 * `retired` не подходит — его смысл «отозвано человеком», а отказ СУЗ и сбой
 * прогона человек не выбирал.
 *
 * Глиф теперь приходит из самого `StatusChip` по фазе (спека тегов
 * 2026-09-19), поэтому своего глифа карта больше не несёт.
 */
export const KM_ORDER_STATE_PHASE: Record<KmOrderState, TagPhase> = {
  created: "running",
  signing: "running",
  submitted: "running",
  buffer_pending: "running",
  buffer_active: "running",
  fetching: "running",
  completed: "done",
  rejected: "failed",
  failed: "failed",
};

export function kmOrderStatePhase(state: KmOrderState): TagPhase {
  return KM_ORDER_STATE_PHASE[state];
}
