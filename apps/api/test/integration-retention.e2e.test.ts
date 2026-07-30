import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { JournalService } from "../src/modules/integrations/journal.service";
import { ExchangeSessionService } from "../src/modules/exchange/exchange-session.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

// Same tenant-FK reasoning as `integration-journal.e2e.test.ts`:
// `integration_sessions`/`exchange_uploads` carry a `tenant_id ->
// organization.id` FK, so a real organization is required before either
// table can be written to.
describe.skipIf(!ready)("retention job", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let journal: JournalService;
  let sessions: ExchangeSessionService;
  let tenantId: string;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;
    journal = new JournalService(db);
    sessions = new ExchangeSessionService(db, journal);

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);

    const agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("подметает просроченные сеансы вместе с их кусками — брошенный обмен не оставляет мусора", async () => {
    const stale = await journal.openSession(tenantId, "commerceml", {
      cookieHash: `h-${randomUUID()}`,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await db.insert(schema.exchangeUploads).values({
      tenantId,
      sessionId: stale.id,
      filename: "import.xml",
      chunk: 0,
      body: Buffer.from("x"),
    });

    await sessions.sweepExpired(new Date());

    const left = await db
      .select()
      .from(schema.exchangeUploads)
      .where(eq(schema.exchangeUploads.sessionId, stale.id));
    expect(left).toHaveLength(0);
  });
});
