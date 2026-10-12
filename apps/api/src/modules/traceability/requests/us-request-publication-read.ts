import { schema } from "@markiro/db";
import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import {
  requireUsRequestPackageEvidence,
  verifyUsRequestRunEvidence,
  type UsTraceExportRunRow,
} from "./us-request-run-evidence";
import { stableStringify } from "./us-request-snapshot";
import {
  parseUsWorkerCheckpoint,
  parseUsWorkerObjectEvidence,
  parseUsWorkerPackageExpectation,
  usWorkerByteSizeFromDb,
  type UsWorkerLease,
  type UsWorkerObjectEvidence,
  type UsWorkerPackageExpectation,
} from "./us-request-worker-types";

type Tx = UsMasterDataTransaction;
type Intent = typeof schema.traceExportObjectIntents.$inferSelect;
type Attempt = typeof schema.traceExportAttempts.$inferSelect;
type Artifact = typeof schema.traceExportArtifacts.$inferSelect;
const mismatch = () => new ConflictException({ code: "us_request_worker_checkpoint_mismatch" });
export const usWorkerPublicationInvalid = () =>
  new ServiceUnavailableException({ code: "us_request_worker_stored_invalid" });
const equal = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
export function usWorkerIntentEvidence(row: Intent): UsWorkerObjectEvidence {
  return parseUsWorkerObjectEvidence({
    tenantId: row.tenantId,
    runId: row.runId,
    id: row.id,
    attemptId: row.attemptId,
    name: row.name,
    kind: row.kind,
    objectKey: row.objectKey,
    mediaType: row.mediaType,
    byteSize: usWorkerByteSizeFromDb(row.byteSize),
    sha256: row.sha256,
  });
}

export function usWorkerPackageDescriptors(expectation: UsWorkerPackageExpectation) {
  return [...expectation.entries.filter((d) => d.name !== "SHA256SUMS"), expectation.zip].sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}

export async function readUsWorkerPackageExpectation(
  tx: Tx,
  row: UsTraceExportRunRow,
): Promise<UsWorkerPackageExpectation> {
  const [saved] = await tx
    .select()
    .from(schema.traceExportRenderCheckpoints)
    .where(
      and(
        eq(schema.traceExportRenderCheckpoints.tenantId, row.tenantId),
        eq(schema.traceExportRenderCheckpoints.runId, row.id),
      ),
    )
    .limit(1);
  if (!saved || saved.packageExpectation === null) throw mismatch();
  const checkpoint = parseUsWorkerCheckpoint({
    model: saved.model,
    modelDigest: saved.modelDigest,
    executionDigest: saved.executionDigest,
    packageVersion: saved.packageVersion,
    reportVersion: saved.reportVersion,
  });
  const expected = parseUsWorkerPackageExpectation(saved.packageExpectation);
  const frozen = requireUsRequestPackageEvidence(row, row.tenantId),
    model = checkpoint.model;
  if (
    !equal(model.identity, {
      tenantId: row.tenantId,
      requestId: row.requestId,
      requestRevision: frozen.validationSnapshot.request.revision,
      runId: row.id,
      runRevision: row.revision,
      mode: row.mode,
      preparedBy: row.createdBy,
    }) ||
    !equal(model.request, frozen.validationSnapshot.request) ||
    !equal(model.scope, frozen.validationSnapshot.selection.scope) ||
    !equal(model.tenantOrigin, frozen.validationSnapshot.tenantOrigin) ||
    !equal(model.plan, frozen.validationSnapshot.plan) ||
    !equal(model.digests, {
      scopedContentDigest: row.scopedContentDigest,
      inputDigest: row.inputDigest,
    }) ||
    model.timing.preparationStartedAt !== frozen.generatedAt ||
    !equal(
      model.preReportFiles,
      expected.manifest.files.filter((d) => d.name !== "request-report.pdf"),
    )
  )
    throw mismatch();
  for (const key of [
    "identity",
    "timing",
    "tenantOrigin",
    "stamps",
    "selectionSummary",
    "findingsSummary",
    "renderFindings",
    "plan",
    "digests",
    "warningAcknowledgement",
    "missingFiles",
  ] as const)
    if (!equal(model[key], expected.manifest[key])) throw mismatch();
  const [owner] = await tx
    .select()
    .from(schema.traceExportAttempts)
    .where(
      and(
        eq(schema.traceExportAttempts.tenantId, row.tenantId),
        eq(schema.traceExportAttempts.runId, row.id),
        eq(schema.traceExportAttempts.id, saved.attemptId),
      ),
    )
    .limit(1);
  if (
    !owner ||
    (model.timing.workerStartedAt !== null &&
      model.timing.workerStartedAt !== owner.startedAt.toISOString()) ||
    Date.parse(model.timing.reportDataPreparedAt) < owner.startedAt.getTime() ||
    Date.parse(model.timing.reportDataPreparedAt) > owner.deadlineAt.getTime()
  )
    throw mismatch();
  return expected;
}

export function assertUsWorkerPublicationObjects(
  rows: readonly Intent[],
  lease: UsWorkerLease,
  expected: UsWorkerPackageExpectation,
): void {
  const files = usWorkerPackageDescriptors(expected);
  if (rows.length !== files.length) throw mismatch();
  for (let n = 0; n < files.length; n++) {
    const row = rows[n],
      file = files[n];
    if (!row || !file || file.name === "SHA256SUMS") throw mismatch();
    const evidence = usWorkerIntentEvidence(row);
    if (
      evidence.tenantId !== lease.tenantId ||
      evidence.runId !== lease.runId ||
      evidence.attemptId !== lease.attemptId ||
      !equal(
        {
          name: evidence.name,
          mediaType: evidence.mediaType,
          byteSize: evidence.byteSize,
          sha256: evidence.sha256,
        },
        file,
      )
    )
      throw mismatch();
  }
}

