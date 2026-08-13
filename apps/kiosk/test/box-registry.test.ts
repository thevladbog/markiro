import { describe, expect, it } from "vitest";
import {
  activateBoxRegistryPage,
  lookupBox,
  readBoxRegistryMeta,
  stageBoxRegistryPage,
} from "../src/store/box-registry.js";
import type { KioskBoxRegistryChange } from "../src/api/types.js";
import { STORE_BOX_REGISTRY_ACTIVE, withStore } from "../src/store/db.js";

const OLD_SSCC = "346006820000000021";
const NEW_SSCC = "346006820000000014";

const upsert = (
  sscc: string,
  boxId: string,
  bottleCount = 12,
): Extract<KioskBoxRegistryChange, { kind: "upsert" }> => ({
  kind: "upsert",
  boxId,
  sscc,
  productId: `product-${boxId}`,
  bottleCount,
  contentKeys: Array.from({ length: bottleCount }, (_, index) => `${boxId}-km-${index}`),
  updatedAt: "2026-08-13T12:00:00.000Z",
});

describe("offline box registry", () => {
  it("does not replace the active registry after an incomplete page sequence", async () => {
    await activateBoxRegistryPage(
      null,
      "1",
      [upsert(OLD_SSCC, "old")],
      new Date("2026-08-13T12:00:00Z"),
    );

    await stageBoxRegistryPage("1", "2", [upsert(NEW_SSCC, "new")]);

    expect(await lookupBox(OLD_SSCC)).toMatchObject({ sscc: OLD_SSCC, version: "1" });
    expect(await lookupBox(NEW_SSCC)).toBeNull();
    expect(await readBoxRegistryMeta()).toEqual({
      version: "1",
      generatedAt: "2026-08-13T12:00:00.000Z",
    });
  });

  it("activates a complete delta atomically and applies removals", async () => {
    await activateBoxRegistryPage(
      null,
      "1",
      [upsert(OLD_SSCC, "old"), upsert(NEW_SSCC, "new")],
      new Date("2026-08-13T12:00:00Z"),
    );

    await activateBoxRegistryPage(
      "1",
      "2",
      [
        { kind: "remove", sscc: OLD_SSCC, updatedAt: "2026-08-13T12:05:00.000Z" },
        upsert(NEW_SSCC, "newer", 6),
      ],
      new Date("2026-08-13T12:05:00Z"),
    );

    expect(await lookupBox(OLD_SSCC)).toBeNull();
    expect(await lookupBox(NEW_SSCC)).toMatchObject({
      boxId: "newer",
      bottleCount: 6,
      version: "2",
    });
    expect(await readBoxRegistryMeta()).toEqual({
      version: "2",
      generatedAt: "2026-08-13T12:05:00.000Z",
    });
  });

  it("preserves active rows a delta does not mention", async () => {
    await activateBoxRegistryPage(
      null,
      "1",
      [upsert(OLD_SSCC, "old"), upsert(NEW_SSCC, "new")],
      new Date("2026-08-13T12:00:00Z"),
    );

    await activateBoxRegistryPage(
      "1",
      "2",
      [upsert(NEW_SSCC, "newer", 6)],
      new Date("2026-08-13T12:05:00Z"),
    );

    expect(await lookupBox(OLD_SSCC)).toMatchObject({ boxId: "old", bottleCount: 12 });
    expect(await lookupBox(NEW_SSCC)).toMatchObject({ boxId: "newer", bottleCount: 6 });
  });

  it("disowns an incomplete cut before a restarted cut is activated", async () => {
    await activateBoxRegistryPage(
      null,
      "1",
      [upsert(OLD_SSCC, "old")],
      new Date("2026-08-13T12:00:00Z"),
    );
    await stageBoxRegistryPage("1", "2", [
      { kind: "remove", sscc: OLD_SSCC, updatedAt: "2026-08-13T12:01:00Z" },
      upsert(NEW_SSCC, "never-committed"),
    ]);

    await activateBoxRegistryPage("1", "3", [], new Date("2026-08-13T12:05:00Z"));

    expect(await lookupBox(OLD_SSCC)).toMatchObject({ boxId: "old" });
    expect(await lookupBox(NEW_SSCC)).toBeNull();
    expect(await readBoxRegistryMeta()).toMatchObject({ version: "3" });
  });

  it("rejects malformed rows without exposing them through the active registry", async () => {
    await expect(
      activateBoxRegistryPage(
        null,
        "1",
        [{ ...upsert(OLD_SSCC, "old"), bottleCount: 0 }],
        new Date("2026-08-13T12:00:00Z"),
      ),
    ).rejects.toThrow(/bottleCount/);

    expect(await lookupBox(OLD_SSCC)).toBeNull();
    expect(await readBoxRegistryMeta()).toBeNull();
  });

  it("rejects untrusted kinds and bounded page work without type accidents", async () => {
    await expect(
      activateBoxRegistryPage(
        null,
        "1",
        [{ kind: "explode", sscc: OLD_SSCC }] as unknown as KioskBoxRegistryChange[],
        new Date(),
      ),
    ).rejects.toThrow("kind");
    await expect(
      activateBoxRegistryPage(
        null,
        "1",
        Array.from({ length: 501 }, () => ({
          kind: "remove" as const,
          sscc: OLD_SSCC,
          updatedAt: "2026-08-13T12:00:00Z",
        })),
        new Date(),
      ),
    ).rejects.toThrow("page size");
  });

  it("fails closed when an active IndexedDB row is corrupt", async () => {
    await withStore(STORE_BOX_REGISTRY_ACTIVE, "readwrite", (store) =>
      store.put({ sscc: OLD_SSCC, bottleCount: 999_999 }),
    );

    expect(await lookupBox(OLD_SSCC)).toBeNull();
  });
});
