import { readDeviceLicensingWork } from "./device-licensing-work";
import { schema } from "@markiro/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  deviceRetentionObservationSchema,
  type DeviceRetentionDevice,
  type EntitlementSnapshotV1,
} from "@markiro/platform-contracts";
import type { EntitlementsService } from "../../subscriptions/entitlements.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { evaluateEntitlementOperation } from "../../subscriptions/entitlement-projection";
import { entitlementRegistryFingerprint } from "../../subscriptions/entitlement-snapshot-reader";
import {
  assignmentConsistent,
  assignmentOccupied,
} from "../../subscriptions/working-device-assignments";
import { replacementDigest } from "./device-replacement-facts";

export function retentionConditions(snapshot: EntitlementSnapshotV1) {
  return {
    limit: snapshot.candidate.quotas.stations.limit,
    handheld:
      snapshot.candidate.features.handheld === true &&
      evaluateEntitlementOperation(snapshot, "handheld.work.start.v1").outcome === "allow",
  };
}
export function retentionReduction(
  before: ReturnType<typeof retentionConditions>,
  after: ReturnType<typeof retentionConditions>,
  hasHandheld: boolean,
) {
  return (
    (after.limit !== null && (before.limit === null || after.limit < before.limit)) ||
    (hasHandheld && before.handheld && !after.handheld)
  );
}

