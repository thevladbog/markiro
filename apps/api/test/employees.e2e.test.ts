import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema } from "@markiro/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("employees e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);

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

  async function ownerUserId(orgId: string): Promise<string> {
    const [owner] = await setup.db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
    if (!owner) throw new Error(`Expected owner for organization ${orgId}`);
    return owner.userId;
  }

  async function employeePolicy(employeeId: string) {
    const [policy] = await setup.db
      .select({
        limitMode: schema.employeePickupPolicies.limitMode,
        dayLimit: schema.employeePickupPolicies.dayLimit,
        canWriteoff: schema.employeePickupPolicies.canWriteoff,
      })
      .from(schema.employeePickupPolicies)
      .where(eq(schema.employeePickupPolicies.employeeId, employeeId));
    return policy;
  }

  it("creates an employee, issues and revokes a badge", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const created = await agent
      .post("/employees")
      .send({ fullName: "Смирнов Алексей", role: "оператор" })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.status).toBe("active");
    expect(created.body.pickupPolicy).toEqual({
      limitMode: "limited",
      dayLimit: 5,
      canWriteoff: false,
    });
    expect(await employeePolicy(id)).toEqual(created.body.pickupPolicy);

    const withBadge = await agent
      .post(`/employees/${id}/badges`)
      .send({ badgeCode: "MARKIRO-BADGE-4412", label: "…4412" })
      .expect(201);
    const badgeId = withBadge.body.badges[0].id as string;
    expect(withBadge.body.badges).toHaveLength(1);

    // Same active code again on another employee → 409.
    const other = await agent.post("/employees").send({ fullName: "Ким Е." }).expect(201);
    await agent
      .post(`/employees/${other.body.id}/badges`)
      .send({ badgeCode: "MARKIRO-BADGE-4412" })
      .expect(409);

    await agent.delete(`/employees/${id}/badges/${badgeId}`).expect(204);
    // After revoke the code can be reissued.
    await agent
      .post(`/employees/${other.body.id}/badges`)
      .send({ badgeCode: "MARKIRO-BADGE-4412" })
      .expect(201);

    // Revoking the same (already-revoked) badge again must not succeed, and
    // must not overwrite the original revocation timestamp.
    const afterFirstRevoke = await agent.get("/employees").expect(200);
    const badgeAfterFirstRevoke = (
      afterFirstRevoke.body.items as Array<{
        id: string;
        badges: Array<{ id: string; revokedAt: string }>;
      }>
    )
      .find((e) => e.id === id)!
      .badges.find((b) => b.id === badgeId)!;
    expect(badgeAfterFirstRevoke.revokedAt).not.toBeNull();

    await agent.delete(`/employees/${id}/badges/${badgeId}`).expect(404);

    const afterSecondRevoke = await agent.get("/employees").expect(200);
    const badgeAfterSecondRevoke = (
      afterSecondRevoke.body.items as Array<{
        id: string;
        badges: Array<{ id: string; revokedAt: string }>;
      }>
    )
      .find((e) => e.id === id)!
      .badges.find((b) => b.id === badgeId)!;
    expect(badgeAfterSecondRevoke.revokedAt).toBe(badgeAfterFirstRevoke.revokedAt);
  });

  it("isolates employees across tenants", async () => {
    const a = request.agent(app!.getHttpServer());
    await signUpAndActivate(a);
    const b = request.agent(app!.getHttpServer());
    await signUpAndActivate(b);
    const created = await a.post("/employees").send({ fullName: "A" }).expect(201);
    await b.patch(`/employees/${created.body.id}`).send({ fullName: "hax" }).expect(404);
    // Badge routes are tenant-scoped too: org B can't issue a badge on org A's
    // employee (the employee simply doesn't exist for B).
    await b
      .post(`/employees/${created.body.id}/badges`)
      .send({ badgeCode: "HAX-BADGE" })
      .expect(404);

    // Issue a real badge as org A, then have org B try to revoke *that* badge
    // by its real id: it must 404 and leave the badge active — proving the
    // guard is authorization, not just a nonexistent-id 404.
    const withBadge = await a
      .post(`/employees/${created.body.id}/badges`)
      .send({ badgeCode: "ORG-A-BADGE" })
      .expect(201);
    const badgeId = withBadge.body.badges[0].id as string;

    await b.delete(`/employees/${created.body.id}/badges/${badgeId}`).expect(404);

    const listed = await a.get("/employees").expect(200);
    const badge = (
      listed.body.items as Array<{
        id: string;
        badges: Array<{ id: string; revokedAt: string | null }>;
      }>
    )
      .find((e) => e.id === created.body.id)!
      .badges.find((x) => x.id === badgeId)!;
    expect(badge.revokedAt).toBeNull();
  });

  async function ownerMemberId(orgId: string): Promise<string> {
    const [owner] = await setup.db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.role, "owner")));
    if (!owner) throw new Error(`Expected owner member for organization ${orgId}`);
    return owner.id;
  }

  it("lists linkable members, links on create, and hides linked members", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const memberId = await ownerMemberId(tenantId);

    const before = await agent.get("/employees/linkable-members").expect(200);
    const beforeItems = before.body.items as Array<{ memberId: string; email: string }>;
    expect(beforeItems.map((m) => m.memberId)).toContain(memberId);

    const created = await agent
      .post("/employees")
      .send({ fullName: "Из Кабинета", role: "оператор", memberId })
      .expect(201);

    const [link] = await setup.db
      .select({ employeeId: schema.cabinetEmployeeLinks.employeeId })
      .from(schema.cabinetEmployeeLinks)
      .where(
        and(
          eq(schema.cabinetEmployeeLinks.organizationId, tenantId),
          eq(schema.cabinetEmployeeLinks.memberId, memberId),
        ),
      );
    expect(link?.employeeId).toBe(created.body.id);

    const after = await agent.get("/employees/linkable-members").expect(200);
    const afterItems = after.body.items as Array<{ memberId: string }>;
    expect(afterItems.map((m) => m.memberId)).not.toContain(memberId);

    // The member is already linked → a second create with the same member must
    // conflict and must not leave an orphan employee behind.
    await agent.post("/employees").send({ fullName: "Дубль", memberId }).expect(409);
    const listed = await agent.get("/employees").expect(200);
    const names = (listed.body.items as Array<{ fullName: string }>).map((e) => e.fullName);
    expect(names).not.toContain("Дубль");
  });

  it("rejects creating an employee linked to another tenant's member", async () => {
    const a = request.agent(app!.getHttpServer());
    const tenantA = await signUpAndActivate(a);
    const b = request.agent(app!.getHttpServer());
    await signUpAndActivate(b);

    const foreignMemberId = await ownerMemberId(tenantA);
    await b
      .post("/employees")
      .send({ fullName: "Чужой участник", memberId: foreignMemberId })
      .expect(404);
  });

  it("returns the employee unchanged on an empty PATCH body, and 404 for a missing id", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const created = await agent
      .post("/employees")
      .send({ fullName: "Empty Patch Тест" })
      .expect(201);
    const id = created.body.id as string;

    const patched = await agent.patch(`/employees/${id}`).send({}).expect(200);
    expect(patched.body.fullName).toBe(created.body.fullName);
    expect(patched.body.status).toBe(created.body.status);

    await agent.patch(`/employees/${randomUUID()}`).send({}).expect(404);
  });

  it("updates only this tenant employee pickup policy and audits exact before/after", async () => {
    const owner = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(owner);
    const actorUserId = await ownerUserId(tenantId);
    const created = await owner.post("/employees").send({ fullName: "Политика" }).expect(201);
    const employeeId = created.body.id as string;

    const response = await owner
      .patch(`/employees/${employeeId}/pickup-policy`)
      .send({ limitMode: "unlimited", dayLimit: 12, canWriteoff: true })
      .expect(200);

    expect(response.body.pickupPolicy).toEqual({
      limitMode: "unlimited",
      dayLimit: 12,
      canWriteoff: true,
    });
    const [audit] = await setup.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "employee.pickup_policy.updated"),
          eq(schema.tenantAuditEvents.targetId, employeeId),
        ),
      )
      .orderBy(desc(schema.tenantAuditEvents.createdAt))
      .limit(1);
    expect(audit).toMatchObject({
      organizationId: tenantId,
      actorUserId,
      action: "employee.pickup_policy.updated",
      outcome: "success",
      targetType: "employee",
      targetId: employeeId,
      before: { limitMode: "limited", dayLimit: 5, canWriteoff: false },
      after: { limitMode: "unlimited", dayLimit: 12, canWriteoff: true },
    });

    const foreign = request.agent(app!.getHttpServer());
    await signUpAndActivate(foreign);
    await foreign
      .patch(`/employees/${employeeId}/pickup-policy`)
      .send({ limitMode: "limited", dayLimit: 3, canWriteoff: false })
      .expect(404);
    expect(await employeePolicy(employeeId)).toEqual(response.body.pickupPolicy);
  });

  it("reports a missing active employee pickup policy as a configuration error", async () => {
    const owner = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(owner);
    const created = await owner.post("/employees").send({ fullName: "Без политики" }).expect(201);
    const employeeId = created.body.id as string;
    await setup.db
      .delete(schema.employeePickupPolicies)
      .where(
        and(
          eq(schema.employeePickupPolicies.tenantId, tenantId),
          eq(schema.employeePickupPolicies.employeeId, employeeId),
        ),
      );

    const response = await owner.get("/employees").expect(500);
    expect(response.body.message).toBe("Employee pickup policy is not configured");
  });

  it("bulk limit assignment preserves writeoff permission", async () => {
    const owner = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(owner);
    const actorUserId = await ownerUserId(tenantId);
    const first = await owner.post("/employees").send({ fullName: "Первый" }).expect(201);
    const second = await owner.post("/employees").send({ fullName: "Второй" }).expect(201);
    await owner
      .patch(`/employees/${first.body.id}/pickup-policy`)
      .send({ limitMode: "limited", dayLimit: 5, canWriteoff: true })
      .expect(200);

    const result = await owner
      .patch("/employees/pickup-policy/limits")
      .send({
        employeeIds: [first.body.id, second.body.id],
        limitMode: "unlimited",
        dayLimit: 17,
      })
      .expect(200);

    expect(result.body.items).toEqual([
      {
        employeeId: first.body.id,
        limitMode: "unlimited",
        dayLimit: 17,
        canWriteoff: true,
      },
      {
        employeeId: second.body.id,
        limitMode: "unlimited",
        dayLimit: 17,
        canWriteoff: false,
      },
    ]);
    const audits = await setup.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "employee.pickup_policy.updated"),
          inArray(schema.tenantAuditEvents.targetId, [first.body.id, second.body.id]),
        ),
      );
    const bulkAudits = audits
      .filter((audit) => (audit.after as { dayLimit?: number } | null)?.dayLimit === 17)
      .sort((left, right) => left.targetId!.localeCompare(right.targetId!));
    expect(bulkAudits).toEqual(
      [
        {
          employeeId: first.body.id,
          before: { limitMode: "limited", dayLimit: 5, canWriteoff: true },
          after: { limitMode: "unlimited", dayLimit: 17, canWriteoff: true },
        },
        {
          employeeId: second.body.id,
          before: { limitMode: "limited", dayLimit: 5, canWriteoff: false },
          after: { limitMode: "unlimited", dayLimit: 17, canWriteoff: false },
        },
      ]
        .sort((left, right) => left.employeeId.localeCompare(right.employeeId))
        .map(({ employeeId, before, after }) =>
          expect.objectContaining({
            organizationId: tenantId,
            actorUserId,
            outcome: "success",
            targetType: "employee",
            targetId: employeeId,
            before,
            after,
          }),
        ),
    );
  });

  it("bulk writeoff assignment preserves each numeric limit and mode", async () => {
    const owner = request.agent(app!.getHttpServer());
    await signUpAndActivate(owner);
    const first = await owner.post("/employees").send({ fullName: "Первый" }).expect(201);
    const second = await owner.post("/employees").send({ fullName: "Второй" }).expect(201);
    await owner
      .patch(`/employees/${first.body.id}/pickup-policy`)
      .send({ limitMode: "unlimited", dayLimit: 11, canWriteoff: false })
      .expect(200);
    await owner
      .patch(`/employees/${second.body.id}/pickup-policy`)
      .send({ limitMode: "limited", dayLimit: 7, canWriteoff: false })
      .expect(200);

    const result = await owner
      .patch("/employees/pickup-policy/writeoff-permission")
      .send({ employeeIds: [first.body.id, second.body.id], canWriteoff: true })
      .expect(200);

    expect(result.body.items).toEqual([
      {
        employeeId: first.body.id,
        limitMode: "unlimited",
        dayLimit: 11,
        canWriteoff: true,
      },
      {
        employeeId: second.body.id,
        limitMode: "limited",
        dayLimit: 7,
        canWriteoff: true,
      },
    ]);
  });

  it("bounds bulk employee policy assignments to 500 ids", async () => {
    const owner = request.agent(app!.getHttpServer());
    await signUpAndActivate(owner);
    await owner
      .patch("/employees/pickup-policy/limits")
      .send({
        employeeIds: Array.from({ length: 501 }, () => randomUUID()),
        limitMode: "limited",
        dayLimit: 5,
      })
      .expect(400);
  });

  it("canonicalizes uppercase bulk employee ids while preserving request order", async () => {
    const owner = request.agent(app!.getHttpServer());
    await signUpAndActivate(owner);
    const first = await owner.post("/employees").send({ fullName: "Первый UUID" }).expect(201);
    const second = await owner.post("/employees").send({ fullName: "Второй UUID" }).expect(201);

    const result = await owner
      .patch("/employees/pickup-policy/limits")
      .send({
        employeeIds: [
          (second.body.id as string).toUpperCase(),
          (first.body.id as string).toUpperCase(),
        ],
        limitMode: "unlimited",
        dayLimit: 13,
      })
      .expect(200);

    expect(result.body.items.map((item: { employeeId: string }) => item.employeeId)).toEqual([
      second.body.id,
      first.body.id,
    ]);
  });

  it("rejects mixed-case aliases of one employee in a bulk assignment", async () => {
    const owner = request.agent(app!.getHttpServer());
    await signUpAndActivate(owner);
    const employee = await owner.post("/employees").send({ fullName: "Дубликат UUID" }).expect(201);

    await owner
      .patch("/employees/pickup-policy/writeoff-permission")
      .send({
        employeeIds: [employee.body.id, (employee.body.id as string).toUpperCase()],
        canWriteoff: true,
      })
      .expect(400);
  });

  it("rejects a malformed employee pickup policy path UUID", async () => {
    const owner = request.agent(app!.getHttpServer());
    await signUpAndActivate(owner);

    await owner
      .patch("/employees/not-a-uuid/pickup-policy")
      .send({ limitMode: "limited", dayLimit: 5, canWriteoff: false })
      .expect(400);
  });

  it("fails a bulk assignment atomically when any employee belongs to another tenant", async () => {
    const owner = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(owner);
    const local = await owner.post("/employees").send({ fullName: "Свой" }).expect(201);
    const foreignOwner = request.agent(app!.getHttpServer());
    await signUpAndActivate(foreignOwner);
    const foreign = await foreignOwner.post("/employees").send({ fullName: "Чужой" }).expect(201);

    await owner
      .patch("/employees/pickup-policy/limits")
      .send({
        employeeIds: [local.body.id, foreign.body.id],
        limitMode: "limited",
        dayLimit: 19,
      })
      .expect(404);

    expect(await employeePolicy(local.body.id)).toEqual({
      limitMode: "limited",
      dayLimit: 5,
      canWriteoff: false,
    });
    expect(await employeePolicy(foreign.body.id)).toEqual({
      limitMode: "limited",
      dayLimit: 5,
      canWriteoff: false,
    });
    const localAudits = await setup.db
      .select({ id: schema.tenantAuditEvents.id })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "employee.pickup_policy.updated"),
          eq(schema.tenantAuditEvents.targetId, local.body.id),
        ),
      );
    expect(localAudits).toHaveLength(0);
  });

  // Routes carry no global prefix — only Better Auth's own `/api/auth/*` mount
  // does — so these are `/station-devices` and `/employees`, matching the
  // existing suites.
  it("rejects a station api-key: employees are cabinet-only", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const device = await createTestStationDevice(app!, agent, "Line 1 terminal");
    const apiKey = device.apiKey;

    await request(app!.getHttpServer()).get("/employees").set("x-api-key", apiKey).expect(403);
  });

  it("still serves employees to a signed-in cabinet user", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    await agent.get("/employees").expect(200);
  });
});