export function assertUsWorkerPublicationWinner(
  row: UsTraceExportRunRow,
  attempts: readonly Attempt[],
  expected: UsWorkerPackageExpectation,
  lease?: UsWorkerLease,
): Attempt {
  const winners = attempts.filter((a) => a.status === "succeeded"),
    winner = winners[0];
  if (
    winners.length !== 1 ||
    !winner ||
    !row.completedAt ||
    !row.reportRenderedAt ||
    row.failureCode !== null ||
    row.exportReady !== (row.mode === "export_ready") ||
    winner.finishedAt?.getTime() !== row.completedAt.getTime() ||
    winner.reportRenderedAt?.getTime() !== row.reportRenderedAt.getTime() ||
    row.completedAt.getTime() >= winner.leaseExpiresAt.getTime() ||
    row.completedAt.getTime() >= winner.deadlineAt.getTime() ||
    row.reportRenderedAt.getTime() > row.completedAt.getTime() ||
    row.reportRenderedAt.getTime() < Date.parse(expected.manifest.timing.reportDataPreparedAt) ||
    winner.attemptNumber !== row.attemptCount ||
    winner.cycle !== row.retryCycle ||
    row.leaseAttemptId !== null ||
    row.leaseToken !== null ||
    row.leaseExpiresAt !== null ||
    row.attemptDeadlineAt !== null ||
    (lease &&
      (winner.id !== lease.attemptId ||
        winner.token !== lease.token ||
        winner.startedAt.toISOString() !== lease.startedAt ||
        winner.deadlineAt.toISOString() !== lease.deadlineAt))
  )
    throw usWorkerPublicationInvalid();

  return winner;
}
export function assertUsWorkerPublicationReferences(
  row: UsTraceExportRunRow,
  objects: readonly Intent[],
  artifacts: readonly Artifact[],
): void {
  if (!row.completedAt) throw usWorkerPublicationInvalid();
  for (const object of objects) {
    const artifact = artifacts.find((a) => a.filename === object.name);
    if (
      object.state !== "referenced" ||
      !object.verifiedAt ||
      object.fencedAt ||
      object.deletedAt ||
      object.referencedAt?.getTime() !== row.completedAt.getTime() ||
      !artifact ||
      artifact.tenantId !== row.tenantId ||
      artifact.runId !== row.id ||
      artifact.kind !== object.kind ||
      artifact.objectKey !== object.objectKey ||
      artifact.mediaType !== object.mediaType ||
      artifact.byteSize !== object.byteSize ||
      artifact.sha256 !== object.sha256 ||
      artifact.publishedAt.getTime() !== row.completedAt.getTime()
    )
      throw usWorkerPublicationInvalid();
  }
}
export interface UsRequestPublishedState {
  readonly run: UsTraceExportRunRow;
  readonly expectation: UsWorkerPackageExpectation;
  readonly artifacts: readonly UsWorkerObjectEvidence[];
}

/** Internal committed evidence only. Caller authorization belongs to its transaction boundary. */
export async function readUsRequestPublishedState(
  tx: Tx,
  tenantId: string,
  runId: string,
): Promise<UsRequestPublishedState> {
  const runs = schema.traceExportRuns;
  const [run] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.tenantId, tenantId), eq(runs.id, runId)))
    .limit(1);
  if (!run) throw new NotFoundException({ code: "us_request_run_not_found" });
  verifyUsRequestRunEvidence(run, tenantId);
  if (run.status !== "ready") throw new ConflictException({ code: "us_request_run_not_ready" });
  try {
    const expectation = await readUsWorkerPackageExpectation(tx, run);
    const table = schema.traceExportAttempts;
    const winners = await tx
      .select()
      .from(table)
      .where(
        and(eq(table.tenantId, tenantId), eq(table.runId, runId), eq(table.status, "succeeded")),
      )
      .limit(2);
    const winner = assertUsWorkerPublicationWinner(run, winners, expectation);
    const intents = schema.traceExportObjectIntents;
    const objects = await tx
      .select()
      .from(intents)
      .where(
        and(
          eq(intents.tenantId, tenantId),
          eq(intents.runId, runId),
          eq(intents.attemptId, winner.id),
        ),
      )
      .orderBy(asc(intents.name))
      .limit(7);
    const lease: UsWorkerLease = {
      tenantId,
      runId,
      attemptId: winner.id,
      attemptNumber: winner.attemptNumber,
      cycle: winner.cycle,
      token: winner.token,
      startedAt: winner.startedAt.toISOString(),
      expiresAt: winner.leaseExpiresAt.toISOString(),
      deadlineAt: winner.deadlineAt.toISOString(),
    };
    assertUsWorkerPublicationObjects(objects, lease, expectation);
    const artifacts = schema.traceExportArtifacts;
    const rows = await tx
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.tenantId, tenantId), eq(artifacts.runId, runId)))
      .limit(7);
    if (rows.length !== objects.length) throw usWorkerPublicationInvalid();
    assertUsWorkerPublicationReferences(run, objects, rows);
    return { run, expectation, artifacts: objects.map(usWorkerIntentEvidence) };
  } catch {
    throw usWorkerPublicationInvalid();
  }
}
