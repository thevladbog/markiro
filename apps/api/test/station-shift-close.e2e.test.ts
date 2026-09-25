import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { canonicalizeKm, kmHash } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { SecurityAuditService } from "../src/authorization/security-audit.service";
import { loadEnv } from "../src/env";
import { createTestEmployee, createTestStationDevice, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const STATION_CAPABILITIES = "subscription-state-v1,station-recovery-v1";
const GTIN14 = "04006381333931";
const PLANNED_QTY = 3;

type Device = Awaited<ReturnType<typeof createTestStationDevice>>;

interface Fixture {
  agent: ReturnType<typeof request.agent>;
  tenantId: string;
  shiftId: string;
  first: Device;
  second: Device;
  operatorId: string;
}

describe.skipIf(!ready)("station shift close authority", () => {
  let app: INestApplication;
  let db: Db;
  let audit: SecurityAuditService;

  beforeAll(async () => {
    const env = loadEnv();
    const setup = setupAuth(env);
    db = setup.db;
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    audit = app.get(SecurityAuditService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    vi.spyOn(audit, "deviceCredentialMutation").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function asStation(device: Device) {
    const server = app.getHttpServer();
    return {
      post: (path: string, body?: object) =>
        request(server)
          .post(path)
          .set("x-api-key", device.apiKey)
          .set("x-station-capabilities", STATION_CAPABILITIES)
          .send(body),
    };
  }

  /** Device A starts the shift and owns its close; device B never enters it. */
  async function fixture(): Promise<Fixture> {
    const agent = request.agent(app.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN14,
      name: "Cola",
      status: "active",
    });
    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", plannedQty: PLANNED_QTY })
      .expect(201);
    const shiftId = created.body.id as string;
    const first = await createTestStationDevice(app, agent, "Station A");
    const second = await createTestStationDevice(app, agent, "Station B");
    const operatorId = await createTestEmployee(db, {
      id: randomUUID(),
      tenantId,
      fullName: "Close operator",
    });
    await db.insert(schema.operatorCredentials).values({
      tenantId,
      employeeId: operatorId,
      login: "4101",
      pinHash: "test-pbkdf2-verifier",
    });
    await asStation(first).post(`/shifts/${shiftId}/open`, { entryMethod: "list" }).expect(200);
    return { agent, tenantId, shiftId, first, second, operatorId };
  }

  function scan(shiftId: string, device: Device, serial: string, verdict: "ok" | "duplicate") {
    const raw = `01${GTIN14}21${serial}`;
    const km = canonicalizeKm(raw);
    return {
      shiftId,
      terminalId: device.deviceId,
      raw,
      verdict,
      scannedAt: new Date().toISOString(),
      code:
        verdict === "ok" ? { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial } : null,
      boxId: null,
      operatorId: null,
    };
  }

  async function submitScan(
    f: Fixture,
    device: Device,
    serial: string,
    verdict: "ok" | "duplicate" = "ok",
  ) {
    await asStation(device)
      .post("/station/scans", {
        batchId: `close-authority-${randomUUID()}`,
        items: [scan(f.shiftId, device, serial, verdict)],
      })
      .expect(201);
  }

  /** Plan 3 against an actual of 1, so the fixed reason is part of the event. */
  function closeEvent(f: Fixture) {
    return {
      eventId: randomUUID(),
      shiftId: f.shiftId,
      operatorId: f.operatorId,
      plannedQtySnapshot: PLANNED_QTY,
      actualQty: 1,
      closedBoxCount: 0,
      reasonCode: "equipment_stop",
      closedAt: new Date().toISOString(),
    };
  }

  async function closeEvents(f: Fixture) {
    return db
      .select()
      .from(schema.stationShiftCloseEvents)
      .where(
        and(
          eq(schema.stationShiftCloseEvents.tenantId, f.tenantId),
          eq(schema.stationShiftCloseEvents.shiftId, f.shiftId),
        ),
      );
  }

  async function shiftState(f: Fixture) {
    const [shift] = await db
      .select({
        status: schema.shifts.status,
        closedAt: schema.shifts.closedAt,
        closeReason: schema.shifts.closeReason,
        stationClosePolicy: schema.shifts.stationClosePolicy,
        stationCloseOwnerDeviceId: schema.shifts.stationCloseOwnerDeviceId,
      })
      .from(schema.shifts)
      .where(and(eq(schema.shifts.tenantId, f.tenantId), eq(schema.shifts.id, f.shiftId)));
    return shift;
  }

  async function participantIds(f: Fixture) {
    const rows = await db
      .select({ deviceId: schema.shiftDeviceParticipants.deviceId })
      .from(schema.shiftDeviceParticipants)
      .where(
        and(
          eq(schema.shiftDeviceParticipants.tenantId, f.tenantId),
          eq(schema.shiftDeviceParticipants.shiftId, f.shiftId),
        ),
      );
    return rows.map((row) => row.deviceId);
  }

  it("rejects the owner's close into a conflict once another device's scans are stored", async () => {
    const f = await fixture();
    // B rejoined without an entry record reaching the server; only its scans did.
    await submitScan(f, f.second, "S-B-1");
    expect(await participantIds(f)).toEqual([f.first.deviceId]);
    expect(await shiftState(f)).toMatchObject({
      stationClosePolicy: "single_device",
      stationCloseOwnerDeviceId: f.first.deviceId,
    });
    vi.mocked(audit.deviceCredentialMutation).mockClear();

    const body = closeEvent(f);
    const response = await asStation(f.first).post("/station/shift-closures", body).expect(200);

    expect(response.body).toEqual({ outcome: "conflict", conflictCode: "multiple_devices" });
    expect(await shiftState(f)).toEqual({
      status: "active",
      closedAt: null,
      closeReason: null,
      stationClosePolicy: "single_device",
      stationCloseOwnerDeviceId: f.first.deviceId,
    });
    expect(await closeEvents(f)).toEqual([
      {
        eventId: body.eventId,
        tenantId: f.tenantId,
        shiftId: f.shiftId,
        deviceId: f.first.deviceId,
        operatorId: f.operatorId,
        payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        plannedQtySnapshot: PLANNED_QTY,
        actualQty: 1,
        closedBoxCount: 0,
        reasonCode: "equipment_stop",
        closedAt: new Date(body.closedAt),
        outcome: "conflict",
        conflictCode: "multiple_devices",
        recordedAt: expect.any(Date),
        resolvedAt: null,
        resolvedBy: null,
      },
    ]);
    expect(audit.deviceCredentialMutation).toHaveBeenCalledTimes(1);
    expect(audit.deviceCredentialMutation).toHaveBeenCalledWith({
      tenantId: f.tenantId,
      actorType: "unauthenticated_device",
      actorId: f.first.deviceId,
      action: "station.shift_close",
      resourceId: f.shiftId,
      outcome: "succeeded",
    });

    // The rejected attempt is the administrator's reconciliation item.
    const conflicts = await f.agent.get("/shift-close-conflicts").expect(200);
    expect(conflicts.body.items).toEqual([
      expect.objectContaining({
        eventId: body.eventId,
        shiftId: f.shiftId,
        productName: "Cola",
        deviceId: f.first.deviceId,
        operatorId: f.operatorId,
        plannedQtySnapshot: PLANNED_QTY,
        actualQty: 1,
        closedBoxCount: 0,
        reasonCode: "equipment_stop",
        closedAt: body.closedAt,
        conflictCode: "multiple_devices",
      }),
    ]);

    // Redelivery keeps the one conflict instead of closing on a second look.
    const again = await asStation(f.first).post("/station/shift-closures", body).expect(200);
    expect(again.body).toEqual({ outcome: "conflict", conflictCode: "multiple_devices" });
    expect(await closeEvents(f)).toHaveLength(1);
    expect((await shiftState(f))?.status).toBe("active");
  });

  it.each([
    ["a rejected scan", (f: Fixture) => submitScan(f, f.second, "S-B-rejected", "duplicate")],
    [
      "a stored code owner",
      async (f: Fixture) => {
        await db.insert(schema.codeRegistry).values({
          tenantId: f.tenantId,
          codeHash: kmHash(canonicalizeKm(`01${GTIN14}21S-B-owned`)),
          shiftId: f.shiftId,
          terminalId: f.second.deviceId,
          scannedAt: new Date(),
        });
      },
    ],
    [
      "a box",
      async (f: Fixture) => {
        await db.insert(schema.boxes).values({
          tenantId: f.tenantId,
          shiftId: f.shiftId,
          terminalId: f.second.deviceId,
          deviceBoxId: "box-b-1",
        });
      },
    ],
    [
      "an entry record",
      async (f: Fixture) => {
        await asStation(f.second)
          .post(`/shifts/${f.shiftId}/enter`, { entryMethod: "list" })
          .expect(200);
      },
    ],
  ])("counts %s from another device against the owner's close", async (_evidence, store) => {
    const f = await fixture();
    await store(f);

    const response = await asStation(f.first)
      .post("/station/shift-closures", closeEvent(f))
      .expect(200);

    expect(response.body).toEqual({ outcome: "conflict", conflictCode: "multiple_devices" });
    expect((await shiftState(f))?.status).toBe("active");
  });

  it("keeps counting a revoked device's stored scans", async () => {
    const f = await fixture();
    await submitScan(f, f.second, "S-B-revoked");
    await f.agent.delete(`/station-devices/${f.second.deviceId}`).expect(204);

    const response = await asStation(f.first)
      .post("/station/shift-closures", closeEvent(f))
      .expect(200);

    expect(response.body).toEqual({ outcome: "conflict", conflictCode: "multiple_devices" });
  });

  it("accepts the owner's close when every stored scan is its own", async () => {
    const f = await fixture();
    await submitScan(f, f.first, "S-A-1");
    const body = closeEvent(f);

    const response = await asStation(f.first).post("/station/shift-closures", body).expect(200);

    expect(response.body).toEqual({ outcome: "accepted" });
    expect(await shiftState(f)).toEqual({
      status: "closed",
      closedAt: new Date(body.closedAt),
      closeReason: "equipment_stop",
      stationClosePolicy: "single_device",
      stationCloseOwnerDeviceId: f.first.deviceId,
    });
    expect(await closeEvents(f)).toEqual([
      expect.objectContaining({
        eventId: body.eventId,
        deviceId: f.first.deviceId,
        outcome: "accepted",
        conflictCode: null,
      }),
    ]);
  });
});
