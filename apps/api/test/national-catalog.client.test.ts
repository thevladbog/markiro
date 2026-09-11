import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  NATIONAL_CATALOG_RESPONSE_BYTE_LIMITS,
  NationalCatalogClient,
  type NationalCatalogClientDependencies,
} from "../src/modules/national-catalog/national-catalog.client";

const auth = { baseUrl: "https://catalog.example.test", token: "catalog-token" };
const listRequest = {
  updatedFrom: "2026-09-01 00:00:00",
  updatedTo: "2026-09-08 12:00:00",
  offset: 0,
  limit: 2,
};

function contentHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function dependencies(
  fetchImpl: NationalCatalogClientDependencies["fetch"],
  scheduleAbort: NationalCatalogClientDependencies["scheduleAbort"] = () => () => {},
): NationalCatalogClientDependencies {
  return { fetch: fetchImpl, scheduleAbort };
}

const categoryPayload = {
  apiversion: 3,
  result: [
    {
      cat_id: 30064,
      cat_name: "Продовольственные товары",
      cat_parent_id: 30062,
      cat_level: 2,
      category_active: true,
      gismt_codes: [7],
      provider_only: "kept out of the normalized record",
    },
  ],
};

const attributePayload = {
  apiversion: 3,
  result: [
    {
      attr_group_id: 103,
      attr_name: "Тип парфюмерии",
      attr_preset_only: false,
      attr_multiplicity: false,
      attr_multiplicity_type: null,
      attr_id: 1034,
      attr_group_name: "Потребительские свойства",
      attr_field_type: "text",
      attr_value_type: [],
      dependent_attributes: [],
      first_layer: false,
      second_layer: true,
      attr_type: "m",
      attr_preset: ["ДУХИ"],
      provider_only: "kept out of the normalized record",
    },
  ],
};

const productPayload = {
  apiversion: 3,
  result: [
    {
      good_id: 720679,
      good_name: "Чешки детские",
      good_status: "published",
      identified_by: [
        {
          value: "0000000000001",
          type: "gtin",
          multiplier: 1 as number | string | null,
          level: "trade-unit",
        },
      ],
      categories: [{ cat_id: 30064, cat_name: "Продовольственные товары" }],
      good_attrs: [
        {
          attr_id: 13933,
          attr_name: "Код ТНВЭД",
          attr_value: "6202930000",
          attr_value_id: 0 as number | string | null,
          value_id: 0 as number | string | null,
          attr_value_type: "",
          attr_group_id: 22,
          attr_group_name: "Нормативно-сопроводительная документация",
          multiplier: null as number | string | null,
        },
      ],
      provider_only: "kept out of the normalized record",
    },
  ],
};

