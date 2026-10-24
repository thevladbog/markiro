import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createDb } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogRepository } from "../src/modules/release-catalog/catalog-repository";
import {
  canonicalPublicationDigest,
  derivePublicPath,
  deriveUploadKey,
} from "../src/modules/release-catalog/catalog-policy";
import { scanRecovery } from "../src/modules/release-catalog/catalog-recovery";
import { reconcileRecovery } from "../src/modules/release-catalog/catalog-recovery-apply";
import {
  applyCatalogRecovery,
  recoveryEvidenceDigest,
  recoveryPlanDigest,
} from "../src/modules/release-catalog/catalog-operator";
import { receiptBytes, digest } from "../src/modules/release-catalog/catalog-receipts";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { fakeLedgerStore } from "./support/catalog-ledger";
const run = promisify(execFile),
  url = process.env.CATALOG_TEST_DATABASE_URL;
describe.skipIf(!url)("catalog stale snapshot recovery", () => {
  const name = `catalog_restore_${randomUUID().replaceAll("-", "_")}`,
    restored = `${name}_old`,
    container = "markiro-release-catalog-test-20261024";
  const admin = createDb(url ?? "postgres://invalid").pool;
  const target = new URL(url ?? "postgres://invalid");
  target.pathname = `/${name}`;
  const source = createDb(target.href);
  target.pathname = `/${restored}`;
  const old = createDb(target.href);
  const principal = { fingerprint: "a".repeat(64) },
    actor = { actorPlatformUserId: null, actorRole: null, requestId: null };
  const audit = new PlatformAuditService(),
    repo = new CatalogRepository(source.db, audit),
    recovered = new CatalogRepository(old.db, audit);
  const epoch = randomUUID();
  const runtimeRole = `rc_restore_reader_${randomUUID().replaceAll("-", "_")}`;
  let roleCreated = false;
  let sourceCreated = false,
    oldCreated = false;
  beforeAll(async () => {
    if (!url || new URL(url).hostname !== "127.0.0.1" || new URL(url).port !== "33791")
      throw new Error("isolated database required");
    const result = await run("docker", [
      "inspect",
      "--format",
      '{{ index .Config.Labels "markiro.task" }}',
      container,
    ]);
    expect(result.stdout.trim()).toBe("immutable-release-catalog-20261024");
    await admin.query(`CREATE ROLE "${runtimeRole}" NOLOGIN`);
    roleCreated = true;
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE catalog_test`);
    sourceCreated = true;
    await source.pool.query(
      "INSERT INTO release_catalog_epochs(id,product,channel,enabled) VALUES($1,'standalone','stable',true)",
      [epoch],
    );
  }, 30000);
  afterAll(async () => {
    await source.pool.end();
    await old.pool.end();
    if (sourceCreated) await admin.query(`DROP DATABASE "${name}"`);
    if (oldCreated) await admin.query(`DROP DATABASE "${restored}"`);
    if (roleCreated) await admin.query(`DROP ROLE "${runtimeRole}"`);
    await admin.end();
  });
  it("restores actual older dump, fences old writers and reserves newer prepared names without inferring channel COMMIT", async () => {
    const request = {
      identity: { product: "standalone" as const, channel: "stable" as const, version: "1.0.0" },
      sourceSha: "b".repeat(40),
      files: [
        {
          name: "manifest.jws",
          sha256: "c".repeat(64),
          sizeBytes: 20,
          contentType: "application/octet-stream" as const,
        },
      ],
      evidence: { kind: "standalone" as const, manifestName: "manifest.jws" },
    };
    const oldRequest = { ...request, identity: { ...request.identity, version: "0.9.0" } };
    const oldIntent = await repo.reserveIntent(principal, randomUUID(), oldRequest);
    await source.pool.query(
      `GRANT USAGE ON SCHEMA public TO "${runtimeRole}"; GRANT SELECT,INSERT ON release_catalog_receipts,release_catalog_reservations TO "${runtimeRole}"`,
    );
    const dump = await run(
      "docker",
      ["exec", container, "pg_dump", "-U", "postgres", "--format=custom", name],
      { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
    );
    expect(dump.stdout.subarray(0, 5).toString()).toBe("PGDMP");
    const intent = await repo.reserveIntent(principal, randomUUID(), request),
      id = randomUUID(),
      spec = request.files[0];
    if (!spec) throw new Error("fixture");
    const objects = [
      {
        ...spec,
        publicPath: derivePublicPath(request.identity, spec.name),
        bucket: "markiro-releases",
        key: deriveUploadKey("standalone", intent.id, spec.name),
        versionId: "pinned-original",
      },
    ].map(({ name: _name, ...file }) => file);
    const operation = {
      schema: 1 as const,
      id,
      kind: "publication" as const,
      epoch,
      identity: request.identity,
      requestDigest: canonicalPublicationDigest(request),
      sourceSha: request.sourceSha,
      files: objects,
    };
    const f = fakeLedgerStore();
    const bytes = receiptBytes(operation),
      stored = await f.store.writeReceipt(id, bytes),
      proof = {
        operationId: id,
        sha256: digest(bytes),
        ledgerKey: stored.key,
        ledgerVersionId: stored.versionId,
      };
    const committed = await repo.commitPublication(
      principal,
      intent.id,
      epoch,
      { metadata: { verified: true }, objects },
      proof,
      actor,
    );
    const confirmation = {
      schema: 1,
      id: randomUUID(),
      kind: "confirmation",
      preparedId: id,
      preparedSha256: proof.sha256,
      result: { kind: "publication", publicationId: committed.publication.id },
    };
    const pointer = Buffer.from('{"version":"1.0.0"}');
    const channel = {
      schema: 1,
      id: randomUUID(),
      kind: "channel",
      epoch,
      identity: { product: "standalone", channel: "stable" },
      expectedRevision: "0",
      revision: "1",
      previousPublicationId: null,
      publicationId: committed.publication.id,
      transition: "forward",
      pointer: {
        base64: pointer.toString("base64"),
        sha256: digest(pointer),
        sizeBytes: pointer.length,
        contentType: "application/json",
      },
    };
    const inventory = [{ id, sha256: proof.sha256 }];
    for (const op of [confirmation, channel]) {
      const b = receiptBytes(op);
      await f.store.writeReceipt(op.id, b);
      inventory.push({ id: op.id, sha256: digest(b) });
    }
    const channelBytes = receiptBytes(channel),
      channelStored = [...f.versions.values()].find(
        (v) => v.key === `_publication-ledger/${channel.id}.json`,
      );
    if (!channelStored) throw new Error("fixture");
    await repo.commitChannelChange(
      {
        identity: channel.identity,
        epoch,
        operationId: channel.id,
        expectedRevision: "0",
        targetPublicationId: committed.publication.id,
        kind: "forward",
        pointer: { version: "1.0.0" },
      },
      {
        operationId: channel.id,
        sha256: digest(channelBytes),
        ledgerKey: channelStored.key,
        ledgerVersionId: channelStored.versionId,
      },
      actor,
    );
    await admin.query(`CREATE DATABASE "${restored}"`);
    oldCreated = true;
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "docker",
        [
          "exec",
          "-i",
          container,
          "pg_restore",
          "-U",
          "postgres",
          "--exit-on-error",
          "--dbname",
          restored,
        ],
        { maxBuffer: 1024 * 1024 },
        (error) => (error ? reject(new Error("isolated restore failed")) : resolve()),
      );
      child.stdin?.end(dump.stdout);
    });
    expect(
      (await old.pool.query("SELECT count(*)::int n FROM release_catalog_publications")).rows,
    ).toEqual([{ n: 0 }]);
    const acl = await old.pool.query(
      "SELECT has_table_privilege($1,'release_catalog_receipts','SELECT') AS read,has_table_privilege($1,'release_catalog_receipts','INSERT') AS insert,has_table_privilege($1,'release_catalog_receipts','UPDATE') AS update,has_table_privilege($1,'release_catalog_receipts','DELETE') AS delete,has_table_privilege($1,'release_catalog_receipts','TRUNCATE') AS truncate",
      [runtimeRole],
    );
    expect(acl.rows).toEqual([
      { read: true, insert: true, update: false, delete: false, truncate: false },
    ]);
    const restricted = await old.pool.connect();
    try {
      await restricted.query(`SET ROLE "${runtimeRole}"`);
      for (const query of [
        "UPDATE release_catalog_receipts SET sha256=sha256",
        "DELETE FROM release_catalog_receipts",
        "TRUNCATE release_catalog_receipts",
      ]) {
        await expect(restricted.query(query)).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await restricted.query("RESET ROLE");
      restricted.release();
    }
    const plan = await scanRecovery(f.store, {
      bucket: "markiro-releases",
      writersFenced: true,
      independentInventoryComplete: true,
      independentInventory: inventory,
      technicalKeys: [],
      maxPages: 10,
      maxRecords: 100,
      maxBytes: 1024 * 1024,
      timeoutMs: 1000,
    });
    expect(plan.channels).toMatchObject([{ readable: false, reason: "unconfirmed_channel" }]);
    const evidence = {
      schema: 1,
      bucket: "markiro-releases",
      independentInventoryComplete: true,
      independentReceipts: inventory.map((r) => {
        const stored = [...f.versions.values()].find(
          (v) => v.key === `_publication-ledger/${r.id}.json`,
        );
        if (!stored) throw new Error("fixture");
        return { ...r, base64: stored.bytes.toString("base64") };
      }),
      technicalKeys: [],
      limits: { maxPages: 10, maxRecords: 100, maxBytes: 1048576, timeoutMs: 1000 },
    };
    const now = Date.now();
    const admission = {
      schema: 1,
      action: "recover",
      operationId: randomUUID(),
      executorSha: "b".repeat(40),
      runId: "123",
      runAttempt: "1",
      epoch,
      evidenceSha256: recoveryEvidenceDigest(evidence),
      expiresAt: new Date(now + 60000).toISOString(),
      reviewedPlanSha256: "0".repeat(64),
    };
    const operator = {
      db: old.db,
      audit,
      actor,
      admission,
      now: () => now,
      authorize: async () => {},
      assertFenced: async () => {},
    };
    await expect(applyCatalogRecovery(evidence, f.store, operator)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(
      (await old.pool.query("SELECT count(*)::int n FROM release_catalog_epochs WHERE enabled"))
        .rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (await old.pool.query("SELECT count(*)::int n FROM release_catalog_reservations")).rows,
    ).toEqual([{ n: 0 }]);
    operator.admission.reviewedPlanSha256 = recoveryPlanDigest(plan);
    expect(await applyCatalogRecovery(evidence, f.store, operator)).toMatchObject({
      writersMayEnable: false,
    });
    await applyCatalogRecovery(evidence, f.store, operator);
    expect(
      (await old.pool.query("SELECT count(*)::int n FROM release_catalog_reservations")).rows,
    ).toEqual([{ n: 2 }]);
    await expect(
      recovered.commitPublication(
        principal,
        oldIntent.id,
        epoch,
        {
          metadata: { verified: true },
          objects: objects.map((file) => ({
            ...file,
            publicPath: derivePublicPath(oldRequest.identity, spec.name),
            key: deriveUploadKey("standalone", oldIntent.id, spec.name),
          })),
        },
        proof,
        actor,
      ),
    ).rejects.toMatchObject({ code: "not_ready" });
    await expect(
      recovered.reserveIntent(principal, randomUUID(), {
        ...request,
        identity: { ...request.identity, version: "1.0.1" },
      }),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(await recovered.readChannel({ product: "standalone", channel: "stable" })).toMatchObject(
      { readable: false, revision: "0" },
    );
    // Only this isolated test's privileged operator enables a fresh epoch to exercise permanent reservations.
    await old.pool.query(
      "INSERT INTO release_catalog_epochs(id,product,channel,enabled) VALUES($1,'standalone','stable',true)",
      [randomUUID()],
    );
    await expect(
      recovered.reserveIntent(principal, randomUUID(), { ...request, sourceSha: "d".repeat(40) }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await recovered.readPath(objects[0]?.publicPath ?? "")).toBeNull();
    await expect(
      reconcileRecovery(old.db, { ...plan, receipts: [] }, audit, actor),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(
      (await old.pool.query("SELECT count(*)::int n FROM release_catalog_epochs WHERE enabled"))
        .rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (await old.pool.query("SELECT count(*)::int n FROM release_catalog_reservations")).rows,
    ).toEqual([{ n: 2 }]);
  }, 30000);
});
