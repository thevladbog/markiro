import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProductPhoto } from "../src/floor/shifts/ProductPhoto.js";
import { ShiftCard } from "../src/floor/shifts/ShiftCard.js";
import type { ShiftCopy } from "../src/floor/shifts/shift-copies.js";
import type { ProductPhotoState } from "../src/host/protocol.js";
import type { ChangeItem } from "../src/host/protocol.js";
import {
  PHOTOS_PER_PASS,
  onProductPhotosChanged,
  readProductPhoto,
  syncProductPhotos,
} from "../src/local/product-photos.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

afterEach(cleanup);

const A = "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b";
const B = "0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
const SUM_1 = "a".repeat(64);
const SUM_2 = "b".repeat(64);
/** 13 bytes that start with the JPEG signature, as `product-photo-put.json`. */
const DATA = "/9j/4AAQSkZJRgABAQ==";

function productItem(id: string, rev: number, photoChecksum: string | null): ChangeItem {
  return {
    entity: "products",
    id,
    rev,
    deleted: false,
    data: {
      gtin14: id === A ? "04600682000013" : "04600682000020",
      name: "Молоко",
      printName: null,
      chzProductGroupCode: 8,
      boxCapacity: 12,
      palletBoxCapacity: null,
      shelfLifeDays: 10,
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: null,
      archived: false,
      status: "active",
      photoChecksum,
    },
  };
}

async function feedProducts(items: ChangeItem[], rev: number, since = 0) {
  const { db, executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev, hasMore: false, items }),
    local: executor,
    hostId: HOST_ID,
    deviceId: DEVICE_ID,
  });
  void since;
  return { db, executor };
}

const photo = (checksum: string): ProductPhotoState => ({
  photo: {
    width: 2,
    height: 1,
    dataBase64: DATA,
    mediaType: "image/jpeg",
    checksum,
    updatedAt: "2026-10-14T10:00:00.000Z",
  },
});

const rows = (db: DatabaseSync, sql: string) =>
  Array.from(db.prepare(sql).all(), (row) => ({ ...row }));

describe("the feed's product record names the photo", () => {
  it("keeps the checksum on the product copy, null for a record without one", async () => {
    const { db } = await feedProducts([productItem(A, 5, SUM_1), productItem(B, 6, null)], 6);
    expect(rows(db, "SELECT id, photo_checksum FROM ref_products ORDER BY id")).toEqual([
      { id: B, photo_checksum: null },
      { id: A, photo_checksum: SUM_1 },
    ]);
  });

  it("reads a record from a host that does not name the photo as having none", async () => {
    const item = productItem(A, 5, null);
    delete (item.data as Record<string, unknown>)["photoChecksum"];
    const { db } = await feedProducts([item], 5);
    expect(rows(db, "SELECT photo_checksum FROM ref_products")).toEqual([{ photo_checksum: null }]);
  });
});

