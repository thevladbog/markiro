import { ApiKeysModule } from "../src/modules/api-keys/api-keys.module";
import { JournalService } from "../src/modules/integrations/journal.service";
import { and, eq } from "drizzle-orm";
import { PublicApiAuthService } from "../src/modules/public-api/public-api-auth.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { SubscriptionReadOnlyException } from "../src/subscriptions/subscription-errors";
import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

  it("records issuer separately from the public key actor without retaining its secret", async () => {
    const created = await agent
      .post("/integrations/public_api/keys")
      .send({ name: "Issuer provenance", scopes: ["inventory.start"] })
      .expect(201);
    const [member] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    const rows = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.targetId, created.body.id),
          eq(schema.tenantAuditEvents.action, "public_api_key.created"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: tenantId,
      actorUserId: member?.userId,
      action: "public_api_key.created",
      outcome: "success",
      targetType: "public_api_key",
      targetId: created.body.id,
      after: { keyId: created.body.id, scopes: ["inventory.start"] },
    });
    expect(JSON.stringify(rows)).not.toContain(created.body.key);
  });
  it("retires an unrevealed key if the issuance audit/journal transaction fails", async () => {
    if (!app) throw new Error("Missing app");
    const spy = vi
      .spyOn(app.select(ApiKeysModule).get(JournalService, { strict: true }), "append")
      .mockRejectedValueOnce(new Error("injected issuance journal failure"));
    try {
      await agent
        .post("/integrations/public_api/keys")
        .send({ name: "Failed unrevealed key", scopes: [] })
        .expect(500);
    } finally {
      spy.mockRestore();
    }
    const keys = await db
      .select()
      .from(schema.apikey)
      .where(
        and(
          eq(schema.apikey.referenceId, tenantId),
          eq(schema.apikey.name, "Failed unrevealed key"),
        ),
      );
    expect(keys).toHaveLength(0);
  });

  it("manages explicit scopes and records exact tenant/actor/before/after audit", async () => {
    const created = await agent
      .post("/integrations/public_api/keys")
      .send({ name: "Scoped", scopes: ["inventory.start"] })
      .expect(201);
    expect(created.body.scopes).toEqual(["inventory.start"]);
    await expect(
      new PublicApiAuthService(db).authenticate(created.body.key),
    ).resolves.toMatchObject({ tenantId, keyId: created.body.id, scopes: ["inventory.start"] });
    const updated = await agent
      .patch(`/integrations/public_api/keys/${created.body.id}`)
      .send({ scopes: [] })
      .expect(200);
    expect(updated.body.scopes).toEqual([]);
    expect(updated.body.key).toBeUndefined();
    const events = await db.select().from(schema.integrationEvents);
    const event = events.find(
      (e) =>
        e.details?.["keyId"] === created.body.id &&
        e.details?.["action"] === "public_api_key.scopes.update",
    );
    expect(event).toMatchObject({
      tenantId,
      channelType: "public_api",
      outcome: "ok",
      details: {
        action: "public_api_key.scopes.update",
        tenantId,
        keyId: created.body.id,
        beforeScopes: ["inventory.start"],
        afterScopes: [],
        outcome: "succeeded",
      },
    });
    const [member] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    expect(event?.details?.["userId"]).toBe(member?.userId);
    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.targetId, created.body.id),
          eq(schema.tenantAuditEvents.action, "public_api_key.scopes.update"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: tenantId,
      actorUserId: member?.userId,
      action: "public_api_key.scopes.update",
      outcome: "success",
      targetType: "public_api_key",
      targetId: created.body.id,
      before: { scopes: ["inventory.start"] },
      after: { scopes: [] },
    });
    await agent
      .patch(`/integrations/public_api/keys/${created.body.id}`)
      .send({ scopes: ["*"] })
      .expect(400);
    await agent.patch(`/integrations/public_api/keys/${created.body.id}`).send({}).expect(400);
    await agent.delete(`/integrations/public_api/keys/${created.body.id}`).expect(204);
    await agent
      .patch(`/integrations/public_api/keys/${created.body.id}`)
      .send({ scopes: [] })
      .expect(404);
  });

  it("scope growth requires write/feature access while reduction remains security recovery", async () => {
    const created = await agent
      .post("/integrations/public_api/keys")
      .send({ name: "Delta", scopes: ["inventory.start"] })
      .expect(201);
    const spy = vi
      .spyOn(app!.get(EntitlementsService), "assertFeatureAccess")
      .mockRejectedValue(new SubscriptionReadOnlyException());
    try {
      await agent
        .patch(`/integrations/public_api/keys/${created.body.id}`)
        .send({ scopes: [] })
        .expect(200);
      expect(spy).not.toHaveBeenCalled();
      await agent
        .patch(`/integrations/public_api/keys/${created.body.id}`)
        .send({ scopes: ["inventory.start"] })
        .expect(403);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it("scope edits require current cabinet permission and tenant ownership", async () => {
    const created = await agent
      .post("/integrations/public_api/keys")
      .send({ name: "Boundary" })
      .expect(201);
    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    await other
      .patch(`/integrations/public_api/keys/${created.body.id}`)
      .send({ scopes: [] })
      .expect(404);
    await request(app!.getHttpServer())
      .patch(`/integrations/public_api/keys/${created.body.id}`)
      .set("x-api-key", created.body.key)
      .send({ scopes: [] })
      .expect(401);
    await db
      .update(schema.member)
      .set({ role: "viewer" })
      .where(eq(schema.member.organizationId, tenantId));
    try {
      await agent
        .patch(`/integrations/public_api/keys/${created.body.id}`)
        .send({ scopes: [] })
        .expect(403);
    } finally {
      await db
        .update(schema.member)
        .set({ role: "owner" })
        .where(eq(schema.member.organizationId, tenantId));
    }
  });

  it("concurrent scope reduction and revoke never resurrect the key", async () => {
    const created = await agent
      .post("/integrations/public_api/keys")
      .send({ name: "Race", scopes: ["inventory.start"] })
      .expect(201);
    const [edited, revoked] = await Promise.all([
      agent.patch(`/integrations/public_api/keys/${created.body.id}`).send({ scopes: [] }),
      agent.delete(`/integrations/public_api/keys/${created.body.id}`),
    ]);
    expect([200, 404]).toContain(edited.status);
    expect(revoked.status).toBe(204);
    const list = await agent.get("/integrations/public_api/keys").expect(200);
    expect(list.body.keys.map((k: { id: string }) => k.id)).not.toContain(created.body.id);
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
