import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CatalogHistoryOperator,
  historyEvidenceDigest,
} from "../src/modules/release-catalog/catalog-history";
import { CatalogLedger } from "../src/modules/release-catalog/catalog-ledger";
import { VerifiedCache } from "../src/modules/release-catalog/catalog-cache";
import { CatalogRepository } from "../src/modules/release-catalog/catalog-repository";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { fakeLedgerStore, digest } from "./support/catalog-ledger";
const url = process.env.CATALOG_TEST_DATABASE_URL;
describe.skipIf(!url)("protected history operator with real PostgreSQL and durable ledger", () => {
  const name = `catalog_history_${randomUUID().replaceAll("-", "_")}`,
    admin = createDb(url ?? "postgres://invalid").pool,
    target = new URL(url ?? "postgres://invalid");
  target.pathname = `/${name}`;
  const { db, pool } = createDb(target.href),
    epoch = randomUUID();
  let root: string,
    created = false;
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
    root = await realpath(await mkdtemp(join(tmpdir(), "catalog-history-")));
    await pool.query(
      "INSERT INTO release_catalog_epochs(id,product,channel,enabled) VALUES($1,'handheld','stable',false)",
      [epoch],
    );
  }, 30000);
  afterAll(async () => {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    if (root) await rm(root, { recursive: true });
  });
  it("imports full verified bytes only with fenced writers, preserves original binding on retry and reserves missing history", async () => {
    const { store, versions, puts } = fakeLedgerStore(),
      journalDir = join(root, "journal"),
      cacheDir = join(root, "cache");
    await mkdir(journalDir, { mode: 0o700 });
    await mkdir(cacheDir, { mode: 0o700 });
    const ledger = new CatalogLedger(
      {
        journalDir,
        bucket: "markiro-releases",
        maxPages: 10,
        maxRecords: 100,
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
    const apk = Buffer.from("historical apk"),
      manifest = Buffer.from(
        JSON.stringify({
          versionName: "1.6.1",
          versionCode: 15,
          sha256: digest(apk),
          bytes: apk.length,
          url: "https://releases.markiro.app/handheld/stable/releases/1.6.1/markiro-tsd-1.6.1.apk",
          notes: "Historical",
          releasedAt: "2026-10-20T00:00:00Z",
          sourceSha: "a".repeat(40),
        }),
      );
    const bodies = [
      {
        name: "markiro-tsd-1.6.1.apk",
        body: apk,
        contentType: "application/vnd.android.package-archive",
      },
      { name: "manifest.json", body: manifest, contentType: "application/json" },
    ];
    const files = bodies.map(({ name, body, contentType }) => ({
      name,
      sha256: digest(body),
      sizeBytes: body.length,
      contentType,
    }));
    const objects = files.map((f) => ({
      ...f,
      key: `handheld/_history/fixture/${f.name}`,
      versionId: "original",
    }));
    for (const [i, o] of objects.entries()) {
      const body = bodies[i]?.body;
      if (!body) throw Error();
      versions.set(`${o.key}:${o.versionId}`, {
        key: o.key,
        versionId: o.versionId,
        bytes: body,
        deleted: false,
      });
    }
    const evidence = {
      schema: 1,
      scope: { product: "handheld", channel: "stable" },
      anchors: [{ kind: "preserved-backup", sha256: "b".repeat(64) }],
      coverage: { kind: "upper-bound", evidenceSha256: "b".repeat(64), upperBound: "1.6.1" },
      releases: [
        {
          version: "1.6.1",
          names: files.map((f) => f.name),
          evidenceSha256: "b".repeat(64),
          publication: {
            identity: { product: "handheld", channel: "stable", version: "1.6.1" },
            sourceSha: "a".repeat(40),
            files,
            evidence: { kind: "handheld", manifestName: "manifest.json", versionCode: 15 },
          },
          objects,
        },
        {
          version: "1.5.0",
          names: ["markiro-tsd-1.5.0.apk"],
          evidenceSha256: "b".repeat(64),
          publication: null,
          objects: [],
        },
      ],
    };
    const audit = new PlatformAuditService();
    let allowed = false,
      failAudit = false;
    const operator = new CatalogHistoryOperator({
      db,
      ledger,
      cache,
      bucket: "markiro-releases",
      audit: {
        record: async (tx, e) => {
          if (failAudit) throw Error("audit unavailable");
          await audit.record(tx, e);
        },
      },
      authorize: async () => {
        if (!allowed) throw Error("protected approval missing");
      },
      assertFenced: async () => {
        if (!allowed) throw Error("physical fence missing");
      },
    });
    const admission = {
      epoch,
      evidenceSha256: historyEvidenceDigest(evidence),
      actor: { actorPlatformUserId: null, actorRole: null, requestId: null },
    };
    await expect(operator.apply(evidence, admission)).rejects.toThrow();
    expect((await pool.query("SELECT * FROM release_catalog_receipts")).rowCount).toBe(0);
    allowed = true;
    failAudit = true;
    await expect(operator.apply(evidence, admission)).rejects.toThrow();
    expect((await pool.query("SELECT * FROM release_catalog_publications")).rowCount).toBe(0);
    failAudit = false;
    const result = await operator.apply(evidence, admission);
    expect(result.publications).toHaveLength(1);
    const putCount = puts();
    const again = await operator.apply(evidence, admission);
    expect(again).toEqual(result);
    expect(puts()).toBe(putCount);
    expect(
      (await pool.query("SELECT version_id FROM release_catalog_objects")).rows.every(
        (r) => r.version_id === "original",
      ),
    ).toBe(true);
    expect(
      (await pool.query("SELECT enabled FROM release_catalog_epochs")).rows.every(
        (r) => r.enabled === false,
      ),
    ).toBe(true);
    expect((await pool.query("SELECT * FROM release_catalog_channels")).rowCount).toBe(0);
    const repo = new CatalogRepository(db, audit);
    expect(
      await repo.readSnapshot("/handheld/stable/releases/1.5.0/markiro-tsd-1.5.0.apk"),
    ).toBeNull();
    expect(
      (await pool.query("SELECT * FROM release_catalog_reservations WHERE version='1.5.0'"))
        .rowCount,
    ).toBe(2);
    await expect(
      operator.apply(
        { ...evidence, coverage: { kind: "complete", evidenceSha256: "b".repeat(64) } },
        admission,
      ),
    ).rejects.toThrow();
    await pool.query("UPDATE release_catalog_epochs SET enabled=true WHERE id=$1", [epoch]);
    await expect(operator.apply(evidence, admission)).rejects.toThrow();
    const base = evidence.releases[0]?.publication;
    if (!base) throw Error();
    await expect(
      repo.reserveIntent({ fingerprint: "c".repeat(64) }, randomUUID(), {
        ...base,
        identity: { ...base.identity, version: "1.5.0" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      repo.reserveIntent({ fingerprint: "c".repeat(64) }, randomUUID(), {
        ...base,
        identity: { ...base.identity, version: "1.7.0" },
      }),
    ).resolves.toMatchObject({ version: "1.7.0" });
  });
});
