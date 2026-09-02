import { describe, expect, it, vi } from "vitest";

import {
  NationalCatalogProductsService,
  type NationalCatalogCardToStore,
  type NationalCatalogProductsRepository,
} from "../src/modules/national-catalog/national-catalog-products.service";
import type { NationalCatalogClient } from "../src/modules/national-catalog/national-catalog.client";
import type { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";

const tenantId = "tenant-a";
const productId = "00000000-0000-4000-8000-000000000001";
const gtin = "04601234567890";

function card(id: number) {
  return {
    id,
    name: "Пиво",
    status: "published",
    identifiers: [{ value: gtin, type: "gtin", multiplier: 1, level: "trade-unit" }],
    categories: [{ id: 10, name: "Пиво" }],
    attributes: [],
    raw: { good_id: id, good_name: "Пиво" },
  };
}

function repository(overrides: Partial<NationalCatalogProductsRepository> = {}) {
  return {
    findProduct: vi.fn(async () => ({ id: productId, gtin14: gtin })),
    findProviderEtag: vi.fn(async () => null),
    markNotModified: vi.fn(async () => []),
    markNotFound: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    storeCards: vi.fn(
      async (
        _tenantId: string,
        _productId: string,
        _gtin: string,
        sourceMethod: "feed_product" | "product",
        cards: readonly NationalCatalogCardToStore[],
      ) =>
        cards.map((item) => ({
          snapshotId: `00000000-0000-4000-8000-${String(item.cardId).padStart(12, "0")}`,
          cardId: item.cardId,
          cardStatus: item.cardStatus,
          sourceMethod,
          changed: true,
        })),
    ),
    ...overrides,
  } satisfies NationalCatalogProductsRepository;
}

function service(options: {
  repository?: NationalCatalogProductsRepository;
  feed?: unknown;
  published?: unknown;
  token?: unknown;
}) {
  const repo = options.repository ?? repository();
  const client = {
    getFeedProducts: vi.fn(
      async () =>
        options.feed ?? {
          status: "ok",
          value: { products: [card(1)] },
          etag: null,
          contentHash: "feed",
          usage: { total: null, method: null },
        },
    ),
    getPublishedProducts: vi.fn(
      async () =>
        options.published ?? {
          status: "ok",
          value: { products: [card(2)] },
          etag: null,
          contentHash: "product",
          usage: { total: null, method: null },
        },
    ),
  } as unknown as NationalCatalogClient;
  const tokens = {
    getActiveToken: vi.fn(
      async () =>
        options.token ?? {
          status: "ok",
          auth: { baseUrl: "https://true-api.example", token: "secret" },
          obtainedAt: new Date(),
        },
    ),
  } as unknown as ChzTokenService;
  return {
    service: new NationalCatalogProductsService(repo, client, tokens, "https://catalog.example"),
    repo,
    client,
    tokens,
  };
}

describe("NationalCatalogProductsService", () => {
  it("resolves the tenant product before token access and rejects cross-tenant ids", async () => {
    const subject = service({ repository: repository({ findProduct: vi.fn(async () => null) }) });
    await expect(subject.service.lookup(tenantId, productId)).rejects.toMatchObject({
      status: 404,
    });
    expect(subject.tokens.getActiveToken).not.toHaveBeenCalled();
  });

  it("uses feed-product first and stores every returned card independently", async () => {
    const subject = service({
      feed: {
        status: "ok",
        value: { products: [card(8), card(7)] },
        etag: '"feed"',
        contentHash: "feed",
        usage: { total: null, method: null },
      },
    });
    const result = await subject.service.lookup(tenantId, productId);
    expect(result.outcome).toBe("selection_required");
    expect(subject.client.getFeedProducts).toHaveBeenCalledWith(
      { baseUrl: "https://catalog.example", token: "secret" },
      [gtin],
    );
    expect(subject.client.getPublishedProducts).not.toHaveBeenCalled();
    expect(subject.repo.storeCards).toHaveBeenCalledWith(
      tenantId,
      productId,
      gtin,
      "feed_product",
      expect.arrayContaining([
        expect.objectContaining({ cardId: "7" }),
        expect.objectContaining({ cardId: "8" }),
      ]),
      expect.any(Date),
    );
  });

  it.each(["not_found", "forbidden", "invalid_response", "unavailable"] as const)(
    "falls back to published cards when feed-product is %s",
    async (status) => {
      const subject = service({
        feed: status === "forbidden" ? { status, message: "private" } : { status },
      });
      const result = await subject.service.lookup(tenantId, productId);
      expect(result).toMatchObject({
        outcome: "found",
        cards: [expect.objectContaining({ cardId: "2" })],
      });
      expect(subject.client.getPublishedProducts).toHaveBeenCalledTimes(1);
      if (status === "not_found") {
        expect(subject.repo.markNotFound).toHaveBeenCalledWith(
          tenantId,
          productId,
          "feed_product",
          expect.any(Date),
        );
      } else {
        expect(subject.repo.markFailed).toHaveBeenCalledWith(
          tenantId,
          productId,
          "feed_product",
          status === "forbidden" ? "forbidden" : status,
          expect.any(Date),
        );
      }
    },
  );

  it("returns an empty result while preserving the last-good freshness cursor", async () => {
    const subject = service({
      feed: {
        status: "ok",
        value: { products: [] },
        etag: null,
        contentHash: "empty",
        usage: { total: null, method: null },
      },
      published: { status: "not_found" },
    });
    await expect(subject.service.lookup(tenantId, productId)).resolves.toEqual({
      outcome: "empty",
      cards: [],
    });
    expect(subject.repo.markNotFound).toHaveBeenCalledWith(
      tenantId,
      productId,
      "feed_product",
      expect.any(Date),
    );
    expect(subject.repo.markNotFound).toHaveBeenCalledWith(
      tenantId,
      productId,
      "product",
      expect.any(Date),
    );
    expect(subject.repo.storeCards).not.toHaveBeenCalled();
  });

  it("uses a stored provider ETag and advances only freshness after 304", async () => {
    const existing = {
      snapshotId: "00000000-0000-4000-8000-000000000007",
      cardId: "7",
      cardStatus: "published",
      sourceMethod: "feed_product" as const,
      changed: false,
    };
    const repo = repository({
      findProviderEtag: vi.fn(async () => '"feed-etag"'),
      markNotModified: vi.fn(async () => [existing]),
    });
    const subject = service({ repository: repo, feed: { status: "not_modified" } });

    await expect(subject.service.lookup(tenantId, productId)).resolves.toEqual({
      outcome: "found",
      cards: [existing],
    });
    expect(subject.client.getFeedProducts).toHaveBeenCalledWith(
      { baseUrl: "https://catalog.example", token: "secret" },
      [gtin],
      { ifNoneMatch: '"feed-etag"' },
    );
    expect(repo.markNotModified).toHaveBeenCalledWith(
      tenantId,
      productId,
      "feed_product",
      expect.any(Date),
    );
    expect(repo.storeCards).not.toHaveBeenCalled();
  });

  it.each(["unconfigured", "missing", "expired", "undecryptable"] as const)(
    "returns token_%s without calling the provider",
    async (status) => {
      const subject = service({ token: { status } });
      await expect(subject.service.lookup(tenantId, productId)).resolves.toEqual({
        outcome: `token_${status}`,
        cards: [],
      });
      expect(subject.client.getFeedProducts).not.toHaveBeenCalled();
    },
  );
});
