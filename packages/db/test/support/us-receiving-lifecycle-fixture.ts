import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PoolClient } from "pg";
import { copyMigrationsThroughIndex } from "./legacy-migrations.js";
import type { Fixture, Specimen } from "./us-receiving-snapshot-fixture.js";

export async function migrateThrough(f: Fixture, index: number) {
  const folder = await mkdtemp(join(tmpdir(), "markiro-us-lifecycle-migrations-"));
  try {
    await copyMigrationsThroughIndex({
      sourceFolder: resolve("migrations"),
      targetFolder: folder,
      lastIncludedIndex: index,
    });
    await migrate(f.db, { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Raw SQL is deliberate: exercise storage guarantees without the future API. */
export async function amendment(tx: PoolClient, c: Specimen, previous = c.id) {
  const id = randomUUID();
  const root = (
    await tx.query<{ next_revision: number }>(
      "SELECT next_revision FROM receiving_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [c.tenant, c.id],
    )
  ).rows[0];
  if (!root) throw new Error("Missing root fixture");
  await tx.query(
    `INSERT INTO traceability_events(id,tenant_id,root_event_id,event_number,revision,previous_revision_id,amendment_reason,
    time_zone,date_received,location_id,previous_source_location_id,received_at_note,notes,created_by,updated_by)
    SELECT $1,tenant_id,root_event_id,event_number,$2,id,'Correct receipt',time_zone,date_received,location_id,previous_source_location_id,
    received_at_note,notes,'qa-user','qa-user' FROM traceability_events WHERE tenant_id=$3 AND id=$4`,
    [id, root.next_revision, c.tenant, previous],
  );
  await tx.query(
    `INSERT INTO receiving_event_items(tenant_id,event_id,line_no,previous_line_no,product_id,lot_id,lot_link_mode,tlc,
    quantity,unit_of_measure,source_location_id,source_reference_kind,source_reference_value,source_reference_location_id,
    exempt_supplier,exempt_reason,exempt_receipt,supplier_lot_reference,notes)
    SELECT tenant_id,$1,line_no,line_no,product_id,lot_id,lot_link_mode,tlc,quantity,unit_of_measure,source_location_id,
    source_reference_kind,source_reference_value,source_reference_location_id,exempt_supplier,exempt_reason,exempt_receipt,
    supplier_lot_reference,notes FROM receiving_event_items WHERE tenant_id=$2 AND event_id=$3`,
    [id, c.tenant, previous],
  );
  await tx.query(
    "INSERT INTO receiving_event_documents(tenant_id,event_id,document_id,position) SELECT tenant_id,$1,document_id,position FROM receiving_event_documents WHERE tenant_id=$2 AND event_id=$3",
    [id, c.tenant, previous],
  );
  await tx.query(
    "UPDATE receiving_event_roots SET pending_draft_id=$1,next_revision=next_revision+1,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
    [id, c.tenant, c.id],
  );
  return id;
}

export async function voidEvent(tx: PoolClient, c: Specimen, id: string) {
  await tx.query(
    "UPDATE traceability_events SET status='void',voided_at='2026-09-07T12:00:00.000Z',voided_by='qa-user',void_reason='Entered in error' WHERE tenant_id=$1 AND id=$2",
    [c.tenant, id],
  );
  await tx.query(
    "UPDATE receiving_event_roots SET pending_draft_id=CASE WHEN pending_draft_id=$1 THEN NULL ELSE pending_draft_id END,current_event_id=CASE WHEN current_event_id=$1 THEN NULL ELSE current_event_id END,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
    [id, c.tenant, c.id],
  );
}

export function retainedSnapshot(c: Specimen, previous = c.id) {
  return {
    ...c.snapshot,
    snapshotVersion: 3,
    items: c.snapshot.items.map((item) => ({
      ...item,
      receiptBasis:
        item.receiptBasis?.kind && item.receiptBasis.kind !== "ordinary"
          ? { ...item.receiptBasis, reviewedAt: "2026-09-07T11:00:00.000Z" }
          : { kind: "ordinary" },
      lotBinding: { kind: "retained", previousEventId: previous, previousLineNo: item.lineNo },
    })),
    confirmation: {
      ...c.snapshot.confirmation,
      ruleVersion: "receiving-readiness-v4",
      reviewedExemptLines: c.snapshot.confirmation.reviewedExemptLines ?? [],
    },
  };
}

export async function finalizeAmendment(
  tx: PoolClient,
  c: Specimen,
  id: string,
  snapshot: unknown = retainedSnapshot(c),
  previous = c.id,
) {
  await tx.query(
    "UPDATE traceability_events SET status='amended',superseded_by_event_id=$1,superseded_at='2026-09-07T11:00:00.000Z',superseded_by='qa-user' WHERE tenant_id=$2 AND id=$3",
    [id, c.tenant, previous],
  );
  await tx.query(
    "UPDATE traceability_events SET status='finalized',finalized_at='2026-09-07T11:00:00.000Z',updated_at='2026-09-07T11:00:00.000Z',finalized_by='qa-user',updated_by='qa-user',finalization_snapshot=$1 WHERE tenant_id=$2 AND id=$3",
    [snapshot, c.tenant, id],
  );
  await tx.query(
    "UPDATE receiving_event_roots SET current_event_id=$1,pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
    [id, c.tenant, c.id],
  );
}
