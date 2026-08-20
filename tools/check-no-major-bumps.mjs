#!/usr/bin/env node
/**
 * Fails when any manifest pin has crossed a MAJOR version relative to
 * `tools/dependency-baseline.json`.
 *
 * Every manifest in this repository pins exact versions, so the only way to
 * upgrade is `pnpm update --latest` — which happily crosses majors. This guard
 * is what makes that command safe to run: the sweep is allowed to move
 * anything within a major and nothing across one.
 *
 * The manifest section list and manifest-discovery logic below are also
 * imported by `tools/generate-dependency-baseline.mjs`, so the guard and the
 * baseline it checks against can never scan different things.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";

/** Manifest sections scanned for version pins. */
export const SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/**
 * Lists `<dir>/<entry>/package.json` for every entry in `dir` that actually
 * has one. Entries without a `package.json` (a stray file, an empty
 * directory, etc.) are skipped rather than crashing.
 */
function listWorkspaceManifests(dir) {
  return readdirSync(dir)
    .map((name) => `${dir}/${name}/package.json`)
    .filter((manifestPath) => existsSync(manifestPath));
}

export function listManifests() {
  return ["package.json", ...listWorkspaceManifests("apps"), ...listWorkspaceManifests("packages")];
}

/**
 * Returns the leading major version number, or `null` when `v` cannot be
 * parsed as a plain/caret/tilde semver (a dist-tag, a compound range, a
 * git/url dependency, or anything else the regex does not anticipate).
 *
 * Callers MUST treat `null` as "unknown, cannot judge" — never as
 * "unchanged". Silently skipping an unparseable version is exactly how a
 * major crossing would slip past this guard undetected.
 */
export function majorOf(v) {
  const m = /^(\d+)\./.exec(String(v).replace(/^[\^~]/, ""));
  return m ? Number(m[1]) : null;
}

function main() {
  const baseline = JSON.parse(readFileSync("tools/dependency-baseline.json", "utf8"));
  const manifests = listManifests();

  const crossed = [];
  const unparseable = [];

  for (const file of manifests) {
    const d = JSON.parse(readFileSync(file, "utf8"));
    for (const section of SECTIONS) {
      for (const [name, version] of Object.entries(d[section] ?? {})) {
        if (String(version).startsWith("workspace:")) continue;

        const hasBaseline = Object.hasOwn(baseline, name);
        if (!hasBaseline) {
          // A package with no baseline entry is a genuinely new dependency —
          // there is nothing to compare it against, so this is intentionally
          // not a major crossing, and not a failure.
          continue;
        }
        const before = baseline[name];

        const a = majorOf(before);
        const b = majorOf(version);
        if (a === null || b === null) {
          unparseable.push(
            `${file}: ${name} ${before} -> ${version} (cannot determine major version)`,
          );
          continue;
        }
        if (b !== a) {
          crossed.push(`${file}: ${name} ${before} -> ${version}`);
        }
      }
    }
  }

  const messages = [];
  if (unparseable.length > 0) {
    messages.push(
      `Cannot determine whether these crossed a major version — treat that as unsafe:\n  ${unparseable.join("\n  ")}`,
    );
  }
  if (crossed.length > 0) {
    messages.push(
      `Major version change is out of scope for this branch:\n  ${crossed.join("\n  ")}`,
    );
  }

  if (messages.length > 0) {
    console.error(messages.join("\n\n"));
    process.exit(1);
  }
  console.log(`No major version changes across ${manifests.length} manifests.`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
