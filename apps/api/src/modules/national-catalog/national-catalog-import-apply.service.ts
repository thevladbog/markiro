import { assertReadyImage, naturalReadyPhotoId } from "./national-catalog-image-state";
import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { schema } from "@markiro/db";
import {
  importApplySchema,
  type ImportApply,
  type ImportResult,
} from "@markiro/platform-contracts";
import { lockTenantSubscriptionTimeline } from "../../subscriptions/subscription-locks";
import { createProductSchema } from "../products/dto";
import type { NationalCatalogImportRepository } from "./national-catalog-import.repository";
import type { NationalCatalogImportService } from "./national-catalog-import.service";
import { assertPreviewEntrySelection } from "./national-catalog-import-preview-builder";
import {
  canonicalImportDecisions,
  parseImportDiff,
  sourceEnvelopeSchema,
  storedCanonicalDecisions,
  appliedEvidenceSchema,
} from "./national-catalog-import-apply-state";
import { applyImportItem, assertAcceptedImageIdentity } from "./national-catalog-import-apply-item";
import type { DbTx, ImportActor } from "./national-catalog-import.types";
const operations = schema.nationalCatalogImportOperations;
const receipts = schema.nationalCatalogImportOperationItems;
const previews = schema.nationalCatalogImportPreviews;

