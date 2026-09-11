import {
  type EntitlementAdmissionService,
  admissionScopeDigest,
  type AdmissionFacts,
} from "../../subscriptions/entitlement-admission.service";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { isDeepStrictEqual } from "node:util";
import { parseCategorySchemaDefinition, validateProductAttributeValue } from "@markiro/domain";
import type { ApplyRegulatoryProposalDto } from "./dto";
import {
  canonicalProposalSelection,
  parsePersistedProposalDiff,
  type PersistedProposalDiff,
} from "./proposal-schema";
type RegulatoryTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Caller owns the transaction. Always locks product, profile, then proposal. */
export class ProductRegulatoryWriter {
  async applyInTransaction(
    tx: RegulatoryTx,
    tenantId: string,
    actorUserId: string,
    productId: string,
    proposalId: string,
    body: ApplyRegulatoryProposalDto,
    admission?: EntitlementAdmissionService,
    facts?: AdmissionFacts,
  ): Promise<"applied" | "replay" | "stale"> {
    const selection = canonicalProposalSelection(body.acceptedEntryIds);
    const accepted = selection.acceptedEntryIds;
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
        (proposal.appliedSelectionHash === null || proposal.appliedSelectionHash === selection.hash)
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
    if (proposal.source === "national_catalog") {
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

    if (diff.kind === "national_catalog_import")
      await admission?.observe({
        tenantId,
        actor: { domain: "cabinet", id: actorUserId },
        operationId: "nk.apply.v1",
        scopeDigest: admissionScopeDigest({ productId, proposalId, selectionHash: selection.hash }),
        transaction: tx,
        facts,
        // This legacy path has no server-owned release flag; never infer one from the registry.
        runtime: { enabled: null, observedAt: new Date() },
      });
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
        productUpdate.printName = entry.proposedValue === null ? null : String(entry.proposedValue);
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
  }
  async markProposalStale(
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

  async requireCategoryCompatibility(
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

  async loadActiveDefinition(db: Db | RegulatoryTx, schemaVersionId: string) {
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

  async requireProduct(db: Db | RegulatoryTx, tenantId: string, productId: string, lock = false) {
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

  currentValues(db: Db | RegulatoryTx, tenantId: string, productId: string) {
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
