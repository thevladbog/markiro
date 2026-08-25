import { z } from "zod";

import {
  parseStationInventoryBundleManifest,
  type StationInventoryBundleManifest,
} from "@markiro/domain";

import type { SqlExecutor } from "./mirror.js";
import {
  acquireCredentialCommitLease,
  credentialGenerationOwnership,
  type CredentialCommitLease,
  type CredentialGeneration,
} from "./credential-recovery.js";

export interface ProductionShiftTask {
  id: string;
  status: string;
  mode: string;
}

export interface StationInventoryTask {
  inventoryId: string;
  inventoryNumber: string;
  productName: string;
  mode: "check" | "repack";
  lineId: string;
  lineName: string;
  productionDateFrom: string;
  productionDateTo: string;
}

export interface ResolvedInventoryTask {
  task: StationInventoryTask;
  deviceLineId: string | null;
  requiresDifferentLineConfirmation: boolean;
}

export type ProductionFloorTask = { kind: "production"; shift: ProductionShiftTask };
export type InventoryFloorTask = {
  kind: "inventory";
  inventory: StationInventoryBundleManifest;
};
export type ActiveFloorTask = ProductionFloorTask | InventoryFloorTask;

export const ACTIVE_INVENTORY_FLOOR_TASK_KEY = "active_inventory_floor_task_v1";

const civilDateSchema = z.iso.date();
const inventoryTaskSchema = z
  .strictObject({
    inventoryId: z.uuid(),
    inventoryNumber: z.string().min(1),
    productName: z.string().min(1),
    mode: z.enum(["check", "repack"]),
    lineId: z.uuid(),
    lineName: z.string().min(1),
    productionDateFrom: civilDateSchema,
    productionDateTo: civilDateSchema,
  })
  .refine((task) => task.productionDateFrom <= task.productionDateTo, {
    message: "inventory task production date range is inverted",
  });

const inventoryTaskListSchema = z.strictObject({ items: z.array(inventoryTaskSchema) });
const resolvedInventoryTaskSchema = z
  .strictObject({
    task: inventoryTaskSchema,
    deviceLineId: z.uuid().nullable(),
    requiresDifferentLineConfirmation: z.boolean(),
  })
  .refine(
    (resolved) =>
      resolved.requiresDifferentLineConfirmation ===
      (resolved.deviceLineId !== resolved.task.lineId),
    { message: "inventory task line confirmation fact is inconsistent" },
  );