/** Durable admission only; Task11 registers the worker. Each position commits independently. */
export class NationalCatalogImportApplyService {
  constructor(
    private readonly repository: NationalCatalogImportRepository,
    private readonly sessions: NationalCatalogImportService,
  ) {}
  async start(actor: ImportActor, sessionId: string, input: ImportApply): Promise<ImportResult> {
    const body = importApplySchema.parse(input);
    const canonical = canonicalImportDecisions(body);
    const operationId = await this.repository.transaction(async (tx) => {
      // Serializes tenant-wide requestId admission and coherent entitlement mutation checks.
      await lockTenantSubscriptionTimeline(tx, actor.tenantId);
      const session = await this.repository.lock(tx, actor.tenantId, sessionId);
      const [existing] = await tx
        .select()
        .from(operations)
        .where(
          and(eq(operations.tenantId, actor.tenantId), eq(operations.requestId, body.requestId)),
        )
        .for("update");
      if (existing) {
        const saved = await this.items(tx, actor.tenantId, existing.id);
        if (
          existing.sessionId !== sessionId ||
          existing.decisionHash !== canonical.hash ||
          storedCanonicalDecisions(
            body.requestId,
            saved.map((r) => r.decision),
          ).hash !== canonical.hash
        )
          throw new ConflictException("import_request_mismatch");
        return existing.id;
      }
      await this.sessions.assertSessionAccess(tx, actor, session);
      const id = randomUUID();
      const writes: Array<typeof receipts.$inferInsert> = [];
      const products = new Set<string>();
      const gtins = new Set<string>();
      for (const decision of canonical.decisions) {
        const preview = await this.preview(tx, actor.tenantId, sessionId, decision.previewId);
        if (preview.expiresAt.getTime() <= Date.now() || preview.payloadPurgedAt)
          throw new ConflictException("preview_expired");
        const diff = parseImportDiff(preview.diff);
        const source = sourceEnvelopeSchema.parse(preview.source);
        if (source.environment !== session.environment)
          throw new ConflictException("environment_mismatch");
        if (!diff.view.canApply)
          throw new BadRequestException(diff.view.reason ?? "preview_not_applicable");
        if (decision.linkAction !== diff.view.linkAction)
          throw new BadRequestException("link_action_mismatch");
        assertPreviewEntrySelection(diff, decision.acceptedEntryIds);
        const acceptedEntries = diff.entries.filter((entry) =>
          decision.acceptedEntryIds.includes(entry.entryId),
        );
        if (acceptedEntries.length !== decision.acceptedEntryIds.length)
          throw new BadRequestException("preview_entry_invalid");
        if (
          !preview.productId &&
          !acceptedEntries.some(
            (entry) =>
              entry.target === "name" &&
              createProductSchema.shape.name.safeParse(entry.proposedValue).success,
          )
        )
          throw new BadRequestException("name_required");
        if ((preview.productId && products.has(preview.productId)) || gtins.has(source.boundGtin14))
          throw new BadRequestException("duplicate_target");
        if (preview.productId) products.add(preview.productId);
        gtins.add(source.boundGtin14);
        let imageId: string | null = null;
        const reviewedCandidateId =
          decision.photo.kind === "candidate"
            ? decision.photo.candidateId
            : (decision.photo.reviewedCandidateId ??
              (await naturalReadyPhotoId(
                tx,
                actor.tenantId,
                sessionId,
                preview.id,
                source.boundGtin14,
                source.normalized.images,
              )));
        if (reviewedCandidateId) {
          const [image] = await tx
            .select()
            .from(schema.nationalCatalogImportImages)
            .where(
              and(
                eq(schema.nationalCatalogImportImages.tenantId, actor.tenantId),
                eq(schema.nationalCatalogImportImages.sessionId, sessionId),
                eq(schema.nationalCatalogImportImages.previewId, preview.id),
                eq(schema.nationalCatalogImportImages.candidateId, reviewedCandidateId),
              ),
            )
            .for("update");
          if (
            !image ||
            image.sourceHash !== preview.sourceHash ||
            image.state === "released" ||
            image.state === "failed" ||
            image.expiresAt.getTime() <= Date.now()
          )
            throw new BadRequestException("image_candidate_invalid");
          await assertReadyImage(tx, image);
          if (decision.photo.kind === "candidate") imageId = image.id;
        }
        writes.push({
          tenantId: actor.tenantId,
          sessionId,
          operationId: id,
          previewId: preview.id,
          decision: {
            ...decision,
            version: 1,
            acceptedBy: actor.userId,
            ...(reviewedCandidateId ? { reviewedPhotoCandidateId: reviewedCandidateId } : {}),
            sourceHash: preview.sourceHash,
            acceptedEntries,
          },
          productId: preview.productId,
          acceptedImageId: imageId,
          imageResult: imageId ? "pending" : "none",
          imageRetryEligible: !!imageId,
        });
      }
      await tx.insert(operations).values({
        id,
        tenantId: actor.tenantId,
        sessionId,
        actorId: actor.userId,
        requestId: body.requestId,
        decisionHash: canonical.hash,
      });
      await tx.insert(receipts).values(writes);
      return id;
    });
    return this.read(actor.tenantId, sessionId, operationId);
  }
  async read(tenantId: string, sessionId: string, operationId: string): Promise<ImportResult> {
    return this.repository.transaction(async (tx) => {
      await this.repository.lock(tx, tenantId, sessionId);
      const operation = await this.operation(tx, tenantId, operationId, sessionId);
      const items = await this.items(tx, tenantId, operation.id);
      for (const item of items)
        if (item.appliedEvidence !== null) appliedEvidenceSchema.parse(item.appliedEvidence);
      return {
        operationId: operation.id,
        state: operation.state,
        items: items
          .sort((a, b) => a.previewId.localeCompare(b.previewId))
          .map((item) => ({
            previewId: item.previewId,
            productId: item.productId,
            product: item.productResult,
            image: item.imageResult,
            productReason: item.errorCode,
            imageReason: item.imageErrorCode,
            reason: item.errorCode ?? item.imageErrorCode,
          })),
      };
    });
  }
  async resume(tenantId: string, operationId: string): Promise<void> {
    const admitted = await this.repository.transaction(async (tx) => {
      const operation = await this.operation(tx, tenantId, operationId);
      return { operation, items: await this.items(tx, tenantId, operationId) };
    });
    if (admitted.operation.state === "cancelled") return;
    for (const candidate of admitted.items) {
      try {
        await this.repository.transaction(async (tx) => {
          await lockTenantSubscriptionTimeline(tx, tenantId);
          const session = await this.repository.lock(tx, tenantId, admitted.operation.sessionId);
          const operation = await this.operation(tx, tenantId, operationId, session.id);
          const item = await this.receipt(tx, tenantId, operationId, candidate.id);
          // Receipt replay is independent of expiry/permissions and never rewrites product or image.
          if (
            operation.state === "cancelled" ||
            item.productResult === "applied" ||
            item.productResult === "conflict" ||
            item.productResult === "cancelled"
          )
            return;
          if (
            item.productResult === "failed" &&
            (item.errorCode !== "infrastructure_failure" ||
              item.attempts >= 4 ||
              !item.nextAttemptAt ||
              item.nextAttemptAt.getTime() > Date.now())
          )
            return;
          const actor = { tenantId, userId: operation.actorId };
          await this.sessions.assertSessionAccess(tx, actor, session);
          const preview = await this.preview(tx, tenantId, session.id, item.previewId);
          if (sourceEnvelopeSchema.parse(preview.source).environment !== session.environment)
            throw new ConflictException("environment_mismatch");
          await applyImportItem(tx, actor, preview, item);
        });
      } catch (error) {
        const classification = classifyApplyError(error);
        await this.repository.transaction(async (tx) => {
          const session = await this.repository.lock(tx, tenantId, admitted.operation.sessionId);
          const operation = await this.operation(tx, tenantId, operationId, session.id);
          const item = await this.receipt(tx, tenantId, operationId, candidate.id);
          if (
            item.productResult === "applied" ||
            item.productResult === "conflict" ||
            item.productResult === "cancelled"
          )
            return;
          const attempts = item.attempts + 1;
          await tx
            .update(receipts)
            .set({
              productResult: classification.result,
              errorCode: classification.reason,
              attempts,
              nextAttemptAt:
                classification.retryable && attempts < 4
                  ? new Date(Date.now() + 60_000 * 2 ** (attempts - 1))
                  : null,
              updatedAt: new Date(),
            })
            .where(and(eq(receipts.tenantId, tenantId), eq(receipts.id, item.id)));
          await tx.insert(schema.tenantAuditEvents).values({
            organizationId: tenantId,
            actorUserId: operation.actorId,
            action: "national_catalog.import.item_failed",
            outcome: "failure",
            targetType: item.productId ? "product" : "national_catalog_import_preview",
            targetId: item.productId ?? item.previewId,
            before: null,
            after: {
              operationId,
              previewId: item.previewId,
              result: classification.result,
              reason: classification.reason,
            },
          });
        });
      }
    }
    await this.repository.transaction(async (tx) => {
      const initial = await this.operation(tx, tenantId, operationId);
      const session = await this.repository.lock(tx, tenantId, initial.sessionId);
      const operation = await this.operation(tx, tenantId, operationId, session.id);
      if (operation.state === "cancelled") return;
      const items = await this.items(tx, tenantId, operationId);
      const pending = items.some(
        (item) =>
          item.productResult === "pending" ||
          (item.productResult === "failed" && item.nextAttemptAt !== null),
      );
      const imagePending = items.some(
        (item) =>
          item.productResult === "applied" &&
          (item.imageResult === "pending" ||
            (item.imageResult === "failed" && item.nextImageAttemptAt !== null)),
      );
      await tx
        .update(operations)
        .set({
          state: pending || imagePending ? "running" : "finished",
          enqueuePending: pending || imagePending,
          startedAt: operation.startedAt ?? new Date(),
          finishedAt: pending || imagePending ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(operations.tenantId, tenantId),
            eq(operations.id, operationId),
            ne(operations.state, "cancelled"),
          ),
        );
    });
  }
  async retry(
    actor: ImportActor,
    sessionId: string,
    operationId: string,
    previewIds: string[],
  ): Promise<ImportResult> {
    if (!previewIds.length || new Set(previewIds).size !== previewIds.length)
      throw new BadRequestException("retry_selection_invalid");
    await this.repository.transaction(async (tx) => {
      await lockTenantSubscriptionTimeline(tx, actor.tenantId);
      const session = await this.repository.lock(tx, actor.tenantId, sessionId);
      const operation = await this.operation(tx, actor.tenantId, operationId, sessionId);
      const items = await this.items(tx, actor.tenantId, operationId);
      if (operation.state === "cancelled")
        throw new ConflictException("import_operation_cancelled");
      if (
        items.some(
          (item) =>
            item.productResult === "pending" ||
            item.nextAttemptAt !== null ||
            (item.productResult === "applied" &&
              (item.imageResult === "pending" || item.nextImageAttemptAt !== null)),
        )
      )
        throw new ConflictException("operation_running");
      if (
        storedCanonicalDecisions(
          operation.requestId,
          items.map((item) => item.decision),
        ).hash !== operation.decisionHash
      )
        throw new ConflictException("import_request_mismatch");
      if (previewIds.some((id) => !items.some((item) => item.previewId === id)))
        throw new NotFoundException("import_preview_not_found");
      const retried = items.filter((item) => previewIds.includes(item.previewId));
      if (retried.some((item) => item.productResult !== "applied"))
        await this.sessions.assertSessionAccess(tx, actor, session);
      else await this.sessions.assertAcceptedOperationAccess(tx, actor, session);

      for (const item of retried) {
        if (item.productResult === "applied") {
          if (
            item.imageResult !== "failed" ||
            !item.imageRetryEligible ||
            !item.acceptedImageId ||
            !item.appliedEvidence
          )
            throw new ConflictException("import_item_not_retryable");
          await assertAcceptedImageIdentity(tx, actor.tenantId, item);
          await tx
            .update(receipts)
            .set({
              imageResult: "pending",
              imageErrorCode: null,
              imageAttempts: 0,
              nextImageAttemptAt: null,
              updatedAt: new Date(),
            })
            .where(and(eq(receipts.tenantId, actor.tenantId), eq(receipts.id, item.id)));
          continue;
        }

        if (item.productResult !== "failed" || item.errorCode !== "infrastructure_failure")
          throw new ConflictException("import_item_not_retryable");
        await tx
          .update(receipts)
          .set({
            productResult: "pending",
            errorCode: null,
            attempts: 0,
            nextAttemptAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(receipts.tenantId, actor.tenantId), eq(receipts.id, item.id)));
      }
      await tx
        .update(operations)
        .set({
          actorId: actor.userId,
          state: "pending",
          enqueuePending: true,
          finishedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(operations.tenantId, actor.tenantId), eq(operations.id, operationId)));
    });
    return this.read(actor.tenantId, sessionId, operationId);
  }
  private async operation(tx: DbTx, tenantId: string, id: string, sessionId?: string) {
    const [row] = await tx
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.tenantId, tenantId),
          eq(operations.id, id),
          sessionId ? eq(operations.sessionId, sessionId) : undefined,
        ),
      );
    if (!row) throw new NotFoundException("import_operation_not_found");
    return row;
  }
  private items(tx: DbTx, tenantId: string, id: string) {
    return tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.tenantId, tenantId), eq(receipts.operationId, id)));
  }
  private async receipt(tx: DbTx, tenantId: string, operationId: string, id: string) {
    const [row] = await tx
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.tenantId, tenantId),
          eq(receipts.operationId, operationId),
          eq(receipts.id, id),
        ),
      )
      .for("update");
    if (!row) throw new NotFoundException("import_receipt_not_found");
    return row;
  }
  private async preview(tx: DbTx, tenantId: string, sessionId: string, id: string) {
    const [row] = await tx
      .select()
      .from(previews)
      .where(
        and(
          eq(previews.tenantId, tenantId),
          eq(previews.sessionId, sessionId),
          eq(previews.id, id),
        ),
      );
    if (!row) throw new NotFoundException("import_preview_not_found");
    return row;
  }
}
function classifyApplyError(error: unknown): {
  result: "conflict" | "failed";
  reason: string;
  retryable: boolean;
} {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const reason =
      typeof response === "string"
        ? response
        : "code" in response && typeof response.code === "string"
          ? response.code
          : "message" in response && typeof response.message === "string"
            ? response.message
            : "import_item_invalid";
    return { result: error.getStatus() === 409 ? "conflict" : "failed", reason, retryable: false };
  }
  const causes: unknown[] = [error];
  if (error && typeof error === "object" && "cause" in error) causes.push(error.cause);
  if (
    causes.some(
      (cause) =>
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        cause.code === "23505" &&
        "constraint" in cause &&
        cause.constraint === "products_tenant_gtin_unarchived_uq",
    )
  )
    return { result: "conflict", reason: "gtin_conflict", retryable: false };
  return { result: "failed", reason: "infrastructure_failure", retryable: true };
}
