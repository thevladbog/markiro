import type { CreateOrderDto } from "../api/types.js";
import { STORE_QUEUE, withStore } from "./db.js";

export interface QueuedOrder {
  deviceSeq: number;
  body: CreateOrderDto;
}

/** Queues one scanned order. `deviceSeq` is the store's `keyPath`, so this is
 * the only place a queued order's key is derived — from the body itself. */
export async function enqueueOrder(body: CreateOrderDto): Promise<void> {
  const record: QueuedOrder = { deviceSeq: body.deviceSeq, body };
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
