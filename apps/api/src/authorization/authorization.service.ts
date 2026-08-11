import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, asc, eq, gt } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { resolveCabinetAccess, type ResolvedCabinetAccess } from "@markiro/domain";
import { DB } from "../auth/auth.module";
import { EntitlementsService } from "../subscriptions/entitlements.service";
import type { EntitlementUsage } from "../subscriptions/entitlements.types";

export interface CabinetPrincipal extends ResolvedCabinetAccess {
  userId: string;
  tenantId: string;
}

export interface AccessSubscriptionPlan {
  id: string;
  version: number;
  nameRu: string;
  nameEn: string;
}

export interface AccessSubscriptionDto {
  access: "managed" | "read_only" | "unmanaged";
  status: "unmanaged" | "pending_activation" | "trial" | "active" | "expired" | "read_only";
  startsAt: string | null;
  endsAt: string | null;
  plan: AccessSubscriptionPlan | null;
  addons: Array<{
    catalogVersionId: string;
    quantity: number;
    quotas: Record<string, number>;
    features: string[];
  }>;
}

export interface AccessDocumentSubscription {
  subscription: AccessSubscriptionDto;
  scheduled: (AccessSubscriptionDto & { startsAt: string }) | null;
  usage: EntitlementUsage;
  quotas: Record<string, number | null>;
  features: Record<string, boolean>;
}

@Injectable()
export class AuthorizationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() private readonly entitlements?: EntitlementsService,
  ) {}

  async resolvePrincipal(userId: string, tenantId: string): Promise<CabinetPrincipal | null> {
    const memberships = await this.db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, tenantId)))
      .limit(2);
    if (memberships.length !== 1) return null;
    const membership = memberships[0]!;
    return { userId, tenantId, ...resolveCabinetAccess(membership.role) };
  }

  async resolveSubscriptionDocument(tenantId: string): Promise<AccessDocumentSubscription> {
    if (!this.entitlements) throw new Error("EntitlementsService is not configured");
    const at = new Date();
    const [resolved, usage, contributors] = await Promise.all([
      this.entitlements.resolve(tenantId, this.db, at),
      this.entitlements.usage(tenantId, this.db, at),
      this.entitlements.contributors(tenantId, this.db, at),
    ]);
    const currentPlan = resolved.subscription
      ? await this.catalogPlan(resolved.subscription.planVersionId)
      : null;
    const [scheduled] = await this.db
      .select({
        planVersionId: schema.tenantSubscriptions.planVersionId,
        startsAt: schema.tenantSubscriptions.startsAt,
        endsAt: schema.tenantSubscriptions.endsAt,
      })
      .from(schema.tenantSubscriptions)
      .where(
        and(
          eq(schema.tenantSubscriptions.tenantId, tenantId),
          eq(schema.tenantSubscriptions.status, "scheduled"),
          gt(schema.tenantSubscriptions.startsAt, at),
        ),
      )
      .orderBy(asc(schema.tenantSubscriptions.startsAt), asc(schema.tenantSubscriptions.id))
      .limit(1);
    const scheduledPlan = scheduled ? await this.catalogPlan(scheduled.planVersionId) : null;
    return {
      subscription: {
        access: resolved.access,
        status:
          resolved.access === "unmanaged"
            ? "unmanaged"
            : (resolved.subscription?.status ?? "read_only"),
        startsAt: resolved.subscription?.startsAt?.toISOString() ?? null,
        endsAt: resolved.subscription?.endsAt?.toISOString() ?? null,
        plan: currentPlan,
        addons: contributors.map((contributor) => ({
          catalogVersionId: contributor.catalogVersionId,
          quantity: contributor.quantity,
          quotas: contributor.quotas,
          features: contributor.features,
        })),
      },
      scheduled:
        scheduled && scheduledPlan
          ? {
              access: "managed",
              status: "active",
              startsAt: scheduled.startsAt!.toISOString(),
              endsAt: scheduled.endsAt?.toISOString() ?? null,
              plan: scheduledPlan,
              addons: [],
            }
          : null,
      usage,
      quotas: resolved.quotas,
      features: resolved.features,
    };
  }

  private async catalogPlan(versionId: string): Promise<AccessSubscriptionPlan | null> {
    const [row] = await this.db
      .select({
        id: schema.catalogItemVersions.id,
        version: schema.catalogItemVersions.version,
        nameRu: schema.catalogItemVersions.nameRu,
        nameEn: schema.catalogItemVersions.nameEn,
      })
      .from(schema.catalogItemVersions)
      .where(
        and(
          eq(schema.catalogItemVersions.id, versionId),
          eq(schema.catalogItemVersions.kind, "plan"),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
