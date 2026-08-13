import { toNodeHandler } from "better-auth/node";
import type { Express } from "express";
import { rateLimit } from "express-rate-limit";
import { buildAuth, createDb, schema, type Auth } from "@markiro/db";
import { sessionAllowedOrigins, type Env } from "../env";
import { MailCryptoService } from "../modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../modules/mail/mail-delivery.service";

// `DbConnection` re-uses createDb's own return type by reference (rather
// than spelling out `NodePgDatabase`/`pg.Pool`, which live in @markiro/db's
// own node_modules and aren't portably nameable from this package's .d.ts —
// see the TS2883 note in packages/db/src/auth-config.ts for the same class
// of issue). Annotating `setupAuth`'s return type explicitly (instead of
// letting it be inferred) lets tsc print this alias instead of expanding it.
type DbConnection = ReturnType<typeof createDb>;

/** Builds the DB pool + Better Auth instance from validated env. */
export function setupAuth(env: Env): DbConnection & { auth: Auth } {
  const { db, pool } = createDb(env.DATABASE_URL);
  const mailDelivery = new MailDeliveryService(
    new MailCryptoService(env.MAIL_PAYLOAD_ENCRYPTION_KEY),
  );
  const afterCreateOrganization =
    process.env.NODE_ENV === "test"
      ? async (organizationId: string) => {
          await db
            .insert(schema.pickupTenantPolicies)
            .values({ tenantId: organizationId, limitsEnabled: true });
        }
      : undefined;
  const auth = buildAuth(db, {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    ...(afterCreateOrganization ? { afterCreateOrganization } : {}),
    // Exactly the list the CORS middleware applies to non-kiosk routes, on
    // purpose -- /api/auth/* is one of those routes, so the two describe the
    // same surface and must not drift (see `sessionAllowedOrigins`).
    // KIOSK_ORIGIN is NOT here: the kiosk calls no /api/auth/* route at all
    // (it authenticates with a device token), so trusting it would only widen
    // what an attacker on that origin can do with an admin's session.
    // SAAS_ADMIN_ORIGIN is also deliberately absent: platform sessions use a
    // separate Better Auth instance, cookie prefix, and trusted-origin list.
    trustedOrigins: sessionAllowedOrigins(env),
    sendResetPassword: async ({ user, url }) => {
      await db.transaction((tx) =>
        mailDelivery.enqueue(tx, {
          scope: { userId: user.id },
          recipient: user.email,
          template: {
            kind: "password-reset",
            recipientName: user.name || "Пользователь",
            actionUrl: url,
            expiresInMinutes: 60,
          },
        }),
      );
    },
    sendVerificationEmail: async ({ user, url }) => {
      await db.transaction((tx) =>
        mailDelivery.enqueue(tx, {
          scope: { userId: user.id },
          recipient: user.email,
          template: {
            kind: "email-verification",
            recipientName: user.name || "Пользователь",
            actionUrl: url,
            expiresInMinutes: 60,
          },
        }),
      );
    },
  });
  return { db, pool, auth };
}

export type AuthSetup = ReturnType<typeof setupAuth>;

const TEAM_MUTATION_PATHS = new Set([
  "/api/auth/organization/invite-member",
  "/api/auth/organization/cancel-invitation",
  "/api/auth/organization/accept-invitation",
  "/api/auth/organization/reject-invitation",
  "/api/auth/organization/remove-member",
  "/api/auth/organization/update-member-role",
]);
const RAW_TENANT_PROVISIONING_PATH = "/api/auth/organization/create";
const AUTH_PATH_CANONICALIZATION_ORIGIN = "http://auth-path.invalid";
const BLOCKED_ORGANIZATION_WINDOW_MS = 60_000;
const BLOCKED_ORGANIZATION_REQUEST_LIMIT = 60;

/**
 * Canonicalizes the raw request target the same way Better Call does before
 * routing: its Node adapter prefixes an HTTP origin, constructs a WHATWG
 * Request, and its router reads `new URL(request.url).pathname`. This removes
 * literal and percent-encoded dot segments and treats backslashes as path
 * separators without recursively decoding `%25` escapes or encoded slashes.
 *
 * A malformed percent escape has no unambiguous path spelling. Return null so
 * the organization guard can fail closed instead of delegating a path that a
 * later adapter or version might interpret differently. Query escapes do not
 * participate in pathname routing and are deliberately left alone.
 */
function canonicalizeAuthRequestPath(rawUrl: string): string | null {
  const pathEnd = rawUrl.search(/[?#]/);
  const rawPath = pathEnd === -1 ? rawUrl : rawUrl.slice(0, pathEnd);
  if (/%(?![0-9a-fA-F]{2})/.test(rawPath)) return null;

  try {
    return new URL(`${AUTH_PATH_CANONICALIZATION_ORIGIN}${rawUrl}`).pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function isBlockedOrganizationPath(normalizedPath: string | null, allowTestSignUp: boolean) {
  return (
    normalizedPath === null ||
    (!allowTestSignUp && normalizedPath === RAW_TENANT_PROVISIONING_PATH) ||
    (normalizedPath !== null && TEAM_MUTATION_PATHS.has(normalizedPath))
  );
}

/**
 * Better Auth needs the raw (unparsed) request body — mount BEFORE any json
 * body parser is installed on the server (see main.ts: app created with
 * `{ bodyParser: false }`).
 */
export function mountAuth(
  server: Express,
  auth: Parameters<typeof toNodeHandler>[0],
  options: { allowTestSignUp?: boolean } = {},
) {
  const allowTestSignUp = options.allowTestSignUp ?? process.env.NODE_ENV === "test";
  if (allowTestSignUp && process.env.NODE_ENV !== "test") {
    throw new Error("allowTestSignUp is restricted to NODE_ENV=test");
  }
  server.all("/api/auth/sign-up/email", (_request, response, next) => {
    if (allowTestSignUp) {
      next();
      return;
    }
    response.sendStatus(404);
  });
  server.all("/api/auth/api-key/*splat", (_request, response) => {
    response.sendStatus(404);
  });
  server.all(
    "/api/auth/organization/*splat",
    rateLimit({
      windowMs: BLOCKED_ORGANIZATION_WINDOW_MS,
      limit: BLOCKED_ORGANIZATION_REQUEST_LIMIT,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      skip: (request) =>
        !isBlockedOrganizationPath(
          canonicalizeAuthRequestPath(request.originalUrl),
          allowTestSignUp,
        ),
      handler: (_request, response) => response.sendStatus(429),
    }),
    (request, response, next) => {
      const normalizedPath = canonicalizeAuthRequestPath(request.originalUrl);
      // Production tenants must go through TenantProvisioningService, which
      // atomically establishes the owner, subscription/default entitlements and
      // pickup policy. Better Auth's generic organization endpoint creates only
      // its own organization/member rows and would leave a partially-provisioned
      // tenant behind. The test bootstrap keeps it solely as an e2e fixture
      // primitive; setupAuth's test-only afterCreateOrganization hook supplies
      // the adjacent policy row those fixtures require.
      if (isBlockedOrganizationPath(normalizedPath, allowTestSignUp)) {
        response.sendStatus(404);
        return;
      }
      next();
    },
  );
  server.all("/api/auth/*splat", toNodeHandler(auth));
}
