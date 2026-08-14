import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, lt, lte, notExists } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { ObjectStorageService } from "../storage/object-storage.service";

const STALE_AFTER_MS = 15 * 60 * 1_000;
const DEFAULT_RECONCILE_LIMIT = 50;

@Injectable()
export class MediaAssetsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}

  /** Best-effort immediate cleanup; durable `deleting` metadata remains for reconciliation. */
  async cleanupDeletingTenantAsset(tenantId: string, assetId: string): Promise<void> {
    try {
      const [asset] = await this.db
        .select({ objectKey: schema.mediaAssets.objectKey })
        .from(schema.mediaAssets)
        .where(
          and(
            eq(schema.mediaAssets.id, assetId),
            eq(schema.mediaAssets.ownerTenantId, tenantId),
            eq(schema.mediaAssets.status, "deleting"),
            notExists(
              this.db
                .select({ productAssetId: schema.productImages.assetId })
                .from(schema.productImages)
                .where(eq(schema.productImages.assetId, assetId)),
            ),
          ),
        )
        .limit(1);
      if (!asset) return;

      await this.storage.delete(asset.objectKey);
    } catch {
      return;
    }

    try {
      await this.db
        .delete(schema.mediaAssets)
        .where(
          and(
            eq(schema.mediaAssets.id, assetId),
            eq(schema.mediaAssets.ownerTenantId, tenantId),
            eq(schema.mediaAssets.status, "deleting"),
            notExists(
              this.db
                .select({ productAssetId: schema.productImages.assetId })
                .from(schema.productImages)
                .where(eq(schema.productImages.assetId, assetId)),
            ),
          ),
        );
    } catch {
      // Object deletion is authoritative; retain the durable row for reconciliation.
    }
  }

  async reconcile(now = new Date(), limit = DEFAULT_RECONCILE_LIMIT): Promise<number> {
    const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
    const candidates = await this.db
      .select({
        id: schema.mediaAssets.id,
        ownerUserId: schema.mediaAssets.ownerUserId,
        ownerTenantId: schema.mediaAssets.ownerTenantId,
        objectKey: schema.mediaAssets.objectKey,
        status: schema.mediaAssets.status,
      })
      .from(schema.mediaAssets)
      .leftJoin(schema.userProfiles, eq(schema.userProfiles.avatarAssetId, schema.mediaAssets.id))
      .leftJoin(schema.productImages, eq(schema.productImages.assetId, schema.mediaAssets.id))
      .where(
        and(
          inArray(schema.mediaAssets.status, ["staging", "deleting"]),
          lt(schema.mediaAssets.updatedAt, staleBefore),
          isNull(schema.userProfiles.avatarAssetId),
          isNull(schema.productImages.assetId),
        ),
      )
      .limit(limit);

    let reconciled = 0;
    for (const candidate of candidates) {
      const claimed = await this.db
        .update(schema.mediaAssets)
        .set({ status: "deleting", updatedAt: now })
        .where(
          and(
            eq(schema.mediaAssets.id, candidate.id),
            eq(schema.mediaAssets.status, candidate.status),
            lte(schema.mediaAssets.updatedAt, staleBefore),
          ),
        )
        .returning({ id: schema.mediaAssets.id });
      if (claimed.length !== 1) continue;

      // An aggregate may have acquired the asset after candidate selection.
      // Recheck after the conditional claim before deleting object bytes.
      const [reference] = await this.db
        .select({
          avatarAssetId: schema.userProfiles.avatarAssetId,
          productAssetId: schema.productImages.assetId,
        })
        .from(schema.mediaAssets)
        .leftJoin(schema.userProfiles, eq(schema.userProfiles.avatarAssetId, schema.mediaAssets.id))
        .leftJoin(schema.productImages, eq(schema.productImages.assetId, schema.mediaAssets.id))
        .where(eq(schema.mediaAssets.id, candidate.id))
        .limit(1);
      if (reference?.avatarAssetId || reference?.productAssetId) continue;

      try {
        await this.storage.delete(candidate.objectKey);
      } catch {
        // Keep the durable deleting row for a later bounded retry.
        continue;
      }

      const result = await this.db
        .delete(schema.mediaAssets)
        .where(
          and(
            eq(schema.mediaAssets.id, candidate.id),
            eq(schema.mediaAssets.status, "deleting"),
            notExists(
              this.db
                .select({ avatarAssetId: schema.userProfiles.avatarAssetId })
                .from(schema.userProfiles)
                .where(eq(schema.userProfiles.avatarAssetId, candidate.id)),
            ),
            notExists(
              this.db
                .select({ productAssetId: schema.productImages.assetId })
                .from(schema.productImages)
                .where(eq(schema.productImages.assetId, candidate.id)),
            ),
          ),
        );
      reconciled += result.rowCount ?? 0;
    }
    return reconciled;
  }
}
