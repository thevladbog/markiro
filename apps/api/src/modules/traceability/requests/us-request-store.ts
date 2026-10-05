import { isDeepStrictEqual } from "node:util";
import { schema, type Db } from "@markiro/db";
import { resolveUsRequestDeadline, US_CAPABILITY } from "@markiro/domain";
import {
  platformUuidSchema,
  usTraceRequestCreateBodySchema,
  usTraceRequestUpdateBodySchema,
  usTraceRequestCloseBodySchema,
  type UsTraceRequestCreateBody,
  type UsTraceRequestUpdateBody,
  type UsTraceRequestCloseBody,
} from "@markiro/platform-contracts";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  authorizeUsMasterData,
  isUniqueConstraintViolation,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { transformationTransaction } from "../transformation/us-transformation-operations";

const table = schema.traceRequests;
type RequestRow = typeof table.$inferSelect;
const scope = (tenantId: string, id: string) => and(eq(table.tenantId, tenantId), eq(table.id, id));
const clearedValidation = {
  lastValidation: null,
  lastValidationDigest: null,
  lastValidatedAt: null,
  warningAckDigest: null,
  warningAckReason: null,
  warningAckAt: null,
  warningAckBy: null,
};
const metadata = (row: RequestRow) => ({
  revision: row.revision,
  status: row.status,
  lastValidationDigest: row.lastValidationDigest,
});

function editable(row: RequestRow) {
  return {
    requestNumber: row.requestNumber,
    requesterName: row.requesterName,
    requesterOrganization: row.requesterOrganization,
    requesterContact: row.requesterContact,
    receivedAt: row.receivedAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    alternateDeadlineReason: row.alternateDeadlineReason,
    scope: row.scope,
  };
}

function deadline(value: UsTraceRequestCreateBody) {
  try {
    return resolveUsRequestDeadline(value.receivedAt, value.dueAt, value.alternateDeadlineReason);
  } catch (error) {
    if (error instanceof RangeError) throw new BadRequestException({ code: error.message });
    throw error;
  }
}

/** Validate saved editable content before accepting a mutation or returning server state. */
function validatedRow(row: RequestRow) {
  try {
    const value = usTraceRequestCreateBodySchema.parse(editable(row));
    const resolved = resolveUsRequestDeadline(
      value.receivedAt,
      value.dueAt,
      value.alternateDeadlineReason,
    );
    if (
      resolved.alternateDeadlineReason !== row.alternateDeadlineReason ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      (row.status !== "open" && row.status !== "closed") ||
      (row.status === "closed") !== (row.closedAt !== null)
    )
      throw new Error("Invalid stored request");
    return { ...row, scope: value.scope };
  } catch {
    throw new ServiceUnavailableException({ code: "us_request_stored_invalid" });
  }
}
export type UsRequestRow = ReturnType<typeof validatedRow>;

/** Context captured only after authorization and tenant-scoped row locking. */
class RequestRevisionConflict extends ConflictException {
  constructor(readonly auditContext: ReturnType<typeof metadata> & { expectedRevision: number }) {
    super({ code: "us_request_revision_conflict" });
  }
}

/** Internal seam; tenant and actor identities must come from the verified server boundary. */
export class UsRequestStore {
  constructor(private readonly db: Db) {}

