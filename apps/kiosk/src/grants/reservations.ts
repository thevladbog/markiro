import { draftKey, type PickupDraft } from "./drafts.js";
import { kioskGrantReservationResultSchema } from "@markiro/platform-contracts";
import type { CreateOrderDto } from "../api/types.js";
import { STORE_GRANTS, STORE_QUEUE, withStore } from "../store/db.js";
import {
  sameBoxRegistryCredentialOwner,
  type BoxRegistryCredentialOwner,
} from "../store/installation-binding.js";
import type { QueuedOrder } from "../store/queue.js";
import { orderContent, sha256 } from "./scope.js";
import { runChecked, withGrantTransaction } from "./store.js";
import type { GrantRequestLease } from "./transport.js";
export interface GrantReservation {
  credentialGeneration: string;
  deviceSeq: number;
  taskId: string;
  snapshotDigest: string;
  payloadDigest: string;
  admission: { claimedAt: string; admissionProof: string };
}
export const reservationKey = (owner: BoxRegistryCredentialOwner, seq: number) =>
  JSON.stringify(["reservation", owner.binding.serverUrl, owner.binding.kioskId, seq]);
export async function readGrantReservation(
  owner: BoxRegistryCredentialOwner,
  seq: number,
): Promise<GrantReservation | null> {
  return (
    (await withStore<GrantReservation>(STORE_GRANTS, "readonly", (store) =>
      store.get(reservationKey(owner, seq)),
    )) ?? null
  );
}
/** The queued owner already accepted this order. Reservation attachment grants no new work. */
export async function persistGrantReservation(
  lease: GrantRequestLease,
  body: CreateOrderDto,
  response: unknown,
): Promise<boolean> {
  const result = kioskGrantReservationResultSchema.parse(response);
  if (result.status !== "reserved") return false;
  const content = orderContent(body),
    payloadDigest = await sha256(content);
  let installed = false;
  await withGrantTransaction([STORE_QUEUE], (context) => {
    if (
      !sameBoxRegistryCredentialOwner(context.owner, lease.owner) ||
      context.state?.requestedSequence !== lease.sequence
    )
      return;
    const request = context.tx.objectStore(STORE_QUEUE).get(body.deviceSeq);
    const draftRequest = context.store.get(draftKey(lease.owner, body.deviceSeq));
    let remaining = 2;
    const ready = () =>
      runChecked(context.tx, () => {
        if (--remaining) return;
        const draft = draftRequest.result as PickupDraft | undefined;
        const queued =
          (request.result as QueuedOrder | undefined) ??
          (draft?.status === "pending" && sameBoxRegistryCredentialOwner(draft.owner, lease.owner)
            ? draft
            : undefined);
        if (!queued || orderContent(queued.body) !== content) return;
        const key = reservationKey(lease.owner, body.deviceSeq),
          oldRequest = context.store.get(key);
        oldRequest.onsuccess = () =>
          runChecked(context.tx, () => {
            const previous = oldRequest.result as GrantReservation | undefined;
            if (
              previous &&
              (previous.taskId !== result.task.taskId ||
                previous.snapshotDigest !== result.task.snapshotDigest ||
                previous.payloadDigest !== payloadDigest)
            )
              throw Error("grant_reservation_conflict");
            context.store.put(
              {
                credentialGeneration: lease.owner.credentialGeneration,
                deviceSeq: body.deviceSeq,
                taskId: result.task.taskId,
                snapshotDigest: result.task.snapshotDigest,
                payloadDigest,
                admission: result.admission,
              } satisfies GrantReservation,
              key,
            );
            installed = true;
          });
      });
    request.onsuccess = ready;
    draftRequest.onsuccess = ready;
  });
  return installed;
}
