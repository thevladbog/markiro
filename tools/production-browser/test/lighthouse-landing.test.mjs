import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLighthouseReport,
  LIGHTHOUSE_THRESHOLDS,
  lighthouseScoreSummary,
} from "../scripts/lighthouse-landing.mjs";

function report(overrides = {}) {
  return {
    categories: Object.fromEntries(
      Object.entries({ ...LIGHTHOUSE_THRESHOLDS, ...overrides }).map(([category, score]) => [
        category,
        { score },
      ]),
    ),
  };
}

test("accepts exact Lighthouse score thresholds", () => {
  assert.doesNotThrow(() => assertLighthouseReport(report(), "mobile"));
  assert.equal(
    lighthouseScoreSummary(report(), "mobile"),
    "mobile: seo=1.00 accessibility=1.00 best-practices=0.95 performance=0.90",
  );
});

for (const [category, score] of [
  ["seo", 0.99],
  ["accessibility", 0.99],
  ["best-practices", 0.94],
  ["performance", 0.89],
]) {
  test(`rejects a ${category} score below the release threshold`, () => {
    assert.throws(
      () => assertLighthouseReport(report({ [category]: score }), "desktop"),
      new RegExp(`desktop: Lighthouse ${category} score`),
    );
  });
}

for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
  test(`rejects missing or non-finite score ${String(value)}`, () => {
    assert.throws(
      () => assertLighthouseReport(report({ seo: value }), "mobile"),
      /mobile: Lighthouse seo score is missing/,
    );
  });
}
