import { z } from "zod";

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
 * - `itemCount` counts only items this box's own scans still own
 *   (`displaced_at IS NULL`) -- `box_items` rows are never deleted, so a
 *   naive `COUNT(*)` would include a code some other scan has since claimed
 *   (see BoxesService.listBoxes and boxItems' own schema comment).
 * - `contentsChangedAfterClose` is true when the box has an item whose
 *   `displaced_at` is later than its `closed_at`. A closed box is taped and
 *   labelled and cannot be corrected, so this is the only way a manager
 *   finds out it is one position short.
 */
export interface BoxDto {
  id: string;
  sscc: string | null;
  terminalId: string | null;
  operatorId: string | null;
  itemCount: number;
  closedAt: Date | null;
  contentsChangedAfterClose: boolean;
}

/** GET /boxes response. */
export interface ListBoxesResponseDto {
  items: BoxDto[];
}
