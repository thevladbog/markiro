import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { schema } from "@markiro/db";
import {
  deviceRetentionSelectionSchema,
  nativeGrantOperationIds,
  type EntitlementSnapshotV1,
} from "@markiro/platform-contracts";
import type { GrantCapability, GrantOwner } from "@markiro/domain";
import type { EntitlementsService } from "../../subscriptions/entitlements.service";
import {
  QUANTITATIVE_ENTITLEMENT_KEYS,
  type SubscriptionTransaction,
} from "../../subscriptions/entitlements.types";
import { lockTenantSubscriptionTimeline } from "../../subscriptions/subscription-locks";
import { lockDeviceLicensingFacts } from "../device-licensing/device-licensing-fact-locks";
import {
  assignmentConsistent,
  assignmentOccupied,
} from "../../subscriptions/working-device-assignments";
import { evaluateEntitlementOperation } from "../../subscriptions/entitlement-projection";
import { retentionStillApplies } from "./grant-retention";
import { lockTenantBoxRegistry } from "../boxes/box-registry-lock";

/** Same serialization protocol as replacement/retention writers. Read committed after locks. */
export async function lockGrantFacts(
  tx: SubscriptionTransaction,
  tenantId: string,
  entitlements: EntitlementsService,
  reservation = false,
) {
  for (const key of QUANTITATIVE_ENTITLEMENT_KEYS)
    await entitlements.withQuotaLock(tx, tenantId, key, () => Promise.resolve());
  await lockTenantSubscriptionTimeline(tx, tenantId);
  await tx
    .select({ id: schema.tenantSubscriptions.id })
    .from(schema.tenantSubscriptions)
    .where(eq(schema.tenantSubscriptions.tenantId, tenantId))
    .orderBy(asc(schema.tenantSubscriptions.id))
    .for("update");
  await tx
    .select({ id: schema.stationDevices.id })
    .from(schema.stationDevices)
    .where(eq(schema.stationDevices.tenantId, tenantId))
    .orderBy(asc(schema.stationDevices.id))
    .for("update");
  if (reservation) await lockTenantBoxRegistry(tx, tenantId);
  await tx
    .select({ id: schema.kiosks.id })
    .from(schema.kiosks)
    .where(eq(schema.kiosks.tenantId, tenantId))
    .orderBy(asc(schema.kiosks.id))
    .for("update");
  await lockDeviceLicensingFacts(tx, tenantId);
  await tx.insert(schema.entitlementRevisions).values({ tenantId }).onConflictDoNothing();
  await tx
    .select()
    .from(schema.entitlementRevisions)
    .where(eq(schema.entitlementRevisions.tenantId, tenantId))
    .for("update");
}
export function allowedNativeCapabilities(
  snapshot: EntitlementSnapshotV1,
  owner: GrantOwner,
): GrantCapability[] {
  const candidates: GrantCapability[] =
    owner.kind === "kiosk" ? ["pickup.start.v1"] : ["shift.start.v1", "inventory.start.v1"];
  return candidates.filter((capability) =>
    nativeGrantOperationIds(owner.kind, capability)?.every(
      (operation) => evaluateEntitlementOperation(snapshot, operation).outcome === "allow",
    ),
  );
}

const replacementNewWorkBlockingStates = new Set(["draining", "ready", "executing"]);

/** A saved plan preserves current authority; only an active replacement transition blocks it. */
export function replacementBlocksNewWorkAdmission(state: unknown) {
  return typeof state === "string" && replacementNewWorkBlockingStates.has(state);
}

/**
 * Task 2 extends the durable preparation state. Query only active transitions now,
 * so legacy prepared/cancelled rows remain non-blocking without inventing a drain.
 */
async function activeReplacementAdmissionProjection(
  tx: SubscriptionTransaction,
  tenantId: string,
  deviceId: string,
) {
  const [replacement] = await tx
    .select({ state: schema.workingDeviceReplacementPreparations.state })
    .from(schema.workingDeviceReplacementPreparations)
    .where(
      and(
        eq(schema.workingDeviceReplacementPreparations.tenantId, tenantId),
        eq(schema.workingDeviceReplacementPreparations.deviceId, deviceId),
        sql`${schema.workingDeviceReplacementPreparations.state} in ('draining', 'ready', 'executing')`,
      ),
    );
  return replacement;
}

