import { randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const SEED_VERSION = "us-development-owner-v1";
const EMAIL = "owner@us-development.example.test";
const SLUG = "us-development-demo";
const METADATA = JSON.stringify({ synthetic: true, seedVersion: SEED_VERSION });
// Same precise CJS type bridge as the existing activation services; the pinned
// Better Auth hashPassword export is async (password: string) => string.
const hashCredentialPassword = hashPassword as unknown as (password: string) => Promise<string>;

export interface UsDevelopmentOwnerResult {
  status: "created" | "already_exists";
  userId: string;
  tenantId: string;
  email: string;
}

export function validateUsOwnerPassword(password: string): string {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128 ||
    /[\r\n\0]/.test(password)
  ) {
    throw new Error("us_development_password_invalid");
  }
  return password;
}

function conflict(): never {
  throw new Error("us_development_owner_conflict");
}

type OwnerFacts = {
  codec: "us-development-owner-provenance-v1";
  organization: { id: string; name: string; metadata: string | null };
  user: { id: string; name: string };
  memberships: { count: number; soleRole: string | null };
  credentials: { count: number; soleAccountId: string | null; nonemptyPassword: boolean };
  audits: {
    count: number;
    sole: {
      actorUserId: string | null;
      outcome: string;
      targetType: string;
      targetId: string | null;
      before: unknown;
      after: unknown;
    } | null;
  };
};

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

