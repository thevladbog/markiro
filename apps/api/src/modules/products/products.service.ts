import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DomainError, gtinMatchesPrefix, normalizeToGtin14 } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { lockTenantBoxRegistry } from "../boxes/box-registry-lock";
import { MediaAssetsService } from "../media/media-assets.service";
import { processProductImage } from "../media/product-image-processor";
import { OrgProfileService } from "../org-profile/org-profile.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import type {
  CreateProductDto,
  GtinCheckResponseDto,
  ListProductsQueryDto,
  ListProductsResponseDto,
  ProductDto,
  ProductImageDescriptor,
  ProductStatus,
  UpdateProductDto,
} from "./dto";
import {
  invalidateProductGtinRegistry,
  productGtinActuallyChanged,
} from "./product-registry-invalidation";

type ProductRow = typeof schema.products.$inferSelect;
type CurrentProductRow = Omit<ProductRow, "defaultLabelTemplateId">;
type ProductWithImageRow = CurrentProductRow & {
  imageChecksum: string | null;
  imageByteSize: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
};

const CURRENT_PRODUCT_SELECTION = {
  id: schema.products.id,
  tenantId: schema.products.tenantId,
  gtin14: schema.products.gtin14,
  name: schema.products.name,
  productGroup: schema.products.productGroup,
  boxCapacity: schema.products.boxCapacity,
  palletCapacity: schema.products.palletCapacity,
  status: schema.products.status,
  defaultCounterpartyId: schema.products.defaultCounterpartyId,
  unitPrice: schema.products.unitPrice,
  egaisCode: schema.products.egaisCode,
  externalRef: schema.products.externalRef,
  createdAt: schema.products.createdAt,
};

const PRODUCT_WITH_IMAGE_SELECTION = {
  ...CURRENT_PRODUCT_SELECTION,
  imageChecksum: schema.mediaAssets.checksum,
  imageByteSize: schema.mediaAssets.byteSize,
  imageWidth: schema.mediaAssets.width,
  imageHeight: schema.mediaAssets.height,
};

type ProductAuditTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgProfileService: OrgProfileService,
    private readonly mediaAssets: MediaAssetsService,
    private readonly storage: ObjectStorageService,
  ) {}

  /** List a tenant's products, optionally filtered by name/gtin14-prefix search and/or status. */
  async listProducts(
    tenantId: string,
    query: ListProductsQueryDto,
  ): Promise<ListProductsResponseDto> {
    const conditions = [eq(schema.products.tenantId, tenantId)];

    if (query.status) {
      conditions.push(eq(schema.products.status, query.status));
    }

    if (query.search) {
      const nameCondition = ilike(schema.products.name, `%${query.search}%`);
      const gtinPrefixCondition = ilike(schema.products.gtin14, `${query.search}%`);
      const searchCondition = or(nameCondition, gtinPrefixCondition);
      if (searchCondition) conditions.push(searchCondition);
    }

    const rows = await this.productRows().where(and(...conditions));

    return { items: rows.map((row: ProductWithImageRow) => this.rowToDto(row)) };
  }

  /** Get a single product by id (must belong to the tenant). */
  async getProduct(tenantId: string, id: string): Promise<ProductDto> {
    const row = await this.findRow(tenantId, id);
    if (!row) {
      throw new NotFoundException();
    }
    return this.rowToDto(row);
  }

  /** Create a product. Server computes `status` -- see computeStatus. */
  async createProduct(tenantId: string, data: CreateProductDto): Promise<ProductDto> {
    const gtin14 = this.normalizeOrThrow(data.gtin);
    const productGroup = data.productGroup ?? null;
    const boxCapacity = data.boxCapacity ?? null;
    const palletCapacity = data.palletCapacity ?? null;
    const status = this.computeStatus({ productGroup, boxCapacity, palletCapacity });

    try {
      const [row] = await this.db
        .insert(schema.products)
        .values({
          tenantId,
          gtin14,
          name: data.name,
          productGroup,
          boxCapacity,
          palletCapacity,
          status,
          defaultCounterpartyId: data.defaultCounterpartyId ?? null,
          unitPrice: data.unitPrice ?? null,
          egaisCode: data.egaisCode ?? null,
          externalRef: data.externalRef ?? null,
        })
        .returning({ id: schema.products.id });

      if (!row) {
        throw new InternalServerErrorException("Failed to create product");
      }
      return this.getProduct(tenantId, row.id);
    } catch (error) {
      this.handleWriteError(error);
    }
  }

  /**
   * Update a product (partial update, preserves untouched fields; explicit
   * `null` clears a nullable field). Status is recomputed from the merged
   * (post-patch) field values on every call, per the plan's draft/active rule.
   */
  async updateProduct(tenantId: string, id: string, data: UpdateProductDto): Promise<ProductDto> {
    const normalizedGtin = data.gtin !== undefined ? this.normalizeOrThrow(data.gtin) : undefined;

    try {
      const updatedId = await this.db.transaction(async (tx) => {
        if (normalizedGtin !== undefined) await lockTenantBoxRegistry(tx, tenantId);
        const [current] = await tx
          .select(CURRENT_PRODUCT_SELECTION)
          .from(schema.products)
          .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, id)))
          .for("update");
        if (!current) throw new NotFoundException();

        const gtin14 = normalizedGtin ?? current.gtin14;
        const name = data.name !== undefined ? data.name : current.name;
        const productGroup =
          data.productGroup !== undefined ? data.productGroup : current.productGroup;
        const boxCapacity = data.boxCapacity !== undefined ? data.boxCapacity : current.boxCapacity;
        const palletCapacity =
          data.palletCapacity !== undefined ? data.palletCapacity : current.palletCapacity;
        const defaultCounterpartyId =
          data.defaultCounterpartyId !== undefined
            ? data.defaultCounterpartyId
            : current.defaultCounterpartyId;
        const status = this.computeStatus({ productGroup, boxCapacity, palletCapacity });
        const set: Partial<typeof schema.products.$inferInsert> = {
          gtin14,
          name,
          productGroup,
          boxCapacity,
          palletCapacity,
          defaultCounterpartyId,
          status,
        };
        if (data.unitPrice !== undefined) set.unitPrice = data.unitPrice;
        if (data.egaisCode !== undefined) set.egaisCode = data.egaisCode;
        if (data.externalRef !== undefined) set.externalRef = data.externalRef;

        const [row] = await tx
          .update(schema.products)
          .set(set)
          .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, id)))
          .returning({ id: schema.products.id, gtin14: schema.products.gtin14 });
        if (!row) {
          throw new NotFoundException("Product not found or does not belong to this tenant");
        }
        if (
          productGtinActuallyChanged(
            { tenantId, productId: id, gtin14: current.gtin14 },
            { tenantId, productId: id, gtin14: row.gtin14 },
          )
        ) {
          await invalidateProductGtinRegistry(tx, tenantId, id);
        }
        return row.id;
      });
      return this.getProduct(tenantId, updatedId);
    } catch (error) {
      this.handleWriteError(error);
    }
  }

  /** Delete a product. Returns 404 if not found, 409 if referenced by shifts. */
  async deleteProduct(tenantId: string, id: string): Promise<void> {
    let previousAssetId: string | null = null;

    try {
      await this.db.transaction(async (tx: ProductAuditTx) => {
        await this.lockProduct(tx, tenantId, id);
        const [currentImage] = await tx
          .select({ assetId: schema.productImages.assetId })
          .from(schema.productImages)
          .where(
            and(
              eq(schema.productImages.tenantId, tenantId),
              eq(schema.productImages.productId, id),
            ),
          )
          .limit(1);
        previousAssetId = currentImage?.assetId ?? null;
        if (previousAssetId) {
          await tx
            .update(schema.mediaAssets)
            .set({ status: "deleting", updatedAt: new Date() })
            .where(
              and(
                eq(schema.mediaAssets.id, previousAssetId),
                eq(schema.mediaAssets.ownerTenantId, tenantId),
              ),
            );
          await tx
            .delete(schema.productImages)
            .where(
              and(
                eq(schema.productImages.tenantId, tenantId),
                eq(schema.productImages.productId, id),
              ),
            );
        }
        await tx
          .delete(schema.products)
          .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, id)));
      });
    } catch (error) {
      // Catch PostgreSQL FK violation errors (code 23503); check both direct
      // code property and nested cause.code (node-postgres wraps it either way).
      const err = error as Error & { code?: string; cause?: unknown };
      const errorCode = err?.code || (err?.cause as Record<string, string> | undefined)?.code;
      if (errorCode === "23503") {
        throw new ConflictException("Product is referenced by shifts");
      }
      throw error;
    }
    if (previousAssetId) {
      await this.mediaAssets.cleanupDeletingTenantAsset(tenantId, previousAssetId);
    }
  }

  async uploadImage(
    tenantId: string,
    actorUserId: string,
    productId: string,
    source: Buffer,
  ): Promise<ProductDto> {
    const product = await this.findRow(tenantId, productId);
    if (!product) throw new NotFoundException();
    const initialImage = this.imageDescriptor(product);

    let image: Awaited<ReturnType<typeof processProductImage>>;
    try {
      image = await processProductImage(source);
    } catch (error) {
      const reason = isImageInfrastructureFailure(error)
        ? "processing_unavailable"
        : "invalid_image";
      await this.writeFailureAudit(tenantId, actorUserId, productId, initialImage, null, reason);
      if (reason === "processing_unavailable") {
        throw new ServiceUnavailableException("Product image processing is unavailable");
      }
      throw new BadRequestException(errorMessage(error));
    }

    const descriptor: ProductImageDescriptor = {
      checksum: image.checksum,
      contentType: image.contentType,
      byteSize: image.byteSize,
      width: image.width,
      height: image.height,
    };
    const assetId = randomUUID();
    const objectKey = `tenants/${tenantId}/products/${productId}/${assetId}.webp`;
    try {
      await this.db.insert(schema.mediaAssets).values({
        id: assetId,
        ownerTenantId: tenantId,
        objectKey,
        contentType: image.contentType,
        byteSize: image.byteSize,
        checksum: image.checksum,
        width: image.width,
        height: image.height,
        status: "staging",
      });
    } catch (error) {
      this.logger.error(
        `Could not stage product image metadata for tenant ${tenantId}, product ${productId}: ${errorMessage(error)}`,
      );
      await this.writeFailureAudit(
        tenantId,
        actorUserId,
        productId,
        initialImage,
        descriptor,
        "metadata_unavailable",
      );
      throw new ServiceUnavailableException("Could not stage product image");
    }

    try {
      await this.storage.put(objectKey, image.buffer, image.contentType);
    } catch (error) {
      this.logger.error(
        `Could not store product image for tenant ${tenantId}, product ${productId}, asset ${assetId}: ${errorMessage(error)}`,
      );
      await this.writeFailureAudit(
        tenantId,
        actorUserId,
        productId,
        initialImage,
        descriptor,
        "storage_unavailable",
      );
      throw new ServiceUnavailableException("Product image storage is unavailable");
    }

    let previousAssetId: string | null = null;
    let switchBeforeImage: ProductImageDescriptor | null | undefined;
    try {
      await this.db.transaction(async (tx: ProductAuditTx) => {
        await this.lockProduct(tx, tenantId, productId);
        const [current] = await tx
          .select({
            assetId: schema.productImages.assetId,
            checksum: schema.mediaAssets.checksum,
            contentType: schema.mediaAssets.contentType,
            byteSize: schema.mediaAssets.byteSize,
            width: schema.mediaAssets.width,
            height: schema.mediaAssets.height,
          })
          .from(schema.productImages)
          .innerJoin(
            schema.mediaAssets,
            and(
              eq(schema.mediaAssets.id, schema.productImages.assetId),
              eq(schema.mediaAssets.ownerTenantId, tenantId),
              eq(schema.mediaAssets.status, "active"),
            ),
          )
          .where(
            and(
              eq(schema.productImages.tenantId, tenantId),
              eq(schema.productImages.productId, productId),
            ),
          )
          .limit(1);
        previousAssetId = current?.assetId ?? null;
        const before = current ? descriptorFromAsset(current) : null;
        switchBeforeImage = before;

        const activated = await tx
          .update(schema.mediaAssets)
          .set({ status: "active", updatedAt: new Date() })
          .where(
            and(
              eq(schema.mediaAssets.id, assetId),
              eq(schema.mediaAssets.ownerTenantId, tenantId),
              eq(schema.mediaAssets.status, "staging"),
            ),
          )
          .returning({ id: schema.mediaAssets.id });
        if (activated.length !== 1)
          throw new ConflictException("Product image staging state changed");

        await tx
          .insert(schema.productImages)
          .values({ tenantId, productId, assetId })
          .onConflictDoUpdate({
            target: [schema.productImages.tenantId, schema.productImages.productId],
            set: { assetId, updatedAt: new Date() },
          });
        if (previousAssetId) {
          await tx
            .update(schema.mediaAssets)
            .set({ status: "deleting", updatedAt: new Date() })
            .where(
              and(
                eq(schema.mediaAssets.id, previousAssetId),
                eq(schema.mediaAssets.ownerTenantId, tenantId),
              ),
            );
        }
        await this.writeSuccessAudit(
          tx,
          tenantId,
          actorUserId,
          productId,
          before ? "product.image.replaced" : "product.image.uploaded",
          before,
          descriptor,
        );
      });
    } catch (error) {
      await this.writeFailureAudit(
        tenantId,
        actorUserId,
        productId,
        switchBeforeImage ?? initialImage,
        descriptor,
        "switch_failed",
      );
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `Could not switch product image for tenant ${tenantId}, product ${productId}, asset ${assetId}: ${errorMessage(error)}`,
      );
      throw new ServiceUnavailableException("Could not activate product image");
    }

    if (previousAssetId) {
      await this.mediaAssets.cleanupDeletingTenantAsset(tenantId, previousAssetId);
    }
    return this.getProduct(tenantId, productId);
  }

  async recordImageUploadFailure(
    tenantId: string,
    actorUserId: string,
    productId: string,
    reason: "missing_image" | "source_too_large",
  ): Promise<void> {
    const product = await this.findRow(tenantId, productId);
    if (!product) throw new NotFoundException();
    await this.writeFailureAudit(
      tenantId,
      actorUserId,
      productId,
      this.imageDescriptor(product),
      null,
      reason,
    );
  }

  async deleteImage(tenantId: string, actorUserId: string, productId: string): Promise<void> {
    let previousAssetId: string | null = null;
    await this.db.transaction(async (tx: ProductAuditTx) => {
      await this.lockProduct(tx, tenantId, productId);
      const [current] = await tx
        .select({
          assetId: schema.productImages.assetId,
          checksum: schema.mediaAssets.checksum,
          contentType: schema.mediaAssets.contentType,
          byteSize: schema.mediaAssets.byteSize,
          width: schema.mediaAssets.width,
          height: schema.mediaAssets.height,
        })
        .from(schema.productImages)
        .innerJoin(
          schema.mediaAssets,
          and(
            eq(schema.mediaAssets.id, schema.productImages.assetId),
            eq(schema.mediaAssets.ownerTenantId, tenantId),
            eq(schema.mediaAssets.status, "active"),
          ),
        )
        .where(
          and(
            eq(schema.productImages.tenantId, tenantId),
            eq(schema.productImages.productId, productId),
          ),
        )
        .limit(1);
      if (!current) return;
      previousAssetId = current.assetId;
      const before = descriptorFromAsset(current);
      await tx
        .update(schema.mediaAssets)
        .set({ status: "deleting", updatedAt: new Date() })
        .where(
          and(
            eq(schema.mediaAssets.id, current.assetId),
            eq(schema.mediaAssets.ownerTenantId, tenantId),
          ),
        );
      await tx
        .delete(schema.productImages)
        .where(
          and(
            eq(schema.productImages.tenantId, tenantId),
            eq(schema.productImages.productId, productId),
          ),
        );
      await this.writeSuccessAudit(
        tx,
        tenantId,
        actorUserId,
        productId,
        "product.image.deleted",
        before,
        null,
      );
    });
    if (previousAssetId) {
      await this.mediaAssets.cleanupDeletingTenantAsset(tenantId, previousAssetId);
    }
  }

  async getCurrentImageRead(
    tenantId: string,
    productId: string,
    checksum: string,
  ): Promise<string> {
    const [asset] = await this.db
      .select({ objectKey: schema.mediaAssets.objectKey })
      .from(schema.products)
      .innerJoin(
        schema.productImages,
        and(
          eq(schema.productImages.tenantId, schema.products.tenantId),
          eq(schema.productImages.productId, schema.products.id),
        ),
      )
      .innerJoin(
        schema.mediaAssets,
        and(
          eq(schema.mediaAssets.id, schema.productImages.assetId),
          eq(schema.mediaAssets.ownerTenantId, schema.products.tenantId),
          eq(schema.mediaAssets.status, "active"),
          eq(schema.mediaAssets.checksum, checksum),
        ),
      )
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)))
      .limit(1);
    if (!asset) throw new NotFoundException();
    return asset.objectKey;
  }

  /**
   * Owner-hint for the catalog UX (design brief 03): normalizes the GTIN,
   * then checks whether it belongs to the tenant's own GS1 prefixes (org
   * profile), then each counterparty's prefixes (first match wins), else
   * "unknown".
   */
  async checkGtinOwner(tenantId: string, gtin: string): Promise<GtinCheckResponseDto> {
    const gtin14 = this.normalizeOrThrow(gtin);

    const ownPrefixes = await this.orgProfileService.getPrefixes(tenantId);
    if (ownPrefixes.some((prefix) => gtinMatchesPrefix(gtin14, prefix))) {
      return { gtin14, owner: "own" };
    }

    const counterpartyRows = await this.db
      .select()
      .from(schema.counterparties)
      .where(eq(schema.counterparties.tenantId, tenantId))
      .orderBy(schema.counterparties.createdAt);

    for (const row of counterpartyRows) {
      if (row.gs1Prefixes.some((prefix) => gtinMatchesPrefix(gtin14, prefix))) {
        return {
          gtin14,
          owner: "counterparty",
          counterpartyId: row.id,
          counterpartyName: row.name,
        };
      }
    }

    return { gtin14, owner: "unknown" };
  }

  private productRows() {
    return this.db
      .select(PRODUCT_WITH_IMAGE_SELECTION)
      .from(schema.products)
      .leftJoin(
        schema.productImages,
        and(
          eq(schema.productImages.tenantId, schema.products.tenantId),
          eq(schema.productImages.productId, schema.products.id),
        ),
      )
      .leftJoin(
        schema.mediaAssets,
        and(
          eq(schema.mediaAssets.id, schema.productImages.assetId),
          eq(schema.mediaAssets.ownerTenantId, schema.products.tenantId),
          eq(schema.mediaAssets.status, "active"),
        ),
      );
  }

  private async findRow(tenantId: string, id: string): Promise<ProductWithImageRow | undefined> {
    const [row] = await this.productRows()
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, id)))
      .limit(1);
    return row;
  }

  private async lockProduct(
    tx: ProductAuditTx,
    tenantId: string,
    productId: string,
  ): Promise<void> {
    const result = await tx.execute(
      sql`select ${schema.products.id} from ${schema.products} where ${schema.products.tenantId} = ${tenantId} and ${schema.products.id} = ${productId} for update`,
    );
    if (result.rows.length !== 1) throw new NotFoundException();
  }

  private async writeSuccessAudit(
    tx: ProductAuditTx,
    tenantId: string,
    actorUserId: string,
    productId: string,
    action: "product.image.uploaded" | "product.image.replaced" | "product.image.deleted",
    before: ProductImageDescriptor | null,
    after: ProductImageDescriptor | null,
  ): Promise<void> {
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action,
      outcome: "success",
      targetType: "product",
      targetId: productId,
      before: { image: before },
      after: { image: after },
    });
  }

  private async writeFailureAudit(
    tenantId: string,
    actorUserId: string,
    productId: string,
    before: ProductImageDescriptor | null,
    attemptedImage: ProductImageDescriptor | null,
    reason:
      | "invalid_image"
      | "processing_unavailable"
      | "metadata_unavailable"
      | "storage_unavailable"
      | "switch_failed"
      | "missing_image"
      | "source_too_large",
  ): Promise<void> {
    await this.db.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action: before ? "product.image.replaced" : "product.image.uploaded",
      outcome: "failure",
      targetType: "product",
      targetId: productId,
      before: { image: before },
      after: attemptedImage ? { attemptedImage, reason } : { reason },
    });
  }

  /** Normalizes/validates a raw GTIN input; DomainError -> 400 GTIN_INVALID. */
  private normalizeOrThrow(gtin: string): string {
    try {
      return normalizeToGtin14(gtin);
    } catch (error) {
      if (error instanceof DomainError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  /** active iff boxCapacity AND palletCapacity AND productGroup are all set; else draft. */
  private computeStatus(fields: {
    productGroup: string | null;
    boxCapacity: number | null;
    palletCapacity: number | null;
  }): ProductStatus {
    return fields.productGroup !== null &&
      fields.boxCapacity !== null &&
      fields.palletCapacity !== null
      ? "active"
      : "draft";
  }

  /**
   * Catch PostgreSQL violations: unique 23505 -> 409; FK 23503 -> 400.
   */
  private handleWriteError(error: unknown): never {
    const err = error as Error & { code?: string; cause?: unknown };
    const cause = err?.cause as { code?: string } | undefined;
    const errorCode = err?.code || cause?.code;

    if (errorCode === "23505") {
      throw new ConflictException("A product with this GTIN already exists for this tenant");
    }
    if (errorCode === "23503") {
      throw new BadRequestException("Unknown counterparty for this organization");
    }
    throw error;
  }

  private imageDescriptor(row: ProductWithImageRow): ProductImageDescriptor | null {
    if (
      row.imageChecksum === null ||
      row.imageByteSize === null ||
      row.imageWidth === null ||
      row.imageHeight === null
    ) {
      return null;
    }
    return {
      checksum: row.imageChecksum,
      contentType: "image/webp",
      byteSize: row.imageByteSize,
      width: row.imageWidth,
      height: row.imageHeight,
    };
  }

  private rowToDto(row: ProductWithImageRow): ProductDto {
    return {
      id: row.id,
      gtin14: row.gtin14,
      name: row.name,
      productGroup: row.productGroup,
      boxCapacity: row.boxCapacity,
      palletCapacity: row.palletCapacity,
      status: row.status,
      defaultCounterpartyId: row.defaultCounterpartyId,
      unitPrice: row.unitPrice,
      egaisCode: row.egaisCode,
      externalRef: row.externalRef,
      createdAt: row.createdAt,
      image: this.imageDescriptor(row),
    };
  }
}

function descriptorFromAsset(asset: {
  checksum: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
}): ProductImageDescriptor {
  if (asset.contentType !== "image/webp" || asset.width === null || asset.height === null) {
    throw new ConflictException("Product image metadata is invalid");
  }
  return {
    checksum: asset.checksum,
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    width: asset.width,
    height: asset.height,
  };
}

function isImageInfrastructureFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("processing exceeded") ||
    message.includes("worker failed") ||
    message.includes("worker exited") ||
    message.includes("Concurrency queue is full")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown product image error";
}
