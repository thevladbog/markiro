import { describe, expect, it } from "vitest";
import {
  buildChzSummary,
  hasUnreviewedCatalogChanges,
} from "../src/modules/national-catalog/national-catalog-summary";

const projection = (values: Record<string, unknown>) => ({ version: 1 as const, values });

describe("confirmed catalogue meaningful changes", () => {
  it("does not combine an old rejected difference with a newly changed target equal to local", () => {
    expect(
      hasUnreviewedCatalogChanges({
        reviewed: projection({ name: "Rejected source", "stable:print_name": "Old" }),
        observed: projection({ name: "Rejected source", "stable:print_name": "Current" }),
        current: projection({ name: "Local", "stable:print_name": "Current" }),
      }),
    ).toBe(false);
  });
  it("badges only a newly unreviewed supported target that also differs locally", () => {
    expect(
      hasUnreviewedCatalogChanges({
        reviewed: projection({ name: "Reviewed" }),
        observed: projection({ name: "Changed" }),
        current: projection({ name: "Local" }),
      }),
    ).toBe(true);
  });
  it("responds to local edits after observation without another source read", () => {
    const input = {
      reviewed: projection({ name: "Reviewed" }),
      observed: projection({ name: "Changed" }),
    };
    expect(
      hasUnreviewedCatalogChanges({ ...input, current: projection({ name: "Changed" }) }),
    ).toBe(false);
    expect(hasUnreviewedCatalogChanges({ ...input, current: projection({ name: "Local" }) })).toBe(
      true,
    );
  });
  it("does not claim changes for missing or incompatible evidence", () => {
    expect(
      hasUnreviewedCatalogChanges({
        reviewed: null,
        observed: projection({ name: "New" }),
        current: projection({ name: "Local" }),
      }),
    ).toBe(false);
    expect(
      hasUnreviewedCatalogChanges({
        reviewed: projection({ "attribute:old:A": "Old" }),
        observed: projection({ "attribute:old:A": "New" }),
        current: projection({ "attribute:new:A": "Local" }),
      }),
    ).toBe(false);
  });
  it("retains known status and success time on a failed refresh", () => {
    expect(
      buildChzSummary({
        linkId: "link",
        revision: 1,
        statusKeys: ["published"],
        rawStatus: "published",
        rawDetailedStatuses: ["unrecognized-provider-label"],
        lastSuccessAt: "2026-09-08T09:00:00Z",
        lastAttemptAt: "2026-09-08T10:00:00Z",
        refreshing: false,
        lastOutcome: "error",
        hasChanges: false,
        lastErrorCode: null,
      }),
    ).toMatchObject({
      statusKeys: ["published"],
      rawDetailedStatuses: ["unrecognized-provider-label"],
      lastSuccessAt: "2026-09-08T09:00:00Z",
      lastOutcome: "error",
      hasChanges: false,
    });
  });
});

it("follows the reviewed logical photo across URL rotation and refuses ambiguous galleries", async () => {
  const { selectObservedPhoto } =
    await import("../src/modules/national-catalog/national-catalog-photo-selection");
  const { createHash } = await import("node:crypto");
  const selector = {
    sourceId: "good_images:0",
    barcode: "04601234567893",
    primary: true,
    urlHash: createHash("sha256").update("https://images.example/old").digest("hex"),
  };
  const rotated = {
    sourceId: "good_images:2",
    barcode: "04601234567893",
    primary: true,
    url: "https://images.example/new",
  };
  expect(selectObservedPhoto(selector, [rotated])).toEqual(rotated);
  expect(
    selectObservedPhoto(selector, [
      rotated,
      { ...rotated, sourceId: "good_images:3", url: "https://images.example/other" },
    ]),
  ).toBeNull();
  const exact = { ...rotated, sourceId: "good_images:9", url: "https://images.example/old" };
  expect(selectObservedPhoto(selector, [rotated, exact])).toEqual(exact);
});
it("suppresses only an explicit archived status while retaining the saved summary", () => {
  const saved = {
    linkId: "link",
    revision: 1,
    statusKeys: ["archived" as const],
    rawStatus: "archived",
    rawDetailedStatuses: [],
    lastSuccessAt: "2026-09-08T09:00:00Z",
    lastAttemptAt: "2026-09-08T09:00:00Z",
    refreshing: false,
    lastOutcome: "ok" as const,
    lastErrorCode: null,
    hasChanges: true,
  };
  expect(buildChzSummary(saved)).toEqual({ ...saved, hasChanges: false });
  expect(buildChzSummary({ ...saved, statusKeys: ["unknown"], rawStatus: "999" }).hasChanges).toBe(
    true,
  );
});
it("distinguishes a first-filled reviewed name from an unknown reviewed photo", async () => {
  const { reviewedCatalogValues } =
    await import("../src/modules/national-catalog/national-catalog-observation-projection");
  const reviewed = reviewedCatalogValues({ version: 1, values: {}, context: null });
  expect(
    hasUnreviewedCatalogChanges({
      reviewed,
      observed: projection({ name: "First valid name" }),
      current: projection({ name: "Local" }),
    }),
  ).toBe(true);
  expect(
    hasUnreviewedCatalogChanges({
      reviewed,
      observed: projection({ photo: "known-new-checksum" }),
      current: projection({ photo: null }),
    }),
  ).toBe(false);
  expect(reviewedCatalogValues(null)).toBeNull();
});
