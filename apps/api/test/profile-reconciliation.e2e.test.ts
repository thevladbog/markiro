import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("profile asset reconciliation e2e", () => {
  let app: INestApplication | undefined;
  let db: Db;
  const deleteObject = vi.fn().mockResolvedValue(undefined);
  const userId = randomUUID();
  const activeId = randomUUID();
  const stagingId = randomUUID();
  const deletingId = randomUUID();

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
    db = setup.db;
    await db.insert(schema.user).values({
      id: userId,
      name: "Петров Иван",
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const stale = new Date(Date.now() - 60 * 60 * 1_000);
    await db.insert(schema.mediaAssets).values([
      {
        id: activeId,
        ownerUserId: userId,
        objectKey: `users/${userId}/avatars/${activeId}.webp`,
        contentType: "image/webp",
        byteSize: 100,
        checksum: "active-checksum",
        width: 512,
        height: 512,
        status: "active",
      },
      {
        id: stagingId,
        ownerUserId: userId,
        objectKey: `users/${userId}/avatars/${stagingId}.webp`,
        contentType: "image/webp",
        byteSize: 100,
        checksum: "staging-checksum",
        width: 512,
        height: 512,
        status: "staging",
        createdAt: stale,
        updatedAt: stale,
      },
      {
        id: deletingId,
        ownerUserId: userId,
        objectKey: `users/${userId}/avatars/${deletingId}.webp`,
        contentType: "image/webp",
        byteSize: 100,
        checksum: "deleting-checksum",
        width: 512,
        height: 512,
        status: "deleting",
        createdAt: stale,
        updatedAt: stale,
      },
    ]);
    await db.insert(schema.userProfiles).values({
      userId,
      firstName: "Иван",
      lastName: "Петров",
      avatarAssetOwnerUserId: userId,
      avatarAssetId: activeId,
    });

    const storage = {
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      delete: deleteObject,
      presignRead: vi.fn(),
    };
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
  });

  afterAll(async () => {
    await db.delete(schema.userProfiles).where(eq(schema.userProfiles.userId, userId));
    await db
      .delete(schema.mediaAssets)
      .where(inArray(schema.mediaAssets.id, [activeId, stagingId, deletingId]));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await app?.close();
  });

  it("removes stale cleanup intents while retaining the referenced active avatar", async () => {
    await vi.waitFor(async () => {
      const rows = await db
        .select({ id: schema.mediaAssets.id, status: schema.mediaAssets.status })
        .from(schema.mediaAssets)
        .where(inArray(schema.mediaAssets.id, [activeId, stagingId, deletingId]));
      expect(rows).toEqual([{ id: activeId, status: "active" }]);
    });
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(deleteObject).toHaveBeenCalledWith(`users/${userId}/avatars/${stagingId}.webp`);
    expect(deleteObject).toHaveBeenCalledWith(`users/${userId}/avatars/${deletingId}.webp`);

    const [profile] = await db
      .select({ avatarAssetId: schema.userProfiles.avatarAssetId })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId));
    expect(profile?.avatarAssetId).toBe(activeId);
  });
});
