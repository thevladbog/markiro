import { z } from "zod";

/** POST /kiosk/orders — one raw scan from the kiosk's scanner. */
export const createOrderItemSchema = z.object({ rawKm: z.string().min(1) });
export type CreateOrderItemInput = z.infer<typeof createOrderItemSchema>;

/**
 * POST /kiosk/orders body. `deviceSeq` is the kiosk's own monotonic counter —
 * together with `(tenantId, kioskId)` it's the idempotency key for offline
 * sync retries. `createdAt` lets an offline-queued order replay with its
 * original scan time instead of the sync moment.
 */
export const createOrderSchema = z.object({
  deviceSeq: z.number().int().nonnegative(),
  badgeCode: z.string().min(1),
  reason: z.enum(["buy", "writeoff"]),
  writeoffReasonId: z.string().uuid().nullable().optional(),
  items: z.array(createOrderItemSchema),
  createdAt: z.string().datetime().optional(),
});
export type CreateOrderDto = z.infer<typeof createOrderSchema>;

/** A scanned item that could not be accepted into the order, and why. */
export interface OrderConflict {
  rawKm: string;
  reason: "not_km" | "incomplete" | "unknown_product" | "not_allowed" | "duplicate" | "over_limit";
}

/** POST /kiosk/orders response — the authoritative server-side outcome. */
export interface CreateOrderResultDto {
  orderNo: string;
  status: "pending";
  itemCount: number;
  conflicts: OrderConflict[];
}

/** GET /kiosk/bootstrap response — everything a kiosk needs to work offline. */
export interface KioskBootstrapDto {
  config: { dayLimitPerEmployee: number; showPrices: boolean };
  reasons: { id: string; name: string }[];
  products: {
    id: string;
    gtin14: string;
    name: string;
    unitPrice: string | null;
    egaisCode: string | null;
  }[];
  employees: { id: string; fullName: string; role: string | null; badgeCodes: string[] }[];
}

const PICKUP_ORDER_STATUSES = ["pending", "punched", "writtenoff", "cancelled"] as const;
export type PickupOrderStatus = (typeof PICKUP_ORDER_STATUSES)[number];

/** `YYYY-MM-DD`. */
const dateOnlySchema = z.string().date();

/** GET /pickup-orders query. `from`/`to` filter on `createdAt`, inclusive (whole-day range). */
export const listPickupOrdersQuerySchema = z.object({
  status: z.enum(PICKUP_ORDER_STATUSES).optional(),
  reason: z.enum(["buy", "writeoff"]).optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});
export type ListPickupOrdersQueryDto = z.infer<typeof listPickupOrdersQuerySchema>;

/** POST /pickup-orders/:id/resolve body. */
export const resolvePickupOrderSchema = z.object({
  action: z.enum(["punch", "writeoff"]),
  receiptNo: z.string().min(1).optional(),
  actNo: z.string().min(1).optional(),
  writeoffReasonId: z.string().uuid().optional(),
});
export type ResolvePickupOrderDto = z.infer<typeof resolvePickupOrderSchema>;

/** Admin list/detail row, joined with employee/kiosk/reason names. */
export interface PickupOrderRowDto {
  id: string;
  orderNo: string;
  employeeName: string;
  kioskName: string;
  reason: "buy" | "writeoff";
  writeoffReasonName: string | null;
  itemCount: number;
  totalPrice: string | null;
  status: PickupOrderStatus;
  createdAt: Date;
}

/** GET /pickup-orders response. */
export interface ListPickupOrdersResponseDto {
  items: PickupOrderRowDto[];
}

/** One item within a pickup order's detail view. */
export interface PickupOrderItemDto {
  id: string;
  gtin14: string;
  serial: string;
  rawKm: string;
  productName: string;
  unitPrice: string | null;
}

/** GET /pickup-orders/:id response. */
export interface PickupOrderDetailDto extends PickupOrderRowDto {
  employeeBadgeCode: string | null;
  items: PickupOrderItemDto[];
  receiptNo: string | null;
  actNo: string | null;
}

/** POST /pickup-orders/export body. */
export const exportPickupCodesSchema = z.object({
  orderIds: z.array(z.string().uuid()).min(1),
});
export type ExportPickupCodesDto = z.infer<typeof exportPickupCodesSchema>;
