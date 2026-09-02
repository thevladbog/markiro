import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { categorySchemaDefinitionSchema } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";

import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import type { ChzTokenService } from "../chz-exports/chz-token.service";
import type { NationalCatalogClient } from "./national-catalog.client";
import { canonicalJsonHash } from "./national-catalog-products.service";
import { normalizeNationalCatalogSchema } from "./national-catalog-schema-normalizer";
import { NATIONAL_CATALOG_BASE_URL } from "./national-catalog.tokens";

export interface NationalCatalogSchemaObservation {
  scopeKey: string;
  categoryId: string;
  categoryName: string;
  gismtCodes: number[];
  selectors: { catId: number };
  sourceVersion: "v3";
  etag: string | null;
  contentHash: string;
  definition: unknown;
  status: "observed";
  fetchedAt: Date;
}

export interface NationalCatalogSchemaRepository {
  observe(observation: NationalCatalogSchemaObservation): Promise<{ inserted: boolean }>;
  activate(
    schemaVersionId: string,
    principal: PlatformPrincipal,
  ): Promise<{
    schemaVersionId: string;
    priorSchemaVersionId: string | null;
    alreadyActive: boolean;
  }>;
  auditRefresh?(
    sourceTenantId: string,
    principal: PlatformPrincipal,
    result: NationalCatalogSchemaRefreshResult,
  ): Promise<void>;
  reviewGroupMapping(
    chzProductGroupCode: number,
    review: { state: "exact" | "ambiguous" | "unmapped"; schemaVersionIds: string[] },
    principal: PlatformPrincipal,
  ): Promise<{
    chzProductGroupCode: number;
    state: "exact" | "ambiguous" | "unmapped";
    schemaVersionIds: string[];
    reviewedAt: string;
  }>;
  reviewAttributeMappings(
    schemaVersionId: string,
    mappings: NationalCatalogReviewedAttributeMapping[],
    principal: PlatformPrincipal,
  ): Promise<{ schemaVersionId: string; mappingCount: number; reviewedAt: string }>;
}

export interface NationalCatalogReviewedAttributeMapping {
  sourceAttributeId: string;
  targetField: "name" | "print_name" | "shelf_life_days";
  conversion: { kind: "identity" | "string_trim" | "positive_integer" };
  mappingVersion: number;
}

export const NATIONAL_CATALOG_SCHEMA_REPOSITORY = Symbol("NATIONAL_CATALOG_SCHEMA_REPOSITORY");

export class DrizzleNationalCatalogSchemaRepository implements NationalCatalogSchemaRepository {
  constructor(private readonly db: Db) {}

  async observe(observation: NationalCatalogSchemaObservation) {
    return this.db.transaction(async (tx) => {
      const { gismtCodes, ...schemaObservation } = observation;
      const [inserted] = await tx
        .insert(schema.nationalCatalogSchemaVersions)
        .values(schemaObservation)
        .onConflictDoNothing()
        .returning({ id: schema.nationalCatalogSchemaVersions.id });
      const [existing] = inserted
        ? [inserted]
        : await tx
            .select({ id: schema.nationalCatalogSchemaVersions.id })
            .from(schema.nationalCatalogSchemaVersions)
            .where(
              and(
                eq(schema.nationalCatalogSchemaVersions.scopeKey, observation.scopeKey),
                eq(schema.nationalCatalogSchemaVersions.contentHash, observation.contentHash),
              ),
            )
            .limit(1);
      if (!existing) throw new Error("National Catalog schema observation persistence failed");

      const candidateCodes = [...new Set(gismtCodes)].sort((left, right) => left - right);
      if (candidateCodes.length > 0) {
        const knownGroups = await tx
          .select({ code: schema.chzProductGroups.code })
          .from(schema.chzProductGroups)
          .where(inArray(schema.chzProductGroups.code, candidateCodes));
        if (knownGroups.length > 0) {
          await tx
            .insert(schema.nationalCatalogCategoryGroupMappings)
            .values(
              knownGroups.map((group) => ({
                chzProductGroupCode: group.code,
                schemaVersionId: existing.id,
                categoryId: observation.categoryId,
                state: "ambiguous" as const,
              })),
            )
            .onConflictDoNothing();
        }
      }
      return { inserted: Boolean(inserted) };
    });
  }

