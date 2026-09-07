import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";
import { migrateThrough } from "./support/us-receiving-lifecycle-fixture.js";
import {
  seed,
  transition,
  type Fixture,
  type Specimen,
} from "./support/us-receiving-snapshot-fixture.js";

const url = process.env.US_TEST_DATABASE_URL;
function legacyIndex() {
  const journal: unknown = JSON.parse(readFileSync("migrations/meta/_journal.json", "utf8"));
  if (
    !journal ||
    typeof journal !== "object" ||
    !("entries" in journal) ||
    !Array.isArray(journal.entries)
  )
    throw new Error("Invalid migration journal");
  const entries: unknown[] = journal.entries;
  for (const e of entries)
    if (
      e &&
      typeof e === "object" &&
      "tag" in e &&
      e.tag === "0124_us_receiving_basis_version" &&
      "idx" in e &&
      typeof e.idx === "number"
    )
      return e.idx;
  throw new Error("Missing pre-root migration");
}
async function history(f: Fixture) {
  return (
    await f.pool.query(`SELECT e.id, (to_jsonb(e)-'root_event_id')::text AS event,
    e.finalization_snapshot::text AS snapshot,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.line_no)::text FROM receiving_event_items i WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id) AS items,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.position)::text FROM receiving_event_documents d WHERE d.tenant_id=e.tenant_id AND d.event_id=e.id) AS documents,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.operation_key)::text FROM receiving_operations o WHERE o.tenant_id=e.tenant_id AND o.event_id=e.id) AS operations
    FROM traceability_events e ORDER BY e.id`)
  ).rows;
}

