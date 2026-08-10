import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Auth, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import type { AuthSetup } from "../src/auth/auth.setup";
import { AUTH, DB_POOL } from "../src/auth/auth.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashPairingCode } from "../src/pickup/device-token";
import {
  GLOBAL_PAIR_SOURCE,
  PAIR_ATTEMPT_WINDOW_MS,
} from "../src/modules/device-pairing/pairing-policy";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";
import { SecurityAuditService } from "../src/authorization/security-audit.service";
import { OperatorsService } from "../src/modules/operators/operators.service";
import { StationPairingService } from "../src/modules/station-pairing/station-pairing.service";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

function pairAttemptWindowStart(now: number): Date {
  return new Date(Math.floor(now / PAIR_ATTEMPT_WINDOW_MS) * PAIR_ATTEMPT_WINDOW_MS);
}

/** Only clears this suite's loopback/global limiter rows in the shared test DB. */
async function clearPairAttemptBudget(db: Db): Promise<void> {
  const current = pairAttemptWindowStart(Date.now());
  const previous = new Date(current.getTime() - PAIR_ATTEMPT_WINDOW_MS);
  await db
    .delete(schema.kioskPairAttempts)
    .where(
      and(
        inArray(schema.kioskPairAttempts.source, ["127.0.0.1", "0:0:0:0::/64", GLOBAL_PAIR_SOURCE]),
        inArray(schema.kioskPairAttempts.windowStartedAt, [current, previous]),
      ),
    );
}

