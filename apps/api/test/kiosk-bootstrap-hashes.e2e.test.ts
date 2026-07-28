import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { parsePhc, verifyPhc } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { hashSecret } from "../src/lib/pin-hash";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/** Badge scoped to the tenant this suite creates; never expected to leak into the payload. */
const BADGE = "BADGE-4412";

describe.skipIf(!ready)("kiosk bootstrap hashes e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  let tenantId: string;
  let employeeId: string;
  const TOKEN = `kiosk-token-${randomUUID()}`;

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

    const agent = request.agent(app!.getHttpServer());
    tenantId = await signUpAndActivate(agent);

    employeeId = randomUUID();
    await db
      .insert(schema.employees)
      .values({ id: employeeId, tenantId, fullName: "Оператор Бейджев", role: "оператор" });
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode: BADGE });

    const pinHash = await hashSecret("4321");
    await db.insert(schema.operatorCredentials).values({
      tenantId,
      employeeId,
      login: "1001",
      pinHash,
      active: true,
    });

    const kioskId = randomUUID();
    await db.insert(schema.kiosks).values({ id: kioskId, tenantId, name: "Киоск Б" });
    await db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(TOKEN) })
      .where(eq(schema.kiosks.id, kioskId));
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

  it("ships badge hashes and never a plaintext badge code", async () => {
    const res = await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", TOKEN)
      .expect(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain("BADGE-4412");

    const employee = res.body.employees[0];
    expect(employee.badgeCodes).toBeUndefined();
    expect(typeof employee.badgeHash).toBe("string");
    await expect(verifyPhc("BADGE-4412", employee.badgeHash)).resolves.toBe(true);
  });

  it("shares one salt across every badge hash so the kiosk derives once", async () => {
    const res = await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", TOKEN)
      .expect(200);

    expect(typeof res.body.badgeSalt).toBe("string");
    for (const e of res.body.employees) {
      if (e.badgeHash) expect(parsePhc(e.badgeHash)!.saltB64).toBe(res.body.badgeSalt);
    }
  });

  it("ships the operator roster as hashes for the settings screen", async () => {
    const res = await request(app!.getHttpServer())
      .get("/kiosk/bootstrap")
      .set("x-kiosk-token", TOKEN)
      .expect(200);

    const operator = res.body.operators.find((o: { login: string }) => o.login === "1001");
    expect(operator).toBeDefined();
    expect(operator.pinHash).toMatch(/^pbkdf2\$sha256\$/);
    expect(JSON.stringify(res.body.operators)).not.toContain("4321"); // the PIN plaintext
  });
});
