import { expect, it } from "vitest";
import {
  splitCatalogInterval,
  statuses,
} from "../src/modules/national-catalog/national-catalog-enumeration";
it("overlaps the midpoint and refuses an unsplittable second", () => {
  expect(splitCatalogInterval(0, 4000)).toEqual([
    [0, 2000],
    [2000, 4000],
  ]);
  expect(splitCatalogInterval(0, 1000)).toBeNull();
});

it("keeps recognized and unknown nonempty provider statuses together", () => {
  expect(statuses("published", ["future_status"])).toEqual(["published", "unknown"]);
  expect(statuses("published", ["", "notsigned"])).toEqual(["published", "unsigned"]);
});
