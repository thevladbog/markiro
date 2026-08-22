import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { billingContactSchema } from "@markiro/platform-contracts";
import type { ZodType } from "zod";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type { BillingProfileInput, OperatorBillingProfileInput } from "./dto";

type OperatorBillingProfileRecord = typeof schema.operatorBillingProfiles.$inferSelect;
type TenantBillingProfileRecord = typeof schema.tenantBillingProfiles.$inferSelect;
type ExistingBillingProfile = Pick<
  OperatorBillingProfileRecord,
  "bankDetails" | "displayName" | "isConfirmed" | "kind" | "revision"
>;

@Injectable()
export class BillingProfilesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
  ) {}

  async getOperator(): Promise<OperatorBillingProfileRecord | null> {
    const [profile] = await this.db
      .select()
      .from(schema.operatorBillingProfiles)
      .where(eq(schema.operatorBillingProfiles.isCurrent, true))
      .limit(1);
    return profile ? withCompatibleContact(profile) : null;
  }

  async setOperator(
    principal: PlatformPrincipal,
    input: OperatorBillingProfileInput,
  ): Promise<OperatorBillingProfileRecord> {
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
          ...profileValues(input, principal.userId, current),
          revision: (current?.revision ?? 0) + 1,
          isCurrent: true,
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
        before: current ? auditProfileSummary(current) : null,
        after: auditProfileSummary(created),
        requestId: null,
      });
      return created;
    });
  }

  async getTenant(tenantId: string): Promise<TenantBillingProfileRecord | null> {
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
    return profile ? withCompatibleContact(profile) : null;
  }

  async setTenant(
    principal: PlatformPrincipal,
    tenantId: string,
    input: BillingProfileInput,
  ): Promise<TenantBillingProfileRecord> {
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
          ...profileValues(input, principal.userId, current),
          tenantId,
          revision: (current?.revision ?? 0) + 1,
          isCurrent: true,
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
        before: current ? auditProfileSummary(current) : null,
        after: auditProfileSummary(created),
        requestId: null,
      });
      return created;
    });
  }
}

function profileValues(
  input: BillingProfileInput,
  actorPlatformUserId: string,
  current?: ExistingBillingProfile,
) {
  const postal = input.postalAddress;
  const legalAddress = input.legalAddress ?? null;
  return {
    kind: input.kind,
    fullName: input.fullName,
    displayName: input.displayName,
    inn: "inn" in input ? (input.inn ?? null) : null,
    kpp: "kpp" in input ? input.kpp : null,
    ogrn: "ogrn" in input ? input.ogrn : null,
    ogrnip: "ogrnip" in input ? input.ogrnip : null,
    legalAddressRaw: input.legalAddressRaw,
    legalAddress,
    postalSameAsLegal: postal.sameAsLegal,
    postalAddressRaw: postal.sameAsLegal ? null : postal.raw,
    postalAddress: postal.sameAsLegal ? null : (postal.normalized ?? null),
    contact: input.contact,
    isConfirmed: true,
    confirmedByPlatformUserId: actorPlatformUserId,
    confirmedAt: new Date(),
    addressRaw: input.legalAddressRaw,
    address: legalAddress,
    bankDetails: current?.bankDetails ?? null,
    createdByPlatformUserId: actorPlatformUserId,
  };
}

function auditProfileSummary(profile: {
  revision: number;
  kind: string;
  displayName: string;
  isConfirmed: boolean;
}) {
  return {
    revision: profile.revision,
    kind: profile.kind,
    displayName: profile.displayName,
    confirmed: profile.isConfirmed,
  };
}

function withCompatibleContact<T extends { contact: unknown }>(profile: T): T {
  return { ...profile, contact: normalizeLegacyContact(profile.contact) };
}

function normalizeLegacyContact(contact: unknown) {
  if (!isRecord(contact)) return null;

  return {
    name: parseContactField(billingContactSchema.shape.name, contact.name),
    email: parseContactField(billingContactSchema.shape.email, contact.email),
    phone: parseContactField(billingContactSchema.shape.phone, contact.phone),
  };
}

function parseContactField<T>(schema: ZodType<T>, value: unknown): T | null {
  const candidate = typeof value === "string" ? value.trim() : null;
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
