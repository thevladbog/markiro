import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSscc, canonicalizeKm, kmHash, kmKey } from "@markiro/domain";
import {
  decodeBoxRegistryCursor,
  encodeBoxRegistryCursor,
  resolveBoxRegistryWindow,
} from "../src/modules/kiosk/box-registry.dto";
import {
  MAX_BOX_REGISTRY_MEMBERS,
  evaluateBoxRegistryCandidate,
  shapeBoxRegistryPage,
  type BoxRegistryCandidate,
  type BoxRegistryMemberFact,
} from "../src/modules/kiosk/box-registry.service";

const CLOSED = new Date("2026-08-13T10:00:00.000Z");
const UPDATED = new Date("2026-08-13T10:01:00.000Z");
const SSCC = buildSscc(3, "4600682", 42);
const GTIN = "04006381333931";
const GS = "\u001d";

function candidate(overrides: Partial<BoxRegistryCandidate> = {}): BoxRegistryCandidate {
  return {
    id: randomUUID(),
    sscc: SSCC,
    productId: randomUUID(),
    productGtin14: GTIN,
    closedAt: CLOSED,
    closureReceivedAt: CLOSED,
    disassembledAt: null,
    updatedAt: UPDATED,
    ...overrides,
  };
}

function member(
  boxId: string,
  serial: string,
  overrides: Partial<BoxRegistryMemberFact> = {},
): BoxRegistryMemberFact {
  const parsed = canonicalizeKm(`01${GTIN}21${serial}${GS}91secret${GS}92crypto-tail`);
  const addedAt = new Date(CLOSED.getTime() - 1_000);
  return {
    boxId,
    codeHash: kmHash(parsed),
    addedAt,
    displacedAt: null,
    removedAt: null,
    registryScannedAt: addedAt,
    registryUpdatedAt: addedAt,
    canonicalRaw: parsed.raw,
    canonicalGtin14: parsed.gtin14,
    totalMembershipCount: 1,
    ...overrides,
  };
}

describe("box registry cursor", () => {
  it("round-trips a canonical versioned cursor and binds both snapshot bounds", () => {
    const value = {
      v: 1 as const,
      since: "2026-08-13T09:00:00.000Z",
      until: "2026-08-13T10:00:00.000Z",
      updatedAt: "2026-08-13T09:30:00.000Z",
      id: randomUUID(),
    };
    const encoded = encodeBoxRegistryCursor(value);
    expect(decodeBoxRegistryCursor(encoded)).toEqual(value);
    expect(
      resolveBoxRegistryWindow(
        { since: value.since, until: value.until, cursor: encoded, limit: 17 },
        "2026-08-13T11:00:00.000Z",
      ),
    ).toEqual({
      since: value.since,
      until: value.until,
      afterUpdatedAt: value.updatedAt,
      afterId: value.id,
      limit: 17,
    });
  });

  it.each([
    "not base64url!",
    Buffer.from("{}", "utf8").toString("base64url"),
    Buffer.from(
      JSON.stringify({
        v: 2,
        since: null,
        until: "2026-08-13T10:00:00.000Z",
        updatedAt: "2026-08-13T09:30:00.000Z",
        id: randomUUID(),
      }),
      "utf8",
    ).toString("base64url"),
    "a".repeat(1025),
  ])("rejects malformed, unknown-version, or oversized cursor %s", (raw) => {
    expect(() => decodeBoxRegistryCursor(raw)).toThrow();
  });

  it("rejects moving bounds, omitted bound parameters, and future cursor positions", () => {
    const cursor = encodeBoxRegistryCursor({
      v: 1,
      since: null,
      until: "2026-08-13T10:00:00.000Z",
      updatedAt: "2026-08-13T09:30:00.000Z",
      id: randomUUID(),
    });
    expect(() =>
      resolveBoxRegistryWindow(
        { cursor, until: "2026-08-13T10:00:01.000Z", limit: 250 },
        "2026-08-13T11:00:00.000Z",
      ),
    ).toThrow();
    expect(() =>
      resolveBoxRegistryWindow({ cursor, limit: 250 }, "2026-08-13T11:00:00.000Z"),
    ).toThrow();
    expect(() =>
      resolveBoxRegistryWindow(
        { since: "2026-08-13T12:00:00.000Z", limit: 250 },
        "2026-08-13T11:00:00.000Z",
      ),
    ).toThrow();
    expect(() =>
      resolveBoxRegistryWindow(
        { until: "2026-08-13T10:00:00.000Z", limit: 250 },
        "2026-08-13T11:00:00.000Z",
      ),
    ).toThrow();
  });
});

