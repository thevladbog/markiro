import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import type { UsDatasetContext, UsDatasetStageRow } from "./us-dataset-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import {
  UsDatasetTraceReadinessStore,
  type UsDatasetTraceReadinessResult,
  type UsDatasetTraceReadinessUnit,
} from "./us-dataset-trace-readiness.js";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

function progressError(code: "incomplete" | "conflict", unitKey: string): Error {
  return Object.assign(new Error(`us_dataset_trace_readiness_stage_${code}`), {
    unitKey,
    stage: "trace_readiness",
  });
}

/** Durable bookkeeping over independent native/read-model snapshots, without business writes. */
export class UsDatasetTraceReadinessStageStore {
  private readonly journal: UsDatasetJournalStore;
  private readonly proof: UsDatasetTraceReadinessStore;
  constructor(db: Db) {
    this.journal = new UsDatasetJournalStore(db, usSixMonthDefinition);
    this.proof = new UsDatasetTraceReadinessStore(db);
  }
  initialize(context: UsDatasetContext, unit: UsDatasetTraceReadinessUnit) {
    return this.execute(context, unit, true);
  }
  verify(context: UsDatasetContext, unit: UsDatasetTraceReadinessUnit) {
    return this.execute(context, unit, false);
  }
  private async execute(
    context: UsDatasetContext,
    unit: UsDatasetTraceReadinessUnit,
    capture: boolean,
  ): Promise<UsDatasetTraceReadinessResult> {
    // Authorization, strict selector parsing and real prerequisites belong to the native proof.
    // Its original errors (including driver failures and native stage diagnostics) pass through.
    const result = await this.proof.verify(context, unit);
    const { datasetId, version, definitionDigest, unitKey } = result;
    const selector: UsDatasetTraceReadinessUnit =
      unitKey === "orphan_0001"
        ? { kind: "orphan" }
        : unitKey === "correction_0001"
          ? { kind: "correction" }
          : { kind: "regular", index: Number(unitKey.slice(6)) };
    const predecessorStage = selector.kind === "orphan" ? "void_receiving" : "shipping";
    const predecessor = await this.journal.readStage(context, datasetId, unitKey, predecessorStage);
    if (!predecessor?.receipt || predecessor.revision !== 2)
      throw progressError("incomplete", unitKey);
    const input = {
      codec: "us-dataset-trace-readiness-stage-v1",
      datasetId,
      version,
      definitionDigest,
      unit: selector,
      predecessor: {
        unitKey: predecessor.unitKey,
        stage: predecessor.stage,
        operationKey: predecessor.intent.operationKey,
        inputDigest: predecessor.intent.inputDigest,
        resultDigest: predecessor.receipt.resultDigest,
        revision: predecessor.revision,
      },
    };
    assertBoundedSyntheticJson(input);
    const inputDigest = canonicalExportDigest(input);
    const receipt = {
      recordIds: [...new Set([...result.lotIds, ...result.currentEventIds])],
      resultDigest: canonicalExportDigest(result),
      result,
    };
    const checkedStage = (row: UsDatasetStageRow | null) => {
      if (
        row &&
        (row.unitKey !== unitKey ||
          row.stage !== "trace_readiness" ||
          row.intent.inputDigest !== inputDigest ||
          canonicalExportDigest(row.intent.input) !== inputDigest ||
          (row.receipt !== null &&
            canonicalExportDigest(row.receipt) !== canonicalExportDigest(receipt)))
      )
        throw progressError("conflict", unitKey);
      return row;
    };
    let row = checkedStage(
      await this.journal.readStage(context, datasetId, unitKey, "trace_readiness"),
    );
    if (!row && capture) {
      try {
        row = checkedStage(
          await this.journal.captureIntent(context, datasetId, {
            unitKey,
            stage: "trace_readiness",
            operationKey: randomUUID(),
            inputDigest,
            input,
          }),
        );
      } catch (error) {
        // A competitor's compatible captured body wins with its persisted operation identity.
        if (!(error instanceof Error) || error.message !== "us_dataset_intent_conflict")
          throw error;
        row = checkedStage(
          await this.journal.readStage(context, datasetId, unitKey, "trace_readiness"),
        );
        if (!row) throw error;
      }
    }
    if (!row || (!capture && !row.receipt)) throw progressError("incomplete", unitKey);
    if (row.receipt) return result;
    try {
      const completed = checkedStage(
        await this.journal.recordReceipt(
          context,
          datasetId,
          row.revision,
          unitKey,
          "trace_readiness",
          row.intent.operationKey,
          receipt,
        ),
      );
      if (!completed?.receipt) throw progressError("incomplete", unitKey);
    } catch (error) {
      if (
        error instanceof Error &&
        ["us_dataset_receipt_conflict", "us_dataset_revision_conflict"].includes(error.message)
      )
        throw progressError("conflict", unitKey);
      throw error;
    }
    return result;
  }
}
