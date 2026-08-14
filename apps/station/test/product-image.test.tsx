import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const imageStore = vi.hoisted(() => ({
  readStationProductImage: vi.fn(),
  readCachedStationProductImage: vi.fn(),
}));

vi.mock("../src/lib/product-image-cache.js", () => imageStore);

import { ProductImage } from "../src/ui/ProductImage.js";

afterEach(() => {
  vi.restoreAllMocks();
  imageStore.readStationProductImage.mockReset();
  imageStore.readCachedStationProductImage.mockReset();
});

describe("ProductImage", () => {
  it("keeps a loaded image visible while a cache refresh is pending", async () => {
    const first = new Blob(["first"], { type: "image/webp" });
    let resolveRefresh: ((blob: Blob | null) => void) | undefined;
    const pendingRefresh = new Promise<Blob | null>((resolve) => {
      resolveRefresh = resolve;
    });
    imageStore.readStationProductImage
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(pendingRefresh);
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:refreshed");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const view = render(
      <ProductImage
        exec={{ all: async () => [], run: async () => {} }}
        productId="p1"
        productName="Tea"
        image={{
          checksum: "a".repeat(64),
          contentType: "image/webp",
          byteSize: 5,
          width: 1,
          height: 1,
        }}
        refreshKey={0}
      />,
    );
    await waitFor(
      () => expect(screen.getByRole("img", { name: "Tea" }).getAttribute("src")).toBe("blob:first"),
      { timeout: 250 },
    );

    view.rerender(
      <ProductImage
        exec={{ all: async () => [], run: async () => {} }}
        productId="p1"
        productName="Tea"
        image={{
          checksum: "a".repeat(64),
          contentType: "image/webp",
          byteSize: 5,
          width: 1,
          height: 1,
        }}
        refreshKey={1}
      />,
    );
    await waitFor(() => expect(imageStore.readStationProductImage).toHaveBeenCalledTimes(2));

    expect(screen.getByRole("img", { name: "Tea" }).getAttribute("src")).toBe("blob:first");

    resolveRefresh?.(new Blob(["refreshed"], { type: "image/webp" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Tea" }).getAttribute("src")).toBe("blob:refreshed"),
    );
  });

  it("keeps a loaded image visible when a background cache refresh fails", async () => {
    const descriptor = {
      checksum: "a".repeat(64),
      contentType: "image/webp" as const,
      byteSize: 5,
      width: 1,
      height: 1,
    };
    imageStore.readStationProductImage
      .mockResolvedValueOnce(new Blob(["first"], { type: "image/webp" }))
      .mockRejectedValueOnce(new Error("cache temporarily unavailable"));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:first");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const view = render(
      <ProductImage
        exec={{ all: async () => [], run: async () => {} }}
        productId="p1"
        productName="Tea"
        image={descriptor}
        refreshKey={0}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Tea" }).getAttribute("src")).toBe("blob:first"),
    );

    view.rerender(
      <ProductImage
        exec={{ all: async () => [], run: async () => {} }}
        productId="p1"
        productName="Tea"
        image={descriptor}
        refreshKey={1}
      />,
    );

    await waitFor(() => expect(imageStore.readStationProductImage).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Tea" }).getAttribute("src")).toBe("blob:first"),
    );
  });
});
