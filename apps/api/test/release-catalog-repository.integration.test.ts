import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogRepository } from "../src/modules/release-catalog/catalog-repository";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";

const url = process.env.CATALOG_TEST_DATABASE_URL;
describe.skipIf(!url)("catalog transactional repository", () => {
  const name = `catalog_repo_${randomUUID().replaceAll("-", "_")}`;
  const admin = createDb(url ?? "postgres://invalid").pool;
  const target = new URL(url ?? "postgres://invalid");
  target.pathname = `/${name}`;
  const { db, pool } = createDb(target.href);
  const repo = new CatalogRepository(db, new PlatformAuditService());
  const principal = { fingerprint: "a".repeat(64) };
  const actor = { actorPlatformUserId: null, actorRole: null, requestId: null };
  let created = false;
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
  }, 30000);
  afterAll(async () => {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  });
  let version = 100;
  async function setup() {
    const v = `1.0.${version++}`;
    await pool.query("UPDATE release_catalog_epochs SET enabled=false");
    const epoch = randomUUID();
    await pool.query(
      "INSERT INTO release_catalog_epochs(id,product,channel,enabled) VALUES($1,'standalone','stable',true)",
      [epoch],
    );
    const request = {
      identity: { product: "standalone", channel: "stable", version: v },
      sourceSha: "b".repeat(40),
      files: [
        {
          name: "manifest.jws",
          sha256: "c".repeat(64),
          sizeBytes: 20,
          contentType: "application/octet-stream",
        },
      ],
      evidence: { kind: "standalone", manifestName: "manifest.jws" },
    };
    return { epoch, request };
  }
  function receipt() {
    const id = randomUUID();
    return {
      operationId: id,
      sha256: "d".repeat(64),
      ledgerKey: `_publication-ledger/${id}.json`,
      ledgerVersionId: "receipt-version",
    };
  }
  function input(id: string, v: string, physical = "object-version") {
    return {
      metadata: { verified: true },
      objects: [
        {
          publicPath: `/standalone/stable/${v}/manifest.jws`,
          bucket: "markiro-releases",
          key: `standalone/_uploads/${id}/manifest.jws`,
          versionId: physical,
          sha256: "c".repeat(64),
          sizeBytes: 20,
          contentType: "application/octet-stream" as const,
        },
      ],
    };
  }
  it("serializes two competing byte sets into one reserved identity", async () => {
    const f = await setup();
    const results = await Promise.allSettled([
      repo.reserveIntent(principal, randomUUID(), f.request),
      repo.reserveIntent(principal, randomUUID(), {
        ...f.request,
        files: [{ ...f.request.files[0], sha256: "e".repeat(64) }],
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "conflict" }) }),
    ]);
  });
  it("returns one intent for exact idempotent retries and rejects changed input", async () => {
    const f = await setup(),
      key = randomUUID();
    const a = await repo.reserveIntent(principal, key, f.request);
    const b = await repo.reserveIntent(principal, key, f.request);
    expect(b.id).toBe(a.id);
    await expect(
      repo.reserveIntent(principal, key, { ...f.request, sourceSha: "e".repeat(40) }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(repo.getIntent({ fingerprint: "f".repeat(64) }, a.id)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("commits a complete binding plus audit once, and resolves a lost reply without rebinding", async () => {
    const f = await setup();
    const intent = await repo.reserveIntent(principal, randomUUID(), f.request);
    const proof = receipt();
    const first = await repo.commitPublication(
      principal,
      intent.id,
      f.epoch,
      input(intent.id, f.request.identity.version),
      proof,
      actor,
    );
    // The caller loses this response; repeat with a new physical version of the SAME bytes.
    const retry = await repo.commitPublication(
      principal,
      intent.id,
      f.epoch,
      input(intent.id, f.request.identity.version, "later-version"),
      receipt(),
      actor,
    );
    expect(first.outcome).toBe("registered");
    expect(retry.outcome).toBe("unchanged");
    expect(retry.publication.id).toBe(first.publication.id);
    expect(
      (await repo.readPath(`/standalone/stable/${f.request.identity.version}/manifest.jws`))
        ?.versionId,
    ).toBe("object-version");
    const audit = await pool.query(
      "SELECT action,outcome,target_type,target_id,actor_platform_user_id,tenant_id FROM platform_audit_events WHERE target_id=$1",
      [first.publication.id],
    );
    expect(audit.rows).toEqual([
      {
        action: "release_catalog.publication.register",
        outcome: "success",
        target_type: "release_catalog_publication",
        target_id: first.publication.id,
        actor_platform_user_id: null,
        tenant_id: null,
      },
    ]);
    expect(
      (
        await pool.query("SELECT count(*)::int AS n FROM release_catalog_receipts WHERE id=$1", [
          proof.operationId,
        ])
      ).rows,
    ).toEqual([{ n: 1 }]);
  });
  it("rolls back all visibility and receipts if the audit write fails", async () => {
    const f = await setup();
    const intent = await repo.reserveIntent(principal, randomUUID(), f.request);
    const proof = receipt();
    const failing = new CatalogRepository(db, {
      async record() {
        throw new Error("audit unavailable");
      },
    });
    await expect(
      failing.commitPublication(
        principal,
        intent.id,
        f.epoch,
        input(intent.id, f.request.identity.version),
        proof,
        actor,
      ),
    ).rejects.toThrow("audit unavailable");
    expect(
      await repo.readPath(`/standalone/stable/${f.request.identity.version}/manifest.jws`),
    ).toBeNull();
    expect(
      (
        await pool.query("SELECT 1 FROM release_catalog_publications WHERE intent_id=$1", [
          intent.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await pool.query("SELECT 1 FROM release_catalog_receipts WHERE id=$1", [proof.operationId]))
        .rowCount,
    ).toBe(0);
  });
  it("refuses incomplete files, changed bytes, arbitrary keys and a fenced executor", async () => {
    const f = await setup();
    const intent = await repo.reserveIntent(principal, randomUUID(), f.request);
    const good = input(intent.id, f.request.identity.version);
    const object = good.objects[0];
    if (!object) throw new Error("fixture absent");
    for (const bad of [
      { ...good, objects: [] },
      { ...good, objects: [{ ...object, sha256: "e".repeat(64) }] },
      { ...good, objects: [{ ...object, key: "standalone/foreign" }] },
    ])
      await expect(
        repo.commitPublication(principal, intent.id, f.epoch, bad, receipt(), actor),
      ).rejects.toMatchObject({ code: "conflict" });
    await pool.query("UPDATE release_catalog_epochs SET enabled=false WHERE id=$1", [f.epoch]);
    await expect(
      repo.commitPublication(principal, intent.id, f.epoch, good, receipt(), actor),
    ).rejects.toMatchObject({ code: "not_ready" });
  });
  it("rejects a foreign committer and expired uncommitted intent", async () => {
    const f = await setup();
    const intent = await repo.reserveIntent(principal, randomUUID(), f.request);
    await expect(
      repo.commitPublication(
        { fingerprint: "f".repeat(64) },
        intent.id,
        f.epoch,
        input(intent.id, f.request.identity.version),
        receipt(),
        actor,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      repo.commitPublication(
        principal,
        intent.id,
        randomUUID(),
        input(intent.id, f.request.identity.version),
        receipt(),
        actor,
      ),
    ).rejects.toMatchObject({ code: "not_ready" });
    const expired = new CatalogRepository(
      db,
      new PlatformAuditService(),
      () => Date.now() + 16 * 60 * 1000,
    );
    await expect(
      expired.commitPublication(
        principal,
        intent.id,
        f.epoch,
        input(intent.id, f.request.identity.version),
        receipt(),
        actor,
      ),
    ).rejects.toMatchObject({ code: "not_ready" });
  });
  it("serializes channel CAS, retains lost-response idempotency and rolls audit failure back", async () => {
    const a = await setup();
    const ai = await repo.reserveIntent(principal, randomUUID(), a.request);
    const ap = await repo.commitPublication(
      principal,
      ai.id,
      a.epoch,
      input(ai.id, a.request.identity.version),
      receipt(),
      actor,
    );
    const bRequest = {
      ...a.request,
      identity: { ...a.request.identity, version: `1.0.${version++}` },
    };
    const bi = await repo.reserveIntent(principal, randomUUID(), bRequest);
    const bp = await repo.commitPublication(
      principal,
      bi.id,
      a.epoch,
      input(bi.id, bRequest.identity.version),
      receipt(),
      actor,
    );
    const scope = { product: "standalone", channel: "stable" };
    expect(await repo.readChannel(scope)).toMatchObject({
      revision: "0",
      publicationId: null,
      readable: false,
    });
    const change = {
      identity: scope,
      epoch: a.epoch,
      operationId: randomUUID(),
      expectedRevision: "0",
      targetPublicationId: ap.publication.id,
      kind: "forward",
      pointer: { version: a.request.identity.version },
    };
    const second = {
      ...change,
      operationId: randomUUID(),
      targetPublicationId: bp.publication.id,
      pointer: { version: bRequest.identity.version },
    };
    const results = await Promise.allSettled([
      repo.commitChannelChange(change, receipt(), actor),
      repo.commitChannelChange(second, receipt(), actor),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "conflict" }) }),
    ]);
    const winner = results[0]?.status === "fulfilled" ? change : second;
    const snapshot = await repo.readChannel(scope);
    expect(snapshot).toMatchObject({
      revision: "1",
      readable: true,
      publicationId: winner.targetPublicationId,
    });
    expect(await repo.commitChannelChange(winner, receipt(), actor)).toEqual(snapshot);
    await expect(
      repo.commitChannelChange({ ...winner, kind: "rollback" }, receipt(), actor),
    ).rejects.toMatchObject({ code: "conflict" });
    const failing = new CatalogRepository(db, {
      async record() {
        throw new Error("audit unavailable");
      },
    });
    await expect(
      failing.commitChannelChange(
        { ...change, operationId: randomUUID(), expectedRevision: "1" },
        receipt(),
        actor,
      ),
    ).rejects.toThrow("audit unavailable");
    expect(await repo.readChannel(scope)).toEqual(snapshot);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM platform_audit_events WHERE action='release_catalog.channel.change'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });
  it("keeps history-closed namespaces unavailable to new publication", async () => {
    const f = await setup();
    const r = receipt();
    await pool.query(
      "INSERT INTO release_catalog_receipts(id,kind,sha256,ledger_key,ledger_version_id) VALUES($1,'reservation',$2,$3,$4)",
      [r.operationId, r.sha256, r.ledgerKey, r.ledgerVersionId],
    );
    await pool.query(
      "INSERT INTO release_catalog_reservations(id,product,channel,kind,receipt_id) VALUES($1,'standalone','stable','closed',$2)",
      [randomUUID(), r.operationId],
    );
    await expect(repo.reserveIntent(principal, randomUUID(), f.request)).rejects.toMatchObject({
      code: "not_ready",
    });
  });
});
