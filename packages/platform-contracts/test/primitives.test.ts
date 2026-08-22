import { describe, expect, it } from "vitest";
import {
  platformErrorSchema,
  platformTenantIdSchema,
  platformTimestampSchema,
} from "../src/index.js";

describe("platform contract primitives", () => {
  it("accepts legacy tenant references and PostgreSQL timestamps", () => {
    expect(platformTenantIdSchema.parse("legacy_better_auth_org")).toBe("legacy_better_auth_org");
    expect(platformTimestampSchema.parse("2026-08-11 18:08:42.158")).toBe(
      "2026-08-11T18:08:42.158Z",
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
