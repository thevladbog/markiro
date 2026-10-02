import { isDeepStrictEqual } from "node:util";
import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import {
  platformUuidSchema,
  usPlanDraftCreateBodySchema,
  usPlanDraftSaveBodySchema,
  usPlanDraftDiscardBodySchema,
} from "@markiro/platform-contracts";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, desc, eq, max, sql } from "drizzle-orm";
import {
  authorizeUsMasterData,
  isUniqueConstraintViolation,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { parseUsPlanDraftRow, type UsPlanDraftView, type UsPlanVersionRow } from "./us-plan-model";

type PublishedSummary = {
  id: string;
  versionNumber: number;
  status: "effective" | "superseded";
  draftRevision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  approvedBy: string;
  approvedAt: string;
  supersededAt: string | null;
  retainThrough: string | null;
};
export type UsPlanVersionView = UsPlanDraftView | PublishedSummary;
function view(row: UsPlanVersionRow): UsPlanVersionView {
  if (row.status === "draft") return parseUsPlanDraftRow(row);
  if (
    (row.status !== "effective" && row.status !== "superseded") ||
    !row.approvedBy ||
    !row.approvedAt
  )
    throw new ServiceUnavailableException({ code: "us_plan_stored_version_invalid" });
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    status: row.status,
    draftRevision: row.draftRevision,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null,
    retainThrough: row.retainThrough,
  };
}
const table = schema.traceabilityPlanVersions;
const scope = (tenantId: string, id: string) => and(eq(table.tenantId, tenantId), eq(table.id, id));
const metadata = (row: UsPlanVersionRow) => ({
  versionNumber: row.versionNumber,
  draftRevision: row.draftRevision,
});

/** Captured only after authorization and a tenant-scoped draft lock; never re-query after rollback. */
class DraftRevisionConflict extends ConflictException {
  constructor(
    readonly auditContext: {
      expectedRevision: number;
      versionNumber: number;
      draftRevision: number;
    },
  ) {
    super({ code: "us_plan_revision_conflict" });
  }
}

