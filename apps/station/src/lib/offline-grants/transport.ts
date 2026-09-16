import { applyTargetReplacementConfiguration } from "../replacement-target.js";
import {
  grantIssueResultSchema,
  grantConfigurationSchema,
  type GrantConfiguration,
  grantKeysetResultSchema,
  type GrantIssueResult,
  type GrantKeyset,
  grantClientReadinessResponseSchema,
} from "@markiro/platform-contracts";
import type { StationClient } from "../api-client.js";
import type { GrantOwner } from "@markiro/domain";
import {
  acquireCredentialCommitLease,
  credentialGenerationIsCurrent,
  type CredentialGeneration,
} from "../credential-recovery.js";
import type { SqlExecutor } from "../mirror.js";
import { sampleGrantClock } from "./clock.js";
import type { GrantClockSample } from "./clock.js";
import {
  acknowledgeStationGrantReadiness,
  installStationGrant,
  markStationGrantReadinessAttempt,
  prepareStationGrantReadiness,
  type StationGrantReadinessIntent,
} from "./store.js";
import {
  assertExecutionScopeMatches,
  readInventoryExecutionProjection,
  readShiftExecutionProjection,
} from "./semantic.js";

const negotiation = (requestId: string) => ({
  protocol: "offline-grants-v1" as const,
  capability: "offline-grants-v1" as const,
  requestId,
});

export async function fetchStationGrantKeyset(
  client: Pick<StationClient, "get">,
): Promise<GrantKeyset> {
  const result = grantKeysetResultSchema.parse(
    await client.get<unknown>("/station/grants/v1/keyset"),
  );
  if ("status" in result) throw new Error(`offline grants denied: ${result.reason}`);
  return result;
}

export async function fetchStationDeviceGrant(
  client: Pick<StationClient, "post">,
  requestId: string,
): Promise<GrantIssueResult> {
  return grantIssueResultSchema.parse(
    await client.post("/station/grants/v1/device", negotiation(requestId)),
  );
}

export async function fetchStationTaskGrant(
  client: Pick<StationClient, "post">,
  input: { requestId: string; taskKind: "shift" | "inventory"; taskId: string },
): Promise<GrantIssueResult> {
  return grantIssueResultSchema.parse(
    await client.post("/station/grants/v1/tasks", {
      ...negotiation(input.requestId),
      taskKind: input.taskKind,
      taskId: input.taskId,
    }),
  );
}

async function nextInstallSequence(exec: SqlExecutor): Promise<number> {
  const [row] = await exec.all<{ request_sequence: number }>(
    `SELECT MAX(request_sequence) AS request_sequence FROM (
       SELECT request_sequence FROM offline_grant_install_commands
       UNION ALL SELECT request_sequence FROM offline_grant_keyset_commands
       UNION ALL SELECT request_sequence FROM offline_grant_configuration_commands
       UNION ALL SELECT grant_install_floor FROM device_replacement_drain
     )`,
  );
  const next = (row?.request_sequence ?? -1) + 1;
  if (!Number.isSafeInteger(next) || next < 0)
    throw new Error("offline grant install sequence exhausted");
  return next;
}

async function persistDeniedKeyset(
  exec: SqlExecutor,
  keyset: GrantKeyset,
  requestSequence: number,
  configuredOrigin: string,
  generation: CredentialGeneration,
): Promise<void> {
  if (keyset.origin !== configuredOrigin) throw new Error("offline grant keyset origin mismatch");
  const lease = acquireCredentialCommitLease(generation);
  if (!lease) throw new Error("offline grant stale credential");
  try {
    await exec.run(
      "INSERT INTO offline_grant_keyset_commands(request_sequence,payload_json) VALUES(?,?)",
      [
        requestSequence,
        JSON.stringify({
          origin: keyset.origin,
          revision: keyset.revision,
          json: JSON.stringify(keyset),
          retiredKids: keyset.retiredKids,
        }),
      ],
    );
  } finally {
    lease.release();
  }
}

