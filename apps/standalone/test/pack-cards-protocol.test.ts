import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createHostApi } from "../src/host/api.js";
import type { HostClient, HttpMethod } from "../src/host/client.js";
import {
  CARD_ROW_LIMIT,
  PALLET_PAGE_SIZE,
  isPackId,
  officeBoxCardSchema,
  officePalletCardSchema,
  officePalletPageSchema,
  palletListPath,
} from "../src/host/pack-cards.js";
import { officeBoxSchema } from "../src/host/protocol.js";

const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const BOX = fixture("office-box-card.json") as Record<string, unknown>;
const PALLET = fixture("office-pallet-card.json") as Record<string, unknown>;
const PAGE = fixture("office-pallet-page.json") as Record<string, unknown>;
const ITEM = (BOX.items as Record<string, unknown>[])[0] as Record<string, unknown>;
const PALLET_EXC = (PALLET.exceptions as Record<string, unknown>[])[0] as Record<string, unknown>;

describe("the box and pallet cards' wire (proto/fixtures/office-*-card.json)", () => {
  it("parses both cards and a page without losing a field", () => {
    expect(officeBoxCardSchema.parse(BOX)).toEqual(BOX);
    expect(officePalletCardSchema.parse(PALLET)).toEqual(PALLET);
    expect(officePalletPageSchema.parse(PAGE)).toEqual(PAGE);
  });

  it("reads a card without documents as one with none", () => {
    const older = { ...BOX };
    delete older.documents;
    expect(officeBoxCardSchema.parse(older).documents).toEqual([]);
    const olderPallet = { ...PALLET };
    delete olderPallet.documents;
    expect(officePalletCardSchema.parse(olderPallet).documents).toEqual([]);
  });

  it("tolerates a field a newer host adds", () => {
    expect(officeBoxCardSchema.safeParse({ ...BOX, addedLater: true }).success).toBe(true);
    expect(officePalletPageSchema.safeParse({ ...PAGE, addedLater: 1 }).success).toBe(true);
  });

  it.each([
    ["an item state the host does not write", { items: [{ ...ITEM, state: "lost" }] }],
    ["an SSCC of 17 digits", { sscc: "04600682000001500" }],
    ["a code hash in upper case", { items: [{ ...ITEM, codeHash: "A".repeat(64) }] }],
    ["a missing operator", { operatorName: undefined }],
  ])("refuses a box card with %s", (_, change) => {
    expect(officeBoxCardSchema.safeParse({ ...BOX, ...change }).success).toBe(false);
  });

  it("refuses a pallet exception of a kind it does not know", () => {
    const refused = officePalletCardSchema.safeParse({
      ...PALLET,
      exceptions: [{ ...PALLET_EXC, kind: "undo" }],
    });
    expect(refused.success).toBe(false);
  });

  it("reads a box of a host before plan КРТ without its operator", () => {
    const boxes = fixture("office-boxes.json") as Record<string, unknown>[];
    const first = boxes[0] as Record<string, unknown>;
    const older = { ...first };
    delete older.operatorName;
    expect(officeBoxSchema.parse(older).operatorName).toBeUndefined();
    expect(officeBoxSchema.parse(first).operatorName).toBe("Анна Кузнецова");
  });

  it("pages and reads as the host does", () => {
    expect([CARD_ROW_LIMIT, PALLET_PAGE_SIZE]).toEqual([10_000, 100]);
  });
});

describe("the pallet list's path", () => {
  it("writes the parameters in a fixed order with the cursor last", () => {
    expect(
      palletListPath(
        { sscc: "146006820000000402", product: "6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f", fromMs: 1 },
        "o~a0000000-0000-4000-8000-000000000003",
      ),
    ).toBe(
      "/v1/office/pallets?product=6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f&fromMs=1&sscc=146006820000000402&cursor=o~a0000000-0000-4000-8000-000000000003",
    );
    expect(palletListPath({}, null)).toBe("/v1/office/pallets");
  });

  it("refuses a value or a cursor the shell would refuse", () => {
    expect(() => palletListPath({ product: "x y" }, null)).toThrow(RangeError);
    expect(() => palletListPath({}, "2026-10-08T06:00:09Z~a")).toThrow(RangeError);
    expect(() => palletListPath({}, "1791439209000~nope")).toThrow(RangeError);
  });

  it("knows an id when it is the host's lower-case UUID", () => {
    expect(isPackId("b0000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isPackId("B0000000-0000-4000-8000-000000000001")).toBe(false);
    expect(isPackId("../users")).toBe(false);
  });
});

describe("HostApi cards", () => {
  function recording(answer: unknown) {
    const sent: { method: HttpMethod; path: string; officeToken: string | undefined }[] = [];
    const client: HostClient = {
      request: async (method, path, options) => {
        sent.push({ method, path, officeToken: options.officeToken });
        return options.schema.parse(answer);
      },
    };
    return { api: createHostApi(client), sent };
  }
  const boxId = String(BOX.id);
  const palletId = String(PALLET.id);

  it("sends the office token to the three routes and returns the parsed answers", async () => {
    const box = recording(BOX);
    await expect(box.api.getBoxCard("token", boxId)).resolves.toEqual(BOX);
    const pallet = recording(PALLET);
    await expect(pallet.api.getPalletCard("token", palletId)).resolves.toEqual(PALLET);
    const list = recording(PAGE);
    await expect(
      list.api.listPallets("token", { sscc: "146006820000000402" }, null),
    ).resolves.toEqual(PAGE);
    expect([...box.sent, ...pallet.sent, ...list.sent]).toEqual([
      { method: "GET", path: `/v1/office/boxes/${boxId}`, officeToken: "token" },
      { method: "GET", path: `/v1/office/pallets/${palletId}`, officeToken: "token" },
      { method: "GET", path: "/v1/office/pallets?sscc=146006820000000402", officeToken: "token" },
    ]);
  });

  it("asks for no card of something that is no id", async () => {
    const { api, sent } = recording(BOX);
    await expect(api.getBoxCard("token", "../users")).rejects.toThrow(RangeError);
    await expect(api.getPalletCard("token", "../users")).rejects.toThrow(RangeError);
    expect(sent).toEqual([]);
  });

  it("rejects an answer that is not the card asked for", async () => {
    await expect(recording(PALLET).api.getBoxCard("token", boxId)).rejects.toThrow();
    await expect(recording(BOX).api.listPallets("token", {}, null)).rejects.toThrow();
  });
});
