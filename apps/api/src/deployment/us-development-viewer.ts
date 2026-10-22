import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import { UsDevelopmentOwnerStore, validateUsOwnerPassword } from "./us-development-owner";

const EMAIL = "viewer@us-development.example.test";
const NAME = "Synthetic US development viewer";
const VERSION = "us-development-viewer-v1";
const ROLE = "traceability_auditor";
const ACTION = "us.development.viewer.provisioned";
// Same pinned Better Auth CJS type bridge as the owner/activation stores.
const hashCredentialPassword = hashPassword as unknown as (password: string) => Promise<string>;

export interface UsDevelopmentViewerContext {
  tenantId: string;
  originalOwnerId: string;
  requestId: string;
}

export interface UsDevelopmentViewerResult {
  status: "created" | "already_exists" | "verified";
  tenantId: string;
  viewerUserId: string;
  email: string;
  role: "traceability_auditor";
  synthetic: true;
  mfaRequired: true;
}

function conflict(): never {
  throw new Error("us_development_viewer_conflict");
}

function provenanceAfter(context: UsDevelopmentViewerContext, viewerUserId: string) {
  return {
    synthetic: true,
    seedVersion: VERSION,
    tenantId: context.tenantId,
    originalOwnerId: context.originalOwnerId,
    viewerUserId,
    email: EMAIL,
    role: ROLE,
  };
}

function exactAfter(actual: unknown, expected: ReturnType<typeof provenanceAfter>): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const entries = Object.entries(actual);
  return (
    entries.length === Object.keys(expected).length &&
    entries.every(
      ([key, value]) => Object.hasOwn(expected, key) && value === Reflect.get(expected, key),
    )
  );
}

/** Reserved local command only; callers validate the actual DB/user before use.
 * No auth policy, owner/profile repair, credential reset or HTTP provisioning.
 */
export class UsDevelopmentViewerStore {
  constructor(private readonly db: Db) {}

  provision(
    context: UsDevelopmentViewerContext,
    password: string,
  ): Promise<UsDevelopmentViewerResult> {
    return this.observe(context, password, "provision");
  }

  verify(
    context: UsDevelopmentViewerContext,
    password: string,
  ): Promise<UsDevelopmentViewerResult> {
    return this.observe(context, password, "verify");
  }

  private async observe(
    context: UsDevelopmentViewerContext,
    password: string,
    mode: "provision" | "verify",
  ): Promise<UsDevelopmentViewerResult> {
    validateUsOwnerPassword(password);
    return this.db.transaction(async (tx) => {
      // Serialize our reserved identity even when no user/audit exists yet.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${VERSION}, 0))`);
      const owner = await new UsDevelopmentOwnerStore(this.db).verifyLockedTrustedSeed(
        context.tenantId,
        context.originalOwnerId,
        new Date(),
        tx,
      );
      if (!owner) return conflict();

      // Separate locking reads avoid a nullable-side outer-join lock and keep
      // both actual persisted rows stable through the viewer transaction.
      const [profile] = await tx
        .select({
          code: schema.traceabilityProfiles.code,
          baselineVersion: schema.traceabilityProfiles.baselineVersion,
          retentionYears: schema.traceabilityProfiles.retentionYears,
        })
        .from(schema.traceabilityProfiles)
        .where(eq(schema.traceabilityProfiles.tenantId, context.tenantId))
        .for("share");
      const [organizationProfile] = await tx
        .select({ timeZone: schema.orgProfiles.timeZone })
        .from(schema.orgProfiles)
        .where(eq(schema.orgProfiles.tenantId, context.tenantId))
        .for("share");
      if (
        profile?.code !== "US_FSMA204_PROCESSOR" ||
        profile.baselineVersion !== "US-REG-2026-09-03" ||
        profile.retentionYears !== 2 ||
        organizationProfile?.timeZone !== "America/Los_Angeles"
      )
        return conflict();

      const [viewer] = await tx
        .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
        .from(schema.user)
        .where(eq(schema.user.email, EMAIL))
        .limit(2)
        .for("update");
      // The reserved command is global: a foreign-tenant or orphan audit also
      // blocks creation/replay. Two rows are enough to reject any multiplicity.
      const audits = await tx
        .select({
          organizationId: schema.tenantAuditEvents.organizationId,
          actorUserId: schema.tenantAuditEvents.actorUserId,
          targetType: schema.tenantAuditEvents.targetType,
          targetId: schema.tenantAuditEvents.targetId,
          outcome: schema.tenantAuditEvents.outcome,
          before: schema.tenantAuditEvents.before,
          after: schema.tenantAuditEvents.after,
        })
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.action, ACTION))
        .limit(2)
        .for("share");

      let viewerUserId: string;
      let status: UsDevelopmentViewerResult["status"];
      if (viewer) {
        viewerUserId = viewer.id;
        const memberships = await tx
          .select({ organizationId: schema.member.organizationId, role: schema.member.role })
          .from(schema.member)
          .where(eq(schema.member.userId, viewer.id))
          .limit(2)
          .for("share");
        const accounts = await tx
          .select({
            providerId: schema.account.providerId,
            accountId: schema.account.accountId,
            password: schema.account.password,
          })
          .from(schema.account)
          .where(eq(schema.account.userId, viewer.id))
          .limit(2)
          .for("share");
        const audit = audits[0];
        const credential = accounts[0];
        if (
          viewer.id === context.originalOwnerId ||
          viewer.name !== NAME ||
          viewer.email !== EMAIL ||
          memberships.length !== 1 ||
          memberships[0]?.organizationId !== context.tenantId ||
          memberships[0].role !== ROLE ||
          accounts.length !== 1 ||
          credential?.providerId !== "credential" ||
          credential.accountId !== viewer.id ||
          !credential.password ||
          audits.length !== 1 ||
          audit?.organizationId !== context.tenantId ||
          audit.actorUserId !== context.originalOwnerId ||
          audit.targetType !== "user" ||
          audit.targetId !== viewer.id ||
          audit.outcome !== "success" ||
          audit.before !== null ||
          !exactAfter(audit.after, provenanceAfter(context, viewer.id))
        )
          return conflict();
        try {
          if (!(await verifyPassword({ hash: credential.password, password }))) return conflict();
        } catch {
          return conflict();
        }
        status = mode === "verify" ? "verified" : "already_exists";
      } else {
        if (mode === "verify" || audits.length !== 0) return conflict();
        viewerUserId = randomUUID();
        const passwordHash = await hashCredentialPassword(password);
        await tx.insert(schema.user).values({
          id: viewerUserId,
          name: NAME,
          email: EMAIL,
          emailVerified: false,
          twoFactorEnabled: false,
        });
        await tx.insert(schema.account).values({
          id: randomUUID(),
          userId: viewerUserId,
          accountId: viewerUserId,
          providerId: "credential",
          password: passwordHash,
        });
        await tx.insert(schema.member).values({
          id: randomUUID(),
          organizationId: context.tenantId,
          userId: viewerUserId,
          role: ROLE,
          createdAt: new Date(),
        });
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: context.tenantId,
          actorUserId: context.originalOwnerId,
          action: ACTION,
          outcome: "success",
          targetType: "user",
          targetId: viewerUserId,
          requestId: context.requestId,
          before: null,
          after: provenanceAfter(context, viewerUserId),
        });
        status = "created";
      }
      return {
        status,
        tenantId: context.tenantId,
        viewerUserId,
        email: EMAIL,
        role: ROLE,
        synthetic: true,
        mfaRequired: true,
      };
    });
  }
}
