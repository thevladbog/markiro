import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import type { Db } from "./client.js";
import {
  platformAccounts,
  platformSessions,
  platformTwoFactors,
  platformUsers,
  platformVerifications,
} from "./schema/platform-auth.js";

const platformAuthSchema = {
  user: platformUsers,
  session: platformSessions,
  account: platformAccounts,
  verification: platformVerifications,
  twoFactor: platformTwoFactors,
};

/**
 * The explicit BetterAuthOptions widening mirrors auth-config.ts and prevents
 * declaration emit from expanding the two-factor plugin's internal zod types.
 * Platform consumers intentionally use only the base session/password APIs;
 * browser clients call plugin endpoints through the mounted HTTP handler.
 */
function buildPlatformAuthImpl(db: Db, options: BuildPlatformAuthOptions) {
  return betterAuth<BetterAuthOptions>({
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: "/api/platform-auth",
    trustedOrigins: options.trustedOrigins,
    database: drizzleAdapter(db, { provider: "pg", schema: platformAuthSchema }),
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "support",
          input: false,
        },
        status: {
          type: "string",
          required: false,
          defaultValue: "invited",
          input: false,
        },
      },
    },
    emailAndPassword: { enabled: true },
    advanced: {
      disableOriginCheck: false,
      cookiePrefix: "markiro-platform",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      },
    },
    plugins: [twoFactor({ issuer: "Markiro Platform", totpOptions: {} })],
  });
}

export type PlatformAuth = ReturnType<typeof buildPlatformAuthImpl>;

export interface BuildPlatformAuthOptions {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
}

export function buildPlatformAuth(db: Db, options: BuildPlatformAuthOptions): PlatformAuth {
  return buildPlatformAuthImpl(db, options);
}
