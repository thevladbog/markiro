#!/usr/bin/env node
/**
 * (Re)generates `tools/dependency-baseline.json` from the manifests as they
 * exist right now — the anchor that `tools/check-no-major-bumps.mjs` compares
 * against.
 *
 * Imports `SECTIONS` and `listManifests` from `./dependency-manifests.mjs`
 * instead of redefining them, so the baseline and the guard that reads it can
 * never scan a different set of manifests or a different set of dependency
 * sections.
 *
 * ## Refresh policy
 *
 * Re-anchor after a dependency sweep merges, as its own commit, with nothing
 * else in it. That is what makes the guard usable more than once.
 *
 * The guard detects crossings *relative to an anchor*; it does not remember
 * history. Leaving the anchor frozen at some historical state does not make it
 * stricter — it makes it useless: the day a deferred major lands (TypeScript
 * 6 -> 7, say) the guard fails on every manifest, permanently, and whoever
 * hits that will delete the guard rather than fight it. Re-anchoring at a
 * reviewed, green state is the correct operation.
 *
 * Committing the regeneration on its own is the whole safeguard: the baseline
 * diff is then the reviewable record of exactly what moved. Do NOT fold it
 * into the sweep commit, and never regenerate to make a red guard go green —
 * at that point the diff is hiding the crossing instead of showing it.
 *
 * Run from the repository root: `node tools/generate-dependency-baseline.mjs`.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { SECTIONS, listManifests } from "./dependency-manifests.mjs";

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
