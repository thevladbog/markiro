import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("chz-product-groups e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);

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

  async function signUpAndActivate(agent: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${Math.random().toString(36).substr(2, 9)}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${Math.random().toString(36).substr(2, 9)}!Aa1`, name: "T" })
      .expect(200);

    const org = await agent
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${Math.random().toString(36).substr(2, 9)}`,
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

  it("returns the seeded dictionary sorted by name", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);

    const res = await agent.get("/chz-product-groups").expect(200);
    const items = res.body.items as { code: number; alias: string; name: string }[];
    expect(items.length).toBeGreaterThanOrEqual(51);

    // Anchors, not all fifty-one rows: enough that a future edit cannot silently
    // renumber or drop a code the exports slice depends on.
    const byCode = new Map(items.map((item) => [item.code, item]));
    expect(byCode.get(8)?.alias).toBe("milk");
    expect(byCode.get(8)?.name).toBe("Молочная продукция");
    expect(byCode.get(13)?.alias).toBe("water");
    expect(byCode.get(15)?.alias).toBe("beer");

    const names = items.map((item) => item.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "ru")));
  });

  it("requires a cabinet session", async () => {
    await request(app!.getHttpServer()).get("/chz-product-groups").expect(401);
  });
});
