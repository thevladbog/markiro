import { z } from "zod";
import type { BoxConflictReason, OrderConflict } from "../pickup-orders/dto";

/**
 * The kiosk's own six refusal reasons plus `unknown_badge` and
 * `unknown_reason`, which only this table can carry: both fire before any
 * item is examined (unrecognised badge at step 2, an unknown/archived
 * writeoff reason at step 3), so neither can appear in `POST /kiosk/orders`'
 * response and must not widen `OrderConflict`.
 */
export type ScanRejectionReason =
  | OrderConflict["reason"]
  | BoxConflictReason
  | "unknown_badge"
  | "unknown_reason"
  | "writeoff_reason_required"
  | "writeoff_forbidden";

export type ScanRejectionCode =
  | { rawKm: string; reason: ScanRejectionReason }
  | {
      source: "box";
      sscc: string;
      bottleCount: number | null;
      reason: ScanRejectionReason;
    };

/** `YYYY-MM-DD`. */
const dateOnlySchema = z.string().date();

/**
 * `GET /pickup-rejections` query. `from`/`to` filter on `syncedAt` -- when
 * the server learned -- inclusive whole days, matching the list's own sort.
 */
export const listPickupRejectionsQuerySchema = z.object({
  kioskId: z.string().uuid().optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  state: z.enum(["open", "acknowledged", "all"]).default("all"),
});
export type ListPickupRejectionsQueryDto = z.infer<typeof listPickupRejectionsQuerySchema>;

export interface PickupScanRejectionRowDto {
  id: string;
  /** Derived from `employeeId === null`; the DB check constraint keeps it honest. */
  kind: "items_refused" | "unknown_badge";
  kioskId: string;
  kioskName: string;
  employeeName: string | null;
  badgeCode: string | null;
  orderId: string | null;
  orderNo: string | null;
  deviceSeq: number;
  codes: ScanRejectionCode[];
  scannedAt: Date;
  syncedAt: Date;
  acknowledgedAt: Date | null;
}

/**
 * `openCount` counts EVERY unacknowledged rejection in the tenant and
 * ignores the query's filters: it feeds the свод banner, which needs a
 * stable global number rather than the size of whatever the admin last
 * filtered to.
 */
export interface ListPickupRejectionsResponseDto {
  items: PickupScanRejectionRowDto[];
  openCount: number;
}
