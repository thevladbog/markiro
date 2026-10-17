import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { LocalExecutor } from "../src/local/executor.js";
import { ProductPanel } from "../src/floor/shifts/ProductPhoto.js";

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

function panel(mediaType: string, faceAlways: boolean) {
  const view = render(
    <ProductPanel
      local={holding(mediaType)}
      productId="p"
      className="panel"
      fallback={null}
      faceAlways={faceAlways}
    />,
  );
  return view.container.querySelector(".panel") as HTMLElement;
}

describe("a product panel wider than its photo (owner photo, beta 4.5: flat navy behind the bottle)", () => {
  it("takes the photo's own backing by default: an opaque JPEG fills a square and needs none", async () => {
    const element = panel("image/jpeg", false);
    await waitFor(() => expect(element.querySelector("img")).not.toBeNull());
    expect(element.getAttribute("data-photo-backing")).toBe("none");
  });

  it("stands on the brand gradient whatever the photo is, so the bands round a fitted picture are not the card's flat face", async () => {
    const element = panel("image/jpeg", true);
    await waitFor(() => expect(element.querySelector("img")).not.toBeNull());
    expect(element.getAttribute("data-photo-backing")).toBe("gradient");
  });
});
