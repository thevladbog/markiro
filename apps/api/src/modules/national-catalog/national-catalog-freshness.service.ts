import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";
import type { NationalCatalogLinkRefreshService } from "./national-catalog-link-refresh.service";

export interface NationalCatalogFreshnessTarget {
  tenantId: string;
  productId: string;
}

export interface NationalCatalogFreshnessRepository {
  listDueProducts(limit: number): Promise<NationalCatalogFreshnessTarget[]>;
  advanceScheduledAt(tenantId: string, productId: string, scheduledAt: Date): Promise<void>;
}

export const NATIONAL_CATALOG_FRESHNESS_REPOSITORY = Symbol(
  "NATIONAL_CATALOG_FRESHNESS_REPOSITORY",
);
const DEFAULT_FRESHNESS_BATCH_SIZE = 50;

export class DrizzleNationalCatalogFreshnessRepository implements NationalCatalogFreshnessRepository {
  constructor(private readonly db: Db) {}

  async listDueProducts(limit: number): Promise<NationalCatalogFreshnessTarget[]> {
    const result = await this.db.execute(sql`
      with cursors as (select tenant_id,max(updated_at) as tenant_cursor from national_catalog_product_links where closed_at is null group by tenant_id), eligible as (
        select l.tenant_id, l.product_id, l.last_attempt_at, l.updated_at,
          row_number() over(partition by l.tenant_id order by l.last_attempt_at asc nulls first, l.updated_at, l.id) as ordinal,
          c.tenant_cursor
        from national_catalog_product_links l join cursors c on c.tenant_id=l.tenant_id
        join products p on p.tenant_id=l.tenant_id and p.id=l.product_id
        where l.closed_at is null and p.archived=false
          and coalesce(l.refresh_checkpoint->>'enqueuePending','false') <> 'true'
          and (l.last_attempt_at is null or l.last_attempt_at <= now()-interval '30 minutes')
      )
      select tenant_id as "tenantId",product_id as "productId" from eligible
      order by ordinal,tenant_cursor,last_attempt_at asc nulls first,tenant_id,product_id
      limit ${limit}
    `);
    return result.rows.flatMap((row) => {
      const tenantId = row.tenantId;
      const productId = row.productId;
      return typeof tenantId === "string" && typeof productId === "string"
        ? [{ tenantId, productId }]
        : [];
    });
  }

  async advanceScheduledAt(tenantId: string, productId: string, scheduledAt: Date): Promise<void> {
    await this.db
      .update(schema.nationalCatalogProductLinks)
      .set({ updatedAt: scheduledAt })
      .where(
        and(
          eq(schema.nationalCatalogProductLinks.tenantId, tenantId),
          eq(schema.nationalCatalogProductLinks.productId, productId),
          isNull(schema.nationalCatalogProductLinks.closedAt),
        ),
      );
  }
}

@Injectable()
export class NationalCatalogFreshnessService {
  constructor(
    @Inject(NATIONAL_CATALOG_FRESHNESS_REPOSITORY)
    private readonly repository: NationalCatalogFreshnessRepository,
    private readonly refreshes?: Pick<NationalCatalogLinkRefreshService, "schedule">,
    private readonly batchSize = DEFAULT_FRESHNESS_BATCH_SIZE,
  ) {}

  async run(): Promise<{ selected: number; completed: number; failed: number }> {
    // Task11 replaces this temporary inactive construction with required scheduler DI.
    if (!this.refreshes) return { selected: 0, completed: 0, failed: 0 };
    const targets = await this.repository.listDueProducts(this.batchSize);
    let completed = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        await this.refreshes.schedule(target.tenantId, target.productId);
        completed++;
      } catch {
        failed++;
      }
      try {
        await this.repository.advanceScheduledAt(target.tenantId, target.productId, new Date());
      } catch {
        /* An unrelated cursor failure cannot discard already durable refresh intent. */
      }
    }
    return { selected: targets.length, completed, failed };
  }
}

export const nationalCatalogFreshnessRepositoryProvider = {
  provide: NATIONAL_CATALOG_FRESHNESS_REPOSITORY,
  inject: [DB],
  useFactory: (db: Db) => new DrizzleNationalCatalogFreshnessRepository(db),
};
