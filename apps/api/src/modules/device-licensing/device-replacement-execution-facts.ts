import { ConflictException } from "@nestjs/common";
import { schema } from "@markiro/db";
import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import {
  deviceReplacementObservationSchema,
  deviceReplacementReadinessRequestSchema,
} from "@markiro/platform-contracts";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import type { EntitlementsService } from "../../subscriptions/entitlements.service";
import { loadEffectiveGrantPolicy } from "../device-grants/grant-policy";
import { readDeviceReplacementFacts, replacementDigest } from "./device-replacement-facts";
import {
  replacementStorageRevisionHighWater,
  REPLACEMENT_REPORT_TTL_MS,
  type ReplacementPreparation,
} from "./device-replacement-readiness-projection";
import { deviceReplacementServerWorkBlockers } from "./device-replacement-readiness-work";

export function executionConflict(code = "stale"): never {
  throw new ConflictException({ code: `device_replacement_${code}` });
}
/** Capture after lockGrantFacts. The client never supplies authority timestamps. */
export async function readReplacementExecutionFacts(
  tx: SubscriptionTransaction,
  row: ReplacementPreparation,
  mode: "normal" | "emergency",
  entitlements: EntitlementsService,
  now: Date,
  fallbackFrom: Date,
) {
  const tenantId = row.tenantId,
    deviceId = row.deviceId;
  const facts = await readDeviceReplacementFacts(
    tx,
    tenantId,
    deviceId,
    deviceReplacementObservationSchema.parse(row.observation).target,
    entitlements,
  );
  if (
    facts.observation.execution.reasons.some(
      (r) => r === "handheld_unavailable" || r === "capacity_unavailable",
    )
  )
    executionConflict("capacity_unavailable");
  const [device] = await tx
    .select()
    .from(schema.stationDevices)
    .where(
      and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, deviceId)),
    );
  const [assignment] = await tx
    .select()
    .from(schema.workingDeviceAssignments)
    .where(
      and(
        eq(schema.workingDeviceAssignments.tenantId, tenantId),
        eq(schema.workingDeviceAssignments.deviceId, deviceId),
      ),
    );
  const [revision] = await tx
    .select()
    .from(schema.entitlementRevisions)
    .where(eq(schema.entitlementRevisions.tenantId, tenantId));
  if (
    !device ||
    (device.kind !== "station" && device.kind !== "handheld") ||
    !assignment ||
    !revision
  )
    executionConflict("facts_unknown");
  const [intent] = await tx
    .select()
    .from(schema.workingDeviceReplacementReadinessIntents)
    .where(
      and(
        eq(schema.workingDeviceReplacementReadinessIntents.tenantId, tenantId),
        eq(schema.workingDeviceReplacementReadinessIntents.preparationId, row.id),
      ),
    )
    .orderBy(
      desc(schema.workingDeviceReplacementReadinessIntents.requestedAt),
      desc(schema.workingDeviceReplacementReadinessIntents.id),
    )
    .limit(1);
  const [report] = intent
    ? await tx
        .select()
        .from(schema.workingDeviceReplacementReadinessReports)
        .where(
          and(
            eq(schema.workingDeviceReplacementReadinessReports.tenantId, tenantId),
            eq(schema.workingDeviceReplacementReadinessReports.intentId, intent.id),
          ),
        )
        .orderBy(desc(schema.workingDeviceReplacementReadinessReports.reportSequence))
        .limit(1)
    : [];
  const [configuration] = await tx
    .select()
    .from(schema.deviceGrantConfigurations)
    .where(
      and(
        eq(schema.deviceGrantConfigurations.tenantId, tenantId),
        eq(schema.deviceGrantConfigurations.stationDeviceId, deviceId),
      ),
    )
    .orderBy(desc(schema.deviceGrantConfigurations.sequence))
    .limit(1);
  const grants = await tx
    .select({
      grantId: schema.deviceGrantIssuances.grantId,
      credentialEpoch: schema.deviceGrantIssuances.credentialEpoch,
      policyRevision: schema.deviceGrantIssuances.policyRevision,
      kind: schema.deviceGrantIssuances.kindOfGrant,
      issuedAt: schema.deviceGrantIssuances.issuedAt,
      startNotAfter: schema.deviceGrantIssuances.startNotAfter,
      completeNotAfter: schema.deviceGrantIssuances.completeNotAfter,
    })
    .from(schema.deviceGrantIssuances)
    .where(
      and(
        eq(schema.deviceGrantIssuances.tenantId, tenantId),
        eq(schema.deviceGrantIssuances.stationDeviceId, deviceId),
        eq(schema.deviceGrantIssuances.ownerKind, device.kind),
        // Rotating/revoking a cloud key does not retire signed authority on a
        // disconnected device. Keep every live horizon of the durable source.
        or(
          eq(schema.deviceGrantIssuances.credentialEpoch, device.credentialEpoch),
          gt(schema.deviceGrantIssuances.startNotAfter, now),
          gt(schema.deviceGrantIssuances.completeNotAfter, now),
        ),
      ),
    )
    .orderBy(asc(schema.deviceGrantIssuances.grantId));
  const currentGrants = grants.filter((g) => g.credentialEpoch === device.credentialEpoch);
  const [inheritedExecution] = await tx
    .select({
      id: schema.workingDeviceReplacementExecutions.id,
      state: schema.workingDeviceReplacementExecutions.state,
      credentialRevokedAt: schema.workingDeviceReplacementExecutions.credentialRevokedAt,
      newWorkAllowedAt: schema.workingDeviceReplacementExecutions.newWorkAllowedAt,
    })
    .from(schema.workingDeviceReplacementExecutions)
    .where(
      and(
        eq(schema.workingDeviceReplacementExecutions.tenantId, tenantId),
        eq(schema.workingDeviceReplacementExecutions.targetDeviceId, deviceId),
      ),
    );
  if (
    inheritedExecution &&
    (inheritedExecution.state !== "completed" || !inheritedExecution.credentialRevokedAt)
  )
    executionConflict("offline_boundary_unknown");
  const payload = report ? deviceReplacementReadinessRequestSchema.parse(report.payload) : null;
  const storageHighWater = intent ? await replacementStorageRevisionHighWater(tx, intent) : 0;
  const blockers = deviceReplacementServerWorkBlockers(facts.work, deviceId);
  if (mode === "normal") {
    if (
      row.state !== "ready" ||
      device.revokedAt ||
      !device.apiKeyId ||
      !intent ||
      intent.state !== "active" ||
      !report ||
      !payload ||
      report.eligibility.status !== "eligible" ||
      intent.credentialEpoch !== device.credentialEpoch ||
      report.credentialEpoch !== device.credentialEpoch ||
      report.receivedAt < intent.requestedAt ||
      now >= intent.expiresAt ||
      now.getTime() - report.receivedAt.getTime() >= REPLACEMENT_REPORT_TTL_MS ||
      report.storageRevision < storageHighWater ||
      intent.factsFingerprint !== facts.readinessFingerprint ||
      intent.assignmentRevision !== assignment.revision ||
      intent.entitlementRevision !== revision.revision ||
      intent.usageRevision !== revision.usageRevision ||
      (configuration?.id ?? null) !== intent.grantConfigurationId ||
      (configuration?.sequence ?? null) !== intent.grantConfigurationSequence ||
      blockers.length
    )
      executionConflict("not_ready");
    if (
      Object.values({
        ...payload.pending,
        conflicts: payload.conflicts,
        unknownPrints: payload.unknownPrints,
      }).some((v) => v !== 0) ||
      payload.activeTasks.length ||
      payload.installedGrants.some(({ grantId }) => {
        const grant = currentGrants.find((g) => g.grantId === grantId);
        return (
          !grant || (grant.kind === "device" && (!grant.startNotAfter || grant.startNotAfter > now))
        );
      })
    )
      executionConflict("not_ready");
  }
  // Readiness proves the current installation is drained, not that previous
  // credentials or a predecessor's offline authority have ceased to exist.
  let boundary = Math.max(
    now.getTime(),
    inheritedExecution?.newWorkAllowedAt.getTime() ?? 0,
    ...grants.map(
      (g) => (g.kind === "device" ? g.startNotAfter : g.completeNotAfter)?.getTime() ?? 0,
    ),
  );
  let policyRevision: string | null = null;
  let fallback = false;
  if (mode === "emergency") {
    policyRevision = grants[0]?.policyRevision ?? null;
    const unknownIssuance =
      currentGrants.length === 0 ||
      payload?.installedGrants.some(
        (g) => !currentGrants.some((issued) => issued.grantId === g.grantId),
      ) ||
      grants.some((g) => !(g.kind === "device" ? g.startNotAfter : g.completeNotAfter));
    if (unknownIssuance) {
      const current = await entitlements.resolveSnapshotInTransaction(tenantId, tx, now);
      const subscription = current.snapshot.current.subscription;
      const effective = subscription
        ? await loadEffectiveGrantPolicy(
            tx,
            { tenantId, deviceId, kind: device.kind, credentialEpoch: device.credentialEpoch },
            subscription.id,
          )
        : null;
      if (!effective?.policy) executionConflict("offline_boundary_unknown");
      policyRevision = effective.policy.revision;
      // Preview expiry is an upper bound on the last possible issuance before the
      // execution admission fence. Anchoring here keeps confirmation deterministic.
      boundary = Math.max(
        boundary,
        fallbackFrom.getTime() +
          Math.max(effective.policy.maxOfflineMs, effective.policy.maxCompletionMs),
      );
      fallback = true;
    }
  }
  const sourceWork = {
    shifts: facts.work.shifts.filter((w) => w.owner === deviceId || w.deviceId === deviceId),
    inventories: facts.work.inventories.filter((w) => w.deviceId === deviceId),
    jobs: facts.work.jobs.filter((w) => w.deviceId === deviceId),
    quarantine: facts.work.quarantine.filter((w) => w.deviceId === deviceId),
    nativeEvidence: facts.work.nativeEvidence.filter((w) => w.deviceId === deviceId),
  };
  const serverFacts = {
    sourceAssignment: { id: assignment.id, revision: assignment.revision, state: assignment.state },
    sourceWork,
    inheritedExecution: inheritedExecution ?? null,
    grants,
    reportId: report?.id ?? null,
    storageHighWater,
    policyRevision,
    fallback,
  };
  const digest = replacementDigest({
    authority: facts.readinessFingerprint,
    configuration: configuration?.id ?? null,
    report: report?.id ?? null,
    intent: intent?.id ?? null,
    serverFacts,
  });
  return { device, assignment, facts, report, serverFacts, digest, boundary: new Date(boundary) };
}
