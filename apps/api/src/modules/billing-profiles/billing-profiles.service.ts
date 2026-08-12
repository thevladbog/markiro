import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type { BillingProfileInput } from "./dto";

@Injectable()
export class BillingProfilesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
  ) {}

  async getOperator(): Promise<unknown> {
    const [profile] = await this.db
      .select()
      .from(schema.operatorBillingProfiles)
      .where(eq(schema.operatorBillingProfiles.isCurrent, true))
      .limit(1);
    return profile ?? null;
  }

  async setOperator(principal: PlatformPrincipal, input: BillingProfileInput): Promise<unknown> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.operatorBillingProfiles)
        .where(eq(schema.operatorBillingProfiles.isCurrent, true))
        .limit(1);
      if (current) {
        await tx
          .update(schema.operatorBillingProfiles)
          .set({ isCurrent: false })
          .where(eq(schema.operatorBillingProfiles.id, current.id));
      }
      const [created] = await tx
        .insert(schema.operatorBillingProfiles)
        .values({
          ...input,
          revision: (current?.revision ?? 0) + 1,
          isCurrent: true,
          inn: input.inn ?? null,
          kpp: input.kpp ?? null,
          ogrn: input.ogrn ?? null,
          ogrnip: input.ogrnip ?? null,
          address: input.address ?? null,
          bankDetails: input.bankDetails ?? null,
          contact: input.contact ?? null,
          createdByPlatformUserId: principal.userId,
        })
        .returning();
      if (!created) throw new BadRequestException({ code: "billing_profile_create_failed" });
      await this.audit.record(tx, {
        actorPlatformUserId: principal.userId,
        actorRole: principal.role,
        action: "billing.operator_profile.revised",
        outcome: "success",
        tenantId: null,
        targetType: "operator_billing_profile",
        targetId: created.id,
        reason: null,
        before: current ? { revision: current.revision, displayName: current.displayName } : null,
        after: { revision: created.revision, displayName: created.displayName },
        requestId: null,
      });
      return created;
    });
  }

  async getTenant(tenantId: string): Promise<unknown> {
    const [profile] = await this.db
      .select()
      .from(schema.tenantBillingProfiles)
      .where(
        and(
          eq(schema.tenantBillingProfiles.tenantId, tenantId),
          eq(schema.tenantBillingProfiles.isCurrent, true),
        ),
      )
      .limit(1);
    return profile ?? null;
  }

  async setTenant(
    principal: PlatformPrincipal,
    tenantId: string,
    input: BillingProfileInput,
  ): Promise<unknown> {
    const [tenant] = await this.db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException({ code: "tenant_not_found" });
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.tenantBillingProfiles)
        .where(
          and(
            eq(schema.tenantBillingProfiles.tenantId, tenantId),
            eq(schema.tenantBillingProfiles.isCurrent, true),
          ),
        )
        .orderBy(desc(schema.tenantBillingProfiles.revision))
        .limit(1);
      if (current) {
        await tx
          .update(schema.tenantBillingProfiles)
          .set({ isCurrent: false })
          .where(eq(schema.tenantBillingProfiles.id, current.id));
      }
      const [created] = await tx
        .insert(schema.tenantBillingProfiles)
        .values({
          ...input,
          tenantId,
          revision: (current?.revision ?? 0) + 1,
          isCurrent: true,
          inn: input.inn ?? null,
          kpp: input.kpp ?? null,
          ogrn: input.ogrn ?? null,
          ogrnip: input.ogrnip ?? null,
          address: input.address ?? null,
          bankDetails: input.bankDetails ?? null,
          contact: input.contact ?? null,
          createdByPlatformUserId: principal.userId,
        })
        .returning();
      if (!created) throw new BadRequestException({ code: "billing_profile_create_failed" });
      await this.audit.record(tx, {
        actorPlatformUserId: principal.userId,
        actorRole: principal.role,
        action: "billing.tenant_profile.revised",
        outcome: "success",
        tenantId,
        targetType: "tenant_billing_profile",
        targetId: created.id,
        reason: null,
        before: current ? { revision: current.revision, displayName: current.displayName } : null,
        after: { revision: created.revision, displayName: created.displayName },
        requestId: null,
      });
      return created;
    });
  }
}
