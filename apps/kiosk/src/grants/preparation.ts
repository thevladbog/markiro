import type { KioskClient } from "../api/client.js";
import { isDeviceRevoked } from "../api/client.js";
import type { CreateOrderDto } from "../api/types.js";
import type { ConfirmedKioskFlowState } from "../session/flow.js";
import {
  sameBoxRegistryCredentialOwner,
  type BoxRegistryCredentialOwner,
} from "../store/installation-binding.js";
import { readGrantState } from "./store.js";
import { GrantDenied, admitNewCart } from "./admission.js";
import { preparePickupDraft, matchingPickupDraft } from "./drafts.js";
import { hasCurrentDraftGrant } from "./completion.js";
import { beginGrantRequest, installGrantResponse } from "./transport.js";
import { persistGrantReservation, readGrantReservation } from "./reservations.js";
/** Strict preparation is durable before network; only the explicit submit accepts production. */
export async function prepareStrictPickup(
  client: KioskClient,
  owner: BoxRegistryCredentialOwner,
  confirmed: ConfirmedKioskFlowState,
  createdAt: string,
): Promise<CreateOrderDto | null> {
  if ((await readGrantState())?.mode !== "strict") {
    const pending = await matchingPickupDraft(owner, confirmed);
    if (!pending) return null;
    const reservation = await readGrantReservation(owner, pending.body.deviceSeq);
    return reservation
      ? {
          ...pending.body,
          createdAt: reservation.admission.claimedAt,
          admissionProof: reservation.admission.admissionProof,
        }
      : pending.body;
  }
  const draft = await preparePickupDraft(owner, confirmed, createdAt);
  if (!(await hasCurrentDraftGrant(owner, draft))) {
    await admitNewCart();
    if (
      !client.reserveGrantOrder ||
      !client.issueTaskGrant ||
      !sameBoxRegistryCredentialOwner(client.registryOwner ?? null, owner)
    )
      throw new GrantDenied("missing_grant");
    const lease = await beginGrantRequest();
    if (!lease || !sameBoxRegistryCredentialOwner(lease.owner, owner))
      throw new GrantDenied("wrong_owner");
    const negotiation = () => ({
      protocol: "offline-grants-v1" as const,
      capability: "offline-grants-v1" as const,
      requestId: crypto.randomUUID(),
    });
    try {
      const order = { ...draft.body, admissionNonce: draft.nonce };
      delete order.createdAt;
      delete order.admissionProof;
      const response = await client.reserveGrantOrder({ ...negotiation(), order });
      if (!(await persistGrantReservation(lease, draft.body, response)))
        throw new GrantDenied("missing_grant");
      const reservation = await readGrantReservation(owner, draft.body.deviceSeq);
      if (
        !reservation ||
        !(await installGrantResponse(
          lease,
          await client.issueTaskGrant({
            ...negotiation(),
            taskKind: "pickup",
            taskId: reservation.taskId,
          }),
          draft.body.deviceSeq,
        ))
      )
        throw new GrantDenied("missing_grant");
    } catch (error) {
      if (error instanceof GrantDenied || isDeviceRevoked(error)) throw error;
      throw new GrantDenied("missing_grant");
    }
  }
  const reservation = await readGrantReservation(owner, draft.body.deviceSeq);
  if (!reservation) throw new GrantDenied("missing_grant");
  return {
    ...draft.body,
    createdAt: reservation.admission.claimedAt,
    admissionProof: reservation.admission.admissionProof,
  };
}
