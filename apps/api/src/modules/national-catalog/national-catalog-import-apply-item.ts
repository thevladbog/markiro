import { retainedObservationForConfirmation } from "./national-catalog-confirmation-observation";
import { buildCatalogProjection } from "./national-catalog-observation-projection";
import { reviewedPhotoForConfirmation } from "./national-catalog-image-state";
import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@markiro/db";
import {
  isValidGtin,
  normalizeToGtin14,
  parseCategorySchemaDefinition,
  productAttributeValueSchema,
  type ProductAttributeValue,
} from "@markiro/domain";
import { isDeepStrictEqual } from "node:util";
import { createProductSchema } from "../products/dto";
import { ProductWriter } from "../products/product-writer";
import { ProductRegulatoryWriter } from "../product-regulatory/product-regulatory-writer";
import { nationalCatalogSnapshotSourceRef } from "../product-regulatory/proposal-schema";
import { productFingerprint, mappingSchema } from "./national-catalog-import-preview-builder";
import {
  storedDecisionSchema,
  sourceEnvelopeSchema,
  previousValuesSchema,
  meaningfulCatalogHash,
  appliedEvidenceSchema,
} from "./national-catalog-import-apply-state";
import { hashContent } from "./national-catalog-preparation-state";
import { closeNationalCatalogLinkInTransaction } from "./national-catalog-link-writer";
import { buildNationalCatalogImportEntries } from "./national-catalog-proposal.service";
import { statuses } from "./national-catalog-enumeration";
import type { DbTx, ImportActor } from "./national-catalog-import.types";

