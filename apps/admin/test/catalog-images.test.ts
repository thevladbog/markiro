import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../src/api/client.js";
import { productImageUrl, type ProductDto } from "../src/pages/catalog/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("catalog product images", () => {
  it("uses the immutable checksum route and does not expose asset metadata", () => {
    const product = {
      id: "product-1",
      image: {
        checksum: "a".repeat(64),
        contentType: "image/webp",
        byteSize: 12,
        width: 4,
        height: 3,
      },
    } as Pick<ProductDto, "id" | "image">;
    expect(productImageUrl(product)).toBe(`/api/products/product-1/image/${"a".repeat(64)}`);
  });

  it("lets fetch set the multipart boundary for image uploads", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      expect(
        (init?.headers as Record<string, string> | undefined)?.["Content-Type"],
      ).toBeUndefined();
      return { ok: true, status: 204, json: async () => undefined } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const body = new FormData();
    body.append("image", new File(["webp"], "photo.webp", { type: "image/webp" }));
    await apiFetch<void>("/products/product-1/image", { method: "POST", body });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