const legacyActiveInventoryPointerSchema = z.strictObject({
  inventoryId: z.uuid(),
  snapshotId: z.uuid(),
});
const activeInventoryPointerSchema = z.union([
  z.strictObject({
    inventoryId: z.uuid(),
    snapshotId: z.uuid(),
    credentialOwnership: z.string().regex(/^[0-9a-f]{64}$/),
    activationId: z.string().min(1),
  }),
  z.strictObject({
    inventoryId: z.uuid(),
    snapshotId: z.uuid(),
    activationId: z.string().min(1),
  }),
  z.strictObject({
    inventoryId: z.uuid(),
    snapshotId: z.uuid(),
    credentialOwnership: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({
    inventoryId: z.uuid(),
    snapshotId: z.uuid(),
    activationToken: z.string().min(1),
  }),
  legacyActiveInventoryPointerSchema,
]);

export interface InventoryFloorActivationCommit {
  credentialLease?: CredentialCommitLease;
  activationId: string;
  onPointerCommitted?: (pointerValue: string) => void;
}

interface ActiveInventoryRow {
  inventory_id: string;
  inventory_number: string;
  active_snapshot_id: string | null;
  active_snapshot_revision: number | null;
  active_snapshot_fixed_at: string | null;
  active_combined_digest: string | null;
  active_content_digest: string | null;
  active_code_count: number | null;
  active_manifest_json: string | null;
}

export function productionFloorTask(shift: ProductionShiftTask): ProductionFloorTask {
  return { kind: "production", shift };
}

export function parseInventoryTaskList(value: unknown): StationInventoryTask[] {
  const result = inventoryTaskListSchema.safeParse(value);
  if (!result.success) throw new Error("Invalid station inventory task list");
  return result.data.items;
}

export function parseResolvedInventoryTask(value: unknown): ResolvedInventoryTask {
  const result = resolvedInventoryTaskSchema.safeParse(value);
  if (!result.success) throw new Error("Invalid resolved station inventory task");
  return result.data;
}

function parseActiveManifest(row: ActiveInventoryRow): StationInventoryBundleManifest {
  if (
    row.active_snapshot_id === null ||
    row.active_snapshot_revision !== 1 ||
    row.active_snapshot_fixed_at === null ||
    row.active_combined_digest === null ||
    row.active_content_digest === null ||
    row.active_code_count === null ||
    row.active_manifest_json === null
  ) {
    throw new Error("inventory bundle is not published");
  }
  let value: unknown;
  try {
    value = JSON.parse(row.active_manifest_json);
  } catch {
    throw new Error("active inventory manifest is invalid");
  }
  const manifest = parseStationInventoryBundleManifest(value);
  if (
    manifest.inventoryId !== row.inventory_id ||
    manifest.inventoryNumber !== row.inventory_number ||
    manifest.snapshotId !== row.active_snapshot_id ||
    manifest.snapshotRevision !== row.active_snapshot_revision ||
    manifest.snapshotFixedAt !== row.active_snapshot_fixed_at ||
    manifest.combinedDigest !== row.active_combined_digest ||
    manifest.contentDigest !== row.active_content_digest ||
    manifest.codeCount !== row.active_code_count
  ) {
    throw new Error("active inventory manifest does not match its published pointer");
  }
  return manifest;
}

async function activeInventoryRow(
  exec: SqlExecutor,
  inventoryId: string,
): Promise<ActiveInventoryRow | null> {
  const rows = await exec.all<ActiveInventoryRow>(
    `SELECT inventory_id, inventory_number, active_snapshot_id,
            active_snapshot_revision, active_snapshot_fixed_at,
            active_combined_digest, active_content_digest, active_code_count,
            active_manifest_json
       FROM inventory_task_mirror
      WHERE inventory_id = ?`,
    [inventoryId],
  );
  return rows[0] ?? null;
}

export async function activateVerifiedInventoryFloorTask(
  exec: SqlExecutor,
  inventoryId: string,
  commit?: InventoryFloorActivationCommit,
): Promise<InventoryFloorTask> {
  const lease = commit?.credentialLease;
  if (lease && !lease.active) throw new Error("inventory floor task activation retired");
  const row = await activeInventoryRow(exec, inventoryId);
  if (!row) throw new Error("inventory bundle is not published");
  const inventory = parseActiveManifest(row);
  if (lease && !lease.active) throw new Error("inventory floor task activation retired");
  const credentialOwnership = lease ? await credentialGenerationOwnership(lease.generation) : null;
  if (lease && (!lease.active || credentialOwnership === null)) {
    throw new Error("inventory floor task credential ownership unavailable");
  }
  const pointer = JSON.stringify({
    inventoryId,
    snapshotId: inventory.snapshotId,
    ...(credentialOwnership === null ? {} : { credentialOwnership }),
    ...(commit ? { activationId: commit.activationId } : {}),
  });
  await exec.run(
    `INSERT INTO station_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [ACTIVE_INVENTORY_FLOOR_TASK_KEY, pointer],
  );
  commit?.onPointerCommitted?.(pointer);
  return { kind: "inventory", inventory };
}

/** Removes only the exact activation owned by the retiring selection attempt. */
export async function clearOwnedInventoryFloorTask(
  exec: SqlExecutor,
  pointerValue: string,
): Promise<void> {
  await exec.run("DELETE FROM station_meta WHERE key = ? AND value = ?", [
    ACTIVE_INVENTORY_FLOOR_TASK_KEY,
    pointerValue,
  ]);
}

export async function readPersistedInventoryFloorTask(
  exec: SqlExecutor,
  generation?: CredentialGeneration,
): Promise<InventoryFloorTask | null> {
  const lease = generation ? acquireCredentialCommitLease(generation) : null;
  if (generation && !lease) return null;
  try {
    const rows = await exec.all<{ value: unknown }>(
      "SELECT value FROM station_meta WHERE key = ?",
      [ACTIVE_INVENTORY_FLOOR_TASK_KEY],
    );
    if (rows.length === 0) return null;
    const raw = rows[0]?.value;
    if (typeof raw !== "string") throw new Error("active inventory floor task is invalid");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("active inventory floor task is invalid");
    }
    const parsed = activeInventoryPointerSchema.safeParse(value);
    if (!parsed.success) throw new Error("active inventory floor task is invalid");
    if (generation) {
      const expectedOwnership = await credentialGenerationOwnership(generation);
      if (
        expectedOwnership === null ||
        !("credentialOwnership" in parsed.data) ||
        parsed.data.credentialOwnership !== expectedOwnership
      ) {
        return null;
      }
    }
    const row = await activeInventoryRow(exec, parsed.data.inventoryId);
    if (!row || row.active_snapshot_id !== parsed.data.snapshotId) {
      throw new Error("active inventory floor task is not published");
    }
    return { kind: "inventory", inventory: parseActiveManifest(row) };
  } finally {
    lease?.release();
  }
}
