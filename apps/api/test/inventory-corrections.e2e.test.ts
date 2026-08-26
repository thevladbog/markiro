import { createHash, randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@markiro/db";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { setOnlyOrganizationMemberRole, signUpAndActivate } from "./support/auth";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";
import { StationInventorySyncService } from "../src/modules/inventories/station-inventory-sync.service";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
const GTIN = "04600000000015";
const SOURCE_DATE = "2026-08-05";
const CHANGED_DATE = "2026-08-06";

type Agent = ReturnType<typeof request.agent>;
type JsonSchema = {
  type?: string;
  enum?: unknown[];
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  oneOf?: JsonSchema[];
};

interface RunningFixture {
  agent: Agent;
  tenantId: string;
  userId: string;
  inventoryId: string;
  snapshotId: string;
  eventId: string;
  resultId: string;
  codeHash: string;
  boxId: string;
  repackItemId: string;
  sourceDate: string;
  deviceId: string;
}

describe.skipIf(!ready)("inventory administrative corrections", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let document: OpenAPIObject;
  let stationSync: StationInventorySyncService;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    stationSync = app.get(StationInventorySyncService);
    await listenOnLoopback(app);
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("inventory corrections").setVersion("test").build(),
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  async function seedRunningInventory(status: "running" | "closed" | "completed" = "running") {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId))
      .limit(1);
    if (!member) throw new Error("Expected inventory correction actor");
    const userId = member.userId;
    const productId = randomUUID();
    const lineId = randomUUID();
    const operatorId = randomUUID();
    const deviceId = randomUUID();
    const inventoryId = randomUUID();
    const snapshotId = randomUUID();
    const eventId = randomUUID();
    const resultId = randomUUID();
    const boxId = randomUUID();
    const repackItemId = randomUUID();
    const codeHash = createHash("sha256").update(resultId).digest("hex");

    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Correction product",
      boxCapacity: 12,
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Correction line" });
    await db.insert(schema.employees).values({
      id: operatorId,
      tenantId,
      fullName: "Correction operator",
    });
    await db.insert(schema.stationDevices).values({
      id: deviceId,
      tenantId,
      name: "Correction terminal",
      lineId,
    });
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: `INV-${randomUUID()}`,
      productId,
      gtin14Snapshot: GTIN,
      lineId,
      mode: "check",
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      createdByUserId: userId,
    });
    await db.insert(schema.inventorySnapshots).values({
      id: snapshotId,
      tenantId,
      inventoryId,
      combinedDigest: "a".repeat(64),
      emittedCount: 0,
      introducedCount: 1,
      appliedCount: 0,
      retiredCount: 0,
      writtenOffCount: 0,
      disaggregationCount: 0,
      protectedCount: 0,
      expectedCount: 1,
      packageCount: 0,
      looseCount: 1,
      fixedByUserId: userId,
    });
    await db.insert(schema.inventorySnapshotCodes).values({
      tenantId,
      snapshotId,
      canonicalRaw: `01${GTIN}21CORRECTION`,
      codeHash,
      gtin14: GTIN,
      serial: "CORRECTION",
      sourceStatus: "INTRODUCED",
      sourceProductionDate: SOURCE_DATE,
      expected: true,
      protected: false,
    });
    await db
      .update(schema.inventories)
      .set({
        activeSnapshotId: snapshotId,
        stationManifest: { snapshotRevision: 1 },
        status,
        resultRevision: 4,
        startedByUserId: userId,
        startedAt: new Date("2026-08-20T09:00:00.000Z"),
        ...(status === "closed" || status === "completed"
          ? { closedByUserId: userId, closedAt: new Date("2026-08-20T12:00:00.000Z") }
          : {}),
        ...(status === "completed"
          ? {
              completionAcknowledgedByUserId: userId,
              completionAcknowledgedAt: new Date("2026-08-20T12:30:00.000Z"),
              completedByUserId: userId,
              completedAt: new Date("2026-08-20T13:00:00.000Z"),
            }
          : {}),
      })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    await db.insert(schema.inventoryScanBatches).values({
      tenantId,
      inventoryId,
      deviceId,
      batchId: "correction-batch",
      payloadDigest: "b".repeat(64),
      sequenceCeiling: 1n,
      outcome: "applied",
      result: {},
    });
    await db.insert(schema.inventoryScanEvents).values({
      eventId,
      tenantId,
      inventoryId,
      batchId: "correction-batch",
      deviceId,
      deviceSequence: 1n,
      operatorId,
      scannedAt: new Date("2026-08-20T10:00:00.000Z"),
      kind: "item",
      normalizedIdentity: `item:${codeHash}`,
      codeHash,
      rawPayload: `01${GTIN}21CORRECTION`,
      activeProductionDate: SOURCE_DATE,
      snapshotRevision: 1,
      localVerdict: "expected",
      authoritativeVerdict: "applied",
    });
    await db.insert(schema.inventoryCodeResults).values({
      id: resultId,
      tenantId,
      inventoryId,
      codeHash,
      snapshotId,
      firstAcceptedEventId: eventId,
      winningDeviceId: deviceId,
      winningScannedAt: new Date("2026-08-20T10:00:00.000Z"),
      observedProductionDate: SOURCE_DATE,
      classification: "expected",
      originClassification: "expected",
    });
    await db.insert(schema.inventoryDeviceParticipants).values({
      tenantId,
      inventoryId,
      deviceId,
      operatorId,
      configuredLineId: lineId,
      joinMethod: "assigned_line",
      joinedAt: new Date("2026-08-20T09:30:00.000Z"),
      heartbeatAt: new Date(),
    });
    await db.insert(schema.inventoryRepackBoxes).values({
      id: boxId,
      tenantId,
      inventoryId,
      newSscc: `1${String(Math.floor(Math.random() * 1e16)).padStart(16, "0")}0`,
      ownerDeviceId: deviceId,
      capacity: 12,
      productionDate: SOURCE_DATE,
      state: "closed",
      printState: "printed",
      printAttemptCount: 1,
      openedAt: new Date("2026-08-20T10:00:00.000Z"),
      closedAt: new Date("2026-08-20T10:10:00.000Z"),
      printedAt: new Date("2026-08-20T10:11:00.000Z"),
    });
    await db.insert(schema.inventoryRepackItems).values({
      id: repackItemId,
      tenantId,
      inventoryId,
      boxId,
      resultId,
      sourceEventId: eventId,
      position: 1,
      productionDate: SOURCE_DATE,
      activeObservedProductionDate: SOURCE_DATE,
    });

    return {
      agent,
      tenantId,
      userId,
      inventoryId,
      snapshotId,
      eventId,
      resultId,
      codeHash,
      boxId,
      repackItemId,
      sourceDate: SOURCE_DATE,
      deviceId,
    } satisfies RunningFixture;
  }

  function correctionBody(
    fixture: RunningFixture,
    action:
      "void_scan" | "restore_scan" | "change_date" | "remove_item" | "invalidate_box" | "reprint",
    overrides: Record<string, unknown> = {},
  ) {
    const target =
      action === "void_scan" || action === "restore_scan"
        ? { eventId: fixture.eventId }
        : action === "change_date" || action === "remove_item"
          ? { codeResultId: fixture.resultId }
          : { repackBoxId: fixture.boxId };
    return {
      action,
      target,
      reason: "Verified warehouse correction",
      expectedResultRevision: 4,
      idempotencyKey: randomUUID(),
      ...(action === "change_date" ? { observedProductionDate: CHANGED_DATE } : {}),
      ...overrides,
    };
  }

  async function correctionRows(fixture: RunningFixture) {
    return db
      .select()
      .from(schema.inventoryCorrections)
      .where(
        and(
          eq(schema.inventoryCorrections.tenantId, fixture.tenantId),
          eq(schema.inventoryCorrections.inventoryId, fixture.inventoryId),
        ),
      );
  }

  it("requires operations.write and active subscription write access", async () => {
    const noCapability = await seedRunningInventory();
    await setOnlyOrganizationMemberRole(db, noCapability.tenantId, "member");
    await noCapability.agent
      .post(`/inventories/${noCapability.inventoryId}/corrections`)
      .send(correctionBody(noCapability, "void_scan"))
      .expect(403);

    const readOnly = await seedRunningInventory();
    const planVersionId = await createPublishedPlan(db, {
      maxLines: null,
      maxStations: null,
      maxKiosks: null,
      maxCabinetUsers: null,
    });
    const subscription = await createManagedSubscription(db, {
      tenantId: readOnly.tenantId,
      planVersionId,
    });
    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "expired", endsAt: new Date(Date.now() - 1_000), updatedAt: new Date() })
      .where(eq(schema.tenantSubscriptions.id, subscription.subscriptionId));
    await readOnly.agent
      .post(`/inventories/${readOnly.inventoryId}/corrections`)
      .send(correctionBody(readOnly, "void_scan"))
      .expect(403, { code: "subscription_read_only" });
  });

  it("rejects blank or oversized reasons, stale revisions, and unknown request fields", async () => {
    const fixture = await seedRunningInventory();
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(correctionBody(fixture, "void_scan", { reason: "   " }))
      .expect(400);
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(correctionBody(fixture, "void_scan", { reason: "x".repeat(1025) }))
      .expect(400);
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(correctionBody(fixture, "void_scan", { reason: "я".repeat(513) }))
      .expect(400);
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(correctionBody(fixture, "void_scan", { expectedResultRevision: 3 }))
      .expect(409, { code: "INVENTORY_CORRECTION_STALE_REVISION", resultRevision: 4 });
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(correctionBody(fixture, "void_scan", { unexpected: true }))
      .expect(400);
    expect(await correctionRows(fixture)).toHaveLength(0);
  });

  it("accepts a reason at exactly 1024 UTF-8 bytes including Cyrillic", async () => {
    const fixture = await seedRunningInventory();
    const reason = "я".repeat(512);
    const response = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(correctionBody(fixture, "void_scan", { reason }))
      .expect(201);
    expect(response.body.reason).toBe(reason);
  });

  it("voids and restores a scan without deleting its immutable source event", async () => {
    const fixture = await seedRunningInventory();
    const voided = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(correctionBody(fixture, "void_scan"))
      .expect(201);
    expect(voided.body).toMatchObject({ action: "void_scan", resultRevision: 5 });
    const [voidedResult] = await db
      .select({ classification: schema.inventoryCodeResults.classification })
      .from(schema.inventoryCodeResults)
      .where(eq(schema.inventoryCodeResults.id, fixture.resultId));
    expect(voidedResult?.classification).toBe("voided");
    expect(
      await db
        .select({ eventId: schema.inventoryScanEvents.eventId })
        .from(schema.inventoryScanEvents)
        .where(eq(schema.inventoryScanEvents.eventId, fixture.eventId)),
    ).toEqual([{ eventId: fixture.eventId }]);

    const restored = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(
        correctionBody(fixture, "restore_scan", {
          expectedResultRevision: 5,
          idempotencyKey: randomUUID(),
        }),
      )
      .expect(201);
    expect(restored.body).toMatchObject({ action: "restore_scan", resultRevision: 6 });
    const [restoredResult] = await db
      .select({ classification: schema.inventoryCodeResults.classification })
      .from(schema.inventoryCodeResults)
      .where(eq(schema.inventoryCodeResults.id, fixture.resultId));
    expect(restoredResult?.classification).toBe("expected");
  });

  it("changes only observed production date and preserves snapshot source evidence", async () => {
    const fixture = await seedRunningInventory();
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(correctionBody(fixture, "change_date"))
      .expect(409, { code: "INVENTORY_CORRECTION_ACTIVE_BOX_CONFLICT" });
    expect(await correctionRows(fixture)).toHaveLength(0);
    const [membership] = await db
      .select({ addedAt: schema.inventoryRepackItems.addedAt })
      .from(schema.inventoryRepackItems)
      .where(eq(schema.inventoryRepackItems.id, fixture.repackItemId));
    await db
      .update(schema.inventoryRepackItems)
      .set({
        removedAt: new Date(membership!.addedAt.getTime() + 1),
        activeObservedProductionDate: null,
      })
      .where(eq(schema.inventoryRepackItems.id, fixture.repackItemId));
    const response = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(correctionBody(fixture, "change_date"))
      .expect(201);
    expect(response.body).toMatchObject({ action: "change_date", resultRevision: 5 });

    const [result] = await db
      .select({ observedProductionDate: schema.inventoryCodeResults.observedProductionDate })
      .from(schema.inventoryCodeResults)
      .where(eq(schema.inventoryCodeResults.id, fixture.resultId));
    const [snapshotCode] = await db
      .select({ sourceProductionDate: schema.inventorySnapshotCodes.sourceProductionDate })
      .from(schema.inventorySnapshotCodes)
      .where(eq(schema.inventorySnapshotCodes.codeHash, fixture.codeHash));
    expect(result?.observedProductionDate).toBe(CHANGED_DATE);
    expect(snapshotCode?.sourceProductionDate).toBe(SOURCE_DATE);
  });

  it("removes an active repack item append-only and invalidates a box", async () => {
    const closedFixture = await seedRunningInventory();
    await closedFixture.agent
      .post(`/inventories/${closedFixture.inventoryId}/corrections`)
      .send(correctionBody(closedFixture, "remove_item"))
      .expect(409, { code: "INVENTORY_CORRECTION_STATE_CONFLICT" });

    const removeFixture = await seedRunningInventory();
    await db
      .update(schema.inventoryRepackBoxes)
      .set({
        state: "open",
        printState: "not_ready",
        printAttemptCount: 0,
        closedAt: null,
        printedAt: null,
      })
      .where(eq(schema.inventoryRepackBoxes.id, removeFixture.boxId));
    await removeFixture.agent
      .post(`/inventories/${removeFixture.inventoryId}/corrections`)
      .send(correctionBody(removeFixture, "remove_item"))
      .expect(201);
    const [membership] = await db
      .select({
        removedAt: schema.inventoryRepackItems.removedAt,
        activeObservedProductionDate: schema.inventoryRepackItems.activeObservedProductionDate,
      })
      .from(schema.inventoryRepackItems)
      .where(eq(schema.inventoryRepackItems.id, removeFixture.repackItemId));
    expect(membership?.removedAt).toBeInstanceOf(Date);
    expect(membership?.activeObservedProductionDate).toBeNull();

    const boxFixture = await seedRunningInventory();
    await boxFixture.agent
      .post(`/inventories/${boxFixture.inventoryId}/corrections`)
      .send(correctionBody(boxFixture, "invalidate_box"))
      .expect(201);
    const [box] = await db
      .select({ state: schema.inventoryRepackBoxes.state })
      .from(schema.inventoryRepackBoxes)
      .where(eq(schema.inventoryRepackBoxes.id, boxFixture.boxId));
    expect(box?.state).toBe("invalidated");
  });

  it("records reprint work without changing the printed server projection", async () => {
    const fixture = await seedRunningInventory();
    const response = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(correctionBody(fixture, "reprint"))
      .expect(201);
    expect(response.body).toMatchObject({ action: "reprint", resultRevision: 5 });
    const [box] = await db
      .select({
        printState: schema.inventoryRepackBoxes.printState,
        printedAt: schema.inventoryRepackBoxes.printedAt,
      })
      .from(schema.inventoryRepackBoxes)
      .where(eq(schema.inventoryRepackBoxes.id, fixture.boxId));
    if (!box) throw new Error("Expected reprint box projection");
    expect(box.printState).toBe("printed");
    expect(box.printedAt).toBeInstanceOf(Date);
    expect(
      await db
        .select()
        .from(schema.inventoryRepackPrintAttempts)
        .where(eq(schema.inventoryRepackPrintAttempts.boxId, fixture.boxId)),
    ).toHaveLength(0);
  });

  it("publishes every member and box correction as a consumable ordered Station delta", async () => {
    const removeFixture = await seedRunningInventory();
    await db
      .update(schema.inventoryRepackBoxes)
      .set({
        state: "open",
        printState: "not_ready",
        printAttemptCount: 0,
        closedAt: null,
        printedAt: null,
      })
      .where(eq(schema.inventoryRepackBoxes.id, removeFixture.boxId));
    await removeFixture.agent
      .post(`/inventories/${removeFixture.inventoryId}/corrections`)
      .send(correctionBody(removeFixture, "remove_item"))
      .expect(201);
    const removePage = await stationSync.progress(
      removeFixture.tenantId,
      removeFixture.deviceId,
      removeFixture.inventoryId,
      { limit: 200 },
    );
    expect(removePage.items).toEqual([
      expect.objectContaining({
        revision: 5,
        kind: "remove_item",
        boxId: removeFixture.boxId,
        resultId: removeFixture.resultId,
        codeHash: removeFixture.codeHash,
        ownerDeviceId: removeFixture.deviceId,
      }),
    ]);
    expect(removePage.nextCursor).toBe(`5:${removePage.items[0]!.id}`);

    for (const action of ["invalidate_box", "reprint"] as const) {
      const fixture = await seedRunningInventory();
      await fixture.agent
        .post(`/inventories/${fixture.inventoryId}/corrections`)
        .send(correctionBody(fixture, action))
        .expect(201);
      const page = await stationSync.progress(
        fixture.tenantId,
        fixture.deviceId,
        fixture.inventoryId,
        { limit: 200 },
      );
      expect(page.items).toEqual([
        expect.objectContaining({
          revision: 5,
          kind: action,
          boxId: fixture.boxId,
          ownerDeviceId: fixture.deviceId,
        }),
      ]);
      expect(page.nextCursor).toBe(`5:${page.items[0]!.id}`);
    }
  });

  it("namespaces idempotency by tenant and inventory, replays exactly, and rejects mismatch", async () => {
    const first = await seedRunningInventory();
    const second = await seedRunningInventory();
    const idempotencyKey = randomUUID();
    const firstBody = correctionBody(first, "void_scan", { idempotencyKey });
    const secondBody = correctionBody(second, "void_scan", { idempotencyKey });
    const applied = await first.agent
      .post(`/inventories/${first.inventoryId}/corrections`)
      .send(firstBody)
      .expect(201);
    const replay = await first.agent
      .post(`/inventories/${first.inventoryId}/corrections`)
      .send(firstBody)
      .expect(201);
    expect(replay.body).toEqual(applied.body);
    expect(await correctionRows(first)).toHaveLength(1);

    await second.agent
      .post(`/inventories/${second.inventoryId}/corrections`)
      .send(secondBody)
      .expect(201);
    expect((await correctionRows(second))[0]?.id).not.toBe((await correctionRows(first))[0]?.id);

    await first.agent
      .post(`/inventories/${first.inventoryId}/corrections`)
      .send({ ...firstBody, reason: "Different operation under the same key" })
      .expect(409, { code: "INVENTORY_CORRECTION_IDEMPOTENCY_MISMATCH" });
    expect(await correctionRows(first)).toHaveLength(1);
  });

  it("includes the normalized observed production date in exact idempotency replay", async () => {
    const fixture = await seedRunningInventory();
    const [membership] = await db
      .select({ addedAt: schema.inventoryRepackItems.addedAt })
      .from(schema.inventoryRepackItems)
      .where(eq(schema.inventoryRepackItems.id, fixture.repackItemId));
    await db
      .update(schema.inventoryRepackItems)
      .set({
        removedAt: new Date(membership!.addedAt.getTime() + 1),
        activeObservedProductionDate: null,
      })
      .where(eq(schema.inventoryRepackItems.id, fixture.repackItemId));
    const idempotencyKey = randomUUID();
    const body = correctionBody(fixture, "change_date", { idempotencyKey });
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(body)
      .expect(201);
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(body)
      .expect(201);
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send({ ...body, observedProductionDate: "2026-08-07" })
      .expect(409, { code: "INVENTORY_CORRECTION_IDEMPOTENCY_MISMATCH" });
  });

  it("denies cross-tenant targets and rejects closed and completed inventories", async () => {
    const owned = await seedRunningInventory();
    const foreign = await seedRunningInventory();
    await foreign.agent
      .post(`/inventories/${owned.inventoryId}/corrections`)
      .send(correctionBody(owned, "void_scan"))
      .expect(404);

    const closed = await seedRunningInventory("closed");
    await closed.agent
      .post(`/inventories/${closed.inventoryId}/corrections`)
      .send(correctionBody(closed, "void_scan"))
      .expect(409, { code: "INVENTORY_CORRECTION_NOT_RUNNING" });
    const completed = await seedRunningInventory("completed");
    await completed.agent
      .post(`/inventories/${completed.inventoryId}/corrections`)
      .send(correctionBody(completed, "void_scan"))
      .expect(409, { code: "INVENTORY_CORRECTION_NOT_RUNNING" });
  });

  it("increments the result revision once and stores exact canonical before/after digests", async () => {
    const fixture = await seedRunningInventory();
    const [beforeResult] = await db
      .select({ updatedAt: schema.inventoryCodeResults.updatedAt })
      .from(schema.inventoryCodeResults)
      .where(eq(schema.inventoryCodeResults.id, fixture.resultId));
    const response = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(correctionBody(fixture, "void_scan"))
      .expect(201);
    const expectedBefore = digest({
      kind: "code_result",
      id: fixture.resultId,
      classification: "expected",
      observedProductionDate: SOURCE_DATE,
      updatedAt: beforeResult!.updatedAt.toISOString(),
    });
    const expectedAfter = digest({
      kind: "code_result",
      id: fixture.resultId,
      classification: "voided",
      observedProductionDate: SOURCE_DATE,
      updatedAt: response.body.createdAt,
    });
    expect(response.body).toMatchObject({
      beforeProjectionDigest: expectedBefore,
      afterProjectionDigest: expectedAfter,
      resultRevision: 5,
    });
    const [inventory] = await db
      .select({ resultRevision: schema.inventories.resultRevision })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    const [audit] = await correctionRows(fixture);
    expect(inventory?.resultRevision).toBe(5);
    expect(audit).toMatchObject({
      actorUserId: fixture.userId,
      targetEventId: fixture.eventId,
      targetCodeResultId: fixture.resultId,
      beforeProjectionDigest: expectedBefore,
      afterProjectionDigest: expectedAfter,
      resultRevision: 5,
    });
  });

  it("digests the exact membership and box fields changed at the one correction timestamp", async () => {
    const memberFixture = await seedRunningInventory();
    await db
      .update(schema.inventoryRepackBoxes)
      .set({
        state: "open",
        printState: "not_ready",
        printAttemptCount: 0,
        closedAt: null,
        printedAt: null,
      })
      .where(eq(schema.inventoryRepackBoxes.id, memberFixture.boxId));
    const removed = await memberFixture.agent
      .post(`/inventories/${memberFixture.inventoryId}/corrections`)
      .send(correctionBody(memberFixture, "remove_item"))
      .expect(201);
    expect(removed.body).toMatchObject({
      beforeProjectionDigest: digest({
        kind: "repack_item",
        id: memberFixture.repackItemId,
        boxId: memberFixture.boxId,
        resultId: memberFixture.resultId,
        removedAt: null,
        activeObservedProductionDate: SOURCE_DATE,
      }),
      afterProjectionDigest: digest({
        kind: "repack_item",
        id: memberFixture.repackItemId,
        boxId: memberFixture.boxId,
        resultId: memberFixture.resultId,
        removedAt: removed.body.createdAt,
        activeObservedProductionDate: null,
      }),
    });

    const boxFixture = await seedRunningInventory();
    const [beforeBox] = await db
      .select()
      .from(schema.inventoryRepackBoxes)
      .where(eq(schema.inventoryRepackBoxes.id, boxFixture.boxId));
    const invalidated = await boxFixture.agent
      .post(`/inventories/${boxFixture.inventoryId}/corrections`)
      .send(correctionBody(boxFixture, "invalidate_box"))
      .expect(201);
    const boxProjection = (state: {
      state: string;
      invalidatedAt: Date | null;
      updatedAt: Date;
    }) => ({
      kind: "repack_box",
      id: boxFixture.boxId,
      state: state.state,
      printState: beforeBox!.printState,
      printAttemptCount: beforeBox!.printAttemptCount,
      printErrorCode: beforeBox!.printErrorCode,
      invalidatedAt: state.invalidatedAt?.toISOString() ?? null,
      printedAt: beforeBox!.printedAt?.toISOString() ?? null,
      updatedAt: state.updatedAt.toISOString(),
    });
    expect(invalidated.body).toMatchObject({
      beforeProjectionDigest: digest(boxProjection(beforeBox!)),
      afterProjectionDigest: digest(
        boxProjection({
          state: "invalidated",
          invalidatedAt: new Date(invalidated.body.createdAt),
          updatedAt: new Date(invalidated.body.createdAt),
        }),
      ),
    });
  });

  it("clamps removedAt to a future offline addedAt and digests the actual stored timestamp", async () => {
    const fixture = await seedRunningInventory();
    const futureAddedAt = new Date("2099-08-25T10:00:00.000Z");
    await db
      .update(schema.inventoryRepackBoxes)
      .set({
        state: "open",
        printState: "not_ready",
        printAttemptCount: 0,
        closedAt: null,
        printedAt: null,
      })
      .where(eq(schema.inventoryRepackBoxes.id, fixture.boxId));
    await db
      .update(schema.inventoryRepackItems)
      .set({ addedAt: futureAddedAt })
      .where(eq(schema.inventoryRepackItems.id, fixture.repackItemId));

    const removed = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections`)
      .send(correctionBody(fixture, "remove_item"))
      .expect(201);

    const [membership] = await db
      .select()
      .from(schema.inventoryRepackItems)
      .where(eq(schema.inventoryRepackItems.id, fixture.repackItemId));
    expect(membership?.removedAt).toEqual(futureAddedAt);
    expect(removed.body.createdAt).not.toBe(futureAddedAt.toISOString());
    expect(removed.body.afterProjectionDigest).toBe(
      digest({
        kind: "repack_item",
        id: fixture.repackItemId,
        boxId: fixture.boxId,
        resultId: fixture.resultId,
        removedAt: futureAddedAt.toISOString(),
        activeObservedProductionDate: null,
      }),
    );
    const page = await stationSync.progress(
      fixture.tenantId,
      fixture.deviceId,
      fixture.inventoryId,
      { limit: 200 },
    );
    expect(page.items).toEqual([
      expect.objectContaining({
        kind: "remove_item",
        correctedAt: removed.body.createdAt,
        removedAt: futureAddedAt.toISOString(),
      }),
    ]);
  });

  it("rolls back the inserted correction, projection, and revision when projection update fails", async () => {
    const fixture = await seedRunningInventory();
    const triggerName = `reject_projection_${fixture.resultId.replaceAll("-", "")}`;
    await db.execute(
      sql.raw(`
      create function ${triggerName}() returns trigger language plpgsql as $$
      begin
        if old.id = '${fixture.resultId}'::uuid then
          raise exception 'synthetic projection failure';
        end if;
        return new;
      end $$;
      create trigger ${triggerName}
      before update on inventory_code_results
      for each row execute function ${triggerName}();
    `),
    );
    try {
      await fixture.agent
        .post(`/inventories/${fixture.inventoryId}/corrections`)
        .send(correctionBody(fixture, "void_scan"))
        .expect(500);
      expect(await correctionRows(fixture)).toHaveLength(0);
      const [state] = await db
        .select({
          classification: schema.inventoryCodeResults.classification,
          resultRevision: schema.inventories.resultRevision,
        })
        .from(schema.inventoryCodeResults)
        .innerJoin(
          schema.inventories,
          and(
            eq(schema.inventories.tenantId, schema.inventoryCodeResults.tenantId),
            eq(schema.inventories.id, schema.inventoryCodeResults.inventoryId),
          ),
        )
        .where(eq(schema.inventoryCodeResults.id, fixture.resultId));
      expect(state).toEqual({ classification: "expected", resultRevision: 4 });
    } finally {
      await db.execute(sql.raw(`drop trigger ${triggerName} on inventory_code_results`));
      await db.execute(sql.raw(`drop function ${triggerName}()`));
    }
  });

  it("publishes exact strict DTO and OpenAPI request/response boundaries", () => {
    const operation = document.paths["/inventories/{id}/corrections"]?.post;
    expect(operation).toBeDefined();
    const requestSchema = (
      operation!.requestBody && "$ref" in operation!.requestBody
        ? undefined
        : operation!.requestBody?.content["application/json"]?.schema
    ) as JsonSchema | undefined;
    if (!requestSchema) throw new Error("Missing correction request schema");
    expect(requestSchema.oneOf).toHaveLength(6);
    for (const branch of requestSchema.oneOf ?? []) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required).toContain("action");
      expect(branch.required).toContain("target");
      expect(branch.required).toContain("reason");
      expect(branch.required).toContain("expectedResultRevision");
      expect(branch.required).toContain("idempotencyKey");
      const action = branch.properties?.action?.enum?.[0];
      expect(typeof action).toBe("string");
      expect(branch.properties?.target?.required).toHaveLength(1);
      expect(Object.keys(branch.properties?.target?.properties ?? {})).toEqual(
        action === "void_scan" || action === "restore_scan"
          ? ["eventId"]
          : action === "change_date" || action === "remove_item"
            ? ["codeResultId"]
            : ["repackBoxId"],
      );
      expect(branch.required?.includes("observedProductionDate")).toBe(action === "change_date");
      expect("observedProductionDate" in (branch.properties ?? {})).toBe(action === "change_date");
    }
    const response = operation!.responses["201"];
    if (!response || "$ref" in response) throw new Error("Missing correction response");
    const responseSchema = response.content?.["application/json"]?.schema as JsonSchema | undefined;
    if (!responseSchema) throw new Error("Missing correction response schema");
    exactObject(responseSchema, [
      "id",
      "action",
      "reason",
      "target",
      "beforeProjectionDigest",
      "afterProjectionDigest",
      "resultRevision",
      "createdAt",
    ]);
  });
});

function digest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function exactObject(schema: JsonSchema, fields: readonly string[]): void {
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...fields].sort());
}
