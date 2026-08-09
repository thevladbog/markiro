import express from "express";
import { and, eq } from "drizzle-orm";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("transactional subscription quotas", () => {
  let app: INestApplication | undefined;
  let db: Db;

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
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  async function managedTenant(limits: {
    lines: number | null;
    stations: number | null;
    kiosks: number | null;
    cabinetUsers: number | null;
  }) {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const planVersionId = await createPublishedPlan(db, {
      maxLines: limits.lines,
      maxStations: limits.stations,
      maxKiosks: limits.kiosks,
      maxCabinetUsers: limits.cabinetUsers,
    });
    await createManagedSubscription(db, { tenantId, planVersionId });
    return { agent, tenantId };
  }

  function expectOneFinalSlot(results: request.Response[], key: string, limit: number): void {
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const rejected = results.find((result) => result.status === 409);
    expect(rejected?.body).toEqual({
      code: "subscription_limit_reached",
      entitlement: key,
      used: limit,
      limit,
    });
  }

  it("serializes two simultaneous final line slots and reports the exact boundary", async () => {
    const { agent, tenantId } = await managedTenant({
      lines: 1,
      stations: null,
      kiosks: null,
      cabinetUsers: null,
    });
    const results = await Promise.all([
      agent.post("/lines").send({ name: "Line A" }),
      agent.post("/lines").send({ name: "Line B" }),
    ]);
    expectOneFinalSlot(results, "lines", 1);
    await expect(
      db.select().from(schema.lines).where(eq(schema.lines.tenantId, tenantId)),
    ).resolves.toHaveLength(1);
  });

  it("serializes two simultaneous final station slots", async () => {
    const { agent, tenantId } = await managedTenant({
      lines: null,
      stations: 1,
      kiosks: null,
      cabinetUsers: null,
    });
    const results = await Promise.all([
      agent.post("/station-devices").send({ name: "Station A", lineId: null }),
      agent.post("/station-devices").send({ name: "Station B", lineId: null }),
    ]);
    expectOneFinalSlot(results, "stations", 1);
    await expect(
      db.select().from(schema.stationDevices).where(eq(schema.stationDevices.tenantId, tenantId)),
    ).resolves.toHaveLength(1);
  });

  it("serializes two simultaneous final kiosk slots", async () => {
    const { agent, tenantId } = await managedTenant({
      lines: null,
      stations: null,
      kiosks: 1,
      cabinetUsers: null,
    });
    const results = await Promise.all([
      agent.post("/kiosks").send({ name: "Kiosk A" }),
      agent.post("/kiosks").send({ name: "Kiosk B" }),
    ]);
    expectOneFinalSlot(results, "kiosks", 1);
    await expect(
      db
        .select()
        .from(schema.kiosks)
        .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.status, "active"))),
    ).resolves.toHaveLength(1);
  });

  it("serializes the final invitation seat with its resource, audit, and outbox writes", async () => {
    const { agent, tenantId } = await managedTenant({
      lines: null,
      stations: null,
      kiosks: null,
      cabinetUsers: 2,
    });
    const results = await Promise.all([
      agent
        .post("/team/invitations")
        .send({ email: `seat-a-${crypto.randomUUID()}@example.com`, role: "manager" }),
      agent
        .post("/team/invitations")
        .send({ email: `seat-b-${crypto.randomUUID()}@example.com`, role: "manager" }),
    ]);
    expectOneFinalSlot(results, "cabinetUsers", 2);
    const invitations = await db
      .select({ id: schema.invitation.id })
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.organizationId, tenantId),
          eq(schema.invitation.status, "pending"),
        ),
      );
    expect(invitations).toHaveLength(1);
    const [owner] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "team.invitation.created"),
        ),
      );
    expect(audits).toEqual([
      expect.objectContaining({
        organizationId: tenantId,
        actorUserId: owner!.userId,
        action: "team.invitation.created",
        outcome: "success",
        targetType: "invitation",
        targetId: invitations[0]!.id,
        after: { role: "manager", position: null },
      }),
    ]);
    await expect(
      db
        .select()
        .from(schema.emailDeliveries)
        .where(eq(schema.emailDeliveries.sourceId, invitations[0]!.id)),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(schema.emailOutbox)
        .innerJoin(
          schema.emailDeliveries,
          eq(schema.emailDeliveries.id, schema.emailOutbox.deliveryId),
        )
        .where(eq(schema.emailDeliveries.sourceId, invitations[0]!.id)),
    ).resolves.toHaveLength(1);
  });

  it("allows unlimited quotas, blocks over-limit downgrade usage, and rolls back a failed create", async () => {
    const unlimited = await managedTenant({
      lines: null,
      stations: null,
      kiosks: null,
      cabinetUsers: null,
    });
    await unlimited.agent.post("/lines").send({ name: "Unlimited A" }).expect(201);
    await unlimited.agent.post("/lines").send({ name: "Unlimited B" }).expect(201);

    const overLimit = await managedTenant({
      lines: 1,
      stations: null,
      kiosks: null,
      cabinetUsers: null,
    });
    await db.insert(schema.lines).values([
      { tenantId: overLimit.tenantId, name: "Existing A" },
      { tenantId: overLimit.tenantId, name: "Existing B" },
    ]);
    const rejected = await overLimit.agent
      .post("/lines")
      .send({ name: "Blocked after downgrade" })
      .expect(409);
    expect(rejected.body).toEqual({
      code: "subscription_limit_reached",
      entitlement: "lines",
      used: 2,
      limit: 1,
    });
    await expect(
      db.select().from(schema.lines).where(eq(schema.lines.tenantId, overLimit.tenantId)),
    ).resolves.toHaveLength(2);

    const rollback = await managedTenant({
      lines: 1,
      stations: null,
      kiosks: null,
      cabinetUsers: null,
    });
    const entitlements = app!.get(EntitlementsService);
    await expect(
      db.transaction((tx) =>
        entitlements.withQuotaSlot(tx, rollback.tenantId, "lines", async () => {
          await tx.insert(schema.lines).values({ tenantId: rollback.tenantId, name: "Rollback" });
          throw new Error("force rollback");
        }),
      ),
    ).rejects.toThrow("force rollback");
    await expect(
      db.select().from(schema.lines).where(eq(schema.lines.tenantId, rollback.tenantId)),
    ).resolves.toHaveLength(0);
    await rollback.agent.post("/lines").send({ name: "Slot remains" }).expect(201);
  });

  it("releases invitation capacity for cancellation, rejection, and timestamp expiry", async () => {
    const { agent, tenantId } = await managedTenant({
      lines: null,
      stations: null,
      kiosks: null,
      cabinetUsers: 2,
    });
    const first = await agent
      .post("/team/invitations")
      .send({ email: `cancel-${crypto.randomUUID()}@example.com`, role: "manager" })
      .expect(201);
    await agent.delete(`/team/invitations/${first.body.id as string}`).expect(204);
    const second = await agent
      .post("/team/invitations")
      .send({ email: `expired-${crypto.randomUUID()}@example.com`, role: "manager" })
      .expect(201);
    await db
      .update(schema.invitation)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(
        and(
          eq(schema.invitation.organizationId, tenantId),
          eq(schema.invitation.id, second.body.id as string),
        ),
      );
    await agent
      .post("/team/invitations")
      .send({ email: `replacement-${crypto.randomUUID()}@example.com`, role: "manager" })
      .expect(201);
    await db
      .update(schema.invitation)
      .set({ status: "rejected" })
      .where(eq(schema.invitation.organizationId, tenantId));
    await agent
      .post("/team/invitations")
      .send({ email: `after-reject-${crypto.randomUUID()}@example.com`, role: "manager" })
      .expect(201);
  });
});
