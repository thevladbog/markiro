import { schema } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

/**
 * Stored shift work that names the device which did it. Scan ingest writes the
 * authenticated device id into every `terminal_id`, whatever the device sent.
 */
const shiftWorkSources = [
  { table: schema.boxes, shift: schema.boxes.shiftId, device: schema.boxes.terminalId },
  {
    table: schema.scanEvents,
    shift: schema.scanEvents.shiftId,
    device: schema.scanEvents.terminalId,
  },
  {
    table: schema.codeRegistry,
    shift: schema.codeRegistry.shiftId,
    device: schema.codeRegistry.terminalId,
  },
] as const;

/**
 * Whether the server has seen a station other than `deviceId` take part in the
 * shift: an explicit entry, or a scan or box already stored for another paired
 * device of the tenant. Stored work counts even when its device never reported
 * an entry (an older station, or a rejoin made while the server was
 * unreachable) and after that device is revoked: multi-device closing
 * authority never reverts.
 */
export async function otherShiftDeviceObserved(
  tx: SubscriptionTransaction,
  tenantId: string,
  shiftId: string,
  deviceId: string,
): Promise<boolean> {
  // `terminal_id` is free text; only a paired device id of this tenant counts.
  const otherDevices = sql`select ${schema.stationDevices.id}::text from ${schema.stationDevices} where ${schema.stationDevices.tenantId} = ${tenantId} and ${schema.stationDevices.id} <> ${deviceId}`;
  const observed = [
    sql`exists(select 1 from ${schema.shiftDeviceParticipants} where ${schema.shiftDeviceParticipants.tenantId} = ${tenantId} and ${schema.shiftDeviceParticipants.shiftId} = ${shiftId} and ${schema.shiftDeviceParticipants.deviceId} <> ${deviceId})`,
    ...shiftWorkSources.map(
      ({ table, shift, device }) =>
        sql`exists(select 1 from ${table} where ${table.tenantId} = ${tenantId} and ${shift} = ${shiftId} and ${device} in (${otherDevices}))`,
    ),
  ];
  const [row] = await tx
    .select({ observed: sql<boolean>`${sql.join(observed, sql` or `)}` })
    .from(schema.shifts)
    .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)));
  return row?.observed ?? false;
}
