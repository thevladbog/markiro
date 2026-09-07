import { randomUUID } from "node:crypto";
import {
  receivingFinalizationSnapshotSchema,
  receivingFinalizationSnapshotV3Schema,
} from "@markiro/platform-contracts";
import type { createUsProfileTestDatabase } from "./us-profile-database";

type Fixture = Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
const connect = (f: Fixture) => f.pool.connect();
type PoolClient = Awaited<ReturnType<typeof connect>>;
/** Raw storage specimens for read tests; these do not exercise lifecycle commands or authorization. */
async function transaction<T>(f: Fixture, run: (tx: PoolClient) => Promise<T>) {
  const tx = await connect(f);
  try {
    await tx.query("BEGIN");
    const result = await run(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}

export function createStoredAmendment(f: Fixture, tenant: string, previous: string) {
  return transaction(f, async (tx) => {
    const row = (
      await tx.query<{ id: string; next_revision: number }>(
        "SELECT r.id,r.next_revision FROM receiving_event_roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.root_event_id=r.id WHERE e.tenant_id=$1 AND e.id=$2 FOR UPDATE OF r",
        [tenant, previous],
      )
    ).rows[0];
    if (!row) throw new Error("Missing synthetic root");
    const id = randomUUID();
    await tx.query(
      `INSERT INTO traceability_events(id,tenant_id,root_event_id,event_number,revision,previous_revision_id,amendment_reason,
      time_zone,date_received,location_id,previous_source_location_id,received_at_note,notes,created_by,updated_by)
      SELECT $1,tenant_id,root_event_id,event_number,$2,id,'Correct receipt',time_zone,date_received,location_id,
      previous_source_location_id,received_at_note,notes,finalized_by,finalized_by FROM traceability_events WHERE tenant_id=$3 AND id=$4`,
      [id, row.next_revision, tenant, previous],
    );
    await tx.query(
      `INSERT INTO receiving_event_items SELECT
      (jsonb_populate_record(NULL::receiving_event_items,to_jsonb(i)||jsonb_build_object('event_id',$1::text,'previous_line_no',i.line_no))).*
      FROM receiving_event_items i WHERE tenant_id=$2 AND event_id=$3`,
      [id, tenant, previous],
    );
    await tx.query(
      "INSERT INTO receiving_event_documents(tenant_id,event_id,document_id,position) SELECT tenant_id,$1,document_id,position FROM receiving_event_documents WHERE tenant_id=$2 AND event_id=$3",
      [id, tenant, previous],
    );
    await tx.query(
      "UPDATE receiving_event_roots SET pending_draft_id=$1,next_revision=next_revision+1,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
      [id, tenant, row.id],
    );
    return id;
  });
}

export function finalizeStoredAmendment(f: Fixture, tenant: string, id: string) {
  return transaction(f, async (tx) => {
    const row = (
      await tx.query<{
        root_event_id: string;
        previous_revision_id: string;
        finalized_at: Date;
        finalized_by: string;
        finalization_snapshot: unknown;
      }>(
        "SELECT e.root_event_id,e.previous_revision_id,p.finalized_at,p.finalized_by,p.finalization_snapshot FROM traceability_events e JOIN traceability_events p ON p.tenant_id=e.tenant_id AND p.id=e.previous_revision_id WHERE e.tenant_id=$1 AND e.id=$2",
        [tenant, id],
      )
    ).rows[0];
    if (!row) throw new Error("Missing synthetic predecessor");
    const snapshot = receivingFinalizationSnapshotSchema.safeParse(row.finalization_snapshot);
    const previous = snapshot.success
      ? snapshot.data
      : receivingFinalizationSnapshotV3Schema.parse(row.finalization_snapshot);
    const now = new Date(row.finalized_at.getTime() + 1000).toISOString();
    const frozen = {
      ...previous,
      snapshotVersion: 3,
      confirmation: {
        ...previous.confirmation,
        ruleVersion: "receiving-readiness-v4",
        reviewedExemptLines:
          "reviewedExemptLines" in previous.confirmation
            ? previous.confirmation.reviewedExemptLines
            : [],
      },
      items: previous.items.map((item) => ({
        ...item,
        receiptBasis:
          "receiptBasis" in item && item.receiptBasis.kind !== "ordinary"
            ? { ...item.receiptBasis, reviewedAt: now }
            : { kind: "ordinary" },
        lotBinding: {
          kind: "retained",
          previousEventId: row.previous_revision_id,
          previousLineNo: item.lineNo,
        },
      })),
    };
    await tx.query(
      "UPDATE traceability_events SET status='amended',superseded_by_event_id=$1,superseded_at=$2,superseded_by=$3 WHERE tenant_id=$4 AND id=$5",
      [id, now, row.finalized_by, tenant, row.previous_revision_id],
    );
    await tx.query(
      "UPDATE traceability_events SET status='finalized',finalized_at=$1,finalized_by=$2,updated_at=$1,updated_by=$2,finalization_snapshot=$3 WHERE tenant_id=$4 AND id=$5",
      [now, row.finalized_by, frozen, tenant, id],
    );
    await tx.query(
      "UPDATE receiving_event_roots SET current_event_id=$1,pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
      [id, tenant, row.root_event_id],
    );
    await tx.query(
      "UPDATE traceability_lots SET receiving_basis_version=receiving_basis_version+1 WHERE tenant_id=$1 AND id IN (SELECT lot_id FROM receiving_event_items WHERE tenant_id=$1 AND event_id=$2)",
      [tenant, id],
    );
    return frozen;
  });
}

export function voidStoredEvent(f: Fixture, tenant: string, id: string) {
  return transaction(f, async (tx) => {
    const row = (
      await tx.query<{ root_event_id: string; finalization_snapshot: unknown }>(
        "UPDATE traceability_events SET status='void',voided_at=now(),voided_by=updated_by,void_reason='Entered in error' WHERE tenant_id=$1 AND id=$2 RETURNING root_event_id,finalization_snapshot",
        [tenant, id],
      )
    ).rows[0];
    if (!row) throw new Error("Missing synthetic event");
    await tx.query(
      "UPDATE receiving_event_roots SET current_event_id=CASE WHEN current_event_id=$1 THEN NULL ELSE current_event_id END,pending_draft_id=CASE WHEN pending_draft_id=$1 THEN NULL ELSE pending_draft_id END,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
      [id, tenant, row.root_event_id],
    );
    if (row.finalization_snapshot !== null)
      await tx.query(
        "UPDATE traceability_lots SET receiving_basis_version=receiving_basis_version+1 WHERE tenant_id=$1 AND id IN (SELECT lot_id FROM receiving_event_items WHERE tenant_id=$1 AND event_id=$2)",
        [tenant, id],
      );
  });
}
