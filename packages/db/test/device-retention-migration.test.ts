import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const hash = "a".repeat(64);
describe.skipIf(!databaseUrl)("working device retention forward migration", () => {
  const name = `markiro_retention_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  const deviceA = randomUUID();
  const deviceB = randomUUID();
  let created = false;
  let temporaryRoot = "";
  let history: unknown;
  const readHistory = async () =>
    Promise.all(
      [
        "station_devices",
        "working_device_assignments",
        "working_device_events",
        "products",
        "shifts",
      ].map(async (table) => (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows),
    );
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-retention-"));
    const legacy = join(temporaryRoot, "legacy");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacy,
      lastIncludedIndex: 132,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacy });
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ('retention-a','A','retention-a',now()),('retention-b','B','retention-b',now())",
    );
    await pool.query(
      "INSERT INTO station_devices (id,tenant_id,name,kind,paired_at,api_key_id) VALUES ($1,'retention-a','A','station',now(),'key-a'),($2,'retention-b','B','handheld',now(),'key-b')",
      [deviceA, deviceB],
    );
    const beforeRetention = join(temporaryRoot, "before-retention");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: beforeRetention,
      lastIncludedIndex: 138,
    });
    await migrate(drizzle(pool), { migrationsFolder: beforeRetention });
    const productId = randomUUID();
    const shiftId = randomUUID();
    await pool.query(
      "INSERT INTO products(id,tenant_id,gtin14,name) VALUES($1,'retention-a','04601234567893','Saved product')",
      [productId],
    );
    await pool.query(
      "INSERT INTO shifts(id,tenant_id,product_id,mode,status,number_month_key,number_seq,opened_at) VALUES($1,'retention-a',$2,'validation','active','SEP26',1,'2026-09-11T08:00:00Z')",
      [shiftId, productId],
    );
    // The later reprocessing migration adds a default-off policy field. Every
    // pre-existing historical field must still match byte-for-byte, and the new
    // field must stay false for this legacy validation shift.
    history = (await readHistory()).map((rows, index) =>
      index === 4
        ? rows.map((row: Record<string, unknown>) => ({
            ...row,
            allow_previously_accepted_codes: false,
          }))
        : rows,
    );
    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder,
      log: () => undefined,
    });
  }, 120_000);
  it("installs the tenant/device index for ordered membership reads", async () => {
    const result = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'working_device_retention_members' AND indexname = 'working_device_retention_members_tenant_device_idx'",
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.indexdef).toContain("USING btree (tenant_id, device_id)");
  });
  afterAll(async () => {
    await pool.end();
    // pool.end() can resolve before the socket closes; FORCE races that shutdown.
    if (created) await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });
  const insertPreview = async (
    input: { tenantId?: string; actorDomain?: string; actorId?: string; requestId?: string } = {},
  ) => {
    const id = randomUUID();
    const requestId = input.requestId ?? randomUUID();
    await pool.query(
      `INSERT INTO working_device_retention_previews
      (id,tenant_id,actor_domain,actor_id,request_id,payload,payload_hash,facts_fingerprint,observation,expected_revision,selected_device_ids,created_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,'{}',$6,$6,'{}',$7,'[]',now(),now()+interval '5 minutes')`,
      [
        id,
        input.tenantId ?? "retention-a",
        input.actorDomain ?? "cabinet",
        input.actorId ?? "cabinet-user-a",
        requestId,
        hash,
        0,
      ],
    );
    return { id, requestId };
  };
  const insertSelection = async (
    previewId: string,
    input: { tenantId?: string; effectiveAt?: string } = {},
  ) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO working_device_retention_selections (id,tenant_id,effective_at,preview_id,revision,actor_domain,actor_id,observation,facts_fingerprint,prepared_at)
      VALUES ($1,$2,$3,$4,1,'cabinet','cabinet-user-a','{}',$5,now())`,
      [
        id,
        input.tenantId ?? "retention-a",
        input.effectiveAt ?? "2099-01-01T00:00:00Z",
        previewId,
        hash,
      ],
    );
    return id;
  };
  const insertMember = (tenantId: string, selectionId: string, deviceId: string) =>
    pool.query(
      "INSERT INTO working_device_retention_members (tenant_id,selection_id,device_id) VALUES ($1,$2,$3)",
      [tenantId, selectionId, deviceId],
    );
  const insertEvent = async (
    selectionId: string,
    requestId: string = randomUUID(),
    patch: {
      actorDomain?: string;
      actorId?: string;
      after?: unknown;
      result?: unknown;
      before?: unknown;
      tenantId?: string;
    } = {},
  ) => {
    const after = patch.after ?? { id: selectionId, revision: 1 };
    const result = patch.result ?? { requestId, selection: after };
    return pool.query(
      `INSERT INTO working_device_retention_events (tenant_id,selection_id,request_id,actor_domain,actor_id,action,before,"after",result)
      VALUES ($1,$2,$3,$4,$5,'selection_confirmed',$6,$7,$8) RETURNING id`,
      [
        patch.tenantId ?? "retention-a",
        selectionId,
        requestId,
        patch.actorDomain ?? "cabinet",
        patch.actorId ?? "cabinet-user-a",
        patch.before === undefined ? null : JSON.stringify(patch.before),
        JSON.stringify(after),
        JSON.stringify(result),
      ],
    );
  };
  it("adds empty storage without altering historical devices, assignments or events and reruns safely", async () => {
    expect(await readHistory()).toEqual(history);
    for (const table of ["previews", "selections", "members", "events"])
      expect((await pool.query(`SELECT * FROM working_device_retention_${table}`)).rows).toEqual(
        [],
      );
    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder,
      log: () => undefined,
    });
    expect(await readHistory()).toEqual(history);
  });
  it("rejects a foreign tenant preview, selection membership and device membership", async () => {
    await expect(insertPreview({ tenantId: "missing-tenant" })).rejects.toMatchObject({
      code: "23503",
    });
    const preview = await insertPreview();
    await expect(insertSelection(preview.id, { tenantId: "retention-b" })).rejects.toMatchObject({
      code: "23503",
    });
    const selectionId = await insertSelection(preview.id);
    await expect(insertMember("retention-b", selectionId, deviceB)).rejects.toMatchObject({
      code: "23503",
    });
    await expect(insertMember("retention-a", selectionId, deviceB)).rejects.toMatchObject({
      code: "23503",
    });
    await expect(
      insertEvent(selectionId, randomUUID(), { tenantId: "retention-b" }),
    ).rejects.toMatchObject({ code: "23503" });
    await insertMember("retention-a", selectionId, deviceA);
    await expect(insertMember("retention-a", selectionId, deviceA)).rejects.toMatchObject({
      code: "23505",
    });
  });
  it("rejects duplicate commercial boundaries and preview request IDs", async () => {
    const preview = await insertPreview();
    await expect(insertPreview({ requestId: preview.requestId })).rejects.toMatchObject({
      code: "23505",
    });
    await expect(insertSelection(preview.id)).rejects.toMatchObject({ code: "23505" });
  });
  it("requires valid actor, objects, digests, finite expiry and complete correlated confirmation", async () => {
    await expect(insertPreview({ actorDomain: "device" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertPreview({ actorId: " " })).rejects.toMatchObject({ code: "23514" });
    const preview = await insertPreview();
    for (const change of [
      "expires_at=created_at",
      "expires_at=created_at+interval '5 minutes 1 millisecond'",
      "created_at='infinity'",
      "payload='[]'",
      "observation='null'",
      "payload_hash='bad'",
      "facts_fingerprint='bad'",
      "expected_revision=-1",
      "selected_device_ids='{}'",
      "confirmed_at=now()",
    ])
      await expect(
        pool.query(`UPDATE working_device_retention_previews SET ${change} WHERE id=$1`, [
          preview.id,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    // Exercise INSERT checks directly; immutable UPDATE rejection alone cannot
    // prove invalid actor/payload/time values are rejected on initial storage.
    for (const change of [
      "'device',actor_id,payload,payload_hash,facts_fingerprint,observation,expected_revision,selected_device_ids,created_at,expires_at",
      "actor_domain,' ',payload,payload_hash,facts_fingerprint,observation,expected_revision,selected_device_ids,created_at,expires_at",
      "actor_domain,actor_id,'[]',payload_hash,facts_fingerprint,observation,expected_revision,selected_device_ids,created_at,expires_at",
      "actor_domain,actor_id,payload,'bad',facts_fingerprint,observation,expected_revision,selected_device_ids,created_at,expires_at",
      "actor_domain,actor_id,payload,payload_hash,'bad',observation,expected_revision,selected_device_ids,created_at,expires_at",
      "actor_domain,actor_id,payload,payload_hash,facts_fingerprint,'null',expected_revision,selected_device_ids,created_at,expires_at",
      "actor_domain,actor_id,payload,payload_hash,facts_fingerprint,observation,-1,selected_device_ids,created_at,expires_at",
      "actor_domain,actor_id,payload,payload_hash,facts_fingerprint,observation,expected_revision,'[1]',created_at,expires_at",
      `actor_domain,actor_id,payload,payload_hash,facts_fingerprint,observation,expected_revision,'["${deviceA}","${deviceA}"]',created_at,expires_at`,
      "actor_domain,actor_id,payload,payload_hash,facts_fingerprint,observation,expected_revision,selected_device_ids,created_at,created_at",
      "actor_domain,actor_id,payload,payload_hash,facts_fingerprint,observation,expected_revision,selected_device_ids,created_at,created_at+interval '6 minutes'",
      "actor_domain,actor_id,payload,payload_hash,facts_fingerprint,observation,expected_revision,selected_device_ids,'-infinity',expires_at",
    ])
      await expect(
        pool.query(
          `INSERT INTO working_device_retention_previews
      (tenant_id,request_id,actor_domain,actor_id,payload,payload_hash,facts_fingerprint,observation,expected_revision,selected_device_ids,created_at,expires_at)
      SELECT tenant_id,gen_random_uuid(),${change} FROM working_device_retention_previews WHERE id=$1`,
          [preview.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    const selectionId = await insertSelection(preview.id, { effectiveAt: "2099-02-01T00:00:00Z" });
    for (const change of [
      "revision=0",
      "actor_domain='device'",
      "actor_id=' '",
      "observation='[]'",
      "facts_fingerprint='bad'",
      "effective_at=prepared_at",
      "prepared_at='infinity'",
    ])
      await expect(
        pool.query(`UPDATE working_device_retention_selections SET ${change} WHERE id=$1`, [
          selectionId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    for (const response of [
      {},
      { requestId: randomUUID(), selection: { id: selectionId, revision: 1 } },
      { requestId: preview.requestId, selection: { id: randomUUID(), revision: 1 } },
      { requestId: preview.requestId, selection: { id: selectionId } },
    ])
      await expect(
        pool.query(
          "UPDATE working_device_retention_previews SET confirmed_at=now(),result_selection_id=$2,response=$3 WHERE id=$1",
          [preview.id, selectionId, response],
        ),
      ).rejects.toMatchObject({ code: "23514" });
  });
  it("stores immutable correlated receipts and a dedicated append-only selection journal", async () => {
    const preview = await insertPreview();
    const selectionId = await insertSelection(preview.id, { effectiveAt: "2099-03-01T00:00:00Z" });
    const after = { id: selectionId, revision: 1 };
    const receipt = { requestId: preview.requestId, selection: after };
    for (const patch of [
      { actorDomain: "device" },
      { actorId: " " },
      { after: {} },
      { after: { id: selectionId, revision: 0 } },
      { result: {} },
      { result: { requestId: randomUUID(), selection: after } },
      { before: [] },
      { after: { id: selectionId, revision: 2 } },
      { before: { id: randomUUID(), revision: 1 }, after: { id: selectionId, revision: 2 } },
      { before: { id: selectionId }, after: { id: selectionId, revision: 2 } },
      { before: { id: selectionId, revision: 1 }, after: { id: selectionId, revision: 1 } },
    ])
      await expect(insertEvent(selectionId, preview.requestId, patch)).rejects.toMatchObject({
        code: "23514",
      });
    await insertEvent(selectionId, preview.requestId);
    await expect(insertEvent(selectionId, preview.requestId)).rejects.toMatchObject({
      code: "23505",
    });
    await pool.query(
      "UPDATE working_device_retention_previews SET confirmed_at=now(),result_selection_id=$2,response=$3 WHERE id=$1",
      [preview.id, selectionId, receipt],
    );
    await expect(
      pool.query("UPDATE working_device_retention_previews SET response='{}' WHERE id=$1", [
        preview.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM working_device_retention_previews WHERE id=$1", [preview.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "UPDATE working_device_retention_events SET actor_id='rewritten' WHERE request_id=$1",
        [preview.requestId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM working_device_retention_events WHERE request_id=$1", [
        preview.requestId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await pool.query(
          'SELECT tenant_id,selection_id,request_id,actor_domain,actor_id,action,before,"after",result FROM working_device_retention_events WHERE request_id=$1',
          [preview.requestId],
        )
      ).rows,
    ).toEqual([
      {
        tenant_id: "retention-a",
        selection_id: selectionId,
        request_id: preview.requestId,
        actor_domain: "cabinet",
        actor_id: "cabinet-user-a",
        action: "selection_confirmed",
        before: null,
        after,
        result: receipt,
      },
    ]);
    expect(
      (
        await pool.query("SELECT response FROM working_device_retention_previews WHERE id=$1", [
          preview.id,
        ])
      ).rows,
    ).toEqual([{ response: receipt }]);
    expect(await readHistory()).toEqual(history);
  });
  it("replaces one shared boundary revision transactionally while preserving the first receipt", async () => {
    const first = await insertPreview();
    const selectionId = await insertSelection(first.id, { effectiveAt: "2099-04-01T00:00:00Z" });
    const before = { id: selectionId, revision: 1 };
    const firstReceipt = { requestId: first.requestId, selection: before };
    await insertEvent(selectionId, first.requestId);
    await pool.query(
      "UPDATE working_device_retention_previews SET confirmed_at=now(),result_selection_id=$2,response=$3 WHERE id=$1",
      [first.id, selectionId, firstReceipt],
    );
    // The immediate tenant/preview FK permits preview -> selection -> receipt.
    const tx = await pool.connect();
    const nextId = randomUUID();
    const requestId = randomUUID();
    const after = { id: selectionId, revision: 2 };
    const receipt = { requestId, selection: after };
    try {
      await tx.query("BEGIN");
      await tx.query(
        `INSERT INTO working_device_retention_previews
        (id,tenant_id,actor_domain,actor_id,request_id,payload,payload_hash,facts_fingerprint,observation,expected_revision,selected_device_ids,created_at,expires_at)
        VALUES ($1,'retention-a','platform','platform-user-a',$2,'{}',$3,$3,'{}',1,'[]',now(),now()+interval '5 minutes')`,
        [nextId, requestId, hash],
      );
      expect(
        (
          await tx.query(
            `UPDATE working_device_retention_selections SET preview_id=$2,revision=2,actor_domain='platform',actor_id='platform-user-a',prepared_at=now() WHERE id=$1 AND revision=1 RETURNING id`,
            [selectionId, nextId],
          )
        ).rowCount,
      ).toBe(1);
      await tx.query(
        `INSERT INTO working_device_retention_events (tenant_id,selection_id,request_id,actor_domain,actor_id,action,before,"after",result)
        VALUES ('retention-a',$1,$2,'platform','platform-user-a','selection_confirmed',$3,$4,$5)`,
        [selectionId, requestId, before, after, receipt],
      );
      await tx.query(
        "UPDATE working_device_retention_previews SET confirmed_at=now(),result_selection_id=$2,response=$3 WHERE id=$1",
        [nextId, selectionId, receipt],
      );
      await tx.query("COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
    expect(
      (
        await pool.query("SELECT response FROM working_device_retention_previews WHERE id=$1", [
          first.id,
        ])
      ).rows,
    ).toEqual([{ response: firstReceipt }]);
    expect(
      (
        await pool.query("SELECT result FROM working_device_retention_events WHERE request_id=$1", [
          first.requestId,
        ])
      ).rows,
    ).toEqual([{ result: firstReceipt }]);
    expect(
      (
        await pool.query(
          "SELECT revision,preview_id,actor_domain,actor_id FROM working_device_retention_selections WHERE id=$1",
          [selectionId],
        )
      ).rows,
    ).toEqual([
      { revision: 2, preview_id: nextId, actor_domain: "platform", actor_id: "platform-user-a" },
    ]);
  });
});
