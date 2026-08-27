import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { DB } from "../src/auth/auth.module";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * Inserts a raw `apikey` row under the `public` config, bypassing
 * `auth.api.createApiKey` entirely -- the only way to get a row with
 * `configId: "public"` but metadata the plugin itself would never produce
 * (missing, invalid JSON, or a foreign `kind`). Exercises the
 * `metadata.kind === "public"` whitelist in `ApiKeysService.list`/`revoke`
 * (see task-11-brief.md): the existing "ключ станции не виден" test only
 * proves the `configId` SQL filter works, since a station key never shares
 * `configId: "public"` to begin with.
 */
async function insertBrokenPublicKey(
  db: Db,
  tenantId: string,
  metadata: string | null,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(schema.apikey).values({
    id,
    configId: "public",
    referenceId: tenantId,
    key: `mk_broken_${id}`,
    createdAt: now,
    updatedAt: now,
    metadata,
  });
  return id;
}

// `apikey` (Better Auth's own table) carries no tenant FK the way
// `integration_channels` does, but `createApiKey`'s `organizationId` path
// still checks real organization membership (see
// `checkOrgApiKeyPermission` in `@better-auth/api-key`) -- a made-up tenant
// id would 403 on the very first POST. A real organization, created the
// same way every other e2e spec in this directory does it
// (`signUpAndActivate`), is required instead.
describe.skipIf(!ready)("public api keys", () => {
  let app: INestApplication | undefined;
  let agent: ReturnType<typeof request.agent>;
  let db: Db;
  let tenantId: string;

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    db = ref.get(DB);

    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);

    // A station device shares the same `apikey` table (Task 6). Enrolling
    // one here makes "ключ станции не виден среди публичных" below an
    // actual test of the `metadata.kind` filter, rather than something
    // that would pass even if the filter were missing.
    await createTestStationDevice(app!, agent, "Terminal filter probe");
  });

  afterAll(async () => {
    await app?.close();
  });

  it("показывает секрет ровно один раз при выпуске", async () => {
    const created = await agent
      .post("/integrations/public_api/keys")
      .send({ name: "Интеграция склада" })
      .expect(201);
    expect(created.body.key).toMatch(/^mk_/);

    const list = await agent.get("/integrations/public_api/keys").expect(200);
    const found = list.body.keys.find((k: { id: string }) => k.id === created.body.id);
    expect(found).toBeDefined();
    expect(found.key).toBeUndefined();
  });

  it("отзыв убирает ключ из списка и пишет событие", async () => {
    const created = await agent
      .post("/integrations/public_api/keys")
      .send({ name: "X" })
      .expect(201);
    await agent.delete(`/integrations/public_api/keys/${created.body.id}`).expect(204);

    const list = await agent.get("/integrations/public_api/keys").expect(200);
    expect(list.body.keys.map((k: { id: string }) => k.id)).not.toContain(created.body.id);

    const journal = await agent.get("/integrations/public_api/journal").expect(200);
    expect(JSON.stringify(journal.body)).toMatch(/отозв/i);
  });

  it("не показывает ключи чужой организации", async () => {
    const stranger = request.agent(app!.getHttpServer());
    await signUpAndActivate(stranger);
    const list = await stranger.get("/integrations/public_api/keys").expect(200);
    expect(list.body.keys).toEqual([]);
  });

  it("ключ станции не виден среди публичных", async () => {
    const list = await agent.get("/integrations/public_api/keys").expect(200);
    expect(list.body.keys.every((k: { kind: string }) => k.kind === "public")).toBe(true);
  });

  it("строка configId=public с испорченными метаданными не в списке и не отзывается", async () => {
    const brokenIds = await Promise.all([
      insertBrokenPublicKey(db, tenantId, null), // отсутствующие метаданные
      insertBrokenPublicKey(db, tenantId, "{not-json"), // невалидный JSON
      insertBrokenPublicKey(db, tenantId, JSON.stringify({ kind: "station" })), // посторонний kind
    ]);

    const list = await agent.get("/integrations/public_api/keys").expect(200);
    const listedIds = list.body.keys.map((k: { id: string }) => k.id);
    for (const id of brokenIds) {
      expect(listedIds).not.toContain(id);
    }

    for (const id of brokenIds) {
      await agent.delete(`/integrations/public_api/keys/${id}`).expect(404);
    }
  });
});
