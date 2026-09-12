import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { schema } from "@markiro/db";
import { and, count, eq, sql } from "drizzle-orm";
import type { EntitlementsExecutor, SubscriptionTransaction } from "./entitlements.types";

export type WorkingAssignment = typeof schema.workingDeviceAssignments.$inferSelect;
export type WorkingDevice = typeof schema.stationDevices.$inferSelect;
export type WorkingDeviceActor = {
  domain: "system" | "cabinet" | "platform" | "device";
  id: string | null;
};
export const SYSTEM_DEVICE_ACTOR: WorkingDeviceActor = { domain: "system", id: null };

/** Shared by quota totals and the per-line presence projection. */
export function workingDeviceOccupiedSql() {
  const d = schema.stationDevices;
  return sql<boolean>`coalesce((select case
    when a.state <> 'released' then true
    when a.release_reason = 'reservation_cancelled' then
      ${d.apiKeyId} is not null or ${d.pairedAt} is not null or ${d.lastSeenAt} is not null
    else ${d.revokedAt} is null end
    from working_device_assignments a
    where a.tenant_id = ${d.tenantId} and a.device_id = ${d.id}), ${d.revokedAt} is null)`;
}

/** Missing/contradictory facts retain capacity. Offline never releases a place. */
export async function countWorkingDeviceUsage(executor: EntitlementsExecutor, tenantId: string) {
  const d = schema.stationDevices;
  const [result] = await executor
    .select({ value: count() })
    .from(d)
    .where(and(eq(d.tenantId, tenantId), workingDeviceOccupiedSql()));
  return result?.value ?? 0;
}

export async function workingAssignment(
  executor: EntitlementsExecutor,
  tenantId: string,
  deviceId: string,
) {
  const [assignment] = await executor
    .select()
    .from(schema.workingDeviceAssignments)
    .where(
      and(
        eq(schema.workingDeviceAssignments.tenantId, tenantId),
        eq(schema.workingDeviceAssignments.deviceId, deviceId),
      ),
    );
  return assignment;
}

export function assertReservationOpen(assignment: WorkingAssignment | undefined) {
  if (assignment?.releaseReason === "reservation_cancelled") {
    throw new ConflictException({ code: "device_reservation_cancelled" });
  }
}

/** Caller holds the station quota lock and device row lock; no credential data is journalled. */
export async function transitionWorkingAssignment(
  tx: SubscriptionTransaction,
  device: Pick<WorkingDevice, "id" | "tenantId" | "pairedAt" | "apiKeyId" | "revokedAt">,
  actor: WorkingDeviceActor = SYSTEM_DEVICE_ACTOR,
  action?: "observed" | "reserved" | "assigned" | "released",
) {
  const previous = await workingAssignment(tx, device.tenantId, device.id);
  assertReservationOpen(previous);
  const now = new Date();
  const state =
    device.revokedAt !== null
      ? "released"
      : device.pairedAt !== null || device.apiKeyId !== null
        ? "assigned"
        : "reserved";
  const next = {
    id: previous?.id ?? randomUUID(),
    tenantId: device.tenantId,
    deviceId: device.id,
    state,
    revision: (previous?.revision ?? 0) + 1,
    observedAt: previous?.observedAt ?? now,
    updatedAt: now,
    releasedAt: state === "released" ? device.revokedAt : null,
    releaseReason: state === "released" ? ("security_revoked" as const) : null,
    provenance: previous?.provenance ?? ("runtime" as const),
    lastEventId: randomUUID(),
  } satisfies typeof schema.workingDeviceAssignments.$inferInsert;
  await tx.insert(schema.workingDeviceEvents).values({
    id: next.lastEventId,
    tenantId: device.tenantId,
    deviceId: device.id,
    actorDomain: actor.domain,
    actorId: actor.id,
    action: action ?? state,
    before: previous ? assignmentSnapshot(previous) : null,
    after: assignmentSnapshot(next),
  });
  if (previous) {
    await tx
      .update(schema.workingDeviceAssignments)
      .set(next)
      .where(
        and(
          eq(schema.workingDeviceAssignments.tenantId, device.tenantId),
          eq(schema.workingDeviceAssignments.id, previous.id),
        ),
      );
  } else await tx.insert(schema.workingDeviceAssignments).values(next);
  return next;
}

export function assignmentSnapshot(
  value: Pick<WorkingAssignment, "id" | "state" | "revision" | "releaseReason" | "releasedAt">,
) {
  return {
    id: value.id,
    state: value.state,
    revision: value.revision,
    releaseReason: value.releaseReason,
    releasedAt: value.releasedAt?.toISOString() ?? null,
  };
}

export function assignmentConsistent(
  device: WorkingDevice,
  assignment: WorkingAssignment | null | undefined,
) {
  if (!assignment) return false;
  const paired = device.apiKeyId !== null || device.pairedAt !== null || device.lastSeenAt !== null;
  switch (assignment.state) {
    case "reserved":
      return device.revokedAt === null && !paired;
    case "assigned":
      return device.revokedAt === null && (device.pairedAt !== null || device.apiKeyId !== null);
    case "released":
      return assignment.releaseReason === "reservation_cancelled"
        ? device.revokedAt === null && !paired
        : device.revokedAt !== null;
  }
}

export function assignmentOccupied(
  device: WorkingDevice,
  assignment: WorkingAssignment | null | undefined,
) {
  if (!assignment) return device.revokedAt === null;
  if (assignment.state !== "released") return true;
  return assignment.releaseReason === "reservation_cancelled"
    ? device.apiKeyId !== null || device.pairedAt !== null || device.lastSeenAt !== null
    : device.revokedAt === null;
}
