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
import type { MailPgClient } from "../src/modules/mail/mail-jobs.service";
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
  let setup: AuthSetup;

  beforeAll(async () => {
    const env = loadEnv({
      ...process.env,
      ...PLATFORM_TEST_ENV,
      SUBSCRIPTION_ENFORCEMENT_MODE: "managed_only",
    });
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

  async function holdQuotaLock(tenantId: string, keyOrder: number): Promise<MailPgClient> {
    const client = await setup.pool.connect();
    await client.query("SELECT pg_advisory_lock(hashtext($1), $2)", [
      `subscription-quota:${tenantId}`,
      keyOrder,
    ]);
    return client;
  }

  async function releaseQuotaLock(
    client: MailPgClient,
    tenantId: string,
    keyOrder: number,
  ): Promise<void> {
    await client.query("SELECT pg_advisory_unlock(hashtext($1), $2)", [
      `subscription-quota:${tenantId}`,
      keyOrder,
    ]);
  }

  async function waitForQuotaWaiters(
    tenantId: string,
    keyOrder: number,
    minimum: number,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await setup.pool.query<{ count: number }>(
        `select count(*)::int as count
         from pg_locks
         where locktype = 'advisory'
           and database = (select oid from pg_database where datname = current_database())
           and classid = hashtext($1)::oid
           and objid = $2::oid
           and not granted`,
        [`subscription-quota:${tenantId}`, keyOrder],
      );
      if ((result.rows[0]?.count ?? 0) >= minimum) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${minimum} quota lock waiter(s)`);
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

  it("serializes line release before a final-slot create without oversubscription", async () => {
    const { agent, tenantId } = await managedTenant({
      lines: 1,
      stations: null,
      kiosks: null,
      cabinetUsers: null,
    });
    const existing = await agent.post("/lines").send({ name: "Released line" }).expect(201);
    const blocker = await holdQuotaLock(tenantId, 1);
    let blockerHeld = true;
    let deletePhase: "waiting" | "settled" | undefined;
    let deleted: request.Response | undefined;
    let created: request.Response | undefined;
    try {
      const deleteAttempt = agent.delete(`/lines/${existing.body.id as string}`).then((row) => row);
      deletePhase = await Promise.race([
        waitForQuotaWaiters(tenantId, 1, 1).then(() => "waiting" as const),
        deleteAttempt.then(() => "settled" as const),
      ]);
      const createAttempt = agent
        .post("/lines")
        .send({ name: "Replacement line" })
        .then((row) => row);
      await waitForQuotaWaiters(tenantId, 1, deletePhase === "waiting" ? 2 : 1);
      await releaseQuotaLock(blocker, tenantId, 1);
      blockerHeld = false;
      [deleted, created] = await Promise.all([deleteAttempt, createAttempt]);
    } finally {
      if (blockerHeld) await releaseQuotaLock(blocker, tenantId, 1);
      blocker.release();
    }

    expect(deletePhase).toBe("waiting");
    expect(deleted?.status).toBe(204);
    expect(created?.status).toBe(201);
    const lines = await db
      .select({ id: schema.lines.id, name: schema.lines.name })
      .from(schema.lines)
      .where(eq(schema.lines.tenantId, tenantId));
    expect(lines).toEqual([{ id: created!.body.id as string, name: "Replacement line" }]);
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

  it("serializes member release before a final invitation seat with exact audit", async () => {
    const { agent, tenantId } = await managedTenant({
      lines: null,
      stations: null,
      kiosks: null,
      cabinetUsers: 2,
    });
    const foreignAgent = request.agent(app!.getHttpServer());
    const foreignTenantId = await signUpAndActivate(foreignAgent);
    const [foreignMember] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, foreignTenantId));
    const [owner] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    const targetMemberId = crypto.randomUUID();
    await db.insert(schema.member).values({
      id: targetMemberId,
      organizationId: tenantId,
      userId: foreignMember!.userId,
      role: "manager",
      createdAt: new Date(),
    });

    const blocker = await holdQuotaLock(tenantId, 4);
    let blockerHeld = true;
    let deletePhase: "waiting" | "settled" | undefined;
    let deleted: request.Response | undefined;
    let invited: request.Response | undefined;
    try {
      const deleteAttempt = agent.delete(`/team/members/${targetMemberId}`).then((row) => row);
      deletePhase = await Promise.race([
        waitForQuotaWaiters(tenantId, 4, 1).then(() => "waiting" as const),
        deleteAttempt.then(() => "settled" as const),
      ]);
      const inviteAttempt = agent
        .post("/team/invitations")
        .send({ email: `replacement-seat-${crypto.randomUUID()}@example.com`, role: "manager" })
        .then((row) => row);
      await waitForQuotaWaiters(tenantId, 4, deletePhase === "waiting" ? 2 : 1);
      await releaseQuotaLock(blocker, tenantId, 4);
      blockerHeld = false;
      [deleted, invited] = await Promise.all([deleteAttempt, inviteAttempt]);
    } finally {
      if (blockerHeld) await releaseQuotaLock(blocker, tenantId, 4);
      blocker.release();
    }

    expect(deletePhase).toBe("waiting");
    expect(deleted?.status).toBe(204);
    expect(invited?.status).toBe(201);
    await expect(
      db.select().from(schema.member).where(eq(schema.member.id, targetMemberId)),
    ).resolves.toEqual([]);
    const usage = await app!.get(EntitlementsService).usage(tenantId);
    expect(usage.cabinetUsers).toBe(2);
    await expect(
      db
        .select({
          organizationId: schema.tenantAuditEvents.organizationId,
          actorUserId: schema.tenantAuditEvents.actorUserId,
          action: schema.tenantAuditEvents.action,
          outcome: schema.tenantAuditEvents.outcome,
          targetType: schema.tenantAuditEvents.targetType,
          targetId: schema.tenantAuditEvents.targetId,
          before: schema.tenantAuditEvents.before,
          after: schema.tenantAuditEvents.after,
        })
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, tenantId),
            eq(schema.tenantAuditEvents.action, "team.member.removed"),
            eq(schema.tenantAuditEvents.targetId, targetMemberId),
          ),
        ),
    ).resolves.toEqual([
      {
        organizationId: tenantId,
        actorUserId: owner!.userId,
        action: "team.member.removed",
        outcome: "success",
        targetType: "member",
        targetId: targetMemberId,
        before: { role: "manager" },
        after: null,
      },
    ]);
  });

  it("serializes recipient rejection before a replacement invitation without oversubscription", async () => {
    const { agent, tenantId } = await managedTenant({
      lines: null,
      stations: null,
      kiosks: null,
      cabinetUsers: 2,
    });
    const invitee = request.agent(app!.getHttpServer());
    const inviteeTenantId = await signUpAndActivate(invitee);
    const [inviteeMember] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, inviteeTenantId));
    const [inviteeUser] = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, inviteeMember!.userId));
    const existing = await agent
      .post("/team/invitations")
      .send({ email: inviteeUser!.email, role: "manager" })
      .expect(201);

    const blocker = await holdQuotaLock(tenantId, 4);
    let blockerHeld = true;
    let rejectPhase: "waiting" | "settled" | undefined;
    let rejected: request.Response | undefined;
    let invited: request.Response | undefined;
    try {
      const rejectAttempt = invitee
        .post(`/invitations/${existing.body.id as string}/reject`)
        .then((row) => row);
      rejectPhase = await Promise.race([
        waitForQuotaWaiters(tenantId, 4, 1).then(() => "waiting" as const),
        rejectAttempt.then(() => "settled" as const),
      ]);
      const inviteAttempt = agent
        .post("/team/invitations")
        .send({
          email: `concurrent-replacement-${crypto.randomUUID()}@example.com`,
          role: "manager",
        })
        .then((row) => row);
      await waitForQuotaWaiters(tenantId, 4, rejectPhase === "waiting" ? 2 : 1);
      await releaseQuotaLock(blocker, tenantId, 4);
      blockerHeld = false;
      [rejected, invited] = await Promise.all([rejectAttempt, inviteAttempt]);
    } finally {
      if (blockerHeld) await releaseQuotaLock(blocker, tenantId, 4);
      blocker.release();
    }

    expect(rejectPhase).toBe("waiting");
    expect(rejected?.status).toBe(200);
    expect(invited?.status).toBe(201);
    const invitations = await db
      .select({ id: schema.invitation.id, status: schema.invitation.status })
      .from(schema.invitation)
      .where(eq(schema.invitation.organizationId, tenantId));
    expect(invitations).toEqual(
      expect.arrayContaining([
        { id: existing.body.id as string, status: "rejected" },
        { id: invited!.body.id as string, status: "pending" },
      ]),
    );
    expect((await app!.get(EntitlementsService).usage(tenantId)).cabinetUsers).toBe(2);
    await expect(
      db
        .select({
          actorUserId: schema.tenantAuditEvents.actorUserId,
          action: schema.tenantAuditEvents.action,
          outcome: schema.tenantAuditEvents.outcome,
          targetType: schema.tenantAuditEvents.targetType,
          targetId: schema.tenantAuditEvents.targetId,
          before: schema.tenantAuditEvents.before,
          after: schema.tenantAuditEvents.after,
        })
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, tenantId),
            eq(schema.tenantAuditEvents.action, "team.invitation.rejected"),
            eq(schema.tenantAuditEvents.targetId, existing.body.id as string),
          ),
        ),
    ).resolves.toEqual([
      {
        actorUserId: inviteeMember!.userId,
        action: "team.invitation.rejected",
        outcome: "success",
        targetType: "invitation",
        targetId: existing.body.id as string,
        before: { status: "pending", role: "manager" },
        after: { status: "rejected", role: "manager" },
      },
    ]);
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
    const replacement = await agent
      .post("/team/invitations")
      .send({ email: `replacement-${crypto.randomUUID()}@example.com`, role: "manager" })
      .expect(201);
    await agent.delete(`/team/invitations/${replacement.body.id as string}`).expect(204);
    const rejectingInvitee = request.agent(app!.getHttpServer());
    const rejectingTenantId = await signUpAndActivate(rejectingInvitee);
    const [rejectingMember] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, rejectingTenantId));
    const [rejectingUser] = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, rejectingMember!.userId));
    const rejectable = await agent
      .post("/team/invitations")
      .send({ email: rejectingUser!.email, role: "manager" })
      .expect(201);
    await rejectingInvitee.post(`/invitations/${rejectable.body.id as string}/reject`).expect(200);
    await agent
      .post("/team/invitations")
      .send({ email: `after-reject-${crypto.randomUUID()}@example.com`, role: "manager" })
      .expect(201);
  });
});
