import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CONFLICT_MAX_PAGE,
  CONFLICT_PAGE_SIZE,
  SHIFT_REVIEW_LIMIT,
  conflictsPath,
  officeConflictPageSchema,
  officeShiftExceptionsSchema,
  officeShiftRejectionsSchema,
} from "../src/host/review.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

describe.each([
  ["office-conflict-page.json", officeConflictPageSchema],
  ["office-shift-exceptions.json", officeShiftExceptionsSchema],
  ["office-shift-rejections.json", officeShiftRejectionsSchema],
] as const)("review fixture %s (plan КНФ)", (name, schema) => {
  it("parses without losing a field", () => {
    expect(schema.parse(fixture(name))).toEqual(fixture(name));
  });
});

describe("officeConflictPageSchema", () => {
  const page = officeConflictPageSchema.parse(fixture("office-conflict-page.json"));
  const first = page.items[0];
  it.each([
    ["an unknown kind", { ...page, items: [{ ...first, kind: "twice" }] }],
    ["a hash in upper case", { ...page, items: [{ ...first, codeHash: "A".repeat(64) }] }],
    ["a short hash", { ...page, items: [{ ...first, codeHash: "0".repeat(63) }] }],
    ["page 0", { ...page, page: 0 }],
  ])("refuses %s", (_, value) => {
    expect(officeConflictPageSchema.safeParse(value).success).toBe(false);
  });

  it("keeps the limits of markiro_proto::review", () => {
    expect([CONFLICT_PAGE_SIZE, CONFLICT_MAX_PAGE, SHIFT_REVIEW_LIMIT]).toEqual([50, 200, 500]);
  });
});

describe("conflictsPath", () => {
  it("writes only what is asked, the first page without a number", () => {
    expect(conflictsPath({})).toBe("/v1/office/conflicts");
    expect(conflictsPath({ page: 1 })).toBe("/v1/office/conflicts");
    expect(conflictsPath({ shiftId: "s-1", reviewed: false, page: 3 })).toBe(
      "/v1/office/conflicts?shift=s-1&reviewed=false&page=3",
    );
    expect(conflictsPath({ reviewed: true })).toBe("/v1/office/conflicts?reviewed=true");
  });
});
