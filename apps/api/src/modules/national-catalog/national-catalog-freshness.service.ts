import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";
import type { NationalCatalogProductsService } from "./national-catalog-products.service";

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
      select tenant_id as "tenantId", product_id as "productId"
      from national_catalog_card_freshness
      group by tenant_id, product_id
      -- A lookup refreshes the preferred feed source and reaches the public
      -- source only as fallback. An older inactive-source cursor must not keep
      -- the whole product permanently at the front of the bounded batch.
      order by max(updated_at) asc, tenant_id asc, product_id asc
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
      .update(schema.nationalCatalogCardFreshness)
      .set({ updatedAt: scheduledAt })
      .where(
        and(
          eq(schema.nationalCatalogCardFreshness.tenantId, tenantId),
          eq(schema.nationalCatalogCardFreshness.productId, productId),
        ),
      );
  }
}

@Injectable()
export class NationalCatalogFreshnessService {
  constructor(
    @Inject(NATIONAL_CATALOG_FRESHNESS_REPOSITORY)
    private readonly repository: NationalCatalogFreshnessRepository,
    private readonly products: NationalCatalogProductsService,
    private readonly batchSize = DEFAULT_FRESHNESS_BATCH_SIZE,
  ) {}

  async run(): Promise<{ selected: number; completed: number; failed: number }> {
    const targets = await this.repository.listDueProducts(this.batchSize);
    let completed = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        const result = await this.products.lookup(target.tenantId, target.productId);
        if (
          result.outcome === "found" ||
          result.outcome === "selection_required" ||
          result.outcome === "empty"
        ) {
          completed += 1;
        } else {
          await this.repository.advanceScheduledAt(target.tenantId, target.productId, new Date());
          failed += 1;
        }
      } catch {
        try {
          await this.repository.advanceScheduledAt(target.tenantId, target.productId, new Date());
        } catch {
          // A persistence failure remains isolated to this tenant/product.
        }
        failed += 1;
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
