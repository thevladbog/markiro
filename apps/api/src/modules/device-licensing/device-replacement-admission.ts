import { ConflictException, NotFoundException } from "@nestjs/common";
import { schema } from "@markiro/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

/** Lock source before tasks, as drain does. Keep the lock through the work mutation. */
export async function assertDeviceReplacementNewWorkAllowed(
  tx: SubscriptionTransaction,
  tenantId: string,
  deviceId: string,
  existingTask?: { kind: "shift" | "inventory"; id: string },
) {
  const [device] = await tx
    .select({ id: schema.stationDevices.id })
    .from(schema.stationDevices)
    .where(
      and(
        eq(schema.stationDevices.tenantId, tenantId),
        eq(schema.stationDevices.id, deviceId),
        isNull(schema.stationDevices.revokedAt),
      ),
    )
    .for("update");
  if (!device) throw new NotFoundException("Station device not found");
  const waiting = await replacementTargetWaiting(tx, tenantId, deviceId);
  if (waiting)
    throw new ConflictException({
      code: "device_replacement_waiting",
      newWorkAllowedAt: waiting.newWorkAllowedAt.toISOString(),
    });
  const [replacement] = await tx
    .select({ id: schema.workingDeviceReplacementPreparations.id })
    .from(schema.workingDeviceReplacementPreparations)
    .where(
      and(
        eq(schema.workingDeviceReplacementPreparations.tenantId, tenantId),
        eq(schema.workingDeviceReplacementPreparations.deviceId, deviceId),
        inArray(schema.workingDeviceReplacementPreparations.state, [
          "draining",
          "ready",
          "executing",
        ]),
      ),
    );
  if (!replacement) return;
  // Re-entering a currently owned task preserves recovery and close access.
  if (existingTask?.kind === "shift") {
    const [participant] = await tx
      .select({ id: schema.shiftDeviceParticipants.shiftId })
      .from(schema.shiftDeviceParticipants)
      .innerJoin(
        schema.shifts,
        and(
          eq(schema.shifts.tenantId, schema.shiftDeviceParticipants.tenantId),
          eq(schema.shifts.id, schema.shiftDeviceParticipants.shiftId),
        ),
      )
      .where(
        and(
          eq(schema.shiftDeviceParticipants.tenantId, tenantId),
          eq(schema.shiftDeviceParticipants.deviceId, deviceId),
          eq(schema.shiftDeviceParticipants.shiftId, existingTask.id),
          eq(schema.shifts.status, "active"),
        ),
      );
    if (participant) return;
  }
  if (existingTask?.kind === "inventory") {
    const [participant] = await tx
      .select({ id: schema.inventoryDeviceParticipants.id })
      .from(schema.inventoryDeviceParticipants)
      .where(
        and(
          eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
          eq(schema.inventoryDeviceParticipants.deviceId, deviceId),
          eq(schema.inventoryDeviceParticipants.inventoryId, existingTask.id),
          isNull(schema.inventoryDeviceParticipants.leftAt),
        ),
      );
    if (participant) return;
  }
  throw new ConflictException({ code: "device_replacement_draining" });
}

/** Target authority is withheld independently of pairing and subscription mode. */
export async function replacementTargetWaiting(
  tx: SubscriptionTransaction,
  tenantId: string,
  deviceId: string,
  now: Date = new Date(),
) {
  const [execution] = await tx
    .select()
    .from(schema.workingDeviceReplacementExecutions)
    .where(
      and(
        eq(schema.workingDeviceReplacementExecutions.tenantId, tenantId),
        eq(schema.workingDeviceReplacementExecutions.targetDeviceId, deviceId),
      ),
    );
  if (
    !execution ||
    (execution.credentialRevokedAt &&
      execution.state === "completed" &&
      execution.newWorkAllowedAt <= now)
  )
    return null;
  return execution;
}

/** Called under the device/quota locks before issuing or claiming a normal code. */
export async function assertReplacementSourcePairingAllowed(
  tx: SubscriptionTransaction,
  tenantId: string,
  deviceId: string,
) {
  const [row] = await tx
    .select({ id: schema.workingDeviceReplacementPreparations.id })
    .from(schema.workingDeviceReplacementPreparations)
    .where(
      and(
        eq(schema.workingDeviceReplacementPreparations.tenantId, tenantId),
        eq(schema.workingDeviceReplacementPreparations.deviceId, deviceId),
        inArray(schema.workingDeviceReplacementPreparations.state, [
          "draining",
          "ready",
          "executing",
          "completed",
        ]),
      ),
    );
  if (row) throw new ConflictException({ code: "device_replacement_source_frozen" });
}

/** Sent even after the boundary so a durable native wait can obtain an explicit release. */
export async function replacementTargetFence(
  tx: SubscriptionTransaction,
  tenantId: string,
  deviceId: string,
  credentialEpoch: number,
  now: Date = new Date(),
) {
  const [execution] = await tx
    .select()
    .from(schema.workingDeviceReplacementExecutions)
    .where(
      and(
        eq(schema.workingDeviceReplacementExecutions.tenantId, tenantId),
        eq(schema.workingDeviceReplacementExecutions.targetDeviceId, deviceId),
      ),
    );
  if (!execution) return undefined;
  if (execution.state !== "completed" || !execution.credentialRevokedAt)
    throw new ConflictException({ code: "device_replacement_waiting" });
  return {
    version: 1 as const,
    executionId: execution.id,
    credentialEpoch,
    newWorkAllowedAt: execution.newWorkAllowedAt.getTime(),
    serverTime: now.getTime(),
  };
}
