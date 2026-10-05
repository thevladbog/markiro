import { schema, type Db } from "@markiro/db";
import { buildUsExportWorkbook, canonicalExportDigest, US_CAPABILITY } from "@markiro/domain";
import {
  platformUuidSchema,
  usExportInputV1Schema,
  usTraceRequestPrepareBodySchema,
  type ExportSourceRecord,
  type UsExportBuildIdentity,
  type UsTraceRequestPrepareBody,
} from "@markiro/platform-contracts";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, max, sql } from "drizzle-orm";
import {
  authorizeUsMasterData,
  isUniqueConstraintViolation,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { transformationTransaction } from "../transformation/us-transformation-operations";
import {
  captureUsRequestScope,
  stableStringify,
  US_REQUEST_SNAPSHOT_LIMIT,
  type UsRequestSnapshot,
} from "./us-request-snapshot";

import {
  currentChain,
  selectsEvents,
  parseUsRequestFrozenRun,
  verifyUsRequestRunEvidence,
} from "./us-request-run-evidence";
import { captureUsRequestTenantOrigin } from "./us-request-tenant-origin";

const requests = schema.traceRequests;
const runs = schema.traceExportRuns;
const action = "traceability.request.prepared";
class PrepareConflict extends ConflictException {
  constructor(
    code: string,
    readonly auditContext: { requestRevision: number; digest: string | null },
  ) {
    super({ code });
  }
}
const unavailable = () =>
  new ServiceUnavailableException({ code: "us_request_prepare_unavailable" });

/** A current Transformation can depend on earlier producers, never on itself.
 * Receiving is terminal; no quantity allocation is inferred from these edges. */
function assertAcyclicProvenance(snapshot: UsRequestSnapshot): void {
  const transformations = new Set(
    snapshot.sources
      .filter(
        (source) => source.type === "transformation" && source.lifecycle === "current_finalized",
      )
      .map((source) => source.eventId),
  );
  const producers = new Map<string, Set<string>>();
  for (const relation of snapshot.selection.relations)
    if (relation.role === "output" && transformations.has(relation.eventId)) {
      const ids = producers.get(relation.lotId) ?? new Set<string>();
      ids.add(relation.eventId);
      producers.set(relation.lotId, ids);
    }
  const dependencies = new Map<string, Set<string>>();
  for (const relation of snapshot.selection.relations)
    if (relation.role === "input" && transformations.has(relation.eventId)) {
      const ids = dependencies.get(relation.eventId) ?? new Set<string>();
      for (const producer of producers.get(relation.lotId) ?? []) ids.add(producer);
      dependencies.set(relation.eventId, ids);
    }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id))
      throw new ServiceUnavailableException({ code: "us_request_provenance_invalid" });
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of transformations) visit(id);
}

/** Current graph eligibility uses frozen lot bindings; history is retained but is not itself a blocker. */
function hasCurrentChain(
  snapshot: UsRequestSnapshot,
  current: readonly ExportSourceRecord[],
): boolean {
  const ids = new Set(current.map((source) => source.eventId));
  const currentRelations = snapshot.selection.relations.filter((relation) =>
    ids.has(relation.eventId),
  );
  const origins = new Set(
    currentRelations
      .filter((relation) => relation.role === "receiving" || relation.role === "output")
      .map((relation) => relation.lotId),
  );
  const currentRoots = new Set(
    snapshot.selection.records
      .filter((record) => ids.has(record.eventId))
      .map((record) => record.rootEventId),
  );
  // Lot-only selection also emits event seeds for every touching revision.
  // Only an explicit event predicate makes an otherwise excluded root required.
  return (
    current.length > 0 &&
    currentRelations.every(
      (relation) =>
        (relation.role !== "input" && relation.role !== "shipping") || origins.has(relation.lotId),
    ) &&
    snapshot.selection.seeds.every((seed) =>
      seed.kind === "lot"
        ? origins.has(seed.id)
        : !selectsEvents(snapshot) ||
          snapshot.selection.records.some(
            (record) => record.eventId === seed.id && currentRoots.has(record.rootEventId),
          ),
    )
  );
}

/** Internal freeze only: no HTTP registration, artifact bytes, artifact rows or publication. */
export class UsRequestPrepareStore {
  constructor(private readonly db: Db) {}

