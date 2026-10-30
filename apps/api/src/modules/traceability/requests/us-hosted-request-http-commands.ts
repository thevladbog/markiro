import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY, type UsCapability } from "@markiro/domain";
import {
  platformUuidSchema,
  usTraceRequestCreateBodySchema,
  usTraceRequestUpdateBodySchema,
  usTraceRequestCloseBodySchema,
  usRequestValidateHttpBodySchema,
  usRequestWarningAckHttpBodySchema,
  usRequestPrepareHttpBodySchema,
  usRequestRetryHttpBodySchema,
  usRequestCommandResponseSchema,
  usRequestValidationHttpResponseSchema,
  usRequestPrepareResponseSchema,
  usRequestRetryResponseSchema,
  type UsRequestCommandResponse,
  type UsRequestValidationHttpResponse,
  type UsRequestPrepareResponse,
  type UsRequestRetryResponse,
} from "@markiro/platform-contracts";
import { HttpException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  assertUsHostedRequestHttpResources,
  type UsHostedRequestHttpResources,
} from "../../../deployment/us-hosted-request-http-resources";
import { parseMasterDataInput } from "../master-data/us-master-data-support";
import { authorizeUsRequestHttp, type UsRequestHttpContext } from "./us-request-http-context";
import { UsRequestStore } from "./us-request-store";
import { UsRequestValidationStore } from "./us-request-validation";
import { UsRequestPrepareStore } from "./us-request-prepare";
import { verifyUsRequestRunEvidence } from "./us-request-run-evidence";
import { UsRequestWorkerLifecycle } from "./us-request-worker-lifecycle";

type UsHostedRequestBuild = Awaited<ReturnType<UsHostedRequestHttpResources["checkedBuild"]>>;
const qa = [US_CAPABILITY.QA_MANAGE] as const;
const exporting = [US_CAPABILITY.QA_MANAGE, US_CAPABILITY.EXPORT_READ] as const;
type Target = "trace_request" | "trace_export_run";
const unavailable = (code: string) => new ServiceUnavailableException({ code });
function response<T>(contract: z.ZodType<T>, value: unknown): T {
  const parsed = contract.safeParse(value);
  if (!parsed.success) throw unavailable("us_request_stored_invalid");
  return parsed.data;
}

/** HTTP command acknowledgements only. Each core command repeats authorization
 * and checks its locked state; this preflight grants no mutation authority. */
export class UsHostedRequestHttpCommands {
  private readonly requests: UsRequestStore;
  private readonly validation: UsRequestValidationStore;
  private readonly preparation: UsRequestPrepareStore;
  private readonly lifecycle: UsRequestWorkerLifecycle;
  constructor(
    private readonly db: Db,
    private readonly gates: UsHostedRequestHttpResources,
  ) {
    assertUsHostedRequestHttpResources(gates);
    this.requests = new UsRequestStore(db);
    this.validation = new UsRequestValidationStore(db);
    this.preparation = new UsRequestPrepareStore(db);
    this.lifecycle = new UsRequestWorkerLifecycle(db);
  }

