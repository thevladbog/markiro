import { randomUUID } from "node:crypto";
import { createDb, schema, type Db } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { loadEnv } from "../src/env";
import {
  createManagedSubscription,
  createOrganization,
  createPublishedAddon,
  createPublishedPlan,
} from "./support/subscription-fixtures";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

const ready = Boolean(process.env.DATABASE_URL);

describe.skipIf(!ready)("EntitlementsService", () => {
  const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  let db: Db;

  beforeAll(() => {
    db = connection.db;
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  it("adds only compatible interval-contained add-ons and reports exact tenant usage", async () => {
    const at = new Date("2026-08-10T10:00:00.000Z");
    const tenantId = await createOrganization(db);
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 2,
      maxStations: null,
      maxKiosks: 2,
      maxCabinetUsers: 3,
      labelEditorEnabled: true,
    });
    const subscriptionId = randomUUID();
    await db.insert(schema.tenantSubscriptions).values({
      id: subscriptionId,
      tenantId,
      planVersionId,
      status: "active",
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-09-01T00:00:00.000Z"),
      source: "manual",
    });
    const addonVersionId = await createPublishedAddon(db, [
      { entitlementKey: "lines", increment: 3 },
      { entitlementKey: "publicApi" },
    ]);
    await db.insert(schema.subscriptionAddons).values({
      tenantId,
      subscriptionId,
      addonVersionId,
      quantity: 2,
      startsAt: new Date("2026-08-05T00:00:00.000Z"),
      endsAt: new Date("2026-08-20T00:00:00.000Z"),
      status: "active",
      source: "manual",
    });
    const secondAddonVersionId = await createPublishedAddon(db, [
      { entitlementKey: "kiosks", increment: 1 },
      { entitlementKey: "pallets" },
    ]);
    await db.insert(schema.subscriptionAddons).values({
      tenantId,
      subscriptionId,
      addonVersionId: secondAddonVersionId,
      quantity: 3,
      startsAt: new Date("2026-08-05T00:00:00.000Z"),
      endsAt: new Date("2026-08-20T00:00:00.000Z"),
      status: "active",
      source: "manual",
    });
    const futureAddonId = await createPublishedAddon(db, [
      { entitlementKey: "kiosks", increment: 50 },
    ]);
    await db.insert(schema.subscriptionAddons).values({
      tenantId,
      subscriptionId,
      addonVersionId: futureAddonId,
      quantity: 1,
      startsAt: new Date("2026-08-11T00:00:00.000Z"),
      endsAt: new Date("2026-08-20T00:00:00.000Z"),
      status: "scheduled",
      source: "manual",
    });
    const foreign = await createManagedSubscription(db, { maxLines: 1 });
    const wrongParentAddonId = await createPublishedAddon(db, [
      { entitlementKey: "lines", increment: 100 },
    ]);
    await db.insert(schema.subscriptionAddons).values({
      tenantId: foreign.tenantId,
      subscriptionId: foreign.subscriptionId,
      addonVersionId: wrongParentAddonId,
      quantity: 1,
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-08-20T00:00:00.000Z"),
      status: "active",
      source: "manual",
    });
    const wrongParentSubscriptionId = randomUUID();
    await db.insert(schema.tenantSubscriptions).values({
      id: wrongParentSubscriptionId,
      tenantId,
      planVersionId,
      status: "expired",
      startsAt: new Date("2026-07-01T00:00:00.000Z"),
      endsAt: new Date("2026-07-31T00:00:00.000Z"),
      source: "manual",
    });
    const sameTenantWrongParentAddonId = await createPublishedAddon(db, [
      { entitlementKey: "lines", increment: 100 },
    ]);
    await db.insert(schema.subscriptionAddons).values({
      tenantId,
      subscriptionId: wrongParentSubscriptionId,
      addonVersionId: sameTenantWrongParentAddonId,
      quantity: 1,
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-08-20T00:00:00.000Z"),
      status: "active",
      source: "manual",
    });

    await db.insert(schema.lines).values([
      { tenantId, name: "Line 1" },
      { tenantId, name: "Line 2" },
      { tenantId: foreign.tenantId, name: "Foreign line" },
    ]);
    await db.insert(schema.stationDevices).values([
      { tenantId, name: "Live station" },
      { tenantId, name: "Revoked station", revokedAt: at },
    ]);
    await db.insert(schema.kiosks).values([
      { tenantId, name: "Active kiosk", status: "active" },
      { tenantId, name: "Archived kiosk", status: "archived" },
    ]);
    const userId = randomUUID();
    await db.insert(schema.user).values({
      id: userId,
      name: "Member",
      email: `${userId}@example.invalid`,
    });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenantId,
      userId,
      role: "member",
      createdAt: at,
    });
    await db.insert(schema.invitation).values([
      {
        id: randomUUID(),
        organizationId: tenantId,
        email: `${randomUUID()}@example.invalid`,
        role: "member",
        status: "pending",
        expiresAt: new Date("2026-08-11T00:00:00.000Z"),
        inviterId: userId,
      },
      {
        id: randomUUID(),
        organizationId: tenantId,
        email: `${randomUUID()}@example.invalid`,
        role: "member",
        status: "pending",
        expiresAt: at,
        inviterId: userId,
      },
      {
        id: randomUUID(),
        organizationId: tenantId,
        email: `${randomUUID()}@example.invalid`,
        role: "member",
        status: "rejected",
        expiresAt: new Date("2026-08-11T00:00:00.000Z"),
        inviterId: userId,
      },
    ]);

    const service = new EntitlementsService(db, "managed_only");
    await expect(service.resolve(tenantId, undefined, at)).resolves.toEqual({
      tenantId,
      access: "managed",
      subscription: {
        id: subscriptionId,
        planVersionId,
        status: "active",
        startsAt: new Date("2026-08-01T00:00:00.000Z"),
        endsAt: new Date("2026-09-01T00:00:00.000Z"),
      },
      quotas: { lines: 8, stations: null, kiosks: 5, cabinetUsers: 3 },
      features: { labelEditor: true, publicApi: true, pallets: true },
    });
    await expect(service.usage(tenantId, undefined, at)).resolves.toEqual({
      lines: 2,
      stations: 1,
      kiosks: 1,
      cabinetUsers: 2,
    });
    const contributors = await service.contributors(tenantId, undefined, at);
    expect(contributors).toHaveLength(2);
    expect(contributors).toEqual(
      expect.arrayContaining([
        {
          subscriptionAddonId: expect.any(String),
          catalogVersionId: addonVersionId,
          quantity: 2,
          quotas: { lines: 6 },
          features: ["publicApi"],
        },
        {
          subscriptionAddonId: expect.any(String),
          catalogVersionId: secondAddonVersionId,
          quantity: 3,
          quotas: { kiosks: 3 },
          features: ["pallets"],
        },
      ]),
    );
  });

  it("uses timestamps as authority for due scheduled and expired stored statuses", async () => {
    const boundary = new Date("2026-08-10T10:00:00.000Z");
    const tenantId = await createOrganization(db);
    const oldPlan = await createPublishedPlan(db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
    });
    const nextPlan = await createPublishedPlan(db, {
      maxLines: 9,
      maxStations: 8,
      maxKiosks: 7,
      maxCabinetUsers: 6,
    });
    await db.insert(schema.tenantSubscriptions).values([
      {
        tenantId,
        planVersionId: oldPlan,
        status: "active",
        startsAt: new Date("2026-08-01T00:00:00.000Z"),
        endsAt: boundary,
        source: "manual",
      },
      {
        tenantId,
        planVersionId: nextPlan,
        status: "scheduled",
        startsAt: boundary,
        endsAt: new Date("2026-09-10T00:00:00.000Z"),
        source: "manual",
      },
    ]);

    const resolved = await new EntitlementsService(db, "managed_only").resolve(
      tenantId,
      undefined,
      boundary,
    );
    expect(resolved.subscription).toMatchObject({ planVersionId: nextPlan, status: "active" });
    expect(resolved.quotas).toEqual({ lines: 9, stations: 8, kiosks: 7, cabinetUsers: 6 });

    const expired = await createManagedSubscription(db, {
      endsAt: boundary,
      maxLines: 4,
    });
    await expect(
      new EntitlementsService(db, "managed_only").resolve(expired.tenantId, undefined, boundary),
    ).resolves.toMatchObject({
      access: "read_only",
      subscription: { id: expired.subscriptionId, status: "expired", endsAt: boundary },
      quotas: { lines: 0, stations: 0, kiosks: 0, cabinetUsers: 0 },
    });
  });

  it("fails closed for broken managed data and distinguishes rollout modes for unmanaged tenants", async () => {
    const tenantId = await createOrganization(db);
    const itemId = randomUUID();
    const brokenVersionId = randomUUID();
    await db.insert(schema.catalogItems).values({
      id: itemId,
      code: `broken-${itemId}`,
      nameRu: "Broken",
      nameEn: "Broken",
      kind: "plan",
    });
    await db.insert(schema.catalogItemVersions).values({
      id: brokenVersionId,
      catalogItemId: itemId,
      kind: "plan",
      version: 1,
      status: "published",
      nameRu: "Broken",
      nameEn: "Broken",
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "1.00",
      vatIncluded: true,
      publishedAt: new Date(),
    });
    await db.insert(schema.tenantSubscriptions).values({
      tenantId,
      planVersionId: brokenVersionId,
      status: "active",
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 60_000),
      source: "manual",
    });
    const failure = await new EntitlementsService(db, "managed_only")
      .resolve(tenantId)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      status: 500,
      response: { code: "subscription_entitlements_invalid" },
    });

    const unmanagedId = await createOrganization(db);
    await expect(new EntitlementsService(db, "managed_only").resolve(unmanagedId)).resolves.toEqual(
      {
        tenantId: unmanagedId,
        access: "unmanaged",
        subscription: null,
        quotas: { lines: null, stations: null, kiosks: null, cabinetUsers: null },
        features: { labelEditor: true, publicApi: true, pallets: true },
      },
    );
    const allMode = new EntitlementsService(db, "all");
    const allFailure = await db.transaction((tx) =>
      allMode
        .withQuotaSlot(tx, unmanagedId, "lines", async () => "unexpected")
        .catch((error: unknown) => error),
    );
    expect(allFailure).toMatchObject({
      status: 409,
      response: { code: "subscription_unmanaged" },
    });

    expect(
      loadEnv({
        ...process.env,
        ...PLATFORM_TEST_ENV,
        SUBSCRIPTION_ENFORCEMENT_MODE: undefined,
      }),
    ).toHaveProperty("SUBSCRIPTION_ENFORCEMENT_MODE", "managed_only");
    expect(() =>
      loadEnv({
        ...process.env,
        ...PLATFORM_TEST_ENV,
        SUBSCRIPTION_ENFORCEMENT_MODE: "observe",
      }),
    ).toThrow();
  });

  it("fails closed when an active assignment references an unpublished add-on version", async () => {
    const managed = await createManagedSubscription(db, { maxLines: 2 });
    const itemId = randomUUID();
    const addonVersionId = randomUUID();
    await db.insert(schema.catalogItems).values({
      id: itemId,
      code: `draft-addon-${itemId}`,
      nameRu: "Draft add-on",
      nameEn: "Draft add-on",
      kind: "addon",
    });
    await db.insert(schema.catalogItemVersions).values({
      id: addonVersionId,
      catalogItemId: itemId,
      kind: "addon",
      version: 1,
      status: "draft",
      nameRu: "Draft add-on",
      nameEn: "Draft add-on",
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "100.00",
      vatRate: "20.00",
      vatIncluded: true,
    });
    await db.insert(schema.addonEntitlements).values({
      catalogVersionId: addonVersionId,
      entitlementKey: "lines",
      quotaIncrement: 1,
    });
    await db.insert(schema.subscriptionAddons).values({
      tenantId: managed.tenantId,
      subscriptionId: managed.subscriptionId,
      addonVersionId,
      quantity: 1,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 60_000),
      status: "active",
      source: "manual",
    });

    const failure = await new EntitlementsService(db, "managed_only")
      .resolve(managed.tenantId)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 500,
      response: { code: "subscription_entitlements_invalid" },
    });
  });
});