export async function refreshStationOfflineGrant(input: {
  exec: SqlExecutor;
  client: Pick<StationClient, "get" | "post">;
  configuredOrigin: string;
  generation: CredentialGeneration;
  expectedDevice: Pick<GrantOwner, "tenantId" | "deviceId" | "kind">;
  task?: { taskKind: "shift" | "inventory"; taskId: string };
  /** Injectable deterministic native source for delayed-response tests. */
  sampleClock?: () => Promise<GrantClockSample>;
}): Promise<GrantIssueResult> {
  const clock = input.sampleClock ?? sampleGrantClock;
  // Anchor at request start: pairing a later monotonic sample with serverTime would
  // undercount time spent in flight and extend every absolute grant deadline.
  const requestStart = await clock();
  const requestSequence = await nextInstallSequence(input.exec);
  const requestId = crypto.randomUUID();
  const [keyset, result] = await Promise.all([
    fetchStationGrantKeyset(input.client),
    input.task
      ? fetchStationTaskGrant(input.client, { requestId, ...input.task })
      : fetchStationDeviceGrant(input.client, requestId),
  ]);
  if (result.status === "denied") {
    await persistDeniedKeyset(
      input.exec,
      keyset,
      requestSequence,
      input.configuredOrigin,
      input.generation,
    );
    return result;
  }
  const responseReceived = await clock();
  if (responseReceived.bootId !== requestStart.bootId) {
    throw new Error("offline grant clock boot changed during request");
  }
  await installStationGrant({
    exec: input.exec,
    envelope: result.envelope,
    keyset,
    configuredOrigin: input.configuredOrigin,
    generation: input.generation,
    expectedDevice: input.expectedDevice,
    requestSequence,
    clock: {
      serverMs: result.envelope.serverTime,
      monotonicMs: requestStart.monotonicMs,
      bootId: requestStart.bootId,
      wallMs: responseReceived.wallMs,
    },
  });
  return result;
}

/** Fetches device authority for new work before the task grant; an installed exact task is resume. */
export async function refreshStationTaskAuthority(
  input: {
    exec: SqlExecutor;
    client: Pick<StationClient, "get" | "post">;
    configuredOrigin: string;
    generation: CredentialGeneration;
    expectedDevice: Pick<GrantOwner, "tenantId" | "deviceId" | "kind">;
    task: { taskKind: "shift" | "inventory"; taskId: string };
  },
  refresh: typeof refreshStationOfflineGrant = refreshStationOfflineGrant,
): Promise<{ resuming: boolean }> {
  const installed = await input.exec.all<{ snapshot_digest: string; scope_json: string }>(
    `SELECT json_extract(grant.grant_json,'$.snapshotDigest') snapshot_digest,
            snapshot.scope_json
       FROM offline_grant_grants grant
       JOIN offline_grant_snapshots snapshot
         ON snapshot.task_kind=json_extract(grant.grant_json,'$.taskKind')
        AND snapshot.task_id=json_extract(grant.grant_json,'$.taskId')
        AND snapshot.snapshot_digest=json_extract(grant.grant_json,'$.snapshotDigest')
       JOIN offline_grant_install_state state ON state.id=1
       JOIN offline_grant_task_admissions admission
         ON admission.tenant_id=state.tenant_id AND admission.device_id=state.device_id
        AND admission.owner_kind=state.owner_kind AND admission.credential_epoch=state.credential_epoch
        AND admission.task_kind=snapshot.task_kind AND admission.task_id=snapshot.task_id
        AND admission.snapshot_digest=snapshot.snapshot_digest
      WHERE json_extract(grant.grant_json,'$.kindOfGrant')='task'
        AND json_extract(grant.grant_json,'$.taskKind')=?
        AND json_extract(grant.grant_json,'$.taskId')=?
        AND state.tenant_id=? AND state.device_id=? AND state.owner_kind=?
      ORDER BY grant.installed_sequence DESC`,
    [
      input.task.taskKind,
      input.task.taskId,
      input.expectedDevice.tenantId,
      input.expectedDevice.deviceId,
      input.expectedDevice.kind,
    ],
  );
  const execution =
    installed.length === 0
      ? null
      : input.task.taskKind === "shift"
        ? await readShiftExecutionProjection(input.exec, input.task.taskId)
        : await readInventoryExecutionProjection(input.exec, input.task.taskId);
  const resuming =
    execution !== null &&
    installed.some((candidate) => {
      try {
        assertExecutionScopeMatches(
          {
            taskKind: input.task.taskKind,
            taskId: input.task.taskId,
            scope: JSON.parse(candidate.scope_json),
          },
          execution,
        );
        return true;
      } catch {
        return false;
      }
    });
  if (!resuming) {
    await refresh({
      exec: input.exec,
      client: input.client,
      configuredOrigin: input.configuredOrigin,
      generation: input.generation,
      expectedDevice: input.expectedDevice,
    });
  }
  try {
    await refresh(input);
  } catch (error) {
    if (!resuming) throw error;
  }
  return { resuming };
}

