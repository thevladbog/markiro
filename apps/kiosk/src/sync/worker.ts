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
 */
export function cacheAge(generatedAt: string, now: Date): CacheAge {
  const ageMs = now.getTime() - Date.parse(generatedAt);
  if (ageMs >= STALE_BLOCK_MS) return "blocked";
  if (ageMs >= STALE_WARN_MS) return "warn";
  return "fresh";
}

/**
 * Drains the offline queue oldest-first.
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
 */
export async function flushQueue(client: KioskClient, now: () => Date): Promise<void> {
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
      // Offline, rejected, or the journal write failed — either way this order
      // is still owed. Stop here so the next drain retries it in place.
      return;
    }
    await dequeueOrder(order.deviceSeq);
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
 * Unlike `flushQueue`, this rethrows: the caller needs to know the refresh
 * failed so the status strip can show the device as offline and `cacheAge` can
 * start counting against the snapshot it still holds.
 */
export async function refreshSnapshot(client: KioskClient, now: () => Date): Promise<void> {
  const bootstrap = await client.bootstrap();
  await replaceSnapshot(bootstrap, now());
}
