import type { GrantIntent, GrantOwner } from "@markiro/domain";
import type { CredentialGeneration } from "../credential-recovery.js";
import type { StationAdmissionDecision, StationGrantAdmission } from "./admission.js";
import type { ExecutionProjection } from "./semantic.js";

export type TaskEntryAdmission =
  { allow: true; observe: boolean } | { allow: false; reason: string };

/** Only the two entry-time methods, so callers can exercise this policy without a grant store. */
type EntryAdmission = Pick<StationGrantAdmission, "commitNewWork" | "assessTaskWork">;

/**
 * Entry-time grant binding for a floor task, and the one place that decides
 * what an unbindable task means.
 *
 * `execution` is null when the device holds no durable execution projection
 * for the task — a first entry whose authenticated bundle refresh could not
 * complete. A projection that no longer matches its signed scope is reported
 * by `assertExecutionScopeMatches` as a thrown error rather than as a denial,
 * so both arrive here outside the decision machinery that
 * `StationGrantAdmission` already converts to an allowance in observe mode.
 *
 * Strict mode refuses both: an unbound task must not consume a signed
 * allowance. Observe mode must not stop the line for either — a station that
 * is only observing has no authority to refuse production, and refusing here
 * used to strand an operator in front of a shift the server had already
 * opened.
 */
export async function admitTaskEntry(input: {
  admission: EntryAdmission;
  generation: CredentialGeneration;
  mode: "observe" | "strict";
  owner: GrantOwner;
  capability: GrantIntent["capability"];
  eventType: GrantIntent["eventType"];
  taskId: string;
  resuming: boolean;
  execution: ExecutionProjection | null;
}): Promise<TaskEntryAdmission> {
  const { admission, execution, mode } = input;
  if (!execution)
    return mode === "strict"
      ? { allow: false, reason: "execution_unavailable" }
      : { allow: true, observe: true };
  const observed = (decision: StationAdmissionDecision): boolean =>
    decision.allow && Boolean(decision.reason);
  try {
    let observe = false;
    if (!input.resuming) {
      const decision = await admission.commitNewWork(
        {
          intent: {
            owner: input.owner,
            capability: input.capability,
            taskId: input.taskId,
            snapshotDigest: "start",
            eventId: crypto.randomUUID(),
            eventType: input.eventType,
            cost: {},
          },
          execution,
        },
        input.generation,
      );
      if (!decision.allow) return { allow: false, reason: decision.reason ?? "denied" };
      observe = observed(decision);
    }
    const taskDecision = await admission.assessTaskWork({
      owner: input.owner,
      capability: input.capability,
      eventType: input.eventType,
      execution,
    });
    if (!taskDecision.allow) return { allow: false, reason: taskDecision.reason ?? "denied" };
    return { allow: true, observe: observe || observed(taskDecision) };
  } catch {
    // Binding failures are execution facts, not transport faults: the scope
    // moved, the credential generation changed, or a durable admission
    // command was refused. Strict mode blocks with a reason the operator can
    // act on; observe mode records the doubt and lets production continue.
    return mode === "strict"
      ? { allow: false, reason: "execution_mismatch" }
      : { allow: true, observe: true };
  }
}
