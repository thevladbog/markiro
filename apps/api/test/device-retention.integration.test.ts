import { replacementDigest } from "../src/modules/device-licensing/device-replacement-facts";
import { platformCapabilitiesForRole, type PlatformRole } from "@markiro/platform-contracts";
import { DeviceReplacementService } from "../src/modules/device-licensing/device-replacement.service";
import { drizzle } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DeviceRetentionService } from "../src/modules/device-licensing/device-retention.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import type * as EntitlementSnapshotReader from "../src/subscriptions/entitlement-snapshot-reader";
import { transitionWorkingAssignment } from "../src/subscriptions/working-device-assignments";
import {
  createOrganization,
  createManagedSubscription,
  createPublishedPlan,
  createPublishedAddon,
} from "./support/subscription-fixtures";

const registryFingerprintOverride = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("../src/subscriptions/entitlement-snapshot-reader", async (importOriginal) => {
  const actual = await importOriginal<typeof EntitlementSnapshotReader>();
  return {
    ...actual,
    entitlementRegistryFingerprint: () =>
      registryFingerprintOverride.value ?? actual.entitlementRegistryFingerprint(),
  };
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred not initialized");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe.skipIf(!process.env.DATABASE_URL)("device retention temporal intent", () => {
  const name = `retention_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  const maintenance = createDb(url.toString());
  url.pathname = `/${name}`;
  const connection = createDb(url.toString());
  const db = connection.db;
  const entitlements = new EntitlementsService(db, "managed_only");
  const service = new DeviceRetentionService(db, entitlements, new PlatformAuditService());
  let created = false;
  afterEach(() => {
    registryFingerprintOverride.value = null;
    vi.useRealTimers();
  });
  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
  }, 120_000);
  afterAll(async () => {
    await connection.pool.end();
    if (created) await maintenance.pool.query(`DROP DATABASE "${name}"`);
    await maintenance.pool.end();
  });
  async function fixture() {
    const tenantId = await createOrganization(db);
    const id = randomUUID();
    await db.insert(schema.user).values({ id, name: "Owner", email: `${id}@example.invalid` });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenantId,
      userId: id,
      role: "owner",
      createdAt: new Date(),
    });
    const [device] = await db
      .insert(schema.stationDevices)
      .values({ tenantId, name: "Source", pairedAt: new Date() })
      .returning();
    if (!device) throw new Error("fixture");
    await db.transaction((tx) => transitionWorkingAssignment(tx, device));
    const boundary = new Date(Date.now() + 60_000);
    const current = await createManagedSubscription(db, {
      tenantId,
      maxStations: 3,
      endsAt: boundary,
    });
    const future = await createManagedSubscription(db, {
      tenantId,
      maxStations: 1,
      status: "scheduled",
      startsAt: boundary,
      endsAt: null,
    });
    return {
      boundary,
      current,
      future,
      tenantId,
      device,
      actor: { domain: "cabinet" as const, id },
      intent: {
        requestId: randomUUID(),
        target: { name: "Replacement", kind: "station" as const },
        reason: "private decision",
      },
    };
  }
  async function operationalRows(tenantId: string) {
    return {
      devices: await db
        .select()
        .from(schema.stationDevices)
        .where(eq(schema.stationDevices.tenantId, tenantId)),
      assignments: await db
        .select()
        .from(schema.workingDeviceAssignments)
        .where(eq(schema.workingDeviceAssignments.tenantId, tenantId)),
      stationPairingCodes: await db
        .select()
        .from(schema.stationPairingCodes)
        .where(eq(schema.stationPairingCodes.tenantId, tenantId)),
      shifts: await db.select().from(schema.shifts).where(eq(schema.shifts.tenantId, tenantId)),
      shiftDeviceParticipants: await db
        .select()
        .from(schema.shiftDeviceParticipants)
        .where(eq(schema.shiftDeviceParticipants.tenantId, tenantId)),
      inventories: await db
        .select()
        .from(schema.inventories)
        .where(eq(schema.inventories.tenantId, tenantId)),
      inventoryDeviceParticipants: await db
        .select()
        .from(schema.inventoryDeviceParticipants)
        .where(eq(schema.inventoryDeviceParticipants.tenantId, tenantId)),
      productLabelJobs: await db
        .select()
        .from(schema.productLabelJobs)
        .where(eq(schema.productLabelJobs.tenantId, tenantId)),
      stationSyncQuarantine: await db
        .select()
        .from(schema.stationSyncQuarantine)
        .where(eq(schema.stationSyncQuarantine.tenantId, tenantId)),
      syncBatches: await db
        .select()
        .from(schema.syncBatches)
        .where(eq(schema.syncBatches.tenantId, tenantId)),
      tenantSubscriptions: await db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, tenantId)),
      subscriptionAddons: await db
        .select()
        .from(schema.subscriptionAddons)
        .where(eq(schema.subscriptionAddons.tenantId, tenantId)),
      entitlementSources: await db
        .select()
        .from(schema.entitlementSources)
        .where(eq(schema.entitlementSources.tenantId, tenantId)),
      commercialOffers: await db
        .select()
        .from(schema.commercialOffers)
        .where(eq(schema.commercialOffers.tenantId, tenantId)),
      commercialOfferLines: await db
        .select()
        .from(schema.commercialOfferLines)
        .where(eq(schema.commercialOfferLines.tenantId, tenantId)),
      invoices: await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.tenantId, tenantId)),
      invoiceLines: await db
        .select()
        .from(schema.invoiceLines)
        .where(eq(schema.invoiceLines.tenantId, tenantId)),
      orderedServices: await db
        .select()
        .from(schema.orderedServices)
        .where(eq(schema.orderedServices.tenantId, tenantId)),
      credentials: await db.select().from(schema.apikey),
      catalogItems: await db.select().from(schema.catalogItems),
      catalogVersions: await db.select().from(schema.catalogItemVersions),
      policies: await db.select().from(schema.entitlementLifecyclePolicies),
      usage: await entitlements.usage(tenantId),
    };
  }

  async function preview(
    f: Awaited<ReturnType<typeof fixture>>,
    ids = [f.device.id],
    revision = 0,
  ) {
    const inspection = await service.inspect(f.tenantId, f.actor);
    if (!inspection.observation) throw new Error("Missing future reduction");
    return service.preview(
      f.tenantId,
      {
        requestId: randomUUID(),
        boundaryKey: inspection.observation.boundary.key,
        selectedDeviceIds: ids,
        expectedRevision: revision,
        reason: "Keep line station",
      },
      f.actor,
    );
  }
  it("marks a prior-registry retention intent for review while replaying its receipt", async () => {
    const f = await fixture();
    registryFingerprintOverride.value = `p1a.v1:${"a".repeat(64)}`;
    const prior = await preview(f);
    const receipt = await service.confirm(
      f.tenantId,
      { requestId: prior.requestId, previewId: prior.id },
      f.actor,
    );
    registryFingerprintOverride.value = null;
    expect((await service.inspect(f.tenantId, f.actor)).selections[0]?.needsReview).toBe(true);
    expect(
      await service.confirm(
        f.tenantId,
        { requestId: prior.requestId, previewId: prior.id },
        f.actor,
      ),
    ).toEqual(receipt);
  });
  it("projects a scheduled smaller plan at precisely the server boundary and preserves operational rows", async () => {
    const f = await fixture();
    const before = await operationalRows(f.tenantId);
    const inspection = await service.inspect(f.tenantId, f.actor);
    expect(inspection.observation?.boundary.effectiveAt).toBe(f.boundary.toISOString());
    expect(inspection.observation?.current.candidate.quotas.stations.limit).toBe(3);
    expect(inspection.observation?.future.candidate.quotas.stations.limit).toBe(1);
    expect(inspection.observation?.future.asOf).toBe(f.boundary.toISOString());
    const p = await preview(f);
    const receipt = await service.confirm(
      f.tenantId,
      { requestId: p.requestId, previewId: p.id },
      f.actor,
    );
    expect(receipt.selection.observation).toEqual(p.observation);
    expect(receipt.selection.selectedDeviceIds).toEqual([f.device.id]);
    expect(await operationalRows(f.tenantId)).toEqual(before);
    const second = await preview(f, [], 1);
    await service.confirm(
      f.tenantId,
      { requestId: second.requestId, previewId: second.id },
      f.actor,
    );
    expect(
      await service.confirm(f.tenantId, { requestId: p.requestId, previewId: p.id }, f.actor),
    ).toEqual(receipt);
    const events = await db
      .select()
      .from(schema.workingDeviceRetentionEvents)
      .where(eq(schema.workingDeviceRetentionEvents.tenantId, f.tenantId));
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.requestId === p.requestId)).toMatchObject({
      tenantId: f.tenantId,
      actorDomain: "cabinet",
      actorId: f.actor.id,
      action: "selection_confirmed",
      before: null,
      after: receipt.selection,
      result: receipt,
    });
  });
  it("rejects duplicate, foreign and released devices and stale pool facts", async () => {
    const f = await fixture();
    await expect(preview(f, [f.device.id, f.device.id])).rejects.toMatchObject({ status: 400 });
    await expect(preview(f, [randomUUID()])).rejects.toMatchObject({ status: 409 });
    const p = await preview(f);
    await db
      .update(schema.stationDevices)
      .set({ name: "Changed" })
      .where(eq(schema.stationDevices.id, f.device.id));
    await expect(
      service.confirm(f.tenantId, { requestId: p.requestId, previewId: p.id }, f.actor),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("keeps reached intention applicable without fabricating a historical snapshot and rejects expired confirm", async () => {
    const f = await fixture();
    const [other] = await db
      .insert(schema.stationDevices)
      .values({ tenantId: f.tenantId, name: "Other" })
      .returning();
    if (!other) throw new Error("fixture");
    await db.transaction((tx) => transitionWorkingAssignment(tx, other));
    const p = await preview(f);
    const receipt = await service.confirm(
      f.tenantId,
      { requestId: p.requestId, previewId: p.id },
      f.actor,
    );
    const pending = await preview(f, [], 1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(f.boundary);
    const inspected = await service.inspect(f.tenantId, f.actor);
    expect(inspected.observation).toBeNull();
    expect(inspected.selections).toEqual([
      { selection: receipt.selection, needsReview: false, boundaryReached: true },
    ]);
    expect(inspected.currentShadow).toEqual({
      awaitingSelection: false,
      affectedDeviceIds: [other.id],
      enforced: false,
    });
    await expect(
      service.confirm(f.tenantId, { requestId: pending.requestId, previewId: pending.id }, f.actor),
    ).rejects.toMatchObject({ status: 409 });
    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "expired" })
      .where(eq(schema.tenantSubscriptions.id, f.current.subscriptionId));
    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "active" })
      .where(eq(schema.tenantSubscriptions.id, f.future.subscriptionId));
    await db
      .insert(schema.entitlementRevisions)
      .values({ tenantId: f.tenantId, revision: 99n, usageRevision: 0n })
      .onConflictDoUpdate({ target: schema.entitlementRevisions.tenantId, set: { revision: 99n } });
    expect((await service.inspect(f.tenantId, f.actor)).selections[0]?.needsReview).toBe(false);
  });
  it("does not invent a date for undated pending activation", async () => {
    const f = await fixture();
    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "cancelled" })
      .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
    await createManagedSubscription(db, {
      tenantId: f.tenantId,
      status: "pending_activation",
      startsAt: null,
      endsAt: null,
    });
    expect((await service.inspect(f.tenantId, f.actor)).observation).toBeNull();
  });
  async function platformActor(role: PlatformRole = "platform_admin") {
    const userId = randomUUID();
    await db.insert(schema.platformUsers).values({
      id: userId,
      email: `${userId}@example.invalid`,
      name: "Operator",
      role,
      status: "active",
      twoFactorEnabled: true,
    });
    await db.insert(schema.platformTwoFactors).values({
      id: randomUUID(),
      userId,
      secret: "fixture",
      backupCodes: "fixture",
      verified: true,
    });
    return {
      domain: "platform" as const,
      principal: {
        userId,
        role,
        capabilities: platformCapabilitiesForRole[role],
        twoFactorReady: true,
      },
    };
  }
  async function waitBlocked(pid: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await connection.pool.query<{ pid: number }>(
        "select pid from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid))",
        [pid],
      );
      const waitingPid = result.rows[0]?.pid;
      if (waitingPid !== undefined) return waitingPid;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Expected transaction barrier was not reached");
  }

  async function plainTimeline(f: Awaited<ReturnType<typeof fixture>>, limit: number | null = 1) {
    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "cancelled" })
      .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
    return createManagedSubscription(db, {
      tenantId: f.tenantId,
      maxStations: limit,
      endsAt: null,
    });
  }
  async function grant(
    f: Awaited<ReturnType<typeof fixture>>,
    subscriptionId: string,
    effects: Array<
      { key: "stations"; quotaIncrement: number } | { key: "handheld"; featureEnabled: true }
    >,
    endsAt: Date | null,
    operationIds: Array<"handheld.work.start.v1" | "nk.lookup.v1"> = ["handheld.work.start.v1"],
  ) {
    const actor = await platformActor();
    const [row] = await db
      .insert(schema.entitlementSources)
      .values({
        tenantId: f.tenantId,
        subscriptionId,
        versionId: randomUUID(),
        kind: "temporary",
        effects,
        operationIds,
        startsAt: new Date(Date.now() - 1000),
        endsAt: endsAt ?? new Date(Date.now() + 3600_000),
        reason: "Private platform reason",
        decisionReference: "TEST-RETENTION",
        requestId: randomUUID(),
        createdByPlatformUserId: actor.principal.userId,
        createdAt: new Date(),
      })
      .returning();
    if (!row) throw new Error("fixture");
    return row;
  }
  it.each(["addon", "grant"] as const)(
    "finds %s expiry after intervening irrelevant quota boundary",
    async (kind) => {
      const f = await fixture(),
        current = await plainTimeline(f);
      const irrelevant = new Date(Date.now() + 10_000),
        expected = new Date(Date.now() + 40_000);
      const addonVersionId = await createPublishedAddon(db, [
        { entitlementKey: "lines", increment: 1 },
      ]);
      await db.insert(schema.subscriptionAddons).values({
        tenantId: f.tenantId,
        subscriptionId: current.subscriptionId,
        addonVersionId,
        quantity: 1,
        source: "manual",
        status: "active",
        startsAt: new Date(Date.now() - 1000),
        endsAt: irrelevant,
      });
      if (kind === "addon") {
        const addonVersionId = await createPublishedAddon(db, [
          { entitlementKey: "stations", increment: 2 },
        ]);
        await db.insert(schema.subscriptionAddons).values({
          tenantId: f.tenantId,
          subscriptionId: current.subscriptionId,
          addonVersionId,
          quantity: 1,
          source: "manual",
          status: "active",
          startsAt: new Date(Date.now() - 1000),
          endsAt: expected,
        });
      } else
        await grant(f, current.subscriptionId, [{ key: "stations", quotaIncrement: 2 }], expected);
      const inspected = await service.inspect(f.tenantId, f.actor);
      expect(inspected.observation?.boundary.effectiveAt).toBe(expected.toISOString());
      expect(inspected.observation?.current.candidate.quotas.stations.limit).toBe(3);
      expect(inspected.observation?.future.candidate.quotas.stations.limit).toBe(1);
      const p = await preview(f);
      expect(p.expiresAt).toBe(irrelevant.toISOString());
      expect(JSON.stringify(p)).not.toContain("Private platform reason");
    },
  );
  it.each([0, null] as const)(
    "handles future capacity %s without choosing devices automatically",
    async (limit) => {
      const f = await fixture();
      const planVersionId = await createPublishedPlan(db, {
        maxStations: limit,
        maxLines: 1,
        maxKiosks: 1,
        maxCabinetUsers: 1,
      });
      await db
        .update(schema.tenantSubscriptions)
        .set({ planVersionId })
        .where(eq(schema.tenantSubscriptions.id, f.future.subscriptionId));
      if (limit === null)
        expect((await service.inspect(f.tenantId, f.actor)).observation).toBeNull();
      else {
        await expect(preview(f)).rejects.toMatchObject({ status: 409 });
        const p = await preview(f, []);
        expect(
          (await service.confirm(f.tenantId, { requestId: p.requestId, previewId: p.id }, f.actor))
            .selection.selectedDeviceIds,
        ).toEqual([]);
      }
    },
  );
  it("detects unlimited-to-finite reduction", async () => {
    const f = await fixture();
    const planVersionId = await createPublishedPlan(db, {
      maxStations: null,
      maxLines: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
    });
    await db
      .update(schema.tenantSubscriptions)
      .set({ planVersionId })
      .where(eq(schema.tenantSubscriptions.id, f.current.subscriptionId));
    expect(
      (await service.inspect(f.tenantId, f.actor)).observation?.current.candidate.quotas.stations
        .limit,
    ).toBeNull();
    expect((await preview(f)).observation.future.candidate.quotas.stations.limit).toBe(1);
  });
  it.each(["unknown", "false", "wrong_operation"] as const)(
    "rejects future handheld %s, including aggregate true from another operation",
    async (kind) => {
      const f = await fixture();
      await db
        .update(schema.stationDevices)
        .set({ kind: "handheld" })
        .where(eq(schema.stationDevices.id, f.device.id));
      if (kind === "wrong_operation")
        await grant(f, f.future.subscriptionId, [{ key: "handheld", featureEnabled: true }], null, [
          "nk.lookup.v1",
        ]);
      if (kind === "false") {
        // A disabled plan field is a distinct known-false fixture, built before publication.
        const itemId = randomUUID(),
          versionId = randomUUID();
        await db.insert(schema.catalogItems).values({
          id: itemId,
          code: `plan-${itemId}`,
          nameRu: "Plan",
          nameEn: "Plan",
          kind: "plan",
        });
        await db.insert(schema.catalogItemVersions).values({
          id: versionId,
          catalogItemId: itemId,
          kind: "plan",
          version: 1,
          nameRu: "Plan",
          nameEn: "Plan",
          unit: "month",
          billingMode: "recurring",
          billingPeriod: "month",
          unitPrice: "100.00",
          vatRate: "20.00",
          vatIncluded: true,
        });
        await db.insert(schema.planEntitlements).values({
          catalogVersionId: versionId,
          maxStations: 1,
          maxLines: 1,
          maxKiosks: 1,
          maxCabinetUsers: 1,
          handheldEnabled: false,
        });
        await db
          .update(schema.catalogItemVersions)
          .set({ status: "published", publishedAt: new Date() })
          .where(eq(schema.catalogItemVersions.id, versionId));
        await db
          .update(schema.tenantSubscriptions)
          .set({ planVersionId: versionId })
          .where(eq(schema.tenantSubscriptions.id, f.future.subscriptionId));
      }
      const inspected = await service.inspect(f.tenantId, f.actor);
      expect(inspected.observation?.devices[0]).toMatchObject({
        eligible: false,
        reasons: ["handheld_unavailable"],
      });
      if (kind === "wrong_operation")
        expect(inspected.observation?.future.candidate.features.handheld).toBe(true);
      await expect(preview(f)).rejects.toMatchObject({ status: 409 });
      await expect(preview(f, [])).resolves.toBeDefined();
    },
  );
  it("finds operation-scoped handheld loss even without a quota reduction", async () => {
    const f = await fixture(),
      current = await plainTimeline(f, null);
    await db
      .update(schema.stationDevices)
      .set({ kind: "handheld" })
      .where(eq(schema.stationDevices.id, f.device.id));
    const at = new Date(Date.now() + 30_000);
    await grant(f, current.subscriptionId, [{ key: "handheld", featureEnabled: true }], at, [
      "handheld.work.start.v1",
    ]);
    await grant(f, current.subscriptionId, [{ key: "handheld", featureEnabled: true }], null, [
      "nk.lookup.v1",
    ]);
    const inspected = await service.inspect(f.tenantId, f.actor);
    expect(inspected.observation?.boundary.effectiveAt).toBe(at.toISOString());
    expect(inspected.observation?.future.candidate.features.handheld).toBe(true);
    expect(inspected.observation?.selectionRequired).toBe(true);
  });
  it("authenticates before immutable replay and enforces fresh platform capabilities and factor", async () => {
    const f = await fixture(),
      actor = await platformActor();
    const inspection = await service.inspect(f.tenantId, actor);
    if (!inspection.observation) throw new Error("fixture");
    const intent = {
      requestId: randomUUID(),
      boundaryKey: inspection.observation.boundary.key,
      expectedRevision: 0,
      selectedDeviceIds: [f.device.id],
      reason: "Keep",
    };
    const p = await service.preview(f.tenantId, intent, actor);
    const body = { requestId: p.requestId, previewId: p.id };
    const receipt = await service.confirm(f.tenantId, body, actor);
    const audits = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.requestId, p.requestId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenantId: f.tenantId,
      actorPlatformUserId: actor.principal.userId,
      actorRole: "platform_admin",
      action: "device.retention.selection_confirmed",
      outcome: "success",
      targetType: "working_device_retention_selection",
      targetId: receipt.selection.id,
      before: null,
      after: {
        id: receipt.selection.id,
        revision: receipt.selection.revision,
        preparedAt: receipt.selection.preparedAt,
        selectedDeviceCount: receipt.selection.selectedDeviceIds.length,
        selectedDeviceIdsDigest: replacementDigest(receipt.selection.selectedDeviceIds),
        boundary: receipt.selection.observation.boundary,
      },
      reason: "Keep",
      requestId: p.requestId,
    });
    await expect(service.confirm(f.tenantId, body, f.actor)).rejects.toMatchObject({ status: 409 });
    const reader = await platformActor("support");
    expect((await service.inspect(f.tenantId, reader)).canSelect).toBe(false);
    await expect(
      service.preview(f.tenantId, { ...intent, requestId: randomUUID() }, reader),
    ).rejects.toMatchObject({ status: 403 });
    await db
      .delete(schema.platformTwoFactors)
      .where(eq(schema.platformTwoFactors.userId, actor.principal.userId));
    await expect(service.confirm(f.tenantId, body, actor)).rejects.toMatchObject({ status: 403 });
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.userId, f.actor.id));
    await expect(service.inspect(f.tenantId, f.actor)).rejects.toMatchObject({ status: 403 });
  });
  it("normalizes complete set order for retries while conflicting on changed body or actor", async () => {
    const f = await fixture();
    const [secondDevice] = await db
      .insert(schema.stationDevices)
      .values({ tenantId: f.tenantId, name: "Second source", pairedAt: new Date() })
      .returning();
    if (!secondDevice) throw new Error("fixture");
    await db.transaction((tx) => transitionWorkingAssignment(tx, secondDevice));
    const futurePlanVersionId = await createPublishedPlan(db, {
      maxStations: 2,
      maxLines: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
    });
    await db
      .update(schema.tenantSubscriptions)
      .set({ planVersionId: futurePlanVersionId })
      .where(eq(schema.tenantSubscriptions.id, f.future.subscriptionId));
    const selectedDeviceIds = [f.device.id, secondDevice.id].sort();
    const inspection = await service.inspect(f.tenantId, f.actor);
    if (!inspection.observation) throw new Error("Missing future reduction");
    const body = {
      requestId: randomUUID(),
      boundaryKey: inspection.observation.boundary.key,
      selectedDeviceIds,
      expectedRevision: 0,
      reason: "Keep line station",
    };
    const p = await service.preview(f.tenantId, body, f.actor);
    const reordered = await service.preview(
      f.tenantId,
      { ...body, selectedDeviceIds: [...selectedDeviceIds].reverse() },
      f.actor,
    );
    expect(reordered).toEqual(p);
    expect(reordered.observation).toEqual(p.observation);
    await expect(
      service.preview(f.tenantId, { ...body, reason: "Changed" }, f.actor),
    ).rejects.toMatchObject({ status: 409 });
    await expect(service.preview(f.tenantId, body, await platformActor())).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      service.confirm(f.tenantId, { requestId: randomUUID(), previewId: p.id }, f.actor),
    ).rejects.toMatchObject({ status: 409 });
    const other = await fixture();
    await expect(
      service.confirm(other.tenantId, { requestId: p.requestId, previewId: p.id }, other.actor),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("mutually invalidates replacement and retention previews without changing operational rows", async () => {
    const f = await fixture(),
      replacements = new DeviceReplacementService(db, entitlements, new PlatformAuditService());
    const first = await replacements.preview(f.tenantId, f.device.id, f.intent, f.actor);
    const p = await preview(f);
    await service.confirm(f.tenantId, { requestId: p.requestId, previewId: p.id }, f.actor);
    await expect(
      replacements.confirm(
        f.tenantId,
        f.device.id,
        { requestId: first.requestId, previewId: first.id },
        f.actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const pending = await preview(f, [], 1);
    const second = await replacements.preview(
      f.tenantId,
      f.device.id,
      { ...f.intent, requestId: randomUUID() },
      f.actor,
    );
    const receipt = await replacements.confirm(
      f.tenantId,
      f.device.id,
      { requestId: second.requestId, previewId: second.id },
      f.actor,
    );
    await expect(
      service.confirm(f.tenantId, { requestId: pending.requestId, previewId: pending.id }, f.actor),
    ).rejects.toMatchObject({ status: 409 });
    const fresh = await preview(f, [], 1);
    await replacements.cancel(
      f.tenantId,
      receipt.preparation.id,
      { requestId: randomUUID(), expectedRevision: 1 },
      f.actor,
    );
    await expect(
      service.confirm(f.tenantId, { requestId: fresh.requestId, previewId: fresh.id }, f.actor),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("replays subscription switches, source scopes and invitation expiry with authoritative snapshot parity", async () => {
    const f = await fixture();
    const invitationEnds = new Date(f.boundary.getTime() - 20_000);
    await db.insert(schema.invitation).values({
      id: randomUUID(),
      organizationId: f.tenantId,
      email: `${randomUUID()}@example.invalid`,
      role: "member",
      status: "pending",
      expiresAt: invitationEnds,
      inviterId: f.actor.id,
    });
    await grant(
      f,
      f.current.subscriptionId,
      [{ key: "handheld", featureEnabled: true }],
      new Date(f.boundary.getTime() + 60_000),
      ["nk.lookup.v1"],
    );
    await grant(
      f,
      f.future.subscriptionId,
      [{ key: "handheld", featureEnabled: true }],
      new Date(f.boundary.getTime() + 60_000),
    );
    const queries: string[] = [];
    const observedDb = drizzle(connection.pool, {
      logger: {
        logQuery(query) {
          queries.push(query);
        },
      },
    });
    const resolver = new EntitlementsService(observedDb, "managed_only");
    await observedDb.transaction(
      async (tx) => {
        const evaluate = await resolver.loadSnapshotTimeline(f.tenantId, tx);
        for (const date of [
          new Date(invitationEnds.getTime() - 1),
          invitationEnds,
          new Date(f.boundary.getTime() - 1),
          f.boundary,
          new Date(f.boundary.getTime() + 60_000),
        ]) {
          queries.length = 0;
          const projected = await evaluate(date);
          expect(queries).toEqual([]);
          const independent = await resolver.resolveSnapshotInTransaction(f.tenantId, tx, date);
          expect(projected).toEqual(independent);
        }
      },
      { isolationLevel: "repeatable read" },
    );
  });
  it.each(["plan", "addon"] as const)(
    "retains malformed %s rejection in timeline evaluation",
    async (kind) => {
      const f = await fixture();
      let versionId = f.current.planVersionId;
      if (kind === "addon") {
        versionId = await createPublishedAddon(db, [{ entitlementKey: "stations", increment: 1 }]);
        await db.insert(schema.subscriptionAddons).values({
          tenantId: f.tenantId,
          subscriptionId: f.current.subscriptionId,
          addonVersionId: versionId,
          quantity: 1,
          source: "manual",
          status: "active",
        });
      }
      const [version] = await db
        .select()
        .from(schema.catalogItemVersions)
        .where(eq(schema.catalogItemVersions.id, versionId));
      if (!version) throw new Error("Missing version");
      const draftId = randomUUID();
      await db
        .insert(schema.catalogItemVersions)
        .values({ ...version, id: draftId, version: 2, status: "draft", publishedAt: null });
      if (kind === "plan")
        await db
          .update(schema.tenantSubscriptions)
          .set({ planVersionId: draftId })
          .where(eq(schema.tenantSubscriptions.id, f.current.subscriptionId));
      else
        await db
          .update(schema.subscriptionAddons)
          .set({ addonVersionId: draftId })
          .where(eq(schema.subscriptionAddons.addonVersionId, versionId));
      await db.transaction(async (tx) => {
        const evaluate = await entitlements.loadSnapshotTimeline(f.tenantId, tx);
        await expect(evaluate(new Date())).rejects.toMatchObject({
          name: "SubscriptionEntitlementsInvalidException",
        });
        await expect(
          entitlements.resolveSnapshotInTransaction(f.tenantId, tx),
        ).rejects.toMatchObject({ name: "SubscriptionEntitlementsInvalidException" });
      });
    },
  );
  it("bounds SQL reads across forty irrelevant dates and finds the last reducing date", async () => {
    const f = await fixture();
    const current = await plainTimeline(f);
    const now = new Date();
    const ending = new Date(now.getTime() + 100_000);
    await grant(f, current.subscriptionId, [{ key: "stations", quotaIncrement: 2 }], ending);
    const queries: string[] = [];
    const observedDb = drizzle(connection.pool, {
      logger: {
        logQuery(query) {
          queries.push(query);
        },
      },
    });
    const reader = new DeviceRetentionService(
      observedDb,
      new EntitlementsService(observedDb, "managed_only"),
      new PlatformAuditService(),
    );
    const initial = await reader.inspect(f.tenantId, f.actor);
    const baseline = queries.length;
    const addonVersionId = await createPublishedAddon(db, [
      { entitlementKey: "lines", increment: 1 },
    ]);
    await db.insert(schema.subscriptionAddons).values(
      Array.from({ length: 40 }, (_, index) => ({
        tenantId: f.tenantId,
        subscriptionId: current.subscriptionId,
        addonVersionId,
        quantity: 1,
        source: "manual" as const,
        status: "active" as const,
        startsAt: new Date(now.getTime() - 1000),
        endsAt: new Date(now.getTime() + (index + 1) * 1000),
      })),
    );
    queries.length = 0;
    const result = await reader.inspect(f.tenantId, f.actor);
    expect(result.observation?.boundary.effectiveAt).toBe(ending.toISOString());
    expect(result.observation?.future.candidate.quotas.stations.limit).toBe(
      initial.observation?.future.candidate.quotas.stations.limit,
    );
    expect(queries.length).toBeLessThanOrEqual(baseline + 3);
  });
  it.each(["boundary", "next-change"])(
    "classifies a preview crossing %s during facts work as stale",
    async (kind) => {
      const f = await fixture();
      const inspection = await service.inspect(f.tenantId, f.actor);
      if (!inspection.observation) throw new Error("Missing observation");
      let cutoff = f.boundary;
      if (kind === "next-change") {
        cutoff = new Date(Date.now() + 10_000);
        const addonVersionId = await createPublishedAddon(db, [
          { entitlementKey: "lines", increment: 1 },
        ]);
        await db.insert(schema.subscriptionAddons).values({
          tenantId: f.tenantId,
          subscriptionId: f.current.subscriptionId,
          addonVersionId,
          quantity: 1,
          source: "manual",
          status: "active",
          startsAt: new Date(Date.now() - 1000),
          endsAt: cutoff,
        });
      }
      const current = await service.inspect(f.tenantId, f.actor);
      if (!current.observation) throw new Error("Missing observation");
      const original = entitlements.resolveSnapshotInTransaction.bind(entitlements);
      vi.useFakeTimers({ toFake: ["Date"] });
      const read = vi
        .spyOn(entitlements, "resolveSnapshotInTransaction")
        .mockImplementation(async (...args) => {
          const result = await original(...args);
          vi.setSystemTime(cutoff);
          return result;
        });
      try {
        await expect(
          service.preview(
            f.tenantId,
            {
              requestId: randomUUID(),
              boundaryKey: current.observation.boundary.key,
              selectedDeviceIds: [],
              expectedRevision: 0,
              reason: "Review",
            },
            f.actor,
          ),
        ).rejects.toMatchObject({ status: 409, response: { code: "device_retention_stale" } });
      } finally {
        read.mockRestore();
      }
    },
  );
  it("inspection is a read-only snapshot and does not wait for writer device locks", async () => {
    const f = await fixture(),
      queries: string[] = [];
    const readConnection = createDb(url.toString());
    const readDb = drizzle(readConnection.pool, {
      logger: {
        logQuery(query) {
          queries.push(query);
        },
      },
    });
    const reader = new DeviceRetentionService(
      readDb,
      new EntitlementsService(readDb, "managed_only"),
      new PlatformAuditService(),
    );
    const writer = await connection.pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("update station_devices set name='Uncommitted' where id=$1", [
        f.device.id,
      ]);
      await readConnection.pool.query("set statement_timeout='2s'");
      expect((await reader.inspect(f.tenantId, f.actor)).observation?.devices[0]?.name).toBe(
        "Source",
      );
      expect(
        queries.some((query) => /for (update|share)|pg_advisory|^insert |^update /i.test(query)),
      ).toBe(false);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await readConnection.pool.end();
    }
  });
  it.each(["cabinet", "platform"] as const)(
    "serializes two expectedRevision 0 confirmations with %s winning",
    async (first) => {
      const f = await fixture(),
        platform = await platformActor();
      const cabinetPreview = await preview(f);
      const platformPreview = await service.preview(
        f.tenantId,
        {
          requestId: randomUUID(),
          boundaryKey: cabinetPreview.observation.boundary.key,
          expectedRevision: 0,
          selectedDeviceIds: [],
          reason: "Platform choice",
        },
        platform,
      );
      const winner =
        first === "cabinet"
          ? { p: cabinetPreview, actor: f.actor }
          : { p: platformPreview, actor: platform };
      const loser =
        first === "cabinet"
          ? { p: platformPreview, actor: platform }
          : { p: cabinetPreview, actor: f.actor };
      const blocker = await connection.pool.connect();
      try {
        await blocker.query("BEGIN");
        const { rows } = await blocker.query<{ pid: number }>("select pg_backend_pid() as pid");
        const pid = rows[0]?.pid;
        if (pid === undefined) throw new Error("fixture");
        if (first === "cabinet")
          await blocker.query("select id from member where user_id=$1 for update", [f.actor.id]);
        else
          await blocker.query("select id from platform_two_factors where user_id=$1 for update", [
            platform.principal.userId,
          ]);
        const result = service.confirm(
          f.tenantId,
          { requestId: winner.p.requestId, previewId: winner.p.id },
          winner.actor,
        );
        const confirmingPid = await waitBlocked(pid);
        const competing = service
          .confirm(f.tenantId, { requestId: loser.p.requestId, previewId: loser.p.id }, loser.actor)
          .catch((error: unknown) => error);
        await waitBlocked(confirmingPid);
        await blocker.query("COMMIT");
        expect((await result).selection.revision).toBe(1);
        expect(await competing).toMatchObject({ status: 409 });
        expect(
          await db
            .select()
            .from(schema.workingDeviceRetentionEvents)
            .where(eq(schema.workingDeviceRetentionEvents.tenantId, f.tenantId)),
        ).toHaveLength(1);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
    },
  );

  it("rechecks expiry after reading and locking facts, not only when confirm starts", async () => {
    const f = await fixture(),
      p = await preview(f);
    const original = entitlements.resolveSnapshotInTransaction.bind(entitlements);
    vi.useFakeTimers({ toFake: ["Date"] });
    const read = vi
      .spyOn(entitlements, "resolveSnapshotInTransaction")
      .mockImplementation(async (...args) => {
        const facts = await original(...args);
        vi.setSystemTime(new Date(p.expiresAt));
        return facts;
      });
    try {
      await expect(
        service.confirm(f.tenantId, { requestId: p.requestId, previewId: p.id }, f.actor),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      read.mockRestore();
    }
  });
  it("counts distinct tenant-scoped server tasks and quarantine batches, retaining unknown local work", async () => {
    const f = await fixture();
    const tenantId = f.tenantId;
    const productId = randomUUID();
    const lineId = randomUUID();
    const operatorId = randomUUID();
    const inventoryId = randomUUID();
    const shiftId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, name: "Product", gtin14: "00012345678901" });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Line" });
    await db.insert(schema.employees).values({ id: operatorId, tenantId, fullName: "Operator" });
    await db.insert(schema.shifts).values({
      id: shiftId,
      tenantId,
      productId,
      mode: "validation",
      status: "active",
      numberMonthKey: "SEP26",
      numberSeq: 1,
      stationCloseOwnerDeviceId: f.device.id,
    });
    await db
      .insert(schema.shiftDeviceParticipants)
      .values({ tenantId, shiftId, deviceId: f.device.id });
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: "Inventory",
      productId,
      gtin14Snapshot: "00012345678901",
      lineId,
      mode: "check",
      productionDateFrom: "2026-09-01",
      productionDateTo: "2026-09-10",
      createdByUserId: f.actor.id,
    });
    await db.insert(schema.inventoryDeviceParticipants).values({
      tenantId,
      inventoryId,
      deviceId: f.device.id,
      operatorId,
      configuredLineId: lineId,
      joinMethod: "assigned_line",
      pendingEventCount: 3,
      openBoxCount: 1,
    });
    await db.insert(schema.productLabelJobs).values({
      tenantId,
      deviceId: f.device.id,
      jobId: randomUUID(),
      shiftId,
      codeHash: "a".repeat(64),
      acceptedAt: new Date(),
      policyRevision: randomUUID(),
      templateDigest: "b".repeat(64),
      payloadDigest: "c".repeat(64),
      latestSequence: 1,
      projection: { state: "retained" },
    });
    const batchId = randomUUID();
    await db.insert(schema.syncBatches).values({
      tenantId,
      batchId,
      terminalId: f.device.id,
      payloadDigest: "a".repeat(64),
      result: {},
    });
    await db.insert(schema.stationSyncQuarantine).values(
      [0, 1].map((recordIndex) => ({
        tenantId,
        terminalId: f.device.id,
        batchId,
        payloadDigest: "a".repeat(64),
        recordKind: "item",
        recordIndex,
        reason: "fixture",
        payload: {},
      })),
    );

    const serviceActor = await platformActor();
    const [offer] = await db
      .insert(schema.commercialOffers)
      .values({
        tenantId,
        revision: 1,
        status: "draft",
        total: "100.00",
        createdByPlatformUserId: serviceActor.principal.userId,
      })
      .returning();
    if (!offer) throw new Error("fixture");
    const [line] = await db
      .insert(schema.commercialOfferLines)
      .values({
        tenantId,
        offerId: offer.id,
        position: 1,
        kind: "service",
        nameRu: "Подключение",
        nameEn: "Setup",
        quantity: 2,
        unit: "service",
        agreedUnitPrice: "50.00",
        vatIncluded: false,
        lineTotal: "100.00",
      })
      .returning();
    if (!line) throw new Error("fixture");
    await db
      .update(schema.commercialOffers)
      .set({
        status: "published",
        number: `KP-RET-${randomUUID()}`,
        publishedAt: new Date(),
        publishedByPlatformUserId: serviceActor.principal.userId,
      })
      .where(eq(schema.commercialOffers.id, offer.id));
    const [payment] = await db
      .insert(schema.payments)
      .values({
        tenantId,
        offerId: offer.id,
        paidAt: new Date(),
        amount: "100.00",
        bankReference: randomUUID(),
        platformUserId: serviceActor.principal.userId,
        idempotencyKey: randomUUID(),
      })
      .returning();
    if (!payment) throw new Error("fixture");
    await db.insert(schema.orderedServices).values({
      tenantId,
      offerLineId: line.id,
      paymentId: payment.id,
      nameRu: "Подключение",
      nameEn: "Setup",
      quantity: 2,
      unit: "service",
      status: "ordered",
      orderedAt: new Date(),
    });
    const protectedRows = await operationalRows(tenantId);
    const p = await preview(f);
    expect(p.observation.devices[0]?.knownServerWork).toEqual({
      activeShifts: 1,
      activeInventories: 1,
      printJobs: 1,
      quarantineBatches: 1,
    });
    expect(p.observation.devices[0]?.localData).toEqual({
      journals: "unknown",
      outbox: "unknown",
      printWork: "unknown",
    });
    expect(p.observation.services).toMatchObject([
      { nameRu: "Подключение", nameEn: "Setup", quantity: 2, unit: "service", status: "ordered" },
    ]);
    const receipt = await service.confirm(
      tenantId,
      { requestId: p.requestId, previewId: p.id },
      f.actor,
    );
    expect(await operationalRows(tenantId)).toEqual(protectedRows);
    const pending = await preview(f, [], 1);
    await db
      .update(schema.inventoryDeviceParticipants)
      .set({ heartbeatAt: new Date() })
      .where(eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId));
    await db
      .update(schema.stationDevices)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.stationDevices.id, f.device.id));
    expect((await service.inspect(tenantId, f.actor)).selections[0]?.needsReview).toBe(false);
    await db
      .update(schema.inventoryDeviceParticipants)
      .set({ pendingEventCount: 0 })
      .where(eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId));
    expect((await service.inspect(tenantId, f.actor)).selections[0]?.needsReview).toBe(true);
    await expect(
      service.confirm(tenantId, { requestId: pending.requestId, previewId: pending.id }, f.actor),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await service.confirm(tenantId, { requestId: p.requestId, previewId: p.id }, f.actor),
    ).toEqual(receipt);
  });

  it("a reached explicit empty choice marks unselected devices even when capacity is sufficient", async () => {
    const f = await fixture(),
      p = await preview(f, []);
    await service.confirm(f.tenantId, { requestId: p.requestId, previewId: p.id }, f.actor);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(f.boundary);
    expect((await service.inspect(f.tenantId, f.actor)).currentShadow).toEqual({
      enforced: false,
      awaitingSelection: false,
      affectedDeviceIds: [f.device.id],
    });
  });

  it.each(
    ["change_first", "confirm_first"].flatMap((order) =>
      ["timeline", "pairing", "cancel", "replacement"].map((change) => ({ order, change })),
    ),
  )("serializes $change against confirm in $order order", async ({ order, change }) => {
    const f = await fixture();
    const replacements = new DeviceReplacementService(db, entitlements, new PlatformAuditService());
    const [reserved] = await db
      .insert(schema.stationDevices)
      .values({ tenantId: f.tenantId, name: "Reserve" })
      .returning();
    if (!reserved) throw new Error("fixture");
    await db.transaction((tx) => transitionWorkingAssignment(tx, reserved));
    const replacement = await replacements.preview(f.tenantId, f.device.id, f.intent, f.actor);
    const prepared = await replacements.confirm(
      f.tenantId,
      f.device.id,
      { requestId: replacement.requestId, previewId: replacement.id },
      f.actor,
    );
    const p = await preview(f),
      body = { requestId: p.requestId, previewId: p.id };
    const blocker = await connection.pool.connect();
    const mutation = async (client: typeof blocker) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1),$2)", [
        `subscription-quota:${f.tenantId}`,
        2,
      ]);
      if (change === "timeline") {
        await client.query("select pg_advisory_xact_lock(hashtext($1),0)", [
          `subscription-timeline:${f.tenantId}`,
        ]);
        await client.query(
          "update tenant_subscriptions set ends_at=ends_at+interval '1 second' where id=$1",
          [f.current.subscriptionId],
        );
        await client.query(
          "update tenant_subscriptions set starts_at=starts_at+interval '1 second' where id=$1",
          [f.future.subscriptionId],
        );
      } else if (change === "pairing") {
        await client.query("update station_devices set paired_at=now() where id=$1", [reserved.id]);
        await client.query(
          "update working_device_assignments set state='assigned',revision=revision+1 where device_id=$1",
          [reserved.id],
        );
      } else if (change === "cancel") {
        await client.query("select id from station_devices where id=$1 for update", [reserved.id]);
        await client.query(
          "update working_device_assignments set state='released',release_reason='reservation_cancelled',released_at=now(),revision=revision+1 where device_id=$1",
          [reserved.id],
        );
      } else {
        await client.query(
          "update working_device_replacement_preparations set state='cancelled',revision=revision+1,cancelled_at=now(),cancelled_actor_domain='cabinet',cancelled_actor_id=$2 where id=$1",
          [prepared.preparation.id, f.actor.id],
        );
      }
    };
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]
        ?.pid;
      if (pid === undefined) throw new Error("fixture");
      if (order === "change_first") {
        await mutation(blocker);
        const result = service.confirm(f.tenantId, body, f.actor).catch((error: unknown) => error);
        await waitBlocked(pid);
        await blocker.query("COMMIT");
        expect(await result).toMatchObject({ status: 409 });
        expect(
          await db
            .select()
            .from(schema.workingDeviceRetentionEvents)
            .where(eq(schema.workingDeviceRetentionEvents.tenantId, f.tenantId)),
        ).toHaveLength(0);
      } else {
        await blocker.query("select id from member where user_id=$1 for update", [f.actor.id]);
        const result = service.confirm(f.tenantId, body, f.actor);
        const confirmingPid = await waitBlocked(pid),
          writer = await connection.pool.connect();
        try {
          await writer.query("BEGIN");
          const change = mutation(writer);
          await waitBlocked(confirmingPid);
          await blocker.query("COMMIT");
          const receipt = await result;
          expect(receipt.selection.revision).toBe(1);
          await change;
          await writer.query("COMMIT");
          expect((await service.inspect(f.tenantId, f.actor)).selections[0]?.needsReview).toBe(
            true,
          );
          expect(await service.confirm(f.tenantId, body, f.actor)).toEqual(receipt);
        } finally {
          await writer.query("ROLLBACK");
          writer.release();
        }
      }
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });
  it.each(["plan", "addon", "source", "credential", "new_device", "policy", "revision"] as const)(
    "invalidates preview and preserves receipt under changed %s",
    async (change) => {
      if (change === "source") {
        const nodeNow = new Date(Date.now() - 60_000);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(nodeNow);
      }
      const f = await fixture(),
        actor = await platformActor();
      const policyId = randomUUID();
      await db.insert(schema.entitlementLifecyclePolicies).values({
        id: policyId,
        policyKey: policyId,
        version: 1,
        status: "draft",
        payload: { stage: "draft" },
        payloadHash: "a".repeat(64),
        createdByPlatformUserId: actor.principal.userId,
      });
      const planVersionId = await createPublishedPlan(db, {
        maxStations: 1,
        maxLines: 1,
        maxKiosks: 1,
        maxCabinetUsers: 1,
        lifecyclePolicyId: policyId,
      });
      await db
        .update(schema.tenantSubscriptions)
        .set({ planVersionId })
        .where(eq(schema.tenantSubscriptions.id, f.future.subscriptionId));
      const source = await grant(
        f,
        f.future.subscriptionId,
        [{ key: "handheld", featureEnabled: true }],
        new Date(Date.now() + 3600_000),
      );
      const keyId = randomUUID();
      await db.insert(schema.apikey).values({
        id: keyId,
        referenceId: f.actor.id,
        key: "test-only-digest",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db
        .update(schema.stationDevices)
        .set({ apiKeyId: keyId })
        .where(eq(schema.stationDevices.id, f.device.id));
      const p = await preview(f),
        receipt = await service.confirm(
          f.tenantId,
          { requestId: p.requestId, previewId: p.id },
          f.actor,
        );
      const pending = await preview(f, [], 1);
      if (change === "plan") {
        const planVersionId = await createPublishedPlan(db, {
          maxStations: 0,
          maxLines: 1,
          maxKiosks: 1,
          maxCabinetUsers: 1,
        });
        await db
          .update(schema.tenantSubscriptions)
          .set({ planVersionId })
          .where(eq(schema.tenantSubscriptions.id, f.future.subscriptionId));
      } else if (change === "addon") {
        const addonVersionId = await createPublishedAddon(db, [
          { entitlementKey: "stations", increment: 1 },
        ]);
        await db.insert(schema.subscriptionAddons).values({
          tenantId: f.tenantId,
          subscriptionId: f.future.subscriptionId,
          addonVersionId,
          quantity: 1,
          source: "manual",
          status: "scheduled",
          startsAt: f.boundary,
        });
      } else if (change === "source") {
        await db
          .update(schema.entitlementSources)
          .set({
            revokedAt: new Date(),
            revokedByPlatformUserId: actor.principal.userId,
            revocationReason: "Test change",
            revocationDecisionReference: "TEST-REVOKE",
            revocationRequestId: randomUUID(),
          })
          .where(eq(schema.entitlementSources.id, source.id));
      } else if (change === "credential")
        await db.update(schema.apikey).set({ enabled: false }).where(eq(schema.apikey.id, keyId));
      else if (change === "new_device") {
        const [device] = await db
          .insert(schema.stationDevices)
          .values({ tenantId: f.tenantId, name: "New" })
          .returning();
        if (!device) throw new Error("fixture");
        await db.transaction((tx) => transitionWorkingAssignment(tx, device));
      } else if (change === "policy")
        await db
          .update(schema.entitlementLifecyclePolicies)
          .set({ payload: { stage: "changed" }, payloadHash: "b".repeat(64) })
          .where(eq(schema.entitlementLifecyclePolicies.id, policyId));
      else
        await db
          .insert(schema.entitlementRevisions)
          .values({ tenantId: f.tenantId, revision: 99n, usageRevision: 0n })
          .onConflictDoUpdate({
            target: schema.entitlementRevisions.tenantId,
            set: { revision: 99n },
          });
      await expect(
        service.confirm(
          f.tenantId,
          { requestId: pending.requestId, previewId: pending.id },
          f.actor,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await service.confirm(f.tenantId, { requestId: p.requestId, previewId: p.id }, f.actor),
      ).toEqual(receipt);
      expect((await service.inspect(f.tenantId, f.actor)).selections[0]?.needsReview).toBe(
        change !== "revision",
      );
    },
  );

  it.each(["retention", "replacement"] as const)(
    "observes a newly inserted %s intent committed while waiting for quota locks",
    async (winner) => {
      const f = await fixture(),
        actor = await platformActor();
      const delayedAudit = new PlatformAuditService(),
        record = delayedAudit.record.bind(delayedAudit);
      const entered = deferred<number>(),
        release = deferred<void>();
      vi.spyOn(delayedAudit, "record").mockImplementation(async (tx, event) => {
        await record(tx, event);
        // Audit's narrowed interface deliberately exposes only insert. Query PID
        // through a bounded pool lookup of the unique uncommitted transaction later.
        entered.resolve(0);
        await release.promise;
      });
      const retention = new DeviceRetentionService(db, entitlements, delayedAudit);
      const replacement = new DeviceReplacementService(db, entitlements, delayedAudit);
      const inspection = await service.inspect(f.tenantId, actor);
      if (!inspection.observation) throw new Error("fixture");
      const p = await service.preview(
        f.tenantId,
        {
          requestId: randomUUID(),
          boundaryKey: inspection.observation.boundary.key,
          expectedRevision: 0,
          selectedDeviceIds: [f.device.id],
          reason: "Choice",
        },
        actor,
      );
      const replacements = new DeviceReplacementService(
        db,
        entitlements,
        new PlatformAuditService(),
      );
      const q = await replacements.preview(f.tenantId, f.device.id, f.intent, actor);
      const first =
        winner === "retention"
          ? retention.confirm(f.tenantId, { requestId: p.requestId, previewId: p.id }, actor)
          : replacement.confirm(
              f.tenantId,
              f.device.id,
              { requestId: q.requestId, previewId: q.id },
              actor,
            );
      try {
        await entered.promise;
        const winnerPid = (
          await connection.pool.query<{ pid: number }>(
            "select pid from pg_stat_activity where datname=current_database() and state='idle in transaction' and query like 'insert into %platform_audit_events%'",
          )
        ).rows[0]?.pid;
        if (winnerPid === undefined) throw new Error("Missing held writer audit transaction");
        const second =
          winner === "retention"
            ? replacements
                .confirm(
                  f.tenantId,
                  f.device.id,
                  { requestId: q.requestId, previewId: q.id },
                  actor,
                )
                .catch((error: unknown) => error)
            : service
                .confirm(f.tenantId, { requestId: p.requestId, previewId: p.id }, actor)
                .catch((error: unknown) => error);
        await waitBlocked(winnerPid);
        release.resolve();
        await first;
        expect(await second).toMatchObject({ status: 409 });
      } finally {
        release.resolve();
        await first;
      }
    },
  );

  it("allows saving intention in read-only access and shows whole pool awaiting selection without a choice", async () => {
    const f = await fixture();
    await db
      .update(schema.tenantSubscriptions)
      .set({ endsAt: new Date(Date.now() - 1000), status: "expired" })
      .where(eq(schema.tenantSubscriptions.id, f.current.subscriptionId));
    const end = new Date(Date.now() + 120_000);
    await db
      .update(schema.tenantSubscriptions)
      .set({ endsAt: end })
      .where(eq(schema.tenantSubscriptions.id, f.future.subscriptionId));
    const inspected = await service.inspect(f.tenantId, f.actor);
    expect(inspected.observation?.current.current.access).toBe("read_only");
    expect(inspected.observation?.boundary.effectiveAt).toBe(end.toISOString());
    expect(inspected.currentShadow).toEqual({
      awaitingSelection: true,
      affectedDeviceIds: [f.device.id],
      enforced: false,
    });
    const p = await preview(f, []);
    await expect(
      service.confirm(f.tenantId, { requestId: p.requestId, previewId: p.id }, f.actor),
    ).resolves.toMatchObject({ selection: { selectedDeviceIds: [] } });
  });
  it("rejects actual foreign, released and inconsistent assignment identities", async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(preview(f, [other.device.id])).rejects.toMatchObject({ status: 409 });
    await db
      .update(schema.workingDeviceAssignments)
      .set({ state: "reserved" })
      .where(eq(schema.workingDeviceAssignments.deviceId, f.device.id));
    expect((await service.inspect(f.tenantId, f.actor)).observation?.devices[0]).toMatchObject({
      eligible: false,
      reasons: ["device_inconsistent"],
    });
    await expect(preview(f)).rejects.toMatchObject({ status: 409 });
    await db.transaction(async (tx) => {
      const [device] = await tx
        .update(schema.stationDevices)
        .set({ revokedAt: new Date() })
        .where(eq(schema.stationDevices.id, f.device.id))
        .returning();
      if (!device) throw new Error("fixture");
      await transitionWorkingAssignment(tx, device);
    });
    await expect(preview(f)).rejects.toMatchObject({ status: 409 });
    expect((await preview(f, [])).observation.devices).toEqual([]);
  });
});