/** One tenant/device batch per kind. Heartbeats never prove an empty local queue. */
export async function readDeviceRetentionFacts(
  tx: SubscriptionTransaction,
  tenantId: string,
  entitlements: EntitlementsService,
  at: Date,
) {
  const d = schema.stationDevices,
    a = schema.workingDeviceAssignments;
  const pool = await tx
    .select({ device: d, assignment: a })
    .from(d)
    .leftJoin(a, and(eq(a.tenantId, d.tenantId), eq(a.deviceId, d.id)))
    .where(eq(d.tenantId, tenantId))
    .orderBy(asc(d.id));
  const occupied = pool.filter((row) => assignmentOccupied(row.device, row.assignment));
  const subscriptions = await tx
    .select()
    .from(schema.tenantSubscriptions)
    .where(eq(schema.tenantSubscriptions.tenantId, tenantId))
    .orderBy(asc(schema.tenantSubscriptions.id));
  const addons = await tx
    .select()
    .from(schema.subscriptionAddons)
    .where(eq(schema.subscriptionAddons.tenantId, tenantId))
    .orderBy(asc(schema.subscriptionAddons.id));
  const sources = await tx
    .select()
    .from(schema.entitlementSources)
    .where(eq(schema.entitlementSources.tenantId, tenantId))
    .orderBy(asc(schema.entitlementSources.id));
  const versionIds = [
    ...new Set([
      ...subscriptions.map((row) => row.planVersionId),
      ...addons.map((row) => row.addonVersionId),
    ]),
  ].sort();
  const versions = versionIds.length
    ? await tx
        .select()
        .from(schema.catalogItemVersions)
        .where(inArray(schema.catalogItemVersions.id, versionIds))
        .orderBy(asc(schema.catalogItemVersions.id))
    : [];
  const plans = versionIds.length
    ? await tx
        .select()
        .from(schema.planEntitlements)
        .where(inArray(schema.planEntitlements.catalogVersionId, versionIds))
        .orderBy(asc(schema.planEntitlements.catalogVersionId))
    : [];
  const effects = versionIds.length
    ? await tx
        .select()
        .from(schema.addonEntitlements)
        .where(inArray(schema.addonEntitlements.catalogVersionId, versionIds))
        .orderBy(
          asc(schema.addonEntitlements.catalogVersionId),
          asc(schema.addonEntitlements.entitlementKey),
        )
    : [];
  const policyIds = [
    ...new Set(versions.flatMap((row) => (row.lifecyclePolicyId ? [row.lifecyclePolicyId] : []))),
  ].sort();
  const policies = policyIds.length
    ? await tx
        .select()
        .from(schema.entitlementLifecyclePolicies)
        .where(inArray(schema.entitlementLifecyclePolicies.id, policyIds))
        .orderBy(asc(schema.entitlementLifecyclePolicies.id))
    : [];
  const credentialIds = pool.flatMap((row) => (row.device.apiKeyId ? [row.device.apiKeyId] : []));
  const k = schema.apikey;
  const credentials = credentialIds.length
    ? await tx
        .select({
          id: k.id,
          configId: k.configId,
          referenceId: k.referenceId,
          enabled: k.enabled,
          expiresAt: k.expiresAt,
          permissions: k.permissions,
          metadata: k.metadata,
        })
        .from(k)
        .where(inArray(k.id, credentialIds))
        .orderBy(asc(k.id))
    : [];
  const r = schema.workingDeviceReplacementPreparations;
  const replacements = await tx
    .select({ id: r.id, deviceId: r.deviceId, revision: r.revision, state: r.state })
    .from(r)
    .where(eq(r.tenantId, tenantId))
    .orderBy(asc(r.id));
  const { shifts, inventories, jobs, quarantine } = await readDeviceLicensingWork(tx, tenantId);
  const o = schema.orderedServices;
  const services = await tx
    .select({
      id: o.id,
      nameRu: o.nameRu,
      nameEn: o.nameEn,
      quantity: o.quantity,
      unit: o.unit,
      status: o.status,
    })
    .from(o)
    .where(eq(o.tenantId, tenantId))
    .orderBy(asc(o.id));
  const current = await entitlements.resolveSnapshotInTransaction(tenantId, tx, at);
  const dates = [
    ...new Set(
      [
        ...subscriptions
          .filter((row) => !["cancelled", "superseded", "pending_activation"].includes(row.status))
          .flatMap((row) => [row.startsAt, row.endsAt]),
        ...addons
          .filter((row) => ["active", "scheduled"].includes(row.status))
          .flatMap((row) => [row.startsAt, row.endsAt]),
        ...sources
          .filter((row) => row.revokedAt === null)
          .flatMap((row) => [row.startsAt, row.endsAt]),
      ].flatMap((date) => (date && date > at ? [date.getTime()] : [])),
    ),
  ].sort((a, b) => a - b);
  const hasHandheld = occupied.some((row) => row.device.kind === "handheld");
  let boundary: { effectiveAt: string; key: string; future: EntitlementSnapshotV1 } | null = null;
  for (const time of dates) {
    const before = await entitlements.resolveSnapshotInTransaction(
      tenantId,
      tx,
      new Date(time - 1),
    );
    const after = await entitlements.resolveSnapshotInTransaction(tenantId, tx, new Date(time));
    if (
      !retentionReduction(
        retentionConditions(before.snapshot),
        retentionConditions(after.snapshot),
        hasHandheld,
      )
    )
      continue;
    boundary = {
      effectiveAt: new Date(time).toISOString(),
      key: replacementDigest({
        effectiveAt: new Date(time).toISOString(),
        before: retentionConditions(before.snapshot),
        after: retentionConditions(after.snapshot),
        sources: after.sources,
        policy: after.policyFingerprint,
        versionIds: after.versionIds,
      }),
      future: after.snapshot,
    };
    break;
  }
  // Routine status jobs materialize dates already known to this observation. They
  // do not change semantic terms; cancellation/supersession and dates still do.
  const lifecycle = (status: string) =>
    ["scheduled", "active", "trial", "expired"].includes(status) ? "dated" : status;
  const semanticFingerprint = replacementDigest({
    pool: pool.map((row) => ({
      device: { ...row.device, lastSeenAt: null },
      assignment: row.assignment,
    })),
    credentials,
    replacements,
    shifts,
    inventories,
    jobs,
    quarantine,
    services,
    subscriptions: subscriptions.map((row) => ({
      id: row.id,
      planVersionId: row.planVersionId,
      status: lifecycle(row.status),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    })),
    addons: addons.map((row) => ({
      id: row.id,
      subscriptionId: row.subscriptionId,
      addonVersionId: row.addonVersionId,
      status: lifecycle(row.status),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      quantity: row.quantity,
    })),
    sources: sources.map((row) => ({
      id: row.id,
      subscriptionId: row.subscriptionId,
      versionId: row.versionId,
      version: row.version,
      prepared: row.prepared,
      kind: row.kind,
      effects: row.effects,
      operationIds: row.operationIds,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      revokedAt: row.revokedAt,
    })),
    versions,
    plans,
    effects,
    policies: policies.map((row) => ({
      id: row.id,
      version: row.version,
      status: row.status,
      payload: row.payload,
      payloadHash: row.payloadHash,
      approvedAt: row.approvedAt,
    })),
    registry: entitlementRegistryFingerprint(),
  });
  const conditions = retentionConditions(current.snapshot);
  const freshnessFingerprint = replacementDigest({
    semanticFingerprint,
    revision: current.revision,
    usageRevision: current.usageRevision,
    conditions,
    boundary: boundary?.key ?? null,
  });
  let observation = null;
  if (boundary) {
    const futureConditions = retentionConditions(boundary.future);
    const devices: DeviceRetentionDevice[] = occupied.flatMap(({ device, assignment }) => {
      if (
        !assignment ||
        assignment.state === "released" ||
        (device.kind !== "station" && device.kind !== "handheld")
      )
        return [];
      const reasons: DeviceRetentionDevice["reasons"] = [];
      if (!assignmentConsistent(device, assignment)) reasons.push("device_inconsistent");
      if (device.kind === "handheld" && !futureConditions.handheld)
        reasons.push("handheld_unavailable");
      return [
        {
          deviceId: device.id,
          name: device.name,
          kind: device.kind,
          assignmentId: assignment.id,
          revision: assignment.revision,
          state: assignment.state,
          eligible: reasons.length === 0,
          reasons,
          knownServerWork: {
            activeShifts: new Set(
              shifts
                .filter((row) => row.owner === device.id || row.deviceId === device.id)
                .map((row) => row.id),
            ).size,
            activeInventories: new Set(
              inventories.filter((row) => row.deviceId === device.id).map((row) => row.id),
            ).size,
            printJobs: jobs.filter((row) => row.deviceId === device.id).length,
            quarantineBatches: new Set(
              quarantine.filter((row) => row.deviceId === device.id).map((row) => row.batchId),
            ).size,
          },
          localData: { journals: "unknown", outbox: "unknown", printWork: "unknown" },
        },
      ];
    });
    observation = deviceRetentionObservationSchema.parse({
      boundary: { effectiveAt: boundary.effectiveAt, key: boundary.key },
      current: current.snapshot,
      future: boundary.future,
      devices,
      services,
      selectionRequired:
        (futureConditions.limit !== null && occupied.length > futureConditions.limit) ||
        (hasHandheld && !futureConditions.handheld),
      execution: {
        available: false,
        reasons: [
          "enforcement_not_enabled",
          "local_data_unknown",
          ...(boundary.future.readiness.reasons.length ? ["lifecycle_policy_not_ready"] : []),
          ...(futureConditions.limit !== null && occupied.length > futureConditions.limit
            ? ["capacity_unavailable"]
            : []),
          ...(hasHandheld && !futureConditions.handheld ? ["handheld_unavailable"] : []),
        ],
      },
    });
  }
  return {
    observation,
    semanticFingerprint,
    freshnessFingerprint,
    versionIds,
    policyIds,
    credentialIds,
    current: current.snapshot,
    occupied: occupied.map((row) => ({
      id: row.device.id,
      kind: row.device.kind,
      consistent: assignmentConsistent(row.device, row.assignment),
    })),
    nextChangeAt: current.snapshot.nextChangeAt,
    conditions,
  };
}
