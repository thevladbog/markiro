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
 *
 * `badgeDigest` is what `resolveBadge` already derived to admit the worker
 * (`deriveDigestB64(raw, badgeSalt, PHC_ITERATIONS)`), and NOT the scanned
 * code, because this body is written to IndexedDB before any network attempt
 * and a permanently refused one is kept there for good. A badge code is the
 * only credential on this device that also works away from it — the same value
 * opens a pickup at any kiosk and signs an operator in at the station — while
 * a digest is already in this device's own bootstrap and can be scanned
 * nowhere. See `credentials/badge.ts` and the server's own `CreateOrderDto`.
 *
 * The server still accepts a legacy `badgeCode`, which is what lets an order
 * queued by an older bundle drain instead of failing validation; today's app
 * never writes one, and `store/scrub.ts` removes the ones it already wrote.
 */
export interface CreateOrderDto {
  deviceSeq: number;
  badgeDigest: string;
  reason: "buy" | "writeoff";
  writeoffReasonId?: string | null;
  items: CreateOrderItemInput[];
  createdAt?: string;
  admissionNonce?: string;
  admissionProof?: string;
}

export type CreateOrderAdmissionDto = Omit<CreateOrderDto, "createdAt" | "admissionProof">;

export interface CreateOrderAdmissionResultDto {
  claimedAt: string;
  admissionProof: string;
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

export interface SubscriptionAccessSnapshotDto {
  access: "managed" | "read_only" | "unmanaged";
  status: "unmanaged" | "pending_activation" | "trial" | "active" | "expired" | "read_only";
  startsAt: string | null;
  endsAt: string | null;
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
  subscription: SubscriptionAccessSnapshotDto;
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
     * What this employee has taken today AT EVERY KIOSK BUT THIS ONE. Not a
     * total, and reading it as one would break the very thing it fixes.
     *
     * This device counts its OWN kiosk's contribution from its journal and its
     * unsynced queue (`session/day-count.ts`), and the limit is the SUM. The
     * two halves are split by SOURCE, so an overlap is impossible by
     * construction — no watermark, no clock comparison. Were this a total, the
     * items this device filed would be counted twice and a worker would be
     * refused product they are entitled to, at an unattended machine with
     * nobody to overrule it.
     *
     * DECLARED REQUIRED, BUT READ AS UNTRUSTED. This interface describes what
     * today's server sends; the app casts `res.json()` to it and validates
     * nothing, and IndexedDB holds whatever snapshot any past server sent. So
     * it is read through `takenTodayElsewhere()`, which answers zero for a
     * payload that does not carry it — the same reason `day-count.ts` guards
     * the journal it reads back.
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