  private async rejected(
    ctx: UsRequestHttpContext,
    id: unknown,
    targetType: Target,
    action: string,
    error: HttpException,
  ): Promise<void> {
    const value = error.getResponse();
    if (typeof value !== "object" || !("code" in value) || typeof value.code !== "string") return;
    const target = platformUuidSchema.safeParse(id);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: ctx.tenantId,
        actorUserId: ctx.userId,
        requestId: ctx.httpRequestId,
        action,
        outcome: error.getStatus() === 409 ? "conflict" : "rejected",
        targetType,
        targetId: target.success ? target.data : null,
        before: null,
        after: { code: value.code },
      });
    });
  }

  private async preflight<T>(
    ctx: UsRequestHttpContext,
    id: unknown,
    targetType: Target,
    action: string,
    capabilities: readonly UsCapability[],
    contract: z.ZodType<T>,
    body: unknown,
    gate?: () => Promise<void> | void,
  ): Promise<{ id: string; body: T }> {
    try {
      const result = await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
        if (targetType === "trace_export_run") {
          const parsed = platformUuidSchema.safeParse(id);
          const [initial] = parsed.success
            ? await tx
                .select({ createdBy: schema.traceExportRuns.createdBy })
                .from(schema.traceExportRuns)
                .where(
                  and(
                    eq(schema.traceExportRuns.tenantId, ctx.tenantId),
                    eq(schema.traceExportRuns.id, parsed.data),
                  ),
                )
                .limit(1)
            : [];
          // Match the durable retry boundary's stable caller/initiator lock order.
          const actors = [...new Set([ctx.userId, ...(initial ? [initial.createdBy] : [])])].sort();
          for (const userId of actors)
            await tx
              .select({ id: schema.member.id })
              .from(schema.member)
              .where(
                and(
                  eq(schema.member.organizationId, ctx.tenantId),
                  eq(schema.member.userId, userId),
                ),
              )
              .limit(1)
              .for("share");
          for (const userId of actors)
            await authorizeUsRequestHttp(tx, { ...ctx, userId }, capabilities);
          const runId = parseMasterDataInput(platformUuidSchema, id);
          if (!initial) throw new NotFoundException({ code: "us_request_run_not_found" });
          return { id: runId, body: parseMasterDataInput(contract, body) };
        }
        await authorizeUsRequestHttp(tx, ctx, capabilities);
        if (id === null && action === "traceability.request.created")
          return { id: "", body: parseMasterDataInput(contract, body) };
        const requestId = parseMasterDataInput(platformUuidSchema, id);
        const [owned] = await tx
          .select({ id: schema.traceRequests.id })
          .from(schema.traceRequests)
          .where(
            and(
              eq(schema.traceRequests.tenantId, ctx.tenantId),
              eq(schema.traceRequests.id, requestId),
            ),
          )
          .limit(1);
        if (!owned) throw new NotFoundException({ code: "us_request_not_found" });
        return { id: requestId, body: parseMasterDataInput(contract, body) };
      });
      await gate?.();
      return result;
    } catch (error) {
      if (error instanceof HttpException) await this.rejected(ctx, id, targetType, action, error);
      throw error;
    }
  }

  private async checkedBuild(): Promise<UsHostedRequestBuild> {
    try {
      assertUsHostedRequestHttpResources(this.gates);
      const loaded = await this.gates.checkedBuild();
      assertUsHostedRequestHttpResources(this.gates);
      return loaded;
    } catch {
      throw unavailable("us_request_build_unavailable");
    }
  }
  private packageStore(): void {
    try {
      assertUsHostedRequestHttpResources(this.gates);
      this.gates.requirePackageStore();
    } catch {
      throw unavailable("us_request_package_storage_unavailable");
    }
  }

  async create(ctx: UsRequestHttpContext, body: unknown): Promise<UsRequestCommandResponse> {
    const value = await this.preflight(
      ctx,
      null,
      "trace_request",
      "traceability.request.created",
      qa,
      usTraceRequestCreateBodySchema,
      body,
    );
    const row = await this.requests.create(ctx.tenantId, ctx.userId, value.body, ctx.httpRequestId);
    return response(usRequestCommandResponseSchema, {
      httpRequestId: ctx.httpRequestId,
      requestId: row.id,
      revision: row.revision,
      status: row.status,
    });
  }
  async update(
    ctx: UsRequestHttpContext,
    id: unknown,
    body: unknown,
  ): Promise<UsRequestCommandResponse> {
    const value = await this.preflight(
      ctx,
      id,
      "trace_request",
      "traceability.request.updated",
      qa,
      usTraceRequestUpdateBodySchema,
      body,
    );
    const row = await this.requests.update(
      ctx.tenantId,
      ctx.userId,
      value.id,
      value.body,
      ctx.httpRequestId,
    );
    return response(usRequestCommandResponseSchema, {
      httpRequestId: ctx.httpRequestId,
      requestId: row.id,
      revision: row.revision,
      status: row.status,
    });
  }
  async close(
    ctx: UsRequestHttpContext,
    id: unknown,
    body: unknown,
  ): Promise<UsRequestCommandResponse> {
    const value = await this.preflight(
      ctx,
      id,
      "trace_request",
      "traceability.request.closed",
      qa,
      usTraceRequestCloseBodySchema,
      body,
    );
    const row = await this.requests.close(
      ctx.tenantId,
      ctx.userId,
      value.id,
      value.body,
      ctx.httpRequestId,
    );
    return response(usRequestCommandResponseSchema, {
      httpRequestId: ctx.httpRequestId,
      requestId: row.id,
      revision: row.revision,
      status: row.status,
    });
  }
  async validate(
    ctx: UsRequestHttpContext,
    id: unknown,
    body: unknown,
  ): Promise<UsRequestValidationHttpResponse> {
    let loaded: UsHostedRequestBuild | undefined;
    const value = await this.preflight(
      ctx,
      id,
      "trace_request",
      "traceability.request.validated",
      exporting,
      usRequestValidateHttpBodySchema,
      body,
      async () => {
        loaded = await this.checkedBuild();
      },
    );
    if (!loaded) throw unavailable("us_request_build_unavailable");
    const result = await this.validation.validateHttp(
      ctx.tenantId,
      ctx.userId,
      value.id,
      value.body,
      loaded.build,
      ctx.httpRequestId,
    );
    return response(usRequestValidationHttpResponseSchema, {
      httpRequestId: ctx.httpRequestId,
      ...result,
    });
  }
  async acknowledgeWarnings(
    ctx: UsRequestHttpContext,
    id: unknown,
    body: unknown,
  ): Promise<UsRequestCommandResponse> {
    const value = await this.preflight(
      ctx,
      id,
      "trace_request",
      "traceability.request.warnings_acknowledged",
      exporting,
      usRequestWarningAckHttpBodySchema,
      body,
    );
    const result = await this.validation.acknowledgeWarningsHttp(
      ctx.tenantId,
      ctx.userId,
      value.id,
      value.body,
      ctx.httpRequestId,
    );
    return response(usRequestCommandResponseSchema, {
      httpRequestId: ctx.httpRequestId,
      requestId: result.requestId,
      revision: result.revision,
      status: "open",
    });
  }
  async prepare(
    ctx: UsRequestHttpContext,
    id: unknown,
    body: unknown,
  ): Promise<UsRequestPrepareResponse> {
    let loaded: UsHostedRequestBuild | undefined;
    const value = await this.preflight(
      ctx,
      id,
      "trace_request",
      "traceability.request.prepared",
      exporting,
      usRequestPrepareHttpBodySchema,
      body,
      async () => {
        loaded = await this.checkedBuild();
        this.packageStore();
      },
    );
    if (!loaded) throw unavailable("us_request_build_unavailable");
    const run = await this.preparation.prepareHttp(
      ctx.tenantId,
      ctx.userId,
      value.id,
      value.body,
      loaded.build,
      ctx.httpRequestId,
    );
    const frozen = verifyUsRequestRunEvidence(run, ctx.tenantId);
    return response(usRequestPrepareResponseSchema, {
      httpRequestId: ctx.httpRequestId,
      requestId: run.requestId,
      requestRevision: frozen.validationSnapshot.request.revision,
      runId: run.id,
      runRevision: run.revision,
      mode: run.mode,
      idempotencyKey: run.idempotencyKey,
      scopedContentDigest: run.scopedContentDigest,
    });
  }
  async retry(
    ctx: UsRequestHttpContext,
    id: unknown,
    body: unknown,
  ): Promise<UsRequestRetryResponse> {
    const value = await this.preflight(
      ctx,
      id,
      "trace_export_run",
      "traceability.request.worker.retried",
      exporting,
      usRequestRetryHttpBodySchema,
      body,
      () => {
        this.packageStore();
      },
    );
    const receipt = await this.lifecycle.retry(
      { tenantId: ctx.tenantId, runId: value.id },
      ctx.userId,
      value.body,
      ctx.httpRequestId,
    );
    return response(usRequestRetryResponseSchema, {
      httpRequestId: ctx.httpRequestId,
      runId: receipt.runId,
      cycle: receipt.cycle,
      lifecycleVersion: receipt.lifecycleVersion,
      requestedBy: receipt.requestedBy,
      idempotencyKey: receipt.idempotencyKey,
    });
  }
}