describe("NationalCatalogClient", () => {
  it("does not interpret an oversized period as an empty catalogue", async () => {
    const client = new NationalCatalogClient(
      dependencies(async () => new Response("", { status: 413 })),
    );

    await expect(
      client.listOwnProducts(auth, {
        updatedFrom: "1970-01-01 00:00:00",
        updatedTo: "2026-09-08 12:00:00",
        offset: 0,
        limit: 1000,
      }),
    ).resolves.toEqual({ status: "selection_too_large" });
  });

  it("reads an own-product page with raw statuses and one GTIN per provider row", async () => {
    const rows = [
      {
        good_id: 720679,
        gtin: "0000000000001",
        good_name: "Чешки детские",
        brand_name: "Фабрика",
        good_status: "provider-future-status",
        good_detailed_status: ["draft", "notsigned", "provider-future-detail"],
        provider_only: "kept in raw",
      },
      {
        good_id: 720679,
        gtin: "04600000000017",
        good_name: "Чешки детские",
        brand_name: "Фабрика",
        good_status: null,
        good_detailed_status: ["published"],
      },
    ];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const payload = {
      result: { goods: rows, total: 3, offset: 0, limit: 2 },
    };
    const client = new NationalCatalogClient(
      dependencies(async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response(JSON.stringify(payload), { status: 200 });
      }),
    );

    await expect(client.listOwnProducts(auth, listRequest)).resolves.toEqual({
      status: "ok",
      etag: null,
      contentHash: contentHash(payload),
      usage: { total: null, method: null },
      value: {
        rows: [
          {
            cardId: "720679",
            gtins: ["0000000000001"],
            name: "Чешки детские",
            brand: "Фабрика",
            status: "provider-future-status",
            detailedStatuses: ["draft", "unsigned", "provider-future-detail"],
            raw: rows[0],
          },
          {
            cardId: "720679",
            gtins: ["04600000000017"],
            name: "Чешки детские",
            brand: "Фабрика",
            status: null,
            detailedStatuses: ["published"],
            raw: rows[1],
          },
        ],
        nextOffset: 2,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://catalog.example.test/v4/product-list?from_date=2026-09-01+00%3A00%3A00&to_date=2026-09-08+12%3A00%3A00&offset=0&limit=2",
    );
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer catalog-token");
    expect(calls[0]?.url).not.toContain("catalog-token");
  });

  it("marks an own-product page complete only when returned rows reach the total", async () => {
    const payload = {
      result: {
        goods: [
          {
            good_id: 2,
            gtin: "invalid-but-visible",
            good_name: null,
            brand_name: null,
            good_status: null,
            good_detailed_status: [],
          },
        ],
        total: 2,
        offset: 1,
        limit: 1,
      },
    };
    const client = new NationalCatalogClient(
      dependencies(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );

    await expect(
      client.listOwnProducts(auth, { ...listRequest, offset: 1, limit: 1 }),
    ).resolves.toMatchObject({
      status: "ok",
      value: {
        rows: [{ cardId: "2", gtins: ["invalid-but-visible"] }],
        nextOffset: null,
      },
    });
  });

  it("rejects inconsistent, oversized, and malformed own-product pages", async () => {
    const row = {
      good_id: 1,
      gtin: "0000000000001",
      good_name: null,
      brand_name: null,
      good_status: null,
      good_detailed_status: [],
    };
    const invalidResults: unknown[] = [
      { goods: [], total: 1, offset: 0, limit: 2 },
      { goods: [row], total: 1, offset: 1, limit: 2 },
      { goods: [row], total: 1, offset: 0, limit: 1 },
      { goods: [row], total: 10_001, offset: 0, limit: 2 },
      { goods: [row], total: 1, offset: 0, limit: 3 },
      { goods: [row, row, row], total: 3, offset: 0, limit: 2 },
      { goods: [{ ...row, good_id: 0 }], total: 1, offset: 0, limit: 2 },
      { goods: [{ ...row, good_id: Number.MAX_SAFE_INTEGER + 1 }], total: 1, offset: 0, limit: 2 },
      { goods: [{ ...row, gtin: ["0000000000001"] }], total: 1, offset: 0, limit: 2 },
      { goods: [{ ...row, good_detailed_status: "published" }], total: 1, offset: 0, limit: 2 },
    ];

    for (const result of invalidResults) {
      const client = new NationalCatalogClient(
        dependencies(async () => new Response(JSON.stringify({ result }), { status: 200 })),
      );
      await expect(client.listOwnProducts(auth, listRequest)).resolves.toEqual({
        status: "invalid_response",
      });
    }
  });

  it("rejects invalid own-product request bounds before making a request", async () => {
    let calls = 0;
    const client = new NationalCatalogClient(
      dependencies(async () => {
        calls += 1;
        return new Response("", { status: 200 });
      }),
    );
    const invalidRequests = [
      { ...listRequest, updatedFrom: "2026-09-01" },
      { ...listRequest, updatedTo: "not-a-date" },
      { ...listRequest, updatedFrom: "2026-09-09 00:00:00" },
      { ...listRequest, offset: -1 },
      { ...listRequest, offset: 0.5 },
      { ...listRequest, limit: 0 },
      { ...listRequest, limit: 1001 },
      { ...listRequest, offset: 9001, limit: 1000 },
    ];

    for (const request of invalidRequests) {
      await expect(client.listOwnProducts(auth, request)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });

  it("maps own-product authorization, absence, rate, and availability failures", async () => {
    const cases = [
      { response: new Response(null, { status: 401 }), expected: { status: "unauthorized" } },
      {
        response: new Response(JSON.stringify({ message: "denied" }), { status: 403 }),
        expected: { status: "forbidden", message: "denied" },
      },
      { response: new Response(null, { status: 404 }), expected: { status: "not_found" } },
      {
        response: new Response(null, { status: 429, headers: { "Retry-After": "19" } }),
        expected: { status: "rate_limited", retryAfterSeconds: 19 },
      },
      { response: new Response(null, { status: 500 }), expected: { status: "unavailable" } },
      { response: new Response(null, { status: 503 }), expected: { status: "unavailable" } },
    ];

    for (const { response, expected } of cases) {
      const client = new NationalCatalogClient(dependencies(async () => response));
      await expect(client.listOwnProducts(auth, listRequest)).resolves.toEqual(expected);
    }
  });

  it("keeps selection-too-large handling specific to the own-product list", async () => {
    const client = new NationalCatalogClient(
      dependencies(async () => new Response("", { status: 413 })),
    );

    await expect(client.listCategories(auth)).resolves.toEqual({ status: "invalid_response" });
    await expect(client.getFeedProducts(auth, ["0000000000001"])).resolves.toEqual({
      status: "invalid_response",
    });
  });

  it("rejects an own-product response declared above its method byte limit", async () => {
    const client = new NationalCatalogClient(
      dependencies(
        async () =>
          new Response("{}", {
            status: 200,
            headers: {
              "Content-Length": String(NATIONAL_CATALOG_RESPONSE_BYTE_LIMITS.list + 1),
            },
          }),
      ),
    );

    await expect(client.listOwnProducts(auth, listRequest)).resolves.toEqual({
      status: "invalid_response",
    });
  });

  it("reads categories with the bearer, ETag cache validator, and a normalized result", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new NationalCatalogClient(
      dependencies(async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response(JSON.stringify(categoryPayload), {
          status: 200,
          headers: { ETag: '"categories-v1"' },
        });
      }),
    );

    await expect(client.listCategories(auth, { ifNoneMatch: '"categories-v0"' })).resolves.toEqual({
      status: "ok",
      etag: '"categories-v1"',
      contentHash: contentHash(categoryPayload),
      usage: { total: null, method: null },
      value: {
        categories: [
          {
            id: 30064,
            name: "Продовольственные товары",
            parentId: 30062,
            level: 2,
            active: true,
            gismtCodes: [7],
            raw: categoryPayload.result[0],
          },
        ],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://catalog.example.test/v3/categories");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer catalog-token");
    expect(headers.get("If-None-Match")).toBe('"categories-v0"');
    expect(headers.get("Accept")).toBe("application/json");
    expect(calls[0]?.url).not.toContain("catalog-token");
  });

  it("normalizes documented attribute definitions and keeps source-only fields in raw", async () => {
    const client = new NationalCatalogClient(
      dependencies(async () => new Response(JSON.stringify(attributePayload), { status: 200 })),
    );

    await expect(client.getAttributes(auth)).resolves.toEqual({
      status: "ok",
      etag: null,
      contentHash: contentHash(attributePayload),
      usage: { total: null, method: null },
      value: {
        attributes: [
          {
            id: 1034,
            groupId: 103,
            groupName: "Потребительские свойства",
            name: "Тип парфюмерии",
            presetOnly: false,
            multiplicity: false,
            multiplicityType: null,
            fieldType: "text",
            valueTypes: [],
            dependentAttributes: [],
            firstLayer: false,
            secondLayer: true,
            type: "m",
            preset: ["ДУХИ"],
            presetUrl: null,
            raw: attributePayload.result[0],
          },
        ],
      },
    });
  });

  it("rejects non-positive, fractional, and unsafe provider identities", async () => {
    const categoryMutations = [
      (payload: typeof categoryPayload) => (payload.result[0]!.cat_id = 0),
      (payload: typeof categoryPayload) => (payload.result[0]!.cat_parent_id = -1),
      (payload: typeof categoryPayload) => (payload.result[0]!.cat_level = 1.5),
      (payload: typeof categoryPayload) => (payload.result[0]!.gismt_codes = [1.5]),
    ];
    for (const mutate of categoryMutations) {
      const payload = structuredClone(categoryPayload);
      mutate(payload);
      const client = new NationalCatalogClient(
        dependencies(async () => new Response(JSON.stringify(payload), { status: 200 })),
      );
      await expect(client.listCategories(auth)).resolves.toEqual({ status: "invalid_response" });
    }

    const attributeMutations = [
      (payload: typeof attributePayload) => (payload.result[0]!.attr_id = -1),
      (payload: typeof attributePayload) => (payload.result[0]!.attr_group_id = 1.5),
    ];
    for (const mutate of attributeMutations) {
      const payload = structuredClone(attributePayload);
      mutate(payload);
      const client = new NationalCatalogClient(
        dependencies(async () => new Response(JSON.stringify(payload), { status: 200 })),
      );
      await expect(client.getAttributes(auth)).resolves.toEqual({ status: "invalid_response" });
    }

    const nestedIdentityPayload = structuredClone(attributePayload);
    (
      nestedIdentityPayload.result[0] as unknown as {
        dependent_attributes: unknown[];
      }
    ).dependent_attributes = [
      {
        value: "ДА",
        atters: [{ attr_id: 0, first_layer: true, second_layer: false, attr_type: "m" }],
      },
    ];
    const nestedIdentityClient = new NationalCatalogClient(
      dependencies(
        async () => new Response(JSON.stringify(nestedIdentityPayload), { status: 200 }),
      ),
    );
    await expect(nestedIdentityClient.getAttributes(auth)).resolves.toEqual({
      status: "invalid_response",
    });

    const productMutations = [
      (payload: typeof productPayload) => (payload.result[0]!.good_id = 0),
      (payload: typeof productPayload) => (payload.result[0]!.categories[0]!.cat_id = -1),
      (payload: typeof productPayload) => (payload.result[0]!.good_attrs[0]!.attr_id = 1.5),
      (payload: typeof productPayload) => (payload.result[0]!.good_attrs[0]!.attr_group_id = 0),
      (payload: typeof productPayload) => (payload.result[0]!.identified_by[0]!.multiplier = -1),
    ];
    for (const mutate of productMutations) {
      const payload = structuredClone(productPayload);
      mutate(payload);
      const client = new NationalCatalogClient(
        dependencies(async () => new Response(JSON.stringify(payload), { status: 200 })),
      );
      await expect(client.getFeedProducts(auth, ["0000000000001"])).resolves.toEqual({
        status: "invalid_response",
      });
    }
  });

  it("serializes bounded category and TN VED selectors for the applicable attribute model", async () => {
    const calls: string[] = [];
    const client = new NationalCatalogClient(
      dependencies(async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify(attributePayload), { status: 200 });
      }),
    );

    await expect(
      client.getAttributes(auth, { catId: 30933, attrType: "m", ifNoneMatch: '"schema-v1"' }),
    ).resolves.toMatchObject({ status: "ok" });
    await expect(
      client.getAttributes(auth, { tnved: "3303", attrType: "r" }),
    ).resolves.toMatchObject({
      status: "ok",
    });
    expect(calls).toEqual([
      "https://catalog.example.test/v3/attributes?cat_id=30933&attr_type=m",
      "https://catalog.example.test/v3/attributes?tnved=3303&attr_type=r",
    ]);

    await expect(client.getAttributes(auth, { attrType: "m" })).rejects.toThrow(
      "National Catalog attrType requires catId, tnved, or isSet",
    );
    await expect(client.getAttributes(auth, { catId: 30933, tnved: "3303" })).rejects.toThrow(
      "National Catalog attribute selectors cannot combine catId and tnved",
    );
    await expect(client.getAttributes(auth, { catId: 0 })).rejects.toThrow(
      "National Catalog catId must be a positive integer",
    );
    await expect(client.getAttributes(auth, { tnved: "abc" })).rejects.toThrow(
      "National Catalog tnved must contain four to 10 digits",
    );
    expect(calls).toHaveLength(2);
  });

  it("serializes and validates the documented category selectors", async () => {
    const calls: string[] = [];
    const client = new NationalCatalogClient(
      dependencies(async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify(categoryPayload), { status: 200 });
      }),
    );

    await expect(
      client.listCategories(auth, { catId: 30064, gismtCode: 7, tnved: "3303001000" }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(calls).toEqual([
      "https://catalog.example.test/v3/categories?cat_id=30064&gismt_code=7&tnved=3303001000",
    ]);

    await expect(client.listCategories(auth, { catId: 0 })).rejects.toThrow(
      "National Catalog catId must be a positive integer",
    );
    await expect(client.listCategories(auth, { gismtCode: -1 })).rejects.toThrow(
      "National Catalog gismtCode must be a positive integer",
    );
    await expect(client.listCategories(auth, { tnved: "33-03" })).rejects.toThrow(
      "National Catalog tnved must contain four to 10 digits",
    );
    expect(calls).toHaveLength(1);
  });

  it("reads and strictly validates a documented etagslist page", async () => {
    const calls: string[] = [];
    const payload = {
      apiversion: 3,
      result: {
        goods_count: 2,
        offset: 100,
        last_product_number: 102,
        total: 102,
        goods: [
          { good_id: 720679, etag: "32b3502ff24f7c30" },
          { good_id: 720680, etag: "8529021f8808aaa9" },
        ],
      },
    };
    const client = new NationalCatalogClient(
      dependencies(async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify(payload), { status: 200 });
      }),
    );

    await expect(
      client.listEtags(auth, {
        brandId: 42,
        ownerInn: "7707083893",
        catId: 30064,
        offset: 100,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      value: {
        goodsCount: 2,
        offset: 100,
        lastProductNumber: 102,
        total: 102,
        goods: [
          { goodId: 720679, etag: "32b3502ff24f7c30" },
          { goodId: 720680, etag: "8529021f8808aaa9" },
        ],
      },
    });
    expect(calls).toEqual([
      "https://catalog.example.test/v3/etagslist?brand_id=42&owner_inn=7707083893&cat_id=30064&offset=100",
    ]);

    await expect(client.listEtags(auth, { brandId: 0 })).rejects.toThrow(
      "National Catalog brandId must be a positive integer",
    );
    await expect(client.listEtags(auth, { catId: 1.5 })).rejects.toThrow(
      "National Catalog catId must be a positive integer",
    );
    await expect(client.listEtags(auth, { offset: -1 })).rejects.toThrow(
      "National Catalog offset must be a non-negative integer",
    );
    await expect(client.listEtags(auth, { ownerInn: "012345" })).rejects.toThrow(
      "National Catalog ownerInn must be a valid INN",
    );
    expect(calls).toHaveLength(1);
  });

  it("rejects oversized, inconsistent, and malformed etagslist pages", async () => {
    const valid = {
      goods_count: 1,
      offset: 0,
      last_product_number: 1,
      total: 1,
      goods: [{ good_id: 1, etag: "etag-1" }],
    };
    const payloads = [
      { ...valid, goods_count: 2 },
      { ...valid, last_product_number: 0 },
      { ...valid, total: 0 },
      { ...valid, goods: [{ good_id: 0, etag: "etag-1" }] },
      { ...valid, goods: [{ good_id: 1, etag: "" }] },
      { ...valid, goods: [{ good_id: 1, etag: "bad etag" }] },
      {
        goods_count: 101,
        offset: 0,
        last_product_number: 101,
        total: 101,
        goods: Array.from({ length: 101 }, (_, index) => ({
          good_id: index + 1,
          etag: `etag-${index + 1}`,
        })),
      },
    ];

    for (const result of payloads) {
      const client = new NationalCatalogClient(
        dependencies(
          async () => new Response(JSON.stringify({ apiversion: 3, result }), { status: 200 }),
        ),
      );
      await expect(client.listEtags(auth)).resolves.toEqual({ status: "invalid_response" });
    }

    const fullPageGoods = Array.from({ length: 100 }, (_, index) => ({
      good_id: index + 1,
      etag: `etag-${index + 1}`,
    }));
    const fullPage = new NationalCatalogClient(
      dependencies(
        async () =>
          new Response(
            JSON.stringify({
              apiversion: 3,
              result: {
                goods_count: 100,
                offset: 0,
                last_product_number: 100,
                total: 100,
                goods: fullPageGoods,
              },
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(fullPage.listEtags(auth)).resolves.toMatchObject({
      status: "ok",
      value: {
        goodsCount: 100,
        goods: expect.arrayContaining([{ goodId: 100, etag: "etag-100" }]),
      },
    });
  });

  it("normalizes omitted optional category and attribute fields to safe empty values", async () => {
    const minimalCategories = {
      apiversion: 3,
      result: [
        {
          cat_id: 30064,
          cat_name: "Продовольственные товары",
          cat_parent_id: 30062,
          cat_level: 2,
          category_active: true,
        },
      ],
    };
    const minimalAttributes = {
      apiversion: 3,
      result: [
        {
          attr_group_id: 103,
          attr_name: "Тип парфюмерии",
          attr_preset_only: false,
          attr_multiplicity: false,
          attr_multiplicity_type: null,
          attr_id: 1034,
          attr_group_name: "Потребительские свойства",
          first_layer: false,
          second_layer: true,
        },
      ],
    };
    const client = new NationalCatalogClient(
      dependencies(
        async (url) =>
          new Response(
            JSON.stringify(
              String(url).includes("categories") ? minimalCategories : minimalAttributes,
            ),
            {
              status: 200,
            },
          ),
      ),
    );

    await expect(client.listCategories(auth)).resolves.toMatchObject({
      status: "ok",
      value: { categories: [expect.objectContaining({ gismtCodes: [] })] },
    });
    await expect(client.getAttributes(auth)).resolves.toMatchObject({
      status: "ok",
      value: {
        attributes: [
          expect.objectContaining({
            fieldType: null,
            valueTypes: [],
            dependentAttributes: [],
            preset: [],
          }),
        ],
      },
    });
  });

  it("normalizes documented dependency rules and rejects malformed nested dependency or preset values", async () => {
    const nestedAttributePayload = {
      apiversion: 3,
      result: [
        {
          ...attributePayload.result[0],
          dependent_attributes: [
            {
              value: "ДА",
              atters: [
                {
                  attr_id: 15654,
                  first_layer: true,
                  second_layer: false,
                  attr_type: "m",
                  provider_only: "kept out of the normalized rule",
                },
              ],
              provider_only: "kept out of the normalized dependency",
            },
          ],
          attr_preset: ["ДА", "НЕТ"],
        },
      ],
    };
    const valid = new NationalCatalogClient(
      dependencies(
        async () => new Response(JSON.stringify(nestedAttributePayload), { status: 200 }),
      ),
    );

    await expect(valid.getAttributes(auth)).resolves.toMatchObject({
      status: "ok",
      value: {
        attributes: [
          expect.objectContaining({
            dependentAttributes: [
              {
                value: "ДА",
                attributes: [{ id: 15654, firstLayer: true, secondLayer: false, type: "m" }],
              },
            ],
            preset: ["ДА", "НЕТ"],
          }),
        ],
      },
    });

    const invalidDependency = new NationalCatalogClient(
      dependencies(
        async () =>
          new Response(
            JSON.stringify({
              ...nestedAttributePayload,
              result: [{ ...nestedAttributePayload.result[0], dependent_attributes: [null] }],
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(invalidDependency.getAttributes(auth)).resolves.toEqual({
      status: "invalid_response",
    });

    const invalidPreset = new NationalCatalogClient(
      dependencies(
        async () =>
          new Response(
            JSON.stringify({
              ...nestedAttributePayload,
              result: [{ ...nestedAttributePayload.result[0], attr_preset: [{}] }],
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(invalidPreset.getAttributes(auth)).resolves.toEqual({
      status: "invalid_response",
    });
  });

  it("rejects an empty dependent attribute object", async () => {
    const client = new NationalCatalogClient(
      dependencies(
        async () =>
          new Response(
            JSON.stringify({
              ...attributePayload,
              result: [{ ...attributePayload.result[0], dependent_attributes: [{}] }],
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(client.getAttributes(auth)).resolves.toEqual({
      status: "invalid_response",
    });
  });

  it("uses only the fixed feed-product path and semicolon-delimited digit GTINs", async () => {
    const calls: string[] = [];
    const client = new NationalCatalogClient(
      dependencies(async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify(productPayload), { status: 200 });
      }),
    );

    await expect(
      client.getFeedProducts(auth, ["0000000000001", "04600000000017"]),
    ).resolves.toMatchObject({
      status: "ok",
      value: {
        products: [
          {
            id: 720679,
            name: "Чешки детские",
            status: "published",
            identifiers: [
              { value: "0000000000001", type: "gtin", multiplier: 1, level: "trade-unit" },
            ],
            categories: [{ id: 30064, name: "Продовольственные товары" }],
            attributes: [
              {
                id: 13933,
                name: "Код ТНВЭД",
                value: "6202930000",
                valueId: 0,
                attributeValueId: 0,
                valueType: "",
                groupId: 22,
                groupName: "Нормативно-сопроводительная документация",
                locationId: null,
                level: null,
                gtin: null,
                multiplier: null,
              },
            ],
          },
        ],
      },
    });
    expect(calls).toEqual([
      "https://catalog.example.test/v3/feed-product?gtins=0000000000001%3B04600000000017",
    ]);
  });

  it("preserves the exact provider attr_value_type used as a numeric source unit", async () => {
    const payload = structuredClone(productPayload);
    payload.result[0]!.good_attrs[0]!.attr_value = "50";
    payload.result[0]!.good_attrs[0]!.attr_value_type = "мл";
    const client = new NationalCatalogClient(
      dependencies(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );

    await expect(client.getFeedProducts(auth, ["0000000000001"])).resolves.toMatchObject({
      status: "ok",
      value: {
        products: [
          {
            attributes: [expect.objectContaining({ value: "50", valueType: "мл" })],
          },
        ],
      },
    });
  });

  it("uses the singular documented GTIN selector for one-card reads", async () => {
    const calls: string[] = [];
    const client = new NationalCatalogClient(
      dependencies(async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify(productPayload), { status: 200 });
      }),
    );

    await expect(client.getFeedProducts(auth, ["0000000000001"])).resolves.toMatchObject({
      status: "ok",
    });
    await expect(client.getPublishedProducts(auth, ["04600000000017"])).resolves.toMatchObject({
      status: "ok",
    });

    expect(calls).toEqual([
      "https://catalog.example.test/v3/feed-product?gtin=0000000000001",
      "https://catalog.example.test/v3/product?gtin=04600000000017",
    ]);
  });

  it("reads owned cards by plural good_ids without falling back to a GTIN selector", async () => {
    const calls: string[] = [];
    const client = new NationalCatalogClient(
      dependencies(async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify(productPayload), { status: 200 });
      }),
    );

    await expect(client.getFeedProductsByIds(auth, ["720679", "720680"])).resolves.toMatchObject({
      status: "ok",
    });
    await expect(client.getFeedProductsByIds(auth, ["720679"])).resolves.toMatchObject({
      status: "ok",
    });
    expect(calls).toEqual([
      "https://catalog.example.test/v3/feed-product?good_ids=720679%3B720680",
      "https://catalog.example.test/v3/feed-product?good_ids=720679",
    ]);
    expect(calls.every((url) => !url.includes("gtin"))).toBe(true);
  });

  it("rejects empty, malformed, unsafe, and over-limit card ID batches before any request", async () => {
    let calls = 0;
    const client = new NationalCatalogClient(
      dependencies(async () => {
        calls += 1;
        return new Response(JSON.stringify(productPayload), { status: 200 });
      }),
    );

    for (const cardIds of [
      [],
      ["0"],
      ["01"],
      ["1.5"],
      ["not-an-id"],
      [String(Number.MAX_SAFE_INTEGER + 1)],
      Array.from({ length: 26 }, (_, index) => String(index + 1)),
    ]) {
      await expect(client.getFeedProductsByIds(auth, cardIds)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });

  it("accepts exactly 25 card IDs in one feed-product request", async () => {
    const cardIds = Array.from({ length: 25 }, (_, index) => String(index + 1));
    const calls: string[] = [];
    const client = new NationalCatalogClient(
      dependencies(async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify(productPayload), { status: 200 });
      }),
    );

    await expect(client.getFeedProductsByIds(auth, cardIds)).resolves.toMatchObject({
      status: "ok",
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0] as string);
    expect(url.searchParams.get("good_ids")).toBe(cardIds.join(";"));
    expect(url.searchParams.has("gtin")).toBe(false);
    expect(url.searchParams.has("gtins")).toBe(false);
  });

  it("normalizes detailed statuses and usable photos while retaining per-photo issues", async () => {
    const payload = {
      ...productPayload,
      result: [
        {
          ...productPayload.result[0],
          good_detailed_status: ["published", "notsigned", "provider-future-detail"],
          good_img: "https://cdn.example.test/main.jpg",
          good_images: [
            {
              photo_type: "side",
              photo_date: "2026-09-08",
              photo_url: "https://cdn.example.test/side.jpg",
              barcode: null,
            },
            {
              photo_type: "front",
              photo_date: "2026-09-08",
              photo_url: "https://cdn.example.test/main.jpg",
              barcode: "0000000000001",
            },
            {
              photo_type: "3ds",
              photo_url: ["https://cdn.example.test/3ds-1.jpg"],
              barcode: null,
            },
            {
              photo_type: "detail",
              photo_url: "https://cdn.example.test/invalid-barcode.jpg",
              barcode: "not-a-barcode",
            },
            "not-a-photo-record",
            {
              photo_type: "detail",
              photo_url: "http://cdn.example.test/insecure.jpg",
              barcode: null,
            },
          ],
        },
      ],
    };
    const client = new NationalCatalogClient(
      dependencies(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );

    await expect(client.getFeedProductsByIds(auth, ["720679"])).resolves.toMatchObject({
      status: "ok",
      value: {
        products: [
          {
            detailedStatuses: ["published", "unsigned", "provider-future-detail"],
            images: [
              {
                sourceId: "good_images:0",
                url: "https://cdn.example.test/side.jpg",
                barcode: null,
                primary: false,
              },
              {
                sourceId: "good_images:1",
                url: "https://cdn.example.test/main.jpg",
                barcode: "0000000000001",
                primary: true,
              },
            ],
            imageIssues: [
              { sourceId: "good_images:2", reason: "unsupported_media" },
              { sourceId: "good_images:3", reason: "invalid_barcode" },
              { sourceId: "good_images:4", reason: "invalid_record" },
              { sourceId: "good_images:5", reason: "invalid_url" },
            ],
          },
        ],
      },
    });
  });

  it("keeps a valid card and default image when the optional gallery container is malformed", async () => {
    const payload = {
      ...productPayload,
      result: [
        {
          ...productPayload.result[0],
          good_img: "https://cdn.example.test/main.jpg",
          good_images: { photo_url: "https://cdn.example.test/not-a-list.jpg" },
        },
      ],
    };
    const client = new NationalCatalogClient(
      dependencies(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );

    await expect(client.getFeedProducts(auth, ["0000000000001"])).resolves.toMatchObject({
      status: "ok",
      value: {
        products: [
          {
            images: [
              {
                sourceId: "good_img",
                url: "https://cdn.example.test/main.jpg",
                barcode: null,
                primary: true,
              },
            ],
            imageIssues: [{ sourceId: "good_images", reason: "invalid_collection" }],
          },
        ],
      },
    });
  });

  it("does not re-admit a default image whose gallery barcode is invalid", async () => {
    const payload = {
      ...productPayload,
      result: [
        {
          ...productPayload.result[0],
          good_img: "https://cdn.example.test/main.jpg",
          good_images: [
            {
              photo_type: "front",
              photo_url: "https://cdn.example.test/main.jpg",
              barcode: "explicitly-invalid",
            },
          ],
        },
      ],
    };
    const client = new NationalCatalogClient(
      dependencies(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );

    await expect(client.getFeedProducts(auth, ["0000000000001"])).resolves.toMatchObject({
      status: "ok",
      value: {
        products: [
          {
            images: [],
            imageIssues: [{ sourceId: "good_images:0", reason: "invalid_barcode" }],
          },
        ],
      },
    });
  });

  it("preserves an explicit conflicting photo barcode when it shares the default URL", async () => {
    const payload = {
      ...productPayload,
      result: [
        {
          ...productPayload.result[0],
          good_img: "https://cdn.example.test/main.jpg",
          good_images: [
            {
              photo_type: "front",
              photo_url: "https://cdn.example.test/main.jpg",
              barcode: null,
            },
            {
              photo_type: "front",
              photo_url: "https://cdn.example.test/main.jpg",
              barcode: "9999999999999",
            },
          ],
        },
      ],
    };
    const client = new NationalCatalogClient(
      dependencies(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );

    await expect(client.getFeedProducts(auth, ["0000000000001"])).resolves.toMatchObject({
      status: "ok",
      value: {
        products: [
          {
            images: [
              {
                sourceId: "good_images:1",
                url: "https://cdn.example.test/main.jpg",
                barcode: "9999999999999",
                primary: true,
              },
            ],
          },
        ],
      },
    });
  });

  it("normalizes production numeric placeholders for owned and published card reads", async () => {
    const payload = structuredClone(productPayload);
    payload.result[0]!.identified_by[0]!.multiplier = "2.000";
    payload.result[0]!.good_attrs[0]!.multiplier = "3.0";
    payload.result[0]!.good_attrs[0]!.attr_value_id = "";
    const client = new NationalCatalogClient(
      dependencies(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );

    const expected = {
      status: "ok",
      value: {
        products: [
          {
            identifiers: [expect.objectContaining({ multiplier: 2 })],
            attributes: [expect.objectContaining({ attributeValueId: null, multiplier: 3 })],
          },
        ],
      },
    };

    await expect(client.getFeedProducts(auth, ["0000000000001"])).resolves.toMatchObject(expected);
    await expect(client.getPublishedProducts(auth, ["0000000000001"])).resolves.toMatchObject(
      expected,
    );
  });

  it.each(["0", "0.0", "-1", "1.5", " 1", "1 ", "one", "9007199254740992", "9007199254740992.0"])(
    "rejects malformed provider multiplier %j",
    async (multiplier) => {
      const payload = structuredClone(productPayload);
      payload.result[0]!.good_attrs[0]!.multiplier = multiplier;
      const client = new NationalCatalogClient(
        dependencies(async () => new Response(JSON.stringify(payload), { status: 200 })),
      );

      await expect(client.getFeedProducts(auth, ["0000000000001"])).resolves.toEqual({
        status: "invalid_response",
      });
    },
  );

  it("keeps value_id and non-empty attr_value_id strings strict", async () => {
    for (const mutate of [
      (payload: typeof productPayload) => (payload.result[0]!.good_attrs[0]!.value_id = ""),
      (payload: typeof productPayload) => (payload.result[0]!.good_attrs[0]!.attr_value_id = "12"),
    ]) {
      const payload = structuredClone(productPayload);
      mutate(payload);
      const client = new NationalCatalogClient(
        dependencies(async () => new Response(JSON.stringify(payload), { status: 200 })),
      );

      await expect(client.getFeedProducts(auth, ["0000000000001"])).resolves.toEqual({
        status: "invalid_response",
      });
    }
  });

  it("rejects empty, non-digit, and over-limit GTIN batches before any request", async () => {
    let calls = 0;
    const client = new NationalCatalogClient(
      dependencies(async () => {
        calls += 1;
        return new Response(JSON.stringify(productPayload), { status: 200 });
      }),
    );

    await expect(client.getPublishedProducts(auth, [])).rejects.toThrow(
      "National Catalog product reads require one to 25 GTINs",
    );
    await expect(client.getPublishedProducts(auth, ["not-a-gtin"])).rejects.toThrow(
      "National Catalog GTINs must contain digits only",
    );
    await expect(
      client.getPublishedProducts(
        auth,
        Array.from({ length: 26 }, () => "04600000000017"),
      ),
    ).rejects.toThrow("National Catalog product reads require one to 25 GTINs");
    expect(calls).toBe(0);
  });

  it("maps a documented 304 without attempting to parse a body", async () => {
    const client = new NationalCatalogClient(
      dependencies(async () => new Response(null, { status: 304 })),
    );

    await expect(client.getPublishedProducts(auth, ["04600000000017"])).resolves.toEqual({
      status: "not_modified",
    });
  });

  it("maps authorization, absence, rate, response, and availability failures to stable outcomes", async () => {
    const denied = new NationalCatalogClient(
      dependencies(
        async () => new Response(JSON.stringify({ message: "x".repeat(700) }), { status: 403 }),
      ),
    );
    await expect(denied.listCategories(auth)).resolves.toEqual({
      status: "forbidden",
      message: "x".repeat(500),
    });

    const statuses = new NationalCatalogClient(
      dependencies(async () => new Response(null, { status: 401 })),
    );
    await expect(statuses.listCategories(auth)).resolves.toEqual({ status: "unauthorized" });

    const absent = new NationalCatalogClient(
      dependencies(async () => new Response(null, { status: 404 })),
    );
    await expect(absent.listCategories(auth)).resolves.toEqual({ status: "not_found" });

    const rateLimited = new NationalCatalogClient(
      dependencies(
        async () => new Response(null, { status: 429, headers: { "Retry-After": "17" } }),
      ),
    );
    await expect(rateLimited.listCategories(auth)).resolves.toEqual({
      status: "rate_limited",
      retryAfterSeconds: 17,
    });

    const badRequest = new NationalCatalogClient(
      dependencies(
        async () => new Response(JSON.stringify({ message: "invalid query" }), { status: 400 }),
      ),
    );
    await expect(badRequest.listCategories(auth)).resolves.toEqual({ status: "invalid_response" });

    const invalid = new NationalCatalogClient(
      dependencies(
        async () => new Response(JSON.stringify({ apiversion: 3, result: {} }), { status: 200 }),
      ),
    );
    await expect(invalid.listCategories(auth)).resolves.toEqual({ status: "invalid_response" });

    const wrongVersion = new NationalCatalogClient(
      dependencies(async () => new Response(JSON.stringify({ ...categoryPayload, apiversion: 4 }))),
    );
    await expect(wrongVersion.listCategories(auth)).resolves.toEqual({
      status: "invalid_response",
    });

    const server = new NationalCatalogClient(
      dependencies(async () => new Response(null, { status: 503 })),
    );
    await expect(server.listCategories(auth)).resolves.toEqual({ status: "unavailable" });

    const network = new NationalCatalogClient(
      dependencies(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    await expect(network.listCategories(auth)).resolves.toEqual({ status: "unavailable" });
  });

  it("parses optional usage metadata and hashes the exact successful response bytes", async () => {
    const body = `${JSON.stringify(categoryPayload)}\n`;
    const client = new NationalCatalogClient(
      dependencies(
        async () =>
          new Response(body, {
            status: 200,
            headers: {
              "API-Usage-Limit": "1/500",
              "API-Method-Usage-Limit": "1/10",
            },
          }),
      ),
    );

    await expect(client.listCategories(auth)).resolves.toMatchObject({
      status: "ok",
      contentHash: createHash("sha256").update(body).digest("hex"),
      usage: {
        total: { used: 1, limit: 500 },
        method: { used: 1, limit: 10 },
      },
    });

    const malformed = new NationalCatalogClient(
      dependencies(
        async () =>
          new Response(JSON.stringify(categoryPayload), {
            status: 200,
            headers: {
              "API-Usage-Limit": "used/limit",
              "API-Method-Usage-Limit": "11/10",
            },
          }),
      ),
    );
    await expect(malformed.listCategories(auth)).resolves.toMatchObject({
      status: "ok",
      usage: { total: null, method: null },
    });
  });

  it("accepts the exact method body bound and rejects one byte over before parsing", async () => {
    const json = JSON.stringify({ apiversion: 3, result: [] });
    const atBound = `${json}${" ".repeat(
      NATIONAL_CATALOG_RESPONSE_BYTE_LIMITS.categories - Buffer.byteLength(json),
    )}`;
    const overBound = `${atBound} `;
    let cancelled = 0;
    const client = new NationalCatalogClient(
      dependencies(
        async (_url, init) => {
          const conditional = new Headers((init as RequestInit).headers).get("If-None-Match");
          return new Response(conditional === "over" ? overBound : atBound, { status: 200 });
        },
        () => () => {
          cancelled += 1;
        },
      ),
    );

    await expect(client.listCategories(auth)).resolves.toMatchObject({ status: "ok" });
    await expect(client.listCategories(auth, { ifNoneMatch: "over" })).resolves.toEqual({
      status: "invalid_response",
    });
    expect(cancelled).toBe(2);
  });

  it("classifies invalid UTF-8, invalid JSON, and a truncated successful stream as invalid_response", async () => {
    const invalidUtf8 = new NationalCatalogClient(
      dependencies(async () => new Response(new Uint8Array([0xc3, 0x28]), { status: 200 })),
    );
    await expect(invalidUtf8.listCategories(auth)).resolves.toEqual({
      status: "invalid_response",
    });

    const invalidJson = new NationalCatalogClient(
      dependencies(async () => new Response("{", { status: 200 })),
    );
    await expect(invalidJson.listCategories(auth)).resolves.toEqual({
      status: "invalid_response",
    });

    const truncated = new NationalCatalogClient(
      dependencies(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"apiversion":3,"result":['));
                controller.error(new Error("truncated"));
              },
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(truncated.listCategories(auth)).resolves.toEqual({
      status: "invalid_response",
    });
  });

  it("always clears the scheduled abort after a transport failure", async () => {
    let cancelled = false;
    const client = new NationalCatalogClient(
      dependencies(
        async () => {
          throw new Error("connection reset");
        },
        () => () => {
          cancelled = true;
        },
      ),
    );

    await expect(client.listCategories(auth)).resolves.toEqual({ status: "unavailable" });
    expect(cancelled).toBe(true);
  });

  it("retains raw provider data only at each item boundary", async () => {
    const providerHeaderSentinel = "must-not-enter-raw-data";
    const client = new NationalCatalogClient(
      dependencies(
        async () =>
          new Response(JSON.stringify(productPayload), {
            status: 200,
            headers: {
              Authorization: providerHeaderSentinel,
              "API-Usage-Limit": "1/500",
            },
          }),
      ),
    );

    const result = await client.getPublishedProducts(auth, ["0000000000001"]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected successful product response");
    expect(result.value).not.toHaveProperty("raw");
    expect(result.value.products[0]?.raw).toEqual(productPayload.result[0]);
    expect(JSON.stringify(result.value.products[0]?.raw)).toContain(
      "kept out of the normalized record",
    );
    expect(JSON.stringify(result.value.products[0]?.raw)).not.toContain(providerHeaderSentinel);
    expect(JSON.stringify(result.value.products[0]?.raw)).not.toContain("API-Usage-Limit");
  });

  it("cancels the request using the configured timeout and maps an abort to unavailable", async () => {
    let timeoutMs: number | null = null;
    let cancelled = false;
    const client = new NationalCatalogClient(
      dependencies(
        async (_url, init) => {
          expect((init as RequestInit).signal?.aborted).toBe(true);
          throw new DOMException("The operation was aborted", "AbortError");
        },
        (controller, timeout) => {
          timeoutMs = timeout;
          controller.abort();
          return () => {
            cancelled = true;
          };
        },
      ),
      1234,
    );

    await expect(client.listCategories(auth)).resolves.toEqual({ status: "unavailable" });
    expect(timeoutMs).toBe(1234);
    expect(cancelled).toBe(true);
  });
});

describe("coordinated transport context", () => {
  it.each([413, 429, 503])(
    "observes quota before handling status %s and cancels its body",
    async (status) => {
      const metadata: unknown[] = [];
      let cancelled = false;
      const client = new NationalCatalogClient(
        dependencies(
          async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
              {
                status,
                headers: {
                  "API-Usage-Limit": "500/500",
                  "API-Method-Usage-Limit": "10/10",
                  "Retry-After": "1800",
                },
              },
            ),
        ),
      );
      await client.listOwnProducts(auth, listRequest, {
        onResponse: (value) => {
          metadata.push(value);
        },
      });
      expect(metadata).toEqual([
        {
          method: "/v4/product-list",
          status,
          usage: { total: { used: 500, limit: 500 }, method: { used: 10, limit: 10 } },
          retryAfterSeconds: 1800,
        },
      ]);
      expect(cancelled).toBe(true);
    },
  );

  it("forwards external abort to the actual fetch while keeping the standalone timeout", async () => {
    const controller = new AbortController();
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let actualSignal: AbortSignal | null = null;
    let timeout = 0;
    const client = new NationalCatalogClient(
      dependencies(
        async (_url, init) => {
          const signal = init?.signal;
          if (!signal) throw new Error("missing abort signal");
          actualSignal = signal;
          started();
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
        (_controller, ms) => {
          timeout = ms;
          return () => {};
        },
      ),
      120_000,
    );
    const pending = client.getFeedProducts(auth, ["04601234567890"], { signal: controller.signal });
    await ready;
    controller.abort();
    expect(actualSignal).toHaveProperty("aborted", true);
    await expect(pending).resolves.toEqual({ status: "unavailable" });
    expect(timeout).toBe(120_000);
  });
});

it("retains over-limit quota and HTTP-date Retry-After in coordinated metadata without changing legacy parsing", async () => {
  const metadata: unknown[] = [];
  const client = new NationalCatalogClient(
    dependencies(
      async () =>
        new Response(null, {
          status: 429,
          headers: {
            "API-Usage-Limit": "501/500",
            "API-Method-Usage-Limit": "11/10",
            Date: "Tue, 08 Sep 2026 09:00:00 GMT",
            "Retry-After": "Tue, 08 Sep 2026 09:30:00 GMT",
          },
        }),
    ),
  );
  await expect(
    client.getFeedProducts(auth, ["04601234567890"], {
      onResponse: (value) => {
        metadata.push(value);
      },
    }),
  ).resolves.toEqual({ status: "rate_limited", retryAfterSeconds: null });
  expect(metadata).toEqual([
    {
      method: "/v3/feed-product",
      status: 429,
      usage: { total: { used: 501, limit: 500 }, method: { used: 11, limit: 10 } },
      retryAfterSeconds: 1800,
    },
  ]);
});
