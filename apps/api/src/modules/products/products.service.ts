import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, ilike, or } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DomainError, gtinMatchesPrefix, normalizeToGtin14 } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { OrgProfileService } from "../org-profile/org-profile.service";
import type {
  CreateProductDto,
  GtinCheckResponseDto,
  ListProductsQueryDto,
  ListProductsResponseDto,
  ProductDto,
  ProductStatus,
  UpdateProductDto,
} from "./dto";

type ProductRow = typeof schema.products.$inferSelect;

@Injectable()
export class ProductsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly orgProfileService: OrgProfileService,
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

    const rows = await this.db
      .select()
      .from(schema.products)
      .where(and(...conditions));

    return { items: rows.map((row) => this.rowToDto(row)) };
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
          defaultLabelTemplateId: data.defaultLabelTemplateId ?? null,
          unitPrice: data.unitPrice ?? null,
          egaisCode: data.egaisCode ?? null,
          externalRef: data.externalRef ?? null,
        })
        .returning();

      if (!row) {
        throw new InternalServerErrorException("Failed to create product");
      }
      return this.rowToDto(row);
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
    const current = await this.findRow(tenantId, id);
    if (!current) {
      throw new NotFoundException();
    }

    const gtin14 = data.gtin !== undefined ? this.normalizeOrThrow(data.gtin) : current.gtin14;
    const name = data.name !== undefined ? data.name : current.name;
    const productGroup = data.productGroup !== undefined ? data.productGroup : current.productGroup;
    const boxCapacity = data.boxCapacity !== undefined ? data.boxCapacity : current.boxCapacity;
    const palletCapacity =
      data.palletCapacity !== undefined ? data.palletCapacity : current.palletCapacity;
    const defaultCounterpartyId =
      data.defaultCounterpartyId !== undefined
        ? data.defaultCounterpartyId
        : current.defaultCounterpartyId;
    const defaultLabelTemplateId =
      data.defaultLabelTemplateId !== undefined
        ? data.defaultLabelTemplateId
        : current.defaultLabelTemplateId;
    const status = this.computeStatus({ productGroup, boxCapacity, palletCapacity });

    try {
      const set: Partial<typeof schema.products.$inferInsert> = {
        gtin14,
        name,
        productGroup,
        boxCapacity,
        palletCapacity,
        defaultCounterpartyId,
        defaultLabelTemplateId,
        status,
      };

      if (data.unitPrice !== undefined) {
        set.unitPrice = data.unitPrice;
      }
      if (data.egaisCode !== undefined) {
        set.egaisCode = data.egaisCode;
      }
      if (data.externalRef !== undefined) {
        set.externalRef = data.externalRef;
      }

      const [row] = await this.db
        .update(schema.products)
        .set(set)
        .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, id)))
        .returning();

      if (!row) {
        throw new NotFoundException("Product not found or does not belong to this tenant");
      }
      return this.rowToDto(row);
    } catch (error) {
      this.handleWriteError(error);
    }
  }

  /** Delete a product. Returns 404 if not found, 409 if referenced by shifts. */
  async deleteProduct(tenantId: string, id: string): Promise<void> {
    const current = await this.findRow(tenantId, id);
    if (!current) {
      throw new NotFoundException();
    }

    try {
      await this.db
        .delete(schema.products)
        .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, id)));
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

  private async findRow(tenantId: string, id: string): Promise<ProductRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, id)));
    return row;
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
   * Catch PostgreSQL violations: unique 23505 -> 409; FK 23503 -> 400,
   * naming the referenced entity per FK constraint name (products has
   * composite FKs to counterparties/label_templates -- see platform.ts).
   */
  private handleWriteError(error: unknown): never {
    const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
    const cause = err?.cause as { code?: string; constraint?: string } | undefined;
    const errorCode = err?.code || cause?.code;
    const constraint = err?.constraint || cause?.constraint;

    if (errorCode === "23505") {
      throw new ConflictException("A product with this GTIN already exists for this tenant");
    }
    if (errorCode === "23503") {
      if (constraint === "products_tenant_default_label_template_fk") {
        throw new BadRequestException("Unknown label template for this organization");
      }
      throw new BadRequestException("Unknown counterparty for this organization");
    }
    throw error;
  }

  private rowToDto(row: ProductRow): ProductDto {
    return {
      id: row.id,
      gtin14: row.gtin14,
      name: row.name,
      productGroup: row.productGroup,
      boxCapacity: row.boxCapacity,
      palletCapacity: row.palletCapacity,
      status: row.status,
      defaultCounterpartyId: row.defaultCounterpartyId,
      defaultLabelTemplateId: row.defaultLabelTemplateId,
      unitPrice: row.unitPrice,
      egaisCode: row.egaisCode,
      externalRef: row.externalRef,
      createdAt: row.createdAt,
    };
  }
}
