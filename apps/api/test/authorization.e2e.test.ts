import { randomUUID } from "node:crypto";
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
import { listenOnLoopback } from "./support/listen-loopback";
import {
  setOnlyOrganizationMemberRole,
  signUpAndActivate,
  signUpWithInactiveOrg,
} from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const VALID_KIOSK = {
  name: "Manager kiosk",
  location: null,
  dayLimitPerEmployee: 5,
  showPrices: true,
};

const OWNER_CAPABILITIES = [
  "operations.read",
  "operations.write",
  "integrations.read",
  "integrations.write",
  "tenant.settings.manage",
  "credentials.manage",
  "members.manage",
];

const ADMIN_CAPABILITIES = [
  "operations.read",
  "operations.write",
  "integrations.read",
  "integrations.write",
  "tenant.settings.manage",
  "credentials.manage",
];

describe.skipIf(!ready)("cabinet authorization e2e", () => {
  let app: INestApplication | undefined;
  let db: Db;

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
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

  async function activeOrganizationFixture() {
    const agent = request.agent(app!.getHttpServer());
    const organizationId = await signUpAndActivate(agent);
    return { agent, organizationId };
  }

  async function soleMember(organizationId: string) {
    const rows = await db
      .select({ id: schema.member.id, userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, organizationId));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it("rejects GET /access/me without a session", async () => {
    await request(app!.getHttpServer()).get("/access/me").expect(401);
  });

  it("rejects a session that has no active organization", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpWithInactiveOrg(agent);

    await agent.get("/access/me").expect(403);
  });

  it("gives an owner every cabinet capability", async () => {
    const { agent } = await activeOrganizationFixture();

    expect((await agent.get("/access/me").expect(200)).body).toEqual({
      roles: ["owner"],
      capabilities: OWNER_CAPABILITIES,
    });
  });

  it("allows a manager to operate but denies tenant internals", async () => {
    const { agent, organizationId } = await activeOrganizationFixture();
    await setOnlyOrganizationMemberRole(db, organizationId, "manager");

    await agent.get("/products").expect(200);
    await agent.post("/kiosks").send(VALID_KIOSK).expect(201);
    await agent.get("/integrations").expect(403);
    await agent.get("/org/profile").expect(403);
    await agent.get("/station-devices").expect(403);
    await agent.get("/integrations/public_api/keys").expect(403);
  });

  it("lets an admin inherit operations and administer tenant internals", async () => {
    const { agent, organizationId } = await activeOrganizationFixture();
    await setOnlyOrganizationMemberRole(db, organizationId, "admin");

    await agent.get("/products").expect(200);
    await agent.get("/integrations").expect(200);
    await agent.get("/org/profile").expect(200);
    await agent.get("/station-devices").expect(200);
  });

  it("lets a member read its empty access document but not operate", async () => {
    const { agent, organizationId } = await activeOrganizationFixture();
    await setOnlyOrganizationMemberRole(db, organizationId, "member");

    expect((await agent.get("/access/me").expect(200)).body).toEqual({
      roles: ["member"],
      capabilities: [],
    });
    await agent.get("/boxes").expect(403);
  });

  it("treats an unknown membership role as no cabinet access", async () => {
    const { agent, organizationId } = await activeOrganizationFixture();
    await setOnlyOrganizationMemberRole(db, organizationId, "not-a-cabinet-role");

    expect((await agent.get("/access/me").expect(200)).body).toEqual({
      roles: [],
      capabilities: [],
    });
    await agent.get("/products").expect(403);
  });

  it("unions multiple roles without dropping admin capabilities", async () => {
    const { agent, organizationId } = await activeOrganizationFixture();
    await setOnlyOrganizationMemberRole(db, organizationId, "admin,member");

    expect((await agent.get("/access/me").expect(200)).body).toEqual({
      roles: ["admin", "member"],
      capabilities: ADMIN_CAPABILITIES,
    });
  });

  it("denies the next request after its active-organization membership is deleted", async () => {
    const { agent, organizationId } = await activeOrganizationFixture();
    const member = await soleMember(organizationId);
    await db.delete(schema.member).where(eq(schema.member.id, member.id));

    await agent.get("/access/me").expect(403);
  });

  it("uses the changed membership role on the next request without re-login", async () => {
    const { agent, organizationId } = await activeOrganizationFixture();
    await setOnlyOrganizationMemberRole(db, organizationId, "manager");
    await agent.get("/integrations").expect(403);

    await setOnlyOrganizationMemberRole(db, organizationId, "admin");
    await agent.get("/integrations").expect(200);
  });

  it("does not authorize an active tenant from a membership in another tenant", async () => {
    const { agent, organizationId } = await activeOrganizationFixture();
    const member = await soleMember(organizationId);
    const foreignOrganizationId = randomUUID();

    await db.delete(schema.member).where(eq(schema.member.id, member.id));
    await db.insert(schema.organization).values({
      id: foreignOrganizationId,
      name: "Foreign fixture organization",
      slug: `foreign-${randomUUID()}`,
      createdAt: new Date(),
    });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: foreignOrganizationId,
      userId: member.userId,
      role: "owner",
      createdAt: new Date(),
    });

    await agent.get("/access/me").expect(403);
  });

  it("keeps Better Auth organization mutations owner-only", async () => {
    const { agent, organizationId } = await activeOrganizationFixture();
    const member = await soleMember(organizationId);

    await agent
      .post("/api/auth/organization/update")
      .send({ organizationId, data: { name: "Owner updated" } })
      .expect(200);

    await setOnlyOrganizationMemberRole(db, organizationId, "admin");

    await agent
      .post("/api/auth/organization/update")
      .send({ organizationId, data: { name: "Admin bypass" } })
      .expect(403);
    await agent
      .post("/api/auth/organization/update-member-role")
      .send({ organizationId, memberId: member.id, role: "manager" })
      .expect(403);
    await agent
      .post("/api/auth/organization/invite-member")
      .send({ organizationId, email: `invite-${randomUUID()}@example.com`, role: "manager" })
      .expect(403);

    const rows = await db
      .select({ name: schema.organization.name, role: schema.member.role })
      .from(schema.organization)
      .innerJoin(schema.member, and(eq(schema.member.organizationId, schema.organization.id)))
      .where(eq(schema.organization.id, organizationId));
    expect(rows).toEqual([{ name: "Owner updated", role: "admin" }]);
  });
});
