import { afterEach, expect, it, vi } from "vitest";
import { importApplySchema, importPrepareSchema } from "@markiro/platform-contracts";
import {
  abandonIntent,
  clearIdentityIntents,
  identityKey,
  loadIntent,
  saveIntent,
} from "../src/pages/catalog/national-catalog/pendingIntent.js";
import {
  currentChoice,
  initialChoice,
  reconcileChoice,
  toggleField,
} from "../src/pages/catalog/national-catalog/reviewState.js";
import { id, previewFixture } from "./national-catalog-fixtures.js";
afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});
const identity = identityKey("tenant", "user");
const expiresAt = "2026-09-09T00:00:01.000Z";
it("never copies one accepted field onto ambiguous duplicate fields in a new preparation", () => {
  const before = structuredClone(previewFixture.items[0]!);
  const after = structuredClone(before);
  after.id = id(60);
  after.fields = [
    { ...before.fields[0]!, id: id(61) },
    { ...before.fields[0]!, id: id(62) },
  ];
  expect(reconcileChoice(after, before, initialChoice(before)).decision.acceptedEntryIds).toEqual(
    [],
  );
});

it("drops a dependent field when its category changes even when the displayed dependent value matches", () => {
  const before = structuredClone(previewFixture.items[0]!);
  before.fields.push(
    {
      ...before.fields[0]!,
      id: id(40),
      labelKey: "category",
      label: "Категория",
      after: "Молочные товары",
    },
    {
      ...before.fields[0]!,
      id: id(41),
      labelKey: "print_name",
      label: "Название для печати",
      after: "Молоко",
      requiresEntryIds: [id(40)],
    },
  );
  before.categoryOptions = [{ optionId: id(42), label: "Молочные товары", selected: true }];
  const after = structuredClone(before);
  after.id = id(60);
  after.fields[0]!.id = id(61);
  after.fields[1]!.id = id(62);
  after.fields[2]!.id = id(63);
  after.fields[2]!.requiresEntryIds = [id(62)];
  after.categoryOptions[0]!.optionId = id(64);
  expect(reconcileChoice(after, before, initialChoice(before)).decision.acceptedEntryIds).toEqual([
    id(61),
  ]);
});
it("expires prepare intents but preserves unresolved applies beyond sessionTTL for receipt recovery", () => {
  const time = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-09T00:00:00Z"));
  const prepare = importPrepareSchema.parse({
    requestId: id(4),
    itemIds: [id(2)],
    manualNames: [],
    categoryChoices: [],
  });
  saveIntent(identity, { version: 1, kind: "prepare", sessionId: id(1), expiresAt, body: prepare });
  const apply = importApplySchema.parse({
    requestId: id(5),
    decisions: [initialChoice(previewFixture.items[0]!).decision],
  });
  saveIntent(identity, { version: 1, kind: "apply", sessionId: id(6), expiresAt, body: apply });
  time.mockReturnValue(Date.parse("2026-09-10T00:00:00Z"));
  expect(loadIntent(identity, id(1))).toEqual({ status: "missing" });
  expect(loadIntent(identity, id(6))).toMatchObject({ status: "valid", intent: { body: apply } });
});
it("scopes pending bodies by both user and tenant and each session, rejects overwrite of unresolved intent", () => {
  const intent = {
    version: 1 as const,
    kind: "apply" as const,
    sessionId: id(1),
    expiresAt,
    body: { requestId: id(5), decisions: [initialChoice(previewFixture.items[0]!).decision] },
  };
  saveIntent(identity, intent);
  saveIntent(identity, { ...intent, sessionId: id(6) });
  expect(loadIntent(identityKey("other", "user"), id(1))).toEqual({ status: "missing" });
  expect(loadIntent(identityKey("tenant", "other"), id(1))).toEqual({ status: "missing" });
  expect(() =>
    saveIntent(identity, { ...intent, body: { ...intent.body, requestId: id(7) } }),
  ).toThrow("unresolved_intent");
  sessionStorage.setItem("unrelated", "keep");
  clearIdentityIntents(identity);
  expect(loadIntent(identity, id(1))).toEqual({ status: "missing" });
  expect(loadIntent(identity, id(6))).toEqual({ status: "missing" });
  expect(sessionStorage.getItem("unrelated")).toBe("keep");
});
it("rejects corrupt, unknown-version, oversized or provider-payload pending storage", () => {
  const storageKey = `markiro.nc.pending.v1:${identity}${id(1)}`;
  for (const raw of [
    "{",
    JSON.stringify({ version: 2 }),
    JSON.stringify({
      version: 1,
      kind: "apply",
      sessionId: id(1),
      expiresAt,
      body: {
        requestId: id(5),
        decisions: [initialChoice(previewFixture.items[0]!).decision],
        provider: { token: "not-a-secret" },
      },
    }),
  ]) {
    sessionStorage.setItem(storageKey, raw);
    expect(loadIntent(identity, id(1))).toEqual({ status: "corrupt" });
    expect(sessionStorage.getItem(storageKey)).toBe(raw);
  }
});
it("never defaults a foreign-GTIN candidate and clears old decisions for a new preview identity", () => {
  const preview = structuredClone(previewFixture.items[0]!);
  preview.photos = [
    {
      candidateId: id(30),
      state: "ready",
      previewPath: null,
      primary: true,
      selectedByDefault: true,
      reason: "barcode_mismatch",
    },
  ];
  expect(initialChoice(preview).decision.photo).toEqual({ kind: "keep" });
  expect(currentChoice({ ...preview, id: id(99) }, undefined).decision.previewId).toBe(id(99));
});
it("preselects empty approved fields of an existing product and respects dependencies", () => {
  const preview = structuredClone(previewFixture.items[0]!);
  preview.productId = id(21);
  const field = preview.fields[0]!;
  preview.fields = [
    { ...field, id: id(40), before: null, selectedByDefault: true },
    { ...field, id: id(41), before: null, selectedByDefault: true, requiresEntryIds: [id(40)] },
    { ...field, id: id(42), before: "Сохранённое значение", selectedByDefault: false },
    { ...field, id: id(43), before: null, applicable: false, selectedByDefault: true },
    { ...field, id: id(44), before: null, selectedByDefault: true, requiresEntryIds: [id(43)] },
  ];
  expect(initialChoice(preview).decision.acceptedEntryIds).toEqual([id(40), id(41)]);
});

