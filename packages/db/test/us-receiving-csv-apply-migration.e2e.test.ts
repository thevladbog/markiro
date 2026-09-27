import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "../src/index.js";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";
import { migrateThrough } from "./support/us-receiving-lifecycle-fixture.js";
import {
  seed,
  transition,
  type Fixture,
  type Specimen,
} from "./support/us-receiving-snapshot-fixture.js";

const url = process.env.US_TEST_DATABASE_URL;
const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const fileHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const command = "receiving.csv.apply";

describe.skipIf(!url)("receiving CSV apply additive binding", () => {
  let fixture: Fixture;
  let original: Specimen, foreign: Specimen;
  let before: unknown;
  let historicPreview: string;
  const oldTables = [
    "products",
    "traceability_lots",
    "reference_documents",
    "traceability_events",
    "receiving_event_roots",
    "receiving_event_items",
    "receiving_event_documents",
    "receiving_counters",
    "receiving_operations",
    "receiving_csv_previews",
  ];
  async function state() {
    return Promise.all(
      oldTables.map(
        async (table) =>
          (
            await fixture.pool.query(
              `SELECT to_jsonb(t)::text AS exact FROM ${table} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows,
      ),
    );
  }
  async function preview(tenant: string = original.tenant, content: string | null = digest) {
    const id = randomUUID();
    await fixture.pool.query(
      `INSERT INTO receiving_csv_previews(id,tenant_id,template_version,file_bytes,byte_size,file_sha256,
       original_header,findings,proposed_draft,preview_digest,row_count,created_by,created_at,expires_at)
       VALUES ($1,$2,'markiro-receiving-v1',$3,3,$4,'{}','{}',$5,$6,$7,'synthetic-writer',
       '2026-09-08T12:00:00Z','2026-09-09T12:00:00Z')`,
      [
        id,
        tenant,
        Buffer.from("abc"),
        fileHash,
        content === null ? null : { notes: "  original Ä  " },
        content,
        content === null ? 0 : 1,
      ],
    );
    return id;
  }
  async function operation(
    c: Specimen = original,
    content = digest,
    kind = command,
    key: string = randomUUID(),
    db: Pool | PoolClient = fixture.pool,
  ) {
    // Deliberately untrusted JSON: this suite proves relational storage, not receipt validation.
    await db.query(
      "INSERT INTO receiving_operations(tenant_id,command,operation_key,input_digest,event_id,result) VALUES ($1,$2,$3,$4,$5,$6)",
      [c.tenant, kind, key, content, c.id, { id: c.id, notes: "  exact Ä  " }],
    );
    return key;
  }
  function bind(
    id: string,
    key: string,
    tenant: string = original.tenant,
    content = digest,
    kind = command,
    db: Pool | PoolClient = fixture.pool,
  ) {
    return db.query(
      "INSERT INTO receiving_csv_applications(tenant_id,preview_id,command,operation_key,input_digest) VALUES ($1,$2,$3,$4,$5)",
      [tenant, id, kind, key, content],
    );
  }
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    fixture = await createUsProfileTestDatabase(url, 124);
    original = await seed(fixture);
    foreign = await seed(fixture, "preserved");
    await transition(fixture, foreign);
    await migrateThrough(fixture, 127);
    historicPreview = await preview();
    await preview(original.tenant, null);
    await operation(original, digest, "receiving.create");
    before = await state();
    await migrateThrough(fixture, 128);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });

  it("adds application binding through the migration journal", async () => {
    expect(
      (await fixture.pool.query("SELECT to_regclass('public.receiving_csv_applications') AS name"))
        .rows,
    ).toEqual([{ name: "receiving_csv_applications" }]);
  });
  it("preserves old drafts, frozen history, operation JSON and preview evidence exactly", async () => {
    expect(await state()).toEqual(before);
  });
  it("round trips a content-matched binding through the exported table", async () => {
    const key = await operation();
    await fixture.db.insert(schema.receivingCsvApplications).values({
      tenantId: original.tenant,
      previewId: historicPreview,
      operationKey: key,
      inputDigest: digest,
    });
    expect(
      await fixture.db
        .select()
        .from(schema.receivingCsvApplications)
        .where(
          and(
            eq(schema.receivingCsvApplications.tenantId, original.tenant),
            eq(schema.receivingCsvApplications.previewId, historicPreview),
          ),
        ),
    ).toEqual([
      {
        tenantId: original.tenant,
        previewId: historicPreview,
        command,
        operationKey: key,
        inputDigest: digest,
      },
    ]);
  });
  it("rejects a missing preview", async () => {
    await expect(bind(randomUUID(), await operation())).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects a preview without an applicable proposal", async () => {
    await expect(
      bind(await preview(original.tenant, null), await operation()),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects a missing operation", async () => {
    await expect(bind(await preview(), randomUUID())).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects a foreign preview even with matching content", async () => {
    await expect(bind(await preview(foreign.tenant), await operation())).rejects.toMatchObject({
      code: "23503",
    });
  });
  it("rejects a foreign operation even with matching content", async () => {
    await expect(bind(await preview(), await operation(foreign))).rejects.toMatchObject({
      code: "23503",
    });
  });
  it("rejects content that does not match the preview", async () => {
    await expect(
      bind(await preview(original.tenant, otherDigest), await operation()),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects content that does not match the operation", async () => {
    await expect(
      bind(await preview(), await operation(original, otherDigest)),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it.each([
    "receiving.create",
    "receiving.save",
    "receiving.finalize",
    "receiving.amend",
    "receiving.void",
  ])("retains %s operations but forbids using one as a CSV application", async (kind) => {
    const key = await operation(original, digest, kind);
    await expect(bind(await preview(), key, original.tenant, digest, kind)).rejects.toMatchObject({
      code: "23514",
    });
  });
  it("keeps unknown commands denied", async () => {
    await expect(operation(original, digest, "receiving.csv.unknown")).rejects.toMatchObject({
      code: "23514",
    });
  });
  it("permits equal files for separate previews and explicit operations", async () => {
    const a = await preview(),
      b = await preview();
    const first = await operation(),
      second = await operation();
    await bind(a, first);
    await bind(b, second);
    expect(
      (
        await fixture.pool.query(
          "SELECT preview_id,operation_key FROM receiving_csv_applications WHERE preview_id=ANY($1::uuid[]) ORDER BY preview_id",
          [[a, b]],
        )
      ).rows,
    ).toEqual(
      [
        { preview_id: a, operation_key: first },
        { preview_id: b, operation_key: second },
      ].sort((x, y) => x.preview_id.localeCompare(y.preview_id)),
    );
  });
  it("allows same-content previews to reference one original result", async () => {
    const a = await preview(),
      b = await preview(),
      key = await operation();
    await bind(a, key);
    await bind(b, key);
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::integer AS count FROM receiving_csv_applications WHERE tenant_id=$1 AND operation_key=$2",
          [original.tenant, key],
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
  });
  it("rejects a second operation for one already bound preview", async () => {
    const id = await preview();
    await bind(id, await operation());
    await expect(bind(id, await operation())).rejects.toMatchObject({ code: "23505" });
  });
  it("retains operation-key uniqueness even when content changes", async () => {
    const key = await operation();
    await expect(operation(original, otherDigest, command, key)).rejects.toMatchObject({
      code: "23505",
    });
  });
  it.each(["tenant_id", "preview_id", "command", "operation_key", "input_digest"])(
    "does not let a null %s bypass composite foreign keys",
    async (column) => {
      const id = await preview(),
        key = await operation();
      await bind(id, key);
      await expect(
        fixture.pool.query(
          `UPDATE receiving_csv_applications SET ${column}=NULL WHERE tenant_id=$1 AND preview_id=$2`,
          [original.tenant, id],
        ),
      ).rejects.toMatchObject({ code: "23502" });
    },
  );
  it.each(["receiving_csv_previews", "receiving_operations"])(
    "prevents bound content identity changing in %s",
    async (table) => {
      const id = await preview(),
        key = await operation();
      await bind(id, key);
      const previewTable = table === "receiving_csv_previews";
      await expect(
        fixture.pool.query(
          `UPDATE ${table} SET ${previewTable ? "preview_digest" : "input_digest"}=$1 WHERE tenant_id=$2 AND ${previewTable ? "id" : "operation_key"}=$3`,
          [otherDigest, original.tenant, previewTable ? id : key],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    },
  );
  it("retains expired previews as binding evidence", async () => {
    const id = await preview(),
      key = await operation();
    await fixture.pool.query(
      "UPDATE receiving_csv_previews SET created_at='2020-01-01Z',expires_at='2020-01-02Z' WHERE id=$1",
      [id],
    );
    await expect(bind(id, key)).resolves.toMatchObject({ rowCount: 1 });
  });
  it.each(["receiving_csv_previews", "receiving_operations"])(
    "protects bound parent %s from deletion",
    async (table) => {
      const id = await preview(),
        key = await operation();
      await bind(id, key);
      const target = table === "receiving_csv_previews" ? "id" : "operation_key";
      await expect(
        fixture.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND ${target}=$2`, [
          original.tenant,
          target === "id" ? id : key,
        ]),
      ).rejects.toMatchObject({ code: "23503" });
    },
  );
  it("rolls back the binding and new receipt together", async () => {
    const id = await preview(),
      key = randomUUID();
    const tx = await fixture.pool.connect();
    try {
      await tx.query("BEGIN");
      await operation(original, digest, command, key, tx);
      await bind(id, key, original.tenant, digest, command, tx);
      await expect(tx.query("SELECT 1/0")).rejects.toMatchObject({ code: "22012" });
      await tx.query("ROLLBACK");
    } finally {
      tx.release();
    }
    expect(
      (
        await fixture.pool.query("SELECT * FROM receiving_csv_applications WHERE preview_id=$1", [
          id,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await fixture.pool.query(
          "SELECT * FROM receiving_operations WHERE tenant_id=$1 AND operation_key=$2",
          [original.tenant, key],
        )
      ).rows,
    ).toEqual([]);
  });
  it("allows only one of two concurrent competing bindings", async () => {
    const id = await preview(),
      first = await operation(),
      second = await operation();
    const winner = await fixture.pool.connect(),
      loser = await fixture.pool.connect();
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const blocker = (await winner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]?.pid;
      const waiter = (await loser.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      expect(blocker).toEqual(expect.any(Number));
      expect(waiter).toEqual(expect.any(Number));
      await winner.query("BEGIN");
      await bind(id, first, original.tenant, digest, command, winner);
      pending = Promise.allSettled([bind(id, second, original.tenant, digest, command, loser)]);
      await expect
        .poll(
          async () =>
            (
              await fixture.pool.query<{ blocked: boolean }>(
                "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
                [blocker, waiter],
              )
            ).rows[0]?.blocked,
          { timeout: 3000 },
        )
        .toBe(true);
      await winner.query("COMMIT");
      expect(await pending).toEqual([
        { status: "rejected", reason: expect.objectContaining({ code: "23505" }) },
      ]);
    } finally {
      await winner.query("ROLLBACK");
      await pending;
      winner.release();
      loser.release();
    }
    const rows = (
      await fixture.pool.query<{ operation_key: string }>(
        "SELECT operation_key FROM receiving_csv_applications WHERE preview_id=$1",
        [id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.operation_key).toBe(first);
  });
});
