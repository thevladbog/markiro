import { ConflictException, NotFoundException } from "@nestjs/common";
import { schema } from "@markiro/db";
import { and, asc, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import {
  deviceReplacementObservationSchema,
  type DeviceReplacementTarget,
} from "@markiro/platform-contracts";
import type { EntitlementsService } from "../../subscriptions/entitlements.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import {
  entitlementDigest,
  entitlementRegistryFingerprint,
} from "../../subscriptions/entitlement-snapshot-reader";
import {
  assignmentConsistent,
  assignmentOccupied,
} from "../../subscriptions/working-device-assignments";

/** Dates must become ISO strings before the canonical digest (Date has no enumerable fields). */
export function replacementDigest(value: unknown) {
  return entitlementDigest(JSON.parse(JSON.stringify(value)));
}

async function readDevicePool(tx: SubscriptionTransaction, tenantId: string) {
  const d = schema.stationDevices;
  const a = schema.workingDeviceAssignments;
  return tx
    .select({ device: d, assignment: a })
    .from(d)
    .leftJoin(a, and(eq(a.tenantId, d.tenantId), eq(a.deviceId, d.id)))
    .where(eq(d.tenantId, tenantId))
    .orderBy(asc(d.id));
}

/** Shared only within one read-only repeatable-read list transaction. */
export function createDeviceReplacementListFactReader(
  tx: SubscriptionTransaction,
  tenantId: string,
  entitlements: EntitlementsService,
) {
  let tenantFacts: Promise<ReadOnlyTenantFacts> | undefined;
  return async (deviceId: string, target: DeviceReplacementTarget) => {
    tenantFacts ??= (async () => ({
      rows: await readDevicePool(tx, tenantId),
      facts: await entitlements.resolveSnapshotInTransaction(tenantId, tx),
    }))();
    // Device and target facts are never cached by device ID alone.
    return readDeviceReplacementFacts(
      tx,
      tenantId,
      deviceId,
      target,
      entitlements,
      await tenantFacts,
    );
  };
}

type ReadOnlyTenantFacts = {
  rows: Awaited<ReturnType<typeof readDevicePool>>;
  facts: Awaited<ReturnType<EntitlementsService["resolveSnapshotInTransaction"]>>;
};

