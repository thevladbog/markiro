import { buildDuplicateLabelTemplate, productLabelValueDigest } from "@markiro/domain";
import { freezeGrantTask } from "../src/modules/device-grants/frozen-task";
import { seedGrantPolicy } from "./support/grant-policy-fixture";
import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { KiosksService } from "../src/modules/kiosks/kiosks.service";
import { StationDevicesService } from "../src/modules/station-devices/station-devices.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { createOrganization } from "./support/subscription-fixtures";
import { lockCurrentGrantOwner } from "../src/modules/device-grants/credential-epoch";
import { hashDeviceToken } from "../src/pickup/device-token";

describe.skipIf(!process.env.DATABASE_URL)("durable credential generation", () => {
  const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  const db = connection.db;
  const entitlements = new EntitlementsService(db, "managed_only");
  const kiosks = new KiosksService(db, entitlements);
  const stations = new StationDevicesService(db, entitlements);
  afterAll(() => connection.pool.end());
  async function kiosk() {
    const tenantId = await createOrganization(db);
    const [row] = await db
      .insert(schema.kiosks)
      .values({ tenantId, name: "Epoch test" })
      .returning();
    if (!row) throw new Error("fixture");
    return row;
  }
  it("advances for direct kiosk enroll, retains metadata epoch and rejects resets", async () => {
    const row = await kiosk();
    expect(row.credentialEpoch).toBe(1);
    await kiosks.enroll(row.tenantId, row.id);
    await kiosks.enroll(row.tenantId, row.id);
    await kiosks.updateKiosk(row.tenantId, row.id, { name: "Renamed" });
    expect(
      (await db.select().from(schema.kiosks).where(eq(schema.kiosks.id, row.id)))[0]
        ?.credentialEpoch,
    ).toBe(3);
    await expect(
      db.update(schema.kiosks).set({ credentialEpoch: 1 }).where(eq(schema.kiosks.id, row.id)),
    ).rejects.toThrow();
  });
  it("invalidates kiosk unbind once and does not resurrect on repeated operations", async () => {
    const row = await kiosk();
    await kiosks.enroll(row.tenantId, row.id);
    await kiosks.unbindKiosk(row.tenantId, row.id);
    await kiosks.unbindKiosk(row.tenantId, row.id);
    const [saved] = await db.select().from(schema.kiosks).where(eq(schema.kiosks.id, row.id));
    expect(saved?.credentialEpoch).toBe(3);
    expect(saved?.deviceTokenHash).toBeNull();
  });
  it("does not advance credentials in rolled back replacement transactions", async () => {
    const row = await kiosk();
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(schema.kiosks)
          .set({ deviceTokenHash: "test-only-hash" })
          .where(eq(schema.kiosks.id, row.id));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      (await db.select().from(schema.kiosks).where(eq(schema.kiosks.id, row.id)))[0]
        ?.credentialEpoch,
    ).toBe(1);
  });
  it("serializes concurrent kiosk replacement into distinct generations", async () => {
    const row = await kiosk();
    await Promise.all([kiosks.enroll(row.tenantId, row.id), kiosks.enroll(row.tenantId, row.id)]);
    expect(
      (await db.select().from(schema.kiosks).where(eq(schema.kiosks.id, row.id)))[0]
        ?.credentialEpoch,
    ).toBe(3);
  });
  it("revoke of a station changes generation once and preserves retry semantics", async () => {
    const tenantId = await createOrganization(db);
    const [row] = await db
      .insert(schema.stationDevices)
      .values({ tenantId, name: "Station" })
      .returning();
    if (!row) throw new Error("fixture");
    await stations.revoke(tenantId, row.id);
    await stations.revoke(tenantId, row.id);
    expect(
      (await db.select().from(schema.stationDevices).where(eq(schema.stationDevices.id, row.id)))[0]
        ?.credentialEpoch,
    ).toBe(2);
  });
  it.each(["station", "handheld"] as const)(
    "freezes raw nullable shift capacities for %s, without product defaults",
    async (kind) => {
      const tenantId = await createOrganization(db),
        deviceId = randomUUID(),
        productId = randomUUID(),
        shiftId = randomUUID();
      await db
        .insert(schema.stationDevices)
        .values({ id: deviceId, tenantId, kind, name: "Raw capacity", apiKeyId: randomUUID() });
      await db.insert(schema.products).values({
        id: productId,
        tenantId,
        name: "Product defaults",
        gtin14: "04680089900383",
        boxCapacity: 10,
        palletBoxCapacity: 20,
      });
      await db.insert(schema.shifts).values({
        id: shiftId,
        tenantId,
        productId,
        mode: "validation",
        status: "active",
        numberMonthKey: "SEP26",
        numberSeq: 1,
        boxCapacity: null,
        palletsEnabled: true,
        palletBoxCapacity: null,
      });
      await db.insert(schema.shiftDeviceParticipants).values({ tenantId, shiftId, deviceId });
      const policy = await seedGrantPolicy(db, {
        shift: {
          "shift.scan.v1": { maxEvents: 2, maxUnits: 2 },
          "shift.close.v1": { maxEvents: 1 },
          "shift.pallet.close.v1": { maxEvents: 1, maxContainers: 1 },
        },
      });
      const frozen = await db.transaction((tx) =>
        freezeGrantTask(
          tx,
          { tenantId, deviceId, kind, credentialEpoch: 1 },
          { taskKind: "shift", taskId: shiftId },
          policy,
        ),
      );
      if (frozen.status !== "ready") throw new Error("Expected source");
      const [saved] = await db
        .select()
        .from(schema.deviceGrantTaskSources)
        .where(eq(schema.deviceGrantTaskSources.id, frozen.sourceId));
      expect(saved?.scope.shift).toMatchObject({ boxCapacity: null, palletBoxCapacity: null });
    },
  );
  it("requires explicit shift limits and retains old frozen identity after task edits", async () => {
    const tenantId = await createOrganization(db),
      deviceId = randomUUID(),
      productId = randomUUID(),
      shiftId = randomUUID();
    await db
      .insert(schema.stationDevices)
      .values({ id: deviceId, tenantId, name: "Shift", apiKeyId: randomUUID() });
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, name: "Product", gtin14: "04680089900383" });
    await db.insert(schema.shifts).values({
      id: shiftId,
      tenantId,
      productId,
      mode: "validation",
      status: "active",
      numberMonthKey: "SEP26",
      numberSeq: 1,
      plannedQty: 100,
      productionDate: "2026-09-10",
    });
    await db.insert(schema.shiftDeviceParticipants).values({ tenantId, shiftId, deviceId });
    const owner = { tenantId, deviceId, kind: "station" as const, credentialEpoch: 1 };
    const reference = { taskKind: "shift" as const, taskId: shiftId };
    const empty = await seedGrantPolicy(db, {});
    expect(await db.transaction((tx) => freezeGrantTask(tx, owner, reference, empty))).toEqual({
      status: "denied",
      reason: "bounds_required",
    });
    const policy = await seedGrantPolicy(db, {
      shift: { "shift.scan.v1": { maxEvents: 4, maxUnits: 3 }, "shift.close.v1": { maxEvents: 0 } },
    });
    const before = await db.transaction((tx) => freezeGrantTask(tx, owner, reference, policy));
    expect(before).toMatchObject({
      status: "ready",
      task: {
        budget: [
          { id: "shift.scan.v1:events", maximum: 4 },
          { id: "shift.scan.v1:units", maximum: 3 },
          { id: "shift.close.v1:events", maximum: 0 },
        ],
      },
    });
    await db.update(schema.shifts).set({ plannedQty: 200 }).where(eq(schema.shifts.id, shiftId));
    await db
      .update(schema.products)
      .set({ unitPrice: "10.00", externalRef: "changed-reference" })
      .where(eq(schema.products.id, productId));
    expect(await db.transaction((tx) => freezeGrantTask(tx, owner, reference, policy))).toEqual(
      before,
    );
    await db
      .update(schema.shifts)
      .set({ productionDate: "2026-09-11" })
      .where(eq(schema.shifts.id, shiftId));
    const after = await db.transaction((tx) => freezeGrantTask(tx, owner, reference, policy));
    if (before.status !== "ready" || after.status !== "ready")
      throw new Error("Expected frozen sources");
    expect(after.sourceId).not.toBe(before.sourceId);
    expect(after.task.snapshotDigest).not.toBe(before.task.snapshotDigest);
    expect(after.task.budget).toEqual(before.task.budget);
    const [source] = await db
      .select()
      .from(schema.deviceGrantTaskSources)
      .where(eq(schema.deviceGrantTaskSources.id, before.sourceId));
    expect(source?.scope).toMatchObject({ shift: { productionDate: "2026-09-10" } });
    expect(source?.scope.shift).not.toHaveProperty("plannedQty");
    expect(source?.scope.shift).toMatchObject({ counterpartyName: null });
    const [priorPolicy] = await db
      .select()
      .from(schema.entitlementLifecyclePolicies)
      .where(eq(schema.entitlementLifecyclePolicies.id, policy.id));
    if (!priorPolicy) throw new Error("Policy fixture missing");
    const renewal = await seedGrantPolicy(
      db,
      {
        shift: {
          "shift.scan.v1": { maxEvents: 8, maxUnits: 6 },
          "shift.close.v1": { maxEvents: 1 },
        },
      },
      { policyKey: priorPolicy.policyKey, version: 2 },
    );
    const renewed = await db.transaction((tx) => freezeGrantTask(tx, owner, reference, renewal));
    if (renewed.status !== "ready") throw new Error("Expected renewed source");
    expect(renewed.sourceId).not.toBe(after.sourceId);
    expect(renewed.task.snapshotDigest).toBe(after.task.snapshotDigest);
    expect(renewed.task.budget).not.toEqual(after.task.budget);
    const [originalPolicySource] = await db
      .select()
      .from(schema.deviceGrantTaskSources)
      .where(eq(schema.deviceGrantTaskSources.id, after.sourceId));
    expect(originalPolicySource?.policyId).toBe(policy.id);
    expect(originalPolicySource?.budget).toEqual(after.task.budget);
    await db
      .update(schema.products)
      .set({ shelfLifeDays: 4 })
      .where(eq(schema.products.id, productId));
    const changedProduct = await db.transaction((tx) =>
      freezeGrantTask(tx, owner, reference, renewal),
    );
    if (changedProduct.status !== "ready") throw new Error("Expected product source");
    expect(changedProduct.task.snapshotDigest).not.toBe(renewed.task.snapshotDigest);
    const templateId = randomUUID();
    const templateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "zpl" as const,
      elements: [],
    };
    await db
      .insert(schema.labelTemplates)
      .values({ id: templateId, tenantId, name: "Original template", spec: templateSpec });
    await db
      .update(schema.shifts)
      .set({ boxLabelTemplateId: templateId })
      .where(eq(schema.shifts.id, shiftId));
    const withTemplate = await db.transaction((tx) =>
      freezeGrantTask(tx, owner, reference, renewal),
    );
    if (withTemplate.status !== "ready") throw new Error("Expected template source");
    expect(withTemplate.task.snapshotDigest).not.toBe(changedProduct.task.snapshotDigest);
    await db
      .update(schema.labelTemplates)
      .set({ name: "Renamed template" })
      .where(eq(schema.labelTemplates.id, templateId));
    expect(await db.transaction((tx) => freezeGrantTask(tx, owner, reference, renewal))).toEqual(
      withTemplate,
    );
    await db
      .update(schema.labelTemplates)
      .set({ spec: { ...templateSpec, widthMm: 60 } })
      .where(eq(schema.labelTemplates.id, templateId));
    const editedTemplate = await db.transaction((tx) =>
      freezeGrantTask(tx, owner, reference, renewal),
    );
    if (editedTemplate.status !== "ready") throw new Error("Expected edited template source");
    expect(editedTemplate.task.snapshotDigest).not.toBe(withTemplate.task.snapshotDigest);
    const [originalTemplateSource] = await db
      .select()
      .from(schema.deviceGrantTaskSources)
      .where(eq(schema.deviceGrantTaskSources.id, withTemplate.sourceId));
    expect(originalTemplateSource?.scope).toMatchObject({
      templates: [{ id: templateId, spec: { widthMm: 58 } }],
    });
    const counterpartyId = randomUUID();
    await db
      .insert(schema.counterparties)
      .values({ id: counterpartyId, tenantId, name: "Printed customer", gln: "6291041500213" });
    await db.update(schema.shifts).set({ counterpartyId }).where(eq(schema.shifts.id, shiftId));
    const named = await db.transaction((tx) => freezeGrantTask(tx, owner, reference, renewal));
    if (named.status !== "ready") throw new Error("Expected counterparty source");
    await db
      .update(schema.counterparties)
      .set({ name: "Renamed printed customer" })
      .where(eq(schema.counterparties.id, counterpartyId));
    const renamed = await db.transaction((tx) => freezeGrantTask(tx, owner, reference, renewal));
    if (renamed.status !== "ready") throw new Error("Expected renamed source");
    expect(renamed.task.snapshotDigest).not.toBe(named.task.snapshotDigest);
    const [originalName] = await db
      .select()
      .from(schema.deviceGrantTaskSources)
      .where(eq(schema.deviceGrantTaskSources.id, named.sourceId));
    expect(originalName?.scope.shift).toMatchObject({
      counterpartyId,
      counterpartyName: "Printed customer",
    });
    const [newName] = await db
      .select()
      .from(schema.deviceGrantTaskSources)
      .where(eq(schema.deviceGrantTaskSources.id, renamed.sourceId));
    expect(newName?.scope.shift).toMatchObject({
      counterpartyId,
      counterpartyName: "Renamed printed customer",
    });
  });
  it("cannot overflow the persisted epoch", async () => {
    const row = await kiosk();
    // New rows may initialize a high generation for an imported identity, but changing it is forbidden.
    const id = randomUUID();
    await db
      .insert(schema.kiosks)
      .values({ id, tenantId: row.tenantId, name: "Boundary", credentialEpoch: 2147483647 });
    await expect(
      db
        .update(schema.kiosks)
        .set({ deviceTokenHash: "different" })
        .where(eq(schema.kiosks.id, id)),
    ).rejects.toThrow();
    expect(
      (await db.execute(sql`select credential_epoch from kiosks where id=${id}`)).rows[0],
    ).toMatchObject({ credential_epoch: 2147483647 });
  });
  it("blocks issuance in the station key-deleted-before-device-revoke gap", async () => {
    const tenantId = await createOrganization(db),
      id = randomUUID(),
      keyId = randomUUID();
    await db.insert(schema.apikey).values({
      id: keyId,
      referenceId: tenantId,
      configId: "station",
      key: "test-only",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.stationDevices).values({ id, tenantId, name: "Live", apiKeyId: keyId });
    const identity = { tenantId, deviceId: id, kind: "station" as const, apiKeyId: keyId };
    expect(
      await db.transaction((tx) => lockCurrentGrantOwner(tx, identity, Date.now())),
    ).toMatchObject({ credentialEpoch: 1 });
    await db.delete(schema.apikey).where(eq(schema.apikey.id, keyId));
    expect(
      await db.transaction((tx) => lockCurrentGrantOwner(tx, identity, Date.now())),
    ).toBeNull();
    expect(
      (await db.select().from(schema.stationDevices).where(eq(schema.stationDevices.id, id)))[0]
        ?.revokedAt,
    ).toBeNull();
  });
  it("serializes locked issuance ownership against direct enrollment and rejects stale credentials", async () => {
    const row = await kiosk();
    const token = await kiosks.enroll(row.tenantId, row.id);
    const identity = {
      tenantId: row.tenantId,
      deviceId: row.id,
      kind: "kiosk" as const,
      tokenHash: hashDeviceToken(token.token),
    };
    let release = () => {};
    let acquired = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const issue = db.transaction(async (tx) => {
      const owner = await lockCurrentGrantOwner(tx, identity, Date.now());
      acquired();
      await held;
      return owner;
    });
    await locked;
    const replacement = kiosks.enroll(row.tenantId, row.id);
    try {
      let waited = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const found = await connection.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%kiosks%' AND pid<>pg_backend_pid()",
        );
        if (found.rowCount) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waited).toBe(true);
    } finally {
      release();
    }
    expect(await issue).toMatchObject({ credentialEpoch: 2 });
    await replacement;
    expect(
      await db.transaction((tx) => lockCurrentGrantOwner(tx, identity, Date.now())),
    ).toBeNull();
  });
  it.each(["station", "handheld"] as const)(
    "binds the validation reprocessing policy bit for %s without rewriting history",
    async (kind) => {
      const tenantId = await createOrganization(db),
        deviceId = randomUUID(),
        productId = randomUUID(),
        shiftId = randomUUID(),
        templateId = randomUUID();
      await db
        .insert(schema.stationDevices)
        .values({ id: deviceId, tenantId, kind, name: "Policy snapshot", apiKeyId: randomUUID() });
      await db
        .insert(schema.products)
        .values({ id: productId, tenantId, gtin14: "04600000000015", name: "Product" });
      const spec = buildDuplicateLabelTemplate();
      await db.insert(schema.labelTemplates).values({
        id: templateId,
        tenantId,
        name: "Duplicate",
        purpose: "product_duplicate",
        spec,
      });
      await db.insert(schema.shifts).values({
        id: shiftId,
        tenantId,
        productId,
        mode: "validation",
        status: "active",
        numberMonthKey: "SEP26",
        numberSeq: 1,
        validationPrintMode: "duplicate_dm",
        validationPrintVerification: "required",
        validationPrintTemplateId: templateId,
        validationPrintSnapshot: { spec, digest: productLabelValueDigest(spec) },
        validationPrintPolicyRevision: randomUUID(),
        allowPreviouslyAcceptedCodes: false,
      });
      await db.insert(schema.shiftDeviceParticipants).values({ tenantId, shiftId, deviceId });
      const policy = await seedGrantPolicy(db, {
        shift: {
          "shift.scan.v1": { maxEvents: 2, maxUnits: 2 },
          "shift.close.v1": { maxEvents: 0 },
          "shift.label.prepare.v1": { maxEvents: 2, maxUnits: 2 },
        },
      });
      const owner = { tenantId, deviceId, kind, credentialEpoch: 1 },
        reference = { taskKind: "shift" as const, taskId: shiftId };
      const before = await db.transaction((tx) => freezeGrantTask(tx, owner, reference, policy));
      await db
        .update(schema.shifts)
        .set({ allowPreviouslyAcceptedCodes: true })
        .where(eq(schema.shifts.id, shiftId));
      const after = await db.transaction((tx) => freezeGrantTask(tx, owner, reference, policy));
      if (before.status !== "ready" || after.status !== "ready")
        throw new Error("Expected frozen policy sources");
      expect(after.task.snapshotDigest).not.toBe(before.task.snapshotDigest);
      expect(after.sourceId).not.toBe(before.sourceId);
      expect(after.task.budget).toEqual(before.task.budget);
      const [oldSource] = await db
        .select()
        .from(schema.deviceGrantTaskSources)
        .where(eq(schema.deviceGrantTaskSources.id, before.sourceId));
      const [newSource] = await db
        .select()
        .from(schema.deviceGrantTaskSources)
        .where(eq(schema.deviceGrantTaskSources.id, after.sourceId));
      expect(oldSource?.scope.shift).toMatchObject({ allowPreviouslyAcceptedCodes: false });
      expect(newSource?.scope.shift).toMatchObject({ allowPreviouslyAcceptedCodes: true });
    },
  );
});
