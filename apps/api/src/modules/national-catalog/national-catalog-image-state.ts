import { isValidGtin, normalizeToGtin14 } from "@markiro/domain";
import { chooseDefaultPhoto } from "./national-catalog-photo-selection";
import { randomUUID, createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { schema } from "@markiro/db";
import type { ImportPhoto, ImportPreview } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTx } from "./national-catalog-import.types";
import type { ProcessedProductImage } from "../media/product-image-processor";
import type { ObjectStorageService } from "../storage/object-storage.service";

export const imageCheckpointSchema = z
  .object({
    version: z.literal(1),
    stepId: z.uuid(),
    runId: z.uuid().nullable(),
    attempts: z.number().int().min(0).max(4),
    enqueuePending: z.boolean(),
    nextRetryAt: z.iso.datetime().nullable(),
  })
  .strict();
export type ImageCheckpoint = z.infer<typeof imageCheckpointSchema>;
export function newImageCheckpoint(): ImageCheckpoint {
  return {
    version: 1,
    stepId: randomUUID(),
    runId: null,
    attempts: 0,
    enqueuePending: true,
    nextRetryAt: null,
  };
}
export type ImageRow = typeof schema.nationalCatalogImportImages.$inferSelect;
export const imageScope = (
  tenantId: string,
  sessionId: string,
  previewId: string,
  candidateId: string,
) =>
  and(
    eq(schema.nationalCatalogImportImages.tenantId, tenantId),
    eq(schema.nationalCatalogImportImages.sessionId, sessionId),
    eq(schema.nationalCatalogImportImages.previewId, previewId),
    eq(schema.nationalCatalogImportImages.candidateId, candidateId),
  );
export function imageView(original: ImportPhoto, row: ImageRow): ImportPhoto {
  return {
    ...original,
    state: row.state === "released" ? "failed" : row.state,
    automaticWorkPending:
      row.state === "pending" &&
      row.preparationCheckpoint !== null &&
      imageCheckpointSchema.parse(row.preparationCheckpoint).enqueuePending,
    previewPath:
      row.state === "ready"
        ? `/national-catalog/import-sessions/${row.sessionId}/images/${row.candidateId}`
        : null,
    reason:
      original.reason === "barcode_mismatch" && row.state !== "failed"
        ? "barcode_mismatch"
        : row.state === "released"
          ? "image_unavailable"
          : row.state === "failed"
            ? original.state === "failed"
              ? original.reason
              : "download_failed"
            : null,
  };
}
export async function overlayStoredImages(
  tx: DbTx,
  tenantId: string,
  sessionId: string,
  view: ImportPreview,
): Promise<ImportPreview> {
  const rows = await tx
    .select()
    .from(schema.nationalCatalogImportImages)
    .where(
      and(
        eq(schema.nationalCatalogImportImages.tenantId, tenantId),
        eq(schema.nationalCatalogImportImages.sessionId, sessionId),
        eq(schema.nationalCatalogImportImages.previewId, view.id),
      ),
    );
  return {
    ...view,
    photos: view.photos.map((photo) => {
      const row = rows.find((candidate) => candidate.candidateId === photo.candidateId);
      if (!row) throw new ConflictException("image_candidate_unavailable");
      return imageView(photo, row);
    }),
  };
}
/** Exact issued identity includes version timestamp and asset ID, not just visual checksum. */
export const previousPhotoSchema = z
  .object({
    assetId: z.uuid(),
    updatedAt: z.iso.datetime(),
    checksum: z.string().length(64),
    width: z.number().int(),
    height: z.number().int(),
  })
  .strict()
  .nullable();
export type ExpectedPreparedPhoto = z.infer<typeof previousPhotoSchema>;
export async function readPreparedBytes(
  storage: Pick<ObjectStorageService, "get">,
  asset: typeof schema.mediaAssets.$inferSelect,
  candidate: ImageRow,
): Promise<ProcessedProductImage> {
  if (
    asset.status === "deleting" ||
    candidate.state !== "ready" ||
    asset.ownerTenantId !== candidate.tenantId ||
    asset.id !== candidate.stagedAssetId ||
    asset.contentType !== "image/webp" ||
    asset.checksum !== candidate.checksum ||
    asset.byteSize !== candidate.byteSize ||
    asset.width !== candidate.width ||
    asset.height !== candidate.height ||
    !asset.width ||
    !asset.height
  )
    throw new ConflictException("prepared_image_changed");
  const stored = await storage.get(asset.objectKey, { maxBytes: 5 * 1024 * 1024 });
  if (
    stored.contentType !== "image/webp" ||
    stored.body.byteLength !== asset.byteSize ||
    createHash("sha256").update(stored.body).digest("hex") !== asset.checksum
  )
    throw new ConflictException("prepared_image_bytes_changed");
  return {
    buffer: stored.body,
    contentType: "image/webp",
    byteSize: asset.byteSize,
    width: asset.width,
    height: asset.height,
    checksum: asset.checksum,
  };
}

