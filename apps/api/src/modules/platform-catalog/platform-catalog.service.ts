import { assertCatalogCommercialCompatibility } from "../../platform-http/commercial-catalog-compatibility";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  platformCatalogV3Contracts as platformCatalogContracts,
  catalogVersionCreateV3Schema,
  catalogVersionPatchV3Schema,
  catalogVersionPatchV2Schema,
  planEntitlementsReadV3Schema,
  type CatalogVersionCreateV2,
  type CatalogVersionPatchV2,
  type CatalogPublicationReviewV3,
  type CommercialReviewIdentityV3,
  type PlanEntitlementsReadV3,
  catalogVersionCreateV2Schema,
  type CommercialReviewIdentity,
  type CatalogPublicationReview,
  type AddonEffectV3 as AddonEffect,
  type ArchiveCatalogItemResponse,
  type CatalogVersionV3 as CatalogVersion,
  type CatalogVersionCreateV3 as CatalogVersionCreate,
  type CatalogVersionPatchV3 as CatalogVersionPatch,
  type DefaultDemoPlanResponse,
  type PlanEntitlements,
  type SetDefaultDemoPlan,
} from "@markiro/platform-contracts";
import { commercialTaxDefaults, isCommercialTaxAllowed } from "@markiro/domain";
import { lockSellerPolicy, readSellerPolicy } from "../billing-profiles/billing-profiles.service";
import {
  projectCommercialResponse,
  type CommercialVersion,
} from "../../platform-http/commercial-version";
import { entitlementDigest } from "../../subscriptions/entitlement-snapshot-reader";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";

type CatalogVersionListResponse = { items: CatalogVersion[] };
type CatalogItemRow = typeof schema.catalogItems.$inferSelect;
type CatalogVersionRow = typeof schema.catalogItemVersions.$inferSelect;
type CatalogItemKind = CatalogItemRow["kind"];
type CatalogTransaction = Parameters<Db["transaction"]>[0] extends (arg: infer T) => unknown
  ? T
  : never;

