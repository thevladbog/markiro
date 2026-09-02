import { createDb } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv, type Env } from "../src/env";
import { NationalCatalogClient } from "../src/modules/national-catalog/national-catalog.client";
import { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";
import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
import type { NationalCatalogResult } from "../src/modules/national-catalog/national-catalog.types";

const liveConfigured = Boolean(
  process.env.NATIONAL_CATALOG_BASE_URL?.trim() &&
  process.env.NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID?.trim() &&
  process.env.NATIONAL_CATALOG_LIVE_GTIN?.trim(),
);

describe.skipIf(!liveConfigured)("National Catalog live read contract", () => {
  let connection: ReturnType<typeof createDb> | undefined;
  let env: Env;
  let client: NationalCatalogClient;
  let tokenService: ChzTokenService;

  beforeAll(() => {
    env = loadEnv();
    connection = createDb(env.DATABASE_URL);
    tokenService = new ChzTokenService(
      connection.db,
      new ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY),
    );
    client = new NationalCatalogClient(undefined, env.NATIONAL_CATALOG_REQUEST_TIMEOUT_MS);
  });

  afterAll(async () => {
    await connection?.pool.end();
  });

  it("reads the configured schema and known GTIN without logging credentials or card payloads", async () => {
    const token = await tokenService.getActiveToken(env.NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID!);
    expect(token.status).toBe("ok");
    if (token.status !== "ok") {
      throw new Error(`National Catalog source tenant token is ${token.status}`);
    }
    if (!env.NATIONAL_CATALOG_BASE_URL || !env.NATIONAL_CATALOG_LIVE_GTIN) {
      throw new Error("National Catalog live configuration disappeared after the opt-in check");
    }
    const auth = { baseUrl: env.NATIONAL_CATALOG_BASE_URL, token: token.auth.token };
    const gtin = env.NATIONAL_CATALOG_LIVE_GTIN;

    const categories = await client.listCategories(auth);
    record(
      "categories",
      categories,
      categories.status === "ok" ? categories.value.categories.length : 0,
    );
    expect(categories.status).toBe("ok");
    if (categories.status !== "ok") return;
    expect(categories.etag).not.toBeNull();
    if (categories.etag === null)
      throw new Error("categories response omitted its documented ETag");

    const repeatedCategories = await client.listCategories(auth, {
      ifNoneMatch: categories.etag,
    });
    record("categories-repeat", repeatedCategories, 0);
    expect(repeatedCategories).toEqual({ status: "not_modified" });

    const attributes = await client.getAttributes(auth);
    record(
      "attributes",
      attributes,
      attributes.status === "ok" ? attributes.value.attributes.length : 0,
    );
    expect(attributes.status).toBe("ok");

    const ownCard = await client.getFeedProducts(auth, [gtin]);
    record("feed-product", ownCard, ownCard.status === "ok" ? ownCard.value.products.length : 0);
    expect(ownCard.status).toBe("ok");

    const publishedCard = await client.getPublishedProducts(auth, [gtin]);
    record(
      "product",
      publishedCard,
      publishedCard.status === "ok" ? publishedCard.value.products.length : 0,
    );
    expect(publishedCard.status).toBe("ok");
    if (publishedCard.status !== "ok") return;
    expect(publishedCard.etag).not.toBeNull();
    if (publishedCard.etag === null)
      throw new Error("product response omitted its documented ETag");

    const repeatedPublishedCard = await client.getPublishedProducts(auth, [gtin], {
      ifNoneMatch: publishedCard.etag,
    });
    record("product-repeat", repeatedPublishedCard, 0);
    expect(repeatedPublishedCard).toEqual({ status: "not_modified" });
  });
});

function record(method: string, result: NationalCatalogResult<unknown>, resultCount: number): void {
  // Deliberately limited evidence for a real tenant: no bearer and no source card.
  console.info(
    JSON.stringify({
      method,
      outcome: result.status,
      resultCount,
      etagPresent: result.status === "ok" && result.etag !== null,
    }),
  );
}
