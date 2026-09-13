import { z } from "zod";
import type { SqlExecutor } from "./mirror.js";
import { purgeOperatorsMirror } from "./mirror.js";
import type { StationConfig } from "./config.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
  sealCredentialGeneration,
  type CredentialGeneration,
} from "./credential-recovery.js";
import type { StationProvisioning } from "./pairing.js";

const ownerSchema = z
  .object({
    serverOrigin: z.string().url(),
    tenantId: z.string().min(1),
    deviceId: z.string().min(1),
    kind: z.literal("station"),
  })
  .strict();
export type DurableStationOwner = z.infer<typeof ownerSchema>;
export type DeviceRecoveryPhase =
  "active" | "sealing" | "sealed" | "restoring" | "owner_unresolved";
export interface DeviceRecoveryView {
  owner: DurableStationOwner | null;
  phase: DeviceRecoveryPhase;
}
interface RecoveryRow {
  machine_id: string;
  owner_json: string | null;
  phase: DeviceRecoveryPhase;
  active_hash: string | null;
  candidate_hash: string | null;
}

export function stationServerOrigin(url: string): string {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("Invalid station origin");
  return parsed.origin;
}
export function stationOwner(config: StationConfig): DurableStationOwner | null {
  if (!config.serverUrl || !config.tenantId || !config.deviceId) return null;
  return ownerSchema.parse({
    serverOrigin: stationServerOrigin(config.serverUrl),
    tenantId: config.tenantId,
    deviceId: config.deviceId,
    kind: "station",
  });
}
const ownerJson = (owner: DurableStationOwner) => JSON.stringify(ownerSchema.parse(owner));
export const sameStationOwner = (a: DurableStationOwner, b: DurableStationOwner): boolean =>
  ownerJson(a) === ownerJson(b);
async function row(exec: SqlExecutor): Promise<RecoveryRow | undefined> {
  return (await exec.all<RecoveryRow>("SELECT * FROM station_device_recovery WHERE id=1"))[0];
}
export async function readDeviceRecovery(exec: SqlExecutor): Promise<DeviceRecoveryView | null> {
  const saved = await row(exec);
  if (!saved) return null;
  return {
    owner: saved.owner_json === null ? null : ownerSchema.parse(JSON.parse(saved.owner_json)),
    phase: saved.phase,
  };
}

/** One bind parameter. Only the active verified key can access associated old hashes.
 * The absent-row branch supports legacy callers before initialization, never a sealed database. */
export const AUTHORIZED_CREDENTIAL_OWNERS_SQL = `WITH caller(hash) AS (VALUES (?))
 SELECT hash FROM caller WHERE NOT EXISTS (SELECT 1 FROM station_device_recovery)
 UNION SELECT owners.credential_hash FROM station_device_owners owners
 JOIN station_device_recovery recovery ON recovery.owner_json=owners.owner_json
 JOIN caller ON caller.hash=recovery.active_hash WHERE recovery.phase='active'`;
export async function credentialOwnsRetainedWork(
  exec: SqlExecutor,
  current: string | null,
  original: string,
): Promise<boolean> {
  return (
    (
      await exec.all(`SELECT 1 WHERE ? IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL})`, [
        original,
        current,
      ])
    ).length > 0
  );
}
export async function deviceRecoveryAllowsWork(
  exec: SqlExecutor,
  generation: CredentialGeneration,
): Promise<boolean> {
  if (generation.sealed) return false;
  const saved = await row(exec);
  if (!saved) return true;
  return (
    saved.phase === "active" &&
    saved.active_hash === (await credentialGenerationOwnership(generation)) &&
    !generation.sealed
  );
}

