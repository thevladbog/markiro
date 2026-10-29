import { betterAuth, type BetterAuthOptions } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";
import type { Db } from "@markiro/db";
import { usAuthAdapter } from "./us-auth-adapter";
import { createUsAuthHooks } from "./us-auth-hooks";

interface UsAuthOptions {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
}

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
    hooks: createUsAuthHooks(db),
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
