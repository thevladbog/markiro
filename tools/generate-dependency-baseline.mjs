#!/usr/bin/env node
/**
 * (Re)generates `tools/dependency-baseline.json` from the manifests as they
 * exist right now.
 *
 * Imports `SECTIONS` and `listManifests` from `tools/check-no-major-bumps.mjs`
 * instead of redefining them, so the baseline and the guard that reads it can
 * never scan a different set of manifests or a different set of dependency
 * sections.
 *
 * Run this exactly once, to establish (or deliberately reset) the pre-sweep
 * baseline the guard compares against. Re-running it after a dependency sweep
 * would just re-record whatever versions exist then, silently erasing the
 * guard's ability to catch anything.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SECTIONS, listManifests } from "./check-no-major-bumps.mjs";

const manifests = listManifests();
const baseline = {};

for (const file of manifests) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  for (const section of SECTIONS) {
    for (const [name, version] of Object.entries(d[section] ?? {})) {
      if (String(version).startsWith("workspace:")) continue;
      baseline[name] ??= version;
    }
  }
}

writeFileSync("tools/dependency-baseline.json", JSON.stringify(baseline, null, 2) + "\n");
console.log(`baseline packages: ${Object.keys(baseline).length}`);
