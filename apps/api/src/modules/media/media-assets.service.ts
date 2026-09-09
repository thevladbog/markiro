import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, lt } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { ObjectStorageService } from "../storage/object-storage.service";
import { noMediaAssetReference } from "./media-asset-references";

const STALE_AFTER_MS = 15 * 60 * 1_000;
const DEFAULT_RECONCILE_LIMIT = 50;
@Injectable()
export class MediaAssetsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}
  /** Best-effort; committed deleting tombstone prevents all new aggregate attachments. */
  async cleanupDeletingTenantAsset(tenantId: string, assetId: string): Promise<void> {
    try {
      await this.deleteUnreferenced(assetId, new Date(), tenantId);
    } catch {
      /* Durable tombstone retains failed work. */
    }
  }
  async reconcile(now = new Date(), limit = DEFAULT_RECONCILE_LIMIT): Promise<number> {
    const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
    const candidates = await this.db
      .select({ id: schema.mediaAssets.id })
      .from(schema.mediaAssets)
      .where(
        and(
          inArray(schema.mediaAssets.status, ["staging", "deleting"]),
          lt(schema.mediaAssets.updatedAt, staleBefore),
          noMediaAssetReference(now),
        ),
      )
      .limit(limit);
    let reconciled = 0;
    for (const candidate of candidates) {
      try {
        if (await this.deleteUnreferenced(candidate.id, now, undefined, staleBefore)) reconciled++;
      } catch {
        /* Keep the durable deleting row for a bounded retry. */
      }
    }
    return reconciled;
  }
  private async deleteUnreferenced(
    id: string,
    now: Date,
    tenantId?: string,
    staleBefore?: Date,
  ): Promise<boolean> {
    // Short lock transaction, no network. A fresh statement AFTER waiting for the lock
    // sees references committed by an earlier attacher; no reverse candidate lock.
    const claim = await this.db.transaction(async (tx) => {
      const [asset] = await tx
        .select()
        .from(schema.mediaAssets)
        .where(
          and(
            eq(schema.mediaAssets.id, id),
            tenantId ? eq(schema.mediaAssets.ownerTenantId, tenantId) : undefined,
          ),
        )
        .for("update");
      if (
        !asset ||
        asset.status === "active" ||
        (!staleBefore && asset.status !== "deleting") ||
        (staleBefore && asset.updatedAt >= staleBefore)
      )
        return null;
      const [unreferenced] = await tx
        .select({ id: schema.mediaAssets.id })
        .from(schema.mediaAssets)
        .where(and(eq(schema.mediaAssets.id, id), noMediaAssetReference(now)));
      if (!unreferenced) return null;
      await tx
        .update(schema.mediaAssets)
        .set({ status: "deleting", updatedAt: now })
        .where(eq(schema.mediaAssets.id, id));
      return { objectKey: asset.objectKey };
    });
    if (!claim) return false;
    // All attach/activate paths reject deleting; final guard also covers retained refs.
    const [deletable] = await this.db
      .select({ id: schema.mediaAssets.id })
      .from(schema.mediaAssets)
      .where(
        and(
          eq(schema.mediaAssets.id, id),
          eq(schema.mediaAssets.status, "deleting"),
          eq(schema.mediaAssets.updatedAt, now),
          noMediaAssetReference(now),
        ),
      );
    if (!deletable) return false;
    await this.storage.delete(claim.objectKey);
    return this.db.transaction(async (tx) => {
      const [asset] = await tx
        .select({ id: schema.mediaAssets.id })
        .from(schema.mediaAssets)
        .where(
          and(
            eq(schema.mediaAssets.id, id),
            eq(schema.mediaAssets.status, "deleting"),
            eq(schema.mediaAssets.updatedAt, now),
            noMediaAssetReference(now),
          ),
        )
        .for("update");
      if (!asset) return false;
      const result = await tx
        .delete(schema.mediaAssets)
        .where(
          and(
            eq(schema.mediaAssets.id, id),
            eq(schema.mediaAssets.status, "deleting"),
            eq(schema.mediaAssets.updatedAt, now),
            noMediaAssetReference(now),
          ),
        );
      return (result.rowCount ?? 0) === 1;
    });
  }
}
