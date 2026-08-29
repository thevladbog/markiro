import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { INVENTORY_CHZ_STATUSES, type InventoryChzStatus } from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import { PgBossService } from "../../jobs/jobs.module";
import { ChzTokenService } from "./chz-token.service";
import type { ChzExportPreflightCode, ChzExportRunDto, ChzExportStateDto } from "./dto";

@Injectable()
export class ChzExportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokens: ChzTokenService,
    private readonly jobs: PgBossService,
  ) {}

  async getState(tenantId: string, inventoryId: string): Promise<ChzExportStateDto> {
    const blockedBy = await this.preflight(tenantId, inventoryId);
    return {
      available: blockedBy.length === 0,
      blockedBy,
      runs: await this.runs(tenantId, inventoryId),
    };
  }

  /**
   * All four conditions are reported together rather than one at a time so the
   * operator fixes everything in one pass instead of discovering the next
   * problem after each fix.
   */
  private async preflight(
    tenantId: string,
    inventoryId: string,
  ): Promise<ChzExportPreflightCode[]> {
    const blocked: ChzExportPreflightCode[] = [];

    const [profile] = await this.db
      .select({ inn: schema.orgProfiles.inn })
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, tenantId));
    if (!profile?.inn || !/^\d{10}(\d{2})?$/.test(profile.inn)) blocked.push("INN_MISSING");

    const [product] = await this.db
      .select({ code: schema.products.chzProductGroupCode })
      .from(schema.inventories)
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.inventories.tenantId),
          eq(schema.products.id, schema.inventories.productId),
        ),
      )
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    if (!product) throw new NotFoundException();
    if (product.code === null) blocked.push("PRODUCT_GROUP_MISSING");

    const [agent] = await this.db
      .select({ id: schema.chzSignerAgents.id })
      .from(schema.chzSignerAgents)
      .where(
        and(
          eq(schema.chzSignerAgents.tenantId, tenantId),
          eq(schema.chzSignerAgents.status, "active"),
        ),
      )
      .limit(1);
    if (!agent) blocked.push("AGENT_NOT_PAIRED");

    const token = await this.tokens.getActiveToken(tenantId);
    if (token.status !== "ok") blocked.push("TOKEN_UNAVAILABLE");

    return blocked;
  }

  async order(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
  ): Promise<ChzExportStateDto> {
    const blockedBy = await this.preflight(tenantId, inventoryId);
    if (blockedBy.length > 0) {
      throw new UnprocessableEntityException({ code: "CHZ_EXPORT_PREFLIGHT_FAILED", blockedBy });
    }
    await this.db.transaction(async (tx) => {
      for (const status of INVENTORY_CHZ_STATUSES) {
        // Insert a queued run, or reset a failed one; never touch a run that is
        // queued, ordered, ready or imported -- re-ordering an export that has
        // already arrived burns the finite daily quota for nothing.
        await tx
          .insert(schema.chzExportRuns)
          .values({ tenantId, inventoryId, status, state: "queued", orderedByUserId: actorUserId })
          .onConflictDoUpdate({
            target: [
              schema.chzExportRuns.tenantId,
              schema.chzExportRuns.inventoryId,
              schema.chzExportRuns.status,
            ],
            set: this.resetToQueued(actorUserId),
            setWhere: eq(schema.chzExportRuns.state, "failed"),
          });
      }
    });
    await this.jobs.enqueueChzExportOrder(tenantId, inventoryId);
    return this.getState(tenantId, inventoryId);
  }

  async retry(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    status: InventoryChzStatus,
  ): Promise<ChzExportStateDto> {
    const updated = await this.db
      .update(schema.chzExportRuns)
      .set(this.resetToQueued(actorUserId))
      .where(
        and(
          eq(schema.chzExportRuns.tenantId, tenantId),
          eq(schema.chzExportRuns.inventoryId, inventoryId),
          eq(schema.chzExportRuns.status, status),
          eq(schema.chzExportRuns.state, "failed"),
        ),
      )
      .returning({ id: schema.chzExportRuns.id });
    if (updated.length === 0) throw new ConflictException({ code: "CHZ_EXPORT_NOT_FAILED" });
    await this.jobs.enqueueChzExportOrder(tenantId, inventoryId);
    return this.getState(tenantId, inventoryId);
  }

  /**
   * One subtractive transition: everything the previous attempt left behind is
   * cleared in the same statement that flips `state`, so a crash cannot leave a
   * half-cleared row that the check constraint would reject or that would
   * resume against a stale ЧЗ task. `attempts` survives on purpose.
   */
  private resetToQueued(actorUserId: string) {
    return {
      state: "queued" as const,
      dispenserTaskId: null,
      resultId: null,
      importId: null,
      errorCode: null,
      errorMessage: null,
      claimedAt: null,
      orderedAt: null,
      completedAt: null,
      orderedByUserId: actorUserId,
      updatedAt: new Date(),
    };
  }

  private async runs(tenantId: string, inventoryId: string): Promise<ChzExportRunDto[]> {
    const rows = await this.db
      .select()
      .from(schema.chzExportRuns)
      .where(
        and(
          eq(schema.chzExportRuns.tenantId, tenantId),
          eq(schema.chzExportRuns.inventoryId, inventoryId),
        ),
      )
      .orderBy(schema.chzExportRuns.status);
    return rows.map((row) => ({
      status: row.status,
      state: row.state,
      attempts: row.attempts,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      importId: row.importId,
      orderedAt: row.orderedAt ? row.orderedAt.toISOString() : null,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    }));
  }
}
