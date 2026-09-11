import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { ProductRegulatoryWriter } from "./product-regulatory-writer";
import {
  parseCategorySchemaDefinition,
  productAttributeValueSchema,
  validateProductAttributeValue,
} from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import type {
  ApplyRegulatoryProposalDto,
  CategoryChangePreviewDto,
  EgaisCodesBodyDto,
  UpdateRegulatoryAttributesDto,
} from "./dto";
import { parsePersistedProposalDiff, REGULATORY_PROPOSAL_TTL_MS } from "./proposal-schema";

type RegulatoryTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class ProductRegulatoryService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getProfile(tenantId: string, productId: string) {
    await this.writer.requireProduct(this.db, tenantId, productId);
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
    const definition = binding ? await this.pinnedDefinition(binding.schemaVersionId) : null;
    const values = await this.writer.currentValues(this.db, tenantId, productId);
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
      definition,
      values,
      egaisCodes,
      pendingProposalCount: pending?.value ?? 0,
    };
  }

  private async pinnedDefinition(schemaVersionId: string) {
    const [row] = await this.db
      .select({ definition: schema.nationalCatalogSchemaVersions.definition })
      .from(schema.nationalCatalogSchemaVersions)
      .where(eq(schema.nationalCatalogSchemaVersions.id, schemaVersionId))
      .limit(1);
    if (!row) throw new NotFoundException("Pinned category schema not found");
    return parseCategorySchemaDefinition(row.definition);
  }

  async getCategoryOptions(tenantId: string, productId: string) {
    const product = await this.writer.requireProduct(this.db, tenantId, productId);
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
      await this.writer.requireProduct(tx, tenantId, productId, true);
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
      const definition = parseCategorySchemaDefinition(schemaVersion.definition);
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
          if (!parsed.success || !validateProductAttributeValue(attribute, parsed.data)) {
            this.invalidAttribute(item.attributeId);
          }
        }
      }

      const current = await this.writer.currentValues(tx, tenantId, productId);
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
    return this.previewCategoryTransition(
      tenantId,
      actorUserId,
      productId,
      body,
      "category_change",
    );
  }

  async previewCategoryBinding(
    tenantId: string,
    actorUserId: string,
    productId: string,
    body: CategoryChangePreviewDto,
  ) {
    return this.previewCategoryTransition(
      tenantId,
      actorUserId,
      productId,
      body,
      "category_binding",
    );
  }

  async getProposal(tenantId: string, productId: string, proposalId: string) {
    await this.writer.requireProduct(this.db, tenantId, productId);
    const [proposal] = await this.db
      .select()
      .from(schema.productRegulatoryProposals)
      .where(
        and(
          eq(schema.productRegulatoryProposals.tenantId, tenantId),
          eq(schema.productRegulatoryProposals.productId, productId),
          eq(schema.productRegulatoryProposals.id, proposalId),
        ),
      )
      .limit(1);
    if (!proposal) throw new NotFoundException();
    return this.proposalView(proposal);
  }

  async rejectProposal(
    tenantId: string,
    actorUserId: string,
    productId: string,
    proposalId: string,
  ) {
    const outcome = await this.db.transaction(async (tx) => {
      await this.writer.requireProduct(tx, tenantId, productId, true);
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
      if (!proposal) throw new NotFoundException();
      this.proposalView(proposal);
      if (proposal.status === "rejected") return "rejected" as const;
      if (proposal.status !== "preview") {
        throw new ConflictException({ code: "REGULATORY_PROPOSAL_NOT_REJECTABLE" });
      }
      const now = new Date();
      if (proposal.expiresAt.getTime() <= now.getTime()) {
        await this.writer.markProposalStale(tx, {
          tenantId,
          actorUserId,
          productId,
          proposal,
          now,
          reason: "expired",
        });
        return "stale" as const;
      }
      await tx
        .update(schema.productRegulatoryProposals)
        .set({
          status: "rejected",
          rejectedBy: actorUserId,
          rejectedAt: now,
          terminalReason: "user_rejected",
        })
        .where(eq(schema.productRegulatoryProposals.id, proposal.id));
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "product.regulatory_proposal.rejected",
        outcome: "success",
        targetType: "product",
        targetId: productId,
        before: { proposalId, status: "preview" },
        after: {
          proposalId,
          proposalKind: proposal.kind,
          source: proposal.source,
          sourceRef: proposal.sourceRef,
          status: "rejected",
        },
      });
      return "rejected" as const;
    });
    if (outcome === "stale") {
      throw new ConflictException({ code: "REGULATORY_PROPOSAL_EXPIRED" });
    }
    return this.getProposal(tenantId, productId, proposalId);
  }

  private readonly writer = new ProductRegulatoryWriter();
  async applyProposal(
    tenantId: string,
    actorUserId: string,
    productId: string,
    proposalId: string,
    body: ApplyRegulatoryProposalDto,
  ) {
    const outcome = await this.db.transaction((tx) =>
      this.writer.applyInTransaction(tx, tenantId, actorUserId, productId, proposalId, body),
    );
    if (outcome === "stale")
      throw new ConflictException({ code: "PRODUCT_REGULATORY_REVISION_STALE" });
    return this.getProfile(tenantId, productId);
  }

  async replaceEgaisCodes(
    tenantId: string,
    actorUserId: string,
    productId: string,
    body: EgaisCodesBodyDto,
  ) {
    await this.db.transaction(async (tx) => {
      await this.writer.requireProduct(tx, tenantId, productId, true);
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

  private async previewCategoryTransition(
    tenantId: string,
    actorUserId: string,
    productId: string,
    body: CategoryChangePreviewDto,
    kind: "category_binding" | "category_change",
  ) {
    return this.db.transaction(async (tx) => {
      const product = await this.writer.requireProduct(tx, tenantId, productId, true);
      if (product.archived) {
        throw new ConflictException({ code: "PRODUCT_ARCHIVED" });
      }
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
      if (kind === "category_binding") {
        if (body.baseRevision !== 0 || profile) {
          throw new ConflictException({ code: "PRODUCT_REGULATORY_INITIAL_BINDING_CONFLICT" });
        }
      } else {
        if (!profile) throw new NotFoundException("Regulatory profile not found");
        if (body.baseRevision === 0 || profile.revision !== body.baseRevision) {
          throw new ConflictException({ code: "PRODUCT_REGULATORY_REVISION_STALE" });
        }
      }

      const [target] = await tx
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
      const mapping = await this.writer.requireCategoryCompatibility(
        tx,
        product.chzProductGroupCode,
        target.id,
      );
      if (mapping.state === "ambiguous" && !body.mappingConfirmed) {
        throw new ConflictException({ code: "CATEGORY_GROUP_CONFIRMATION_REQUIRED" });
      }

      const targetDefinition = parseCategorySchemaDefinition(target.definition);
      const targetById = new Map(targetDefinition.attributes.map((item) => [item.id, item]));
      const current = await this.writer.currentValues(tx, tenantId, productId);
      const sourceDefinition = profile
        ? await this.loadDefinition(tx, profile.schemaVersionId)
        : null;
      const sourceById = new Map(sourceDefinition?.attributes.map((item) => [item.id, item]) ?? []);
      const entries = current.map((entry) => {
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
          target: "attribute" as const,
          targetSchemaVersionId: target.id,
          targetAttributeId: entry.attributeId,
          disposition,
          currentValue: entry.value,
          proposedValue: disposition === "transferable" ? entry.value : null,
        };
      });
      const diff = parsePersistedProposalDiff(
        {
          version: 1,
          kind,
          target: {
            schemaVersionId: target.id,
            categoryId: target.categoryId,
            categoryName: target.categoryName,
            tnVedCode: body.tnVedCode,
            okpd2Code: body.okpd2Code,
          },
          entries,
        },
        { kind, source: "manual", snapshotId: null, sourceRef: null },
      );
      const now = new Date();
      const [proposal] = await tx
        .insert(schema.productRegulatoryProposals)
        .values({
          tenantId,
          productId,
          kind,
          source: "manual",
          baseRevision: body.baseRevision,
          diff,
          createdBy: actorUserId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + REGULATORY_PROPOSAL_TTL_MS),
        })
        .returning({ id: schema.productRegulatoryProposals.id });
      if (!proposal) throw new ConflictException("Failed to persist category preview");
      return { proposalId: proposal.id, baseRevision: body.baseRevision, diff };
    });
  }

  private proposalView(proposal: typeof schema.productRegulatoryProposals.$inferSelect) {
    const diff = parsePersistedProposalDiff(proposal.diff, {
      kind: proposal.kind,
      source: proposal.source,
      snapshotId: proposal.snapshotId,
      sourceRef: proposal.sourceRef,
    });
    return {
      id: proposal.id,
      kind: proposal.kind,
      source: proposal.source,
      sourceRef: proposal.sourceRef,
      snapshotId: proposal.snapshotId,
      baseRevision: proposal.baseRevision,
      diff,
      status: proposal.status,
      expiresAt: proposal.expiresAt,
      terminalReason: proposal.terminalReason,
      createdAt: proposal.createdAt,
      appliedAt: proposal.appliedAt,
      rejectedAt: proposal.rejectedAt,
      staleAt: proposal.staleAt,
    };
  }

  private invalidAttribute(attributeId: string): never {
    throw new BadRequestException({ code: "PRODUCT_ATTRIBUTE_INVALID", attributeId });
  }

  private async loadDefinition(db: Db | RegulatoryTx, schemaVersionId: string) {
    const [row] = await db
      .select({ definition: schema.nationalCatalogSchemaVersions.definition })
      .from(schema.nationalCatalogSchemaVersions)
      .where(eq(schema.nationalCatalogSchemaVersions.id, schemaVersionId))
      .limit(1);
    if (!row) throw new NotFoundException("Category schema not found");
    return parseCategorySchemaDefinition(row.definition);
  }
}
