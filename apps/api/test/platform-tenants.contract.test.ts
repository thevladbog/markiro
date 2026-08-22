import { describe, expect, it } from "vitest";
import { platformTenantContracts } from "@markiro/platform-contracts";

import { serializeTenantListTimestamp } from "../src/modules/platform-tenants/platform-tenants.service.js";
import { parsePlatformResponse } from "../src/platform-http/platform-response.js";

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

  it("parses service results through the shared success schema", () => {
    expect(
      parsePlatformResponse(platformTenantContracts.list.response, {
        items: [
          {
            id: "legacy_better_auth_org",
            name: "Старое производство",
            slug: "legacy-factory",
            createdAt: "2026-08-11 18:08:42.158",
            subscriptionStatus: "unmanaged",
          },
        ],
        page: 1,
        limit: 50,
        total: 1,
      }),
    ).toMatchObject({
      items: [
        {
          id: "legacy_better_auth_org",
          createdAt: "2026-08-11T18:08:42.158Z",
          subscriptionStatus: "unmanaged",
        },
      ],
    });
  });
});