/** Startup reconciles a config-file commit with the durable intent before workers start. */
export async function initializeDeviceRecovery(
  exec: SqlExecutor,
  config: StationConfig,
): Promise<DeviceRecoveryView> {
  let saved = await row(exec);
  const owner = stationOwner(config);
  const hash = config.apiKey
    ? await credentialGenerationOwnership(createCredentialGeneration(config.apiKey))
    : null;
  if (!saved) {
    const [history] = await exec.all<{ count: number }>(`SELECT
      (SELECT COUNT(*) FROM outbox)+(SELECT COUNT(*) FROM inventory_outbox)+
      (SELECT COUNT(*) FROM product_label_jobs)+(SELECT COUNT(*) FROM boxes_mirror)+
      (SELECT COUNT(*) FROM codes_mirror)+(SELECT COUNT(*) FROM validation_occurrences)+(SELECT COUNT(*) FROM shift_close_outbox)+
      (SELECT COUNT(*) FROM box_exceptions_mirror)+(SELECT COUNT(*) FROM inventory_task_mirror)+
      (SELECT COUNT(*) FROM scan_events_mirror)+(SELECT COUNT(*) FROM sscc_pool)+
      (SELECT COUNT(*) FROM conflicts_mirror)+(SELECT COUNT(*) FROM inventory_scan_events_mirror)+
      (SELECT COUNT(*) FROM inventory_repack_journal)+(SELECT COUNT(*) FROM inventory_repack_print_journal)+
      (SELECT COUNT(*) FROM inventory_repack_boxes_mirror)+(SELECT COUNT(*) FROM inventory_conflicts_mirror)+
      (SELECT COUNT(*) FROM station_meta WHERE key LIKE 'sync_pending_%' OR key LIKE 'inventory_sync_batch_v1:%' OR key='active_inventory_floor_task_v1') AS count`);
    const contradictions =
      owner && hash
        ? await exec.all(
            `WITH expected(hash,device) AS (VALUES (?,?))
      SELECT 1 FROM product_label_accept_commands,expected WHERE credential_ownership<>hash OR json_extract(acceptance_json,'$.deviceId')<>device
      UNION SELECT 1 FROM validation_occurrences,expected WHERE credential_ownership<>hash
      UNION SELECT 1 FROM inventory_task_mirror,expected WHERE credential_ownership IS NOT NULL AND credential_ownership<>hash
      UNION SELECT 1 FROM outbox,expected WHERE terminal_id IS NOT NULL AND terminal_id<>device
      UNION SELECT 1 FROM scan_events_mirror,expected WHERE terminal_id IS NOT NULL AND terminal_id<>device
      UNION SELECT 1 FROM boxes_mirror,expected WHERE terminal_id IS NOT NULL AND terminal_id<>device
      UNION SELECT 1 FROM box_exceptions_mirror,expected WHERE terminal_id IS NOT NULL AND terminal_id<>device
      UNION SELECT 1 FROM shift_close_outbox,expected WHERE device_id<>device
      UNION SELECT 1 FROM inventory_terminal_state,expected WHERE device_id<>device
      UNION SELECT 1 FROM inventory_scan_events_mirror,expected WHERE device_id<>device
      UNION SELECT 1 FROM inventory_repack_journal,expected WHERE device_id<>device
      UNION SELECT 1 FROM inventory_repack_print_journal,expected WHERE device_id<>device
      UNION SELECT 1 FROM station_meta,expected WHERE key='sync_pending_product_label_batch'
        AND CASE WHEN json_valid(value) THEN json_extract(value,'$.pin.credentialOwnership') IS NOT hash ELSE 1 END
      UNION SELECT 1 FROM station_meta,expected WHERE key='active_inventory_floor_task_v1'
        AND CASE WHEN json_valid(value) THEN json_extract(value,'$.credentialOwnership') IS NOT hash ELSE 1 END
      LIMIT 1`,
            [hash, owner.deviceId],
          )
        : [];
    const phase =
      owner && hash && contradictions.length === 0
        ? "active"
        : (history?.count ?? 0) > 0 || config.deviceId
          ? "owner_unresolved"
          : "active";
    await exec.run(
      "INSERT INTO station_device_recovery(id,machine_id,owner_json,phase,active_hash) VALUES(1,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      [config.machineId, owner && phase === "active" ? ownerJson(owner) : null, phase, hash],
    );
    saved = await row(exec);
  }
  if (!saved) throw new Error("Recovery state unavailable");
  if (saved.phase === "active" && saved.owner_json === null && owner && hash) {
    await exec.run(
      "UPDATE station_device_recovery SET owner_json=?,active_hash=?,phase='active' WHERE id=1 AND owner_json IS NULL AND phase='active'",
      [ownerJson(owner), hash],
    );
    saved = await row(exec);
    if (!saved) throw new Error("Recovery state unavailable");
  }
  const matches =
    owner !== null &&
    saved.owner_json === ownerJson(owner) &&
    saved.machine_id === config.machineId;
  if (saved.phase === "restoring") {
    if (matches && hash === saved.candidate_hash && hash !== null) {
      await exec.run(
        "UPDATE station_device_recovery SET phase='active',active_hash=candidate_hash,candidate_hash=NULL WHERE id=1 AND phase='restoring' AND candidate_hash=?",
        [hash],
      );
    } else {
      await purgeOperatorsMirror(exec);
      await exec.run(
        "UPDATE station_device_recovery SET phase='sealed',candidate_hash=NULL WHERE id=1 AND phase='restoring'",
      );
    }
  } else if (
    saved.phase === "sealing" ||
    (saved.phase === "active" &&
      saved.owner_json !== null &&
      (!matches || hash !== saved.active_hash))
  ) {
    await purgeOperatorsMirror(exec);
    await exec.run("UPDATE station_device_recovery SET phase='sealed' WHERE id=1");
  }
  if (saved.owner_json === null && !config.apiKey) {
    await exec.run(
      "UPDATE station_device_recovery SET phase='owner_unresolved',active_hash=NULL WHERE id=1 AND owner_json IS NULL AND phase='sealed'",
    );
  }
  const view = await readDeviceRecovery(exec);
  if (!view) throw new Error("Recovery state unavailable");
  return view;
}

