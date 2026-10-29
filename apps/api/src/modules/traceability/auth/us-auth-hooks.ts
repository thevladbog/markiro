import type { BetterAuthOptions } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { and, eq, lte, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { isUsSessionAssured } from "./us-principal";
import { usAuthError, usAuthErrorCode } from "./us-auth-error";

const verificationPaths = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);

/** Shared assurance hooks only; no auth construction or origin/cookie policy. */
export function createUsAuthHooks(db: Db): NonNullable<BetterAuthOptions["hooks"]> {
  return {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/organization/list" || ctx.path === "/organization/set-active") {
        const active = await getSessionFromCtx(ctx);
        if (!active || !(await isUsSessionAssured(db, active.user.id, active.session.id)))
          throw usAuthError("FORBIDDEN", "MFA is required before organization access");
      }
      if (ctx.path === "/two-factor/enable") {
        const active = await getSessionFromCtx(ctx);
        if (active) {
          const [identity] = await db
            .select()
            .from(schema.user)
            .where(eq(schema.user.id, active.user.id));
          // Recovery / replacement requires its own reviewed workflow. A stolen
          // pre-enrollment password session cannot replace an enrolled factor.
          if (identity?.twoFactorEnabled)
            throw usAuthError("FORBIDDEN", "Factor replacement is not available");
          const [factor] = await db
            .select({ id: schema.usTwoFactors.id })
            .from(schema.usTwoFactors)
            .where(eq(schema.usTwoFactors.userId, active.user.id));
          if (factor) throw usAuthError("CONFLICT", "Factor enrollment already started");
        }
      }
      if (!verificationPaths.has(ctx.path)) return;
      const body: unknown = ctx.body;
      if (
        body &&
        typeof body === "object" &&
        (("trustDevice" in body && body.trustDevice) ||
          ("disableSession" in body && body.disableSession))
      )
        throw usAuthError("BAD_REQUEST", "Every login requires a fresh MFA session");
      const active = await getSessionFromCtx(ctx);
      let userId = active?.user.id;
      if (userId) {
        const [identity] = await db
          .select({ enabled: schema.user.twoFactorEnabled })
          .from(schema.user)
          .where(eq(schema.user.id, userId));
        if (identity?.enabled)
          throw usAuthError("FORBIDDEN", "Sign in again to start a fresh MFA challenge");
      }
      if (!userId) {
        const cookie = ctx.context.createAuthCookie("two_factor");
        const challenge = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
        if (challenge)
          userId = (await ctx.context.internalAdapter.findVerificationValue(challenge))?.value;
      }
      const [factor] = userId
        ? await db
            .select({ id: schema.usTwoFactors.id, lockedUntil: schema.usTwoFactors.lockedUntil })
            .from(schema.usTwoFactors)
            .where(eq(schema.usTwoFactors.userId, userId))
        : [];
      if (active && factor?.lockedUntil) {
        if (factor.lockedUntil > new Date())
          throw usAuthError("TOO_MANY_REQUESTS", "MFA verification is temporarily locked");
        await db
          .update(schema.usTwoFactors)
          .set({ failedVerificationCount: 0, lockedUntil: null })
          .where(
            and(
              eq(schema.usTwoFactors.id, factor.id),
              lte(schema.usTwoFactors.lockedUntil, new Date()),
            ),
          );
      }
      // Capture before verification: a concurrent replacement must never let a
      // successful code for the previous factor bless the replacement factor.
      return {
        context: {
          context: {
            usVerificationFactorId: factor?.id ?? null,
            usEnrollmentVerification: Boolean(active),
          },
        },
      };
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (!verificationPaths.has(ctx.path)) return;
      const factorId: unknown =
        "usVerificationFactorId" in ctx.context ? ctx.context.usVerificationFactorId : undefined;
      const enrollment =
        "usEnrollmentVerification" in ctx.context && ctx.context.usEnrollmentVerification === true;
      if (isAPIError(ctx.context.returned)) {
        const code = usAuthErrorCode(ctx.context.returned);
        // The plugin counts login challenges, but not authenticated enrollment
        // attempts. Persist those too, with an atomic increment across sessions.
        if (
          enrollment &&
          typeof factorId === "string" &&
          (code === "INVALID_CODE" || code === "INVALID_BACKUP_CODE")
        ) {
          await db
            .update(schema.usTwoFactors)
            .set({
              failedVerificationCount: sql`${schema.usTwoFactors.failedVerificationCount} + 1`,
              lockedUntil: sql`CASE WHEN ${schema.usTwoFactors.failedVerificationCount} + 1 >= 10 THEN ${new Date(Date.now() + 15 * 60 * 1000)} ELSE ${schema.usTwoFactors.lockedUntil} END`,
            })
            .where(eq(schema.usTwoFactors.id, factorId));
        }
        return;
      }
      const result: unknown = ctx.context.returned;
      if (
        !result ||
        typeof result !== "object" ||
        !("token" in result) ||
        typeof result.token !== "string"
      )
        return;
      const active = ctx.context.newSession ?? ctx.context.session;
      if (!active || typeof factorId !== "string") return;
      const [factor] = await db
        .select({ id: schema.usTwoFactors.id })
        .from(schema.usTwoFactors)
        .innerJoin(schema.user, eq(schema.user.id, schema.usTwoFactors.userId))
        .where(
          and(
            eq(schema.usTwoFactors.id, factorId),
            eq(schema.user.id, active.user.id),
            eq(schema.user.twoFactorEnabled, true),
            eq(schema.usTwoFactors.verified, true),
          ),
        );
      if (!factor) return;
      if (enrollment)
        await db
          .update(schema.usTwoFactors)
          .set({ failedVerificationCount: 0, lockedUntil: null })
          .where(eq(schema.usTwoFactors.id, factor.id));
      await db
        .insert(schema.usSessionAssurances)
        .values({ sessionId: active.session.id, factorId: factor.id })
        .onConflictDoNothing();
    }),
  };
}
