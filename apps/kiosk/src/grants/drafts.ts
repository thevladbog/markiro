import type { CreateOrderDto } from "../api/types.js";
import { createConfirmedOrderBody, type ConfirmedKioskFlowState } from "../session/flow.js";
import type { CartState } from "../session/cart.js";
import type { BoxRegistryCredentialOwner } from "../store/installation-binding.js";
import { sameBoxRegistryCredentialOwner } from "../store/installation-binding.js";
import { STORE_CONFIG, STORE_SNAPSHOT, withStore, STORE_GRANTS } from "../store/db.js";
import type { CachedSnapshot } from "../store/cache.js";
import { buildBadgeIndex } from "../credentials/badge.js";
import { assertNewWork, GrantDenied } from "./admission.js";
import { runChecked, withGrantTransaction } from "./store.js";
export interface PickupDraft {
  recordType: "pickup-draft";
  owner: BoxRegistryCredentialOwner;
  employeeId: string;
  badgeDigest: string;
  body: CreateOrderDto;
  cart: CartState;
  nonce: string;
  status: "pending" | "accepted" | "abandoned";
  taskReady?: boolean;
}
export const draftKey = (owner: BoxRegistryCredentialOwner, seq: number) =>
  JSON.stringify(["draft", owner.binding.serverUrl, owner.binding.kioskId, seq]);
const isDraft = (value: unknown): value is PickupDraft =>
  value !== null &&
  typeof value === "object" &&
  (value as { recordType?: unknown }).recordType === "pickup-draft";
