import { generateKeyPairSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { createDb, schema } from "@markiro/db";
import { platformCapabilitiesForRole, type PlatformPrincipal } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyGrantReadiness,
  type GrantReadinessFacts,
  type GrantReadinessTargetPolicy,
} from "../src/modules/device-grants/grant-readiness-facts";
import { PlatformGrantReadinessController } from "../src/modules/device-grants/platform-grant-readiness.controller";
import { PlatformGrantReadinessService } from "../src/modules/device-grants/platform-grant-readiness.service";
import { configureGrantSigning } from "../src/modules/device-grants/grant-keyset";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";
import { entitlementDigest } from "../src/subscriptions/entitlement-snapshot-reader";

const asOf = new Date("2026-09-14T12:00:00.000Z");
const policyId = randomUUID();
const policyRevision = `${policyId}:1:${"a".repeat(64)}`;
const grantId = randomUUID();
const configurationId = randomUUID();
const reportId = randomUUID();

const targetPolicy: GrantReadinessTargetPolicy = {
  id: policyId,
  revision: policyRevision,
  approved: true,
};

function eligibleFacts(): GrantReadinessFacts {
  return {
    tenantId: "tenant-ready",
    tenantName: "Ready tenant",
    deviceId: randomUUID(),
    deviceKind: "station",
    deviceName: "Line station",
    credentialEpoch: 3,
    credentialActive: true,
    deviceRevoked: false,
    revokedAt: null,
    workingAssignmentPresent: true,
    assignmentId: randomUUID(),
    lastSeenAt: new Date(asOf.getTime() - 1_000),
    subscriptionActive: true,
    currentPolicy: targetPolicy,
    signingConfigured: true,
    currentKeysetRevision: "keyset-7",
    retiredKids: new Set(["retired-key"]),
    configuration: {
      id: configurationId,
      credentialEpoch: 3,
      mode: "observe",
      policyRevision,
    },
    clientReport: {
      id: reportId,
      receivedAt: new Date(asOf.getTime() - 1_000),
      clientBuild: "station:1.4.2",
      storageRevision: 14,
      credentialEpoch: 3,
      mode: "observe",
      policyRevision,
      keysetRevision: "keyset-7",
      verifiedGrantId: grantId,
      configurationId,
      matchesCurrentConfiguration: true,
      verifiedGrantMatched: true,
    },
    verifiedGrant: {
      id: grantId,
      credentialEpoch: 3,
      policyId,
      policyRevision,
      issuedAt: new Date(asOf.getTime() - 60_000),
      startNotAfter: new Date(asOf.getTime() - 1),
      kid: "current-key",
    },
    evidence: { acceptedCount: 0, lastAcceptedAt: null },
  };
}

