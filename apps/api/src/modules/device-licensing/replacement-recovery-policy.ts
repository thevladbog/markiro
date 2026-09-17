import { SetMetadata } from "@nestjs/common";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

export const REPLACEMENT_RECOVERY_POLICY = "replacement_evidence_recovery_route";
/** Method opt-in only. Subscription recovery policy alone never grants this principal access. */
export const AllowReplacementEvidenceRecovery = () =>
  SetMetadata(REPLACEMENT_RECOVERY_POLICY, true);
export const recoveryKeyMetadataSchema = z
  .object({
    kind: z.literal("station"),
    purpose: z.literal("replacement_evidence_recovery"),
    executionId: z.uuid(),
    deviceId: z.uuid(),
  })
  .strict();
export function recoveryKeyMetadata(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = recoveryKeyMetadataSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export async function currentReplacementRecovery(
  tx: SubscriptionTransaction,
  device: typeof schema.stationDevices.$inferSelect,
  metadata: NonNullable<ReturnType<typeof recoveryKeyMetadata>>,
) {
  if (!device.revokedAt || metadata.deviceId !== device.id) return null;
  const [execution] = await tx
    .select()
    .from(schema.workingDeviceReplacementExecutions)
    .where(
      and(
        eq(schema.workingDeviceReplacementExecutions.tenantId, device.tenantId),
        eq(schema.workingDeviceReplacementExecutions.deviceId, device.id),
        eq(schema.workingDeviceReplacementExecutions.id, metadata.executionId),
      ),
    );
  const [assignment] = await tx
    .select()
    .from(schema.workingDeviceAssignments)
    .where(
      and(
        eq(schema.workingDeviceAssignments.tenantId, device.tenantId),
        eq(schema.workingDeviceAssignments.deviceId, device.id),
      ),
    );
  return execution?.state === "completed" &&
    execution.mode === "emergency" &&
    execution.recoveryState === "draining" &&
    execution.recoveryCredentialEpoch === device.credentialEpoch &&
    assignment?.state === "released" &&
    assignment.releaseReason === "replacement_transferred"
    ? execution
    : null;
}
