import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { buildSscc } from "@markiro/domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  seedFinalizableTransformation,
  type TransformationFixtureDatabase,
} from "./us-transformation-finalization-fixture";

export async function seedCaseBridge(f: TransformationFixtureDatabase) {
  const c = await seedFinalizableTransformation(f);
  const original = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "case-origin");
  const output = original.snapshot.outputs[0];
  if (!output) throw new Error("Missing output");
  const shiftId = randomUUID();
  await f.db.insert(schema.shifts).values({
    id: shiftId,
    tenantId: c.tenant,
    productId: c.product,
    mode: "aggregation",
    numberMonthKey: "SEP26",
    numberSeq: 1,
  });
  const boxes = Array.from({ length: 102 }, (_, index) => ({
    id: randomUUID(),
    tenantId: c.tenant,
    shiftId,
    deviceBoxId: `synthetic-fixture-${index}`,
    sscc: buildSscc(0, "1234567", index + 1),
    ...(index === 101 ? { disassembledAt: new Date() } : {}),
  }));
  await f.db.insert(schema.boxes).values(boxes);
  await f.db.insert(schema.traceabilitySyntheticCaseOrigins).values(
    boxes.slice(0, 100).map((box) => ({
      tenantId: c.tenant,
      boxId: box.id,
      seedId: "us-case-test-fixture",
      seedVersion: 1,
    })),
  );
  const codes = boxes.slice(0, 100).map((box) => box.sscc);
  return {
    ...c,
    original,
    lotId: output.lotId,
    boxes,
    codes,
    existingCode: boxes[100]!.sscc,
    retiredCode: boxes[101]!.sscc,
    ...caseBridgeReads(f),
  };
}

export function caseBridgeReads(f: TransformationFixtureDatabase) {
  return {
    activeLinks: (tenantId: string, sscc: string) =>
      f.db
        .select()
        .from(schema.traceLotBoxes)
        .where(
          and(
            eq(schema.traceLotBoxes.tenantId, tenantId),
            eq(schema.traceLotBoxes.ssccAtLink, sscc),
            isNull(schema.traceLotBoxes.unlinkedAt),
          ),
        ),
    auditForOperation: async (tenantId: string, operationKey: string) => {
      const rows = await f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, tenantId),
            sql`${schema.tenantAuditEvents.after}->>'operationKey' = ${operationKey}`,
          ),
        );
      if (rows.length > 1) throw new Error("Duplicate operation audit");
      return rows[0];
    },
  };
}

export async function caseState(f: TransformationFixtureDatabase, tenantId: string) {
  const result = await f.pool.query(
    `SELECT
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM trace_lot_boxes x WHERE tenant_id=$1) links,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY command,operation_key) FROM trace_lot_box_operations x WHERE tenant_id=$1) receipts,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tenant_audit_events x WHERE organization_id=$1 AND action IN ('case.link','case.unlink')) audits,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM traceability_lots x WHERE tenant_id=$1) lots,
    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM traceability_events x WHERE tenant_id=$1) events,
    (SELECT jsonb_agg(jsonb_build_array(id, finalization_snapshot::text) ORDER BY id) FROM traceability_events WHERE tenant_id=$1) snapshot_bytes`,
    [tenantId],
  );
  return result.rows[0];
}
