import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLighthouseReport,
  lighthouseArguments,
  LIGHTHOUSE_RUN_COUNT,
  LIGHTHOUSE_THRESHOLDS,
  lighthouseScoreSummary,
  representativeLighthouseReport,
} from "../scripts/lighthouse-landing.mjs";

function report(overrides = {}, metrics = { fcp: 1000, interactive: 3000 }) {
  return {
    audits: {
      "first-contentful-paint": { numericValue: metrics.fcp },
      interactive: { numericValue: metrics.interactive },
    },
    categories: Object.fromEntries(
      Object.entries({ ...LIGHTHOUSE_THRESHOLDS, ...overrides }).map(([category, score]) => [
        category,
        { score },
      ]),
    ),
  };
}

test("uses three sequential runs and the representative Lighthouse median", () => {
  assert.equal(LIGHTHOUSE_RUN_COUNT, 3);
  const slowOutlier = report({ performance: 0.72 }, { fcp: 4000, interactive: 8000 });
  const representative = report({ performance: 0.93 }, { fcp: 1000, interactive: 3000 });
  const fastOutlier = report({ performance: 1 }, { fcp: 500, interactive: 1000 });
  assert.equal(
    representativeLighthouseReport([slowOutlier, representative, fastOutlier]),
    representative,
  );
});

test("accepts exact Lighthouse score thresholds", () => {
  assert.doesNotThrow(() => assertLighthouseReport(report(), "mobile"));
  assert.equal(
    lighthouseScoreSummary(report(), "mobile"),
    "mobile: seo=1.00 accessibility=1.00 best-practices=0.95 performance=0.90",
  );
});

test("adds Chromium sandbox compatibility flags only in CI", () => {
  const base = {
    chromePath: "/chromium",
    output: "/report.json",
    profile: "mobile",
    url: "http://127.0.0.1:5473/",
  };
  assert.deepEqual(
    lighthouseArguments({ ...base, isCI: true }).filter((argument) =>
      argument.startsWith("--chrome-flags="),
    ),
    ["--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage"],
  );
  assert.deepEqual(
    lighthouseArguments({ ...base, isCI: false }).filter((argument) =>
      argument.startsWith("--chrome-flags="),
    ),
    [],
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
