import { betterAuth, type BetterAuthOptions } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";
import type { Db } from "@markiro/db";
import { usAuthAdapter } from "./us-auth-adapter";
import { createUsAuthHooks } from "./us-auth-hooks";
import {
  assertUsHostedRelease,
  usHostedReleaseIdentity,
} from "../../../deployment/us-hosted-release-verifier";
import {
  assertUsHostedMaterial,
  usHostedApiMaterial,
} from "../../../deployment/us-hosted-material-owner";

function admitted(release: unknown, material: unknown) {
  try {
    assertUsHostedRelease(release);
    assertUsHostedMaterial(material, release, "api");
    const config = usHostedReleaseIdentity(release).config;
    const values = usHostedApiMaterial(material, release);
    if (config.service !== "api" || values.authSecret.trim().length < 32) throw new Error();
    return { config, values };
  } catch {
    throw new Error("us_hosted_auth_invalid");
  }
}

/** Hosted API admission is separate from the unchanged local auth foundation. */
export function createUsHostedAuth(release: unknown, material: unknown, db: Db) {
  const { config, values } = admitted(release, material);
  return betterAuth<BetterAuthOptions>({
    appName: "Markiro US",
    secret: values.authSecret,
    baseURL: config.publicOrigin,
    basePath: "/api/us-auth",
    // Library error logs may contain SQL parameters (including session tokens).
    // Let the US boundary redact failures instead of logging raw adapter errors.
    logger: { disabled: true },
    onAPIError: { throw: true },
    trustedOrigins: [config.publicOrigin],
    database: usAuthAdapter(db),
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: { cookieCache: { enabled: false } },
    // Better Auth otherwise disables its limiter in development/test.
    rateLimit: { enabled: true },
    advanced: {
      disableOriginCheck: false,
      cookiePrefix: "markiro-us",
      // Native HTTPS supplies the protocol. Ignore caller-supplied forwarding
      // headers and retain the shared per-path bucket on this private listener.
      ipAddress: { ipAddressHeaders: [] },
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
    },
    plugins: [
      organization({ allowUserToCreateOrganization: false }),
      twoFactor({ issuer: "Markiro US" }),
    ],
    hooks: createUsAuthHooks(db),
  });
}
