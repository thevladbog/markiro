import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";
import {
  seed,
  transition,
  type Fixture,
  type Specimen,
} from "./support/us-receiving-snapshot-fixture.js";
import {
  amendment,
  finalizeAmendment,
  migrateThrough,
  retainedSnapshot,
  voidEvent,
} from "./support/us-receiving-lifecycle-fixture.js";
const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving revision lifecycle storage", () => {
  let f: Fixture;
  let ordinary: Specimen, assigned: Specimen, legacy: Specimen, draft: Specimen;
  let before: unknown;
  let legacyGuards: unknown;
  let lotBytes: unknown;
  const metadata = [
    "previous_revision_id",
    "superseded_by_event_id",
    "amendment_reason",
    "superseded_at",
    "superseded_by",
    "voided_at",
    "voided_by",
    "void_reason",
  ];
  async function history() {
    return (
      await f.pool.query(
        `SELECT e.id,(to_jsonb(e)-$1::text[])::text AS event,
      (SELECT jsonb_agg(to_jsonb(i)-'previous_line_no' ORDER BY line_no)::text FROM receiving_event_items i WHERE tenant_id=e.tenant_id AND event_id=e.id) AS items,
      (SELECT jsonb_agg(to_jsonb(d) ORDER BY position)::text FROM receiving_event_documents d WHERE tenant_id=e.tenant_id AND event_id=e.id) AS documents,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key)::text FROM receiving_operations o WHERE tenant_id=e.tenant_id AND event_id=e.id) AS operations,
      (SELECT to_jsonb(r)::text FROM receiving_event_roots r WHERE tenant_id=e.tenant_id AND id=e.root_event_id) AS root
      FROM traceability_events e ORDER BY id`,
        [metadata],
      )
    ).rows;
  }
  beforeAll(async () => {
    if (!url) throw new Error("Missing synthetic database");
    f = await createUsProfileTestDatabase(url, 124);
    ordinary = await seed(f, "ordinary", 2);
    assigned = await seed(f, "assigned", 2);
    legacy = await seed(f, "ordinary", 1);
    draft = await seed(f, "preserved", 2);
    for (const c of [ordinary, assigned, legacy]) await transition(f, c);
    for (const c of [ordinary, assigned, legacy, draft])
      await f.pool.query(
        "INSERT INTO receiving_operations(tenant_id,command,operation_key,input_digest,event_id,result) VALUES ($1,'receiving.create',$2,$3,$4,$5)",
        [
          c.tenant,
          randomUUID(),
          "b".repeat(64),
          c.id,
          { id: c.id, quantity: "500.000", snapshot: c.snapshot },
        ],
      );
    await migrateThrough(f, 125);
    before = await history();
    legacyGuards = (
      await f.pool.query(
        "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('receiving_header_finalization_guard','receiving_snapshot_v1_shape_valid','receiving_snapshot_v2_shape_valid','receiving_snapshot_v2_common') ORDER BY proname",
      )
    ).rows;
    lotBytes = (
      await f.pool.query("SELECT to_jsonb(l)::text AS bytes FROM traceability_lots l ORDER BY id")
    ).rows;
    await migrate(f.db, { migrationsFolder: resolve("migrations") });
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  async function transaction(run: (tx: PoolClient) => Promise<void>) {
    const tx = await f.pool.connect();
    try {
      await tx.query("BEGIN");
      await run(tx);
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  }
  async function denied(run: (tx: PoolClient) => Promise<unknown>, code = "23514") {
    await transaction(async (tx) => {
      await expect(
        (async () => {
          await run(tx);
          await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
        })(),
      ).rejects.toMatchObject({ code });
    });
  }
  it("adds nullable chain metadata without rewriting roots, historical bytes or receipts", async () => {
    expect(
      (
        await f.pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='traceability_events'",
        )
      ).rows.map((r) => r.column_name),
    ).toEqual(expect.arrayContaining(metadata));
    expect(await history()).toEqual(before);
    expect(
      (
        await f.pool.query(
          "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('receiving_header_finalization_guard','receiving_snapshot_v1_shape_valid','receiving_snapshot_v2_shape_valid','receiving_snapshot_v2_common') ORDER BY proname",
        )
      ).rows,
    ).toEqual(legacyGuards);
    expect(
      (await f.pool.query("SELECT to_jsonb(l)::text AS bytes FROM traceability_lots l ORDER BY id"))
        .rows,
    ).toEqual(lotBytes);
  });
  it("keeps the predecessor current while a draft is pending and never reuses a cancelled revision", async () => {
    await transaction(async (tx) => {
      const a = await amendment(tx, ordinary);
      await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect(
        (
          await tx.query(
            "SELECT current_event_id,pending_draft_id,next_revision,lifecycle_version FROM receiving_event_roots WHERE id=$1",
            [ordinary.id],
          )
        ).rows,
      ).toEqual([
        {
          current_event_id: ordinary.id,
          pending_draft_id: a,
          next_revision: 3,
          lifecycle_version: 3,
        },
      ]);
      await tx.query("SET CONSTRAINTS ALL DEFERRED");
      await voidEvent(tx, ordinary, a);
      const b = await amendment(tx, ordinary);
      await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect(
        (
          await tx.query(
            "SELECT revision,status FROM traceability_events WHERE root_event_id=$1 ORDER BY revision",
            [ordinary.id],
          )
        ).rows,
      ).toEqual([
        { revision: 1, status: "finalized" },
        { revision: 2, status: "void" },
        { revision: 3, status: "draft" },
      ]);
      expect(
        (
          await tx.query(
            "SELECT pending_draft_id,next_revision,lifecycle_version FROM receiving_event_roots WHERE id=$1",
            [ordinary.id],
          )
        ).rows,
      ).toEqual([{ pending_draft_id: b, next_revision: 4, lifecycle_version: 5 }]);
    });
  });
  it("defers both tenant/root-scoped revision foreign keys until transaction completion", async () => {
    expect(
      (
        await f.pool.query(
          "SELECT conname,condeferrable,condeferred FROM pg_constraint WHERE conname IN ('receiving_previous_revision_fk','receiving_superseded_by_fk') ORDER BY conname",
        )
      ).rows,
    ).toEqual([
      { conname: "receiving_previous_revision_fk", condeferrable: true, condeferred: true },
      { conname: "receiving_superseded_by_fk", condeferrable: true, condeferred: true },
    ]);
  });
  it.each(["ordinary", "assigned", "legacy"] as const)(
    "finalizes retained %s identity without rewriting its frozen predecessor or lot",
    async (kind) => {
      const c = { ordinary, assigned, legacy }[kind];
      await transaction(async (tx) => {
        await tx.query("UPDATE traceability_lots SET status='recalled',revision=7 WHERE id=$1", [
          c.lot,
        ]);
        const lot = (
          await tx.query("SELECT to_jsonb(l)::text AS bytes FROM traceability_lots l WHERE id=$1", [
            c.lot,
          ])
        ).rows;
        const previous = (
          await tx.query(
            "SELECT (to_jsonb(e)-ARRAY['status','superseded_by_event_id','superseded_at','superseded_by'])::text AS bytes FROM traceability_events e WHERE id=$1",
            [c.id],
          )
        ).rows;
        const a = await amendment(tx, c);
        await finalizeAmendment(tx, c, a);
        await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
        expect(
          (
            await tx.query(
              "SELECT status,superseded_by_event_id FROM traceability_events WHERE id=$1",
              [c.id],
            )
          ).rows,
        ).toEqual([{ status: "amended", superseded_by_event_id: a }]);
        expect(
          (
            await tx.query(
              "SELECT (to_jsonb(e)-ARRAY['status','superseded_by_event_id','superseded_at','superseded_by'])::text AS bytes FROM traceability_events e WHERE id=$1",
              [c.id],
            )
          ).rows,
        ).toEqual(previous);
        expect(
          (
            await tx.query(
              "SELECT to_jsonb(l)::text AS bytes FROM traceability_lots l WHERE id=$1",
              [c.lot],
            )
          ).rows,
        ).toEqual(lot);
      });
    },
  );
  it.each(["draft", "finalized"] as const)(
    "voids an original %s without fabricating or rewriting frozen content",
    async (status) => {
      const c = status === "draft" ? draft : ordinary;
      await transaction(async (tx) => {
        const frozen = (
          await tx.query(
            "SELECT finalization_snapshot::text AS snapshot,updated_at,updated_by,finalized_at,finalized_by FROM traceability_events WHERE id=$1",
            [c.id],
          )
        ).rows;
        await voidEvent(tx, c, c.id);
        await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
        expect(
          (
            await tx.query(
              "SELECT finalization_snapshot::text AS snapshot,updated_at,updated_by,finalized_at,finalized_by FROM traceability_events WHERE id=$1",
              [c.id],
            )
          ).rows,
        ).toEqual(frozen);
        expect(
          (
            await tx.query(
              "SELECT current_event_id,pending_draft_id FROM receiving_event_roots WHERE id=$1",
              [c.id],
            )
          ).rows,
        ).toEqual([{ current_event_id: null, pending_draft_id: null }]);
      });
    },
  );
  it.each([
    "lot_id=gen_random_uuid()",
    "tlc='different'",
    "product_id=gen_random_uuid()",
    "lot_link_mode='link_existing'",
    "source_location_id=NULL",
    "exempt_supplier=true",
  ])("rejects retained identity mutation %s", async (change) => {
    await denied(async (tx) => {
      const a = await amendment(tx, ordinary);
      await tx.query(`UPDATE receiving_event_items SET ${change} WHERE event_id=$1`, [a]);
    });
  });
  it.each([
    "status='draft'",
    "notes='rewrite'",
    "finalization_snapshot='{}'",
    "finalized_by='other'",
    "updated_by='other'",
  ])("rejects mutation of terminal history: %s", async (change) => {
    await denied(async (tx) => {
      await voidEvent(tx, ordinary, ordinary.id);
      await tx.query(`UPDATE traceability_events SET ${change} WHERE id=$1`, [ordinary.id]);
    });
  });
  it("rejects voiding a current predecessor with a pending amendment", async () => {
    await denied(async (tx) => {
      await amendment(tx, ordinary);
      await voidEvent(tx, ordinary, ordinary.id);
    });
  });
  it("rejects a second pending draft", async () => {
    await denied(async (tx) => {
      await amendment(tx, ordinary);
      await amendment(tx, ordinary);
    }, "23505");
  });
  it("rejects foreign-root predecessor and forged allocation", async () => {
    await denied(async (tx) => {
      await amendment(tx, ordinary);
      await tx.query(
        "UPDATE traceability_events SET previous_revision_id=$1 WHERE root_event_id=$2 AND revision=2",
        [assigned.id, ordinary.id],
      );
    });
    await denied(async (tx) => {
      await tx.query("UPDATE receiving_event_roots SET next_revision=next_revision+1 WHERE id=$1", [
        ordinary.id,
      ]);
    });
  });
  it.each(["wrong_event", "wrong_line", "duplicate", "missing", "legacy_snapshot", "new_binding"])(
    "rejects forged frozen binding %s",
    async (mutation) => {
      await denied(async (tx) => {
        const a = await amendment(tx, ordinary);
        const snapshot = retainedSnapshot(ordinary);
        const first = snapshot.items[0];
        if (!first) throw new Error("Missing item");
        const bad =
          mutation === "legacy_snapshot"
            ? ordinary.snapshot
            : {
                ...snapshot,
                items:
                  mutation === "duplicate"
                    ? [first, first]
                    : [
                        {
                          ...first,
                          lotBinding:
                            mutation === "wrong_event"
                              ? { ...first.lotBinding, previousEventId: assigned.id }
                              : mutation === "wrong_line"
                                ? { ...first.lotBinding, previousLineNo: 2 }
                                : mutation === "new_binding"
                                  ? { kind: "created" }
                                  : null,
                        },
                      ],
              };
        await finalizeAmendment(tx, ordinary, a, bad);
      });
    },
  );
  it("rolls all schema changes back after a late migration failure and permits a clean retry", async () => {
    if (!url) throw new Error("Missing synthetic database");
    const g = await createUsProfileTestDatabase(url, 124);
    try {
      const c = await seed(g, "assigned", 2);
      await transition(g, c);
      await migrateThrough(g, 125);
      const before = (
        await g.pool.query("SELECT to_jsonb(e)::text AS bytes FROM traceability_events e")
      ).rows;
      await g.pool.query(
        "CREATE FUNCTION receiving_snapshot_v3_common(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT value $$",
      );
      await expect(
        migrate(g.db, { migrationsFolder: resolve("migrations") }),
      ).rejects.toMatchObject({ cause: { code: "42723" } });
      expect(
        (await g.pool.query("SELECT to_jsonb(e)::text AS bytes FROM traceability_events e")).rows,
      ).toEqual(before);
      expect(
        (
          await g.pool.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name='traceability_events' AND column_name='previous_revision_id'",
          )
        ).rows,
      ).toEqual([]);
      await g.pool.query("DROP FUNCTION receiving_snapshot_v3_common(jsonb)");
      await migrate(g.db, { migrationsFolder: resolve("migrations") });
      expect(
        (
          await g.pool.query(
            "SELECT previous_revision_id,finalization_snapshot FROM traceability_events WHERE id=$1",
            [c.id],
          )
        ).rows,
      ).toEqual([{ previous_revision_id: null, finalization_snapshot: c.snapshot }]);
    } finally {
      await g.close();
    }
  }, 60_000);
  it.each(["quantity='12.000'", "lot_id=gen_random_uuid()", "previous_line_no=NULL"])(
    "rejects frozen child mutation after supersession: %s",
    async (change) => {
      await denied(async (tx) => {
        const a = await amendment(tx, ordinary);
        await finalizeAmendment(tx, ordinary, a);
        await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
        await tx.query(`UPDATE receiving_event_items SET ${change} WHERE event_id=$1`, [
          ordinary.id,
        ]);
      });
    },
  );
  it.each(["unreviewed", "wrong_actor", "old_review", "changed_received", "changed_handling"])(
    "rejects retained own-assignment corruption: %s",
    async (mutation) => {
      await denied(async (tx) => {
        const a = await amendment(tx, assigned);
        const snapshot = retainedSnapshot(assigned);
        const first = snapshot.items[0];
        if (!first) throw new Error("Missing item");
        if (mutation === "changed_received")
          await tx.query("UPDATE receiving_event_items SET tlc='new' WHERE event_id=$1", [a]);
        if (mutation === "changed_handling")
          await tx.query(
            'UPDATE receiving_event_items SET exempt_receipt=exempt_receipt || \'{"tlcHandling":"preserve_existing"}\'::jsonb WHERE event_id=$1',
            [a],
          );
        const bad = {
          ...snapshot,
          confirmation:
            mutation === "unreviewed"
              ? { ...snapshot.confirmation, reviewedExemptLines: [] }
              : snapshot.confirmation,
          items: [
            {
              ...first,
              receiptBasis: {
                ...first.receiptBasis,
                ...(mutation === "wrong_actor" ? { reviewedBy: "other" } : {}),
                ...(mutation === "old_review" ? { reviewedAt: "2026-09-07T10:00:00.000Z" } : {}),
              },
            },
          ],
        };
        await finalizeAmendment(tx, assigned, a, bad);
      });
    },
  );
  it("does not accept unbound new-use lines for recalled lots", async () => {
    for (const c of [ordinary, assigned])
      await denied(async (tx) => {
        await tx.query("UPDATE traceability_lots SET status='recalled',revision=7 WHERE id=$1", [
          c.lot,
        ]);
        const a = await amendment(tx, c);
        await tx.query("UPDATE receiving_event_items SET previous_line_no=NULL WHERE event_id=$1", [
          a,
        ]);
        const snapshot = retainedSnapshot(c);
        await finalizeAmendment(tx, c, a, {
          ...snapshot,
          items: snapshot.items.map((item) => ({ ...item, lotBinding: { kind: "created" } })),
        });
      });
  });
  it("rejects an unbound own assignment whose active lot has already advanced", async () => {
    await denied(async (tx) => {
      await tx.query("UPDATE traceability_lots SET revision=7 WHERE id=$1", [assigned.lot]);
      const a = await amendment(tx, assigned);
      await tx.query("UPDATE receiving_event_items SET previous_line_no=NULL WHERE event_id=$1", [
        a,
      ]);
      const snapshot = retainedSnapshot(assigned);
      await finalizeAmendment(tx, assigned, a, {
        ...snapshot,
        items: snapshot.items.map((item) => ({ ...item, lotBinding: { kind: "created" } })),
      });
    });
  });
  it.each(["created", "linked", "assigned"])("accepts a valid unbound v3 %s path", async (kind) => {
    await transaction(async (tx) => {
      const c = kind === "assigned" ? assigned : ordinary;
      const a = await amendment(tx, c);
      const mode = kind === "linked" ? "link_existing" : "create_on_finalize";
      await tx.query(
        "UPDATE receiving_event_items SET previous_line_no=NULL,lot_link_mode=$1 WHERE event_id=$2",
        [mode, a],
      );
      const snapshot = retainedSnapshot(c);
      await finalizeAmendment(tx, c, a, {
        ...snapshot,
        items: snapshot.items.map((item) => ({
          ...item,
          lotLinkMode: mode,
          lotBinding: { kind: kind === "linked" ? "linked" : "created" },
        })),
      });
      await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
  });
  it("permits original v3 finalization without a predecessor", async () => {
    await transaction(async (tx) => {
      const snapshot = retainedSnapshot(draft);
      await tx.query(
        "UPDATE traceability_events SET status='finalized',finalized_at='2026-09-07T11:00:00Z',updated_at='2026-09-07T11:00:00Z',finalized_by='qa-user',updated_by='qa-user',finalization_snapshot=$1 WHERE id=$2",
        [
          {
            ...snapshot,
            items: snapshot.items.map((item) => ({ ...item, lotBinding: { kind: "created" } })),
          },
          draft.id,
        ],
      );
      await tx.query(
        "UPDATE receiving_event_roots SET current_event_id=$1,pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$1",
        [draft.id],
      );
      await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
  });
  it("preserves a multi-revision chain after voiding its latest finalized revision", async () => {
    await transaction(async (tx) => {
      const a = await amendment(tx, ordinary);
      await finalizeAmendment(tx, ordinary, a);
      const b = await amendment(tx, ordinary, a);
      await finalizeAmendment(tx, ordinary, b, retainedSnapshot(ordinary, a), a);
      await voidEvent(tx, ordinary, b);
      await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect(
        (
          await tx.query(
            "SELECT revision,status,previous_revision_id,superseded_by_event_id FROM traceability_events WHERE root_event_id=$1 ORDER BY revision",
            [ordinary.id],
          )
        ).rows,
      ).toEqual([
        { revision: 1, status: "amended", previous_revision_id: null, superseded_by_event_id: a },
        {
          revision: 2,
          status: "amended",
          previous_revision_id: ordinary.id,
          superseded_by_event_id: b,
        },
        { revision: 3, status: "void", previous_revision_id: a, superseded_by_event_id: null },
      ]);
      expect(
        (
          await tx.query(
            "SELECT current_event_id,pending_draft_id,next_revision,lifecycle_version FROM receiving_event_roots WHERE id=$1",
            [ordinary.id],
          )
        ).rows,
      ).toEqual([
        { current_event_id: null, pending_draft_id: null, next_revision: 4, lifecycle_version: 7 },
      ]);
    });
  });
  it.each([
    "UPDATE receiving_event_roots SET current_event_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$1",
    "UPDATE traceability_events SET status='void',voided_at=now(),voided_by='qa-user',void_reason='Wrong row',notes='hidden edit' WHERE id=$1",
    "DELETE FROM traceability_events WHERE id=$1",
    "DELETE FROM receiving_event_roots WHERE id=$1",
  ])("rejects a raw history bypass: %s", async (query) => {
    await denied((tx) => tx.query(query, [ordinary.id]));
  });
  it("rejects a successor whose predecessor was not superseded", async () => {
    await denied(async (tx) => {
      const a = await amendment(tx, ordinary);
      await tx.query(
        "UPDATE traceability_events SET status='finalized',finalized_at='2026-09-07T11:00:00Z',updated_at='2026-09-07T11:00:00Z',finalized_by='qa-user',updated_by='qa-user',finalization_snapshot=$1 WHERE id=$2",
        [retainedSnapshot(ordinary), a],
      );
    }, "23505");
  });
  it("retains the assigned source when changing only the receiving location", async () => {
    await transaction(async (tx) => {
      const site = randomUUID();
      await tx.query(
        "INSERT INTO traceability_locations SELECT (jsonb_populate_record(NULL::traceability_locations,to_jsonb(l)||jsonb_build_object('id',$1::text))).* FROM traceability_locations l WHERE id=$2",
        [site, assigned.location],
      );
      const a = await amendment(tx, assigned);
      await tx.query("UPDATE traceability_events SET location_id=$1 WHERE id=$2", [site, a]);
      const snapshot = retainedSnapshot(assigned);
      await finalizeAmendment(tx, assigned, a, {
        ...snapshot,
        locationId: site,
        locationDescription: { ...snapshot.locationDescription, locationId: site },
      });
      await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect(
        (
          await tx.query("SELECT source_location_id FROM traceability_lots WHERE id=$1", [
            assigned.lot,
          ])
        ).rows,
      ).toEqual([{ source_location_id: assigned.location }]);
    });
  });
});
