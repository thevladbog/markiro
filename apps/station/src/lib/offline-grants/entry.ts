import type { GrantIntent, GrantOwner } from "@markiro/domain";
import type { CredentialGeneration } from "../credential-recovery.js";
import type { StationAdmissionDecision, StationGrantAdmission } from "./admission.js";
import type { ExecutionProjection } from "./semantic.js";

export type TaskEntryAdmission =
  { allow: true; observe: boolean } | { allow: false; reason: string };

/** The three entry-time methods, so callers can exercise this policy without a grant store. */
type EntryAdmission = Pick<
  StationGrantAdmission,
  "commitNewWork" | "assessTaskWork" | "installedMode"
>;

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
 * A mismatch is repaired before it is judged: `refreshExecution` re-reads the
 * task's authenticated projection once, because the local mirror is the side
 * that goes stale (the server's close authority, counterparty or print policy
 * moved since this device last mirrored). Without that retry a strict station
 * whose mirror lags deadlocks — it cannot enter, and only a successful entry
 * refreshes the mirror.
 *
 * Whatever remains is judged against the mode read from the admission itself,
 * at the moment of the decision. A caller's earlier snapshot can be stale by
 * then: the readiness refresh installs a new mode on its own schedule while
 * entry is still waiting on the network. Strict mode refuses both cases — an
 * unbound task must not consume a signed allowance. Observe mode must not stop
 * the line for either: a station that is only observing has no authority to
 * refuse production, and refusing here used to strand an operator in front of
 * a shift the server had already opened.
 */
export async function admitTaskEntry(input: {
  admission: EntryAdmission;
  generation: CredentialGeneration;
  owner: GrantOwner;
  capability: GrantIntent["capability"];
  eventType: GrantIntent["eventType"];
  taskId: string;
  resuming: boolean;
  execution: ExecutionProjection | null;
  /** Authenticated re-read of the task's projection, tried once when binding fails. */
  refreshExecution?: () => Promise<ExecutionProjection | null>;
}): Promise<TaskEntryAdmission> {
  const { admission } = input;
  const unbound = async (reason: string): Promise<TaskEntryAdmission> =>
    (await admission.installedMode()) === "strict"
      ? { allow: false, reason }
      : { allow: true, observe: true };
  if (!input.execution) return unbound("execution_unavailable");
  const observed = (decision: StationAdmissionDecision): boolean =>
    decision.allow && Boolean(decision.reason);

  const bind = async (execution: ExecutionProjection): Promise<TaskEntryAdmission> => {
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
  };

  try {
    return await bind(input.execution);
  } catch {
    // Binding failures are execution facts, not transport faults: the scope
    // moved, the credential generation changed, or a durable admission command
    // was refused. Only the first is repairable here, and only once.
    const refreshed = await input.refreshExecution?.().catch(() => null);
    if (refreshed) {
      try {
        return await bind(refreshed);
      } catch {
        return unbound("execution_mismatch");
      }
    }
    return unbound("execution_mismatch");
  }
}
