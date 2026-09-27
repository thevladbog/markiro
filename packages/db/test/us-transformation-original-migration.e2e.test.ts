import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";
import {
  amendment,
  finalizeAmendment,
  migrateThrough,
} from "./support/us-receiving-lifecycle-fixture.js";
import {
  seed,
  transition,
  type Fixture,
  type Specimen,
} from "./support/us-receiving-snapshot-fixture.js";

const url = process.env.US_TEST_DATABASE_URL;
const frozenCoverage = {
  coverageStatus: "covered",
  coverageRationale: "Reviewed raw fixture",
  ftlCategory: "Fresh-cut fruits",
  ftlSourceUrl: "https://www.fda.gov/food/food-traceability-list",
  ftlSourceVersion: "2026",
  reviewedBy: "qa-reviewer",
  reviewedAt: "2026-09-06T09:08:07.123Z",
};
describe.skipIf(!url)("Transformation original storage", () => {
  let f: Fixture, c: Specimen, foreign: Specimen;
  let before: unknown;
  let guardsBefore: unknown;
  const receivingGuards = async () =>
    (
      await f.pool.query(
        "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname LIKE 'receiving_%guard' ORDER BY proname",
      )
    ).rows;
  async function tx<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await f.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const retained = async () =>
    Promise.all(
      [
        "traceability_events",
        "receiving_event_roots",
        "receiving_event_items",
        "receiving_event_documents",
      ].map(
        async (table) =>
          (await f.pool.query(`SELECT to_jsonb(t)::text AS exact FROM ${table} t ORDER BY 1`)).rows,
      ),
    );
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url, 124);
    c = await seed(f);
    foreign = await seed(f, "ordinary", 1);
    await transition(f, c);
    await transition(f, foreign);
    await migrateThrough(f, 128);
    await tx(async (client) => {
      const id = await amendment(client, c);
      await finalizeAmendment(client, c, id);
    });
    await migrateThrough(f, 130);
    before = await retained();
    guardsBefore = await receivingGuards();
    await migrateThrough(f, 131);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  async function draft(client: PoolClient, referenceInput = false) {
    const id = randomUUID(),
      out = randomUUID();
    await client.query(
      "INSERT INTO product_traceability_profiles(tenant_id,product_id,product_name,coverage_status,coverage_rationale,ftl_category,ftl_source_url,ftl_source_version,reviewed_by,reviewed_at) VALUES ($1,$2,'Apple slices','covered',$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
      [
        c.tenant,
        c.product,
        frozenCoverage.coverageRationale,
        frozenCoverage.ftlCategory,
        frozenCoverage.ftlSourceUrl,
        frozenCoverage.ftlSourceVersion,
        frozenCoverage.reviewedBy,
        frozenCoverage.reviewedAt,
      ],
    );
    const inputLot = referenceInput ? randomUUID() : c.lot;
    const sourceReference = "https://supplier.example.test/source/Ä?lot=001";
    if (referenceInput)
      await client.query(
        "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_reference_kind,source_reference_value,source_reference_location_id,source_locked_at,created_by,updated_by) VALUES ($1,$2,$3,$1::uuid::text,'imported','web_url',$4,$5,now(),'qa-user','qa-user')",
        [inputLot, c.tenant, c.product, sourceReference, c.location],
      );
    await client.query(
      "INSERT INTO traceability_events(id,tenant_id,root_event_id,type,event_number,time_zone,event_date,location_id,created_by,updated_by) VALUES ($1,$2,$1,'transformation',$3,'America/Chicago','2026-09-07',$4,'qa-user','qa-user')",
      [id, c.tenant, `TRN-26-${Math.floor(Math.random() * 1e9) + 1000}`, c.location],
    );
    await client.query(
      "INSERT INTO transformation_event_roots(id,tenant_id,event_number,pending_draft_id) SELECT id,tenant_id,event_number,id FROM traceability_events WHERE id=$1",
      [id],
    );
    await client.query(
      "INSERT INTO transformation_event_details(tenant_id,event_id,reason) VALUES ($1,$2,'repacking')",
      [c.tenant, id],
    );
    await client.query(
      "INSERT INTO transformation_event_inputs(tenant_id,event_id,line_no,kind,lot_id,quantity,unit_of_measure) VALUES ($1,$2,1,'ftl_lot',$3,'500.000','lb')",
      [c.tenant, id, inputLot],
    );
    await client.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_location_id,source_locked_at,created_by,updated_by) VALUES ($1,$2,$3,$1::uuid::text,'transformation',$4,now(),'qa-user','qa-user')",
      [out, c.tenant, c.product, c.location],
    );
    await client.query(
      "INSERT INTO transformation_event_outputs(tenant_id,event_id,line_no,lot_id,product_id,tlc,quantity,unit_of_measure) VALUES ($1,$2,1,$3,$4,$3::uuid::text,'100','case')",
      [c.tenant, id, out, c.product],
    );
    await client.query(
      "INSERT INTO transformation_event_documents(tenant_id,event_id,document_id,position) VALUES ($1,$2,$3,1)",
      [c.tenant, id, c.document],
    );
    await client.query(
      "INSERT INTO lot_genealogy_edges(tenant_id,event_id,input_lot_id,output_lot_id) VALUES ($1,$2,$3,$4)",
      [c.tenant, id, inputLot, out],
    );
    const location = { id: c.location, description: "Dock" };
    return {
      id,
      out,
      snapshot: {
        snapshotVersion: 1,
        eventId: id,
        eventNumber: (
          await client.query("SELECT event_number FROM traceability_events WHERE id=$1", [id])
        ).rows[0].event_number,
        revision: 1,
        eventDate: "2026-09-07",
        timeZone: "America/Chicago",
        processor: location,
        reason: "repacking",
        reasonNote: null,
        notes: null,
        inputs: [
          {
            kind: "ftl_lot",
            lineNo: 1,
            lotId: inputLot,
            product: {
              id: c.product,
              description: "Apple slices",
              coverage: { ...frozenCoverage },
            },
            tlc: referenceInput ? inputLot : "=Case/Ä-001",
            source: referenceInput
              ? {
                  ...location,
                  kind: "reference",
                  referenceKind: "web_url",
                  referenceValue: sourceReference,
                }
              : { ...location, kind: "location" },
            quantity: "500.000",
            unitOfMeasure: "lb",
          },
        ],
        outputs: [
          {
            lineNo: 1,
            lotId: out,
            product: {
              id: c.product,
              description: "Apple slices",
              coverage: { ...frozenCoverage },
            },
            tlc: out,
            source: { ...location, kind: "location" },
            quantity: "100",
            unitOfMeasure: "case",
          },
        ],
        documents: [{ id: c.document, type: "bol", number: "0001" }],
        finalizedBy: "qa-user",
        finalizedAt: "2026-09-07T10:00:00.000Z",
      },
    };
  }
  async function finalize(client: PoolClient, id: string, snapshot: unknown, pointers = true) {
    await client.query(
      "UPDATE traceability_events SET status='finalized',finalized_at='2026-09-07T10:00:00Z',updated_at='2026-09-07T10:00:00Z',finalized_by='qa-user',updated_by='qa-user',finalization_snapshot=$2 WHERE id=$1",
      [id, snapshot],
    );
    if (pointers)
      await client.query(
        "UPDATE transformation_event_roots SET current_event_id=id,pending_draft_id=NULL,lifecycle_version=2 WHERE id=$1",
        [id],
      );
  }
  it("preserves Receiving v1/v2/v3 rows and frozen bytes", async () => {
    expect(await retained()).toEqual(before);
    expect(await receivingGuards()).toEqual(guardsBefore);
    expect(
      (
        await f.pool.query(
          "SELECT DISTINCT finalization_snapshot->>'snapshotVersion' AS v FROM traceability_events ORDER BY v",
        )
      ).rows,
    ).toEqual([{ v: "1" }, { v: "2" }, { v: "3" }]);
  });
  it("creates all seven typed relations on upgrade", async () => {
    for (const name of [
      "transformation_event_details",
      "transformation_event_inputs",
      "transformation_event_outputs",
      "transformation_event_documents",
      "transformation_counters",
      "transformation_operations",
      "lot_genealogy_edges",
    ])
      expect((await f.pool.query("SELECT to_regclass($1)::text AS name", [name])).rows).toEqual([
        { name },
      ]);
  });
  it("migrates an empty database through 0131 with deferred roots and typed tenant FKs", async () => {
    if (!url) throw new Error("Missing isolated URL");
    const fresh = await createUsProfileTestDatabase(url);
    try {
      const tables = (
        await fresh.pool.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'transformation_%' OR tablename='lot_genealogy_edges') ORDER BY 1",
        )
      ).rows;
      expect(tables).toHaveLength(8);
      expect(
        (
          await fresh.pool.query(
            "SELECT conname,condeferrable,condeferred FROM pg_constraint WHERE conname IN ('transformation_roots_current_fk','transformation_roots_pending_fk','traceability_events_transformation_root_fk') ORDER BY conname",
          )
        ).rows,
      ).toEqual(
        [
          "traceability_events_transformation_root_fk",
          "transformation_roots_current_fk",
          "transformation_roots_pending_fk",
        ].map((conname) => ({ conname, condeferrable: true, condeferred: true })),
      );
      expect(
        (
          await fresh.pool.query(
            "SELECT tgname,tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgname='transformation_finalization_guard'",
          )
        ).rows,
      ).toEqual([
        { tgname: "transformation_finalization_guard", tgdeferrable: true, tginitdeferred: true },
      ]);
      const active = (
        await fresh.pool.query(
          "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('transformation_root_identity_guard','transformation_root_consistency_guard','transformation_child_write_guard','transformation_finalization_guard') ORDER BY proname",
        )
      ).rows;
      expect(active).toHaveLength(4);
    } finally {
      await fresh.close();
    }
  }, 60_000);
  it("retains incomplete drafts and one immutable result per command operation key", async () => {
    let id = "";
    const key = randomUUID();
    await tx(async (client) => {
      const d = await draft(client);
      id = d.id;
      await client.query("DELETE FROM lot_genealogy_edges WHERE event_id=$1", [id]);
      await client.query(
        "UPDATE transformation_event_outputs SET lot_id=NULL,product_id=NULL,tlc=NULL,quantity=NULL,unit_of_measure=NULL WHERE event_id=$1",
        [id],
      );
      await client.query(
        "UPDATE transformation_event_inputs SET lot_id=NULL,quantity=NULL,unit_of_measure=NULL WHERE event_id=$1",
        [id],
      );
      await client.query(
        "INSERT INTO transformation_operations(tenant_id,event_id,command,operation_key,input_digest,result) VALUES ($1,$2,'transformation.create',$3,repeat('a',64),'{\"retained\":true}')",
        [c.tenant, id, key],
      );
    });
    await expect(
      f.pool.query(
        "INSERT INTO transformation_operations(tenant_id,event_id,command,operation_key,input_digest,result) VALUES ($1,$2,'transformation.create',$3,repeat('b',64),'{}')",
        [c.tenant, id, key],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    for (const action of [
      "UPDATE transformation_operations SET result='{}'",
      "DELETE FROM transformation_operations",
    ])
      await expect(f.pool.query(`${action} WHERE operation_key=$1`, [key])).rejects.toMatchObject({
        code: "23514",
      });
    expect(
      (
        await f.pool.query("SELECT result FROM transformation_operations WHERE operation_key=$1", [
          key,
        ])
      ).rows,
    ).toEqual([{ result: { retained: true } }]);
  });
  it.each([
    "transformation_event_details",
    "transformation_event_inputs",
    "transformation_event_outputs",
    "transformation_event_documents",
    "lot_genealogy_edges",
  ])("rejects a wrong-type parent for %s", async (table) => {
    await expect(
      tx(async (client) => {
        const d = await draft(client);
        await client.query(`UPDATE ${table} SET event_id=$1 WHERE event_id=$2`, [c.id, d.id]);
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^235(03|14)$/) });
  });
  it("rejects a wrong-type operation parent", async () => {
    await expect(
      f.pool.query(
        "INSERT INTO transformation_operations(tenant_id,event_id,command,operation_key,input_digest,result) VALUES ($1,$2,'transformation.create',gen_random_uuid(),repeat('a',64),'{}')",
        [c.tenant, c.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("commits complete evidence and prohibits all finalized rewrites", async () => {
    let id = "";
    await tx(async (client) => {
      const d = await draft(client);
      id = d.id;
      await finalize(client, id, d.snapshot);
    });
    for (const table of [
      "traceability_events",
      "transformation_event_details",
      "transformation_event_inputs",
      "transformation_event_outputs",
      "transformation_event_documents",
      "lot_genealogy_edges",
    ]) {
      const key = table === "traceability_events" ? "id" : "event_id";
      await expect(
        f.pool.query(`DELETE FROM ${table} WHERE ${key}=$1`, [id]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        f.pool.query(`UPDATE ${table} SET tenant_id=tenant_id WHERE ${key}=$1`, [id]),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
  it.each(["input-coverage", "output-coverage", "input-source-kind"])(
    "rejects missing frozen %s at commit",
    async (field) => {
      let reachedCommit = false;
      await expect(
        tx(async (client) => {
          const d = await draft(client);
          if (field === "input-source-kind")
            Reflect.deleteProperty(d.snapshot.inputs[0]?.source ?? {}, "kind");
          else
            Reflect.deleteProperty(
              (field === "input-coverage" ? d.snapshot.inputs : d.snapshot.outputs)[0]?.product ??
                {},
              "coverage",
            );
          await finalize(client, d.id, d.snapshot);
          reachedCommit = true;
        }),
      ).rejects.toMatchObject({ code: "23514" });
      expect(reachedCommit).toBe(true);
    },
  );
  it("commits a reference identity and exact reviewed coverage without consulting later review changes", async () => {
    const d = await tx(async (client) => {
      const value = await draft(client, true);
      await finalize(client, value.id, value.snapshot);
      return value;
    });
    expect(d.snapshot.inputs[0]?.source).toEqual({
      id: c.location,
      description: "Dock",
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: "https://supplier.example.test/source/Ä?lot=001",
    });
    await f.pool.query(
      "UPDATE product_traceability_profiles SET coverage_rationale='Later review' WHERE tenant_id=$1 AND product_id=$2",
      [c.tenant, c.product],
    );
    try {
      expect(
        (
          await f.pool.query(
            "SELECT finalization_snapshot FROM traceability_events WHERE tenant_id=$1 AND id=$2",
            [c.tenant, d.id],
          )
        ).rows,
      ).toEqual([{ finalization_snapshot: d.snapshot }]);
    } finally {
      await f.pool.query(
        "UPDATE product_traceability_profiles SET coverage_rationale=$3 WHERE tenant_id=$1 AND product_id=$2",
        [c.tenant, c.product, frozenCoverage.coverageRationale],
      );
    }
  });
  it.each(["inputs", "outputs"] as const)(
    "rejects every forged reviewed coverage field in %s at commit",
    async (side) => {
      for (const [field, wrong] of Object.entries({
        coverageStatus: "not_covered",
        coverageRationale: "invented",
        ftlCategory: "wrong category",
        ftlSourceUrl: "https://other.example.test/ftl",
        ftlSourceVersion: "wrong version",
        reviewedBy: "different-reviewer",
        reviewedAt: "2026-09-06T09:08:08.123Z",
      })) {
        let reachedCommit = false;
        await expect(
          tx(async (client) => {
            const d = await draft(client);
            Reflect.set(d.snapshot[side][0]?.product.coverage ?? {}, field, wrong);
            await finalize(client, d.id, d.snapshot);
            reachedCommit = true;
          }),
        ).rejects.toMatchObject({ code: "23514" });
        expect(reachedCommit, field).toBe(true);
      }
    },
  );
  it.each(["kind", "referenceKind", "referenceValue"])(
    "rejects a forged reference source %s at commit",
    async (field) => {
      let reachedCommit = false;
      await expect(
        tx(async (client) => {
          const d = await draft(client, true);
          Reflect.set(
            d.snapshot.inputs[0]?.source ?? {},
            field,
            field === "referenceValue" ? "https://other.example.test/source" : "wrong-kind",
          );
          await finalize(client, d.id, d.snapshot);
          reachedCommit = true;
        }),
      ).rejects.toMatchObject({ code: "23514" });
      expect(reachedCommit).toBe(true);
    },
  );
  it("rejects a frozen review superseded in relational data before commit", async () => {
    let reachedCommit = false;
    await expect(
      tx(async (client) => {
        const d = await draft(client);
        await client.query(
          "UPDATE product_traceability_profiles SET ftl_source_version='Changed before finalization' WHERE tenant_id=$1 AND product_id=$2",
          [c.tenant, c.product],
        );
        await finalize(client, d.id, d.snapshot);
        reachedCommit = true;
      }),
    ).rejects.toMatchObject({ code: "23514" });
    expect(reachedCommit).toBe(true);
  });
  it("rejects a new genealogy edge attached to a finalized parent", async () => {
    const d = await tx(async (client) => {
      const value = await draft(client);
      await finalize(client, value.id, value.snapshot);
      return value;
    });
    // Reverse direction is a distinct, tenant-valid pair, not a duplicate-key failure.
    await expect(
      f.pool.query(
        "INSERT INTO lot_genealogy_edges(tenant_id,event_id,input_lot_id,output_lot_id) VALUES ($1,$2,$3,$4)",
        [c.tenant, d.id, d.out, c.lot],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await f.pool.query(
          "SELECT input_lot_id,output_lot_id FROM lot_genealogy_edges WHERE event_id=$1",
          [d.id],
        )
      ).rows,
    ).toEqual([{ input_lot_id: c.lot, output_lot_id: d.out }]);
  });
  it("rejects actual rewrites of finalized snapshots, children, root pointers and genealogy", async () => {
    const d = await tx(async (client) => {
      const value = await draft(client);
      await finalize(client, value.id, value.snapshot);
      return value;
    });
    for (const query of [
      "UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot,'{reason}',to_jsonb('processing'::text)) WHERE id=$1",
      "UPDATE traceability_events SET event_date='2026-09-08' WHERE id=$1",
      "UPDATE transformation_event_details SET reason='processing' WHERE event_id=$1",
      "UPDATE transformation_event_inputs SET quantity='499' WHERE event_id=$1",
      "UPDATE transformation_event_outputs SET quantity='99' WHERE event_id=$1",
      "UPDATE transformation_event_documents SET position=2 WHERE event_id=$1",
      "UPDATE lot_genealogy_edges SET input_lot_id=output_lot_id,output_lot_id=input_lot_id WHERE event_id=$1",
      "UPDATE transformation_event_roots SET current_event_id=NULL,pending_draft_id=id,lifecycle_version=1 WHERE id=$1",
    ])
      await expect(f.pool.query(query, [d.id])).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await f.pool.query(
          "SELECT status,finalization_snapshot FROM traceability_events WHERE id=$1",
          [d.id],
        )
      ).rows,
    ).toEqual([{ status: "finalized", finalization_snapshot: d.snapshot }]);
    expect(
      (
        await f.pool.query(
          "SELECT input_lot_id,output_lot_id FROM lot_genealogy_edges WHERE event_id=$1",
          [d.id],
        )
      ).rows,
    ).toEqual([{ input_lot_id: c.lot, output_lot_id: d.out }]);
  });
  it.each(["finalizer-first", "child-first"] as const)(
    "serializes concurrent child writes and finalization: %s",
    async (order) => {
      const d = await tx(draft);
      const writer = await f.pool.connect();
      const waiter = await f.pool.connect();
      let pending: Promise<{ success: true } | { success: false; error: unknown }> | undefined;
      try {
        await writer.query("BEGIN");
        await waiter.query("BEGIN");
        await waiter.query("SET LOCAL statement_timeout='5s'");
        const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        const waiterPid = (await waiter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        if (!writerPid || !waiterPid) throw new Error("Missing concurrent backend identity");
        const changeQuantity = (client: PoolClient) =>
          client.query(
            "UPDATE transformation_event_inputs SET quantity='499' WHERE tenant_id=$1 AND event_id=$2",
            [c.tenant, d.id],
          );
        if (order === "finalizer-first") await finalize(writer, d.id, d.snapshot);
        else await changeQuantity(writer);
        pending = (async () => {
          if (order === "finalizer-first") await changeQuantity(waiter);
          else await finalize(waiter, d.id, d.snapshot);
          await waiter.query("COMMIT");
        })().then(
          () => ({ success: true as const }),
          (error: unknown) => ({ success: false as const, error }),
        );
        // Observe the actual lock dependency instead of inferring blocking from a delay.
        await expect
          .poll(
            async () =>
              (
                await f.pool.query<{ blockers: number[] }>(
                  "SELECT pg_blocking_pids($1) AS blockers",
                  [waiterPid],
                )
              ).rows[0]?.blockers,
            { timeout: 2_000 },
          )
          .toContain(writerPid);
        await writer.query("COMMIT");
        expect(await pending).toMatchObject({ success: false, error: { code: "23514" } });
        const actual = (
          await f.pool.query(
            "SELECT e.status,i.quantity,e.finalization_snapshot FROM traceability_events e JOIN transformation_event_inputs i ON i.tenant_id=e.tenant_id AND i.event_id=e.id WHERE e.id=$1",
            [d.id],
          )
        ).rows;
        expect(actual).toEqual(
          order === "finalizer-first"
            ? [{ status: "finalized", quantity: "500.000", finalization_snapshot: d.snapshot }]
            : [{ status: "draft", quantity: "499", finalization_snapshot: null }],
        );
      } finally {
        await writer.query("ROLLBACK");
        await pending;
        await waiter.query("ROLLBACK");
        writer.release();
        waiter.release();
      }
    },
    10_000,
  );
  it.each([
    "pointers",
    "date",
    "location",
    "snapshot",
    "quantity",
    "reason",
    "input",
    "output",
    "documents",
    "detail",
    "edges",
  ])("rejects incomplete or mismatched %s at commit", async (kind) => {
    await expect(
      tx(async (client) => {
        const d = await draft(client);
        if (kind === "date" || kind === "location")
          await client.query(
            `UPDATE traceability_events SET ${kind === "date" ? "event_date" : "location_id"}=NULL WHERE id=$1`,
            [d.id],
          );
        if (kind === "quantity")
          d.snapshot.inputs = d.snapshot.inputs.map((input) => ({ ...input, quantity: "499" }));
        if (kind === "reason") d.snapshot.reason = "processing";
        const table = {
          input: "transformation_event_inputs",
          output: "transformation_event_outputs",
          documents: "transformation_event_documents",
          detail: "transformation_event_details",
          edges: "lot_genealogy_edges",
        }[kind];
        if (table) await client.query(`DELETE FROM ${table} WHERE event_id=$1`, [d.id]);
        await finalize(client, d.id, kind === "snapshot" ? {} : d.snapshot, kind !== "pointers");
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it.each([
    "eventId",
    "eventDate",
    "timeZone",
    "reasonNote",
    "lineNo",
    "outputQuantity",
    "outputLot",
    "source",
    "documentNumber",
  ])("rejects a bad snapshot %s specifically at commit", async (field) => {
    let reachedCommit = false;
    await expect(
      tx(async (client) => {
        const d = await draft(client);
        switch (field) {
          case "eventId":
            d.snapshot.eventId = randomUUID();
            break;
          case "eventDate":
            d.snapshot.eventDate = "2026-09-08";
            break;
          case "timeZone":
            d.snapshot.timeZone = "UTC";
            break;
          case "reasonNote":
            await client.query(
              "UPDATE transformation_event_details SET reason_note='Stored note' WHERE event_id=$1",
              [d.id],
            );
            break;
          case "lineNo":
            d.snapshot.inputs = d.snapshot.inputs.map((i) => ({ ...i, lineNo: 2 }));
            break;
          case "outputQuantity":
            d.snapshot.outputs = d.snapshot.outputs.map((o) => ({ ...o, quantity: "99" }));
            break;
          case "outputLot":
            d.snapshot.outputs = d.snapshot.outputs.map((o) => ({ ...o, lotId: randomUUID() }));
            break;
          case "source":
            d.snapshot.outputs = d.snapshot.outputs.map((o) => ({
              ...o,
              source: { ...o.source, id: foreign.location },
            }));
            break;
          case "documentNumber":
            d.snapshot.documents = d.snapshot.documents.map((doc) => ({ ...doc, number: "WRONG" }));
            break;
        }
        await finalize(client, d.id, d.snapshot);
        reachedCommit = true;
      }),
    ).rejects.toMatchObject({ code: "23514" });
    expect(reachedCommit).toBe(true);
  });
  it.each([
    "input",
    "output",
    "document",
    "edge",
    "type",
    "duplicate-input",
    "duplicate-output",
    "root",
  ])("rejects tenant/type/uniqueness breach: %s", async (kind) => {
    await expect(
      tx(async (client) => {
        const d = await draft(client);
        const q: Record<string, [string, unknown[]]> = {
          input: [
            "UPDATE transformation_event_inputs SET lot_id=$1 WHERE event_id=$2",
            [foreign.lot, d.id],
          ],
          output: [
            "UPDATE transformation_event_outputs SET lot_id=$1 WHERE event_id=$2",
            [foreign.lot, d.id],
          ],
          document: [
            "UPDATE transformation_event_documents SET document_id=$1 WHERE event_id=$2",
            [foreign.document, d.id],
          ],
          edge: [
            "UPDATE lot_genealogy_edges SET input_lot_id=$1 WHERE event_id=$2",
            [foreign.lot, d.id],
          ],
          type: [
            "UPDATE transformation_event_details SET event_id=$1 WHERE event_id=$2",
            [c.id, d.id],
          ],
          "duplicate-input": [
            "INSERT INTO transformation_event_inputs(tenant_id,event_id,line_no,kind,lot_id) VALUES ($1,$2,2,'ftl_lot',$3)",
            [c.tenant, d.id, c.lot],
          ],
          "duplicate-output": [
            "INSERT INTO transformation_event_outputs(tenant_id,event_id,line_no,lot_id) VALUES ($1,$2,2,$3)",
            [c.tenant, d.id, d.out],
          ],
          root: [
            "UPDATE transformation_event_roots SET current_event_id=$1 WHERE id=$2",
            [c.id, d.id],
          ],
        };
        const query = q[kind];
        if (!query) throw new Error("Missing test query");
        await client.query(query[0], query[1]);
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^235(03|05|14)$/) });
  });
});
