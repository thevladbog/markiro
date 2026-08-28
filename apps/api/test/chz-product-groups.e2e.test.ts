import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

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

    // Hand-authored ordering expectations, independent of the service's own
    // comparator: assert against known-correct Russian alphabetical order
    // rather than re-deriving "expected" by re-sorting the response with the
    // same function under test (that would only prove the service agrees
    // with itself).
    const nameIndex = (name: string) => items.findIndex((item) => item.name === name);

    // "Лёгкая промышленность" vs "Лекарственные препараты для медицинского
    // применения" is the pair that actually exercises the letter "ё": a
    // plain byte/codepoint ("C" collation) comparison places "ё" (U+0451)
    // after "я" -- i.e. after the rest of the alphabet -- so an unlocalized
    // sort (e.g. a bare SQL `ORDER BY name` under "C" collation) would put
    // "Лекарственные..." first. Correct Russian alphabetical order treats
    // "ё" as sitting right after "е" (before "ж"), so "Лёгкая..." belongs
    // first. This assertion catches a regression to that kind of ordering.
    const legkaya = nameIndex("Лёгкая промышленность");
    const lekarstvennye = nameIndex("Лекарственные препараты для медицинского применения");
    expect(legkaya).toBeGreaterThanOrEqual(0);
    expect(lekarstvennye).toBeGreaterThanOrEqual(0);
    expect(legkaya).toBeLessThan(lekarstvennye);

    // A couple more hand-picked pairs spanning the alphabet, to catch a
    // regression that reverses order or drops localization entirely.
    const avtozapchasti = nameIndex("Автозапчасти и комплектующие транспортных средств");
    const alkogol = nameIndex("Алкоголь");
    const shiny = nameIndex("Шины и покрышки пневматические резиновые новые");
    expect(avtozapchasti).toBeGreaterThanOrEqual(0);
    expect(alkogol).toBeGreaterThanOrEqual(0);
    expect(shiny).toBeGreaterThanOrEqual(0);
    expect(avtozapchasti).toBeLessThan(alkogol);
    expect(alkogol).toBeLessThan(shiny);
  });

  it("requires a cabinet session", async () => {
    await request(app!.getHttpServer()).get("/chz-product-groups").expect(401);
  });
});
