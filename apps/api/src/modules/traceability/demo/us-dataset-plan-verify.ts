import { schema, type Db } from "@markiro/db";
import {
  canonicalExportDigest,
  usPlanApprovalRequestDigest,
  usPlanIdempotencyKeyHash,
} from "@markiro/domain";
import { and, eq, ne } from "drizzle-orm";
import { UsDevelopmentOwnerStore } from "../../../deployment/us-development-owner.js";
import { UsCatalogStore } from "../catalog/us-catalog-store.js";
import { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import { UsProductProfileStore } from "../products/us-product-profile-store.js";
import { parseUsPlanDraftRow } from "../plans/us-plan-model.js";
import { parseUsPlanPublishedRow } from "../plans/us-plan-published.js";
import { readUsPlanConfiguration } from "../plans/us-plan-configuration.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext, UsDatasetStageRow } from "./us-dataset-contract.js";
import type { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { verifyUsDatasetReferences } from "./us-dataset-reference-verify.js";
import {
  datasetPlanError,
  equalPlan,
  parsePlanInput,
  parseUsDatasetPlanResult,
} from "./us-dataset-plan-contract.js";
import {
  usDatasetPlanContent,
  US_DATASET_PLAN_CONTENT_VERSION,
} from "./us-dataset-plan-content.js";

export async function verifyPlanReferences(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  datasetId: string,
  db: Db,
  journal: UsDatasetJournalStore,
) {
  const references = await journal.readStageInTransaction(
    tx,
    context,
    datasetId,
    "references",
    "references",
  );
  if (!references?.receipt) throw datasetPlanError("incomplete");
  await verifyUsDatasetReferences(tx, context, references.intent, references.receipt, {
    master: new UsMasterDataStore(db),
    catalog: new UsCatalogStore(db),
    profiles: new UsProductProfileStore(db),
  });
  return references.receipt.resultDigest;
}

/** Only invoked inside a guarded dataset transaction. Provider I/O belongs to the caller. */
export async function readOwnedPlan(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  datasetId: string,
  stage: UsDatasetStageRow,
  db: Db,
  journal: UsDatasetJournalStore,
) {
  const input = parsePlanInput(stage.intent.input);
  equalPlan(stage.intent.inputDigest, canonicalExportDigest(input));
  equalPlan(input.datasetId, datasetId);
  equalPlan(input.draft.createdBy, context.actorUserId);
  equalPlan(input.referenceDigest, await verifyPlanReferences(tx, context, datasetId, db, journal));
  const table = schema.traceabilityPlanVersions;
  // Hold the allocation/publication parent while validating the bounded owned version set.
  await tx
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, context.tenantId))
    .for("share");
  const [unowned] = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.tenantId, context.tenantId), ne(table.id, input.draft.id)))
    .limit(1);
  const [row] = await tx
    .select()
    .from(table)
    .where(and(eq(table.tenantId, context.tenantId), eq(table.id, input.draft.id)))
    .limit(1)
    .for("share");
  if (unowned || !row || row.status === "superseded") throw datasetPlanError("conflict");
  equalPlan(
    {
      id: row.id,
      versionNumber: row.versionNumber,
      draftRevision: row.draftRevision,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    },
    input.draft,
  );
  equalPlan({ sections: row.sections, changeSummary: row.changeSummary }, usDatasetPlanContent);
  if (row.status === "draft") {
    equalPlan(
      canonicalExportDigest((await readUsPlanConfiguration(tx, context.tenantId)).facts),
      input.configuredFactsDigest,
    );
    try {
      parseUsPlanDraftRow(row);
    } catch (cause) {
      throw datasetPlanError("conflict", cause);
    }
    if (stage.receipt) throw datasetPlanError("conflict");
    return { input, result: null, artifact: null };
  }
  if (
    row.status !== "effective" ||
    row.approvedBy !== context.actorUserId ||
    row.supersededById !== null
  )
    throw datasetPlanError("conflict");
  equalPlan(row.idempotencyKeyHash, usPlanIdempotencyKeyHash(input.approval.idempotencyKey));
  equalPlan(
    row.approvalRequestDigest,
    usPlanApprovalRequestDigest({ ...input.approval, tenantId: context.tenantId }),
  );
  let published: ReturnType<typeof parseUsPlanPublishedRow>;
  try {
    published = parseUsPlanPublishedRow(row);
  } catch (cause) {
    throw datasetPlanError("conflict", cause);
  }
  equalPlan(
    canonicalExportDigest(published.evidence.snapshot.configured),
    input.configuredFactsDigest,
  );
  if (published.evidence.snapshot.provenance !== "trusted_synthetic")
    throw datasetPlanError("conflict");
  const trustedSeed = await new UsDevelopmentOwnerStore(db).verifyTrustedSeed(
    context.tenantId,
    new Date(published.approvedAt),
    tx,
  );
  if (!trustedSeed) throw datasetPlanError("conflict");
  for (const confirmation of Object.values(published.evidence.confirmations))
    equalPlan(confirmation, { origin: "synthetic_fixture", trustedSeed });
  const result = parseUsDatasetPlanResult({
    datasetId,
    version: input.version,
    definitionDigest: input.definitionDigest,
    state: "plan_verified",
    datasetComplete: false,
    contentVersion: US_DATASET_PLAN_CONTENT_VERSION,
    plan: { ...input.draft, approvedBy: published.approvedBy, approvedAt: published.approvedAt },
    approvedEvidenceDigest: canonicalExportDigest(published.evidence),
    artifact: {
      descriptorDigest: canonicalExportDigest(published.artifact),
      sha256: published.artifact.sha256,
      byteSize: published.artifact.byteSize,
      rendererVersion: published.artifact.rendererVersion,
      contentType: published.artifact.contentType,
    },
  });
  if (stage.receipt) equalPlan(stage.receipt, planReceipt(result));
  return { input, result, artifact: published.artifact };
}
export function planReceipt(result: ReturnType<typeof parseUsDatasetPlanResult>) {
  return { recordIds: [result.plan.id], resultDigest: canonicalExportDigest(result), result };
}
