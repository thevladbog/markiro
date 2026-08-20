#!/usr/bin/env node
/**
 * Fails when any manifest pin has crossed a MAJOR version relative to
 * `tools/dependency-baseline.json`.
 *
 * Every manifest in this repository pins exact versions, so the only way to
 * upgrade is `pnpm update --latest` — which happily crosses majors. This guard
 * is what makes that command safe to run: the sweep is allowed to move
 * anything within a major and nothing across one.
 */
import { readFileSync, readdirSync } from "node:fs";

const baseline = JSON.parse(readFileSync("tools/dependency-baseline.json", "utf8"));

const manifests = [
  "package.json",
  ...readdirSync("apps").map((d) => `apps/${d}/package.json`),
  ...readdirSync("packages").map((d) => `packages/${d}/package.json`),
];

const majorOf = (v) => {
  const m = /^(\d+)\./.exec(String(v).replace(/^[\^~]/, ""));
  return m ? Number(m[1]) : null;
};

const crossed = [];
for (const file of manifests) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(d[section] ?? {})) {
      if (String(version).startsWith("workspace:")) continue;
      const before = baseline[name];
      if (!before) continue;
      const a = majorOf(before);
      const b = majorOf(version);
      if (a !== null && b !== null && b !== a) {
        crossed.push(`${file}: ${name} ${before} -> ${version}`);
      }
    }
  }
}

if (crossed.length > 0) {
  console.error(`Major version change is out of scope for this branch:\n  ${crossed.join("\n  ")}`);
  process.exit(1);
}
console.log(`No major version changes across ${manifests.length} manifests.`);
