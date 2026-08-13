import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSscc, canonicalizeKm, kmHash, kmKey } from "@markiro/domain";
import {
  decodeBoxRegistryCursor,
  encodeBoxRegistryCursor,
  resolveBoxRegistryWindow,
} from "../src/modules/kiosk/box-registry.dto";
import {
  MAX_REGISTRY_PAGE_MEMBER_KEYS,
  MAX_BOX_REGISTRY_MEMBERS,
  evaluateBoxRegistryCandidate,
  isRegistryRevisionInWindow,
  selectBoxRegistryCandidatePrefix,
  shapeBoxRegistryPage,
  type BoxRegistryCandidate,
  type BoxRegistryMemberFact,
} from "../src/modules/kiosk/box-registry.service";

const CLOSED = new Date("2026-08-13T10:00:00.000Z");
const UPDATED = new Date("2026-08-13T10:01:00.000Z");
const SSCC = buildSscc(3, "4600682", 42);
const GTIN = "04006381333931";
const GS = "\u001d";
const SHIFT_ID = "00000000-0000-4000-8000-000000000099";

function candidate(overrides: Partial<BoxRegistryCandidate> = {}): BoxRegistryCandidate {
  return {
    id: randomUUID(),
    shiftId: SHIFT_ID,
    terminalId: "terminal-a",
    sscc: SSCC,
    productId: randomUUID(),
    productGtin14: GTIN,
    closedAt: CLOSED,
    closureReceivedAt: CLOSED,
    disassembledAt: null,
    registryVersion: 7n,
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
    registryShiftId: overrides.registryShiftId ?? SHIFT_ID,
    registryTerminalId: overrides.registryTerminalId ?? "terminal-a",
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
      v: 2 as const,
      since: "9007199254740993",
      until: "9007199254741999",
      registryVersion: "9007199254741001",
      id: randomUUID(),
    };
    const encoded = encodeBoxRegistryCursor(value);
    expect(decodeBoxRegistryCursor(encoded)).toEqual(value);
    expect(
      resolveBoxRegistryWindow(
        { since: value.since, until: value.until, cursor: encoded, limit: 17 },
        value.until,
      ),
    ).toEqual({
      since: value.since,
      until: value.until,
      afterRegistryVersion: value.registryVersion,
      afterId: value.id,
      limit: 17,
    });
  });

  it.each([
    "not base64url!",
    Buffer.from("{}", "utf8").toString("base64url"),
    Buffer.from(
      JSON.stringify({
        v: 1,
        since: null,
        until: "7",
        registryVersion: "6",
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
      v: 2,
      since: null,
      until: "10",
      registryVersion: "9",
      id: randomUUID(),
    });
    expect(() => resolveBoxRegistryWindow({ cursor, until: "11", limit: 250 }, "12")).toThrow();
    expect(() => resolveBoxRegistryWindow({ cursor, limit: 250 }, "12")).toThrow();
    expect(() => resolveBoxRegistryWindow({ since: "13", limit: 250 }, "12")).toThrow();
    expect(() => resolveBoxRegistryWindow({ until: "10", limit: 250 }, "12")).toThrow();
  });

  it.each(["-1", "01", "+1", "1.0", "9223372036854775808", "9007199254740993 "])(
    "rejects noncanonical or out-of-range revision %s without Number coercion",
    (revision) =>
      expect(() => resolveBoxRegistryWindow({ since: revision, limit: 250 }, "20")).toThrow(),
  );

  it("models a committed cut without losing a concurrent revision", () => {
    // Revision 8 is allocated inside an uncommitted mutation transaction.
    // A reader still sees committed tenant cut 7 and excludes it. Once the
    // mutation commits, a delta (7,8] includes it exactly once.
    expect(isRegistryRevisionInWindow("8", null, "7")).toBe(false);
    expect(isRegistryRevisionInWindow("8", "7", "8")).toBe(true);
    expect(isRegistryRevisionInWindow("7", "7", "8")).toBe(false);
  });
});

describe("box registry eligibility", () => {
  it("returns a sorted, unique 12-bottle upsert without raw KM material", () => {
    const box = candidate();
    const facts = Array.from({ length: 12 }, (_, index) =>
      member(box.id, `S-${12 - index}`, {
        registryShiftId: box.shiftId,
        registryTerminalId: box.terminalId,
      }),
    );
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
    const facts = [
      member(box.id, "one", {
        registryShiftId: box.shiftId,
        registryTerminalId: box.terminalId,
      }),
    ];
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
    expect(
      evaluateBoxRegistryCandidate(
        box,
        [
          member(box.id, "one", {
            registryShiftId: box.shiftId,
            registryTerminalId: box.terminalId,
            ...patch,
          }),
        ],
        true,
      ),
    ).toEqual({
      kind: "remove",
      sscc: SSCC,
      updatedAt: UPDATED.toISOString(),
    });
  });

  it.each([
    ["different shift", { registryShiftId: randomUUID() }],
    ["different terminal", { registryTerminalId: "terminal-b" }],
  ])("rejects same timestamp owned by a %s", (_label, patch) => {
    const box = candidate();
    const fact = member(box.id, "owner", {
      registryShiftId: box.shiftId,
      registryTerminalId: box.terminalId,
      ...patch,
    });
    expect(evaluateBoxRegistryCandidate(box, [fact], true)?.kind).toBe("remove");
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
      until: "7",
      afterRegistryVersion: null,
      afterId: null,
      limit: 2,
    };
    const page = shapeBoxRegistryPage([invalid1, invalid2], new Map(), window, true);
    expect(page.items).toEqual([]);
    expect(decodeBoxRegistryCursor(page.nextCursor!)).toEqual({
      v: 2,
      since: null,
      until: window.until,
      registryVersion: "7",
      id: id2,
    });
  });

  it("splits three 500-member candidates into deterministic 2/1 pages", () => {
    const candidates = [candidate(), candidate(), candidate()];
    const counts = new Map(candidates.map((box) => [box.id, 500]));
    expect(MAX_REGISTRY_PAGE_MEMBER_KEYS).toBe(1000);
    const first = selectBoxRegistryCandidatePrefix(candidates, counts, false);
    expect(first.candidates.map((box) => box.id)).toEqual(
      candidates.slice(0, 2).map((box) => box.id),
    );
    expect(first.hasMoreCandidates).toBe(true);
    const second = selectBoxRegistryCandidatePrefix(candidates.slice(2), counts, false);
    expect(second.candidates.map((box) => box.id)).toEqual([candidates[2]!.id]);
    expect(second.hasMoreCandidates).toBe(false);
  });

  it("always advances over an oversized first candidate at zero payload cost", () => {
    const oversized = candidate();
    const selected = selectBoxRegistryCandidatePrefix(
      [oversized],
      new Map([[oversized.id, MAX_BOX_REGISTRY_MEMBERS + 1]]),
      false,
    );
    expect(selected.candidates).toEqual([oversized]);
    expect(selected.memberKeyBudget).toBe(0);
    expect(selected.hasMoreCandidates).toBe(false);
  });
});
