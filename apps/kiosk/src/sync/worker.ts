import { KioskApiError, type KioskClient } from "../api/client.js";
import {
  assertMeasurableGeneratedAt,
  replaceSnapshot,
  type CachedSnapshot,
} from "../store/cache.js";
import { appendJournal } from "../store/journal.js";
import { dequeueOrder, listQueue, quarantineOrder, type QueuedOrder } from "../store/queue.js";

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
 * WHAT TIME THE SERVER THINKS IT IS, reconstructed on the device.
 *
 * The snapshot holds both halves of one instant: `generatedAt` is the SERVER's
 * stamp for it, `fetchedAt` the DEVICE's stamp for receiving it. Their
 * difference is this device's offset from the server's clock, established the
 * last time the two were provably in contact, and adding it to the device
 * clock cancels a constant skew out of everything downstream.
 *
 * TWO BUGS SHARE THIS ROOT, and both are fixed by measuring through the offset
 * rather than by subtracting two absolute clocks:
 *
 *  - a tablet more than seven days FAST used to read a bootstrap generated
 *    seconds ago as older than `STALE_BLOCK_MS`, so every successful refresh
 *    left an otherwise healthy kiosk on the Blocked screen — «обратитесь к
 *    администратору» about a network that is working perfectly;
 *  - and the same skew, applied to an order's `createdAt`, moved the withdrawal
 *    into a UTC day the worker had not spent yet, which is a fresh daily
 *    allowance for anyone who can reach the tablet's date setting.
 *
 * An UNMEASURABLE offset yields an Invalid Date rather than the raw device
 * clock, and every caller treats that as "cannot establish the time" — the same
 * fail-closed rule `cacheAge` applies to an unparseable stamp. Falling back to
 * the device's own clock would hand back exactly the trust this exists to
 * remove.
 */
export function serverNow(snapshot: CachedSnapshot | null, now: Date): Date {
  if (!snapshot) return new Date(Number.NaN);
  const offsetMs = Date.parse(snapshot.bootstrap.generatedAt) - Date.parse(snapshot.fetchedAt);
  if (Number.isNaN(offsetMs)) return new Date(Number.NaN);
  return new Date(now.getTime() + offsetMs);
}

/**
 * The same gate, asked of what the device actually holds.
 *
 * Asked in SERVER time (`serverNow` above), which is what makes this measure
 * how long ago the dataset was fetched rather than how far apart the two clocks
 * are. The arithmetic reduces to `now - fetchedAt` — two readings of the SAME
 * clock — so a device hours or years off the server's time still ages its
 * snapshot at one second per second, and any successful refresh re-establishes
 * the offset.
 *
 * That does not put the device's clock back in charge of the lockout. The
 * measurement is a DIFFERENCE between two device readings, so a constant skew
 * cancels; only a clock moved BACKWARDS between refreshes can shorten it, and
 * that direction already read `fresh` when the age was measured against
 * `generatedAt` (see the future-stamp rule above). What it removes is the
 * failure in the other direction, where a fast clock bricked a working kiosk.
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
  // An unmeasurable `fetchedAt` makes `serverNow` an Invalid Date, whose
  // `getTime()` is NaN — so `cacheAge` blocks, exactly as it does for an
  // unmeasurable `generatedAt`. Both halves of the offset must be readable for
  // this gate to assert anything.
  return cacheAge(snapshot.bootstrap.generatedAt, serverNow(snapshot, now));
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
 *    The one exception is an order the server refuses PERMANENTLY, which is
 *    not "stuck" but "answered": see `isTerminalRejection` below. It is moved
 *    aside so the drain can carry on, and moving it aside cannot reorder
 *    anything, because it is never going to be filed at all.
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

/**
 * The statuses that mean THIS ORDER will never be accepted, however many times
 * it is offered — the only failures allowed to take an order out of the queue
 * without the server having filed it.
 *
 * TWO ARE REACHABLE, and both are the same shape: something the cabinet
 * changed while the order sat in an offline queue.
 *
 *  - 400 — a write-off whose reason an administrator archived before the kiosk
 *    synced (`resolveWriteoffReasonId`, «Unknown or archived writeoff reason»);
 *  - 422 — a badge that no longer resolves to an active employee, deleted or
 *    archived server-side after the scan (`createFromKiosk` step 2, «Unknown or
 *    inactive badge»).
 *
 * Without a quarantine either one parks at the head of the queue and every
 * later purchase sits behind it while the kiosk goes on cheerfully accepting
 * and confirming new ones.
 *
 * THE 422 IS THE SERVER'S HALF OF THIS RULE and was hard-won: an unknown badge
 * used to answer 401, which is the one status this list must never contain, so
 * that order was undeliverable AND unquarantinable and blocked the queue
 * permanently. The device cannot repair that from here — a status is all it
 * gets, and sniffing the message string would be worse — so the fix is that the
 * server no longer describes a bad ORDER with the device's own credential
 * status. Keep the two apart: adding 401 here to "handle" a bad badge would
 * trade a stalled queue for an emptied one.
 *
 * DELIBERATELY AN ALLOWLIST, not "any 4xx". The two statuses that would be
 * catastrophic to include are both 4xx:
 *
 *  - 401 is the DEVICE's credential, not the order — a revoked or archived
 *    kiosk answers every request with it, so quarantining on it would empty a
 *    whole queue on a revocation instead of routing the device back to pairing
 *    (`isDeviceRevoked`, handled in the shell's refresh);
 *  - 404 is overwhelmingly a MISCONFIGURED SERVER URL or a reverse proxy that
 *    has lost the route, and a kiosk pointed at the wrong host would otherwise
 *    quarantine every order it ever took, one by one, while the network is
 *    perfectly healthy.
 *
 * 408 and 429 are transport back-pressure and retry by definition. A status
 * left off this list costs only a stalled queue that recovers; one wrongly on
 * it costs orders that could have been delivered — so the list stays the three
 * the server actually raises against a body it will never take.
 */
