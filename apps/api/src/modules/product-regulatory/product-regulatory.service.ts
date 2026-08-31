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
import type {
  ApplyRegulatoryProposalDto,
  CategoryChangePreviewDto,
  EgaisCodesBodyDto,
  UpdateRegulatoryAttributesDto,
} from "./dto";

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

  async previewCategoryChange(
    tenantId: string,
    actorUserId: string,
    productId: string,
    body: CategoryChangePreviewDto,
  ) {
    const product = await this.requireProduct(this.db, tenantId, productId);
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
    if (!profile) throw new NotFoundException("Regulatory profile not found");
    if (profile.revision !== body.baseRevision) {
      throw new ConflictException({ code: "PRODUCT_REGULATORY_REVISION_STALE" });
    }
    const [target] = await this.db
      .select()
      .from(schema.nationalCatalogSchemaVersions)
      .where(
        and(
          eq(schema.nationalCatalogSchemaVersions.id, body.targetSchemaVersionId),
          eq(schema.nationalCatalogSchemaVersions.status, "active"),
        ),
      )
      .limit(1);
    if (!target) throw new NotFoundException("Target category schema not found");
    if (product.chzProductGroupCode === null) {
      throw new ConflictException({ code: "CATEGORY_GROUP_INCOMPATIBLE" });
    }
    const [mapping] = await this.db
      .select()
      .from(schema.nationalCatalogCategoryGroupMappings)
      .where(
        and(
          eq(
            schema.nationalCatalogCategoryGroupMappings.chzProductGroupCode,
            product.chzProductGroupCode,
          ),
          eq(schema.nationalCatalogCategoryGroupMappings.schemaVersionId, target.id),
        ),
      )
      .limit(1);
    if (!mapping || mapping.state === "unmapped") {
      throw new ConflictException({ code: "CATEGORY_GROUP_INCOMPATIBLE" });
    }
    if (mapping.state === "ambiguous" && !body.mappingConfirmed) {
      throw new ConflictException({ code: "CATEGORY_GROUP_CONFIRMATION_REQUIRED" });
    }
    const sourceDefinition = await this.loadDefinition(profile.schemaVersionId);
    const targetDefinition = categorySchemaDefinitionSchema.parse(target.definition);
    const sourceById = new Map(sourceDefinition.attributes.map((item) => [item.id, item]));
    const targetById = new Map(targetDefinition.attributes.map((item) => [item.id, item]));
    const current = await this.currentValues(this.db, tenantId, productId);
    const values = current.map((entry) => {
      const source = sourceById.get(entry.attributeId);
      const destination = targetById.get(entry.attributeId);
      const disposition = !destination
        ? "inapplicable"
        : source?.valueType === destination.valueType &&
            source.multiplicity === destination.multiplicity
          ? "transferable"
          : "conflict";
      return {
        entryId: entry.entryId,
        attributeId: entry.attributeId,
        disposition,
        currentValue: entry.value,
      };
    });
    const diff = {
      target: {
        schemaVersionId: target.id,
        categoryId: target.categoryId,
        categoryName: target.categoryName,
        tnVedCode: body.tnVedCode,
        okpd2Code: body.okpd2Code,
      },
      values,
    };
    const [proposal] = await this.db
      .insert(schema.productRegulatoryProposals)
      .values({
        tenantId,
        productId,
        source: "manual",
        baseRevision: body.baseRevision,
        diff,
        createdBy: actorUserId,
      })
      .returning({ id: schema.productRegulatoryProposals.id });
    if (!proposal) throw new ConflictException("Failed to persist category preview");
    return { proposalId: proposal.id, baseRevision: body.baseRevision, diff };
  }

  async applyProposal(
    tenantId: string,
    actorUserId: string,
    productId: string,
    proposalId: string,
    body: ApplyRegulatoryProposalDto,
  ) {
    const accepted = [...body.acceptedEntryIds].sort();
    const outcome = await this.db.transaction(async (tx) => {
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
      const [proposal] = await tx
        .select()
        .from(schema.productRegulatoryProposals)
        .where(
          and(
            eq(schema.productRegulatoryProposals.tenantId, tenantId),
            eq(schema.productRegulatoryProposals.productId, productId),
            eq(schema.productRegulatoryProposals.id, proposalId),
          ),
        )
        .for("update")
        .limit(1);
      if (!profile || !proposal) throw new NotFoundException();
      if (proposal.status === "applied") {
        if (proposal.sourceRef === JSON.stringify(accepted)) return "replay" as const;
        throw new ConflictException({ code: "REGULATORY_PROPOSAL_REPLAY_MISMATCH" });
      }
      if (proposal.status !== "preview") {
        throw new ConflictException({ code: "REGULATORY_PROPOSAL_NOT_APPLICABLE" });
      }
      if (proposal.baseRevision !== profile.revision) {
        await tx
          .update(schema.productRegulatoryProposals)
          .set({ status: "stale", staleAt: new Date() })
          .where(eq(schema.productRegulatoryProposals.id, proposal.id));
        return "stale" as const;
      }
      const diff = proposal.diff as {
        target: {
          schemaVersionId: string;
          categoryId: string;
          categoryName: string;
          tnVedCode: string | null;
          okpd2Code: string | null;
        };
        values: Array<{
          entryId: string;
          attributeId: string;
          disposition: string;
          currentValue: unknown;
        }>;
      };
      const byId = new Map(diff.values.map((entry) => [entry.entryId, entry]));
      if (accepted.some((id) => !byId.has(id))) {
        throw new BadRequestException({ code: "REGULATORY_PROPOSAL_ENTRY_INVALID" });
      }
      const selected = diff.values.filter(
        (entry) =>
          accepted.includes(entry.entryId) &&
          (entry.disposition === "transferable" || entry.disposition === "convertible"),
      );
      const now = new Date();
      await tx
        .update(schema.productRegulatoryAttributeValues)
        .set({ supersededAt: now })
        .where(
          and(
            eq(schema.productRegulatoryAttributeValues.tenantId, tenantId),
            eq(schema.productRegulatoryAttributeValues.productId, productId),
            isNull(schema.productRegulatoryAttributeValues.supersededAt),
          ),
        );
      for (const entry of selected) {
        await tx.insert(schema.productRegulatoryAttributeValues).values({
          tenantId,
          productId,
          schemaVersionId: diff.target.schemaVersionId,
          attributeId: entry.attributeId,
          value: entry.currentValue,
          source: "manual",
          appliedBy: actorUserId,
          appliedAt: now,
        });
      }
      await tx
        .update(schema.productRegulatoryProfiles)
        .set({
          revision: profile.revision + 1,
          schemaVersionId: diff.target.schemaVersionId,
          categoryId: diff.target.categoryId,
          categoryName: diff.target.categoryName,
          tnVedCode: diff.target.tnVedCode,
          okpd2Code: diff.target.okpd2Code,
          source: "manual",
          confirmedBy: actorUserId,
          confirmedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.productRegulatoryProfiles.tenantId, tenantId),
            eq(schema.productRegulatoryProfiles.productId, productId),
          ),
        );
      await tx
        .update(schema.productRegulatoryProposals)
        .set({
          status: "applied",
          sourceRef: JSON.stringify(accepted),
          appliedBy: actorUserId,
          appliedAt: now,
        })
        .where(eq(schema.productRegulatoryProposals.id, proposal.id));
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "product.regulatory_category.changed",
        outcome: "success",
        targetType: "product",
        targetId: productId,
        before: { schemaVersionId: profile.schemaVersionId, categoryId: profile.categoryId },
        after: { ...diff.target, dispositions: dispositionCounts(diff.values) },
      });
      return "applied" as const;
    });
    if (outcome === "stale") {
      throw new ConflictException({ code: "PRODUCT_REGULATORY_REVISION_STALE" });
    }
    return this.getProfile(tenantId, productId);
  }

  async replaceEgaisCodes(
    tenantId: string,
    actorUserId: string,
    productId: string,
    body: EgaisCodesBodyDto,
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
      if (profile.revision !== body.baseRevision)
        throw new ConflictException({ code: "PRODUCT_REGULATORY_REVISION_STALE" });
      const before = await tx
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
      await tx
        .delete(schema.productEgaisCodes)
        .where(
          and(
            eq(schema.productEgaisCodes.tenantId, tenantId),
            eq(schema.productEgaisCodes.productId, productId),
          ),
        );
      if (body.codes.length > 0)
        await tx.insert(schema.productEgaisCodes).values(
          body.codes.map((code) => ({
            tenantId,
            productId,
            code,
            isPrimary: code === body.primaryCode,
            source: "manual" as const,
          })),
        );
      await tx
        .update(schema.products)
        .set({ egaisCode: body.primaryCode })
        .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
      await tx
        .update(schema.productRegulatoryProfiles)
        .set({ revision: profile.revision + 1, updatedAt: new Date() })
        .where(
          and(
            eq(schema.productRegulatoryProfiles.tenantId, tenantId),
            eq(schema.productRegulatoryProfiles.productId, productId),
          ),
        );
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "product.egais_codes.updated",
        outcome: "success",
        targetType: "product",
        targetId: productId,
        before,
        after: body,
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
        entryId: schema.productRegulatoryAttributeValues.id,
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

  private async loadDefinition(schemaVersionId: string) {
    const [row] = await this.db
      .select({ definition: schema.nationalCatalogSchemaVersions.definition })
      .from(schema.nationalCatalogSchemaVersions)
      .where(eq(schema.nationalCatalogSchemaVersions.id, schemaVersionId))
      .limit(1);
    if (!row) throw new NotFoundException("Category schema not found");
    return categorySchemaDefinitionSchema.parse(row.definition);
  }
}

function dispositionCounts(values: Array<{ disposition: string }>) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value.disposition] = (counts[value.disposition] ?? 0) + 1;
    return counts;
  }, {});
}