/** Persist before waiting for leases; a previous rejected generation cannot touch a new key. */
export async function persistDeviceRecoverySealing(
  exec: SqlExecutor,
  config: StationConfig,
  generation: CredentialGeneration,
): Promise<void> {
  const hash = await credentialGenerationOwnership(generation);
  const saved = await row(exec);
  const owner = stationOwner(config);
  if (!saved || !owner || saved.owner_json !== ownerJson(owner) || saved.active_hash !== hash)
    throw new Error("Recovery owner changed");
  await exec.run(
    "UPDATE station_device_recovery SET phase='sealing' WHERE id=1 AND active_hash=? AND phase='active'",
    [hash],
  );
}

/** Caller owns the config transition. A stale key never seals a replacement key. */
export async function sealDeviceRecovery(
  exec: SqlExecutor,
  config: StationConfig,
  generation: CredentialGeneration,
): Promise<void> {
  const settle = sealCredentialGeneration(generation);
  const hash = await credentialGenerationOwnership(generation);
  const saved = await row(exec);
  const owner = stationOwner(config);
  if (!saved || !owner || saved.owner_json !== ownerJson(owner) || saved.active_hash !== hash)
    throw new Error("Recovery owner changed");
  await exec.run(
    "UPDATE station_device_recovery SET phase='sealing' WHERE id=1 AND active_hash=? AND phase IN ('active','sealing','sealed')",
    [hash],
  );
  await settle;
  await purgeOperatorsMirror(exec);
  await exec.run(
    "UPDATE station_device_recovery SET phase='sealed' WHERE id=1 AND active_hash=? AND phase='sealing'",
    [hash],
  );
}

/** Intent before external config write, activation after it; restart can finish either side. */
export async function restoreDeviceRecovery(
  exec: SqlExecutor,
  expectedOwner: DurableStationOwner,
  provisioning: StationProvisioning,
  publishConfig: (config: StationConfig) => Promise<void>,
): Promise<void> {
  const saved = await row(exec);
  const config: StationConfig = {
    machineId: saved?.machine_id ?? "",
    deviceId: provisioning.deviceId,
    tenantId: provisioning.tenantId,
    serverUrl: provisioning.serverUrl,
    apiKey: provisioning.apiKey,
    deviceName: provisioning.deviceName,
    organizationName: provisioning.organizationName,
    ...(provisioning.lineId ? { lineId: provisioning.lineId } : {}),
    ...(provisioning.lineName ? { lineName: provisioning.lineName } : {}),
  };
  const actual = stationOwner(config);
  if (
    !saved ||
    saved.phase !== "sealed" ||
    saved.owner_json !== ownerJson(expectedOwner) ||
    !actual ||
    !sameStationOwner(actual, expectedOwner)
  )
    throw new Error("Recovery owner mismatch");
  const hash = await credentialGenerationOwnership(createCredentialGeneration(provisioning.apiKey));
  await exec.run(
    "UPDATE station_device_recovery SET phase='restoring',candidate_hash=? WHERE id=1 AND phase='sealed' AND owner_json=?",
    [hash, saved.owner_json],
  );
  await publishConfig(config);
  await exec.run(
    "UPDATE station_device_recovery SET phase='active',active_hash=candidate_hash,candidate_hash=NULL WHERE id=1 AND phase='restoring' AND candidate_hash=?",
    [hash],
  );
}

/** Explicit legacy revocation still clears secrets; lack of an owner never grants data access.
 * The caller holds the same config transition used for the originating identity request. */
export async function sealUnresolvedDeviceRecovery(
  exec: SqlExecutor,
  config: StationConfig,
  clearCredential: () => Promise<void>,
): Promise<void> {
  const saved = await row(exec);
  const hash = config.apiKey
    ? await credentialGenerationOwnership(createCredentialGeneration(config.apiKey))
    : null;
  if (
    !saved ||
    saved.owner_json !== null ||
    saved.machine_id !== config.machineId ||
    !hash ||
    saved.active_hash !== hash
  )
    throw new Error("Recovery credential changed");
  await exec.run(
    "UPDATE station_device_recovery SET phase='sealing' WHERE id=1 AND owner_json IS NULL AND active_hash=?",
    [hash],
  );
  await purgeOperatorsMirror(exec);
  await clearCredential();
  await exec.run(
    "UPDATE station_device_recovery SET phase='owner_unresolved',active_hash=NULL WHERE id=1 AND owner_json IS NULL AND phase='sealing' AND active_hash=?",
    [hash],
  );
}
