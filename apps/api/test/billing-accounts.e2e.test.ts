import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import express from "express";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, schema, type PlatformRole } from "@markiro/db";
import type { BankAccountInput } from "@markiro/platform-contracts";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { corsDelegate } from "../src/cors";
import { loadEnv } from "../src/env";
import { mountPlatformAuth, setupPlatformAuth } from "../src/platform-auth/platform-auth.setup";
import { listenOnLoopback } from "./support/listen-loopback";

const databaseUrl = process.env.DATABASE_URL;
const ready = Boolean(
  databaseUrl &&
  process.env.BETTER_AUTH_SECRET &&
  process.env.BETTER_AUTH_URL &&
  process.env.PLATFORM_AUTH_SECRET &&
  process.env.PLATFORM_AUTH_URL &&
  process.env.SAAS_ADMIN_ORIGIN,
);

function requiredSetCookie(response: request.Response): string {
  const values = response.headers["set-cookie"];
  const cookies = Array.isArray(values) ? values : typeof values === "string" ? [values] : [];
  const cookie = cookies.find((value) => value.startsWith("markiro-platform.session_token="));
  if (!cookie) throw new Error("Expected a platform session cookie");
  return cookie.split(";", 1)[0]!;
}

function currentTotp(uri: string): string {
  const encoded = new URL(uri).searchParams.get("secret");
  if (!encoded) throw new Error("Expected a TOTP enrollment URI");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of encoded.toUpperCase().replaceAll("=", "")) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("Invalid TOTP enrollment URI");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  const offset = digest.at(-1)! & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}

describe.skipIf(!ready)("billing accounts API", () => {
  const databaseName = `markiro_billing_accounts_e2e_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const migrationsFolder = join(__dirname, "../../../packages/db/migrations");
  const tenantA = `billing-e2e-a-${randomUUID()}`;
  const tenantB = `billing-e2e-b-${randomUUID()}`;
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let admin: ReturnType<typeof request.agent>;
  let accountant: ReturnType<typeof request.agent>;
  let support: ReturnType<typeof request.agent>;

  const bankAccount = (sequence: number): BankAccountInput => ({
    label: `Расчётный ${sequence}`,
    settlementAccount: `4070281090000000${sequence.toString().padStart(4, "0")}`,
    bic: "044525225",
    bankName: "ПАО Сбербанк",
    correspondentAccount: "30101810400000000225",
    currency: "RUB",
  });

  async function createPlatformAgent(role: PlatformRole) {
    const password = randomBytes(24).toString("base64url");
    const signedUp = await request(app!.getHttpServer())
      .post("/api/platform-auth/sign-up/email")
      .set("Origin", setupEnv.SAAS_ADMIN_ORIGIN)
      .send({ email: `${role}-${randomUUID()}@example.invalid`, password, name: role })
      .expect(200);
    const userId = (signedUp.body as { user: { id: string } }).user.id;
    let cookie = requiredSetCookie(signedUp);
    await setup.db
      .update(schema.platformUsers)
      .set({ status: "active", role })
      .where(eq(schema.platformUsers.id, userId));
    const enrollment = await request(app!.getHttpServer())
      .post("/api/platform-auth/two-factor/enable")
      .set("Origin", setupEnv.SAAS_ADMIN_ORIGIN)
      .set("Cookie", cookie)
      .send({ password })
      .expect(200);
    const verified = await request(app!.getHttpServer())
      .post("/api/platform-auth/two-factor/verify-totp")
      .set("Origin", setupEnv.SAAS_ADMIN_ORIGIN)
      .set("Cookie", cookie)
      .send({
        code: currentTotp((enrollment.body as { totpURI: string }).totpURI),
        trustDevice: false,
      })
      .expect(200);
    cookie = requiredSetCookie(verified);
    return request.agent(app!.getHttpServer()).set("Cookie", cookie);
  }

  const setupEnv = loadEnv({
    ...process.env,
    DATABASE_URL: scratchUrl.toString(),
  });

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const migrator = createDb(scratchUrl.toString());
    await migrate(migrator.db, { migrationsFolder });
    await migrator.pool.end();

    setup = setupAuth(setupEnv);
    const platformSetup = setupPlatformAuth(setupEnv, setup.db);
    const ref = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          ...setup,
          platformAuth: platformSetup.platformAuth,
          databaseUrl: setupEnv.DATABASE_URL,
          env: setupEnv,
        }),
      ],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    app.enableCors(corsDelegate(setupEnv));
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    mountPlatformAuth(server, platformSetup.platformAuth, { allowTestSignUp: true });
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);

    admin = await createPlatformAgent("platform_admin");
    accountant = await createPlatformAgent("accountant");
    support = await createPlatformAgent("support");
    const createdAt = new Date();
    await setup.db.insert(schema.organization).values([
      { id: tenantA, name: "Billing tenant A", slug: tenantA, createdAt },
      { id: tenantB, name: "Billing tenant B", slug: tenantB, createdAt },
    ]);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await maintenance.pool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenance.pool.end();
  });

  it("allows admin/accountant lifecycle access and denies support financial access", async () => {
    const created = await admin
      .post("/platform/billing/operator/accounts")
      .send(bankAccount(11))
      .expect(201);
    expect(created.body).toMatchObject({ status: "active", isDefault: true });

    const listed = await accountant.get("/platform/billing/operator/accounts").expect(200);
    expect(listed.body).toEqual([expect.objectContaining({ id: created.body.id })]);
    await support.get("/platform/billing/operator/accounts").expect(403);
    await support.post("/platform/billing/operator/accounts").send(bankAccount(12)).expect(403);
  });

  it("returns not-found instead of disclosing a tenant account through another tenant", async () => {
    const foreign = await accountant
      .post(`/platform/billing/tenants/${tenantB}/accounts`)
      .send(bankAccount(21))
      .expect(201);

    const response = await admin
      .patch(`/platform/billing/tenants/${tenantA}/accounts/${foreign.body.id}/default`)
      .send({})
      .expect(404);
    expect(response.body).toEqual(expect.objectContaining({ code: "billing_account_not_found" }));
  });
});
