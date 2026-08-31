import { describe, expect, it } from "vitest";

import {
  NationalCatalogClient,
  type NationalCatalogClientDependencies,
} from "../src/modules/national-catalog/national-catalog.client";

const auth = { baseUrl: "https://catalog.example.test", token: "catalog-token" };

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
      identified_by: [{ value: "0000000000001", type: "gtin", multiplier: 1, level: "trade-unit" }],
      categories: [{ cat_id: 30064, cat_name: "Продовольственные товары" }],
      good_attrs: [
        {
          attr_id: 13933,
          attr_name: "Код ТНВЭД",
          attr_value: "6202930000",
          attr_value_id: 0,
          value_id: 0,
          attr_value_type: "",
          attr_group_id: 22,
          attr_group_name: "Нормативно-сопроводительная документация",
        },
      ],
      provider_only: "kept out of the normalized record",
    },
  ],
};

describe("NationalCatalogClient", () => {
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
      value: {
        categories: [
          {
            id: 30064,
            name: "Продовольственные товары",
            parentId: 30062,
            level: 2,
            active: true,
            gismtCodes: [7],
          },
        ],
        raw: categoryPayload,
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
          },
        ],
        raw: attributePayload,
      },
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
