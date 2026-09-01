import { describe, expect, it, vi } from "vitest";

import {
  NationalCatalogSchemaService,
  type NationalCatalogSchemaRepository,
} from "../src/modules/national-catalog/national-catalog-schema.service";
import type { NationalCatalogClient } from "../src/modules/national-catalog/national-catalog.client";
import type { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";

const category = {
  id: 10,
  name: "Пиво",
  parentId: null,
  level: 1,
  active: true,
  gismtCodes: [7],
  raw: { cat_id: 10 },
};

const attribute = {
  id: 20,
  groupId: 1,
  groupName: "Основные",
  name: "Тип",
  presetOnly: false,
  multiplicity: false,
  multiplicityType: null,
  fieldType: "text" as const,
  valueTypes: [],
  dependentAttributes: [],
  firstLayer: true,
  secondLayer: false,
  type: "m",
  preset: [],
  presetUrl: null,
  raw: { attr_id: 20 },
};

function subject(
  options: { attributesStatus?: "ok" | "invalid_response"; inserted?: boolean } = {},
) {
  const repository: NationalCatalogSchemaRepository = {
    observe: vi.fn(async () => ({ inserted: options.inserted ?? true })),
    activate: vi.fn(),
    reviewGroupMapping: vi.fn(),
    reviewAttributeMappings: vi.fn(),
  };
  const client = {
    listCategories: vi.fn(async () => ({
      status: "ok",
      value: { categories: [category] },
      etag: null,
      contentHash: "categories",
      usage: { total: null, method: null },
    })),
    getAttributes: vi.fn(async () =>
      options.attributesStatus === "invalid_response"
        ? { status: "invalid_response" }
        : {
            status: "ok",
            value: { attributes: [attribute] },
            etag: '"attributes"',
            contentHash: "attributes",
            usage: { total: null, method: null },
          },
    ),
  } as unknown as NationalCatalogClient;
  const tokens = {
    getActiveToken: vi.fn(async () => ({
      status: "ok",
      auth: { baseUrl: "https://true-api.example", token: "secret" },
      obtainedAt: new Date(),
    })),
  } as unknown as ChzTokenService;
  return {
    service: new NationalCatalogSchemaService(
      repository,
      client,
      tokens,
      "https://catalog.example",
      "source-tenant",
    ),
    repository,
    client,
  };
}

describe("NationalCatalogSchemaService", () => {
  it("discovers attributes per active category and persists an observed v2 schema", async () => {
    const test = subject();
    await expect(test.service.refresh("source-tenant")).resolves.toEqual({
      categories: 1,
      observed: 1,
      unchanged: 0,
      blocked: 0,
      failed: 0,
    });
    expect(test.client.getAttributes).toHaveBeenCalledWith(
      { baseUrl: "https://catalog.example", token: "secret" },
      { catId: 10 },
    );
    expect(test.repository.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: "national-catalog:category:10",
        categoryId: "10",
        categoryName: "Пиво",
        gismtCodes: [7],
        status: "observed",
        definition: expect.objectContaining({ formatVersion: 2 }),
      }),
    );
  });

  it("is idempotent and records a category read failure without inventing a schema", async () => {
    const unchanged = subject({ inserted: false });
    await expect(unchanged.service.refresh("source-tenant")).resolves.toMatchObject({
      unchanged: 1,
      observed: 0,
    });

    const failed = subject({ attributesStatus: "invalid_response" });
    await expect(failed.service.refresh("source-tenant")).resolves.toEqual({
      categories: 1,
      observed: 0,
      unchanged: 0,
      blocked: 0,
      failed: 1,
    });
    expect(failed.repository.observe).not.toHaveBeenCalled();
  });

  it("rejects a source tenant other than the deployment-reviewed tenant before token access", async () => {
    const test = subject();
    await expect(test.service.refresh("other-tenant")).rejects.toMatchObject({
      response: { code: "NATIONAL_CATALOG_SOURCE_TENANT_MISMATCH" },
    });
    expect(test.client.listCategories).not.toHaveBeenCalled();
  });
});
