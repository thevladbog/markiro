import { generateKeyPairSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, schema } from "@markiro/db";
import { platformCapabilitiesForRole, type PlatformPrincipal } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureGrantSigning } from "../src/modules/device-grants/grant-keyset";
import { loadEffectiveGrantPolicy } from "../src/modules/device-grants/grant-policy";
import { resolveGrantRollout } from "../src/modules/device-grants/grant-rollout";
import { PlatformGrantActivationService } from "../src/modules/device-grants/platform-grant-activation.service";
import { PlatformGrantRollbackService } from "../src/modules/device-grants/platform-grant-rollback.service";
import { PlatformGrantReadinessService } from "../src/modules/device-grants/platform-grant-readiness.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { entitlementDigest } from "../src/subscriptions/entitlement-snapshot-reader";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("offline grant activation preparation", () => {
  const databaseName = `platform_grant_activation_${randomUUID().replaceAll("-", "_")}`;
  const adminUrl = new URL(databaseUrl ?? "postgres://invalid");
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${databaseName}`;
  testUrl.search = "";
  const admin = createDb(adminUrl.toString());
  const connection = createDb(testUrl.toString());
  const db = connection.db;
  const now = new Date("2026-09-14T12:00:00.000Z");
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signing = configureGrantSigning({
    OFFLINE_GRANT_ORIGIN: "https://api.example.invalid",
    OFFLINE_GRANT_KID: "current-key",
    OFFLINE_GRANT_PRIVATE_KEY_PEM: keys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    OFFLINE_GRANT_KEYSET_JSON: JSON.stringify({
      protocol: "offline-grants-v1",
      origin: "https://api.example.invalid",
      revision: "keyset-activation-1",
      keys: [{ kid: "current-key", jwk: keys.publicKey.export({ format: "jwk" }) }],
      retiredKids: [],
    }),
  });
  const principal: PlatformPrincipal = {
    userId: `activation-admin-${randomUUID()}`,
    role: "platform_admin",
    capabilities: platformCapabilitiesForRole.platform_admin,
    twoFactorReady: true,
  };
  const confirmer: PlatformPrincipal = {
    userId: `activation-confirmer-${randomUUID()}`,
    role: "platform_admin",
    capabilities: platformCapabilitiesForRole.platform_admin,
    twoFactorReady: true,
  };
  const audit = new PlatformAuditService();
  const readiness = new PlatformGrantReadinessService(db, signing, audit, () => now.getTime());
  const activation = new PlatformGrantActivationService(db, signing, audit, () => now.getTime());
  const rollback = new PlatformGrantRollbackService(db, audit, () => now.getTime());
  const policyId = randomUUID();
  const deviceId = randomUUID();
  let tenantId = "";
  let preparedId = "";
  let preparedDigest = "";
  let expiredPreparedId = "";
  let created = false;
  let confirmedActivationId = "";

  beforeAll(async () => {
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await migrate(drizzle(connection.pool), {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    await db.insert(schema.platformUsers).values({
      id: principal.userId,
      name: "Activation admin",
      email: `${randomUUID()}@example.invalid`,
      role: principal.role,
      twoFactorEnabled: true,
    });
    await db.insert(schema.platformUsers).values({
      id: confirmer.userId,
      name: "Activation confirmer",
      email: `${randomUUID()}@example.invalid`,
      role: confirmer.role,
      twoFactorEnabled: true,
    });
    const payload = {
      offlineGrant: {
        version: 1,
        maxOfflineMs: 8 * 60 * 60 * 1_000,
        maxCompletionMs: 24 * 60 * 60 * 1_000,
        taskBounds: {},
      },
    };
    const payloadHash = entitlementDigest(payload);
    await db.insert(schema.entitlementLifecyclePolicies).values({
      id: policyId,
      policyKey: `activation-${policyId}`,
      version: 1,
      status: "approved",
      payload,
      payloadHash,
      decisionReference: "P1D.2-test",
      approvedAt: now,
      approvedByPlatformUserId: principal.userId,
      createdByPlatformUserId: principal.userId,
    });
    const itemId = randomUUID();
    const versionId = randomUUID();
    await db.insert(schema.catalogItems).values({
      id: itemId,
      code: `activation-${itemId}`,
      nameRu: "Активация",
      nameEn: "Activation",
      kind: "plan",
    });
    await db.insert(schema.catalogItemVersions).values({
      id: versionId,
      catalogItemId: itemId,
      kind: "plan",
      version: 1,
      status: "published",
      lifecyclePolicyId: policyId,
      nameRu: "Активация",
      nameEn: "Activation",
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "1.00",
      vatIncluded: true,
      publishedAt: now,
      publishedByPlatformUserId: principal.userId,
    });
    tenantId = `activation-tenant-${randomUUID()}`;
    const apiKeyId = randomUUID();
    const configurationId = randomUUID();
    const grantId = randomUUID();
    await db.insert(schema.organization).values({
      id: tenantId,
      name: "Activation tenant",
      slug: tenantId,
      createdAt: now,
    });
    await db.insert(schema.entitlementRevisions).values({ tenantId, revision: 7n });
    await db.insert(schema.tenantSubscriptions).values({
      tenantId,
      planVersionId: versionId,
      status: "active",
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
      source: "manual",
    });
    await db.insert(schema.apikey).values({
      id: apiKeyId,
      referenceId: tenantId,
      configId: "station",
      key: `test-${apiKeyId}`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.stationDevices).values({
      id: deviceId,
      tenantId,
      name: "Activation station",
      kind: "station",
      apiKeyId,
      pairedAt: new Date(now.getTime() - 120_000),
      lastSeenAt: now,
    });
    await db.insert(schema.workingDeviceAssignments).values({
      tenantId,
      deviceId,
      state: "assigned",
      provenance: "runtime",
      observedAt: new Date(now.getTime() - 120_000),
      updatedAt: now,
    });
    await db.insert(schema.deviceGrantConfigurations).values({
      id: configurationId,
      tenantId,
      ownerKind: "station",
      stationDeviceId: deviceId,
      credentialEpoch: 1,
      mode: "observe",
      policyId,
      policyRevision: `${policyId}:1:${payloadHash}`,
      decisionReference: "P1D.2-test",
      issuedAt: new Date(now.getTime() - 90_000),
    });
    await db.insert(schema.deviceGrantIssuances).values({
      grantId,
      tenantId,
      ownerKind: "station",
      stationDeviceId: deviceId,
      credentialEpoch: 1,
      kindOfGrant: "device",
      policyId,
      policyRevision: `${policyId}:1:${payloadHash}`,
      entitlementRevision: "7",
      requestIdentity: randomUUID(),
      headerKid: "current-key",
      compactJws: "header.payload.signature",
      payloadDigest: "b".repeat(64),
      issuedAt: new Date(now.getTime() - 80_000),
      startNotAfter: new Date(now.getTime() - 1),
    });
    await db.insert(schema.deviceGrantClientReadinessReports).values({
      tenantId,
      ownerKind: "station",
      stationDeviceId: deviceId,
      credentialEpoch: 1,
      requestId: randomUUID(),
      payloadDigest: "c".repeat(64),
      clientBuild: "station:test",
      storageRevision: 1,
      reportedMode: "observe",
      reportedPolicyRevision: `${policyId}:1:${payloadHash}`,
      reportedKeysetRevision: "keyset-activation-1",
      reportedGrantId: grantId,
      configurationId,
      verifiedGrantId: grantId,
      matchesCurrentConfiguration: true,
      verifiedGrantMatched: true,
      receivedAt: new Date(now.getTime() - 1_000),
    });
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    if (created) await admin.pool.query(`DROP DATABASE "${databaseName}"`);
    await admin.pool.end();
  });

  it("prepares an exact immutable cohort without changing customer or runtime state", async () => {
    const preview = await readiness.preview(principal, {
      requestId: randomUUID(),
      policyId,
      mode: "strict",
      deviceIds: [deviceId],
    });
    const request = {
      protocol: "offline-grants-activation-v1" as const,
      previewRequestId: preview.requestId,
      previewDigest: preview.previewDigest,
      policyId,
      deviceIds: [deviceId],
      decisionReference: "CAB-2026-0914",
      requestId: randomUUID(),
    };
    const before = await Promise.all(
      ["entitlement_lifecycle_policies", "tenant_subscriptions", "device_grant_configurations"].map(
        count,
      ),
    );
    const result = await activation.prepare(principal, request);
    preparedId = result.id;
    preparedDigest = result.preparationDigest;

    expect(result).toMatchObject({
      state: "prepared",
      requestId: request.requestId,
      previewRequestId: preview.requestId,
      previewDigest: preview.previewDigest,
      decisionReference: "CAB-2026-0914",
      preparedBy: { userId: principal.userId, role: "platform_admin" },
      expiresAt: "2026-09-14T12:30:00.000Z",
      members: [{ deviceId, assignmentId: expect.any(String), entitlementRevision: "8" }],
    });
    expect(await activation.prepare(principal, request)).toEqual(result);
    expect(
      await Promise.all(
        [
          "entitlement_lifecycle_policies",
          "tenant_subscriptions",
          "device_grant_configurations",
        ].map(count),
      ),
    ).toEqual(before);
    await expect(
      activation.prepare(principal, { ...request, decisionReference: "changed" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("releases an expired preparation before preparing the same device again", async () => {
    const firstPreparationId = preparedId;
    expiredPreparedId = firstPreparationId;
    now.setTime(new Date("2026-09-14T12:30:00.001Z").getTime());
    const preview = await readiness.preview(principal, {
      requestId: randomUUID(),
      policyId,
      mode: "strict",
      deviceIds: [deviceId],
    });
    const replacement = await activation.prepare(principal, {
      protocol: "offline-grants-activation-v1",
      previewRequestId: preview.requestId,
      previewDigest: preview.previewDigest,
      policyId,
      deviceIds: [deviceId],
      decisionReference: "CAB-2026-0914-expired-retry",
      requestId: randomUUID(),
    });

    expect(replacement).toMatchObject({
      state: "prepared",
      members: [{ deviceId }],
      expiresAt: "2026-09-14T13:00:00.001Z",
    });
    expect(replacement.id).not.toBe(firstPreparationId);
    preparedId = replacement.id;
    preparedDigest = replacement.preparationDigest;
  });

  it("cancels a preparation idempotently and releases its reservation", async () => {
    const request = {
      protocol: "offline-grants-activation-v1" as const,
      reason: "Pilot deferred",
      requestId: randomUUID(),
    };
    const cancelled = await activation.cancel(expiredPreparedId, principal, request);
    expect(cancelled).toMatchObject({
      id: expiredPreparedId,
      state: "cancelled",
      cancellationReason: "Pilot deferred",
      cancelledBy: { userId: principal.userId },
    });
    expect(await activation.cancel(expiredPreparedId, principal, request)).toEqual(cancelled);
    expect(await activation.detail(expiredPreparedId)).toEqual(cancelled);
  });

  it("requires a second operator and confirms the exact overlay without commercial mutation", async () => {
    const confirmRequest = {
      protocol: "offline-grants-activation-v1" as const,
      preparationDigest: preparedDigest,
      requestId: randomUUID(),
    };
    await expect(activation.confirm(preparedId, principal, confirmRequest)).rejects.toMatchObject({
      status: 403,
    });

    const beforePlans = await db
      .select({ id: schema.tenantSubscriptions.id, plan: schema.tenantSubscriptions.planVersionId })
      .from(schema.tenantSubscriptions);
    const receipt = await activation.confirm(preparedId, confirmer, confirmRequest);
    if (receipt.status !== "confirmed") throw new Error("Expected confirmed activation");
    confirmedActivationId = receipt.activationIds[0]!;
    expect(receipt).toMatchObject({
      status: "confirmed",
      requestId: confirmRequest.requestId,
      preparation: {
        id: preparedId,
        state: "confirmed",
        confirmedBy: { userId: confirmer.userId, role: "platform_admin" },
        rolloutPolicy: {
          status: "approved",
          createdByPlatformUserId: principal.userId,
          approvedByPlatformUserId: confirmer.userId,
          offlineGrant: {
            rollout: {
              mode: "strict",
              deviceIds: [deviceId],
              decisionReference: "CAB-2026-0914-expired-retry",
            },
          },
        },
      },
      activationIds: [expect.any(String)],
    });
    expect(await activation.confirm(preparedId, confirmer, confirmRequest)).toEqual(receipt);
    await expect(
      activation.confirm(preparedId, confirmer, {
        ...confirmRequest,
        preparationDigest: "f".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await db
        .select({
          id: schema.tenantSubscriptions.id,
          plan: schema.tenantSubscriptions.planVersionId,
        })
        .from(schema.tenantSubscriptions),
    ).toEqual(beforePlans);
    expect(await count("offline_grant_device_activations")).toBe(1);
    const effective = await db.transaction((tx) =>
      loadEffectiveGrantPolicy(
        tx,
        { tenantId, deviceId, kind: "station", credentialEpoch: 1 },
        receipt.preparation.members[0]!.subscriptionId,
      ),
    );
    expect(effective).toMatchObject({
      activationId: receipt.activationIds[0],
      basePolicyId: policyId,
      policy: { id: receipt.preparation.rolloutPolicy!.id, rollout: { mode: "strict" } },
    });
    const configuration = await db.transaction((tx) =>
      resolveGrantRollout(
        tx,
        { tenantId, deviceId, kind: "station", credentialEpoch: 1 },
        effective.policy,
        true,
        effective.activationId,
      ),
    );
    expect(configuration).toMatchObject({
      mode: "strict",
      activationId: receipt.activationIds[0],
      policyId: receipt.preparation.rolloutPolicy!.id,
    });
    expect(await activation.detail(preparedId)).toEqual(receipt.preparation);
    expect(await activation.list({ state: "confirmed", limit: 1 })).toMatchObject({
      items: [{ id: preparedId, state: "confirmed" }],
    });
  });

  it("rejects a missing preview and overlapping prepared ownership", async () => {
    await expect(
      activation.prepare(principal, {
        protocol: "offline-grants-activation-v1",
        previewRequestId: randomUUID(),
        previewDigest: "a".repeat(64),
        policyId,
        deviceIds: [deviceId],
        decisionReference: "missing-preview",
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 400 });

    const preview = await readiness.preview(principal, {
      requestId: randomUUID(),
      policyId,
      mode: "strict",
      deviceIds: [deviceId],
    });
    await expect(
      activation.prepare(principal, {
        protocol: "offline-grants-activation-v1",
        previewRequestId: preview.requestId,
        previewDigest: preview.previewDigest,
        policyId,
        deviceIds: [deviceId],
        decisionReference: "overlap",
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("selectively rolls a confirmed strict activation back to observe with a second operator", async () => {
    const candidates = await rollback.candidates({ limit: 10 });
    expect(candidates.items).toEqual([
      expect.objectContaining({
        activationId: confirmedActivationId,
        deviceId,
        deviceKind: "station",
      }),
    ]);
    const beforePlans = await db
      .select({ id: schema.tenantSubscriptions.id, plan: schema.tenantSubscriptions.planVersionId })
      .from(schema.tenantSubscriptions);
    const prepared = await rollback.prepare(principal, {
      protocol: "offline-grants-rollback-v1",
      activationIds: [confirmedActivationId],
      decisionReference: "CAB-2026-0914-RB",
      requestId: randomUUID(),
    });
    expect(prepared).toMatchObject({
      state: "prepared",
      members: [{ activationId: confirmedActivationId, deviceId }],
    });
    const confirmRequest = {
      protocol: "offline-grants-rollback-v1" as const,
      rollbackDigest: prepared.rollbackDigest,
      requestId: randomUUID(),
    };
    await expect(rollback.confirm(prepared.id, principal, confirmRequest)).rejects.toMatchObject({
      status: 403,
    });
    const receipt = await rollback.confirm(prepared.id, confirmer, confirmRequest);
    expect(receipt).toMatchObject({
      status: "confirmed",
      preparation: {
        state: "confirmed",
        observePolicy: { offlineGrant: { rollout: { mode: "observe", deviceIds: [deviceId] } } },
      },
    });
    expect(
      await db
        .select({
          id: schema.tenantSubscriptions.id,
          plan: schema.tenantSubscriptions.planVersionId,
        })
        .from(schema.tenantSubscriptions),
    ).toEqual(beforePlans);
    const subscriptionId = prepared.members[0]!.subscriptionId;
    const effective = await db.transaction((tx) =>
      loadEffectiveGrantPolicy(
        tx,
        { tenantId, deviceId, kind: "station", credentialEpoch: 1 },
        subscriptionId,
      ),
    );
    expect(effective).toMatchObject({
      activationId: null,
      basePolicyId: policyId,
      policy: { id: receipt.preparation.observePolicy!.id, rollout: { mode: "observe" } },
    });
    const configuration = await db.transaction((tx) =>
      resolveGrantRollout(
        tx,
        { tenantId, deviceId, kind: "station", credentialEpoch: 1 },
        effective.policy,
        true,
        effective.activationId,
      ),
    );
    expect(configuration).toMatchObject({
      mode: "observe",
      activationId: null,
      policyId: receipt.preparation.observePolicy!.id,
      decisionReference: "CAB-2026-0914-RB",
    });
    const reactivationId = randomUUID();
    await db.insert(schema.offlineGrantDeviceActivations).values({
      id: reactivationId,
      preparationId: preparedId,
      tenantId,
      subscriptionId,
      ownerKind: "station",
      stationDeviceId: deviceId,
      credentialEpoch: 1,
      basePolicyId: policyId,
      rolloutPolicyId: receipt.preparation.members[0]!.strictPolicyId,
      activatedByPlatformUserId: confirmer.userId,
      activatedAt: new Date(now.getTime() + 1),
    });
    const reactivated = await db.transaction((tx) =>
      loadEffectiveGrantPolicy(
        tx,
        { tenantId, deviceId, kind: "station", credentialEpoch: 1 },
        subscriptionId,
      ),
    );
    expect(reactivated).toMatchObject({
      activationId: reactivationId,
      policy: { rollout: { mode: "strict" } },
    });
  });

  async function count(table: string): Promise<number> {
    const result = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from ${sql.identifier(table)}`,
    );
    return result.rows[0]?.count ?? 0;
  }
});
