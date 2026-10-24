import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createDb, schema } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogService, type CatalogCaller } from "../src/modules/release-catalog/catalog-service";
import { CatalogRepository } from "../src/modules/release-catalog/catalog-repository";
import { CatalogLedger } from "../src/modules/release-catalog/catalog-ledger";
import { VerifiedCache } from "../src/modules/release-catalog/catalog-cache";
import type { CatalogStore } from "../src/modules/release-catalog/catalog-store";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import {
  recheckCatalogCaller,
  platformCatalogFingerprint,
} from "../src/modules/release-catalog/release-catalog.module";
import { CatalogFault } from "../src/modules/release-catalog/catalog-types";
const url = process.env.CATALOG_TEST_DATABASE_URL;
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
describe.skipIf(!url)("catalog publication with real DB, cache and durable journal", () => {
  const name = `catalog_service_${randomUUID().replaceAll("-", "_")}`;
  const admin = createDb(url ?? "postgres://invalid").pool;
  const target = new URL(url ?? "postgres://invalid");
  target.pathname = `/${name}`;
  const { db, pool } = createDb(target.href);
  let root: string;
  let created = false;
  let serial = 100;
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
    root = await realpath(await mkdtemp(join(tmpdir(), "catalog-service-")));
  }, 30000);
  afterAll(async () => {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    if (root) await rm(root, { recursive: true });
  });
  async function setup() {
    const versionCode = serial++,
      version = `1.0.${versionCode}`;
    await pool.query("UPDATE release_catalog_epochs SET enabled=false");
    await pool.query("DELETE FROM release_catalog_channels");
    await pool.query(
      "INSERT INTO release_catalog_epochs(id,product,channel,enabled) VALUES($1,'handheld','stable',true)",
      [randomUUID()],
    );
    const dir = join(root, randomUUID());
    await mkdir(dir, { mode: 0o700 });
    const cacheDir = join(dir, "cache"),
      journalDir = join(dir, "journal");
    await mkdir(cacheDir, { mode: 0o700 });
    await mkdir(journalDir, { mode: 0o700 });
    const versions = new Map<string, Buffer>();
    let uploads = 0,
      allowed = true,
      failAudit = false,
      failConfirmation = false,
      offset = 0,
      revokeDuringRead = false;
    const now = () => Date.now() + offset;
    const store: CatalogStore = {
      readVersion: async (t) => {
        if (revokeDuringRead && t.key.startsWith("handheld/")) allowed = false;
        const b = versions.get(`${t.key}#${t.versionId}`);
        if (!b) throw new CatalogFault("unavailable");
        return Readable.from([b]);
      },
      writeReceipt: async (id, bytes) => {
        if (failConfirmation && JSON.parse(bytes.toString()).kind === "confirmation")
          throw new Error("lost confirmation");
        uploads++;
        const key = `_publication-ledger/${id}.json`,
          versionId = randomUUID();
        versions.set(`${key}#${versionId}`, bytes);
        return { key, versionId };
      },
      listReceiptVersions: async () => ({
        versions: [...versions.keys()]
          .filter((k) => k.startsWith("_publication-ledger/"))
          .map((k) => {
            const [key, versionId] = k.split("#");
            if (!key || !versionId) throw new Error();
            return { key, versionId, deleted: false };
          }),
        nextCursor: undefined,
      }),
    };
    const audit = new PlatformAuditService();
    const repo = new CatalogRepository(
      db,
      {
        record: async (tx, e) => {
          if (failAudit) throw new Error("audit failed");
          await audit.record(tx, e);
        },
      },
      now,
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
      store,
    );
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
      store,
    );
    const service = new CatalogService({
      repository: repo,
      ledger,
      cache,
      now,
      bucket: "markiro-releases",
      authorize: async () => {
        if (!allowed) throw new CatalogFault("forbidden");
      },
    });
    const caller: CatalogCaller = {
      principal: {
        fingerprint: hash(Buffer.from(dir)),
        tokenHash: hash(Buffer.from(`token:${dir}`)),
      },
      product: "handheld",
      machine: true,
      expiresAt: Date.now() + 3600000,
      actor: { actorPlatformUserId: null, actorRole: null, requestId: null },
    };
    const apk = Buffer.from(`APK-${version}`);
    const manifest = Buffer.from(
      JSON.stringify({
        versionName: version,
        versionCode,
        sha256: hash(apk),
        bytes: apk.length,
        url: `https://releases.markiro.app/handheld/stable/releases/${version}/markiro-tsd-${version}.apk`,
        notes: "Release",
        releasedAt: "2026-10-24T12:00:00Z",
        sourceSha: "a".repeat(40),
      }),
    );
    const bytes = new Map([
      ["manifest.json", manifest],
      [`markiro-tsd-${version}.apk`, apk],
    ]);
    const request = {
      identity: { product: "handheld", channel: "stable", version },
      sourceSha: "a".repeat(40),
      files: [...bytes].map(([name, b]) => ({
        name,
        sha256: hash(b),
        sizeBytes: b.length,
        contentType: name.endsWith("json")
          ? "application/json"
          : "application/vnd.android.package-archive",
      })),
      evidence: { kind: "handheld", manifestName: "manifest.json", versionCode },
    };
    const intent = await service.createIntent(caller, randomUUID(), request);
    const files = [...bytes].map(([name, b]) => {
      const versionId = randomUUID();
      versions.set(`handheld/_uploads/${intent.id}/${name}#${versionId}`, b);
      return { name, versionId };
    });
    return {
      service,
      repo,
      ledger,
      caller,
      intent,
      files,
      versions,
      bytes,
      request,
      uploads: () => uploads,
      expire: () => {
        offset = 16 * 60000;
      },
      revokeDuringRead: () => {
        revokeDuringRead = true;
      },
      deny: () => {
        allowed = false;
      },
      auditFailure: (v: boolean) => {
        failAudit = v;
      },
      confirmationFailure: (v: boolean) => {
        failConfirmation = v;
      },
    };
  }
  it("registers the complete set, retries reordered/new physical versions without rebinding", async () => {
    const f = await setup();
    const first = await f.service.commitIntent(f.caller, f.intent.id, { files: f.files });
    const retry = await f.service.commitIntent(f.caller, f.intent.id, {
      files: [...f.files].reverse().map((v) => ({ ...v, versionId: "new-unused-version" })),
    });
    expect(retry.publicationId).toBe(first.publicationId);
    expect(retry.files).toEqual(first.files);
    expect(first.files.map((v) => v.versionId).sort()).toEqual(
      f.files.map((v) => v.versionId).sort(),
    );
    expect(await f.repo.readChannel({ product: "handheld", channel: "stable" })).toMatchObject({
      revision: "0",
      readable: false,
    });
  });
  it("refuses incomplete set, different bytes and foreign ownership without publication", async () => {
    const f = await setup();
    await expect(
      f.service.commitIntent(f.caller, f.intent.id, { files: f.files.slice(1) }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.service.commitIntent(
        { ...f.caller, principal: { fingerprint: "b".repeat(64) } },
        f.intent.id,
        { files: f.files },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const one = f.files[0];
    if (!one) throw new Error();
    f.versions.set(
      `handheld/_uploads/${f.intent.id}/${one.name}#${one.versionId}`,
      Buffer.from("corrupt"),
    );
    await expect(
      f.service.commitIntent(f.caller, f.intent.id, { files: f.files }),
    ).rejects.toBeInstanceOf(Error);
    expect(f.uploads()).toBe(0);
  });
  it("refuses expired intent and revoked authorization", async () => {
    const f = await setup();
    f.deny();
    await expect(
      f.service.commitIntent(f.caller, f.intent.id, { files: f.files }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const g = await setup();
    g.expire();
    await expect(
      g.service.commitIntent(g.caller, g.intent.id, { files: g.files }),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(g.uploads()).toBe(0);
  });
  it("preserves prepared versions after audit rollback and resumes without overwrite", async () => {
    const f = await setup();
    f.auditFailure(true);
    await expect(f.service.commitIntent(f.caller, f.intent.id, { files: f.files })).rejects.toThrow(
      "audit failed",
    );
    expect(
      (
        await pool.query("SELECT id FROM release_catalog_publications WHERE intent_id=$1", [
          f.intent.id,
        ])
      ).rowCount,
    ).toBe(0);
    f.auditFailure(false);
    const result = await f.service.commitIntent(f.caller, f.intent.id, {
      files: f.files.map((v) => ({ ...v, versionId: "other-version" })),
    });
    expect(result.files.map((v) => v.versionId).sort()).toEqual(
      f.files.map((v) => v.versionId).sort(),
    );
  });
  it("reconciles committed DB after failed confirmation without a second publication", async () => {
    const f = await setup();
    f.confirmationFailure(true);
    await expect(
      f.service.commitIntent(f.caller, f.intent.id, { files: f.files }),
    ).rejects.toBeInstanceOf(Error);
    const before = await pool.query(
      "SELECT id FROM release_catalog_publications WHERE intent_id=$1",
      [f.intent.id],
    );
    expect(before.rowCount).toBe(1);
    f.confirmationFailure(false);
    const retry = await f.service.commitIntent(f.caller, f.intent.id, { files: f.files });
    expect(retry.publicationId).toBe(before.rows[0].id);
  });
  it("channel CAS has one winner, exact operation retry and no supplied pointer", async () => {
    const f = await setup();
    expect(await f.repo.readSnapshot("/handheld/download")).toBeNull();
    const pub = await f.service.commitIntent(f.caller, f.intent.id, { files: f.files });
    const scope = { product: "handheld", channel: "stable" };
    const change = {
      operationId: randomUUID(),
      expectedRevision: "0",
      targetPublicationId: pub.publicationId,
      kind: "forward",
    };
    const results = await Promise.allSettled([
      f.service.changeChannel(f.caller, scope, change),
      f.service.changeChannel(f.caller, scope, { ...change, operationId: randomUUID() }),
    ]);
    expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(await f.repo.readChannel(scope)).toMatchObject({
      revision: "1",
      publicationId: pub.publicationId,
      readable: true,
    });
    const winner = results[0]?.status === "fulfilled" ? change : null;
    if (winner)
      expect(await f.service.changeChannel(f.caller, scope, winner)).toMatchObject({
        revision: "1",
      });
    await expect(
      f.service.changeChannel(f.caller, scope, {
        ...change,
        pointer: { url: "https://evil.invalid" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const file = pub.files.find((v) => v.name.endsWith(".apk"));
    if (!file) throw new Error();
    expect(await f.repo.readSnapshot(file.publicPath)).toMatchObject({
      kind: "object",
      mutable: false,
      object: { versionId: file.versionId },
    });
    const pointer = await f.repo.readSnapshot("/handheld/stable/latest.json");
    expect(pointer?.kind).toBe("pointer");
    if (pointer?.kind !== "pointer") throw new Error();
    expect(JSON.parse(pointer.bytes.toString()).versionName).toBe(f.request.identity.version);
    expect(hash(pointer.bytes)).toBe(pointer.sha256);
    const event = await pool.query(
      "SELECT id FROM release_catalog_channel_events WHERE product='handheld' AND channel='stable' AND revision=1",
    );
    const prepared = await f.ledger.load(event.rows[0].id);
    if (prepared.kind !== "channel") throw new Error();
    expect(pointer.bytes.toString("base64")).toBe(prepared.pointer.base64);
    expect(pointer.sha256).toBe(prepared.pointer.sha256);
    expect(await f.repo.readSnapshot("/handheld/download")).toMatchObject({
      kind: "object",
      mutable: true,
      object: { publicPath: file.publicPath, versionId: file.versionId },
    });
    await pool.query(
      "UPDATE release_catalog_channels SET readable=false WHERE product='handheld' AND channel='stable'",
    );
    await expect(f.repo.readSnapshot("/handheld/download")).rejects.toMatchObject({
      code: "not_ready",
    });
    await expect(f.repo.readSnapshot("/handheld/stable/latest.json")).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(await f.repo.readSnapshot("/handheld/_uploads/secret")).toBeNull();
  });
  it("rechecks authorization after full file verification and before DB visibility", async () => {
    const f = await setup();
    f.revokeDuringRead();
    await expect(
      f.service.commitIntent(f.caller, f.intent.id, { files: f.files }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (
        await pool.query("SELECT id FROM release_catalog_publications WHERE intent_id=$1", [
          f.intent.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it("reloads actual platform status, capability and verified MFA", async () => {
    const id = randomUUID();
    await db.insert(schema.platformUsers).values({
      id,
      name: "Catalog test",
      email: `${id}@example.invalid`,
      role: "platform_admin",
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
    const caller: CatalogCaller = {
      principal: { fingerprint: platformCatalogFingerprint(id) },
      product: "standalone",
      machine: false,
      expiresAt: Date.now() + 60000,
      actor: { actorPlatformUserId: id, actorRole: "platform_admin", requestId: null },
    };
    await expect(recheckCatalogCaller(db, caller)).resolves.toBeUndefined();
    await pool.query("UPDATE platform_users SET status='suspended' WHERE id=$1", [id]);
    await expect(recheckCatalogCaller(db, caller)).rejects.toMatchObject({ code: "forbidden" });
    await pool.query("UPDATE platform_users SET status='active', role='accountant' WHERE id=$1", [
      id,
    ]);
    await expect(
      recheckCatalogCaller(db, { ...caller, actor: { ...caller.actor, actorRole: "accountant" } }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await pool.query("UPDATE platform_users SET role='platform_admin' WHERE id=$1", [id]);
    await pool.query("UPDATE platform_two_factors SET verified=false WHERE user_id=$1", [id]);
    await expect(recheckCatalogCaller(db, caller)).rejects.toMatchObject({ code: "forbidden" });
  });
});