  activate(schemaVersionId: string, principal: PlatformPrincipal) {
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(schema.nationalCatalogSchemaVersions)
        .where(eq(schema.nationalCatalogSchemaVersions.id, schemaVersionId))
        .for("update")
        .limit(1);
      if (!target) throw new NotFoundException("National Catalog schema version not found");
      const definition = categorySchemaDefinitionSchema.safeParse(target.definition);
      if (!definition.success) {
        throw new ConflictException({ code: "NATIONAL_CATALOG_SCHEMA_BLOCKED" });
      }
      if (target.status === "active") {
        return { schemaVersionId, priorSchemaVersionId: schemaVersionId, alreadyActive: true };
      }
      const [mapping] = await tx
        .select({ id: schema.nationalCatalogCategoryGroupMappings.id })
        .from(schema.nationalCatalogCategoryGroupMappings)
        .where(
          and(
            eq(schema.nationalCatalogCategoryGroupMappings.schemaVersionId, schemaVersionId),
            eq(schema.nationalCatalogCategoryGroupMappings.state, "exact"),
            isNotNull(schema.nationalCatalogCategoryGroupMappings.reviewedAt),
          ),
        )
        .limit(1);
      if (!mapping) {
        throw new ConflictException({ code: "NATIONAL_CATALOG_EXACT_MAPPING_REQUIRED" });
      }
      const [prior] = await tx
        .select({ id: schema.nationalCatalogSchemaVersions.id })
        .from(schema.nationalCatalogSchemaVersions)
        .where(
          and(
            eq(schema.nationalCatalogSchemaVersions.scopeKey, target.scopeKey),
            eq(schema.nationalCatalogSchemaVersions.status, "active"),
            ne(schema.nationalCatalogSchemaVersions.id, schemaVersionId),
          ),
        )
        .limit(1);
      const now = new Date();
      await tx
        .update(schema.nationalCatalogSchemaVersions)
        .set({ status: "retired", retiredAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.nationalCatalogSchemaVersions.scopeKey, target.scopeKey),
            eq(schema.nationalCatalogSchemaVersions.status, "active"),
            ne(schema.nationalCatalogSchemaVersions.id, schemaVersionId),
          ),
        );
      await tx
        .update(schema.nationalCatalogSchemaVersions)
        .set({
          status: "active",
          validatedAt: now,
          activatedAt: now,
          retiredAt: null,
          updatedAt: now,
        })
        .where(eq(schema.nationalCatalogSchemaVersions.id, schemaVersionId));
      await tx.insert(schema.platformAuditEvents).values({
        actorPlatformUserId: principal.userId,
        actorRole: principal.role,
        action: "national_catalog.schema.activated",
        outcome: "success",
        targetType: "national_catalog_schema_version",
        targetId: schemaVersionId,
        before: { schemaVersionId: prior?.id ?? null },
        after: { schemaVersionId, scopeKey: target.scopeKey },
      });
      return {
        schemaVersionId,
        priorSchemaVersionId: prior?.id ?? null,
        alreadyActive: false,
      };
    });
  }

  async auditRefresh(
    sourceTenantId: string,
    principal: PlatformPrincipal,
    result: NationalCatalogSchemaRefreshResult,
  ) {
    await this.db.insert(schema.platformAuditEvents).values({
      actorPlatformUserId: principal.userId,
      actorRole: principal.role,
      action: "national_catalog.schema.refreshed",
      outcome: result.failed === 0 ? "success" : "failed",
      tenantId: sourceTenantId,
      targetType: "national_catalog_schema",
      targetId: null,
      after: result,
    });
  }

  reviewGroupMapping(
    chzProductGroupCode: number,
    review: { state: "exact" | "ambiguous" | "unmapped"; schemaVersionIds: string[] },
    principal: PlatformPrincipal,
  ) {
    return this.db.transaction(async (tx) => {
      const [group] = await tx
        .select({ code: schema.chzProductGroups.code })
        .from(schema.chzProductGroups)
        .where(eq(schema.chzProductGroups.code, chzProductGroupCode))
        .limit(1);
      if (!group) throw new NotFoundException("ChZ product group not found");
      const versions =
        review.schemaVersionIds.length === 0
          ? []
          : await tx
              .select({
                id: schema.nationalCatalogSchemaVersions.id,
                categoryId: schema.nationalCatalogSchemaVersions.categoryId,
              })
              .from(schema.nationalCatalogSchemaVersions)
              .where(inArray(schema.nationalCatalogSchemaVersions.id, review.schemaVersionIds));
      if (versions.length !== review.schemaVersionIds.length) {
        throw new NotFoundException("National Catalog schema version not found");
      }
      await tx
        .delete(schema.nationalCatalogCategoryGroupMappings)
        .where(
          eq(schema.nationalCatalogCategoryGroupMappings.chzProductGroupCode, chzProductGroupCode),
        );
      const reviewedAt = new Date();
      if (review.state === "unmapped") {
        await tx.insert(schema.nationalCatalogCategoryGroupMappings).values({
          chzProductGroupCode,
          schemaVersionId: null,
          categoryId: null,
          state: "unmapped",
          reviewedAt,
          reviewedBy: null,
        });
      } else {
        const byId = new Map(versions.map((version) => [version.id, version]));
        await tx.insert(schema.nationalCatalogCategoryGroupMappings).values(
          review.schemaVersionIds.map((id) => ({
            chzProductGroupCode,
            schemaVersionId: id,
            categoryId: byId.get(id)!.categoryId,
            state: review.state,
            reviewedAt,
            reviewedBy: null,
          })),
        );
      }
      await tx.insert(schema.platformAuditEvents).values({
        actorPlatformUserId: principal.userId,
        actorRole: principal.role,
        action: "national_catalog.group_mapping.reviewed",
        outcome: "success",
        targetType: "chz_product_group",
        targetId: String(chzProductGroupCode),
        after: review,
      });
      return {
        chzProductGroupCode,
        state: review.state,
        schemaVersionIds: [...review.schemaVersionIds],
        reviewedAt: reviewedAt.toISOString(),
      };
    });
  }

  reviewAttributeMappings(
    schemaVersionId: string,
    mappings: NationalCatalogReviewedAttributeMapping[],
    principal: PlatformPrincipal,
  ) {
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ definition: schema.nationalCatalogSchemaVersions.definition })
        .from(schema.nationalCatalogSchemaVersions)
        .where(eq(schema.nationalCatalogSchemaVersions.id, schemaVersionId))
        .limit(1);
      if (!target) throw new NotFoundException("National Catalog schema version not found");
      const definition = categorySchemaDefinitionSchema.safeParse(target.definition);
      if (!definition.success) {
        throw new ConflictException({ code: "NATIONAL_CATALOG_SCHEMA_BLOCKED" });
      }
      const attributeIds = new Set(definition.data.attributes.map((attribute) => attribute.id));
      for (const mapping of mappings) {
        if (
          (mapping.sourceAttributeId !== "good_name" &&
            !attributeIds.has(mapping.sourceAttributeId)) ||
          (mapping.targetField === "shelf_life_days" &&
            mapping.conversion.kind !== "positive_integer") ||
          (mapping.targetField !== "shelf_life_days" &&
            mapping.conversion.kind === "positive_integer") ||
          (mapping.sourceAttributeId === "good_name" && mapping.targetField === "shelf_life_days")
        ) {
          throw new ConflictException({ code: "NATIONAL_CATALOG_ATTRIBUTE_MAPPING_INVALID" });
        }
      }
      await tx
        .delete(schema.nationalCatalogAttributeMappings)
        .where(eq(schema.nationalCatalogAttributeMappings.schemaVersionId, schemaVersionId));
      if (mappings.length > 0) {
        await tx.insert(schema.nationalCatalogAttributeMappings).values(
          mappings.map((mapping) => ({
            schemaVersionId,
            sourceAttributeId: mapping.sourceAttributeId,
            targetField: mapping.targetField,
            conversion: mapping.conversion,
            mappingVersion: mapping.mappingVersion,
          })),
        );
      }
      const reviewedAt = new Date();
      await tx.insert(schema.platformAuditEvents).values({
        actorPlatformUserId: principal.userId,
        actorRole: principal.role,
        action: "national_catalog.attribute_mappings.reviewed",
        outcome: "success",
        targetType: "national_catalog_schema_version",
        targetId: schemaVersionId,
        after: {
          mappingCount: mappings.length,
          mappings: mappings.map((mapping) => ({
            sourceAttributeId: mapping.sourceAttributeId,
            targetField: mapping.targetField,
            conversion: mapping.conversion,
            mappingVersion: mapping.mappingVersion,
          })),
        },
        createdAt: reviewedAt,
      });
      return {
        schemaVersionId,
        mappingCount: mappings.length,
        reviewedAt: reviewedAt.toISOString(),
      };
    });
  }
}