describe("syncProductPhotos", () => {
  it("fetches the photos the records name and stores them whole", async () => {
    const { db, executor } = await feedProducts(
      [productItem(A, 5, SUM_1), productItem(B, 6, null)],
      6,
    );
    const fetchPhoto = vi.fn(async () => photo(SUM_1));
    const result = await syncProductPhotos({ local: executor, fetchPhoto });
    expect(result).toEqual({ stored: 1, dropped: 0 });
    // Only the product that has one is asked for.
    expect(fetchPhoto.mock.calls).toEqual([[A]]);
    expect(
      rows(db, "SELECT product_id, checksum, width, height, data_base64 FROM ref_product_photos"),
    ).toEqual([{ product_id: A, checksum: SUM_1, width: 2, height: 1, data_base64: DATA }]);
    expect(await readProductPhoto(executor, A)).toEqual({
      src: `data:image/jpeg;base64,${DATA}`,
      checksum: SUM_1,
      mediaType: "image/jpeg",
    });
    expect(await readProductPhoto(executor, B)).toBeNull();
  });

  it("keeps a transparent PNG's media type and shows it as a PNG, an old copy as a JPEG", async () => {
    const { db, executor } = await feedProducts([productItem(A, 5, SUM_1)], 5);
    await syncProductPhotos({
      local: executor,
      fetchPhoto: async () => ({ photo: { ...photo(SUM_1).photo!, mediaType: "image/png" } }),
    });
    expect(rows(db, "SELECT media_type FROM ref_product_photos")).toEqual([
      { media_type: "image/png" },
    ]);
    expect(await readProductPhoto(executor, A)).toEqual({
      src: `data:image/png;base64,${DATA}`,
      checksum: SUM_1,
      mediaType: "image/png",
    });
    // A copy stored before migration 0019 has the column's default.
    db.exec("DELETE FROM ref_product_photos");
    db.prepare(
      "INSERT INTO ref_product_photos (product_id, checksum, width, height, data_base64) VALUES (?, ?, 2, 1, ?)",
    ).run(A, SUM_1, DATA);
    expect((await readProductPhoto(executor, A))?.src).toBe(`data:image/jpeg;base64,${DATA}`);
    expect((await readProductPhoto(executor, A))?.mediaType).toBe("image/jpeg");
  });

  it("fetches nothing again while the stored checksum is the record's, and again when it changes", async () => {
    const { db, executor } = await feedProducts([productItem(A, 5, SUM_1)], 5);
    const fetchPhoto = vi.fn(async () => photo(SUM_1));
    await syncProductPhotos({ local: executor, fetchPhoto });
    await syncProductPhotos({ local: executor, fetchPhoto });
    expect(fetchPhoto).toHaveBeenCalledTimes(1);
    // The host's photo changed: the record's checksum moves.
    db.prepare("UPDATE ref_products SET photo_checksum = ? WHERE id = ?").run(SUM_2, A);
    fetchPhoto.mockResolvedValueOnce(photo(SUM_2));
    await syncProductPhotos({ local: executor, fetchPhoto });
    expect(fetchPhoto).toHaveBeenCalledTimes(2);
    expect(rows(db, "SELECT checksum FROM ref_product_photos")).toEqual([{ checksum: SUM_2 }]);
  });

  it("drops the photo of a product that has none any more", async () => {
    const { db, executor } = await feedProducts([productItem(A, 5, SUM_1)], 5);
    await syncProductPhotos({ local: executor, fetchPhoto: async () => photo(SUM_1) });
    db.prepare("UPDATE ref_products SET photo_checksum = NULL WHERE id = ?").run(A);
    const result = await syncProductPhotos({
      local: executor,
      fetchPhoto: () => Promise.reject(new Error("nothing to fetch")),
    });
    expect(result).toEqual({ stored: 0, dropped: 1 });
    expect(await readProductPhoto(executor, A)).toBeNull();
  });

  it("stores nothing for a photo the host cleared meanwhile", async () => {
    const { db, executor } = await feedProducts([productItem(A, 5, SUM_1)], 5);
    const result = await syncProductPhotos({
      local: executor,
      fetchPhoto: async () => ({ photo: null }),
    });
    expect(result).toEqual({ stored: 0, dropped: 0 });
    expect(rows(db, "SELECT * FROM ref_product_photos")).toEqual([]);
  });

  it("keeps what it stored when a later fetch fails, rejects, and announces the change", async () => {
    const { executor } = await feedProducts(
      [productItem(A, 5, SUM_1), productItem(B, 6, SUM_2)],
      6,
    );
    const announced = vi.fn();
    const stop = onProductPhotosChanged(announced);
    const fetchPhoto = vi.fn(async (id: string) => {
      // The pass goes by id: B first, then A, which fails.
      if (id === A) throw new Error("offline");
      return photo(SUM_2);
    });
    await expect(syncProductPhotos({ local: executor, fetchPhoto })).rejects.toThrow("offline");
    stop();
    expect(await readProductPhoto(executor, B)).not.toBeNull();
    expect(await readProductPhoto(executor, A)).toBeNull();
    expect(announced).toHaveBeenCalledTimes(1);
  });

  it("fetches at most one pass worth of photos at a time", async () => {
    const items = Array.from({ length: PHOTOS_PER_PASS + 3 }, (_, index) =>
      productItem(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, index + 1, SUM_1),
    );
    const { executor } = await feedProducts(items, items.length);
    const fetchPhoto = vi.fn(async () => photo(SUM_1));
    await syncProductPhotos({ local: executor, fetchPhoto });
    expect(fetchPhoto).toHaveBeenCalledTimes(PHOTOS_PER_PASS);
    await syncProductPhotos({ local: executor, fetchPhoto });
    expect(fetchPhoto).toHaveBeenCalledTimes(PHOTOS_PER_PASS + 3);
  });
});

describe("ProductPhoto", () => {
  it("shows the stored picture, and the fallback without one", async () => {
    const { executor } = await feedProducts([productItem(A, 5, SUM_1)], 5);
    const view = render(
      <ProductPhoto local={executor} productId={A} fallback={<span>монограмма</span>} />,
    );
    expect(screen.getByText("монограмма")).toBeTruthy();
    await syncProductPhotos({ local: executor, fetchPhoto: async () => photo(SUM_1) });
    await waitFor(() => expect(view.container.querySelector("img.product-photo")).not.toBeNull());
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      `data:image/jpeg;base64,${DATA}`,
    );
    expect(screen.queryByText("монограмма")).toBeNull();
  });

  it("falls back to the monogram when the picture does not decode", async () => {
    const { executor } = await feedProducts([productItem(A, 5, SUM_1)], 5);
    await syncProductPhotos({ local: executor, fetchPhoto: async () => photo(SUM_1) });
    const view = render(
      <ProductPhoto local={executor} productId={A} fallback={<span>монограмма</span>} />,
    );
    const image = await waitFor(() => {
      const found = view.container.querySelector("img");
      expect(found).not.toBeNull();
      return found as HTMLImageElement;
    });
    image.dispatchEvent(new Event("error"));
    await waitFor(() => expect(screen.getByText("монограмма")).toBeTruthy());
    expect(view.container.querySelector("img")).toBeNull();
  });
});