export async function readPickupDraft(
  owner: BoxRegistryCredentialOwner,
  seq: number,
): Promise<PickupDraft | null> {
  return (
    (await withStore<PickupDraft>(STORE_GRANTS, "readonly", (s) => s.get(draftKey(owner, seq)))) ??
    null
  );
}
/** Reserve a sequence and confirmed intent atomically before any online freeze. No raw badge stored. */
export async function preparePickupDraft(
  owner: BoxRegistryCredentialOwner,
  confirmed: ConfirmedKioskFlowState,
  createdAt: string,
): Promise<PickupDraft> {
  let result: PickupDraft | null = null;
  const nonce = crypto.randomUUID().replaceAll("-", "");
  await withGrantTransaction([STORE_SNAPSHOT], (context) => {
    if (!sameBoxRegistryCredentialOwner(context.owner, owner) || !context.config)
      throw new GrantDenied("wrong_owner");
    const cfg = context.config,
      all = context.store.getAll(),
      snapshotRequest = context.tx.objectStore(STORE_SNAPSHOT).get("current");
    let pending = 2;
    const ready = () =>
      runChecked(context.tx, () => {
        if (--pending) return;
        const snapshot = snapshotRequest.result as CachedSnapshot | undefined;
        if (
          !snapshot ||
          buildBadgeIndex(snapshot.bootstrap).get(confirmed.session.badgeDigest) !==
            confirmed.session.employee.id
        )
          throw new GrantDenied("wrong_owner");
        const saved = (all.result as unknown[])
          .filter(isDraft)
          .find(
            (d) =>
              d.status === "pending" &&
              sameBoxRegistryCredentialOwner(d.owner, owner) &&
              d.employeeId === confirmed.session.employee.id &&
              d.badgeDigest === confirmed.session.badgeDigest &&
              JSON.stringify(d.cart) === JSON.stringify(confirmed.session.cart),
          );
        if (saved) {
          if (!saved.taskReady) assertNewWork(context);
          result = saved;
          return;
        }
        assertNewWork(context);
        for (const previous of (all.result as unknown[]).filter(isDraft)) {
          if (
            previous.status === "pending" &&
            sameBoxRegistryCredentialOwner(previous.owner, owner) &&
            previous.employeeId === confirmed.session.employee.id
          )
            context.store.put(
              { ...previous, status: "abandoned" },
              draftKey(owner, previous.body.deviceSeq),
            );
        }
        const deviceSeq = cfg.nextDeviceSeq;
        if (
          !Number.isSafeInteger(deviceSeq) ||
          deviceSeq < 0 ||
          !Number.isSafeInteger(deviceSeq + 1)
        )
          throw Error("kiosk_order_sequence_conflict");
        result = {
          recordType: "pickup-draft",
          owner,
          employeeId: confirmed.session.employee.id,
          badgeDigest: confirmed.session.badgeDigest,
          cart: confirmed.session.cart,
          body: createConfirmedOrderBody(confirmed, deviceSeq, createdAt),
          nonce,
          status: "pending",
        };
        context.store.add(result, draftKey(owner, deviceSeq));
        context.tx
          .objectStore(STORE_CONFIG)
          .put({ ...cfg, nextDeviceSeq: deviceSeq + 1 }, "current");
      });
    all.onsuccess = ready;
    snapshotRequest.onsuccess = ready;
  });
  if (!result) throw new GrantDenied("wrong_task");
  return result;
}
/** Fresh badge authentication selects only this human's exact frozen confirmed draft. */
export async function recoverPickupDraft(
  owner: BoxRegistryCredentialOwner,
  employeeId: string,
  badgeDigest: string,
): Promise<PickupDraft | null> {
  let result: PickupDraft | null = null;
  await withGrantTransaction([STORE_SNAPSHOT], (context) => {
    if (!sameBoxRegistryCredentialOwner(context.owner, owner)) return;
    const all = context.store.getAll(),
      snapshot = context.tx.objectStore(STORE_SNAPSHOT).get("current");
    let remaining = 2;
    const ready = () =>
      runChecked(context.tx, () => {
        if (--remaining) return;
        const current = snapshot.result as CachedSnapshot | undefined;
        if (!current || buildBadgeIndex(current.bootstrap).get(badgeDigest) !== employeeId) return;
        result =
          (all.result as unknown[])
            .filter(isDraft)
            .filter(
              (d) =>
                d.status === "pending" &&
                d.taskReady &&
                sameBoxRegistryCredentialOwner(d.owner, owner) &&
                d.employeeId === employeeId &&
                d.badgeDigest === badgeDigest,
            )
            .sort((a, b) => b.body.deviceSeq - a.body.deviceSeq)[0] ?? null;
      });
    all.onsuccess = ready;
    snapshot.onsuccess = ready;
  });
  return result;
}
/** Explicit cancellation retires preparation; an in-flight response cannot revive it. */
export async function abandonPickupDrafts(
  owner: BoxRegistryCredentialOwner,
  employeeId: string,
  cart: CartState,
): Promise<void> {
  await withGrantTransaction([], (context) => {
    if (!sameBoxRegistryCredentialOwner(context.owner, owner)) return;
    const request = context.store.getAll();
    request.onsuccess = () =>
      runChecked(context.tx, () => {
        for (const draft of (request.result as unknown[]).filter(isDraft))
          if (
            draft.status === "pending" &&
            sameBoxRegistryCredentialOwner(draft.owner, owner) &&
            draft.employeeId === employeeId &&
            JSON.stringify(draft.cart) === JSON.stringify(cart)
          )
            context.store.put(
              { ...draft, status: "abandoned" },
              draftKey(owner, draft.body.deviceSeq),
            );
      });
  });
}
/** Finds the exact pending intent during an authenticated observe rollback. */
export async function matchingPickupDraft(
  owner: BoxRegistryCredentialOwner,
  confirmed: ConfirmedKioskFlowState,
): Promise<PickupDraft | null> {
  const values = await withStore<unknown[]>(STORE_GRANTS, "readonly", (store) => store.getAll());
  return (
    (values ?? [])
      .filter(isDraft)
      .find(
        (draft) =>
          draft.status === "pending" &&
          sameBoxRegistryCredentialOwner(draft.owner, owner) &&
          draft.employeeId === confirmed.session.employee.id &&
          draft.badgeDigest === confirmed.session.badgeDigest &&
          JSON.stringify(draft.cart) === JSON.stringify(confirmed.session.cart),
      ) ?? null
  );
}
