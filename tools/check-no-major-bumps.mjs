#!/usr/bin/env node
/**
 * Fails when any manifest pin has crossed a breaking version boundary relative
 * to `tools/dependency-baseline.json`.
 *
 * Every manifest in this repository pins exact versions, so the only way to
 * upgrade is `pnpm update -r --latest` — which happily crosses majors. This
 * guard is what makes that command safe to run: the sweep is allowed to move
 * anything within a breaking boundary and nothing across one.
 *
 * "Breaking" is the major at `1.0.0` and above, and the MINOR below it:
 * `0.45.2 -> 0.46.0` is reported as a crossing, `0.45.2 -> 0.45.3` is not.
 * See `breakingVersionOf` in `./dependency-manifests.mjs` for why.
 *
 * Run from the repository root: `pnpm check:deps`.
 *
 * This file is a CLI and nothing else — it does its work unconditionally, with
 * no "am I the entry point?" test that could silently skip it. Everything
 * reusable lives in `./dependency-manifests.mjs`; import from there.
 */
import { readFileSync } from "node:fs";

import { findBreakingChanges, listManifests, readManifests } from "./dependency-manifests.mjs";

const baseline = JSON.parse(readFileSync("tools/dependency-baseline.json", "utf8"));
const files = listManifests();
const { crossed, unparseable } = findBreakingChanges(baseline, readManifests(files));

const messages = [];
if (unparseable.length > 0) {
  messages.push(
    `Cannot determine whether these crossed a breaking version — treat that as unsafe:\n  ${unparseable.join("\n  ")}`,
  );
}
if (crossed.length > 0) {
  messages.push(
    `Breaking version change (major, or minor below 1.0) is out of scope for this branch:\n  ${crossed.join("\n  ")}`,
  );
}

if (messages.length > 0) {
  console.error(messages.join("\n\n"));
  process.exit(1);
}
console.log(`No breaking version changes across ${files.length} manifests.`);
