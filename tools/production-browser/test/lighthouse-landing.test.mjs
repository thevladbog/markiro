import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLighthouseReport,
  lighthouseArguments,
  LIGHTHOUSE_ROUTES,
  LIGHTHOUSE_RUN_COUNT,
  lighthouseBuildEnvironment,
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

test("gates on the run with the median performance score, not Lighthouse's metric median", () => {
  // A shared CI runner can drop one run's score through total-blocking-time
  // alone while its FCP/TTI stay in the middle; that run must not be the gate.
  const cpuNoise = report({ performance: 0.86 }, { fcp: 1000, interactive: 3000 });
  const medianScore = report({ performance: 0.94 }, { fcp: 900, interactive: 2800 });
  const best = report({ performance: 0.95 }, { fcp: 1200, interactive: 3300 });
  assert.equal(representativeLighthouseReport([cpuNoise, medianScore, best]), medianScore);
  assert.equal(representativeLighthouseReport([best, cpuNoise, medianScore]), medianScore);
});

test("builds the production-like enabled landing for the gate unless the caller overrides it", () => {
  const environment = lighthouseBuildEnvironment({ PATH: "/usr/bin" });
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.ASTRO_TELEMETRY_DISABLED, "1");
  assert.equal(environment.PUBLIC_DEMO_SUBMISSION_ENABLED, "true");
  assert.match(environment.PUBLIC_SMARTCAPTCHA_CLIENT_KEY, /^ysc1_.+/);
  assert.equal(environment.PUBLIC_PHONE, "+7 934 355-14-90");

  const overridden = lighthouseBuildEnvironment({
    PUBLIC_DEMO_SUBMISSION_ENABLED: "false",
    PUBLIC_PHONE: "",
  });
  assert.equal(overridden.PUBLIC_DEMO_SUBMISSION_ENABLED, "false");
  assert.equal(overridden.PUBLIC_PHONE, "");
});

test("gates the home page, a commercial topic page and an article", () => {
  assert.ok(Object.isFrozen(LIGHTHOUSE_ROUTES));
  assert.deepEqual(LIGHTHOUSE_ROUTES, [
    "/",
    "/markirovka-chestny-znak/",
    "/stati/markirovka-piva-2026/",
  ]);
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
