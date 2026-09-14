import { generateKeyPairSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "@markiro/db";
import type { GrantClientReadinessRequest } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GrantClientReadinessService } from "../src/modules/device-grants/grant-client-readiness.service";
import { configureGrantSigning } from "../src/modules/device-grants/grant-keyset";
import { hashDeviceToken } from "../src/pickup/device-token";

describe.skipIf(!process.env.DATABASE_URL)("offline grant client readiness", () => {
  const databaseName = `grant_client_readiness_${randomUUID().replaceAll("-", "_")}`;
  const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = createDb(adminUrl.toString());
  const connection = createDb(databaseUrl.toString());
  const db = connection.db;
  const now = Date.now();
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
  const service = new GrantClientReadinessService(db, signing, () => now);
  let created = false;

  beforeAll(async () => {
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await migrate(drizzle(connection.pool), {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    if (created) await admin.pool.query(`DROP DATABASE "${databaseName}"`);
    await admin.pool.end();
  });

  async function stationFixture(
    headerKid = "current-key",
    kind: "station" | "handheld" = "station",
  ) {
    const tenantId = `readiness-${randomUUID()}`;
    const deviceId = randomUUID();
    const apiKeyId = randomUUID();
    const policyId = randomUUID();
    const configurationId = randomUUID();
    const grantId = randomUUID();
    const approverId = `approver-${randomUUID()}`;
    const policyRevision = `${policyId}:1:${"a".repeat(64)}`;
    await db.insert(schema.organization).values({
      id: tenantId,
      name: tenantId,
      slug: tenantId,
      createdAt: new Date(now),
    });
    await db.insert(schema.apikey).values({
      id: apiKeyId,
      referenceId: tenantId,
      configId: "station",
      key: `test-${apiKeyId}`,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await db.insert(schema.stationDevices).values({
      id: deviceId,
      tenantId,
      name: `Readiness ${kind}`,
      kind,
      apiKeyId,
      pairedAt: new Date(now - 1_000),
      lastSeenAt: new Date(now),
    });
    await db.insert(schema.platformUsers).values({
      id: approverId,
      name: "Approver",
      email: `${randomUUID()}@example.invalid`,
      role: "platform_admin",
    });
    await db.insert(schema.entitlementLifecyclePolicies).values({
      id: policyId,
      policyKey: `readiness-${policyId}`,
      version: 1,
      status: "approved",
      payload: {},
      payloadHash: "a".repeat(64),
      decisionReference: "fixture",
      approvedAt: new Date(now),
      approvedByPlatformUserId: approverId,
      createdByPlatformUserId: approverId,
    });
    await db.insert(schema.deviceGrantConfigurations).values({
      id: configurationId,
      tenantId,
      ownerKind: kind,
      stationDeviceId: deviceId,
      credentialEpoch: 1,
      mode: "observe",
      policyId,
      policyRevision,
      decisionReference: "fixture",
      issuedAt: new Date(now - 2_000),
    });
    await db.insert(schema.deviceGrantIssuances).values({
      grantId,
      tenantId,
      ownerKind: kind,
      stationDeviceId: deviceId,
      credentialEpoch: 1,
      kindOfGrant: "device",
      policyId,
      policyRevision,
      entitlementRevision: "entitlement-1",
      requestIdentity: randomUUID(),
      headerKid,
      compactJws: "header.payload.signature",
      payloadDigest: "b".repeat(64),
      issuedAt: new Date(now - 1_000),
      startNotAfter: new Date(now + 60_000),
    });
    const identity = { tenantId, deviceId, kind, apiKeyId };
    const input: GrantClientReadinessRequest = {
      protocol: "offline-grants-v1",
      capability: "offline-grants-readiness-v1",
      requestId: randomUUID(),
      clientBuild: "station:test",
      storageRevision: 14,
      installed: {
        mode: "observe",
        policyRevision,
        keysetRevision: "keyset-7",
        verifiedGrantId: grantId,
      },
    };
    return { identity, input, policyId, configurationId, grantId, apiKeyId };
  }

  it("retains server-matched station facts and an exact device audit event", async () => {
    const fixture = await stationFixture();
    const result = await service.report(fixture.identity, fixture.input);

    expect(result).toEqual({
      protocol: "offline-grants-v1",
      requestId: fixture.input.requestId,
      receivedAt: new Date(now).toISOString(),
      accepted: true,
      matchesCurrentConfiguration: true,
      verifiedGrantMatched: true,
    });
    const [stored] = await db
      .select()
      .from(schema.deviceGrantClientReadinessReports)
      .where(
        and(
          eq(schema.deviceGrantClientReadinessReports.tenantId, fixture.identity.tenantId),
          eq(schema.deviceGrantClientReadinessReports.requestId, fixture.input.requestId),
        ),
      );
    expect(stored).toMatchObject({
      ownerKind: "station",
      stationDeviceId: fixture.identity.deviceId,
      credentialEpoch: 1,
      configurationId: fixture.configurationId,
      verifiedGrantId: fixture.grantId,
      matchesCurrentConfiguration: true,
      verifiedGrantMatched: true,
    });
    const [audit] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, fixture.identity.tenantId),
          eq(schema.tenantAuditEvents.action, "offline_grant.readiness.reported"),
        ),
      );
    expect(audit).toMatchObject({
      actorUserId: null,
      outcome: "success",
      targetType: "offline_grant_readiness_report",
      targetId: stored?.id,
      requestId: fixture.input.requestId,
      after: {
        actorDomain: "station_device",
        actorId: fixture.identity.deviceId,
        deviceKind: "station",
        credentialEpoch: 1,
        configurationId: fixture.configurationId,
        verifiedGrantId: fixture.grantId,
        matchesCurrentConfiguration: true,
        verifiedGrantMatched: true,
      },
    });
  });

  it("replays the same payload and rejects changed payload under the same identity", async () => {
    const fixture = await stationFixture();
    const first = await service.report(fixture.identity, fixture.input);
    expect(await service.report(fixture.identity, fixture.input)).toEqual(first);
    await expect(
      service.report(fixture.identity, { ...fixture.input, clientBuild: "station:changed" }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "GRANT_READINESS_REQUEST_CONFLICT" },
    });
    expect(
      await db
        .select()
        .from(schema.deviceGrantClientReadinessReports)
        .where(eq(schema.deviceGrantClientReadinessReports.tenantId, fixture.identity.tenantId)),
    ).toHaveLength(1);
  });

  it("surfaces configuration and grant mismatches without accepting client authority", async () => {
    const fixture = await stationFixture("retired-key");
    const retired = await service.report(fixture.identity, fixture.input);
    expect(retired).toMatchObject({
      accepted: true,
      matchesCurrentConfiguration: true,
      verifiedGrantMatched: false,
    });
    const mismatched = await service.report(fixture.identity, {
      ...fixture.input,
      requestId: randomUUID(),
      installed: {
        ...fixture.input.installed,
        policyRevision: "other-policy",
        keysetRevision: "old-keyset",
      },
    });
    expect(mismatched).toMatchObject({
      accepted: true,
      matchesCurrentConfiguration: false,
      verifiedGrantMatched: false,
    });
    const missing = await service.report(fixture.identity, {
      ...fixture.input,
      requestId: randomUUID(),
      installed: { ...fixture.input.installed, verifiedGrantId: randomUUID() },
    });
    expect(missing).toMatchObject({ accepted: true, verifiedGrantMatched: false });
  });

  it("binds request identity to the current credential epoch", async () => {
    const fixture = await stationFixture();
    await service.report(fixture.identity, fixture.input);
    const nextApiKeyId = randomUUID();
    await db.insert(schema.apikey).values({
      id: nextApiKeyId,
      referenceId: fixture.identity.tenantId,
      configId: "station",
      key: `test-${nextApiKeyId}`,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await db
      .update(schema.stationDevices)
      .set({ apiKeyId: nextApiKeyId })
      .where(eq(schema.stationDevices.id, fixture.identity.deviceId));
    await expect(service.report(fixture.identity, fixture.input)).rejects.toMatchObject({
      status: 401,
    });
    const current = await service.report(
      { ...fixture.identity, apiKeyId: nextApiKeyId },
      { ...fixture.input, installed: { ...fixture.input.installed, verifiedGrantId: null } },
    );
    expect(current).toMatchObject({ accepted: true, verifiedGrantMatched: false });
    const reports = await db
      .select({ credentialEpoch: schema.deviceGrantClientReadinessReports.credentialEpoch })
      .from(schema.deviceGrantClientReadinessReports)
      .where(eq(schema.deviceGrantClientReadinessReports.tenantId, fixture.identity.tenantId));
    expect(reports.map((row) => row.credentialEpoch).sort()).toEqual([1, 2]);
  });

  it("rejects an authenticated identity from another tenant", async () => {
    const fixture = await stationFixture();
    await expect(
      service.report({ ...fixture.identity, tenantId: `foreign-${randomUUID()}` }, fixture.input),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("accepts the same server-derived protocol from handheld and kiosk credentials", async () => {
    const handheld = await stationFixture("current-key", "handheld");
    await expect(service.report(handheld.identity, handheld.input)).resolves.toMatchObject({
      accepted: true,
      matchesCurrentConfiguration: true,
      verifiedGrantMatched: true,
    });

    const base = await stationFixture();
    const kioskId = randomUUID();
    const tokenHash = hashDeviceToken(randomUUID());
    const configurationId = randomUUID();
    const grantId = randomUUID();
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId: base.identity.tenantId,
      name: "Readiness kiosk",
      deviceTokenHash: tokenHash,
      lastSeenAt: new Date(now),
    });
    await db.insert(schema.deviceGrantConfigurations).values({
      id: configurationId,
      tenantId: base.identity.tenantId,
      ownerKind: "kiosk",
      kioskId,
      credentialEpoch: 1,
      mode: "observe",
      policyId: base.policyId,
      policyRevision: base.input.installed.policyRevision,
      decisionReference: "fixture",
      issuedAt: new Date(now - 2_000),
    });
    await db.insert(schema.deviceGrantIssuances).values({
      grantId,
      tenantId: base.identity.tenantId,
      ownerKind: "kiosk",
      kioskId,
      credentialEpoch: 1,
      kindOfGrant: "device",
      policyId: base.policyId,
      policyRevision: base.input.installed.policyRevision ?? "missing",
      entitlementRevision: "entitlement-1",
      requestIdentity: randomUUID(),
      headerKid: "current-key",
      compactJws: "header.payload.signature",
      payloadDigest: "b".repeat(64),
      issuedAt: new Date(now - 1_000),
      startNotAfter: new Date(now + 60_000),
    });
    const kioskInput = {
      ...base.input,
      requestId: randomUUID(),
      clientBuild: "kiosk:test",
      installed: { ...base.input.installed, verifiedGrantId: grantId },
    };
    await expect(
      service.report(
        { tenantId: base.identity.tenantId, deviceId: kioskId, kind: "kiosk", tokenHash },
        kioskInput,
      ),
    ).resolves.toMatchObject({
      accepted: true,
      matchesCurrentConfiguration: true,
      verifiedGrantMatched: true,
    });
  });
});
