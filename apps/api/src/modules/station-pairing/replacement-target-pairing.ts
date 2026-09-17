import { createHash, randomBytes, randomUUID } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { EntitlementsService } from "../../subscriptions/entitlements.service";
import {
  transitionWorkingAssignment,
  workingAssignment,
} from "../../subscriptions/working-device-assignments";
import { lockGrantFacts } from "../device-grants/grant-admission";
import { replacementTargetFence } from "../device-licensing/device-replacement-admission";
import { PAIR_CODE_MAX_ATTEMPTS } from "../device-pairing/pairing-policy";
const invalid = () => new UnauthorizedException({ code: "PAIR_INVALID" });

/** Only immutable platform replacement issuance can provision without a cabinet member. */
export async function redeemReplacementTarget(input: {
  db: Db;
  entitlements: EntitlementsService;
  candidate: Pick<
    typeof schema.stationPairingCodes.$inferSelect,
    "id" | "tenantId" | "stationDeviceId" | "issuedByUserId"
  >;
  station: { id: string; tenantId: string; kind: string };
}) {
  const { db, entitlements, candidate, station } = input;
  const [binding] = await db
    .select()
    .from(schema.workingDeviceEvents)
    .where(
      and(
        eq(schema.workingDeviceEvents.tenantId, candidate.tenantId),
        eq(schema.workingDeviceEvents.action, "observed"),
        sql`${schema.workingDeviceEvents.after}->>'operation' = 'issue_replacement_target_code'`,
        sql`${schema.workingDeviceEvents.after}->>'pairingCodeId' = ${candidate.id}`,
      ),
    );
  if (!binding) return null; // Ordinary cabinet pairing retains its original path.
  const data = binding.after;
  if (
    binding.actorDomain !== "platform" ||
    binding.actorId !== candidate.issuedByUserId ||
    binding.tenantId !== candidate.tenantId ||
    binding.deviceId !== candidate.stationDeviceId ||
    data?.targetDeviceId !== station.id ||
    data.targetKind !== station.kind ||
    data.purpose !== "normal" ||
    typeof data.executionId !== "string" ||
    typeof data.preparationId !== "string"
  )
    throw invalid();
  const executionId = data.executionId,
    preparationId = data.preparationId;
  return db.transaction(async (tx) => {
    await lockGrantFacts(tx, candidate.tenantId, entitlements);
    await entitlements.assertWriteAccess(candidate.tenantId, tx, new Date());
    const [execution] = await tx
      .select()
      .from(schema.workingDeviceReplacementExecutions)
      .where(
        and(
          eq(schema.workingDeviceReplacementExecutions.tenantId, candidate.tenantId),
          eq(schema.workingDeviceReplacementExecutions.id, executionId),
        ),
      )
      .for("update");
    const [target] = await tx
      .select()
      .from(schema.stationDevices)
      .where(
        and(
          eq(schema.stationDevices.tenantId, candidate.tenantId),
          eq(schema.stationDevices.id, station.id),
        ),
      )
      .for("update");
    const assignment = await workingAssignment(tx, candidate.tenantId, station.id);
    if (
      !target ||
      target.revokedAt ||
      target.apiKeyId ||
      target.kind !== data.targetKind ||
      target.credentialEpoch !== data.targetEpoch ||
      assignment?.state !== "reserved" ||
      execution?.state !== "completed" ||
      execution.step !== "transferred" ||
      !execution.credentialRevokedAt ||
      execution.preparationId !== preparationId ||
      execution.targetDeviceId !== target.id
    )
      throw invalid();
    const [claimed] = await tx
      .update(schema.stationPairingCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.stationPairingCodes.id, candidate.id),
          eq(schema.stationPairingCodes.tenantId, candidate.tenantId),
          eq(schema.stationPairingCodes.stationDeviceId, target.id),
          eq(schema.stationPairingCodes.purpose, "normal"),
          isNull(schema.stationPairingCodes.usedAt),
          gt(schema.stationPairingCodes.expiresAt, sql`now()`),
          lt(schema.stationPairingCodes.attempts, PAIR_CODE_MAX_ATTEMPTS),
        ),
      )
      .returning();
    if (!claimed) throw invalid();
    const now = new Date(),
      key = { id: randomUUID(), key: randomBytes(32).toString("base64url") };
    await tx.insert(schema.apikey).values({
      id: key.id,
      configId: "station",
      name: "Station device",
      referenceId: candidate.tenantId,
      key: createHash("sha256").update(key.key).digest("base64url"),
      enabled: true,
      createdAt: now,
      updatedAt: now,
      metadata: JSON.stringify({ kind: "station" }),
    });
    const [paired] = await tx
      .update(schema.stationDevices)
      .set({ apiKeyId: key.id, pairedAt: now })
      .where(
        and(
          eq(schema.stationDevices.tenantId, candidate.tenantId),
          eq(schema.stationDevices.id, target.id),
        ),
      )
      .returning();
    if (!paired) throw invalid();
    await transitionWorkingAssignment(tx, paired, { domain: "device", id: paired.id });
    const replacement = await replacementTargetFence(
      tx,
      candidate.tenantId,
      target.id,
      paired.credentialEpoch,
    );
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: candidate.tenantId,
      actorUserId: null,
      action: "device.replacement.target_paired",
      outcome: "success",
      targetType: "device_replacement",
      targetId: preparationId,
      requestId: randomUUID(),
      after: {
        actorDomain: "station_device",
        actorId: target.id,
        deviceKind: target.kind,
        executionId,
        credentialEpoch: paired.credentialEpoch,
        pairingCodeId: candidate.id,
      },
    });
    return { key, replacement };
  });
}
