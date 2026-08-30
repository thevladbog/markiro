import type { StatusChipStatus } from "@markiro/ui";

import type { Inventory } from "./schemas.js";

/** Единая карта тон+глиф для чипов статуса инвентаризации во всём разделе. */
export const INVENTORY_STATUS_CHIP: Record<
  Inventory["status"],
  { status: StatusChipStatus; glyph: string }
> = {
  draft: { status: "neutral", glyph: "–" },
  preparing: { status: "warn", glyph: "◷" },
  ready: { status: "info", glyph: "●" },
  cancelled: { status: "error", glyph: "×" },
  running: { status: "ok", glyph: "✓" },
  closed: { status: "neutral", glyph: "■" },
  completed: { status: "neutral", glyph: "✓" },
};

export function inventoryStatusChipProps(status: Inventory["status"]) {
  return INVENTORY_STATUS_CHIP[status];
}

/**
 * Вердикты, которые синхронизация пишет в `inventory_scan_events`
 * (`station-inventory-sync.service.ts`): `pending` при приёме пачки, затем
 * `rejected`, либо `applied`/`duplicate` после разбора притязаний. Скан без
 * строки результата (например, `old_box`) приходит с `classification: null`,
 * и вердикт — единственное, что можно показать в чипе.
 */
export const INVENTORY_EVENT_VERDICT_CHIP = {
  pending: "info",
  applied: "ok",
  duplicate: "warn",
  rejected: "error",
} as const satisfies Record<string, StatusChipStatus>;

export type InventoryEventVerdict = keyof typeof INVENTORY_EVENT_VERDICT_CHIP;

/**
 * Колонка вердикта — свободный текст (`authoritativeVerdict: string`), поэтому
 * незнакомое значение не должно уходить в `t()`: в тестовой среде отсутствующий
 * ключ бросает исключение (`i18n/index.ts`).
 */
export function isInventoryEventVerdict(value: string): value is InventoryEventVerdict {
  return Object.hasOwn(INVENTORY_EVENT_VERDICT_CHIP, value);
}
