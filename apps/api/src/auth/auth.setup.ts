import { toNodeHandler } from "better-auth/node";
import type { Express } from "express";
import { buildAuth, createDb, type Auth } from "@markiro/db";
import { sessionAllowedOrigins, type Env } from "../env";

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
  const auth = buildAuth(db, {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // Exactly the list the CORS middleware applies to non-kiosk routes, on
    // purpose -- /api/auth/* is one of those routes, so the two describe the
    // same surface and must not drift (see `sessionAllowedOrigins`).
    // KIOSK_ORIGIN is NOT here: the kiosk calls no /api/auth/* route at all
    // (it authenticates with a device token), so trusting it would only widen
    // what an attacker on that origin can do with an admin's session.
    trustedOrigins: sessionAllowedOrigins(env),
  });
  return { db, pool, auth };
}

export type AuthSetup = ReturnType<typeof setupAuth>;

/**
 * Better Auth needs the raw (unparsed) request body — mount BEFORE any json
 * body parser is installed on the server (see main.ts: app created with
 * `{ bodyParser: false }`).
 */
export function mountAuth(server: Express, auth: AuthSetup["auth"]) {
  server.all("/api/auth/api-key/*splat", (_request, response) => {
    response.sendStatus(404);
  });
  server.all("/api/auth/*splat", toNodeHandler(auth));
}
