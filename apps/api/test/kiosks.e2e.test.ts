import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { schema, type Db } from "@markiro/db";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

async function waitForKioskLockWait(
  pool: AuthSetup["pool"],
  blockingPid: number,
  kioskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await pool.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%kiosks%'
          AND query ILIKE '%for update%'
          AND $1 = ANY(pg_blocking_pids(pid))
      )
    `,
      [blockingPid],
    );
    if (result.rows[0]?.exists === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for enrollment to block on kiosk ${kioskId}`);
}

describe.skipIf(!ready)("kiosks e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
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

  async function signUpWithInactiveOrg(agent: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
      .expect(200);

    const org = await agent
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);

    return org.body.id as string;
  }

  async function signUpAndActivate(agent: ReturnType<typeof request.agent>): Promise<string> {
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return orgId;
  }

  it("GET /kiosks is unauthorized without a session", async () => {
    await request(app!.getHttpServer()).get("/kiosks").expect(401);
  });

  it("creates a kiosk, sets its allowlist, and enrolls a device token", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const productId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: "04650075195923", name: "Пиво" });

    const kiosk = await agent
      .post("/kiosks")
      .send({ name: "Киоск-1", location: "Проходная", dayLimitPerEmployee: 5 })
      .expect(201);
    expect(kiosk.body.enrolled).toBe(false);
    expect(kiosk.body.productIds).toEqual([]);
    expect(kiosk.body.status).toEqual("active");
    const id = kiosk.body.id as string;

    const withList = await agent
      .put(`/kiosks/${id}/products`)
      .send({ productIds: [productId] })
      .expect(200);
    expect(withList.body.productIds).toEqual([productId]);

    const enroll = await agent
      .post(`/kiosks/${id}/enroll`)
      .send({})
      .expect("Cache-Control", "no-store")
      .expect(200);
    expect(typeof enroll.body.token).toBe("string");
    expect(enroll.body.token.length).toBeGreaterThan(0);

    const after = await agent.get("/kiosks").expect(200);
    const listed = after.body.items.find((k: { id: string }) => k.id === id);
    expect(listed.enrolled).toBe(true);
    // The hash must never leak through the API.
    expect(listed.deviceTokenHash).toBeUndefined();
    expect(listed.token).toBeUndefined();
  });

  it("PUT /kiosks/:id/products rejects a foreign-tenant product id with 400", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    const org1 = await signUpAndActivate(agent1);
    const foreignProductId = randomUUID();
    await db.insert(schema.products).values({
      id: foreignProductId,
      tenantId: org1,
      gtin14: "04650075195924",
      name: "Foreign Product",
    });

    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);
    const kiosk = await agent2.post("/kiosks").send({ name: "Киоск-2" }).expect(201);
    const id = kiosk.body.id as string;

    const res = await agent2
      .put(`/kiosks/${id}/products`)
      .send({ productIds: [foreignProductId] })
      .expect(400);
    expect(res.body.message).toEqual(expect.stringContaining("Unknown product"));
  });

  it("PUT /kiosks/:id/products replaces the previous allowlist wholesale", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const productA = randomUUID();
    const productB = randomUUID();
    await db.insert(schema.products).values([
      { id: productA, tenantId, gtin14: "04650075195925", name: "Product A" },
      { id: productB, tenantId, gtin14: "04650075195926", name: "Product B" },
    ]);

    const kiosk = await agent.post("/kiosks").send({ name: "Киоск-3" }).expect(201);
    const id = kiosk.body.id as string;

    await agent
      .put(`/kiosks/${id}/products`)
      .send({ productIds: [productA] })
      .expect(200);
    const replaced = await agent
      .put(`/kiosks/${id}/products`)
      .send({ productIds: [productB] })
      .expect(200);
    expect(replaced.body.productIds).toEqual([productB]);
  });

  it("PUT /kiosks/:id/products dedupes duplicate product ids instead of 500ing", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const productId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: "04650075195927", name: "Product C" });

    const kiosk = await agent.post("/kiosks").send({ name: "Киоск-4" }).expect(201);
    const id = kiosk.body.id as string;

    const res = await agent
      .put(`/kiosks/${id}/products`)
      .send({ productIds: [productId, productId] })
      .expect(200);
    expect(res.body.productIds).toEqual([productId]);
  });

  it("PUT /kiosks/:id/products 404s for a nonexistent kiosk", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    await agent.put(`/kiosks/${randomUUID()}/products`).send({ productIds: [] }).expect(404);
  });

  it("POST /kiosks/:id/enroll 404s for a nonexistent kiosk", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    await agent.post(`/kiosks/${randomUUID()}/enroll`).send({}).expect(404);
  });

  it("PATCH /kiosks/:id with an empty body returns 200 unchanged (no empty-set 500)", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const created = await agent
      .post("/kiosks")
      .send({ name: "Киоск-4", location: "Склад", dayLimitPerEmployee: 3 })
      .expect(201);
    const id = created.body.id as string;

    const patched = await agent.patch(`/kiosks/${id}`).send({}).expect(200);
    expect(patched.body).toMatchObject({
      id,
      name: "Киоск-4",
      location: "Склад",
      dayLimitPerEmployee: 3,
      status: "active",
    });
  });

  it("PATCH /kiosks/:id returns 404 for a nonexistent id", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    await agent.patch(`/kiosks/${randomUUID()}`).send({}).expect(404);
  });

  it("PATCH /kiosks/:id updates fields and DELETE archives it", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const created = await agent.post("/kiosks").send({ name: "Киоск-5" }).expect(201);
    const id = created.body.id as string;

    const updated = await agent
      .patch(`/kiosks/${id}`)
      .send({ name: "Киоск-5 renamed", showPrices: false })
      .expect(200);
    expect(updated.body).toMatchObject({ name: "Киоск-5 renamed", showPrices: false });

    await agent.delete(`/kiosks/${id}`).expect(204);
    const list = await agent.get("/kiosks").expect(200);
    const archived = list.body.items.find((k: { id: string }) => k.id === id);
    expect(archived.status).toEqual("archived");
  });

  it("POST /kiosks/:id/unbind keeps an active kiosk but removes its credential and live pairing code", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const created = await agent.post("/kiosks").send({ name: "Unbound kiosk" }).expect(201);
    const id = created.body.id as string;
    const enrolled = await agent.post(`/kiosks/${id}/enroll`).send({}).expect(200);
    await agent.post(`/kiosks/${id}/pairing-code`).send({}).expect(201);

    await agent.post(`/kiosks/${id}/unbind`).send({}).expect(204);
    await agent.post(`/kiosks/${id}/unbind`).send({}).expect(204);

    await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", enrolled.body.token)
      .expect(401);
    const [kiosk] = await db
      .select({ status: schema.kiosks.status, deviceTokenHash: schema.kiosks.deviceTokenHash })
      .from(schema.kiosks)
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)));
    expect(kiosk).toEqual({ status: "active", deviceTokenHash: null });
    const liveCodes = await db
      .select({ id: schema.kioskPairingCodes.id })
      .from(schema.kioskPairingCodes)
      .where(
        and(
          eq(schema.kioskPairingCodes.tenantId, tenantId),
          eq(schema.kioskPairingCodes.kioskId, id),
          isNull(schema.kioskPairingCodes.usedAt),
        ),
      );
    expect(liveCodes).toEqual([]);

    const devices = await agent.get("/devices?type=kiosk&status=awaiting_pairing").expect(200);
    expect(devices.body.items).toContainEqual(
      expect.objectContaining({ id, status: "awaiting_pairing", paired: false }),
    );
  });

  it("reactivating a legacy archived kiosk clears rather than revives its retained token", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const created = await agent.post("/kiosks").send({ name: "Legacy archived kiosk" }).expect(201);
    const id = created.body.id as string;
    const oldToken = "legacy-kiosk-token";
    await db
      .update(schema.kiosks)
      .set({ status: "archived", deviceTokenHash: hashDeviceToken(oldToken) })
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)));

    await agent.patch(`/kiosks/${id}`).send({ status: "active" }).expect(200);

    await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", oldToken)
      .expect(401);
    const [kiosk] = await db
      .select({ status: schema.kiosks.status, deviceTokenHash: schema.kiosks.deviceTokenHash })
      .from(schema.kiosks)
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)));
    expect(kiosk).toEqual({ status: "active", deviceTokenHash: null });
  });

  it("serializes enrollment behind an archive lock and revalidates the committed lifecycle state", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const created = await agent.post("/kiosks").send({ name: "Enrollment race kiosk" }).expect(201);
    const id = created.body.id as string;
    let releaseArchive: (() => void) | undefined;
    const archivePaused = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    let archiveLocked: (() => void) | undefined;
    const archiveStarted = new Promise<void>((resolve) => {
      archiveLocked = resolve;
    });
    let archivePid: number | undefined;

    const archive = db.transaction(async (tx) => {
      const pidResult = await tx.execute<{ pid: number }>("select pg_backend_pid() as pid");
      archivePid = pidResult.rows[0]?.pid;
      await tx
        .select({ id: schema.kiosks.id })
        .from(schema.kiosks)
        .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)))
        .for("update");
      await tx
        .update(schema.kiosks)
        .set({ status: "archived", deviceTokenHash: null })
        .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)));
      archiveLocked?.();
      await archivePaused;
    });
    let enroll: Promise<request.Response> | undefined;
    try {
      await archiveStarted;
      enroll = agent
        .post(`/kiosks/${id}/enroll`)
        .send({})
        .then((response) => response);
      if (archivePid === undefined) throw new Error("Archive transaction PID was not captured");
      await waitForKioskLockWait(setup.pool, archivePid, id);
      releaseArchive?.();
      await archive;

      expect((await enroll).status).toBe(404);
    } finally {
      releaseArchive?.();
      await Promise.allSettled([archive, enroll].filter((pending) => pending !== undefined));
    }
  });

  it("cross-tenant isolation: org B cannot PATCH/DELETE org A's kiosk (404)", async () => {
    const agent1 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent1);
    const created = await agent1.post("/kiosks").send({ name: "Org A Kiosk" }).expect(201);
    const id = created.body.id as string;

    const agent2 = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent2);

    await agent2.patch(`/kiosks/${id}`).send({ name: "Hijacked" }).expect(404);
    await agent2.delete(`/kiosks/${id}`).expect(404);
    await agent2.post(`/kiosks/${id}/enroll`).send({}).expect(404);

    const list = await agent2.get("/kiosks").expect(200);
    expect(list.body.items.find((k: { id: string }) => k.id === id)).toBeUndefined();
  });
});
