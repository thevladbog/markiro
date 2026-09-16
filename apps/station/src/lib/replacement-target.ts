import { z } from "zod";
import {
  deviceReplacementTargetFenceSchema,
  type DeviceReplacementTargetFence,
} from "@markiro/platform-contracts";
import type { GrantOwner } from "@markiro/domain";
import type { SqlExecutor } from "./mirror.js";
import {
  acquireCredentialCommitLease,
  credentialGenerationOwnership,
  createCredentialGeneration,
  type CredentialGeneration,
} from "./credential-recovery.js";
import { stationServerOrigin } from "./device-recovery.js";
import type { StationProvisioning } from "./pairing.js";
const KEY = "device_replacement_target_v1";
const savedSchema = z
  .object({
    tenantId: z.string(),
    deviceId: z.string(),
    serverOrigin: z.string(),
    credentialOwnership: z.string(),
    fence: deviceReplacementTargetFenceSchema,
  })
  .strict();
export async function readTargetReplacementFence(exec: SqlExecutor) {
  const [row] = await exec.all<{ value: string }>("SELECT value FROM station_meta WHERE key=?", [
    KEY,
  ]);
  return row ? savedSchema.parse(JSON.parse(row.value)) : null;
}
export async function targetReplacementWaiting(exec: SqlExecutor) {
  const saved = await readTargetReplacementFence(exec);
  return saved !== null && saved.fence.serverTime < saved.fence.newWorkAllowedAt;
}
/** First durable write precedes config/credential publication. Conditional upsert rejects late epochs. */
export async function persistTargetReplacementFence(
  exec: SqlExecutor,
  provisioning: StationProvisioning,
) {
  const prior = await readTargetReplacementFence(exec);
  if (!provisioning.replacement) {
    if (prior && prior.fence.serverTime < prior.fence.newWorkAllowedAt)
      throw new Error("Replacement boundary required");
    return;
  }
  const fence = deviceReplacementTargetFenceSchema.parse(provisioning.replacement);
  const value = savedSchema.parse({
    tenantId: provisioning.tenantId,
    deviceId: provisioning.deviceId,
    serverOrigin: stationServerOrigin(provisioning.serverUrl),
    credentialOwnership: await credentialGenerationOwnership(
      createCredentialGeneration(provisioning.apiKey),
    ),
    fence,
  });
  await exec.run(
    `INSERT INTO station_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE json_extract(station_meta.value,'$.tenantId')=json_extract(excluded.value,'$.tenantId')
      AND json_extract(station_meta.value,'$.deviceId')=json_extract(excluded.value,'$.deviceId')
      AND json_extract(station_meta.value,'$.serverOrigin')=json_extract(excluded.value,'$.serverOrigin')
      AND json_extract(station_meta.value,'$.fence.executionId')=json_extract(excluded.value,'$.fence.executionId')
      AND json_extract(station_meta.value,'$.fence.newWorkAllowedAt')=json_extract(excluded.value,'$.fence.newWorkAllowedAt')
      AND (json_extract(station_meta.value,'$.fence.credentialEpoch')<json_extract(excluded.value,'$.fence.credentialEpoch') OR json_extract(station_meta.value,'$.credentialOwnership')=json_extract(excluded.value,'$.credentialOwnership'))
      AND json_extract(station_meta.value,'$.fence.credentialEpoch')<=json_extract(excluded.value,'$.fence.credentialEpoch')
      AND json_extract(station_meta.value,'$.fence.serverTime')<=json_extract(excluded.value,'$.fence.serverTime')`,
    [KEY, JSON.stringify(value)],
  );
  const saved = await readTargetReplacementFence(exec);
  if (JSON.stringify(saved) !== JSON.stringify(value))
    throw new Error("Replacement boundary publication failed");
}
/** Missing configuration is not permission to release. Use server time and exact authenticated owner only. */
export async function applyTargetReplacementConfiguration(
  exec: SqlExecutor,
  generation: CredentialGeneration,
  owner: GrantOwner,
  fence: DeviceReplacementTargetFence | undefined,
) {
  const saved = await readTargetReplacementFence(exec);
  if (!fence) return;
  const parsed = deviceReplacementTargetFenceSchema.parse(fence);
  if (!saved) throw new Error("Replacement pairing boundary missing");
  const hash = await credentialGenerationOwnership(generation);
  if (
    saved.tenantId !== owner.tenantId ||
    saved.deviceId !== owner.deviceId ||
    owner.kind !== "station" ||
    saved.credentialOwnership !== hash ||
    parsed.credentialEpoch !== owner.credentialEpoch ||
    parsed.credentialEpoch !== saved.fence.credentialEpoch ||
    parsed.executionId !== saved.fence.executionId ||
    parsed.newWorkAllowedAt !== saved.fence.newWorkAllowedAt
  )
    throw new Error("Replacement boundary identity mismatch");
  const lease = acquireCredentialCommitLease(generation);
  if (!lease) throw new Error("Replacement credential changed");
  try {
    await exec.run(
      `UPDATE station_meta SET value=? WHERE key=? AND value=? AND json_extract(value,'$.fence.serverTime')<=?`,
      [JSON.stringify({ ...saved, fence: parsed }), KEY, JSON.stringify(saved), parsed.serverTime],
    );
  } finally {
    lease.release();
  }
}
