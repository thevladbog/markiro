import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { LocalExecutor } from "../src/local/executor.js";
import { ProductPanel } from "../src/floor/shifts/ProductPhoto.js";

afterEach(cleanup);

/** A local database holding one stored photo of `mediaType` for any product. */
function holding(mediaType: string): LocalExecutor {
  return {
    query: (() =>
      Promise.resolve([
        { checksum: `c-${mediaType}`, data_base64: "AAAA", media_type: mediaType },
      ])) as LocalExecutor["query"],
    transaction: () => Promise.resolve([]),
  };
}

function panel(mediaType: string) {
  const view = render(
    <ProductPanel
      local={holding(mediaType)}
      productId="p"
      className="panel"
      fallback={<span className="monogram">М</span>}
    />,
  );
  return view.container.querySelector(".panel") as HTMLElement;
}

describe("a product panel takes its photo's own backing (owner, 2026-10-20)", () => {
  it("needs none behind an opaque JPEG: the picture fills the panel", async () => {
    const element = panel("image/jpeg");
    await waitFor(() => expect(element.querySelector("img")).not.toBeNull());
    expect(element.getAttribute("data-photo-backing")).toBe("none");
  });

  it("stands on the brand gradient while a PNG's edge is not read", async () => {
    const element = panel("image/png");
    await waitFor(() => expect(element.querySelector("img")).not.toBeNull());
    expect(element.getAttribute("data-photo-backing")).toBe("gradient");
  });

  it("puts the monogram back on the gradient when the photo will not decode", async () => {
    const element = panel("image/jpeg");
    const image = await waitFor(() => {
      const found = element.querySelector("img");
      expect(found).not.toBeNull();
      return found as HTMLImageElement;
    });
    fireEvent.error(image);
    await waitFor(() => expect(element.querySelector(".monogram")).not.toBeNull());
    expect(element.getAttribute("data-photo-backing")).toBe("gradient");
  });
});
