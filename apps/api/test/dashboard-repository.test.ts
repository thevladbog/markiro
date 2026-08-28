import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { createDb, schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleDashboardRepository } from "../src/modules/dashboard/dashboard.repository";
import { DashboardService } from "../src/modules/dashboard/dashboard.service";

const databaseUrl = process.env.DATABASE_URL;
const NOW = new Date("2026-08-27T12:00:00.000Z");
const DST_NOW = new Date("2026-03-30T10:00:00.000Z");

const TENANT_A = `dashboard-a-${randomUUID()}`;
const TENANT_B = `dashboard-b-${randomUUID()}`;
const BERLIN_TENANT = `dashboard-berlin-${randomUUID()}`;
const INVALID_TIME_ZONE_TENANT = `dashboard-invalid-tz-${randomUUID()}`;
const NO_PROFILE_TENANT = `dashboard-no-profile-${randomUUID()}`;
const LATE_WINDOW_TENANT = `dashboard-late-window-${randomUUID()}`;

const A_VALIDATION_PRODUCT = randomUUID();
const A_AGGREGATION_PRODUCT = randomUUID();
const A_ARCHIVED_PRODUCT = randomUUID();
const A_LINE = randomUUID();
const A_ACTIVE_VALIDATION_SHIFT = randomUUID();
const A_TODAY_AGGREGATION_SHIFT = randomUUID();
const A_OLD_AGGREGATION_SHIFT = randomUUID();

const B_VALIDATION_PRODUCT = randomUUID();
const B_AGGREGATION_PRODUCT = randomUUID();
const B_VALIDATION_SHIFT_WITHOUT_DURATION = randomUUID();
const B_AGGREGATION_SHIFT = randomUUID();

const BERLIN_VALIDATION_PRODUCT = randomUUID();
const BERLIN_VALIDATION_SHIFT = randomUUID();

const NO_PROFILE_PRODUCT = randomUUID();

const LATE_WINDOW_PRODUCT = randomUUID();
const LATE_WINDOW_SHIFT = randomUUID();

