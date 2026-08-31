import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { categorySchemaDefinitionSchema, productAttributeValueSchema } from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import type { UpdateRegulatoryAttributesDto } from "./dto";

type RegulatoryTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class ProductRegulatoryService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getProfile(tenantId: string, productId: string) {
    await this.requireProduct(this.db, tenantId, productId);
    const [binding] = await this.db
      .select()
      .from(schema.productRegulatoryProfiles)
      .where(
        and(
          eq(schema.productRegulatoryProfiles.tenantId, tenantId),
          eq(schema.productRegulatoryProfiles.productId, productId),
        ),
      )
      .limit(1);
    const values = await this.currentValues(this.db, tenantId, productId);
    const egaisCodes = await this.db
      .select({
        code: schema.productEgaisCodes.code,
        isPrimary: schema.productEgaisCodes.isPrimary,
        source: schema.productEgaisCodes.source,
        observedAt: schema.productEgaisCodes.observedAt,
        appliedAt: schema.productEgaisCodes.appliedAt,
      })
      .from(schema.productEgaisCodes)
      .where(
        and(
          eq(schema.productEgaisCodes.tenantId, tenantId),
          eq(schema.productEgaisCodes.productId, productId),
        ),
      );
    const [pending] = await this.db
      .select({ value: count() })
      .from(schema.productRegulatoryProposals)
      .where(
        and(
          eq(schema.productRegulatoryProposals.tenantId, tenantId),
          eq(schema.productRegulatoryProposals.productId, productId),
          eq(schema.productRegulatoryProposals.status, "preview"),
        ),
      );
    return {
      productId,
      binding: binding ?? null,
      values,
      egaisCodes,
      pendingProposalCount: pending?.value ?? 0,
    };
  }

  async getCategoryOptions(tenantId: string, productId: string) {
    const product = await this.requireProduct(this.db, tenantId, productId);
    if (product.chzProductGroupCode === null) return { items: [] };
    const rows = await this.db
      .select({
        schemaVersionId: schema.nationalCatalogSchemaVersions.id,
        categoryId: schema.nationalCatalogSchemaVersions.categoryId,
        categoryName: schema.nationalCatalogSchemaVersions.categoryName,
        selectors: schema.nationalCatalogSchemaVersions.selectors,
        mappingState: schema.nationalCatalogCategoryGroupMappings.state,
      })
      .from(schema.nationalCatalogCategoryGroupMappings)
      .innerJoin(
        schema.nationalCatalogSchemaVersions,
        eq(
          schema.nationalCatalogCategoryGroupMappings.schemaVersionId,
          schema.nationalCatalogSchemaVersions.id,
        ),
      )
      .where(
        and(
          eq(
            schema.nationalCatalogCategoryGroupMappings.chzProductGroupCode,
            product.chzProductGroupCode,
          ),
          eq(schema.nationalCatalogSchemaVersions.status, "active"),
        ),
      );
    return { items: rows };
  }

  async updateAttributes(
    tenantId: string,
    actorUserId: string,
    productId: string,
    body: UpdateRegulatoryAttributesDto,
  ) {
    await this.db.transaction(async (tx) => {
      await this.requireProduct(tx, tenantId, productId, true);
      const [profile] = await tx
        .select()
        .from(schema.productRegulatoryProfiles)
        .where(
          and(
            eq(schema.productRegulatoryProfiles.tenantId, tenantId),
            eq(schema.productRegulatoryProfiles.productId, productId),
          ),
        )
        .for("update")
        .limit(1);
      if (!profile) throw new NotFoundException("Regulatory profile not found");
      if (profile.revision !== body.baseRevision) {
        throw new ConflictException({ code: "PRODUCT_REGULATORY_REVISION_STALE" });
      }
      const [schemaVersion] = await tx
        .select({ definition: schema.nationalCatalogSchemaVersions.definition })
        .from(schema.nationalCatalogSchemaVersions)
        .where(eq(schema.nationalCatalogSchemaVersions.id, profile.schemaVersionId))
        .limit(1);
      if (!schemaVersion) throw new NotFoundException("Pinned category schema not found");
      const definition = categorySchemaDefinitionSchema.parse(schemaVersion.definition);
      const definitions = new Map(
        definition.attributes.map((attribute) => [attribute.id, attribute]),
      );
      const duplicateIds = new Set<string>();
      for (const item of body.values) {
        if (duplicateIds.has(item.attributeId)) this.invalidAttribute(item.attributeId);
        duplicateIds.add(item.attributeId);
        const attribute = definitions.get(item.attributeId);
        if (!attribute) this.invalidAttribute(item.attributeId);
        if (item.value !== null) {
          const parsed = productAttributeValueSchema.safeParse(item.value);
          if (!parsed.success || parsed.data.type !== attribute.valueType) {
            this.invalidAttribute(item.attributeId);
          }
        }
      }

      const current = await this.currentValues(tx, tenantId, productId);
      const beforeById = new Map(current.map((item) => [item.attributeId, item.value]));
      const now = new Date();
      for (const item of body.values) {
        await tx
          .update(schema.productRegulatoryAttributeValues)
          .set({ supersededAt: now })
          .where(
            and(
              eq(schema.productRegulatoryAttributeValues.tenantId, tenantId),
              eq(schema.productRegulatoryAttributeValues.productId, productId),
              eq(schema.productRegulatoryAttributeValues.attributeId, item.attributeId),
              isNull(schema.productRegulatoryAttributeValues.supersededAt),
            ),
          );
        if (item.value !== null) {
          await tx.insert(schema.productRegulatoryAttributeValues).values({
            tenantId,
            productId,
            schemaVersionId: profile.schemaVersionId,
            attributeId: item.attributeId,
            value: item.value,
            source: "manual",
            appliedBy: actorUserId,
            appliedAt: now,
          });
        }
      }
      await tx
        .update(schema.productRegulatoryProfiles)
        .set({ revision: profile.revision + 1, updatedAt: now })
        .where(
          and(
            eq(schema.productRegulatoryProfiles.tenantId, tenantId),
            eq(schema.productRegulatoryProfiles.productId, productId),
          ),
        );
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "product.regulatory_attributes.updated",
        outcome: "success",
        targetType: "product",
        targetId: productId,
        before: body.values.map((item) => ({
          attributeId: item.attributeId,
          value: beforeById.get(item.attributeId) ?? null,
        })),
        after: body.values,
      });
    });
    return this.getProfile(tenantId, productId);
  }

  private invalidAttribute(attributeId: string): never {
    throw new BadRequestException({ code: "PRODUCT_ATTRIBUTE_INVALID", attributeId });
  }

  private async requireProduct(
    db: Db | RegulatoryTx,
    tenantId: string,
    productId: string,
    lock = false,
  ) {
    const query = db
      .select({
        id: schema.products.id,
        chzProductGroupCode: schema.products.chzProductGroupCode,
      })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
    const rows = lock ? await query.for("update").limit(1) : await query.limit(1);
    const product = rows[0];
    if (!product) throw new NotFoundException();
    return product;
  }

  private currentValues(db: Db | RegulatoryTx, tenantId: string, productId: string) {
    return db
      .select({
        attributeId: schema.productRegulatoryAttributeValues.attributeId,
        value: schema.productRegulatoryAttributeValues.value,
        source: schema.productRegulatoryAttributeValues.source,
        observedAt: schema.productRegulatoryAttributeValues.observedAt,
        appliedAt: schema.productRegulatoryAttributeValues.appliedAt,
      })
      .from(schema.productRegulatoryAttributeValues)
      .where(
        and(
          eq(schema.productRegulatoryAttributeValues.tenantId, tenantId),
          eq(schema.productRegulatoryAttributeValues.productId, productId),
          isNull(schema.productRegulatoryAttributeValues.supersededAt),
        ),
      );
  }
}
