import { betterAuth, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { organization, twoFactor } from "better-auth/plugins";
import { and, eq, lte, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { usAuthAdapter } from "./us-auth-adapter";
import { isUsSessionAssured } from "./us-principal";
import { usAuthError, usAuthErrorCode } from "./us-auth-error";

interface UsAuthOptions {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
}

const verificationPaths = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);
const routes = new Map([
  ["/sign-in/email", "POST"],
  ["/sign-out", "POST"],
  ["/get-session", "GET"],
  ["/organization/list", "GET"],
  ["/organization/set-active", "POST"],
  ["/two-factor/enable", "POST"],
  ["/two-factor/verify-totp", "POST"],
  ["/two-factor/verify-backup-code", "POST"],
]);

/** Local-only foundation. Never reuse the RU factory or its API-key/mail plugins. */
export function createUsAuth(db: Db, options: UsAuthOptions) {
  if (options.secret.trim().length < 32)
    throw new Error("US auth requires an explicit secret of at least 32 characters");
  if (
    !["http://localhost:3100", "http://127.0.0.1:3100"].includes(options.baseURL) ||
    options.trustedOrigins.length !== 1 ||
    !["http://localhost:5174", "http://127.0.0.1:5174"].includes(options.trustedOrigins[0] ?? "")
  )
    throw new Error("US auth requires isolated loopback origins");
  return betterAuth<BetterAuthOptions>({
    appName: "Markiro US",
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: "/api/us-auth",
    // Library error logs may contain SQL parameters (including session tokens).
    // Let the US boundary redact failures instead of logging raw adapter errors.
    logger: { disabled: true },
    onAPIError: { throw: true },
    trustedOrigins: [...options.trustedOrigins],
    database: usAuthAdapter(db),
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: { cookieCache: { enabled: false } },
    // Better Auth otherwise disables its limiter in development/test.
    rateLimit: { enabled: true },
    advanced: {
      disableOriginCheck: false,
      cookiePrefix: "markiro-us",
      // No proxy is part of this loopback-only foundation. Ignore caller-supplied
      // forwarding headers and use the shared per-path bucket on this local server.
      ipAddress: { ipAddressHeaders: [] },
      defaultCookieAttributes: { httpOnly: true, secure: false, sameSite: "lax", path: "/" },
    },
    plugins: [
      organization({ allowUserToCreateOrganization: false }),
      twoFactor({ issuer: "Markiro US" }),
    ],
    hooks: {
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
          "usEnrollmentVerification" in ctx.context &&
          ctx.context.usEnrollmentVerification === true;
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
    },
  });
}

export type UsAuth = ReturnType<typeof createUsAuth>;

/** The only HTTP mount target; plugin presence is not route authorization. */
export async function handleUsAuth(
  auth: UsAuth,
  request: Request,
  beforeDispatch?: () => Promise<void>,
): Promise<Response> {
  const url = new URL(request.url);
  if (typeof auth.options.baseURL !== "string") return new Response(null, { status: 503 });
  const baseURL = new URL(auth.options.baseURL);
  if (url.origin !== baseURL.origin || !url.pathname.startsWith("/api/us-auth/"))
    return new Response(null, { status: 404 });
  const route = url.pathname.slice("/api/us-auth".length);
  if (routes.get(route) !== request.method) return new Response(null, { status: 404 });
  if (request.method !== "GET") {
    const origins = auth.options.trustedOrigins;
    if (!Array.isArray(origins) || !origins.includes(request.headers.get("origin") ?? ""))
      return new Response(null, { status: 403 });
  }
  await beforeDispatch?.();
  try {
    const response = await auth.handler(request);
    if (response.status < 500) return response;
  } catch {
    // Some routes return a 5xx APIError; others throw a raw adapter error.
    // Neither representation may escape into the response or raw library logs.
  }
  return Response.json({ code: "us_database_unavailable" }, { status: 503 });
}
