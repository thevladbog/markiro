import type { CreateOrderDto } from "../api/types.js";
import { STORE_QUEUE, withStore } from "./db.js";

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
  body: CreateOrderDto;
}

/** Queues one scanned order. `deviceSeq` is the store's `keyPath`, so this is
 * the only place a queued order's key is derived — from the body itself. */
export async function enqueueOrder(body: CreateOrderDto, employeeId: string): Promise<void> {
  const record: QueuedOrder = { deviceSeq: body.deviceSeq, employeeId, body };
  await withStore(STORE_QUEUE, "readwrite", (s) => s.put(record));
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
