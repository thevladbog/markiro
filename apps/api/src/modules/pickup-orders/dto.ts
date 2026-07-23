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
  products: { id: string; gtin14: string; name: string; unitPrice: string | null; egaisCode: string | null }[];
  employees: { id: string; fullName: string; role: string | null; badgeCodes: string[] }[];
}
