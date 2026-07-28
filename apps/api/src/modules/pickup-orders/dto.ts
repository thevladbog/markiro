import { z } from "zod";

/** POST /kiosk/pair body — the 8-digit code shown on the kiosk cabinet. */
export const pairKioskSchema = z.object({ code: z.string().regex(/^\d{8}$/) });
export type PairKioskDto = z.infer<typeof pairKioskSchema>;

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

/**
 * GET /kiosk/bootstrap — everything a kiosk needs to work offline.
 *
 * Credentials are PBKDF2 verifiers, never plaintext: an unattended tablet at
 * a factory gate is the most theft-exposed node in the system, and a badge is
 * the credential that authorises a pickup (see docs/device-key-surface.md).
 * All badge verifiers share `badgeSalt` so the device derives once per scan
 * and looks the digest up, instead of running PBKDF2 per employee.
 *
 * `operators[]` is frozen to match the station's `OperatorMirrorRecord`
 * shape (`{ employeeId, name, login, role, pinHash, badgeHash, active }`) —
 * the device app (Plan B-2) hasn't been built against this yet, so this is
 * the cheapest point to lock it in.
 *
 * `generatedAt` is stamped by the server (not left to the device's own
 * receive clock) because the device's 24h-warning / 7d-block staleness gates
 * need a timestamp trustworthy enough to gate on — an unattended tablet's
 * own clock is the least trustworthy clock in the system.
 */
export interface KioskBootstrapDto {
  generatedAt: string; // ISO 8601, server time -- see doc comment above
  config: { dayLimitPerEmployee: number; showPrices: boolean };
  badgeSalt: string; // base64; the salt every badgeHash below shares
  reasons: { id: string; name: string }[];
  products: {
    id: string;
    gtin14: string;
    name: string;
    unitPrice: string | null;
    egaisCode: string | null;
  }[];
  employees: { id: string; fullName: string; role: string | null; badgeHash: string | null }[];
  operators: {
    employeeId: string;
    name: string;
    login: string;
    role: string;
    pinHash: string;
    badgeHash: string | null;
    active: boolean;
  }[];
}

/**
 * POST /kiosk/pair response — the contract Plan B-2's pairing screen calls.
 * `nextDeviceSeq` is `MAX(deviceSeq) + 1` for this kiosk across BOTH
 * `pickup_orders` and `pickup_scan_rejections` (0 if it has neither yet), so
 * a re-paired device continues its idempotency-key counter instead of
 * restarting at 0 and colliding with its own past orders. A rejection
 * consumes a `device_seq` without creating an order, so an orders-only max
 * would hand a re-paired device a number already spent, and its next
 * rejection would be silently dropped as a replay.
 */
export interface PairKioskResultDto {
  device: { kioskId: string; kioskName: string; place: string | null };
  token: string; // the x-kiosk-token
  nextDeviceSeq: number;
  bootstrap: KioskBootstrapDto;
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
  /** How many scanned codes the server refused when this order synced. */
  conflictCount: number;
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
  syncConflicts: OrderConflict[];
}

/** POST /pickup-orders/export body. */
export const exportPickupCodesSchema = z.object({
  orderIds: z.array(z.string().uuid()).min(1),
});
export type ExportPickupCodesDto = z.infer<typeof exportPickupCodesSchema>;
