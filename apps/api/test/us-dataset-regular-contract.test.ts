import { describe, expect, it } from "vitest";
import {
  makeUsDatasetRegularIndices,
  parseUsDatasetRegularRange,
} from "../src/modules/traceability/demo/us-dataset-regular-contract";

describe("explicit bounded regular range", () => {
  // Off-by-one or a default empty list loses the actual last two selected chains.
  it("selects the last two chains in ascending order", () => {
    expect(
      makeUsDatasetRegularIndices(parseUsDatasetRegularRange({ startIndex: 258, count: 2 })),
    ).toEqual([258, 259]);
  });
  it("selects all 260 regular indices only when explicitly requested", () => {
    const indices = makeUsDatasetRegularIndices({ startIndex: 0, count: 260 });
    expect(indices).toHaveLength(260);
    expect(indices[0]).toBe(0);
    expect(indices[259]).toBe(259);
    expect(new Set(indices).size).toBe(260);
    expect(indices.every((value, offset) => value === offset)).toBe(true);
  });
  it.each([
    undefined,
    null,
    [],
    {},
    { startIndex: 0 },
    { count: 1 },
    { startIndex: 0, count: 0 },
    { startIndex: 0, count: -1 },
    { startIndex: -1, count: 1 },
    { startIndex: 260, count: 1 },
    { startIndex: 259, count: 2 },
    { startIndex: 0, count: 261 },
    { startIndex: 0.5, count: 1 },
    { startIndex: 0, count: 1.5 },
    { startIndex: "0", count: 1 },
    { startIndex: 0, count: "1" },
    { startIndex: NaN, count: 1 },
    { startIndex: 0, count: Infinity },
    { startIndex: -0, count: 1 },
    { startIndex: 0, count: -0 },
    { startIndex: 0, count: 1, extra: true },
    { startIndex: 0, count: 1, [Symbol("hidden")]: true },
    Object.defineProperty({ startIndex: 0, count: 1 }, "hidden", { value: true }),
    Object.assign(Object.create({ inherited: true }), { startIndex: 0, count: 1 }),
    { startIndex: 0, count: 1, padding: "x".repeat(256 * 1024) },
  ])("rejects invalid evidence without coercion (%#)", (raw) => {
    expect(() => parseUsDatasetRegularRange(raw)).toThrow("us_dataset_regular_range_invalid");
  });
  it("rejects accessors and cycles before any getter executes", () => {
    let reads = 0;
    const root = { count: 1 };
    Object.defineProperty(root, "startIndex", {
      enumerable: true,
      get() {
        reads++;
        return 0;
      },
    });
    const nested = { startIndex: 0, count: 1, child: root };
    const cycle: Record<string, unknown> = { startIndex: 0, count: 1 };
    cycle["child"] = cycle;
    for (const raw of [root, nested, cycle])
      expect(() => parseUsDatasetRegularRange(raw)).toThrow("us_dataset_regular_range_invalid");
    expect(reads).toBe(0);
  });
  it("owns immutable copies without freezing or aliasing caller evidence", () => {
    const raw = { startIndex: 0, count: 2 };
    const parsed = parseUsDatasetRegularRange(raw);
    const indices = makeUsDatasetRegularIndices(parsed);
    raw.startIndex = 259;
    raw.count = 1;
    expect(parsed).toEqual({ startIndex: 0, count: 2 });
    expect(parsed).not.toBe(raw);
    expect(indices).toEqual([0, 1]);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(indices)).toBe(true);
    expect(makeUsDatasetRegularIndices(parsed)).not.toBe(indices);
  });
  it("revalidates an untrusted direct indices request", () => {
    expect(() => makeUsDatasetRegularIndices({ startIndex: 259, count: 2 })).toThrow(
      "us_dataset_regular_range_invalid",
    );
  });
});
