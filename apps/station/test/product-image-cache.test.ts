import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  clearStationProductImages,
  prefetchStationProductImage,
  readCachedStationProductImage,
  readStationProductImage,
  stationProductImageCacheKey,
  subscribeStationProductImageCache,
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function checksumBuffer(checksum: string): ArrayBuffer {
  const buffer = new ArrayBuffer(checksum.length / 2);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(checksum.slice(index * 2, index * 2 + 2), 16);
  }
  return buffer;
}

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

  it("does not publish downloaded bytes after the credential is sealed during validation", async () => {
    const cachePut = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({
        match: vi.fn().mockResolvedValue(undefined),
        put: cachePut,
      }),
      delete: vi.fn().mockResolvedValue(true),
    });
    const digest = deferred<ArrayBuffer>();
    const digestCall = vi.fn().mockReturnValue(digest.promise);
    vi.stubGlobal("crypto", { subtle: { digest: digestCall } });
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await insertProduct(exec);
    let sealed = false;

    const syncing = syncStationProductImage(
      exec,
      {
        download: vi
          .fn()
          .mockResolvedValue(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/webp" })),
      },
      { id: "p1", image: descriptor },
      () => sealed,
    );
    await vi.waitFor(() => expect(digestCall).toHaveBeenCalledOnce());
    sealed = true;
    await clearStationProductImages(exec);
    digest.resolve(checksumBuffer(descriptor.checksum));
    await syncing;

    expect(await exec.all("SELECT checksum FROM station_product_images")).toEqual([]);
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("does not copy browser-cached bytes into SQLite after sealing during validation", async () => {
    const digest = deferred<ArrayBuffer>();
    const digestCall = vi.fn().mockReturnValue(digest.promise);
    vi.stubGlobal("crypto", { subtle: { digest: digestCall } });
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({
        match: vi.fn().mockResolvedValue(
          new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "Content-Type": "image/webp" },
          }),
        ),
        delete: vi.fn().mockResolvedValue(true),
      }),
      delete: vi.fn().mockResolvedValue(true),
    });
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await insertProduct(exec);
    let sealed = false;

    const syncing = syncStationProductImage(
      exec,
      { download: vi.fn().mockRejectedValue(new Error("download must not be needed")) },
      { id: "p1", image: descriptor },
      () => sealed,
    );
    await vi.waitFor(() => expect(digestCall).toHaveBeenCalledOnce());
    sealed = true;
    await clearStationProductImages(exec);
    digest.resolve(checksumBuffer(descriptor.checksum));
    await syncing;

    expect(await exec.all("SELECT checksum FROM station_product_images")).toEqual([]);
  });

  it("rejects and deletes an invalid browser entry when only retained pointer metadata is available", async () => {
    const cacheDelete = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({
        match: vi.fn().mockResolvedValue(
          new Response(new Uint8Array([9, 9, 9, 9]), {
            headers: { "Content-Type": "image/webp" },
          }),
        ),
        delete: cacheDelete,
      }),
    });
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await insertProduct(exec);
    await exec.run("UPDATE product_mirror SET image_pointer_checksum = ? WHERE id = ?", [
      descriptor.checksum,
      "p1",
    ]);

    await expect(readStationProductImage(exec, "p1", undefined)).resolves.toBeNull();
    expect(cacheDelete).toHaveBeenCalledWith(
      stationProductImageCacheKey("p1", descriptor.checksum),
    );
  });
});

describe("station product image cache announcements", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("announces a product once its image becomes readable", async () => {
    vi.stubGlobal("caches", undefined);
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await insertProduct(exec);
    const announced: string[] = [];
    const unsubscribe = subscribeStationProductImageCache((productId) => {
      announced.push(productId);
    });

    try {
      await syncStationProductImage(
        exec,
        {
          download: vi
            .fn()
            .mockResolvedValue(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/webp" })),
        },
        { id: "p1", image: descriptor },
      );
    } finally {
      unsubscribe();
    }

    expect(announced).toEqual(["p1"]);
    // The announcement means precisely "this now reads back", so a subscriber
    // that re-reads on it is guaranteed to find bytes rather than another null.
    expect(await readStationProductImage(exec, "p1", descriptor)).not.toBeNull();
  });

  it("stays silent when a later sync finds the same image already cached", async () => {
    vi.stubGlobal("caches", undefined);
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await insertProduct(exec);
    const download = vi
      .fn()
      .mockResolvedValue(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/webp" }));
    await syncStationProductImage(exec, { download }, { id: "p1", image: descriptor });

    const announced: string[] = [];
    const unsubscribe = subscribeStationProductImageCache((productId) => {
      announced.push(productId);
    });
    try {
      // Re-entering the same shift mirrors the bundle again. Nothing about the
      // photo changed, so nothing should be asked to re-read it.
      await syncStationProductImage(exec, { download }, { id: "p1", image: descriptor });
    } finally {
      unsubscribe();
    }

    expect(announced).toEqual([]);
  });

  it("announces again when the product's image is replaced by a different one", async () => {
    vi.stubGlobal("caches", undefined);
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await insertProduct(exec);
    await syncStationProductImage(
      exec,
      {
        download: vi
          .fn()
          .mockResolvedValue(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/webp" })),
      },
      { id: "p1", image: descriptor },
    );
    const replacement = {
      checksum: "c42522128b49193de8cd45d8f7589cd7e085e65f138640d57d4482e5f7189623",
      contentType: "image/webp" as const,
      byteSize: 2,
      width: 1,
      height: 1,
    };
    await exec.run("UPDATE product_mirror SET image_checksum = ? WHERE id = ?", [
      replacement.checksum,
      "p1",
    ]);

    const announced: string[] = [];
    const unsubscribe = subscribeStationProductImageCache((productId) => {
      announced.push(productId);
    });
    try {
      await syncStationProductImage(
        exec,
        {
          download: vi
            .fn()
            .mockResolvedValue(new Blob([new Uint8Array([5, 6])], { type: "image/webp" })),
        },
        { id: "p1", image: replacement },
      );
    } finally {
      unsubscribe();
    }

    expect(announced).toEqual(["p1"]);
  });
});