describe("box registry eligibility", () => {
  it("returns a sorted, unique 12-bottle upsert without raw KM material", () => {
    const box = candidate();
    const facts = Array.from({ length: 12 }, (_, index) => member(box.id, `S-${12 - index}`));
    for (const fact of facts) fact.totalMembershipCount = 12;

    const change = evaluateBoxRegistryCandidate(box, facts, false);
    expect(change).toEqual({
      kind: "upsert",
      boxId: box.id,
      sscc: box.sscc,
      productId: box.productId,
      bottleCount: 12,
      contentKeys: [...facts.map((fact) => kmKey(canonicalizeKm(fact.canonicalRaw!)))].sort(),
      updatedAt: UPDATED.toISOString(),
    });
    expect(JSON.stringify(change)).not.toContain("canonicalRaw");
    expect(JSON.stringify(change)).not.toContain("secret");
    expect(JSON.stringify(change)).not.toContain("crypto-tail");
  });

  it.each([
    ["open", { closedAt: null }],
    ["closure not received", { closureReceivedAt: null }],
    ["disassembled", { disassembledAt: UPDATED }],
  ] as const)("omits %s boxes in a full snapshot and removes them in a delta", (_label, patch) => {
    const box = candidate(patch);
    const facts = [member(box.id, "one")];
    expect(evaluateBoxRegistryCandidate(box, facts, false)).toBeNull();
    expect(evaluateBoxRegistryCandidate(box, facts, true)).toEqual({
      kind: "remove",
      sscc: SSCC,
      updatedAt: UPDATED.toISOString(),
    });
  });

  it.each([
    ["changed after close", { registryUpdatedAt: new Date(CLOSED.getTime() + 1) }],
    ["removed after close", { removedAt: new Date(CLOSED.getTime() + 1) }],
    ["displaced after close", { displacedAt: new Date(CLOSED.getTime() + 1) }],
    ["current-owner mismatch", { registryScannedAt: new Date(CLOSED.getTime() - 2_000) }],
    ["missing canonical row", { canonicalRaw: null, canonicalGtin14: null }],
    ["malformed canonical row", { canonicalRaw: "not-a-km" }],
    ["mixed product", { canonicalGtin14: "04600511789539" }],
  ] as const)("rejects %s", (_label, patch) => {
    const box = candidate();
    expect(evaluateBoxRegistryCandidate(box, [member(box.id, "one", patch)], true)).toEqual({
      kind: "remove",
      sscc: SSCC,
      updatedAt: UPDATED.toISOString(),
    });
  });

  it("rejects missing, duplicate, ambiguous, and oversized membership", () => {
    const box = candidate();
    expect(evaluateBoxRegistryCandidate(box, [], false)).toBeNull();

    const one = member(box.id, "same");
    const duplicate = { ...one };
    one.totalMembershipCount = 2;
    duplicate.totalMembershipCount = 2;
    expect(evaluateBoxRegistryCandidate(box, [one, duplicate], false)).toBeNull();

    const oversized = member(box.id, "large", {
      totalMembershipCount: MAX_BOX_REGISTRY_MEMBERS + 1,
    });
    expect(evaluateBoxRegistryCandidate(box, [oversized], true)?.kind).toBe("remove");
  });
});

describe("box registry page shaping", () => {
  it("emits a remove for an ineligible delta because a closed box retains its SSCC", () => {
    const box = candidate({ disassembledAt: UPDATED });
    const change = evaluateBoxRegistryCandidate(box, [], true);
    expect(change).toEqual({ kind: "remove", sscc: SSCC, updatedAt: UPDATED.toISOString() });
    expect(box.sscc).toBe(SSCC);
  });

  it("advances over an empty-output candidate page and uses the last candidate tie-breaker", () => {
    const id1 = "00000000-0000-4000-8000-000000000001";
    const id2 = "00000000-0000-4000-8000-000000000002";
    const invalid1 = candidate({ id: id1, closedAt: null });
    const invalid2 = candidate({ id: id2, closedAt: null });
    const window = {
      since: null,
      until: "2026-08-13T11:00:00.000Z",
      afterUpdatedAt: null,
      afterId: null,
      limit: 2,
    };
    const page = shapeBoxRegistryPage([invalid1, invalid2], new Map(), window, true);
    expect(page.items).toEqual([]);
    expect(decodeBoxRegistryCursor(page.nextCursor!)).toEqual({
      v: 1,
      since: null,
      until: window.until,
      updatedAt: UPDATED.toISOString(),
      id: id2,
    });
  });
});
