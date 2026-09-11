import {
  type EntitlementAdmissionService,
  admissionScopeDigest,
} from "../../subscriptions/entitlement-admission.service";
import type { DbTx } from "./national-catalog-import.types";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import type { ProductsService } from "../products/products.service";
import type { ObjectStorageService } from "../storage/object-storage.service";
import type { NationalCatalogImportRepository } from "./national-catalog-import.repository";
import type { NationalCatalogImportService } from "./national-catalog-import.service";
import { assertAcceptedImageIdentity } from "./national-catalog-import-apply-item";
import { previousPhotoSchema, readPreparedBytes } from "./national-catalog-image-state";

/** Product receipt is already committed. This transaction touches only the photo outcome. */
export async function applyAcceptedImage(
  repository: NationalCatalogImportRepository,
  sessions: NationalCatalogImportService,
  storage: Pick<ObjectStorageService, "get">,
  products: Pick<ProductsService, "applyPreparedImage">,
  tenantId: string,
  operationId: string,
  previewId: string,
  admission?: EntitlementAdmissionService,
): Promise<void> {
  const operations = schema.nationalCatalogImportOperations;
  const receipts = schema.nationalCatalogImportOperationItems;
  const [initial] = await repository.transaction((tx) =>
    tx
      .select()
      .from(operations)
      .where(and(eq(operations.tenantId, tenantId), eq(operations.id, operationId))),
  );
  if (!initial) throw new ConflictException("operation_unavailable");
  const sessionId = initial.sessionId;
  async function finish() {
    await repository.transaction(async (tx) => {
      await repository.lock(tx, tenantId, sessionId);
      const [operation] = await tx
        .select()
        .from(operations)
        .where(and(eq(operations.tenantId, tenantId), eq(operations.id, operationId)))
        .for("update");
      if (!operation || operation.state === "cancelled") return;
      const rows = await tx
        .select()
        .from(receipts)
        .where(and(eq(receipts.tenantId, tenantId), eq(receipts.operationId, operationId)));
      const pending = rows.some(
        (r) =>
          r.productResult === "pending" ||
          (r.productResult === "failed" && r.nextAttemptAt) ||
          (r.productResult === "applied" &&
            (r.imageResult === "pending" || (r.imageResult === "failed" && r.nextImageAttemptAt))),
      );
      await tx
        .update(operations)
        .set({
          state: pending ? "running" : "finished",
          enqueuePending: pending,
          finishedAt: pending ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(operations.id, operationId));
    });
  }
  const claim = await repository.transaction(async (tx) => {
    const session = await repository.lock(tx, tenantId, sessionId);
    const [operation] = await tx
      .select()
      .from(operations)
      .where(and(eq(operations.tenantId, tenantId), eq(operations.id, operationId)))
      .for("update");
    const [receipt] = await tx
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.tenantId, tenantId),
          eq(receipts.operationId, operationId),
          eq(receipts.previewId, previewId),
        ),
      )
      .for("update");
    if (
      !operation ||
      operation.state === "cancelled" ||
      !receipt ||
      receipt.productResult !== "applied" ||
      !receipt.imageRetryEligible ||
      (receipt.imageResult !== "pending" &&
        !(receipt.imageResult === "failed" && receipt.nextImageAttemptAt)) ||
      (receipt.nextImageAttemptAt && receipt.nextImageAttemptAt.getTime() > Date.now())
    )
      return null;
    if (receipt.imageAttempts >= 4) {
      await tx
        .update(receipts)
        .set({
          imageResult: "failed",
          imageErrorCode: "image_attempts_exhausted",
          nextImageAttemptAt: null,
        })
        .where(eq(receipts.id, receipt.id));
      await recordImageFailure(tx, operation.actorId, receipt, "image_attempts_exhausted");
      return null;
    }
    try {
      await sessions.assertAcceptedOperationAccess(
        tx,
        { tenantId, userId: operation.actorId },
        session,
      );
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      await tx
        .update(receipts)
        .set({
          imageResult: "failed",
          imageErrorCode: "image_access_changed",
          nextImageAttemptAt: null,
          updatedAt: new Date(),
        })
        .where(eq(receipts.id, receipt.id));
      await recordImageFailure(tx, operation.actorId, receipt, "image_access_changed");
      return null;
    }
    await tx
      .update(receipts)
      .set({
        imageAttempts: receipt.imageAttempts + 1,
        nextImageAttemptAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      })
      .where(eq(receipts.id, receipt.id));
    return { receipt, actorId: operation.actorId, attempt: receipt.imageAttempts + 1 };
  });
  if (!claim) {
    await finish();
    return;
  }
  try {
    // Accepted receipt retains its candidate and temporary bytes while this bounded read runs.
    // No DB locks/transaction are held over object storage; all identities are rechecked at swap.
    const cached = await repository.transaction(async (tx) => {
      if (!claim.receipt.acceptedImageId) throw new ConflictException("image_unavailable");
      const [candidate] = await tx
        .select()
        .from(schema.nationalCatalogImportImages)
        .where(
          and(
            eq(schema.nationalCatalogImportImages.tenantId, tenantId),
            eq(schema.nationalCatalogImportImages.sessionId, sessionId),
            eq(schema.nationalCatalogImportImages.previewId, previewId),
            eq(schema.nationalCatalogImportImages.id, claim.receipt.acceptedImageId),
          ),
        );
      if (!candidate?.stagedAssetId) throw new ConflictException("image_unavailable");
      const [asset] = await tx
        .select()
        .from(schema.mediaAssets)
        .where(
          and(
            eq(schema.mediaAssets.id, candidate.stagedAssetId),
            eq(schema.mediaAssets.ownerTenantId, tenantId),
          ),
        );
      if (!asset) throw new ConflictException("image_unavailable");
      return { candidate, asset };
    });
    const image = await readPreparedBytes(storage, cached.asset, cached.candidate);
    const facts = await admission?.capture(tenantId);
    await repository.transaction(async (tx) => {
      const session = await repository.lock(tx, tenantId, sessionId);
      const [operation] = await tx
        .select()
        .from(operations)
        .where(and(eq(operations.tenantId, tenantId), eq(operations.id, operationId)))
        .for("update");
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(and(eq(receipts.tenantId, tenantId), eq(receipts.id, claim.receipt.id)))
        .for("update");
      if (
        !operation ||
        operation.state === "cancelled" ||
        !receipt ||
        receipt.imageAttempts !== claim.attempt ||
        !receipt.imageRetryEligible ||
        ["applied", "unchanged"].includes(receipt.imageResult)
      )
        return;
      await sessions.assertAcceptedOperationAccess(
        tx,
        { tenantId, userId: operation.actorId },
        session,
      );
      await assertAcceptedImageIdentity(tx, tenantId, receipt);
      const [preview] = await tx
        .select()
        .from(schema.nationalCatalogImportPreviews)
        .where(
          and(
            eq(schema.nationalCatalogImportPreviews.tenantId, tenantId),
            eq(schema.nationalCatalogImportPreviews.sessionId, receipt.sessionId),
            eq(schema.nationalCatalogImportPreviews.id, previewId),
          ),
        );
      if (!preview || preview.payloadPurgedAt)
        throw new ConflictException("image_comparison_unavailable");
      const expected = previousPhotoSchema.parse(preview.previousPhoto);
      if (!receipt.acceptedImageId) throw new ConflictException("image_unavailable");
      const [candidate] = await tx
        .select()
        .from(schema.nationalCatalogImportImages)
        .where(
          and(
            eq(schema.nationalCatalogImportImages.tenantId, tenantId),
            eq(schema.nationalCatalogImportImages.id, receipt.acceptedImageId),
          ),
        );
      if (!candidate?.stagedAssetId || !receipt.productId)
        throw new ConflictException("image_unavailable");
      const [asset] = await tx
        .select()
        .from(schema.mediaAssets)
        .where(
          and(
            eq(schema.mediaAssets.id, candidate.stagedAssetId),
            eq(schema.mediaAssets.ownerTenantId, tenantId),
          ),
        )
        .for("update");
      if (!asset || asset.status !== "staging")
        throw new ConflictException("prepared_image_changed");
      if (asset.id !== cached.asset.id || candidate.id !== cached.candidate.id)
        throw new ConflictException("prepared_image_changed");
      await sessions.assertAcceptedOperationAccess(
        tx,
        { tenantId, userId: operation.actorId },
        session,
      );
      await admission?.observe({
        tenantId,
        actor: { domain: "cabinet", id: operation.actorId },
        operationId: "nk.worker.v1",
        scopeDigest: admissionScopeDigest({
          operationId,
          previewId,
          receiptId: receipt.id,
          assetId: asset.id,
        }),
        transaction: tx,
        facts,
        attempt: { number: claim.attempt, identity: receipt.id },
        runtime: { enabled: null, observedAt: new Date() },
      });
      const result = await products.applyPreparedImage(
        tx,
        tenantId,
        operation.actorId,
        receipt.productId,
        image,
        expected,
        asset.id,
      );
      await tx
        .update(receipts)
        .set({
          imageResult: result,
          imageErrorCode: null,
          imageRetryEligible: false,
          nextImageAttemptAt: null,
          updatedAt: new Date(),
        })
        .where(eq(receipts.id, receipt.id));
    });
  } catch (error) {
    await repository.transaction(async (tx) => {
      const session = await repository.lock(tx, tenantId, sessionId);
      const [operation] = await tx
        .select()
        .from(operations)
        .where(and(eq(operations.tenantId, tenantId), eq(operations.id, operationId)))
        .for("update");
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(and(eq(receipts.tenantId, tenantId), eq(receipts.id, claim.receipt.id)))
        .for("update");
      if (
        !operation ||
        operation.state === "cancelled" ||
        !receipt ||
        receipt.imageAttempts !== claim.attempt ||
        !receipt.imageRetryEligible
      )
        return;
      let denied = false;
      try {
        await sessions.assertAcceptedOperationAccess(
          tx,
          { tenantId, userId: operation.actorId },
          session,
        );
      } catch (accessError) {
        if (!(accessError instanceof ForbiddenException)) throw accessError;
        denied = true;
      }
      const conflict = error instanceof ConflictException;
      const retry = !denied && !conflict && claim.attempt < 4;
      const reason = denied
        ? "image_access_changed"
        : conflict
          ? error.message
          : "image_infrastructure_failure";
      await tx
        .update(receipts)
        .set({
          imageResult: "failed",
          imageErrorCode: reason,
          nextImageAttemptAt: retry
            ? new Date(Date.now() + 60_000 * 2 ** (claim.attempt - 1))
            : null,
          updatedAt: new Date(),
        })
        .where(eq(receipts.id, receipt.id));
      await recordImageFailure(tx, operation.actorId, receipt, reason);
    });
  }
  await finish();
}

async function recordImageFailure(
  tx: DbTx,
  actorUserId: string,
  receipt: typeof schema.nationalCatalogImportOperationItems.$inferSelect,
  reason: string,
): Promise<void> {
  await tx.insert(schema.tenantAuditEvents).values({
    organizationId: receipt.tenantId,
    actorUserId,
    action: "national_catalog.image.failed",
    outcome: "failure",
    targetType: "product",
    targetId: receipt.productId,
    before: null,
    after: {
      operationId: receipt.operationId,
      previewId: receipt.previewId,
      acceptedImageId: receipt.acceptedImageId,
      reason,
      result: "failed",
    },
  });
}
