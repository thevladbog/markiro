import { describe, expect, it } from "vitest";

import { canUseCategory, parseConsent, serializeConsent, type ConsentState } from "./consent";

describe("consent state", () => {
  it.each([null, "", "null", "{}", '{"version":2,"analytics":true,"marketing":true}']) (
    "treats absent or incompatible storage as no consent: %s",
    (stored) => {
      expect(parseConsent(stored)).toBeNull();
    },
  );

  it("round-trips only the versioned category decisions", () => {
    const state: ConsentState = { version: 1, analytics: true, marketing: false };

    expect(parseConsent(serializeConsent(state))).toEqual(state);
    expect(serializeConsent(state)).toBe('{"version":1,"analytics":true,"marketing":false}');
  });

  it("requires an explicit category grant", () => {
    expect(canUseCategory(null, "analytics")).toBe(false);
    expect(
      canUseCategory({ version: 1, analytics: false, marketing: true }, "analytics"),
    ).toBe(false);
    expect(
      canUseCategory({ version: 1, analytics: true, marketing: false }, "analytics"),
    ).toBe(true);
  });
});
