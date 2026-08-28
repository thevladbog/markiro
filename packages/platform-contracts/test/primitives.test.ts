import { describe, expect, it } from "vitest";
import {
  platformErrorSchema,
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
  parseTenantBillingActObjectKey,
  parseTenantBillingRequestAttachmentObjectKey,
  tenantBillingActObjectKey,
  tenantBillingRequestAttachmentObjectKey,
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
  ])("preserves an opaque tenant id independently from its object-key encoding: %j", (tenantId) => {
    expect(platformTenantIdSchema.parse(tenantId)).toBe(tenantId);
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

  it("round-trips encoded opaque tenant ids for acts and request attachments", () => {
    const tenantId = "Производство / линия % A";
    const requestId = "C1111111-1111-4111-8111-111111111111";
    const attachmentId = "D1111111-1111-4111-8111-111111111111";
    const actId = "A1111111-1111-4111-8111-111111111111";
    const documentId = "B1111111-1111-4111-8111-111111111111";

    const actKey = tenantBillingActObjectKey(tenantId, actId, documentId);
    const attachmentKey = tenantBillingRequestAttachmentObjectKey(
      tenantId,
      requestId,
      attachmentId,
    );

    expect(actKey).toMatch(/^tenant-billing\/~u[0-9a-f]+\/acts\//);
    expect(attachmentKey).toMatch(/^tenant-billing\/~u[0-9a-f]+\/requests\//);
    expect(parseTenantBillingActObjectKey(actKey)?.tenantId).toBe(tenantId);
    expect(parseTenantBillingRequestAttachmentObjectKey(attachmentKey)).toEqual({
      tenantId,
      requestId: requestId.toLowerCase(),
      attachmentId: attachmentId.toLowerCase(),
    });

    expect(parseTenantBillingActObjectKey(actKey.replace("~u", "~U"))).toBeNull();
    expect(parseTenantBillingActObjectKey(actKey.replace("~u", "%7Eu"))).toBeNull();
    expect(parseTenantBillingRequestAttachmentObjectKey(`${attachmentKey}/..`)).toBeNull();
  });

  it("keeps existing safe request-attachment keys byte-for-byte compatible", () => {
    const key = tenantBillingRequestAttachmentObjectKey(
      "legacy_better-auth.org:primary",
      "C1111111-1111-4111-8111-111111111111",
      "D1111111-1111-4111-8111-111111111111",
    );
    expect(key).toBe(
      "tenant-billing/legacy_better-auth.org:primary/requests/c1111111-1111-4111-8111-111111111111/d1111111-1111-4111-8111-111111111111",
    );
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