@Injectable()
export class PlatformCatalogService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
  ) {}

  async list(principal: PlatformPrincipal): Promise<CatalogVersionListResponse> {
    const rows = await this.db
      .select({ item: schema.catalogItems, version: schema.catalogItemVersions })
      .from(schema.catalogItems)
      .leftJoin(
        schema.catalogItemVersions,
        eq(schema.catalogItemVersions.catalogItemId, schema.catalogItems.id),
      )
      .orderBy(schema.catalogItems.code, desc(schema.catalogItemVersions.version));
    const items: CatalogVersion[] = [];
    for (const row of rows) {
      if (!row.version) continue;
      items.push(await this.toDto(row.item, row.version, principal.role !== "support"));
    }
    return { items };
  }

  async listVersions(
    principal: PlatformPrincipal,
    itemRef: string,
  ): Promise<CatalogVersionListResponse> {
    const item = await this.findItem(itemRef);
    if (!item) throw new NotFoundException({ code: "catalog_item_not_found" });
    const versions = await this.db
      .select()
      .from(schema.catalogItemVersions)
      .where(eq(schema.catalogItemVersions.catalogItemId, item.id))
      .orderBy(desc(schema.catalogItemVersions.version));
    return {
      items: await Promise.all(
        versions.map((version) => this.toDto(item, version, principal.role !== "support")),
      ),
    };
  }

  async getVersion(
    principal: PlatformPrincipal,
    itemRef: string,
    versionId: string,
  ): Promise<CatalogVersion> {
    const found = await this.findVersion(itemRef, versionId);
    if (!found) throw new NotFoundException({ code: "catalog_version_not_found" });
    return this.toDto(found.item, found.version, principal.role !== "support");
  }

  async createVersion(
    principal: PlatformPrincipal,
    itemRef: string,
    input: CatalogVersionCreate | CatalogVersionCreateV2,
    clientVersion: CommercialVersion | boolean = 2,
  ): Promise<CatalogVersion> {
    const versionNumber = normalizeVersion(clientVersion);
    projectCommercialResponse(versionNumber, input);
    input =
      versionNumber === 3
        ? catalogVersionCreateV3Schema.parse(input)
        : catalogVersionCreateV2Schema.parse(input);
    const kind = kindForInput(input);
    try {
      return await this.db.transaction(async (tx) => {
        let item = await this.findItem(itemRef, tx);
        if (!item) {
          const [created] = await tx
            .insert(schema.catalogItems)
            .values({
              code: itemRef,
              nameRu: input.nameRu,
              nameEn: input.nameEn,
              kind,
            })
            .returning();
          if (!created) throw new ConflictException({ code: "catalog_item_create_failed" });
          item = created;
        }
        item = await this.lockItem(tx, item.id);
        if (item.status === "archived")
          throw new ConflictException({ code: "catalog_item_archived" });
        if (item.kind !== kind) throw new ConflictException({ code: "catalog_item_kind_mismatch" });

        const [last] = await tx
          .select({ version: schema.catalogItemVersions.version })
          .from(schema.catalogItemVersions)
          .where(eq(schema.catalogItemVersions.catalogItemId, item.id))
          .orderBy(desc(schema.catalogItemVersions.version))
          .limit(1);
        const [version] = await tx
          .insert(schema.catalogItemVersions)
          .values({
            catalogItemId: item.id,
            kind,
            version: (last?.version ?? 0) + 1,
            nameRu: input.nameRu,
            nameEn: input.nameEn,
            descriptionRu: input.descriptionRu ?? null,
            descriptionEn: input.descriptionEn ?? null,
            documentNameRu: input.documentNameRu ?? null,
            documentNameEn: input.documentNameEn ?? null,
            subject: input.subject ?? null,
            sellerPolicyRevision: input.sellerPolicyRevision ?? null,
            lifecyclePolicyId: "lifecyclePolicyId" in input ? input.lifecyclePolicyId : null,
            unit: input.billingMode === "recurring" ? input.billingPeriod : input.unit,
            billingMode: input.billingMode,
            billingPeriod: input.billingPeriod ?? null,
            unitPrice: input.unitPrice,
            vatRate: toVatRate(input.vatRateBps),
            vatIncluded: input.vatIncluded,
          })
          .returning();
        if (!version) throw new ConflictException({ code: "catalog_version_create_failed" });
        await this.insertEffects(tx, version.id, kind, input);
        return this.toDto(item, version, true, tx);
      });
    } catch (error) {
      catalogDatabaseError(error);
    }
  }

  async updateVersion(
    principal: PlatformPrincipal,
    itemRef: string,
    versionId: string,
    input: CatalogVersionPatch | CatalogVersionPatchV2,
    clientVersion: CommercialVersion | boolean = 2,
  ): Promise<CatalogVersion> {
    const versionNumber = normalizeVersion(clientVersion);
    projectCommercialResponse(versionNumber, input);
    input =
      versionNumber === 3
        ? catalogVersionPatchV3Schema.parse(input)
        : catalogVersionPatchV2Schema.parse(input);
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockVersion(tx, versionId);
        const found = await this.findVersion(itemRef, versionId, tx);
        if (!found) throw new NotFoundException({ code: "catalog_version_not_found" });
        if (found.version.status !== "draft") {
          throw new ConflictException({ code: "catalog_version_immutable" });
        }
        const currentDto = await this.toDto(found.item, found.version, true, tx);
        projectCommercialResponse(versionNumber, currentDto);
        const representable = projectCommercialResponse(
          versionNumber === 1 ? 2 : versionNumber,
          currentDto,
        );
        if (!representable || typeof representable !== "object") throw new BadRequestException();
        validateEffectForKind(found.item.kind, input);
        const merged = { ...representable, ...input };
        const responseFields = new Set([
          "id",
          "catalogItemId",
          "catalogItemCode",
          "version",
          "status",
          "publishedAt",
          "publishedByPlatformUserId",
          "kind",
        ]);
        const candidate = Object.fromEntries(
          Object.entries(merged).filter(([key]) => !responseFields.has(key)),
        );
        // A V3 edit of a legacy draft preserves unknown mapping until explicit plan values are supplied.
        const parsed =
          versionNumber === 3 &&
          currentDto.kind === "plan" &&
          input.plan === undefined &&
          [
            currentDto.plan.chzIntegrationEnabled,
            currentDto.plan.inventoryEnabled,
            currentDto.plan.commerceMlEnabled,
            currentDto.plan.handheldEnabled,
          ].some((flag) => flag === null)
            ? catalogVersionCreateV3Schema.options[0]
                .extend({ plan: planEntitlementsReadV3Schema })
                .strict()
                .safeParse(candidate)
            : (versionNumber === 3
                ? catalogVersionCreateV3Schema
                : catalogVersionCreateV2Schema
              ).safeParse(candidate);
        if (!parsed.success) throw new BadRequestException({ code: "catalog_version_invalid" });
        const changes: Record<string, unknown> = {
          updatedAt: sql`greatest(clock_timestamp(), date_trunc('milliseconds', updated_at) + interval '1 millisecond')`,
        };
        copyDefined(changes, input, [
          "documentNameRu",
          "documentNameEn",
          "subject",
          "sellerPolicyRevision",
          "lifecyclePolicyId",
          "nameRu",
          "nameEn",
          "descriptionRu",
          "descriptionEn",
          "unit",
          "billingMode",
          "billingPeriod",
          "unitPrice",
          "vatIncluded",
        ]);
        if (found.item.kind !== "service") changes.unit = parsed.data.billingPeriod;
        if (input.vatRateBps !== undefined) changes.vatRate = toVatRate(input.vatRateBps);
        const [version] = await tx
          .update(schema.catalogItemVersions)
          .set(changes)
          .where(eq(schema.catalogItemVersions.id, versionId))
          .returning();
        if (!version) throw new NotFoundException({ code: "catalog_version_not_found" });
        if (input.plan !== undefined || input.addon !== undefined || input.service !== undefined) {
          await this.replaceEffects(tx, version.id, found.item.kind, input);
        }
        return this.toDto(found.item, version, true, tx);
      });
    } catch (error) {
      catalogDatabaseError(error);
    }
  }

  async publish(
    principal: PlatformPrincipal,
    itemRef: string,
    versionId: string,
    identity?: CommercialReviewIdentity | CommercialReviewIdentityV3,
    clientVersion: CommercialVersion = 2,
  ): Promise<CatalogVersion> {
    if (!identity) throw new ConflictException({ code: "client_update_required" });
    try {
      return await this.db.transaction(async (tx) => {
        await lockSellerPolicy(tx);
        const item = await this.findItem(itemRef, tx);
        if (!item) throw new NotFoundException({ code: "catalog_item_not_found" });
        await this.lockItem(tx, item.id);
        await this.lockVersion(tx, versionId);
        const found = await this.findVersion(itemRef, versionId, tx);
        if (!found) throw new NotFoundException({ code: "catalog_version_not_found" });
        if (found.item.status === "archived")
          throw new ConflictException({ code: "catalog_item_archived" });
        if (found.version.status !== "draft") {
          throw new ConflictException({ code: "catalog_version_immutable" });
        }
        projectCommercialResponse(
          clientVersion,
          await this.toDto(found.item, found.version, true, tx),
        );
        const review = await this.publicationReview(tx, found.item, found.version, clientVersion);
        if (
          identity.catalogVersionId !== review.identity.catalogVersionId ||
          identity.draftUpdatedAt !== review.identity.draftUpdatedAt ||
          identity.sellerPolicyRevision !== review.identity.sellerPolicyRevision ||
          (clientVersion === 3 &&
            (!("lifecyclePolicyId" in identity) ||
              !("lifecyclePolicyId" in review.identity) ||
              identity.lifecyclePolicyId !== review.identity.lifecyclePolicyId ||
              identity.lifecyclePolicyVersion !== review.identity.lifecyclePolicyVersion ||
              identity.lifecyclePolicyHash !== review.identity.lifecyclePolicyHash))
        )
          throw new ConflictException({ code: "commercial_review_stale" });
        if (review.errors.length)
          throw new BadRequestException({ code: "commercial_review_invalid" });
        await this.assertCompleteEffects(tx, found.version);
        const [version] = await tx
          .update(schema.catalogItemVersions)
          .set({
            sellerPolicyRevision: review.identity.sellerPolicyRevision,
            status: "published",
            publishedAt: sql`now()`,
            publishedByPlatformUserId: principal.userId,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.catalogItemVersions.id, versionId),
              eq(schema.catalogItemVersions.status, "draft"),
            ),
          )
          .returning();
        if (!version) throw new ConflictException({ code: "catalog_version_immutable" });
        await this.audit.record(tx, {
          actorPlatformUserId: principal.userId,
          actorRole: principal.role,
          action: "catalog.version.published",
          outcome: "success",
          tenantId: null,
          targetType: "catalog_version",
          targetId: version.id,
          reason: null,
          before: { status: "draft" },
          after: { status: "published", catalogItemId: found.item.id, version: version.version },
          requestId: null,
        });
        return this.toDto(found.item, version, true, tx);
      });
    } catch (error) {
      catalogDatabaseError(error);
    }
  }

  async retire(
    principal: PlatformPrincipal,
    itemRef: string,
    versionId: string,
    clientVersion: CommercialVersion | boolean = 2,
  ): Promise<CatalogVersion> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockVersion(tx, versionId);
        const found = await this.findVersion(itemRef, versionId, tx);
        if (!found) throw new NotFoundException({ code: "catalog_version_not_found" });
        projectCommercialResponse(
          normalizeVersion(clientVersion),
          await this.toDto(found.item, found.version, true, tx),
        );
        if (found.version.status !== "published") {
          throw new ConflictException({ code: "catalog_version_not_published" });
        }
        const defaultDemo = await this.lockDefaultDemoSetting(tx);
        if (defaultDemo?.catalogVersionId === versionId) {
          throw new ConflictException({ code: "catalog_default_demo_in_use" });
        }
        const [version] = await tx
          .update(schema.catalogItemVersions)
          .set({ status: "retired", updatedAt: sql`now()` })
          .where(eq(schema.catalogItemVersions.id, versionId))
          .returning();
        if (!version) throw new ConflictException({ code: "catalog_version_not_published" });
        await this.audit.record(tx, {
          actorPlatformUserId: principal.userId,
          actorRole: principal.role,
          action: "catalog.version.retired",
          outcome: "success",
          tenantId: null,
          targetType: "catalog_version",
          targetId: version.id,
          reason: null,
          before: { status: "published" },
          after: { status: "retired" },
          requestId: null,
        });
        return this.toDto(found.item, version, true, tx);
      });
    } catch (error) {
      catalogDatabaseError(error);
    }
  }

  async archive(
    principal: PlatformPrincipal,
    itemRef: string,
  ): Promise<ArchiveCatalogItemResponse> {
    try {
      return await this.db.transaction(async (tx) => {
        const item = await this.findItem(itemRef, tx);
        if (!item) throw new NotFoundException({ code: "catalog_item_not_found" });
        const lockedItem = await this.lockItem(tx, item.id);
        const nonRetired = await tx
          .select({ id: schema.catalogItemVersions.id })
          .from(schema.catalogItemVersions)
          .where(
            and(
              eq(schema.catalogItemVersions.catalogItemId, lockedItem.id),
              or(
                eq(schema.catalogItemVersions.status, "draft"),
                eq(schema.catalogItemVersions.status, "published"),
              ),
            ),
          )
          .limit(1);
        if (nonRetired.length > 0) {
          throw new ConflictException({ code: "catalog_item_versions_not_retired" });
        }
        await tx
          .update(schema.catalogItems)
          .set({ status: "archived", updatedAt: sql`now()` })
          .where(eq(schema.catalogItems.id, lockedItem.id));
        await this.audit.record(tx, {
          actorPlatformUserId: principal.userId,
          actorRole: principal.role,
          action: "catalog.item.archived",
          outcome: "success",
          tenantId: null,
          targetType: "catalog_item",
          targetId: lockedItem.id,
          reason: null,
          before: { status: lockedItem.status },
          after: { status: "archived" },
          requestId: null,
        });
        return { status: "archived" };
      });
    } catch (error) {
      catalogDatabaseError(error);
    }
  }

  async getDefaultDemo(_principal: PlatformPrincipal): Promise<DefaultDemoPlanResponse> {
    const [setting] = await this.db
      .select({ catalogVersionId: schema.platformSettings.defaultDemoCatalogVersionId })
      .from(schema.platformSettings)
      .where(eq(schema.platformSettings.key, "default"));
    return { catalogVersionId: setting?.catalogVersionId ?? null };
  }

  async setDefaultDemo(
    principal: PlatformPrincipal,
    input: SetDefaultDemoPlan,
    clientVersion: CommercialVersion = 2,
  ): Promise<SetDefaultDemoPlan> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockVersion(tx, input.catalogVersionId);
        await assertCatalogCommercialCompatibility(tx, input.catalogVersionId, clientVersion);
        const before = await this.lockDefaultDemoSetting(tx);
        const [candidate] = await tx
          .select({
            id: schema.catalogItemVersions.id,
            kind: schema.catalogItemVersions.kind,
            status: schema.catalogItemVersions.status,
            demoDurationDays: schema.planEntitlements.demoDurationDays,
          })
          .from(schema.catalogItemVersions)
          .leftJoin(
            schema.planEntitlements,
            eq(schema.planEntitlements.catalogVersionId, schema.catalogItemVersions.id),
          )
          .where(eq(schema.catalogItemVersions.id, input.catalogVersionId));
        if (
          !candidate ||
          candidate.kind !== "plan" ||
          candidate.status !== "published" ||
          candidate.demoDurationDays === null ||
          candidate.demoDurationDays <= 0
        ) {
          throw new ConflictException({ code: "default_demo_version_invalid" });
        }
        await tx
          .insert(schema.platformSettings)
          .values({
            key: "default",
            defaultDemoCatalogVersionId: candidate.id,
            updatedByPlatformUserId: principal.userId,
          })
          .onConflictDoUpdate({
            target: schema.platformSettings.key,
            set: {
              defaultDemoCatalogVersionId: candidate.id,
              updatedByPlatformUserId: principal.userId,
              updatedAt: sql`now()`,
            },
          });
        await this.audit.record(tx, {
          actorPlatformUserId: principal.userId,
          actorRole: principal.role,
          action: "catalog.default_demo.changed",
          outcome: "success",
          tenantId: null,
          targetType: "platform_setting",
          targetId: "default_demo_plan",
          reason: null,
          before: { catalogVersionId: before?.catalogVersionId ?? null },
          after: { catalogVersionId: candidate.id },
          requestId: null,
        });
        return { catalogVersionId: candidate.id };
      });
    } catch (error) {
      catalogDatabaseError(error);
    }
  }

  async editorContext(principal: PlatformPrincipal, clientVersion: CommercialVersion = 2) {
    const policies =
      clientVersion === 3
        ? await this.db
            .select()
            .from(schema.entitlementLifecyclePolicies)
            .where(eq(schema.entitlementLifecyclePolicies.status, "approved"))
        : [];
    const seller = await readSellerPolicy(this.db);
    return {
      sellerPolicyRevision: seller.revision,
      taxPolicy: seller.taxPolicy,
      taxDefaults: seller.taxPolicy ? commercialTaxDefaults(seller.taxPolicy) : null,
      canWrite: principal.capabilities.includes("catalog.write"),
      ...(clientVersion === 3
        ? {
            lifecyclePolicies: policies
              .filter((policy) => policy.payloadHash === entitlementDigest(policy.payload))
              .map(({ id, policyKey, version }) => ({ id, policyKey, version })),
          }
        : {}),
    };
  }

  async review(
    _principal: PlatformPrincipal,
    itemRef: string,
    versionId: string,
    clientVersion: CommercialVersion = 2,
  ): Promise<CatalogPublicationReview | CatalogPublicationReviewV3> {
    return this.db.transaction(async (tx) => {
      await lockSellerPolicy(tx);
      const item = await this.findItem(itemRef, tx);
      if (!item) throw new NotFoundException({ code: "catalog_item_not_found" });
      await this.lockItem(tx, item.id);
      await this.lockVersion(tx, versionId);
      const found = await this.findVersion(itemRef, versionId, tx);
      if (!found) throw new NotFoundException({ code: "catalog_version_not_found" });
      if (found.version.status !== "draft")
        throw new ConflictException({ code: "catalog_version_immutable" });
      projectCommercialResponse(
        clientVersion,
        await this.toDto(found.item, found.version, true, tx),
      );
      return this.publicationReview(tx, found.item, found.version, clientVersion);
    });
  }

  private async publicationReview(
    tx: CatalogTransaction,
    item: CatalogItemRow,
    version: CatalogVersionRow,
    clientVersion: CommercialVersion,
  ): Promise<CatalogPublicationReview | CatalogPublicationReviewV3> {
    const seller = await readSellerPolicy(tx);
    const errors: CatalogPublicationReview["errors"] = [];
    if (!seller.taxPolicy)
      errors.push({ code: "seller_tax_policy_unconfigured", path: "sellerPolicyRevision" });
    if (!version.documentNameRu?.trim())
      errors.push({ code: "document_name_required", path: "documentNameRu" });
    if (!version.subject) errors.push({ code: "commercial_subject_required", path: "subject" });
    if (
      seller.taxPolicy &&
      !isCommercialTaxAllowed(seller.taxPolicy, {
        vatRateBps: version.vatRate === null ? null : Math.round(Number(version.vatRate) * 100),
        vatIncluded: version.vatIncluded,
      })
    )
      errors.push({ code: "seller_tax_policy_violation", path: "vatRateBps" });
    // Strict DTO validation also rejects unknown effects and inconsistent stored kind/period.
    const dto = await this.toDto(item, version, true, tx);
    let lifecyclePolicyVersion: number | null = null;
    let lifecyclePolicyHash: string | null = null;
    if (clientVersion === 3) {
      if (
        dto.kind === "plan" &&
        [
          dto.plan.chzIntegrationEnabled,
          dto.plan.inventoryEnabled,
          dto.plan.commerceMlEnabled,
          dto.plan.handheldEnabled,
        ].some((flag) => flag === null)
      )
        errors.push({ code: "plan_mapping_required", path: "plan" });
      if (!version.lifecyclePolicyId)
        errors.push({ code: "lifecycle_policy_required", path: "lifecyclePolicyId" });
      else {
        const [policy] = await tx
          .select()
          .from(schema.entitlementLifecyclePolicies)
          .where(eq(schema.entitlementLifecyclePolicies.id, version.lifecyclePolicyId))
          .for("share");
        if (policy) {
          lifecyclePolicyVersion = policy.version;
          lifecyclePolicyHash = policy.payloadHash;
        }
        if (
          !policy ||
          policy.status !== "approved" ||
          policy.payloadHash !== entitlementDigest(policy.payload)
        )
          errors.push({ code: "lifecycle_policy_not_approved", path: "lifecyclePolicyId" });
      }
    }
    return {
      identity: {
        catalogVersionId: version.id,
        draftUpdatedAt: version.updatedAt.toISOString(),
        sellerPolicyRevision: seller.revision,
        ...(clientVersion === 3
          ? {
              lifecyclePolicyId: version.lifecyclePolicyId,
              lifecyclePolicyVersion,
              lifecyclePolicyHash,
            }
          : {}),
      },
      errors,
    };
  }

  private async findItem(
    itemRef: string,
    db: Pick<Db, "select"> = this.db,
  ): Promise<CatalogItemRow | undefined> {
    const reference = isUuid(itemRef)
      ? or(eq(schema.catalogItems.id, itemRef), eq(schema.catalogItems.code, itemRef))
      : eq(schema.catalogItems.code, itemRef);
    const [item] = await db.select().from(schema.catalogItems).where(reference).limit(1);
    return item;
  }

  private async findVersion(
    itemRef: string,
    versionId: string,
    db: Pick<Db, "select"> = this.db,
  ): Promise<{ item: CatalogItemRow; version: CatalogVersionRow } | undefined> {
    const itemReference = isUuid(itemRef)
      ? or(eq(schema.catalogItems.id, itemRef), eq(schema.catalogItems.code, itemRef))
      : eq(schema.catalogItems.code, itemRef);
    const [found] = await db
      .select({ item: schema.catalogItems, version: schema.catalogItemVersions })
      .from(schema.catalogItemVersions)
      .innerJoin(
        schema.catalogItems,
        eq(schema.catalogItems.id, schema.catalogItemVersions.catalogItemId),
      )
      .where(and(eq(schema.catalogItemVersions.id, versionId), itemReference))
      .limit(1);
    return found;
  }

  private async lockItem(tx: CatalogTransaction, itemId: string): Promise<CatalogItemRow> {
    await tx.execute(sql`select id from catalog_items where id = ${itemId} for update`);
    const [item] = await tx
      .select()
      .from(schema.catalogItems)
      .where(eq(schema.catalogItems.id, itemId));
    if (!item) throw new NotFoundException({ code: "catalog_item_not_found" });
    return item;
  }

  private async lockVersion(tx: CatalogTransaction, versionId: string): Promise<void> {
    await tx.execute(sql`select id from catalog_item_versions where id = ${versionId} for update`);
  }

  private async lockDefaultDemoSetting(
    tx: CatalogTransaction,
  ): Promise<{ catalogVersionId: string } | undefined> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('platform-default-demo-setting', 0))`,
    );
    await tx.execute(sql`select key from platform_settings where key = 'default' for update`);
    const [setting] = await tx
      .select({ catalogVersionId: schema.platformSettings.defaultDemoCatalogVersionId })
      .from(schema.platformSettings)
      .where(eq(schema.platformSettings.key, "default"));
    return setting;
  }

  private async insertEffects(
    tx: CatalogTransaction,
    versionId: string,
    kind: CatalogItemKind,
    input: CatalogVersionCreate | CatalogVersionCreateV2,
  ): Promise<void> {
    if (kind === "plan" && "plan" in input) {
      await tx
        .insert(schema.planEntitlements)
        .values({ catalogVersionId: versionId, ...toPlanValues(input.plan) });
    } else if (kind === "addon" && "addon" in input) {
      await tx.insert(schema.addonEntitlements).values(
        input.addon.effects.map((effect) =>
          "quotaIncrement" in effect
            ? {
                catalogVersionId: versionId,
                entitlementKey: effect.key,
                quotaIncrement: effect.quotaIncrement,
              }
            : { catalogVersionId: versionId, entitlementKey: effect.key, featureEnabled: true },
        ),
      );
    }
  }

  private async replaceEffects(
    tx: CatalogTransaction,
    versionId: string,
    kind: CatalogItemKind,
    input: CatalogVersionPatch | CatalogVersionPatchV2,
  ): Promise<void> {
    if (kind === "plan" && input.plan !== undefined) {
      await tx
        .update(schema.planEntitlements)
        .set(toPlanValues(input.plan))
        .where(eq(schema.planEntitlements.catalogVersionId, versionId));
    }
    if (kind === "addon" && input.addon !== undefined) {
      await tx
        .delete(schema.addonEntitlements)
        .where(eq(schema.addonEntitlements.catalogVersionId, versionId));
      await tx.insert(schema.addonEntitlements).values(
        input.addon.effects.map((effect) =>
          "quotaIncrement" in effect
            ? {
                catalogVersionId: versionId,
                entitlementKey: effect.key,
                quotaIncrement: effect.quotaIncrement,
              }
            : { catalogVersionId: versionId, entitlementKey: effect.key, featureEnabled: true },
        ),
      );
    }
  }

  private async assertCompleteEffects(
    tx: CatalogTransaction,
    version: CatalogVersionRow,
  ): Promise<void> {
    if (version.kind === "plan") {
      const [effect] = await tx
        .select({ id: schema.planEntitlements.catalogVersionId })
        .from(schema.planEntitlements)
        .where(eq(schema.planEntitlements.catalogVersionId, version.id));
      if (!effect) throw new BadRequestException({ code: "catalog_version_effect_invalid" });
    }
    if (version.kind === "addon") {
      const [effect] = await tx
        .select({ id: schema.addonEntitlements.catalogVersionId })
        .from(schema.addonEntitlements)
        .where(eq(schema.addonEntitlements.catalogVersionId, version.id));
      if (!effect) throw new BadRequestException({ code: "catalog_version_effect_invalid" });
    }
  }

  private async toDto(
    item: CatalogItemRow,
    version: CatalogVersionRow,
    includeFinancial: boolean,
    db: Pick<Db, "select"> = this.db,
  ): Promise<CatalogVersion> {
    const common = {
      documentNameRu: version.documentNameRu,
      documentNameEn: version.documentNameEn,
      subject: version.subject,
      sellerPolicyRevision: version.sellerPolicyRevision,
      lifecyclePolicyId: version.lifecyclePolicyId,
      id: version.id,
      catalogItemId: item.id,
      catalogItemCode: item.code,
      version: version.version,
      status: version.status,
      nameRu: version.nameRu,
      nameEn: version.nameEn,
      descriptionRu: version.descriptionRu,
      descriptionEn: version.descriptionEn,
      unit: version.unit,
      billingMode: version.billingMode,
      billingPeriod: version.billingPeriod,
      publishedAt: version.publishedAt,
      publishedByPlatformUserId: version.publishedByPlatformUserId,
    };
    const financial = includeFinancial
      ? {
          unitPrice: String(version.unitPrice),
          vatRateBps: version.vatRate === null ? null : Math.round(Number(version.vatRate) * 100),
          vatIncluded: version.vatIncluded,
        }
      : {};
    if (version.kind === "plan") {
      const [plan] = await db
        .select()
        .from(schema.planEntitlements)
        .where(eq(schema.planEntitlements.catalogVersionId, version.id));
      return platformCatalogContracts.getVersion.response.parse({
        ...common,
        ...financial,
        kind: "plan",
        plan: plan
          ? {
              maxLines: plan.maxLines,
              maxStations: plan.maxStations,
              maxKiosks: plan.maxKiosks,
              maxCabinetUsers: plan.maxCabinetUsers,
              labelEditorEnabled: plan.labelEditorEnabled,
              publicApiEnabled: plan.publicApiEnabled,
              palletsEnabled: plan.palletsEnabled,
              chzIntegrationEnabled: plan.chzIntegrationEnabled,
              inventoryEnabled: plan.inventoryEnabled,
              commerceMlEnabled: plan.commerceMlEnabled,
              handheldEnabled: plan.handheldEnabled,
              demoDurationDays: plan.demoDurationDays,
            }
          : undefined,
      });
    }
    if (version.kind === "addon") {
      const effects = await db
        .select()
        .from(schema.addonEntitlements)
        .where(eq(schema.addonEntitlements.catalogVersionId, version.id));
      return platformCatalogContracts.getVersion.response.parse({
        ...common,
        ...financial,
        kind: "addon",
        addon: { effects: effects.map(toAddonEffect) },
      });
    }
    return platformCatalogContracts.getVersion.response.parse({
      ...common,
      ...financial,
      kind: "service",
      service: {},
    });
  }
}

function kindForInput(input: CatalogVersionCreate | CatalogVersionCreateV2): CatalogItemKind {
  if ("plan" in input) return "plan";
  if ("addon" in input) return "addon";
  return "service";
}

function toVatRate(vatRateBps: number | null | undefined): string | null {
  return vatRateBps === null || vatRateBps === undefined ? null : (vatRateBps / 100).toFixed(2);
}

function toPlanValues(plan: PlanEntitlements | PlanEntitlementsReadV3) {
  return {
    maxLines: plan.maxLines,
    maxStations: plan.maxStations,
    maxKiosks: plan.maxKiosks,
    maxCabinetUsers: plan.maxCabinetUsers,
    labelEditorEnabled: plan.labelEditorEnabled,
    publicApiEnabled: plan.publicApiEnabled,
    palletsEnabled: plan.palletsEnabled,
    demoDurationDays: plan.demoDurationDays,
    ...("chzIntegrationEnabled" in plan
      ? {
          chzIntegrationEnabled: plan.chzIntegrationEnabled,
          inventoryEnabled: plan.inventoryEnabled,
          commerceMlEnabled: plan.commerceMlEnabled,
          handheldEnabled: plan.handheldEnabled,
        }
      : {}),
  };
}

function validateEffectForKind(
  kind: CatalogItemKind,
  input: CatalogVersionPatch | CatalogVersionPatchV2,
): void {
  if (
    (input.plan !== undefined && kind !== "plan") ||
    (input.addon !== undefined && kind !== "addon") ||
    (input.service !== undefined && kind !== "service")
  ) {
    throw new BadRequestException({ code: "catalog_version_kind_effect_mismatch" });
  }
}

function copyDefined(
  target: Record<string, unknown>,
  source: CatalogVersionPatch | CatalogVersionPatchV2,
  keys: readonly (keyof CatalogVersionPatch)[],
): void {
  for (const key of keys) {
    const value: unknown = key in source ? Reflect.get(source, key) : undefined;
    if (value !== undefined) target[key] = value;
  }
}

function toAddonEffect(effect: typeof schema.addonEntitlements.$inferSelect): AddonEffect {
  if (
    effect.entitlementKey === "lines" ||
    effect.entitlementKey === "stations" ||
    effect.entitlementKey === "kiosks" ||
    effect.entitlementKey === "cabinetUsers"
  ) {
    if (effect.quotaIncrement === null) {
      throw new ConflictException({ code: "catalog_version_effect_invalid" });
    }
    return { key: effect.entitlementKey, quotaIncrement: effect.quotaIncrement };
  }
  return { key: effect.entitlementKey, featureEnabled: true };
}

function catalogDatabaseError(error: unknown): never {
  if (
    error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof NotFoundException
  )
    throw error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "23505") throw new ConflictException({ code: "catalog_conflict" });
  if (code === "23503") throw new ConflictException({ code: "catalog_reference_invalid" });
  if (code === "23514") throw new BadRequestException({ code: "catalog_version_invalid" });
  if (code === "P0001") throw new ConflictException({ code: "catalog_version_immutable" });
  throw error;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeVersion(value: CommercialVersion | boolean): CommercialVersion {
  return value === true ? 1 : value === false ? 2 : value;
}
