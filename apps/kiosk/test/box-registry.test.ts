import { buildSscc } from "@markiro/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { KioskBoxRegistryChange } from "../src/api/types.js";
import {
  activateBoxRegistryPage,
  beginBoxRegistryStage,
  discardBoxRegistryStage,
  lookupBox,
  readBoxRegistryMeta,
  stageBoxRegistryPage,
  type BoxRegistryCut,
  type BoxRegistryBinding,
} from "../src/store/box-registry.js";
import { STORE_BOX_REGISTRY_ACTIVE, withStore } from "../src/store/db.js";
import { writeConfig } from "../src/store/config.js";

const BINDING: BoxRegistryBinding = { serverUrl: "https://one.example/api", kioskId: "kiosk-a" };
const OTHER_BINDING: BoxRegistryBinding = {
  serverUrl: "https://two.example/api",
  kioskId: "kiosk-a",
};
const OLD_SSCC = buildSscc(3, "4600682", 2);
const NEW_SSCC = buildSscc(3, "4600682", 1);
const BOX_ID = "00000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "00000000-0000-4000-8000-000000000002";
const GENERATED_AT = "2026-08-13T12:00:00.000Z";

const cut = (
  owner: string,
  since: string | null,
  until: string,
  binding = BINDING,
): BoxRegistryCut => ({ binding, owner, since, until });

const upsert = (
  sscc: string,
  boxId = BOX_ID,
  bottleCount = 12,
): Extract<KioskBoxRegistryChange, { kind: "upsert" }> => ({
  kind: "upsert",
  boxId,
  sscc,
  productId: PRODUCT_ID,
  bottleCount,
  contentKeys: Array.from({ length: bottleCount }, (_, index) => `${boxId}-km-${index}`),
  updatedAt: GENERATED_AT,
});

async function activate(
  registryCut: BoxRegistryCut,
  changes: readonly KioskBoxRegistryChange[],
  generatedAt = GENERATED_AT,
): Promise<void> {
  await beginBoxRegistryStage(registryCut);
  await activateBoxRegistryPage(registryCut, changes, generatedAt);
}

describe("offline box registry", () => {
  beforeEach(async () => {
    await writeConfig({
      ...BINDING,
      token: "token",
      kioskName: "Kiosk A",
      place: null,
      nextDeviceSeq: 0,
    });
  });

  it("does not replace active rows after an incomplete page sequence", async () => {
    await activate(cut("old", null, "1"), [upsert(OLD_SSCC)]);
    const next = cut("next", "1", "2");
    await beginBoxRegistryStage(next);
    await stageBoxRegistryPage(next, [upsert(NEW_SSCC)]);

    expect(await lookupBox(BINDING, OLD_SSCC)).toMatchObject({ version: "1" });
    expect(await lookupBox(BINDING, NEW_SSCC)).toBeNull();
    expect(await readBoxRegistryMeta(BINDING)).toEqual({
      binding: BINDING,
      version: "1",
      generatedAt: GENERATED_AT,
    });
  });

  it("activates a delta atomically while preserving unaffected rows", async () => {
    await activate(cut("old", null, "1"), [upsert(OLD_SSCC), upsert(NEW_SSCC)]);
    const next = cut("next", "1", "2");
    await beginBoxRegistryStage(next);
    await activateBoxRegistryPage(
      next,
      [{ kind: "remove", sscc: NEW_SSCC, updatedAt: GENERATED_AT }],
      GENERATED_AT,
    );

    expect(await lookupBox(BINDING, OLD_SSCC)).toMatchObject({ version: "1" });
    expect(await lookupBox(BINDING, NEW_SSCC)).toBeNull();
    expect(await readBoxRegistryMeta(BINDING)).toMatchObject({ version: "2" });
  });

  it("prevents overlapping initial cuts from mixing, erasing the winner, or regressing active", async () => {
    const loser = cut("loser", null, "1");
    const winner = cut("winner", null, "2");
    await beginBoxRegistryStage(loser);
    await stageBoxRegistryPage(loser, [upsert(OLD_SSCC)]);
    await beginBoxRegistryStage(winner);
    await stageBoxRegistryPage(winner, [upsert(NEW_SSCC)]);

    await discardBoxRegistryStage(loser);
    await expect(activateBoxRegistryPage(loser, [], GENERATED_AT)).rejects.toThrow(/lost/i);
    await activateBoxRegistryPage(winner, [], GENERATED_AT);
    expect(await lookupBox(BINDING, OLD_SSCC)).toBeNull();
    expect(await lookupBox(BINDING, NEW_SSCC)).not.toBeNull();

    const stale = cut("stale", null, "1");
    await beginBoxRegistryStage(stale);
    await expect(activateBoxRegistryPage(stale, [upsert(OLD_SSCC)], GENERATED_AT)).rejects.toThrow(
      /older/i,
    );
    expect(await readBoxRegistryMeta(BINDING)).toMatchObject({ version: "2" });
    expect(await lookupBox(BINDING, NEW_SSCC)).not.toBeNull();
  });

  it("does not expose or clear the current registry for a stale binding caller", async () => {
    await activate(cut("old", null, "7"), [upsert(OLD_SSCC)]);

    expect(await lookupBox(OTHER_BINDING, OLD_SSCC)).toBeNull();
    expect(await readBoxRegistryMeta(OTHER_BINDING)).toBeNull();
    expect(await lookupBox(BINDING, OLD_SSCC)).not.toBeNull();
    await expect(beginBoxRegistryStage(cut("stale", null, "8", OTHER_BINDING))).rejects.toThrow(
      /binding changed/,
    );
    expect(await lookupBox(BINDING, OLD_SSCC)).not.toBeNull();
  });

  it("rejects malformed and oversized UTF-8 strings before durable copying", async () => {
    const target = cut("unsafe", null, "1");
    await beginBoxRegistryStage(target);
    await expect(
      stageBoxRegistryPage(target, [
        { ...upsert(OLD_SSCC, BOX_ID, 1), contentKeys: ["я".repeat(513)] },
      ]),
    ).rejects.toThrow(/1024 UTF-8 bytes/);

    await expect(
      stageBoxRegistryPage(target, [{ ...upsert(OLD_SSCC), boxId: "not-a-uuid" }]),
    ).rejects.toThrow(/boxId/);
  });

  it("rejects aggregate page bytes above one MiB before copying or dedupe", async () => {
    const target = cut("large", null, "1");
    await beginBoxRegistryStage(target);
    const page = Array.from({ length: 500 }, (_, index) => ({
      ...upsert(
        buildSscc(3, "4600682", index + 10),
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        2,
      ),
      contentKeys: ["a".repeat(1024), "b".repeat(1024)],
    }));

    await expect(stageBoxRegistryPage(target, page)).rejects.toThrow(/one MiB/);
  });

  it("fails closed when an active IndexedDB row is corrupt", async () => {
    await withStore(STORE_BOX_REGISTRY_ACTIVE, "readwrite", (store) =>
      store.put({ sscc: OLD_SSCC, bottleCount: 999_999 }),
    );
    expect(await lookupBox(BINDING, OLD_SSCC)).toBeNull();
  });
});
