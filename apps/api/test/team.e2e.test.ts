import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { setOnlyOrganizationMemberRole, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("tenant team e2e", () => {
  let app: INestApplication | undefined;
  let db: Db;

  beforeAll(async () => {
    const env = loadEnv();
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
  });

  afterAll(async () => {
    await app?.close();
  });

  async function fixture() {
    const agent = request.agent(app!.getHttpServer());
    const organizationId = await signUpAndActivate(agent);
    return { agent, organizationId };
  }

  it("creates a tenant-scoped invitation and its durable email atomically", async () => {
    const { agent, organizationId } = await fixture();
    const email = `manager-${crypto.randomUUID()}@example.com`;

    const response = await agent
      .post("/team/invitations")
      .send({ email, role: "manager", position: "Начальник смены" })
      .expect(201);

    const [invitation] = await db
      .select()
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.id, response.body.id as string),
          eq(schema.invitation.organizationId, organizationId),
        ),
      );
    expect(invitation).toMatchObject({ email, role: "manager", status: "pending" });

    const [profile] = await db
      .select()
      .from(schema.tenantInvitationProfiles)
      .where(eq(schema.tenantInvitationProfiles.invitationId, invitation!.id));
    expect(profile).toMatchObject({
      organizationId,
      position: "Начальник смены",
    });

    const [delivery] = await db
      .select()
      .from(schema.emailDeliveries)
      .where(
        and(
          eq(schema.emailDeliveries.tenantId, organizationId),
          eq(schema.emailDeliveries.sourceId, invitation!.id),
        ),
      );
    expect(delivery).toMatchObject({ recipient: email, status: "queued" });
    expect(delivery!.encryptedPayload).not.toBeNull();

    const [outbox] = await db
      .select()
      .from(schema.emailOutbox)
      .where(eq(schema.emailOutbox.deliveryId, delivery!.id));
    expect(outbox).toBeDefined();

    const team = await agent.get("/team").expect(200);
    expect(team.body.invitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: invitation!.id,
          email,
          role: "manager",
          position: "Начальник смены",
          accessStatus: "pending",
          delivery: expect.objectContaining({ status: "queued" }),
        }),
      ]),
    );
  });

  it("allows admins but rejects managers and product-internal roles", async () => {
    const admin = await fixture();
    await setOnlyOrganizationMemberRole(db, admin.organizationId, "admin");
    await admin.agent
      .post("/team/invitations")
      .send({ email: `admin-invite-${crypto.randomUUID()}@example.com`, role: "manager" })
      .expect(201);

    await admin.agent
      .post("/team/invitations")
      .send({ email: `owner-invite-${crypto.randomUUID()}@example.com`, role: "owner" })
      .expect(400);

    const manager = await fixture();
    await setOnlyOrganizationMemberRole(db, manager.organizationId, "manager");
    await manager.agent.get("/team").expect(403);
    await manager.agent
      .post("/team/invitations")
      .send({ email: `denied-${crypto.randomUUID()}@example.com`, role: "manager" })
      .expect(403);
  });

  it("updates and removes another member without deleting factory operator data", async () => {
    const owner = await fixture();
    const foreign = await fixture();
    const [foreignMember] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, foreign.organizationId));
    const targetMemberId = crypto.randomUUID();
    await db.insert(schema.member).values({
      id: targetMemberId,
      organizationId: owner.organizationId,
      userId: foreignMember!.userId,
      role: "manager",
      createdAt: new Date(),
    });
    const [employee] = await db
      .insert(schema.employees)
      .values({ tenantId: owner.organizationId, fullName: "Иван Петров", role: "Оператор" })
      .returning({ id: schema.employees.id });
    const badgeId = crypto.randomUUID();
    await db.insert(schema.employeeBadges).values({
      id: badgeId,
      tenantId: owner.organizationId,
      employeeId: employee!.id,
      badgeCode: `badge-${crypto.randomUUID()}`,
    });
    await db.insert(schema.operatorCredentials).values({
      tenantId: owner.organizationId,
      employeeId: employee!.id,
      login: `operator-${crypto.randomUUID()}`,
      pinHash: "test-pin-hash",
    });

    const updated = await owner.agent
      .patch(`/team/members/${targetMemberId}`)
      .send({ role: "admin", position: "Руководитель производства" })
      .expect(200);
    expect(updated.body).toMatchObject({
      id: targetMemberId,
      role: "admin",
      position: "Руководитель производства",
    });

    const linked = await owner.agent
      .put(`/team/members/${targetMemberId}/employee`)
      .send({ employeeId: employee!.id })
      .expect(200);
    expect(linked.body.employee).toMatchObject({
      id: employee!.id,
      operatorAccess: true,
    });

    await owner.agent.delete(`/team/members/${targetMemberId}`).expect(204);
    expect(
      await db.select().from(schema.member).where(eq(schema.member.id, targetMemberId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.cabinetEmployeeLinks)
        .where(eq(schema.cabinetEmployeeLinks.memberId, targetMemberId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.employees).where(eq(schema.employees.id, employee!.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(schema.employeeBadges).where(eq(schema.employeeBadges.id, badgeId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.operatorCredentials)
        .where(
          and(
            eq(schema.operatorCredentials.tenantId, owner.organizationId),
            eq(schema.operatorCredentials.employeeId, employee!.id),
          ),
        ),
    ).toHaveLength(1);
  });

  it("protects the owner, the actor, and tenant boundaries", async () => {
    const owner = await fixture();
    const [ownerMember] = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.organizationId, owner.organizationId));
    const foreign = await fixture();
    const [foreignMember] = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.organizationId, foreign.organizationId));

    await owner.agent.patch(`/team/members/${ownerMember!.id}`).send({ role: "admin" }).expect(403);
    await owner.agent
      .patch(`/team/members/${foreignMember!.id}`)
      .send({ role: "admin" })
      .expect(404);
  });

  it("resends and cancels invitations while erasing encrypted payloads", async () => {
    const { agent, organizationId } = await fixture();
    const email = `lifecycle-${crypto.randomUUID()}@example.com`;
    const created = await agent
      .post("/team/invitations")
      .send({ email, role: "manager" })
      .expect(201);
    const beforeExpiry = new Date(created.body.expiresAt as string);

    const resent = await agent.post(`/team/invitations/${created.body.id}/resend`).expect(201);
    expect(new Date(resent.body.expiresAt as string).getTime()).toBeGreaterThanOrEqual(
      beforeExpiry.getTime(),
    );

    await agent.delete(`/team/invitations/${created.body.id}`).expect(204);
    const [invitation] = await db
      .select({ status: schema.invitation.status })
      .from(schema.invitation)
      .where(eq(schema.invitation.id, created.body.id as string));
    expect(invitation!.status).toBe("canceled");
    const deliveries = await db
      .select({
        status: schema.emailDeliveries.status,
        encryptedPayload: schema.emailDeliveries.encryptedPayload,
      })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.sourceId, created.body.id as string));
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((delivery) => delivery.status === "canceled")).toBe(true);
    expect(deliveries.every((delivery) => delivery.encryptedPayload === null)).toBe(true);
    expect(
      await db
        .select()
        .from(schema.tenantInvitationProfiles)
        .where(eq(schema.tenantInvitationProfiles.invitationId, created.body.id as string)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.cabinetEmployeeLinks)
        .where(eq(schema.cabinetEmployeeLinks.invitationId, created.body.id as string)),
    ).toHaveLength(0);
    void organizationId;
  });
});
