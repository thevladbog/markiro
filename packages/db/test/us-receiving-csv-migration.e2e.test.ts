import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
const abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe.skipIf(!url)("receiving CSV preview additive storage", () => {
  let fixture: Fixture;
  let frozen: Specimen, draft: Specimen;
  let before: unknown;
  const businessTables = [
    "products",
    "traceability_lots",
    "reference_documents",
    "traceability_events",
    "receiving_event_roots",
    "receiving_event_items",
    "receiving_event_documents",
    "receiving_operations",
    "receiving_counters",
  ];
  async function businessState() {
    return Promise.all(
      businessTables.map(
        async (table) =>
          (
            await fixture.pool.query(
              `SELECT to_jsonb(t)::text AS exact FROM ${table} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows,
      ),
    );
  }
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    fixture = await createUsProfileTestDatabase(url, 124);
    frozen = await seed(fixture);
    draft = await seed(fixture, "preserved");
    await transition(fixture, frozen);
    await migrateThrough(fixture, 126);
    await fixture.pool.query(
      "INSERT INTO receiving_operations(tenant_id,command,operation_key,input_digest,event_id,result) VALUES ($1,'receiving.create',$2,$3,$4,$5)",
      [
        frozen.tenant,
        randomUUID(),
        "a".repeat(64),
        frozen.id,
        { id: frozen.id, notes: "  exact Ä  " },
      ],
    );
    before = await businessState();
    await migrateThrough(fixture, 127);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });

  async function insert(tenantId: string = frozen.tenant) {
    const id = randomUUID();
    await fixture.pool.query(
      `INSERT INTO receiving_csv_previews(id,tenant_id,template_version,file_bytes,byte_size,file_sha256,
        original_header,findings,row_count,created_by,created_at,expires_at)
       VALUES ($1,$2,'markiro-receiving-v1',$3,3,$4,$5,$6,0,'synthetic-writer',
        '2026-09-08T12:00:00Z','2026-09-09T12:00:00Z')`,
      [
        id,
        tenantId,
        Buffer.from("abc"),
        abcHash,
        { notes: "  original Ä  ", documentIds: [] },
        { ok: false, error: { code: "header", lineNumber: 1 } },
      ],
    );
    return id;
  }
  async function denied(assignment: string, code = "23514") {
    const id = await insert();
    await expect(
      fixture.pool.query(`UPDATE receiving_csv_previews SET ${assignment} WHERE id=$1`, [id]),
    ).rejects.toMatchObject({ code });
  }

  it("adds the preview table through the journal", async () => {
    expect(
      (await fixture.pool.query("SELECT to_regclass('public.receiving_csv_previews') AS name"))
        .rows,
    ).toEqual([{ name: "receiving_csv_previews" }]);
  });
  it("preserves every existing business field and immutable receipt", async () => {
    expect(await businessState()).toEqual(before);
  });
  it("round trips evidence through the exported Drizzle table without business writes", async () => {
    const id = await insert();
    const [record] = await fixture.db
      .select()
      .from(schema.receivingCsvPreviews)
      .where(
        and(
          eq(schema.receivingCsvPreviews.tenantId, frozen.tenant),
          eq(schema.receivingCsvPreviews.id, id),
        ),
      );
    expect(record).toMatchObject({
      id,
      tenantId: frozen.tenant,
      templateVersion: "markiro-receiving-v1",
      fileBytes: Buffer.from("abc"),
      byteSize: 3,
      fileSha256: abcHash,
      originalHeader: { notes: "  original Ä  ", documentIds: [] },
      findings: { ok: false, error: { code: "header", lineNumber: 1 } },
      proposedDraft: null,
      previewDigest: null,
      rowCount: 0,
      fileName: null,
      createdBy: "synthetic-writer",
      createdAt: new Date("2026-09-08T12:00:00Z"),
      expiresAt: new Date("2026-09-09T12:00:00Z"),
    });
    expect(await businessState()).toEqual(before);
  });
  it("allows identical bytes in independent previews and tenants, never globally deduplicating deliveries", async () => {
    const first = await insert(),
      second = await insert(),
      foreign = await insert(draft.tenant);
    expect(new Set([first, second, foreign]).size).toBe(3);
    expect(
      await fixture.db
        .select()
        .from(schema.receivingCsvPreviews)
        .where(
          and(
            eq(schema.receivingCsvPreviews.tenantId, frozen.tenant),
            eq(schema.receivingCsvPreviews.id, foreign),
          ),
        ),
    ).toEqual([]);
    await expect(insert("missing-tenant")).rejects.toMatchObject({ code: "23503" });
  });
  it("retains empty and invalid UTF-8 files as evidence and accepts the exact byte cap", async () => {
    const id = await insert();
    await fixture.pool.query(
      "UPDATE receiving_csv_previews SET file_bytes=$1,byte_size=0,file_sha256=$2 WHERE id=$3",
      [Buffer.alloc(0), emptyHash, id],
    );
    const invalid = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0x0d, 0x0a, 0x00]);
    for (const bytes of [invalid, Buffer.alloc(262144, 255)]) {
      await fixture.pool.query(
        "UPDATE receiving_csv_previews SET file_bytes=$1,byte_size=octet_length($1::bytea),file_sha256=encode(sha256($1::bytea),'hex') WHERE id=$2",
        [bytes, id],
      );
      expect(
        (
          await fixture.pool.query("SELECT file_bytes FROM receiving_csv_previews WHERE id=$1", [
            id,
          ])
        ).rows,
      ).toEqual([{ file_bytes: bytes }]);
    }
    await expect(
      fixture.pool.query(
        "UPDATE receiving_csv_previews SET file_bytes=$1,byte_size=262145,file_sha256=encode(sha256($1::bytea),'hex') WHERE id=$2",
        [Buffer.alloc(262145), id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("preserves proposed identifiers, exact decimals and raw multiline findings", async () => {
    const id = await insert();
    const proposal = {
      notes: null,
      items: [{ productId: frozen.product, quantity: "500.000", tlc: "=Case/Ä-001" }],
    };
    const findings = {
      ok: true,
      rows: [{ rowNumber: 1, lineNumber: 2, cells: ["  Ä\r\nquoted  ", "500.000"], issues: [] }],
    };
    await fixture.db
      .update(schema.receivingCsvPreviews)
      .set({
        proposedDraft: proposal,
        previewDigest: "a".repeat(64),
        rowCount: 1,
        findings,
      })
      .where(
        and(
          eq(schema.receivingCsvPreviews.tenantId, frozen.tenant),
          eq(schema.receivingCsvPreviews.id, id),
        ),
      );
    expect(
      (
        await fixture.pool.query(
          "SELECT proposed_draft,findings FROM receiving_csv_previews WHERE id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ proposed_draft: proposal, findings }]);
    expect(await businessState()).toEqual(before);
  });
  it.each([
    "byte_size=-1",
    "byte_size=2",
    "file_sha256=repeat('a',64)",
    "file_sha256=upper(file_sha256)",
    "template_version='future'",
    "row_count=-1",
    "row_count=101",
    "original_header='[]'::jsonb",
    "original_header='null'::jsonb",
    "findings='true'::jsonb",
    "findings='null'::jsonb",
    "proposed_draft='{}'::jsonb",
    "preview_digest=repeat('a',64)",
    "proposed_draft='null'::jsonb,preview_digest=repeat('a',64),row_count=1",
    "proposed_draft='[]'::jsonb,preview_digest=repeat('a',64),row_count=1",
    "proposed_draft='{}'::jsonb,preview_digest='bad',row_count=1",
    "proposed_draft='{}'::jsonb,preview_digest=repeat('a',64),row_count=0",
    "created_by='  '",
    "created_by=repeat('x',129)",
    "file_name=''",
    "file_name=repeat('x',201)",
    "file_name=chr(10)",
    "file_name=chr(127)",
    "file_name=chr(159)",
    "expires_at=created_at",
    "expires_at=created_at+interval '25 hours'",
    "created_at='infinity',expires_at='infinity'",
  ])("rejects corrupted preview metadata: %s", async (assignment) => {
    await denied(assignment);
  });
  it.each([
    "file_bytes",
    "byte_size",
    "file_sha256",
    "template_version",
    "original_header",
    "findings",
    "row_count",
    "created_by",
    "created_at",
    "expires_at",
    "tenant_id",
  ])("requires %s", async (column) => {
    await denied(`${column}=NULL`, "23502");
  });
  it("measures 24 elapsed hours over DST and retains expired evidence", async () => {
    const id = await insert();
    const tx = await fixture.pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("SET LOCAL TIME ZONE 'America/New_York'");
      await tx.query(
        "UPDATE receiving_csv_previews SET created_at='2026-03-07T12:00:00-05:00',expires_at='2026-03-08T13:00:00-04:00' WHERE id=$1",
        [id],
      );
      expect(
        (
          await tx.query(
            "SELECT extract(epoch from expires_at-created_at)::integer AS seconds FROM receiving_csv_previews WHERE id=$1",
            [id],
          )
        ).rows,
      ).toEqual([{ seconds: 86400 }]);
      await expect(
        tx.query(
          "UPDATE receiving_csv_previews SET expires_at=created_at+interval '1 day' WHERE id=$1",
          [id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
    await fixture.pool.query(
      "UPDATE receiving_csv_previews SET created_at='2020-01-01Z',expires_at='2020-01-02Z' WHERE id=$1",
      [id],
    );
    expect(
      (
        await fixture.pool.query(
          "SELECT file_sha256 FROM receiving_csv_previews WHERE id=$1 AND expires_at<now()",
          [id],
        )
      ).rows,
    ).toEqual([{ file_sha256: abcHash }]);
  });
  it("rolls back preview persistence with the enclosing transaction", async () => {
    const id = randomUUID();
    await expect(
      fixture.db.transaction(async (tx) => {
        await tx.insert(schema.receivingCsvPreviews).values({
          id,
          tenantId: frozen.tenant,
          templateVersion: "markiro-receiving-v1",
          fileBytes: Buffer.alloc(0),
          byteSize: 0,
          fileSha256: emptyHash,
          originalHeader: {},
          findings: { ok: false },
          rowCount: 0,
          createdBy: "synthetic-writer",
          createdAt: new Date("2026-09-08Z"),
          expiresAt: new Date("2026-09-09Z"),
        });
        throw new Error("Synthetic transaction failure");
      }),
    ).rejects.toThrow("Synthetic transaction failure");
    expect(
      (await fixture.pool.query("SELECT id FROM receiving_csv_previews WHERE id=$1", [id])).rows,
    ).toEqual([]);
    expect(await businessState()).toEqual(before);
  });
});
