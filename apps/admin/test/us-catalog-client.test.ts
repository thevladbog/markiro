import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";

const product = {
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Apple cups",
  gtin14: null,
  archived: false,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
};
const transport = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body, { status }));

describe("US catalog browser boundary", () => {
  it("encodes bounded search on the isolated catalog route", async () => {
    const send = transport({ items: [product], limit: 50, offset: 0 });
    expect(
      await createUsBrowserClient(send).listProducts({ search: " A&B ", archived: "all" }),
    ).toEqual({ items: [product], limit: 50, offset: 0 });
    expect(send).toHaveBeenCalledWith(
      "/api/us/traceability/catalog/products?archived=all&limit=50&offset=0&search=A%26B",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store", redirect: "error" }),
    );
  });

  it("creates without GTIN and distinguishes omitted from cleared GTIN on patch", async () => {
    const send = transport(product);
    const api = createUsBrowserClient(send);
    expect(await api.createProduct({ name: " Apple cups " })).toEqual(product);
    await api.updateProduct(product.id, { name: "Apple slices" });
    await api.updateProduct(product.id, { gtin: null });
    await api.updateProduct(product.id, { archived: true });
    await api.updateProduct(product.id, { archived: false });
    expect(send.mock.calls.map(([path, init]) => [path, init?.method, init?.body])).toEqual([
      ["/api/us/traceability/catalog/products", "POST", '{"name":"Apple cups","gtin":null}'],
      ...[
        '{"name":"Apple slices"}',
        '{"gtin":null}',
        '{"archived":true}',
        '{"archived":false}',
      ].map((body) => [`/api/us/traceability/catalog/products/${product.id}`, "PATCH", body]),
    ]);
    expect(await api.getProduct(product.id.toUpperCase())).toEqual(product);
    expect(send.mock.lastCall?.[0]).toBe(`/api/us/traceability/catalog/products/${product.id}`);
  });

  it("rejects invalid identity, forged authority, RU fields and malformed GTIN before sending", async () => {
    const send = transport(product);
    const api = createUsBrowserClient(send);
    for (const operation of [
      () => api.getProduct("../profile"),
      () => api.updateProduct(`${product.id}?tenantId=x`, { archived: true }),
      () => api.updateProduct(product.id, {}),
      () => api.createProduct({ name: "Apple", tenantId: "foreign" }),
      () => api.createProduct({ name: "Apple", chzProductGroupCode: "milk" }),
      () => api.createProduct({ name: "Apple", gtin: "123" }),
      () => api.listProducts({ limit: 101 }),
      () => api.listProducts({ offset: 100001 }),
      () => api.listProducts({ partyId: product.id }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "invalid_input" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects widened and malformed persisted responses", async () => {
    for (const value of [
      { ...product, gtin14: "123" },
      { ...product, tenantId: "private" },
    ]) {
      await expect(
        createUsBrowserClient(transport(value)).getProduct(product.id),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
    await expect(
      createUsBrowserClient(
        transport({ items: [product, product], limit: 1, offset: 0 }),
      ).listProducts(),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    [409, "product_gtin_taken", "product_gtin_taken"],
    [409, "product_gtin_locked", "product_gtin_locked"],
    [409, "private_unknown_error", "conflict"],
    [403, "product_gtin_taken", "forbidden"],
    [401, "session_required", "session_required"],
    [503, "us_database_unavailable", "unavailable"],
  ])("sanitizes %s / %s without retaining raw details or retrying", async (status, code, safe) => {
    const send = transport({ code, message: "private", tenantId: "secret" }, status);
    await expect(
      createUsBrowserClient(send).updateProduct(product.id, { gtin: null }),
    ).rejects.toMatchObject({ code: safe, message: safe });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