export async function fetchStationGrantConfiguration(
  client: Pick<StationClient, "post">,
  requestId: string,
): Promise<GrantConfiguration> {
  return grantConfigurationSchema.parse(
    await client.post("/station/grants/v1/configuration", negotiation(requestId)),
  );
}

/** Recovery/configuration receipt is independent of productive issuance and cannot extend time in flight. */
export async function refreshStationGrantConfiguration(input: {
  exec: SqlExecutor;
  client: Pick<StationClient, "post">;
  configuredOrigin: string;
  generation: CredentialGeneration;
  expectedDevice: Pick<GrantOwner, "tenantId" | "deviceId" | "kind">;
  sampleClock?: () => Promise<GrantClockSample>;
}): Promise<GrantConfiguration> {
  const clock = input.sampleClock ?? sampleGrantClock;
  const requestStart = await clock().catch(() => null);
  const requestSequence = await nextInstallSequence(input.exec);
  const configuration = await fetchStationGrantConfiguration(input.client, crypto.randomUUID());
  const responseReceived = await clock().catch(() => null);
  if (
    configuration.owner.tenantId !== input.expectedDevice.tenantId ||
    configuration.owner.deviceId !== input.expectedDevice.deviceId ||
    configuration.owner.kind !== input.expectedDevice.kind
  )
    throw new Error("offline grant configuration owner mismatch");
  if (
    configuration.keyset?.origin !== undefined &&
    configuration.keyset.origin !== input.configuredOrigin
  )
    throw new Error("offline grant configuration origin mismatch");
  const lease = acquireCredentialCommitLease(input.generation);
  if (!lease) throw new Error("offline grant stale credential");
  try {
    await input.exec.run(
      "INSERT INTO offline_grant_configuration_commands(request_sequence,payload_json) VALUES(?,?)",
      [
        requestSequence,
        JSON.stringify({
          owner: configuration.owner,
          mode: configuration.mode,
          policyRevision: configuration.policyRevision,
          serverTime: configuration.serverTime,
          keyset: configuration.keyset
            ? {
                origin: configuration.keyset.origin,
                revision: configuration.keyset.revision,
                json: JSON.stringify(configuration.keyset),
                retiredKids: configuration.keyset.retiredKids,
              }
            : null,
          clock:
            requestStart && responseReceived && responseReceived.bootId === requestStart.bootId
              ? {
                  monotonicMs: requestStart.monotonicMs,
                  bootId: requestStart.bootId,
                  wallMs: responseReceived.wallMs,
                }
              : null,
        }),
      ],
    );
  } finally {
    lease.release();
  }
  await applyTargetReplacementConfiguration(
    input.exec,
    input.generation,
    configuration.owner,
    configuration.replacement,
  );
  return configuration;
}

export async function reportStationGrantReadiness(input: {
  exec: SqlExecutor;
  client: Pick<StationClient, "post">;
  configuredOrigin: string;
  generation: CredentialGeneration;
  expectedDevice: Pick<GrantOwner, "tenantId" | "deviceId" | "kind">;
  clientBuild: string;
  intent?: StationGrantReadinessIntent;
}): Promise<boolean> {
  const intent = input.intent ?? (await prepareStationGrantReadiness(input));
  if (!intent) return false;
  if (!(await markStationGrantReadinessAttempt(input.exec, intent, input.generation))) return false;
  if (!credentialGenerationIsCurrent(input.generation)) return false;
  const response = grantClientReadinessResponseSchema.parse(
    await input.client.post("/station/grants/v1/readiness", intent.body),
  );
  if (response.requestId !== intent.requestId)
    throw new Error("offline grant readiness response identity mismatch");
  return acknowledgeStationGrantReadiness(input.exec, intent, input.generation);
}
