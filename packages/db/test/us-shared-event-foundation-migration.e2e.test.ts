import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";
import {
  amendment,
  finalizeAmendment,
  migrateThrough,
  retainedSnapshot,
  voidEvent,
} from "./support/us-receiving-lifecycle-fixture.js";
import {
  seed,
  transition,
  type Fixture,
  type Specimen,
} from "./support/us-receiving-snapshot-fixture.js";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("shared event foundation upgrade", () => {
  let fixture: Fixture;
  let original: Specimen;
  let foreign: Specimen;
  let before: unknown;
  let transformation: string;
  let currentId: ReturnType<typeof randomUUID>;
  let pending: Specimen[];
  let frozenBefore: unknown;
  let guardsBefore: { definition: string }[];
  const guardDefinitions = async () =>
    (
      await fixture.pool.query<{ definition: string }>(
        "SELECT pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('receiving_header_finalization_guard','receiving_header_finalization_v3_guard') ORDER BY proname",
      )
    ).rows;
  async function transaction(action: (tx: PoolClient) => Promise<unknown>) {
    const tx = await fixture.pool.connect();
    try {
      await tx.query("BEGIN");
      await action(tx);
      await tx.query("COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  }
  async function state() {
    return Promise.all(
      [
        "traceability_events",
        "receiving_event_roots",
        "receiving_event_items",
        "receiving_event_documents",
        "receiving_operations",
      ].map(
        async (table) =>
          (
            await fixture.pool.query(
              `SELECT ((to_jsonb(t)-ARRAY['receiving_root_key','transformation_root_key','date_received','event_date']) || CASE WHEN '${table}'='traceability_events' THEN jsonb_build_object('business_date',coalesce(to_jsonb(t)->'event_date',to_jsonb(t)->'date_received')) ELSE '{}'::jsonb END)::text AS exact FROM ${table} t ORDER BY 1`,
            )
          ).rows,
      ),
    );
  }
  async function insert(
    tx: PoolClient,
    tenant: string = original.tenant,
    id: string = randomUUID(),
    root: string = id,
  ) {
    await tx.query(
      "INSERT INTO traceability_events(id,tenant_id,root_event_id,type,event_number,time_zone,created_by,updated_by) VALUES ($1,$2,$3,'transformation','TRN-26-0001','America/Chicago','synthetic','synthetic')",
      [id, tenant, root],
    );
    return id;
  }
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    fixture = await createUsProfileTestDatabase(url, 124);
    original = await seed(fixture);
    foreign = await seed(fixture, "ordinary", 1);
    await transition(fixture, original);
    await transition(fixture, foreign);
    await seed(fixture);
    pending = [await seed(fixture, "ordinary", 1), await seed(fixture)];
    for (const c of pending) {
      c.snapshot.dateReceived = "2024-02-29";
      await fixture.pool.query(
        "UPDATE traceability_events SET date_received='2024-02-29',time_zone='Pacific/Kiritimati' WHERE id=$1",
        [c.id],
      );
    }
    await migrateThrough(fixture, 128);
    await transaction(async (tx) => {
      const id = await amendment(tx, original);
      await finalizeAmendment(tx, original, id);
      currentId = id;
    });
    await fixture.pool.query(
      "INSERT INTO receiving_operations(tenant_id,command,operation_key,input_digest,event_id,result) VALUES ($1,'receiving.create',$2,$3,$4,$5)",
      [original.tenant, randomUUID(), "a".repeat(64), original.id, { saved: "  Exact Ä  " }],
    );
    before = await state();
    frozenBefore = (
      await fixture.pool.query(
        "SELECT id,finalization_snapshot::text AS exact FROM traceability_events ORDER BY id",
      )
    ).rows;
    await migrateThrough(fixture, 129);
    guardsBefore = await guardDefinitions();
    await migrateThrough(fixture, 130);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  it("stores one civil event date and rebinds every active finalization guard", async () => {
    expect(
      (
        await fixture.pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='traceability_events' AND column_name IN ('event_date','date_received')",
        )
      ).rows,
    ).toEqual([{ column_name: "event_date" }]);
    const guards = await guardDefinitions();
    expect(guards).toHaveLength(2);
    expect(guards).toEqual(
      guardsBefore.map(({ definition }) => ({
        definition: definition.replace("NEW.date_received", "NEW.event_date"),
      })),
    );
    for (const guard of guards) {
      expect(guard.definition).toContain("NEW.event_date");
      expect(guard.definition).not.toContain("NEW.date_received");
    }
  });
  it("preserves every pre-existing Receiving row and frozen v1/v2/v3 snapshot", async () => {
    expect(await state()).toEqual(before);
    expect(
      (
        await fixture.pool.query(
          "SELECT id,finalization_snapshot::text AS exact FROM traceability_events ORDER BY id",
        )
      ).rows,
    ).toEqual(frozenBefore);
    expect(
      (
        await fixture.pool.query(
          "SELECT DISTINCT finalization_snapshot->>'snapshotVersion' AS version FROM traceability_events WHERE finalization_snapshot IS NOT NULL ORDER BY 1",
        )
      ).rows,
    ).toEqual([{ version: "1" }, { version: "2" }, { version: "3" }]);
  });
  it("commits an original Transformation draft with a matching deferred root", async () => {
    await transaction(async (tx) => {
      transformation = await insert(tx);
      await tx.query(
        "INSERT INTO transformation_event_roots(id,tenant_id,event_number,pending_draft_id) VALUES ($1,$2,'TRN-26-0001',$1)",
        [transformation, original.tenant],
      );
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT receiving_root_key,transformation_root_key FROM traceability_events WHERE id=$1",
          [transformation],
        )
      ).rows,
    ).toEqual([{ receiving_root_key: null, transformation_root_key: transformation }]);
  });
  it("rejects a missing typed root at commit", async () => {
    let inserted = false;
    await expect(
      transaction(async (tx) => {
        await insert(tx, foreign.tenant);
        inserted = true;
      }),
    ).rejects.toMatchObject({ code: "23503" });
    expect(inserted).toBe(true);
  });
  it("makes all three event root FKs initially deferred", async () => {
    expect(
      (
        await fixture.pool.query(
          "SELECT conname,condeferrable,condeferred FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname",
          [
            [
              "traceability_events_typed_root_fk",
              "traceability_events_receiving_root_fk",
              "traceability_events_transformation_root_fk",
            ],
          ],
        )
      ).rows,
    ).toEqual(
      [
        "traceability_events_receiving_root_fk",
        "traceability_events_transformation_root_fk",
        "traceability_events_typed_root_fk",
      ].map((conname) => ({ conname, condeferrable: true, condeferred: true })),
    );
  });
  it("rejects a second pending Transformation revision", async () => {
    await expect(
      transaction(async (tx) => {
        await insert(tx, original.tenant, randomUUID(), transformation);
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects a typed root with a mismatched event number", async () => {
    await expect(
      transaction(async (tx) => {
        const id = await insert(tx, foreign.tenant);
        await tx.query(
          "INSERT INTO transformation_event_roots(id,tenant_id,event_number,pending_draft_id) VALUES ($1,$2,'TRN-26-9999',$1)",
          [id, foreign.tenant],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects a root pointer without its original draft", async () => {
    const id = randomUUID();
    await expect(
      fixture.pool.query(
        "INSERT INTO transformation_event_roots(id,tenant_id,event_number,pending_draft_id) VALUES ($1,$2,'TRN-26-9999',$1)",
        [id, foreign.tenant],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^235(03|14)$/) });
  });
  it("does not accept writes to generated root keys", async () => {
    await expect(
      fixture.pool.query("UPDATE traceability_events SET receiving_root_key=$1 WHERE id=$2", [
        original.id,
        transformation,
      ]),
    ).rejects.toMatchObject({ code: "428C9" });
  });
  it.each(["cross-type", "cross-tenant"])("enforces the %s self-FK", async (kind) => {
    await expect(
      transaction(async (tx) => {
        await insert(
          tx,
          kind === "cross-tenant" ? foreign.tenant : original.tenant,
          randomUUID(),
          kind === "cross-tenant" ? transformation : original.id,
        );
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it.each(["receiving_event_items", "receiving_event_documents", "receiving_operations"])(
    "rejects a %s attached to Transformation",
    async (table) => {
      const queries = {
        receiving_event_items:
          "INSERT INTO receiving_event_items(tenant_id,event_id,line_no,lot_link_mode,exempt_supplier) VALUES ($1,$2,1,'create_on_finalize',false)",
        receiving_event_documents:
          "INSERT INTO receiving_event_documents(tenant_id,event_id,document_id,position) VALUES ($1,$2,$3,1)",
        receiving_operations:
          "INSERT INTO receiving_operations(tenant_id,event_id,command,operation_key,input_digest,result) VALUES ($1,$2,'receiving.create',gen_random_uuid(),repeat('a',64),'{}')",
      };
      await expect(
        fixture.pool.query(queries[table as keyof typeof queries], [
          original.tenant,
          transformation,
          ...(table === "receiving_event_documents" ? [original.document] : []),
        ]),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^235(03|14)$/) });
    },
  );
  it.each([
    "DELETE FROM traceability_events WHERE id=$1",
    "UPDATE traceability_events SET type='receiving' WHERE id=$1",
    "UPDATE traceability_events SET status='finalized' WHERE id=$1",
    "UPDATE transformation_event_roots SET pending_draft_id=NULL WHERE id=$1",
  ])("rejects unsupported identity/lifecycle mutation: %s", async (query) => {
    await expect(fixture.pool.query(query, [transformation])).rejects.toMatchObject({
      code: "23514",
    });
  });
  it("rejects a second pending Receiving revision and rolls back the allocation", async () => {
    await expect(
      transaction(async (tx) => {
        await amendment(tx, original, currentId, "event_date");
        await amendment(tx, original, currentId, "event_date");
      }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(
      (
        await fixture.pool.query("SELECT pending_draft_id FROM receiving_event_roots WHERE id=$1", [
          original.id,
        ])
      ).rows,
    ).toEqual([{ pending_draft_id: null }]);
  });
  it("keeps Receiving amendment, finalization and void functional with generated keys", async () => {
    await transaction(async (tx) => {
      const id = await amendment(tx, original, currentId, "event_date");
      await tx.query("SAVEPOINT corrupt_date");
      await expect(
        finalizeAmendment(
          tx,
          original,
          id,
          { ...retainedSnapshot(original, currentId), dateReceived: "2024-03-01" },
          currentId,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await tx.query("ROLLBACK TO SAVEPOINT corrupt_date");
      await finalizeAmendment(tx, original, id, retainedSnapshot(original, currentId), currentId);
      await voidEvent(tx, original, id);
    });
  });
  it("creates, saves and voids a fresh Receiving draft beside Transformation", async () => {
    const id = randomUUID();
    await transaction(async (tx) => {
      await tx.query(
        "INSERT INTO receiving_event_roots(id,tenant_id,event_number,pending_draft_id) VALUES ($1,$2,'REC-26-0002',$1)",
        [id, original.tenant],
      );
      await tx.query(
        "INSERT INTO traceability_events(id,tenant_id,root_event_id,event_number,time_zone,created_by,updated_by) VALUES ($1,$2,$1,'REC-26-0002','America/Chicago','synthetic','synthetic')",
        [id, original.tenant],
      );
    });
    await fixture.pool.query(
      "UPDATE traceability_events SET notes='Saved draft',draft_version=draft_version+1 WHERE id=$1",
      [id],
    );
    await transaction(async (tx) => {
      await voidEvent(tx, { ...original, id }, id);
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT status,notes,draft_version,receiving_root_key,transformation_root_key FROM traceability_events WHERE id=$1",
          [id],
        )
      ).rows,
    ).toEqual([
      {
        status: "void",
        notes: "Saved draft",
        draft_version: 2,
        receiving_root_key: id,
        transformation_root_key: null,
      },
    ]);
  });
  it.each([1, 2])("finalizes an existing v%s draft after migration", async (version) => {
    const c = pending[version - 1];
    if (!c) throw new Error("Missing pending fixture");
    await expect(
      transition(fixture, c, { ...c.snapshot, dateReceived: "2024-03-01" }),
    ).rejects.toMatchObject({ code: "23514" });
    await transaction(async (tx) => {
      await tx.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
      expect(
        (
          await tx.query("SELECT event_date::text AS date FROM traceability_events WHERE id=$1", [
            c.id,
          ])
        ).rows,
      ).toEqual([{ date: "2024-02-29" }]);
      await tx.query(
        "UPDATE traceability_events SET status='finalized',finalized_at='2026-09-07T10:00:00Z',updated_at='2026-09-07T10:00:00Z',finalized_by='qa-user',updated_by='qa-user',finalization_snapshot=$1 WHERE id=$2",
        [c.snapshot, c.id],
      );
      await tx.query(
        "UPDATE receiving_event_roots SET current_event_id=$1,pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$1",
        [c.id],
      );
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT finalization_snapshot FROM traceability_events WHERE id=$1",
          [c.id],
        )
      ).rows,
    ).toEqual([{ finalization_snapshot: c.snapshot }]);
  });
});