const COPY: ShiftCopy = {
  id: "bbbbbbbb-0000-4000-8000-000000000001",
  number: "OCT26-004",
  status: "planned",
  localState: null,
  mode: "aggregation",
  palletsEnabled: false,
  createdFrom: "office",
  lineId: "33333333-3333-4333-8333-333333333333",
  productId: A,
  productPrintName: null,
  productName: "Молоко 3,2% 0,9 л",
  productGtin14: "04600682000013",
  counterpartyName: null,
  productionDate: "2026-10-14",
  plannedDate: null,
  plannedQty: 1200,
  boxCapacity: 12,
  boxTemplateId: "44444444-4444-4444-8444-444444444444",
  palletBoxCapacity: null,
  palletTemplateId: null,
  ownerDeviceId: null,
  openedAt: null,
  closedAt: null,
  entered: false,
};

describe("the shift card", () => {
  const card = (local?: Awaited<ReturnType<typeof feedProducts>>["executor"]) =>
    render(
      <ShiftCard
        copy={COPY}
        action={{ kind: "open", enabled: true }}
        busy={false}
        onAction={() => undefined}
        {...(local === undefined ? {} : { local })}
      />,
    );

  it("marks a demo shift «Демо» beside its number (spec 2026-10-21)", () => {
    const view = render(
      <ShiftCard
        copy={{ ...COPY, number: "DEMO-001" }}
        action={{ kind: "open", enabled: true }}
        busy={false}
        onAction={() => undefined}
      />,
    );
    expect(view.getByText("Демо")).toBeTruthy();
    view.unmount();
    expect(card().queryByText("Демо")).toBeNull();
  });

  it("shows the product's photo on its panel once the station holds it", async () => {
    const { executor } = await feedProducts([productItem(A, 5, SUM_1)], 5);
    await syncProductPhotos({ local: executor, fetchPhoto: async () => photo(SUM_1) });
    const view = card(executor);
    await waitFor(() =>
      expect(view.container.querySelector(".shift-card__photo img.product-photo")).not.toBeNull(),
    );
    expect(view.container.querySelector(".shift-card__photo-monogram")).toBeNull();
  });

  it("fills the panel with a photo that has its own background: a JPEG stands on no gradient", async () => {
    const { executor } = await feedProducts([productItem(A, 5, SUM_1)], 5);
    await syncProductPhotos({ local: executor, fetchPhoto: async () => photo(SUM_1) });
    const view = card(executor);
    await waitFor(() =>
      expect(view.container.querySelector(".shift-card__photo img.product-photo")).not.toBeNull(),
    );
    const panel = view.container.querySelector(".shift-card__photo");
    expect(panel?.getAttribute("data-photo-backing")).toBe("none");
    // The tags stay on the panel, over the picture.
    expect(panel?.querySelector(".shift-card__tags")?.textContent).toContain("Агрегация");
  });

  it("keeps a PNG whose edge is not read yet (a cut-out until proven otherwise) on the brand gradient", async () => {
    const { executor } = await feedProducts([productItem(A, 5, SUM_1)], 5);
    await syncProductPhotos({
      local: executor,
      fetchPhoto: async () => {
        const state = photo(SUM_1);
        return state.photo === null ? state : { photo: { ...state.photo, mediaType: "image/png" } };
      },
    });
    const view = card(executor);
    await waitFor(() =>
      expect(view.container.querySelector(".shift-card__photo img.product-photo")).not.toBeNull(),
    );
    expect(
      view.container.querySelector(".shift-card__photo")?.getAttribute("data-photo-backing"),
    ).toBe("gradient");
  });

  it("puts the monogram back on the gradient when an opaque photo will not decode", async () => {
    const { executor } = await feedProducts([productItem(A, 5, SUM_1)], 5);
    await syncProductPhotos({ local: executor, fetchPhoto: async () => photo(SUM_1) });
    const view = card(executor);
    const image = await waitFor(() => {
      const found = view.container.querySelector(".shift-card__photo img.product-photo");
      expect(found).not.toBeNull();
      return found as HTMLImageElement;
    });
    fireEvent.error(image);
    await waitFor(() =>
      expect(view.container.querySelector(".shift-card__photo-monogram")).not.toBeNull(),
    );
    expect(
      view.container.querySelector(".shift-card__photo")?.getAttribute("data-photo-backing"),
    ).toBe("gradient");
  });

  it("keeps the monogram on the colour panel for a product with no photo, and where no database is given", async () => {
    const { executor } = await feedProducts([productItem(A, 5, null)], 5);
    const view = card(executor);
    await waitFor(() =>
      expect(view.container.querySelector(".shift-card__photo-monogram")).not.toBeNull(),
    );
    expect(view.container.querySelector("img")).toBeNull();
    cleanup();
    const bare = card();
    expect(bare.container.querySelector(".shift-card__photo-monogram")?.textContent).toBe("М");
  });
});