export async function readDeviceReplacementFacts(
  tx: SubscriptionTransaction,
  tenantId: string,
  deviceId: string,
  target: DeviceReplacementTarget,
  entitlements: EntitlementsService,
  readOnlyFacts?: ReadOnlyTenantFacts,
) {
  const rows = readOnlyFacts?.rows ?? (await readDevicePool(tx, tenantId));
  const source = rows.find((row) => row.device.id === deviceId);
  if (!source) throw new NotFoundException();
  if (!rows.every((row) => assignmentConsistent(row.device, row.assignment)))
    throw new ConflictException({ code: "device_replacement_inconsistent" });
  const { device, assignment } = source;
  // Revocation clears the credential ID, including legacy devices with no
  // pairedAt. Their immutable assignment journal remains pairing evidence.
  const priorPairing =
    assignment?.state === "released"
      ? ((
          await tx
            .select({ id: schema.workingDeviceEvents.id })
            .from(schema.workingDeviceEvents)
            .where(
              and(
                eq(schema.workingDeviceEvents.tenantId, tenantId),
                eq(schema.workingDeviceEvents.deviceId, deviceId),
                sql`(${schema.workingDeviceEvents.after}->>'state' = 'assigned' or ${schema.workingDeviceEvents.before}->>'state' = 'assigned')`,
              ),
            )
            .orderBy(asc(schema.workingDeviceEvents.createdAt), asc(schema.workingDeviceEvents.id))
            .limit(1)
        )[0] ?? null)
      : null;
  // Before the assignment journal existed, TenantGuard wrote lastSeenAt only
  // after authenticating a live station key bound to this tenant/device. The
  // migration records already-revoked devices as released, not prior assigned.
  const authenticatedLegacyObservation =
    assignment?.provenance === "migration" &&
    assignment.state === "released" &&
    assignment.releaseReason === "security_revoked" &&
    device.lastSeenAt !== null;
  if (
    !assignment ||
    !(device.pairedAt || device.apiKeyId || priorPairing || authenticatedLegacyObservation) ||
    (assignment.state !== "assigned" &&
      !(assignment.state === "released" && assignment.releaseReason === "security_revoked"))
  )
    throw new ConflictException({ code: "device_replacement_source_ineligible" });
  const credentialQuery = (apiKeyId: string) =>
    tx
      .select({
        id: schema.apikey.id,
        configId: schema.apikey.configId,
        referenceId: schema.apikey.referenceId,
        enabled: schema.apikey.enabled,
        expiresAt: schema.apikey.expiresAt,
        permissions: schema.apikey.permissions,
        metadata: schema.apikey.metadata,
      })
      .from(schema.apikey)
      .where(eq(schema.apikey.id, apiKeyId));
  const credential = device.apiKeyId
    ? ((
        await (readOnlyFacts
          ? credentialQuery(device.apiKeyId)
          : credentialQuery(device.apiKeyId).for("share"))
      )[0] ?? null)
    : null;
  const shifts = await tx
    .selectDistinct({
      id: schema.shifts.id,
      status: schema.shifts.status,
      closeOwner: schema.shifts.stationCloseOwnerDeviceId,
    })
    .from(schema.shifts)
    .leftJoin(
      schema.shiftDeviceParticipants,
      and(
        eq(schema.shiftDeviceParticipants.tenantId, schema.shifts.tenantId),
        eq(schema.shiftDeviceParticipants.shiftId, schema.shifts.id),
      ),
    )
    .where(
      and(
        eq(schema.shifts.tenantId, tenantId),
        ne(schema.shifts.status, "closed"),
        or(
          eq(schema.shifts.stationCloseOwnerDeviceId, deviceId),
          eq(schema.shiftDeviceParticipants.deviceId, deviceId),
        ),
      ),
    )
    .orderBy(asc(schema.shifts.id));
  const ip = schema.inventoryDeviceParticipants;
  const inventories = await tx
    .select({
      id: schema.inventories.id,
      status: schema.inventories.status,
      participantId: ip.id,
      pendingEventCount: ip.pendingEventCount,
      openBoxCount: ip.openBoxCount,
      leftAt: ip.leftAt,
    })
    .from(schema.inventories)
    .innerJoin(
      ip,
      and(eq(ip.tenantId, schema.inventories.tenantId), eq(ip.inventoryId, schema.inventories.id)),
    )
    .where(
      and(
        eq(schema.inventories.tenantId, tenantId),
        eq(ip.deviceId, deviceId),
        notInArray(schema.inventories.status, ["completed", "cancelled"]),
      ),
    )
    .orderBy(asc(schema.inventories.id), asc(ip.id));
  const jobs = await tx
    .select({
      id: schema.productLabelJobs.jobId,
      latestSequence: schema.productLabelJobs.latestSequence,
      payloadDigest: schema.productLabelJobs.payloadDigest,
      projection: schema.productLabelJobs.projection,
    })
    .from(schema.productLabelJobs)
    .where(
      and(
        eq(schema.productLabelJobs.tenantId, tenantId),
        eq(schema.productLabelJobs.deviceId, deviceId),
      ),
    )
    .orderBy(asc(schema.productLabelJobs.jobId));
  const quarantine = await tx
    .select({
      id: schema.stationSyncQuarantine.id,
      batchId: schema.stationSyncQuarantine.batchId,
      recordKind: schema.stationSyncQuarantine.recordKind,
      recordIndex: schema.stationSyncQuarantine.recordIndex,
      payloadDigest: schema.stationSyncQuarantine.payloadDigest,
    })
    .from(schema.stationSyncQuarantine)
    .where(
      and(
        eq(schema.stationSyncQuarantine.tenantId, tenantId),
        eq(schema.stationSyncQuarantine.terminalId, deviceId),
      ),
    )
    .orderBy(asc(schema.stationSyncQuarantine.id));
  const facts =
    readOnlyFacts?.facts ?? (await entitlements.resolveSnapshotInTransaction(tenantId, tx));
  if (!readOnlyFacts && facts.versionIds.length)
    await tx
      .select({ id: schema.catalogItemVersions.id })
      .from(schema.catalogItemVersions)
      .where(inArray(schema.catalogItemVersions.id, facts.versionIds))
      .orderBy(asc(schema.catalogItemVersions.id))
      .for("share");
  if (!readOnlyFacts && facts.policyIds.length)
    await tx
      .select({ id: schema.entitlementLifecyclePolicies.id })
      .from(schema.entitlementLifecyclePolicies)
      .where(inArray(schema.entitlementLifecyclePolicies.id, facts.policyIds))
      .orderBy(asc(schema.entitlementLifecyclePolicies.id))
      .for("share");
  if (!readOnlyFacts)
    await tx.execute(
      sql`select tenant_id from entitlement_revisions where tenant_id=${tenantId} for update`,
    );
  const occupied = assignmentOccupied(device, assignment);
  const usage = rows.filter((row) => assignmentOccupied(row.device, row.assignment)).length;
  const limit = facts.snapshot.current.quotas.stations.limit;
  const reasons: Array<
    | "transfer_not_available"
    | "local_data_unknown"
    | "source_authority_transition_required"
    | "handheld_unavailable"
    | "capacity_unavailable"
    | "lifecycle_policy_not_ready"
  > = ["transfer_not_available", "local_data_unknown", "source_authority_transition_required"];
  if (target.kind === "handheld" && facts.snapshot.candidate.features.handheld !== true)
    reasons.push("handheld_unavailable");
  if (limit !== null && usage + (occupied ? 0 : 1) > limit) reasons.push("capacity_unavailable");
  if (facts.snapshot.readiness.reasons.length) reasons.push("lifecycle_policy_not_ready");
  const observation = deviceReplacementObservationSchema.parse({
    source: {
      deviceId,
      name: device.name,
      kind: device.kind,
      lineId: device.lineId,
      assignmentId: assignment.id,
      revision: assignment.revision,
      state: assignment.state,
      slotOccupied: occupied,
      pairedAt: device.pairedAt?.toISOString() ?? null,
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      revokedAt: device.revokedAt?.toISOString() ?? null,
    },
    target,
    usage,
    limit,
    preparationSlotDelta: 0,
    expectedTransferSlotDelta: occupied ? 0 : 1,
    knownServerWork: {
      activeShifts: shifts.length,
      activeInventories: new Set(inventories.map((row) => row.id)).size,
      printJobs: jobs.length,
      quarantineBatches: new Set(quarantine.map((row) => row.batchId)).size,
    },
    localData: { journals: "unknown", outbox: "unknown", printWork: "unknown" },
    execution: { available: false, reasons },
  });
  const fingerprint = replacementDigest({
    credential,
    priorPairing,
    authenticatedLegacyObservation,
    source: { ...device, lastSeenAt: null },
    pool: rows.map((row) => ({
      deviceId: row.device.id,
      assignment: row.assignment,
      occupied: assignmentOccupied(row.device, row.assignment),
    })),
    target,
    usage: facts.input.usage,
    current: facts.snapshot.current,
    candidate: facts.snapshot.candidate,
    sources: facts.sources,
    sourceVersions: facts.sourceDetails.map((row) => ({
      id: row.id,
      versionId: row.versionId,
      version: row.version,
      revokedAt: row.revokedAt,
    })),
    revision: facts.revision,
    usageRevision: facts.usageRevision,
    policy: facts.policyFingerprint,
    registry: entitlementRegistryFingerprint(),
    shifts,
    inventories,
    jobs,
    quarantine,
  });
  return { observation, fingerprint, nextChangeAt: facts.snapshot.nextChangeAt };
}
