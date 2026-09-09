import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTx } from "./national-catalog-import.types";
import { sourceEnvelopeSchema } from "./national-catalog-import-apply-state";
import { photoReviewSchema } from "./national-catalog-image-state";
import { readRefreshCheckpoint } from "./national-catalog-refresh-state";
import { photoSelector, selectObservedPhoto } from "./national-catalog-photo-selection";
import { canonicalJsonHash } from "./national-catalog-products.service";
import {
  readCatalogProjection,
  observeCatalogProjection,
  catalogProjectionHash,
  type CatalogProjection,
} from "./national-catalog-observation-projection";
const photoSchema = z.object({
  sourceId: z.string(),
  url: z.string(),
  barcode: z.string().nullable(),
  primary: z.boolean(),
});

/** Explicit review may be older than either the last successful check or last failed attempt. */
export async function retainedObservationForConfirmation(
  tx: DbTx,
  link: typeof schema.nationalCatalogProductLinks.$inferSelect,
  fetchedAt: Date,
  projection: CatalogProjection,
  reviewedPhoto: unknown,
): Promise<Partial<typeof schema.nationalCatalogProductLinks.$inferInsert>> {
  const laterObservation = !!link.lastSuccessAt && link.lastSuccessAt >= fetchedAt;
  const laterAttempt = !!link.lastAttemptAt && link.lastAttemptAt >= fetchedAt;
  const patch: Partial<typeof schema.nationalCatalogProductLinks.$inferInsert> = {
    ...(laterAttempt
      ? {
          lastAttemptAt: link.lastAttemptAt,
          lastOutcome: link.lastOutcome,
          refreshErrorCode: link.refreshErrorCode,
        }
      : {}),
  };
  let latestPhotos: z.infer<typeof photoSchema>[] = [];
  let observedPhoto: string | null = null;
  let latestSourceHash: string | null = null;
  if (laterObservation) {
    const [snapshot] = link.latestSnapshotId
      ? await tx
          .select()
          .from(schema.nationalCatalogCardSnapshots)
          .where(
            and(
              eq(schema.nationalCatalogCardSnapshots.tenantId, link.tenantId),
              eq(schema.nationalCatalogCardSnapshots.productId, link.productId),
              eq(schema.nationalCatalogCardSnapshots.id, link.latestSnapshotId),
            ),
          )
      : [];
    const parsed = sourceEnvelopeSchema.safeParse(snapshot?.payload);
    let observed: CatalogProjection | null = null;
    if (
      parsed.success &&
      parsed.data.cardId === link.cardId &&
      parsed.data.environment === link.environment &&
      parsed.data.boundGtin14 === link.boundGtin14
    ) {
      latestSourceHash = snapshot?.contentHash ?? null;
      const photos = z.array(photoSchema).safeParse(parsed.data.normalized.images);
      latestPhotos = photos.success ? photos.data : [];
      const before = photoReviewSchema.safeParse(link.reviewedPhoto);
      const after = photoReviewSchema.safeParse(reviewedPhoto);
      const oldSelected = before.success
        ? selectObservedPhoto(before.data.selector, latestPhotos)
        : null;
      const newSelected = after.success
        ? selectObservedPhoto(after.data.selector, latestPhotos)
        : null;
      if (
        oldSelected &&
        newSelected &&
        canonicalJsonHash(photoSelector(oldSelected)) ===
          canonicalJsonHash(photoSelector(newSelected))
      ) {
        const value = readCatalogProjection(link.observedProjection)?.values.photo;
        observedPhoto = typeof value === "string" ? value : null;
      }
      const categories = z
        .array(z.object({ id: z.number() }))
        .safeParse(parsed.data.normalized.categories);
      if (categories.success)
        observed = observeCatalogProjection(
          {
            name: parsed.data.normalized.name,
            categories: categories.data,
            attributes: parsed.data.normalized.attributes,
          },
          link.boundGtin14,
          projection,
          observedPhoto,
        );
    }
    Object.assign(patch, {
      latestSnapshotId: link.latestSnapshotId,
      lastSuccessAt: link.lastSuccessAt,
      rawStatus: link.rawStatus,
      rawDetailedStatuses: link.rawDetailedStatuses,
      statusKeys: link.statusKeys,
      observedProjection: observed,
      observedMeaningfulHash: observed ? catalogProjectionHash(observed) : null,
    });
  }
  const cp = readRefreshCheckpoint(link.refreshCheckpoint);
  if (
    cp?.enqueuePending &&
    cp.linkId === link.id &&
    cp.revision === link.revision &&
    cp.cardId === link.cardId &&
    cp.environment === link.environment &&
    cp.boundGtin14 === link.boundGtin14
  ) {
    if (cp.phase === "card")
      patch.refreshCheckpoint = { ...cp, revision: link.revision + 1, runId: null };
    else if (
      cp.phase === "photo" &&
      laterObservation &&
      cp.photo?.snapshotId === link.latestSnapshotId &&
      cp.photo.sourceHash === latestSourceHash
    ) {
      const review = photoReviewSchema.safeParse(reviewedPhoto);
      const selected = review.success
        ? selectObservedPhoto(review.data.selector, latestPhotos)
        : null;
      if (selected) {
        const selector = photoSelector(selected);
        const sameStep = canonicalJsonHash(selector) === canonicalJsonHash(cp.photo.selector);
        patch.refreshCheckpoint = {
          ...cp,
          revision: link.revision + 1,
          runId: null,
          ...(sameStep ? {} : { stepId: randomUUID(), attempts: 0 }),
          photo: { ...cp.photo, selector },
        };
      }
    }
  }
  return patch;
}
