import {
  assessClock,
  assessCompletion,
  assessNewWork,
  grantEventCost,
  offlineGrantSchema,
  type DeviceGrant,
  type GrantIntent,
  type GrantOwner,
  type LocalDecision,
  type TaskGrant,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import { acquireCredentialCommitLease, type CredentialGeneration } from "../credential-recovery.js";
import type { GrantClockSample } from "./clock.js";
import { assertExecutionScopeMatches, type ExecutionProjection } from "./semantic.js";

export interface StationAdmissionDecision {
  allow: boolean;
  reason?: Exclude<LocalDecision, { allow: true }>["reason"];
  mode: "observe" | "strict";
}

interface StateRow {
  tenant_id: string;
  device_id: string;
  owner_kind: string;
  credential_epoch: number;
  mode: "observe" | "strict";
}
interface ClockRow {
  server_ms: number;
  monotonic_ms: number;
  boot_id: string;
  high_water_ms: number;
  wall_high_water_ms: number;
}
interface GrantRow {
  grant_id: string;
  grant_json: string;
}
interface SnapshotRow {
  scope_json: string;
}

export async function stationOperatorIsCurrentlyActive(
  exec: SqlExecutor,
  operatorId: string,
): Promise<boolean> {
  const rows = await exec.all<{ active: number }>(
    `SELECT active FROM operators_mirror
      WHERE operator_id=? AND COALESCE((SELECT value FROM station_meta WHERE key='operators_slot'),'a')<>'b'
        AND COALESCE((SELECT value FROM station_meta WHERE key='operators_blocked'),'0')<>'1'
     UNION ALL
     SELECT active FROM operators_mirror_b
      WHERE operator_id=? AND COALESCE((SELECT value FROM station_meta WHERE key='operators_slot'),'a')='b'
        AND COALESCE((SELECT value FROM station_meta WHERE key='operators_blocked'),'0')<>'1'`,
    [operatorId, operatorId],
  );
  return rows[0]?.active === 1;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function sha256(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value))),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class StationGrantAdmission {
  constructor(
    private readonly exec: SqlExecutor,
    private readonly sampleClock: () => Promise<GrantClockSample>,
  ) {}

  private async context(): Promise<{
    owner: GrantOwner;
    mode: "observe" | "strict";
    now: number | null;
    sample: GrantClockSample;
    clock: ClockRow | null;
  }> {
    const [state] = await this.exec.all<StateRow>(
      "SELECT tenant_id,device_id,owner_kind,credential_epoch,mode FROM offline_grant_install_state WHERE id=1",
    );
    const sample = await this.sampleClock().catch(() => ({
      bootId: "",
      monotonicMs: -1,
      wallMs: -1,
    }));
    if (!state)
      return {
        owner: { tenantId: "", deviceId: "", kind: "station", credentialEpoch: 1 },
        mode: "observe",
        now: null,
        sample,
        clock: null,
      };
    const owner = {
      tenantId: state.tenant_id,
      deviceId: state.device_id,
      kind: state.owner_kind,
      credentialEpoch: state.credential_epoch,
    } as GrantOwner;
    const [clock] = await this.exec.all<ClockRow>(
      "SELECT server_ms,monotonic_ms,boot_id,high_water_ms,wall_high_water_ms FROM offline_grant_clock WHERE id=1",
    );
    const assessed = clock
      ? assessClock(
          {
            serverMs: clock.server_ms,
            monotonicMs: clock.monotonic_ms,
            bootId: clock.boot_id,
            highWaterMs: clock.high_water_ms,
            wallHighWaterMs: clock.wall_high_water_ms,
          },
          sample,
        )
      : { trusted: false as const, reason: "clock_untrusted" as const };
    return {
      owner,
      mode: state.mode,
      now: assessed.trusted ? assessed.now : null,
      sample,
      clock: clock ?? null,
    };
  }

  private async grants(): Promise<{
    devices: DeviceGrant[];
    tasks: Array<{ id: string; grant: TaskGrant }>;
  }> {
    const rows = await this.exec.all<GrantRow>(
      "SELECT grant_id,grant_json FROM offline_grant_grants ORDER BY installed_sequence DESC",
    );
    const devices: DeviceGrant[] = [],
      tasks: Array<{ id: string; grant: TaskGrant }> = [];
    for (const row of rows) {
      const parsed = offlineGrantSchema.safeParse(JSON.parse(row.grant_json));
      if (!parsed.success) continue;
      if (parsed.data.kindOfGrant === "device") devices.push(parsed.data);
      else tasks.push({ id: row.grant_id, grant: parsed.data });
    }
    return { devices, tasks };
  }

  async assessNewWork(intent: GrantIntent): Promise<StationAdmissionDecision> {
    const context = await this.context(),
      { devices } = await this.grants();
    const decision = assessNewWork(
      devices.find((grant) => grant.credentialEpoch === context.owner.credentialEpoch) ?? null,
      intent,
      context.now,
    );
    return decision.allow || context.mode === "strict"
      ? { ...decision, mode: context.mode }
      : { allow: true, reason: decision.reason, mode: context.mode };
  }

  /** Persist successful task start before the floor task is published; installed grants alone are not resume proof. */
  async commitNewWork(
    input: { intent: GrantIntent; execution: ExecutionProjection },
    generation: CredentialGeneration,
  ): Promise<StationAdmissionDecision> {
    const context = await this.context();
    const { devices, tasks } = await this.grants();
    const assessed = assessNewWork(
      devices.find((grant) => grant.credentialEpoch === context.owner.credentialEpoch) ?? null,
      input.intent,
      context.now,
    );
    const decision =
      assessed.allow || context.mode === "strict"
        ? { ...assessed, mode: context.mode }
        : ({ allow: true, reason: assessed.reason, mode: context.mode } as const);
    if (!decision.allow) return decision;
    if (context.mode !== "strict" || context.now === null) return decision;
    const selected = tasks.find(
      ({ grant }) =>
        grant.taskKind === input.execution.taskKind && grant.taskId === input.execution.taskId,
    );
    if (!selected) return decision;
    const [snapshot] = await this.exec.all<SnapshotRow>(
      "SELECT scope_json FROM offline_grant_snapshots WHERE task_kind=? AND task_id=? AND snapshot_digest=?",
      [selected.grant.taskKind, selected.grant.taskId, selected.grant.snapshotDigest],
    );
    if (!snapshot) return decision;
    assertExecutionScopeMatches(
      {
        taskKind: selected.grant.taskKind,
        taskId: selected.grant.taskId,
        scope: JSON.parse(snapshot.scope_json),
      },
      input.execution,
    );
    const taskDecision = assessCompletion(
      selected.grant,
      {
        ...input.intent,
        taskId: selected.grant.taskId,
        snapshotDigest: selected.grant.snapshotDigest,
        cost: {},
      },
      context.now,
      {},
    );
    if (!taskDecision.allow) return { ...taskDecision, mode: context.mode };
    const lease = acquireCredentialCommitLease(generation);
    if (!lease) throw new Error("offline grant stale credential");
    try {
      await this.exec.run(
        "INSERT INTO offline_grant_task_admission_commands(admission_id,payload_json) VALUES(?,?)",
        [
          crypto.randomUUID(),
          JSON.stringify({
            owner: input.intent.owner,
            mode: context.mode,
            capability: input.intent.capability,
            eventType: input.intent.eventType,
            taskKind: input.execution.taskKind,
            taskId: input.execution.taskId,
            snapshotDigest: selected.grant.snapshotDigest,
            signedScopeJson: snapshot.scope_json,
            executionScope: input.execution.scope,
            admittedAt: context.now,
            clock: context.clock
              ? {
                  serverMs: context.clock.server_ms,
                  monotonicMs: context.clock.monotonic_ms,
                  bootId: context.clock.boot_id,
                  highWaterMs: context.clock.high_water_ms,
                  wallHighWaterMs: context.clock.wall_high_water_ms,
                }
              : null,
            sample: context.sample,
          }),
        ],
      );
    } finally {
      lease.release();
    }
    return decision;
  }

  /** Entry-time task check: binds the current durable execution projection before floor work starts. */
  async assessTaskWork(input: {
    owner: GrantOwner;
    capability: GrantIntent["capability"];
    eventType: GrantIntent["eventType"];
    execution: ExecutionProjection;
  }): Promise<StationAdmissionDecision> {
    const context = await this.context();
    const { tasks } = await this.grants();
    const selected = tasks.find(
      ({ grant }) =>
        grant.taskKind === input.execution.taskKind && grant.taskId === input.execution.taskId,
    );
    let decision: LocalDecision;
    if (!selected) {
      decision = { allow: false, reason: "missing_grant" };
    } else {
      const [snapshot] = await this.exec.all<SnapshotRow>(
        "SELECT scope_json FROM offline_grant_snapshots WHERE task_kind=? AND task_id=? AND snapshot_digest=?",
        [selected.grant.taskKind, selected.grant.taskId, selected.grant.snapshotDigest],
      );
      if (!snapshot) decision = { allow: false, reason: "wrong_task" };
      else {
        assertExecutionScopeMatches(
          {
            taskKind: selected.grant.taskKind,
            taskId: selected.grant.taskId,
            scope: JSON.parse(snapshot.scope_json),
          },
          input.execution,
        );
        const [admission] = await this.exec.all<{ present: number }>(
          `SELECT 1 present FROM offline_grant_task_admissions
            WHERE tenant_id=? AND device_id=? AND owner_kind=? AND credential_epoch=?
              AND task_kind=? AND task_id=? AND snapshot_digest=?`,
          [
            context.owner.tenantId,
            context.owner.deviceId,
            context.owner.kind,
            context.owner.credentialEpoch,
            selected.grant.taskKind,
            selected.grant.taskId,
            selected.grant.snapshotDigest,
          ],
        );
        decision =
          context.mode === "strict" && !admission
            ? { allow: false, reason: "wrong_task" }
            : assessCompletion(
                selected.grant,
                {
                  owner: input.owner,
                  capability: input.capability,
                  taskId: selected.grant.taskId,
                  snapshotDigest: selected.grant.snapshotDigest,
                  eventId: "entry",
                  eventType: input.eventType,
                  cost: {},
                },
                context.now,
                {},
              );
      }
    }
    return decision.allow || context.mode === "strict"
      ? { ...decision, mode: context.mode }
      : { allow: true, reason: decision.reason, mode: context.mode };
  }

  async commitCompletion(input: {
    operatorId: string;
    intent: GrantIntent;
    execution: ExecutionProjection;
    event: unknown;
    facts: { units?: number; containers?: number };
    result: unknown;
    ownerStatements?: readonly { sql: string; values?: readonly unknown[] }[];
    wrapCommand?: (command: { sql: string; values: readonly unknown[] }) => {
      sql: string;
      values: readonly unknown[];
    };
  }): Promise<{ decision: StationAdmissionDecision; result: unknown; replay: boolean }> {
    const eventDigest = await sha256(input.event);
    const prior = await this.exec.all<{
      event_digest: string;
      decision_json: string;
      result_json: string;
    }>(
      "SELECT event_digest,decision_json,result_json FROM offline_grant_decisions WHERE event_id=?",
      [input.intent.eventId],
    );
    if (prior[0]) {
      if (prior[0].event_digest !== eventDigest)
        throw new Error("offline grant event replay mismatch");
      return {
        decision: JSON.parse(prior[0].decision_json) as StationAdmissionDecision,
        result: JSON.parse(prior[0].result_json) as unknown,
        replay: true,
      };
    }
    const context = await this.context(),
      { tasks } = await this.grants();
    const selected = tasks.find(
      ({ grant }) =>
        grant.taskId === input.intent.taskId &&
        grant.snapshotDigest === input.intent.snapshotDigest,
    );
    const snapshots = await this.exec.all<SnapshotRow>(
      "SELECT scope_json FROM offline_grant_snapshots WHERE task_kind=? AND task_id=? AND snapshot_digest=?",
      [input.execution.taskKind, input.intent.taskId, input.intent.snapshotDigest],
    );
    if (selected && snapshots[0])
      assertExecutionScopeMatches(
        {
          taskKind: selected.grant.taskKind,
          taskId: selected.grant.taskId,
          scope: JSON.parse(snapshots[0].scope_json),
        },
        input.execution,
      );
    const consumedRows = await this.exec.all<{ budget_line_id: string; consumed: number }>(
      "SELECT budget_line_id,consumed FROM offline_grant_consumption WHERE tenant_id=? AND device_id=? AND task_kind=? AND task_id=? AND snapshot_digest=?",
      [
        input.intent.owner.tenantId,
        input.intent.owner.deviceId,
        input.execution.taskKind,
        input.intent.taskId,
        input.intent.snapshotDigest,
      ],
    );
    const consumed = Object.fromEntries(
      consumedRows.map((row) => [row.budget_line_id, row.consumed]),
    );
    const cost = grantEventCost(input.intent.eventType, input.facts);
    const preDecision =
      selected && !snapshots[0]
        ? ({ allow: false, reason: "wrong_task" } as const)
        : cost
          ? assessCompletion(
              selected?.grant ?? null,
              { ...input.intent, cost },
              context.now,
              consumed,
            )
          : ({ allow: false, reason: "budget_exhausted" } as const);
    const grantId = selected?.id ?? "missing";
    const command = {
      sql: "INSERT INTO offline_grant_event_commands(event_id,payload_json) VALUES(?,?)",
      values: [
        input.intent.eventId,
        JSON.stringify({
          owner: input.intent.owner,
          operatorId: input.operatorId,
          mode: context.mode,
          grantId,
          taskKind: input.execution.taskKind,
          executionScope: input.execution.scope,
          taskId: input.intent.taskId,
          snapshotDigest: input.intent.snapshotDigest,
          eventDigest,
          preDecision,
          cost: cost ?? {},
          clockHighWater: context.now ?? 0,
          wallHighWater: context.sample.wallMs >= 0 ? context.sample.wallMs : 0,
          resultJson: JSON.stringify(input.result),
        }),
      ],
    };
    if (input.wrapCommand) {
      const wrapped = input.wrapCommand(command);
      await this.exec.run(wrapped.sql, [...wrapped.values]);
    } else if (input.ownerStatements) {
      if (!this.exec.atomic) throw new Error("offline grant productive transaction unavailable");
      await this.exec.atomic([command, ...input.ownerStatements]);
    } else {
      await this.exec.run(command.sql, [...command.values]);
    }
    const [saved] = await this.exec.all<{ decision_json: string; result_json: string }>(
      "SELECT decision_json,result_json FROM offline_grant_decisions WHERE event_id=?",
      [input.intent.eventId],
    );
    if (!saved) throw new Error("offline grant decision persistence failed");
    return {
      decision: JSON.parse(saved.decision_json) as StationAdmissionDecision,
      result: JSON.parse(saved.result_json) as unknown,
      replay: false,
    };
  }

  /** Two productive grant event types owned by one indivisible business mutation. */
  async commitCompletionPair(input: {
    first: {
      operatorId: string;
      intent: GrantIntent;
      execution: ExecutionProjection;
      event: unknown;
      facts: { units?: number; containers?: number };
      result: unknown;
    };
    second: {
      operatorId: string;
      intent: GrantIntent;
      execution: ExecutionProjection;
      event: unknown;
      facts: { units?: number; containers?: number };
      result: unknown;
    };
    ownerStatements: readonly { sql: string; values?: readonly unknown[] }[];
  }): Promise<{
    first: StationAdmissionDecision;
    second: StationAdmissionDecision;
    result: unknown;
  }> {
    if (!this.exec.atomic) throw new Error("offline grant productive transaction unavailable");
    const build = async (part: typeof input.first) => {
      const eventDigest = await sha256(part.event);
      const context = await this.context(),
        { tasks } = await this.grants();
      const selected = tasks.find(
        ({ grant }) =>
          grant.taskId === part.intent.taskId &&
          grant.snapshotDigest === part.intent.snapshotDigest,
      );
      const snapshots = await this.exec.all<SnapshotRow>(
        "SELECT scope_json FROM offline_grant_snapshots WHERE task_kind=? AND task_id=? AND snapshot_digest=?",
        [part.execution.taskKind, part.intent.taskId, part.intent.snapshotDigest],
      );
      if (selected && snapshots[0])
        assertExecutionScopeMatches(
          {
            taskKind: selected.grant.taskKind,
            taskId: selected.grant.taskId,
            scope: JSON.parse(snapshots[0].scope_json),
          },
          part.execution,
        );
      const consumedRows = await this.exec.all<{ budget_line_id: string; consumed: number }>(
        "SELECT budget_line_id,consumed FROM offline_grant_consumption WHERE tenant_id=? AND device_id=? AND task_kind=? AND task_id=? AND snapshot_digest=?",
        [
          part.intent.owner.tenantId,
          part.intent.owner.deviceId,
          part.execution.taskKind,
          part.intent.taskId,
          part.intent.snapshotDigest,
        ],
      );
      const cost = grantEventCost(part.intent.eventType, part.facts);
      const preDecision =
        selected && !snapshots[0]
          ? ({ allow: false, reason: "wrong_task" } as const)
          : cost
            ? assessCompletion(
                selected?.grant ?? null,
                { ...part.intent, cost },
                context.now,
                Object.fromEntries(consumedRows.map((row) => [row.budget_line_id, row.consumed])),
              )
            : ({ allow: false, reason: "budget_exhausted" } as const);
      return {
        sql: "INSERT INTO offline_grant_event_commands(event_id,payload_json) VALUES(?,?)",
        values: [
          part.intent.eventId,
          JSON.stringify({
            owner: part.intent.owner,
            operatorId: part.operatorId,
            mode: context.mode,
            grantId: selected?.id ?? "missing",
            taskKind: part.execution.taskKind,
            executionScope: part.execution.scope,
            taskId: part.intent.taskId,
            snapshotDigest: part.intent.snapshotDigest,
            eventDigest,
            preDecision,
            cost: cost ?? {},
            clockHighWater: context.now ?? 0,
            wallHighWater: context.sample.wallMs >= 0 ? context.sample.wallMs : 0,
            resultJson: JSON.stringify(part.result),
          }),
        ] as readonly unknown[],
      };
    };
    const [firstCommand, secondCommand] = await Promise.all([
      build(input.first),
      build(input.second),
    ]);
    const pairDenied = `EXISTS(SELECT 1 FROM offline_grant_decisions WHERE event_id IN (?,?) AND json_extract(decision_json,'$.allow')<>1)`;
    const rollbackCharge = (eventId: string) => ({
      sql: `UPDATE offline_grant_consumption SET consumed=consumed-COALESCE((SELECT cost.value FROM offline_grant_event_commands command,json_each(command.payload_json,'$.cost') cost WHERE command.event_id=? AND cost.key=offline_grant_consumption.budget_line_id),0) WHERE ${pairDenied} AND EXISTS(SELECT 1 FROM offline_grant_decisions decision,offline_grant_event_commands command WHERE decision.event_id=? AND command.event_id=? AND json_extract(decision.decision_json,'$.reason') IS NULL AND json_extract(command.payload_json,'$.preDecision.allow')=1) AND tenant_id=? AND device_id=? AND task_kind=? AND task_id=? AND snapshot_digest=?`,
      values: [
        eventId,
        input.first.intent.eventId,
        input.second.intent.eventId,
        eventId,
        eventId,
        input.first.intent.owner.tenantId,
        input.first.intent.owner.deviceId,
        input.first.execution.taskKind,
        input.first.intent.taskId,
        input.first.intent.snapshotDigest,
      ],
    });
    await this.exec.atomic([
      firstCommand,
      secondCommand,
      rollbackCharge(input.first.intent.eventId),
      rollbackCharge(input.second.intent.eventId),
      {
        sql: `DELETE FROM offline_grant_consumption WHERE consumed=0 AND ${pairDenied}`,
        values: [input.first.intent.eventId, input.second.intent.eventId],
      },
      {
        sql: `UPDATE offline_grant_decisions SET decision_json=json_set(decision_json,'$.allow',json('false'),'$.reason',COALESCE((SELECT json_extract(decision_json,'$.reason') FROM offline_grant_decisions denied WHERE denied.event_id IN (?,?) AND json_extract(decision_json,'$.allow')<>1 LIMIT 1),'budget_exhausted')) WHERE event_id IN (?,?) AND ${pairDenied}`,
        values: [
          input.first.intent.eventId,
          input.second.intent.eventId,
          input.first.intent.eventId,
          input.second.intent.eventId,
          input.first.intent.eventId,
          input.second.intent.eventId,
        ],
      },
      ...input.ownerStatements,
    ]);
    const rows = await this.exec.all<{ event_id: string; decision_json: string }>(
      "SELECT event_id,decision_json FROM offline_grant_decisions WHERE event_id IN (?,?)",
      [input.first.intent.eventId, input.second.intent.eventId],
    );
    const first = rows.find((row) => row.event_id === input.first.intent.eventId);
    const second = rows.find((row) => row.event_id === input.second.intent.eventId);
    if (!first || !second) throw new Error("offline grant paired decision persistence failed");
    return {
      first: JSON.parse(first.decision_json) as StationAdmissionDecision,
      second: JSON.parse(second.decision_json) as StationAdmissionDecision,
      result: input.first.result,
    };
  }
}
