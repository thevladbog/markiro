import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";

export const profile = {
  productId: "a0000000-0000-4000-8000-000000000001",
  revision: 0,
  productName: "Apple cups",
  brandName: null,
  commodity: null,
  variety: null,
  packagingSizeValue: null,
  packagingSizeUom: null,
  packagingStyle: null,
  defaultQuantityUom: null,
  coverageStatus: "unknown",
  coverageRationale: null,
  ftlCategory: null,
  ftlSourceUrl: null,
  ftlSourceVersion: null,
  reviewedBy: null,
  reviewedAt: null,
  createdAt: null,
  updatedAt: null,
};
const input = {
  productName: "Apple cups",
  brandName: null,
  commodity: null,
  variety: null,
  packagingSizeValue: "6.125",
  packagingSizeUom: "oz",
  packagingStyle: null,
  defaultQuantityUom: "case",
  coverageStatus: "unknown",
  coverageRationale: null,
  ftlCategory: null,
  ftlSourceUrl: null,
  ftlSourceVersion: null,
  expectedRevision: 0,
};
const path = `/api/us/traceability/products/${profile.productId}`;
const transport = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body, { status }));

describe("US product-profile client", () => {
  it("uses the isolated UUID route and sends exact decimal strings and revision", async () => {
    const send = transport(profile);
    const client = createUsBrowserClient(send);
    expect(await client.getProductProfile(profile.productId.toUpperCase())).toEqual(profile);
    await client.putProductProfile(profile.productId, input);
    expect(send.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [path, "GET"],
      [path, "PUT"],
    ]);
    expect(send.mock.lastCall?.[1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify(input),
    });
  });
  it("rejects forged metadata, invalid identity and imprecise quantities before transport", async () => {
    const send = transport(profile);
    const client = createUsBrowserClient(send);
    await expect(client.getProductProfile("../profile")).rejects.toMatchObject({
      code: "invalid_input",
    });
    for (const patch of [
      { reviewedBy: "forged" },
      { tenantId: "foreign" },
      { expectedRevision: -1 },
      { packagingSizeValue: 6 },
      { packagingSizeValue: "6.1234" },
    ])
      await expect(
        client.putProductProfile(profile.productId, { ...input, ...patch }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects malformed responses and mismatched product identity", async () => {
    for (const patch of [
      { revision: 1 },
      { tenantId: "private" },
      { productId: "b0000000-0000-4000-8000-000000000002" },
    ])
      await expect(
        createUsBrowserClient(transport({ ...profile, ...patch })).getProductProfile(
          profile.productId,
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("returns a safe conflict once, without retrying or retaining server details", async () => {
    const send = transport({ code: "product_profile_conflict", message: "private" }, 409);
    await expect(
      createUsBrowserClient(send).putProductProfile(profile.productId, input),
    ).rejects.toMatchObject({ code: "conflict", message: "conflict" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
