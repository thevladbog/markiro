import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { breakingVersionOf, findBreakingChanges, majorOf } from "../dependency-manifests.mjs";

const toolsDir = fileURLToPath(new URL("../", import.meta.url));
const repositoryDir = fileURLToPath(new URL("../../", import.meta.url));

const manifest = (file, dependencies) => ({ file, manifest: { dependencies } });

test("majorOf reads the leading major of a plain version", () => {
  assert.equal(majorOf("10.7.0"), 10);
});

test("majorOf strips a caret or tilde range prefix", () => {
  assert.equal(majorOf("^0.2.2"), 0);
  assert.equal(majorOf("~7.1.6"), 7);
});

test("majorOf reports 0 for every 0.x version, which is why breakingVersionOf exists", () => {
  assert.equal(majorOf("0.45.2"), 0);
  assert.equal(majorOf("0.46.0"), 0);
});

test("majorOf returns null for anything it cannot parse", () => {
  for (const v of ["latest", "*", ">=1 <3", "github:foo/bar", "workspace:*", ""]) {
    assert.equal(majorOf(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

/**
 * The parser matched only a PREFIX of the version once, which made it fail
 * OPEN. `"1.2.3 || 2.0.0"` is the dangerous case: it admits version 2, but read
 * as "major 1", so against a `1.2.3` baseline it compared equal and passed
 * silently. Everything below is input the guard cannot honestly judge and so
 * must report as `null`. `"01.2.3"` additionally used to make the two functions
 * disagree (`1` vs `"01"`), turning a parse failure into a spurious crossing.
 */
const UNJUDGEABLE = [
  "1.2.3 || 2.0.0", // compound range
  ">=1.2.3 <2.0.0", // compound range
  "1.2.3 - 2.0.0", // hyphen range
  "1.2.3abc", // trailing text
  "1.2.3.4", // trailing text
  "1.x", // wildcard
  "1.2.*", // wildcard
  "01.2.3", // leading zero
  "1.02.3", // leading zero
  "1.2.03", // leading zero
  "1.2", // partial version
  "5", // partial version
  "v1.2.3", // unsupported prefix
  ">=1.2.3", // unsupported operator
];

test("majorOf returns null for input it cannot judge", () => {
  for (const v of UNJUDGEABLE) {
    assert.equal(majorOf(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test("breakingVersionOf returns null for input it cannot judge", () => {
  for (const v of UNJUDGEABLE) {
    assert.equal(breakingVersionOf(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test("a compound range that admits a new major is not silently accepted", () => {
  const { crossed, unparseable } = findBreakingChanges({ typescript: "6.0.3" }, [
    manifest("package.json", { typescript: "6.0.3 || 7.0.2" }),
  ]);
  assert.deepEqual(crossed, []);
  assert.equal(unparseable.length, 1);
  assert.match(unparseable[0], /typescript 6\.0\.3 -> 6\.0\.3 \|\| 7\.0\.2/);
});

test("prereleases and build metadata stay parseable, by decision", () => {
  assert.equal(majorOf("1.2.3-beta.1"), 1);
  assert.equal(breakingVersionOf("1.2.3-beta.1"), "1");
  assert.equal(breakingVersionOf("^0.45.0-rc.2"), "0.45");
  assert.equal(breakingVersionOf("1.2.3+build.5"), "1");
  // and a prerelease of the NEXT major is still caught as a crossing
  assert.equal(breakingVersionOf("2.0.0-beta.1"), "2");
});

test("breakingVersionOf uses the major at 1.0.0 and above", () => {
  assert.equal(breakingVersionOf("10.7.0"), "10");
  assert.equal(breakingVersionOf("^1.2.3"), "1");
});

test("breakingVersionOf uses major and minor below 1.0.0", () => {
  assert.equal(breakingVersionOf("0.45.2"), "0.45");
  assert.equal(breakingVersionOf("0.46.0"), "0.46");
});

test("breakingVersionOf returns null for anything it cannot parse", () => {
  for (const v of ["latest", "*", "5", "1.x", ""]) {
    assert.equal(breakingVersionOf(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test("a major crossing is reported", () => {
  const { crossed, unparseable } = findBreakingChanges({ typescript: "6.0.3" }, [
    manifest("package.json", { typescript: "7.0.2" }),
  ]);
  assert.deepEqual(unparseable, []);
  assert.deepEqual(crossed, ["package.json: typescript 6.0.3 -> 7.0.2"]);
});

test("a move within a major is not reported", () => {
  const { crossed, unparseable } = findBreakingChanges({ eslint: "10.7.0" }, [
    manifest("package.json", { eslint: "10.8.1" }),
  ]);
  assert.deepEqual(crossed, []);
  assert.deepEqual(unparseable, []);
});

test("a 0.x minor move is reported as a crossing", () => {
  const { crossed } = findBreakingChanges({ "drizzle-orm": "0.45.2" }, [
    manifest("apps/api/package.json", { "drizzle-orm": "0.46.0" }),
  ]);
  assert.deepEqual(crossed, ["apps/api/package.json: drizzle-orm 0.45.2 -> 0.46.0"]);
});

test("a 0.x patch move is not reported", () => {
  const { crossed } = findBreakingChanges({ "drizzle-orm": "0.45.2" }, [
    manifest("apps/api/package.json", { "drizzle-orm": "0.45.3" }),
  ]);
  assert.deepEqual(crossed, []);
});

test("an unparseable version is reported rather than skipped", () => {
  const { crossed, unparseable } = findBreakingChanges({ rxjs: "7.8.2" }, [
    manifest("apps/api/package.json", { rxjs: "latest" }),
  ]);
  assert.deepEqual(crossed, []);
  assert.equal(unparseable.length, 1);
  assert.match(unparseable[0], /rxjs 7\.8\.2 -> latest/);
});

test("workspace pins and dependencies absent from the baseline are skipped", () => {
  const { crossed, unparseable } = findBreakingChanges({ eslint: "10.7.0" }, [
    manifest("packages/db/package.json", {
      "@markiro/core": "workspace:*",
      "brand-new-package": "3.0.0",
    }),
  ]);
  assert.deepEqual(crossed, []);
  assert.deepEqual(unparseable, []);
});

test("every dependency section is scanned", () => {
  const { crossed } = findBreakingChanges({ react: "19.2.0" }, [
    { file: "packages/ui/package.json", manifest: { peerDependencies: { react: "20.0.0" } } },
    { file: "apps/api/package.json", manifest: { optionalDependencies: { react: "20.0.0" } } },
  ]);
  assert.equal(crossed.length, 2);
});

/**
 * The entry-point tests below run the guard as a real process from a directory
 * whose name contains a SPACE. That is not incidental: the previous version of
 * this script decided whether to run via
 * `import.meta.url === \`file://${process.argv[1]}\``, which is false for any
 * such path (and on Windows always), so the guard exited 0 and printed nothing.
 * A crossing constructed here must actually fail.
 */
function scratchRepo(rootManifest) {
  const dir = mkdtempSync(join(tmpdir(), "dep guard "));
  mkdirSync(join(dir, "tools"), { recursive: true });
  for (const name of ["check-no-major-bumps.mjs", "dependency-manifests.mjs"]) {
    cpSync(join(toolsDir, name), join(dir, "tools", name));
  }
  writeFileSync(
    join(dir, "tools", "dependency-baseline.json"),
    JSON.stringify({ typescript: "6.0.3", "drizzle-orm": "0.45.2" }, null, 2) + "\n",
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify(rootManifest, null, 2) + "\n");
  return dir;
}

function runGuard(rootManifest) {
  const dir = scratchRepo(rootManifest);
  try {
    assert.ok(dir.includes(" "), "scratch directory must contain a space");
    return spawnSync(process.execPath, ["tools/check-no-major-bumps.mjs"], {
      cwd: dir,
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the guard runs and passes from a path containing a space", () => {
  const r = runGuard({ name: "scratch", devDependencies: { typescript: "6.0.4" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No breaking version changes across 1 manifests\./);
});

test("the guard runs and FAILS on a crossing from a path containing a space", () => {
  const r = runGuard({ name: "scratch", devDependencies: { typescript: "104.0.0" } });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stdout=${r.stdout}`);
  assert.match(r.stderr, /typescript 6\.0\.3 -> 104\.0\.0/);
  assert.equal(r.stdout.trim(), "");
});

test("the guard fails on a 0.x minor crossing from a path containing a space", () => {
  const r = runGuard({ name: "scratch", dependencies: { "drizzle-orm": "0.46.0" } });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stdout=${r.stdout}`);
  assert.match(r.stderr, /drizzle-orm 0\.45\.2 -> 0\.46\.0/);
});

test("private repositories retain a high-severity dependency audit gate", () => {
  const workflow = readFileSync(
    join(repositoryDir, ".github/workflows/dependency-review.yml"),
    "utf8",
  );

  assert.match(workflow, /if:.*repository\.private == false/);
  assert.match(workflow, /actions\/dependency-review-action@/);
  assert.match(workflow, /if:.*repository\.private == true/);
  assert.match(workflow, /pnpm audit --prod --audit-level high/);
});
