export type ReceivingEventStatus = "draft" | "finalized" | "amended" | "void";

export interface ReceivingLifecycleState {
  id: string;
  rootId: string;
  status: ReceivingEventStatus;
  revision: number;
  supersededByEventId: string | null;
  currentEventId: string | null;
  pendingDraftId: string | null;
  lifecycleVersion: number;
  nextRevision: number;
}
export type ReceivingLifecycleAction = "amend" | "finalize" | "void";
export type ReceivingLifecycleDecision =
  | { ok: true }
  | {
      ok: false;
      code: "receiving_lifecycle_conflict" | "receiving_pending_amendment";
      pendingDraftId: string | null;
    };

export function isCurrentReceiving(value: {
  status: ReceivingEventStatus;
  supersededByEventId: string | null;
}): boolean {
  return value.status === "finalized" && value.supersededByEventId === null;
}

const maxVersion = 2147483647;
function isVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maxVersion;
}

/** Pure state guard. The caller verifies tenant/root ownership and the predecessor row. */
export function assessReceivingTransition(
  state: ReceivingLifecycleState,
  action: ReceivingLifecycleAction,
): ReceivingLifecycleDecision {
  const conflict: ReceivingLifecycleDecision = {
    ok: false,
    code: "receiving_lifecycle_conflict",
    pendingDraftId: state.pendingDraftId,
  };
  if (
    !isVersion(state.revision) ||
    !isVersion(state.nextRevision) ||
    !isVersion(state.lifecycleVersion) ||
    state.lifecycleVersion === maxVersion ||
    state.nextRevision <= state.revision ||
    (state.revision === 1) !== (state.id === state.rootId) ||
    state.supersededByEventId !== null
  )
    return conflict;

  if (state.status === "draft") {
    if (
      action === "amend" ||
      state.pendingDraftId !== state.id ||
      state.currentEventId === state.id ||
      (state.revision === 1) !== (state.currentEventId === null)
    )
      return conflict;
    return { ok: true };
  }
  if (!isCurrentReceiving(state) || state.currentEventId !== state.id || action === "finalize")
    return conflict;
  if (state.pendingDraftId === state.id) return conflict;
  if (state.pendingDraftId !== null)
    return { ok: false, code: "receiving_pending_amendment", pendingDraftId: state.pendingDraftId };
  if (action === "amend" && state.nextRevision === maxVersion) return conflict;
  return { ok: true };
}

export interface ReceivingConsumerFact {
  eventId: string;
  kind: "transformation" | "shipping";
  receiptRootId: string;
  lotIds: readonly string[];
  status: ReceivingEventStatus;
  supersededByEventId: string | null;
}

/** Filters complete caller-supplied facts; does not discover dependencies or order corrections. */
export function getBlockingReceivingConsumerIds(input: {
  changeKind: "documentary" | "material" | "void";
  receiptRootId: string;
  affectedLotIds: readonly string[];
  consumers: readonly ReceivingConsumerFact[];
}): string[] {
  if (input.changeKind === "documentary") return [];
  const affected = new Set(input.affectedLotIds);
  return [
    ...new Set(
      input.consumers
        .filter(
          (consumer) =>
            consumer.receiptRootId === input.receiptRootId &&
            isCurrentReceiving(consumer) &&
            consumer.lotIds.some((id) => affected.has(id)),
        )
        .map((consumer) => consumer.eventId),
    ),
  ].sort();
}
