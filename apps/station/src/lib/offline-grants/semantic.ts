import { formatShiftNumber } from "@markiro/domain";
import { z } from "zod";
import type { SqlExecutor } from "../mirror.js";

export interface InventoryExecutionProjection {
  taskKind: "inventory";
  taskId: string;
  scope: { manifest: unknown; snapshotId: string; combinedDigest: string; contentDigest: string };
}
export interface ShiftExecutionProjection {
  taskKind: "shift";
  taskId: string;
  scope: {
    shift: {
      id: string;
      productId: string;
      mode: string;
      lineId: string | null;
      counterpartyId: string | null;
      counterpartyName: string | null;
      labelTemplateId: string | null;
      boxLabelTemplateId: string | null;
      palletLabelTemplateId: string | null;
      validationPrintMode: string | null;
      allowPreviouslyAcceptedCodes: boolean;
      validationPrintVerification: string | null;
      validationPrintTemplateId: string | null;
      validationPrintSnapshot: unknown;
      validationPrintPolicyRevision: string | null;
      boxCapacity: number | null;
      palletsEnabled: boolean;
      palletBoxCapacity: number | null;
      stationClosePolicy: string | null;
      stationCloseOwnerDeviceId: string | null;
      plannedDate: string | null;
      productionDate: string | null;
      number: string;
    };
    product: {
      id: string;
      gtin14: string;
      name: string;
      printName: string | null;
      egaisCode: string | null;
      shelfLifeDays: number | null;
    };
    templates: { id: string; spec: unknown }[];
  };
}
export type ExecutionProjection = InventoryExecutionProjection | ShiftExecutionProjection;

const nullableString = z.string().nullable();
const shiftExecutionScopeSchema = z.strictObject({
  shift: z.strictObject({
    id: z.string().min(1),
    productId: z.string().min(1),
    mode: z.string().min(1),
    lineId: nullableString,
    counterpartyId: nullableString,
    counterpartyName: nullableString,
    labelTemplateId: nullableString,
    boxLabelTemplateId: nullableString,
    palletLabelTemplateId: nullableString,
    validationPrintMode: nullableString,
    allowPreviouslyAcceptedCodes: z.boolean(),
    validationPrintVerification: nullableString,
    validationPrintTemplateId: nullableString,
    validationPrintSnapshot: z.unknown().nullable(),
    validationPrintPolicyRevision: nullableString,
    boxCapacity: z.number().int().positive().nullable(),
    palletsEnabled: z.boolean(),
    palletBoxCapacity: z.number().int().positive().nullable(),
    stationClosePolicy: nullableString,
    stationCloseOwnerDeviceId: nullableString,
    plannedDate: nullableString,
    productionDate: nullableString,
    number: z.string().min(1),
  }),
  product: z.strictObject({
    id: z.string().min(1),
    gtin14: z.string().min(1),
    name: z.string().min(1),
    printName: nullableString,
    egaisCode: nullableString,
    shelfLifeDays: z.number().int().positive().nullable(),
  }),
  templates: z.array(z.strictObject({ id: z.string().min(1), spec: z.unknown() })),
});

/**
 * The task has no durable execution projection to bind against — no mirrored
 * bundle, or one this build can no longer read. Distinct from a storage or
 * parsing fault so callers can degrade on exactly this case and on nothing
 * else.
 */
export class ExecutionProjectionUnavailableError extends Error {}

export async function readShiftExecutionProjection(
  exec: SqlExecutor,
  taskId: string,
): Promise<ShiftExecutionProjection> {
  const [row] = await exec.all<{ execution_scope_json: string | null }>(
    "SELECT execution_scope_json FROM shift_mirror WHERE id=? AND status='active'",
    [taskId],
  );
  if (!row?.execution_scope_json)
    throw new ExecutionProjectionUnavailableError(
      "offline grant active shift requires a fresh bundle",
    );
  const parsed = shiftExecutionScopeSchema.safeParse(JSON.parse(row.execution_scope_json));
  if (!parsed.success)
    throw new ExecutionProjectionUnavailableError(
      "offline grant active shift requires a fresh bundle",
    );
  return { taskKind: "shift", taskId, scope: parsed.data };
}

