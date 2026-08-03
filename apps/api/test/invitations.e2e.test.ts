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
import { signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";
import { InvitationsService } from "../src/modules/invitations/invitations.service";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("invitation lifecycle e2e", () => {
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

  async function invite(
    email: string,
    position: string | null = null,
    linkEmployee = false,
  ) {
    const owner = request.agent(app!.getHttpServer());
    const organizationId = await signUpAndActivate(owner);
    const [employee] = linkEmployee
      ? await db
          .insert(schema.employees)
          .values({ tenantId: organizationId, fullName: "Анна Смирнова" })
          .returning({ id: schema.employees.id })
      : [];
    const response = await owner
      .post("/team/invitations")
      .send({ email, role: "manager", position, employeeId: employee?.id })
      .expect(201);
    return { owner, organizationId, invitationId: response.body.id as string, employeeId: employee?.id };
  }

  it("registers only the locked invitation email and finalizes its membership", async () => {
    const email = `new-invite-${crypto.randomUUID()}@example.com`;
    const invited = await invite(email, "Мастер смены", true);
    const publicState = await request(app!.getHttpServer())
      .get(`/invitations/${invited.invitationId}`)
      .expect(200);
    expect(publicState.body).toMatchObject({
      id: invited.invitationId,
      email,
      role: "manager",
      state: "pending",
    });
    expect(publicState.body.organizationName).not.toBe("Test Plant");

    const invitee = request.agent(app!.getHttpServer());
    await invitee
      .post(`/invitations/${invited.invitationId}/register`)
      .send({
        firstName: "Анна",
        lastName: "Смирнова",
        middleName: "Игоревна",
        password: `Pw-${crypto.randomUUID()}!Aa1`,
      })
      .expect(201);
    await invitee.post(`/invitations/${invited.invitationId}/accept`).expect(200);

    const [user] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, email));
    expect(user).toMatchObject({ emailVerified: true });
    const [profile] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, user!.id));
    expect(profile).toMatchObject({
      firstName: "Анна",
      lastName: "Смирнова",
      middleName: "Игоревна",
    });
    const [member] = await db
      .select()
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, invited.organizationId),
          eq(schema.member.userId, user!.id),
        ),
      );
    expect(member).toMatchObject({ role: "manager" });
    const [tenantProfile] = await db
      .select()
      .from(schema.tenantMemberProfiles)
      .where(eq(schema.tenantMemberProfiles.memberId, member!.id));
    expect(tenantProfile).toMatchObject({ position: "Мастер смены" });
    const [employeeLink] = await db
      .select()
      .from(schema.cabinetEmployeeLinks)
      .where(eq(schema.cabinetEmployeeLinks.employeeId, invited.employeeId!));
    expect(employeeLink).toMatchObject({
      organizationId: invited.organizationId,
      memberId: member!.id,
      invitationId: null,
    });

    await app!.get(InvitationsService).finalizeAccepted(invited.invitationId, user!.id, email);
    const [idempotentProfile] = await db
      .select()
      .from(schema.tenantMemberProfiles)
      .where(eq(schema.tenantMemberProfiles.memberId, member!.id));
    expect(idempotentProfile!.position).toBe("Мастер смены");
  });

  it("allows an existing multi-tenant user to accept but rejects another account", async () => {
    const existing = request.agent(app!.getHttpServer());
    const existingOrganizationId = await signUpAndActivate(existing);
    const [existingMember] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, existingOrganizationId));
    const [existingUser] = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, existingMember!.userId));
    const invited = await invite(existingUser!.email);

    const wrong = request.agent(app!.getHttpServer());
    await signUpAndActivate(wrong);
    await wrong.post(`/invitations/${invited.invitationId}/accept`).expect(403);
    await existing.post(`/invitations/${invited.invitationId}/accept`).expect(200);

    const memberships = await db
      .select({ organizationId: schema.member.organizationId })
      .from(schema.member)
      .where(eq(schema.member.userId, existingMember!.userId));
    expect(new Set(memberships.map((row) => row.organizationId))).toEqual(
      new Set([existingOrganizationId, invited.organizationId]),
    );
  });

  it("does not reveal tenant details for invalid or terminal links", async () => {
    await request(app!.getHttpServer())
      .get(`/invitations/${crypto.randomUUID()}`)
      .expect(404, { code: "invitation_unavailable" });

    const expiredEmail = `expired-${crypto.randomUUID()}@example.com`;
    const expired = await invite(expiredEmail);
    await db
      .update(schema.invitation)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.invitation.id, expired.invitationId));
    await request(app!.getHttpServer())
      .get(`/invitations/${expired.invitationId}`)
      .expect(404, { code: "invitation_unavailable" });

    const canceledEmail = `canceled-${crypto.randomUUID()}@example.com`;
    const canceled = await invite(canceledEmail);
    await canceled.owner.delete(`/team/invitations/${canceled.invitationId}`).expect(204);
    await request(app!.getHttpServer())
      .get(`/invitations/${canceled.invitationId}`)
      .expect(404, { code: "invitation_unavailable" });
  });
});
