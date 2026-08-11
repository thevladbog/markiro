import { isCanonicalDigestB64 } from "@markiro/domain";
import { z } from "zod";
import type { SubscriptionAccessSnapshot } from "../../subscriptions/entitlements.types";

/** POST /kiosk/pair body — the 8-digit code shown on the kiosk cabinet. */
export const pairKioskSchema = z.object({ code: z.string().regex(/^\d{8}$/) });
export type PairKioskDto = z.infer<typeof pairKioskSchema>;

/** POST /kiosk/orders — one raw scan from the kiosk's scanner. */
export const createOrderItemSchema = z.object({ rawKm: z.string().min(1) });
export type CreateOrderItemInput = z.infer<typeof createOrderItemSchema>;

/** PostgreSQL `integer` upper bound for the durable kiosk idempotency key. */
export const MAX_KIOSK_DEVICE_SEQ = 2_147_483_647;

/**
 * POST /kiosk/orders body. `deviceSeq` is the kiosk's own monotonic counter —
 * together with `(tenantId, kioskId)` it's the idempotency key for offline
 * sync retries. `createdAt` lets an offline-queued order replay with its
 * original scan time instead of the sync moment — accepted only within a
 * plausible window around server time, and otherwise replaced by it, because
 * it also decides which day the order's items count against (see
 * `PickupOrdersService.resolveScanTime`).
 *
 * THE BADGE ARRIVES AS A DIGEST, NOT A CODE, and that is a storage decision
 * rather than a transport one. An order is written to the kiosk's IndexedDB
 * queue BEFORE any network attempt (that is what makes a pickup survive a
 * battery pull), and a permanently refused one is kept in its quarantine store
 * indefinitely — so whatever identifies the employee here is what an
 * unattended tablet at a factory gate holds at rest. A badge CODE is the one
 * credential in this system that also works away from the device: the same
 * value authorises a pickup at any kiosk, signs an operator in at the line
 * station, and is printed on a physical card. A digest is not: it is already
 * in the device's own bootstrap (`employees[].badgeHash`), so the queue holds
 * nothing the snapshot does not, and it cannot be scanned anywhere.
 *
 * `badgeDigest` is `deriveDigestB64(badgeCode, tenant badgeSalt,
 * PHC_ITERATIONS)` — the value the device already derives to resolve the badge
 * locally, and the digest half of the `employee_badges.badge_hash` the server
 * already stores, so the lookup is one string equality and neither end needs
 * the plaintext.
 *
 * ROTATING THE TENANT BADGE SALT WOULD STRAND QUEUED ORDERS. A digest derived
 * under an old salt matches no stored hash, so a device's whole backlog would
 * 422 and quarantine. Nothing rotates it today (`getOrCreateBadgeSalt` only
 * ever creates), and rotation would have to drain kiosks first.
 *
 * `badgeCode` is LEGACY and stays accepted only for bodies queued by a
 * pre-digest bundle. Rejecting it would fail validation with 400, and 400 is
 * in the kiosk's `TERMINAL_STATUSES` (apps/kiosk/src/sync/worker.ts) — so
 * dropping it would quarantine every order already queued on every device that
 * was offline during the upgrade. It can go once no device can still hold a
 * pre-upgrade queue; the device's own seven-day staleness block bounds that.
 */
const createOrderContentShape = {
  deviceSeq: z.number().int().nonnegative().max(MAX_KIOSK_DEVICE_SEQ),
  badgeDigest: z.string().refine(isCanonicalDigestB64, "Not a canonical badge digest").optional(),
  badgeCode: z.string().min(1).optional(),
  reason: z.enum(["buy", "writeoff"]),
  writeoffReasonId: z.string().uuid().nullable().optional(),
  items: z.array(createOrderItemSchema),
};

const hasExactlyOneBadgeIdentity = (body: {
  badgeDigest?: string | undefined;
  badgeCode?: string | undefined;
}): boolean => (body.badgeDigest === undefined) !== (body.badgeCode === undefined);

export const createOrderAdmissionSchema = z
  .object(createOrderContentShape)
  .refine(hasExactlyOneBadgeIdentity, "Exactly one of badgeDigest or badgeCode is required");
export type CreateOrderAdmissionDto = z.infer<typeof createOrderAdmissionSchema>;

export interface CreateOrderAdmissionResultDto {
  claimedAt: string;
  admissionProof: string;
}

export const createOrderSchema = z
  .object({
    ...createOrderContentShape,
    createdAt: z.string().datetime().optional(),
    admissionProof: z.string().min(1).max(2048).optional(),
  })
  // Exactly one, never both: two identifiers for one employee is two answers
  // the server would have to rank, and a body carrying a digest AND the
  // plaintext it is meant to replace is the very thing this field exists to
  // stop being persisted.
  .refine(hasExactlyOneBadgeIdentity, "Exactly one of badgeDigest or badgeCode is required");
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
  subscription: SubscriptionAccessSnapshot;
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
  employees: {
    id: string;
    fullName: string;
    role: string | null;
    badgeHash: string | null;
    /**
     * How many items this employee has already taken TODAY AT EVERY KIOSK BUT
     * THE ONE ASKING. Not a total, and it must never become one.
     *
     * The device's own day count (`apps/kiosk/src/session/day-count.ts`) is
     * computed from this kiosk's journal and its unsynced queue, and the limit
     * check is the SUM of the two numbers. Split by SOURCE — this kiosk's
     * orders here, every other kiosk's there — an overlap is impossible by
     * construction, with no watermark and no clock comparison to get subtly
     * wrong. Send a total instead and every item this device filed is counted
     * twice, which refuses a worker product they are entitled to at an
     * unattended machine with nobody present to overrule it. The opposite
     * error, under-counting, is the safe one: `POST /kiosk/orders` re-decides
     * the limit against live data and is still the gate.
     *
     * Counted exactly the way `PickupOrdersService.applyDayLimit` counts —
     * non-voided items, on non-cancelled orders, whose order's
     * `(created_at at time zone 'utc')::date` is today — so the number a device
     * plans with and the number the server enforces cannot disagree.
     */
    takenTodayElsewhere: number;
  }[];
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
  /** Set once 1С confirms receipt over `/1c_exchange` `mode=success` (плана И-2). `null` — not yet exported. */
  exportedAt: Date | null;
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
  /** Products this order's items reference that carry no 1С link yet — non-empty means this order is held back from `mode=query` (плана И-2, спека §5). */
  exportHeldProductNames: string[];
}

/** POST /pickup-orders/export body. */
export const exportPickupCodesSchema = z.object({
  orderIds: z.array(z.string().uuid()).min(1),
});
export type ExportPickupCodesDto = z.infer<typeof exportPickupCodesSchema>;