describe("offline grant rollout readiness classification", () => {
  it("accepts an exact 24-hour-old report and does not require an unexpired grant", () => {
    const facts = eligibleFacts();
    facts.clientReport!.receivedAt = new Date(asOf.getTime() - 24 * 60 * 60 * 1_000);
    facts.lastSeenAt = facts.clientReport!.receivedAt;

    expect(classifyGrantReadiness(facts, targetPolicy, asOf)).toEqual({
      status: "eligible",
      reasons: [],
    });
  });

  it("blocks a report one millisecond older than 24 hours", () => {
    const facts = eligibleFacts();
    facts.clientReport!.receivedAt = new Date(asOf.getTime() - 24 * 60 * 60 * 1_000 - 1);
    facts.lastSeenAt = facts.clientReport!.receivedAt;

    expect(classifyGrantReadiness(facts, targetPolicy, asOf)).toEqual({
      status: "blocked",
      reasons: ["client_report_stale"],
    });
  });

  it("returns every blocking reason once in stable contract order", () => {
    const facts = eligibleFacts();
    facts.credentialActive = false;
    facts.deviceRevoked = true;
    facts.revokedAt = new Date(asOf.getTime() - 5_000);
    facts.workingAssignmentPresent = false;
    facts.assignmentId = null;
    facts.subscriptionActive = false;
    facts.currentPolicy = { ...targetPolicy, id: randomUUID(), approved: false };
    facts.signingConfigured = false;
    facts.currentKeysetRevision = null;
    facts.configuration = null;
    facts.clientReport = null;
    facts.verifiedGrant = null;

    expect(classifyGrantReadiness(facts, targetPolicy, asOf)).toEqual({
      status: "blocked",
      reasons: [
        "credential_inactive",
        "device_revoked",
        "working_assignment_missing",
        "subscription_missing",
        "target_policy_not_current",
        "target_policy_not_approved",
        "signing_not_configured",
        "configuration_missing",
        "client_report_missing",
        "verified_grant_missing",
      ],
    });
  });

  it("re-evaluates epoch, configuration, keyset, grant ownership and retired keys", () => {
    const facts = eligibleFacts();
    facts.clientReport = {
      ...facts.clientReport!,
      credentialEpoch: 2,
      mode: "strict",
      policyRevision: "old-policy",
      keysetRevision: "old-keyset",
      verifiedGrantMatched: false,
    };
    facts.verifiedGrant = {
      ...facts.verifiedGrant!,
      credentialEpoch: 2,
      policyId: randomUUID(),
      policyRevision: "old-policy",
      kid: "retired-key",
    };

    expect(classifyGrantReadiness(facts, targetPolicy, asOf)).toEqual({
      status: "blocked",
      reasons: [
        "credential_epoch_mismatch",
        "configuration_mismatch",
        "keyset_mismatch",
        "verified_grant_mismatch",
        "grant_key_retired",
      ],
    });
  });

  it("requires native authentication at or after the persisted report", () => {
    const facts = eligibleFacts();
    facts.lastSeenAt = new Date(facts.clientReport!.receivedAt.getTime() - 1);

    expect(classifyGrantReadiness(facts, targetPolicy, asOf)).toEqual({
      status: "blocked",
      reasons: ["credential_inactive"],
    });
  });
});

