import type { KioskClient } from "../api/client.js";
import { replaceSnapshot } from "../store/cache.js";
import { appendJournal } from "../store/journal.js";
import { dequeueOrder, listQueue } from "../store/queue.js";

/**
 * How often a paired kiosk pulls a fresh bootstrap. Every authenticated call
 * bumps `kiosks.last_seen_at` server-side, so this doubles as the heartbeat.
 */
export const REFRESH_INTERVAL_MS = 5 * 60_000;

/** Past this the UI warns that the dataset is ageing, but work continues. */
export const STALE_WARN_MS = 24 * 60 * 60_000;

/** Past this the device refuses to hand anything out until it syncs again. */
export const STALE_BLOCK_MS = 7 * 24 * 60 * 60_000;

export type CacheAge = "fresh" | "warn" | "blocked";

/**
 * How much the cached dataset can still be trusted.
 *
 * Measured against `generatedAt` — the SERVER's stamp — and deliberately not
 * against the snapshot's own `fetchedAt`, which is written from the device's
 * clock: an unattended tablet at a factory gate is the least trustworthy clock
 * in the system, and gating a lockout on it would let a drifted clock either
 * brick a healthy kiosk or keep a week-old roster in service.
 *
 * A `generatedAt` in the future (the tablet lagging the server, which happens
 * routinely after a cold boot with no NTP) reads `fresh`: the age is negative,
 * so neither threshold trips. Comparing magnitude instead of signed age would
 * lock out a device whose only fault is a slow clock.
 *
 * FAILS CLOSED. An unparseable stamp makes `ageMs` NaN, and every comparison
 * against NaN is false — so without the guard below this returns `fresh`
 * forever, and one edited character in a stolen tablet's IndexedDB disables
 * the seven-day lockout permanently. A gate that cannot establish freshness
 * must not assert it. `refreshSnapshot` already refuses to persist such a
 * stamp, so this branch is defence in depth for one that reached the store by
 * another route (a future pairing path also writes a snapshot).
 */
export function cacheAge(generatedAt: string, now: Date): CacheAge {
  const ageMs = now.getTime() - Date.parse(generatedAt);
  if (Number.isNaN(ageMs)) return "blocked";
  if (ageMs >= STALE_BLOCK_MS) return "blocked";
  if (ageMs >= STALE_WARN_MS) return "warn";
  return "fresh";
}

/**
 * Guards against overlapping drains. Task 14 triggers a flush from both a
 * periodic interval and an `online` handler, which can fire close enough
 * together that a second drain reads the queue before the first has dequeued
 * what it already submitted. Resubmitting is harmless on the server — it is
 * idempotent on `(tenantId, kioskId, deviceSeq)` — but the second acknowledgement
 * appends a duplicate journal entry to the service screen's log. The invariant
 * belongs here rather than in the caller: it is this module's, and every future
 * caller would otherwise have to rederive it.
 */
let draining = false;

/**
 * Drains the offline queue oldest-first. NEVER REJECTS — every failure, from
 * the network down to IndexedDB itself, leaves the affected order queued for
 * the next drain instead of surfacing here. Task 14 calls this from a
 * `setInterval` and an `online` handler, neither of which can catch anything,
 * so no caller needs a `.catch()`. `refreshSnapshot` deliberately does the
 * opposite: its caller has to learn that the device is offline.
 *
 * Two invariants, both load-bearing:
 *
 *  - **Acknowledge, then remove.** The order leaves the queue only after the
 *    server's answer is durably journalled. A crash in between therefore
 *    replays the order rather than losing it, and a replay is harmless because
 *    the server is idempotent on `(tenantId, kioskId, deviceSeq)` — it returns
 *    the original order instead of creating a second one. The reverse order
 *    (remove, then journal) would silently drop a worker's pickup on any crash
 *    between the two writes.
 *  - **The first failure aborts the whole drain**, it does not skip ahead.
 *    Orders carry a monotonic `deviceSeq` and the server records them in
 *    arrival order; letting a later order overtake a stuck earlier one would
 *    reorder a worker's history and break the day-limit accounting that
 *    depends on it.
 *
 * KNOWN LIMITATION — head-of-line blocking on a permanent rejection. Every
 * failure is treated as retryable, so an order the server refuses for good
 * (a 4xx that will never succeed: a deleted kiosk, a malformed body from an
 * older app version) parks at the head of the queue and stalls every order
 * behind it forever. Fixing it needs a poison-queue policy that is out of this
 * plan's scope: distinguish a `KioskApiError` with a 4xx status from a
 * transport failure, move the former into a quarantine store for the service
 * screen to surface, and carry on draining the rest.
 *
 * KNOWN LIMITATION — a double journal entry. "Acknowledge, then remove" is the
 * right trade in the other direction too: if `dequeueOrder` fails after the
 * journal write succeeded, the order replays and its verdict is journalled a
 * second time. The alternative loses the pickup entirely, so this stays. It
 * costs one duplicate line in a service-screen log that nothing computes from.
 */
export async function flushQueue(client: KioskClient, now: () => Date): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const queued = await listQueue(); // ascending deviceSeq
    for (const order of queued) {
      try {
        const result = await client.submitOrder(order.body);
        await appendJournal({
          at: now().toISOString(),
          deviceSeq: order.deviceSeq,
          orderNo: result.orderNo,
          conflicts: result.conflicts,
        });
      } catch {
        // Offline, rejected, or the journal write failed — either way this
        // order is still owed. Stop here so the next drain retries it in place.
        return;
      }
      await dequeueOrder(order.deviceSeq);
    }
  } catch {
    // The store itself failed (`listQueue`, `dequeueOrder`). Nothing is lost:
    // an order only leaves the queue after a durable acknowledgement, so the
    // next drain picks up wherever this one stopped. Swallowed to keep the
    // never-rejects contract above true for the timer that drives it.
  } finally {
    draining = false;
  }
}

/**
 * Pulls a fresh bootstrap and swaps it in wholesale.
 *
 * `replaceSnapshot` runs only after `bootstrap()` resolves, so a failed
 * refresh leaves the cached dataset exactly as it was — a kiosk that wiped its
 * cache whenever the network blinked would brick itself, which is the opposite
 * of what an offline-first device is for.
 *
 * REJECTS ON FAILURE, unlike `flushQueue`, and the asymmetry is deliberate: a
 * failed drain is invisible to the user (the order is simply still queued),
 * whereas a failed refresh is the one signal that tells the status strip the
 * device is offline and lets `cacheAge` start counting against the snapshot it
 * still holds. Callers must handle the rejection.
 *
 * A bootstrap whose `generatedAt` cannot be parsed is refused rather than
 * stored, down the same path as a dead network — so the device keeps its
 * last-known-good snapshot and ages fresh → warn → blocked over seven days
 * (a six-day warning window) instead of locking out on the spot. Persisting it
 * is the one thing that must not happen: `cacheAge` cannot measure such a
 * stamp, and a gate that cannot establish freshness has to fail closed.
 *
 * Only `generatedAt` is checked, not the whole payload. `zod` is a declared
 * dependency but nothing in `src/` validates responses yet; full response
 * validation is a separate concern and does not belong in this guard.
 */
export async function refreshSnapshot(client: KioskClient, now: () => Date): Promise<void> {
  const bootstrap = await client.bootstrap();
  if (Number.isNaN(Date.parse(bootstrap.generatedAt))) {
    throw new Error(
      `bootstrap has an unparseable generatedAt: ${JSON.stringify(bootstrap.generatedAt)}`,
    );
  }
  await replaceSnapshot(bootstrap, now());
}
