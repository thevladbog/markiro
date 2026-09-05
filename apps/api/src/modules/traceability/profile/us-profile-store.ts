import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  US_CAPABILITY,
  resolveUsAccess,
  hasUsCapabilities,
  type UsCapability,
} from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import {
  provisionUsTraceabilityProfileSchema,
  type ProvisionUsTraceabilityProfileInput,
} from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const BASELINE_VERSION = "US-REG-2026-09-03";

export interface UsProfileSummary extends ProvisionUsTraceabilityProfileInput {
  baselineVersion: string;
  effectiveAt: string;
}

/** Internal US settings store; callers must obtain actorUserId from a verified
 * US session, never the request body. Mounted only in the isolated US API. */
export class UsProfileStore {
  constructor(private readonly db: Db) {}

  private async authorize(
    tx: Transaction,
    tenantId: string,
    actorUserId: string,
    required: UsCapability,
  ) {
    const [membership] = await tx
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, tenantId), eq(schema.member.userId, actorUserId)))
      .limit(1)
      .for("share");
    const access = resolveUsAccess(membership?.role ?? "");
    if (!membership || !hasUsCapabilities(access.capabilities, [required])) {
      throw new ForbiddenException({ code: "insufficient_permission" });
    }
    return access;
  }

  private async stored(tx: Transaction, tenantId: string): Promise<UsProfileSummary | undefined> {
    const [row] = await tx
      .select({
        code: schema.traceabilityProfiles.code,
        baselineVersion: schema.traceabilityProfiles.baselineVersion,
        effectiveAt: schema.traceabilityProfiles.effectiveAt,
        retentionYears: schema.traceabilityProfiles.retentionYears,
        timeZone: schema.orgProfiles.timeZone,
      })
      .from(schema.traceabilityProfiles)
      .leftJoin(
        schema.orgProfiles,
        eq(schema.orgProfiles.tenantId, schema.traceabilityProfiles.tenantId),
      )
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId))
      .limit(1);
    if (!row) return undefined;
    const parsed = provisionUsTraceabilityProfileSchema.safeParse({
      code: row.code,
      timeZone: row.timeZone,
      retentionYears: row.retentionYears,
    });
    if (!parsed.success || row.baselineVersion !== BASELINE_VERSION) {
      throw new ServiceUnavailableException({ code: "traceability_profile_invalid" });
    }
    return {
      ...parsed.data,
      baselineVersion: row.baselineVersion,
      effectiveAt: row.effectiveAt.toISOString(),
    };
  }

  async read(tenantId: string, actorUserId: string): Promise<UsProfileSummary> {
    return this.db.transaction(async (tx) => {
      const access = await this.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const profile = await this.stored(tx, tenantId);
      if (!profile) {
        // Only settings administrators may enter initial setup. Other readers
        // must not receive the special missing-profile signal used by the UI.
        if (!hasUsCapabilities(access.capabilities, [US_CAPABILITY.SETTINGS_MANAGE]))
          throw new ForbiddenException({ code: "insufficient_permission" });
        throw new ServiceUnavailableException({ code: "traceability_profile_not_provisioned" });
      }
      return profile;
    });
  }

  async provision(
    tenantId: string,
    actorUserId: string,
    input: unknown,
    requestId: string,
  ): Promise<UsProfileSummary> {
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, tenantId, actorUserId, US_CAPABILITY.SETTINGS_MANAGE);
      const parsed = provisionUsTraceabilityProfileSchema.safeParse(input);
      if (!parsed.success) throw new BadRequestException({ code: "invalid_traceability_profile" });
      const value = parsed.data;
      // Serialize first creation on an existing tenant row (there is no profile
      // row to lock yet). Repeat requests then observe the winning transaction.
      const [organization] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, tenantId))
        .for("update");
      if (!organization) throw new ForbiddenException({ code: "insufficient_permission" });
      const existing = await this.stored(tx, tenantId);
      if (existing) {
        if (
          existing.code !== value.code ||
          existing.timeZone !== value.timeZone ||
          existing.retentionYears !== value.retentionYears
        ) {
          throw new ConflictException({ code: "traceability_profile_already_provisioned" });
        }
        return existing;
      }
      const now = new Date();
      const profile: UsProfileSummary = {
        ...value,
        baselineVersion: BASELINE_VERSION,
        effectiveAt: now.toISOString(),
      };
      await tx.insert(schema.traceabilityProfiles).values({
        tenantId,
        code: value.code,
        baselineVersion: BASELINE_VERSION,
        retentionYears: value.retentionYears,
        effectiveAt: now,
        updatedByUserId: actorUserId,
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .insert(schema.orgProfiles)
        .values({ tenantId, timeZone: value.timeZone, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.orgProfiles.tenantId,
          set: { timeZone: value.timeZone, updatedAt: now },
        });
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "traceability.profile.updated",
        outcome: "success",
        targetType: "tenant",
        targetId: tenantId,
        before: null,
        after: profile,
        requestId,
      });
      return profile;
    });
  }
}
