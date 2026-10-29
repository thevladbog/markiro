import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CatalogReadBootstrapOperator,
  bootstrapEvidenceDigest,
} from "../src/modules/release-catalog/catalog-bootstrap";
import { CatalogRepository } from "../src/modules/release-catalog/catalog-repository";
import { CatalogLedger } from "../src/modules/release-catalog/catalog-ledger";
import { VerifiedCache } from "../src/modules/release-catalog/catalog-cache";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { fakeLedgerStore, digest } from "./support/catalog-ledger";

const url = process.env.CATALOG_TEST_DATABASE_URL;
describe.skipIf(!url)("protected initial read channel with real PostgreSQL", () => {
  const name = `catalog_bootstrap_${randomUUID().replaceAll("-", "_")}`;
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
    root = await realpath(await mkdtemp(join(tmpdir(), "catalog-bootstrap-")));
  }, 30000);
  afterAll(async () => {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    if (root) await rm(root, { recursive: true });
  });
  async function fixture() {
    const operationId = randomUUID();
    const versionCode = serial++;
    const version = `1.0.${versionCode}`;
    const directory = join(root, operationId);
    await mkdir(directory, { mode: 0o700 });
    const journalDir = join(directory, "journal"),
      cacheDir = join(directory, "cache");
    await mkdir(journalDir, { mode: 0o700 });
    await mkdir(cacheDir, { mode: 0o700 });
    const { store, versions, puts } = fakeLedgerStore();
    let lostConfirmation = false;
    const writeReceipt = store.writeReceipt,
      listReceiptVersions = store.listReceiptVersions;
    store.writeReceipt = async (id, bytes) => {
      const result = await writeReceipt(id, bytes);
      const value = JSON.parse(bytes.toString()) as { kind: string; preparedId?: string };
      if (lostConfirmation && value.kind === "confirmation" && value.preparedId === operationId)
        throw Error("lost storage reply");
      return result;
    };
    store.listReceiptVersions = async (...args) => {
      if (lostConfirmation) throw Error("storage temporarily unavailable");
      const result = await listReceiptVersions(...args);
      return {
        ...result,
        versions: result.versions.filter((v) => v.key.startsWith("_publication-ledger/")),
      };
    };
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
    const apk = Buffer.from(`APK-${version}`);
    const bodies = new Map([
      [`markiro-tsd-${version}.apk`, apk],
      [
        "manifest.json",
        Buffer.from(
          JSON.stringify({
            versionName: version,
            versionCode,
            sha256: digest(apk),
            bytes: apk.length,
            url: `https://releases.markiro.app/handheld/stable/releases/${version}/markiro-tsd-${version}.apk`,
            notes: "Historical",
            releasedAt: "2026-10-20T00:00:00Z",
            sourceSha: "a".repeat(40),
          }),
        ),
      ],
    ]);
    const files = [...bodies].map(([name, bytes]) => ({
      name,
      sha256: digest(bytes),
      sizeBytes: bytes.length,
      contentType: name.endsWith(".apk")
        ? "application/vnd.android.package-archive"
        : "application/json",
    }));
    const objects = files.map((file) => ({
      ...file,
      key: `handheld/_history/${operationId}/${file.name}`,
      versionId: "original",
    }));
    for (const object of objects) {
      const bytes = bodies.get(object.name);
      if (!bytes) throw Error();
      versions.set(`${object.key}:original`, {
        key: object.key,
        versionId: "original",
        bytes,
        deleted: false,
      });
    }
    const evidence = {
      schema: 1,
      scope: { product: "handheld", channel: "stable" },
      anchors: [{ kind: "preserved-backup", sha256: "b".repeat(64) }],
      coverage: { kind: "upper-bound", evidenceSha256: "b".repeat(64), upperBound: version },
      releases: [
        {
          version,
          names: files.map((file) => file.name),
          evidenceSha256: "b".repeat(64),
          publication: {
            identity: { product: "handheld", channel: "stable", version },
            sourceSha: "a".repeat(40),
            files,
            evidence: { kind: "handheld", manifestName: "manifest.json", versionCode },
          },
          objects,
        },
      ],
    };
    const input = { schema: 1, operationId, targetVersion: version, evidence };
    let authorized = true,
      fenced = true,
      failChannelAudit = false,
      guards = 0;
    const bindings: unknown[] = [];
    let afterFence: (() => void) | undefined;
    const audit = new PlatformAuditService();
    const operator = new CatalogReadBootstrapOperator({
      db,
      ledger,
      cache,
      bucket: "markiro-releases",
      audit: {
        record: async (tx, event) => {
          if (failChannelAudit && event.action === "release_catalog.channel.bootstrap")
            throw Error("audit failed");
          await audit.record(tx, event);
        },
      },
      authorize: async (binding) => {
        bindings.push(binding);
        if (!authorized) throw Error("authorization denied");
      },
      assertFenced: async () => {
        guards++;
        if (!fenced) throw Error("fence denied");
        afterFence?.();
      },
    });
    return {
      input,
      operator,
      versions,
      objects,
      puts,
      bodies,
      operationId,
      deny: () => {
        authorized = false;
      },
      unfence: () => {
        fenced = false;
      },
      loseConfirmation: (value: boolean) => {
        lostConfirmation = value;
      },
      failAudit: (value = true) => {
        failChannelAudit = value;
      },
      bindings,
      afterFence: (fn: () => void) => {
        afterFence = fn;
      },
      guards: () => guards,
    };
  }
  it("imports pinned bytes and initial pointer, leaves writers disabled, and retries without another event or binding", async () => {
    const f = await fixture();
    const original = f.objects[0];
    if (!original) throw Error();
    const stored = f.versions.get(`${original.key}:original`);
    if (!stored) throw Error();
    f.versions.set(`${original.key}:original`, { ...stored, bytes: Buffer.from("corrupt") });
    await expect(f.operator.apply(f.input)).rejects.toThrow();
    expect((await pool.query("SELECT * FROM release_catalog_channels")).rowCount).toBe(0);
    f.versions.set(`${original.key}:original`, stored);
    f.failAudit();
    await expect(f.operator.apply(f.input)).rejects.toThrow("audit failed");
    expect((await pool.query("SELECT * FROM release_catalog_channels")).rowCount).toBe(0);
    expect(
      (
        await pool.query("SELECT * FROM release_catalog_channel_events WHERE id=$1", [
          f.operationId,
        ])
      ).rowCount,
    ).toBe(0);
    f.failAudit(false);
    f.loseConfirmation(true);
    await expect(f.operator.apply(f.input)).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT revision FROM release_catalog_channels WHERE product='handheld' AND channel='stable'",
        )
      ).rows,
    ).toEqual([{ revision: "1" }]);
    const acknowledgedPuts = f.puts();
    f.loseConfirmation(false);
    const result = await f.operator.apply(f.input);
    expect(f.puts()).toBe(acknowledgedPuts);
    expect(f.bindings).toContainEqual({
      operationId: f.operationId,
      epoch: result.epoch,
      evidenceSha256: bootstrapEvidenceDigest(f.input),
      identity: { product: "handheld", channel: "stable" },
      targetVersion: f.input.targetVersion,
    });
    expect(result).toMatchObject({
      identity: { product: "handheld", channel: "stable" },
      revision: "1",
      readable: true,
      writersMayEnable: false,
    });
    const repo = new CatalogRepository(db, new PlatformAuditService());
    const pointer = await repo.readSnapshot("/handheld/stable/latest.json");
    expect(pointer?.kind).toBe("pointer");
    if (pointer?.kind !== "pointer") throw Error();
    expect(JSON.parse(pointer.bytes.toString()).versionName).toBe(f.input.targetVersion);
    // A mutable storage head is irrelevant: bindings retain the original exact VersionId.
    const first = f.objects[0];
    if (!first) throw Error();
    f.versions.set(`${first.key}:new-head`, {
      key: first.key,
      versionId: "new-head",
      bytes: Buffer.from("replacement"),
      deleted: false,
    });
    expect(
      (await repo.readPath(`/handheld/stable/releases/${f.input.targetVersion}/${first.name}`))
        ?.versionId,
    ).toBe("original");
    const count = f.puts();
    expect(await f.operator.apply(f.input)).toEqual(result);
    expect(f.puts()).toBe(count);
    expect(f.guards()).toBeGreaterThan(10);
    const rows = await pool.query("SELECT enabled FROM release_catalog_epochs");
    expect(rows.rows.every((row: { enabled: boolean }) => !row.enabled)).toBe(true);
    const events = await pool.query("SELECT * FROM release_catalog_channel_events WHERE id=$1", [
      f.operationId,
    ]);
    expect(events.rows).toHaveLength(1);
    expect(String(events.rows[0].expected_revision)).toBe("0");
    const audit = await pool.query(
      "SELECT action,actor_platform_user_id,actor_role,request_id,target_id,outcome FROM platform_audit_events WHERE action='release_catalog.channel.bootstrap' AND request_id=$1",
      [f.operationId],
    );
    expect(audit.rows).toEqual([
      {
        action: "release_catalog.channel.bootstrap",
        actor_platform_user_id: null,
        actor_role: null,
        request_id: f.operationId,
        target_id: "handheld/stable",
        outcome: "success",
      },
    ]);
    await expect(
      repo.activeEpoch({ product: "handheld", channel: "stable" }),
    ).rejects.toMatchObject({ code: "not_ready" });
    await expect(
      repo.commitChannelChange(
        {
          operationId: randomUUID(),
          expectedRevision: "1",
          targetPublicationId: result.publicationId,
          kind: "forward",
          identity: result.identity,
          epoch: result.epoch,
          pointer: {},
        },
        {
          operationId: randomUUID(),
          sha256: "b".repeat(64),
          ledgerKey: "invalid",
          ledgerVersionId: "original",
        },
        { actorPlatformUserId: null, actorRole: null, requestId: null },
      ),
    ).rejects.toMatchObject({ code: "not_ready" });
    await expect(f.operator.apply({ ...f.input, operationId: randomUUID() })).rejects.toThrow();
    await expect(f.operator.apply({ ...f.input, targetVersion: "9.9.9" })).rejects.toThrow();
  });
  it("authorization and physical fencing fail before any mutation", async () => {
    const f = await fixture();
    const before = await pool.query("SELECT count(*) FROM release_catalog_epochs");
    f.deny();
    await expect(f.operator.apply(f.input)).rejects.toThrow("authorization denied");
    const g = await fixture();
    g.unfence();
    await expect(g.operator.apply(g.input)).rejects.toThrow("fence denied");
    expect((await pool.query("SELECT count(*) FROM release_catalog_epochs")).rows).toEqual(
      before.rows,
    );
    expect(f.puts() + g.puts()).toBe(0);
  });
  it("refuses an enabled epoch before any receipt writes", async () => {
    const f = await fixture();
    await pool.query(
      "INSERT INTO release_catalog_epochs(id,product,channel,enabled) VALUES($1,'station','beta',true)",
      [randomUUID()],
    );
    try {
      await expect(f.operator.apply(f.input)).rejects.toMatchObject({ code: "not_ready" });
      expect(f.puts()).toBe(0);
    } finally {
      await pool.query("UPDATE release_catalog_epochs SET enabled=false WHERE product='station'");
    }
  });
});
