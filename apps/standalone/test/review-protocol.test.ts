import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  conflictStatusRequestSchema,
  conflictStatusResponseSchema,
  deviceDisplacementsSchema,
  displacementsPath,
  CONFLICT_MAX_PAGE,
  CONFLICT_PAGE_SIZE,
  SHIFT_REVIEW_LIMIT,
  conflictsPath,
  officeConflictPageSchema,
  officeShiftExceptionsSchema,
  officeShiftExportsSchema,
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
  ["office-shift-exports.json", officeShiftExportsSchema],
  ["conflict-status-request.json", conflictStatusRequestSchema],
  ["conflict-status-response.json", conflictStatusResponseSchema],
  ["device-displacements.json", deviceDisplacementsSchema],
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

describe("a station's requests after its conflicts (plan КНФ)", () => {
  it("names 1 to 200 record ids and nothing else", () => {
    const id = "00000000-0000-4000-8000-000000000002";
    expect(conflictStatusRequestSchema.safeParse({ recordIds: [] }).success).toBe(false);
    expect(
      conflictStatusRequestSchema.safeParse({ recordIds: Array.from({ length: 201 }, () => id) })
        .success,
    ).toBe(false);
    expect(conflictStatusRequestSchema.safeParse({ recordIds: [id], extra: 1 }).success).toBe(
      false,
    );
  });

  it("asks for displacements after both ends of its cursor, or from the start", () => {
    expect(displacementsPath(null)).toBe("/v1/device/displacements");
    expect(displacementsPath({ at: "2026-10-08T07:12:03Z", id: "c-1" })).toBe(
      "/v1/device/displacements?afterAt=2026-10-08T07%3A12%3A03Z&afterId=c-1",
    );
  });
});