it("removes dependent fields when category is unchecked and never reselects them implicitly", () => {
  const preview = structuredClone(previewFixture.items[0]!);
  preview.fields.push(
    { ...preview.fields[0]!, id: id(40), label: "Category", requiresEntryIds: [] },
    { ...preview.fields[0]!, id: id(41), label: "Volume", requiresEntryIds: [id(40)] },
  );
  let choice = initialChoice(preview);
  choice = toggleField(preview, choice, id(40), false);
  expect(choice.decision.acceptedEntryIds).toEqual([id(13)]);
  choice = toggleField(preview, choice, id(41), true);
  expect(choice.decision.acceptedEntryIds).toEqual([id(13)]);
  choice = toggleField(preview, choice, id(40), true);
  expect(choice.decision.acceptedEntryIds).toEqual([id(13), id(40)]);
});

it("blocks unreadable storage and verifies deletion before abandoning or expiring prepare", () => {
  const getItem = Storage.prototype.getItem;
  const getter = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw Error("blocked");
  });
  expect(loadIntent(identity, id(1))).toEqual({ status: "unavailable" });
  expect(() => abandonIntent(identity, id(1))).toThrow("blocked");
  getter.mockRestore();
  const intent = {
    version: 1 as const,
    kind: "prepare" as const,
    sessionId: id(1),
    expiresAt,
    body: { requestId: id(4), itemIds: [id(2)], manualNames: [], categoryChoices: [] },
  };
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-08T00:00:00Z"));
  saveIntent(identity, intent);
  vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-10T00:00:00Z"));
  const remover = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {});
  expect(loadIntent(identity, id(1))).toEqual({ status: "unavailable" });
  expect(() => abandonIntent(identity, id(1))).toThrow("storage_unavailable");
  expect(getItem.call(sessionStorage, `markiro.nc.pending.v1:${identity}${id(1)}`)).not.toBeNull();
  remover.mockRestore();
  expect(loadIntent(identity, id(1))).toEqual({ status: "missing" });
});
it("cannot overwrite invalid pending bytes through the mandatory pre-POST persistence gate", () => {
  const storageKey = `markiro.nc.pending.v1:${identity}${id(1)}`;
  sessionStorage.setItem(storageKey, "{");
  expect(() =>
    saveIntent(identity, {
      version: 1,
      kind: "apply",
      sessionId: id(1),
      expiresAt,
      body: { requestId: id(5), decisions: [initialChoice(previewFixture.items[0]!).decision] },
    }),
  ).toThrow("storage_unavailable");
  expect(sessionStorage.getItem(storageKey)).toBe("{");
});

