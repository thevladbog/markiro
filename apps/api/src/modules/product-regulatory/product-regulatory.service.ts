import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { isDeepStrictEqual } from "node:util";
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
import {
  canonicalProposalSelection,
  parsePersistedProposalDiff,
  REGULATORY_PROPOSAL_TTL_MS,
  type PersistedProposalDiff,
} from "./proposal-schema";

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
    await this.requireProduct(this.db, tenantId, productId);
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
      await this.requireProduct(tx, tenantId, productId, true);
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
        await this.markProposalStale(tx, {
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

  async applyProposal(
    tenantId: string,
    actorUserId: string,
    productId: string,
    proposalId: string,
    body: ApplyRegulatoryProposalDto,
  ) {
    const selection = canonicalProposalSelection(body.acceptedEntryIds);
    const accepted = selection.acceptedEntryIds;
    const outcome = await this.db.transaction(async (tx) => {
      const product = await this.requireProduct(tx, tenantId, productId, true);
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
      if (proposal.status === "applied") {
        const recorded = proposal.appliedSelection;
        if (
          Array.isArray(recorded) &&
          recorded.every((id): id is string => typeof id === "string") &&
          JSON.stringify(recorded) === JSON.stringify(accepted) &&
          (proposal.appliedSelectionHash === null ||
            proposal.appliedSelectionHash === selection.hash)
        ) {
          return "replay" as const;
        }
        throw new ConflictException({ code: "REGULATORY_PROPOSAL_REPLAY_MISMATCH" });
      }
      if (proposal.status !== "preview") {
        throw new ConflictException({ code: "REGULATORY_PROPOSAL_NOT_APPLICABLE" });
      }
      const now = new Date();
      if (proposal.expiresAt.getTime() <= now.getTime()) {
        await this.markProposalStale(tx, {
          tenantId,
          actorUserId,
          productId,
          proposal,
          now,
          reason: "expired",
        });
        return "stale" as const;
      }
      const diff = parsePersistedProposalDiff(proposal.diff, {
        kind: proposal.kind,
        source: proposal.source,
        snapshotId: proposal.snapshotId,
        sourceRef: proposal.sourceRef,
      });
      const initialBinding = diff.kind === "category_binding";
      if (
        (initialBinding && (proposal.baseRevision !== 0 || profile !== undefined)) ||
        (!initialBinding && (!profile || proposal.baseRevision !== profile.revision))
      ) {
        await this.markProposalStale(tx, {
          tenantId,
          actorUserId,
          productId,
          proposal,
          now,
          reason: "revision_mismatch",
        });
        return "stale" as const;
      }
      const byId = new Map(diff.entries.map((entry) => [entry.entryId, entry]));
      if (accepted.some((id) => !byId.has(id))) {
        throw new BadRequestException({ code: "REGULATORY_PROPOSAL_ENTRY_INVALID" });
      }
      const selected = diff.entries.filter((entry) => accepted.includes(entry.entryId));
      if (new Set(selected.map(operationKey)).size !== selected.length) {
        throw new BadRequestException({ code: "REGULATORY_PROPOSAL_TARGET_DUPLICATE" });
      }
      if (
        selected.some(
          (entry) =>
            entry.target === "attribute" &&
            (entry.disposition === "conflict" || entry.disposition === "inapplicable"),
        )
      ) {
        throw new BadRequestException({ code: "REGULATORY_PROPOSAL_ENTRY_INVALID" });
      }

      const target = diff.kind === "national_catalog_import" ? null : diff.target;
      const operationSchemaVersionId = target?.schemaVersionId ?? profile?.schemaVersionId ?? null;
      let targetDefinition: ReturnType<typeof parseCategorySchemaDefinition> | null = null;
      let sourceObservedAt: Date | null = null;
      if (operationSchemaVersionId !== null) {
        targetDefinition = await this.loadActiveDefinition(tx, operationSchemaVersionId);
        await this.requireCategoryCompatibility(
          tx,
          product.chzProductGroupCode,
          operationSchemaVersionId,
        );
      }
      if (diff.kind === "national_catalog_import") {
        const importSnapshotId = proposal.snapshotId;
        if (importSnapshotId === null) {
          throw new ConflictException({ code: "NATIONAL_CATALOG_SNAPSHOT_INVALID" });
        }
        const [snapshot] = await tx
          .select({
            sourceMethod: schema.nationalCatalogCardSnapshots.sourceMethod,
            payloadFormatVersion: schema.nationalCatalogCardSnapshots.payloadFormatVersion,
            fetchedAt: schema.nationalCatalogCardSnapshots.fetchedAt,
          })
          .from(schema.nationalCatalogCardSnapshots)
          .where(
            and(
              eq(schema.nationalCatalogCardSnapshots.tenantId, tenantId),
              eq(schema.nationalCatalogCardSnapshots.productId, productId),
              eq(schema.nationalCatalogCardSnapshots.id, importSnapshotId),
            ),
          )
          .limit(1);
        if (
          !snapshot ||
          snapshot.sourceMethod === "legacy_unknown" ||
          snapshot.payloadFormatVersion !== 2
        ) {
          throw new ConflictException({ code: "NATIONAL_CATALOG_SNAPSHOT_INVALID" });
        }
        sourceObservedAt = snapshot.fetchedAt;
      }

      const currentValues = await this.currentValues(tx, tenantId, productId);
      const currentByAttribute = new Map(
        currentValues.map((entry) => [entry.attributeId, entry.value]),
      );
      const currentEgais = await tx
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
      let currentMismatch = false;
      const definitions = new Map<string, ReturnType<typeof parseCategorySchemaDefinition>>();
      if (targetDefinition && target) definitions.set(target.schemaVersionId, targetDefinition);

      for (const entry of selected) {
        if (entry.target === "attribute") {
          if (entry.proposedValue === null) {
            throw new BadRequestException({ code: "REGULATORY_PROPOSAL_ENTRY_INVALID" });
          }
          if (
            operationSchemaVersionId === null ||
            entry.targetSchemaVersionId !== operationSchemaVersionId
          ) {
            throw new ConflictException({ code: "REGULATORY_PROPOSAL_MAPPING_DRIFT" });
          }
          let definition = definitions.get(entry.targetSchemaVersionId);
          if (!definition) {
            definition = await this.loadActiveDefinition(tx, entry.targetSchemaVersionId);
            definitions.set(entry.targetSchemaVersionId, definition);
          }
          const attribute = definition.attributes.find(
            (candidate) => candidate.id === entry.targetAttributeId,
          );
          if (!attribute || !validateProductAttributeValue(attribute, entry.proposedValue)) {
            throw new ConflictException({ code: "REGULATORY_PROPOSAL_MAPPING_DRIFT" });
          }
          if (
            !jsonEqual(currentByAttribute.get(entry.targetAttributeId) ?? null, entry.currentValue)
          ) {
            currentMismatch = true;
          }
          continue;
        }
        if (entry.target === "egais_codes") {
          const actual = {
            codes: currentEgais.map((row) => row.code).sort(),
            primaryCode: currentEgais.find((row) => row.isPrimary)?.code ?? null,
          };
          const expected = { ...entry.current, codes: [...entry.current.codes].sort() };
          if (!jsonEqual(actual, expected)) currentMismatch = true;
          continue;
        }
        const [mapping] = await tx
          .select()
          .from(schema.nationalCatalogAttributeMappings)
          .where(eq(schema.nationalCatalogAttributeMappings.id, entry.mappingId))
          .limit(1);
        if (
          !mapping ||
          mapping.targetField !== entry.targetField ||
          mapping.mappingVersion !== entry.mappingVersion ||
          !jsonEqual(mapping.conversion, entry.conversion) ||
          (!profile && diff.kind === "national_catalog_import") ||
          (profile && mapping.schemaVersionId !== profile.schemaVersionId)
        ) {
          throw new ConflictException({ code: "REGULATORY_PROPOSAL_MAPPING_DRIFT" });
        }
        if (!jsonEqual(productStableField(product, entry.targetField), entry.currentValue)) {
          currentMismatch = true;
        }
      }
      if (currentMismatch) {
        await this.markProposalStale(tx, {
          tenantId,
          actorUserId,
          productId,
          proposal,
          now,
          reason: "current_value_changed",
        });
        return "stale" as const;
      }

      if (diff.kind === "category_change") {
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
      }
      const productUpdate: {
        name?: string;
        printName?: string | null;
        shelfLifeDays?: number | null;
        egaisCode?: string | null;
      } = {};
      for (const entry of selected) {
        if (entry.target === "attribute") {
          if (diff.kind !== "category_change") {
            await tx
              .update(schema.productRegulatoryAttributeValues)
              .set({ supersededAt: now })
              .where(
                and(
                  eq(schema.productRegulatoryAttributeValues.tenantId, tenantId),
                  eq(schema.productRegulatoryAttributeValues.productId, productId),
                  eq(schema.productRegulatoryAttributeValues.attributeId, entry.targetAttributeId),
                  isNull(schema.productRegulatoryAttributeValues.supersededAt),
                ),
              );
          }
          if (entry.proposedValue === null) {
            throw new BadRequestException({ code: "REGULATORY_PROPOSAL_ENTRY_INVALID" });
          }
          await tx.insert(schema.productRegulatoryAttributeValues).values({
            tenantId,
            productId,
            schemaVersionId: entry.targetSchemaVersionId,
            attributeId: entry.targetAttributeId,
            value: entry.proposedValue,
            source: proposal.source,
            sourceRef: proposal.sourceRef,
            observedAt: sourceObservedAt,
            appliedBy: actorUserId,
            appliedAt: now,
          });
          continue;
        }
        if (entry.target === "egais_codes") {
          await tx
            .delete(schema.productEgaisCodes)
            .where(
              and(
                eq(schema.productEgaisCodes.tenantId, tenantId),
                eq(schema.productEgaisCodes.productId, productId),
              ),
            );
          if (entry.proposed.codes.length > 0) {
            await tx.insert(schema.productEgaisCodes).values(
              entry.proposed.codes.map((code) => ({
                tenantId,
                productId,
                code,
                isPrimary: code === entry.proposed.primaryCode,
                source: proposal.source,
                sourceRef: proposal.sourceRef,
                observedAt: sourceObservedAt,
                appliedAt: now,
              })),
            );
          }
          productUpdate.egaisCode = entry.proposed.primaryCode;
          continue;
        }
        if (entry.targetField === "name") productUpdate.name = String(entry.proposedValue);
        if (entry.targetField === "print_name") {
          productUpdate.printName =
            entry.proposedValue === null ? null : String(entry.proposedValue);
        }
        if (entry.targetField === "shelf_life_days") {
          productUpdate.shelfLifeDays =
            entry.proposedValue === null ? null : Number(entry.proposedValue);
        }
      }
      if (Object.keys(productUpdate).length > 0) {
        await tx
          .update(schema.products)
          .set(productUpdate)
          .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
      }

      const priorRevision = profile?.revision ?? 0;
      const resultingRevision = priorRevision + 1;
      if (diff.kind === "category_binding") {
        await tx.insert(schema.productRegulatoryProfiles).values({
          tenantId,
          productId,
          revision: resultingRevision,
          categoryId: diff.target.categoryId,
          categoryName: diff.target.categoryName,
          tnVedCode: diff.target.tnVedCode,
          okpd2Code: diff.target.okpd2Code,
          schemaVersionId: diff.target.schemaVersionId,
          source: proposal.source,
          confirmedBy: actorUserId,
          confirmedAt: now,
        });
      } else if (diff.kind === "category_change") {
        await tx
          .update(schema.productRegulatoryProfiles)
          .set({
            revision: resultingRevision,
            schemaVersionId: diff.target.schemaVersionId,
            categoryId: diff.target.categoryId,
            categoryName: diff.target.categoryName,
            tnVedCode: diff.target.tnVedCode,
            okpd2Code: diff.target.okpd2Code,
            source: proposal.source,
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
      } else {
        await tx
          .update(schema.productRegulatoryProfiles)
          .set({ revision: resultingRevision, updatedAt: now })
          .where(
            and(
              eq(schema.productRegulatoryProfiles.tenantId, tenantId),
              eq(schema.productRegulatoryProfiles.productId, productId),
            ),
          );
      }
      if (diff.kind !== "national_catalog_import") {
        await tx.insert(schema.productRegulatoryBindingHistory).values({
          tenantId,
          productId,
          proposalId: proposal.id,
          priorCategoryId: profile?.categoryId ?? null,
          priorSchemaVersionId: profile?.schemaVersionId ?? null,
          nextCategoryId: diff.target.categoryId,
          nextSchemaVersionId: diff.target.schemaVersionId,
          resultingRevision,
          source: proposal.source,
          sourceRef: proposal.sourceRef,
          actorId: actorUserId,
          createdAt: now,
        });
      }
      await tx
        .update(schema.productRegulatoryProposals)
        .set({
          status: "applied",
          appliedSelection: accepted,
          appliedSelectionHash: selection.hash,
          appliedBy: actorUserId,
          appliedAt: now,
        })
        .where(eq(schema.productRegulatoryProposals.id, proposal.id));
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "product.regulatory_proposal.applied",
        outcome: "success",
        targetType: "product",
        targetId: productId,
        before: {
          proposalId: proposal.id,
          priorRevision,
          schemaVersionId: profile?.schemaVersionId ?? null,
          categoryId: profile?.categoryId ?? null,
        },
        after: {
          proposalId: proposal.id,
          proposalKind: proposal.kind,
          source: proposal.source,
          sourceRef: proposal.sourceRef,
          priorRevision,
          resultingRevision,
          selectedEntryIds: accepted,
          selectionHash: selection.hash,
          dispositions: dispositionCounts(selected),
        },
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

  private async previewCategoryTransition(
    tenantId: string,
    actorUserId: string,
    productId: string,
    body: CategoryChangePreviewDto,
    kind: "category_binding" | "category_change",
  ) {
    return this.db.transaction(async (tx) => {
      const product = await this.requireProduct(tx, tenantId, productId, true);
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
      const mapping = await this.requireCategoryCompatibility(
        tx,
        product.chzProductGroupCode,
        target.id,
      );
      if (mapping.state === "ambiguous" && !body.mappingConfirmed) {
        throw new ConflictException({ code: "CATEGORY_GROUP_CONFIRMATION_REQUIRED" });
      }

      const targetDefinition = parseCategorySchemaDefinition(target.definition);
      const targetById = new Map(targetDefinition.attributes.map((item) => [item.id, item]));
      const current = await this.currentValues(tx, tenantId, productId);
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

  private async markProposalStale(
    tx: RegulatoryTx,
    input: {
      tenantId: string;
      actorUserId: string;
      productId: string;
      proposal: typeof schema.productRegulatoryProposals.$inferSelect;
      now: Date;
      reason: "expired" | "revision_mismatch" | "current_value_changed";
    },
  ) {
    await tx
      .update(schema.productRegulatoryProposals)
      .set({ status: "stale", staleAt: input.now, terminalReason: input.reason })
      .where(eq(schema.productRegulatoryProposals.id, input.proposal.id));
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: input.tenantId,
      actorUserId: input.actorUserId,
      action: "product.regulatory_proposal.stale",
      outcome: "failure",
      targetType: "product",
      targetId: input.productId,
      before: { proposalId: input.proposal.id, status: "preview" },
      after: {
        proposalId: input.proposal.id,
        proposalKind: input.proposal.kind,
        source: input.proposal.source,
        sourceRef: input.proposal.sourceRef,
        result: "stale",
        reason: input.reason,
      },
    });
  }

  private async requireCategoryCompatibility(
    db: Db | RegulatoryTx,
    chzProductGroupCode: number | null,
    schemaVersionId: string,
  ) {
    if (chzProductGroupCode === null) {
      throw new ConflictException({ code: "CATEGORY_GROUP_INCOMPATIBLE" });
    }
    const [mapping] = await db
      .select()
      .from(schema.nationalCatalogCategoryGroupMappings)
      .where(
        and(
          eq(schema.nationalCatalogCategoryGroupMappings.chzProductGroupCode, chzProductGroupCode),
          eq(schema.nationalCatalogCategoryGroupMappings.schemaVersionId, schemaVersionId),
        ),
      )
      .limit(1);
    if (!mapping || mapping.state === "unmapped") {
      throw new ConflictException({ code: "CATEGORY_GROUP_INCOMPATIBLE" });
    }
    return mapping;
  }

  private async loadActiveDefinition(db: Db | RegulatoryTx, schemaVersionId: string) {
    const [row] = await db
      .select({ definition: schema.nationalCatalogSchemaVersions.definition })
      .from(schema.nationalCatalogSchemaVersions)
      .where(
        and(
          eq(schema.nationalCatalogSchemaVersions.id, schemaVersionId),
          eq(schema.nationalCatalogSchemaVersions.status, "active"),
        ),
      )
      .limit(1);
    if (!row) throw new ConflictException({ code: "REGULATORY_PROPOSAL_SCHEMA_INACTIVE" });
    return parseCategorySchemaDefinition(row.definition);
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
        archived: schema.products.archived,
        name: schema.products.name,
        printName: schema.products.printName,
        shelfLifeDays: schema.products.shelfLifeDays,
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

function dispositionCounts(values: Array<{ target: string; disposition?: string }>) {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = value.disposition ?? value.target;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

type ProposalEntry = PersistedProposalDiff["entries"][number];

function operationKey(entry: ProposalEntry): string {
  if (entry.target === "attribute") {
    return `attribute:${entry.targetSchemaVersionId}:${entry.targetAttributeId}`;
  }
  if (entry.target === "stable_field") return `stable_field:${entry.targetField}`;
  return "egais_codes";
}

function productStableField(
  product: { name: string; printName: string | null; shelfLifeDays: number | null },
  targetField: "name" | "print_name" | "shelf_life_days",
): string | number | null {
  if (targetField === "name") return product.name;
  if (targetField === "print_name") return product.printName;
  return product.shelfLifeDays;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