/** Internal only: all identity arguments come from a verified server boundary. */
export class UsPlanStore {
  constructor(private readonly db: Db) {}
  private async authorize(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    write: boolean,
  ) {
    const profile = await authorizeUsMasterData(
      tx,
      tenantId,
      actorUserId,
      write ? US_CAPABILITY.QA_MANAGE : US_CAPABILITY.READ,
    );
    if (profile !== "US_FSMA204_PROCESSOR")
      throw new ForbiddenException({ code: "us_plan_profile_unsupported" });
  }
  async listVersions(
    tenantId: string,
    actorUserId: string,
    _requestId: string,
  ): Promise<{ items: UsPlanVersionView[] }> {
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, tenantId, actorUserId, false);
      const rows = await tx
        .select()
        .from(table)
        .where(eq(table.tenantId, tenantId))
        .orderBy(desc(table.versionNumber));
      return { items: rows.map(view) };
    });
  }
  async getVersion(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    _requestId: string,
  ): Promise<UsPlanVersionView> {
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, tenantId, actorUserId, false);
      const versionId = parseMasterDataInput(platformUuidSchema, id);
      const [row] = await tx.select().from(table).where(scope(tenantId, versionId)).limit(1);
      if (!row) throw new NotFoundException({ code: "us_plan_version_not_found" });
      return view(row);
    });
  }
  private async command<T>(
    tenantId: string,
    actorUserId: string,
    requestId: string,
    action: string,
    id: unknown,
    run: (tx: UsMasterDataTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.authorize(tx, tenantId, actorUserId, true);
        // Organization -> version lock order serializes allocation even when no draft exists.
        const [organization] = await tx
          .select({ id: schema.organization.id })
          .from(schema.organization)
          .where(eq(schema.organization.id, tenantId))
          .for("update");
        if (!organization) throw new NotFoundException({ code: "us_plan_version_not_found" });
        return run(tx);
      });
    } catch (caught) {
      const error = isUniqueConstraintViolation(caught, "traceability_plan_one_draft_uq")
        ? new ConflictException({ code: "us_plan_draft_exists" })
        : isUniqueConstraintViolation(caught, "traceability_plan_tenant_version_uq")
          ? new ConflictException({ code: "us_plan_version_conflict" })
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
          // Audited after rollback; infra/audit failures propagate for retry.
          await this.db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
            await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
            await tx.insert(schema.tenantAuditEvents).values({
              organizationId: tenantId,
              actorUserId,
              requestId,
              action,
              outcome: error instanceof ConflictException ? "conflict" : "rejected",
              targetType: "traceability_plan_version",
              targetId: target.success ? target.data : null,
              before: null,
              after: {
                code,
                ...(error instanceof DraftRevisionConflict ? error.auditContext : {}),
              },
            });
          });
        }
      }
      throw error;
    }
  }
  async createDraft(
    tenantId: string,
    actorUserId: string,
    input: unknown,
    requestId: string,
  ): Promise<UsPlanDraftView> {
    const action = "traceability.plan.draft_created";
    return this.command(tenantId, actorUserId, requestId, action, null, async (tx) => {
      const value = parseMasterDataInput(usPlanDraftCreateBodySchema, input);
      const [draft] = await tx
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.tenantId, tenantId), eq(table.status, "draft")))
        .limit(1);
      if (draft) throw new ConflictException({ code: "us_plan_draft_exists" });
      const [maximum] = await tx
        .select({ number: max(table.versionNumber) })
        .from(table)
        .where(eq(table.tenantId, tenantId));
      const [row] = await tx
        .insert(table)
        .values({
          tenantId,
          createdBy: actorUserId,
          versionNumber: (maximum?.number ?? 0) + 1,
          ...value,
        })
        .returning();
      if (!row) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        requestId,
        action,
        outcome: "success",
        targetType: "traceability_plan_version",
        targetId: row.id,
        before: null,
        after: metadata(row),
      });
      return parseUsPlanDraftRow(row);
    });
  }
  private async lockedDraft(
    tx: UsMasterDataTransaction,
    tenantId: string,
    id: unknown,
    revision: number,
  ) {
    const versionId = parseMasterDataInput(platformUuidSchema, id);
    const [row] = await tx
      .select()
      .from(table)
      .where(scope(tenantId, versionId))
      .limit(1)
      .for("update");
    if (!row) throw new NotFoundException({ code: "us_plan_version_not_found" });
    if (row.status !== "draft") throw new ConflictException({ code: "us_plan_not_draft" });
    if (row.draftRevision !== revision)
      throw new DraftRevisionConflict({ expectedRevision: revision, ...metadata(row) });
    parseUsPlanDraftRow(row);
    return row;
  }
  async saveDraft(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<UsPlanDraftView> {
    const action = "traceability.plan.draft_updated";
    return this.command(tenantId, actorUserId, requestId, action, id, async (tx) => {
      const value = parseMasterDataInput(usPlanDraftSaveBodySchema, input);
      const previous = await this.lockedDraft(tx, tenantId, id, value.expectedRevision);
      if (
        isDeepStrictEqual(previous.sections, value.sections) &&
        previous.changeSummary === value.changeSummary
      )
        return parseUsPlanDraftRow(previous);
      const [row] = await tx
        .update(table)
        .set({
          sections: value.sections,
          changeSummary: value.changeSummary,
          draftRevision: previous.draftRevision + 1,
          updatedAt: new Date(),
        })
        .where(scope(tenantId, previous.id))
        .returning();
      if (!row) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        requestId,
        action,
        outcome: "success",
        targetType: "traceability_plan_version",
        targetId: row.id,
        before: metadata(previous),
        after: metadata(row),
      });
      return parseUsPlanDraftRow(row);
    });
  }
  async discardDraft(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<void> {
    const action = "traceability.plan.draft_discarded";
    return this.command(tenantId, actorUserId, requestId, action, id, async (tx) => {
      const value = parseMasterDataInput(usPlanDraftDiscardBodySchema, input);
      const row = await this.lockedDraft(tx, tenantId, id, value.expectedRevision);
      await tx.delete(table).where(scope(tenantId, row.id));
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        requestId,
        action,
        outcome: "success",
        targetType: "traceability_plan_version",
        targetId: row.id,
        before: metadata(row),
        after: null,
      });
    });
  }
}