type Preview = typeof schema.nationalCatalogImportPreviews.$inferSelect;
type Receipt = typeof schema.nationalCatalogImportOperationItems.$inferSelect;
const productWriter = new ProductWriter();
const regulatoryWriter = new ProductRegulatoryWriter();
/** Caller holds session and operation-item locks; no nested transaction or pool reads. */
export async function applyImportItem(
  tx: DbTx,
  actor: ImportActor,
  preview: Preview,
  receipt: Receipt,
): Promise<void> {
  const decision = storedDecisionSchema.parse(receipt.decision);
  const source = sourceEnvelopeSchema.parse(preview.source);
  const previous = previousValuesSchema.parse(preview.previousValues);
  if (preview.expiresAt.getTime() <= Date.now() || preview.payloadPurgedAt)
    throw new ConflictException("preview_expired");
  const [item] = await tx
    .select()
    .from(schema.nationalCatalogImportItems)
    .where(
      and(
        eq(schema.nationalCatalogImportItems.tenantId, actor.tenantId),
        eq(schema.nationalCatalogImportItems.sessionId, preview.sessionId),
        eq(schema.nationalCatalogImportItems.id, preview.itemId),
      ),
    );
  if (
    !item ||
    item.cardId !== source.cardId ||
    item.gtin14 !== source.boundGtin14 ||
    item.productId !== preview.productId ||
    source.cardId !== String(source.normalized.id) ||
    !source.normalized.identifiers.some(
      (id) => isValidGtin(id.value) && normalizeToGtin14(id.value) === source.boundGtin14,
    ) ||
    statuses(source.normalized.status, source.normalized.detailedStatuses).includes("archived")
  )
    throw new ConflictException("card_identity_changed");
  const [product] = preview.productId
    ? await tx
        .select()
        .from(schema.products)
        .where(
          and(
            eq(schema.products.tenantId, actor.tenantId),
            eq(schema.products.id, preview.productId),
          ),
        )
        .for("update")
    : [];
  if (
    preview.productId &&
    (!product ||
      product.archived ||
      product.gtin14 !== source.boundGtin14 ||
      productFingerprint(product) !== preview.expectedProductRevision)
  )
    throw new ConflictException("product_changed");
  if (!product) {
    const [competing] = await tx
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(
        and(
          eq(schema.products.tenantId, actor.tenantId),
          eq(schema.products.gtin14, source.boundGtin14),
          eq(schema.products.archived, false),
        ),
      );
    if (competing) throw new ConflictException("gtin_conflict");
  }
  const [profile] = product
    ? await tx
        .select()
        .from(schema.productRegulatoryProfiles)
        .where(
          and(
            eq(schema.productRegulatoryProfiles.tenantId, actor.tenantId),
            eq(schema.productRegulatoryProfiles.productId, product.id),
          ),
        )
        .for("update")
    : [];
  if ((profile?.revision ?? null) !== preview.expectedProfileRevision)
    throw new ConflictException("profile_changed");
  const [link] = product
    ? await tx
        .select()
        .from(schema.nationalCatalogProductLinks)
        .where(
          and(
            eq(schema.nationalCatalogProductLinks.tenantId, actor.tenantId),
            eq(schema.nationalCatalogProductLinks.productId, product.id),
            isNull(schema.nationalCatalogProductLinks.closedAt),
          ),
        )
        .for("update")
    : [];
  if (
    (link?.revision ?? null) !== preview.expectedLinkRevision ||
    (link?.id ?? null) !== (previous.link?.id ?? null)
  )
    throw new ConflictException("link_changed");
  const expectedAction = !link
    ? "attach"
    : link.cardId === source.cardId &&
        link.boundGtin14 === source.boundGtin14 &&
        link.environment === source.environment
      ? "keep"
      : "replace";
  if (decision.linkAction !== expectedAction) throw new ConflictException("link_changed");
  const currentAttributes = product
    ? await tx
        .select()
        .from(schema.productRegulatoryAttributeValues)
        .where(
          and(
            eq(schema.productRegulatoryAttributeValues.tenantId, actor.tenantId),
            eq(schema.productRegulatoryAttributeValues.productId, product.id),
            isNull(schema.productRegulatoryAttributeValues.supersededAt),
          ),
        )
        .for("share")
    : [];
  // Compare semantic JSON values, independent of JSONB key ordering/date revival.
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(currentAttributes)), previous.attributes))
    throw new ConflictException("attributes_changed");
  let version: typeof schema.nationalCatalogSchemaVersions.$inferSelect | undefined;
  let mapping: typeof schema.nationalCatalogCategoryGroupMappings.$inferSelect | undefined;
  let stableMappings: ReturnType<typeof mappingSchema.parse>[] = [];
  if (previous.schema) {
    [version] = await tx
      .select()
      .from(schema.nationalCatalogSchemaVersions)
      .where(eq(schema.nationalCatalogSchemaVersions.id, previous.schema.version.id))
      .for("share");
    [mapping] = await tx
      .select()
      .from(schema.nationalCatalogCategoryGroupMappings)
      .where(eq(schema.nationalCatalogCategoryGroupMappings.id, previous.schema.mapping.id))
      .for("share");
    const rows = await tx
      .select({
        id: schema.nationalCatalogAttributeMappings.id,
        sourceAttributeId: schema.nationalCatalogAttributeMappings.sourceAttributeId,
        targetField: schema.nationalCatalogAttributeMappings.targetField,
        conversion: schema.nationalCatalogAttributeMappings.conversion,
        mappingVersion: schema.nationalCatalogAttributeMappings.mappingVersion,
      })
      .from(schema.nationalCatalogAttributeMappings)
      .where(
        eq(schema.nationalCatalogAttributeMappings.schemaVersionId, previous.schema.version.id),
      )
      .for("share");
    stableMappings = rows.flatMap((row) => {
      const parsed = mappingSchema.safeParse(row);
      return parsed.success && parsed.data.targetField !== "name" ? [parsed.data] : [];
    });
    if (
      !version ||
      !mapping ||
      version.status !== "active" ||
      hashContent({ version, mapping, stableMappings }) !== preview.expectedSchemaRevision
    )
      throw new ConflictException("schema_changed");
  }
  const name = decision.acceptedEntries.find((entry) => entry.target === "name");
  const category = decision.acceptedEntries.find((entry) => entry.target === "category");
  if (
    !product &&
    (!name ||
      name.target !== "name" ||
      !createProductSchema.shape.name.safeParse(name.proposedValue).success)
  )
    throw new BadRequestException("name_required");
  if (name?.target === "name" && name.currentValue !== (product?.name ?? null))
    throw new ConflictException("name_changed");
  const targets = decision.acceptedEntries.map((entry) =>
    entry.target === "mapped"
      ? entry.entry.target === "attribute"
        ? `attribute:${entry.entry.targetSchemaVersionId}:${entry.entry.targetAttributeId}`
        : `stable:${entry.entry.targetField}`
      : entry.target === "name"
        ? "stable:name"
        : "category",
  );
  if (new Set(targets).size !== targets.length) throw new BadRequestException("duplicate_target");
  const productId =
    product?.id ??
    (await productWriter.createInTransaction(tx, actor.tenantId, {
      gtin: source.boundGtin14,
      name: name?.target === "name" ? name.proposedValue : "",
      chzProductGroupCode: category?.target === "category" ? category.option.groupCode : null,
    }));
  if (product && name?.target === "name")
    await tx
      .update(schema.products)
      .set({ name: name.proposedValue })
      .where(and(eq(schema.products.tenantId, actor.tenantId), eq(schema.products.id, productId)));
  if (product && category?.target === "category" && product.chzProductGroupCode === null) {
    const groupCode = category.option.groupCode;
    await tx
      .update(schema.products)
      .set({
        chzProductGroupCode: groupCode,
        status: productWriter.computeStatus({
          chzProductGroupCode: groupCode,
          boxCapacity: product.boxCapacity,
          palletCapacity: product.palletCapacity,
        }),
      })
      .where(and(eq(schema.products.tenantId, actor.tenantId), eq(schema.products.id, productId)));
  }
  const now = new Date();
  // Same provider content can be reviewed repeatedly; reuse its tenant/product snapshot.
  const [existingSnapshot] = await tx
    .select()
    .from(schema.nationalCatalogCardSnapshots)
    .where(
      and(
        eq(schema.nationalCatalogCardSnapshots.tenantId, actor.tenantId),
        eq(schema.nationalCatalogCardSnapshots.productId, productId),
        eq(schema.nationalCatalogCardSnapshots.cardId, source.cardId),
        eq(schema.nationalCatalogCardSnapshots.sourceMethod, "feed_product"),
        eq(schema.nationalCatalogCardSnapshots.contentHash, preview.sourceHash),
      ),
    );
  const snapshotId = existingSnapshot?.id ?? randomUUID();
  if (!existingSnapshot)
    await tx.insert(schema.nationalCatalogCardSnapshots).values({
      id: snapshotId,
      tenantId: actor.tenantId,
      productId,
      gtin14: source.boundGtin14,
      cardId: source.cardId,
      cardStatus: source.normalized.status ?? "unknown",
      sourceMethod: "feed_product",
      payloadFormatVersion: 2,
      contentHash: preview.sourceHash,
      payload: preview.source,
      fetchedAt: preview.createdAt,
    });
  const sourceRef = nationalCatalogSnapshotSourceRef(snapshotId);
  if (category?.target === "category") {
    if (!version || profile) throw new ConflictException("category_changed");
    const [proposal] = await tx
      .insert(schema.productRegulatoryProposals)
      .values({
        tenantId: actor.tenantId,
        productId,
        kind: "category_binding",
        source: "national_catalog",
        snapshotId,
        sourceRef,
        baseRevision: 0,
        diff: {
          version: 1,
          kind: "category_binding",
          target: {
            schemaVersionId: version.id,
            categoryId: version.categoryId,
            categoryName: version.categoryName,
            tnVedCode: null,
            okpd2Code: null,
          },
          entries: [],
        },
        createdBy: actor.userId,
        expiresAt: preview.expiresAt,
      })
      .returning();
    if (!proposal) throw new Error("proposal insert missing");
    if (
      (await regulatoryWriter.applyInTransaction(
        tx,
        actor.tenantId,
        actor.userId,
        productId,
        proposal.id,
        { acceptedEntryIds: [] },
      )) === "stale"
    )
      throw new ConflictException("profile_changed");
  }
  const mapped = decision.acceptedEntries.flatMap((entry) =>
    entry.target === "mapped" ? [entry.entry] : [],
  );
  if (mapped.length) {
    const [proposal] = await tx
      .insert(schema.productRegulatoryProposals)
      .values({
        tenantId: actor.tenantId,
        productId,
        kind: "national_catalog_import",
        source: "national_catalog",
        snapshotId,
        sourceRef,
        baseRevision: category ? 1 : (profile?.revision ?? 0),
        diff: { version: 1, kind: "national_catalog_import", entries: mapped },
        createdBy: actor.userId,
        expiresAt: preview.expiresAt,
      })
      .returning();
    if (!proposal) throw new Error("proposal insert missing");
    if (
      (await regulatoryWriter.applyInTransaction(
        tx,
        actor.tenantId,
        actor.userId,
        productId,
        proposal.id,
        { acceptedEntryIds: mapped.map((entry) => entry.entryId) },
      )) === "stale"
    )
      throw new ConflictException("profile_changed");
  }
  const currentValues = new Map<string, ProductAttributeValue>();
  for (const row of currentAttributes) {
    const parsed = productAttributeValueSchema.safeParse(row.value);
    if (parsed.success) currentValues.set(row.attributeId, parsed.data);
  }
  const baselineEntries = version
    ? buildNationalCatalogImportEntries({
        schemaVersionId: version.id,
        definitions: parseCategorySchemaDefinition(version.definition).attributes,
        currentValues,
        sourceAttributes: source.normalized.attributes
          .filter(
            (a) =>
              a.gtin === null ||
              (isValidGtin(a.gtin) && normalizeToGtin14(a.gtin) === source.boundGtin14),
          )
          .map((a) => ({ id: a.id, value: a.value, unit: null })),
        sourceName: source.normalized.name,
        stableMappings,
        currentStableFields: new Map<"print_name" | "shelf_life_days", string | number | null>([
          ["print_name", product?.printName ?? null],
          ["shelf_life_days", product?.shelfLifeDays ?? null],
        ]),
      }).entries
    : [];
  const photoReview = await reviewedPhotoForConfirmation(tx, {
    tenantId: actor.tenantId,
    sessionId: preview.sessionId,
    previewId: preview.id,
    snapshotId,
    sourceHash: preview.sourceHash,
    gtin14: source.boundGtin14,
    sourcePhotos: source.normalized.images,
    requestedId: decision.reviewedPhotoCandidateId,
    choice: decision.photo.kind,
    previous:
      link &&
      link.cardId === source.cardId &&
      link.environment === source.environment &&
      link.boundGtin14 === source.boundGtin14
        ? link.reviewedPhoto
        : null,
  });
  const projection = buildCatalogProjection({
    providerName: source.normalized.name,
    mappedEntries: baselineEntries,
    imageChecksum: photoReview?.checksum ?? null,
    context:
      version && mapping
        ? {
            schemaVersionId: version.id,
            categoryId: version.categoryId,
            groupCode: mapping.chzProductGroupCode,
            definition: version.definition,
            stableMappings,
          }
        : null,
  });
  const meaningfulHash = meaningfulCatalogHash({
    providerName: source.normalized.name,
    mappedEntries: baselineEntries,
    imageChecksum: photoReview?.checksum ?? null,
  });
  if (link && decision.linkAction === "replace")
    await closeNationalCatalogLinkInTransaction(tx, actor, productId, link.revision, "replaced");
  const linkValues = {
    latestSnapshotId: snapshotId,
    reviewedSnapshotId: snapshotId,
    reviewedPhoto: photoReview,
    reviewedProjection: projection,
    observedProjection: projection,
    refreshCheckpoint: null,
    refreshErrorCode: null,
    lastAttemptAt: preview.createdAt,
    lastSuccessAt: preview.createdAt,
    lastOutcome: "ok" as const,
    rawStatus: source.normalized.status,
    rawDetailedStatuses: source.normalized.detailedStatuses,
    statusKeys: statuses(source.normalized.status, source.normalized.detailedStatuses),
    observedMeaningfulHash: meaningfulHash,
    reviewedMeaningfulHash: meaningfulHash,
    updatedAt: now,
  };
  let confirmedLinkId = link?.id;
  if (link && decision.linkAction === "keep")
    await tx
      .update(schema.nationalCatalogProductLinks)
      .set({
        ...linkValues,
        ...(await retainedObservationForConfirmation(
          tx,
          link,
          preview.createdAt,
          projection,
          photoReview,
        )),
        revision: link.revision + 1,
      })
      .where(
        and(
          eq(schema.nationalCatalogProductLinks.tenantId, actor.tenantId),
          eq(schema.nationalCatalogProductLinks.id, link.id),
        ),
      );
  else {
    const [createdLink] = await tx
      .insert(schema.nationalCatalogProductLinks)
      .values({
        ...linkValues,
        tenantId: actor.tenantId,
        productId,
        environment: source.environment,
        cardId: source.cardId,
        boundGtin14: source.boundGtin14,
        confirmedBy: actor.userId,
      })
      .returning({ id: schema.nationalCatalogProductLinks.id });
    if (!createdLink) throw new Error("link insert missing");
    confirmedLinkId = createdLink.id;
  }
  await tx.insert(schema.tenantAuditEvents).values({
    organizationId: actor.tenantId,
    actorUserId: actor.userId,
    action: "national_catalog.link.confirmed",
    outcome: "success",
    targetType: "product",
    targetId: productId,
    before: { product: previous.product, link: previous.link },
    after: {
      operationId: receipt.operationId,
      previewId: preview.id,
      cardId: source.cardId,
      environment: source.environment,
      boundGtin14: source.boundGtin14,
      sourceRef,
      sourceHash: preview.sourceHash,
      acceptedEntryIds: decision.acceptedEntryIds,
      acceptedEntries: decision.acceptedEntries,
      result: "applied",
    },
  });
  await tx
    .update(schema.nationalCatalogImportOperationItems)
    .set({
      productId,
      productResult: "applied",
      appliedEvidence: appliedEvidenceSchema.parse({
        version: 1,
        appliedBy: actor.userId,
        ...(photoReview ? { photoReview } : {}),
        linkId: confirmedLinkId,
        cardId: source.cardId,
        environment: source.environment,
        boundGtin14: source.boundGtin14,
        snapshotId,
        sourceRef,
        sourceHash: preview.sourceHash,
        acceptedEntryIds: decision.acceptedEntryIds,
        acceptedEntries: decision.acceptedEntries,
      }),
      errorCode: null,
      attempts: receipt.attempts + 1,
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.nationalCatalogImportOperationItems.tenantId, actor.tenantId),
        eq(schema.nationalCatalogImportOperationItems.id, receipt.id),
      ),
    );
}

