import * as nodeCrypto from "node:crypto";
import type * as ExchangeCredentialsModule from "../src/modules/exchange/exchange-credentials";
import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import {
  assertUnderCheckauthLimit,
  CHECKAUTH_BUDGET,
  generateExchangeCredentials,
  hashExchangeSecret,
  refundCheckauthAttempt,
  verifyExchangeSecret,
} from "../src/modules/exchange/exchange-credentials";

// Only `randomUUID` is ever mocked (the login-collision regression below,
// one call, one test) -- every other export passes through unchanged.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeCrypto>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

// Same shape as the mock above: `refundCheckauthAttempt` is wrapped, not
// replaced, so every test that doesn't touch it gets the real
// implementation. Only the Fix 2 regression below overrides it, once, via
// `mockRejectedValueOnce`.
vi.mock("../src/modules/exchange/exchange-credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof ExchangeCredentialsModule>();
  return { ...actual, refundCheckauthAttempt: vi.fn(actual.refundCheckauthAttempt) };
});

describe("exchange credentials", () => {
  it("выдаёт логин и секрет, и секрет не выводится из логина", () => {
    const a = generateExchangeCredentials();
    const b = generateExchangeCredentials();
    expect(a.login).not.toBe(b.login);
    expect(a.secret).not.toBe(b.secret);
    expect(a.secret.length).toBeGreaterThanOrEqual(24);
  });

  it("хранит только хэш и узнаёт по нему правильный секрет", async () => {
    const { secret } = generateExchangeCredentials();
    const hash = await hashExchangeSecret(secret);
    expect(hash).not.toContain(secret);
    expect(await verifyExchangeSecret(secret, hash)).toBe(true);
    expect(await verifyExchangeSecret(`${secret}x`, hash)).toBe(false);
  });

  it("не падает на мусорном хэше, а отвечает отказом", async () => {
    expect(await verifyExchangeSecret("whatever", "not-a-phc-string")).toBe(false);
  });
});

describe("exchange credentials — checkauth attempt counter", () => {
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
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  function freshSource(): string {
    return `test-source-${crypto.randomUUID()}`;
  }

  // Pins the "count attempts, not misses on a matched row" requirement called
  // out in the brief: this counter takes only `(source, windowStart)` -- it
  // never looks up a channel row -- so it must trip purely from repeated
  // calls, with no channel/login involved at all. Exactly the shape the
  // kiosk-pairing bug got wrong (a counter that only incremented when a row
  // was found, so a wrong login could never trip it).
  it("запирает после budget попыток, даже когда ни один вызов не относится к найденной строке", async () => {
    const source = freshSource();
    const windowStart = new Date();

    for (let i = 0; i < CHECKAUTH_BUDGET; i++) {
      await expect(assertUnderCheckauthLimit(db, source, windowStart)).resolves.toBeUndefined();
    }
    await expect(assertUnderCheckauthLimit(db, source, windowStart)).rejects.toThrow();

    const [row] = await db
      .select()
      .from(schema.exchangeAttempts)
      .where(
        and(
          eq(schema.exchangeAttempts.source, source),
          eq(schema.exchangeAttempts.windowStartedAt, windowStart),
        ),
      );
    expect(row?.failures).toBe(CHECKAUTH_BUDGET + 1);
  });

  it("успешный вход возвращает потраченную попытку, но не уходит в минус", async () => {
    const source = freshSource();
    const windowStart = new Date();

    await assertUnderCheckauthLimit(db, source, windowStart);
    await assertUnderCheckauthLimit(db, source, windowStart);
    await refundCheckauthAttempt(db, source, windowStart);
    await refundCheckauthAttempt(db, source, windowStart);
    await refundCheckauthAttempt(db, source, windowStart); // one refund past zero

    const [row] = await db
      .select()
      .from(schema.exchangeAttempts)
      .where(
        and(
          eq(schema.exchangeAttempts.source, source),
          eq(schema.exchangeAttempts.windowStartedAt, windowStart),
        ),
      );
    expect(row?.failures).toBe(0);
  });
});