import { getExactCardItems } from "../src/pages/catalog/national-catalog/api.js";
import { itemsFixture } from "./national-catalog-fixtures.js";
it("reads the exact-card feed across pages including archived rows instead of choosing the first card", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          items: [
            { ...itemsFixture.items[0], cardId: calls.length === 1 ? "other-card" : "card-1" },
          ],
          nextCursor: calls.length === 1 ? "next" : null,
        }),
        { status: 200 },
      );
    }),
  );
  try {
    const items = await getExactCardItems("00000000-0000-4000-8000-000000000001");
    expect(items.map((item) => item.cardId)).toEqual(["other-card", "card-1"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("includeArchived=true");
    expect(calls[1]).toContain("cursor=next");
  } finally {
    vi.unstubAllGlobals();
  }
});
it.each(["loop", "limit"])(
  "rejects incomplete exact-card traversal at the %s bound",
  async (kind) => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response(
          JSON.stringify({
            items: itemsFixture.items,
            nextCursor: kind === "loop" ? "same" : String(calls),
          }),
          { status: 200 },
        );
      }),
    );
    try {
      await expect(getExactCardItems("00000000-0000-4000-8000-000000000001")).rejects.toThrow(
        "incomplete_feed",
      );
      expect(calls).toBe(kind === "loop" ? 2 : 100);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

// A legitimate field-heavy apply is below the existing HTTP body limit.
it("persists and reloads a100-position60-field intent without changing its exact request", () => {
  const body = importApplySchema.parse({
    requestId: id(500),
    decisions: Array.from({ length: 100 }, (_, index) => ({
      previewId: id(1000 + index),
      acceptedEntryIds: Array.from({ length: 60 }, (_, field) => id(2000 + field)),
      linkAction: "attach",
      photo: { kind: "keep" },
    })),
  });
  const intent = { version: 1 as const, kind: "apply" as const, sessionId: id(1), expiresAt, body };
  expect(JSON.stringify(intent).length).toBeGreaterThan(200_000);
  expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(900_000);
  saveIntent(identity, intent);
  expect(loadIntent(identity, id(1))).toEqual({ status: "valid", intent });
});

it("bounds the serialized intent envelope and refuses oversized retained bytes without deleting them", () => {
  const body = { requestId: id(5), decisions: [initialChoice(previewFixture.items[0]!).decision] };
  const intent = { version: 1 as const, kind: "apply" as const, sessionId: id(1), expiresAt, body };
  expect(JSON.stringify(intent).length - JSON.stringify(body).length).toBeLessThan(1024);
  const oversized = JSON.stringify(intent) + " ".repeat(9_002_049);
  const get = vi.spyOn(Storage.prototype, "getItem").mockReturnValue(oversized);
  expect(loadIntent(identity, id(1))).toEqual({ status: "corrupt" });
  expect(() => saveIntent(identity, intent)).toThrow("storage_unavailable");
  expect(get.mock.results[0]?.value).toBe(oversized);
});
