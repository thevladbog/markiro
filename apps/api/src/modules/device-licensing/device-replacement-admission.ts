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
