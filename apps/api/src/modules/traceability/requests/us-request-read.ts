import { schema, type Db } from "@markiro/db";
import { resolveUsRequestDeadline, US_CAPABILITY } from "@markiro/domain";
import {
  platformUuidSchema,
  usRequestListQuerySchema,
  usRequestHistoryQuerySchema,
  usRequestSummarySchema,
  usRequestDetailResponseSchema,
  usRequestListResponseSchema,
  usRequestRunSummarySchema,
  usRequestRunDetailSchema,
  usRequestRunListResponseSchema,
  usRequestAttemptListResponseSchema,
  usTraceRequestCreateBodySchema,
  type UsRequestSummary,
  type UsRequestDetailData,
  type UsRequestListResponse,
  type UsRequestRunDetail,
  type UsRequestRunListResponse,
  type UsRequestAttemptListResponse,
} from "@markiro/platform-contracts";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { authorizeUsRequestHttp, type UsRequestHttpContext } from "./us-request-http-context";
import { readUsRequestPublishedState } from "./us-request-publication-read";
import { verifyUsRequestRunEvidence, type UsTraceExportRunRow } from "./us-request-run-evidence";
import { stableStringify } from "./us-request-snapshot";

type Tx = UsMasterDataTransaction;
const requests = schema.traceRequests;
const runs = schema.traceExportRuns;
const attempts = schema.traceExportAttempts;
const savedValidationSchema = usRequestDetailResponseSchema.shape.savedValidation.unwrap().pick({
  matchedRevisionCount: true,
  findings: true,
});
const summaryColumns = {
  id: requests.id,
  requestNumber: requests.requestNumber,
  revision: requests.revision,
  status: requests.status,
  receivedAt: requests.receivedAt,
  dueAt: requests.dueAt,
  createdBy: requests.createdBy,
  createdAt: requests.createdAt,
  updatedAt: requests.updatedAt,
  closedAt: requests.closedAt,
  lastValidatedAt: requests.lastValidatedAt,
};
const attemptColumns = {
  id: attempts.id,
  attemptNumber: attempts.attemptNumber,
  cycle: attempts.cycle,
  status: attempts.status,
  startedAt: attempts.startedAt,
  finishedAt: attempts.finishedAt,
  reportRenderedAt: attempts.reportRenderedAt,
  failureCode: attempts.failureCode,
  retryable: attempts.retryable,
};
type SummaryRow = Pick<typeof requests.$inferSelect, keyof typeof summaryColumns>;
type AttemptRow = Pick<typeof attempts.$inferSelect, keyof typeof attemptColumns>;
const invalid = () => new ServiceUnavailableException({ code: "us_request_stored_invalid" });
function checked<T>(contract: z.ZodType<T>, value: unknown): T {
  const parsed = contract.safeParse(value);
  if (!parsed.success || stableStringify(parsed.data) !== stableStringify(value)) throw invalid();
  return parsed.data;
}
function summary(row: SummaryRow): UsRequestSummary {
  return checked(usRequestSummarySchema, {
    id: row.id,
    requestNumber: row.requestNumber,
    revision: row.revision,
    status: row.status,
    receivedAt: row.receivedAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    lastValidatedAt: row.lastValidatedAt?.toISOString() ?? null,
  });
}
function attempt(row: AttemptRow) {
  return {
    ...row,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    reportRenderedAt: row.reportRenderedAt?.toISOString() ?? null,
  };
}

