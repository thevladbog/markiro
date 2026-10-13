import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { eq } from "drizzle-orm";
import type { UsPlanArtifactStore } from "../plans/us-plan-artifacts.js";
import { UsPlanStore } from "../plans/us-plan-store.js";
import { UsPlanApprovalStore } from "../plans/us-plan-approval.js";
import { readUsPlanConfiguration } from "../plans/us-plan-configuration.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";
import {
  datasetPlanError,
  equalPlan,
  parseUsDatasetPlanResult,
  type UsDatasetPlanResult,
} from "./us-dataset-plan-contract.js";
import { readOwnedPlan, planReceipt, verifyPlanReferences } from "./us-dataset-plan-verify.js";
import {
  usDatasetPlanContent,
  US_DATASET_PLAN_CONTENT_VERSION,
} from "./us-dataset-plan-content.js";

/** Internal synthetic stage only. Approval/render/provider work never holds journal locks. */
export class UsDatasetPlanSeedStore {
  private readonly journal: UsDatasetJournalStore;
  constructor(
    private readonly db: Db,
    private readonly artifacts: UsPlanArtifactStore,
  ) {
    this.journal = new UsDatasetJournalStore(db, usSixMonthDefinition);
  }
  initialize(context: UsDatasetContext): Promise<UsDatasetPlanResult> {
    return this.execute(context, true);
  }
  verify(context: UsDatasetContext): Promise<UsDatasetPlanResult> {
    return this.execute(context, false);
  }
  private async execute(
    context: UsDatasetContext,
    initialize: boolean,
  ): Promise<UsDatasetPlanResult> {
    const header = await this.journal.read(context);
    if (!header) throw datasetPlanError("incomplete");
    if (initialize) {
      const operationKey = randomUUID();
      await this.journal.prepareStageIntent(
        context,
        header.id,
        { unitKey: "plan", stage: "plan", operationKey },
        async (tx, checked) => {
          const referenceDigest = await verifyPlanReferences(
            tx,
            checked,
            header.id,
            this.db,
            this.journal,
          );
          // Serialize absence and allocation with all native public Plan commands.
          await tx
            .select({ id: schema.organization.id })
            .from(schema.organization)
            .where(eq(schema.organization.id, checked.tenantId))
            .for("update");
          if (
            (
              await tx
                .select({ id: schema.traceabilityPlanVersions.id })
                .from(schema.traceabilityPlanVersions)
                .where(eq(schema.traceabilityPlanVersions.tenantId, checked.tenantId))
                .limit(1)
            ).length
          )
            throw datasetPlanError("conflict");
          const configuredFactsDigest = canonicalExportDigest(
            (await readUsPlanConfiguration(tx, checked.tenantId)).facts,
          );
          const draft = await new UsPlanStore(this.db).createDraftCommandInTransaction(
            tx,
            checked.tenantId,
            checked.actorUserId,
            usDatasetPlanContent,
            operationKey,
          );
          const input = {
            codec: US_DATASET_PLAN_CONTENT_VERSION,
            datasetId: header.id,
            version: header.version,
            definitionDigest: header.definitionDigest,
            referenceDigest,
            configuredFactsDigest,
            content: usDatasetPlanContent,
            draft: {
              id: draft.id,
              versionNumber: draft.versionNumber,
              draftRevision: draft.draftRevision,
              createdBy: draft.createdBy,
              createdAt: draft.createdAt,
            },
            approval: {
              versionId: draft.id,
              expectedRevision: draft.draftRevision,
              idempotencyKey: operationKey,
              confirmations: {
                procedures: true,
                backupAndRecovery: true,
                contact: true,
                nonFarmScope: true,
              },
            },
          };
          return {
            unitKey: "plan",
            stage: "plan",
            operationKey,
            input,
            inputDigest: canonicalExportDigest(input),
          };
        },
      );
    }
    const probe = () =>
      this.db.transaction(
        async (tx) => {
          const stage = await this.journal.readStageInTransaction(
            tx,
            context,
            header.id,
            "plan",
            "plan",
          );
          if (!stage || (!initialize && !stage.receipt)) throw datasetPlanError("incomplete");
          const owned = await readOwnedPlan(tx, context, header.id, stage, this.db, this.journal);
          equalPlan(owned.input.approval.idempotencyKey, stage.intent.operationKey);
          return { stage, ...owned };
        },
        { isolationLevel: "repeatable read" },
      );
    let current = await probe();
    if (!current.stage.receipt) {
      // Includes effective-but-receipt-missing recovery: the original native key is retried.
      await new UsPlanApprovalStore(this.db, this.artifacts).approve(
        context.tenantId,
        context.actorUserId,
        current.input.approval,
        current.stage.intent.operationKey,
      );
      current = await probe();
    }
    const verified = current.result;
    if (!verified || !current.artifact) throw datasetPlanError("incomplete");
    await this.artifacts.readVerified(
      { tenantId: context.tenantId, versionId: verified.plan.id },
      current.artifact,
    );
    const receipt = planReceipt(verified);
    const stage = await this.journal.runAtomicStage(
      context,
      header.id,
      current.stage.revision,
      current.stage.intent,
      {
        apply: async (tx, checked) => {
          const live = await readOwnedPlan(
            tx,
            checked,
            header.id,
            current.stage,
            this.db,
            this.journal,
          );
          equalPlan(live.result, verified);
          return receipt;
        },
        verify: async (tx, checked, _intent, saved) => {
          const live = await readOwnedPlan(
            tx,
            checked,
            header.id,
            { ...current.stage, receipt: saved },
            this.db,
            this.journal,
          );
          equalPlan(live.result, verified);
          equalPlan(saved, receipt);
        },
      },
    );
    if (!stage.receipt) throw datasetPlanError("incomplete");
    return parseUsDatasetPlanResult(stage.receipt.result);
  }
}
