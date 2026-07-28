import { randomInt, randomUUID } from "node:crypto";
import express from "express";
import { and, eq } from "drizzle-orm";
import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { parsePhc, verifyPhc } from "@markiro/domain";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { DB } from "../src/auth/auth.module";
import { loadEnv } from "../src/env";
import { OperatorsService } from "../src/modules/operators/operators.service";
import { getOrCreateBadgeSalt, hashBadgeWithSalt } from "../src/lib/badge-salt";
import { hashSecret } from "../src/lib/pin-hash";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("badge salt e2e", () => {
  let app: INestApplication | undefined;
  let moduleRef: TestingModule;
  let setup: AuthSetup;
  let db: Db;
  let operatorsService: OperatorsService;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    moduleRef = ref;
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    db = moduleRef.get(DB);
    operatorsService = moduleRef.get(OperatorsService);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpAndActivate(agent: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    // Generated per run rather than a hardcoded literal, so it can't be
    // flagged as a leaked secret (GitGuardian "Generic Password").
    const password = `Pw-${randomUUID()}!Aa1`;
    await agent.post("/api/auth/sign-up/email").send({ email, password, name: "T" }).expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);
    const orgId = org.body.id as string;
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return orgId;
  }

  async function createEmployee(
    agent: ReturnType<typeof request.agent>,
    fullName: string,
  ): Promise<string> {
    const res = await agent.post("/employees").send({ fullName }).expect(201);
    return res.body.id as string;
  }

  it("mints one salt per tenant and reuses it", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);

    const a = await getOrCreateBadgeSalt(db, tenantId);
    const b = await getOrCreateBadgeSalt(db, tenantId);
    expect(a).toBe(b);
    expect(Buffer.from(a, "base64")).toHaveLength(16);
  });

  it("hashes every badge of a tenant under the same salt, so a kiosk derives once", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);

    const salt = await getOrCreateBadgeSalt(db, tenantId);
    const one = await hashBadgeWithSalt("BADGE-1", salt);
    const two = await hashBadgeWithSalt("BADGE-2", salt);
    expect(parsePhc(one)!.saltB64).toBe(parsePhc(two)!.saltB64);
    await expect(verifyPhc("BADGE-1", one)).resolves.toBe(true);
    await expect(verifyPhc("BADGE-2", one)).resolves.toBe(false);
  });

  it("re-hashes a legacy per-row-salted badge onto the tenant salt", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const employeeId = await createEmployee(agent, "Legacy Badge Employee");
    // Must be an active operator to appear in buildRoster's output.
    await agent
      .put(`/operators/${employeeId}`)
      .send({ login: String(randomInt(100_000, 999_999)), pin: "1234" })
      .expect(200);

    // Seed a badge hashed the OLD way (random per-row salt, as hashSecret does).
    const legacy = await hashSecret("BADGE-LEGACY");
    await db.insert(schema.employeeBadges).values({
      tenantId,
      employeeId,
      badgeCode: "BADGE-LEGACY",
      badgeHash: legacy,
    });
    const salt = await getOrCreateBadgeSalt(db, tenantId);
    expect(parsePhc(legacy)!.saltB64).not.toBe(salt);

    const roster = await operatorsService.buildRoster(tenantId);
    const record = roster.find((r) => r.operatorId === employeeId)!;
    expect(parsePhc(record.badgeHash!)!.saltB64).toBe(salt);
    await expect(verifyPhc("BADGE-LEGACY", record.badgeHash!)).resolves.toBe(true);

    // …and it was persisted, not just computed in memory.
    const [stored] = await db
      .select({ badgeHash: schema.employeeBadges.badgeHash })
      .from(schema.employeeBadges)
      .where(
        and(
          eq(schema.employeeBadges.tenantId, tenantId),
          eq(schema.employeeBadges.badgeCode, "BADGE-LEGACY"),
        ),
      );
    expect(stored!.badgeHash).toBe(record.badgeHash);
  });
});
