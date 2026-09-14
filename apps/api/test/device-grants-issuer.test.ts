import { ShiftsService } from "../src/modules/shifts/shifts.service";
import { OperatorsService } from "../src/modules/operators/operators.service";
import { SsccService } from "../src/modules/sscc/sscc.service";
import { EntitlementAdmissionService } from "../src/subscriptions/entitlement-admission.service";
import { StationDevicesService } from "../src/modules/station-devices/station-devices.service";
import { DeviceReplacementService } from "../src/modules/device-licensing/device-replacement.service";
import { KiosksService } from "../src/modules/kiosks/kiosks.service";
import { hashDeviceToken } from "../src/pickup/device-token";
import { DeviceRetentionService } from "../src/modules/device-licensing/device-retention.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { verifyGrant } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { GrantIssuerService } from "../src/modules/device-grants/grant-issuer.service";
import * as grantSigning from "../src/modules/device-grants/grant-keyset";
import * as grantRollout from "../src/modules/device-grants/grant-rollout";
import { configureGrantSigning } from "../src/modules/device-grants/grant-keyset";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { transitionWorkingAssignment } from "../src/subscriptions/working-device-assignments";
import {
  createOrganization,
  createPublishedPlan,
  createManagedSubscription,
} from "./support/subscription-fixtures";
import { seedGrantPolicy } from "./support/grant-policy-fixture";
const origin = "https://api.example.invalid";
describe.skipIf(!process.env.DATABASE_URL)("authenticated grant issuance", () => {
  const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid"),
    db = connection.db;
  const entitlements = new EntitlementsService(db, "managed_only");
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const config = configureGrantSigning({
    OFFLINE_GRANT_ORIGIN: origin,
    OFFLINE_GRANT_KID: "test",
    OFFLINE_GRANT_PRIVATE_KEY_PEM: keys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    OFFLINE_GRANT_KEYSET_JSON: JSON.stringify({
      protocol: "offline-grants-v1",
      origin,
      revision: "1",
      keys: [{ kid: "test", jwk: keys.publicKey.export({ format: "jwk" }) }],
      retiredKids: [],
    }),
  });
  const issuer = new GrantIssuerService(db, entitlements, config);
  afterAll(() => connection.pool.end());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  async function fixture(configured = true, assigned = true, strict = false) {
    const tenantId = await createOrganization(db),
      deviceId = randomUUID(),
      apiKeyId = randomUUID();
    const policy = configured
      ? await seedGrantPolicy(
          db,
          {
            shift: {
              "shift.scan.v1": { maxEvents: 5, maxUnits: 5 },
              "shift.close.v1": { maxEvents: 1 },
              "shift.pallet.close.v1": { maxEvents: 2, maxContainers: 2 },
            },
          },
          undefined,
          strict
            ? {
                protocol: "offline-grants-v1",
                mode: "strict",
                deviceIds: [deviceId],
                decisionReference: "test-only-rollout",
              }
            : undefined,
        )
      : null;
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 5,
      maxStations: 2,
      maxKiosks: 2,
      maxCabinetUsers: 5,
      ...(policy ? { lifecyclePolicyId: policy.id } : {}),
    });
    await createManagedSubscription(db, { tenantId, planVersionId });
    await db.insert(schema.apikey).values({
      id: apiKeyId,
      referenceId: tenantId,
      configId: "station",
      key: `test-${apiKeyId}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [device] = await db
      .insert(schema.stationDevices)
      .values({ id: deviceId, tenantId, name: "Issuer", apiKeyId })
      .returning();
    if (!device) throw new Error("fixture");
    if (assigned) await db.transaction((tx) => transitionWorkingAssignment(tx, device));
    return { tenantId, deviceId, apiKeyId, kind: "station" as const };
  }
  it("does not activate strict without signing and isolates configuration by native owner", async () => {
    const f = await fixture(true, true, true);
    expect(await new GrantIssuerService(db, entitlements, null).configuration(f)).toMatchObject({
      mode: "observe",
      policyRevision: null,
      keyset: null,
    });
    const other = await fixture();
    await issuer.configuration(f);
    expect(await issuer.configuration(other)).toMatchObject({
      mode: "observe",
      owner: { tenantId: other.tenantId, deviceId: other.deviceId },
    });
    await expect(issuer.configuration({ ...f, tenantId: other.tenantId })).rejects.toMatchObject({
      status: 401,
    });
  });
  it("persists server rollout through missing policy and records an approved recovery rollback", async () => {
    const f = await fixture(true, true, true);
    const initial = await issuer.configuration(f);
    expect(initial).toMatchObject({
      mode: "strict",
      owner: { deviceId: f.deviceId },
      policyRevision: expect.any(String),
    });
    expect(await issuer.issueDevice(f, randomUUID())).toMatchObject({
      status: "issued",
      envelope: { mode: "strict" },
    });
    const missingPlan = await createPublishedPlan(db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
    });
    await db
      .update(schema.tenantSubscriptions)
      .set({
        planVersionId: missingPlan,
        startsAt: new Date(Date.now() - 20000),
        endsAt: new Date(Date.now() - 10000),
      })
      .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
    expect(await issuer.configuration(f)).toMatchObject({
      mode: "strict",
      policyRevision: initial.policyRevision,
    });
    expect((await issuer.issueDevice(f, randomUUID())).status).toBe("denied");
    const rollback = await seedGrantPolicy(db, {}, undefined, {
      protocol: "offline-grants-v1",
      mode: "observe",
      deviceIds: [f.deviceId],
      decisionReference: "test-only-rollback",
    });
    const plan = await createPublishedPlan(db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
      lifecyclePolicyId: rollback.id,
    });
    await db
      .update(schema.tenantSubscriptions)
      .set({ planVersionId: plan })
      .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
    expect(await issuer.configuration(f)).toMatchObject({
      mode: "observe",
      policyRevision: rollback.revision,
    });
    const history = await db
      .select()
      .from(schema.deviceGrantConfigurations)
      .where(eq(schema.deviceGrantConfigurations.tenantId, f.tenantId))
      .orderBy(schema.deviceGrantConfigurations.sequence);
    expect(history.map((row) => row.mode)).toEqual(["strict", "observe"]);
    expect(
      await db
        .select()
        .from(schema.deviceGrantIssuances)
        .where(eq(schema.deviceGrantIssuances.tenantId, f.tenantId)),
    ).toHaveLength(1);
    await expect(
      db
        .update(schema.deviceGrantConfigurations)
        .set({ mode: "observe" })
        .where(eq(schema.deviceGrantConfigurations.id, history[0]?.id ?? "")),
    ).rejects.toThrow();
  });
  it("denies only grant issuance when signing or approved policy is absent", async () => {
    const identity = await fixture(false);
    expect(await issuer.issueDevice(identity, randomUUID())).toEqual({
      status: "denied",
      reason: "policy_not_configured",
    });
    expect(
      await new GrantIssuerService(db, entitlements, null).issueDevice(identity, randomUUID()),
    ).toEqual({ status: "denied", reason: "policy_not_configured" });
  });
  it("denies inconsistent assignments, unresolved capacity and unavailable Handheld features", async () => {
    const identity = await fixture(true, false);
    expect(await issuer.issueDevice(identity, randomUUID())).toEqual({
      status: "denied",
      reason: "facts_unknown",
    });
    const [device] = await db
      .select()
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, identity.deviceId));
    if (!device) throw new Error("Device fixture missing");
    await db.transaction((tx) => transitionWorkingAssignment(tx, device));
    for (let i = 0; i < 2; i++) {
      const [other] = await db
        .insert(schema.stationDevices)
        .values({ tenantId: identity.tenantId, name: "Occupied", pairedAt: new Date() })
        .returning();
      if (!other) throw new Error("Fixture");
      await db.transaction((tx) => transitionWorkingAssignment(tx, other));
    }
    expect(await issuer.issueDevice(identity, randomUUID())).toEqual({
      status: "denied",
      reason: "not_entitled",
    });
    const handheld = await fixture();
    await db
      .update(schema.stationDevices)
      .set({ kind: "handheld" })
      .where(eq(schema.stationDevices.id, handheld.deviceId));
    expect(await issuer.issueDevice({ ...handheld, kind: "handheld" }, randomUUID())).toEqual({
      status: "denied",
      reason: "not_entitled",
    });
  });
  it("uses current time after waiting and never persists authority beyond its horizon", async () => {
    const identity = await fixture();
    let now = Date.now();
    const timed = new GrantIssuerService(db, entitlements, config, () => now);
    const original = entitlements.resolveSnapshotInTransaction.bind(entitlements);
    vi.spyOn(entitlements, "resolveSnapshotInTransaction").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        now += 2 * 60 * 60 * 1000;
        return result;
      },
    );
    expect((await timed.issueDevice(identity, randomUUID())).status).toBe("denied");
    expect(
      await db
        .select()
        .from(schema.deviceGrantIssuances)
        .where(eq(schema.deviceGrantIssuances.tenantId, identity.tenantId)),
    ).toHaveLength(0);
  });
  it("serializes real kiosk enrollment against issuing credentials and rejects the stale replay", async () => {
    const f = await fixture(),
      kioskId = randomUUID();
    await db
      .insert(schema.kiosks)
      .values({ id: kioskId, tenantId: f.tenantId, name: "Racing kiosk" });
    const kioskService = new KiosksService(db, entitlements),
      enrolled = await kioskService.enroll(f.tenantId, kioskId);
    const identity = {
      tenantId: f.tenantId,
      deviceId: kioskId,
      kind: "kiosk" as const,
      tokenHash: hashDeviceToken(enrolled.token),
    };
    let release = () => {},
      acquired = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      locked = new Promise<void>((resolve) => {
        acquired = resolve;
      });
    const original = entitlements.resolveSnapshotInTransaction.bind(entitlements);
    vi.spyOn(entitlements, "resolveSnapshotInTransaction").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        acquired();
        await held;
        return result;
      },
    );
    const requestId = randomUUID(),
      issuing = issuer.issueDevice(identity, requestId);
    await locked;
    const rotating = kioskService.enroll(f.tenantId, kioskId);
    try {
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const result = await connection.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%kiosks%' AND pid<>pg_backend_pid()",
        );
        if (result.rowCount) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally {
      release();
    }
    expect((await issuing).status).toBe("issued");
    await rotating;
    await expect(issuer.issueDevice(identity, requestId)).rejects.toMatchObject({ status: 401 });
    const [stored] = await db
      .select()
      .from(schema.deviceGrantIssuances)
      .where(eq(schema.deviceGrantIssuances.kioskId, kioskId));
    expect(stored?.credentialEpoch).toBe(2);
  });
  it("rejects stale authentication after a revoke wins while issuance waits on quota", async () => {
    const f = await fixture();
    let release = () => {},
      acquired = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      locked = new Promise<void>((resolve) => {
        acquired = resolve;
      });
    const blocking = db.transaction((tx) =>
      entitlements.withQuotaLock(tx, f.tenantId, "stations", async () => {
        acquired();
        await held;
      }),
    );
    await locked;
    const issuing = issuer.issueDevice(f, randomUUID()).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const revoking = new StationDevicesService(db, entitlements).revoke(f.tenantId, f.deviceId);
    try {
      let deleted = false;
      for (let i = 0; i < 100; i++) {
        if (
          !(await db.select().from(schema.apikey).where(eq(schema.apikey.id, f.apiKeyId))).length
        ) {
          deleted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(deleted).toBe(true);
    } finally {
      release();
    }
    await blocking;
    expect(await issuing).toMatchObject({ error: { status: 401 } });
    await revoking;
    expect(
      await db
        .select()
        .from(schema.deviceGrantIssuances)
        .where(eq(schema.deviceGrantIssuances.tenantId, f.tenantId)),
    ).toHaveLength(0);
  });
  it.each(["archive", "unbind"] as const)(
    "rejects kiosk %s and preserves earlier immutable grants",
    async (operation) => {
      const f = await fixture(),
        kioskId = randomUUID();
      await db
        .insert(schema.kiosks)
        .values({ id: kioskId, tenantId: f.tenantId, name: "Lifecycle kiosk" });
      const service = new KiosksService(db, entitlements),
        enrolled = await service.enroll(f.tenantId, kioskId);
      const identity = {
          tenantId: f.tenantId,
          deviceId: kioskId,
          kind: "kiosk" as const,
          tokenHash: hashDeviceToken(enrolled.token),
        },
        requestId = randomUUID();
      expect((await issuer.issueDevice(identity, requestId)).status).toBe("issued");
      if (operation === "archive") await service.archiveKiosk(f.tenantId, kioskId);
      else await service.unbindKiosk(f.tenantId, kioskId);
      await expect(issuer.issueDevice(identity, requestId)).rejects.toMatchObject({ status: 401 });
      expect(
        await db
          .select()
          .from(schema.deviceGrantIssuances)
          .where(eq(schema.deviceGrantIssuances.kioskId, kioskId)),
      ).toHaveLength(1);
    },
  );
  it("rolls back issuance and its audit if the final commit time crosses the finite horizon", async () => {
    const f = await fixture();
    let now = Date.now();
    const originalSign = grantSigning.signOfflineGrant;
    vi.spyOn(grantSigning, "signOfflineGrant").mockImplementationOnce((...args) => {
      const compact = originalSign(...args);
      now += 2 * 60 * 60 * 1000;
      return compact;
    });
    const timed = new GrantIssuerService(db, entitlements, config, () => now);
    await expect(timed.issueDevice(f, randomUUID())).rejects.toMatchObject({ status: 409 });
    expect(
      await db
        .select()
        .from(schema.deviceGrantIssuances)
        .where(eq(schema.deviceGrantIssuances.tenantId, f.tenantId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, f.tenantId)),
    ).toHaveLength(0);
  });
  it("reauthenticates credential expiry after signing and rolls back the grant and audit", async () => {
    const f = await fixture();
    let now = Date.now();
    await db
      .update(schema.apikey)
      .set({ expiresAt: new Date(now + 1000) })
      .where(eq(schema.apikey.id, f.apiKeyId));
    const originalSign = grantSigning.signOfflineGrant;
    vi.spyOn(grantSigning, "signOfflineGrant").mockImplementationOnce((...args) => {
      const compact = originalSign(...args);
      now += 2000;
      return compact;
    });
    await expect(
      new GrantIssuerService(db, entitlements, config, () => now).issueDevice(f, randomUUID()),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      await db
        .select()
        .from(schema.deviceGrantIssuances)
        .where(eq(schema.deviceGrantIssuances.tenantId, f.tenantId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, f.tenantId)),
    ).toHaveLength(0);
  });
  it.each([
    { replay: false, credentialExpires: true },
    { replay: true, credentialExpires: true },
    { replay: false, credentialExpires: false },
    { replay: true, credentialExpires: false },
  ])("rechecks final authority after rollout awaits: %j", async ({ replay, credentialExpires }) => {
    const f = await fixture();
    let now = Date.now();
    const requestId = randomUUID();
    const candidate = new GrantIssuerService(db, entitlements, config, () => now);
    if (replay) expect((await candidate.issueDevice(f, requestId)).status).toBe("issued");
    if (credentialExpires)
      await db
        .update(schema.apikey)
        .set({ expiresAt: new Date(now + 1000) })
        .where(eq(schema.apikey.id, f.apiKeyId));
    const original = grantRollout.resolveGrantRollout;
    vi.spyOn(grantRollout, "resolveGrantRollout").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      now += 2000;
      return result;
    });
    await expect(candidate.issueDevice(f, requestId)).rejects.toMatchObject({
      status: credentialExpires ? 401 : 409,
    });
    expect(
      await db
        .select()
        .from(schema.deviceGrantIssuances)
        .where(eq(schema.deviceGrantIssuances.tenantId, f.tenantId)),
    ).toHaveLength(replay ? 1 : 0);
    expect(
      await db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, f.tenantId)),
    ).toHaveLength(replay ? 1 : 0);
    expect(
      await db
        .select()
        .from(schema.deviceGrantConfigurations)
        .where(eq(schema.deviceGrantConfigurations.tenantId, f.tenantId)),
    ).toHaveLength(replay ? 1 : 0);
  });
  it("honors an effective retained-device selection under the existing licensing lock protocol", async () => {
    const f = await fixture(),
      actorId = randomUUID(),
      secondKey = randomUUID(),
      secondId = randomUUID();
    await db
      .insert(schema.user)
      .values({ id: actorId, name: "Owner", email: `${actorId}@example.invalid` });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: f.tenantId,
      userId: actorId,
      role: "owner",
      createdAt: new Date(),
    });
    await db.insert(schema.apikey).values({
      id: secondKey,
      referenceId: f.tenantId,
      configId: "station",
      key: secondKey,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [second] = await db
      .insert(schema.stationDevices)
      .values({ id: secondId, tenantId: f.tenantId, apiKeyId: secondKey, name: "Second" })
      .returning();
    if (!second) throw new Error("Fixture");
    await db.transaction((tx) => transitionWorkingAssignment(tx, second));
    const [current] = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
    const [version] = await db
      .select()
      .from(schema.catalogItemVersions)
      .where(eq(schema.catalogItemVersions.id, current?.planVersionId ?? ""));
    if (!version?.lifecyclePolicyId) throw new Error("Policy missing");
    const boundary = new Date(Date.now() + 60000);
    await db
      .update(schema.tenantSubscriptions)
      .set({ endsAt: boundary })
      .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
    const futurePlan = await createPublishedPlan(db, {
      maxLines: 5,
      maxStations: 1,
      maxKiosks: 2,
      maxCabinetUsers: 5,
      lifecyclePolicyId: version.lifecyclePolicyId,
    });
    await createManagedSubscription(db, {
      tenantId: f.tenantId,
      planVersionId: futurePlan,
      status: "scheduled",
      startsAt: boundary,
      endsAt: new Date(boundary.getTime() + 60000),
    });
    if (!current) throw new Error("Missing current subscription");
    const service = new DeviceRetentionService(db, entitlements, new PlatformAuditService()),
      actor = { domain: "cabinet" as const, id: actorId };
    const inspected = await service.inspect(f.tenantId, actor);
    if (!inspected.observation) throw new Error("Expected reduction");
    const preview = await service.preview(
      f.tenantId,
      {
        requestId: randomUUID(),
        boundaryKey: inspected.observation.boundary.key,
        selectedDeviceIds: [f.deviceId],
        expectedRevision: 0,
        reason: "Keep first",
      },
      actor,
    );
    // Confirmation holds quota while blocked on revision; issuer must wait behind it.
    const blocker = await connection.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT tenant_id FROM entitlement_revisions WHERE tenant_id=$1 FOR UPDATE",
      [f.tenantId],
    );
    const confirming = service.confirm(
      f.tenantId,
      { requestId: preview.requestId, previewId: preview.id },
      actor,
    );
    const waitForLock = async (pattern: string) => {
      for (let i = 0; i < 200; i++) {
        const found = await connection.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND pid<>pg_backend_pid()",
          [pattern],
        );
        if (found.rowCount) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Expected blocked owner ${pattern}`);
    };
    let concurrentIssue: Promise<unknown> | undefined;
    try {
      await waitForLock("%entitlement_revisions%");
      const atBoundary = new GrantIssuerService(db, entitlements, config, () => boundary.getTime());
      concurrentIssue = atBoundary.issueDevice(
        { tenantId: f.tenantId, deviceId: secondId, apiKeyId: secondKey, kind: "station" },
        randomUUID(),
      );
      await waitForLock("%pg_advisory_xact_lock%");
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
    }
    await confirming;
    expect(await concurrentIssue).toEqual({ status: "denied", reason: "not_entitled" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(boundary);
    const timed = new GrantIssuerService(db, entitlements, config, () => Date.now());
    expect((await timed.issueDevice(f, randomUUID())).status).toBe("issued");
    expect(
      await timed.issueDevice(
        { tenantId: f.tenantId, deviceId: secondId, apiKeyId: secondKey, kind: "station" },
        randomUUID(),
      ),
    ).toEqual({ status: "denied", reason: "not_entitled" });
    // Real production owner changes work/participation facts after selection.
    const productId = randomUUID(),
      shiftId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      name: "Retained work",
      gtin14: "04680089900383",
      status: "active",
    });
    await db.insert(schema.shifts).values({
      id: shiftId,
      tenantId: f.tenantId,
      productId,
      mode: "validation",
      status: "planned",
      numberMonthKey: "SEP26",
      numberSeq: 1,
    });
    const shifts = new ShiftsService(
      db,
      new OperatorsService(db),
      new SsccService(db),
      entitlements,
      new EntitlementAdmissionService(db, entitlements),
    );
    await shifts.enterShift(f.tenantId, shiftId, f.deviceId);
    expect(
      (await timed.issueTask(f, { taskKind: "shift", taskId: shiftId }, randomUUID())).status,
    ).toBe("issued");
    expect((await timed.issueDevice(f, randomUUID())).status).toBe("issued");
    expect(
      await timed.issueDevice(
        { tenantId: f.tenantId, deviceId: secondId, apiKeyId: secondKey, kind: "station" },
        randomUUID(),
      ),
    ).toEqual({ status: "denied", reason: "not_entitled" });
    // Metadata updates legitimately advance assignment revision, but preserve membership.
    await new StationDevicesService(db, entitlements).update(f.tenantId, f.deviceId, {
      name: "Retained renamed",
    });
    expect((await timed.issueDevice(f, randomUUID())).status).toBe("issued");
    vi.setSystemTime(new Date(boundary.getTime() + 60000));
    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "expired" })
      .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
    const restored = await createManagedSubscription(db, {
      tenantId: f.tenantId,
      planVersionId: current.planVersionId,
      status: "active",
      startsAt: new Date(),
      endsAt: new Date(boundary.getTime() + 120000),
    });
    expect(
      (
        await timed.issueDevice(
          { tenantId: f.tenantId, deviceId: secondId, apiKeyId: secondKey, kind: "station" },
          randomUUID(),
        )
      ).status,
    ).toBe("issued");
    // A resolved old reduction cannot silently become authority for a new reduction.
    vi.setSystemTime(new Date(boundary.getTime() + 120000));
    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "expired" })
      .where(eq(schema.tenantSubscriptions.id, restored.subscriptionId));
    await createManagedSubscription(db, {
      tenantId: f.tenantId,
      planVersionId: futurePlan,
      status: "active",
      startsAt: new Date(),
      endsAt: new Date(boundary.getTime() + 3600000),
    });
    expect(await timed.issueDevice(f, randomUUID())).toEqual({
      status: "denied",
      reason: "not_entitled",
    });
  });
  it("denies prepared replacement while retaining the currently valid credential", async () => {
    const f = await fixture(),
      id = randomUUID();
    await db.insert(schema.user).values({ id, name: "Owner", email: `${id}@example.invalid` });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: f.tenantId,
      userId: id,
      role: "owner",
      createdAt: new Date(),
    });
    const service = new DeviceReplacementService(db, entitlements, new PlatformAuditService()),
      actor = { domain: "cabinet" as const, id };
    const prepared = await service.preview(
      f.tenantId,
      f.deviceId,
      {
        requestId: randomUUID(),
        target: { name: "Replacement", kind: "station" },
        reason: "Replace",
      },
      actor,
    );
    await service.confirm(
      f.tenantId,
      f.deviceId,
      { requestId: prepared.requestId, previewId: prepared.id },
      actor,
    );
    expect(await issuer.issueDevice(f, randomUUID())).toEqual({
      status: "denied",
      reason: "not_entitled",
    });
    expect(
      await db.select().from(schema.apikey).where(eq(schema.apikey.id, f.apiKeyId)),
    ).toHaveLength(1);
    const [denial] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, f.tenantId));
    expect(denial?.after).toMatchObject({
      actorDomain: "station_device",
      actorId: f.deviceId,
      deviceKind: "station",
      credentialEpoch: 1,
      operation: "device",
      reason: "not_entitled",
      entitlementRevision: expect.any(String),
      policyRevision: expect.any(String),
    });
  });
  it("retains task request identity across policy changes and denies foreign task lookup", async () => {
    const f = await fixture(),
      foreign = await fixture(),
      productId = randomUUID(),
      taskId = randomUUID(),
      secondTask = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      name: "Grant product",
      gtin14: "04680089900383",
    });
    for (const [id, numberSeq] of [
      [taskId, 1],
      [secondTask, 2],
    ] as const) {
      await db.insert(schema.shifts).values({
        id,
        tenantId: f.tenantId,
        productId,
        mode: "validation",
        status: "active",
        numberMonthKey: "SEP26",
        numberSeq,
      });
      await db
        .insert(schema.shiftDeviceParticipants)
        .values({ tenantId: f.tenantId, shiftId: id, deviceId: f.deviceId });
    }
    await db
      .update(schema.shifts)
      .set({ palletsEnabled: true, palletBoxCapacity: 1 })
      .where(eq(schema.shifts.id, secondTask));
    expect(
      await issuer.issueTask(f, { taskKind: "shift", taskId: secondTask }, randomUUID()),
    ).toEqual({ status: "denied", reason: "not_entitled" });
    const reference = { taskKind: "shift" as const, taskId },
      requestId = randomUUID();
    const first = await issuer.issueTask(f, reference, requestId);
    if (first.status !== "issued") throw new Error("Expected task grant");
    expect(await issuer.issueTask(foreign, reference, randomUUID())).toEqual({
      status: "denied",
      reason: "task_not_frozen",
    });
    await expect(
      issuer.issueTask(f, { ...reference, taskId: secondTask }, requestId),
    ).rejects.toMatchObject({ status: 409 });
    const policy = await seedGrantPolicy(db, {
      shift: {
        "shift.scan.v1": { maxEvents: 10, maxUnits: 10 },
        "shift.close.v1": { maxEvents: 2 },
      },
    });
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 5,
      maxStations: 2,
      maxKiosks: 2,
      maxCabinetUsers: 5,
      lifecyclePolicyId: policy.id,
    });
    await db
      .update(schema.tenantSubscriptions)
      .set({ planVersionId })
      .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
    const replay = await issuer.issueTask(f, reference, requestId);
    if (replay.status !== "issued") throw new Error("Expected task replay");
    expect(replay.envelope.grants).toEqual(first.envelope.grants);
    expect(replay.envelope.taskSnapshots).toEqual(first.envelope.taskSnapshots);
    expect(
      await db
        .select()
        .from(schema.deviceGrantIssuances)
        .where(eq(schema.deviceGrantIssuances.tenantId, f.tenantId)),
    ).toHaveLength(1);
  });
  it("persists original signed bytes and audit atomically and replays them exactly", async () => {
    const identity = await fixture(),
      requestId = randomUUID();
    const result = await issuer.issueDevice(identity, requestId);
    expect(result.status).toBe("issued");
    if (result.status !== "issued" || !config) throw new Error("Expected grant");
    const compact = result.envelope.grants[0];
    if (!compact) throw new Error("Missing bytes");
    expect(
      await verifyGrant(
        compact,
        config.keyset.keys.map((key) => ({
          kid: key.kid,
          origin,
          jwk: { kty: key.jwk.kty, crv: key.jwk.crv, x: key.jwk.x, y: key.jwk.y },
        })),
        origin,
      ),
    ).toMatchObject({
      ok: true,
      grant: { tenantId: identity.tenantId, deviceId: identity.deviceId, kind: identity.kind },
    });
    const replay = await issuer.issueDevice(identity, requestId);
    expect(replay).toMatchObject({
      status: "issued",
      envelope: { grants: [compact], mode: "observe", taskSnapshots: [] },
    });
    const rows = await db
      .select()
      .from(schema.deviceGrantIssuances)
      .where(eq(schema.deviceGrantIssuances.tenantId, identity.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.compactJws).toBe(compact);
    const audit = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, identity.tenantId));
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "offline_grant.device.issued",
          outcome: "success",
          targetType: "offline_grant",
          targetId: rows[0]?.grantId,
          after: expect.objectContaining({
            actorDomain: "station_device",
            actorId: identity.deviceId,
            credentialEpoch: 1,
          }),
        }),
      ]),
    );
    const issuedAudit = audit.find((row) => row.action === "offline_grant.device.issued");
    expect(issuedAudit).toMatchObject({
      organizationId: identity.tenantId,
      actorUserId: null,
      action: "offline_grant.device.issued",
      outcome: "success",
      targetType: "offline_grant",
      targetId: rows[0]?.grantId,
      requestId,
    });
    expect(issuedAudit?.after).toEqual({
      actorDomain: "station_device",
      actorId: identity.deviceId,
      deviceKind: "station",
      credentialEpoch: 1,
      operation: "device",
      reason: null,
      entitlementRevision: rows[0]?.entitlementRevision,
      policyRevision: rows[0]?.policyRevision,
    });
    expect(audit.find((row) => row.action === "offline_grant.device.replayed")?.after).toEqual(
      issuedAudit?.after,
    );
    await db.delete(schema.apikey).where(eq(schema.apikey.id, identity.apiKeyId));
    await expect(issuer.issueDevice(identity, requestId)).rejects.toMatchObject({ status: 401 });
  });
});
