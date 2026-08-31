import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@markiro/db";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
const GTIN = "04600000000015";
type Agent = ReturnType<typeof request.agent>;

interface Fixture {
  agent: Agent;
  tenantId: string;
  userId: string;
  inventoryId: string;
  snapshotId: string;
  lineId: string;
  operatorId: string;
}

describe.skipIf(!ready)("inventory close lifecycle", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

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
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function seedRunningInventory(): Promise<Fixture> {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId))
      .limit(1);
    if (!member) throw new Error("Expected inventory actor");
    const userId = member.userId;
    const productId = randomUUID();
    const lineId = randomUUID();
    const operatorId = randomUUID();
    const inventoryId = randomUUID();
    const snapshotId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Close product",
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Close line" });
    await db.insert(schema.employees).values({
      id: operatorId,
      tenantId,
      fullName: "Close operator",
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
      productName: "Close product",
      lineName: "Close line",
      emittedCount: 0,
      introducedCount: 0,
      appliedCount: 0,
      retiredCount: 0,
      writtenOffCount: 0,
      disaggregationCount: 0,
      protectedCount: 0,
      expectedCount: 0,
      packageCount: 0,
      looseCount: 0,
      fixedByUserId: userId,
    });
    await db
      .update(schema.inventories)
      .set({
        status: "running",
        activeSnapshotId: snapshotId,
        stationManifest: { snapshotRevision: 1 },
        resultRevision: 7,
        startedByUserId: userId,
        startedAt: new Date("2026-08-26T08:00:00.000Z"),
      })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    return { agent, tenantId, userId, inventoryId, snapshotId, lineId, operatorId };
  }

  async function seedParticipant(
    fixture: Fixture,
    options: { stale?: boolean; pending?: number; open?: number } = {},
  ): Promise<string> {
    const deviceId = await seedDevice(fixture, options.stale ? "Stale station" : "Active station");
    await db.insert(schema.inventoryDeviceParticipants).values({
      tenantId: fixture.tenantId,
      inventoryId: fixture.inventoryId,
      deviceId,
      operatorId: fixture.operatorId,
      configuredLineId: fixture.lineId,
      joinMethod: "assigned_line",
      heartbeatAt: new Date(Date.now() - (options.stale ? 120_000 : 1_000)),
      pendingEventCount: options.pending ?? 0,
      openBoxCount: options.open ?? 0,
    });
    return deviceId;
  }

  async function seedDevice(fixture: Fixture, name = "Close station"): Promise<string> {
    const deviceId = randomUUID();
    await db.insert(schema.stationDevices).values({
      id: deviceId,
      tenantId: fixture.tenantId,
      name,
      lineId: fixture.lineId,
    });
    return deviceId;
  }

  async function seedBox(
    fixture: Fixture,
    state: "open" | "closed" | "invalidated",
    printState: "not_ready" | "pending" | "failed" | "printed",
    invalidationSource: "claim_lost" | "admin" = "claim_lost",
  ): Promise<string> {
    const deviceId = await seedDevice(fixture, `Box ${state}`);
    const boxId = randomUUID();
    const changedAt = new Date();
    await db.insert(schema.inventoryRepackBoxes).values({
      id: boxId,
      tenantId: fixture.tenantId,
      inventoryId: fixture.inventoryId,
      newSscc: `1${String(Math.floor(Math.random() * 1e16)).padStart(16, "0")}0`,
      ownerDeviceId: deviceId,
      capacity: 20,
      productionDate: "2026-08-20",
      state,
      printState,
      printAttemptCount: printState === "failed" || printState === "printed" ? 1 : 0,
      printErrorCode: printState === "failed" ? "TEST_PRINT_FAILURE" : null,
      closedAt: state === "closed" ? changedAt : null,
      invalidatedAt: state === "invalidated" ? changedAt : null,
      invalidationSource: state === "invalidated" ? invalidationSource : null,
      printedAt: printState === "printed" ? changedAt : null,
    });
    return boxId;
  }

  async function seedRequiredDiscrepancies(fixture: Fixture): Promise<void> {
    const deviceId = await seedDevice(fixture, "Discrepancy station");
    const batchId = `close-discrepancy-${randomUUID()}`;
    await db.insert(schema.inventoryScanBatches).values({
      tenantId: fixture.tenantId,
      inventoryId: fixture.inventoryId,
      deviceId,
      batchId,
      payloadDigest: "c".repeat(64),
      sequenceCeiling: 4n,
      outcome: "applied",
      result: {},
    });
    const facts = [
      { label: "unknown", classification: "unknown", origin: "unknown", snapshot: false },
      { label: "ineligible", classification: "ineligible", origin: "ineligible", snapshot: true },
      { label: "date", classification: "expected", origin: "expected", snapshot: true },
      { label: "voided", classification: "voided", origin: "unknown", snapshot: false },
    ] as const;
    for (const [index, fact] of facts.entries()) {
      const codeHash = createHash("sha256")
        .update(`${fixture.inventoryId}:${fact.label}`)
        .digest("hex");
      const eventId = randomUUID();
      if (fact.snapshot) {
        await db.insert(schema.inventorySnapshotCodes).values({
          tenantId: fixture.tenantId,
          snapshotId: fixture.snapshotId,
          canonicalRaw: `01${GTIN}21${fact.label.toUpperCase()}`,
          codeHash,
          gtin14: GTIN,
          serial: fact.label.toUpperCase(),
          sourceStatus: fact.origin === "expected" ? "INTRODUCED" : "EMITTED",
          sourceProductionDate: "2026-08-05",
          expected: fact.origin === "expected",
          protected: false,
        });
      }
      const scannedAt = new Date(`2026-08-26T08:0${index}:00.000Z`);
      await db.insert(schema.inventoryScanEvents).values({
        eventId,
        tenantId: fixture.tenantId,
        inventoryId: fixture.inventoryId,
        batchId,
        deviceId,
        deviceSequence: BigInt(index + 1),
        operatorId: fixture.operatorId,
        scannedAt,
        kind: "item",
        normalizedIdentity: `item:${codeHash}`,
        codeHash,
        rawPayload: `01${GTIN}21${fact.label.toUpperCase()}`,
        activeProductionDate: fact.label === "date" ? "2026-08-06" : "2026-08-05",
        snapshotRevision: 1,
        localVerdict: fact.origin,
        authoritativeVerdict: "applied",
      });
      await db.insert(schema.inventoryCodeResults).values({
        tenantId: fixture.tenantId,
        inventoryId: fixture.inventoryId,
        codeHash,
        snapshotId: fact.snapshot ? fixture.snapshotId : null,
        firstAcceptedEventId: eventId,
        winningDeviceId: deviceId,
        winningScannedAt: scannedAt,
        observedProductionDate: fact.label === "date" ? "2026-08-06" : "2026-08-05",
        classification: fact.classification,
        originClassification: fact.origin,
      });
    }
  }

  it("closes only a blocker-free running inventory and freezes its result revision", async () => {
    const fixture = await seedRunningInventory();
    const response = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/close`)
      .send({})
      .expect(201);
    expect(response.body).toMatchObject({
      inventoryId: fixture.inventoryId,
      status: "closed",
      resultRevision: 7,
      emergency: false,
      blockers: [],
    });
    expect(response.body.closedAt).toEqual(expect.any(String));

    const [row] = await db
      .select({ status: schema.inventories.status, revision: schema.inventories.resultRevision })
      .from(schema.inventories)
      .where(
        and(
          eq(schema.inventories.tenantId, fixture.tenantId),
          eq(schema.inventories.id, fixture.inventoryId),
        ),
      );
    expect(row).toEqual({ status: "closed", revision: 7 });
  });

  it("returns exact active/stale, pending and participant-open blocker codes without closing", async () => {
    const fixture = await seedRunningInventory();
    await seedParticipant(fixture, { pending: 3, open: 1 });
    await seedParticipant(fixture, { stale: true });
    const preview = await fixture.agent
      .get(`/inventories/${fixture.inventoryId}/close-preview`)
      .expect(200);
    expect(preview.body).toMatchObject({
      inventoryId: fixture.inventoryId,
      status: "running",
      resultRevision: 7,
    });
    const response = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/close`)
      .send({})
      .expect(409);
    expect(response.body).toMatchObject({
      code: "INVENTORY_CLOSE_BLOCKED",
      resultRevision: 7,
    });
    expect(response.body.blockers).toEqual(preview.body.blockers);
    expect(response.body.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ACTIVE_PARTICIPANT", count: 1, deviceId: null }),
        expect.objectContaining({ code: "STALE_PARTICIPANT", count: 1, deviceId: null }),
        expect.objectContaining({ code: "PENDING_OUTBOX", count: 3, deviceId: null }),
        expect.objectContaining({ code: "PARTICIPANT_OPEN_BOX", count: 1, deviceId: null }),
      ]),
    );
    const [row] = await db
      .select({ status: schema.inventories.status })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    expect(row?.status).toBe("running");
  });

  it("reports actual box, print and required discrepancy blockers but treats missing expected codes as output", async () => {
    const fixture = await seedRunningInventory();
    await seedBox(fixture, "open", "not_ready");
    await seedBox(fixture, "open", "not_ready");
    await seedBox(fixture, "invalidated", "not_ready", "claim_lost");
    await seedBox(fixture, "invalidated", "not_ready", "admin");
    await seedBox(fixture, "closed", "failed");
    await seedRequiredDiscrepancies(fixture);
    const response = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/close`)
      .send({})
      .expect(409);
    expect(response.body.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "OPEN_REPACK_BOX", count: 2, boxId: null }),
        expect.objectContaining({
          code: "INVALIDATED_REPACK_BOX",
          count: 1,
          boxId: null,
          invalidationSource: "claim_lost",
        }),
        expect.objectContaining({
          code: "INVALIDATED_REPACK_BOX",
          count: 1,
          boxId: null,
          invalidationSource: "admin",
        }),
        expect.objectContaining({ code: "UNRESOLVED_BOX_PRINT", count: 1, boxId: null }),
        expect.objectContaining({
          code: "UNRESOLVED_DISCREPANCY",
          discrepancyCategory: "unknown",
          count: 1,
        }),
        expect.objectContaining({
          code: "UNRESOLVED_DISCREPANCY",
          discrepancyCategory: "ineligible",
          count: 1,
        }),
        expect.objectContaining({
          code: "UNRESOLVED_DISCREPANCY",
          discrepancyCategory: "date_mismatch",
          count: 1,
        }),
      ]),
    );
    expect(
      response.body.blockers.some(
        (item: { discrepancyCategory?: string }) => item.discrepancyCategory === "missing",
      ),
    ).toBe(false);
  });

  it("does not treat audited voided scans as safe-close blockers", async () => {
    const fixture = await seedRunningInventory();
    await seedRequiredDiscrepancies(fixture);
    await db
      .update(schema.inventoryCodeResults)
      .set({ classification: "voided" })
      .where(
        and(
          eq(schema.inventoryCodeResults.tenantId, fixture.tenantId),
          eq(schema.inventoryCodeResults.inventoryId, fixture.inventoryId),
        ),
      );

    const preview = await fixture.agent
      .get(`/inventories/${fixture.inventoryId}/close-preview`)
      .expect(200);
    expect(preview.body.blockers).not.toContainEqual(
      expect.objectContaining({
        code: "UNRESOLVED_DISCREPANCY",
        discrepancyCategory: "voided",
      }),
    );

    await fixture.agent.post(`/inventories/${fixture.inventoryId}/close`).send({}).expect(201);
  });

  it("requires emergency reason and explicit blocker acknowledgement, then stores the exact snapshot", async () => {
    const fixture = await seedRunningInventory();
    await seedParticipant(fixture, { pending: 2 });
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/emergency-close`)
      .send({ reason: "Аварийная остановка", acknowledgeBlockers: false })
      .expect(400);
    const response = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/emergency-close`)
      .send({ reason: "Аварийная остановка линии", acknowledgeBlockers: true })
      .expect(201);
    expect(response.body).toMatchObject({
      status: "closed",
      emergency: true,
      resultRevision: 7,
    });
    expect(response.body.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ACTIVE_PARTICIPANT", count: 1, deviceId: null }),
        expect.objectContaining({ code: "PENDING_OUTBOX", count: 2, deviceId: null }),
      ]),
    );
    const [inventory] = await db
      .select({
        reason: schema.inventories.emergencyCloseReason,
        actor: schema.inventories.emergencyClosedByUserId,
      })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    expect(inventory).toEqual({ reason: "Аварийная остановка линии", actor: fixture.userId });
    const [audit] = await db
      .select({ after: schema.tenantAuditEvents.after })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
          eq(schema.tenantAuditEvents.action, "inventory.emergency_closed"),
          eq(schema.tenantAuditEvents.targetId, fixture.inventoryId),
        ),
      );
    expect(audit?.after).toMatchObject({
      reason: "Аварийная остановка линии",
      resultRevision: 7,
      blockers: response.body.blockers,
    });
  });

  it("reopens a closed inventory, audits every cleared close fact and increments revision once", async () => {
    const fixture = await seedRunningInventory();
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/emergency-close`)
      .send({ reason: "Проверка точного аудита", acknowledgeBlockers: true })
      .expect(201);
    const [closed] = await db
      .select({
        status: schema.inventories.status,
        resultRevision: schema.inventories.resultRevision,
        closedByUserId: schema.inventories.closedByUserId,
        closedAt: schema.inventories.closedAt,
        emergencyCloseReason: schema.inventories.emergencyCloseReason,
        emergencyClosedByUserId: schema.inventories.emergencyClosedByUserId,
        emergencyClosedAt: schema.inventories.emergencyClosedAt,
      })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    if (!closed?.closedAt || !closed.emergencyClosedAt) throw new Error("Expected close facts");
    const response = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/reopen`)
      .send({})
      .expect(201);
    expect(response.body).toMatchObject({
      inventoryId: fixture.inventoryId,
      status: "running",
      resultRevision: 8,
      invalidatedArtifactCount: 0,
    });
    const [row] = await db
      .select({
        status: schema.inventories.status,
        revision: schema.inventories.resultRevision,
        closedAt: schema.inventories.closedAt,
        closedBy: schema.inventories.closedByUserId,
        updatedAt: schema.inventories.updatedAt,
      })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    expect(row).toMatchObject({ status: "running", revision: 8, closedAt: null, closedBy: null });
    const [audit] = await db
      .select({ before: schema.tenantAuditEvents.before, after: schema.tenantAuditEvents.after })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
          eq(schema.tenantAuditEvents.action, "inventory.reopened"),
          eq(schema.tenantAuditEvents.targetId, fixture.inventoryId),
        ),
      );
    expect(audit?.before).toEqual({
      status: "closed",
      resultRevision: 7,
      closedByUserId: fixture.userId,
      closedAt: closed.closedAt.toISOString(),
      emergencyCloseReason: "Проверка точного аудита",
      emergencyClosedByUserId: fixture.userId,
      emergencyClosedAt: closed.emergencyClosedAt.toISOString(),
    });
    expect(audit?.after).toEqual({
      status: "running",
      resultRevision: 8,
      closedByUserId: null,
      closedAt: null,
      emergencyCloseReason: null,
      emergencyClosedByUserId: null,
      emergencyClosedAt: null,
      invalidatedArtifactCount: 0,
      replayAuthorizedLateEventCount: 0,
      reopenedAt: row?.updatedAt.toISOString(),
    });
    await fixture.agent.post(`/inventories/${fixture.inventoryId}/close`).send({}).expect(201);
    const [secondClose] = await db
      .select({ revision: schema.inventories.resultRevision })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    expect(secondClose?.revision).toBe(8);
  });

  it("fails completion until a ready document run has verified artifacts", async () => {
    const fixture = await seedRunningInventory();
    await fixture.agent.post(`/inventories/${fixture.inventoryId}/close`).send({}).expect(201);
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/complete`)
      .send({ documentsDownloadedAndChecked: false })
      .expect(400);
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/complete`)
      .send({ documentsDownloadedAndChecked: true })
      .expect(409, {
        code: "INVENTORY_DOCUMENT_ARTIFACTS_NOT_READY",
        missingFormats: [],
      });
    const completedAt = new Date("2026-08-26T13:00:00.000Z");
    await db
      .update(schema.inventories)
      .set({
        status: "completed",
        completionAcknowledgedByUserId: fixture.userId,
        completionAcknowledgedAt: completedAt,
        completedByUserId: fixture.userId,
        completedAt,
      })
      .where(eq(schema.inventories.id, fixture.inventoryId));
    await fixture.agent.post(`/inventories/${fixture.inventoryId}/reopen`).send({}).expect(409, {
      code: "INVENTORY_COMPLETED_IMMUTABLE",
    });
    await fixture.agent.post(`/inventories/${fixture.inventoryId}/close`).send({}).expect(409, {
      code: "INVENTORY_COMPLETED_IMMUTABLE",
    });
  });

  it("serializes a concurrent final participant leave before evaluating close blockers", async () => {
    const fixture = await seedRunningInventory();
    const deviceId = await seedParticipant(fixture, { pending: 1 });
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let inventoryLocked!: () => void;
    const hasLock = new Promise<void>((resolve) => {
      inventoryLocked = resolve;
    });
    const finalSync = db.transaction(async (tx) => {
      await tx
        .select({ id: schema.inventories.id })
        .from(schema.inventories)
        .where(
          and(
            eq(schema.inventories.tenantId, fixture.tenantId),
            eq(schema.inventories.id, fixture.inventoryId),
          ),
        )
        .for("update");
      inventoryLocked();
      await locked;
      await tx
        .update(schema.inventoryDeviceParticipants)
        .set({
          leftAt: sql`greatest(now(), ${schema.inventoryDeviceParticipants.joinedAt})`,
          heartbeatAt: sql`greatest(now(), ${schema.inventoryDeviceParticipants.joinedAt})`,
          pendingEventCount: 0,
          openBoxCount: 0,
        })
        .where(
          and(
            eq(schema.inventoryDeviceParticipants.tenantId, fixture.tenantId),
            eq(schema.inventoryDeviceParticipants.inventoryId, fixture.inventoryId),
            eq(schema.inventoryDeviceParticipants.deviceId, deviceId),
          ),
        );
    });
    await hasLock;
    const closeRequest = fixture.agent.post(`/inventories/${fixture.inventoryId}/close`).send({});
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseLock();
    await finalSync;
    const response = await closeRequest.expect(201);
    expect(response.body).toMatchObject({ status: "closed", resultRevision: 7, blockers: [] });
  });

  it("denies cross-tenant lifecycle mutations and rejects unknown body fields", async () => {
    const owner = await seedRunningInventory();
    const foreign = await seedRunningInventory();
    await foreign.agent.post(`/inventories/${owner.inventoryId}/close`).send({}).expect(404);
    await owner.agent
      .post(`/inventories/${owner.inventoryId}/close`)
      .send({ unexpected: true })
      .expect(400);
  });
});
