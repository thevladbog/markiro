import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { CatalogService } from "../src/modules/release-catalog/catalog-service";
import { CatalogRepository } from "../src/modules/release-catalog/catalog-repository";
import { CatalogLedger } from "../src/modules/release-catalog/catalog-ledger";
import { VerifiedCache } from "../src/modules/release-catalog/catalog-cache";
import { recheckCatalogCaller } from "../src/modules/release-catalog/release-catalog.module";
import {
  PlatformAuditService,
  type PlatformAuditEvent,
  type PlatformAuditTransaction,
} from "../src/platform-auth/platform-audit.service";
import { PlatformAuthGuard } from "../src/platform-auth/platform-auth.guard";
import { PlatformStandaloneReleasesController } from "../src/modules/standalone-releases/platform-standalone-releases.controller";
import { StandaloneReleasesService } from "../src/modules/standalone-releases/standalone-releases.service";
import { listenOnLoopback } from "./support/listen-loopback";
import {
  MemoryStore,
  KEYSET,
  ORIGIN,
  manifest,
  sha,
  stranger,
} from "./support/standalone-releases";
import { fakeLedgerStore } from "./support/catalog-ledger";
const url = process.env.CATALOG_TEST_DATABASE_URL;
describe.skipIf(!url)(
  "standalone catalog HTTP with isolated PostgreSQL and exact-version storage",
  () => {
    const name = `standalone_catalog_${randomUUID().replaceAll("-", "_")}`;
    const adminDb = createDb(url ?? "postgres://invalid").pool,
      target = new URL(url ?? "postgres://invalid");
    target.pathname = `/${name}`;
    const { db, pool } = createDb(target.href);
    let created = false,
      root: string,
      app: INestApplication,
      repo: CatalogRepository;
    const users = {
      admin: `admin-${randomUUID()}`,
      support: `support-${randomUUID()}`,
      accountant: `accountant-${randomUUID()}`,
    };
    const storage = fakeLedgerStore(),
      heads = new Map<string, { versionId: string; size: number }>();
    let delayed = false,
      failAudit = false;
    class StagedStore extends MemoryStore {
      override async headVersion(key: string) {
        const value = heads.get(key) ?? null;
        if (delayed && value) {
          delayed = false;
          putVersion(key, Buffer.from("late overwrite"));
        }
        return value;
      }
    }
    const store = new StagedStore();
    function putVersion(key: string, bytes: Buffer) {
      const versionId = randomUUID();
      storage.versions.set(`${key}:${versionId}`, {
        key,
        versionId,
        bytes: Buffer.from(bytes),
        deleted: false,
      });
      heads.set(key, { versionId, size: bytes.length });
      return versionId;
    }
    class Audit extends PlatformAuditService {
      override async record(tx: PlatformAuditTransaction, event: PlatformAuditEvent) {
        if (failAudit && event.outcome === "success") throw Error("audit unavailable");
        await super.record(tx, event);
      }
    }
    const audit = new Audit();
    beforeAll(async () => {
      await adminDb.query(`CREATE DATABASE "${name}"`);
      created = true;
      await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
      root = await realpath(await mkdtemp(join(tmpdir(), "standalone-catalog-")));
      const journalDir = join(root, "journal"),
        cacheDir = join(root, "cache");
      await mkdir(journalDir, { mode: 0o700 });
      await mkdir(cacheDir, { mode: 0o700 });
      for (const [role, id] of Object.entries(users)) {
        await db.insert(schema.platformUsers).values({
          id,
          name: "Fixture",
          email: `${id}@example.invalid`,
          role: role === "admin" ? "platform_admin" : (role as "support" | "accountant"),
          status: "active",
          twoFactorEnabled: true,
        });
        await db.insert(schema.platformTwoFactors).values({
          id: randomUUID(),
          userId: id,
          secret: "fixture",
          backupCodes: "fixture",
          verified: true,
        });
      }
      await pool.query(
        "INSERT INTO release_catalog_epochs(id,product,channel,enabled) VALUES($1,'standalone','stable',true)",
        [randomUUID()],
      );
      repo = new CatalogRepository(db, audit);
      const cache = new VerifiedCache(
        {
          cacheDir,
          bucket: "markiro-releases",
          cacheBytes: 1048576,
          maxObjectBytes: 524288,
          diskReserveBytes: 1,
          maxDownloads: 2,
          timeoutMs: 1000,
        },
        storage.store,
      );
      const ledger = new CatalogLedger(
        {
          journalDir,
          bucket: "markiro-releases",
          maxPages: 10,
          maxRecords: 1000,
          maxBytes: 2097152,
          timeoutMs: 1000,
        },
        storage.store,
      );
      const catalog = new CatalogService({
        repository: repo,
        ledger,
        cache,
        bucket: "markiro-releases",
        standaloneKeys: KEYSET,
        authorize: (caller) => recheckCatalogCaller(db, caller),
      });
      const service = new StandaloneReleasesService(
        db,
        audit,
        {
          store,
          config: {
            endpoint: "https://s3.twcstorage.ru",
            region: "ru-1",
            bucket: "markiro-releases",
            accessKeyId: "fixture",
            secretAccessKey: "fixture",
            publicOrigin: ORIGIN,
          },
        },
        catalog,
        repo,
        () => new Date(),
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
    }, 30000);
    afterAll(async () => {
      await app?.close();
      await pool.end();
      if (created) await adminDb.query(`DROP DATABASE "${name}"`);
      await adminDb.end();
      if (root) await rm(root, { recursive: true });
    });
    const cookie = `fixture=${users.admin}`;
    const base = "/platform/standalone-releases";
    async function upload(version: string, proofSigner?: typeof stranger) {
      const bytes = Buffer.from(`installer ${version}`),
        proof = manifest(version, bytes, {}, proofSigner);
      const body = {
        channel: "stable",
        version,
        sourceSha: "0123456789abcdef0123456789abcdef01234567",
        idempotencyKey: randomUUID(),
        installer: { sha256: sha(bytes), sizeBytes: bytes.length },
        manifest: { sha256: sha(proof), sizeBytes: proof.length },
      };
      const response = await request(app.getHttpServer())
        .post(`${base}/uploads`)
        .set("Cookie", cookie)
        .send(body)
        .expect(200);
      const result = response.body as {
        intentId: string;
        installer: { name: string };
        manifest: { name: string };
      };
      const installerKey = `standalone/_uploads/${result.intentId}/${result.installer.name}`,
        manifestKey = `standalone/_uploads/${result.intentId}/${result.manifest.name}`;
      putVersion(installerKey, bytes);
      putVersion(manifestKey, proof);
      return { ...result, bytes, proof, installerKey, manifestKey, body };
    }
    const register = (intentId: string) =>
      request(app.getHttpServer())
        .post(`${base}/registrations`)
        .set("Cookie", cookie)
        .send({ intentId });
    const move = (
      version: string,
      expectedRevision: string,
      kind = "forward",
      operationId = randomUUID(),
    ) =>
      request(app.getHttpServer())
        .put(`${base}/stable/latest`)
        .set("Cookie", cookie)
        .send({ version, expectedRevision, kind, operationId });
    it("requires a session and administrator capability for every route", async () => {
      await request(app.getHttpServer()).get(base).expect(401);
      for (const user of [users.support, users.accountant])
        for (const [method, path] of [
          ["get", base],
          ["post", `${base}/uploads`],
          ["post", `${base}/registrations`],
          ["put", `${base}/stable/latest`],
        ] as const)
          await request(app.getHttpServer())
            [method](path)
            .set("Cookie", `fixture=${user}`)
            .expect(403);
      expect(store.presigned).toEqual([]);
      const rows = await pool.query("SELECT * FROM platform_audit_events WHERE action=$1", [
        "platform.authorization.denied",
      ]);
      for (const id of [users.support, users.accountant])
        expect(rows.rows.filter((r) => r.actor_platform_user_id === id)).toHaveLength(4);
    });
    it("refuses an untrusted ES256 key, records denial and retains every staged version", async () => {
      const f = await upload("1.0.0", stranger),
        count = storage.versions.size;
      const response = await register(f.intentId).expect(422);
      expect(response.body.code).toBe("standalone_release_manifest_unknown_key");
      expect(store.removed).toEqual([]);
      expect(storage.versions.size).toBe(count);
      expect(await repo.publicationByIntent(f.intentId)).toBeNull();
      const rows = await pool.query(
        "SELECT * FROM platform_audit_events WHERE target_id=$1 AND action=$2",
        [f.intentId, "standalone_release.register"],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        actor_platform_user_id: users.admin,
        actor_role: "platform_admin",
        tenant_id: null,
        target_type: "release_catalog_intent",
        outcome: "denied",
        reason: "conflict",
      });
    });
    it("binds exact versions despite delayed PUT and retries the original registration after newer writes", async () => {
      const f = await upload("2.0.0");
      delayed = true;
      const result = await register(f.intentId).expect(200);
      expect(result.body).toMatchObject({
        outcome: "registered",
        release: {
          version: "2.0.0",
          kid: "upd-test",
          minUpgradeFrom: "0.1.0",
          installer: { sha256: sha(f.bytes) },
        },
      });
      const accepted = await repo.publicationByIntent(f.intentId);
      expect(accepted).not.toBeNull();
      const installer = accepted!.files.find((f) => f.name.endsWith(".exe"))!;
      expect(installer.versionId).not.toBe(heads.get(f.installerKey)?.versionId);
      putVersion(f.manifestKey, Buffer.from("later invalid manifest"));
      expect((await register(f.intentId).expect(200)).body).toMatchObject({
        outcome: "unchanged",
        release: { installer: { sha256: sha(f.bytes) } },
      });
      const snapshot = await repo.readChannel({ product: "standalone", channel: "stable" });
      expect(snapshot.revision).toBe("0");
      const rows = await pool.query(
        "SELECT * FROM platform_audit_events WHERE target_id=$1 AND action=$2",
        [accepted!.publication.id, "release_catalog.publication.register"],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        actor_platform_user_id: users.admin,
        actor_role: "platform_admin",
        outcome: "success",
        tenant_id: null,
        target_type: "release_catalog_publication",
        after: {
          identity: { product: "standalone", channel: "stable", version: "2.0.0" },
          sourceSha: f.body.sourceSha,
          fileCount: 2,
        },
      });
    });
    it("CAS refuses stale screens and ambiguous retry yields only one channel event", async () => {
      const operationId = randomUUID();
      await move("2.0.0", "0", "forward", operationId).expect(200);
      await move("2.0.0", "0", "forward", operationId).expect(200);
      const f = await upload("2.1.0");
      await register(f.intentId).expect(200);
      const rejected = await move("2.1.0", "0").expect(409);
      expect(rejected.body.code).toBe("standalone_release_channel_conflict");
      expect((await repo.readChannel({ product: "standalone", channel: "stable" })).revision).toBe(
        "1",
      );
      await move("2.1.0", "1").expect(200);
      await move("2.0.0", "2").expect(409);
      await move("2.0.0", "2", "rollback").expect(200);
      const rows = await pool.query("SELECT * FROM release_catalog_channel_events WHERE id=$1", [
        operationId,
      ]);
      expect(rows.rows).toHaveLength(1);
      const list = await request(app.getHttpServer()).get(base).set("Cookie", cookie).expect(200);
      expect(list.body.channels[0]).toMatchObject({
        channel: "stable",
        revision: "3",
        latest: "2.0.0",
        latestReadable: true,
      });
      expect(list.body.channels[0].releases.map((r: { version: string }) => r.version)).toEqual([
        "2.1.0",
        "2.0.0",
      ]);
    });
    it("revoked membership after upload denies registration and audit failure leaves no publication", async () => {
      const f = await upload("2.2.0");
      await pool.query("UPDATE platform_users SET role='support' WHERE id=$1", [users.admin]);
      try {
        await register(f.intentId).expect(403);
        expect(await repo.publicationByIntent(f.intentId)).toBeNull();
      } finally {
        await pool.query("UPDATE platform_users SET role='platform_admin' WHERE id=$1", [
          users.admin,
        ]);
      }
      failAudit = true;
      try {
        await register(f.intentId).expect(503);
        expect(await repo.publicationByIntent(f.intentId)).toBeNull();
      } finally {
        failAudit = false;
      }
      await register(f.intentId).expect(200);
      expect(store.removed).toEqual([]);
    });
  },
);
