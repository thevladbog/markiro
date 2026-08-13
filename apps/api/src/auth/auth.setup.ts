import { toNodeHandler } from "better-auth/node";
import type { Express } from "express";
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

/**
 * Better Auth needs the raw (unparsed) request body — mount BEFORE any json
 * body parser is installed on the server (see main.ts: app created with
 * `{ bodyParser: false }`).
 */
export function mountAuth(
  server: Express,
  auth: AuthSetup["auth"],
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
  server.all("/api/auth/organization/*splat", (request, response, next) => {
    const normalizedPath = request.path.replace(/\/+$/, "");
    if (TEAM_MUTATION_PATHS.has(normalizedPath)) {
      response.sendStatus(404);
      return;
    }
    next();
  });
  server.all("/api/auth/*splat", toNodeHandler(auth));
}
