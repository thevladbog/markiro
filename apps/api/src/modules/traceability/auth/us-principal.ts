import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { and, eq, gt } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { UsAuth } from "./us-auth";

export interface UsPrincipal {
  userId: string;
  tenantId: string;
  sessionId: string;
}

/** Does not require an active organization: selection itself is MFA-protected. */
export async function isUsSessionAssured(
  db: Db,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .innerJoin(schema.user, eq(schema.user.id, schema.session.userId))
    .innerJoin(
      schema.usSessionAssurances,
      eq(schema.usSessionAssurances.sessionId, schema.session.id),
    )
    .innerJoin(
      schema.usTwoFactors,
      and(
        eq(schema.usTwoFactors.id, schema.usSessionAssurances.factorId),
        eq(schema.usTwoFactors.userId, schema.user.id),
      ),
    )
    .where(
      and(
        eq(schema.session.id, sessionId),
        eq(schema.user.id, userId),
        gt(schema.session.expiresAt, new Date()),
        eq(schema.user.twoFactorEnabled, true),
        eq(schema.usTwoFactors.verified, true),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Session identity is verified first; all authorization-relevant state is fresh. */
export async function resolveUsPrincipal(
  db: Db,
  auth: UsAuth,
  headers: Headers,
): Promise<UsPrincipal> {
  const active = await auth.api.getSession({ headers });
  if (!active) throw new UnauthorizedException("us_session_required");
  const [principal] = await db
    .select({
      userId: schema.user.id,
      tenantId: schema.member.organizationId,
      sessionId: schema.session.id,
    })
    .from(schema.session)
    .innerJoin(schema.user, eq(schema.user.id, schema.session.userId))
    .innerJoin(
      schema.usSessionAssurances,
      eq(schema.usSessionAssurances.sessionId, schema.session.id),
    )
    .innerJoin(
      schema.usTwoFactors,
      and(
        eq(schema.usTwoFactors.id, schema.usSessionAssurances.factorId),
        eq(schema.usTwoFactors.userId, schema.user.id),
      ),
    )
    .innerJoin(
      schema.member,
      and(
        eq(schema.member.userId, schema.user.id),
        eq(schema.member.organizationId, schema.session.activeOrganizationId),
      ),
    )
    .where(
      and(
        eq(schema.session.id, active.session.id),
        eq(schema.user.id, active.user.id),
        gt(schema.session.expiresAt, new Date()),
        eq(schema.user.twoFactorEnabled, true),
        eq(schema.usTwoFactors.verified, true),
      ),
    )
    .limit(1);
  if (!principal) throw new ForbiddenException("us_mfa_and_membership_required");
  return principal;
}
