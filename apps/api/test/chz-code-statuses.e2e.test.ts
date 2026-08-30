import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@markiro/db";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

describe.skipIf(!ready)("chz code statuses freshness line", () => {
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

  async function seedStatus(
    tenantId: string,
    input: { codeHash: string; group: number | null; checkedAt: Date | null },
  ): Promise<void> {
    await db.insert(schema.chzCodeStatuses).values({
      tenantId,
      codeHash: input.codeHash,
      chzProductGroupCode: input.group,
      checkedAt: input.checkedAt,
    });
  }

  it("counts the store and reports how fresh it is", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);

    // Computed once, not re-derived at assertion time: `hoursAgo` reads
    // `Date.now()`, and the real wall-clock time this test spends signing up
    // a tenant and round-tripping two HTTP requests is enough drift to make
    // two independent `hoursAgo(1)` calls disagree by tens of milliseconds.
    const checkedAt = hoursAgo(1);
    await seedStatus(tenantId, { codeHash: HASH_A, group: 8, checkedAt });
    await seedStatus(tenantId, { codeHash: HASH_B, group: 8, checkedAt: hoursAgo(30) });
    await seedStatus(tenantId, { codeHash: HASH_C, group: null, checkedAt: null });

    const res = await agent.get("/integrations/chestny_znak/code-statuses").expect(200);

    expect(res.body).toMatchObject({
      total: 3,
      refreshedLastDay: 1,
      withoutProductGroup: 1,
    });
    expect(Date.parse(res.body.lastCheckedAt)).toBe(checkedAt.getTime());
  });

  it("answers with zeroes for a tenant that has never run a pass", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const res = await agent.get("/integrations/chestny_znak/code-statuses").expect(200);
    expect(res.body).toEqual({
      total: 0,
      refreshedLastDay: 0,
      withoutProductGroup: 0,
      lastCheckedAt: null,
    });
  });

  it("requires a cabinet session", async () => {
    await request(app!.getHttpServer()).get("/integrations/chestny_znak/code-statuses").expect(401);
  });

  // `chz_code_statuses` carries no channel column at all -- one row per
  // `(tenantId, codeHash)`, tenant-wide, not one per integration channel (see
  // that table's own doc) -- but that data is Chestny ZNAK's, and handing it
  // back under an unrelated channel (`commerceml`) would be wrong regardless.
  // `ChzCodeStatusReadService.summary` narrows to `chestny_znak` the same
  // shape `IntegrationsService.issueCredentials`/`deleteChannel` already use
  // for `usesExchangeCredentials`: a type the registry has never heard of at
  // all is 404 (`safeDescribeChannel`, same as `:type/candidates` and
  // `:type/journal` -- `integrations.e2e.test.ts`'s "404 на неизвестный тип
  // канала" pins that), while a *registered* type that just isn't
  // `chestny_znak` is 409, not 200.
  it("answers 409 for a registered channel type that isn't chestny_znak, and 404 for an unregistered one", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    await seedStatus(tenantId, { codeHash: HASH_A, group: 8, checkedAt: hoursAgo(1) });

    await agent.get("/integrations/commerceml/code-statuses").expect(409);

    await agent.get("/integrations/bogus/code-statuses").expect(404);
  });
});