  async prepare(
    tenantId: string,
    actorUserId: string,
    requestId: string,
    body: UsTraceRequestPrepareBody,
    build: UsExportBuildIdentity,
  ): Promise<typeof runs.$inferSelect> {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await transformationTransaction(this.db, (tx) =>
            this.prepareWithinTransaction(tx, tenantId, actorUserId, requestId, body, build),
          );
        } catch (error) {
          if (
            !isUniqueConstraintViolation(error, "trace_export_runs_idempotency_uq") &&
            !isUniqueConstraintViolation(error, "trace_export_runs_revision_uq")
          )
            throw error;
          if (attempt === 2) throw unavailable();
        }
      }
      throw unavailable();
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        const response = error.getResponse();
        const code =
          typeof response === "object" && "code" in response && typeof response.code === "string"
            ? response.code
            : null;
        const id = platformUuidSchema.safeParse(requestId);
        const command = usTraceRequestPrepareBodySchema.safeParse(body);
        if (code && id.success)
          await this.db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
            await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
            const [owned] = await tx
              .select({ id: requests.id })
              .from(requests)
              .where(and(eq(requests.tenantId, tenantId), eq(requests.id, id.data)));
            if (!owned) return;
            await tx.insert(schema.tenantAuditEvents).values({
              organizationId: tenantId,
              actorUserId,
              action,
              outcome: error instanceof ConflictException ? "conflict" : "rejected",
              targetType: "trace_request",
              targetId: id.data,
              before: null,
              after: {
                code,
                ...(command.success ? { mode: command.data.mode } : {}),
                ...(error instanceof PrepareConflict ? error.auditContext : {}),
              },
            });
          });
      }
      throw error;
    }
  }

  private async prepareWithinTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    requestId: string,
    body: UsTraceRequestPrepareBody,
    build: UsExportBuildIdentity,
  ): Promise<typeof runs.$inferSelect> {
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='15s'`);
    const profile = await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.QA_MANAGE);
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.EXPORT_READ);
    if (profile !== "US_FSMA204_PROCESSOR")
      throw new ForbiddenException({ code: "us_request_profile_unsupported" });
    const id = parseMasterDataInput(platformUuidSchema, requestId);
    const value = parseMasterDataInput(usTraceRequestPrepareBodySchema, body);
    const [request] = await tx
      .select()
      .from(requests)
      .where(and(eq(requests.tenantId, tenantId), eq(requests.id, id)))
      .limit(1)
      .for("update");
    if (!request) throw new NotFoundException({ code: "us_request_not_found" });
    const conflict = (code: string) =>
      new PrepareConflict(code, {
        requestRevision: request.revision,
        digest: request.lastValidationDigest,
      });
    const commandDigest = canonicalExportDigest({
      schemaVersion: 1,
      requestId: id,
      mode: value.mode,
    });
    const [stored] = await tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.tenantId, tenantId),
          eq(runs.createdBy, actorUserId),
          eq(runs.idempotencyKey, value.idempotencyKey),
        ),
      );
    if (stored) {
      if (stored.createdBy !== actorUserId)
        throw new ServiceUnavailableException({ code: "us_request_run_stored_invalid" });
      verifyUsRequestRunEvidence(stored, tenantId);
      if (stored.commandDigest !== commandDigest) throw conflict("us_request_idempotency_conflict");
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "traceability.request.prepare_replayed",
        outcome: "success",
        targetType: "trace_request",
        targetId: stored.requestId,
        before: null,
        after: {
          runId: stored.id,
          revision: stored.revision,
          mode: stored.mode,
          digest: stored.scopedContentDigest,
          inputDigest: stored.inputDigest,
        },
      });
      return stored;
    }
    if (request.status !== "open") throw conflict("us_request_closed");
    if (!request.lastValidationDigest || !request.lastValidatedAt)
      throw conflict("us_request_validation_required");
    const tenantOrigin = await captureUsRequestTenantOrigin(this.db, tx, tenantId);
    const captured = await captureUsRequestScope(
      tx,
      tenantId,
      actorUserId,
      request,
      build,
      tenantOrigin,
    );
    if (captured.digest !== request.lastValidationDigest)
      throw conflict("us_request_validation_stale");
    if (captured.snapshot.selection.records.length > 500)
      throw conflict("us_request_selection_limit");
    if (captured.byteSize > US_REQUEST_SNAPSHOT_LIMIT) throw conflict("us_request_snapshot_limit");
    const snapshot = captured.snapshot;
    assertAcyclicProvenance(snapshot);
    const events = value.mode === "export_ready" ? currentChain(snapshot) : snapshot.sources;
    if (value.mode === "export_ready" && (!snapshot.plan || !hasCurrentChain(snapshot, events)))
      throw conflict("us_request_not_export_ready");
    const currentPins = new Set(events.map((source) => `${source.eventId}:${source.revision}`));
    const findings =
      value.mode === "export_ready"
        ? snapshot.findings.filter(
            (finding) =>
              // This global finding describes the full history model. The
              // current-only model is independently checked below. Other global
              // policies remain blocking, including future unknown error codes.
              finding.code !== "workbook_unrepresentable" &&
              (!finding.eventId ||
                (finding.revision === undefined
                  ? events.some((event) => event.eventId === finding.eventId)
                  : currentPins.has(`${finding.eventId}:${finding.revision}`))),
          )
        : snapshot.findings;
    const generatedAt = new Date();
    const mode =
      value.mode === "export_ready" ? "export_ready_candidate" : "available_records_incomplete";
    let input = events.length
      ? usExportInputV1Schema.parse({
          schemaVersion: 1,
          tenantId,
          mode,
          events,
          findings,
          metadata: {
            mode,
            profile: snapshot.profile,
            scopeLabel: snapshot.request.requestNumber,
            timeZone: snapshot.timeZone,
            generatedAt: generatedAt.toISOString(),
            baselineId: snapshot.baselineId,
            registryId: snapshot.registryId,
            registryVersion: snapshot.registryVersion,
            registryHash: snapshot.registryHash,
            build: snapshot.build,
          },
        })
      : null;
    if (input) {
      const checked = buildUsExportWorkbook(input);
      if (checked.failure && value.mode === "export_ready")
        throw conflict("us_request_workbook_unrepresentable");
      // Capture already contains model findings. Preserve one copy per finding
      // when evaluating the chosen mode again.
      const unique = new Map(
        checked.findings.map((finding) => [stableStringify(finding), finding]),
      );
      input = usExportInputV1Schema.parse({
        ...input,
        findings: [...unique]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([, finding]) => finding),
      });
    }
    if (value.mode === "export_ready") {
      if (input?.findings.some((finding) => finding.severity === "error"))
        throw conflict("us_request_not_export_ready");
      if (
        input?.findings.some((finding) => finding.severity === "warning") &&
        (request.warningAckDigest !== captured.digest ||
          !request.warningAckAt ||
          !request.warningAckBy ||
          !request.warningAckReason)
      )
        throw conflict("us_request_warning_ack_required");
    }
    const parsed = parseUsRequestFrozenRun({
      schemaVersion: 2,
      selectionKind: input ? "events" : "empty",
      mode: value.mode,
      generatedAt: generatedAt.toISOString(),
      preparedBy: actorUserId,
      validationSnapshot: snapshot,
      exportInput: input,
      warningAcknowledgement:
        request.warningAckDigest === captured.digest && request.warningAckAt
          ? {
              digest: request.warningAckDigest,
              reason: request.warningAckReason,
              actorId: request.warningAckBy,
              acknowledgedAt: request.warningAckAt.toISOString(),
            }
          : null,
    });
    if (!parsed) throw unavailable();
    if (Buffer.byteLength(stableStringify(parsed), "utf8") > US_REQUEST_SNAPSHOT_LIMIT)
      throw conflict("us_request_snapshot_limit");
    const [maximum] = await tx
      .select({ revision: max(runs.revision) })
      .from(runs)
      .where(and(eq(runs.tenantId, tenantId), eq(runs.requestId, id)));
    const [run] = await tx
      .insert(runs)
      .values({
        tenantId,
        requestId: id,
        revision: (maximum?.revision ?? 0) + 1,
        mode: value.mode,
        status: "queued",
        exportReady: false,
        createdBy: actorUserId,
        idempotencyKey: value.idempotencyKey,
        commandDigest,
        scopedContentDigest: captured.digest,
        inputSnapshot: parsed,
        inputDigest: input ? canonicalExportDigest(input) : null,
        planVersionId: snapshot.plan?.id ?? null,
        planPdfSha256: snapshot.plan?.pdfSha256 ?? null,
        registryVersion: snapshot.registryVersion,
        registryHash: snapshot.registryHash,
        startedAt: generatedAt,
      })
      .returning();
    if (!run) throw unavailable();
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action,
      outcome: "success",
      targetType: "trace_request",
      targetId: id,
      before: null,
      after: {
        runId: run.id,
        revision: run.revision,
        requestRevision: request.revision,
        mode: value.mode,
        digest: captured.digest,
        inputDigest: run.inputDigest,
      },
    });
    return run;
  }
}