const TERMINAL_STATUSES: ReadonlySet<number> = new Set([400, 409, 422]);

export function isTerminalRejection(err: unknown): boolean {
  return err instanceof KioskApiError && TERMINAL_STATUSES.has(err.status);
}

/**
 * Moves a permanently refused order aside. NOTHING IS DROPPED — the whole
 * record, raw marking codes and all, goes to the quarantine store, which is
 * never pruned, and the refusal is journalled where the service screen already
 * reads verdicts from.
 *
 * CUSTODY BEFORE REMOVAL, the same invariant the success path keeps: the order
 * leaves the queue only once its body is durable elsewhere. A crash in between
 * replays the submit, collects the same refusal and re-parks it — harmless,
 * because the quarantine store is keyed by `deviceSeq` and a second `put`
 * overwrites the first.
 *
 * Answers whether the drain may CONTINUE. A store that refused the hand-over
 * leaves the order exactly where it was, and the caller stops rather than
 * skipping it — an order still in the queue must not be overtaken.
 */
async function quarantine(
  order: QueuedOrder,
  err: KioskApiError,
  now: () => Date,
): Promise<boolean> {
  const at = now().toISOString();
  try {
    await quarantineOrder({ ...order, at, status: err.status, message: err.message });
  } catch (storeErr) {
    console.error("kiosk: a refused order could not be set aside", storeErr);
    return false;
  }
  try {
    await appendJournal({
      at,
      // The scan time, as on the success path: a refusal has to be readable
      // beside the day it belongs to, not the day it was finally answered.
      createdAt: order.body.createdAt ?? at,
      deviceSeq: order.deviceSeq,
      // The vocabulary `Done` already uses for an order the server refused
      // outright, so the service screen needs no new state to read one.
      orderNo: "",
      employeeId: order.employeeId,
      // Nothing was accepted, so nothing is charged to the worker — the same
      // rule the success path applies to a refused ITEM, applied to the order.
      acceptedCount: 0,
      conflicts: [],
    });
  } catch (journalErr) {
    // Best effort: the quarantine record is the custody, the journal is the
    // log. Losing the log line must not put the order back in the queue.
    console.warn("kiosk: a refused order could not be journalled", journalErr);
  }
  try {
    await dequeueOrder(order.deviceSeq);
  } catch (storeErr) {
    console.error("kiosk: a refused order could not leave the queue", storeErr);
    return false;
  }
  return true;
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
      } catch (err) {
        // A verdict the order can never come back from is not a stall: park it
        // and carry on, so one poisoned record cannot hold a day's pickups.
        // A timeout is deliberately NOT one of these — `KioskTimeoutError`
        // carries no status, so an aborted request stays retryable and the
        // order stays queued.
        if (isTerminalRejection(err) && (await quarantine(order, err as KioskApiError, now))) {
          continue;
        }
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
 * AND MUST NOT READ EVERY REJECTION AS AN OUTAGE. A `KioskApiError` with status
 * 401 (`isDeviceRevoked`) is the server ANSWERING — the kiosk archived, or a
 * replacement device having redeemed a new token — and the device that treats
 * it as a blink goes on admitting employees for the seven days its cached
 * roster takes to age out. The shell's `revoke` handles it.
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