function encodeActor(actor: unknown): string | null {
  if (actor === undefined) return null;
  return JSON.stringify(typeof actor === "string" && validPgIdentity(actor) ? actor : null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalidFacts(): never {
  throw new Error("us_development_owner_provenance_contract_invalid");
}

function decodeOwnerFacts(value: unknown): OwnerFacts | null {
  if (value === null) return null;
  if (
    !hasKeys(value, ["codec", "organization", "user", "memberships", "credentials", "audits"]) ||
    value.codec !== "us-development-owner-provenance-v1" ||
    !hasKeys(value.organization, ["id", "name", "metadata"]) ||
    typeof value.organization.id !== "string" ||
    typeof value.organization.name !== "string" ||
    !nullableString(value.organization.metadata) ||
    !hasKeys(value.user, ["id", "name"]) ||
    typeof value.user.id !== "string" ||
    typeof value.user.name !== "string" ||
    !hasKeys(value.memberships, ["count", "soleRole"]) ||
    !count(value.memberships.count) ||
    !nullableString(value.memberships.soleRole) ||
    !hasKeys(value.credentials, ["count", "soleAccountId", "nonemptyPassword"]) ||
    !count(value.credentials.count) ||
    !nullableString(value.credentials.soleAccountId) ||
    typeof value.credentials.nonemptyPassword !== "boolean" ||
    !hasKeys(value.audits, ["count", "sole"]) ||
    !count(value.audits.count)
  )
    return invalidFacts();
  const sole = value.audits.sole;
  if (
    sole !== null &&
    (!hasKeys(sole, ["actorUserId", "outcome", "targetType", "targetId", "before", "after"]) ||
      !nullableString(sole.actorUserId) ||
      typeof sole.outcome !== "string" ||
      typeof sole.targetType !== "string" ||
      !nullableString(sole.targetId))
  )
    return invalidFacts();
  if ((value.audits.count === 1) !== (sole !== null)) return invalidFacts();
  return value as OwnerFacts;
}

/** Internal local CLI store, not an HTTP endpoint or a production provisioner.
 * The command must validate edition, loopback target and actual DB identity first.
 */
export class UsDevelopmentOwnerStore {
  constructor(private readonly db: Db) {}

  /** Treat the local fixture as synthetic only when its persisted origin is intact. */
  async verifyTrustedSeed(
    tenantId: string,
    verifiedAt: Date,
    transaction?: Transaction,
  ): Promise<{ seedId: string; verifiedBy: string; verifiedAt: string } | null> {
    if (!Number.isFinite(verifiedAt.getTime())) return null;
    const read = (tx: Transaction) => this.readTrustedSeed(tx, tenantId, verifiedAt, false);
    return transaction
      ? read(transaction)
      : this.db.transaction(read, { isolationLevel: "repeatable read" });
  }

  /** Reads each complete native fact under its original provenance share lock. */
  verifyLockedTrustedSeed(
    tenantId: string,
    actorUserId: string,
    verifiedAt: Date,
    transaction: Transaction,
  ): Promise<{ seedId: string; verifiedBy: string; verifiedAt: string } | null> {
    return this.readLockedTrustedSeed(transaction, tenantId, verifiedAt, actorUserId);
  }

  private async readLockedTrustedSeed(
    transaction: Transaction,
    tenantId: string,
    verifiedAt: Date,
    actorUserId: string,
  ): Promise<{ seedId: string; verifiedBy: string; verifiedAt: string } | null> {
    if (!Number.isFinite(verifiedAt.getTime())) return null;
    const encodedActor = encodeActor(actorUserId);
    const native = await transaction.execute<{ facts: unknown }>(sql`
      SELECT public.us_development_owner_provenance_v1(
        ${tenantId}::pg_catalog.text, ${encodedActor}::pg_catalog.jsonb
      ) AS facts
    `);
    if (native.rows.length !== 1 || !Object.hasOwn(native.rows[0] ?? {}, "facts"))
      return invalidFacts();
    const facts = decodeOwnerFacts(native.rows[0]?.facts);
    if (facts === null) return null;
    if (
      facts.organization.id !== tenantId ||
      facts.organization.metadata !== METADATA ||
      facts.organization.name !== "Synthetic US development" ||
      facts.user.name !== "Synthetic US development owner" ||
      (actorUserId !== undefined && facts.user.id !== actorUserId) ||
      facts.memberships.count !== 1 ||
      facts.memberships.soleRole !== "owner" ||
      facts.credentials.count !== 1 ||
      facts.credentials.soleAccountId !== facts.user.id ||
      !facts.credentials.nonemptyPassword ||
      facts.audits.count !== 1 ||
      facts.audits.sole?.actorUserId !== facts.user.id ||
      facts.audits.sole.outcome !== "success" ||
      facts.audits.sole.targetType !== "tenant" ||
      facts.audits.sole.targetId !== tenantId ||
      facts.audits.sole.before !== null ||
      JSON.stringify(facts.audits.sole.after) !== METADATA
    )
      return null;
    return { seedId: tenantId, verifiedBy: SEED_VERSION, verifiedAt: verifiedAt.toISOString() };
  }

  private async readTrustedSeed(
    tx: Transaction,
    tenantId: string,
    verifiedAt: Date,
    lock: boolean,
    actorUserId?: string,
  ): Promise<{ seedId: string; verifiedBy: string; verifiedAt: string } | null> {
    if (!Number.isFinite(verifiedAt.getTime())) return null;
    const organizationQuery = tx
      .select()
      .from(schema.organization)
      .where(and(eq(schema.organization.id, tenantId), eq(schema.organization.slug, SLUG)));
    const [organization] = await (lock ? organizationQuery.for("share") : organizationQuery);
    if (
      !organization ||
      organization.metadata !== METADATA ||
      organization.name !== "Synthetic US development"
    )
      return null;
    const userQuery = tx.select().from(schema.user).where(eq(schema.user.email, EMAIL));
    const [user] = await (lock ? userQuery.for("share") : userQuery);
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
    const memberships = await (lock ? membershipQuery.for("share") : membershipQuery);
    if (memberships.length !== 1 || memberships[0]?.role !== "owner") return null;
    const credentialQuery = tx
      .select()
      .from(schema.account)
      .where(and(eq(schema.account.userId, user.id), eq(schema.account.providerId, "credential")));
    const credentials = await (lock ? credentialQuery.for("share") : credentialQuery);
    if (
      credentials.length !== 1 ||
      credentials[0]?.accountId !== user.id ||
      !credentials[0].password
    )
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
    const audits = await (lock ? auditQuery.for("share") : auditQuery);
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

  async provision(password: string, requestId: string): Promise<UsDevelopmentOwnerResult> {
    validateUsOwnerPassword(password);
    return this.db.transaction(async (tx) => {
      // No seed row exists on first run. Serialize the reserved seed identity.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${SEED_VERSION}, 0))`);
      const [organization] = await tx
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, SLUG))
        .for("update");
      const [user] = await tx
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, EMAIL))
        .for("update");
      if (organization || user) {
        if (!organization || !user || organization.metadata !== METADATA) return conflict();
        const memberships = await tx
          .select()
          .from(schema.member)
          .where(
            and(
              eq(schema.member.organizationId, organization.id),
              eq(schema.member.userId, user.id),
            ),
          )
          .for("share");
        const credentials = await tx
          .select()
          .from(schema.account)
          .where(
            and(eq(schema.account.userId, user.id), eq(schema.account.providerId, "credential")),
          )
          .for("share");
        const credential = credentials[0];
        if (
          memberships.length !== 1 ||
          memberships[0]?.role !== "owner" ||
          credentials.length !== 1 ||
          credential?.accountId !== user.id ||
          !credential.password
        )
          return conflict();
        if (!(await verifyPassword({ hash: credential.password, password }))) return conflict();
        // Never repair, reset a password/MFA, or elevate a revoked member.
        return {
          status: "already_exists",
          tenantId: organization.id,
          userId: user.id,
          email: EMAIL,
        };
      }
      const userId = randomUUID();
      const tenantId = randomUUID();
      const now = new Date();
      const passwordHash = await hashCredentialPassword(password);
      await tx.insert(schema.user).values({
        id: userId,
        name: "Synthetic US development owner",
        email: EMAIL,
        emailVerified: false,
        twoFactorEnabled: false,
      });
      await tx.insert(schema.account).values({
        id: randomUUID(),
        userId,
        accountId: userId,
        providerId: "credential",
        password: passwordHash,
      });
      await tx.insert(schema.organization).values({
        id: tenantId,
        name: "Synthetic US development",
        slug: SLUG,
        metadata: METADATA,
        createdAt: now,
      });
      await tx.insert(schema.member).values({
        id: randomUUID(),
        organizationId: tenantId,
        userId,
        role: "owner",
        createdAt: now,
      });
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: userId,
        action: "us.development.owner.provisioned",
        outcome: "success",
        targetType: "tenant",
        targetId: tenantId,
        requestId,
        before: null,
        after: { synthetic: true, seedVersion: SEED_VERSION },
      });
      return { status: "created", tenantId, userId, email: EMAIL };
    });
  }
}
