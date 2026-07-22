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
function buildAuthImpl(db: Db, opts: { secret: string; baseURL: string }) {
  return betterAuth<BetterAuthOptions>({
    secret: opts.secret,
    baseURL: opts.baseURL,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: true },
    plugins: [organization(), apiKey()],
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

/**
 * Narrowed Auth: identical to the widened base except `api.getSession`, which is
 * re-typed to expose the organization plugin's session fields. The
 * `<BetterAuthOptions>` widening in `buildAuthImpl` erases plugin type additions
 * (TS2883 workaround) — this companion type restores the one contract
 * downstream tasks depend on.
 * Update `SessionWithActiveOrg` if the plugin set changes.
 */
export type Auth = Omit<AuthBase, "api"> & {
  api: Omit<AuthBase["api"], "getSession"> & {
    getSession(input: { headers: Headers }): Promise<SessionWithActiveOrg | null>;
  };
};

export function buildAuth(db: Db, opts: { secret: string; baseURL: string }): Auth {
  return buildAuthImpl(db, opts);
}
