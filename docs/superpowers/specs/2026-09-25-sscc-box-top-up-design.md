# Proactive box SSCC top-up for Station and handheld

**Date:** 2026-09-25

**Status:** Implemented in an isolated worktree; not merged, released, or factory-verified
**Source base:** `main` at `7ae07b9a3d4d1ad1ad992b9f4201a9975a223f17`

## Outcome and observed gap

An active aggregation shift must keep closing boxes when a connected device
approaches the end of its box SSCC range, without requiring an operator to pause
and re-enter the shift. Station and handheld must both receive a non-overlapping
range before the current one is dry. Offline work continues on already persisted
serials; no client invents, reuses, or resets an SSCC.

Today Station sends `serialsLeft` with scan batches and can apply an optional
`ssccBlock` response, but the API's batch parser discards `serialsLeft` and its
response never contains `ssccBlock`. Both devices fetch a new range only through
shift entry/bundle refresh. The Station sync loop sends no batch at all when its
outbox is empty. Adding mutable `serialsLeft` to the existing batch digest would
make a retry under the same `batchId` fail with `station_batch_mismatch`.

## Decision

Add a narrow, device-authenticated `POST /shifts/:id/sscc/top-up` endpoint for
**box extension digit 0 only**. Both clients call it in the background when the
local remaining count for the active shift's issuer prefix falls to **400 or
fewer**. This is 20% of today's 2,000-serial box grant and leaves time for a
normal sync/retry cycle. The endpoint is also checked once on active-shift entry,
so a device that missed the last response can recover without a pause. It is
not an alternative ingest path and does not modify scan-batch bytes, digests,
identities, or acknowledgements.

The endpoint accepts no client-selected prefix, range, or cursor. It uses the
authenticated device and tenant, checks that the named shift is active and in
aggregation mode and that this device is its participant, resolves the shift's
issuer prefix on the server, and applies the same continuing-subscription rule
as bundle allocation. Cabinet sessions, other tenants, and unrelated devices
cannot reserve ranges. A missing issuer or exhausted global serial space is an
explicit no-new-range result; transient storage failures propagate for retry.

## Server allocation and response

Within one transaction, serialize decisions for the same tenant/device/prefix/
digit stream before reading its latest live block. Preserve a consistent lock
order with shift-bundle allocation and the existing atomic counter allocator.
Compute remaining from `consumedThroughSerial`, never from a client claim. If
the latest block has more than 400 server-unconsumed serials, return it without
allocating. When it is at/below 400 and has actually begun consumption, reserve
one next block using the existing allocator. A subsequent request sees that new
block as the latest and returns it instead of allocating another. Fully
consumed blocks retain the existing bundle behavior: allocate one next block.
Concurrent and repeated requests must converge on the same outstanding reserve;
no two devices receive overlapping serials.

The response contains the original bounds and `consumedThroughSerial` for the
device's live box blocks under that prefix, plus the existing explicit revoked
`fromSerial` list. Returning the old and reserved blocks lets a client reconcile
its saved cursor before it starts the new range. The response is tenant/device
scoped; pallet blocks are neither allocated nor changed. Existing bundle
delivery remains supported for older clients and normal recovery.

## Device lifecycle

Both devices count the box pool for the **active shift's** issuer prefix, not a
globally chosen first prefix. A single-flight background check runs after entry
and after closures while the count is low, with bounded retry/backoff while
online. It must not block scans, printing, pause, or shift close. Successful
delivery applies revocations first, then each returned block through the
existing progress-preserving pool upsert; the oldest usable range is still
burned first. Persist the grant before reporting success or using it. Ignore a
late response after a shift change, credential replacement, or device recovery
seal; re-entry may safely ask again. Network failure leaves the local pool
untouched and retries; reaching zero retains the existing no-serials stop,
keeping the open box and its scans. No automatic close or reprint follows a
late grant: the operator retries the close explicitly.

The endpoint is additive. Publish the API before shipping Station and handheld
clients. Against an older API (404), clients keep their existing range and
bundle/re-entry recovery; they do not spin on requests or modify local cursors.

## Verification

- API: tenant/device/participant/active-shift denial, subscription boundary,
  issuer resolution, threshold edges, partial terminal block, global exhaustion,
  repeat and parallel calls, distinct devices/prefixes, exact response bounds,
  revocation filtering, and no pallet allocation.
- Station: low-water trigger for the active prefix, single-flight/retry, durable
  apply-before-use, old-range-first burn, offline/restart, stale credential and
  shift-change responses, 404 compatibility, and zero-pool open-box recovery.
- Handheld: matching Room pool and coroutine lifecycle tests, interrupted apply,
  old-range-first burn, offline/restart, credential generation, and 404 fallback.
- Cross-device: prove API grants are disjoint and both consumers interpret the
  same response. Run API, Station, and Android package gates. Hardware printing,
  scanner behavior, and installed-client acceptance remain separate checks.

## Outside scope

Pallet (extension digit 1) prefetch, changing block size or GS1 formatting,
manual SSCC reseeding, repair of historical missing boxes, and treating a
connected icon as proof of successful sync. This prevents ordinary exhaustion
when the server has accepted enough prior closures; it cannot guarantee a new
grant while the network or the closure-sync channel is failing.
