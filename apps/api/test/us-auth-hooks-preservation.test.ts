import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
const oldimports =
  'import { betterAuth, type BetterAuthOptions } from "better-auth";\nimport { createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";\nimport { organization, twoFactor } from "better-auth/plugins";\nimport { and, eq, lte, sql } from "drizzle-orm";\nimport { schema, type Db } from "@markiro/db";\nimport { usAuthAdapter } from "./us-auth-adapter";\nimport { isUsSessionAssured } from "./us-principal";\nimport { usAuthError, usAuthErrorCode } from "./us-auth-error";\n\n';
const newimports =
  'import { betterAuth, type BetterAuthOptions } from "better-auth";\nimport { organization, twoFactor } from "better-auth/plugins";\nimport type { Db } from "@markiro/db";\nimport { usAuthAdapter } from "./us-auth-adapter";\nimport { createUsAuthHooks } from "./us-auth-hooks";\n\n';
const verification =
  'const verificationPaths = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);\n';
const prefix =
  'import type { BetterAuthOptions } from "better-auth";\nimport { createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";\nimport { and, eq, lte, sql } from "drizzle-orm";\nimport { schema, type Db } from "@markiro/db";\nimport { isUsSessionAssured } from "./us-principal";\nimport { usAuthError, usAuthErrorCode } from "./us-auth-error";\n\nconst verificationPaths = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);\n\n/** Shared assurance hooks only; no auth construction or origin/cookie policy. */\nexport function createUsAuthHooks(db: Db): NonNullable<BetterAuthOptions["hooks"]> {\n  return {\n';
const suffix = "  };\n}\n";
const bodySha = "76c80c3c9d2402357435a98172eceab40f242db3790b36996af8529fa491cc81";
const originalSha = "c1ac42532d4ad7f26783b09f5916fa175c0e201071c20f8f8307c0b8901e8ba2";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function restore(local: string, hooks: string) {
  expect(hooks.startsWith(prefix)).toBe(true);
  expect(hooks.endsWith(suffix)).toBe(true);
  const formattedEnrollment =
    '      const enrollment =\n        "usEnrollmentVerification" in ctx.context && ctx.context.usEnrollmentVerification === true;\n      if (isAPIError(ctx.context.returned)) {';
  const originalEnrollment =
    '      const enrollment =\n        "usEnrollmentVerification" in ctx.context &&\n        ctx.context.usEnrollmentVerification === true;\n      if (isAPIError(ctx.context.returned)) {';
  expect(hooks.split(formattedEnrollment)).toHaveLength(2);
  const restoredHooks = hooks.replace(formattedEnrollment, originalEnrollment);
  const body = restoredHooks
    .slice(prefix.length, -suffix.length)
    .split("\n")
    .map((line) => (line ? "  " + line : line))
    .join("\n");
  expect(digest(body)).toBe(bodySha);
  expect(local.split(newimports)).toHaveLength(2);
  const delegation = "    hooks: createUsAuthHooks(db),";
  expect(local.split(delegation)).toHaveLength(2);
  expect(local.split("const routes = new Map([")).toHaveLength(2);
  const original = local
    .replace(newimports, oldimports)
    .replace("const routes = new Map([", verification + "const routes = new Map([")
    .replace(delegation, "    hooks: {\n" + body + "    },");
  expect(digest(original)).toBe(originalSha);
}
const read = (name: string) =>
  readFileSync(resolve(__dirname, "../src/modules/traceability/auth", name), "utf8");
it("restores the complete original guarded factory and hooks", () => {
  restore(read("us-auth.ts"), read("us-auth-hooks.ts"));
});
it.each([
  ["+ 1 >= 10", "+ 1 >= 11"],
  ["15 * 60 * 1000", "16 * 60 * 1000"],
  ["body.trustDevice", "false"],
  ["eq(schema.user.twoFactorEnabled, true)", "eq(schema.user.twoFactorEnabled, false)"],
])("rejects assurance hook mutation %s", (before, after) => {
  const hooks = read("us-auth-hooks.ts");
  expect(hooks.split(before)).toHaveLength(2);
  expect(() => restore(read("us-auth.ts"), hooks.replace(before, after))).toThrow();
});
it("rejects local policy mutation", () => {
  const local = read("us-auth.ts");
  expect(local.split("secure: false")).toHaveLength(2);
  expect(() =>
    restore(local.replace("secure: false", "secure: true"), read("us-auth-hooks.ts")),
  ).toThrow();
});