export async function readInventoryExecutionProjection(
  exec: SqlExecutor,
  taskId: string,
): Promise<InventoryExecutionProjection> {
  const [row] = await exec.all<{
    active_snapshot_id: string | null;
    active_combined_digest: string | null;
    active_content_digest: string | null;
    active_manifest_json: string | null;
  }>(
    "SELECT active_snapshot_id,active_combined_digest,active_content_digest,active_manifest_json FROM inventory_task_mirror WHERE inventory_id=?",
    [taskId],
  );
  if (
    !row?.active_snapshot_id ||
    !row.active_combined_digest ||
    !row.active_content_digest ||
    !row.active_manifest_json
  )
    throw new ExecutionProjectionUnavailableError(
      "offline grant active inventory requires a fresh bundle",
    );
  return {
    taskKind: "inventory",
    taskId,
    scope: {
      manifest: JSON.parse(row.active_manifest_json),
      snapshotId: row.active_snapshot_id,
      combinedDigest: row.active_combined_digest,
      contentDigest: row.active_content_digest,
    },
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("offline grant scope missing");
  return value as Record<string, unknown>;
}
const SHIFT_KEYS = [
  "id",
  "productId",
  "mode",
  "lineId",
  "counterpartyId",
  "counterpartyName",
  "labelTemplateId",
  "boxLabelTemplateId",
  "palletLabelTemplateId",
  "validationPrintMode",
  "allowPreviouslyAcceptedCodes",
  "validationPrintVerification",
  "validationPrintTemplateId",
  "validationPrintSnapshot",
  "validationPrintPolicyRevision",
  "boxCapacity",
  "palletsEnabled",
  "palletBoxCapacity",
  "stationClosePolicy",
  "stationCloseOwnerDeviceId",
  "plannedDate",
  "productionDate",
] as const;
const PRODUCT_KEYS = ["id", "gtin14", "name", "printName", "egaisCode", "shelfLifeDays"] as const;
const project = (source: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, source[key]]));

/** Compare a fixed complete Station projection; callers cannot choose which signed fields matter. */
export function assertExecutionScopeMatches(
  signed: { taskKind: string; taskId: string; scope: unknown },
  actual: ExecutionProjection,
): void {
  if (signed.taskKind !== actual.taskKind || signed.taskId !== actual.taskId)
    throw new Error("offline grant task identity mismatch");
  const scope = record(signed.scope);
  if (actual.taskKind === "inventory") {
    const expected = {
      manifest: scope.manifest,
      snapshotId: scope.snapshotId,
      combinedDigest: scope.combinedDigest,
      contentDigest: scope.contentDigest,
    };
    if (stable(expected) !== stable(actual.scope))
      throw new Error("offline grant active inventory mismatch");
    return;
  }
  const signedShift = record(scope.shift),
    signedProduct = record(scope.product);
  if (!Array.isArray(scope.templates)) throw new Error("offline grant shift scope missing");
  let number: string;
  try {
    if (signedShift.createdFrom !== "admin" && signedShift.createdFrom !== "station")
      throw new Error();
    if (
      typeof signedShift.numberMonthKey !== "string" ||
      !/^[A-Z]{3}\d{2}$/.test(signedShift.numberMonthKey)
    )
      throw new Error();
    if (!Number.isSafeInteger(signedShift.numberSeq) || Number(signedShift.numberSeq) <= 0)
      throw new Error();
    number = formatShiftNumber({
      monthKey: signedShift.numberMonthKey,
      seq: Number(signedShift.numberSeq),
      createdFrom: signedShift.createdFrom,
    });
  } catch {
    throw new Error("offline grant active shift mismatch");
  }
  const expected = {
    shift: { ...project(signedShift, SHIFT_KEYS), number },
    product: project(signedProduct, PRODUCT_KEYS),
    templates: scope.templates,
  };
  if (stable(expected) !== stable(actual.scope))
    throw new Error("offline grant active shift mismatch");
}

/**
 * Reads the projection a productive write must bind to, and says what an
 * unbindable task means.
 *
 * Strict mode propagates the failure: unbound work must not be charged to a
 * signed allowance. Observe mode returns null so the caller records production
 * exactly as a device with no grant state does — an observing station has no
 * authority to stop the line, and the projection is missing for reasons the
 * floor cannot act on (a bundle this device has never mirrored).
 */
export async function readExecutionToBind<T>(
  mode: "observe" | "strict",
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    // Only a missing binding degrades. A failed read, unreadable JSON or a
    // broken invariant is a fault the floor must see rather than silently
    // produce against, in either mode.
    if (mode === "strict" || !(error instanceof ExecutionProjectionUnavailableError)) throw error;
    return null;
  }
}

/**
 * Runs a granted close and turns the trigger's own concurrency refusal into
 * "someone else closed it first".
 *
 * The close triggers refuse to claim a container another owner already closed,
 * and the ungranted paths report exactly that as an `already-closed` verdict
 * rather than a failure. Letting the abort escape instead would tell the
 * operator the close broke, for a container that is closed — and send them to
 * close it again against a second serial.
 */
export async function closeWithConflictVerdict<T>(
  commit: () => Promise<T>,
  abort: "OFFLINE_GRANT_BOX_CLOSE_CONFLICT" | "OFFLINE_GRANT_PALLET_CLOSE_CONFLICT",
): Promise<T | null> {
  try {
    return await commit();
  } catch (error) {
    if (!(error instanceof Error ? error.message : String(error)).includes(abort)) throw error;
    return null;
  }
}
