# Kiosk Badge Digest — Design Spec

**Date:** 2026-07-29
**Status:** Delivered
**Slice of:** pickup kiosk B-2 (device app). Closes a finding deferred from the review of PR #25.
**Related:** `docs/superpowers/specs/2026-07-24-pickup-kiosk-b-app-offline-design.md`, `docs/device-key-surface.md`

## Problem

The kiosk queues orders in IndexedDB while offline, and each queued record holds the whole request body — including the raw `badgeCode` the employee scanned (`apps/kiosk/src/store/queue.ts`, `CreateOrderDto` in `apps/api/src/modules/pickup-orders/dto.ts`).

Everything else in the design goes out of its way to keep credentials off the device. `GET /kiosk/bootstrap` ships PBKDF2 verifiers and never plaintext codes, precisely because an unattended tablet at a factory gate is the most theft-exposed node in the system. The queue is the one place that breaks that rule.

The window is not "an outage". `submitCart` writes the queue record **before any network attempt** — deliberately, because that is what makes a pickup survive a battery pull — so every order passes through IndexedDB carrying the badge code. Two stores hold it:

- `queue`, until the order drains. Head-of-line blocking on a permanently rejected order used to make that unbounded; quarantine bounds it, but a device that cannot reach the server at all still holds everything.
- `quarantine`, **forever**. Nothing prunes that store, by design, and `quarantineQueue` moves the entire queue into it when a device's token is revoked.

A badge code is also the only credential on the device that works **away** from the device. The kiosk token is kiosk-scoped and revocable; the snapshot holds only verifiers. A badge code is a shared identifier: the same value authorises a pickup at any kiosk, signs an operator in at the line station, and is printed on a physical card. Someone who takes or inspects a kiosk can authorise withdrawals as every worker who submitted while it was offline.

## Decision

**The device sends a badge digest.** `POST /kiosk/orders` accepts `badgeDigest` — the PBKDF2 digest the device already derives to resolve the badge locally — and the server matches it against the per-tenant salted hash it already stores.

The device already computes exactly this value in `resolveBadge` (`deriveDigestB64(raw, badgeSalt, PHC_ITERATIONS)`) and throws it away. The server already stores exactly this value: `employee_badges.badge_hash` is `pbkdf2$sha256$100000$<tenantSalt>$<digest>`. So matching is one string equality against `formatPhc(PHC_ITERATIONS, salt, digest)` — no PBKDF2 server-side, no plaintext, and **no database schema change**.

### What this does and does not buy

It makes the queue hold nothing the snapshot does not already hold: the same digest is already in `bootstrap.employees[].badgeHash`. And it holds nothing usable away from this device's token — a digest cannot be scanned at a station or a door.

It does **not** make a stolen kiosk harmless. The device token plus the roster still let someone file orders as any employee until the kiosk is revoked. That is a separate, pre-existing property of pairing a device at all, and this change does not claim to close it.

### Why not an employee id

The device could resolve the employee locally and send an `employeeId` the server re-validates against the kiosk's tenant. Rejected, for three reasons.

1. **It breaks the rejection table.** `pickup_scan_rejections` carries `CHECK ((employee_id is null) = (badge_code is not null))`, and `PickupScanRejectionRowDto.kind` is derived from `employee_id IS NULL`. An employee the server cannot resolve leaves nothing to write in either column, so the constraint has to be relaxed and the admin loses the "whose card" column outright.
2. **It changes what the server verifies.** A badge revoked while the order sat in the queue would now be accepted, because the employee is still active. Today that is a 422. The server would stop confirming that a valid badge authorised the withdrawal and start trusting the device's local match — the opposite direction from the rest of this module, where the server re-decides everything.
3. **It wins one case only.** A card revoked from A and reissued to B between the scan and the sync would be filed under A, correctly, where the digest files it under B. That mis-attribution already exists today with the plaintext code, so the digest inherits it rather than introducing it, and it is rare enough not to pay for the two problems above.

A hybrid — send both and 422 on disagreement — would turn that one case into an explicit refusal, at the cost of a second field and a new failure mode. Not worth it now.

### Roster drift, case by case

The server performs the same lookup keyed by the same physical card, so behaviour between the scan (T0, offline) and the sync (T1, hours later) is **identical to today** in every case:

| Change between T0 and T1               | Result                                                  |
| -------------------------------------- | ------------------------------------------------------- |
| Employee archived or deleted           | 422 → the device quarantines that one order             |
| Badge revoked, employee still active   | 422 → quarantined                                       |
| Card revoked from A and reissued to B  | Filed under B (pre-existing mis-attribution, unchanged) |
| Employee added, unrelated roster edits | No effect                                               |

The 422 stays where it is and means what it meant: a well-formed body naming an employee no withdrawal can be filed against, as distinct from 401, which is the device's own credential. `TERMINAL_STATUSES` in `apps/kiosk/src/sync/worker.ts` is untouched.

### The one new coupling

