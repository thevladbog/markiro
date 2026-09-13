import {
  assessCompletion,
  grantEventCost,
  type TaskGrant,
  type GrantIntent,
} from "@markiro/domain";
import type { CreateOrderDto } from "../api/types.js";
import type { CachedSnapshot } from "../store/cache.js";
import type { StoredBoxRegistryRow } from "../store/box-registry.js";
import {
  sameBoxRegistryCredentialOwner,
  type BoxRegistryCredentialOwner,
} from "../store/installation-binding.js";
import { STORE_GRANTS, withStore } from "../store/db.js";
import { readGrantState, runChecked, type GrantContext, type StoredGrant } from "./store.js";
import { readGrantReservation, reservationKey, type GrantReservation } from "./reservations.js";
import { draftKey, type PickupDraft } from "./drafts.js";
import { canonical, orderContent, assertPickupScopeFacts, type PickupScope } from "./scope.js";
import { clockSample, trustedNow } from "./clock.js";
import { GrantDenied } from "./admission.js";
export type StoredPickupGrant = StoredGrant & {
  scope: PickupScope;
  canonical: string;
  deviceSeq: number;
  purpose: string;
};
export const taskKey = (
  origin: string,
  tenantId: string,
  deviceId: string,
  taskId: string,
  digest: string,
) => canonical(["task", origin, tenantId, deviceId, "pickup", taskId, digest]);
export const counterKey = (grant: TaskGrant) =>
  canonical([
    "consumed",
    grant.tenantId,
    grant.deviceId,
    "pickup",
    grant.taskId,
    grant.snapshotDigest,
  ]);
