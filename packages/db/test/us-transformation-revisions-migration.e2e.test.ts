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
const at = "2026-09-07T10:00:00.000Z";
const coverage = {
  coverageStatus: "covered",
  coverageRationale: "Reviewed raw fixture",
  ftlCategory: "Fresh-cut fruits",
  ftlSourceUrl: "https://www.fda.gov/food/food-traceability-list",
  ftlSourceVersion: "2026",
  reviewedBy: "qa-reviewer",
  reviewedAt: "2026-09-06T09:08:07.123Z",
};

describe.skipIf(!url)("Transformation revision storage upgrade", () => {
  let f: Fixture, c: Specimen, foreign: Specimen;
  let secondInputLot: string;
  let original: { id: string; out: string; snapshot: Record<string, unknown> };
  let receivingBefore: unknown, transformationBefore: unknown, guardsBefore: unknown;
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
  async function rows(table: string) {
    return (await f.pool.query(`SELECT to_jsonb(t)::text AS exact FROM ${table} t ORDER BY 1`))
      .rows;
  }
  async function receivingRows() {
    return Promise.all(
      [
        "traceability_events",
        "receiving_event_roots",
        "receiving_event_items",
        "receiving_event_documents",
      ].map((table) => rows(table)),
    );
  }
  async function receivingGuards() {
    return (
      await f.pool.query(
        "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname LIKE 'receiving_%guard' ORDER BY proname",
      )
    ).rows;
  }
  async function draft(client: PoolClient, predecessor?: string, requestedRevision = 2) {
    const id = randomUUID();
    const out = predecessor ? original.out : randomUUID();
    const revision = predecessor ? requestedRevision : 1;
    await client.query(
      `INSERT INTO traceability_events(id,tenant_id,root_event_id,type,event_number,revision,previous_revision_id,amendment_reason,
       time_zone,event_date,location_id,created_by,updated_by)
       VALUES($1,$2,$3,'transformation',$4,$5,$6,$7,'America/Chicago','2026-09-07',$8,'qa-user','qa-user')`,
      [
        id,
        c.tenant,
        predecessor ? original.id : id,
        predecessor
          ? original.snapshot.eventNumber
          : `TRN-26-${Math.floor(Math.random() * 1e9) + 1000}`,
        revision,
        predecessor ?? null,
        predecessor ? "Correct inputs" : null,
        c.location,
      ],
    );
    if (!predecessor) {
      await client.query(
        "INSERT INTO transformation_event_roots(id,tenant_id,event_number,pending_draft_id) SELECT id,tenant_id,event_number,id FROM traceability_events WHERE id=$1",
        [id],
      );
      await client.query(
        "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_location_id,source_locked_at,created_by,updated_by) VALUES ($1,$2,$3,$1::uuid::text,'transformation',$4,now(),'qa-user','qa-user')",
        [out, c.tenant, c.product, c.location],
      );
    } else {
      await client.query(
        "UPDATE transformation_event_roots SET pending_draft_id=$1,next_revision=$4,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
        [id, c.tenant, original.id, revision + 1],
      );
    }
    await client.query(
      "INSERT INTO transformation_event_details(tenant_id,event_id,reason) VALUES ($1,$2,'repacking')",
      [c.tenant, id],
    );
    await client.query(
      "INSERT INTO transformation_event_inputs(tenant_id,event_id,line_no,kind,lot_id,quantity,unit_of_measure) VALUES ($1,$2,1,'ftl_lot',$3,'500.000','lb')",
      [c.tenant, id, c.lot],
    );
    await client.query(
      "INSERT INTO transformation_event_inputs(tenant_id,event_id,line_no,kind,lot_id,quantity,unit_of_measure) VALUES ($1,$2,2,'ftl_lot',$3,'250.000','lb')",
      [c.tenant, id, secondInputLot],
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
      [c.tenant, id, c.lot, out],
    );
    await client.query(
      "INSERT INTO lot_genealogy_edges(tenant_id,event_id,input_lot_id,output_lot_id) VALUES ($1,$2,$3,$4)",
      [c.tenant, id, secondInputLot, out],
    );
    const location = { id: c.location, description: "Dock" };
    const snapshot = {
      snapshotVersion: 1,
      eventId: id,
      eventNumber: predecessor
        ? original.snapshot.eventNumber
        : (await client.query("SELECT event_number FROM traceability_events WHERE id=$1", [id]))
            .rows[0].event_number,
      revision,
      ...(predecessor ? { previousRevisionId: predecessor } : {}),
      eventDate: "2026-09-07",
      timeZone: "America/Chicago",
      processor: location,
      reason: "repacking",
      reasonNote: null,
      notes: null,
      inputs: [
        {
          lineNo: 1,
          kind: "ftl_lot",
          lotId: c.lot,
          product: { id: c.product, description: "Apple slices", coverage },
          tlc: "=Case/Ä-001",
          source: { ...location, kind: "location" },
          reference: null,
          quantity: "500.000",
          unitOfMeasure: "lb",
        },
        {
          lineNo: 2,
          kind: "ftl_lot",
          lotId: secondInputLot,
          product: { id: c.product, description: "Apple slices", coverage },
          tlc: "=Case/Ä-002",
          source: { ...location, kind: "location" },
          reference: null,
          quantity: "250.000",
          unitOfMeasure: "lb",
        },
      ],
      outputs: [
        {
          lineNo: 1,
          lotId: out,
          product: { id: c.product, description: "Apple slices", coverage },
          tlc: out,
          source: { ...location, kind: "location" },
          quantity: "100",
          unitOfMeasure: "case",
        },
      ],
      documents: [{ id: c.document, type: "bol", number: "0001" }],
      finalizedBy: "qa-user",
      finalizedAt: at,
    };
    return { id, out, snapshot };
  }
  async function finalize(
    client: PoolClient,
    d: { id: string; snapshot: unknown },
    predecessor?: string,
  ) {
    if (predecessor)
      await client.query(
        "UPDATE traceability_events SET status='amended',superseded_by_event_id=$1,superseded_at=$2,superseded_by='qa-user' WHERE id=$3",
        [d.id, at, predecessor],
      );
    await client.query(
      "UPDATE traceability_events SET status='finalized',finalized_at=$2,updated_at=$2,finalized_by='qa-user',updated_by='qa-user',finalization_snapshot=$3 WHERE id=$1",
      [d.id, at, d.snapshot],
    );
    await client.query(
      "UPDATE transformation_event_roots SET current_event_id=$1,pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$2",
      [d.id, predecessor ?? d.id],
    );
  }
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
    await migrateThrough(f, 131);
    await f.pool.query(
      "INSERT INTO product_traceability_profiles(tenant_id,product_id,product_name,coverage_status,coverage_rationale,ftl_category,ftl_source_url,ftl_source_version,reviewed_by,reviewed_at) VALUES($1,$2,'Apple slices','covered',$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
      [
        c.tenant,
        c.product,
        coverage.coverageRationale,
        coverage.ftlCategory,
        coverage.ftlSourceUrl,
        coverage.ftlSourceVersion,
        coverage.reviewedBy,
        coverage.reviewedAt,
      ],
    );
    secondInputLot = randomUUID();
    await f.pool.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_location_id,source_locked_at,created_by,updated_by) VALUES($1,$2,$3,'=Case/Ä-002','imported',$4,$5,'qa-user','qa-user')",
      [secondInputLot, c.tenant, c.product, c.location, at],
    );
    original = await tx(async (client) => {
      const d = await draft(client);
      await finalize(client, d);
      return d;
    });
    receivingBefore = await receivingRows();
    transformationBefore = await Promise.all(
      [
        "traceability_events",
        "transformation_event_roots",
        "transformation_event_details",
        "transformation_event_inputs",
        "transformation_event_outputs",
        "transformation_event_documents",
        "lot_genealogy_edges",
      ].map((table) => rows(table)),
    );
    guardsBefore = await receivingGuards();
    await migrateThrough(f, 132);
  }, 90_000);
  afterAll(async () => {
    await f?.close();
  });

  it("installs the epoch and revised guards on a fresh disposable database", async () => {
    if (!url) throw new Error("Missing isolated URL");
    const fresh = await createUsProfileTestDatabase(url);
    try {
      expect(
        (await fresh.pool.query("SELECT current_dependency_version FROM traceability_lots LIMIT 0"))
          .fields[0]?.name,
      ).toBe("current_dependency_version");
      const active = (
        await fresh.pool.query(
          "SELECT proname FROM pg_proc WHERE proname IN ('transformation_root_consistency_guard','transformation_revision_identity_guard','transformation_finalization_guard') ORDER BY proname",
        )
      ).rows;
      expect(active).toEqual([
        { proname: "transformation_finalization_guard" },
        { proname: "transformation_revision_identity_guard" },
        { proname: "transformation_root_consistency_guard" },
      ]);
    } finally {
      await fresh.close();
    }
  }, 60_000);

  it("preserves Receiving history, guard definitions and original Transformation evidence", async () => {
    expect(original.snapshot.inputs).toHaveLength(2);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS count FROM lot_genealogy_edges WHERE event_id=$1",
          [original.id],
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
    const afterReceiving = await receivingRows();
    expect(afterReceiving).toEqual(receivingBefore);
    expect(await receivingGuards()).toEqual(guardsBefore);
    expect(
      await Promise.all(
        [
          "traceability_events",
          "transformation_event_roots",
          "transformation_event_details",
          "transformation_event_inputs",
          "transformation_event_outputs",
          "transformation_event_documents",
          "lot_genealogy_edges",
        ].map((table) => rows(table)),
      ),
    ).toEqual(transformationBefore);
    expect(
      (
        await f.pool.query("SELECT finalization_snapshot FROM traceability_events WHERE id=$1", [
          original.id,
        ])
      ).rows[0].finalization_snapshot,
    ).toEqual(original.snapshot);
  });
  it("defaults the dependency epoch to one and enforces positive bounded increments", async () => {
    expect(
      (
        await f.pool.query("SELECT current_dependency_version FROM traceability_lots WHERE id=$1", [
          original.out,
        ])
      ).rows,
    ).toEqual([{ current_dependency_version: 1 }]);
    await expect(
      f.pool.query("UPDATE traceability_lots SET current_dependency_version=0 WHERE id=$1", [
        original.out,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await f.pool.query(
      "UPDATE traceability_lots SET current_dependency_version=2147483647 WHERE id=$1",
      [original.out],
    );
    await expect(
      f.pool.query(
        "UPDATE traceability_lots SET current_dependency_version=current_dependency_version+1 WHERE id=$1",
        [original.out],
      ),
    ).rejects.toMatchObject({ code: "22003" });
  });
  it("allows one revision draft and atomic finalization while preserving prior evidence", async () => {
    const d = await tx((client) => draft(client, original.id));
    expect(
      (
        await f.pool.query(
          "SELECT current_event_id,pending_draft_id,next_revision FROM transformation_event_roots WHERE id=$1",
          [original.id],
        )
      ).rows,
    ).toEqual([{ current_event_id: original.id, pending_draft_id: d.id, next_revision: 3 }]);
    await tx((client) => finalize(client, d, original.id));
    expect(
      (
        await f.pool.query(
          "SELECT status,superseded_by_event_id,finalization_snapshot FROM traceability_events WHERE id=$1",
          [original.id],
        )
      ).rows,
    ).toEqual([
      { status: "amended", superseded_by_event_id: d.id, finalization_snapshot: original.snapshot },
    ]);
    await expect(
      f.pool.query("UPDATE transformation_event_outputs SET lot_id=$1 WHERE event_id=$2", [
        foreign.lot,
        original.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      f.pool.query("UPDATE traceability_events SET finalization_snapshot='{}' WHERE id=$1", [
        original.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects a forged revision output lot even when its snapshot matches", async () => {
    original = await tx(async (client) => {
      const d = await draft(client);
      await finalize(client, d);
      return d;
    });
    const replacement = randomUUID();
    await f.pool.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_location_id,source_locked_at,created_by,updated_by) VALUES($1,$2,$3,$1::uuid::text,'transformation',$4,now(),'qa-user','qa-user')",
      [replacement, c.tenant, c.product, c.location],
    );
    await expect(
      tx(async (client) => {
        const d = await draft(client, original.id);
        await client.query(
          "UPDATE transformation_event_outputs SET lot_id=$1,tlc=$1::uuid::text WHERE event_id=$2",
          [replacement, d.id],
        );
        d.snapshot.outputs[0]!.lotId = replacement;
        d.snapshot.outputs[0]!.tlc = replacement;
        await finalize(client, d, original.id);
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects wrong-tenant predecessors and mismatched root pointers", async () => {
    original = await tx(async (client) => {
      const d = await draft(client);
      await finalize(client, d);
      return d;
    });
    await expect(
      tx(async (client) => {
        const d = await draft(client, original.id);
        await client.query("UPDATE traceability_events SET previous_revision_id=$1 WHERE id=$2", [
          foreign.id,
          d.id,
        ]);
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^235(03|14)$/) });
    await expect(
      tx(async (client) => {
        const d = await draft(client, original.id);
        await client.query(
          "UPDATE transformation_event_roots SET pending_draft_id=NULL WHERE id=$1",
          [original.id],
        );
        return d;
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects a skipped revision number even if the root counter is forged to match", async () => {
    original = await tx(async (client) => {
      const d = await draft(client);
      await finalize(client, d);
      return d;
    });
    await expect(tx((client) => draft(client, original.id, 42))).rejects.toMatchObject({
      code: "23514",
    });
  });
  it("rejects a root lifecycle version jump without a pointer transition", async () => {
    original = await tx(async (client) => {
      const d = await draft(client);
      await finalize(client, d);
      return d;
    });
    await expect(
      f.pool.query("UPDATE transformation_event_roots SET lifecycle_version=999 WHERE id=$1", [
        original.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects two current finalized revisions and preserves the original pointer", async () => {
    original = await tx(async (client) => {
      const d = await draft(client);
      await finalize(client, d);
      return d;
    });
    await expect(
      tx(async (client) => {
        const d = await draft(client, original.id);
        await finalize(client, d);
      }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(
      (
        await f.pool.query(
          "SELECT current_event_id,pending_draft_id FROM transformation_event_roots WHERE id=$1",
          [original.id],
        )
      ).rows,
    ).toEqual([{ current_event_id: original.id, pending_draft_id: null }]);
  });
  it("rejects a final revision without immutable snapshot evidence", async () => {
    original = await tx(async (client) => {
      const d = await draft(client);
      await finalize(client, d);
      return d;
    });
    await expect(
      tx(async (client) => {
        const d = await draft(client, original.id);
        await client.query(
          "UPDATE traceability_events SET status='amended',superseded_by_event_id=$1,superseded_at=$2,superseded_by='qa-user' WHERE id=$3",
          [d.id, at, original.id],
        );
        await client.query("UPDATE traceability_events SET status='finalized' WHERE id=$1", [d.id]);
        await client.query(
          "UPDATE transformation_event_roots SET current_event_id=$1,pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$2",
          [d.id, original.id],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("voids a finalized original without rewriting its lot or frozen edges", async () => {
    original = await tx(async (client) => {
      const d = await draft(client);
      await finalize(client, d);
      return d;
    });
    const lotBefore = (
      await f.pool.query("SELECT to_jsonb(t)::text AS exact FROM traceability_lots t WHERE id=$1", [
        original.out,
      ])
    ).rows;
    const edgesBefore = (
      await f.pool.query(
        "SELECT to_jsonb(t)::text AS exact FROM lot_genealogy_edges t WHERE event_id=$1",
        [original.id],
      )
    ).rows;
    await tx(async (client) => {
      await client.query(
        "UPDATE traceability_events SET status='void',voided_at=$2,voided_by='qa-user',void_reason='Incorrect event' WHERE id=$1",
        [original.id, at],
      );
      await client.query(
        "UPDATE transformation_event_roots SET current_event_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$1",
        [original.id],
      );
    });
    expect(
      (
        await f.pool.query("SELECT current_event_id FROM transformation_event_roots WHERE id=$1", [
          original.id,
        ])
      ).rows,
    ).toEqual([{ current_event_id: null }]);
    expect(
      (
        await f.pool.query(
          "SELECT to_jsonb(t)::text AS exact FROM traceability_lots t WHERE id=$1",
          [original.out],
        )
      ).rows,
    ).toEqual(lotBefore);
    expect(
      (
        await f.pool.query(
          "SELECT to_jsonb(t)::text AS exact FROM lot_genealogy_edges t WHERE event_id=$1",
          [original.id],
        )
      ).rows,
    ).toEqual(edgesBefore);
  });
  it("rejects a fabricated finalized-void original inserted without evidence", async () => {
    await expect(
      tx(async (client) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO traceability_events(id,tenant_id,root_event_id,type,event_number,status,time_zone,event_date,location_id,
          finalized_at,finalized_by,finalization_snapshot,voided_at,voided_by,void_reason,created_by,updated_by,updated_at)
         VALUES($1,$2,$1,'transformation',$3,'void','America/Chicago','2026-09-07',$4,
          $5,'qa-user','{}',$5,'qa-user','Incorrect event','qa-user','qa-user',$5)`,
          [id, c.tenant, `TRN-26-${Math.floor(Math.random() * 1e9) + 1000}`, c.location, at],
        );
        await client.query(
          "INSERT INTO transformation_event_roots(id,tenant_id,event_number) SELECT id,tenant_id,event_number FROM traceability_events WHERE id=$1",
          [id],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("validates evidence when a draft is finalized and voided in one transaction", async () => {
    await expect(
      tx(async (client) => {
        const d = await draft(client);
        await finalize(client, { id: d.id, snapshot: {} });
        await client.query(
          "UPDATE traceability_events SET status='void',voided_at=$2,voided_by='qa-user',void_reason='Incorrect event' WHERE id=$1",
          [d.id, at],
        );
        await client.query(
          "UPDATE transformation_event_roots SET current_event_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$1",
          [d.id],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("checks revision output identity even when the new finalized revision is voided in the same transaction", async () => {
    original = await tx(async (client) => {
      const d = await draft(client);
      await finalize(client, d);
      return d;
    });
    const replacement = randomUUID();
    await f.pool.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_location_id,source_locked_at,created_by,updated_by) VALUES($1,$2,$3,$1::uuid::text,'transformation',$4,$5,'qa-user','qa-user')",
      [replacement, c.tenant, c.product, c.location, at],
    );
    await expect(
      tx(async (client) => {
        const d = await draft(client, original.id);
        await client.query(
          "UPDATE transformation_event_outputs SET lot_id=$1,tlc=$1::uuid::text WHERE event_id=$2",
          [replacement, d.id],
        );
        d.snapshot.outputs[0]!.lotId = replacement;
        d.snapshot.outputs[0]!.tlc = replacement;
        await finalize(client, d, original.id);
        await client.query(
          "UPDATE traceability_events SET status='void',voided_at=$2,voided_by='qa-user',void_reason='Incorrect event' WHERE id=$1",
          [d.id, at],
        );
        await client.query(
          "UPDATE transformation_event_roots SET current_event_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$1",
          [original.id],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("permits voiding the predecessor after its amendment draft was canceled", async () => {
    original = await tx(async (client) => {
      const d = await draft(client);
      await finalize(client, d);
      return d;
    });
    const canceled = await tx(async (client) => {
      const d = await draft(client, original.id);
      await client.query(
        "UPDATE traceability_events SET status='void',voided_at=$2,voided_by='qa-user',void_reason='Canceled correction' WHERE id=$1",
        [d.id, at],
      );
      await client.query(
        "UPDATE transformation_event_roots SET pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$1",
        [original.id],
      );
      return d;
    });
    await tx(async (client) => {
      await client.query(
        "UPDATE traceability_events SET status='void',voided_at=$2,voided_by='qa-user',void_reason='Incorrect event' WHERE id=$1",
        [original.id, at],
      );
      await client.query(
        "UPDATE transformation_event_roots SET current_event_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$1",
        [original.id],
      );
    });
    expect(
      (
        await f.pool.query(
          "SELECT status,previous_revision_id FROM traceability_events WHERE id=$1",
          [canceled.id],
        )
      ).rows,
    ).toEqual([{ status: "void", previous_revision_id: original.id }]);
  });
  it.each(["event_number", "time_zone"] as const)(
    "rejects a pending revision with a different root %s",
    async (field) => {
      original = await tx(async (client) => {
        const d = await draft(client);
        await finalize(client, d);
        return d;
      });
      const root = (
        await f.pool.query<{ event_number: string; time_zone: string }>(
          "SELECT event_number,time_zone FROM traceability_events WHERE id=$1",
          [original.id],
        )
      ).rows[0];
      if (!root) throw new Error("Missing original Transformation");
      await expect(
        tx(async (client) => {
          const id = randomUUID();
          await client.query(
            `INSERT INTO traceability_events(id,tenant_id,root_event_id,type,event_number,revision,previous_revision_id,
            amendment_reason,time_zone,created_by,updated_by)
           VALUES($1,$2,$3,'transformation',$4,2,$3,'Correct inputs',$5,'qa-user','qa-user')`,
            [
              id,
              c.tenant,
              original.id,
              field === "event_number" ? "TRN-26-9999999999" : root.event_number,
              field === "time_zone" ? "America/New_York" : root.time_zone,
            ],
          );
          await client.query(
            "UPDATE transformation_event_roots SET pending_draft_id=$1,next_revision=3,lifecycle_version=lifecycle_version+1 WHERE id=$2",
            [id, original.id],
          );
        }),
      ).rejects.toMatchObject({ code: "23514" });
    },
  );
});