/** Cached retries and Task9 activation must pin the actual confirmed identity, never re-resolve a GTIN. */
export async function assertAcceptedImageIdentity(
  tx: DbTx,
  tenantId: string,
  receipt: Receipt,
): Promise<void> {
  const evidence = appliedEvidenceSchema.parse(receipt.appliedEvidence);
  if (!receipt.productId || !receipt.acceptedImageId)
    throw new ConflictException("image_unavailable");
  const [product] = await tx
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, receipt.productId)))
    .for("update");
  const [link] = await tx
    .select()
    .from(schema.nationalCatalogProductLinks)
    .where(
      and(
        eq(schema.nationalCatalogProductLinks.tenantId, tenantId),
        eq(schema.nationalCatalogProductLinks.productId, receipt.productId),
        isNull(schema.nationalCatalogProductLinks.closedAt),
      ),
    )
    .for("share");
  if (
    !product ||
    product.archived ||
    product.gtin14 !== evidence.boundGtin14 ||
    !link ||
    link.id !== evidence.linkId ||
    link.cardId !== evidence.cardId ||
    link.environment !== evidence.environment ||
    link.boundGtin14 !== evidence.boundGtin14
  )
    throw new ConflictException("image_binding_changed");
  const [image] = await tx
    .select()
    .from(schema.nationalCatalogImportImages)
    .where(
      and(
        eq(schema.nationalCatalogImportImages.tenantId, tenantId),
        eq(schema.nationalCatalogImportImages.sessionId, receipt.sessionId),
        eq(schema.nationalCatalogImportImages.previewId, receipt.previewId),
        eq(schema.nationalCatalogImportImages.id, receipt.acceptedImageId),
      ),
    )
    .for("share");
  if (
    !image ||
    image.sourceHash !== evidence.sourceHash ||
    image.state !== "ready" ||
    !image.stagedAssetId ||
    !image.checksum
  )
    throw new ConflictException("image_unavailable");
}