  private async command<T>(
    tenantId: string,
    actorUserId: string,
    action: string,
    id: string | null,
    run: (tx: UsMasterDataTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await transformationTransaction(this.db, async (tx) => {
        const profile = await authorizeUsMasterData(
          tx,
          tenantId,
          actorUserId,
          US_CAPABILITY.QA_MANAGE,
        );
        if (profile !== "US_FSMA204_PROCESSOR")
          throw new ForbiddenException({ code: "us_request_profile_unsupported" });
        return run(tx);
      });
    } catch (caught) {
      const error = isUniqueConstraintViolation(caught, "trace_requests_number_uq")
        ? new ConflictException({ code: "us_request_number_conflict" })
        : caught;
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        const response = error.getResponse();
        const code =
          typeof response === "object" && "code" in response && typeof response.code === "string"
            ? response.code
            : null;
        if (code) {
          const target = platformUuidSchema.safeParse(id);
          // The rejected transaction has rolled back. Never re-query private row data here.
          await this.db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
            await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
            await tx.insert(schema.tenantAuditEvents).values({
              organizationId: tenantId,
              actorUserId,
              action,
              outcome: error instanceof ConflictException ? "conflict" : "rejected",
              targetType: "trace_request",
              targetId: target.success ? target.data : null,
              before: null,
              after: {
                code,
                ...(error instanceof RequestRevisionConflict ? error.auditContext : {}),
              },
            });
          });
        }
      }
      throw error;
    }
  }

  private async success(
    tx: UsMasterDataTransaction,
    actorUserId: string,
    action: string,
    row: RequestRow,
    previous: RequestRow | null,
  ) {
    const result = validatedRow(row);
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: row.tenantId,
      actorUserId,
      action,
      outcome: "success",
      targetType: "trace_request",
      targetId: row.id,
      before: previous ? metadata(previous) : null,
      after: metadata(row),
    });
    return result;
  }

  async create(
    tenantId: string,
    actorUserId: string,
    body: UsTraceRequestCreateBody,
  ): Promise<UsRequestRow> {
    const action = "traceability.request.created";
    return this.command(tenantId, actorUserId, action, null, async (tx) => {
      const value = parseMasterDataInput(usTraceRequestCreateBodySchema, body);
      const resolved = deadline(value);
      const [row] = await tx
        .insert(table)
        .values({
          ...value,
          tenantId,
          createdBy: actorUserId,
          receivedAt: new Date(value.receivedAt),
          dueAt: new Date(resolved.dueAt),
          alternateDeadlineReason: resolved.alternateDeadlineReason,
        })
        .returning();
      if (!row) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
      return this.success(tx, actorUserId, action, row, null);
    });
  }

  private async locked(
    tx: UsMasterDataTransaction,
    tenantId: string,
    id: string,
    expectedRevision: number,
  ) {
    const requestId = parseMasterDataInput(platformUuidSchema, id);
    const [row] = await tx
      .select()
      .from(table)
      .where(scope(tenantId, requestId))
      .limit(1)
      .for("update");
    if (!row) throw new NotFoundException({ code: "us_request_not_found" });
    if (row.revision !== expectedRevision)
      throw new RequestRevisionConflict({ expectedRevision, ...metadata(row) });
    if (row.status === "closed") throw new ConflictException({ code: "us_request_closed" });
    return validatedRow(row);
  }

  async update(
    tenantId: string,
    actorUserId: string,
    requestId: string,
    body: UsTraceRequestUpdateBody,
  ): Promise<UsRequestRow> {
    const action = "traceability.request.updated";
    return this.command(tenantId, actorUserId, action, requestId, async (tx) => {
      const { expectedRevision, ...patch } = parseMasterDataInput(
        usTraceRequestUpdateBodySchema,
        body,
      );
      const previous = await this.locked(tx, tenantId, requestId, expectedRevision);
      const current = editable(previous);
      const value = parseMasterDataInput(usTraceRequestCreateBodySchema, {
        ...current,
        ...patch,
        // An omitted deadline preserves its policy: default elapsed 24h versus an agreed instant.
        dueAt:
          patch.dueAt ?? (previous.alternateDeadlineReason === null ? undefined : current.dueAt),
      });
      const resolved = deadline(value);
      const next = {
        ...value,
        receivedAt: new Date(value.receivedAt).toISOString(),
        dueAt: resolved.dueAt,
        alternateDeadlineReason: resolved.alternateDeadlineReason,
      };
      if (isDeepStrictEqual(current, next)) return previous;
      const [row] = await tx
        .update(table)
        .set({
          ...next,
          receivedAt: new Date(next.receivedAt),
          dueAt: new Date(next.dueAt),
          revision: previous.revision + 1,
          updatedAt: new Date(),
          ...clearedValidation,
        })
        .where(scope(tenantId, previous.id))
        .returning();
      if (!row) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
      return this.success(tx, actorUserId, action, row, previous);
    });
  }

  async close(
    tenantId: string,
    actorUserId: string,
    requestId: string,
    body: UsTraceRequestCloseBody,
  ): Promise<UsRequestRow> {
    const action = "traceability.request.closed";
    return this.command(tenantId, actorUserId, action, requestId, async (tx) => {
      const value = parseMasterDataInput(usTraceRequestCloseBodySchema, body);
      const previous = await this.locked(tx, tenantId, requestId, value.expectedRevision);
      const now = new Date();
      const [row] = await tx
        .update(table)
        .set({
          status: "closed",
          closedAt: now,
          updatedAt: now,
          revision: previous.revision + 1,
          ...clearedValidation,
        })
        .where(scope(tenantId, previous.id))
        .returning();
      if (!row) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
      return this.success(tx, actorUserId, action, row, previous);
    });
  }
}
