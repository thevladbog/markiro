import { DeviceLicensingService } from "../src/modules/device-licensing/device-licensing.service";
import { StationDevicesService } from "../src/modules/station-devices/station-devices.service";
import { platformCapabilitiesForRole, type PlatformRole } from "@markiro/platform-contracts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DeviceReplacementService } from "../src/modules/device-licensing/device-replacement.service";
import { createDeviceReplacementListFactReader } from "../src/modules/device-licensing/device-replacement-facts";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { transitionWorkingAssignment } from "../src/subscriptions/working-device-assignments";
import {
  createOrganization,
  createManagedSubscription,
  createPublishedPlan,
  createPublishedAddon,
} from "./support/subscription-fixtures";

describe.skipIf(!process.env.DATABASE_URL)("device replacement preparation", () => {
  const name = `replacement_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  const maintenance = createDb(url.toString());
  url.pathname = `/${name}`;
  const connection = createDb(url.toString());
  const db = connection.db;
  const entitlements = new EntitlementsService(db, "managed_only");
  const service = new DeviceReplacementService(db, entitlements, new PlatformAuditService());
  let created = false;
  afterEach(() => vi.useRealTimers());
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
    return {
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
  it("prepares and cancels with exact durable replay and no operational changes", async () => {
    const f = await fixture();
    const credentialId = randomUUID();
    await db.insert(schema.apikey).values({
      id: credentialId,
      referenceId: f.actor.id,
      key: "test-only-key-digest",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(schema.stationDevices)
      .set({ apiKeyId: credentialId })
      .where(eq(schema.stationDevices.id, f.device.id));
    await db.insert(schema.stationPairingCodes).values({
      tenantId: f.tenantId,
      stationDeviceId: f.device.id,
      issuedByUserId: f.actor.id,
      codeHash: "test-only-pairing-digest",
      expiresAt: new Date(Date.now() + 60000),
    });
    const managed = await createManagedSubscription(db, { tenantId: f.tenantId });
    const addonVersionId = await createPublishedAddon(db, [
      { entitlementKey: "stations", increment: 1 },
    ]);
    await db.insert(schema.subscriptionAddons).values({
      tenantId: f.tenantId,
      subscriptionId: managed.subscriptionId,
      addonVersionId,
      quantity: 1,
      source: "manual",
      status: "active",
      startsAt: new Date(Date.now() - 1000),
    });
    const operator = await platformActor();
    const offerId = randomUUID();
    await db.insert(schema.commercialOffers).values({
      id: offerId,
      tenantId: f.tenantId,
      revision: 1,
      createdByPlatformUserId: operator.principal.userId,
    });
    await db.insert(schema.invoices).values({
      tenantId: f.tenantId,
      number: `REPLACEMENT-${randomUUID()}`,
      createdByPlatformUserId: operator.principal.userId,
      sourceOfferId: offerId,
    });

    const before = await operationalRows(f.tenantId);
    const preview = await service.preview(f.tenantId, f.device.id, f.intent, f.actor);
    expect(await operationalRows(f.tenantId)).toEqual(before);
    expect(preview.observation).toMatchObject({
      preparationSlotDelta: 0,
      expectedTransferSlotDelta: 0,
      localData: { journals: "unknown", outbox: "unknown", printWork: "unknown" },
      execution: { available: false },
    });
    expect(JSON.stringify(preview)).not.toContain(f.intent.reason);
    expect(JSON.stringify(preview)).not.toContain(credentialId);
    expect(await service.preview(f.tenantId, f.device.id, f.intent, f.actor)).toEqual(preview);
    const body = { requestId: f.intent.requestId, previewId: preview.id };
    const receipt = await service.confirm(f.tenantId, f.device.id, body, f.actor);
    expect(receipt.preparation.state).toBe("prepared");
    expect(await operationalRows(f.tenantId)).toEqual(before);
    expect((await service.list(f.tenantId, f.actor)).items[0]?.needsReview).toBe(false);
    const cancel = { requestId: randomUUID(), expectedRevision: 1 };
    const cancelled = await service.cancel(f.tenantId, receipt.preparation.id, cancel, f.actor);
    expect(cancelled.preparation).toMatchObject({ state: "cancelled", revision: 2 });
    expect(await service.cancel(f.tenantId, receipt.preparation.id, cancel, f.actor)).toEqual(
      cancelled,
    );
    expect(await service.confirm(f.tenantId, f.device.id, body, f.actor)).toEqual(receipt);
    expect(await operationalRows(f.tenantId)).toEqual(before);
    const events = await db
      .select()
      .from(schema.workingDeviceEvents)
      .where(eq(schema.workingDeviceEvents.requestId, f.intent.requestId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: f.tenantId,
      deviceId: f.device.id,
      actorDomain: "cabinet",
      actorId: f.actor.id,
      action: "replacement_prepared",
      outcome: "success",
      response: receipt,
      after: { state: "prepared" },
    });
  });
  it("lists one coherent read-only snapshot without operational changes", async () => {
    const f = await fixture();
    const p = await service.preview(f.tenantId, f.device.id, f.intent, f.actor);
    await service.confirm(
      f.tenantId,
      f.device.id,
      { requestId: p.requestId, previewId: p.id },
      f.actor,
    );
    const before = await operationalRows(f.tenantId);
    const resolve = entitlements.resolveSnapshotInTransaction.bind(entitlements);
    const snapshot = vi
      .spyOn(entitlements, "resolveSnapshotInTransaction")
      .mockImplementation(async (tenantId, tx) => {
        const settings = await tx.execute<{ read_only: string; isolation: string }>(
          sql`select current_setting('transaction_read_only') as read_only, current_setting('transaction_isolation') as isolation`,
        );
        expect(settings.rows[0]).toEqual({ read_only: "on", isolation: "repeatable read" });
        // Keep the listing transaction open while an independent writer obtains
        // the source/revision locks. Roll back so the side-effect assertion also
        // covers every operational table after the read completes.
        const writer = await connection.pool.connect();
        try {
          await writer.query("BEGIN");
          await writer.query("set local statement_timeout='1000ms'");
          await writer.query("update station_devices set name='Concurrent writer' where id=$1", [
            f.device.id,
          ]);
        } finally {
          await writer.query("ROLLBACK");
          writer.release();
        }
        return resolve(tenantId, tx);
      });
    try {
      expect((await service.list(f.tenantId, f.actor)).items).toHaveLength(1);
      expect(await operationalRows(f.tenantId)).toEqual(before);
    } finally {
      snapshot.mockRestore();
    }
  });
  it("does not create an entitlement revision when listing an empty tenant", async () => {
    const tenantId = await createOrganization(db);
    const actor = await platformActor("support");
    expect(
      await db
        .select()
        .from(schema.entitlementRevisions)
        .where(eq(schema.entitlementRevisions.tenantId, tenantId)),
    ).toEqual([]);
    expect(await service.list(tenantId, actor)).toEqual({ canPrepare: false, items: [] });
    expect(
      await db
        .select()
        .from(schema.entitlementRevisions)
        .where(eq(schema.entitlementRevisions.tenantId, tenantId)),
    ).toEqual([]);
  });
  it("lists committed facts while a device writer holds tenant and source locks", async () => {
    const f = await fixture();
    const p = await service.preview(f.tenantId, f.device.id, f.intent, f.actor);
    await service.confirm(
      f.tenantId,
      f.device.id,
      { requestId: p.requestId, previewId: p.id },
      f.actor,
    );
    const readerUrl = new URL(url);
    readerUrl.searchParams.set("options", "-c statement_timeout=1000");
    const reader = createDb(readerUrl.toString());
    const readService = new DeviceReplacementService(
      reader.db,
      new EntitlementsService(reader.db, "managed_only"),
      new PlatformAuditService(),
    );
    const writer = await connection.pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("select pg_advisory_xact_lock(hashtext($1),$2)", [
        `subscription-quota:${f.tenantId}`,
        2,
      ]);
      await writer.query("update station_devices set name='Uncommitted rename' where id=$1", [
        f.device.id,
      ]);
      const list = await readService.list(f.tenantId, f.actor);
      expect(list.items[0]).toMatchObject({
        needsReview: false,
        preparation: { sourceDeviceId: f.device.id },
      });
      await writer.query("COMMIT");
      expect((await readService.list(f.tenantId, f.actor)).items[0]?.needsReview).toBe(true);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await reader.pool.end();
    }
  });
  it("reads tenant-wide facts once for distinct prepared devices and preserves target fingerprints", async () => {
    const f = await fixture();
    const [second] = await db
      .insert(schema.stationDevices)
      .values({ tenantId: f.tenantId, name: "Second source", pairedAt: new Date() })
      .returning();
    if (!second) throw new Error("fixture");
    await db.transaction((tx) => transitionWorkingAssignment(tx, second));
    for (const [index, device] of [f.device, second].entries()) {
      const p = await service.preview(
        f.tenantId,
        device.id,
        {
          ...f.intent,
          requestId: randomUUID(),
          target: { name: `Replacement ${index}`, kind: index === 0 ? "station" : "handheld" },
        },
        f.actor,
      );
      await service.confirm(
        f.tenantId,
        device.id,
        { requestId: p.requestId, previewId: p.id },
        f.actor,
      );
    }
    const queries: string[] = [];
    const observedDb = drizzle(connection.pool, {
      logger: {
        logQuery(query) {
          queries.push(query);
        },
      },
    });
    const resolver = new EntitlementsService(observedDb, "managed_only");
    const resolve = vi.spyOn(resolver, "resolveSnapshotInTransaction");
    const observedService = new DeviceReplacementService(
      observedDb,
      resolver,
      new PlatformAuditService(),
    );
    const result = await observedService.list(f.tenantId, f.actor);
    expect(result.items.map((item) => item.needsReview)).toEqual([false, false]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(
      queries.filter((query) => query.includes('from "working_device_retention_selections"')),
    ).toHaveLength(1);
    expect(
      queries.filter(
        (query) =>
          query.includes('"station_devices"."name"') &&
          query.includes('"working_device_assignments"."id"'),
      ),
    ).toHaveLength(1);
    expect(queries.some((query) => /for (update|share)|pg_advisory|^insert /i.test(query))).toBe(
      false,
    );
  });
  it("retains the complete target for the same source within a shared fact reader", async () => {
    const f = await fixture();
    await db.transaction(
      async (tx) => {
        const readFacts = createDeviceReplacementListFactReader(tx, f.tenantId, entitlements);
        const first = await readFacts(f.device.id, { name: "First", kind: "station" });
        const renamed = await readFacts(f.device.id, { name: "Second", kind: "station" });
        const handheld = await readFacts(f.device.id, { name: "Second", kind: "handheld" });
        expect(first.observation.target).toEqual({ name: "First", kind: "station" });
        expect(renamed.observation.target).toEqual({ name: "Second", kind: "station" });
        expect(handheld.observation.target).toEqual({ name: "Second", kind: "handheld" });
        expect(new Set([first.fingerprint, renamed.fingerprint, handheld.fingerprint]).size).toBe(
          3,
        );
        expect(await readFacts(f.device.id, { name: "First", kind: "station" })).toEqual(first);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  });
  it("ignores heartbeat time but invalidates durable source and allows stale cancellation", async () => {
    const f = await fixture();
    const preview = await service.preview(f.tenantId, f.device.id, f.intent, f.actor);
    await db
      .update(schema.stationDevices)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.stationDevices.id, f.device.id));
    const receipt = await service.confirm(
      f.tenantId,
      f.device.id,
      { requestId: f.intent.requestId, previewId: preview.id },
      f.actor,
    );
    await db
      .update(schema.stationDevices)
      .set({ name: "Renamed" })
      .where(eq(schema.stationDevices.id, f.device.id));
    expect((await service.list(f.tenantId, f.actor)).items[0]?.needsReview).toBe(true);
    await service.cancel(
      f.tenantId,
      receipt.preparation.id,
      { requestId: randomUUID(), expectedRevision: 1 },
      f.actor,
    );
    const other = await service.preview(
      f.tenantId,
      f.device.id,
      { ...f.intent, requestId: randomUUID() },
      f.actor,
    );
    await db
      .update(schema.stationDevices)
      .set({ name: "Again" })
      .where(eq(schema.stationDevices.id, f.device.id));
    await expect(
      service.confirm(
        f.tenantId,
        f.device.id,
        { requestId: other.requestId, previewId: other.id },
        f.actor,
      ),
    ).rejects.toMatchObject({ response: { code: "device_replacement_stale" } });
  });
  it("rechecks authority, tenant isolation and actor/content-bound request identity", async () => {
    const f = await fixture();
    const other = await fixture();
    const p = await service.preview(f.tenantId, f.device.id, f.intent, f.actor);
    await expect(
      service.preview(f.tenantId, f.device.id, { ...f.intent, reason: "changed" }, f.actor),
    ).rejects.toMatchObject({ response: { code: "device_replacement_request_conflict" } });
    await expect(
      service.preview(
        f.tenantId,
        other.device.id,
        { ...f.intent, requestId: randomUUID() },
        f.actor,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.list(f.tenantId, other.actor)).rejects.toMatchObject({ status: 403 });
    await db.delete(schema.member).where(eq(schema.member.userId, f.actor.id));
    await expect(
      service.confirm(
        f.tenantId,
        f.device.id,
        { requestId: p.requestId, previewId: p.id },
        f.actor,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("replays concurrent unchanged confirmations once and blocks a second preparation", async () => {
    const f = await fixture();
    const previews = await Promise.all([
      service.preview(f.tenantId, f.device.id, f.intent, f.actor),
      service.preview(f.tenantId, f.device.id, f.intent, f.actor),
    ]);
    expect(previews[0]).toEqual(previews[1]);
    const p = previews[0]!;
    const body = { requestId: p.requestId, previewId: p.id };
    const results = await Promise.all([
      service.confirm(f.tenantId, f.device.id, body, f.actor),
      service.confirm(f.tenantId, f.device.id, body, f.actor),
    ]);
    expect(results[0]).toEqual(results[1]);
    await expect(
      service.preview(f.tenantId, f.device.id, { ...f.intent, requestId: randomUUID() }, f.actor),
    ).rejects.toMatchObject({ response: { code: "device_replacement_already_prepared" } });
  });
  it("rejects exact expiry, changed source binding and changed pool facts", async () => {
    const f = await fixture();
    const preview = await service.preview(f.tenantId, f.device.id, f.intent, f.actor);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(preview.expiresAt));
    await expect(
      service.confirm(
        f.tenantId,
        f.device.id,
        { requestId: preview.requestId, previewId: preview.id },
        f.actor,
      ),
    ).rejects.toMatchObject({ response: { code: "device_replacement_stale" } });
    vi.useRealTimers();
    for (const field of ["credential", "pool"] as const) {
      const p = await service.preview(
        f.tenantId,
        f.device.id,
        { ...f.intent, requestId: randomUUID() },
        f.actor,
      );
      if (field === "credential")
        await db
          .update(schema.stationDevices)
          .set({ apiKeyId: randomUUID() })
          .where(eq(schema.stationDevices.id, f.device.id));
      else
        await db
          .update(schema.workingDeviceAssignments)
          .set({ revision: 7 })
          .where(eq(schema.workingDeviceAssignments.deviceId, f.device.id));
      await expect(
        service.confirm(
          f.tenantId,
          f.device.id,
          { requestId: p.requestId, previewId: p.id },
          f.actor,
        ),
      ).rejects.toMatchObject({ response: { code: "device_replacement_stale" } });
    }
  });
  it.each([0, null])(
    "prepares with limit %s, bounds preview at next commercial boundary, and preserves sales",
    async (limit) => {
      const f = await fixture();
      const endsAt = new Date(Date.now() + 120000);
      const subscription = await createManagedSubscription(db, {
        tenantId: f.tenantId,
        maxStations: limit,
        endsAt,
      });
      const before = await db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
      const p = await service.preview(
        f.tenantId,
        f.device.id,
        { ...f.intent, target: { name: "Handheld", kind: "handheld" } },
        f.actor,
      );
      expect(p.expiresAt).toBe(endsAt.toISOString());
      expect(p.observation.limit).toBe(limit);
      expect(p.observation.execution.reasons).toContain("handheld_unavailable");
      expect(p.observation.execution.reasons.includes("capacity_unavailable")).toBe(limit === 0);
      await service.confirm(
        f.tenantId,
        f.device.id,
        { requestId: p.requestId, previewId: p.id },
        f.actor,
      );
      expect(
        await db
          .select()
          .from(schema.tenantSubscriptions)
          .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId)),
      ).toEqual(before);
      expect(subscription.subscriptionId).toBe(before[0]?.id);
    },
  );
  it("invalidates changed plan, add-on and lifecycle policy identity", async () => {
    const f = await fixture();
    const sub = await createManagedSubscription(db, { tenantId: f.tenantId });
    for (const change of ["plan", "addon", "policy"] as const) {
      const p = await service.preview(
        f.tenantId,
        f.device.id,
        { ...f.intent, requestId: randomUUID() },
        f.actor,
      );
      if (change === "plan") {
        const planVersionId = await createPublishedPlan(db, {
          maxLines: 1,
          maxStations: 3,
          maxKiosks: 1,
          maxCabinetUsers: 2,
        });
        await db
          .update(schema.tenantSubscriptions)
          .set({ planVersionId })
          .where(eq(schema.tenantSubscriptions.id, sub.subscriptionId));
      } else if (change === "addon") {
        const addonVersionId = await createPublishedAddon(db, [
          { entitlementKey: "stations", increment: 1 },
        ]);
        await db.insert(schema.subscriptionAddons).values({
          tenantId: f.tenantId,
          subscriptionId: sub.subscriptionId,
          addonVersionId,
          quantity: 1,
          source: "manual",
          status: "active",
          startsAt: new Date(Date.now() - 1000),
        });
      } else {
        await db
          .insert(schema.entitlementRevisions)
          .values({ tenantId: f.tenantId, revision: 50n, usageRevision: 0n })
          .onConflictDoUpdate({
            target: schema.entitlementRevisions.tenantId,
            set: { revision: 50n },
          });
      }
      await expect(
        service.confirm(
          f.tenantId,
          f.device.id,
          { requestId: p.requestId, previewId: p.id },
          f.actor,
        ),
      ).rejects.toMatchObject({ response: { code: "device_replacement_stale" } });
    }
  });
  it("accepts security-released paired sources but rejects never-paired sources and inconsistent pools", async () => {
    const f = await fixture();
    await db.transaction(async (tx) => {
      const [device] = await tx
        .update(schema.stationDevices)
        .set({ revokedAt: new Date() })
        .where(eq(schema.stationDevices.id, f.device.id))
        .returning();
      if (!device) throw new Error("fixture");
      await transitionWorkingAssignment(tx, device);
    });
    expect(
      (await service.preview(f.tenantId, f.device.id, f.intent, f.actor)).observation,
    ).toMatchObject({
      source: { state: "released", slotOccupied: false },
      preparationSlotDelta: 0,
      expectedTransferSlotDelta: 1,
    });
    const other = await fixture();
    await db.transaction(async (tx) => {
      const [device] = await tx
        .update(schema.stationDevices)
        .set({ pairedAt: null })
        .where(eq(schema.stationDevices.id, other.device.id))
        .returning();
      if (!device) throw new Error("fixture");
      await transitionWorkingAssignment(tx, device);
    });
    await expect(
      service.preview(other.tenantId, other.device.id, other.intent, other.actor),
    ).rejects.toMatchObject({ response: { code: "device_replacement_source_ineligible" } });
    await db
      .insert(schema.stationDevices)
      .values({ tenantId: f.tenantId, name: "Missing assignment" });
    await expect(
      service.preview(f.tenantId, f.device.id, { ...f.intent, requestId: randomUUID() }, f.actor),
    ).rejects.toMatchObject({ response: { code: "device_replacement_inconsistent" } });
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
  it("requires fresh platform writer and factor, while permitting readers to list", async () => {
    const f = await fixture();
    const actor = await platformActor();
    const p = await service.preview(f.tenantId, f.device.id, f.intent, actor);
    const receipt = await service.confirm(
      f.tenantId,
      f.device.id,
      { requestId: p.requestId, previewId: p.id },
      actor,
    );
    const audits = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.requestId, p.requestId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenantId: f.tenantId,
      actorPlatformUserId: actor.principal.userId,
      actorRole: "platform_admin",
      action: "device.replacement.prepared",
      outcome: "success",
      targetType: "station_device",
      targetId: f.device.id,
      reason: f.intent.reason,
      before: null,
      after: receipt.preparation,
      requestId: p.requestId,
    });
    const cancelBody = { requestId: randomUUID(), expectedRevision: 1 };
    const cancelled = await service.cancel(f.tenantId, receipt.preparation.id, cancelBody, actor);
    const cancelEvents = await db
      .select()
      .from(schema.workingDeviceEvents)
      .where(eq(schema.workingDeviceEvents.requestId, cancelBody.requestId));
    expect(cancelEvents).toHaveLength(1);
    expect(cancelEvents[0]).toMatchObject({
      tenantId: f.tenantId,
      deviceId: f.device.id,
      actorDomain: "platform",
      actorId: actor.principal.userId,
      action: "replacement_cancelled",
      outcome: "success",
      before: receipt.preparation,
      after: cancelled.preparation,
      requestId: cancelBody.requestId,
      response: cancelled,
    });
    expect(cancelEvents[0]?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    const cancelAudits = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.requestId, cancelBody.requestId));
    expect(cancelAudits).toHaveLength(1);
    expect(cancelAudits[0]).toMatchObject({
      tenantId: f.tenantId,
      actorPlatformUserId: actor.principal.userId,
      actorRole: "platform_admin",
      action: "device.replacement.cancelled",
      outcome: "success",
      targetType: "station_device",
      targetId: f.device.id,
      reason: null,
      before: receipt.preparation,
      after: cancelled.preparation,
      requestId: cancelBody.requestId,
    });
    expect(await service.cancel(f.tenantId, receipt.preparation.id, cancelBody, actor)).toEqual(
      cancelled,
    );
    await db
      .delete(schema.platformTwoFactors)
      .where(eq(schema.platformTwoFactors.userId, actor.principal.userId));
    await expect(
      service.confirm(f.tenantId, f.device.id, { requestId: p.requestId, previewId: p.id }, actor),
    ).rejects.toMatchObject({ status: 403 });
    const reader = await platformActor("support");
    expect((await service.list(f.tenantId, reader)).canPrepare).toBe(false);
    await expect(
      service.cancel(
        f.tenantId,
        receipt.preparation.id,
        { requestId: randomUUID(), expectedRevision: 1 },
        reader,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
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
  it.each(
    ["source_first", "confirm_first"].flatMap((order) =>
      ["revoke", "repair", "commercial"].map((change) => ({ order, change })),
    ),
  )("serializes $change in ordering $order", async ({ order, change }) => {
    const f = await fixture();
    const sub = await createManagedSubscription(db, { tenantId: f.tenantId });
    const p = await service.preview(f.tenantId, f.device.id, f.intent, f.actor);
    const mutateSql =
      change === "commercial"
        ? "update tenant_subscriptions set ends_at=ends_at+interval '1 hour' where id=$1"
        : change === "repair"
          ? "update station_devices set paired_at=paired_at+interval '1 second' where id=$1"
          : "update station_devices set revoked_at=now() where id=$1";
    const mutateId = change === "commercial" ? sub.subscriptionId : f.device.id;
    const body = { requestId: p.requestId, previewId: p.id };
    const blocker = await connection.pool.connect();
    let result: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!
        .pid;
      if (order === "source_first") {
        await blocker.query("select pg_advisory_xact_lock(hashtext($1),$2)", [
          `subscription-quota:${f.tenantId}`,
          2,
        ]);
        await blocker.query(mutateSql, [mutateId]);
        if (change === "revoke")
          await blocker.query(
            "update working_device_assignments set state='released',release_reason='security_revoked',revision=revision+1,released_at=now() where device_id=$1",
            [f.device.id],
          );
        result = service
          .confirm(f.tenantId, f.device.id, body, f.actor)
          .catch((error: unknown) => error);
        await waitBlocked(pid);
        await blocker.query("COMMIT");
        expect(await result).toMatchObject({ response: { code: "device_replacement_stale" } });
      } else {
        // Hold membership after confirmation takes the source lock; the second
        // connection proves revoke is waiting on the confirmation transaction.
        await blocker.query("select id from member where user_id=$1 for update", [f.actor.id]);
        result = service.confirm(f.tenantId, f.device.id, body, f.actor);
        const confirmingPid = await waitBlocked(pid);
        const revoker = await connection.pool.connect();
        try {
          await revoker.query("BEGIN");
          const revoke = revoker.query(mutateSql, [mutateId]);
          await waitBlocked(confirmingPid);
          await blocker.query("COMMIT");
          expect(await result).toMatchObject({ preparation: { state: "prepared" } });
          await revoke;
          if (change === "revoke")
            await revoker.query(
              "update working_device_assignments set state='released',release_reason='security_revoked',revision=revision+1,released_at=now() where device_id=$1",
              [f.device.id],
            );
          await revoker.query("COMMIT");
          expect((await service.list(f.tenantId, f.actor)).items[0]?.needsReview).toBe(true);
        } finally {
          await blocker.query("ROLLBACK");
          await revoker.query("ROLLBACK");
          revoker.release();
        }
      }
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
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
    const beforeObservation = await operationalRows(tenantId);
    const p = await service.preview(tenantId, f.device.id, f.intent, f.actor);
    expect(await operationalRows(tenantId)).toEqual(beforeObservation);
    expect(p.observation.knownServerWork).toEqual({
      activeShifts: 1,
      activeInventories: 1,
      printJobs: 1,
      quarantineBatches: 1,
    });
    expect(p.observation.localData).toEqual({
      journals: "unknown",
      outbox: "unknown",
      printWork: "unknown",
    });
    await db
      .update(schema.inventoryDeviceParticipants)
      .set({ heartbeatAt: new Date() })
      .where(eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId));
    expect(await service.preview(tenantId, f.device.id, f.intent, f.actor)).toEqual(p);
    await db
      .update(schema.inventoryDeviceParticipants)
      .set({ pendingEventCount: 0, openBoxCount: 0 })
      .where(eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId));
    await expect(
      service.confirm(tenantId, f.device.id, { requestId: p.requestId, previewId: p.id }, f.actor),
    ).rejects.toMatchObject({ response: { code: "device_replacement_stale" } });
    const refreshed = await service.preview(
      tenantId,
      f.device.id,
      { ...f.intent, requestId: randomUUID() },
      f.actor,
    );
    const protectedRows = await operationalRows(tenantId);
    const confirmBody = { requestId: refreshed.requestId, previewId: refreshed.id };
    const prepared = await service.confirm(tenantId, f.device.id, confirmBody, f.actor);
    expect(await operationalRows(tenantId)).toEqual(protectedRows);
    const cancelBody = { requestId: randomUUID(), expectedRevision: 1 };
    const cancelled = await service.cancel(tenantId, prepared.preparation.id, cancelBody, f.actor);
    expect(await operationalRows(tenantId)).toEqual(protectedRows);
    expect(await service.confirm(tenantId, f.device.id, confirmBody, f.actor)).toEqual(prepared);
    expect(await service.cancel(tenantId, prepared.preparation.id, cancelBody, f.actor)).toEqual(
      cancelled,
    );
    expect(await operationalRows(tenantId)).toEqual(protectedRows);
  });
  it("invalidates edited referenced lifecycle policy with no commercial revision bump", async () => {
    const f = await fixture();
    const actor = await platformActor();
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
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
      lifecyclePolicyId: policyId,
    });
    await createManagedSubscription(db, { tenantId: f.tenantId, planVersionId });
    const p = await service.preview(f.tenantId, f.device.id, f.intent, f.actor);
    await db
      .update(schema.entitlementLifecyclePolicies)
      .set({ payload: { stage: "edited" }, payloadHash: "b".repeat(64) })
      .where(eq(schema.entitlementLifecyclePolicies.id, policyId));
    await expect(
      service.confirm(
        f.tenantId,
        f.device.id,
        { requestId: p.requestId, previewId: p.id },
        f.actor,
      ),
    ).rejects.toMatchObject({ response: { code: "device_replacement_stale" } });
  });
  it("gives two actors one prepared winner and preserves changed cancel request conflicts", async () => {
    const f = await fixture();
    const second = await platformActor();
    const p = await service.preview(f.tenantId, f.device.id, f.intent, f.actor);
    const q = await service.preview(
      f.tenantId,
      f.device.id,
      { ...f.intent, requestId: randomUUID() },
      second,
    );
    const results = await Promise.allSettled([
      service.confirm(
        f.tenantId,
        f.device.id,
        { requestId: p.requestId, previewId: p.id },
        f.actor,
      ),
      service.confirm(f.tenantId, f.device.id, { requestId: q.requestId, previewId: q.id }, second),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.find((row) => row.status === "rejected")).toMatchObject({
      reason: { response: { code: "device_replacement_already_prepared" } },
    });
    const prepared = (await service.list(f.tenantId, f.actor)).items[0]!.preparation;
    const request = { requestId: randomUUID(), expectedRevision: 1 };
    const cancelled = await service.cancel(f.tenantId, prepared.id, request, f.actor);
    expect(await service.cancel(f.tenantId, prepared.id, request, f.actor)).toEqual(cancelled);
    await expect(service.cancel(f.tenantId, prepared.id, request, second)).rejects.toMatchObject({
      response: { code: "device_replacement_request_conflict" },
    });
    await expect(
      service.cancel(f.tenantId, prepared.id, { ...request, expectedRevision: 2 }, f.actor),
    ).rejects.toMatchObject({ response: { code: "device_replacement_request_conflict" } });
  });
  it("retains immutable pairing evidence for a revoked legacy credential-only source", async () => {
    const f = await fixture();
    await db.transaction(async (tx) => {
      const [device] = await tx
        .update(schema.stationDevices)
        .set({ pairedAt: null, apiKeyId: randomUUID() })
        .where(eq(schema.stationDevices.id, f.device.id))
        .returning();
      if (!device) throw new Error("fixture");
      await transitionWorkingAssignment(tx, device);
    });
    await new StationDevicesService(db, entitlements).revoke(f.tenantId, f.device.id, f.actor);
    const preview = await service.preview(f.tenantId, f.device.id, f.intent, f.actor);
    expect(preview.observation.source).toMatchObject({
      state: "released",
      pairedAt: null,
      slotOccupied: false,
    });
    expect(preview.observation.expectedTransferSlotDelta).toBe(1);
  });
  it.each(["role", "user", "factor"] as const)(
    "rejects first confirm after platform %s authority is lost",
    async (loss) => {
      const f = await fixture();
      const actor = await platformActor();
      const p = await service.preview(f.tenantId, f.device.id, f.intent, actor);
      if (loss === "role")
        await db
          .update(schema.platformUsers)
          .set({ role: "support" })
          .where(eq(schema.platformUsers.id, actor.principal.userId));
      else if (loss === "user")
        await db
          .update(schema.platformUsers)
          .set({ status: "suspended" })
          .where(eq(schema.platformUsers.id, actor.principal.userId));
      else
        await db
          .delete(schema.platformTwoFactors)
          .where(eq(schema.platformTwoFactors.userId, actor.principal.userId));
      await expect(
        service.confirm(
          f.tenantId,
          f.device.id,
          { requestId: p.requestId, previewId: p.id },
          actor,
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        await db
          .select()
          .from(schema.workingDeviceReplacementPreparations)
          .where(eq(schema.workingDeviceReplacementPreparations.tenantId, f.tenantId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(schema.workingDeviceEvents)
          .where(eq(schema.workingDeviceEvents.requestId, p.requestId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(schema.platformAuditEvents)
          .where(eq(schema.platformAuditEvents.requestId, p.requestId)),
      ).toEqual([]);
    },
  );
  it("rejects first confirm after cabinet role loses credentials.manage", async () => {
    const f = await fixture();
    const p = await service.preview(f.tenantId, f.device.id, f.intent, f.actor);
    await db
      .update(schema.member)
      .set({ role: "viewer" })
      .where(eq(schema.member.userId, f.actor.id));
    await expect(
      service.confirm(
        f.tenantId,
        f.device.id,
        { requestId: p.requestId, previewId: p.id },
        f.actor,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("invalidates a credential security change without changing the binding ID", async () => {
    const f = await fixture();
    const credentialId = randomUUID();
    await db.insert(schema.apikey).values({
      id: credentialId,
      referenceId: f.actor.id,
      key: "test-only",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(schema.stationDevices)
      .set({ apiKeyId: credentialId })
      .where(eq(schema.stationDevices.id, f.device.id));
    const p = await service.preview(f.tenantId, f.device.id, f.intent, f.actor);
    await db
      .update(schema.apikey)
      .set({ enabled: false })
      .where(eq(schema.apikey.id, credentialId));
    await expect(
      service.confirm(
        f.tenantId,
        f.device.id,
        { requestId: p.requestId, previewId: p.id },
        f.actor,
      ),
    ).rejects.toMatchObject({ response: { code: "device_replacement_stale" } });
  });
  it.each(["cancel_first", "confirm_first"] as const)(
    "rejects reservation cancellation of paired source with barrier ordering %s",
    async (order) => {
      const f = await fixture();
      const p = await service.preview(f.tenantId, f.device.id, f.intent, f.actor);
      const protectedRows = await operationalRows(f.tenantId);
      const licensing = new DeviceLicensingService(db, entitlements, new PlatformAuditService());
      const body = { requestId: p.requestId, previewId: p.id };
      const blocker = await connection.pool.connect();
      let first: Promise<unknown> | undefined;
      let second: Promise<unknown> | undefined;
      const confirm = () =>
        service.confirm(f.tenantId, f.device.id, body, f.actor).catch((error: unknown) => error);
      const cancel = () =>
        licensing
          .cancel(
            f.tenantId,
            f.device.id,
            { requestId: randomUUID(), expectedRevision: 1 },
            f.actor,
          )
          .catch((error: unknown) => error);
      try {
        await blocker.query("BEGIN");
        const pid = (await blocker.query<{ pid: number }>("select pg_backend_pid() as pid"))
          .rows[0]!.pid;
        await blocker.query("select id from member where user_id=$1 for update", [f.actor.id]);
        first = order === "cancel_first" ? cancel() : confirm();
        await waitBlocked(pid);
        second = order === "cancel_first" ? confirm() : cancel();
        const firstPid = (
          await connection.pool.query<{ pid: number }>(
            "select pid from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid))",
            [pid],
          )
        ).rows[0]!.pid;
        await waitBlocked(firstPid);
        await blocker.query("COMMIT");
        const results = await Promise.all([first, second]);
        expect(results[order === "cancel_first" ? 0 : 1]).toMatchObject({
          response: { code: "device_reservation_not_empty" },
        });
        expect(results[order === "confirm_first" ? 0 : 1]).toMatchObject({
          preparation: { state: "prepared" },
        });
        expect((await entitlements.usage(f.tenantId)).stations).toBe(1);
        expect(await operationalRows(f.tenantId)).toEqual(protectedRows);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await Promise.all([first, second]);
      }
    },
  );
  it("accepts authenticated historical lastSeen evidence on a pre-journal security release only", async () => {
    const f = await fixture();
    for (const observed of [true, false]) {
      const deviceId = randomUUID();
      const assignmentId = randomUUID();
      const eventId = randomUUID();
      const revokedAt = new Date();
      await db.insert(schema.stationDevices).values({
        id: deviceId,
        tenantId: f.tenantId,
        name: "Pre-journal source",
        revokedAt,
        lastSeenAt: observed ? new Date(Date.now() - 1000) : null,
      });
      await db.insert(schema.workingDeviceEvents).values({
        id: eventId,
        tenantId: f.tenantId,
        deviceId,
        actorDomain: "migration",
        action: "observed",
        after: {
          assignmentId,
          state: "released",
          revision: 1,
          releaseReason: "security_revoked",
          releasedAt: revokedAt.toISOString(),
          provenance: "migration",
        },
      });
      await db.insert(schema.workingDeviceAssignments).values({
        id: assignmentId,
        tenantId: f.tenantId,
        deviceId,
        state: "released",
        revision: 1,
        releaseReason: "security_revoked",
        releasedAt: revokedAt,
        provenance: "migration",
        lastEventId: eventId,
      });
      const intent = { ...f.intent, requestId: randomUUID() };
      if (!observed) {
        await expect(service.preview(f.tenantId, deviceId, intent, f.actor)).rejects.toMatchObject({
          response: { code: "device_replacement_source_ineligible" },
        });
        continue;
      }
      const p = await service.preview(f.tenantId, deviceId, intent, f.actor);
      expect(p.observation).toMatchObject({
        source: { state: "released", pairedAt: null, slotOccupied: false },
        localData: { journals: "unknown", outbox: "unknown", printWork: "unknown" },
      });
      await db
        .update(schema.stationDevices)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.stationDevices.id, deviceId));
      expect(await service.preview(f.tenantId, deviceId, intent, f.actor)).toEqual(p);
      await service.confirm(
        f.tenantId,
        deviceId,
        { requestId: p.requestId, previewId: p.id },
        f.actor,
      );
    }
  });
});
