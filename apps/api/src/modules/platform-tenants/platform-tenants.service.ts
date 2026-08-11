import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { sanitizeSupportAuditMetadata } from "../../platform-auth/platform-audit.service";
import { SubscriptionLifecycleService } from "../../subscriptions/subscription-lifecycle.service";
import type { AssignAddonDto, AssignPlanDto, ProvisionTenantDto, TenantListQueryDto } from "./dto";
import {
  TenantProvisioningService,
  type TenantProvisioningResult,
} from "./tenant-provisioning.service";

type SubscriptionRow = typeof schema.tenantSubscriptions.$inferSelect;
type CatalogVersionRow = typeof schema.catalogItemVersions.$inferSelect;

interface TenantListRow {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  planVersionId: string | null;
  planVersion: number | null;
  planNameRu: string | null;
  planNameEn: string | null;
  unitPrice: string | null;
  total: number;
}

@Injectable()
export class PlatformTenantsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly provisioning: TenantProvisioningService,
    private readonly subscriptions: SubscriptionLifecycleService,
  ) {}

  create(actor: PlatformPrincipal, input: ProvisionTenantDto): Promise<TenantProvisioningResult> {
    return this.provisioning.provision(input, { actor });
  }

  async list(actor: PlatformPrincipal, query: TenantListQueryDto) {
    const offset = (query.page - 1) * query.limit;
    const filter = query.status
      ? sql`coalesce(latest.status::text, 'unmanaged') = ${query.status}`
      : sql`true`;
    const result = await this.db.execute(sql<TenantListRow>`
      select
        organization.id,
        organization.name,
        organization.slug,
        organization.created_at as "createdAt",
        latest.id as "subscriptionId",
        latest.status::text as "subscriptionStatus",
        latest.starts_at as "startsAt",
        latest.ends_at as "endsAt",
        latest.plan_version_id as "planVersionId",
        catalog_item_versions.version as "planVersion",
        catalog_item_versions.name_ru as "planNameRu",
        catalog_item_versions.name_en as "planNameEn",
        catalog_item_versions.unit_price as "unitPrice",
        count(*) over()::int as total
      from organization
      left join lateral (
        select tenant_subscriptions.*
        from tenant_subscriptions
        where tenant_subscriptions.tenant_id = organization.id
        order by
          case tenant_subscriptions.status
            when 'pending_activation' then 0
            when 'trial' then 0
            when 'active' then 0
            when 'scheduled' then 1
            else 2
          end,
          tenant_subscriptions.updated_at desc,
          tenant_subscriptions.id desc
        limit 1
      ) latest on true
      left join catalog_item_versions on catalog_item_versions.id = latest.plan_version_id
      where ${filter}
      order by organization.created_at desc, organization.id desc
      limit ${query.limit} offset ${offset}
    `);
    const includeFinancial = actor.role !== "support";
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        createdAt: row.createdAt,
        subscriptionStatus: row.subscriptionStatus ?? "unmanaged",
        ...(row.subscriptionId
          ? {
              subscription: {
                id: row.subscriptionId,
                status: row.subscriptionStatus,
                startsAt: row.startsAt,
                endsAt: row.endsAt,
                planVersion: {
                  id: row.planVersionId,
                  version: row.planVersion,
                  nameRu: row.planNameRu,
                  nameEn: row.planNameEn,
                  ...(includeFinancial ? { unitPrice: row.unitPrice } : {}),
                },
              },
            }
          : {}),
      })),
      page: query.page,
      limit: query.limit,
      total: result.rows[0]?.total ?? 0,
    };
  }

  async get(actor: PlatformPrincipal, tenantId: string) {
    const [tenant] = await this.db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException({ code: "tenant_not_found" });

    const [owner] = await this.db
      .select({
        userId: schema.user.id,
        email: schema.user.email,
        emailVerified: schema.user.emailVerified,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(and(eq(schema.member.organizationId, tenantId), eq(schema.member.role, "owner")))
      .orderBy(schema.member.createdAt)
      .limit(1);
    const [delivery] = owner
      ? await this.db
          .select({
            id: schema.emailDeliveries.id,
            status: schema.emailDeliveries.status,
            createdAt: schema.emailDeliveries.createdAt,
            updatedAt: schema.emailDeliveries.updatedAt,
            terminalAt: schema.emailDeliveries.terminalAt,
          })
          .from(schema.emailDeliveries)
          .where(
            and(
              eq(schema.emailDeliveries.userId, owner.userId),
              eq(schema.emailDeliveries.kind, "tenant-owner-activation"),
              eq(schema.emailDeliveries.sourceId, `tenant-owner:${tenantId}`),
            ),
          )
          .orderBy(desc(schema.emailDeliveries.createdAt), desc(schema.emailDeliveries.id))
          .limit(1)
      : [];

    const [current] = await this.db
      .select()
      .from(schema.tenantSubscriptions)
      .where(
        and(
          eq(schema.tenantSubscriptions.tenantId, tenantId),
          inArray(schema.tenantSubscriptions.status, ["pending_activation", "trial", "active"]),
        ),
      )
      .orderBy(desc(schema.tenantSubscriptions.updatedAt))
      .limit(1);
    const [scheduled] = await this.db
      .select()
      .from(schema.tenantSubscriptions)
      .where(
        and(
          eq(schema.tenantSubscriptions.tenantId, tenantId),
          eq(schema.tenantSubscriptions.status, "scheduled"),
        ),
      )
      .limit(1);
    const now = new Date();
    const addonRows = await this.db
      .select({ addon: schema.subscriptionAddons })
      .from(schema.subscriptionAddons)
      .innerJoin(
        schema.tenantSubscriptions,
        and(
          eq(schema.tenantSubscriptions.tenantId, schema.subscriptionAddons.tenantId),
          eq(schema.tenantSubscriptions.id, schema.subscriptionAddons.subscriptionId),
        ),
      )
      .where(
        and(
          eq(schema.subscriptionAddons.tenantId, tenantId),
          or(
            and(
              eq(schema.subscriptionAddons.status, "active"),
              inArray(schema.tenantSubscriptions.status, ["trial", "active"]),
              lte(schema.subscriptionAddons.startsAt, now),
              or(
                isNull(schema.subscriptionAddons.endsAt),
                gt(schema.subscriptionAddons.endsAt, now),
              ),
              or(
                isNull(schema.tenantSubscriptions.startsAt),
                lte(schema.tenantSubscriptions.startsAt, now),
              ),
              or(
                isNull(schema.tenantSubscriptions.endsAt),
                gt(schema.tenantSubscriptions.endsAt, now),
              ),
            ),
            and(
              eq(schema.subscriptionAddons.status, "scheduled"),
              eq(schema.tenantSubscriptions.status, "scheduled"),
              or(
                isNull(schema.subscriptionAddons.endsAt),
                gt(schema.subscriptionAddons.endsAt, now),
              ),
              or(
                isNull(schema.tenantSubscriptions.endsAt),
                gt(schema.tenantSubscriptions.endsAt, now),
              ),
            ),
          ),
        ),
      )
      .orderBy(desc(schema.subscriptionAddons.createdAt));
    const events = await this.db
      .select()
      .from(schema.subscriptionEvents)
      .where(eq(schema.subscriptionEvents.tenantId, tenantId))
      .orderBy(desc(schema.subscriptionEvents.effectiveAt), desc(schema.subscriptionEvents.id))
      .limit(200);
    const [lineUsage, stationUsage, kioskUsage, cabinetUsage, invitationUsage] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(schema.lines)
        .where(eq(schema.lines.tenantId, tenantId)),
      this.db
        .select({ value: count() })
        .from(schema.stationDevices)
        .where(
          and(
            eq(schema.stationDevices.tenantId, tenantId),
            isNull(schema.stationDevices.revokedAt),
          ),
        ),
      this.db
        .select({ value: count() })
        .from(schema.kiosks)
        .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.status, "active"))),
      this.db
        .select({ value: count() })
        .from(schema.member)
        .where(eq(schema.member.organizationId, tenantId)),
      this.db
        .select({ value: count() })
        .from(schema.invitation)
        .where(
          and(
            eq(schema.invitation.organizationId, tenantId),
            eq(schema.invitation.status, "pending"),
            gt(schema.invitation.expiresAt, now),
          ),
        ),
    ]);
    const currentDto = current
      ? await this.subscriptionDto(current, actor.role !== "support")
      : null;
    const scheduledDto = scheduled
      ? await this.subscriptionDto(scheduled, actor.role !== "support")
      : null;
    const addonDtos = await Promise.all(
      addonRows.map(({ addon }) => this.addonDto(addon, actor.role !== "support")),
    );
    const scrub =
      actor.role === "support" ? sanitizeSupportAuditMetadata : (value: unknown) => value;
    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        createdAt: tenant.createdAt,
      },
      subscriptionStatus: current?.status ?? scheduled?.status ?? "unmanaged",
      ownerActivation: owner
        ? {
            ownerUserId: owner.userId,
            ownerEmail: owner.email,
            emailVerified: owner.emailVerified,
            deliveryId: delivery?.id ?? null,
            status: delivery?.status ?? "missing",
            createdAt: delivery?.createdAt ?? null,
            updatedAt: delivery?.updatedAt ?? null,
            terminalAt: delivery?.terminalAt ?? null,
          }
        : null,
      currentSubscription: currentDto,
      scheduledSubscription: scheduledDto,
      activeAddons: addonDtos.filter(
        (addon) => addon.status === "active" && (!addon.endsAt || addon.endsAt > now),
      ),
      scheduledAddons: addonDtos.filter((addon) => addon.status === "scheduled"),
      usage: {
        cabinetUsers: (cabinetUsage[0]?.value ?? 0) + (invitationUsage[0]?.value ?? 0),
        kiosks: kioskUsage[0]?.value ?? 0,
        lines: lineUsage[0]?.value ?? 0,
        stations: stationUsage[0]?.value ?? 0,
      },
      events: events.map((event) => ({
        id: event.id,
        subscriptionId: event.subscriptionId,
        eventKind: event.eventKind,
        effectiveAt: event.effectiveAt,
        source: event.source,
        reason: event.reason,
        before: scrub(event.before),
        after: scrub(event.after),
        createdAt: event.createdAt,
      })),
    };
  }

  async renewActivation(
    actor: PlatformPrincipal,
    tenantId: string,
  ): Promise<{ deliveryId: string }> {
    const [owner] = await this.db
      .select({
        tenantName: schema.organization.name,
        tenantSlug: schema.organization.slug,
        email: schema.user.email,
      })
      .from(schema.organization)
      .innerJoin(schema.member, eq(schema.member.organizationId, schema.organization.id))
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(
        and(
          eq(schema.organization.id, tenantId),
          eq(schema.member.organizationId, tenantId),
          eq(schema.member.role, "owner"),
        ),
      )
      .orderBy(schema.member.createdAt)
      .limit(1);
    if (!owner) throw new NotFoundException({ code: "tenant_owner_not_found" });
    const result = await this.provisioning.provision(
      { email: owner.email, tenantName: owner.tenantName, tenantSlug: owner.tenantSlug },
      { actor, renewActivation: true },
    );
    return { deliveryId: result.deliveryId };
  }

  assignPlan(actor: PlatformPrincipal, tenantId: string, input: AssignPlanDto) {
    return this.subscriptions.assignPlan(actor, tenantId, input);
  }

  assignAddon(actor: PlatformPrincipal, tenantId: string, input: AssignAddonDto) {
    return this.subscriptions.assignAddon(actor, tenantId, input);
  }

  private async subscriptionDto(subscription: SubscriptionRow, includeFinancial: boolean) {
    const version = await this.requireCatalogVersion(subscription.planVersionId);
    return {
      ...subscriptionSnapshot(subscription),
      planVersion: await this.catalogVersionDto(version, includeFinancial),
    };
  }

  private async addonDto(
    addon: typeof schema.subscriptionAddons.$inferSelect,
    includeFinancial: boolean,
  ) {
    const version = await this.requireCatalogVersion(addon.addonVersionId);
    return {
      id: addon.id,
      subscriptionId: addon.subscriptionId,
      addonVersionId: addon.addonVersionId,
      quantity: addon.quantity,
      startsAt: addon.startsAt,
      endsAt: addon.endsAt,
      status: addon.status,
      source: addon.source,
      addonVersion: await this.catalogVersionDto(version, includeFinancial),
    };
  }

  private async requireCatalogVersion(versionId: string): Promise<CatalogVersionRow> {
    const [version] = await this.db
      .select()
      .from(schema.catalogItemVersions)
      .where(eq(schema.catalogItemVersions.id, versionId))
      .limit(1);
    if (!version) throw new NotFoundException({ code: "catalog_version_not_found" });
    return version;
  }

  private async catalogVersionDto(version: CatalogVersionRow, includeFinancial: boolean) {
    const [item] = await this.db
      .select({ code: schema.catalogItems.code })
      .from(schema.catalogItems)
      .where(eq(schema.catalogItems.id, version.catalogItemId))
      .limit(1);
    const dto = {
      id: version.id,
      catalogItemId: version.catalogItemId,
      catalogItemCode: item?.code ?? null,
      kind: version.kind,
      version: version.version,
      status: version.status,
      nameRu: version.nameRu,
      nameEn: version.nameEn,
      unit: version.unit,
      billingMode: version.billingMode,
      billingPeriod: version.billingPeriod,
      ...(includeFinancial
        ? {
            unitPrice: String(version.unitPrice),
            vatRateBps: version.vatRate === null ? null : Math.round(Number(version.vatRate) * 100),
            vatIncluded: version.vatIncluded,
          }
        : {}),
    };
    if (version.kind === "plan") {
      const [entitlements] = await this.db
        .select()
        .from(schema.planEntitlements)
        .where(eq(schema.planEntitlements.catalogVersionId, version.id));
      return { ...dto, entitlements: entitlements ?? null };
    }
    const effects = await this.db
      .select({
        entitlementKey: schema.addonEntitlements.entitlementKey,
        quotaIncrement: schema.addonEntitlements.quotaIncrement,
        featureEnabled: schema.addonEntitlements.featureEnabled,
      })
      .from(schema.addonEntitlements)
      .where(eq(schema.addonEntitlements.catalogVersionId, version.id));
    return { ...dto, effects };
  }
}

function subscriptionSnapshot(subscription: SubscriptionRow) {
  return {
    id: subscription.id,
    tenantId: subscription.tenantId,
    planVersionId: subscription.planVersionId,
    status: subscription.status,
    startsAt: subscription.startsAt,
    endsAt: subscription.endsAt,
    source: subscription.source,
    createdByPlatformUserId: subscription.createdByPlatformUserId,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}
