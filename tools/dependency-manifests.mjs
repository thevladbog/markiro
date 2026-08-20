/**
 * Shared manifest discovery and version comparison, used by both
 * `tools/check-no-major-bumps.mjs` (the guard) and
 * `tools/generate-dependency-baseline.mjs` (which writes the baseline the
 * guard compares against), so the two can never scan different things.
 *
 * This module is deliberately side-effect free, and both of its consumers are
 * plain CLIs that do their work unconditionally at import time. That means
 * neither needs an "am I the entry point?" test. The obvious spelling of that
 * test — `import.meta.url === \`file://${process.argv[1]}\`` — compares a
 * percent-encoded URL against a raw path, so it is false for any path
 * containing a space, `#`, `%`, or a non-ASCII character, and false on Windows
 * always (`file://C:\...` vs `file:///C:/...`). A guard behind such a test
 * exits 0 and prints nothing, which is indistinguishable from passing. Keeping
 * the reusable parts here removes the need for the test at all.
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
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => `${dir}/${name}/package.json`)
    .filter((manifestPath) => existsSync(manifestPath));
}

/** Manifest paths, relative to the repository root — run from there. */
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

/**
 * Returns the version segment this repository treats as the breaking one, as
 * a comparable string, or `null` when `v` cannot be parsed (same contract as
 * `majorOf`: `null` means "cannot judge", never "unchanged").
 *
 * - At `1.0.0` and above that is the major: `"10.7.0"` -> `"10"`.
 * - Below `1.0.0` it is the major AND the minor: `"0.45.2"` -> `"0.45"`.
 *
 * The `0.x` rule matters because `majorOf` reports `0` for every version below
 * 1.0, so every move within `0.x` would read as "same major". By the
 * convention these ecosystems follow, `0.45 -> 0.46` IS a breaking change,
 * while `0.45.2 -> 0.45.3` is not. Five of this repository's pinned
 * dependencies live there — `drizzle-orm`, `drizzle-kit`, `sharp`, `fflate`,
 * `@astrojs/check` — and without this rule the guard would give them no
 * protection whatsoever.
 */
export function breakingVersionOf(v) {
  const m = /^(\d+)\.(\d+)/.exec(String(v).replace(/^[\^~]/, ""));
  if (!m) return null;
  return m[1] === "0" ? `0.${m[2]}` : m[1];
}

/**
 * Reads and parses each manifest path into `{ file, manifest }`.
 */
export function readManifests(files) {
  return files.map((file) => ({ file, manifest: JSON.parse(readFileSync(file, "utf8")) }));
}

/**
 * Compares every pin in `manifests` (as returned by `readManifests`) against
 * `baseline`, and reports:
 *
 * - `crossed`: pins whose breaking segment moved (see `breakingVersionOf`).
 * - `unparseable`: pins where either side could not be judged at all.
 *
 * `workspace:` protocol pins are internal and are skipped. A package with no
 * baseline entry is a genuinely new dependency — there is nothing to compare
 * it against, so it is intentionally neither a crossing nor a failure.
 */
export function findBreakingChanges(baseline, manifests) {
  const crossed = [];
  const unparseable = [];

  for (const { file, manifest } of manifests) {
    for (const section of SECTIONS) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        if (String(version).startsWith("workspace:")) continue;
        if (!Object.hasOwn(baseline, name)) continue;

        const before = baseline[name];
        const a = breakingVersionOf(before);
        const b = breakingVersionOf(version);
        if (a === null || b === null) {
          unparseable.push(
            `${file}: ${name} ${before} -> ${version} (cannot determine breaking version)`,
          );
          continue;
        }
        if (b !== a) {
          crossed.push(`${file}: ${name} ${before} -> ${version}`);
        }
      }
    }
  }

  return { crossed, unparseable };
}
