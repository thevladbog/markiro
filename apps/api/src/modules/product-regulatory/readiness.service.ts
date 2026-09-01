import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  evaluateProductReadiness,
  parseCategorySchemaDefinition,
  type ProductAttributeValues,
  type ProductReadinessDimensionResult,
} from "@markiro/domain";

import { DB } from "../../auth/auth.module";

export interface ProductReadinessResponse {
  productId: string;
  dimensions: ProductReadinessDimensionResult[];
}

@Injectable()
export class ProductReadinessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getReadiness(tenantId: string, productId: string): Promise<ProductReadinessResponse> {
    const [product] = await this.db
      .select({
        id: schema.products.id,
        chzProductGroupCode: schema.products.chzProductGroupCode,
        boxCapacity: schema.products.boxCapacity,
        palletCapacity: schema.products.palletCapacity,
        egaisCode: schema.products.egaisCode,
      })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)))
      .limit(1);
    if (!product) throw new NotFoundException();

    const [profile] = await this.db
      .select()
      .from(schema.productRegulatoryProfiles)
      .where(
        and(
          eq(schema.productRegulatoryProfiles.tenantId, tenantId),
          eq(schema.productRegulatoryProfiles.productId, productId),
        ),
      )
      .limit(1);

    const egaisRows = await this.db
      .select({
        code: schema.productEgaisCodes.code,
        isPrimary: schema.productEgaisCodes.isPrimary,
      })
      .from(schema.productEgaisCodes)
      .where(
        and(
          eq(schema.productEgaisCodes.tenantId, tenantId),
          eq(schema.productEgaisCodes.productId, productId),
        ),
      );
    const egaisCodes =
      egaisRows.length > 0
        ? egaisRows.map((row) => row.code)
        : product.egaisCode
          ? [product.egaisCode]
          : [];

    if (!profile) {
      const evaluated = evaluateProductReadiness({
        schemaVersionId: "category-not-confirmed",
        schema: {
          formatVersion: 2,
          categoryId: "unconfirmed",
          scopeKey: "category:unconfirmed|tnved:none",
          attributes: [],
        },
        values: {},
        production: product,
        egais: {
          applicable: product.chzProductGroupCode === 15,
          codes: egaisCodes,
          primaryCode: egaisRows.find((row) => row.isPrimary)?.code ?? null,
        },
        schemaStale: false,
      });
      return {
        productId,
        dimensions: evaluated.map((dimension) =>
          dimension.dimension === "code_ordering" || dimension.dimension === "circulation"
            ? {
                ...dimension,
                state: "not_ready",
                reasons: [{ code: "CATEGORY_NOT_CONFIRMED" }],
              }
            : dimension,
        ),
      };
    }

    const [pinnedSchema] = await this.db
      .select()
      .from(schema.nationalCatalogSchemaVersions)
      .where(eq(schema.nationalCatalogSchemaVersions.id, profile.schemaVersionId))
      .limit(1);
    if (!pinnedSchema) throw new NotFoundException("Pinned category schema not found");
    const definition = parseCategorySchemaDefinition(pinnedSchema.definition);
    const [activeSchema] = await this.db
      .select({ id: schema.nationalCatalogSchemaVersions.id })
      .from(schema.nationalCatalogSchemaVersions)
      .where(
        and(
          eq(schema.nationalCatalogSchemaVersions.scopeKey, pinnedSchema.scopeKey),
          eq(schema.nationalCatalogSchemaVersions.status, "active"),
        ),
      )
      .limit(1);
    const valueRows = await this.db
      .select({
        attributeId: schema.productRegulatoryAttributeValues.attributeId,
        value: schema.productRegulatoryAttributeValues.value,
      })
      .from(schema.productRegulatoryAttributeValues)
      .where(
        and(
          eq(schema.productRegulatoryAttributeValues.tenantId, tenantId),
          eq(schema.productRegulatoryAttributeValues.productId, productId),
          eq(schema.productRegulatoryAttributeValues.state, "active"),
          isNull(schema.productRegulatoryAttributeValues.supersededAt),
        ),
      );
    const values = Object.fromEntries(
      valueRows.map((row) => [row.attributeId, row.value]),
    ) as ProductAttributeValues;

    return {
      productId,
      dimensions: evaluateProductReadiness({
        schemaVersionId: profile.schemaVersionId,
        schema: definition,
        values,
        production: product,
        egais: {
          applicable: product.chzProductGroupCode === 15,
          codes: egaisCodes,
          primaryCode: egaisRows.find((row) => row.isPrimary)?.code ?? null,
        },
        schemaStale: activeSchema?.id !== profile.schemaVersionId,
      }),
    };
  }
}
