import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext, UsDatasetStageRow } from "./us-dataset-contract.js";
import type { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { canonicalExportDigest } from "./us-demo-canonical.js";
import { readOwnedPlan } from "./us-dataset-plan-verify.js";
import {
  checkRequestSelection,
  type DatasetRequestSelection,
} from "./us-dataset-request-selection.js";
import {
  equalRequest,
  requestError,
  parseRequestValue,
  requestInputSchema,
  packageInputSchema,
  parseUsDatasetRequestResult,
  type UsDatasetRequestServices,
} from "./us-dataset-request-contract.js";
import { captureUsRequestScope } from "../requests/us-request-snapshot.js";
import { captureUsRequestTenantOrigin } from "../requests/us-request-tenant-origin.js";
import { requireUsRequestPackageEvidence } from "../requests/us-request-run-evidence.js";
import { readUsRequestPublishedState } from "../requests/us-request-publication-read.js";
import { renderUsRequestPayloads } from "../requests/us-request-payloads.js";
import { UsRequestPlanReader } from "../requests/us-request-plan-reader.js";
import { bindUsRequestPackageInputs } from "../requests/us-request-package-inputs.js";
import { assembleUsRequestPackage } from "../requests/us-request-package.js";
import { verifyUsRequestPackageArchive } from "../requests/us-request-package-zip.js";
import { parseUsWorkerCheckpoint } from "../requests/us-request-worker-types.js";
import { UsRequestWorkerCheckpoints } from "../requests/us-request-worker-checkpoint.js";
import { UsRequestWorkerLifecycle } from "../requests/us-request-worker-lifecycle.js";
import {
  enterUsRequestVerificationOperation,
  type UsRequestVerificationFrame,
} from "../requests/us-request-verification-failure.js";

async function readOwnedAudit(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  targetId: string,
  action: string,
  operationKey: string,
  after: unknown,
) {
  const table = schema.tenantAuditEvents;
  const rows = await tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.organizationId, context.tenantId),
        eq(table.targetId, targetId),
        eq(table.action, action),
      ),
    )
    .limit(2)
    .for("share");
  const row = rows[0];
  if (rows.length !== 1 || !row) throw requestError("conflict");
  equalRequest(
    {
      actorUserId: row.actorUserId,
      requestId: row.requestId,
      outcome: row.outcome,
      targetType: row.targetType,
      before: row.before,
      after: row.after,
    },
    {
      actorUserId: context.actorUserId,
      requestId: operationKey,
      outcome: "success",
      targetType: "trace_request",
      before: null,
      after,
    },
  );
}

