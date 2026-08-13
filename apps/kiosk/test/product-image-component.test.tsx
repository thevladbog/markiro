import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductImage } from "../src/ui/ProductImage.js";
import { clearProductImages, publishProductImage } from "../src/store/product-images.js";

afterEach(async () => {
  cleanup();
  await clearProductImages();
  vi.restoreAllMocks();
});

const image = {
  checksum: "a".repeat(64),
  contentType: "image/webp" as const,
  byteSize: 3,
  width: 10,
  height: 10,
};

describe("ProductImage", () => {
  it("renders the published blob and revokes its object URL on unmount", async () => {
    await publishProductImage("p1", image.checksum, new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }));
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const view = render(<ProductImage productId="p1" name="Молоко" image={image} />);

    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", "blob:test"));
    view.unmount();
    expect(create).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:test");
  });

  it("renders a retained pointer when a rolling legacy payload omits image", async () => {
    await publishProductImage("p1", image.checksum, new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:legacy");
    render(<ProductImage productId="p1" name="Молоко" />);

    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", "blob:legacy"));
  });

  it("fails closed to a monogram when the pointer is absent or mismatched", async () => {
    render(<ProductImage productId="p1" name="Молоко" image={image} />);
    expect(screen.getByText("М")).toBeDefined();
    await act(async () => Promise.resolve());
    expect(screen.queryByRole("img")).toBeNull();
  });
});
