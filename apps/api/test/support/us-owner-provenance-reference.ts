import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const SEED_VERSION = "us-development-owner-v1";
const EMAIL = "owner@us-development.example.test";
const SLUG = "us-development-demo";
const METADATA = JSON.stringify({ synthetic: true, seedVersion: SEED_VERSION });

// Test-only copy of the previous locked five-query reader. Never import this
// from production code: it is the differential oracle, not a fallback.
export async function readPreviousLockedSeed(
  tx: Transaction,
  tenantId: string,
  verifiedAt: Date,
  actorUserId?: string,
): Promise<{ seedId: string; verifiedBy: string; verifiedAt: string } | null> {
  if (!Number.isFinite(verifiedAt.getTime())) return null;
  const organizationQuery = tx
    .select()
    .from(schema.organization)
    .where(and(eq(schema.organization.id, tenantId), eq(schema.organization.slug, SLUG)));
  const [organization] = await organizationQuery.for("share");
  if (
    !organization ||
    organization.metadata !== METADATA ||
    organization.name !== "Synthetic US development"
  )
    return null;
  const userQuery = tx.select().from(schema.user).where(eq(schema.user.email, EMAIL));
  const [user] = await userQuery.for("share");
  if (
    !user ||
    user.name !== "Synthetic US development owner" ||
    (actorUserId !== undefined && user.id !== actorUserId)
  )
    return null;
  const membershipQuery = tx
    .select()
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, tenantId), eq(schema.member.userId, user.id)));
  const memberships = await membershipQuery.for("share");
  if (memberships.length !== 1 || memberships[0]?.role !== "owner") return null;
  const credentialQuery = tx
    .select()
    .from(schema.account)
    .where(and(eq(schema.account.userId, user.id), eq(schema.account.providerId, "credential")));
  const credentials = await credentialQuery.for("share");
  if (credentials.length !== 1 || credentials[0]?.accountId !== user.id || !credentials[0].password)
    return null;
  const auditQuery = tx
    .select()
    .from(schema.tenantAuditEvents)
    .where(
      and(
        eq(schema.tenantAuditEvents.organizationId, tenantId),
        eq(schema.tenantAuditEvents.action, "us.development.owner.provisioned"),
      ),
    );
  const audits = await auditQuery.for("share");
  if (audits.length !== 1) return null;
  const audit = audits[0];
  if (
    audit?.actorUserId !== user.id ||
    audit.outcome !== "success" ||
    audit.targetType !== "tenant" ||
    audit.targetId !== tenantId ||
    audit.before !== null ||
    JSON.stringify(audit.after) !== METADATA
  )
    return null;
  return { seedId: tenantId, verifiedBy: SEED_VERSION, verifiedAt: verifiedAt.toISOString() };
}

function validPgIdentity(value: string): boolean {
  if (value.includes("\0")) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function encodeActorForCandidate(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(typeof value === "string" && validPgIdentity(value) ? value : null);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readCandidateLockedSeed(
  tx: Transaction,
  tenantId: string,
  verifiedAt: Date,
  actorUserId?: string,
): Promise<{ seedId: string; verifiedBy: string; verifiedAt: string } | null> {
  if (!Number.isFinite(verifiedAt.getTime())) return null;
  const encodedActor = encodeActorForCandidate(actorUserId);
  const result = await tx.execute<{ facts: unknown }>(sql`
    SELECT public.us_development_owner_provenance_v1(
      ${tenantId}::pg_catalog.text, ${encodedActor}::pg_catalog.jsonb
    ) AS facts
  `);
  if (result.rows.length !== 1) throw new Error("owner_provenance_result_cardinality");
  const facts = result.rows[0]?.facts;
  if (facts === null) return null;
  if (!record(facts) || facts.codec !== "us-development-owner-provenance-v1")
    throw new Error("owner_provenance_codec_invalid");
  const organization = facts.organization;
  const user = facts.user;
  const memberships = facts.memberships;
  const credentials = facts.credentials;
  const audits = facts.audits;
  if (
    !record(organization) ||
    organization.id !== tenantId ||
    organization.name !== "Synthetic US development" ||
    organization.metadata !== METADATA ||
    !record(user) ||
    typeof user.id !== "string" ||
    user.name !== "Synthetic US development owner" ||
    (actorUserId !== undefined && user.id !== actorUserId) ||
    !record(memberships) ||
    memberships.count !== 1 ||
    memberships.soleRole !== "owner" ||
    !record(credentials) ||
    credentials.count !== 1 ||
    credentials.soleAccountId !== user.id ||
    credentials.nonemptyPassword !== true ||
    !record(audits) ||
    audits.count !== 1 ||
    !record(audits.sole) ||
    audits.sole.actorUserId !== user.id ||
    audits.sole.outcome !== "success" ||
    audits.sole.targetType !== "tenant" ||
    audits.sole.targetId !== tenantId ||
    audits.sole.before !== null ||
    JSON.stringify(audits.sole.after) !== METADATA
  )
    return null;
  return { seedId: tenantId, verifiedBy: SEED_VERSION, verifiedAt: verifiedAt.toISOString() };
}
