import { buildPlatformAuth, type Db, type PlatformAuth } from "@markiro/db";
import { toNodeHandler } from "better-auth/node";
import type { Express } from "express";
import { platformAllowedOrigins, type Env } from "../env";

export const PLATFORM_AUTH = "PLATFORM_AUTH";

export interface PlatformAuthSetup {
  platformAuth: PlatformAuth;
}

export function setupPlatformAuth(env: Env, db: Db): PlatformAuthSetup {
  return {
    platformAuth: buildPlatformAuth(db, {
      secret: env.PLATFORM_AUTH_SECRET,
      baseURL: env.PLATFORM_AUTH_URL,
      trustedOrigins: platformAllowedOrigins(env),
    }),
  };
}

/** Mount before JSON parsing so Better Auth receives the raw request body. */
export function mountPlatformAuth(
  server: Express,
  auth: PlatformAuth,
  options: { allowTestSignUp?: boolean } = {},
): void {
  const allowTestSignUp = options.allowTestSignUp ?? process.env.NODE_ENV === "test";
  if (allowTestSignUp && process.env.NODE_ENV !== "test") {
    throw new Error("allowTestSignUp is restricted to NODE_ENV=test");
  }
  server.all("/api/platform-auth/sign-up/email", (_request, response, next) => {
    if (allowTestSignUp) {
      next();
      return;
    }
    response.sendStatus(404);
  });
  server.all("/api/platform-auth/*splat", toNodeHandler(auth));
}
