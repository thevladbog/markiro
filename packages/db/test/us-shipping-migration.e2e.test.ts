import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";
import {
  amendment,
  finalizeAmendment,
  migrateThrough,
} from "./support/us-receiving-lifecycle-fixture.js";
import { seed, transition } from "./support/us-receiving-snapshot-fixture.js";

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

describe.skipIf(!url)("Shipping storage upgrade", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let first: Awaited<ReturnType<typeof seed>>;
  let foreign: Awaited<ReturnType<typeof seed>>;
  let transformationId: string;
  let transformationSuccessorId: string;
  let receivingSuccessorId: string;
  let transformationSnapshotsBefore: unknown;
  let transformationOutputLot: string;
  let before: unknown;
  let nextShippingNumber = 1;
  let finalizedShippingId: string;
  const recipientId = randomUUID();

  async function transaction<T>(run: (client: PoolClient) => Promise<T>) {
    const client = await fixture.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function oldRows() {
    return Promise.all(
      [
        "traceability_events",
        "receiving_event_roots",
        "receiving_event_items",
        "receiving_event_documents",
        "transformation_event_roots",
        "transformation_event_details",
        "transformation_event_inputs",
        "transformation_event_outputs",
        "transformation_event_documents",
        "lot_genealogy_edges",
      ].map(
        async (table) =>
          (
            await fixture.pool.query(
              `SELECT ${table === "traceability_events" ? "to_jsonb(t)-'shipping_root_key'" : "to_jsonb(t)"}::text AS exact FROM ${table} t ORDER BY 1`,
            )
          ).rows,
      ),
    );
  }

  async function transformationDraft(client: PoolClient, predecessor?: string, revision = 1) {
    const id = randomUUID();
    const root = predecessor ? transformationId : id;
    const eventNumber = "TRN-26-0001";
    await client.query(
      "INSERT INTO traceability_events(id,tenant_id,root_event_id,type,event_number,revision,previous_revision_id,amendment_reason,time_zone,event_date,location_id,created_by,updated_by) VALUES($1,$2,$3,'transformation',$4,$5,$6,$7,'America/Chicago','2026-09-07',$8,'qa-user','qa-user')",
      [
        id,
        first.tenant,
        root,
        eventNumber,
        revision,
        predecessor ?? null,
        predecessor ? "Correct inputs" : null,
        first.location,
      ],
    );
    if (!predecessor) {
      transformationId = id;
      transformationOutputLot = randomUUID();
      await client.query(
        "INSERT INTO transformation_event_roots(id,tenant_id,event_number,pending_draft_id) VALUES($1,$2,$3,$1)",
        [id, first.tenant, eventNumber],
      );
      await client.query(
        "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_location_id,source_locked_at,created_by,updated_by) VALUES($1,$2,$3,$1::uuid::text,'transformation',$4,now(),'qa-user','qa-user')",
        [transformationOutputLot, first.tenant, first.product, first.location],
      );
    } else {
      await client.query(
        "UPDATE transformation_event_roots SET pending_draft_id=$1,next_revision=$4,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
        [id, first.tenant, transformationId, revision + 1],
      );
    }
    await client.query(
      "INSERT INTO transformation_event_details(tenant_id,event_id,reason) VALUES($1,$2,'repacking')",
      [first.tenant, id],
    );
    await client.query(
      "INSERT INTO transformation_event_inputs(tenant_id,event_id,line_no,kind,lot_id,quantity,unit_of_measure) VALUES($1,$2,1,'ftl_lot',$3,'500.000','lb')",
      [first.tenant, id, first.lot],
    );
    await client.query(
      "INSERT INTO transformation_event_outputs(tenant_id,event_id,line_no,lot_id,product_id,tlc,quantity,unit_of_measure) VALUES($1,$2,1,$3,$4,$3::uuid::text,'100','case')",
      [first.tenant, id, transformationOutputLot, first.product],
    );
    await client.query(
      "INSERT INTO transformation_event_documents(tenant_id,event_id,document_id,position) VALUES($1,$2,$3,1)",
      [first.tenant, id, first.document],
    );
    await client.query(
      "INSERT INTO lot_genealogy_edges(tenant_id,event_id,input_lot_id,output_lot_id) VALUES($1,$2,$3,$4)",
      [first.tenant, id, first.lot, transformationOutputLot],
    );
    const location = { id: first.location, description: "Dock" };
    const snapshot = {
      snapshotVersion: 1,
      eventId: id,
      eventNumber,
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
          lotId: first.lot,
          product: { id: first.product, description: "Apple slices", coverage },
          tlc: "=Case/Ä-001",
          source: { ...location, kind: "location" },
          reference: null,
          quantity: "500.000",
          unitOfMeasure: "lb",
        },
      ],
      outputs: [
        {
          lineNo: 1,
          lotId: transformationOutputLot,
          product: { id: first.product, description: "Apple slices", coverage },
          tlc: transformationOutputLot,
          source: { ...location, kind: "location" },
          quantity: "100",
          unitOfMeasure: "case",
        },
      ],
      documents: [{ id: first.document, type: "bol", number: "0001" }],
      finalizedBy: "qa-user",
      finalizedAt: at,
    };
    return { id, snapshot };
  }

  async function finalizeTransformation(
    client: PoolClient,
    draft: { id: string; snapshot: unknown },
    predecessor?: string,
  ) {
    if (predecessor)
      await client.query(
        "UPDATE traceability_events SET status='amended',superseded_by_event_id=$1,superseded_at=$2,superseded_by='qa-user' WHERE id=$3",
        [draft.id, at, predecessor],
      );
    await client.query(
      "UPDATE traceability_events SET status='finalized',finalized_at=$2,updated_at=$2,finalized_by='qa-user',updated_by='qa-user',finalization_snapshot=$3 WHERE id=$1",
      [draft.id, at, draft.snapshot],
    );
    await client.query(
      "UPDATE transformation_event_roots SET current_event_id=$1,pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$2",
      [draft.id, transformationId],
    );
  }

  async function shippingDraft(tenant: string, rootId = randomUUID(), revision = 1) {
    const id = revision === 1 ? rootId : randomUUID();
    const location = tenant === foreign.tenant ? foreign.location : first.location;
    const eventNumber =
      revision === 1
        ? `SHP-26-${String(nextShippingNumber++).padStart(4, "0")}`
        : (
            await fixture.pool.query("SELECT event_number FROM shipping_event_roots WHERE id=$1", [
              rootId,
            ])
          ).rows[0]?.event_number;
    await transaction(async (client) => {
      await client.query(
        "INSERT INTO traceability_events(id,tenant_id,root_event_id,type,event_number,revision,previous_revision_id,amendment_reason,time_zone,event_date,location_id,created_by,updated_by) VALUES($1,$2,$3,'shipping',$4,$5,$6,$7,'America/Chicago','2026-09-07',$8,'qa-user','qa-user')",
        [
          id,
          tenant,
          rootId,
          eventNumber,
          revision,
          revision > 1 ? rootId : null,
          revision > 1 ? "Correction" : null,
          location,
        ],
      );
      if (revision === 1) {
        await client.query(
          "INSERT INTO shipping_event_roots(id,tenant_id,event_number,pending_draft_id) VALUES($1,$2,$3,$1)",
          [id, tenant, eventNumber],
        );
      } else {
        await client.query(
          "UPDATE shipping_event_roots SET pending_draft_id=$1,next_revision=3,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
          [id, tenant, rootId],
        );
      }
      await client.query(
        "INSERT INTO shipping_event_details(tenant_id,event_id,recipient_location_id) VALUES($1,$2,$3)",
        [tenant, id, location],
      );
    });
    return id;
  }

  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US URL");
    fixture = await createUsProfileTestDatabase(url, 124);
    first = await seed(fixture);
    foreign = await seed(fixture);
    await fixture.pool.query(
      "INSERT INTO traceability_locations(id,tenant_id,party_id,name,business_name,phone_number,street_address,city,state_or_region,zip_or_postal_code,country_code) SELECT $1,tenant_id,party_id,'Recipient',business_name,phone_number,street_address,city,state_or_region,zip_or_postal_code,country_code FROM traceability_locations WHERE id=$2",
      [recipientId, first.location],
    );
    await transition(fixture, first);
    await migrateThrough(fixture, 128);
    receivingSuccessorId = await transaction(async (client) => {
      const id = await amendment(client, first);
      await finalizeAmendment(client, first, id);
      return id;
    });
    await migrateThrough(fixture, 133);
    await fixture.pool.query(
      "INSERT INTO product_traceability_profiles(tenant_id,product_id,product_name,coverage_status,coverage_rationale,ftl_category,ftl_source_url,ftl_source_version,reviewed_by,reviewed_at) VALUES($1,$2,'Apple slices','covered',$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
      [
        first.tenant,
        first.product,
        coverage.coverageRationale,
        coverage.ftlCategory,
        coverage.ftlSourceUrl,
        coverage.ftlSourceVersion,
        coverage.reviewedBy,
        coverage.reviewedAt,
      ],
    );
    await transaction(async (client) => {
      const draft = await transformationDraft(client);
      await finalizeTransformation(client, draft);
    });
    transformationSuccessorId = await transaction(async (client) => {
      const draft = await transformationDraft(client, transformationId, 2);
      await finalizeTransformation(client, draft, transformationId);
      return draft.id;
    });
    transformationSnapshotsBefore = (
      await fixture.pool.query(
        "SELECT id,finalization_snapshot FROM traceability_events WHERE root_event_id=$1 ORDER BY revision",
        [transformationId],
      )
    ).rows;
    before = await oldRows();
    await migrateThrough(fixture, 134);
  }, 90_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("preserves Receiving and Transformation rows and frozen snapshots byte for byte", async () => {
    expect(await oldRows()).toEqual(before);
    expect(
      (
        await fixture.pool.query(
          "SELECT status FROM traceability_events WHERE root_event_id=$1 ORDER BY revision",
          [first.id],
        )
      ).rows,
    ).toEqual([{ status: "amended" }, { status: "finalized" }]);
    expect(
      (
        await fixture.pool.query(
          "SELECT status FROM traceability_events WHERE root_event_id=$1 ORDER BY revision",
          [transformationId],
        )
      ).rows,
    ).toEqual([{ status: "amended" }, { status: "finalized" }]);
    expect(
      (
        await fixture.pool.query(
          "SELECT id,finalization_snapshot FROM traceability_events WHERE root_event_id=$1 ORDER BY revision",
          [transformationId],
        )
      ).rows,
    ).toEqual(transformationSnapshotsBefore);
    expect(
      (
        await fixture.pool.query("SELECT status FROM traceability_events WHERE id=$1", [
          receivingSuccessorId,
        ])
      ).rows,
    ).toEqual([{ status: "finalized" }]);
    expect(
      (
        await fixture.pool.query("SELECT status FROM traceability_events WHERE id=$1", [
          transformationSuccessorId,
        ])
      ).rows,
    ).toEqual([{ status: "finalized" }]);
    expect(
      (
        await fixture.pool.query(
          "SELECT finalization_snapshot FROM traceability_events WHERE id=$1",
          [first.id],
        )
      ).rows[0]?.finalization_snapshot,
    ).toEqual(first.snapshot);
  });

  it("keeps Transformation evidence immutable while allowing amendment and void after 0134", async () => {
    const originalEvidence = (
      await fixture.pool.query(
        "SELECT finalization_snapshot FROM traceability_events WHERE id=$1",
        [transformationId],
      )
    ).rows[0]?.finalization_snapshot;
    const successorEvidence = (
      await fixture.pool.query(
        "SELECT finalization_snapshot FROM traceability_events WHERE id=$1",
        [transformationSuccessorId],
      )
    ).rows[0]?.finalization_snapshot;
    for (const statement of [
      "UPDATE transformation_event_inputs SET quantity='499' WHERE event_id=$1",
      "UPDATE transformation_event_outputs SET quantity='99' WHERE event_id=$1",
      "DELETE FROM transformation_event_documents WHERE event_id=$1",
      "DELETE FROM lot_genealogy_edges WHERE event_id=$1",
    ]) {
      await expect(fixture.pool.query(statement, [transformationId])).rejects.toMatchObject({
        code: "23514",
      });
    }
    await expect(
      fixture.pool.query("UPDATE traceability_events SET finalization_snapshot='{}' WHERE id=$1", [
        transformationSuccessorId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    const third = await transaction(async (client) => {
      const draft = await transformationDraft(client, transformationSuccessorId, 3);
      await finalizeTransformation(client, draft, transformationSuccessorId);
      return draft.id;
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT status,finalization_snapshot FROM traceability_events WHERE id=$1",
          [transformationSuccessorId],
        )
      ).rows,
    ).toEqual([{ status: "amended", finalization_snapshot: successorEvidence }]);
    expect(
      (
        await fixture.pool.query(
          "SELECT current_event_id,pending_draft_id FROM transformation_event_roots WHERE id=$1",
          [transformationId],
        )
      ).rows,
    ).toEqual([{ current_event_id: third, pending_draft_id: null }]);
    await transaction(async (client) => {
      await client.query(
        "UPDATE traceability_events SET status='void',voided_at=$2,voided_by='qa-user',void_reason='Entered in error' WHERE id=$1",
        [third, at],
      );
      await client.query(
        "UPDATE transformation_event_roots SET current_event_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$1",
        [transformationId],
      );
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT status,current_event_id FROM transformation_event_roots r JOIN traceability_events e ON e.id=$2 WHERE r.id=$1",
          [transformationId, third],
        )
      ).rows,
    ).toEqual([{ status: "void", current_event_id: null }]);
    expect(
      (
        await fixture.pool.query(
          "SELECT finalization_snapshot FROM traceability_events WHERE id=$1",
          [transformationId],
        )
      ).rows[0]?.finalization_snapshot,
    ).toEqual(originalEvidence);
    await expect(
      fixture.pool.query(
        "UPDATE transformation_event_outputs SET quantity='98' WHERE event_id=$1",
        [third],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects wrong-type children, foreign lots, and malformed decimal quantities", async () => {
    const shipping = await shippingDraft(first.tenant);
    await expect(
      fixture.pool.query(
        "INSERT INTO shipping_event_items(tenant_id,event_id,line_no,lot_id,quantity,unit_of_measure) VALUES($1,$2,1,$3,'1','case')",
        [first.tenant, first.id, first.lot],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.pool.query(
        "INSERT INTO shipping_event_items(tenant_id,event_id,line_no,lot_id,quantity,unit_of_measure) VALUES($1,$2,1,$3,'1','case')",
        [first.tenant, transformationId, first.lot],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.pool.query(
        "INSERT INTO shipping_event_items(tenant_id,event_id,line_no,lot_id,quantity,unit_of_measure) VALUES($1,$2,1,$3,'1','case')",
        [first.tenant, shipping, foreign.lot],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      fixture.pool.query(
        "INSERT INTO shipping_event_items(tenant_id,event_id,line_no,lot_id,quantity,unit_of_measure) VALUES($1,$2,1,$3,'1.0000','case')",
        [first.tenant, shipping, first.lot],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await fixture.pool.query(
      "INSERT INTO shipping_event_items(tenant_id,event_id,line_no,lot_id,quantity,unit_of_measure) VALUES($1,$2,1,$3,'100.000','case')",
      [first.tenant, shipping, first.lot],
    );
    expect(
      (
        await fixture.pool.query("SELECT quantity FROM shipping_event_items WHERE event_id=$1", [
          shipping,
        ])
      ).rows,
    ).toEqual([{ quantity: "100.000" }]);
  });

  it("keeps incomplete Shipping drafts but rejects finalized headers without typed evidence", async () => {
    const root = await shippingDraft(first.tenant);
    const finalize = () =>
      transaction(async (client) => {
        await client.query(
          "UPDATE traceability_events SET status='finalized',finalized_at='2026-09-07T10:00:00Z',updated_at='2026-09-07T10:00:00Z',finalized_by='qa-user',updated_by='qa-user',finalization_snapshot=$2 WHERE id=$1",
          [root, { eventId: root }],
        );
        await client.query(
          "UPDATE shipping_event_roots SET current_event_id=$1,pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$1",
          [root],
        );
      });
    await expect(finalize()).rejects.toMatchObject({
      code: "23514",
      message: "Shipping recipient evidence is incomplete",
    });
    await fixture.pool.query(
      "UPDATE shipping_event_details SET recipient_location_id=$1,recipient_snapshot=$2 WHERE event_id=$3",
      [recipientId, { id: recipientId, description: "Recipient" }, root],
    );
    await expect(finalize()).rejects.toMatchObject({
      code: "23514",
      message: "Shipping line evidence is incomplete",
    });
    await fixture.pool.query(
      "INSERT INTO shipping_event_items(tenant_id,event_id,line_no,lot_id,quantity,unit_of_measure,tlc_snapshot,source_snapshot,product_snapshot) VALUES($1,$2,1,$3,'100.000','case','=Case/Ä-001','{}','{}')",
      [first.tenant, root, first.lot],
    );
    await expect(finalize()).rejects.toMatchObject({
      code: "23514",
      message: "Shipping document evidence is incomplete",
    });
    expect(
      (await fixture.pool.query("SELECT status FROM traceability_events WHERE id=$1", [root])).rows,
    ).toEqual([{ status: "draft" }]);
  });

  it("keeps a finalized revision current while an amendment draft is pending and freezes child evidence", async () => {
    const root = await shippingDraft(first.tenant);
    finalizedShippingId = root;
    await fixture.pool.query(
      "UPDATE shipping_event_details SET recipient_location_id=$1,recipient_snapshot=$2 WHERE event_id=$3",
      [recipientId, { id: recipientId, description: "Recipient" }, root],
    );
    await fixture.pool.query(
      "INSERT INTO shipping_event_items(tenant_id,event_id,line_no,lot_id,quantity,unit_of_measure,tlc_snapshot,source_snapshot,product_snapshot) VALUES($1,$2,1,$3,'100.000','case','=Case/Ä-001','{}','{}')",
      [first.tenant, root, first.lot],
    );
    await fixture.pool.query(
      "INSERT INTO shipping_event_documents(tenant_id,event_id,document_id,position) VALUES($1,$2,$3,1)",
      [first.tenant, root, first.document],
    );
    await transaction(async (client) => {
      await client.query(
        "UPDATE traceability_events SET status='finalized',finalized_at='2026-09-07T10:00:00Z',updated_at='2026-09-07T10:00:00Z',finalized_by='qa-user',updated_by='qa-user',finalization_snapshot=$2 WHERE id=$1",
        [root, { eventId: root }],
      );
      await client.query(
        "UPDATE shipping_event_roots SET current_event_id=$1,pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$1",
        [root],
      );
    });
    await expect(
      fixture.pool.query("UPDATE shipping_event_items SET quantity='99' WHERE event_id=$1", [root]),
    ).rejects.toMatchObject({ code: "23514" });
    const draft = await shippingDraft(first.tenant, root, 2);
    expect(
      (
        await fixture.pool.query(
          "SELECT current_event_id,pending_draft_id FROM shipping_event_roots WHERE id=$1",
          [root],
        )
      ).rows,
    ).toEqual([{ current_event_id: root, pending_draft_id: draft }]);
    await expect(
      fixture.pool.query(
        "UPDATE traceability_events SET finalization_snapshot='{" +
          '"changed":true' +
          "}' WHERE id=$1",
        [root],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("limits an uncompensated status effect to one owner and preserves effect history", async () => {
    await expect(
      fixture.pool.query(
        "INSERT INTO shipping_lot_status_effects(tenant_id,event_id,lot_id,prior_status,new_status) VALUES($1,$2,$3,'active','shipped')",
        [first.tenant, first.id, first.lot],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      fixture.pool.query(
        "INSERT INTO shipping_lot_status_effects(tenant_id,event_id,lot_id,prior_status,new_status) VALUES($1,$2,$3,'active','shipped')",
        [first.tenant, finalizedShippingId, foreign.lot],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const result = await fixture.pool.query<{ id: string }>(
      "INSERT INTO shipping_lot_status_effects(tenant_id,event_id,lot_id,prior_status,new_status) VALUES($1,$2,$3,'active','shipped') RETURNING id",
      [first.tenant, finalizedShippingId, first.lot],
    );
    const id = result.rows[0]?.id;
    expect(id).toBeDefined();
    await expect(
      fixture.pool.query(
        "INSERT INTO shipping_lot_status_effects(tenant_id,event_id,lot_id,prior_status,new_status) VALUES($1,$2,$3,'active','shipped')",
        [first.tenant, finalizedShippingId, first.lot],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      fixture.pool.query(
        "UPDATE shipping_lot_status_effects SET prior_status='shipped' WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await fixture.pool.query(
      "UPDATE shipping_lot_status_effects SET compensated_at=now(),compensation_reason='Recalculated' WHERE id=$1",
      [id],
    );
    await expect(
      fixture.pool.query(
        "UPDATE shipping_lot_status_effects SET compensated_at=NULL,compensation_reason=NULL WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await fixture.pool.query(
      "INSERT INTO shipping_lot_status_effects(tenant_id,event_id,lot_id,prior_status,new_status) VALUES($1,$2,$3,'active','shipped')",
      [first.tenant, finalizedShippingId, first.lot],
    );
  });

  it("installs Shipping tables and guards on a fresh disposable database", async () => {
    if (!url) throw new Error("Missing isolated US URL");
    const fresh = await createUsProfileTestDatabase(url);
    try {
      const tables = await fresh.pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'shipping_%' ORDER BY tablename",
      );
      expect(tables.rows.map((row) => row.tablename)).toEqual([
        "shipping_counters",
        "shipping_event_details",
        "shipping_event_documents",
        "shipping_event_items",
        "shipping_event_roots",
        "shipping_lot_status_effects",
        "shipping_operations",
      ]);
      const fk = await fresh.pool.query(
        "SELECT condeferrable,condeferred FROM pg_constraint WHERE conname='traceability_events_shipping_root_fk'",
      );
      expect(fk.rows).toEqual([{ condeferrable: true, condeferred: true }]);
    } finally {
      await fresh.close();
    }
  }, 60_000);

  it("upgrades 0134 to 0135 without changing existing event evidence and enforces Shipping receipt scope", async () => {
    const evidenceBefore = await Promise.all([
      oldRows(),
      ...[
        "shipping_event_roots",
        "shipping_event_details",
        "shipping_event_items",
        "shipping_event_documents",
        "shipping_lot_status_effects",
      ].map(
        async (table) =>
          (await fixture.pool.query(`SELECT to_jsonb(t)::text AS exact FROM ${table} t ORDER BY 1`))
            .rows,
      ),
    ]);
    await migrateThrough(fixture, 135);
    const evidenceAfter = await Promise.all([
      oldRows(),
      ...[
        "shipping_event_roots",
        "shipping_event_details",
        "shipping_event_items",
        "shipping_event_documents",
        "shipping_lot_status_effects",
      ].map(
        async (table) =>
          (await fixture.pool.query(`SELECT to_jsonb(t)::text AS exact FROM ${table} t ORDER BY 1`))
            .rows,
      ),
    ]);
    expect(evidenceAfter).toEqual(evidenceBefore);

    await fixture.pool.query(
      "INSERT INTO shipping_counters(tenant_id,year,sequence) VALUES($1,2026,1),($2,2026,1),($1,2027,1)",
      [first.tenant, foreign.tenant],
    );
    await expect(
      fixture.pool.query("INSERT INTO shipping_counters VALUES($1,2026,2)", [first.tenant]),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      fixture.pool.query("INSERT INTO shipping_counters VALUES($1,2028,0)", [first.tenant]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.pool.query("INSERT INTO shipping_counters VALUES($1,2028,1)", [randomUUID()]),
    ).rejects.toMatchObject({ code: "23503" });

    const key = randomUUID();
    const insert = (
      tenant: string,
      event: string,
      command: string,
      digest: string,
      result: unknown,
      operationKey = key,
    ) =>
      fixture.pool.query(
        "INSERT INTO shipping_operations(tenant_id,event_id,command,operation_key,input_digest,result) VALUES($1,$2,$3,$4,$5,$6)",
        [tenant, event, command, operationKey, digest, result],
      );
    await insert(first.tenant, finalizedShippingId, "shipping.create", "a".repeat(64), {
      eventId: finalizedShippingId,
    });
    await expect(
      insert(first.tenant, finalizedShippingId, "shipping.create", "b".repeat(64), {}),
    ).rejects.toMatchObject({ code: "23505" });
    await insert(first.tenant, finalizedShippingId, "shipping.save", "b".repeat(64), {});
    const foreignShipping = await shippingDraft(foreign.tenant);
    await insert(foreign.tenant, foreignShipping, "shipping.create", "a".repeat(64), {});
    for (const command of ["shipping.finalize", "shipping.amend", "shipping.void"]) {
      await insert(first.tenant, finalizedShippingId, command, "c".repeat(64), {}, randomUUID());
    }
    await expect(
      insert(first.tenant, first.id, "shipping.create", "a".repeat(64), {}, randomUUID()),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      insert(first.tenant, transformationId, "shipping.create", "a".repeat(64), {}, randomUUID()),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      insert(
        foreign.tenant,
        finalizedShippingId,
        "shipping.create",
        "a".repeat(64),
        {},
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      insert(
        first.tenant,
        finalizedShippingId,
        "shipping.unknown",
        "a".repeat(64),
        {},
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert(
        first.tenant,
        finalizedShippingId,
        "shipping.create",
        "A".repeat(64),
        {},
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert(
        first.tenant,
        finalizedShippingId,
        "shipping.create",
        "a".repeat(63),
        {},
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert(
        first.tenant,
        finalizedShippingId,
        "shipping.create",
        "a".repeat(64),
        "[]",
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.pool.query("UPDATE shipping_operations SET result='{}' WHERE operation_key=$1", [
        key,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.pool.query("DELETE FROM shipping_operations WHERE operation_key=$1", [key]),
    ).rejects.toMatchObject({ code: "23514" });
  }, 90_000);
});