export const requestReceipt = (input: ReturnType<typeof requestInputSchema.parse>) => ({
  recordIds: [input.request.id],
  result: input,
  resultDigest: canonicalExportDigest(input),
});
export const resultReceipt = (result: ReturnType<typeof parseUsDatasetRequestResult>) => ({
  recordIds: [result.request.id, result.run.id],
  result,
  resultDigest: canonicalExportDigest(result),
});
export function runPin(run: typeof schema.traceExportRuns.$inferSelect) {
  return {
    id: run.id,
    revision: run.revision,
    inputDigest: run.inputDigest,
    scopedContentDigest: run.scopedContentDigest,
    frozenDigest: canonicalExportDigest(run.inputSnapshot),
    startedAt: run.startedAt.toISOString(),
  };
}
/** Requires the journal's original-owner guard in this same transaction. */
export async function readOwnedRequest(
  tx: UsDemoTransaction,
  db: Db,
  journal: UsDatasetJournalStore,
  context: UsDatasetContext,
  stage: UsDatasetStageRow,
  selected: DatasetRequestSelection,
  services: UsDatasetRequestServices,
) {
  const input = parseRequestValue(requestInputSchema, stage.intent.input);
  const live = await journal.readStageInTransaction(
    tx,
    context,
    input.datasetId,
    input.unitKey,
    "request",
  );
  if (!live) throw requestError("incomplete");
  equalRequest(live.intent, stage.intent);
  if (stage.receipt) equalRequest(live.receipt, stage.receipt);
  equalRequest(stage.intent.inputDigest, canonicalExportDigest(input));
  equalRequest(stage.intent.unitKey, input.unitKey);
  equalRequest(input.datasetId, selected.plan.datasetId);
  equalRequest(input.projectionDigest, selected.projectionDigest);
  equalRequest(input.planDigest, canonicalExportDigest(selected.plan));
  const planStage = await journal.readStageInTransaction(
    tx,
    context,
    input.datasetId,
    "plan",
    "plan",
  );
  if (!planStage?.receipt) throw requestError("incomplete");
  const plan = await readOwnedPlan(tx, context, input.datasetId, planStage, db, journal);
  equalRequest(plan.result, selected.plan);
  const table = schema.traceRequests;
  const [row] = await tx
    .select()
    .from(table)
    .where(and(eq(table.tenantId, context.tenantId), eq(table.id, input.request.id)))
    .limit(1)
    .for("share");
  if (
    !row ||
    row.createdBy !== context.actorUserId ||
    row.status !== "open" ||
    row.closedAt !== null
  )
    throw requestError("conflict");
  equalRequest(
    {
      id: row.id,
      revision: row.revision,
      receivedAt: row.receivedAt.toISOString(),
      dueAt: row.dueAt.toISOString(),
    },
    input.request,
  );
  equalRequest(
    {
      requestNumber: row.requestNumber,
      requesterName: row.requesterName,
      requesterOrganization: row.requesterOrganization,
      requesterContact: row.requesterContact,
      receivedAt: row.receivedAt.toISOString(),
      dueAt: row.dueAt.toISOString(),
      alternateDeadlineReason: row.alternateDeadlineReason,
      scope: row.scope,
    },
    input.command,
  );
  equalRequest(input.command.requestNumber, selected.recipe.reference);
  equalRequest(input.command.scope, selected.scope);
  if (row.dueAt.getTime() - row.receivedAt.getTime() !== 86_400_000) throw requestError("conflict");
  await readOwnedAudit(
    tx,
    context,
    row.id,
    "traceability.request.created",
    stage.intent.operationKey,
    {
      revision: 1,
      status: "open",
      lastValidationDigest: null,
    },
  );
  const capture = await captureUsRequestScope(
    tx,
    context.tenantId,
    context.actorUserId,
    row,
    services.execution.build,
    await captureUsRequestTenantOrigin(db, tx, context.tenantId),
  );
  checkRequestSelection(capture.snapshot, selected);
  equalRequest(capture.digest, input.sourceDigest);
  if (live.receipt) equalRequest(live.receipt, requestReceipt(input));
  return { input, row };
}
export async function readOwnedRun(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  stage: UsDatasetStageRow,
  request: Awaited<ReturnType<typeof readOwnedRequest>>,
) {
  const input = parseRequestValue(packageInputSchema, stage.intent.input);
  equalRequest(stage.intent.inputDigest, canonicalExportDigest(input));
  equalRequest(input.datasetId, request.input.datasetId);
  equalRequest(input.unitKey, request.input.unitKey);
  equalRequest(input.requestDigest, canonicalExportDigest(request.input));
  const table = schema.traceExportRuns;
  const [run] = await tx
    .select()
    .from(table)
    .where(and(eq(table.tenantId, context.tenantId), eq(table.id, input.run.id)))
    .limit(1)
    .for("share");
  if (
    !run ||
    run.requestId !== request.row.id ||
    run.createdBy !== context.actorUserId ||
    run.mode !== "export_ready" ||
    run.idempotencyKey !== stage.intent.operationKey
  )
    throw requestError("conflict");
  equalRequest(runPin(run), input.run);
  const frozen = requireUsRequestPackageEvidence(run, context.tenantId);
  equalRequest(run.scopedContentDigest, request.input.sourceDigest);
  equalRequest(frozen.validationSnapshot.request.revision, request.row.revision);
  equalRequest(frozen.warningAcknowledgement, null);
  await readOwnedAudit(
    tx,
    context,
    request.row.id,
    "traceability.request.prepared",
    stage.intent.operationKey,
    {
      runId: run.id,
      revision: run.revision,
      requestRevision: request.row.revision,
      mode: "export_ready",
      digest: request.input.sourceDigest,
      inputDigest: run.inputDigest,
    },
  );
  return { input, run };
}
export async function readOwnedPublication(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  request: Awaited<ReturnType<typeof readOwnedRequest>>,
  owned: Awaited<ReturnType<typeof readOwnedRun>>,
  selected: DatasetRequestSelection,
  services: UsDatasetRequestServices,
) {
  const publication = await readUsRequestPublishedState(tx, context.tenantId, owned.run.id);
  equalRequest(runPin(publication.run), owned.input.run);
  const table = schema.traceExportRenderCheckpoints;
  const [row] = await tx
    .select()
    .from(table)
    .where(and(eq(table.tenantId, context.tenantId), eq(table.runId, owned.run.id)))
    .limit(1)
    .for("share");
  if (!row) throw requestError("conflict");
  const checkpoint = parseUsWorkerCheckpoint({
    model: row.model,
    modelDigest: row.modelDigest,
    executionDigest: row.executionDigest,
    packageVersion: row.packageVersion,
    reportVersion: row.reportVersion,
  });
  equalRequest(checkpoint.executionDigest, services.execution.digest);
  const artifacts = publication.artifacts.map(({ objectKey, tenantId, runId, ...descriptor }) => {
    void objectKey;
    void tenantId;
    void runId;
    return descriptor;
  });
  const result = parseUsDatasetRequestResult({
    datasetId: request.input.datasetId,
    version: request.input.version,
    definitionDigest: request.input.definitionDigest,
    unitKey: request.input.unitKey,
    state: "request_package_verified",
    datasetComplete: false,
    request: request.input.request,
    run: owned.input.run,
    plan: { id: selected.plan.plan.id, sha256: selected.plan.artifact.sha256 },
    artifacts,
    artifactsDigest: canonicalExportDigest(publication.artifacts),
    publicationDigest: canonicalExportDigest({
      ...publication,
      run: Object.fromEntries(
        Object.entries(publication.run).map(([key, value]) => [
          key,
          value instanceof Date ? value.toISOString() : value,
        ]),
      ),
    }),
  });
  return { publication, checkpoint, result };
}
/** Provider work is outside journal locks; reproduce native deterministic payload and ZIP bytes. */
export async function verifyRequestBytes(
  db: Db,
  services: UsDatasetRequestServices,
  verified: Awaited<ReturnType<typeof readOwnedPublication>>,
  frame: UsRequestVerificationFrame | undefined,
) {
  const { publication } = verified;
  const { run, expectation } = publication;
  enterUsRequestVerificationOperation(frame, "render_payloads");
  const payloads = await renderUsRequestPayloads(run, run.tenantId);
  enterUsRequestVerificationOperation(frame, "read_plan");
  const plan = await new UsRequestPlanReader(db, services.planArtifacts).read(run, run.tenantId);
  enterUsRequestVerificationOperation(frame, "bind_inputs");
  const inputs = bindUsRequestPackageInputs(run, run.tenantId, payloads, plan, {
    schemaVersion: 1,
    workerStartedAt: expectation.manifest.timing.workerStartedAt,
    reportDataPreparedAt: expectation.manifest.timing.reportDataPreparedAt,
  });
  enterUsRequestVerificationOperation(frame, "check_checkpoint");
  new UsRequestWorkerCheckpoints(db, new UsRequestWorkerLifecycle(db)).assertReproduction(
    verified.checkpoint,
    inputs,
    services.execution.digest,
  );
  enterUsRequestVerificationOperation(frame, "assemble_package");
  const reproduced = await assembleUsRequestPackage(inputs);
  enterUsRequestVerificationOperation(frame, "compare_manifest");
  equalRequest(reproduced.manifest, expectation.manifest);
  enterUsRequestVerificationOperation(frame, "compare_entries");
  equalRequest(
    reproduced.files.map(({ bytes, ...d }) => {
      void bytes;
      return d;
    }),
    expectation.entries,
  );
  enterUsRequestVerificationOperation(frame, "compare_archive");
  const { bytes: zipBytes, ...zip } = reproduced.zip;
  equalRequest(zip, expectation.zip);
  for (const descriptor of publication.artifacts) {
    enterUsRequestVerificationOperation(frame, "read_private_object", descriptor.name);
    const expected =
      descriptor.name === "package.zip"
        ? zipBytes
        : reproduced.files.find((file) => file.name === descriptor.name)?.bytes;
    if (!expected) throw requestError("conflict");
    const bytes = await services.packageArtifacts.readVerified(
      { tenantId: run.tenantId, runId: run.id },
      descriptor,
    );
    enterUsRequestVerificationOperation(frame, "compare_private_object", descriptor.name);
    if (!bytes.equals(expected)) throw requestError("conflict");
    if (descriptor.name === "package.zip") {
      enterUsRequestVerificationOperation(frame, "verify_private_archive", "package.zip");
      verifyUsRequestPackageArchive(bytes, {
        files: reproduced.files,
        manifest: reproduced.manifest,
      });
    }
  }
}
