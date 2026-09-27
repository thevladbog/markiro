import { randomUUID } from "node:crypto";
import type { TransformationDraftRecord } from "@markiro/platform-contracts";
import {
  seedFinalizableTransformation,
  type TransformationFixtureDatabase,
} from "./us-transformation-finalization-fixture";

export async function seedTransformationRevision(f: TransformationFixtureDatabase) {
  const c = await seedFinalizableTransformation(f);
  const original = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "original");
  const receipt = await c.store.amend(
    c.tenant,
    c.actor,
    original.id,
    {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 2,
      reason: "Correct record",
    },
    "amend",
  );
  if (receipt.record.status !== "draft") throw new Error("Expected pending draft");
  return { ...c, original, amendment: receipt.record };
}
export type RevisionFixture = Awaited<ReturnType<typeof seedTransformationRevision>>;
export async function finalizationCommand(c: RevisionFixture, draft: TransformationDraftRecord) {
  const ready = await c.store.checkReadiness(c.tenant, c.actor, draft.id, {
    expectedDraftVersion: draft.draftVersion,
  });
  return {
    operationKey: randomUUID(),
    expectedDraftVersion: draft.draftVersion,
    expectedInputDigest: ready.inputDigest,
  };
}
export async function downstreamDraft(c: RevisionFixture) {
  return c.store.createDraft(
    c.tenant,
    c.actor,
    {
      operationKey: randomUUID(),
      draft: {
        ...c.saved.draft,
        inputs: c.original.snapshot.outputs.map((line) => ({
          kind: "ftl_lot",
          lotId: line.lotId,
          quantity: line.quantity,
          unitOfMeasure: line.unitOfMeasure,
        })),
        outputs: c.saved.draft.outputs.map((line) => ({ ...line, tlc: "DOWNSTREAM" })),
      },
    },
    "downstream-draft",
  );
}
export async function revisionState(f: TransformationFixtureDatabase, tenant: string) {
  const result = await f.pool.query(
    `SELECT
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM traceability_events x WHERE tenant_id=$1) events,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM transformation_event_roots x WHERE tenant_id=$1) roots,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM traceability_lots x WHERE tenant_id=$1) lots,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY event_id,input_lot_id,output_lot_id) FROM lot_genealogy_edges x WHERE tenant_id=$1) edges,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY command,operation_key) FROM transformation_operations x WHERE tenant_id=$1) receipts,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tenant_audit_events x WHERE organization_id=$1) audits`,
    [tenant],
  );
  return result.rows[0];
}
