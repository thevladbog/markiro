import { describe, expect, it } from "vitest";
import type { OperatorMirrorRecord } from "@markiro/db/station-sqlite";
import { normalizeOperatorNameQuery, searchOperatorsByName } from "../src/lib/operator-search.js";

function operator(
  operatorId: string,
  name: string,
  login: string,
  overrides: Partial<OperatorMirrorRecord> = {},
): OperatorMirrorRecord {
  return {
    operatorId,
    name,
    login,
    role: "operator",
    pinHash: `secret-${operatorId}`,
    badgeHash: `badge-${operatorId}`,
    active: true,
    ...overrides,
  };
}

describe("operator name search", () => {
  it("normalizes case and repeated whitespace and waits for two letters", () => {
    const roster = [operator("op-1", "Анна   Смирнова", "101")];

    expect(normalizeOperatorNameQuery("  АННА   см ")).toBe("анна см");
    expect(searchOperatorsByName(roster, "а")).toEqual([]);
    expect(searchOperatorsByName(roster, "  АН ")).toEqual([
      { operatorId: "op-1", name: "Анна   Смирнова", login: "101" },
    ]);
  });

  it("returns at most five deterministic active matches without credentials", () => {
    const roster = [
      operator("op-6", "Alex Z", "106"),
      operator("op-3", "Alex C", "103"),
      operator("op-2", "Alex B", "102"),
      operator("op-5", "Alex E", "105"),
      operator("op-1", "Alex A", "101"),
      operator("op-4", "Alex D", "104"),
      operator("op-off", "Alex Offline", "107", { active: false }),
    ];

    const results = searchOperatorsByName(roster, "al");
    expect(results).toHaveLength(5);
    expect(results.map((result) => result.operatorId)).toEqual([
      "op-1",
      "op-2",
      "op-3",
      "op-4",
      "op-5",
    ]);
    expect(results.every((result) => !Object.hasOwn(result, "pinHash"))).toBe(true);
    expect(results.every((result) => !Object.hasOwn(result, "badgeHash"))).toBe(true);
  });

  it("matches normalized tokens in order and excludes operators without a usable exact login", () => {
    const roster = [
      operator("op-1", "Смирнов Алексей", "123"),
      operator("op-2", "Смирнова Алёна", "000123"),
      operator("op-empty", "Смирнов Без номера", ""),
    ];

    expect(searchOperatorsByName(roster, "см ал")).toEqual([
      { operatorId: "op-1", name: "Смирнов Алексей", login: "123" },
      { operatorId: "op-2", name: "Смирнова Алёна", login: "000123" },
    ]);
  });
});
