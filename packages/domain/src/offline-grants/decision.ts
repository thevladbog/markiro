import type {
  DeviceGrant,
  GrantCapability,
  GrantEventType,
  GrantOwner,
  TaskGrant,
} from "./types.js";

export interface GrantIntent {
  owner: GrantOwner;
  capability: GrantCapability;
  taskId: string;
  snapshotDigest: string;
  eventId: string;
  eventType: GrantEventType;
  /** Trusted durable adapter derives every applicable charge from the actual event, never UI/network cost. */
  cost: Record<string, number>;
}
export type LocalDecision =
  | { allow: true }
  | {
      allow: false;
      reason:
        | "missing_grant"
        | "wrong_owner"
        | "not_yet_valid"
        | "expired"
        | "wrong_task"
        | "event_forbidden"
        | "budget_exhausted"
        | "clock_untrusted";
    };

function safe(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function assessBase(
  grant: DeviceGrant | TaskGrant | null,
  intent: GrantIntent,
  now: number | null,
): LocalDecision {
  if (!grant) return { allow: false, reason: "missing_grant" };
  if (
    grant.tenantId !== intent.owner.tenantId ||
    grant.deviceId !== intent.owner.deviceId ||
    grant.kind !== intent.owner.kind ||
    grant.credentialEpoch !== intent.owner.credentialEpoch
  ) {
    return { allow: false, reason: "wrong_owner" };
  }
  if (now === null || !safe(now)) return { allow: false, reason: "clock_untrusted" };
  if (now < grant.notBefore) return { allow: false, reason: "not_yet_valid" };
  const deadline = grant.kindOfGrant === "device" ? grant.startNotAfter : grant.completeNotAfter;
  if (now >= deadline) return { allow: false, reason: "expired" };
  return { allow: true };
}

/** Requires a successfully verified grant; this does not authenticate arbitrary JSON or authorize the operator. */
export function assessNewWork(
  grant: DeviceGrant | null,
  intent: GrantIntent,
  now: number | null,
): LocalDecision {
  const base = assessBase(grant, intent, now);
  if (!base.allow || !grant) return base;
  return grant.capabilities.includes(intent.capability)
    ? { allow: true }
    : { allow: false, reason: "event_forbidden" };
}

/**
 * Requires a verified grant and trusted adapter intent. Revalidate inside the productive transaction.
 * Read consumed by tenant/device/epoch/taskKind/taskId/snapshotDigest/budgetLineId, never grantId.
 * The durable adapter returns an exact event replay's saved result BEFORE a fresh assessment/charge.
 */
export function assessCompletion(
  grant: TaskGrant | null,
  intent: GrantIntent,
  now: number | null,
  consumed: Readonly<Record<string, number>>,
): LocalDecision {
  const base = assessBase(grant, intent, now);
  if (!base.allow || !grant) return base;
  if (
    grant.taskId !== intent.taskId ||
    grant.snapshotDigest !== intent.snapshotDigest ||
    intent.capability !== `${grant.taskKind}.start.v1`
  )
    return { allow: false, reason: "wrong_task" };
  if (!grant.eventTypes.includes(intent.eventType))
    return { allow: false, reason: "event_forbidden" };
  const exhausted = { allow: false, reason: "budget_exhausted" } as const;
  const maximums = new Map(grant.budget.map((line) => [line.id, line.maximum]));
  for (const [id, used] of Object.entries(consumed)) {
    const maximum = maximums.get(id);
    if (maximum === undefined || !safe(maximum) || !safe(used) || used > maximum) return exhausted;
  }
  for (const [id, cost] of Object.entries(intent.cost)) {
    const maximum = maximums.get(id);
    const used = Object.hasOwn(consumed, id) ? consumed[id] : 0;
    if (
      maximum === undefined ||
      !safe(maximum) ||
      !safe(cost) ||
      used === undefined ||
      !safe(used) ||
      used > maximum ||
      cost > maximum - used
    )
      return exhausted;
  }
  return { allow: true };
}
