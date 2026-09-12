import { schema } from "@markiro/db";
import { sql } from "drizzle-orm";
import type { EntitlementsExecutor } from "./entitlements.types";

/** A reservation is empty only if all known server production sources agree. */
const sources = [
  { table: schema.shifts, device: schema.shifts.stationCloseOwnerDeviceId },
  { table: schema.codeConflicts, device: schema.codeConflicts.losingTerminalId },
  { table: schema.codeConflicts, device: schema.codeConflicts.winningTerminalId },
  { table: schema.shiftDeviceParticipants, device: schema.shiftDeviceParticipants.deviceId },
  { table: schema.stationShiftCloseEvents, device: schema.stationShiftCloseEvents.deviceId },
  { table: schema.syncBatches, device: schema.syncBatches.terminalId },
  { table: schema.stationSyncQuarantine, device: schema.stationSyncQuarantine.terminalId },
  { table: schema.ssccBlocks, device: schema.ssccBlocks.deviceId },
  { table: schema.productLabelJobs, device: schema.productLabelJobs.deviceId },
  { table: schema.productLabelEventReceipts, device: schema.productLabelEventReceipts.deviceId },
  {
    table: schema.inventoryDeviceParticipants,
    device: schema.inventoryDeviceParticipants.deviceId,
  },
  { table: schema.inventoryScanBatches, device: schema.inventoryScanBatches.deviceId },
  {
    table: schema.inventoryEventClaimOutcomes,
    device: schema.inventoryEventClaimOutcomes.winningDeviceId,
  },
  { table: schema.inventoryCodeResults, device: schema.inventoryCodeResults.winningDeviceId },
  {
    table: schema.inventoryProgressChanges,
    device: schema.inventoryProgressChanges.winningDeviceId,
  },
  { table: schema.inventoryRepackBoxes, device: schema.inventoryRepackBoxes.ownerDeviceId },
  { table: schema.inventoryLateEvents, device: schema.inventoryLateEvents.deviceId },
  { table: schema.codeRegistry, device: schema.codeRegistry.terminalId },
  { table: schema.boxExceptions, device: schema.boxExceptions.terminalId },
  { table: schema.boxes, device: schema.boxes.terminalId },
  { table: schema.scanEvents, device: schema.scanEvents.terminalId },
] as const;

export async function hasWorkingDeviceEvidence(
  executor: EntitlementsExecutor,
  tenantId: string,
  deviceId: string,
) {
  const predicates = sources.map(
    ({ table, device }) =>
      sql`exists(select 1 from ${table} where ${table.tenantId} = ${tenantId} and ${device} = ${deviceId})`,
  );
  const [row] = await executor
    .select({ exists: sql<boolean>`${sql.join(predicates, sql` or `)}` })
    .from(schema.stationDevices)
    .where(
      sql`${schema.stationDevices.tenantId} = ${tenantId} and ${schema.stationDevices.id} = ${deviceId}`,
    );
  return row?.exists ?? false;
}