/** Public reads authorize before parsing/lookup and validate saved evidence without repair. */
export class UsRequestReadStore {
  constructor(private readonly db: Db) {}
  private async read<T>(ctx: UsRequestHttpContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='15s'`);
        await authorizeUsRequestHttp(tx, ctx, [US_CAPABILITY.READ]);
        return work(tx);
      },
      { isolationLevel: "repeatable read" },
    );
  }
  private async request(tx: Tx, ctx: UsRequestHttpContext, rawId: unknown) {
    const id = parseMasterDataInput(platformUuidSchema, rawId);
    const [row] = await tx
      .select()
      .from(requests)
      .where(and(eq(requests.tenantId, ctx.tenantId), eq(requests.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException({ code: "us_request_not_found" });
    return row;
  }
  private async run(tx: Tx, ctx: UsRequestHttpContext, rawId: unknown) {
    const id = parseMasterDataInput(platformUuidSchema, rawId);
    const [row] = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.tenantId, ctx.tenantId), eq(runs.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException({ code: "us_request_run_not_found" });
    return row;
  }
  private async runDetail(
    tx: Tx,
    ctx: UsRequestHttpContext,
    row: UsTraceExportRunRow,
  ): Promise<UsRequestRunDetail> {
    const frozen = verifyUsRequestRunEvidence(row, ctx.tenantId);
    const [latest] = await tx
      .select(attemptColumns)
      .from(attempts)
      .where(and(eq(attempts.tenantId, ctx.tenantId), eq(attempts.runId, row.id)))
      .orderBy(desc(attempts.attemptNumber))
      .limit(1);
    const publication =
      row.status === "ready" ? await readUsRequestPublishedState(tx, ctx.tenantId, row.id) : null;
    return checked(usRequestRunDetailSchema, {
      runId: row.id,
      requestId: row.requestId,
      requestRevision: frozen.validationSnapshot.request.revision,
      runRevision: row.revision,
      mode: row.mode,
      status: row.status,
      exportReady: row.exportReady,
      createdBy: row.createdBy,
      commandDigest: row.commandDigest,
      scopedContentDigest: row.scopedContentDigest,
      inputDigest: row.inputDigest,
      lifecycleVersion: row.lifecycleVersion,
      retryCycle: row.retryCycle,
      attemptCount: row.attemptCount,
      cycleAttemptCount: row.cycleAttemptCount,
      failureCode: row.failureCode,
      startedAt: row.startedAt.toISOString(),
      generationStartedAt: row.generationStartedAt?.toISOString() ?? null,
      reportRenderedAt: row.reportRenderedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      provenance:
        frozen.schemaVersion === 2 &&
        frozen.validationSnapshot.tenantOrigin.result === "trusted_synthetic"
          ? "trusted_synthetic"
          : "not_verified",
      request: frozen.validationSnapshot.request,
      scope: frozen.validationSnapshot.selection.scope,
      findings: frozen.validationSnapshot.findings,
      latestAttempt: latest ? attempt(latest) : null,
      artifacts:
        publication?.artifacts.map((file) => ({
          kind: file.kind,
          name: file.name,
          mediaType: file.mediaType,
          byteSize: file.byteSize,
          sha256: file.sha256,
        })) ?? [],
      missingFiles: publication?.expectation.manifest.missingFiles ?? null,
    });
  }
  private async runSummary(tx: Tx, ctx: UsRequestHttpContext, row: UsTraceExportRunRow) {
    const { request, scope, findings, latestAttempt, artifacts, missingFiles, ...item } =
      await this.runDetail(tx, ctx, row);
    void request;
    void scope;
    void findings;
    void latestAttempt;
    void artifacts;
    void missingFiles;
    return checked(usRequestRunSummarySchema, item);
  }
  async list(ctx: UsRequestHttpContext, rawQuery: unknown): Promise<UsRequestListResponse> {
    return this.read(ctx, async (tx) => {
      const query = parseMasterDataInput(usRequestListQuerySchema, rawQuery);
      const rows = await tx
        .select(summaryColumns)
        .from(requests)
        .where(
          and(
            eq(requests.tenantId, ctx.tenantId),
            query.status ? eq(requests.status, query.status) : undefined,
            query.requestNumber ? eq(requests.requestNumber, query.requestNumber) : undefined,
          ),
        )
        .orderBy(asc(requests.dueAt), asc(requests.id))
        .limit(query.limit + 1)
        .offset(query.offset);
      return checked(usRequestListResponseSchema, {
        items: rows.slice(0, query.limit).map(summary),
        limit: query.limit,
        offset: query.offset,
        hasMore: rows.length > query.limit,
      });
    });
  }
  async get(ctx: UsRequestHttpContext, rawId: unknown): Promise<UsRequestDetailData> {
    return this.read(ctx, async (tx) => {
      const row = await this.request(tx, ctx, rawId);
      const editable = checked(usTraceRequestCreateBodySchema, {
        requestNumber: row.requestNumber,
        requesterName: row.requesterName,
        requesterOrganization: row.requesterOrganization,
        requesterContact: row.requesterContact,
        receivedAt: row.receivedAt.toISOString(),
        dueAt: row.dueAt.toISOString(),
        alternateDeadlineReason: row.alternateDeadlineReason,
        scope: row.scope,
      });
      try {
        resolveUsRequestDeadline(
          editable.receivedAt,
          editable.dueAt,
          editable.alternateDeadlineReason,
        );
      } catch {
        throw invalid();
      }
      const [latest] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.tenantId, ctx.tenantId), eq(runs.requestId, row.id)))
        .orderBy(desc(runs.revision))
        .limit(1);
      const latestRun = latest
        ? await this.runSummary(tx, ctx, await this.run(tx, ctx, latest.id))
        : null;
      const validation =
        row.lastValidation === null ? null : checked(savedValidationSchema, row.lastValidation);
      const savedValidation =
        validation === null
          ? null
          : {
              ...validation,
              digest: row.lastValidationDigest,
              validatedAt: row.lastValidatedAt?.toISOString() ?? null,
              freshness: "not_rechecked",
            };
      const warningAcknowledgement =
        row.warningAckDigest === null &&
        row.warningAckReason === null &&
        row.warningAckBy === null &&
        row.warningAckAt === null
          ? null
          : {
              digest: row.warningAckDigest,
              reason: row.warningAckReason,
              actorId: row.warningAckBy,
              acknowledgedAt: row.warningAckAt?.toISOString() ?? null,
            };
      const result = checked(usRequestDetailResponseSchema, {
        ...summary(row),
        requesterName: editable.requesterName,
        requesterOrganization: editable.requesterOrganization,
        requesterContact: editable.requesterContact,
        alternateDeadlineReason: row.alternateDeadlineReason,
        scope: editable.scope,
        savedValidation,
        warningAcknowledgement,
        latestRun,
        availability: { build: "unknown", packageStorage: "unconfigured" },
      });
      const { availability, ...data } = result;
      void availability;
      return data;
    });
  }
  async listRuns(
    ctx: UsRequestHttpContext,
    rawId: unknown,
    rawQuery: unknown,
  ): Promise<UsRequestRunListResponse> {
    return this.read(ctx, async (tx) => {
      const query = parseMasterDataInput(usRequestHistoryQuerySchema, rawQuery);
      const request = await this.request(tx, ctx, rawId);
      const ids = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.tenantId, ctx.tenantId), eq(runs.requestId, request.id)))
        .orderBy(desc(runs.revision))
        .limit(query.limit + 1)
        .offset(query.offset);
      const items = [];
      // Retain IDs and safe summaries only; discard each frozen payload before the next read.
      for (const id of ids.slice(0, query.limit))
        items.push(await this.runSummary(tx, ctx, await this.run(tx, ctx, id.id)));
      return checked(usRequestRunListResponseSchema, {
        items,
        limit: query.limit,
        offset: query.offset,
        hasMore: ids.length > query.limit,
      });
    });
  }
  async getRun(ctx: UsRequestHttpContext, rawId: unknown): Promise<UsRequestRunDetail> {
    return this.read(ctx, async (tx) => this.runDetail(tx, ctx, await this.run(tx, ctx, rawId)));
  }
  async listAttempts(
    ctx: UsRequestHttpContext,
    rawId: unknown,
    rawQuery: unknown,
  ): Promise<UsRequestAttemptListResponse> {
    return this.read(ctx, async (tx) => {
      const query = parseMasterDataInput(usRequestHistoryQuerySchema, rawQuery);
      const row = await this.run(tx, ctx, rawId);
      await this.runSummary(tx, ctx, row);
      const rows = await tx
        .select(attemptColumns)
        .from(attempts)
        .where(and(eq(attempts.tenantId, ctx.tenantId), eq(attempts.runId, row.id)))
        .orderBy(desc(attempts.attemptNumber))
        .limit(query.limit + 1)
        .offset(query.offset);
      // Historical pre-worker counts can exceed the real saved suffix. Never invent rows.
      if (rows.some((item) => item.attemptNumber > row.attemptCount || item.cycle > row.retryCycle))
        throw invalid();
      return checked(usRequestAttemptListResponseSchema, {
        items: rows.slice(0, query.limit).map(attempt),
        limit: query.limit,
        offset: query.offset,
        hasMore: rows.length > query.limit,
      });
    });
  }
}
