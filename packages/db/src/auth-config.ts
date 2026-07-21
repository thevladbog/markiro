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
export function buildAuth(db: Db, opts: { secret: string; baseURL: string }) {
  return betterAuth<BetterAuthOptions>({
    secret: opts.secret,
    baseURL: opts.baseURL,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: true },
    plugins: [organization(), apiKey()],
  });
}
export type Auth = ReturnType<typeof buildAuth>;