const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const HASH_3 = "3".repeat(64);
const HASH_4 = "4".repeat(64);
const HASH_5 = "5".repeat(64);
const HASH_6 = "6".repeat(64);
const HASH_7 = "7".repeat(64);
const HASH_8 = "8".repeat(64);
const HASH_9 = "9".repeat(64);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe.skipIf(!databaseUrl)("tenant dashboard repository", () => {
  const databaseName = `markiro_dashboard_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratchUrl.toString());
  const migrationsFolder = join(__dirname, "../../../packages/db/migrations");

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(connection.db, { migrationsFolder });
    await seedOrganizations(connection.db);
    await seedTenantA(connection.db);
    await seedTenantB(connection.db);
    await seedBerlin(connection.db);
  }, 120_000);

  afterAll(async () => {
    try {
      await connection.pool.end();
    } finally {
      try {
        await maintenance.pool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
      } finally {
        await maintenance.pool.end();
      }
    }
  }, 120_000);

  it("loads one tenant's authoritative today facts and mode-isolated equal-shape windows", async () => {
    const transactionOptions: unknown[] = [];
    const repository = new DrizzleDashboardRepository(
      transactionRecordingDb(connection.db, transactionOptions),
    );

    const facts = await repository.load(TENANT_A, "7d", NOW);

    expect(facts.generatedAt).toEqual(NOW);
    expect(facts.timeZone).toBe("Asia/Yekaterinburg");
    expect(facts.setup).toEqual({
      productCount: 2,
      shiftCount: 3,
      hasRunShift: true,
      activeShiftCount: 1,
    });
    expect(facts.today).toEqual({
      validationAcceptedUnits: 2,
      aggregationClosedBoxes: 1,
      aggregationContainedUnits: 2,
      activeShiftCount: 1,
      includedClosedShiftCount: 1,
    });
    expect(facts.unreviewedConflictCount).toBe(1);
    expect(facts.todayLateDataShiftCount).toBe(1);
    expect(facts.selectedWindowLateDataShiftCount).toBe(1);
    expect(facts.missingDurationModes).toEqual([]);
    expect(facts.activeShifts).toEqual([
      {
        id: A_ACTIVE_VALIDATION_SHIFT,
        number: "AUG26-001/S",
        productName: "Tenant A validation product",
        lineName: "Tenant A line",
        openedAt: "2026-08-26T10:00:00.000Z",
        lateDataAt: null,
        output: { mode: "validation", acceptedUnits: 2 },
      },
    ]);
    expect(JSON.stringify(facts)).not.toContain("Tenant B");
    expect(transactionOptions).toEqual([
      { isolationLevel: "repeatable read", accessMode: "read only" },
    ]);

    expect(facts.currentWindow).toEqual({
      start: "2026-08-20T19:00:00.000Z",
      end: "2026-08-27T12:00:00.000Z",
      validation: {
        acceptedUnits: 2,
        shiftHours: 26,
        unitsPerShiftHour: 0.1,
      },
      aggregation: {
        closedBoxes: 1,
        containedUnits: 2,
        shiftHours: 4,
        boxesPerShiftHour: 0.3,
        containedUnitsPerShiftHour: 0.5,
      },
    });
    expect(facts.comparisonWindow).toEqual({
      start: "2026-08-13T19:00:00.000Z",
      end: "2026-08-20T12:00:00.000Z",
      validation: {
        acceptedUnits: 0,
        shiftHours: 0,
        unitsPerShiftHour: null,
      },
      aggregation: {
        closedBoxes: 1,
        containedUnits: 1,
        shiftHours: 2,
        boxesPerShiftHour: 0.5,
        containedUnitsPerShiftHour: 0.5,
      },
    });
    expect(facts.buckets.map((bucket) => bucket.label)).toEqual([
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
    ]);
    expect(facts.buckets[5]).toMatchObject({
      validation: { acceptedUnits: 1 },
      aggregation: { closedBoxes: 0, containedUnits: 0 },
    });
    expect(facts.buckets[6]).toMatchObject({
      validation: { acceptedUnits: 1 },
      aggregation: { closedBoxes: 1, containedUnits: 2 },
    });
    expect(sum(facts.buckets.map((bucket) => bucket.validation.acceptedUnits))).toBe(2);
    expect(sum(facts.buckets.map((bucket) => bucket.aggregation.closedBoxes))).toBe(1);
    expect(sum(facts.buckets.map((bucket) => bucket.aggregation.containedUnits))).toBe(2);
  });

  it("keeps foreign facts isolated and represents output without eligible duration", async () => {
    const repository = new DrizzleDashboardRepository(connection.db);

    const facts = await repository.load(TENANT_B, "7d", NOW);

    expect(facts.setup).toEqual({
      productCount: 2,
      shiftCount: 2,
      hasRunShift: true,
      activeShiftCount: 0,
    });
    expect(facts.today).toEqual({
      validationAcceptedUnits: 1,
      aggregationClosedBoxes: 1,
      aggregationContainedUnits: 1,
      activeShiftCount: 0,
      includedClosedShiftCount: 2,
    });
    expect(facts.currentWindow.validation).toEqual({
      acceptedUnits: 1,
      shiftHours: 0,
      unitsPerShiftHour: null,
    });
    expect(facts.missingDurationModes).toEqual(["validation"]);
    expect(facts.unreviewedConflictCount).toBe(1);
    expect(facts.todayLateDataShiftCount).toBe(1);
    expect(facts.selectedWindowLateDataShiftCount).toBe(1);
    expect(facts.activeShifts).toEqual([]);
    expect(JSON.stringify(facts)).not.toContain("Tenant A");
  });

  it("uses civil-day bucket edges across the Europe/Berlin spring DST transition", async () => {
    const repository = new DrizzleDashboardRepository(connection.db);

    const facts = await repository.load(BERLIN_TENANT, "7d", DST_NOW);
    const dstBucket = facts.buckets.find((bucket) => bucket.label === "2026-03-29");

    expect(facts.timeZone).toBe("Europe/Berlin");
    expect(facts.currentWindow).toMatchObject({
      start: "2026-03-23T23:00:00.000Z",
      end: "2026-03-30T10:00:00.000Z",
    });
    expect(facts.comparisonWindow).toMatchObject({
      start: "2026-03-16T23:00:00.000Z",
      end: "2026-03-23T11:00:00.000Z",
    });
    expect(dstBucket).toMatchObject({
      start: "2026-03-28T23:00:00.000Z",
      end: "2026-03-29T22:00:00.000Z",
      label: "2026-03-29",
      validation: {
        acceptedUnits: 13,
        shiftHours: 23,
        unitsPerShiftHour: 0.6,
      },
    });
    expect(
      (new Date(dstBucket!.end).getTime() - new Date(dstBucket!.start).getTime()) / 3_600_000,
    ).toBe(23);
    expect(facts.missingDurationModes).toEqual([]);
  });

  it("rejects an invalid timezone stored outside the validated write boundary", async () => {
    const repository = new DrizzleDashboardRepository(connection.db);

    await expect(repository.load(INVALID_TIME_ZONE_TENANT, "today", NOW)).rejects.toThrow(
      "Invalid dashboard timezone",
    );
  });

  it("uses the Moscow fallback for an organization without a profile and does not create one", async () => {
    const repository = new DrizzleDashboardRepository(connection.db);

    expect(
      await connection.db
        .select({ tenantId: schema.orgProfiles.tenantId })
        .from(schema.orgProfiles)
        .where(eq(schema.orgProfiles.tenantId, NO_PROFILE_TENANT)),
    ).toEqual([]);

    const facts = await repository.load(NO_PROFILE_TENANT, "today", NOW);

    expect(facts.timeZone).toBe("Europe/Moscow");
    expect(facts.setup).toEqual({
      productCount: 1,
      shiftCount: 0,
      hasRunShift: false,
      activeShiftCount: 0,
    });
    expect(facts.today).toEqual({
      validationAcceptedUnits: 0,
      aggregationClosedBoxes: 0,
      aggregationContainedUnits: 0,
      activeShiftCount: 0,
      includedClosedShiftCount: 0,
    });
    expect(facts.activeShifts).toEqual([]);
    expect(facts.unreviewedConflictCount).toBe(0);
    expect(facts.todayLateDataShiftCount).toBe(0);
    expect(facts.selectedWindowLateDataShiftCount).toBe(0);
    expect(
      await connection.db
        .select({ tenantId: schema.orgProfiles.tenantId })
        .from(schema.orgProfiles)
        .where(eq(schema.orgProfiles.tenantId, NO_PROFILE_TENANT)),
    ).toEqual([]);
  });

  it("keeps old late data out of today's verdict while marking the selected seven-day window", async () => {
    const repository = new DrizzleDashboardRepository(connection.db);

    const sevenDayFacts = await repository.load(LATE_WINDOW_TENANT, "7d", NOW);
    expect(sevenDayFacts.todayLateDataShiftCount).toBe(0);
    expect(sevenDayFacts.selectedWindowLateDataShiftCount).toBe(1);
    expect(sevenDayFacts.currentWindow.validation).toEqual({
      acceptedUnits: 1,
      shiftHours: 2,
      unitsPerShiftHour: 0.5,
    });

    const service = new DashboardService(repository, () => NOW);
    const sevenDayOverview = await service.overview(LATE_WINDOW_TENANT, "7d");
    expect(sevenDayOverview.verdict).toEqual({ status: "under_control", reasons: [] });
    expect(sevenDayOverview.dynamics.quality).toMatchObject({
      status: "provisional",
      reasons: ["late_data"],
      lateDataShiftCount: 1,
    });

    const todayOverview = await service.overview(LATE_WINDOW_TENANT, "today");
    expect(todayOverview.verdict).toEqual({ status: "under_control", reasons: [] });
    expect(todayOverview.dynamics.quality).toMatchObject({
      status: "complete",
      reasons: [],
      lateDataShiftCount: 0,
    });
  });
});

async function seedOrganizations(db: Db): Promise<void> {
  await db
    .insert(schema.organization)
    .values([
      organization(TENANT_A, "Tenant A"),
      organization(TENANT_B, "Tenant B"),
      organization(BERLIN_TENANT, "Berlin tenant"),
      organization(INVALID_TIME_ZONE_TENANT, "Invalid timezone tenant"),
      organization(NO_PROFILE_TENANT, "No-profile tenant"),
      organization(LATE_WINDOW_TENANT, "Late-window tenant"),
    ]);
  await db.insert(schema.orgProfiles).values([
    { tenantId: TENANT_A, timeZone: "Asia/Yekaterinburg" },
    { tenantId: TENANT_B, timeZone: "Asia/Yekaterinburg" },
    { tenantId: BERLIN_TENANT, timeZone: "Europe/Berlin" },
    { tenantId: INVALID_TIME_ZONE_TENANT, timeZone: "Not/A_Time_Zone" },
    { tenantId: LATE_WINDOW_TENANT, timeZone: "Europe/Moscow" },
  ]);
  await db
    .insert(schema.products)
    .values(product(NO_PROFILE_TENANT, NO_PROFILE_PRODUCT, "04600000000060", "Own product"));
  await db
    .insert(schema.products)
    .values(
      product(LATE_WINDOW_TENANT, LATE_WINDOW_PRODUCT, "04600000000077", "Late-window product"),
    );
  await db.insert(schema.shifts).values({
    ...shift(LATE_WINDOW_TENANT, LATE_WINDOW_SHIFT, LATE_WINDOW_PRODUCT, 1, "validation"),
    status: "closed",
    openedAt: new Date("2026-08-24T07:00:00.000Z"),
    closedAt: new Date("2026-08-24T09:00:00.000Z"),
    lateDataAt: new Date("2026-08-25T10:00:00.000Z"),
  });
  await db
    .insert(schema.codeRegistry)
    .values(registry(LATE_WINDOW_TENANT, LATE_WINDOW_SHIFT, HASH_B, "2026-08-24T08:00:00.000Z"));
}

async function seedTenantA(db: Db): Promise<void> {
  await db.insert(schema.products).values([
    product(TENANT_A, A_VALIDATION_PRODUCT, "04600000000015", "Tenant A validation product"),
    product(TENANT_A, A_AGGREGATION_PRODUCT, "04600000000022", "Tenant A aggregation product"),
    {
      ...product(TENANT_A, A_ARCHIVED_PRODUCT, "04600000000084", "Tenant A archived product"),
      archived: true,
    },
  ]);
  await db.insert(schema.lines).values({ id: A_LINE, tenantId: TENANT_A, name: "Tenant A line" });
  await db.insert(schema.shifts).values([
    {
      ...shift(TENANT_A, A_ACTIVE_VALIDATION_SHIFT, A_VALIDATION_PRODUCT, 1, "validation"),
      lineId: A_LINE,
      status: "active",
      createdFrom: "station",
      openedAt: new Date("2026-08-26T10:00:00.000Z"),
    },
    {
      ...shift(TENANT_A, A_TODAY_AGGREGATION_SHIFT, A_AGGREGATION_PRODUCT, 2, "aggregation"),
      status: "closed",
      openedAt: new Date("2026-08-27T05:00:00.000Z"),
      closedAt: new Date("2026-08-27T09:00:00.000Z"),
      lateDataAt: new Date("2026-08-27T10:00:00.000Z"),
    },
    {
      ...shift(TENANT_A, A_OLD_AGGREGATION_SHIFT, A_AGGREGATION_PRODUCT, 3, "aggregation"),
      status: "closed",
      openedAt: new Date("2026-08-20T08:00:00.000Z"),
      closedAt: new Date("2026-08-20T10:00:00.000Z"),
      lateDataAt: new Date("2026-08-20T11:00:00.000Z"),
    },
  ]);
  await db
    .insert(schema.codeRegistry)
    .values([
      registry(TENANT_A, A_ACTIVE_VALIDATION_SHIFT, HASH_1, "2026-08-26T11:00:00.000Z"),
      registry(TENANT_A, A_ACTIVE_VALIDATION_SHIFT, HASH_2, "2026-08-27T06:00:00.000Z"),
      registry(TENANT_A, A_TODAY_AGGREGATION_SHIFT, HASH_3, "2026-08-27T06:10:00.000Z"),
      registry(TENANT_A, A_TODAY_AGGREGATION_SHIFT, HASH_4, "2026-08-27T06:20:00.000Z"),
      registry(TENANT_A, A_TODAY_AGGREGATION_SHIFT, HASH_5, "2026-08-27T06:30:00.000Z"),
    ]);

  const closedBox = randomUUID();
  const openBox = randomUUID();
  const disassembledBox = randomUUID();
  const comparisonBox = randomUUID();
  const validationShiftBox = randomUUID();
  await db.insert(schema.boxes).values([
    box(TENANT_A, closedBox, A_TODAY_AGGREGATION_SHIFT, "shared-closed", {
      sscc: "046000000000000015",
      closedAt: new Date("2026-08-27T08:00:00.000Z"),
    }),
    box(TENANT_A, openBox, A_TODAY_AGGREGATION_SHIFT, "shared-open"),
    box(TENANT_A, disassembledBox, A_TODAY_AGGREGATION_SHIFT, "shared-disassembled", {
      sscc: "146000000000000012",
      closedAt: new Date("2026-08-27T08:30:00.000Z"),
      disassembledAt: new Date("2026-08-27T09:30:00.000Z"),
    }),
    box(TENANT_A, comparisonBox, A_OLD_AGGREGATION_SHIFT, "comparison", {
      sscc: "246000000000000019",
      closedAt: new Date("2026-08-20T10:00:00.000Z"),
    }),
    box(TENANT_A, validationShiftBox, A_ACTIVE_VALIDATION_SHIFT, "validation-shift-box", {
      sscc: "346000000000000016",
      closedAt: new Date("2026-08-27T07:30:00.000Z"),
    }),
  ]);
  await db.insert(schema.boxItems).values([
    item(TENANT_A, closedBox, HASH_3, "2026-08-27T06:10:00.000Z"),
    item(TENANT_A, closedBox, HASH_4, "2026-08-27T06:20:00.000Z"),
    item(TENANT_A, closedBox, HASH_5, "2026-08-27T06:30:00.000Z", {
      displacedAt: new Date("2026-08-27T06:31:00.000Z"),
    }),
    item(TENANT_A, closedBox, HASH_6, "2026-08-27T06:40:00.000Z", {
      removedAt: new Date("2026-08-27T06:41:00.000Z"),
    }),
    item(TENANT_A, openBox, HASH_7, "2026-08-27T07:00:00.000Z"),
    item(TENANT_A, disassembledBox, HASH_8, "2026-08-27T07:10:00.000Z"),
    item(TENANT_A, comparisonBox, HASH_9, "2026-08-20T09:00:00.000Z"),
    item(TENANT_A, validationShiftBox, HASH_1, "2026-08-27T07:00:00.000Z"),
  ]);
  await db.insert(schema.codeConflicts).values([
    conflict(TENANT_A, A_ACTIVE_VALIDATION_SHIFT, A_OLD_AGGREGATION_SHIFT, HASH_1),
    {
      ...conflict(TENANT_A, A_ACTIVE_VALIDATION_SHIFT, A_TODAY_AGGREGATION_SHIFT, HASH_2),
      reviewedAt: new Date("2026-08-27T11:00:00.000Z"),
    },
  ]);
}

async function seedTenantB(db: Db): Promise<void> {
  await db
    .insert(schema.products)
    .values([
      product(TENANT_B, B_VALIDATION_PRODUCT, "04600000000039", "Tenant B validation product"),
      product(TENANT_B, B_AGGREGATION_PRODUCT, "04600000000046", "Tenant B aggregation product"),
    ]);
  await db.insert(schema.shifts).values([
    {
      ...shift(
        TENANT_B,
        B_VALIDATION_SHIFT_WITHOUT_DURATION,
        B_VALIDATION_PRODUCT,
        1,
        "validation",
      ),
      status: "closed",
      openedAt: null,
      closedAt: new Date("2026-08-27T08:00:00.000Z"),
      lateDataAt: new Date("2026-08-27T09:00:00.000Z"),
    },
    {
      ...shift(TENANT_B, B_AGGREGATION_SHIFT, B_AGGREGATION_PRODUCT, 2, "aggregation"),
      status: "closed",
      openedAt: new Date("2026-08-27T05:00:00.000Z"),
      closedAt: new Date("2026-08-27T09:00:00.000Z"),
    },
  ]);
  await db
    .insert(schema.codeRegistry)
    .values([
      registry(TENANT_B, B_VALIDATION_SHIFT_WITHOUT_DURATION, HASH_1, "2026-08-27T06:00:00.000Z"),
      registry(TENANT_B, B_AGGREGATION_SHIFT, HASH_A, "2026-08-27T06:10:00.000Z"),
    ]);

  const boxId = randomUUID();
  await db.insert(schema.boxes).values(
    box(TENANT_B, boxId, B_AGGREGATION_SHIFT, "shared-closed", {
      sscc: "046000000000000015",
      closedAt: new Date("2026-08-27T08:00:00.000Z"),
    }),
  );
  await db
    .insert(schema.boxItems)
    .values(item(TENANT_B, boxId, HASH_A, "2026-08-27T06:10:00.000Z"));
  await db
    .insert(schema.codeConflicts)
    .values(conflict(TENANT_B, B_VALIDATION_SHIFT_WITHOUT_DURATION, B_AGGREGATION_SHIFT, HASH_B));
}

async function seedBerlin(db: Db): Promise<void> {
  await db
    .insert(schema.products)
    .values(
      product(
        BERLIN_TENANT,
        BERLIN_VALIDATION_PRODUCT,
        "04600000000053",
        "Berlin validation product",
      ),
    );
  await db.insert(schema.shifts).values({
    ...shift(BERLIN_TENANT, BERLIN_VALIDATION_SHIFT, BERLIN_VALIDATION_PRODUCT, 1, "validation"),
    numberMonthKey: "MAR26",
    plannedDate: "2026-03-29",
    status: "closed",
    openedAt: new Date("2026-03-28T23:00:00.000Z"),
    closedAt: new Date("2026-03-29T22:00:00.000Z"),
  });
  await db
    .insert(schema.codeRegistry)
    .values(
      Array.from({ length: 13 }, (_, index) =>
        registry(
          BERLIN_TENANT,
          BERLIN_VALIDATION_SHIFT,
          index.toString(16).padStart(64, "0"),
          "2026-03-29T10:00:00.000Z",
        ),
      ),
    );
}

function organization(id: string, name: string) {
  return { id, name, slug: id, createdAt: new Date("2026-01-01T00:00:00.000Z") };
}

function product(tenantId: string, id: string, gtin14: string, name: string) {
  return { id, tenantId, gtin14, name, status: "active" as const };
}

function shift(
  tenantId: string,
  id: string,
  productId: string,
  numberSeq: number,
  mode: "validation" | "aggregation",
) {
  return {
    id,
    tenantId,
    productId,
    mode,
    numberMonthKey: "AUG26",
    numberSeq,
    plannedDate: "2026-08-27",
  };
}

function registry(tenantId: string, shiftId: string, codeHash: string, scannedAt: string) {
  return { tenantId, shiftId, codeHash, scannedAt: new Date(scannedAt) };
}

function box(
  tenantId: string,
  id: string,
  shiftId: string,
  deviceBoxId: string,
  overrides: Partial<typeof schema.boxes.$inferInsert> = {},
) {
  return {
    id,
    tenantId,
    shiftId,
    terminalId: null,
    deviceBoxId,
    openedAt: new Date("2026-08-27T06:00:00.000Z"),
    ...overrides,
  };
}

function item(
  tenantId: string,
  boxId: string,
  codeHash: string,
  addedAt: string,
  overrides: Partial<typeof schema.boxItems.$inferInsert> = {},
) {
  return { tenantId, boxId, codeHash, addedAt: new Date(addedAt), ...overrides };
}

function conflict(
  tenantId: string,
  losingShiftId: string,
  winningShiftId: string,
  codeHash: string,
) {
  return {
    tenantId,
    codeHash,
    losingShiftId,
    losingTerminalId: "terminal-losing",
    losingScannedAt: new Date("2026-08-27T06:00:00.000Z"),
    winningShiftId,
    winningTerminalId: "terminal-winning",
    winningScannedAt: new Date("2026-08-27T05:59:00.000Z"),
    detectedAt: new Date("2026-08-27T06:01:00.000Z"),
  };
}

function transactionRecordingDb(db: Db, options: unknown[]): Db {
  return {
    transaction: (callback, config) => {
      options.push(config);
      return db.transaction(callback, config);
    },
  } as Db;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
