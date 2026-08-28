import { describe, expect, it } from "vitest";
import {
  platformErrorSchema,
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
  parseTenantBillingActObjectKey,
  tenantBillingActObjectKey,
} from "../src/index.js";

describe("platform contract primitives", () => {
  it("accepts legacy tenant references and PostgreSQL timestamps", () => {
    expect(platformTenantIdSchema.parse("legacy_better_auth_org")).toBe("legacy_better_auth_org");
    expect(platformTenantIdSchema.parse("factory.eu:primary")).toBe("factory.eu:primary");
    expect(platformTimestampSchema.parse("2026-08-11 18:08:42.158")).toBe(
      "2026-08-11T18:08:42.158Z",
    );
  });

  it("canonicalizes PostgreSQL UUID aliases before they reach locks or persistence", () => {
    expect(platformUuidSchema.parse("A1111111-1111-4111-8111-111111111111")).toBe(
      "a1111111-1111-4111-8111-111111111111",
    );
  });

  it.each([
    "../tenant",
    "tenant/child",
    "tenant\\child",
    "tenant%2fchild",
    "tenant\u0000child",
    ".tenant",
    "tenant..child",
  ])("rejects an ambiguous tenant object-key segment: %j", (tenantId) => {
    expect(platformTenantIdSchema.safeParse(tenantId).success).toBe(false);
  });

  it("round-trips the one canonical act key for safe tenant segments and UUID aliases", () => {
    const actId = "A1111111-1111-4111-8111-111111111111";
    const documentId = "B1111111-1111-4111-8111-111111111111";
    const key = tenantBillingActObjectKey("factory.eu:primary", actId, documentId);
    expect(key).toBe(
      "tenant-billing/factory.eu:primary/acts/a1111111-1111-4111-8111-111111111111/b1111111-1111-4111-8111-111111111111.pdf",
    );
    expect(parseTenantBillingActObjectKey(key)).toEqual({
      tenantId: "factory.eu:primary",
      actId: actId.toLowerCase(),
      documentId: documentId.toLowerCase(),
    });
    expect(parseTenantBillingActObjectKey(`${key}.bak`)).toBeNull();
    expect(parseTenantBillingActObjectKey(key.replace("factory.eu", "factory%2Feu"))).toBeNull();
  });

  it("requires a machine code and request id for errors", () => {
    expect(
      platformErrorSchema.parse({
        code: "tenant_not_found",
        message: "Tenant not found",
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toMatchObject({ code: "tenant_not_found" });
  });
});
