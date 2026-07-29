import type { KioskClient } from "../api/client.js";
import {
  assertMeasurableGeneratedAt,
  replaceSnapshot,
  type CachedSnapshot,
} from "../store/cache.js";
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
 * must not assert it. `assertMeasurableGeneratedAt` already refuses to persist
 * such a stamp on both write paths (this refresh and pairing), so this branch
 * is defence in depth for one that reached the store by another route.
 */
export function cacheAge(generatedAt: string, now: Date): CacheAge {
  const ageMs = now.getTime() - Date.parse(generatedAt);
  if (Number.isNaN(ageMs)) return "blocked";
  if (ageMs >= STALE_BLOCK_MS) return "blocked";
  if (ageMs >= STALE_WARN_MS) return "warn";
  return "fresh";
}

/**
 * The same gate, asked of what the device actually holds.
 *
 * NO SNAPSHOT IS `blocked`, and that is the second half of the fail-closed
 * rule above: a paired device with nothing cached cannot say how old its data
 * is, and a gate that cannot establish freshness must not assert it. The two
 * halves belong together — one answers "the stamp is unreadable", the other
 * "there is no stamp" — and both used to be true only for as long as an
 * untested `snapshot ? … : "blocked"` in the shell's wiring kept saying so.
 *
 * `null` is the normal state of a device between pairing and its first
 * bootstrap, which routes to the pairing screen anyway; this answer only
 * matters for a device that IS paired and has somehow lost its dataset.
 */
export function snapshotAge(snapshot: CachedSnapshot | null, now: Date): CacheAge {
  if (!snapshot) return "blocked";
  return cacheAge(snapshot.bootstrap.generatedAt, now);
}

/**
 * The drain currently owed — the tail of the chain, not merely a busy flag.
 *
 * Task 14 triggers a flush from both a periodic interval and an `online`
 * handler, which can fire close enough together that a second drain reads the
 * queue before the first has dequeued what it already submitted. Resubmitting
 * is harmless on the server — it is idempotent on
 * `(tenantId, kioskId, deviceSeq)` — but the second acknowledgement appends a
 * duplicate journal entry to the service screen's log. The invariant belongs
 * here rather than in the caller: it is this module's, and every future caller
 * would otherwise have to rederive it.
 *
 * A PROMISE rather than a boolean, because a second caller must WAIT rather
 * than be turned away — see `flushQueue`.
 */
let draining: Promise<void> | null = null;

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
 *
 * CONCURRENT CALLERS ARE QUEUED, NOT TURNED AWAY, and the difference is a
 * worker's confirmation. Two drains must never run at once (see `draining`
 * above), but the interval and the `online` handler are not the only callers:
 * `submitCart` awaits its own drain to learn whether THIS order reached the
 * server, and «Заявка № … передана» is the whole point of the confirmation. An
 * early return would resolve that await having done nothing, and the kiosk
 * would tell an ONLINE worker their order is queued with no number — precisely
 * during backlog recovery, when the `online` handler is draining an outage and
 * workers are submitting again.
 *
 * Handing the second caller the promise already in flight would be simpler and
 * is wrong for one reason: `listQueue` below is read ONCE, before the first
 * submission, so a drain already running snapshotted a queue that this caller's
 * order was never in. Awaiting it would resolve having delivered everything
 * EXCEPT the one order somebody is standing there waiting on. So each call gets
 * a drain of its own, chained behind whatever is already owed — which keeps the
 * no-overlap invariant (the chain is sequential) and makes the resolution mean
 * "the queue as of your call has been attempted".
 *
 * The chained drain uses the CLIENT ITS OWN CALLER PASSED, which the shell
 * depends on: that client is the one recording the reply for the order being
 * awaited.
 */
export function flushQueue(client: KioskClient, now: () => Date): Promise<void> {
  // Started synchronously when nothing is in flight, so a lone caller reads the
  // queue at call time exactly as it always did.
  const run =
    draining === null ? drainOnce(client, now) : draining.then(() => drainOnce(client, now));
  // `drainOnce` never rejects, so the catch is unreachable today; it is here so
  // that a future one could not poison every drain queued behind it. Clearing
  // the tail when it is still ours keeps an idle device from holding a chain of
  // settled promises.
  const tail: Promise<void> = run
    .catch(() => {})
    .then(() => {
      if (draining === tail) draining = null;
    });
  draining = tail;
  return tail;
}

/** One pass over the queue. Never rejects, never overlaps another — the
 * serialisation is `flushQueue`'s, which is the only caller. */
async function drainOnce(client: KioskClient, now: () => Date): Promise<void> {
  try {
    const queued = await listQueue(); // ascending deviceSeq
    for (const order of queued) {
      try {
        const result = await client.submitOrder(order.body);
        const at = now().toISOString();
        await appendJournal({
          at,
          // The order's own scan time, which is what the server files it under
          // (`createFromKiosk`: `when = dto.createdAt ?? new Date()`). The
          // fallback mirrors that second branch — with no `createdAt` in the
          // body the server stamps the order as it arrives, which is this
          // moment. Journalling the sync time instead would move an order
          // queued through an outage into the wrong day for the day count.
          createdAt: order.body.createdAt ?? at,
          deviceSeq: order.deviceSeq,
          orderNo: result.orderNo,
          // Whom the DEVICE opened the session for; the server re-resolves the
          // badge and may disagree, which is one of several reasons the local
          // day count is best-effort.
          employeeId: order.employeeId,
          // What the server ACCEPTED. A refused item never counted against the
          // worker server-side, so it must not count against them here.
          acceptedCount: result.itemCount,
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
 * stored (`assertMeasurableGeneratedAt`, shared with the pairing screen, which
 * writes a snapshot too), down the same path as a dead network — so the device
 * keeps its last-known-good snapshot and ages fresh → warn → blocked over seven
 * days (a six-day warning window) instead of locking out on the spot.
 *
 * Only `generatedAt` is checked, not the whole payload. `zod` is a declared
 * dependency but nothing in `src/` validates responses yet; full response
 * validation is a separate concern and does not belong in this guard.
 */
export async function refreshSnapshot(client: KioskClient, now: () => Date): Promise<void> {
  const bootstrap = await client.bootstrap();
  assertMeasurableGeneratedAt(bootstrap);
  await replaceSnapshot(bootstrap, now());
}
