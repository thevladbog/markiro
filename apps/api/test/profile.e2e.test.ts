import express from "express";
import sharp from "sharp";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { signUpWithInactiveOrg } from "./support/auth";
import { settleQueuedBackgroundWork } from "./support/background-work";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("global profile and private avatar e2e", () => {
  let app: INestApplication | undefined;
  let db: Db;
  const storedObjects = new Map<string, Buffer>();
  const storage = {
    ensureBucket: vi.fn().mockResolvedValue(undefined),
    put: vi.fn(async (key: string, body: Buffer) => {
      storedObjects.set(key, body);
    }),
    delete: vi.fn(async (key: string) => {
      storedObjects.delete(key);
    }),
    presignRead: vi.fn(async (key: string) => `https://signed.invalid/${encodeURIComponent(key)}`),
  };

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
    db = setup.db;
    // Neutralise background work an earlier file (or an aborted run) left
    // claimable, before `app.init()` lets this suite's pg-boss workers
    // reconcile it into the storage mock below. See `settleQueuedBackgroundWork`.
    await settleQueuedBackgroundWork(db);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    })
      .overrideProvider(ObjectStorageService)
      .useValue(storage)
      .compile();

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

  beforeEach(() => {
    storedObjects.clear();
    vi.clearAllMocks();
    storage.ensureBucket.mockResolvedValue(undefined);
    storage.put.mockImplementation(async (key: string, body: Buffer) => {
      storedObjects.set(key, body);
    });
    storage.delete.mockImplementation(async (key: string) => {
      storedObjects.delete(key);
    });
    storage.presignRead.mockImplementation(
      async (key: string) => `https://signed.invalid/${encodeURIComponent(key)}`,
    );
  });

  async function fixture() {
    const agent = request.agent(app!.getHttpServer());
    const organizationId = await signUpWithInactiveOrg(agent);
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, organizationId));
    if (!member) throw new Error("Expected the fixture organization to have an owner");
    return { agent, organizationId, userId: member.userId };
  }

  async function completeProfile(agent: ReturnType<typeof request.agent>) {
    return agent
      .patch("/profile")
      .send({ firstName: "Иван", lastName: "Петров", middleName: "Сергеевич" })
      .expect(200);
  }

  async function avatarFixture(): Promise<Buffer> {
    return sharp({
      create: { width: 700, height: 300, channels: 3, background: "#2463eb" },
    })
      .jpeg()
      .toBuffer();
  }

  it("requires a user session without requiring an active tenant", async () => {
    await request(app!.getHttpServer()).get("/profile").expect(401);

    const { agent } = await fixture();
    await agent.get("/profile").expect(200, {
      firstName: null,
      lastName: null,
      middleName: null,
      hasAvatar: false,
    });
  });

  it("stores structured names and keeps the Better Auth display name synchronized", async () => {
    const { agent, organizationId, userId } = await fixture();

    const response = await completeProfile(agent);
    expect(response.body).toEqual({
      firstName: "Иван",
      lastName: "Петров",
      middleName: "Сергеевич",
      hasAvatar: false,
    });

    const [profile] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId));
    expect(profile).toMatchObject({
      firstName: "Иван",
      lastName: "Петров",
      middleName: "Сергеевич",
      avatarAssetId: null,
    });
    const [user] = await db
      .select({ name: schema.user.name })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(user?.name).toBe("Петров Иван Сергеевич");

    const audit = await db
      .select({
        action: schema.tenantAuditEvents.action,
        before: schema.tenantAuditEvents.before,
        after: schema.tenantAuditEvents.after,
      })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, organizationId),
          eq(schema.tenantAuditEvents.targetId, userId),
        ),
      );
    expect(audit.map((event) => event.action)).toContain("profile.updated");
    expect(JSON.stringify(audit)).not.toContain("Иван");
    expect(JSON.stringify(audit)).not.toContain("Петров");
  });

  it("fans global profile audit metadata out to every tenant membership", async () => {
    const { agent, organizationId, userId } = await fixture();
    const secondOrganizationId = randomUUID();
    await db.insert(schema.organization).values({
      id: secondOrganizationId,
      name: "Second profile fixture organization",
      slug: `profile-second-${randomUUID()}`,
      createdAt: new Date(),
    });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: secondOrganizationId,
      userId,
      role: "manager",
      createdAt: new Date(),
    });

    await completeProfile(agent);

    const audits = await db
      .select({ organizationId: schema.tenantAuditEvents.organizationId })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.targetId, userId),
          eq(schema.tenantAuditEvents.action, "profile.updated"),
        ),
      );
    expect(new Set(audits.map((event) => event.organizationId))).toEqual(
      new Set([organizationId, secondOrganizationId]),
    );
  });

  it("uses removal-specific guidance when no structured profile exists", async () => {
    const { agent } = await fixture();

    const response = await agent.delete("/profile/avatar").expect(409);

    expect(response.body.message).toBe("Complete the profile before removing an avatar");
  });

  it("rejects invalid avatar content and reports a missing signed read", async () => {
    const { agent } = await fixture();
    await completeProfile(agent);

    await agent.get("/profile/avatar-url").expect(200, { url: null });
    await agent
      .post("/profile/avatar")
      .attach("avatar", Buffer.from("not an image"), {
        filename: "bad.txt",
        contentType: "text/plain",
      })
      .expect(400);
  });

  it("normalizes an avatar, stores it privately, and returns only a short signed read", async () => {
    const { agent, userId } = await fixture();
    await completeProfile(agent);
    const source = await avatarFixture();

    const uploaded = await agent
      .post("/profile/avatar")
      .attach("avatar", source, { filename: "portrait.jpg", contentType: "image/jpeg" })
      .expect(201);
    expect(uploaded.body).toMatchObject({ hasAvatar: true });

    const [profile] = await db
      .select({ avatarAssetId: schema.userProfiles.avatarAssetId })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId));
    expect(profile?.avatarAssetId).toEqual(expect.any(String));
    const [asset] = await db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id, profile!.avatarAssetId!));
    expect(asset).toMatchObject({
      ownerUserId: userId,
      contentType: "image/webp",
      width: 512,
      height: 512,
      status: "active",
    });
    expect(asset!.objectKey).toBe(`users/${userId}/avatars/${asset!.id}.webp`);
    expect(storedObjects.get(asset!.objectKey)).toBeDefined();
    expect(uploaded.body).not.toHaveProperty("objectKey");
    expect(uploaded.body).not.toHaveProperty("avatarAssetId");

    const signed = await agent.get("/profile/avatar-url").expect(200);
    expect(signed.body.url).toBe(`https://signed.invalid/${encodeURIComponent(asset!.objectKey)}`);
    expect(storage.presignRead).toHaveBeenCalledWith(asset!.objectKey, 300);
  });

  it("keeps the active avatar and durable staging intent when object upload fails", async () => {
    const { agent, userId } = await fixture();
    await completeProfile(agent);
    const source = await avatarFixture();
    await agent
      .post("/profile/avatar")
      .attach("avatar", source, { filename: "first.jpg", contentType: "image/jpeg" })
      .expect(201);
    const [before] = await db
      .select({ avatarAssetId: schema.userProfiles.avatarAssetId })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId));

    storage.put.mockRejectedValueOnce(new Error("storage unavailable"));
    await agent
      .post("/profile/avatar")
      .attach("avatar", source, { filename: "replacement.jpg", contentType: "image/jpeg" })
      .expect(503);

    const [after] = await db
      .select({ avatarAssetId: schema.userProfiles.avatarAssetId })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId));
    expect(after?.avatarAssetId).toBe(before?.avatarAssetId);
    const staging = await db
      .select({ id: schema.mediaAssets.id })
      .from(schema.mediaAssets)
      .where(
        and(eq(schema.mediaAssets.ownerUserId, userId), eq(schema.mediaAssets.status, "staging")),
      );
    expect(staging).toHaveLength(1);
  });

  it("switches to a replacement before deleting the previous private object", async () => {
    const { agent, userId } = await fixture();
    await completeProfile(agent);
    const source = await avatarFixture();
    await agent
      .post("/profile/avatar")
      .attach("avatar", source, { filename: "first.jpg", contentType: "image/jpeg" })
      .expect(201);
    const [before] = await db
      .select({ id: schema.mediaAssets.id, objectKey: schema.mediaAssets.objectKey })
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.ownerUserId, userId));

    await agent
      .post("/profile/avatar")
      .attach("avatar", source, { filename: "replacement.jpg", contentType: "image/jpeg" })
      .expect(201);

    const [profile] = await db
      .select({ avatarAssetId: schema.userProfiles.avatarAssetId })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId));
    expect(profile?.avatarAssetId).not.toBe(before?.id);
    expect(
      await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, before!.id)),
    ).toHaveLength(0);
    expect(storedObjects.has(before!.objectKey)).toBe(false);
    expect(storage.delete).toHaveBeenCalledWith(before!.objectKey);
  });

  it("clears the profile first and leaves failed object deletion retryable", async () => {
    const { agent, userId } = await fixture();
    await completeProfile(agent);
    const source = await avatarFixture();
    await agent
      .post("/profile/avatar")
      .attach("avatar", source, { filename: "portrait.jpg", contentType: "image/jpeg" })
      .expect(201);
    const [before] = await db
      .select({ avatarAssetId: schema.userProfiles.avatarAssetId })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId));

    storage.delete.mockRejectedValueOnce(new Error("delete unavailable"));
    await agent.delete("/profile/avatar").expect(204);

    const [profile] = await db
      .select({ avatarAssetId: schema.userProfiles.avatarAssetId })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId));
    expect(profile?.avatarAssetId).toBeNull();
    const [asset] = await db
      .select({ status: schema.mediaAssets.status })
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id, before!.avatarAssetId!));
    expect(asset?.status).toBe("deleting");
  });
});
