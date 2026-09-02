import { describe, expect, it } from "vitest";

import { platformNationalCatalogContracts } from "../src/national-catalog.js";

describe("platform National Catalog contracts", () => {
  it("keeps refresh and activation payloads strict", () => {
    expect(
      platformNationalCatalogContracts.refresh.body.safeParse({ sourceTenantId: "tenant-a" })
        .success,
    ).toBe(true);
    expect(
      platformNationalCatalogContracts.refresh.body.safeParse({
        sourceTenantId: "tenant-a",
        token: "secret",
      }).success,
    ).toBe(false);
    expect(
      platformNationalCatalogContracts.activate.params.safeParse({
        id: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(true);
    expect(
      platformNationalCatalogContracts.reviewGroupMapping.body.safeParse({
        state: "exact",
        schemaVersionIds: ["00000000-0000-4000-8000-000000000001"],
      }).success,
    ).toBe(true);
    expect(
      platformNationalCatalogContracts.reviewGroupMapping.body.safeParse({
        state: "ambiguous",
        schemaVersionIds: ["00000000-0000-4000-8000-000000000001"],
      }).success,
    ).toBe(false);
    expect(
      platformNationalCatalogContracts.reviewAttributeMappings.body.safeParse({
        mappings: [
          {
            sourceAttributeId: "good_name",
            targetField: "print_name",
            conversion: { kind: "string_trim" },
            mappingVersion: 1,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      platformNationalCatalogContracts.reviewAttributeMappings.body.safeParse({
        mappings: [
          {
            sourceAttributeId: "2478",
            targetField: "name",
            conversion: { kind: "identity" },
            mappingVersion: 1,
          },
          {
            sourceAttributeId: "good_name",
            targetField: "name",
            conversion: { kind: "string_trim" },
            mappingVersion: 1,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects provider payloads and unknown result keys", () => {
    expect(
      platformNationalCatalogContracts.refresh.response.safeParse({
        categories: 1,
        observed: 1,
        unchanged: 0,
        blocked: 0,
        failed: 0,
        raw: {},
      }).success,
    ).toBe(false);
  });
});
