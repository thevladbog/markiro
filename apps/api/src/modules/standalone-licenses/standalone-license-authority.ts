import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import type {
  PlatformCapability,
  PlatformPrincipal,
  StandaloneIssuanceSource,
} from "@markiro/platform-contracts";
import { platformCapabilitiesForRole } from "../../platform-auth/platform-access-policy";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

export const STANDALONE_LICENSE_CAPABILITIES = [
  "tenants.read",
  "standaloneLicenses.manage",
] as const satisfies readonly PlatformCapability[];
export const STANDALONE_LICENSE_CLOCK = Symbol("STANDALONE_LICENSE_CLOCK");
export type StandaloneLicenseClock = () => Date;

/**
 * Reloads the platform user, its verified factor and the tenant inside the
 * caller's transaction (apps/api/AGENTS.md); a write takes them FOR SHARE in the
 * platform recovery order (factor first, as device licensing does).
 */
export async function requireStandaloneLicenseActor(
  tx: SubscriptionTransaction,
  principal: PlatformPrincipal | undefined,
  tenantId: string,
  write: boolean,
) {
  if (!principal?.twoFactorReady) throw new ForbiddenException();
  const factorQuery = tx
    .select({ id: schema.platformTwoFactors.id })
    .from(schema.platformTwoFactors)
    .where(
      and(
        eq(schema.platformTwoFactors.userId, principal.userId),
        eq(schema.platformTwoFactors.verified, true),
      ),
    );
  if (!(await (write ? factorQuery.for("share") : factorQuery))[0]) throw new ForbiddenException();
  const userQuery = tx
    .select()
    .from(schema.platformUsers)
    .where(eq(schema.platformUsers.id, principal.userId));
  const [user] = await (write ? userQuery.for("share") : userQuery);
  if (
    !user ||
    user.status !== "active" ||
    !user.twoFactorEnabled ||
    !STANDALONE_LICENSE_CAPABILITIES.every((capability) =>
      platformCapabilitiesForRole(user.role).includes(capability),
    )
  )
    throw new ForbiddenException();
  // The cabinet access decides the issuance path; a write holds it FOR SHARE so
  // a cabinet grant cannot commit between the decision and the signed file.
  const tenantQuery = tx
    .select({
      id: schema.organization.id,
      name: schema.organization.name,
      cabinetAccess: schema.organization.cabinetAccess,
    })
    .from(schema.organization)
    .where(eq(schema.organization.id, tenantId));
  const [tenant] = await (write ? tenantQuery.for("share") : tenantQuery);
  if (!tenant) throw new NotFoundException();
  return { user, tenant };
}

/**
 * Owner decision 2026-10-13: a tenant without a cabinet takes offline licenses
 * only; a tenant with a cabinet takes the subscription-derived file.
 */
export function issuanceSourceFor(cabinetAccess: "enabled" | "none"): StandaloneIssuanceSource {
  return cabinetAccess === "none" ? "offline" : "subscription";
}

export async function readTenantInns(tx: SubscriptionTransaction, tenantId: string) {
  const [profile] = await tx
    .select({ inn: schema.orgProfiles.inn })
    .from(schema.orgProfiles)
    .where(eq(schema.orgProfiles.tenantId, tenantId));
  const [billing] = await tx
    .select({
      inn: schema.tenantBillingProfiles.inn,
      fullName: schema.tenantBillingProfiles.fullName,
    })
    .from(schema.tenantBillingProfiles)
    .where(
      and(
        eq(schema.tenantBillingProfiles.tenantId, tenantId),
        eq(schema.tenantBillingProfiles.isCurrent, true),
      ),
    );
  return {
    orgInn: profile?.inn ?? null,
    billingInn: billing?.inn ?? null,
    billingName: billing?.fullName ?? null,
  };
}

/** A site of this tenant or 404; never another tenant's (composite tenant scope). */
export async function findSite(
  tx: SubscriptionTransaction,
  tenantId: string,
  siteId: string,
  lock = false,
) {
  const query = tx
    .select()
    .from(schema.standaloneSites)
    .where(
      and(eq(schema.standaloneSites.tenantId, tenantId), eq(schema.standaloneSites.id, siteId)),
    );
  const [site] = await (lock ? query.for("update") : query);
  if (!site) throw new NotFoundException();
  return site;
}
