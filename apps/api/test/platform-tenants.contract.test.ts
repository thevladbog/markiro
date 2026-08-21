import { describe, expect, it } from "vitest";

import { serializeTenantListTimestamp } from "../src/modules/platform-tenants/platform-tenants.service.js";

describe("platform tenant list contract", () => {
  it("serializes both Drizzle dates and raw PostgreSQL timestamps as ISO UTC strings", () => {
    expect(serializeTenantListTimestamp(new Date("2026-08-11T18:08:42.158Z"))).toBe(
      "2026-08-11T18:08:42.158Z",
    );
    expect(serializeTenantListTimestamp("2026-08-11 18:08:42.158")).toBe(
      "2026-08-11T18:08:42.158Z",
    );
    expect(serializeTenantListTimestamp("2026-08-11 18:08:42.158+00")).toBe(
      "2026-08-11T18:08:42.158Z",
    );
  });

  it("preserves nullable subscription boundaries", () => {
    expect(serializeTenantListTimestamp(null)).toBeNull();
  });
});
