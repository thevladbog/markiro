import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const imageStore = vi.hoisted(() => ({
  readStationProductImage: vi.fn(),
  readCachedStationProductImage: vi.fn(),
}));

vi.mock("../src/lib/product-image-cache.js", () => imageStore);

import { ProductImage } from "../src/ui/ProductImage.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  imageStore.readStationProductImage.mockReset();
  imageStore.readCachedStationProductImage.mockReset();
});

const DESCRIPTOR = {
  checksum: "a".repeat(64),
  contentType: "image/webp" as const,
  byteSize: 5,
  width: 1,
  height: 1,
};

/**
 * Advances fake time in SEPARATE `act` blocks rather than one long one.
 *
 * The retry is a chain: each timer's `setRetryKey` has to be rendered and its
 * effect has to run before the next timer is even scheduled. Inside `act`,
 * React queues that work on the act queue and flushes it only when the block
 * exits -- so a single `advanceTimersByTimeAsync(2_000)` fires every pending
 * timer against a component that never re-ran its effect in between, and the
 * chain silently stops after one step. One `act` per step is what actually
 * drives it.
 */
async function advanceInSteps(stepMs: number, steps: number) {
  for (let index = 0; index < steps; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stepMs);
    });
  }
}

/**
 * The component's retry is a real `setTimeout`, so these two tests drive it
 * with fake timers rather than by sleeping: the assertion is about how many
 * reads happen across a span of time, and a real sleep would only ever be
 * "long enough" by luck on a loaded runner.
 */
describe("ProductImage cache retry", () => {
  it("stops reading the cache once the photo is on screen", async () => {
    vi.useFakeTimers();
    imageStore.readStationProductImage.mockResolvedValue(
      new Blob(["first"], { type: "image/webp" }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:first");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    render(
      <ProductImage
        exec={{ all: async () => [], run: async () => {} }}
        productId="p1"
        productName="Tea"
        image={DESCRIPTOR}
        refreshKey={0}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("img", { name: "Tea" }).getAttribute("src")).toBe("blob:first");

    // Well past both retry deadlines (350ms and 700ms). A cached read that
    // already produced a validated blob has nothing to retry FOR -- the bytes
    // are checksum-checked, so re-reading can only yield the same image while
    // re-running `createObjectURL`/`revokeObjectURL` for nothing.
    await advanceInSteps(400, 6);
    expect(imageStore.readStationProductImage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "Tea" }).getAttribute("src")).toBe("blob:first");
  });

  it("keeps re-reading while the cache has nothing yet, then stops once it does", async () => {
    vi.useFakeTimers();
    // The genuine reason the retry exists: media sync runs independently of the
    // operational bundle, so the descriptor can be mirrored while the bytes are
    // still landing. Until they do, the read answers `null`.
    let reads = 0;
    imageStore.readStationProductImage.mockImplementation(() => {
      reads += 1;
      return Promise.resolve(reads < 3 ? null : new Blob(["late"], { type: "image/webp" }));
    });
    imageStore.readCachedStationProductImage.mockResolvedValue(null);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:late");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    render(
      <ProductImage
        exec={{ all: async () => [], run: async () => {} }}
        productId="p1"
        productName="Tea"
        image={DESCRIPTOR}
        refreshKey={0}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("img", { name: "Tea" })).toBeNull();

    // No `refreshKey` change drives this -- the component's own retry has to
    // pick the bytes up, or the photo never appears on the work screen.
    await advanceInSteps(400, 6);
    expect(screen.getByRole("img", { name: "Tea" }).getAttribute("src")).toBe("blob:late");
    expect(imageStore.readStationProductImage).toHaveBeenCalledTimes(3);
  });
});

/**
 * `ProductImage` re-reads the cache on its OWN `setTimeout(..., 350)` twice
 * after the first load (`retryKey < 2`), and it schedules that timer whether or
 * not the load succeeded. So the number of reads a test sees is a function of
 * how much WALL-CLOCK passed, not of how many times the test re-rendered.
 *
 * That makes `mockResolvedValueOnce(...).mockReturnValueOnce(...)` the wrong
 * shape here: a retry that lands between the two steps below consumes the next
 * queued value, so the pending-refresh promise meant for the `refreshKey`
 * change is handed to a retry instead, the refresh gets the FIRST blob, and the
 * image never flips -- the test then fails on a read count of 4, or hangs
 * waiting for `blob:refreshed`.
 *
 * `waitFor`'s own `timeout` option cannot bound that wall-clock: on a loaded
 * runner its 50ms polling timer and its timeout timer are both overdue by the
 * time the loop gets round to them, and Node dispatches the earlier-expiring
 * one first, so a `waitFor` can succeed hundreds of milliseconds after its
 * nominal deadline -- long enough for a 350ms retry to have fired.
 *
 * Keying the mocks on the PHASE instead of the call ORDER makes the extra reads
 * harmless: before the refresh they all resolve the same first blob, during it
 * they all await the same pending promise.
 */
describe("ProductImage", () => {
  it("keeps a loaded image visible while a cache refresh is pending", async () => {
    const first = new Blob(["first"], { type: "image/webp" });
    const refreshed = new Blob(["refreshed"], { type: "image/webp" });
    let resolveRefresh: ((blob: Blob | null) => void) | undefined;
    const pendingRefresh = new Promise<Blob | null>((resolve) => {
      resolveRefresh = resolve;
    });
    let refreshing = false;
    imageStore.readStationProductImage.mockImplementation(() =>
      refreshing ? pendingRefresh : Promise.resolve(first),
    );
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) =>
      blob === refreshed ? "blob:refreshed" : "blob:first",
    );
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
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Tea" }).getAttribute("src")).toBe("blob:first"),
    );

    // Counted from HERE rather than from zero: the reads already made are the
    // first load plus however many 350ms retries the runner had time for, and
    // the point of the assertion below is only that the `refreshKey` change
    // issued a read of its own.
    const readsBeforeRefresh = imageStore.readStationProductImage.mock.calls.length;
    refreshing = true;
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
    await waitFor(() =>
      expect(imageStore.readStationProductImage.mock.calls.length).toBeGreaterThan(
        readsBeforeRefresh,
      ),
    );

    expect(screen.getByRole("img", { name: "Tea" }).getAttribute("src")).toBe("blob:first");

    resolveRefresh?.(refreshed);
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
    // Phase-keyed for the same reason as the test above: a 350ms retry read
    // would otherwise consume the queued rejection, so the FAILING refresh this
    // test is about would instead be handed the successful first blob.
    let refreshing = false;
    imageStore.readStationProductImage.mockImplementation(() =>
      refreshing
        ? Promise.reject(new Error("cache temporarily unavailable"))
        : Promise.resolve(new Blob(["first"], { type: "image/webp" })),
    );
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

    const readsBeforeRefresh = imageStore.readStationProductImage.mock.calls.length;
    refreshing = true;
    view.rerender(
      <ProductImage
        exec={{ all: async () => [], run: async () => {} }}
        productId="p1"
        productName="Tea"
        image={descriptor}
        refreshKey={1}
      />,
    );

    await waitFor(() =>
      expect(imageStore.readStationProductImage.mock.calls.length).toBeGreaterThan(
        readsBeforeRefresh,
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Tea" }).getAttribute("src")).toBe("blob:first"),
    );
  });
});