describe("integrations (cabinet) — issue exchange credentials", () => {
  let app: INestApplication | undefined;
  let agent: ReturnType<typeof request.agent>;
  let db: Db;
  let tenantId: string;

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
    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("выпускает логин и секрет ровно один раз, а в базе хранит только хэш", async () => {
    const res = await agent.post("/integrations/commerceml/credentials").send({}).expect(201);
    expect(res.body.login).toEqual(expect.any(String));
    expect(res.body.secret).toEqual(expect.any(String));

    const [row] = await db
      .select()
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, "commerceml"),
        ),
      );
    expect(row?.credentialLogin).toBe(res.body.login);
    expect(row?.credentialHash).not.toContain(res.body.secret);
    expect(await verifyExchangeSecret(res.body.secret, row!.credentialHash!)).toBe(true);
  });

  // Fix 2 regression: `exchange.controller.ts:215` calls `refundCheckauthAttempt`
  // right after a genuinely matched login+secret. If that call throws
  // unguarded, a caller with VALID credentials would get an exception instead
  // of its session -- the sample the review points at, `pairing.service.ts:
  // 204-211`, avoids exactly this by wrapping its own compensating refund in
  // `.catch()`. `refundCheckauthAttempt` is mocked (module-level, above) to
  // reject once here; every other test in this file gets the real
  // implementation untouched.
  it("сбой возврата попытки после верных учётных данных не роняет успешную аутентификацию", async () => {
    const issued = await agent.post("/integrations/commerceml/credentials").send({}).expect(201);

    vi.mocked(refundCheckauthAttempt).mockRejectedValueOnce(new Error("refund boom"));

    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=checkauth")
      .auth(issued.body.login, issued.body.secret)
      .expect(200);

    const lines = res.text.split("\n");
    expect(lines[0]).toBe("success");
    expect(lines[1]).toBeTruthy();
    expect(lines[2]).toBeTruthy();
  });

  it("никогда не отдаёт секрет из карточки канала", async () => {
    await agent.post("/integrations/commerceml/credentials").send({}).expect(201);
    const res = await agent.get("/integrations/commerceml").expect(200);
    expect(res.body.credentialLogin).toEqual(expect.any(String));
    expect(res.body).not.toHaveProperty("secret");
    expect(res.body).not.toHaveProperty("credentialHash");
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("повторный выпуск затирает прежний хэш — старый секрет перестаёт подходить", async () => {
    const first = await agent.post("/integrations/commerceml/credentials").send({}).expect(201);
    const second = await agent.post("/integrations/commerceml/credentials").send({}).expect(201);

    expect(second.body.login).not.toBe(first.body.login);
    expect(second.body.secret).not.toBe(first.body.secret);

    const [row] = await db
      .select()
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, "commerceml"),
        ),
      );
    expect(await verifyExchangeSecret(first.body.secret, row!.credentialHash!)).toBe(false);
    expect(await verifyExchangeSecret(second.body.secret, row!.credentialHash!)).toBe(true);
  });

  it("404 на неизвестный тип канала", async () => {
    await agent.post("/integrations/bogus/credentials").send({}).expect(404);
  });

  it("409 на канал, который ещё недоступен", async () => {
    await agent.post("/integrations/gis_mt_files/credentials").send({}).expect(409);
  });

  it("не пускает ключ станции в кабинетный маршрут", async () => {
    const stationKey = (await createTestStationDevice(app!, agent, "Terminal")).apiKey;

    await request(app!.getHttpServer())
      .post("/integrations/commerceml/credentials")
      .set("x-api-key", stationKey)
      .send({})
      .expect(403);
  });

  // Regression: `credentialLogin` is unique across EVERY tenant and channel
  // (`integration_channels_login_uq`), but `generateExchangeCredentials`
  // mints only an 8 hex-char suffix -- a collision is rare but real. Forces
  // the very first random draw to reproduce an already-taken login (seeded on
  // a DIFFERENT channel of the SAME tenant, so the primary-key upsert target
  // never masks it) and asserts `issueCredentials` re-mints instead of
  // surfacing the raw 23505 as a 500.
  it("коллизия логина перегенерирует пару, а не роняет выпуск в 500", async () => {
    const collidingLogin = "mk-1c-abcdef12";
    const otherHash = await hashExchangeSecret("unrelated-secret-not-checked");

    await db.insert(schema.integrationChannels).values({
      tenantId,
      type: "public_api",
      credentialLogin: collidingLogin,
      credentialHash: otherHash,
    });

    try {
      vi.mocked(nodeCrypto.randomUUID).mockImplementationOnce(
        () => "abcdef12-0000-4000-8000-000000000000" as ReturnType<typeof nodeCrypto.randomUUID>,
      );

      const res = await agent.post("/integrations/commerceml/credentials").send({}).expect(201);
      expect(res.body.login).not.toBe(collidingLogin);

      const [row] = await db
        .select()
        .from(schema.integrationChannels)
        .where(
          and(
            eq(schema.integrationChannels.tenantId, tenantId),
            eq(schema.integrationChannels.type, "commerceml"),
          ),
        );
      expect(row?.credentialLogin).toBe(res.body.login);
      expect(await verifyExchangeSecret(res.body.secret, row!.credentialHash!)).toBe(true);

      // The seeded row on the other channel is untouched by the retry.
      const [otherRow] = await db
        .select()
        .from(schema.integrationChannels)
        .where(
          and(
            eq(schema.integrationChannels.tenantId, tenantId),
            eq(schema.integrationChannels.type, "public_api"),
          ),
        );
      expect(otherRow?.credentialLogin).toBe(collidingLogin);
    } finally {
      await db
        .delete(schema.integrationChannels)
        .where(
          and(
            eq(schema.integrationChannels.tenantId, tenantId),
            eq(schema.integrationChannels.type, "public_api"),
          ),
        );
    }
  });
});
