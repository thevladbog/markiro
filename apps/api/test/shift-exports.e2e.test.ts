import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SHIFT_EXPORT_FORMATS } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { PgBossService } from "../src/jobs/jobs.module";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import {
  createTestStationDevice,
  setOnlyOrganizationMemberRole,
  signUpAndActivate,
} from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const CREATE_BODY = {
  formatId: "shift_csv_flat",
  formatVersion: 1,
  maxLines: null,
} as const;

describe.skipIf(!ready)("shift exports e2e", () => {
  let app: INestApplication | undefined;
  let db: Db;
  const enqueueShiftExport = vi.fn(async (_exportId: string) => randomUUID());
  const presignRead = vi.fn(
    async (_key: string, _expires: number, _options: { downloadFilename: string }) =>
      "https://objects.invalid/signed",
  );

  beforeAll(async () => {
    const env = loadEnv({
      ...process.env,
      ...PLATFORM_TEST_ENV,
      SUBSCRIPTION_ENFORCEMENT_MODE: "managed_only",
    });
    const setup: AuthSetup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    })
      .overrideProvider(PgBossService)
      .useValue({ enqueueShiftExport, checkReady: async () => undefined })
      .overrideProvider(ObjectStorageService)
      .useValue({ presignRead, ensureBucket: async () => undefined })
      .compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);

  beforeEach(() => {
    enqueueShiftExport.mockClear();
    enqueueShiftExport.mockImplementation(async () => randomUUID());
    presignRead.mockClear();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  async function fixture(status: "planned" | "active" | "closed" = "closed") {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    if (!member) throw new Error("Expected tenant owner fixture");
    const productId = randomUUID();
    const shiftId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: `${Math.floor(Math.random() * 1e13)}`.padStart(14, "0"),
      name: "Вода газированная",
      status: "active",
      boxCapacity: 12,
      palletCapacity: 48,
    });
    await db.insert(schema.shifts).values({
      id: shiftId,
      tenantId,
      productId,
      mode: "validation",
      status,
      plannedDate: "2026-08-13",
      ...(status === "closed" ? { closedAt: new Date(), closeReason: "test close" } : {}),
    });
    return { agent, tenantId, userId: member.userId, productId, shiftId };
  }

  async function attachExpiredSubscription(tenantId: string): Promise<void> {
    const planVersionId = await createPublishedPlan(db, {
      maxLines: null,
      maxStations: null,
      maxKiosks: null,
      maxCabinetUsers: null,
      labelEditorEnabled: true,
      publicApiEnabled: true,
      palletsEnabled: true,
    });
    await createManagedSubscription(db, {
      tenantId,
      planVersionId,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() - 60_000),
    });
  }

  function createBody(idempotencyKey = randomUUID()) {
    return { ...CREATE_BODY, idempotencyKey };
  }

  it("returns the exact server registry and keeps every route cabinet-only", async () => {
    const { agent } = await fixture();
    expect((await agent.get("/shift-exports/formats").expect(200)).body).toEqual(
      SHIFT_EXPORT_FORMATS,
    );

    const station = await createTestStationDevice(app!, agent, "Export-denied station");
    await request(app!.getHttpServer())
      .get("/shift-exports/formats")
      .set("x-api-key", station.apiKey)
      .expect(403);
  });

  it("requires operations.read but permits export creation in subscription read-only mode", async () => {
    const denied = await fixture();
    await setOnlyOrganizationMemberRole(db, denied.tenantId, "member");
    await denied.agent.post(`/shifts/${denied.shiftId}/exports`).send(createBody()).expect(403);

    const allowed = await fixture();
    await attachExpiredSubscription(allowed.tenantId);
    const created = await allowed.agent
      .post(`/shifts/${allowed.shiftId}/exports`)
      .send(createBody())
      .expect(201);
    expect(created.body).toMatchObject({
      shiftId: allowed.shiftId,
      status: "queued",
      createdByUserId: allowed.userId,
      stale: false,
      artifacts: [],
    });
  });

  it("rejects open, cross-tenant, unknown-version, and invalid-limit requests", async () => {
    const open = await fixture("active");
    await open.agent.post(`/shifts/${open.shiftId}/exports`).send(createBody()).expect(409);

    const owner = await fixture();
    const other = await fixture();
    await other.agent.post(`/shifts/${owner.shiftId}/exports`).send(createBody()).expect(404);
    await owner.agent
      .post(`/shifts/${owner.shiftId}/exports`)
      .send({ ...createBody(), formatVersion: 2 })
      .expect(400);
    await owner.agent
      .post(`/shifts/${owner.shiftId}/exports`)
      .send({ ...createBody(), maxLines: 1 })
      .expect(400);
    await owner.agent
      .post(`/shifts/${owner.shiftId}/exports`)
      .send({ ...createBody(), maxLines: 1_000_001 })
      .expect(400);
  });

  it("rejects creating a boxes export with the superseded format version 1", async () => {
    const { agent, shiftId } = await fixture();
    const response = await agent
      .post(`/shifts/${shiftId}/exports`)
      .send({
        formatId: "shift_txt_boxes",
        formatVersion: 1,
        maxLines: null,
        idempotencyKey: randomUUID(),
      });
    expect(response.status).toBe(400);
  });

  it("creates a boxes export at format version 2", async () => {
    const { agent, shiftId } = await fixture();
    const response = await agent
      .post(`/shifts/${shiftId}/exports`)
      .send({
        formatId: "shift_txt_boxes",
        formatVersion: 2,
        maxLines: null,
        idempotencyKey: randomUUID(),
      });
    expect(response.status).toBe(201);
    expect(response.body.formatVersion).toBe(2);
  });

  it("collapses only the same actor/idempotency key and creates a job for each distinct key", async () => {
    const { agent, shiftId } = await fixture();
    const key = randomUUID();
    const first = await agent.post(`/shifts/${shiftId}/exports`).send(createBody(key)).expect(201);
    const repeated = await agent
      .post(`/shifts/${shiftId}/exports`)
      .send(createBody(key))
      .expect(201);
    const distinct = await agent
      .post(`/shifts/${shiftId}/exports`)
      .send(createBody(randomUUID()))
      .expect(201);

    expect(repeated.body.id).toBe(first.body.id);
    expect(distinct.body.id).not.toBe(first.body.id);
    expect(enqueueShiftExport).toHaveBeenCalledTimes(2);
  });

  it("restores the same QUEUE_FAILED row on an idempotent repeat", async () => {
    const { agent, tenantId, shiftId } = await fixture();
    const key = randomUUID();
    enqueueShiftExport.mockRejectedValueOnce(new Error("queue unavailable"));
    await agent.post(`/shifts/${shiftId}/exports`).send(createBody(key)).expect(503);

    const [failed] = await db
      .select()
      .from(schema.shiftExports)
      .where(
        and(
          eq(schema.shiftExports.tenantId, tenantId),
          eq(schema.shiftExports.idempotencyKey, key),
        ),
      );
    expect(failed).toMatchObject({ status: "failed", errorCode: "QUEUE_FAILED" });

    const retried = await agent
      .post(`/shifts/${shiftId}/exports`)
      .send(createBody(key))
      .expect(201);
    expect(retried.body).toMatchObject({ id: failed!.id, status: "queued", errorCode: null });
    expect(enqueueShiftExport).toHaveBeenCalledTimes(2);
  });

  it("lists only the shift history newest-first, with creator, artifacts, and late-data staleness", async () => {
    const { agent, tenantId, userId, shiftId, productId } = await fixture();
    await db
      .insert(schema.userProfiles)
      .values({ userId, firstName: "Иван", lastName: "Петров", middleName: null })
      .onConflictDoUpdate({
        target: schema.userProfiles.userId,
        set: { firstName: "Иван", lastName: "Петров", middleName: null },
      });
    const oldId = randomUUID();
    const freshId = randomUUID();
    const oldSnapshot = new Date("2026-08-13T08:00:00.000Z");
    await db.insert(schema.shiftExports).values([
      {
        id: oldId,
        tenantId,
        shiftId,
        formatId: "shift_csv_flat",
        formatVersion: 1,
        maxLines: null,
        status: "ready",
        totalCodeCount: 2,
        totalBoxCount: 0,
        createdByUserId: userId,
        idempotencyKey: randomUUID(),
        sourceSnapshotStartedAt: oldSnapshot,
        completedAt: new Date("2026-08-13T08:01:00.000Z"),
        createdAt: new Date("2026-08-13T08:00:00.000Z"),
      },
      {
        id: freshId,
        tenantId,
        shiftId,
        formatId: "shift_txt_flat",
        formatVersion: 1,
        maxLines: 2000,
        status: "queued",
        createdByUserId: userId,
        idempotencyKey: randomUUID(),
        createdAt: new Date("2026-08-13T09:00:00.000Z"),
      },
    ]);
    await db.insert(schema.shiftExportArtifacts).values({
      tenantId,
      exportId: oldId,
      partNumber: 1,
      physicalLineCount: 3,
      codeCount: 2,
      boxCount: 0,
      filename: "persisted.csv",
      mimeType: "text/csv; charset=utf-8",
      byteSize: 42,
      sha256: "a".repeat(64),
      objectKey: `tenants/${tenantId}/shift-exports/${oldId}/attempt-1/part-1.csv`,
    });
    await db
      .update(schema.shifts)
      .set({ lateDataAt: new Date(oldSnapshot.getTime() + 1_000) })
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)));

    const unrelatedShiftId = randomUUID();
    await db.insert(schema.shifts).values({
      id: unrelatedShiftId,
      tenantId,
      productId,
      mode: "validation",
      status: "closed",
      closedAt: new Date(),
      closeReason: "test close",
    });
    await db.insert(schema.shiftExports).values({
      tenantId,
      shiftId: unrelatedShiftId,
      formatId: "shift_txt_flat",
      formatVersion: 1,
      status: "queued",
      createdByUserId: userId,
      idempotencyKey: randomUUID(),
    });

    const history = await agent.get(`/shifts/${shiftId}/exports`).expect(200);
    expect(history.body.map((item: { id: string }) => item.id)).toEqual([freshId, oldId]);
    expect(history.body[0]).toMatchObject({ stale: false, createdByName: "Петров Иван" });
    expect(history.body[1]).toMatchObject({
      stale: true,
      artifacts: [{ filename: "persisted.csv", byteSize: 42 }],
    });
    expect(history.text).not.toMatch(/objectKey|object_key|attempt-1/i);
  });

  it("atomically retries only a tenant-owned failed export and records the acting user", async () => {
    const owner = await fixture();
    const failedId = randomUUID();
    await db.insert(schema.shiftExports).values({
      id: failedId,
      tenantId: owner.tenantId,
      shiftId: owner.shiftId,
      formatId: "shift_txt_boxes",
      formatVersion: 1,
      maxLines: 500,
      status: "failed",
      errorCode: "STORAGE_FAILED",
      completedAt: new Date(),
      createdByUserId: owner.userId,
      idempotencyKey: randomUUID(),
      attemptCount: 1,
    });
    const retried = await owner.agent.post(`/shift-exports/${failedId}/retry`).expect(200);
    expect(retried.body).toMatchObject({
      id: failedId,
      status: "queued",
      errorCode: null,
      completedAt: null,
      attemptCount: 1,
    });
    const [audit] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, owner.tenantId),
          eq(schema.tenantAuditEvents.action, "shift_export.retried"),
          eq(schema.tenantAuditEvents.targetId, failedId),
        ),
      );
    expect(audit).toMatchObject({ actorUserId: owner.userId, outcome: "success" });
    expect(audit?.after).toMatchObject({
      actorUserId: owner.userId,
      formatId: "shift_txt_boxes",
      formatVersion: 1,
      maxLines: 500,
      outcome: "success",
    });

    await owner.agent.post(`/shift-exports/${failedId}/retry`).expect(409);
    const other = await fixture();
    await other.agent.post(`/shift-exports/${failedId}/retry`).expect(404);
  });

  it("signs only a ready tenant-owned artifact for 300 seconds with its persisted filename", async () => {
    const owner = await fixture();
    const exportId = randomUUID();
    const artifactId = randomUUID();
    const objectKey = `tenants/${owner.tenantId}/shift-exports/${exportId}/attempt-1/part-1.csv`;
    await db.insert(schema.shiftExports).values({
      id: exportId,
      tenantId: owner.tenantId,
      shiftId: owner.shiftId,
      formatId: "shift_csv_flat",
      formatVersion: 1,
      status: "ready",
      totalCodeCount: 1,
      totalBoxCount: 0,
      completedAt: new Date(),
      sourceSnapshotStartedAt: new Date(),
      createdByUserId: owner.userId,
      idempotencyKey: randomUUID(),
      attemptCount: 1,
    });
    await db.insert(schema.shiftExportArtifacts).values({
      id: artifactId,
      tenantId: owner.tenantId,
      exportId,
      partNumber: 1,
      physicalLineCount: 2,
      codeCount: 1,
      boxCount: 0,
      filename: "Имя из БД.csv",
      mimeType: "text/csv; charset=utf-8",
      byteSize: 24,
      sha256: "b".repeat(64),
      objectKey,
    });

    const download = await owner.agent
      .get(`/shift-exports/${exportId}/artifacts/${artifactId}/download`)
      .expect(200);
    expect(download.body).toEqual({
      url: "https://objects.invalid/signed",
      filename: "Имя из БД.csv",
      expiresInSeconds: 300,
    });
    expect(presignRead).toHaveBeenCalledWith(objectKey, 300, {
      downloadFilename: "Имя из БД.csv",
    });
    const [audit] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, owner.tenantId),
          eq(schema.tenantAuditEvents.action, "shift_export.downloaded"),
          eq(schema.tenantAuditEvents.targetId, exportId),
        ),
      );
    const serializedAudit = JSON.stringify(audit);
    expect(audit).toMatchObject({ actorUserId: owner.userId, outcome: "success" });
    expect(serializedAudit).not.toContain(objectKey);
    expect(serializedAudit).not.toContain("https://objects.invalid/signed");

    const other = await fixture();
    await other.agent
      .get(`/shift-exports/${exportId}/artifacts/${artifactId}/download`)
      .expect(404);
  });
});
