import { z } from "zod";
import { parseScannedSscc } from "@markiro/domain";

/**
 * GET /boxes query schema. A box list only ever makes sense scoped to one
 * shift (there is no cross-shift "all my boxes" view), so `shiftId` is
 * required, unlike `/conflicts`'s optional filter.
 */
export const listBoxesQuerySchema = z.object({
  shiftId: z.string().uuid(),
});
export type ListBoxesQueryDto = z.infer<typeof listBoxesQuerySchema>;

/**
 * Mirrors one `boxes` row (Task 3, corrected in Task 10/13) plus a live
 * aggregate over its `box_items`:
 *
 * - `itemCount` counts only items this box's own scans still own AND that no
 *   operator exception has removed (`displaced_at IS NULL AND removed_at IS
 *   NULL`, Task 7) -- `box_items` rows are never deleted, so a naive
 *   `COUNT(*)` would include a code some other scan has since claimed
 *   (`displaced_at`) or one an "undo"/"clear"/"disassemble" exception has
 *   released (`removed_at`) (see BoxesService.listBoxes and boxItems' own
 *   schema comment).
 * - `contentsChangedAfterClose` is true when the box has an item whose
 *   `displaced_at` is later than its `closed_at`. A closed box is taped and
 *   labelled and cannot be corrected, so this is the only way a manager
 *   finds out it is one position short.
 * - `disassembledAt` (Task 7) mirrors the box's own retirement (see
 *   station-scans.service.ts's "disassemble" branch): non-null once an
 *   operator has retired an already-closed box, so a cabinet UI can exclude
 *   it from an "active boxes" view.
 */
export interface BoxDto {
  id: string;
  /** 20-значный код с GS1 AI "00" (требование Честного знака); в БД хранится голый 18-значный SSCC. */
  sscc: string | null;
  terminalId: string | null;
  /** Assigned production line of the station that reported this box. */
  lineName: string | null;
  operatorId: string | null;
  itemCount: number;
  closedAt: Date | null;
  contentsChangedAfterClose: boolean;
  disassembledAt: Date | null;
}

/** GET /boxes response. */
export interface ListBoxesResponseDto {
  items: BoxDto[];
}

/**
 * GET /boxes/sell-codes query. Accepts whatever the cashier's camera or
 * keyboard produced -- `parseScannedSscc` strips the `]C1` AIM prefix,
 * a printed `(00)` and the bare `00` AI, and validates the check digit --
 * so the stored bare-18-digit form is what reaches the service.
 */
export const sellCodesQuerySchema = z.object({
  sscc: z.string().transform((value, ctx) => {
    const parsed = parseScannedSscc(value.trim());
    if (parsed === null) {
      ctx.addIssue({ code: "custom", message: "invalid_sscc" });
      return z.NEVER;
    }
    return parsed;
  }),
});
export type SellCodesQueryDto = z.infer<typeof sellCodesQuerySchema>;

/** One live code of a sellable box; `rawKm` feeds `renderDataMatrixSvg` client-side. */
export interface BoxSellCodeItemDto {
  codeHash: string;
  rawKm: string;
  gtin14: string;
  serial: string;
}

/** GET /boxes/sell-codes response. `sscc` is AI-00-prefixed (20 digits), as everywhere cabinet-facing. */
export interface BoxSellCodesDto {
  boxId: string;
  sscc: string;
  productName: string;
  itemCount: number;
  items: BoxSellCodeItemDto[];
}
