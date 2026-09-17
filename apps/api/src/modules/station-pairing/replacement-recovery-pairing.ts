import { createHash, randomBytes, randomUUID } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { PairStationResultDto } from "./dto";
import type { EntitlementsService } from "../../subscriptions/entitlements.service";
import { lockGrantFacts } from "../device-grants/grant-admission";
import { loadEnv } from "../../env";
import { PAIR_CODE_MAX_ATTEMPTS } from "../device-pairing/pairing-policy";
import { replacementDigest } from "../device-licensing/device-replacement-facts";
const invalid = () => new UnauthorizedException({ code: "PAIR_INVALID" });
export async function redeemReplacementRecovery(input: {
  db: Db;
  entitlements: EntitlementsService;
  candidate: Pick<
    typeof schema.stationPairingCodes.$inferSelect,
    "id" | "tenantId" | "stationDeviceId" | "issuedByUserId"
  >;
  station: {
    id: string;
    tenantId: string;
    kind: string;
    name: string;
    organizationName: string;
    lineId: string | null;
    lineName: string | null;
  };
}): Promise<PairStationResultDto> {
  const { db, entitlements, candidate, station } = input;
  const [binding] = await db
    .select()
    .from(schema.workingDeviceEvents)
    .where(
      and(
        eq(schema.workingDeviceEvents.tenantId, candidate.tenantId),
        eq(schema.workingDeviceEvents.deviceId, candidate.stationDeviceId),
        eq(schema.workingDeviceEvents.action, "replacement_recovery_started"),
        sql`${schema.workingDeviceEvents.after}->>'pairingCodeId' = ${candidate.id}`,
      ),
    );
  const executionId = binding?.after?.executionId;
  if (
    typeof executionId !== "string" ||
    !binding ||
    !["cabinet", "platform"].includes(binding.actorDomain) ||
    !binding.actorId
  )
    throw invalid();
  const actorId = binding.actorId;
  const key = { id: randomUUID(), key: randomBytes(32).toString("base64url") };
  const recovery = await db.transaction(async (tx) => {
    await lockGrantFacts(tx, candidate.tenantId, entitlements);
    const [source] = await tx
      .select()
      .from(schema.stationDevices)
      .where(
        and(
          eq(schema.stationDevices.tenantId, candidate.tenantId),
          eq(schema.stationDevices.id, station.id),
        ),
      )
      .for("update");
    const [execution] = await tx
      .select()
      .from(schema.workingDeviceReplacementExecutions)
      .where(
        and(
          eq(schema.workingDeviceReplacementExecutions.tenantId, candidate.tenantId),
          eq(schema.workingDeviceReplacementExecutions.deviceId, station.id),
          eq(schema.workingDeviceReplacementExecutions.id, executionId),
        ),
      )
      .for("update");
    const [assignment] = await tx
      .select()
      .from(schema.workingDeviceAssignments)
      .where(
        and(
          eq(schema.workingDeviceAssignments.tenantId, candidate.tenantId),
          eq(schema.workingDeviceAssignments.deviceId, station.id),
        ),
      );
    if (
      !source?.revokedAt ||
      source.credentialEpoch !== binding.after?.sourceCredentialEpoch ||
      source.kind !== station.kind ||
      !execution ||
      execution.state !== "completed" ||
      execution.mode !== "emergency" ||
      !["required", "draining"].includes(execution.recoveryState) ||
      assignment?.state !== "released" ||
      assignment.releaseReason !== "replacement_transferred"
    )
      throw invalid();
    const [claimed] = await tx
      .update(schema.stationPairingCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.stationPairingCodes.id, candidate.id),
          eq(schema.stationPairingCodes.purpose, "replacement_recovery"),
          isNull(schema.stationPairingCodes.usedAt),
          gt(schema.stationPairingCodes.expiresAt, sql`now()`),
          lt(schema.stationPairingCodes.attempts, PAIR_CODE_MAX_ATTEMPTS),
        ),
      )
      .returning();
    if (!claimed) throw invalid();
    // Platform operators are deliberately not cabinet members. Mint this restricted
    // credential only after the code/execution/source locks authorize redemption;
    // use the same hash format verified by TenantGuard, with no orphan on rollback.
    const now = new Date(),
      expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await tx.insert(schema.apikey).values({
      id: key.id,
      configId: "station",
      name: "Evidence recovery",
      referenceId: candidate.tenantId,
      key: createHash("sha256").update(key.key).digest("base64url"),
      enabled: true,
      expiresAt,
      createdAt: now,
      updatedAt: now,
      metadata: JSON.stringify({
        kind: "station",
        purpose: "replacement_evidence_recovery",
        executionId,
        deviceId: source.id,
      }),
    });
    if (source.apiKeyId)
      await tx.delete(schema.apikey).where(eq(schema.apikey.id, source.apiKeyId));
    const [paired] = await tx
      .update(schema.stationDevices)
      .set({ apiKeyId: key.id })
      .where(eq(schema.stationDevices.id, source.id))
      .returning();
    if (!paired) throw invalid();
    const [revision] = await tx
      .select()
      .from(schema.entitlementRevisions)
      .where(eq(schema.entitlementRevisions.tenantId, candidate.tenantId));
    if (!revision) throw invalid();
    await tx
      .update(schema.workingDeviceReplacementReadinessIntents)
      .set({ state: "superseded", closedAt: now })
      .where(
        and(
          eq(schema.workingDeviceReplacementReadinessIntents.tenantId, candidate.tenantId),
          eq(schema.workingDeviceReplacementReadinessIntents.deviceId, source.id),
          eq(schema.workingDeviceReplacementReadinessIntents.state, "active"),
        ),
      );
    const [preparation] = await tx
      .select()
      .from(schema.workingDeviceReplacementPreparations)
      .where(eq(schema.workingDeviceReplacementPreparations.id, execution.preparationId));
    if (!preparation) throw invalid();
    const requestId = randomUUID();
    const [intent] = await tx
      .insert(schema.workingDeviceReplacementReadinessIntents)
      .values({
        tenantId: candidate.tenantId,
        deviceId: source.id,
        preparationId: execution.preparationId,
        actorDomain: binding.actorDomain === "platform" ? "platform" : "cabinet",
        actorId,
        requestId,
        requestHash: replacementDigest({ executionId, credentialEpoch: paired.credentialEpoch }),
        credentialEpoch: paired.credentialEpoch,
        preparationRevision: preparation.revision,
        assignmentRevision: assignment.revision,
        entitlementRevision: revision.revision,
        usageRevision: revision.usageRevision,
        factsFingerprint: execution.factsFingerprint,
        requestedAt: now,
        expiresAt,
      })
      .returning();
    if (!intent) throw invalid();
    await tx
      .update(schema.workingDeviceReplacementExecutions)
      .set({
        recoveryState: "draining",
        recoveryCredentialEpoch: paired.credentialEpoch,
        revision: execution.revision + 1,
      })
      .where(eq(schema.workingDeviceReplacementExecutions.id, execution.id));
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: candidate.tenantId,
      actorUserId: null,
      action: "device.replacement.recovery_paired",
      outcome: "success",
      targetType: "device_replacement",
      targetId: execution.preparationId,
      requestId,
      after: {
        actorDomain: "station_device",
        actorId: source.id,
        deviceKind: source.kind,
        executionId,
        credentialEpoch: paired.credentialEpoch,
        intentId: intent.id,
      },
    });
    return {
      version: 1 as const,
      purpose: "replacement_evidence_recovery" as const,
      operatorRoster: "preserve_sealed" as const,
      executionId,
      intentId: intent.id,
      credentialEpoch: paired.credentialEpoch,
      requestedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  });
  return {
    device: {
      id: station.id,
      name: station.name,
      kind: station.kind === "handheld" ? "handheld" : "station",
      tenantId: station.tenantId,
      organizationName: station.organizationName,
      line:
        station.lineId && station.lineName ? { id: station.lineId, name: station.lineName } : null,
    },
    credential: { apiKey: key.key, serverUrl: loadEnv().BETTER_AUTH_URL },
    operators: [],
    recovery,
  };
}