describe("offline grant readiness platform route policy", () => {
  it("requires both read capabilities for list and the catalog write capability for preview", () => {
    expect(
      Reflect.getMetadata(PLATFORM_ACCESS_POLICY, PlatformGrantReadinessController.prototype.list),
    ).toEqual({ mode: "capabilities", capabilities: ["tenants.read", "catalog.read"] });
    expect(
      Reflect.getMetadata(
        PLATFORM_ACCESS_POLICY,
        PlatformGrantReadinessController.prototype.preview,
      ),
    ).toEqual({
      mode: "capabilities",
      capabilities: ["tenants.read", "catalog.read", "catalog.write"],
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("offline grant readiness platform snapshots", () => {
  const databaseName = `platform_grant_readiness_${randomUUID().replaceAll("-", "_")}`;
  const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createDb(adminUrl.toString());
  const connection = createDb(databaseUrl.toString());
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
      revision: "keyset-7",
      keys: [{ kid: "current-key", jwk: keys.publicKey.export({ format: "jwk" }) }],
      retiredKids: ["retired-key"],
    }),
  });
  const principal: PlatformPrincipal = {
    userId: `readiness-admin-${randomUUID()}`,
    role: "platform_admin",
    capabilities: platformCapabilitiesForRole.platform_admin,
    twoFactorReady: true,
  };
  const service = new PlatformGrantReadinessService(db, signing, new PlatformAuditService(), () =>
    now.getTime(),
  );
  const policyId = randomUUID();
  let policyRevision = "";
  const deviceIds: string[] = [];
  let created = false;

  beforeAll(async () => {
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await migrate(drizzle(connection.pool), {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    await db.insert(schema.platformUsers).values({
      id: principal.userId,
      name: "Readiness admin",
      email: `${randomUUID()}@example.invalid`,
      role: principal.role,
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
    policyRevision = `${policyId}:1:${payloadHash}`;
    await db.insert(schema.entitlementLifecyclePolicies).values({
      id: policyId,
      policyKey: `readiness-${policyId}`,
      version: 1,
      status: "approved",
      payload,
      payloadHash,
      decisionReference: "P1D-test",
      approvedAt: now,
      approvedByPlatformUserId: principal.userId,
      createdByPlatformUserId: principal.userId,
    });
    const catalogItemId = randomUUID();
    const planVersionId = randomUUID();
    await db.insert(schema.catalogItems).values({
      id: catalogItemId,
      code: `readiness-${catalogItemId}`,
      nameRu: "Готовность",
      nameEn: "Readiness",
      kind: "plan",
    });
    await db.insert(schema.catalogItemVersions).values({
      id: planVersionId,
      catalogItemId,
      kind: "plan",
      version: 1,
      status: "published",
      lifecyclePolicyId: policyId,
      nameRu: "Готовность",
      nameEn: "Readiness",
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "1.00",
      vatIncluded: true,
      publishedAt: now,
      publishedByPlatformUserId: principal.userId,
    });
    for (const suffix of ["b", "a"]) {
      const tenantId = `readiness-${suffix}-${randomUUID()}`;
      const deviceId = randomUUID();
      const apiKeyId = randomUUID();
      const configurationId = randomUUID();
      const grantId = randomUUID();
      deviceIds.push(deviceId);
      await db.insert(schema.organization).values({
        id: tenantId,
        name: `Tenant ${suffix}`,
        slug: tenantId,
        createdAt: now,
      });
      await db.insert(schema.tenantSubscriptions).values({
        tenantId,
        planVersionId,
        status: "active",
        startsAt: new Date(now.getTime() - 60_000),
        endsAt: new Date(now.getTime() + 60_000),
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
        name: `Station ${suffix}`,
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
        policyRevision,
        decisionReference: "P1D-test",
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
        policyRevision,
        entitlementRevision: "entitlement-1",
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
        reportedPolicyRevision: policyRevision,
        reportedKeysetRevision: "keyset-7",
        reportedGrantId: grantId,
        configurationId,
        verifiedGrantId: grantId,
        matchesCurrentConfiguration: true,
        verifiedGrantMatched: true,
        receivedAt: new Date(now.getTime() - 1_000),
      });
    }
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    if (created) await admin.pool.query(`DROP DATABASE "${databaseName}"`);
    await admin.pool.end();
  });

  it("lists deterministic eligible rows with a cursor bound to filters and no audit write", async () => {
    const beforeAudit = await count("platform_audit_events");
    const first = await service.list(principal, { policyId, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.eligibility).toEqual({ status: "eligible", reasons: [] });
    expect(first.aggregates).toEqual({ total: 2, eligible: 2, blocked: 0, reasons: {} });
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(principal, {
      policyId,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.asOf).toBe(first.asOf);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.tenantId.localeCompare(first.items[0]!.tenantId)).toBeGreaterThan(0);
    await expect(
      service.list(principal, { policyId, readiness: "blocked", cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await count("platform_audit_events")).toBe(beforeAudit);
  });

  it("previews a multi-tenant cohort in a read-only snapshot and audits only the result", async () => {
    const protectedTables = [
      "entitlement_lifecycle_policies",
      "tenant_subscriptions",
      "working_device_assignments",
      "device_grant_configurations",
      "device_grant_client_readiness_reports",
    ] as const;
    const before = await Promise.all(protectedTables.map(count));
    const result = await service.preview(principal, {
      requestId: randomUUID(),
      policyId,
      mode: "strict",
      deviceIds: [...deviceIds].reverse(),
    });
    expect(result.items.map((item) => item.tenantId)).toEqual(
      [...result.items.map((item) => item.tenantId)].sort(),
    );
    expect(result).toMatchObject({
      policyId,
      policyRevision,
      mode: "strict",
      aggregates: { total: 2, eligible: 2, blocked: 0, reasons: {} },
    });
    expect(result.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(await Promise.all(protectedTables.map(count))).toEqual(before);
    const [audit] = await db
      .select()
      .from(schema.platformAuditEvents)
      .orderBy(sql`${schema.platformAuditEvents.createdAt} desc`)
      .limit(1);
    expect(audit).toMatchObject({
      actorPlatformUserId: principal.userId,
      action: "offline_grant.readiness.previewed",
      outcome: "success",
      targetId: policyId,
    });
  });

  async function count(table: string): Promise<number> {
    const result = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from ${sql.identifier(table)}`,
    );
    return result.rows[0]?.count ?? 0;
  }
});