describe.skipIf(!ready)("station pairing e2e", () => {
  let app: INestApplication | undefined;
  let db: Db;
  let agent: ReturnType<typeof request.agent>;
  let otherAgent: ReturnType<typeof request.agent>;
  let tenantId: string;
  let deviceId: string;
  let deviceName: string;
  let pairingCodePepper: string;
  let audit: SecurityAuditService;
  let auditSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const env = loadEnv();
    const setup = setupAuth(env);
    db = setup.db;
    pairingCodePepper = env.PAIRING_CODE_PEPPER;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await clearPairAttemptBudget(db);
    auditSpy = vi.spyOn(audit, "deviceCredentialMutation").mockImplementation(() => {});
    agent = request.agent(app!.getHttpServer());
    tenantId = await signUpAndActivate(agent);
    otherAgent = request.agent(app!.getHttpServer());
    await signUpAndActivate(otherAgent);
    const [line] = await db.insert(schema.lines).values({ tenantId, name: "Packing" }).returning();
    deviceName = `Station ${randomUUID()}`;
    const created = await agent
      .post("/station-devices")
      .send({ name: deviceName, lineId: line!.id })
      .expect(201);
    deviceId = created.body.id as string;
    const operatorId = randomUUID();
    await db.insert(schema.employees).values({
      id: operatorId,
      tenantId,
      fullName: "Pairing operator",
    });
    await db.insert(schema.operatorCredentials).values({
      tenantId,
      employeeId: operatorId,
      login: "4001",
      pinHash: "test-pbkdf2-verifier",
    });
  });

  async function pairCurrentDevice(): Promise<string> {
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const paired = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: issued.body.code })
      .expect(201);
    return paired.body.credential.apiKey as string;
  }

  async function manageCurrentTenant(maxStations: number): Promise<void> {
    const planVersionId = await createPublishedPlan(db, {
      maxLines: null,
      maxStations,
      maxKiosks: null,
      maxCabinetUsers: null,
    });
    await createManagedSubscription(db, { tenantId, planVersionId });
  }

  async function waitForQuotaWaiter(keyOrder: number): Promise<void> {
    const pool = app!.get<AuthSetup["pool"]>(DB_POOL);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ count: number }>(
        `select count(*)::int as count
         from pg_locks
         where locktype = 'advisory'
           and database = (select oid from pg_database where datname = current_database())
           and classid = hashtext($1)::oid
           and objid = $2::oid
           and objsubid = 2
           and not granted`,
        [`subscription-quota:${tenantId}`, keyOrder],
      );
      if ((result.rows[0]?.count ?? 0) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for the stations quota lock");
  }

  async function waitForExtendedLockWaiter(lockKey: string): Promise<void> {
    const pool = app!.get<AuthSetup["pool"]>(DB_POOL);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ count: number }>(
        `select count(*)::int as count
         from pg_locks
         where locktype = 'advisory'
           and database = (select oid from pg_database where datname = current_database())
           and classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
           and objid = (hashtextextended($1, 0) & 4294967295)::oid
           and objsubid = 1
           and not granted`,
        [lockKey],
      );
      if ((result.rows[0]?.count ?? 0) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for the station restore barrier");
  }

  it("issues an HMAC-protected 8-digit code and redeems it into one durable station credential", async () => {
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect("Cache-Control", "no-store")
      .expect(201);

    expect(issued.body.code).toMatch(/^\d{8}$/);
    expect(new Date(issued.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(13 * 60_000);
    expect(new Date(issued.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);

    const [storedCode] = await db
      .select()
      .from(schema.stationPairingCodes)
      .where(
        and(
          eq(schema.stationPairingCodes.tenantId, tenantId),
          eq(schema.stationPairingCodes.stationDeviceId, deviceId),
        ),
      );
    expect(storedCode!.codeHash).toBe(
      hashPairingCode(issued.body.code as string, pairingCodePepper),
    );
    expect(storedCode!.codeHash).not.toBe(issued.body.code);

    const paired = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: issued.body.code })
      .expect("Cache-Control", "no-store")
      .expect(201);

    expect(auditSpy).toHaveBeenCalledWith({
      tenantId,
      actorType: "unauthenticated_device",
      actorId: null,
      action: "station.pair",
      resourceId: deviceId,
      outcome: "succeeded",
    });
    const auditCalls = JSON.stringify(auditSpy.mock.calls);
    expect(auditCalls).not.toContain(issued.body.code as string);
    expect(auditCalls).not.toContain(paired.body.credential.apiKey as string);

    expect(paired.body).toMatchObject({
      device: {
        id: deviceId,
        tenantId,
        organizationName: "Test Plant",
        line: { id: expect.any(String), name: "Packing" },
      },
      credential: { apiKey: expect.any(String), serverUrl: loadEnv().BETTER_AUTH_URL },
      operators: [
        {
          operatorId: expect.any(String),
          name: "Pairing operator",
          login: "4001",
          pinHash: "test-pbkdf2-verifier",
          badgeHash: null,
          active: true,
        },
      ],
    });
    expect(paired.body.operators[0]).not.toHaveProperty("pin");
    expect(paired.body.operators[0]).not.toHaveProperty("badgeCode");

    const [device] = await db
      .select()
      .from(schema.stationDevices)
      .where(
        and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, deviceId)),
      );
    expect(device!.apiKeyId).toEqual(expect.any(String));
    expect(device!.pairedAt).toBeInstanceOf(Date);
    expect(device!.revokedAt).toBeNull();

    const [claimedCode] = await db
      .select({ usedAt: schema.stationPairingCodes.usedAt })
      .from(schema.stationPairingCodes)
      .where(eq(schema.stationPairingCodes.id, storedCode!.id));
    expect(claimedCode!.usedAt).toBeInstanceOf(Date);

    await request(app!.getHttpServer())
      .post(`/station-devices/${deviceId}/pairing-code`)
      .set("x-api-key", paired.body.credential.apiKey as string)
      .send({})
      .expect(403);
  });

  it("resolves only the authenticated station identity without echoing its credential", async () => {
    const otherDeviceName = `Other ${randomUUID()}`;
    await otherAgent
      .post("/station-devices")
      .send({ name: otherDeviceName, lineId: null })
      .expect(201);
    const apiKey = await pairCurrentDevice();

    const identity = await request(app!.getHttpServer())
      .get("/station/identity")
      .set("x-api-key", apiKey)
      .expect("Cache-Control", "no-store")
      .expect(200);

    expect(identity.body).toEqual({
      device: {
        id: deviceId,
        name: deviceName,
        tenantId,
        organizationName: "Test Plant",
        line: { id: expect.any(String), name: "Packing" },
      },
      subscription: {
        access: "unmanaged",
        status: "unmanaged",
        startsAt: null,
        endsAt: null,
      },
    });
    expect(JSON.stringify(identity.body)).not.toContain(apiKey);
    expect(JSON.stringify(identity.body)).not.toContain(otherDeviceName);
  });

  it("rejects sessions and orphaned or revoked station keys at the identity boundary", async () => {
    await agent.get("/station/identity").expect(403);

    const orphanedKey = await pairCurrentDevice();
    await db
      .update(schema.stationDevices)
      .set({ apiKeyId: null })
      .where(
        and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, deviceId)),
      );
    await request(app!.getHttpServer())
      .get("/station/identity")
      .set("x-api-key", orphanedKey)
      .expect(401);

    const reparing = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const repaired = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: reparing.body.code })
      .expect(201);
    await db
      .update(schema.stationDevices)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, deviceId)),
      );
    await request(app!.getHttpServer())
      .get("/station/identity")
      .set("x-api-key", repaired.body.credential.apiKey as string)
      .expect(401);
  });

  it("retires a previous live code and preserves one live code per station", async () => {
    const first = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    await agent.post(`/station-devices/${deviceId}/pairing-code`).send({}).expect(201);

    const rows = await db
      .select()
      .from(schema.stationPairingCodes)
      .where(
        and(
          eq(schema.stationPairingCodes.tenantId, tenantId),
          eq(schema.stationPairingCodes.stationDeviceId, deviceId),
        ),
      );
    expect(rows.filter((row) => row.usedAt === null)).toHaveLength(1);
    expect(
      rows.find((row) => row.codeHash === hashPairingCode(first.body.code, pairingCodePepper))
        ?.usedAt,
    ).toBeInstanceOf(Date);
  });

  it("uses stable public error codes without exposing station details", async () => {
    auditSpy.mockClear();
    const unknown = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: "99999999" })
      .expect(401);
    expect(unknown.body).toMatchObject({ code: "PAIR_INVALID" });
    expect(JSON.stringify(unknown.body)).not.toContain(deviceId);
    expect(auditSpy).toHaveBeenLastCalledWith({
      tenantId: null,
      actorType: "unauthenticated_device",
      actorId: null,
      action: "station.pair",
      resourceId: null,
      outcome: "failed",
    });

    await pairCurrentDevice();

    const expired = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    await db
      .update(schema.stationPairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(
        eq(
          schema.stationPairingCodes.codeHash,
          hashPairingCode(expired.body.code, pairingCodePepper),
        ),
      );
    auditSpy.mockClear();
    const expiredResult = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: expired.body.code })
      .expect(401);
    expect(expiredResult.body).toMatchObject({ code: "PAIR_EXPIRED" });
    expect(auditSpy).toHaveBeenLastCalledWith({
      tenantId,
      actorType: "unauthenticated_device",
      actorId: null,
      action: "station.repair",
      resourceId: deviceId,
      outcome: "failed",
    });

    const locked = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    await db
      .update(schema.stationPairingCodes)
      .set({ attempts: 5 })
      .where(
        eq(
          schema.stationPairingCodes.codeHash,
          hashPairingCode(locked.body.code, pairingCodePepper),
        ),
      );
    auditSpy.mockClear();
    const lockedResult = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: locked.body.code })
      .expect(401);
    expect(lockedResult.body).toMatchObject({ code: "PAIR_LOCKED" });
    expect(auditSpy).toHaveBeenLastCalledWith({
      tenantId,
      actorType: "unauthenticated_device",
      actorId: null,
      action: "station.repair",
      resourceId: deviceId,
      outcome: "failed",
    });
  });

  it("applies the global limiter before lookup and leaves its code live", async () => {
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    await db.insert(schema.kioskPairAttempts).values({
      source: GLOBAL_PAIR_SOURCE,
      windowStartedAt: pairAttemptWindowStart(Date.now()),
      failures: 401,
    });

    const limited = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: issued.body.code })
      .expect(401);
    expect(limited.body).toMatchObject({ code: "PAIR_RATE_LIMITED" });
    expect(auditSpy).toHaveBeenLastCalledWith({
      tenantId: null,
      actorType: "unauthenticated_device",
      actorId: null,
      action: "station.pair",
      resourceId: null,
      outcome: "failed",
    });
    const [code] = await db
      .select({ usedAt: schema.stationPairingCodes.usedAt })
      .from(schema.stationPairingCodes)
      .where(
        eq(
          schema.stationPairingCodes.codeHash,
          hashPairingCode(issued.body.code, pairingCodePepper),
        ),
      );
    expect(code!.usedAt).toBeNull();
  });

  it("allows one concurrent winner and deletes the losing candidate key", async () => {
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const [first, second] = await Promise.all([
      request(app!.getHttpServer()).post("/station/pair").send({ code: issued.body.code }),
      request(app!.getHttpServer()).post("/station/pair").send({ code: issued.body.code }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 401]);

    const [station] = await db
      .select({ apiKeyId: schema.stationDevices.apiKeyId })
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, deviceId));
    const keys = await db
      .select({ id: schema.apikey.id })
      .from(schema.apikey)
      .where(and(eq(schema.apikey.referenceId, tenantId), eq(schema.apikey.configId, "station")));
    expect(keys).toEqual([{ id: station!.apiKeyId! }]);
  });

  it("re-pairs the same revoked durable station record", async () => {
    await agent.delete(`/station-devices/${deviceId}`).expect(204);
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const paired = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: issued.body.code })
      .expect(201);

    expect(paired.body.device.id).toBe(deviceId);
    const [station] = await db
      .select({
        apiKeyId: schema.stationDevices.apiKeyId,
        revokedAt: schema.stationDevices.revokedAt,
      })
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, deviceId));
    expect(station).toMatchObject({ apiKeyId: expect.any(String), revokedAt: null });
  });

  it("rejects revoked station restoration when another live station filled its slot", async () => {
    await manageCurrentTenant(1);
    await agent.delete(`/station-devices/${deviceId}`).expect(204);
    const [revokedBefore] = await db
      .select({ revokedAt: schema.stationDevices.revokedAt })
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, deviceId));
    const replacement = await agent
      .post("/station-devices")
      .send({ name: "Replacement station", lineId: null })
      .expect(201);
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const [storedCode] = await db
      .select({ id: schema.stationPairingCodes.id })
      .from(schema.stationPairingCodes)
      .where(
        eq(
          schema.stationPairingCodes.codeHash,
          hashPairingCode(issued.body.code as string, pairingCodePepper),
        ),
      );
    auditSpy.mockClear();

    const rejected = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: issued.body.code })
      .expect(409);
    expect(rejected.body).toEqual({
      code: "subscription_limit_reached",
      entitlement: "stations",
      used: 1,
      limit: 1,
    });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledWith({
      tenantId,
      actorType: "unauthenticated_device",
      actorId: null,
      action: "station.pair",
      resourceId: deviceId,
      outcome: "failed",
    });
    await expect(
      db
        .select({
          apiKeyId: schema.stationDevices.apiKeyId,
          revokedAt: schema.stationDevices.revokedAt,
        })
        .from(schema.stationDevices)
        .where(eq(schema.stationDevices.id, deviceId)),
    ).resolves.toEqual([{ apiKeyId: null, revokedAt: revokedBefore!.revokedAt }]);
    await expect(
      db
        .select({ usedAt: schema.stationPairingCodes.usedAt })
        .from(schema.stationPairingCodes)
        .where(eq(schema.stationPairingCodes.id, storedCode!.id)),
    ).resolves.toEqual([{ usedAt: null }]);
    await expect(
      db
        .select({ id: schema.apikey.id })
        .from(schema.apikey)
        .where(and(eq(schema.apikey.referenceId, tenantId), eq(schema.apikey.configId, "station"))),
    ).resolves.toEqual([]);
    await expect(
      db
        .select({ id: schema.stationDevices.id })
        .from(schema.stationDevices)
        .where(
          and(
            eq(schema.stationDevices.tenantId, tenantId),
            isNull(schema.stationDevices.revokedAt),
          ),
        ),
    ).resolves.toEqual([{ id: replacement.body.id as string }]);
  });

  it("serializes revoked restoration against final-slot creation", async () => {
    await manageCurrentTenant(1);
    await agent.delete(`/station-devices/${deviceId}`).expect(204);
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const pool = app!.get<AuthSetup["pool"]>(DB_POOL);
    const suffix = randomUUID().replaceAll("-", "_");
    const lockKey = `station-restore-barrier:${suffix}`;
    const functionName = `wait_for_station_restore_${suffix}`;
    const triggerName = `wait_for_station_restore_${suffix}`;
    const blocker = await pool.connect();
    let blockerHeld = false;
    let paired: request.Response | undefined;
    let created: request.Response | undefined;
    let createPhase: "waiting" | "settled" | undefined;
    try {
      await pool.query(`
        create function ${functionName}() returns trigger language plpgsql as $$
        begin
          perform pg_advisory_xact_lock(hashtextextended('${lockKey}', 0));
          return new;
        end
        $$
      `);
      await pool.query(`
        create trigger ${triggerName}
        before update of revoked_at on station_devices
        for each row
        when (
          old.id = '${deviceId}'::uuid
          and old.revoked_at is not null
          and new.revoked_at is null
        )
        execute function ${functionName}()
      `);
      await blocker.query("select pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
      blockerHeld = true;
      const pairAttempt = request(app!.getHttpServer())
        .post("/station/pair")
        .send({ code: issued.body.code })
        .then((row) => row);
      await waitForExtendedLockWaiter(lockKey);
      const createAttempt = agent
        .post("/station-devices")
        .send({ name: "Concurrent final station", lineId: null })
        .then((row) => row);
      createPhase = await Promise.race([
        waitForQuotaWaiter(2).then(() => "waiting" as const),
        createAttempt.then(() => "settled" as const),
      ]);
      await blocker.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      blockerHeld = false;
      [paired, created] = await Promise.all([pairAttempt, createAttempt]);
    } finally {
      if (blockerHeld) {
        await blocker
          .query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
          .catch(() => undefined);
      }
      blocker.release();
      await pool.query(`drop trigger if exists ${triggerName} on station_devices`);
      await pool.query(`drop function if exists ${functionName}()`);
    }

    expect(createPhase).toBe("waiting");
    expect(paired?.status).toBe(201);
    expect(created?.status).toBe(409);
    expect(created?.body).toEqual({
      code: "subscription_limit_reached",
      entitlement: "stations",
      used: 1,
      limit: 1,
    });
    const live = await db
      .select({ id: schema.stationDevices.id })
      .from(schema.stationDevices)
      .where(
        and(eq(schema.stationDevices.tenantId, tenantId), isNull(schema.stationDevices.revokedAt)),
      );
    expect(live).toEqual([{ id: deviceId }]);
  });

  it("rotates an active station key so only the replacement can reach station routes", async () => {
    await manageCurrentTenant(1);
    const firstCode = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const firstPair = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: firstCode.body.code })
      .expect(201);
    const oldKey = firstPair.body.credential.apiKey as string;

    const replacementCode = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    auditSpy.mockClear();
    const replacementPair = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: replacementCode.body.code })
      .expect(201);
    const newKey = replacementPair.body.credential.apiKey as string;

    expect(auditSpy).toHaveBeenCalledWith({
      tenantId,
      actorType: "unauthenticated_device",
      actorId: null,
      action: "station.repair",
      resourceId: deviceId,
      outcome: "succeeded",
    });

    expect(replacementPair.body.device.id).toBe(deviceId);
    expect(newKey).not.toBe(oldKey);
    await request(app!.getHttpServer())
      .get("/station/operators")
      .set("x-api-key", oldKey)
      .expect(401);
    await request(app!.getHttpServer())
      .get("/station/operators")
      .set("x-api-key", newKey)
      .expect(200);

    const keys = await db
      .select({ id: schema.apikey.id })
      .from(schema.apikey)
      .where(and(eq(schema.apikey.referenceId, tenantId), eq(schema.apikey.configId, "station")));
    expect(keys).toHaveLength(1);
  });

  it("deletes a losing candidate with the persisted fallback when direct deletion fails", async () => {
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const directDelete = vi.spyOn(db, "delete").mockImplementationOnce(() => {
      throw new Error("forced direct key delete failure");
    });
    try {
      const [first, second] = await Promise.all([
        request(app!.getHttpServer()).post("/station/pair").send({ code: issued.body.code }),
        request(app!.getHttpServer()).post("/station/pair").send({ code: issued.body.code }),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 401]);
    } finally {
      directDelete.mockRestore();
    }

    const keys = await db
      .select({ id: schema.apikey.id })
      .from(schema.apikey)
      .where(and(eq(schema.apikey.referenceId, tenantId), eq(schema.apikey.configId, "station")));
    expect(keys).toHaveLength(1);
  });

  it("does not relink an active station when old-key deletion cannot be proven", async () => {
    const firstCode = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const firstPair = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: firstCode.body.code })
      .expect(201);
    const oldKey = firstPair.body.credential.apiKey as string;
    const [before] = await db
      .select({ apiKeyId: schema.stationDevices.apiKeyId })
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, deviceId));
    const replacementCode = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);

    const pool = app!.get<AuthSetup["pool"]>(DB_POOL);
    const objectScope = deviceId.replaceAll("-", "");
    const blockedKeyTable = `sp_blocked_key_${objectScope}`;
    const rejectDeleteFunction = `sp_reject_key_delete_${objectScope}`;
    const rejectDeleteTrigger = `sp_reject_key_delete_trigger_${objectScope}`;
    const identifier = (value: string) => `"${value}"`;
    let primaryError: unknown;
    let hasPrimaryError = false;
    try {
      await pool.query(`CREATE TABLE ${identifier(blockedKeyTable)} (id text PRIMARY KEY)`);
      await pool.query(`INSERT INTO ${identifier(blockedKeyTable)} (id) VALUES ($1)`, [
        before!.apiKeyId,
      ]);
      await pool.query(`
        CREATE FUNCTION ${identifier(rejectDeleteFunction)}()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF OLD.id = (SELECT id FROM ${identifier(blockedKeyTable)} LIMIT 1) THEN
            RAISE EXCEPTION 'forced persisted old-key delete failure';
          END IF;
          RETURN OLD;
        END;
        $$
      `);
      await pool.query(`
        CREATE TRIGGER ${identifier(rejectDeleteTrigger)}
        BEFORE DELETE ON apikey
        FOR EACH ROW EXECUTE FUNCTION ${identifier(rejectDeleteFunction)}()
      `);
      await request(app!.getHttpServer())
        .post("/station/pair")
        .send({ code: replacementCode.body.code })
        .expect(500);
      expect(auditSpy).toHaveBeenLastCalledWith({
        tenantId,
        actorType: "unauthenticated_device",
        actorId: null,
        action: "station.repair",
        resourceId: deviceId,
        outcome: "failed",
      });
    } catch (error) {
      primaryError = error;
      hasPrimaryError = true;
    }

    let cleanupError: unknown;
    for (const cleanup of [
      () => pool.query(`DROP TRIGGER IF EXISTS ${identifier(rejectDeleteTrigger)} ON apikey`),
      () => pool.query(`DROP FUNCTION IF EXISTS ${identifier(rejectDeleteFunction)}() CASCADE`),
      () => pool.query(`DROP TABLE IF EXISTS ${identifier(blockedKeyTable)}`),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (hasPrimaryError) throw primaryError;
    if (cleanupError !== undefined) throw cleanupError;

    await request(app!.getHttpServer())
      .get("/station/operators")
      .set("x-api-key", oldKey)
      .expect(200);
    const [station] = await db
      .select({ apiKeyId: schema.stationDevices.apiKeyId })
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, deviceId));
    const keys = await db
      .select({ id: schema.apikey.id })
      .from(schema.apikey)
      .where(and(eq(schema.apikey.referenceId, tenantId), eq(schema.apikey.configId, "station")));
    expect(keys).toEqual([{ id: station!.apiKeyId! }]);
  });

  it("keeps the active key when a regenerated code loses after candidate provisioning", async () => {
    const firstCode = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const firstPair = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: firstCode.body.code })
      .expect(201);
    const oldKey = firstPair.body.credential.apiKey as string;
    const [before] = await db
      .select({ apiKeyId: schema.stationDevices.apiKeyId })
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, deviceId));

    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const auth = app!.get<Auth>(AUTH);
    const createApiKey = auth.api.createApiKey.bind(auth.api);
    const candidateBeforeClaim = vi
      .spyOn(auth.api, "createApiKey")
      .mockImplementationOnce(async (input) => {
        const candidate = await createApiKey(input);
        await agent.post(`/station-devices/${deviceId}/pairing-code`).send({}).expect(201);
        return candidate;
      });
    try {
      const lost = await request(app!.getHttpServer())
        .post("/station/pair")
        .send({ code: issued.body.code })
        .expect(401);
      expect(lost.body).toMatchObject({ code: "PAIR_INVALID" });
      expect(auditSpy).toHaveBeenLastCalledWith({
        tenantId,
        actorType: "unauthenticated_device",
        actorId: null,
        action: "station.repair",
        resourceId: deviceId,
        outcome: "failed",
      });
    } finally {
      candidateBeforeClaim.mockRestore();
    }

    await request(app!.getHttpServer())
      .get("/station/operators")
      .set("x-api-key", oldKey)
      .expect(200);
    const [after] = await db
      .select({ apiKeyId: schema.stationDevices.apiKeyId })
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, deviceId));
    expect(after!.apiKeyId).toBe(before!.apiKeyId);
    const keys = await db
      .select({ id: schema.apikey.id })
      .from(schema.apikey)
      .where(and(eq(schema.apikey.referenceId, tenantId), eq(schema.apikey.configId, "station")));
    expect(keys).toEqual([{ id: before!.apiKeyId! }]);
  });

  it("rejects a previously used station code with PAIR_INVALID", async () => {
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: issued.body.code })
      .expect(201);

    const reused = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: issued.body.code })
      .expect(401);
    expect(reused.body).toMatchObject({ code: "PAIR_INVALID" });
  });

  it("classifies a roster failure for an already paired station as repair", async () => {
    await pairCurrentDevice();
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const rosterError = new Error("operator roster unavailable");
    vi.spyOn(app!.get(OperatorsService), "buildRoster").mockRejectedValueOnce(rosterError);
    const selectSpy = vi.spyOn(db, "select");
    auditSpy.mockClear();

    await expect(
      app!.get(StationPairingService).redeem(issued.body.code as string, `test-${randomUUID()}`),
    ).rejects.toBe(rosterError);
    expect(auditSpy).toHaveBeenCalledWith({
      tenantId,
      actorType: "unauthenticated_device",
      actorId: null,
      action: "station.repair",
      resourceId: deviceId,
      outcome: "failed",
    });
    const calls = JSON.stringify(auditSpy.mock.calls);
    expect(calls).not.toContain(issued.body.code as string);
    expect(calls).not.toContain("operator roster unavailable");
    expect(
      selectSpy.mock.calls.some(
        ([projection]) =>
          projection !== undefined && "hasExistingCredential" in (projection as object),
      ),
    ).toBe(true);
    expect(selectSpy).not.toHaveBeenCalledWith({ apiKeyId: schema.stationDevices.apiKeyId });
  });

  it("does not let an audit sink failure replace validation or roster errors", async () => {
    const pairing = app!.get(StationPairingService);
    auditSpy.mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });

    await expect(pairing.redeem("99999999", `test-${randomUUID()}`)).rejects.toMatchObject({
      response: { code: "PAIR_INVALID" },
    });

    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const rosterError = new Error("roster database unavailable");
    vi.spyOn(app!.get(OperatorsService), "buildRoster").mockRejectedValueOnce(rosterError);
    await expect(pairing.redeem(issued.body.code as string, `test-${randomUUID()}`)).rejects.toBe(
      rosterError,
    );
  });

  it("lets the locked station row override the code lookup classification", async () => {
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    const auth = app!.get<Auth>(AUTH);
    const operators = app!.get(OperatorsService);
    const buildRoster = operators.buildRoster.bind(operators);
    vi.spyOn(operators, "buildRoster").mockImplementationOnce(async (resolvedTenantId) => {
      const roster = await buildRoster(resolvedTenantId);
      const existing = await auth.api.createApiKey({
        body: {
          configId: "station",
          organizationId: tenantId,
          userId: member!.userId,
          name: "Station device",
          metadata: { kind: "station" },
        },
      });
      await db
        .update(schema.stationDevices)
        .set({ apiKeyId: existing.id, pairedAt: new Date() })
        .where(
          and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, deviceId)),
        );
      return roster;
    });
    auditSpy.mockClear();

    await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: issued.body.code })
      .expect(201);
    expect(auditSpy).toHaveBeenCalledWith({
      tenantId,
      actorType: "unauthenticated_device",
      actorId: null,
      action: "station.repair",
      resourceId: deviceId,
      outcome: "succeeded",
    });
  });

  it("audits a station revoked after code resolution from the locked credential state", async () => {
    await pairCurrentDevice();
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const operators = app!.get(OperatorsService);
    const buildRoster = operators.buildRoster.bind(operators);
    vi.spyOn(operators, "buildRoster").mockImplementationOnce(async (resolvedTenantId) => {
      const roster = await buildRoster(resolvedTenantId);
      await agent.delete(`/station-devices/${deviceId}`).expect(204);
      return roster;
    });
    auditSpy.mockClear();

    const rejected = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code: issued.body.code })
      .expect(401);
    expect(rejected.body).toMatchObject({ code: "PAIR_INVALID" });
    expect(auditSpy).toHaveBeenCalledWith({
      tenantId,
      actorType: "unauthenticated_device",
      actorId: null,
      action: "station.pair",
      resourceId: deviceId,
      outcome: "failed",
    });
    const [station] = await db
      .select({
        apiKeyId: schema.stationDevices.apiKeyId,
        revokedAt: schema.stationDevices.revokedAt,
      })
      .from(schema.stationDevices)
      .where(
        and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, deviceId)),
      );
    expect(station).toMatchObject({ apiKeyId: null, revokedAt: expect.any(Date) });
  });

  it("hides a station from another tenant when issuing a pairing code", async () => {
    await otherAgent.post(`/station-devices/${deviceId}/pairing-code`).send({}).expect(404);
  });

  it("rejects a verified but unlinked station key from station-only routes", async () => {
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    const auth = app!.get<Auth>(AUTH);
    const orphan = await auth.api.createApiKey({
      body: {
        configId: "station",
        organizationId: tenantId,
        userId: member!.userId,
        name: "Station device",
        metadata: { kind: "station" },
      },
    });

    await request(app!.getHttpServer())
      .get("/station/operators")
      .set("x-api-key", orphan.key)
      .expect(401);
  });
});