export interface NationalCatalogSchemaRefreshResult {
  categories: number;
  observed: number;
  unchanged: number;
  blocked: number;
  failed: number;
}

@Injectable()
export class NationalCatalogSchemaService {
  constructor(
    @Inject(NATIONAL_CATALOG_SCHEMA_REPOSITORY)
    private readonly repository: NationalCatalogSchemaRepository,
    private readonly client: NationalCatalogClient,
    private readonly tokens: ChzTokenService,
    @Inject(NATIONAL_CATALOG_BASE_URL) private readonly baseUrl: string | undefined,
    private readonly sourceTenantId: string | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async refresh(sourceTenantId: string, principal?: PlatformPrincipal) {
    if (!this.baseUrl || !this.sourceTenantId) {
      throw new ConflictException({ code: "NATIONAL_CATALOG_UNCONFIGURED" });
    }
    if (sourceTenantId !== this.sourceTenantId) {
      throw new ConflictException({ code: "NATIONAL_CATALOG_SOURCE_TENANT_MISMATCH" });
    }
    const token = await this.tokens.getActiveToken(sourceTenantId);
    if (token.status !== "ok") {
      throw new ConflictException({ code: `NATIONAL_CATALOG_TOKEN_${token.status.toUpperCase()}` });
    }
    const auth = { baseUrl: this.baseUrl, token: token.auth.token };
    const categories = await this.client.listCategories(auth);
    if (categories.status !== "ok") {
      throw new ConflictException({ code: "NATIONAL_CATALOG_CATEGORIES_UNAVAILABLE" });
    }
    const result: NationalCatalogSchemaRefreshResult = {
      categories: categories.value.categories.filter((category) => category.active).length,
      observed: 0,
      unchanged: 0,
      blocked: 0,
      failed: 0,
    };
    for (const category of [...categories.value.categories]
      .filter((item) => item.active)
      .sort((left, right) => left.id - right.id)) {
      const attributes = await this.client.getAttributes(auth, { catId: category.id });
      if (attributes.status !== "ok") {
        result.failed += 1;
        continue;
      }
      const normalized = normalizeNationalCatalogSchema(category, attributes.value.attributes);
      const definition =
        normalized.status === "valid"
          ? normalized.definition
          : {
              observationVersion: 1,
              categoryId: String(category.id),
              scopeKey: `national-catalog:category:${category.id}`,
              blockedReasons: normalized.reasons,
              source: {
                category: category.raw,
                attributes: attributes.value.attributes.map((attribute) => attribute.raw),
              },
            };
      const persisted = await this.repository.observe({
        scopeKey: `national-catalog:category:${category.id}`,
        categoryId: String(category.id),
        categoryName: category.name,
        gismtCodes: category.gismtCodes,
        selectors: { catId: category.id },
        sourceVersion: "v3",
        etag: attributes.etag,
        contentHash:
          normalized.status === "valid" ? normalized.contentHash : canonicalJsonHash(definition),
        definition,
        status: "observed",
        fetchedAt: this.now(),
      });
      if (!persisted.inserted) result.unchanged += 1;
      else if (normalized.status === "blocked") result.blocked += 1;
      else result.observed += 1;
    }
    if (principal && this.repository.auditRefresh) {
      await this.repository.auditRefresh(sourceTenantId, principal, result);
    }
    return result;
  }

  activate(schemaVersionId: string, principal: PlatformPrincipal) {
    return this.repository.activate(schemaVersionId, principal);
  }

  reviewGroupMapping(
    chzProductGroupCode: number,
    review: { state: "exact" | "ambiguous" | "unmapped"; schemaVersionIds: string[] },
    principal: PlatformPrincipal,
  ) {
    return this.repository.reviewGroupMapping(chzProductGroupCode, review, principal);
  }

  reviewAttributeMappings(
    schemaVersionId: string,
    mappings: NationalCatalogReviewedAttributeMapping[],
    principal: PlatformPrincipal,
  ) {
    return this.repository.reviewAttributeMappings(schemaVersionId, mappings, principal);
  }
}

export const nationalCatalogSchemaRepositoryProvider = {
  provide: NATIONAL_CATALOG_SCHEMA_REPOSITORY,
  inject: [DB],
  useFactory: (db: Db) => new DrizzleNationalCatalogSchemaRepository(db),
};
