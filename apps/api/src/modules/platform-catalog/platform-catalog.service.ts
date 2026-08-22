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
  platformCatalogContracts,
  type AddonEffect,
  type ArchiveCatalogItemResponse,
  type CatalogVersion,
  type CatalogVersionCreate,
  type CatalogVersionListResponse,
  type CatalogVersionPatch,
  type DefaultDemoPlanResponse,
  type PlanEntitlements,
  type SetDefaultDemoPlan,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";

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
    input: CatalogVersionCreate,
  ): Promise<CatalogVersion> {
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
            unit: input.unit,
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
    input: CatalogVersionPatch,
  ): Promise<CatalogVersion> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockVersion(tx, versionId);
        const found = await this.findVersion(itemRef, versionId, tx);
        if (!found) throw new NotFoundException({ code: "catalog_version_not_found" });
        if (found.version.status !== "draft") {
          throw new ConflictException({ code: "catalog_version_immutable" });
        }
        validateEffectForKind(found.item.kind, input);
        const changes: Record<string, unknown> = { updatedAt: sql`now()` };
        copyDefined(changes, input, [
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
  ): Promise<CatalogVersion> {
    try {
      return await this.db.transaction(async (tx) => {
        const found = await this.findVersion(itemRef, versionId, tx);
        if (!found) throw new NotFoundException({ code: "catalog_version_not_found" });
        if (found.item.status === "archived")
          throw new ConflictException({ code: "catalog_item_archived" });
        if (found.version.status !== "draft") {
          throw new ConflictException({ code: "catalog_version_immutable" });
        }
        await this.assertCompleteEffects(tx, found.version);
        const [version] = await tx
          .update(schema.catalogItemVersions)
          .set({
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
  ): Promise<CatalogVersion> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockVersion(tx, versionId);
        const found = await this.findVersion(itemRef, versionId, tx);
        if (!found) throw new NotFoundException({ code: "catalog_version_not_found" });
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
  ): Promise<SetDefaultDemoPlan> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockVersion(tx, input.catalogVersionId);
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
    input: CatalogVersionCreate,
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
    input: CatalogVersionPatch,
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

function kindForInput(input: CatalogVersionCreate): CatalogItemKind {
  if ("plan" in input) return "plan";
  if ("addon" in input) return "addon";
  return "service";
}

function toVatRate(vatRateBps: number | null | undefined): string | null {
  return vatRateBps === null || vatRateBps === undefined ? null : (vatRateBps / 100).toFixed(2);
}

function toPlanValues(plan: PlanEntitlements) {
  return {
    maxLines: plan.maxLines,
    maxStations: plan.maxStations,
    maxKiosks: plan.maxKiosks,
    maxCabinetUsers: plan.maxCabinetUsers,
    labelEditorEnabled: plan.labelEditorEnabled,
    publicApiEnabled: plan.publicApiEnabled,
    palletsEnabled: plan.palletsEnabled,
    demoDurationDays: plan.demoDurationDays,
  };
}

function validateEffectForKind(kind: CatalogItemKind, input: CatalogVersionPatch): void {
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
  source: CatalogVersionPatch,
  keys: readonly (keyof CatalogVersionPatch)[],
): void {
  for (const key of keys) {
    const value = source[key];
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