describe.skipIf(!url)("receiving root backfill and integrity", () => {
  let fixture: Fixture;
  let pending: Specimen;
  let finalized: Specimen[];
  let before: unknown;
  let lotBytes: unknown;
  let guards: unknown;
  beforeAll(async () => {
    if (!url) throw new Error("Missing synthetic database");
    fixture = await createUsProfileTestDatabase(url, legacyIndex());
    pending = await seed(fixture, "preserved", 2);
    await fixture.pool.query(
      "UPDATE receiving_event_items SET tlc=NULL,quantity=NULL,lot_id=NULL,source_location_id=NULL WHERE tenant_id=$1 AND event_id=$2",
      [pending.tenant, pending.id],
    );
    finalized = [
      await seed(fixture, "ordinary", 1),
      await seed(fixture, "ordinary", 2),
      await seed(fixture, "assigned", 2),
    ];
    for (const c of finalized) await transition(fixture, c);
    for (const c of [pending, ...finalized])
      await fixture.pool.query(
        "INSERT INTO receiving_operations(tenant_id,command,operation_key,input_digest,event_id,result) VALUES ($1,'receiving.create',$2,$3,$4,$5)",
        [
          c.tenant,
          randomUUID(),
          "b".repeat(64),
          c.id,
          { id: c.id, exact: "  historical result  ", quantity: "500.000", snapshot: c.snapshot },
        ],
      );
    await fixture.pool.query("UPDATE traceability_lots SET receiving_basis_version=7");
    before = await history(fixture);
    lotBytes = (
      await fixture.pool.query(
        "SELECT to_jsonb(l)::text AS exact FROM traceability_lots l ORDER BY id",
      )
    ).rows;
    guards = (
      await fixture.pool.query(
        "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('receiving_header_finalization_guard','receiving_snapshot_v1_shape_valid','receiving_snapshot_v2_shape_valid','receiving_snapshot_v2_common') ORDER BY proname",
      )
    ).rows;
    await migrateThrough(fixture, 125);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });

  it("anchors every existing event without changing historical content, receipts, or advanced lot tokens", async () => {
    expect(await history(fixture)).toEqual(before);
    expect(
      (
        await fixture.pool.query(
          "SELECT to_jsonb(l)::text AS exact FROM traceability_lots l ORDER BY id",
        )
      ).rows,
    ).toEqual(lotBytes);
    expect(
      (
        await fixture.pool.query(
          "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('receiving_header_finalization_guard','receiving_snapshot_v1_shape_valid','receiving_snapshot_v2_shape_valid','receiving_snapshot_v2_common') ORDER BY proname",
        )
      ).rows,
    ).toEqual(guards);
    expect(
      (
        await fixture.pool.query(
          "SELECT id,to_jsonb(e)->>'root_event_id' AS root FROM traceability_events e ORDER BY id",
        )
      ).rows,
    ).toEqual(
      [pending, ...finalized]
        .map((c) => ({ id: c.id, root: c.id }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    const roots = await fixture.pool.query("SELECT * FROM receiving_event_roots ORDER BY id");
    expect(roots.rows).toEqual(
      [pending, ...finalized]
        .map((c) => ({
          id: c.id,
          tenant_id: c.tenant,
          event_number: "REC-26-0001",
          lifecycle_version: c === pending ? 1 : 2,
          next_revision: 2,
          pending_draft_id: c === pending ? c.id : null,
          current_event_id: c === pending ? null : c.id,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it("keeps circular tenant/root/event foreign keys deferred until the transaction is complete", async () => {
    const constraints = await fixture.pool.query(
      "SELECT conname,condeferrable,condeferred FROM pg_constraint WHERE conname IN ('traceability_events_root_fk','receiving_roots_current_fk','receiving_roots_pending_fk') ORDER BY conname",
    );
    expect(constraints.rows).toEqual(
      [
        "receiving_roots_current_fk",
        "receiving_roots_pending_fk",
        "traceability_events_root_fk",
      ].map((conname) => ({ conname, condeferrable: true, condeferred: true })),
    );
    const connection = await fixture.pool.connect();
    const id = randomUUID();
    try {
      await connection.query("BEGIN");
      await connection.query(
        "INSERT INTO receiving_event_roots(id,tenant_id,event_number,pending_draft_id) VALUES ($1,$2,'REC-26-0002',$1)",
        [id, pending.tenant],
      );
      await connection.query(
        "INSERT INTO traceability_events(id,root_event_id,tenant_id,event_number,time_zone,created_by,updated_by) VALUES ($1,$1,$2,'REC-26-0002','America/Chicago','actor','actor')",
        [id, pending.tenant],
      );
      await connection.query("SET CONSTRAINTS ALL IMMEDIATE");
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  });

  async function denied(query: string, values: unknown[], code = "23514") {
    const connection = await fixture.pool.connect();
    try {
      await connection.query("BEGIN");
      await expect(
        (async () => {
          await connection.query(query, values);
          await connection.query("SET CONSTRAINTS ALL IMMEDIATE");
        })(),
      ).rejects.toMatchObject({ code });
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  }

  it("rejects absent, cross-tenant and cross-root pointers", async () => {
    const other = finalized[0];
    if (!other) throw new Error("Missing frozen receipt");
    await denied(
      "UPDATE receiving_event_roots SET pending_draft_id=$1,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
      [other.id, pending.tenant, pending.id],
      "23503",
    );
    await denied(
      "UPDATE receiving_event_roots SET pending_draft_id=$1,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
      [randomUUID(), pending.tenant, pending.id],
      "23503",
    );
    await denied(
      "UPDATE receiving_event_roots SET pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$1 AND id=$2",
      [pending.tenant, pending.id],
    );
    await denied(
      "UPDATE receiving_event_roots SET current_event_id=$1,pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$1",
      [pending.id, pending.tenant],
    );
    const connection = await fixture.pool.connect();
    const second = randomUUID();
    try {
      await connection.query("BEGIN");
      await connection.query(
        "INSERT INTO receiving_event_roots(id,tenant_id,event_number,pending_draft_id) VALUES ($1,$2,'REC-26-0002',$1)",
        [second, pending.tenant],
      );
      await connection.query(
        "INSERT INTO traceability_events(id,root_event_id,tenant_id,event_number,time_zone,created_by,updated_by) VALUES ($1,$1,$2,'REC-26-0002','America/Chicago','actor','actor')",
        [second, pending.tenant],
      );
      await connection.query("SET CONSTRAINTS ALL IMMEDIATE");
      await expect(
        connection.query(
          "UPDATE receiving_event_roots SET pending_draft_id=$1,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
          [second, pending.tenant, pending.id],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  });

  it("does not allow orphan roots, inconsistent numbers or counter regression", async () => {
    await denied(
      "INSERT INTO receiving_event_roots(id,tenant_id,event_number) VALUES ($1,$2,'REC-26-0002')",
      [randomUUID(), pending.tenant],
    );
    await denied(
      "UPDATE receiving_event_roots SET event_number='REC-26-0002' WHERE tenant_id=$1 AND id=$2",
      [pending.tenant, pending.id],
    );
    await denied("UPDATE receiving_event_roots SET next_revision=1 WHERE tenant_id=$1 AND id=$2", [
      pending.tenant,
      pending.id,
    ]);
    await denied("UPDATE receiving_event_roots SET next_revision=3 WHERE tenant_id=$1 AND id=$2", [
      pending.tenant,
      pending.id,
    ]);
    await denied(
      "UPDATE receiving_event_roots SET lifecycle_version=2 WHERE tenant_id=$1 AND id=$2",
      [pending.tenant, pending.id],
    );
    await denied(
      "INSERT INTO receiving_event_roots(id,tenant_id,event_number) VALUES ($1,$2,'REC-26-0001')",
      [randomUUID(), pending.tenant],
      "23505",
    );
    const c = finalized[0];
    if (!c) throw new Error("Missing frozen receipt");
    await denied(
      "UPDATE receiving_event_roots SET lifecycle_version=1 WHERE tenant_id=$1 AND id=$2",
      [c.tenant, c.id],
    );
  });

  it("rejects deleting persisted roots/drafts or rebinding original identity", async () => {
    await denied("DELETE FROM traceability_events WHERE tenant_id=$1 AND id=$2", [
      pending.tenant,
      pending.id,
    ]);
    await denied("DELETE FROM receiving_event_roots WHERE tenant_id=$1 AND id=$2", [
      pending.tenant,
      pending.id,
    ]);
    for (const assignment of [
      "root_event_id=gen_random_uuid()",
      "event_number='REC-26-0002'",
      "time_zone='UTC'",
      "created_by='different'",
      "created_at=created_at+interval '1 second'",
    ])
      await denied(`UPDATE traceability_events SET ${assignment} WHERE tenant_id=$1 AND id=$2`, [
        pending.tenant,
        pending.id,
      ]);
    expect(await history(fixture)).toEqual(before);
  });
});
