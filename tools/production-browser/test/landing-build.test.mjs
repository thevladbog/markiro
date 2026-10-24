import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { landingBuildEnvironment, prepareLandingDist } from "../scripts/landing-build.mjs";
import { lighthouseBuildEnvironment } from "../scripts/lighthouse-landing.mjs";

test("the Playwright suite and the Lighthouse gate build the landing from one environment", () => {
  assert.equal(lighthouseBuildEnvironment, landingBuildEnvironment);
  const config = readFileSync(
    path.join(import.meta.dirname, "../landing.playwright.config.ts"),
    "utf8",
  );
  const defaults = landingBuildEnvironment({});
  for (const [name, value] of Object.entries(defaults)) {
    assert.match(
      config,
      new RegExp(`${name}: ${JSON.stringify(value).replaceAll("+", "\\+")},`),
      name,
    );
  }
});

test("a prebuilt landing is used as is, but only when it is complete", (t) => {
  const dist = mkdtempSync(path.join(tmpdir(), "markiro-landing-dist-"));
  t.after(() => rmSync(dist, { force: true, recursive: true }));
  const prebuilt = { MARKIRO_LANDING_PREBUILT: "1" };

  assert.throws(() => prepareLandingDist(prebuilt, { dist }), /dist\/index\.html is missing/);
  writeFileSync(path.join(dist, "index.html"), "<!doctype html>");
  assert.throws(() => prepareLandingDist(prebuilt, { dist }), /dist\/404\.html is missing/);
  mkdirSync(path.join(dist, "nested"));
  writeFileSync(path.join(dist, "404.html"), "<!doctype html>");
  assert.doesNotThrow(() => prepareLandingDist(prebuilt, { dist }));
});