export async function grantPoolDenial(
  tx: SubscriptionTransaction,
  owner: GrantOwner,
  snapshot: EntitlementSnapshotV1,
  entitlements: EntitlementsService,
  at: Date,
): Promise<"not_entitled" | "facts_unknown" | null> {
  if (owner.kind === "kiosk") {
    const kiosks = await tx
      .select()
      .from(schema.kiosks)
      .where(eq(schema.kiosks.tenantId, owner.tenantId));
    const device = kiosks.find((row) => row.id === owner.deviceId);
    if (!device || device.status !== "active" || !device.deviceTokenHash) return "not_entitled";
    const limit = snapshot.candidate.quotas.kiosks.limit;
    if (limit !== null && kiosks.filter((row) => row.status === "active").length > limit)
      return "not_entitled";
    return null;
  }
  const pool = await tx
    .select({ device: schema.stationDevices, assignment: schema.workingDeviceAssignments })
    .from(schema.stationDevices)
    .leftJoin(
      schema.workingDeviceAssignments,
      and(
        eq(schema.workingDeviceAssignments.tenantId, schema.stationDevices.tenantId),
        eq(schema.workingDeviceAssignments.deviceId, schema.stationDevices.id),
      ),
    )
    .where(eq(schema.stationDevices.tenantId, owner.tenantId));
  const row = pool.find((row) => row.device.id === owner.deviceId);
  if (!row || !row.assignment || !assignmentConsistent(row.device, row.assignment))
    return "facts_unknown";
  if (row.assignment.state !== "assigned") return "not_entitled";
  const replacement = await activeReplacementAdmissionProjection(
    tx,
    owner.tenantId,
    owner.deviceId,
  );
  if (replacementBlocksNewWorkAdmission(replacement?.state)) return "not_entitled";
  const occupied = pool.filter((row) => assignmentOccupied(row.device, row.assignment));
  if (occupied.some((row) => !assignmentConsistent(row.device, row.assignment)))
    return "facts_unknown";
  const limit = snapshot.candidate.quotas.stations.limit;
  if (limit === null || occupied.length <= limit) return null;
  const [selection] = await tx
    .select()
    .from(schema.workingDeviceRetentionSelections)
    .where(
      and(
        eq(schema.workingDeviceRetentionSelections.tenantId, owner.tenantId),
        lte(schema.workingDeviceRetentionSelections.effectiveAt, at),
      ),
    )
    .orderBy(desc(schema.workingDeviceRetentionSelections.effectiveAt))
    .limit(1);
  if (selection) {
    const members = await tx
      .select()
      .from(schema.workingDeviceRetentionMembers)
      .where(
        and(
          eq(schema.workingDeviceRetentionMembers.tenantId, owner.tenantId),
          eq(schema.workingDeviceRetentionMembers.selectionId, selection.id),
        ),
      );
    const parsed = deviceRetentionSelectionSchema.safeParse({
      id: selection.id,
      revision: selection.revision,
      preparedAt: selection.preparedAt.toISOString(),
      observation: selection.observation,
      selectedDeviceIds: members.map((row) => row.deviceId).sort(),
    });
    if (!parsed.success) return "facts_unknown";
    if (
      !(await retentionStillApplies(
        tx,
        owner.tenantId,
        parsed.data,
        owner.deviceId,
        entitlements,
        at,
      ))
    )
      return "not_entitled";
    // Names, work counters and assignment revisions may change without withdrawing
    // membership. Match stable assignment identity and kind against current rows.
    const original = parsed.data.observation.devices.find(
      (device) => device.deviceId === owner.deviceId,
    );
    if (
      !original ||
      row.assignment.id !== original.assignmentId ||
      row.device.kind !== original.kind
    )
      return "facts_unknown";
    if (!members.some((member) => member.deviceId === owner.deviceId)) return "not_entitled";
    if (members.length > limit) return "facts_unknown";
  } else if (occupied.length > limit) return "not_entitled";
  return null;
}
