import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { schema } from "@markiro/db";
import { CABINET_CAPABILITY, hasCabinetCapabilities, resolveCabinetAccess } from "@markiro/domain";
import { and, eq } from "drizzle-orm";
import type { PlatformPrincipal, PlatformCapability } from "@markiro/platform-contracts";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { platformCapabilitiesForRole } from "../../platform-auth/platform-access-policy";
export type DeviceLicensingActor =
  { domain: "cabinet"; id: string } | { domain: "platform"; principal: PlatformPrincipal };
export async function requireDeviceLicensingActor(
  tx: SubscriptionTransaction,
  tenantId: string,
  actor: DeviceLicensingActor,
  write: boolean,
) {
  if (actor.domain === "cabinet") {
    const query = tx
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, tenantId), eq(schema.member.userId, actor.id)))
      .limit(2);
    const memberships = await (write ? query.for("share") : query);
    const membership = memberships[0];
    if (
      memberships.length !== 1 ||
      !membership ||
      !hasCabinetCapabilities(resolveCabinetAccess(membership.role).capabilities, [
        CABINET_CAPABILITY.CREDENTIALS_MANAGE,
      ])
    )
      throw new ForbiddenException();
    return { id: actor.id, role: null, canCancel: true };
  }
  const { principal } = actor;
  if (!principal?.twoFactorReady) throw new ForbiddenException();
  // Platform recovery retires the factor before updating its user. Follow
  // that order so a concurrent security reset cannot deadlock cancellation.
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
  const query = tx
    .select()
    .from(schema.platformUsers)
    .where(eq(schema.platformUsers.id, principal.userId));
  const [user] = await (write ? query.for("share") : query);
  const required: PlatformCapability[] = write
    ? ["tenants.write", "billing.write"]
    : ["tenants.read"];
  if (
    !user ||
    user.status !== "active" ||
    !user.twoFactorEnabled ||
    !required.every((cap) => platformCapabilitiesForRole(user.role).includes(cap))
  )
    throw new ForbiddenException();
  const [tenant] = await tx
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, tenantId));
  if (!tenant) throw new NotFoundException();
  return {
    id: user.id,
    role: user.role,
    canCancel: ["tenants.write", "billing.write"].every((cap) =>
      platformCapabilitiesForRole(user.role).some((value) => value === cap),
    ),
  };
}
