import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../src/schema.js";

describe("US MFA persistence", () => {
  it("adds opt-in MFA without enabling it for existing cabinet users", () => {
    expect(schema.user).toHaveProperty("twoFactorEnabled");
    expect(schema.user.twoFactorEnabled.default).toBe(false);
    expect(schema.user.twoFactorEnabled.notNull).toBe(true);
  });

  it("binds assurance to a session and a replaceable factor with cascading deletion", () => {
    expect(schema).toHaveProperty("usTwoFactors");
    expect(schema).toHaveProperty("usSessionAssurances");
    expect(schema.usSessionAssurances.sessionId.primary).toBe(true);
    expect(getTableConfig(schema.usSessionAssurances).foreignKeys.map((fk) => fk.onDelete)).toEqual(
      ["cascade", "cascade"],
    );
    expect(schema.usTwoFactors.verified.default).toBe(false);
  });
});
