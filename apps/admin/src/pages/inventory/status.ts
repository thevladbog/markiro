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
