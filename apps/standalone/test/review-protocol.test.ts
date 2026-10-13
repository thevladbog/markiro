import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
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
