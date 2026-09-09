import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from "@nestjs/common";
import { schema } from "@markiro/db";
import type { ImportPhoto } from "@markiro/platform-contracts";
import { and, eq, lte, isNull, notExists, asc } from "drizzle-orm";
import { downloadBoundedImage, ImageDownloadError } from "../media/bounded-image-download";
import { processProductImage } from "../media/product-image-processor";
import type { ObjectStorageService } from "../storage/object-storage.service";
import type { ProductsService } from "../products/products.service";
import type { NationalCatalogImportRepository } from "./national-catalog-import.repository";
import type { NationalCatalogImportService } from "./national-catalog-import.service";
import type { DbTx, ImportActor, ImportSessionRow } from "./national-catalog-import.types";
import {
  CatalogRequestError,
  type NationalCatalogRequestCoordinator,
} from "./national-catalog-request-coordinator";
import {
  imageCheckpointSchema,
  imageScope,
  imageView,
  newImageCheckpoint,
  readPreparedBytes,
  type ImageRow,
} from "./national-catalog-image-state";
import { parseImportDiff } from "./national-catalog-import-apply-state";
import { applyAcceptedImage } from "./national-catalog-image-apply";

const images = schema.nationalCatalogImportImages;
export type CatalogImagePolicy = { enabled: boolean; verifiedHosts: readonly string[] };
/** POST records opaque candidate intent; workers download only pinned server URLs. */
export class NationalCatalogImageService {
  constructor(
    private readonly repository: NationalCatalogImportRepository,
    private readonly sessions: NationalCatalogImportService,
    private readonly coordinator: Pick<NationalCatalogRequestCoordinator, "runExternal">,
    private readonly storage: Pick<ObjectStorageService, "put" | "get">,
    private readonly products: Pick<ProductsService, "applyPreparedImage">,
    private readonly policy: CatalogImagePolicy,
    private readonly download = downloadBoundedImage,
  ) {}
  private enabled(): void {
    if (!this.policy.enabled || !this.policy.verifiedHosts.length)
      throw new ForbiddenException("catalog_images_disabled");
  }
  async prepare(
    actor: ImportActor,
    sessionId: string,
    previewId: string,
    candidateId: string,
  ): Promise<ImportPhoto> {
    return this.repository.transaction(async (tx) => {
      const session = await this.repository.lock(tx, actor.tenantId, sessionId);
      await this.sessions.assertSessionAccess(tx, actor, session);
      let row = await this.lock(tx, actor.tenantId, sessionId, previewId, candidateId);
      this.enabled();
      await this.assertTemporary(tx, session, row);
      const cp = row.preparationCheckpoint
        ? imageCheckpointSchema.parse(row.preparationCheckpoint)
        : null;
      if (row.state !== "ready" && !cp?.enqueuePending) {
        if (!row.sourceUrl || row.state === "released")
          throw new ConflictException("image_candidate_unavailable");
        const [saved] = await tx
          .update(images)
          .set({
            state: "pending",
            preparationActorId: actor.userId,
            preparationCheckpoint: newImageCheckpoint(),
            updatedAt: new Date(),
          })
          .where(imageScope(actor.tenantId, sessionId, previewId, candidateId))
          .returning();
        if (!saved) throw new ConflictException("image_candidate_unavailable");
        row = saved;
      }
      return this.view(tx, row);
    });
  }
  /** Durable step/attempt survives repair; admission is committed before any HTTP bytes. */
  async resume(
    tenantId: string,
    sessionId: string,
    previewId: string,
    candidateId: string,
    expectedStepId?: string,
  ): Promise<void> {
    const claim = await this.repository.transaction(async (tx) => {
      const session = await this.repository.lock(tx, tenantId, sessionId);
      const row = await this.lock(tx, tenantId, sessionId, previewId, candidateId);
      const cp = row.preparationCheckpoint
        ? imageCheckpointSchema.parse(row.preparationCheckpoint)
        : null;
      if (
        !cp?.enqueuePending ||
        row.state === "ready" ||
        (expectedStepId && cp.stepId !== expectedStepId) ||
        (cp.nextRetryAt && Date.parse(cp.nextRetryAt) > Date.now())
      )
        return null;
      if (!(await this.authorize(tx, session, row))) return null;
      if (cp.attempts >= 4) {
        await tx
          .update(images)
          .set({
            state: "failed",
            errorCode: "attempts_exhausted",
            preparationCheckpoint: { ...cp, enqueuePending: false },
          })
          .where(eq(images.id, row.id));
        return null;
      }
      return { session, row, cp };
    });
    if (!claim) return;
    const runId = randomUUID();
    let admitted = false;
    try {
      const bytes = await this.coordinator.runExternal(
        { tenantId, environment: claim.session.environment },
        async (signal) => {
          const allowed = await this.repository.transaction(async (tx) => {
            const session = await this.repository.lock(tx, tenantId, sessionId);
            const row = await this.lock(tx, tenantId, sessionId, previewId, candidateId);
            const cp = imageCheckpointSchema.parse(row.preparationCheckpoint);
            if (
              cp.stepId !== claim.cp.stepId ||
              cp.attempts !== claim.cp.attempts ||
              !cp.enqueuePending
            )
              throw new CatalogRequestError("deferred", "step_changed");
            if (!(await this.authorize(tx, session, row))) return false;
            await tx
              .update(images)
              .set({
                preparationCheckpoint: {
                  ...cp,
                  runId,
                  attempts: cp.attempts + 1,
                  nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
                },
                updatedAt: new Date(),
              })
              .where(eq(images.id, row.id));
            return true;
          });
          if (!allowed) throw new CatalogRequestError("blocked", "access_changed");
          admitted = true;
          if (!claim.row.sourceUrl)
            throw new CatalogRequestError("failed", "image_candidate_unavailable");
          try {
            return await this.download(
              claim.row.sourceUrl,
              {
                maxBytes: 5 * 1024 * 1024,
                timeoutMs: 15_000,
                maxRedirects: 2,
                allowedHosts: this.policy.verifiedHosts,
              },
              { signal },
            );
          } catch (error) {
            if (
              error instanceof ImageDownloadError &&
              !["network", "timeout", "bad_status"].includes(error.reason)
            )
              throw new CatalogRequestError("failed", `image_${error.reason}`, null, true);
            throw error;
          }
        },
        { attempt: claim.cp.attempts },
      );
      const processed = await processProductImage(bytes);
      const assetId = randomUUID();
      const objectKey = `tenants/${tenantId}/national-catalog/${assetId}.webp`;
      const staged = await this.repository.transaction(async (tx) => {
        const session = await this.repository.lock(tx, tenantId, sessionId);
        const row = await this.lock(tx, tenantId, sessionId, previewId, candidateId);
        const cp = imageCheckpointSchema.parse(row.preparationCheckpoint);
        if (cp.runId !== runId || !cp.enqueuePending || !(await this.authorize(tx, session, row)))
          return false;
        await tx.insert(schema.mediaAssets).values({
          id: assetId,
          ownerTenantId: tenantId,
          objectKey,
          contentType: processed.contentType,
          checksum: processed.checksum,
          byteSize: processed.byteSize,
          width: processed.width,
          height: processed.height,
          status: "staging",
        });
        await tx.update(images).set({ stagedAssetId: assetId }).where(eq(images.id, row.id));
        return true;
      });
      if (!staged) return;
      await this.storage.put(objectKey, processed.buffer, processed.contentType);
      await this.repository.transaction(async (tx) => {
        const session = await this.repository.lock(tx, tenantId, sessionId);
        const row = await this.lock(tx, tenantId, sessionId, previewId, candidateId);
        const cp = imageCheckpointSchema.parse(row.preparationCheckpoint);
        if (cp.runId !== runId || !cp.enqueuePending || !(await this.authorize(tx, session, row)))
          return;
        const [asset] = await tx
          .select()
          .from(schema.mediaAssets)
          .where(
            and(eq(schema.mediaAssets.id, assetId), eq(schema.mediaAssets.ownerTenantId, tenantId)),
          )
          .for("update");
        if (!asset || asset.status !== "staging" || row.stagedAssetId !== assetId)
          throw new ConflictException("image_staging_changed");
        await tx
          .update(images)
          .set({
            state: "ready",
            checksum: processed.checksum,
            byteSize: processed.byteSize,
            width: processed.width,
            height: processed.height,
            errorCode: null,
            preparationCheckpoint: { ...cp, enqueuePending: false, nextRetryAt: null },
            updatedAt: new Date(),
          })
          .where(eq(images.id, row.id));
      });
    } catch (error) {
      await this.repository.transaction(async (tx) => {
        const session = await this.repository.lock(tx, tenantId, sessionId);
        const row = await this.lock(tx, tenantId, sessionId, previewId, candidateId);
        const cp = imageCheckpointSchema.parse(row.preparationCheckpoint);
        if (
          cp.stepId !== claim.cp.stepId ||
          (admitted ? cp.runId !== runId : cp.attempts !== claim.cp.attempts) ||
          !cp.enqueuePending
        )
          return;
        if (!(await this.authorize(tx, session, row))) return;
        const retry =
          error instanceof CatalogRequestError && ["retry", "deferred"].includes(error.state);
        const due = retry ? (error.nextRetryAt ?? new Date(Date.now() + 60_000)) : null;
        await tx
          .update(images)
          .set({
            state: due ? "pending" : "failed",
            errorCode:
              error instanceof CatalogRequestError ? error.reason : "image_processing_failed",
            preparationCheckpoint: {
              ...cp,
              enqueuePending: due !== null,
              nextRetryAt: due?.toISOString() ?? null,
            },
            updatedAt: new Date(),
          })
          .where(eq(images.id, row.id));
      });
    }
  }
  async readPreview(
    tenantId: string,
    sessionId: string,
    candidateId: string,
  ): Promise<{ buffer: Buffer; contentType: "image/webp" }> {
    const { asset, candidate } = await this.repository.transaction(async (tx) => {
      const session = await this.repository.lock(tx, tenantId, sessionId);
      const [candidate] = await tx
        .select()
        .from(images)
        .where(
          and(
            eq(images.tenantId, tenantId),
            eq(images.sessionId, sessionId),
            eq(images.candidateId, candidateId),
          ),
        )
        .for("share");
      if (!candidate) throw new NotFoundException();
      await this.assertTemporary(tx, session, candidate);
      if (!candidate.stagedAssetId || candidate.state !== "ready")
        throw new ConflictException("image_not_ready");
      const [asset] = await tx
        .select()
        .from(schema.mediaAssets)
        .where(
          and(
            eq(schema.mediaAssets.id, candidate.stagedAssetId),
            eq(schema.mediaAssets.ownerTenantId, tenantId),
          ),
        )
        .for("share");
      if (!asset) throw new ConflictException("image_unavailable");
      return { asset, candidate };
    });
    const image = await readPreparedBytes(this.storage, asset, candidate);
    return { buffer: image.buffer, contentType: image.contentType };
  }
  async apply(tenantId: string, operationId: string, previewId: string): Promise<void> {
    await applyAcceptedImage(
      this.repository,
      this.sessions,
      this.storage,
      this.products,
      tenantId,
      operationId,
      previewId,
    );
  }
  /** Task11 bounded cleanup job. Retain exact previousPhoto for every retry-eligible receipt. */
  async releaseExpired(now = new Date(), limit = 50): Promise<number> {
    const previews = schema.nationalCatalogImportPreviews;
    const candidates = await this.repository.transaction((tx) =>
      tx
        .select()
        .from(previews)
        .where(
          and(
            lte(previews.expiresAt, now),
            isNull(previews.payloadPurgedAt),
            notExists(
              tx
                .select({ id: schema.nationalCatalogImportOperationItems.id })
                .from(schema.nationalCatalogImportOperationItems)
                .where(
                  and(
                    eq(schema.nationalCatalogImportOperationItems.tenantId, previews.tenantId),
                    eq(schema.nationalCatalogImportOperationItems.sessionId, previews.sessionId),
                    eq(schema.nationalCatalogImportOperationItems.previewId, previews.id),
                    eq(schema.nationalCatalogImportOperationItems.imageRetryEligible, true),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(previews.expiresAt), asc(previews.id))
        .limit(limit),
    );
    let released = 0;
    for (const candidate of candidates)
      released += await this.repository.transaction(async (tx) => {
        await this.repository.lock(tx, candidate.tenantId, candidate.sessionId);
        const [preview] = await tx
          .select()
          .from(previews)
          .where(and(eq(previews.tenantId, candidate.tenantId), eq(previews.id, candidate.id)))
          .for("update");
        if (!preview || preview.payloadPurgedAt || preview.expiresAt > now) return 0;
        const [retained] = await tx
          .select({ id: schema.nationalCatalogImportOperationItems.id })
          .from(schema.nationalCatalogImportOperationItems)
          .where(
            and(
              eq(schema.nationalCatalogImportOperationItems.tenantId, preview.tenantId),
              eq(schema.nationalCatalogImportOperationItems.sessionId, preview.sessionId),
              eq(schema.nationalCatalogImportOperationItems.previewId, preview.id),
              eq(schema.nationalCatalogImportOperationItems.imageRetryEligible, true),
            ),
          )
          .limit(1);
        if (retained) return 0;
        const rows = await tx
          .select()
          .from(images)
          .where(
            and(
              eq(images.tenantId, preview.tenantId),
              eq(images.sessionId, preview.sessionId),
              eq(images.previewId, preview.id),
            ),
          )
          .for("update");
        for (const row of rows) {
          if (row.stagedAssetId)
            await tx
              .select({ id: schema.mediaAssets.id })
              .from(schema.mediaAssets)
              .where(
                and(
                  eq(schema.mediaAssets.id, row.stagedAssetId),
                  eq(schema.mediaAssets.ownerTenantId, row.tenantId),
                ),
              )
              .for("update");
          await tx
            .update(images)
            .set({
              state: "released",
              sourceUrl: null,
              stagedAssetId: null,
              preparationCheckpoint: null,
              updatedAt: now,
            })
            .where(eq(images.id, row.id));
        }
        await tx
          .update(previews)
          .set({
            source: null,
            diff: null,
            previousValues: null,
            previousPhoto: null,
            categoryOptions: null,
            manualProvenance: null,
            payloadPurgedAt: now,
          })
          .where(eq(previews.id, preview.id));
        return 1;
      });
    return released;
  }
  private async lock(
    tx: DbTx,
    tenantId: string,
    sessionId: string,
    previewId: string,
    candidateId: string,
  ): Promise<ImageRow> {
    const [row] = await tx
      .select()
      .from(images)
      .where(imageScope(tenantId, sessionId, previewId, candidateId))
      .for("update");
    if (!row) throw new NotFoundException();
    return row;
  }
  private async assertTemporary(tx: DbTx, session: ImportSessionRow, row: ImageRow): Promise<void> {
    const [preview] = await tx
      .select()
      .from(schema.nationalCatalogImportPreviews)
      .where(
        and(
          eq(schema.nationalCatalogImportPreviews.tenantId, row.tenantId),
          eq(schema.nationalCatalogImportPreviews.sessionId, row.sessionId),
          eq(schema.nationalCatalogImportPreviews.id, row.previewId),
        ),
      );
    if (
      !preview ||
      preview.payloadPurgedAt ||
      preview.sourceHash !== row.sourceHash ||
      preview.expiresAt.getTime() <= Date.now() ||
      row.expiresAt.getTime() <= Date.now() ||
      session.expiresAt.getTime() <= Date.now() ||
      session.state === "cancelled" ||
      session.state === "expired"
    )
      throw new GoneException("image_preview_expired");
  }
  private async authorize(tx: DbTx, session: ImportSessionRow, row: ImageRow): Promise<boolean> {
    try {
      this.enabled();
      if (!row.preparationActorId) throw new ForbiddenException("image_actor_unavailable");
      await this.sessions.assertSessionAccess(
        tx,
        { tenantId: row.tenantId, userId: row.preparationActorId },
        session,
      );
      await this.assertTemporary(tx, session, row);
      return true;
    } catch (error) {
      if (!(error instanceof ForbiddenException || error instanceof GoneException)) throw error;
      const cp = imageCheckpointSchema.parse(row.preparationCheckpoint);
      await tx
        .update(images)
        .set({
          state: "failed",
          errorCode: "image_access_changed",
          preparationCheckpoint: { ...cp, enqueuePending: false, nextRetryAt: null },
          updatedAt: new Date(),
        })
        .where(eq(images.id, row.id));
      return false;
    }
  }
  private async view(tx: DbTx, row: ImageRow): Promise<ImportPhoto> {
    const [preview] = await tx
      .select()
      .from(schema.nationalCatalogImportPreviews)
      .where(
        and(
          eq(schema.nationalCatalogImportPreviews.tenantId, row.tenantId),
          eq(schema.nationalCatalogImportPreviews.id, row.previewId),
        ),
      );
    const original =
      preview &&
      parseImportDiff(preview.diff).view.photos.find((p) => p.candidateId === row.candidateId);
    if (!original) throw new ConflictException("image_candidate_unavailable");
    return imageView(original, row);
  }
}
