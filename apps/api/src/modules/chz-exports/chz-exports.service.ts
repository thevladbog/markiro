import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq, lt } from "drizzle-orm";
import { INVENTORY_CHZ_STATUSES, type InventoryChzStatus } from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import { PgBossService } from "../../jobs/jobs.module";
import { MAX_CREATE_ATTEMPTS } from "./chz-export-runner.service";
import { ChzTokenService } from "./chz-token.service";
import {
  CHZ_EXPORT_NOT_FAILED_CODE,
  CHZ_EXPORT_RETRY_EXHAUSTED_CODE,
  type ChzExportPreflightCode,
  type ChzExportRunDto,
  type ChzExportStateDto,
} from "./dto";

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

    // A presence-and-expiry check, not `getActiveToken`: this runs on every
    // poll of a read-only endpoint while any run is non-terminal, and has no
    // use for the decrypted token -- see `ChzTokenService.hasUsableToken`.
    const hasToken = await this.tokens.hasUsableToken(tenantId);
    if (!hasToken) blocked.push("TOKEN_UNAVAILABLE");

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
        // Insert a queued run, or reset a failed one that has not hit the
        // create-attempt cap; never touch a run that is queued, ordered, ready
        // or imported -- re-ordering an export that has already arrived burns
        // the finite daily quota for nothing. The cap condition matches
        // `retry()`'s exactly, on purpose: a run at `MAX_CREATE_ATTEMPTS` is
        // left alone by both, rather than reset here only for
        // `ChzExportRunnerService.orderQueuedRuns` to fail it again on the
        // very next pass.
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
            setWhere: this.resetEligible(),
          });
      }
    });
    await this.jobs.enqueueChzExportOrder(tenantId, inventoryId);
    return this.getState(tenantId, inventoryId);
  }

  /**
   * The `attempts < MAX_CREATE_ATTEMPTS` guard is part of the same
   * conditional `UPDATE` as the `state = 'failed'` one, not a separate
   * read-then-write: a run already at the cap must never be reset to
   * `queued`, because `ChzExportRunnerService.orderQueuedRuns` fails any
   * `queued` run at the cap outright, before it is claimed -- resetting it
   * here would only buy the operator one more pass that ends the same way.
   * `resetToQueued` deliberately preserves `attempts` (it is the record of
   * how much quota this status has already cost), so a run at the cap stays
   * at the cap forever unless this refuses first.
   */
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
          this.resetEligible(),
        ),
      )
      .returning({ id: schema.chzExportRuns.id });
    if (updated.length === 0) {
      // The `UPDATE` matched nothing; find out which of the two conditions it
      // was, so the operator sees a code that tells them what to do next
      // rather than one generic refusal.
      const [existing] = await this.db
        .select({ state: schema.chzExportRuns.state, attempts: schema.chzExportRuns.attempts })
        .from(schema.chzExportRuns)
        .where(
          and(
            eq(schema.chzExportRuns.tenantId, tenantId),
            eq(schema.chzExportRuns.inventoryId, inventoryId),
            eq(schema.chzExportRuns.status, status),
          ),
        );
      if (existing?.state === "failed" && existing.attempts >= MAX_CREATE_ATTEMPTS) {
        throw new ConflictException({ code: CHZ_EXPORT_RETRY_EXHAUSTED_CODE });
      }
      throw new ConflictException({ code: CHZ_EXPORT_NOT_FAILED_CODE });
    }
    await this.jobs.enqueueChzExportOrder(tenantId, inventoryId);
    return this.getState(tenantId, inventoryId);
  }

  /**
   * `state = 'failed' AND attempts < MAX_CREATE_ATTEMPTS`: the one condition
   * under which a run may go back to `queued`, shared by `order()`'s
   * conditional upsert and `retry()`'s conditional update so the two
   * comparisons cannot drift apart -- see the comment on `retry()` for why a
   * run at the cap must never be reset.
   *
   * The non-null assertion is safe, not a suppressed error: both arguments to
   * `and()` here are always concrete `SQL` conditions, never `undefined` or
   * omitted, so this call can only ever produce `SQL<unknown>`. The `|
   * undefined` in `and()`'s return type exists for its general case of an
   * arbitrarily short or falsy conditions list, which does not apply here.
   */
  private resetEligible() {
    return and(
      eq(schema.chzExportRuns.state, "failed"),
      lt(schema.chzExportRuns.attempts, MAX_CREATE_ATTEMPTS),
    )!;
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
