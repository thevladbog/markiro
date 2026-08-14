import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  prefetchStationProductImage,
  readCachedStationProductImage,
  readStationProductImage,
  syncStationProductImage,
} from "../src/lib/product-image-cache.js";

function nodeExecutor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

const descriptor = {
  checksum: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
  contentType: "image/webp" as const,
  byteSize: 4,
  width: 2,
  height: 2,
};

async function insertProduct(exec: SqlExecutor): Promise<void> {
  await exec.run(
    `INSERT INTO product_mirror (
       id, gtin14, name, status, image_checksum, image_content_type,
       image_byte_size, image_width, image_height
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "p1",
      "04600000000017",
      "Cola",
      "active",
      descriptor.checksum,
      descriptor.contentType,
      descriptor.byteSize,
      descriptor.width,
      descriptor.height,
    ],
  );
}

describe("station product image cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists and reads an image when Windows WebView has no Cache Storage", async () => {
    vi.stubGlobal("caches", undefined);
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await insertProduct(exec);
    const source = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/webp" });

    await syncStationProductImage(
      exec,
      { download: vi.fn().mockResolvedValue(source) },
      { id: "p1", image: descriptor },
    );

    const stored = await readStationProductImage(exec, "p1", descriptor);
    expect(stored?.type).toBe("image/webp");
    if (!stored) throw new Error("expected the SQLite image to be readable");
    expect([...new Uint8Array(await stored.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(
      await exec.all("SELECT image_pointer_checksum FROM product_mirror WHERE id = ?", ["p1"]),
    ).toEqual([{ image_pointer_checksum: descriptor.checksum }]);
  });

  it("keeps a prefetched unopened-shift image when another product publishes its pointer", async () => {
    vi.stubGlobal("caches", undefined);
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await insertProduct(exec);
    const prefetchedDescriptor = {
      checksum: "c42522128b49193de8cd45d8f7589cd7e085e65f138640d57d4482e5f7189623",
      contentType: "image/webp" as const,
      byteSize: 2,
      width: 1,
      height: 1,
    };

    await prefetchStationProductImage(
      {
        download: vi
          .fn()
          .mockResolvedValue(new Blob([new Uint8Array([5, 6])], { type: "image/webp" })),
      },
      { id: "p2", image: prefetchedDescriptor },
      undefined,
      exec,
    );
    await syncStationProductImage(
      exec,
      {
        download: vi
          .fn()
          .mockResolvedValue(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/webp" })),
      },
      { id: "p1", image: descriptor },
    );

    const prefetched = await readCachedStationProductImage("p2", prefetchedDescriptor, exec);
    if (!prefetched) throw new Error("expected the prefetched image to remain cached");
    expect([...new Uint8Array(await prefetched.arrayBuffer())]).toEqual([5, 6]);
  });

  it("keeps shared prefetched bytes when another product receives an image tombstone", async () => {
    vi.stubGlobal("caches", undefined);
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await insertProduct(exec);
    const source = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/webp" });

    await syncStationProductImage(
      exec,
      { download: vi.fn().mockResolvedValue(source) },
      { id: "p1", image: descriptor },
    );
    await prefetchStationProductImage(
      { download: vi.fn().mockRejectedValue(new Error("download must not be needed")) },
      { id: "p2", image: descriptor },
      undefined,
      exec,
    );
    await syncStationProductImage(
      exec,
      { download: vi.fn().mockRejectedValue(new Error("download must not be needed")) },
      { id: "p1", image: null },
    );

    const shared = await readCachedStationProductImage("p2", descriptor, exec);
    if (!shared) throw new Error("expected shared prefetched bytes to remain cached");
    expect([...new Uint8Array(await shared.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });
});
