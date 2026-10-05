import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import {
  buildUsPlanSnapshot,
  buildUsPlanDraftFactSources,
  buildUsPlanApprovedEvidence,
  canonicalExportDigest,
  type UsPlanSections,
} from "@markiro/domain";
import { transformationTransaction } from "../../src/modules/traceability/transformation/us-transformation-operations";
import { readUsPlanConfiguration } from "../../src/modules/traceability/plans/us-plan-configuration";

import { UsReceivingStore } from "../../src/modules/traceability/receiving/us-receiving-store";
import type { seedCompleteReceiving } from "./us-receiving-fixture";

/** Real saved/readiness/finalized Receiving content for frozen-payload tests. */
export async function finalizeUsRequestPayloadReceiving(
  db: Db,
  c: Awaited<ReturnType<typeof seedCompleteReceiving>>,
) {
  await db
    .update(schema.productTraceabilityProfiles)
    .set({ packagingStyle: "Case", packagingSizeValue: "10", packagingSizeUom: "lb" })
    .where(eq(schema.productTraceabilityProfiles.productId, c.product));
  const store = new UsReceivingStore(db);
  const saved = await store.createDraft(
    c.tenant,
    c.actor,
    { operationKey: randomUUID(), draft: c.draft },
    "prepare-fixture",
  );
  const checked = await store.checkReadiness(c.tenant, c.actor, saved.id, {
    expectedDraftVersion: 1,
  });
  return store.finalize(
    c.tenant,
    c.actor,
    saved.id,
    {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      expectedInputDigest: checked.inputDigest,
    },
    "prepare-fixture-finalize",
  );
}

export async function seedUsRequestPayloadPlan(
  db: Db,
  c: Awaited<ReturnType<typeof seedCompleteReceiving>>,
  versionNumber = 1,
) {
  const sections: UsPlanSections = {
    recordMaintenance: {
      systemOfRecord: "Synthetic register",
      formats: ["PDF"],
      recordLocations: ["QA"],
      responsibleRoles: ["QA"],
      backupAndRecovery: "Synthetic procedure",
      narrative: [],
    },
    ftlIdentification: { procedure: "Review FTL", reviewCadence: "On change" },
    tlcAssignment: { procedure: "Assign" },
    pointOfContact: { name: "Synthetic QA", title: "QA", phone: "+1 555 0100", email: null },
    farmActivity: { status: "no", explanation: "No farming" },
    reviewAndUpdate: { procedure: "Review changes" },
  };
  const facts = await transformationTransaction(db, (tx) => readUsPlanConfiguration(tx, c.tenant));
  const snapshot = buildUsPlanSnapshot(facts.facts, sections, "operational");
  const approvedAt = new Date("2026-10-04T00:00:00.000Z");
  const evidence = buildUsPlanApprovedEvidence(
    snapshot,
    buildUsPlanDraftFactSources(facts.facts, sections),
    {
      kind: "operational",
      actorId: c.actor,
      confirmedAt: approvedAt.toISOString(),
      confirmations: {
        procedures: true,
        backupAndRecovery: true,
        contact: true,
        nonFarmScope: true,
      },
    },
  );
  const id = randomUUID();
  const values = {
    id,
    tenantId: c.tenant,
    versionNumber,
    status: "effective",
    changeSummary: "Synthetic revision",
    sections,
    createdBy: c.actor,
    approvedBy: c.actor,
    approvedAt,
    configSnapshot: snapshot,
    configDigest: canonicalExportDigest(snapshot),
    approvedEvidence: evidence,
    idempotencyKeyHash: canonicalExportDigest(id),
    approvalRequestDigest: "c".repeat(64),
    pdfObjectKey: `us/plans/${c.tenant}/${id}/${randomUUID()}.pdf`,
    pdfSha256: "d".repeat(64),
    pdfByteSize: 100,
    rendererVersion: "us-plan-pdf-v2",
  };
  await db.transaction(async (tx) => {
    const previous = await tx
      .select()
      .from(schema.traceabilityPlanVersions)
      .where(eq(schema.traceabilityPlanVersions.tenantId, c.tenant));
    await tx
      .insert(schema.traceabilityPlanVersions)
      .values({ id, tenantId: c.tenant, versionNumber, createdBy: c.actor, sections });
    for (const row of previous.filter((row) => row.status === "effective"))
      await tx
        .update(schema.traceabilityPlanVersions)
        .set({
          status: "superseded",
          supersededById: id,
          supersededAt: new Date(),
          retainThrough: "2032-10-04",
        })
        .where(eq(schema.traceabilityPlanVersions.id, row.id));
    await tx
      .update(schema.traceabilityPlanVersions)
      .set(values)
      .where(eq(schema.traceabilityPlanVersions.id, id));
  });
  return id;
}
