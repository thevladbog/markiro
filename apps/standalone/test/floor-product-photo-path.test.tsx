import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProductPanel } from "../src/floor/shifts/ProductPhoto.js";
import { ShiftBand } from "../src/floor/work/WorkInstruments.js";
import { productPhotoStateSchema, type ChangeItem } from "../src/host/protocol.js";
import { PHOTOS_PER_PASS, syncAllProductPhotos } from "../src/local/product-photos.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { fixture } from "./support/proto-fixture.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

afterEach(cleanup);

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const checksum = (index: number) => String(index % 10).repeat(63) + "a";

function productItem(index: number): ChangeItem {
  return {
    entity: "products",
    id: id(index),
    rev: index + 1,
    deleted: false,
    data: {
      gtin14: `0460068200${String(1000 + index).padStart(4, "0")}`,
      name: `Товар ${index}`,
      printName: null,
      chzProductGroupCode: 8,
      boxCapacity: 12,
      palletBoxCapacity: null,
      shelfLifeDays: 10,
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: null,
      archived: false,
      status: "active",
      photoChecksum: checksum(index),
    },
  };
}

describe("a product's photo, from the host's answer to the rendered picture (beta 3.2)", () => {
  it("every photo the records name reaches the station in one run, not only the first pass's", async () => {
    // More products with photos than a pass takes: the rest used to wait for a sync that
    // might be hours away, so their cards stayed on the monogram.
    const count = PHOTOS_PER_PASS * 2 + 7;
    const items = Array.from({ length: count }, (_, index) => productItem(index));
    const { executor } = openLocalDb();
    await syncReferences({
      changes: async () => ({ hostId: HOST_ID, rev: count + 1, hasMore: false, items }),
      local: executor,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
    });
    // The host's own answer shape, as the Zod schema of the device route reads it.
    const answer = productPhotoStateSchema.parse(fixture("product-photo-state.json"));
    const fetchPhoto = vi.fn(async (productId: string) => {
      const index = Number(productId.slice(-12));
      return answer.photo === null
        ? answer
        : { photo: { ...answer.photo, checksum: checksum(index) } };
    });
    const result = await syncAllProductPhotos({ local: executor, fetchPhoto });
    expect(result.stored).toBe(count);
    expect(fetchPhoto).toHaveBeenCalledTimes(count);
    // Nothing is fetched twice by the next run.
    await syncAllProductPhotos({ local: executor, fetchPhoto });
    expect(fetchPhoto).toHaveBeenCalledTimes(count);

    // The last product (the one a single pass leaves out) shows its picture in the shift
    // band of the work screen and on a card's panel.
    const last = count - 1;
    const band = render(
      <ShiftBand
        productName="Товар"
        gtin="04600682001000"
        number="OCT26-001"
        counterpartyName={null}
        accepted={0}
        plannedQty={null}
        modeLabel="Проверка"
        local={executor}
        productId={id(last)}
      />,
    );
    await waitFor(() => expect(band.container.querySelector("img.product-photo")).not.toBeNull());
    expect(band.container.querySelector("img.product-photo")?.getAttribute("src")).toMatch(
      /^data:image\/jpeg;base64,/,
    );
    expect(band.container.querySelector(".work-shift-band__monogram")).toBeNull();
    const panel = render(
      <ProductPanel
        local={executor}
        productId={id(last)}
        className="shift-card__photo"
        fallback={<span>монограмма</span>}
      />,
    );
    await waitFor(() => expect(panel.container.querySelector("img.product-photo")).not.toBeNull());
  });

  it("a product without a photo keeps the monogram; the band takes no per-product colour (kit)", async () => {
    const { executor } = openLocalDb();
    const view = render(
      <ShiftBand
        productName="Молоко"
        gtin="04600682000013"
        number="OCT26-001"
        counterpartyName={null}
        accepted={0}
        plannedQty={null}
        modeLabel="Проверка"
        local={executor}
        productId={id(1)}
      />,
    );
    await waitFor(() =>
      expect(view.container.querySelector(".work-shift-band__monogram")?.textContent).toBe("М"),
    );
    expect(view.container.querySelector("img")).toBeNull();
    const band = view.container.querySelector<HTMLElement>(".work-shift-band");
    // The one brand gradient paints the band for every product (kit step C): no hue variable.
    expect(band?.style.getPropertyValue("--product-hue")).toBe("");
    expect(band?.getAttribute("data-accent")).toBeNull();
  });
});

describe("the product frame carries no per-product colour (station audit, 2026-10)", () => {
  it("a card's photo frame has no accent attribute or hue variable, with or without a photo", async () => {
    const { executor } = openLocalDb();
    const view = render(
      <ProductPanel
        local={executor}
        productId={id(1)}
        className="shift-card__photo"
        fallback={<span>монограмма</span>}
      />,
    );
    const bare = render(
      <ProductPanel
        local={undefined}
        productId={id(1)}
        className="shift-card__photo"
        fallback={<span>монограмма</span>}
      />,
    );
    for (const frame of [view.container.firstElementChild, bare.container.firstElementChild]) {
      expect(frame?.getAttribute("data-accent")).toBeNull();
      expect(frame?.getAttribute("style")).toBeNull();
      expect(frame?.textContent).toBe("монограмма");
    }
  });
});
