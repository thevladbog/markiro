import { describe, expect, it } from "vitest";

import type { BadgeInfo, OfficeOperator } from "../src/host/protocol.js";
import { withBadge } from "../src/office/operators/operator-records.js";

const ANNA_ID = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";

const REVOKED: BadgeInfo = {
  id: "e7f6d5c4-b3a2-4918-8a7b-6c5d4e3f2a19",
  label: null,
  createdAt: "2026-09-20T08:00:00Z",
  revokedAt: "2026-09-27T08:00:00Z",
};
const PASS_7: BadgeInfo = {
  id: "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d",
  label: "Пропуск №7",
  createdAt: "2026-09-27T08:00:00Z",
  revokedAt: null,
};
const PASS_8: BadgeInfo = {
  id: "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b",
  label: "Пропуск №8",
  createdAt: "2026-09-28T08:00:00Z",
  revokedAt: null,
};

function operator(id: string, badges: BadgeInfo[]): OfficeOperator {
  return {
    id,
    login: "0042",
    name: "Анна Кузнецова",
    role: null,
    active: true,
    hasPin: true,
    badges,
    rev: 55,
  };
}

const VERA = operator("3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f", []);

describe("withBadge", () => {
  it("adds a badge the operator does not have after theirs, and leaves everyone else as they are", () => {
    const operators = [operator(ANNA_ID, [REVOKED, PASS_7]), VERA];
    const before = structuredClone(operators);
    const result = withBadge(operators, ANNA_ID, PASS_8);
    expect(result).toStrictEqual([operator(ANNA_ID, [REVOKED, PASS_7, PASS_8]), VERA]);
    expect(result[1]).toBe(VERA);
    expect(result).not.toBe(operators);
    expect(operators).toStrictEqual(before);
  });

  it("puts a badge the operator already has in place of it, which keeps its position", () => {
    const revokedNow: BadgeInfo = { ...PASS_7, revokedAt: "2026-09-28T09:00:00Z" };
    const operators = [operator(ANNA_ID, [REVOKED, PASS_7, PASS_8]), VERA];
    const before = structuredClone(operators);
    const result = withBadge(operators, ANNA_ID, revokedNow);
    expect(result[0]?.badges).toStrictEqual([REVOKED, revokedNow, PASS_8]);
    expect(result[0]?.badges[1]).toBe(revokedNow);
    expect(operators).toStrictEqual(before);
  });

  it("applied twice gives one badge: a re-read that raced the write may have brought it already", () => {
    const once = withBadge([operator(ANNA_ID, [REVOKED])], ANNA_ID, PASS_7);
    const twice = withBadge(once, ANNA_ID, PASS_7);
    expect(once[0]?.badges).toStrictEqual([REVOKED, PASS_7]);
    expect(twice).toStrictEqual(once);
    // One badge per id: two would be a duplicate React key and a double count in the row.
    expect(twice[0]?.badges.map((badge) => badge.id)).toStrictEqual([REVOKED.id, PASS_7.id]);
  });
});
