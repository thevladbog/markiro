import type { CreateOrderDto } from "../api/types.js";
import { STORE_QUARANTINE, STORE_QUEUE, updateEach, withStore } from "./db.js";

export interface QueuedOrder {
  deviceSeq: number;
  /**
   * Which employee this device opened the session for. Alongside the body
   * rather than inside it, and that is the point: `CreateOrderDto` is what
   * goes over the wire, where the badge is re-resolved server-side, so this id
   * is device-local bookkeeping — it is what lets the day count charge an
   * order that has not synced yet to the worker who took it.
   *
   * An order queued by an app version older than this one has none, and is
   * skipped by the count rather than attributed to whoever asks.
   */
  employeeId: string;
  /**
   * The request, verbatim, because this record IS the order until the server
   * has one.
   *
   * Which is why the body names the badge by DIGEST and not by the scanned
   * code (`CreateOrderDto.badgeDigest`): this store, and the quarantine store
   * that outlives it, are the only places on an unattended tablet that hold an
   * order body at rest, and a badge code is the one credential here that also
   * works away from the device. `store/scrub.ts` clears the codes an earlier
   * version of the app left behind.
   */
  body: CreateOrderDto;
  /**
   * New orders first persist in this state before any request is made. The
   * sync worker owns the whole attest -> persist -> submit sequence, so a
   * refresh/online drain cannot race the shell and submit the proofless body.
   * Missing means an older queued record, or one whose exact attestation has
   * already been persisted and is safe to submit after a restart.
   */
  admissionState?: "pending_attestation";
  admissionNonce?: string;
}

/** Queues one scanned order. `deviceSeq` is the store's `keyPath`, so this is
 * the only place a queued order's key is derived — from the body itself. */
export async function enqueueOrder(
  body: CreateOrderDto,
  employeeId: string,
  admissionState?: "pending_attestation",
): Promise<void> {
  const record: QueuedOrder = {
    deviceSeq: body.deviceSeq,
    employeeId,
    body,
    ...(admissionState ? { admissionState } : {}),
  };
  await withStore(STORE_QUEUE, "readwrite", (s) => s.put(record));
}

/**
 * Adds the server reservation to a queued order without resurrecting a record
 * that a concurrent drain already acknowledged. IndexedDB serialises this
 * cursor transaction with the drain's delete transaction.
 */
export async function attestQueuedOrder(deviceSeq: number, body: CreateOrderDto): Promise<boolean> {
  const updated = await updateEach(STORE_QUEUE, (value) => {
    const queued = value as QueuedOrder;
    if (queued.deviceSeq !== deviceSeq || queued.admissionState !== "pending_attestation") {
      return null;
    }
    const completed: QueuedOrder = { ...queued, body };
    delete completed.admissionState;
    return completed;
  });
  return updated === 1;
}

export async function persistAdmissionNonce(deviceSeq: number, nonce: string): Promise<boolean> {
  const updated = await updateEach(STORE_QUEUE, (value) => {
    const queued = value as QueuedOrder;
    if (queued.deviceSeq !== deviceSeq || queued.admissionState !== "pending_attestation")
      return null;
    return { ...queued, admissionNonce: nonce };
  });
  return updated === 1;
}

/** Orders awaiting sync, ascending by `deviceSeq` — `getAll()` on a store
 * keyed by `deviceSeq` walks the key range in ascending order, which is
 * exactly the drain order the server's idempotency contract requires. */
export async function listQueue(): Promise<QueuedOrder[]> {
  const found = await withStore<QueuedOrder[]>(STORE_QUEUE, "readonly", (s) => s.getAll());
  return found ?? [];
}

export async function dequeueOrder(deviceSeq: number): Promise<void> {
  await withStore(STORE_QUEUE, "readwrite", (s) => s.delete(deviceSeq));
}

/**
 * A queued order the server refused for good, kept aside rather than dropped.
 *
 * The whole `QueuedOrder` is carried, not a summary: the raw marking codes are
 * the only way an administrator can tell which bottles a refused pickup was
 * for, and re-deriving them from a journal line is impossible. Kept out of the
 * `queue` store so the drain stops offering it and the day count stops charging
 * it to the worker (the server never counted it), and out of the `journal`,
 * which is pruned after two weeks and is a log rather than custody.
 */
export interface QuarantinedOrder extends QueuedOrder {
  /** When the device set it aside, from the device's own clock. */
  at: string;
  /**
   * The HTTP status the server refused it with — `0` when the order was parked
   * without a verdict at all, which is what a revoked device does with a queue
   * its token can no longer deliver.
   */
  status: number;
  /** The server's own message, verbatim, so the reason survives the refusal. */
  message: string;
}

/** Sets one order aside. Idempotent: `deviceSeq` is the store's `keyPath`, so
 * a replay after a crash overwrites its own record instead of adding a second. */
export async function quarantineOrder(order: QuarantinedOrder): Promise<void> {
  await withStore(STORE_QUARANTINE, "readwrite", (s) => s.put(order));
}

/** Everything set aside, ascending by `deviceSeq` — nothing prunes this store:
 * a refused pickup stays inspectable until somebody deals with it. */
export async function listQuarantine(): Promise<QuarantinedOrder[]> {
  const found = await withStore<QuarantinedOrder[]>(STORE_QUARANTINE, "readonly", (s) =>
    s.getAll(),
  );
  return found ?? [];
}

/**
 * Sets the WHOLE queue aside, for the one case where nothing in it can ever be
 * delivered: the device's token has been revoked.
 *
 * Not merely tidy — leaving the queue in place is actively dangerous. Re-pairing
 * a revoked device redeems a code for a DIFFERENT kiosk row, whose
 * `nextDeviceSeq` starts at 0, so the old orders would drain under sequences the
 * new identity is about to reuse. The server answers a repeated
 * `(tenantId, kioskId, deviceSeq)` by returning the FIRST order rather than
 * filing a second, so some later worker's whole cart would evaporate and be
 * confirmed to them under a stranger's order number — the exact silent failure
 * `submitCart`'s counter ordering exists to prevent.
 *
 * Custody before removal, one order at a time, so a failure part-way through
 * leaves the rest queued rather than lost. Returns how many were parked.
 */
export async function quarantineQueue(at: Date, message: string): Promise<number> {
  const stamp = at.toISOString();
  let parked = 0;
  for (const order of await listQueue()) {
    // Status 0: there was no verdict on this ORDER at all. The server never
    // refused it — the device simply lost the right to offer it.
    await quarantineOrder({ ...order, at: stamp, status: 0, message });
    await dequeueOrder(order.deviceSeq);
    parked += 1;
  }
  return parked;
}
