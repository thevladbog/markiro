import { apiKey } from "@better-auth/api-key";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import type { Db } from "./client.js";
import * as authSchema from "./schema/auth.js";

// The explicit `<BetterAuthOptions>` type argument (instead of letting it be
// inferred from the options object) works around a TypeScript declaration-emit
// limitation (TS2883) triggered by `@better-auth/api-key`'s zod-derived types:
// with inference, the compiler cannot print a portable name for an internal
// zod `$strip` type in the generated .d.ts. Widening to the base
// `BetterAuthOptions` avoids expanding that unnameable type.
//
// The tradeoff: widening to the base `BetterAuthOptions` erases the
// plugin-specific type additions (e.g. the `organization` plugin's
// `activeOrganizationId` session field), because `Auth<Options>["api"]["getSession"]`
// is derived from the literal `Options` type, not the runtime plugin list.
// `buildAuth`/`Auth` below restore that one contract with a narrow companion
// type layered back on top, without reintroducing the unnameable-type problem.
function buildAuthImpl(
  db: Db,
  opts: { secret: string; baseURL: string; trustedOrigins?: string[] },
) {
  return betterAuth<BetterAuthOptions>({
    secret: opts.secret,
    baseURL: opts.baseURL,
    // Enforced by better-auth's own origin-check middleware (see
    // apps/api/test/cors.e2e.test.ts for the pinned, verified behavior --
    // including a documented gotcha where better-auth *itself* skips this
    // enforcement whenever it detects a test runner).
    trustedOrigins: opts.trustedOrigins,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: true },
    plugins: [
      organization(),
      apiKey([
        {
          configId: "station",
          defaultPrefix: "mk_",
          references: "organization",
          // Station enrollment (Task 6) tags minted keys with
          // `metadata: { kind: "station" }`; the plugin rejects any
          // `metadata` on createApiKey unless explicitly enabled per config.
          enableMetadata: true,
        },
      ]),
    ],
  });
}

/**
 * The session shape downstream code relies on (the `organization` plugin adds
 * `activeOrganizationId` to the session record returned by `getSession`).
 */
export interface SessionWithActiveOrg {
  session: { activeOrganizationId?: string | null } & Record<string, unknown>;
  user: { id: string } & Record<string, unknown>;
}

type AuthBase = ReturnType<typeof buildAuthImpl>;

/** Result of an api-key verification (apiKey plugin). */
export interface VerifyApiKeyResult {
  valid: boolean;
  error: { message: string; code: string } | null;
  key: { id: string; referenceId: string; enabled: boolean | null } | null;
}

/** Minimal created-api-key shape (apiKey plugin) used by device enrollment. */
export interface CreatedApiKey {
  id: string;
  key: string;
  referenceId: string;
}

/**
 * Narrowed Auth: identical to the widened base except `api.getSession`, which is
 * re-typed to expose the organization plugin's session fields, plus the
 * `apiKey` plugin's `verifyApiKey`/`createApiKey` endpoints. The
 * `<BetterAuthOptions>` widening in `buildAuthImpl` erases plugin type additions
 * (TS2883 workaround) — this companion type restores the contract downstream
 * tasks depend on. `verifyApiKey`/`createApiKey` don't exist at all on the
 * widened `AuthBase["api"]` (they're plugin-only endpoints, unlike the
 * always-present `getSession`), so `buildAuth` below casts through `unknown`
 * to attach them; the runtime object always has them because the `apiKey()`
 * plugin is unconditionally registered in `buildAuthImpl`.
 * Update `SessionWithActiveOrg` if the plugin set changes.
 */
export type Auth = Omit<AuthBase, "api"> & {
  api: Omit<AuthBase["api"], "getSession"> & {
    getSession(input: { headers: Headers }): Promise<SessionWithActiveOrg | null>;
    // `configId` is required here in practice: our single "station" apiKey
    // configuration has no `configId: "default"` fallback, so
    // `verifyApiKey({ body: { key } })` without it throws
    // NO_DEFAULT_API_KEY_CONFIGURATION_FOUND (verified against the running
    // plugin -- see task-5-report.md). Callers must pass `configId: "station"`.
    verifyApiKey(input: {
      body: { key: string; configId?: string };
    }): Promise<VerifyApiKeyResult>;
    createApiKey(input: {
      body: {
        configId?: string;
        name?: string;
        userId?: string;
        organizationId?: string;
        metadata?: Record<string, unknown>;
      };
    }): Promise<CreatedApiKey>;
  };
};

export function buildAuth(
  db: Db,
  opts: { secret: string; baseURL: string; trustedOrigins?: string[] },
): Auth {
  return buildAuthImpl(db, opts) as unknown as Auth;
}
