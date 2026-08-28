import type { SchemaObject } from "@nestjs/swagger";
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

// --- OpenAPI response schemas (hand-written: the response DTOs above are ---
// --- interfaces, not zod schemas; see inventories/dto.ts for the pattern) ---

/** Every `ScanRejectionReason` member: item and box refusals plus the pre-item ones. */
const scanRejectionReasonEnum = [
  "not_km",
  "incomplete",
  "unknown_product",
  "not_allowed",
  "duplicate",
  "over_limit",
  "unknown_box",
  "box_not_closed",
  "box_disassembled",
  "box_contents_changed",
  "mixed_product_box",
  "unknown_badge",
  "unknown_reason",
  "writeoff_reason_required",
  "writeoff_forbidden",
] as const satisfies readonly ScanRejectionReason[];

const scanRejectionCodeOpenApiSchema: SchemaObject = {
  oneOf: [
    {
      type: "object",
      required: ["rawKm", "reason"],
      properties: {
        rawKm: { type: "string" },
        reason: { type: "string", enum: [...scanRejectionReasonEnum] },
      },
    },
    {
      type: "object",
      required: ["source", "sscc", "bottleCount", "reason"],
      properties: {
        source: { type: "string", enum: ["box"] },
        sscc: { type: "string", pattern: "^[0-9]{18}$" },
        bottleCount: { type: "integer", nullable: true },
        reason: { type: "string", enum: [...scanRejectionReasonEnum] },
      },
    },
  ],
};

export const pickupScanRejectionRowOpenApiSchema: SchemaObject = {
  type: "object",
  required: [
    "id",
    "kind",
    "kioskId",
    "kioskName",
    "employeeName",
    "badgeCode",
    "orderId",
    "orderNo",
    "deviceSeq",
    "codes",
    "scannedAt",
    "syncedAt",
    "acknowledgedAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    kind: { type: "string", enum: ["items_refused", "unknown_badge"] },
    kioskId: { type: "string", format: "uuid" },
    kioskName: { type: "string" },
    employeeName: { type: "string", nullable: true },
    badgeCode: { type: "string", nullable: true },
    orderId: { type: "string", format: "uuid", nullable: true },
    orderNo: { type: "string", nullable: true },
    deviceSeq: { type: "integer", minimum: 0 },
    codes: { type: "array", items: scanRejectionCodeOpenApiSchema },
    scannedAt: { type: "string", format: "date-time" },
    syncedAt: { type: "string", format: "date-time" },
    acknowledgedAt: { type: "string", format: "date-time", nullable: true },
  },
};

export const listPickupRejectionsOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["items", "openCount"],
  properties: {
    items: { type: "array", items: pickupScanRejectionRowOpenApiSchema },
    openCount: {
      type: "integer",
      minimum: 0,
      description: "Every unacknowledged rejection in the tenant, ignoring the query's filters.",
    },
  },
};
