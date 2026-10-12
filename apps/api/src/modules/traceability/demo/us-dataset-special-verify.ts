import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { UsDatasetAtomicStageWork } from "./us-dataset-atomic-stage-contract.js";
import { parseUsDatasetIntent, type UsDatasetReceipt } from "./us-dataset-contract.js";
import type { UsDatasetReceivingStores } from "./us-dataset-receiving-verify.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import {
  datasetSpecialError,
  makeUsDatasetSpecialStageIdentity,
  parseUsDatasetSpecialResult,
  usDatasetSpecialRecordIds,
  type UsDatasetSpecialLifecycleResult,
} from "./us-dataset-special-contract.js";
import {
  specialEqual,
  verifySpecialBindings,
  verifySpecialOperationsAndAudits,
} from "./us-dataset-special-evidence.js";

export type UsDatasetSpecialStores = UsDatasetReceivingStores;
/** Joint verification never recurses. The explicit lifecycle candidate precedes journal persistence. */
export async function verifyUsDatasetSpecial(
  ...[tx, context, rawIntent, rawReceipt, stores]: [
    ...Parameters<UsDatasetAtomicStageWork["verify"]>,
    UsDatasetSpecialStores,
  ]
): ReturnType<UsDatasetAtomicStageWork["verify"]> {
  const intent = parseUsDatasetIntent(rawIntent);
  const receipt = parseUsDemoReceipt(rawReceipt);
  const result = parseUsDatasetSpecialResult(receipt.result);
  const original = result.stage === "receiving" ? result : result.original;
  const equal = (a: unknown, b: unknown) => specialEqual(a, b, original);
  const mismatch = (cause?: unknown) =>
    datasetSpecialError("us_dataset_special_mismatch", intent.unitKey, result.stage, cause);
  const check = (ownedIntent: typeof intent, ownedReceipt: UsDatasetReceipt) => {
    const ownedResult = parseUsDatasetSpecialResult(ownedReceipt.result);
    equal(
      ownedIntent.unitKey,
      ownedResult.input.kind === "correction" ? "correction_0001" : "orphan_0001",
    );
    equal(ownedIntent.stage, ownedResult.stage);
    equal(ownedIntent.input, ownedResult.input);
    equal(ownedReceipt.resultDigest, canonicalExportDigest(ownedResult));
    equal(ownedReceipt.recordIds, usDatasetSpecialRecordIds(ownedResult));
    equal(
      ownedIntent.operationKey,
      ownedResult.stage === "receiving"
        ? ownedResult.created.operationKey
        : ownedResult.stage === "amend_receiving"
          ? ownedResult.started.operationKey
          : ownedResult.voided.operationKey,
    );
    return ownedResult;
  };
  check(intent, receipt);
  // Lock actual same-tenant business root first, then all revisions and sorted lots.
  const roots = schema.receivingEventRoots,
    events = schema.traceabilityEvents,
    lots = schema.traceabilityLots;
  const rootId = original.created.eventId;
  const [root] = await tx
    .select()
    .from(roots)
    .where(and(eq(roots.tenantId, context.tenantId), eq(roots.id, rootId)))
    .for("update");
  if (!root) throw mismatch();
  const revisions = await tx
    .select()
    .from(events)
    .where(and(eq(events.tenantId, context.tenantId), eq(events.rootEventId, rootId)))
    .orderBy(asc(events.id))
    .for("update");
  const ids = original.lots.map((l) => l.id).sort();
  equal(
    (
      await tx
        .select({ id: lots.id })
        .from(lots)
        .where(and(eq(lots.tenantId, context.tenantId), inArray(lots.id, ids)))
        .orderBy(asc(lots.id))
        .for("update")
    ).map((l) => l.id),
    ids,
  );
  const datasetId = original.input.references.datasetId;
  const originalStage = await stores.journal.readStageInTransaction(
    tx,
    context,
    datasetId,
    intent.unitKey,
    "receiving",
  );
  if (!originalStage) throw mismatch();
  let lifecycle: UsDatasetSpecialLifecycleResult | null = null;
  if (result.stage !== "receiving") {
    if (!originalStage.receipt) throw mismatch();
    const candidateStage = await stores.journal.readStageInTransaction(
      tx,
      context,
      datasetId,
      intent.unitKey,
      result.stage,
    );
    if (!candidateStage) throw mismatch();
    equal(candidateStage.intent, intent);
    if (candidateStage.receipt) equal(candidateStage.receipt, receipt);
    equal(check(originalStage.intent, originalStage.receipt), original);
    equal(makeUsDatasetSpecialStageIdentity(datasetId, originalStage), result.input.receiving);
    lifecycle = result;
  } else {
    equal(originalStage.intent, intent);
    if (originalStage.receipt) equal(originalStage.receipt, receipt);
    const completed = await stores.journal.readStageInTransaction(
      tx,
      context,
      datasetId,
      intent.unitKey,
      result.input.kind === "correction" ? "amend_receiving" : "void_receiving",
    );
    if (completed?.receipt) {
      const selected = check(completed.intent, completed.receipt);
      if (selected.stage === "receiving" || !originalStage.receipt) throw mismatch();
      equal(selected.original, original);
      equal(selected.input.receiving, makeUsDatasetSpecialStageIdentity(datasetId, originalStage));
      lifecycle = selected;
    }
  }
  equal(
    {
      current: root.currentEventId,
      pending: root.pendingDraftId,
      version: root.lifecycleVersion,
      next: root.nextRevision,
      number: root.eventNumber,
    },
    {
      current:
        lifecycle?.stage === "void_receiving"
          ? null
          : lifecycle?.stage === "amend_receiving"
            ? lifecycle.finalized.eventId
            : rootId,
      pending: null,
      version: lifecycle?.stage === "amend_receiving" ? 4 : lifecycle ? 3 : 2,
      next: lifecycle?.stage === "amend_receiving" ? 3 : 2,
      number: original.finalized.record.eventNumber,
    },
  );
  equal(
    revisions.map((r) => r.id).sort(),
    lifecycle?.stage === "amend_receiving"
      ? [rootId, lifecycle.finalized.eventId].sort()
      : [rootId],
  );
  if (revisions.some((r) => r.type !== "receiving")) throw mismatch();
  try {
    const historical =
      lifecycle?.stage === "amend_receiving"
        ? lifecycle.predecessor
        : lifecycle?.stage === "void_receiving"
          ? lifecycle.voided.record
          : original.finalized.record;
    equal(
      await stores.receiving.getLiveRecordInTransaction(
        tx,
        context.tenantId,
        context.actorUserId,
        rootId,
      ),
      historical,
    );
    if (lifecycle?.stage === "amend_receiving")
      equal(
        await stores.receiving.getLiveRecordInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          lifecycle.finalized.eventId,
        ),
        lifecycle.finalized.record,
      );
    await verifySpecialBindings(tx, context, original, lifecycle, revisions, stores);
    await verifySpecialOperationsAndAudits(tx, context, original, lifecycle);
  } catch (cause) {
    if (
      cause instanceof NotFoundException ||
      cause instanceof ServiceUnavailableException ||
      (cause instanceof Error &&
        (cause.name === "ZodError" || cause.message === "us_dataset_reference_mismatch"))
    )
      throw mismatch(cause);
    throw cause;
  }
}
