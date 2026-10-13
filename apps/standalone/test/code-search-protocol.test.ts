import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createHostApi } from "../src/host/api.js";
import type { HostClient, HttpMethod } from "../src/host/client.js";
import {
  CODE_MAX_PAGE,
  CODE_PAGE_SIZE,
  CODE_SEARCH_CAP,
  codeSearchPath,
  officeCodeCardSchema,
  officeCodePageSchema,
} from "../src/host/code-search.js";

const testModuleUrl = import.meta.url;

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"),
  ) as Record<string, unknown>;
}

const PAGE = fixture("office-code-page.json");
const CARD = fixture("office-code-card.json");
/** A validation shift's code (plan РЕЖ): placements without a box, `checked` and `displaced`. */
const VALIDATION_CARD = fixture("office-code-card-validation.json");
const ITEM = (PAGE.items as Record<string, unknown>[])[0] as Record<string, unknown>;

describe("the code search's wire (proto/fixtures/office-code-*.json)", () => {
  it("parses the page and the card without losing a field", () => {
    expect(officeCodePageSchema.parse(PAGE)).toEqual(PAGE);
    expect(officeCodeCardSchema.parse(CARD)).toEqual(CARD);
    expect(officeCodeCardSchema.parse(CARD).canonical).toContain("\u001d");
  });

  it("parses a validation shift's placements and displacement, which name no box", () => {
    const card = officeCodeCardSchema.parse(VALIDATION_CARD);
    expect(card).toEqual(VALIDATION_CARD);
    expect(card.placements.map((item) => [item.state, item.boxId])).toEqual([
      ["displaced", null],
      ["checked", null],
    ]);
    expect(card.events.at(-1)).toEqual({
      type: "displaced",
      at: "2026-10-13T07:20:00Z",
      boxId: null,
      boxSscc: null,
    });
  });

  it("tolerates a field a newer host adds", () => {
    expect(officeCodePageSchema.safeParse({ ...PAGE, addedLater: true }).success).toBe(true);
    expect(
      officeCodePageSchema.safeParse({ ...PAGE, items: [{ ...ITEM, addedLater: 1 }] }).success,
    ).toBe(true);
  });

  it.each([
    ["a state the host does not write", { ...ITEM, state: "lost" }],
    ["a hash in upper case", { ...ITEM, codeHash: "A".repeat(64) }],
    ["a scan instant that is no instant", { ...ITEM, scannedAt: "yesterday" }],
    ["a missing operator", { ...ITEM, operatorName: undefined }],
    ["a missing pallet", { ...ITEM, palletId: undefined }],
    ["a shift status the host does not write", { ...ITEM, shiftStatus: "open" }],
  ])("refuses a row with %s", (_, row) => {
    expect(officeCodePageSchema.safeParse({ ...PAGE, items: [row] }).success).toBe(false);
  });

  it("refuses an event of a kind or a verdict it does not know", () => {
    const events = CARD.events as Record<string, unknown>[];
    for (const event of [
      { ...events[0], type: "moved" },
      { ...events[0], verdict: "maybe" },
      { ...events[3], exception: "lost" },
    ]) {
      expect(officeCodeCardSchema.safeParse({ ...CARD, events: [event] }).success).toBe(false);
    }
  });

  it("pages as the host does: 50 a page, at most 10 000 counted, so 200 pages", () => {
    expect([CODE_PAGE_SIZE, CODE_SEARCH_CAP, CODE_MAX_PAGE]).toEqual([50, 10_000, 200]);
  });
});

describe("the search's path", () => {
  it("writes the criteria in a fixed order, unencoded, as the shell passes them", () => {
    expect(
      codeSearchPath({ page: 2, shift: "OCT26-004/S", gtin: "04600682000013", fromMs: 1 }),
    ).toBe("/v1/office/codes?gtin=04600682000013&shift=OCT26-004/S&fromMs=1&page=2");
  });

  it("refuses a value the shell would refuse, before the shell", () => {
    expect(() => codeSearchPath({ shift: "OCT26 004" })).toThrow(RangeError);
    expect(() => codeSearchPath({ sscc: "1&page=9" })).toThrow(RangeError);
    expect(() => codeSearchPath({ gtin: "\u001d" })).toThrow(RangeError);
  });
});

describe("HostApi code search", () => {
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
  const hash = String(CARD.codeHash);

  it("sends the office token to both routes and returns the parsed answers", async () => {
    const page = recording(PAGE);
    await expect(page.api.searchCodes("token", { sscc: "046006820000015000" })).resolves.toEqual(
      PAGE,
    );
    const card = recording(CARD);
    await expect(card.api.getCodeCard("token", hash)).resolves.toEqual(CARD);
    expect([...page.sent, ...card.sent]).toEqual([
      { method: "GET", path: "/v1/office/codes?sscc=046006820000015000", officeToken: "token" },
      { method: "GET", path: `/v1/office/codes/${hash}`, officeToken: "token" },
    ]);
  });

  it("asks for no card of something that is no code hash", async () => {
    const { api, sent } = recording(CARD);
    await expect(api.getCodeCard("token", "../users")).rejects.toThrow(RangeError);
    expect(sent).toEqual([]);
  });

  it("rejects an answer that is not a page or not a card", async () => {
    await expect(recording(CARD).api.searchCodes("token", { gtin: "1" })).rejects.toThrow();
    await expect(recording(PAGE).api.getCodeCard("token", hash)).rejects.toThrow();
  });
});
