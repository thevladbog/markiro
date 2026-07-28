/**
 * Hand-mirrored from apps/api/src/modules/pickup-orders/dto.ts. These types
 * are not published in a shared package, so they are duplicated here the same
 * way apps/admin duplicates its own slice. Plan B-1 froze these shapes
 * deliberately so this app could be built against them — if the server ever
 * changes one, this file must change with it in the same commit.
 */

/** One raw scan from the kiosk's scanner, within a POST /kiosk/orders body. */
export interface CreateOrderItemInput {
  rawKm: string;
}

/**
 * POST /kiosk/orders body. `deviceSeq` is the kiosk's own monotonic counter —
 * together with `(tenantId, kioskId)` it's the idempotency key for offline
 * sync retries. `createdAt` lets an offline-queued order replay with its
 * original scan time instead of the sync moment.
 */
export interface CreateOrderDto {
  deviceSeq: number;
  badgeCode: string;
  reason: "buy" | "writeoff";
  writeoffReasonId?: string | null;
  items: CreateOrderItemInput[];
  createdAt?: string;
}

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
 * `nextDeviceSeq` is `MAX(deviceSeq) + 1` for this kiosk (0 if it has no
 * orders yet), so a re-paired device continues its idempotency-key counter
 * instead of restarting at 0 and colliding with its own past orders.
 */
export interface PairKioskResultDto {
  device: { kioskId: string; kioskName: string; place: string | null };
  token: string; // the x-kiosk-token
  nextDeviceSeq: number;
  bootstrap: KioskBootstrapDto;
}
