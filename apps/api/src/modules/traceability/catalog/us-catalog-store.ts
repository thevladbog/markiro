import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { normalizeCatalogGtin, US_CAPABILITY } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import {
  createUsProductSchema,
  listUsProductsQuerySchema,
  platformUuidSchema,
  updateUsProductSchema,
  type UsProduct,
  type UsProductList,
} from "@markiro/platform-contracts";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import {
  authorizeUsMasterData,
  escapeLikePattern,
  isUniqueConstraintViolation,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { productResponse } from "./us-catalog-support";

const ACTIVE_GTIN_CONSTRAINT = "products_tenant_gtin_unarchived_uq";

/** US-only catalog access over the shared product table. */
export class UsCatalogStore {
  constructor(private readonly db: Db) {}

  async listProducts(
    tenantId: string,
    actorUserId: string,
    query: unknown,
  ): Promise<UsProductList> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const value = parseMasterDataInput(listUsProductsQuerySchema, query);
      const search = value.search ? `%${escapeLikePattern(value.search)}%` : undefined;
      const rows = await tx
        .select({
          id: schema.products.id,
          name: schema.products.name,
          gtin14: schema.products.gtin14,
          archived: schema.products.archived,
          createdAt: schema.products.createdAt,
          updatedAt: schema.products.updatedAt,
        })
        .from(schema.products)
        .where(
          and(
            eq(schema.products.tenantId, tenantId),
            value.archived === "all"
              ? undefined
              : eq(schema.products.archived, value.archived === "true"),
            search
              ? or(ilike(schema.products.name, search), ilike(schema.products.gtin14, search))
              : undefined,
          ),
        )
        .orderBy(asc(schema.products.name), asc(schema.products.id))
        .limit(value.limit)
        .offset(value.offset);
      return { items: rows.map(productResponse), limit: value.limit, offset: value.offset };
    });
  }

  async getProduct(tenantId: string, actorUserId: string, id: unknown): Promise<UsProduct> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const productId = parseMasterDataInput(platformUuidSchema, id);
      const [row] = await tx
        .select({
          id: schema.products.id,
          name: schema.products.name,
          gtin14: schema.products.gtin14,
          archived: schema.products.archived,
          createdAt: schema.products.createdAt,
          updatedAt: schema.products.updatedAt,
        })
        .from(schema.products)
        .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)))
        .limit(1);
      if (!row) throw new NotFoundException({ code: "product_not_found" });
      return productResponse(row);
    });
  }

  async createProduct(
    tenantId: string,
    actorUserId: string,
    input: unknown,
    requestId: string,
  ): Promise<UsProduct> {
    try {
      return await this.db.transaction(async (tx) => {
        const profile = await authorizeUsMasterData(
          tx,
          tenantId,
          actorUserId,
          US_CAPABILITY.MASTER_DATA_WRITE,
        );
        const value = parseMasterDataInput(createUsProductSchema, input);
        const now = new Date();
        const [row] = await tx
          .insert(schema.products)
          .values({
            tenantId,
            gtin14: normalizeCatalogGtin(profile, value.gtin),
            name: value.name,
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: schema.products.id,
            name: schema.products.name,
            gtin14: schema.products.gtin14,
            archived: schema.products.archived,
            createdAt: schema.products.createdAt,
            updatedAt: schema.products.updatedAt,
          });
        if (!row) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
        const response = productResponse(row);
        await this.writeAudit(
          tx,
          tenantId,
          actorUserId,
          requestId,
          row.id,
          null,
          response,
          "created",
        );
        return response;
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error, ACTIVE_GTIN_CONSTRAINT)) {
        throw new ConflictException({ code: "product_gtin_taken" });
      }
      throw error;
    }
  }

  async updateProduct(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<UsProduct> {
    try {
      return await this.db.transaction(async (tx) => {
        const profile = await authorizeUsMasterData(
          tx,
          tenantId,
          actorUserId,
          US_CAPABILITY.MASTER_DATA_WRITE,
        );
        const productId = parseMasterDataInput(platformUuidSchema, id);
        const patch = parseMasterDataInput(updateUsProductSchema, input);
        const [existing] = await tx
          .select({
            id: schema.products.id,
            name: schema.products.name,
            gtin14: schema.products.gtin14,
            archived: schema.products.archived,
            createdAt: schema.products.createdAt,
            updatedAt: schema.products.updatedAt,
          })
          .from(schema.products)
          .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)))
          .limit(1)
          .for("update");
        if (!existing) throw new NotFoundException({ code: "product_not_found" });
        const current = productResponse(existing);
        const next = {
          name: patch.name ?? current.name,
          gtin14:
            patch.gtin === undefined ? current.gtin14 : normalizeCatalogGtin(profile, patch.gtin),
          archived: patch.archived ?? current.archived,
        };
        if (
          isDeepStrictEqual(
            { name: current.name, gtin14: current.gtin14, archived: current.archived },
            next,
          )
        ) {
          return current;
        }
        if (next.gtin14 !== current.gtin14) {
          await this.assertGtinMutable(tx, tenantId, productId);
        }
        const [updated] = await tx
          .update(schema.products)
          .set({
            name: next.name,
            gtin14: next.gtin14,
            archived: next.archived,
            updatedAt: new Date(),
          })
          .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)))
          .returning({
            id: schema.products.id,
            name: schema.products.name,
            gtin14: schema.products.gtin14,
            archived: schema.products.archived,
            createdAt: schema.products.createdAt,
            updatedAt: schema.products.updatedAt,
          });
        if (!updated) throw new NotFoundException({ code: "product_not_found" });
        const response = productResponse(updated);
        const lifecycle =
          patch.archived !== undefined && patch.archived !== current.archived
            ? patch.archived
              ? "archived"
              : "restored"
            : "updated";
        await this.writeAudit(
          tx,
          tenantId,
          actorUserId,
          requestId,
          productId,
          current,
          response,
          lifecycle,
        );
        return response;
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error, ACTIVE_GTIN_CONSTRAINT)) {
        throw new ConflictException({ code: "product_gtin_taken" });
      }
      throw error;
    }
  }

  private async assertGtinMutable(
    tx: UsMasterDataTransaction,
    tenantId: string,
    productId: string,
  ): Promise<void> {
    const tables = [schema.shifts, schema.kioskProducts, schema.inventories] as const;
    for (const table of tables) {
      const [reference] = await tx
        .select({ productId: table.productId })
        .from(table)
        .where(and(eq(table.tenantId, tenantId), eq(table.productId, productId)))
        .limit(1);
      if (reference) throw new ConflictException({ code: "product_gtin_locked" });
    }
  }

  private async writeAudit(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    requestId: string,
    productId: string,
    before: UsProduct | null,
    after: UsProduct,
    lifecycle: "created" | "updated" | "archived" | "restored",
  ): Promise<void> {
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action: `traceability.product.${lifecycle}`,
      outcome: "success",
      targetType: "traceability_product",
      targetId: productId,
      before,
      after,
      requestId,
    });
  }
}
