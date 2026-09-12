import { stationRecoveryResponseSchema } from "@markiro/platform-contracts";
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
import {
  preTask8IdentityDecoderAccepts,
  preTask8PairDecoderAccepts,
} from "./support/pre-task8-station-decoders";

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
  let otherTenantId: string;
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
    otherTenantId = await signUpAndActivate(otherAgent);
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

  async function waitForQuotaWaiter(keyOrder: number, minimum = 1): Promise<void> {
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
      if ((result.rows[0]?.count ?? 0) >= minimum) return;
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

  function recoveryPair(
    code: string,
    expected = { tenantId, deviceId, kind: "station" },
    capabilities = "",
  ) {
    return request(app!.getHttpServer())
      .post("/station/pair/recovery")
      .set("x-station-capabilities", capabilities)
      .send({ version: 1, code, expected });
  }

  async function recoveryState() {
    const devices = await db
      .select()
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.tenantId, tenantId));
    const keys = await db
      .select()
      .from(schema.apikey)
      .where(and(eq(schema.apikey.referenceId, tenantId), eq(schema.apikey.configId, "station")));
    return { devices, keys };
  }

  async function issueRecoveryCode(): Promise<string> {
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    return issued.body.code as string;
  }

  async function expectRecoveryCodeLive(code: string) {
    const [row] = await db
      .select()
      .from(schema.stationPairingCodes)
      .where(eq(schema.stationPairingCodes.codeHash, hashPairingCode(code, pairingCodePepper)));
    expect(row?.usedAt).toBeNull();
    expect(row?.attempts).toBe(0);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  }

  it.each(["device", "tenant", "kind"])(
    "recovery rejects mismatched %s before minting without changing the current credential",
    async (field) => {
      await pairCurrentDevice();
      const code = await issueRecoveryCode();
      const mint = vi.spyOn(app!.get<Auth>(AUTH).api, "createApiKey");
      const expected = { tenantId, deviceId, kind: "station" };
      if (field === "device") {
        const other = await agent
          .post("/station-devices")
          .send({ name: "Other station", lineId: null })
          .expect(201);
        expected.deviceId = other.body.id as string;
      }
      if (field === "tenant") expected.tenantId = otherTenantId;
      if (field === "kind") expected.kind = "handheld";
      const before = await recoveryState();
      const result = await recoveryPair(code, expected).expect(401);
      expect(result.body).toEqual({ code: "PAIR_RECOVERY_MISMATCH" });
      expect(mint).not.toHaveBeenCalled();
      expect(await recoveryState()).toEqual(before);
      await expectRecoveryCodeLive(code);
      expect(auditSpy).toHaveBeenLastCalledWith({
        tenantId,
        actorType: "unauthenticated_device",
        actorId: null,
        action: "station.repair",
        resourceId: deviceId,
        outcome: "failed",
      });
    },
  );

  it("recovery rejects incompatible client capability independently of matching identity", async () => {
    const code = await issueRecoveryCode();
    const before = await recoveryState();
    const result = await recoveryPair(
      code,
      { tenantId, deviceId, kind: "station" },
      "handheld-v1",
    ).expect(401);
    expect(result.body).toEqual({ code: "PAIR_KIND_MISMATCH" });
    expect(await recoveryState()).toEqual(before);
    await expectRecoveryCodeLive(code);
  });

  it("recovery rotates an active same-ID credential at full quota and rejects the old key", async () => {
    const oldKey = await pairCurrentDevice();
    await manageCurrentTenant(1);
    const code = await issueRecoveryCode();
    const result = await recoveryPair(
      code,
      { tenantId, deviceId, kind: "station" },
      "subscription-state-v1",
    )
      .expect("Cache-Control", "no-store")
      .expect(201);
    expect(stationRecoveryResponseSchema.parse(result.body)).toEqual(result.body);
    expect(result.body.version).toBe(1);
    expect(result.body.device).toMatchObject({ id: deviceId, tenantId, kind: "station" });
    expect(result.body.subscription).toBeDefined();
    expect(result.body.operators).toHaveLength(1);
    await request(app!.getHttpServer())
      .get("/station/operators")
      .set("x-api-key", oldKey)
      .expect(401);
    await request(app!.getHttpServer())
      .get("/station/operators")
      .set("x-api-key", result.body.credential.apiKey as string)
      .expect(200);
    const state = await recoveryState();
    expect(state.keys).toHaveLength(1);
    expect(state.devices).toHaveLength(1);
    expect(auditSpy).toHaveBeenLastCalledWith({
      tenantId,
      actorType: "unauthenticated_device",
      actorId: null,
      action: "station.repair",
      resourceId: deviceId,
      outcome: "succeeded",
    });
  });

  it.each(["expired", "pending_activation"])(
    "recovery preserves the current key when subscription is %s",
    async (status) => {
      await pairCurrentDevice();
      const code = await issueRecoveryCode();
      const before = await recoveryState();
      await createManagedSubscription(db, {
        tenantId,
        status: status === "expired" ? "active" : "pending_activation",
        startsAt: status === "expired" ? new Date(Date.now() - 60_000) : null,
        endsAt: status === "expired" ? new Date(Date.now() - 1000) : null,
      });
      const mint = vi.spyOn(app!.get<Auth>(AUTH).api, "createApiKey");
      await recoveryPair(code).expect(403);
      expect(mint).not.toHaveBeenCalled();
      expect(await recoveryState()).toEqual(before);
      await expectRecoveryCodeLive(code);
    },
  );

  it("recovery restores a revoked handheld with the same identity and optional subscription omitted", async () => {
    const handheld = await agent
      .post("/station-devices")
      .send({ name: "Handheld", kind: "handheld", lineId: null })
      .expect(201);
    const handheldId = handheld.body.id as string;
    await agent.delete(`/station-devices/${handheldId}`).expect(204);
    const issued = await agent
      .post(`/station-devices/${handheldId}/pairing-code`)
      .send({})
      .expect(201);
    const expected = { tenantId, deviceId: handheldId, kind: "handheld" };
    const before = await recoveryState();
    const mismatch = await recoveryPair(issued.body.code as string, expected).expect(401);
    expect(mismatch.body).toEqual({ code: "PAIR_KIND_MISMATCH" });
    expect(await recoveryState()).toEqual(before);
    const result = await recoveryPair(issued.body.code as string, expected, "handheld-v1").expect(
      201,
    );
    expect(result.body).toMatchObject({
      version: 1,
      device: { id: handheldId, tenantId, kind: "handheld" },
    });
    expect(result.body).not.toHaveProperty("subscription");
    const [device] = await db
      .select()
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, handheldId));
    expect(device?.revokedAt).toBeNull();
  });

  it("recovery rejects malformed identity before provisioning", async () => {
    const code = await issueRecoveryCode();
    const mint = vi.spyOn(app!.get<Auth>(AUTH).api, "createApiKey");
    await recoveryPair(code, { tenantId, deviceId: "not-a-uuid", kind: "station" }).expect(400);
    expect(mint).not.toHaveBeenCalled();
    await expectRecoveryCodeLive(code);
  });

  it.each([false, true])(
    "rechecks identity and client kind under the device lock and cleans up its candidate (recovery=%s)",
    async (recovery) => {
      await pairCurrentDevice();
      const code = await issueRecoveryCode();
      const before = await recoveryState();
      const auth = app!.get<Auth>(AUTH);
      const create = auth.api.createApiKey.bind(auth.api);
      vi.spyOn(auth.api, "createApiKey").mockImplementationOnce(async (input) => {
        const key = await create(input);
        await db
          .update(schema.stationDevices)
          .set({ kind: "handheld" })
          .where(eq(schema.stationDevices.id, deviceId));
        return key;
      });
      const result = await (
        recovery
          ? recoveryPair(code)
          : request(app!.getHttpServer()).post("/station/pair").send({ code })
      ).expect(401);
      expect(result.body).toEqual({
        code: recovery ? "PAIR_RECOVERY_MISMATCH" : "PAIR_KIND_MISMATCH",
      });
      const after = await recoveryState();
      expect(after.keys).toEqual(before.keys);
      expect(after.devices).toEqual(before.devices.map((row) => ({ ...row, kind: "handheld" })));
      await expectRecoveryCodeLive(code);
    },
  );

  async function quotaQueue(
    first: () => Promise<request.Response>,
    second: () => Promise<request.Response>,
  ) {
    const blocker = await app!.get<AuthSetup["pool"]>(DB_POOL).connect();
    let a: Promise<request.Response> | undefined;
    let b: Promise<request.Response> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("select pg_advisory_xact_lock(hashtext($1), 2)", [
        `subscription-quota:${tenantId}`,
      ]);
      a = first();
      await waitForQuotaWaiter(2);
      b = second();
      await waitForQuotaWaiter(2, 2);
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
    }
    return Promise.all([a!, b!]);
  }

  it.each(["cancel", "create"] as const)(
    "serializes final-slot creation and reservation cancellation with %s first",
    async (first) => {
      await manageCurrentTenant(1);
      const cancel = () =>
        agent
          .post(`/device-licensing/${deviceId}/cancel-reservation`)
          .send({ requestId: randomUUID(), expectedRevision: 1 })
          .then((r) => r);
      const create = () =>
        agent
          .post("/station-devices")
          .send({ name: "Next handheld", kind: "handheld", lineId: null })
          .then((r) => r);
      const [a, b] = await quotaQueue(
        first === "cancel" ? cancel : create,
        first === "cancel" ? create : cancel,
      );
      expect(a.status).toBe(first === "cancel" ? 200 : 409);
      expect(b.status).toBe(first === "cancel" ? 201 : 200);
      const projection = (await agent.get("/device-licensing").expect(200)).body;
      expect(projection).toMatchObject({
        integrity: "ready",
        usage: first === "cancel" ? 1 : 0,
        limit: 1,
      });
      expect(projection.devices).toEqual(
        expect.arrayContaining([expect.objectContaining({ deviceId, state: "released" })]),
      );
    },
  );

  it.each(["kind", "pair"] as const)(
    "serializes kind changes and pairing with %s first",
    async (first) => {
      const code = await issueRecoveryCode();
      const update = () =>
        agent
          .patch(`/station-devices/${deviceId}`)
          .send({ kind: "handheld" })
          .then((r) => r);
      const pair = () =>
        request(app!.getHttpServer())
          .post("/station/pair")
          .send({ code })
          .then((r) => r);
      const [a, b] = await quotaQueue(
        first === "kind" ? update : pair,
        first === "kind" ? pair : update,
      );
      expect(a.status).toBe(first === "kind" ? 200 : 201);
      expect(b.status).toBe(first === "kind" ? 401 : 409);
      const projection = (await agent.get("/device-licensing").expect(200)).body;
      expect(projection).toMatchObject({
        integrity: "ready",
        usage: 1,
        devices: [
          {
            kind: first === "kind" ? "handheld" : "station",
            state: first === "kind" ? "reserved" : "assigned",
            revision: 2,
          },
        ],
      });
      expect((await recoveryState()).keys).toHaveLength(first === "kind" ? 0 : 1);
    },
  );

  it("deletes a credential linked after the security revoke's initial read", async () => {
    const code = await issueRecoveryCode();
    const [paired, revoked] = await quotaQueue(
      () =>
        request(app!.getHttpServer())
          .post("/station/pair")
          .send({ code })
          .then((r) => r),
      () => agent.delete(`/station-devices/${deviceId}`).then((r) => r),
    );
    expect(paired.status).toBe(201);
    expect(revoked.status).toBe(204);
    const after = await recoveryState();
    expect(after.keys).toHaveLength(0);
    expect(after.devices[0]).toMatchObject({ apiKeyId: null, revokedAt: expect.any(Date) });
    expect((await agent.get("/device-licensing").expect(200)).body).toMatchObject({
      integrity: "ready",
      usage: 0,
      devices: [{ state: "released", releaseReason: "security_revoked" }],
    });
  });

  it("allows read-only cancellation without a lifecycle policy while keeping enrollment blocked", async () => {
    await createManagedSubscription(db, {
      tenantId,
      maxStations: 1,
      startsAt: new Date(Date.now() - 3600000),
      endsAt: new Date(Date.now() - 60000),
    });
    const inspection = await agent.get("/device-licensing").expect(200);
    expect(inspection.body.devices[0]).toMatchObject({ deviceId, canCancel: true });
    await agent
      .post("/station-devices")
      .send({ name: "Blocked enrollment", lineId: null })
      .expect(403);
    await agent.post(`/station-devices/${deviceId}/pairing-code`).send({}).expect(403);
    await agent
      .post(`/device-licensing/${deviceId}/cancel-reservation`)
      .send({ requestId: randomUUID(), expectedRevision: 1 })
      .expect(200);
    expect((await agent.get("/device-licensing").expect(200)).body).toMatchObject({
      usage: 0,
      devices: [{ state: "released" }],
    });
  });

  it.each(["cancel", "issue"] as const)(
    "serializes code issuance and cancellation with %s first",
    async (first) => {
      const cancel = () =>
        agent
          .post(`/device-licensing/${deviceId}/cancel-reservation`)
          .send({ requestId: randomUUID(), expectedRevision: 1 })
          .then((r) => r);
      const issue = () =>
        agent
          .post(`/station-devices/${deviceId}/pairing-code`)
          .send({})
          .then((r) => r);
      const [a, b] = await quotaQueue(
        first === "cancel" ? cancel : issue,
        first === "cancel" ? issue : cancel,
      );
      expect(a.status).toBe(first === "cancel" ? 200 : 201);
      expect(b.status).toBe(first === "cancel" ? 409 : 200);
      const liveCodes = await db
        .select()
        .from(schema.stationPairingCodes)
        .where(
          and(
            eq(schema.stationPairingCodes.stationDeviceId, deviceId),
            isNull(schema.stationPairingCodes.usedAt),
          ),
        );
      expect(liveCodes).toEqual([]);
      expect((await agent.get("/device-licensing").expect(200)).body).toMatchObject({ usage: 0 });
    },
  );

  it("assigns the existing reservation without consuming a second place", async () => {
    const before = await agent.get("/device-licensing").expect(200);
    await pairCurrentDevice();
    const after = await agent.get("/device-licensing").expect(200);
    expect(after.body).toMatchObject({
      usage: 1,
      integrity: "ready",
      devices: [
        {
          assignmentId: before.body.devices[0].assignmentId,
          state: "assigned",
          revision: 2,
          canCancel: false,
        },
      ],
    });
    const events = await db
      .select()
      .from(schema.workingDeviceEvents)
      .where(eq(schema.workingDeviceEvents.deviceId, deviceId));
    const [membership] = await db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, tenantId), eq(schema.member.role, "owner")));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId,
          deviceId,
          action: "reserved",
          actorDomain: "cabinet",
          actorId: membership!.userId,
          before: null,
          outcome: "success",
        }),
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "assigned",
          actorDomain: "device",
          actorId: deviceId,
          before: expect.objectContaining({ state: "reserved" }),
          after: expect.objectContaining({ state: "assigned" }),
        }),
      ]),
    );
  });

  it.each([false, true])(
    "rejects a cancelled reservation after candidate provisioning (recovery=%s)",
    async (recovery) => {
      const code = await issueRecoveryCode();
      const before = await recoveryState();
      const auth = app!.get<Auth>(AUTH);
      const mint = auth.api.createApiKey.bind(auth.api);
      vi.spyOn(auth.api, "createApiKey").mockImplementationOnce(async (input) => {
        const key = await mint(input);
        await agent
          .post(`/device-licensing/${deviceId}/cancel-reservation`)
          .send({ requestId: randomUUID(), expectedRevision: 1 })
          .expect(200);
        return key;
      });
      const result = await (
        recovery
          ? recoveryPair(code)
          : request(app!.getHttpServer()).post("/station/pair").send({ code })
      ).expect(401);
      expect(result.body).toEqual({ code: "PAIR_INVALID" });
      const after = await recoveryState();
      expect(after.keys).toEqual(before.keys);
      expect(after.devices).toEqual(before.devices);
      await agent.post(`/station-devices/${deviceId}/pairing-code`).send({}).expect(409);
      await agent
        .patch(`/station-devices/${deviceId}`)
        .send({ name: "Cannot resurrect" })
        .expect(409);
      await agent.delete(`/station-devices/${deviceId}`).expect(409);
      expect((await agent.get("/device-licensing").expect(200)).body).toMatchObject({
        usage: 0,
        devices: [{ state: "released", releaseReason: "reservation_cancelled" }],
      });
    },
  );

  it.each(["cancel", "pair"] as const)(
    "serializes cancellation versus claim with %s first",
    async (first) => {
      const code = await issueRecoveryCode();
      const blocker = await app!.get<AuthSetup["pool"]>(DB_POOL).connect();
      let pairAttempt: Promise<request.Response> | undefined;
      let cancelAttempt: Promise<request.Response> | undefined;
      const cancel = () =>
        agent
          .post(`/device-licensing/${deviceId}/cancel-reservation`)
          .send({ requestId: randomUUID(), expectedRevision: 1 })
          .then((r) => r);
      const pair = () =>
        request(app!.getHttpServer())
          .post("/station/pair")
          .send({ code })
          .then((r) => r);
      try {
        await blocker.query("BEGIN");
        await blocker.query("select pg_advisory_xact_lock(hashtext($1), 2)", [
          `subscription-quota:${tenantId}`,
        ]);
        if (first === "cancel") cancelAttempt = cancel();
        else pairAttempt = pair();
        await waitForQuotaWaiter(2);
        if (first === "cancel") pairAttempt = pair();
        else cancelAttempt = cancel();
        await waitForQuotaWaiter(2, 2);
      } finally {
        await blocker.query("COMMIT");
        blocker.release();
      }
      const [cancelled, paired] = await Promise.all([cancelAttempt!, pairAttempt!]);
      expect(cancelled.status).toBe(first === "cancel" ? 200 : 409);
      expect(paired.status).toBe(first === "cancel" ? 401 : 201);
      const projection = (await agent.get("/device-licensing").expect(200)).body;
      expect(projection).toMatchObject({
        integrity: "ready",
        usage: first === "cancel" ? 0 : 1,
        devices: [{ state: first === "cancel" ? "released" : "assigned" }],
      });
      const state = await recoveryState();
      expect(state.keys).toHaveLength(first === "cancel" ? 0 : 1);
    },
  );

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
    expect(Object.keys(paired.body).sort()).toEqual(["credential", "device", "operators"]);
    expect(preTask8PairDecoderAccepts(paired.body)).toBe(true);
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

  it("adds subscription state only when a pairing client negotiates subscription-state-v1", async () => {
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const paired = await request(app!.getHttpServer())
      .post("/station/pair")
      .set("x-station-capabilities", "subscription-state-v1")
      .send({ code: issued.body.code })
      .expect(201);

    expect(Object.keys(paired.body).sort()).toEqual([
      "credential",
      "device",
      "operators",
      "subscription",
    ]);
    expect(paired.body.subscription).toEqual({
      access: "unmanaged",
      status: "unmanaged",
      startsAt: null,
      endsAt: null,
    });
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
        kind: "station",
        tenantId,
        organizationName: "Test Plant",
        line: { id: expect.any(String), name: "Packing" },
      },
    });
    expect(preTask8IdentityDecoderAccepts(identity.body)).toBe(true);

    const negotiated = await request(app!.getHttpServer())
      .get("/station/identity")
      .set("x-api-key", apiKey)
      .set("x-station-capabilities", "subscription-state-v1")
      .expect(200);
    expect(negotiated.body).toEqual({
      device: identity.body.device,
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

  it("revokes a paired handheld through the station endpoint and retires its credential", async () => {
    const created = await agent
      .post("/station-devices")
      .send({ name: "Handheld revocation", kind: "handheld", lineId: null })
      .expect(201);
    const handheldId = created.body.id as string;
    const issued = await agent
      .post(`/station-devices/${handheldId}/pairing-code`)
      .send({})
      .expect(201);
    await recoveryPair(
      issued.body.code as string,
      { tenantId, deviceId: handheldId, kind: "handheld" },
      "handheld-v1",
    ).expect(201);
    const [before] = await db
      .select()
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, handheldId));
    if (!before?.apiKeyId) throw new Error("Paired handheld credential missing");

    await agent.delete(`/station-devices/${handheldId}`).expect(204);

    const [after] = await db
      .select()
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, handheldId));
    expect(after).toMatchObject({
      id: handheldId,
      tenantId,
      kind: "handheld",
      apiKeyId: null,
      revokedAt: expect.any(Date),
      pairedAt: before.pairedAt,
    });
    expect(
      await db
        .select({ id: schema.apikey.id })
        .from(schema.apikey)
        .where(eq(schema.apikey.id, before.apiKeyId)),
    ).toEqual([]);
    const [assignment] = await db
      .select()
      .from(schema.workingDeviceAssignments)
      .where(eq(schema.workingDeviceAssignments.deviceId, handheldId));
    expect(assignment).toMatchObject({ state: "released", releaseReason: "security_revoked" });
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

  it.each([false, true])(
    "rejects revoked station restoration when another live station filled its slot (recovery=%s)",
    async (recovery) => {
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

      const rejected = await (
        recovery
          ? recoveryPair(issued.body.code as string)
          : request(app!.getHttpServer()).post("/station/pair").send({ code: issued.body.code })
      ).expect(409);
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
          .where(
            and(eq(schema.apikey.referenceId, tenantId), eq(schema.apikey.configId, "station")),
          ),
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
    },
  );

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

  it("rotates an active station key without extending a trial so only the replacement can reach station routes", async () => {
    await manageCurrentTenant(1);
    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "trial" })
      .where(eq(schema.tenantSubscriptions.tenantId, tenantId));
    const trialBefore = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, tenantId));
    const eventsBefore = await db
      .select()
      .from(schema.subscriptionEvents)
      .where(eq(schema.subscriptionEvents.tenantId, tenantId));
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
    expect(
      await db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, tenantId)),
    ).toEqual(trialBefore);
    expect(
      await db
        .select()
        .from(schema.subscriptionEvents)
        .where(eq(schema.subscriptionEvents.tenantId, tenantId)),
    ).toEqual(eventsBefore);
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

  it.each([false, true])(
    "keeps the active key when a regenerated code loses after candidate provisioning (recovery=%s)",
    async (recovery) => {
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
        const lost = await (
          recovery
            ? recoveryPair(issued.body.code as string)
            : request(app!.getHttpServer()).post("/station/pair").send({ code: issued.body.code })
        ).expect(401);
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
    },
  );

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

  it("keeps a handheld code live when a station client redeems it, then pairs the handheld client", async () => {
    const [line] = await db.insert(schema.lines).values({ tenantId, name: "Line 2" }).returning();
    const handheld = await agent
      .post("/station-devices")
      .send({ name: "TSD kind", lineId: line!.id, kind: "handheld" })
      .expect(201);
    const issued = await agent
      .post(`/station-devices/${handheld.body.id}/pairing-code`)
      .send({})
      .expect(201);
    const code = issued.body.code as string;

    const rejected = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code })
      .expect(401);
    expect(rejected.body).toEqual({ code: "PAIR_KIND_MISMATCH" });

    const paired = await request(app!.getHttpServer())
      .post("/station/pair")
      .set("x-station-capabilities", "handheld-v1,subscription-state-v1")
      .send({ code })
      .expect(201);
    expect(paired.body.device).toMatchObject({ id: handheld.body.id, kind: "handheld" });
    expect(paired.body.credential.apiKey).toEqual(expect.any(String));

    const identity = await request(app!.getHttpServer())
      .get("/station/identity")
      .set("x-api-key", paired.body.credential.apiKey as string)
      .expect(200);
    expect(identity.body.device.kind).toBe("handheld");
  });

  it("rejects a station code redeemed by the handheld client and keeps it live", async () => {
    const issued = await agent
      .post(`/station-devices/${deviceId}/pairing-code`)
      .send({})
      .expect(201);
    const code = issued.body.code as string;

    const rejected = await request(app!.getHttpServer())
      .post("/station/pair")
      .set("x-station-capabilities", "handheld-v1")
      .send({ code })
      .expect(401);
    expect(rejected.body).toEqual({ code: "PAIR_KIND_MISMATCH" });

    const paired = await request(app!.getHttpServer())
      .post("/station/pair")
      .send({ code })
      .expect(201);
    expect(paired.body.device.kind).toBe("station");
  });
});
