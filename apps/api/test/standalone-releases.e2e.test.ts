import { randomUUID } from "node:crypto";
import { type INestApplication } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@markiro/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformStandaloneReleasesController } from "../src/modules/standalone-releases/platform-standalone-releases.controller";
import { StandaloneReleasesService } from "../src/modules/standalone-releases/standalone-releases.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { PlatformAuthGuard } from "../src/platform-auth/platform-auth.guard";
import { listenOnLoopback } from "./support/listen-loopback";
import {
  installerKey,
  KEYSET,
  manifest,
  manifestKey,
  MemoryStore,
  NOW,
  ORIGIN,
  sha,
  stranger,
} from "./support/standalone-releases";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("standalone releases over HTTP (spec 2026-10-20 §5)", () => {
  const { db, pool } = createDb(url ?? "postgres://localhost/unavailable");
  const audit = new PlatformAuditService();
  const store = new MemoryStore();
  const run = randomUUID().slice(0, 8);
  // Each run uses its own channel versions, so audit rows of earlier runs never match.
  const major = Number.parseInt(run.slice(0, 6), 16) % 1_000_000;
  const v = (minor: number) => `${major}.${minor}.0`;
  const users = {
    admin: `releases-admin-${run}`,
    support: `releases-support-${run}`,
    accountant: `releases-accountant-${run}`,
  } as const;
  const service = new StandaloneReleasesService(
    db,
    audit,
    {
      config: {
        endpoint: "https://storage.example.test",
        region: "ru-central1",
        bucket: "releases.markiro.app",
        accessKeyId: "key",
        secretAccessKey: "secret",
        publicOrigin: ORIGIN,
      },
      store,
    },
    KEYSET,
    () => NOW,
  );
  let app: INestApplication;

  beforeAll(async () => {
    await db.insert(schema.platformUsers).values(
      (Object.entries(users) as [keyof typeof users, string][]).map(([role, id]) => ({
        id,
        name: `Тест ${role}`,
        email: `${id}@example.invalid`,
        role: role === "admin" ? ("platform_admin" as const) : role,
        status: "active",
        twoFactorEnabled: true,
      })),
    );
    await db.insert(schema.platformTwoFactors).values(
      Object.values(users).map((userId) => ({
        id: randomUUID(),
        userId,
        secret: "fixture",
        backupCodes: "fixture",
        verified: true,
      })),
    );
    const module = await Test.createTestingModule({
      controllers: [PlatformStandaloneReleasesController],
      providers: [{ provide: StandaloneReleasesService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    const auth = {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const id = /fixture=([\w-]+)/.exec(headers.get("cookie") ?? "")?.[1];
          return id ? { user: { id } } : null;
        },
      },
    };
    app.useGlobalGuards(new PlatformAuthGuard(new Reflector(), auth as never, db, audit));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
    // Audit is append-only; platform users stay referenced by it.
    await pool.end();
  });

  const as = (user: keyof typeof users) => `fixture=${users[user]}`;
  const auditRows = (action: string) =>
    db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.action, action),
          inArray(schema.platformAuditEvents.actorPlatformUserId, Object.values(users)),
        ),
      )
      .orderBy(asc(schema.platformAuditEvents.createdAt));

  function put(version: string, installer: Buffer, manifestBytes: Buffer) {
    store.objects.set(installerKey("stable", version), {
      body: installer,
      contentType: "application/octet-stream",
    });
    store.objects.set(manifestKey("stable", version), {
      body: manifestBytes,
      contentType: "application/octet-stream",
    });
  }

  it("keeps everyone but the administrator out of every route, and needs a session", async () => {
    const http = request(app.getHttpServer());
    await http.get("/platform/standalone-releases").expect(401);
    for (const user of ["support", "accountant"] as const) {
      await http.get("/platform/standalone-releases").set("Cookie", as(user)).expect(403);
      await http
        .post("/platform/standalone-releases/uploads")
        .set("Cookie", as(user))
        .send({ channel: "stable", version: v(1) })
        .expect(403);
      await http
        .post("/platform/standalone-releases/registrations")
        .set("Cookie", as(user))
        .send({ channel: "stable", version: v(1) })
        .expect(403);
      await http
        .put("/platform/standalone-releases/stable/latest")
        .set("Cookie", as(user))
        .send({ version: v(1) })
        .expect(403);
    }
    expect(store.presigned).toEqual([]);
    const denied = await auditRows("platform.authorization.denied");
    expect(denied.filter((row) => row.actorPlatformUserId === users.support)).toHaveLength(4);
    expect(denied.filter((row) => row.actorPlatformUserId === users.accountant)).toHaveLength(4);
  });

  it("registers, refuses and moves the pointer with exact audit rows in Postgres", async () => {
    const http = request(app.getHttpServer());
    const installer = Buffer.from(`MZ ${run}`);

    const upload = await http
      .post("/platform/standalone-releases/uploads")
      .set("Cookie", as("admin"))
      .send({ channel: "stable", version: v(1) })
      .expect(200);
    expect(upload.body.installer.uploadUrl).toContain(installerKey("stable", v(1)));

    // A manifest signed by a key no host trusts is refused and audited.
    put(v(1), installer, manifest(v(1), installer, {}, stranger));
    await http
      .post("/platform/standalone-releases/registrations")
      .set("Cookie", as("admin"))
      .send({ channel: "stable", version: v(1) })
      .expect(422);

    put(v(1), installer, manifest(v(1), installer));
    const registered = await http
      .post("/platform/standalone-releases/registrations")
      .set("Cookie", as("admin"))
      .send({ channel: "stable", version: v(1) })
      .expect(200);
    expect(registered.body).toMatchObject({
      outcome: "registered",
      release: { version: v(1), installer: { sha256: sha(installer) } },
    });

    const latest = await http
      .put("/platform/standalone-releases/stable/latest")
      .set("Cookie", as("admin"))
      .send({ version: v(1) })
      .expect(200);
    expect(latest.body).toMatchObject({ channel: "stable", latest: v(1) });

    const registrations = await auditRows("standalone.release.register");
    expect(
      registrations.map((row) => ({
        actor: row.actorPlatformUserId,
        role: row.actorRole,
        outcome: row.outcome,
        reason: row.reason,
        tenantId: row.tenantId,
        targetType: row.targetType,
        targetId: row.targetId,
      })),
    ).toEqual([
      {
        actor: users.admin,
        role: "platform_admin",
        outcome: "rejected",
        reason: "standalone_release_manifest_unknown_key",
        tenantId: null,
        targetType: "standalone_release",
        targetId: `stable/${v(1)}`,
      },
      {
        actor: users.admin,
        role: "platform_admin",
        outcome: "success",
        reason: null,
        tenantId: null,
        targetType: "standalone_release",
        targetId: `stable/${v(1)}`,
      },
    ]);
    expect(registrations[1]?.after).toMatchObject({
      channel: "stable",
      version: v(1),
      kid: "upd-test",
      installerSha256: sha(installer),
      installerSizeBytes: installer.byteLength,
    });
    const moves = await auditRows("standalone.release.latest.set");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      actorPlatformUserId: users.admin,
      actorRole: "platform_admin",
      outcome: "success",
      targetId: `stable/${v(1)}`,
      before: { version: null },
      after: {
        channel: "stable",
        version: v(1),
        direction: "promote",
        installerSha256: sha(installer),
      },
    });
    const authorized = await auditRows("standalone.release.upload.authorize");
    expect(authorized).toHaveLength(1);
    expect(authorized[0]).toMatchObject({ outcome: "success", targetId: `stable/${v(1)}` });
  });
});
