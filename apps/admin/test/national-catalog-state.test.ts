import { afterEach, expect, it, vi } from "vitest";
import { importApplySchema, importPrepareSchema } from "@markiro/platform-contracts";
import {
  clearIdentityIntents,
  identityKey,
  loadIntent,
  saveIntent,
} from "../src/pages/catalog/national-catalog/pendingIntent.js";
import {
  currentChoice,
  initialChoice,
  toggleField,
} from "../src/pages/catalog/national-catalog/reviewState.js";
import { id, previewFixture } from "./national-catalog-fixtures.js";
afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});
const identity = identityKey("tenant", "user");
const expiresAt = "2026-09-09T00:00:01.000Z";
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
  expect(loadIntent(identity, id(1))).toBeNull();
  expect(loadIntent(identity, id(6))?.body).toEqual(apply);
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
  expect(loadIntent(identityKey("other", "user"), id(1))).toBeNull();
  expect(loadIntent(identityKey("tenant", "other"), id(1))).toBeNull();
  expect(() =>
    saveIntent(identity, { ...intent, body: { ...intent.body, requestId: id(7) } }),
  ).toThrow("unresolved_intent");
  sessionStorage.setItem("unrelated", "keep");
  clearIdentityIntents(identity);
  expect(loadIntent(identity, id(1))).toBeNull();
  expect(loadIntent(identity, id(6))).toBeNull();
  expect(sessionStorage.getItem("unrelated")).toBe("keep");
});
it("rejects corrupt, unknown-version, oversized or provider-payload pending storage", () => {
  const storageKey = `markiro.nc.pending.v1:${identity}${id(1)}`;
  for (const raw of [
    "{",
    JSON.stringify({ version: 2 }),
    "x".repeat(200001),
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
    expect(loadIntent(identity, id(1))).toBeNull();
    expect(sessionStorage.getItem(storageKey)).toBeNull();
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
