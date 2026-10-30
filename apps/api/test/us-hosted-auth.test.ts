import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type * as AuthLibrary from "better-auth";
const authFactory = vi.hoisted(() => vi.fn());
vi.mock("better-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthLibrary>()),
  betterAuth: authFactory,
}));
import type { UsAuth } from "../src/modules/traceability/auth/us-auth";
import { createUsHostedAuth } from "../src/modules/traceability/auth/us-hosted-auth";

it("rejects forged owners before invoking the auth library or observing a database", () => {
  authFactory.mockClear();
  try {
    // @ts-expect-error Deliberately invalid database must remain unobserved behind release refusal.
    expect(() => createUsHostedAuth({}, {}, undefined)).toThrow("us_hosted_auth_invalid");
    expect(authFactory).not.toHaveBeenCalled();
  } finally {
    authFactory.mockClear();
  }
});
it("preserves the complete local auth construction except reviewed origin and secure-cookie substitutions", () => {
  const folder = resolve(__dirname, "../src/modules/traceability/auth");
  const local = readFileSync(resolve(folder, "us-auth.ts"), "utf8");
  const hosted = readFileSync(resolve(folder, "us-hosted-auth.ts"), "utf8");
  const body = (source: string) =>
    source.slice(
      source.indexOf("  return betterAuth<BetterAuthOptions>({"),
      source.indexOf("\n}", source.indexOf("  return betterAuth<BetterAuthOptions>({")),
    );
  const restored = body(hosted)
    .replace("secret: values.authSecret", "secret: options.secret")
    .replace("baseURL: config.publicOrigin", "baseURL: options.baseURL")
    .replace("trustedOrigins: [config.publicOrigin]", "trustedOrigins: [...options.trustedOrigins]")
    .replace("secure: true", "secure: false")
    .replace(
      "// Native HTTPS supplies the protocol. Ignore caller-supplied forwarding\n      // headers and retain the shared per-path bucket on this private listener.",
      "// No proxy is part of this loopback-only foundation. Ignore caller-supplied\n      // forwarding headers and use the shared per-path bucket on this local server.",
    );
  expect(restored).toBe(body(local));
  expect(createHash("sha256").update(local).digest("hex")).toBe(
    "aa163fcf815d2df4d653e41bbc6667c38c177e678d3eab249ed30c57b463fd76",
  );
});

const handlerCompatible: ReturnType<typeof createUsHostedAuth> extends UsAuth ? true : false = true;
it("retains the existing allowlisted auth handler type", () => {
  expect(handlerCompatible).toBe(true);
});
