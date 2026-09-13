import { assessNewWork, type GrantIntent, type LocalDecision } from "@markiro/domain";
import { clockSample, trustedNow } from "./clock.js";
import { withGrantTransaction, type GrantContext } from "./store.js";

export class GrantDenied extends Error {
  constructor(readonly reason: Exclude<LocalDecision, { allow: true }>["reason"]) {
    super(`offline_grant:${reason}`);
  }
}
export function newWorkDecision(context: GrantContext): LocalDecision {
  const { state, owner } = context;
  const saved = state?.device;
  const grant =
    saved?.grant.kindOfGrant === "device" &&
    saved.credentialGeneration === owner?.credentialGeneration &&
    !state?.retiredKids.includes(saved.kid)
      ? saved.grant
      : null;
  const intent: GrantIntent = {
    owner: {
      tenantId: state?.tenantId ?? "unknown",
      deviceId: owner?.binding.kioskId ?? "unknown",
      kind: "kiosk",
      credentialEpoch: state?.epoch ?? 0,
    },
    capability: "pickup.start.v1",
    taskId: "",
    snapshotDigest: "",
    eventId: "",
    eventType: "pickup.complete.v1",
    cost: {},
  };
  return assessNewWork(
    grant,
    intent,
    state?.clockTrusted === false ? null : trustedNow(state?.clock ?? null, clockSample()),
  );
}
export function assertNewWork(context: GrantContext): LocalDecision {
  const decision = newWorkDecision(context);
  if (context.state?.mode === "strict" && !decision.allow) throw new GrantDenied(decision.reason);
  const sample = clockSample(),
    now =
      context.state?.clockTrusted === false
        ? null
        : trustedNow(context.state?.clock ?? null, sample);
  if (context.state?.clock && now !== null) {
    context.state = {
      ...context.state,
      clock: { ...context.state.clock, highWaterMs: now, wallHighWaterMs: sample.wallMs },
    };
    context.store.put(context.state, context.key);
  }
  return decision;
}
export async function admitNewCart(): Promise<void> {
  await withGrantTransaction([], (context) => {
    assertNewWork(context);
  });
}
export async function readGrantStatus(): Promise<{
  mode: "observe" | "strict";
  decision: LocalDecision;
} | null> {
  let result: { mode: "observe" | "strict"; decision: LocalDecision } | null = null;
  await withGrantTransaction([], (context) => {
    if (context.state?.tenantId && context.owner)
      result = { mode: context.state.mode, decision: newWorkDecision(context) };
  });
  return result;
}
