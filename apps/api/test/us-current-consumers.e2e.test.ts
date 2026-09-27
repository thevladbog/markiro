import { randomUUID } from "node:crypto";
import { receivingAmendmentDraftSchema } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { listCurrentTransformationConsumers } from "../src/modules/traceability/lots/us-current-consumers";
import {
  seedFinalizableTransformation,
  type TransformationFixtureDatabase,
} from "./support/us-transformation-finalization-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Current Transformation consumers protect Receiving origins", () => {
  let f: TransformationFixtureDatabase;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  const voidCommand = () => ({
    commandVersion: 2,
    operationKey: randomUUID(),
    expectedLifecycleVersion: 2,
    expectedDraftVersion: null,
    reason: "Incorrect origin",
  });
  async function state(tenant: string) {
    return (
      await f.pool.query(
        `SELECT
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM traceability_events e WHERE tenant_id=$1) AS events,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM receiving_event_roots r WHERE tenant_id=$1) AS receiving_roots,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM transformation_event_roots r WHERE tenant_id=$1) AS transformation_roots,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM traceability_lots l WHERE tenant_id=$1) AS lots,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY event_id,line_no) FROM transformation_event_outputs i WHERE tenant_id=$1) AS outputs,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY event_id,input_lot_id,output_lot_id) FROM lot_genealogy_edges g WHERE tenant_id=$1) AS edges,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY command,operation_key) FROM receiving_operations o WHERE tenant_id=$1) AS receiving_operations,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY command,operation_key) FROM transformation_operations o WHERE tenant_id=$1) AS transformation_operations,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM tenant_audit_events a WHERE organization_id=$1) AS audit`,
        [tenant],
      )
    ).rows;
  }
  async function lots(tenant: string) {
    return (
      await f.pool.query<{ lot: Record<string, unknown>; id: string; epoch: number }>(
        "SELECT id,current_dependency_version AS epoch,to_jsonb(l)-'current_dependency_version' AS lot FROM traceability_lots l WHERE tenant_id=$1 ORDER BY id",
        [tenant],
      )
    ).rows;
  }
  it("blocks void with exact current consumers, preserving every effect and excluding foreign details", async () => {
    const c = await seedFinalizableTransformation(f);
    await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "consumer");
    const before = await state(c.tenant);
    await expect(
      c.receiving.void(c.tenant, c.actor, c.origin.id, voidCommand(), "blocked"),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "traceability_downstream_blocked",
        blockers: c.origin.snapshot.items
          .map((line) => ({
            lotId: line.lotId,
            eventId: c.saved.id,
            rootId: c.saved.id,
            revision: 1,
          }))
          .sort((a, b) => a.lotId.localeCompare(b.lotId)),
      },
    });
    expect(await state(c.tenant)).toEqual(before);
    const foreign = await seedCompleteReceiving(f.db);
    await expect(
      c.receiving.void(foreign.tenant, foreign.actor, c.origin.id, voidCommand(), "foreign"),
    ).rejects.toHaveProperty("response", { code: "receiving_draft_not_found" });
    expect(await state(c.tenant)).toEqual(before);
  });
  it("selects only the typed root's current revision and excludes amended and void history", async () => {
    const c = await seedFinalizableTransformation(f);
    const original = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "consumer");
    const id = randomUUID(),
      now = new Date().toISOString();
    const snapshot = {
      ...original.snapshot,
      eventId: id,
      revision: 2,
      previousRevisionId: original.id,
      finalizedAt: now,
    };
    const tx = await f.pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(
        `INSERT INTO traceability_events(id,tenant_id,root_event_id,type,event_number,revision,previous_revision_id,amendment_reason,time_zone,event_date,location_id,notes,created_by,updated_by)
        SELECT $1,tenant_id,root_event_id,type,event_number,2,id,'Documentary correction',time_zone,event_date,location_id,notes,created_by,updated_by FROM traceability_events WHERE tenant_id=$2 AND id=$3`,
        [id, c.tenant, original.id],
      );
      await tx.query(
        "UPDATE transformation_event_roots SET pending_draft_id=$1,next_revision=3,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
        [id, c.tenant, original.id],
      );
      await tx.query(
        "INSERT INTO transformation_event_details(tenant_id,event_id,reason,reason_note) SELECT tenant_id,$1,reason,reason_note FROM transformation_event_details WHERE tenant_id=$2 AND event_id=$3",
        [id, c.tenant, original.id],
      );
      await tx.query(
        "INSERT INTO transformation_event_inputs(tenant_id,event_id,line_no,kind,lot_id,product_id,source_location_id,reference,quantity,unit_of_measure) SELECT tenant_id,$1,line_no,kind,lot_id,product_id,source_location_id,reference,quantity,unit_of_measure FROM transformation_event_inputs WHERE tenant_id=$2 AND event_id=$3",
        [id, c.tenant, original.id],
      );
      await tx.query(
        "INSERT INTO transformation_event_outputs(tenant_id,event_id,line_no,lot_id,product_id,tlc,quantity,unit_of_measure) SELECT tenant_id,$1,line_no,lot_id,product_id,tlc,quantity,unit_of_measure FROM transformation_event_outputs WHERE tenant_id=$2 AND event_id=$3",
        [id, c.tenant, original.id],
      );
      await tx.query(
        "INSERT INTO transformation_event_documents(tenant_id,event_id,document_id,position) SELECT tenant_id,$1,document_id,position FROM transformation_event_documents WHERE tenant_id=$2 AND event_id=$3",
        [id, c.tenant, original.id],
      );
      await tx.query(
        "INSERT INTO lot_genealogy_edges(tenant_id,event_id,input_lot_id,output_lot_id) SELECT tenant_id,$1,input_lot_id,output_lot_id FROM lot_genealogy_edges WHERE tenant_id=$2 AND event_id=$3",
        [id, c.tenant, original.id],
      );
      await tx.query(
        "UPDATE traceability_events SET status='amended',superseded_by_event_id=$1,superseded_at=$4,superseded_by=$5 WHERE tenant_id=$2 AND id=$3",
        [id, c.tenant, original.id, now, c.actor],
      );
      await tx.query(
        "UPDATE traceability_events SET status='finalized',finalized_at=$3,updated_at=$3,finalized_by=$4,finalization_snapshot=$5 WHERE tenant_id=$1 AND id=$2",
        [c.tenant, id, now, c.actor, snapshot],
      );
      await tx.query(
        "UPDATE transformation_event_roots SET current_event_id=$1,pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$2 AND id=$3",
        [id, c.tenant, original.id],
      );
      await tx.query("COMMIT");
      const lotIds = c.origin.snapshot.items.map((line) => line.lotId);
      expect(
        await f.db.transaction((tx) =>
          listCurrentTransformationConsumers(tx, c.tenant, [...lotIds, ...lotIds]),
        ),
      ).toEqual(
        lotIds.sort().map((lotId) => ({ lotId, eventId: id, rootId: original.id, revision: 2 })),
      );
      expect(
        await f.db.transaction((tx) => listCurrentTransformationConsumers(tx, c.tenant, [])),
      ).toEqual([]);
      expect(
        await f.db.transaction((tx) =>
          listCurrentTransformationConsumers(tx, randomUUID(), lotIds),
        ),
      ).toEqual([]);
      await tx.query("BEGIN");
      await tx.query(
        "UPDATE traceability_events SET status='void',voided_at=now(),voided_by=$3,void_reason='Historical revision' WHERE tenant_id=$1 AND id=$2",
        [c.tenant, id, c.actor],
      );
      await tx.query(
        "UPDATE transformation_event_roots SET current_event_id=NULL,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$1 AND id=$2",
        [c.tenant, original.id],
      );
      await tx.query("COMMIT");
      expect(
        await f.db.transaction((tx) => listCurrentTransformationConsumers(tx, c.tenant, lotIds)),
      ).toEqual([]);
      expect(
        (await c.receiving.void(c.tenant, c.actor, c.origin.id, voidCommand(), "history-allowed"))
          .record.status,
      ).toBe("void");
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  });
  it("finalizing a consumer increments only input dependency epochs once, including replay", async () => {
    const c = await seedFinalizableTransformation(f),
      before = await lots(c.tenant);
    const result = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "consumer");
    expect((await lots(c.tenant)).filter((row) => before.some((old) => old.id === row.id))).toEqual(
      before.map((row) => ({ ...row, epoch: row.epoch + 1 })),
    );
    const committed = await state(c.tenant);
    expect(await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "replay")).toEqual(
      result,
    );
    expect(await state(c.tenant)).toEqual(committed);
    expect(
      (
        await f.pool.query(
          "SELECT organization_id,actor_user_id,action,outcome,target_type,target_id,before,after,request_id FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.transformation.finalized'",
          [c.tenant],
        )
      ).rows,
    ).toEqual([
      {
        organization_id: c.tenant,
        actor_user_id: c.actor,
        action: "traceability.transformation.finalized",
        outcome: "success",
        target_type: "traceability_event",
        target_id: c.saved.id,
        before: c.saved,
        after: result,
        request_id: "consumer",
      },
    ]);
  });
  it.each(["draft", "void"])("a %s consumer does not block origin void", async (status) => {
    const c = await seedFinalizableTransformation(f);
    if (status === "void") {
      await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "consumer");
      const tx = await f.pool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query(
          "UPDATE traceability_events SET status='void',voided_at=now(),voided_by=$3,void_reason='Historical consumer' WHERE tenant_id=$1 AND id=$2",
          [c.tenant, c.saved.id, c.actor],
        );
        await tx.query(
          "UPDATE transformation_event_roots SET current_event_id=NULL,lifecycle_version=lifecycle_version+1 WHERE tenant_id=$1 AND id=$2",
          [c.tenant, c.saved.id],
        );
        await tx.query("COMMIT");
      } finally {
        await tx.query("ROLLBACK");
        tx.release();
      }
    }
    const before = await lots(c.tenant);
    expect(
      (await c.receiving.void(c.tenant, c.actor, c.origin.id, voidCommand(), "allowed")).record
        .status,
    ).toBe("void");
    expect(
      (await lots(c.tenant))
        .filter((row) => c.origin.snapshot.items.some((line) => line.lotId === row.id))
        .map((row) => row.epoch),
    ).toEqual(
      before
        .filter((row) => c.origin.snapshot.items.some((line) => line.lotId === row.id))
        .map((row) => row.epoch + 1),
    );
  });
  it.each([true, false])(
    "material amendment=%s is reclassified against current consumers at finalization",
    async (material) => {
      const c = await seedFinalizableTransformation(f);
      await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "consumer");
      const amended = await c.receiving.amend(
        c.tenant,
        c.actor,
        c.origin.id,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          reason: "Correction",
        },
        "amend",
      );
      if (amended.record.content.kind !== "draft") throw new Error("Missing amendment");
      const draft = receivingAmendmentDraftSchema.parse(amended.record.content.draft);
      await c.receiving.saveAmendment(
        c.tenant,
        c.actor,
        amended.eventId,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedLifecycleVersion: 3,
          draft: {
            ...draft,
            notes: "Correct documentary note",
            items: draft.items.map((line) => ({
              ...line,
              quantity: material ? "499" : line.quantity,
            })),
          },
        },
        "save",
      );
      const ready = await c.receiving.checkRevisionReadiness(c.tenant, c.actor, amended.eventId, {
        expectedDraftVersion: 2,
      });
      const command = {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedDraftVersion: 2,
        expectedLifecycleVersion: ready.expectedLifecycleVersion,
        previousRevisionId: ready.previousRevisionId,
        expectedInputDigest: ready.inputDigest,
        reviewedExemptLines: ready.exemptReviewRequiredLines,
      };
      const before = await state(c.tenant),
        beforeLots = await lots(c.tenant);
      const result = c.receiving.finalizeRevision(
        c.tenant,
        c.actor,
        amended.eventId,
        command,
        "amend-finalize",
      );
      if (material) {
        await expect(result).rejects.toMatchObject({
          status: 409,
          response: { code: "traceability_downstream_blocked" },
        });
        expect(await state(c.tenant)).toEqual(before);
      } else {
        expect((await result).record.status).toBe("finalized");
        expect((await lots(c.tenant)).map((row) => row.epoch)).toEqual(
          beforeLots.map((row) => row.epoch),
        );
        expect(
          (await c.receiving.getLiveRecord(c.tenant, c.actor, c.origin.id)).lifecycle
            .supersededByEventId,
        ).toBe(amended.eventId);
      }
    },
  );
  it.each(["consumer", "void"])(
    "exhausted dependency epoch rolls back %s and its evidence",
    async (action) => {
      const c = await seedFinalizableTransformation(f);
      await f.pool.query(
        "UPDATE traceability_lots SET current_dependency_version=2147483647 WHERE tenant_id=$1",
        [c.tenant],
      );
      const ready = await c.store.checkReadiness(c.tenant, c.actor, c.saved.id, {
        expectedDraftVersion: 1,
      });
      const before = await state(c.tenant);
      await expect(
        action === "consumer"
          ? c.store.finalize(
              c.tenant,
              c.actor,
              c.saved.id,
              { ...c.command, expectedInputDigest: ready.inputDigest },
              "overflow",
            )
          : c.receiving.void(c.tenant, c.actor, c.origin.id, voidCommand(), "overflow"),
      ).rejects.toMatchObject({ status: 503 });
      expect(await state(c.tenant)).toEqual(before);
    },
  );
});