function intent(
  grant: TaskGrant,
  context: GrantContext,
  cost: Record<string, number>,
): GrantIntent {
  return {
    owner: {
      tenantId: context.state?.tenantId ?? "",
      deviceId: context.owner?.binding.kioskId ?? "",
      kind: "kiosk",
      credentialEpoch: context.state?.epoch ?? 0,
    },
    capability: "pickup.start.v1",
    taskId: grant.taskId,
    snapshotDigest: grant.snapshotDigest,
    eventId: `pickup:${grant.taskId}`,
    eventType: "pickup.complete.v1",
    cost,
  };
}
/** Consume every dimension, advance trusted time and accept the draft in the caller's queue transaction. */
export function commitPickupCompletion(
  context: GrantContext,
  body: CreateOrderDto,
  employeeId: string,
  payloadDigest: string,
  snapshot: CachedSnapshot,
  rows: StoredBoxRegistryRow[],
  cost: Record<string, number>,
  commit: (task: StoredPickupGrant) => void,
): void {
  const owner = context.owner,
    state = context.state;
  if (!owner || !state?.tenantId) throw new GrantDenied("missing_grant");
  const tenantId = state.tenantId;
  const draftRequest = context.store.get(draftKey(owner, body.deviceSeq)),
    reservationRequest = context.store.get(reservationKey(owner, body.deviceSeq));
  let pending = 2;
  const ready = () =>
    runChecked(context.tx, () => {
      if (--pending) return;
      const draft = draftRequest.result as PickupDraft | undefined,
        reservation = reservationRequest.result as GrantReservation | undefined;
      if (!draft || !reservation) throw new GrantDenied("missing_grant");
      if (
        draft.status !== "pending" ||
        !sameBoxRegistryCredentialOwner(draft.owner, owner) ||
        draft.employeeId !== employeeId ||
        draft.badgeDigest !== body.badgeDigest ||
        orderContent(draft.body) !== orderContent(body) ||
        reservation.payloadDigest !== payloadDigest ||
        reservation.credentialGeneration !== owner.credentialGeneration ||
        body.admissionProof !== reservation.admission.admissionProof ||
        body.createdAt !== reservation.admission.claimedAt
      )
        throw new GrantDenied("wrong_task");
      const taskRequest = context.store.get(
        taskKey(
          owner.binding.serverUrl,
          tenantId,
          owner.binding.kioskId,
          reservation.taskId,
          reservation.snapshotDigest,
        ),
      );
      taskRequest.onsuccess = () =>
        runChecked(context.tx, () => {
          const saved = taskRequest.result as StoredPickupGrant | undefined;
          if (
            !saved ||
            saved.grant.kindOfGrant !== "task" ||
            saved.credentialGeneration !== owner.credentialGeneration ||
            state.retiredKids.includes(saved.kid)
          )
            throw new GrantDenied("missing_grant");
          const grant = saved.grant;
          if (
            grant.taskKind !== "pickup" ||
            grant.taskId !== reservation.taskId ||
            grant.snapshotDigest !== reservation.snapshotDigest ||
            saved.scope.payloadDigest !== payloadDigest
          )
            throw new GrantDenied("wrong_task");
          try {
            assertPickupScopeFacts(saved.scope, body, snapshot.bootstrap.products, rows);
          } catch {
            throw new GrantDenied("wrong_task");
          }
          const counterRequest = context.store.get(counterKey(grant));
          counterRequest.onsuccess = () =>
            runChecked(context.tx, () => {
              const consumed = (counterRequest.result as Record<string, number> | undefined) ?? {},
                sample = clockSample(),
                now = state.clockTrusted === false ? null : trustedNow(state.clock, sample);
              const decision = assessCompletion(grant, intent(grant, context, cost), now, consumed);
              if (!decision.allow) throw new GrantDenied(decision.reason);
              const next = { ...consumed };
              for (const [id, amount] of Object.entries(cost)) next[id] = (next[id] ?? 0) + amount;
              context.store.put(next, counterKey(grant));
              context.store.put({ ...draft, status: "accepted" }, draftKey(owner, body.deviceSeq));
              if (state.clock && now !== null)
                context.store.put(
                  {
                    ...state,
                    clock: { ...state.clock, highWaterMs: now, wallHighWaterMs: sample.wallMs },
                  },
                  context.key,
                );
              commit(saved);
            });
        });
    });
  draftRequest.onsuccess = ready;
  reservationRequest.onsuccess = ready;
}
export async function hasCurrentDraftGrant(
  owner: BoxRegistryCredentialOwner,
  draft: PickupDraft,
): Promise<boolean> {
  const state = await readGrantState(),
    reservation = await readGrantReservation(owner, draft.body.deviceSeq);
  if (!state?.tenantId || !reservation || !sameBoxRegistryCredentialOwner(state, owner))
    return false;
  const tenantId = state.tenantId;
  const saved = await withStore<StoredPickupGrant>(STORE_GRANTS, "readonly", (s) =>
    s.get(
      taskKey(
        owner.binding.serverUrl,
        tenantId,
        owner.binding.kioskId,
        reservation.taskId,
        reservation.snapshotDigest,
      ),
    ),
  );
  if (
    !saved ||
    saved.grant.kindOfGrant !== "task" ||
    saved.credentialGeneration !== owner.credentialGeneration ||
    state.retiredKids.includes(saved.kid)
  )
    return false;
  const grant = saved.grant,
    cost = grantEventCost("pickup.complete.v1", {
      units: saved.scope.unitCount,
      containers: saved.scope.containerCount,
    });
  if (!cost) return false;
  const consumed =
    (await withStore<Record<string, number>>(STORE_GRANTS, "readonly", (s) =>
      s.get(counterKey(grant)),
    )) ?? {};
  return assessCompletion(
    grant,
    {
      owner: {
        tenantId: state.tenantId,
        deviceId: owner.binding.kioskId,
        kind: "kiosk",
        credentialEpoch: state.epoch,
      },
      capability: "pickup.start.v1",
      taskId: reservation.taskId,
      snapshotDigest: reservation.snapshotDigest,
      eventId: `pickup:${draft.body.deviceSeq}`,
      eventType: "pickup.complete.v1",
      cost,
    },
    state.clockTrusted === false ? null : trustedNow(state.clock, clockSample()),
    consumed,
  ).allow;
}