export const photoReviewSchema = z
  .object({
    version: z.literal(1),
    snapshotId: z.uuid(),
    sourceHash: z.string().length(64),
    candidateId: z.uuid(),
    selector: z
      .object({
        sourceId: z.string().min(1),
        barcode: z.string().nullable(),
        primary: z.boolean(),
        urlHash: z.string().length(64),
      })
      .strict(),
    checksum: z.string().length(64),
    choice: z.enum(["candidate", "keep"]),
  })
  .strict();
export type PhotoReview = z.infer<typeof photoReviewSchema>;
/** Candidate -> asset lock, also used at acceptance. GC's committed tombstone wins safely. */
export async function assertReadyImage(tx: DbTx, row: ImageRow): Promise<void> {
  if (
    row.state !== "ready" ||
    !row.stagedAssetId ||
    !row.checksum ||
    !row.byteSize ||
    !row.width ||
    !row.height
  )
    throw new ConflictException("image_not_ready");
  const [asset] = await tx
    .select()
    .from(schema.mediaAssets)
    .where(
      and(
        eq(schema.mediaAssets.ownerTenantId, row.tenantId),
        eq(schema.mediaAssets.id, row.stagedAssetId),
      ),
    )
    .for("update");
  if (
    !asset ||
    asset.status !== "staging" ||
    asset.checksum !== row.checksum ||
    asset.byteSize !== row.byteSize ||
    asset.width !== row.width ||
    asset.height !== row.height ||
    asset.contentType !== "image/webp"
  )
    throw new ConflictException("prepared_image_changed");
}

const sourcePhotoSchema = z.object({
  sourceId: z.string(),
  url: z.string(),
  barcode: z.string().nullable(),
  primary: z.boolean(),
});
export async function reviewedPhotoForConfirmation(
  tx: DbTx,
  input: {
    tenantId: string;
    sessionId: string;
    previewId: string;
    snapshotId: string;
    sourceHash: string;
    gtin14: string;
    sourcePhotos: unknown[];
    requestedId: string | undefined;
    choice: "keep" | "candidate";
    previous: unknown;
  },
): Promise<PhotoReview | null> {
  const sourcePhotos = z.array(sourcePhotoSchema).parse(input.sourcePhotos);
  const rows = await tx
    .select()
    .from(schema.nationalCatalogImportImages)
    .where(
      and(
        eq(schema.nationalCatalogImportImages.tenantId, input.tenantId),
        eq(schema.nationalCatalogImportImages.sessionId, input.sessionId),
        eq(schema.nationalCatalogImportImages.previewId, input.previewId),
      ),
    )
    .for("share");
  const candidate = input.requestedId
    ? rows.find((r) => r.candidateId === input.requestedId)
    : null;
  if (!candidate) {
    if (input.requestedId) throw new ConflictException("reviewed_image_unavailable");
    const previous = photoReviewSchema.safeParse(input.previous);
    return previous.success ? previous.data : null;
  }
  await assertReadyImage(tx, candidate);
  const original = sourcePhotos.filter(
    (p) => p.sourceId === candidate.sourceId && p.url === candidate.sourceUrl,
  );
  if (original.length !== 1 || candidate.sourceHash !== input.sourceHash || !candidate.checksum)
    throw new ConflictException("reviewed_image_source_changed");
  const photo = original[0];
  if (!photo) throw new ConflictException("reviewed_image_source_changed");
  return {
    version: 1,
    snapshotId: input.snapshotId,
    sourceHash: input.sourceHash,
    candidateId: candidate.candidateId,
    selector: {
      sourceId: photo.sourceId,
      barcode: photo.barcode === null ? null : normalizeToGtin14(photo.barcode),
      primary: photo.primary,
      urlHash: createHash("sha256").update(photo.url).digest("hex"),
    },
    checksum: candidate.checksum,
    choice: input.choice,
  };
}

export async function naturalReadyPhotoId(
  tx: DbTx,
  tenantId: string,
  sessionId: string,
  previewId: string,
  gtin14: string,
  photos: unknown[],
): Promise<string | undefined> {
  const sourcePhotos = z.array(sourcePhotoSchema).parse(photos);
  const eligible = sourcePhotos.filter((p) => p.barcode === null || isValidGtin(p.barcode));
  const naturalId = chooseDefaultPhoto(
    gtin14,
    eligible.map((p) => ({
      candidateId: p.sourceId,
      barcode: p.barcode === null ? null : normalizeToGtin14(p.barcode),
      primary: p.primary,
    })),
  );
  if (!naturalId) return undefined;
  const rows = await tx
    .select()
    .from(schema.nationalCatalogImportImages)
    .where(
      and(
        eq(schema.nationalCatalogImportImages.tenantId, tenantId),
        eq(schema.nationalCatalogImportImages.sessionId, sessionId),
        eq(schema.nationalCatalogImportImages.previewId, previewId),
        eq(schema.nationalCatalogImportImages.sourceId, naturalId),
        eq(schema.nationalCatalogImportImages.state, "ready"),
      ),
    );
  return rows.length === 1 ? rows[0]?.candidateId : undefined;
}