**The tenant badge salt must not be rotated while kiosks hold queued orders.** A digest derived under an old salt matches nothing, so the whole backlog would 422 and quarantine. Nothing rotates it today — `getOrCreateBadgeSalt` only ever creates — and `activeBadgeHashes` already rehashes legacy per-row salts onto the tenant salt. Rotation would have to drain kiosks first. Written down here and in the DTO rather than defended against.

## Contract

`createOrderSchema` gains `badgeDigest` and demotes `badgeCode` to legacy, with a refinement requiring **exactly one**:

```ts
badgeDigest: z.string().refine(isCanonicalDigestB64).optional(),
badgeCode: z.string().min(1).optional(),   // legacy: bodies queued by a pre-digest bundle
```

`badgeCode` stays accepted because removing it would fail zod → 400, and **400 is in the kiosk's `TERMINAL_STATUSES`** — so shipping this would quarantine every order already queued by the previous bundle, on every device that was offline during the upgrade. It can be removed once no device can still hold a pre-upgrade queue; the seven-day staleness block bounds that.

`isCanonicalDigestB64` is a new export from `packages/domain/src/crypto/phc.ts`, built on the `decodeCanonical` helper already there. The base64 rule belongs beside the code that produces the digest, not restated as a regex in a DTO.

## Server

`resolveActiveEmployeeId` gains a digest branch: read the tenant salt, rebuild the PHC string, and match `employee_badges.badge_hash` — joined to `employees` on the same `revoked_at is null` / `status = 'active'` conditions as the plaintext path.

The salt is read through a new **read-only** `readBadgeSalt` in `apps/api/src/lib/badge-salt.ts` rather than `getOrCreateBadgeSalt`. The order path resolves, it does not provision, and a tenant with no salt row has no badge hashes either — so `null` correctly yields the 422 without a write on the hot path.

### The audit value in `pickup_scan_rejections`

On the unknown-badge 422, a new `auditBadgeValue` resolves the digest against **all** of the tenant's badges, revoked included, and records the recovered plaintext `badge_code`. Badges are only ever soft-revoked (`employees.service.ts` sets `revokedAt`; nothing deletes a row), so this covers the whole class of case the column exists for — "so the admin can still tell whose badge was used once the employee is gone from the roster".

Only a digest the tenant has never issued falls back to recording the digest itself, and **a real kiosk cannot produce one**: `Idle` refuses to open a session for a badge its snapshot cannot resolve, so every badge the device sends was an active badge of this tenant at bootstrap time. The column comment in `packages/db/src/schema/pickup.ts` is corrected to say so. The check constraint and the `kind` derivation are untouched, and so is `apps/admin`.

## Device

- `resolveBadge` returns `{ employeeId, digest }` — it already computes the digest.
- `KioskSession.badgeCode` becomes `badgeDigest`; `submitCart` puts it in the body. `Idle`'s prop signature is unchanged: that screen still only learns an employee id.
- The device's `CreateOrderDto` declares `badgeDigest: string` only — what today's app **writes**. Stored records from older versions are read back through guards, not through the writer's type, which is the rule `countTakenToday` already follows.

### Boot scrub

A one-time, idempotent pass at startup removes the plaintext already sitting on devices — the queue that motivated this, and the quarantine store that would otherwise hold it forever.

1. Read both stores and collect the **distinct** legacy badge codes. A backlog is one or two workers, so this is a couple of ~50ms derivations, not one per order.
2. Derive a digest for each.
3. Rewrite through a **read-write cursor**, so a record the drain deleted in between is simply not visited.

Step 3 is why this is not a `get`/`put`: a `put` on a deleted key re-creates it, which would resurrect a delivered order under a spent `deviceSeq` — the exact silent failure `quarantineQueue` already documents, where the server answers a repeated `(tenantId, kioskId, deviceSeq)` with the first order and a later worker's cart evaporates.

This needs one cursor helper in `apps/kiosk/src/store/db.ts`, which by its own comment is the only place allowed to drive a multi-step transaction. No `DB_VERSION` bump: the store shape does not change, only the contents of a record. The scrub never throws — a device with no snapshot cannot derive, so it logs and retries on the next boot.

## Tests

**API.** Digest accepted and filed under the right employee; legacy `badgeCode` still accepted; both or neither → 400; malformed digest → 400; revoked badge → 422; archived employee → 422; the rejection row records the **recovered plaintext** for a revoked badge, and the digest for one that never existed.

**Kiosk.** `resolveBadge` returns the digest; the scrub rewrites both stores, is idempotent, ignores already-migrated records, and does not resurrect a concurrently-dequeued one; `sync.test.ts` and `app.test.tsx` bodies updated. Plus the regression test that names the bug: after a submit, **no record in `queue` or `quarantine` contains the raw badge value**.

**Domain.** `isCanonicalDigestB64` accepts a real digest and rejects wrong lengths and non-canonical encodings.

## Out of scope

No new secret is involved, so `turbo.json`, `apps/api/turbo.json`, `.env` and CI are untouched. No migration: the change adds no column and no index — the digest lookup is an equality filter already scoped by `tenant_id`, on a table read once per order create.
