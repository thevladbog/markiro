import { readPickupDraft, draftKey, type PickupDraft } from "./drafts.js";
import type { TaskGrant, GrantTaskSnapshot } from "@markiro/domain";
import type { CachedSnapshot } from "../store/cache.js";
import type { StoredBoxRegistryRow, BoxRegistryMeta } from "../store/box-registry.js";
import type { QueuedOrder } from "../store/queue.js";
import {
  STORE_QUEUE,
  STORE_SNAPSHOT,
  STORE_BOX_REGISTRY_ACTIVE,
  STORE_BOX_REGISTRY_META,
  withStore,
} from "../store/db.js";
import { sameBoxRegistryCredentialOwner } from "../store/installation-binding.js";
import { readGrantReservation, reservationKey, type GrantReservation } from "./reservations.js";
import { canonical, orderContent, sha256, verifyPickupScope, type PickupScope } from "./scope.js";
import { runChecked, type GrantContext } from "./store.js";
import type { GrantRequestLease } from "./transport.js";
export const PICKUP_BINDING_STORES = [
  STORE_QUEUE,
  STORE_SNAPSHOT,
  STORE_BOX_REGISTRY_ACTIVE,
  STORE_BOX_REGISTRY_META,
];
export interface PickupBinding {
  deviceSeq: number;
  canonical: string;
  scope: PickupScope;
  queue: QueuedOrder | PickupDraft;
  draft: boolean;
  reservation: GrantReservation;
  snapshot: CachedSnapshot;
  rows: StoredBoxRegistryRow[];
  meta: BoxRegistryMeta | null;
}
export async function preparePickupBinding(
  lease: GrantRequestLease,
  grant: TaskGrant,
  snapshots: GrantTaskSnapshot[],
  deviceSeq: number,
): Promise<PickupBinding> {
  const [queued, reservation, snapshot, rows, meta, draft] = await Promise.all([
    withStore<QueuedOrder>(STORE_QUEUE, "readonly", (s) => s.get(deviceSeq)),
    readGrantReservation(lease.owner, deviceSeq),
    withStore<CachedSnapshot>(STORE_SNAPSHOT, "readonly", (s) => s.get("current")),
    withStore<StoredBoxRegistryRow[]>(STORE_BOX_REGISTRY_ACTIVE, "readonly", (s) => s.getAll()),
    withStore<BoxRegistryMeta>(STORE_BOX_REGISTRY_META, "readonly", (s) => s.get("active")),
    readPickupDraft(lease.owner, deviceSeq),
  ]);
  const queue =
    queued ??
    (draft?.status === "pending" && sameBoxRegistryCredentialOwner(draft.owner, lease.owner)
      ? draft
      : null);
  const binding = snapshots.find(
    (s) =>
      s.taskKind === "pickup" &&
      s.taskId === grant.taskId &&
      s.snapshotDigest === grant.snapshotDigest,
  );
  if (
    !queue ||
    !reservation ||
    !snapshot ||
    !binding ||
    grant.taskKind !== "pickup" ||
    reservation.credentialGeneration !== lease.owner.credentialGeneration ||
    reservation.taskId !== grant.taskId ||
    reservation.snapshotDigest !== grant.snapshotDigest ||
    reservation.payloadDigest !== (await sha256(orderContent(queue.body)))
  )
    throw Error("grant_task_binding");
  if (queue.body.boxes?.length && !sameBoxRegistryCredentialOwner(meta ?? null, lease.owner))
    throw Error("grant_registry_owner");
  const scope = await verifyPickupScope(
    binding.canonical,
    binding.snapshotDigest,
    grant.taskId,
    queue.body,
    snapshot.bootstrap.products,
    rows ?? [],
  );
  return {
    deviceSeq,
    canonical: binding.canonical,
    scope,
    queue,
    draft: !queued,
    reservation,
    snapshot,
    rows: rows ?? [],
    meta: meta ?? null,
  };
}
/** Rechecks every independently saved input after crypto; a dequeue wins and never resurrects. */
export function commitPickupBinding(
  context: GrantContext,
  lease: GrantRequestLease,
  binding: PickupBinding,
  commit: () => void,
): void {
  const reads = [
    binding.draft
      ? context.store.get(draftKey(lease.owner, binding.deviceSeq))
      : context.tx.objectStore(STORE_QUEUE).get(binding.deviceSeq),
    context.store.get(reservationKey(lease.owner, binding.deviceSeq)),
    context.tx.objectStore(STORE_SNAPSHOT).get("current"),
    context.tx.objectStore(STORE_BOX_REGISTRY_ACTIVE).getAll(),
    context.tx.objectStore(STORE_BOX_REGISTRY_META).get("active"),
  ];
  let remaining = reads.length;
  for (const request of reads)
    request.onsuccess = () =>
      runChecked(context.tx, () => {
        if (--remaining) return;
        const expected = [
          binding.queue,
          binding.reservation,
          binding.snapshot,
          binding.rows,
          binding.meta ?? undefined,
        ];
        if (
          reads.some(
            (read, index) => JSON.stringify(read.result) !== JSON.stringify(expected[index]),
          )
        )
          return;
        commit();
      });
}
export function pickupEvidenceKey(context: GrantContext, grant: TaskGrant): string {
  return canonical([
    "task",
    context.owner?.binding.serverUrl,
    grant.tenantId,
    grant.deviceId,
    grant.taskKind,
    grant.taskId,
    grant.snapshotDigest,
  ]);
}
