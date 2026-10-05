import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import {
  platformUuidSchema,
  usExportInputV1Schema,
  usTraceRequestScopeV1Schema,
  type UsExportBuildIdentity,
} from "@markiro/platform-contracts";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { transformationTransaction } from "../transformation/us-transformation-operations";
import { captureUsRequestScope, type UsRequestRow } from "./us-request-snapshot";
import { captureUsRequestTenantOrigin } from "./us-request-tenant-origin";

const table = schema.traceRequests;
const summarySchema = z
  .object({
    matchedRevisionCount: z.number().int().min(0).max(500),
    findings: usExportInputV1Schema.shape.findings,
  })
  .strict();
const ackSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z
      .string()
      .min(3)
      .max(2000)
      .refine((value) => value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value)),
  })
  .strict();
const metadata = (row: UsRequestRow) => ({
  revision: row.revision,
  digest: row.lastValidationDigest,
  warningAckDigest: row.warningAckDigest,
});
class ValidationConflict extends ConflictException {
  constructor(
    code: string,
    readonly auditContext: ReturnType<typeof metadata>,
  ) {
    super({ code });
  }
}

/** Internal authorized validation seam. No route, artifact or publication side effects. */
export class UsRequestValidationStore {
  constructor(private readonly db: Db) {}
  private async command<T>(
    tenantId: string,
    actorUserId: string,
    requestId: string,
    action: string,
    run: (tx: UsMasterDataTransaction, row: UsRequestRow) => Promise<T>,
  ): Promise<T> {
    try {
      return await transformationTransaction(this.db, async (tx) => {
        const profile = await authorizeUsMasterData(
          tx,
          tenantId,
          actorUserId,
          US_CAPABILITY.QA_MANAGE,
        );
        await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.EXPORT_READ);
        if (profile !== "US_FSMA204_PROCESSOR")
          throw new ForbiddenException({ code: "us_request_profile_unsupported" });
        const id = parseMasterDataInput(platformUuidSchema, requestId);
        const [row] = await tx
          .select()
          .from(table)
          .where(and(eq(table.tenantId, tenantId), eq(table.id, id)))
          .limit(1)
          .for("update");
        if (!row) throw new NotFoundException({ code: "us_request_not_found" });
        if (row.status !== "open" || row.scope === null)
          throw new ValidationConflict("us_request_scope_required", metadata(row));
        if (!usTraceRequestScopeV1Schema.safeParse(row.scope).success)
          throw new ServiceUnavailableException({ code: "us_request_stored_invalid" });
        return run(tx, row);
      });
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
        if (code) {
          const id = platformUuidSchema.safeParse(requestId);
          await this.db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
            await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
            await tx.insert(schema.tenantAuditEvents).values({
              organizationId: tenantId,
              actorUserId,
              action,
              outcome: error instanceof ConflictException ? "conflict" : "rejected",
              targetType: "trace_request",
              targetId: id.success ? id.data : null,
              before: null,
              after: { code, ...(error instanceof ValidationConflict ? error.auditContext : {}) },
            });
          });
        }
      }
      throw error;
    }
  }
  async validate(
    tenantId: string,
    actorUserId: string,
    requestId: string,
    build: UsExportBuildIdentity,
  ) {
    const action = "traceability.request.validated";
    return this.command(tenantId, actorUserId, requestId, action, async (tx, row) => {
      const tenantOrigin = await captureUsRequestTenantOrigin(this.db, tx, tenantId);
      const captured = await captureUsRequestScope(
        tx,
        tenantId,
        actorUserId,
        row,
        build,
        tenantOrigin,
      );
      const summary = summarySchema.parse({
        matchedRevisionCount: captured.snapshot.selection.records.length,
        findings: captured.snapshot.findings,
      });
      const now = new Date();
      const [saved] = await tx
        .update(table)
        .set({
          lastValidation: summary,
          lastValidationDigest: captured.digest,
          lastValidatedAt: now,
          warningAckDigest: null,
          warningAckReason: null,
          warningAckAt: null,
          warningAckBy: null,
        })
        .where(
          and(eq(table.tenantId, tenantId), eq(table.id, row.id), eq(table.revision, row.revision)),
        )
        .returning();
      if (!saved) throw new ValidationConflict("us_request_revision_conflict", metadata(row));
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action,
        outcome: "success",
        targetType: "trace_request",
        targetId: row.id,
        before: metadata(row),
        after: {
          ...metadata(saved),
          matchedRevisionCount: summary.matchedRevisionCount,
          findingCodes: summary.findings.map((finding) => finding.code),
        },
      });
      return {
        requestId: row.id,
        revision: row.revision,
        digest: captured.digest,
        byteSize: captured.byteSize,
        ...summary,
        validatedAt: now.toISOString(),
      };
    });
  }
  async acknowledgeWarnings(
    tenantId: string,
    actorUserId: string,
    requestId: string,
    digest: string,
    reason: string,
  ) {
    const action = "traceability.request.warnings_acknowledged";
    return this.command(tenantId, actorUserId, requestId, action, async (tx, row) => {
      const value = parseMasterDataInput(ackSchema, { digest, reason });
      if (row.lastValidationDigest !== value.digest || !row.lastValidatedAt)
        throw new ValidationConflict("us_request_validation_stale", metadata(row));
      const parsed = summarySchema.safeParse(row.lastValidation);
      if (!parsed.success)
        throw new ServiceUnavailableException({ code: "us_request_validation_stored_invalid" });
      if (!parsed.data.findings.some((finding) => finding.severity === "warning"))
        throw new ValidationConflict("us_request_warnings_required", metadata(row));
      const now = new Date();
      const [saved] = await tx
        .update(table)
        .set({
          warningAckDigest: value.digest,
          warningAckReason: value.reason,
          warningAckAt: now,
          warningAckBy: actorUserId,
        })
        .where(
          and(eq(table.tenantId, tenantId), eq(table.id, row.id), eq(table.revision, row.revision)),
        )
        .returning();
      if (!saved) throw new ValidationConflict("us_request_revision_conflict", metadata(row));
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action,
        outcome: "success",
        targetType: "trace_request",
        targetId: row.id,
        before: metadata(row),
        after: metadata(saved),
      });
      return {
        requestId: row.id,
        revision: row.revision,
        digest: value.digest,
        reason: value.reason,
        acknowledgedAt: now.toISOString(),
        acknowledgedBy: actorUserId,
      };
    });
  }
}
