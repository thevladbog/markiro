import type { StatusChipStatus } from "@markiro/ui";

import type { KmOrderState } from "./schemas.js";

/**
 * One tone+glyph map for the order-state chip, shared by the list and the
 * order card the way `../inventory/status.ts` is shared across its section.
 *
 * Every in-flight state is the same `info` tone on purpose -- an operator
 * cannot act on the difference between «Подписание» and «Ожидание буфера»,
 * only wait -- so the glyph and the translated label carry the distinction
 * and colour never carries it alone.
 */
export const KM_ORDER_STATE_CHIP: Record<
  KmOrderState,
  { status: StatusChipStatus; glyph: string }
> = {
  created: { status: "info", glyph: "◷" },
  signing: { status: "info", glyph: "✎" },
  submitted: { status: "info", glyph: "↑" },
  buffer_pending: { status: "info", glyph: "◷" },
  buffer_active: { status: "info", glyph: "●" },
  fetching: { status: "info", glyph: "⟳" },
  completed: { status: "ok", glyph: "✓" },
  rejected: { status: "error", glyph: "✕" },
  failed: { status: "error", glyph: "!" },
};

export function kmOrderStateChipProps(state: KmOrderState) {
  return KM_ORDER_STATE_CHIP[state];
}
