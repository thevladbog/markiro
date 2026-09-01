# Signer Distribution Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish future Signer stable releases to `thevladbog/markiro-station-releases` with workflow-owned semantic versions and an exact-byte recovery path, while retaining Yandex as the public updater and installer channel.

**Architecture:** Pure Node helpers reconcile the GitHub and Yandex release ledgers and calculate the next semantic version. The Windows job injects that version through a temporary Tauri overlay, prepares one canonical release directory, uploads it to a draft GitHub release, publishes the same bytes to Yandex, and finally publishes the draft. A repair dispatch downloads and verifies the draft assets instead of rebuilding them.

**Tech Stack:** GitHub Actions, GitHub CLI, Node 24 built-in test runner, Tauri 2, AWS S3 client, Windows NSIS.

**Spec:** `docs/superpowers/specs/2026-09-01-signer-release-resilience-design.md`

## Global Constraints

- Only stable versions matching `major.minor.patch` are released; no beta channel is added.
- Future GitHub releases go to `thevladbog/markiro-station-releases`; historical source-repository releases remain untouched.
- The installed client continues to read only `https://releases.markiro.app/signer/stable/latest.json`.
- `publish` supports `patch`, `minor`, and `major`, defaulting to `patch`; `repair` accepts no bump.
- GitHub and Yandex must agree before a new version is calculated; disagreement blocks publication.
- The release version is injected only in the runner and is never committed to `main`.
- Immutable artifacts are never rebuilt, overwritten, or replaced during repair.
- Yandex `latest.json` and `/signer/download` advance only after immutable artifacts are publicly verified.
- The cross-repository credential is `STATION_RELEASE_REPOSITORY_TOKEN` from the `station-release` environment.
- The signing private key must never be printed or placed directly on a command line.

---

### Task 1: Semantic version and channel reconciliation

**Files:**

- Modify: `tools/signer-release/version.mjs`
- Modify: `tools/signer-release/test/version.test.mjs`

**Interfaces:**

- Produces: `parseSignerReleaseTag(tag): string | null`
- Produces: `compareVersions(left, right): number`
- Produces: `bumpSignerVersion(current, bump): string`
- Produces: `reconcileStableVersions({ githubVersion, yandexVersion }): { kind: "empty" } | { kind: "aligned"; version: string }`
- Produces: `buildTauriVersionOverlay(version): { version: string }`
- Produces: `SIGNER_DISTRIBUTION_BASELINE = "0.1.4"` for the one-time migration from an empty distribution repository.

- [ ] **Step 1: Add failing tests for strict tags, all bump kinds, overflow-safe numeric comparison, empty channels, aligned channels, and split-brain refusal.**

```js
test("bumps the agreed stable version", () => {
  assert.equal(bumpSignerVersion("0.1.4", "patch"), "0.1.5");
  assert.equal(bumpSignerVersion("0.1.4", "minor"), "0.2.0");
  assert.equal(bumpSignerVersion("0.1.4", "major"), "1.0.0");
});

test("refuses split-brain stable channels", () => {
  assert.throws(
    () => reconcileStableVersions({ githubVersion: "0.1.4", yandexVersion: "0.1.5" }),
    /repair/,
  );
});

test("accepts the one-time distribution migration baseline", () => {
  assert.deepEqual(
    reconcileStableVersions({ githubVersion: null, yandexVersion: "0.1.4" }),
    { kind: "aligned", version: "0.1.4" },
  );
});

test("rejects prerelease and malformed tags", () => {
  assert.equal(parseSignerReleaseTag("signer-v0.2.0-beta.1"), null);
  assert.equal(parseSignerReleaseTag("station-v0.2.0"), null);
});
```

- [ ] **Step 2: Run the focused test and confirm the new exports are absent.**

Run: `node --test tools/signer-release/test/version.test.mjs`

Expected: FAIL with missing export errors.

- [ ] **Step 3: Implement strict integer parsing, semantic comparison, bumping, reconciliation, and the one-key overlay.**

```js
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function bumpSignerVersion(current, bump) {
  const parts = parseVersion(current);
  if (bump === "patch") return `${parts.major}.${parts.minor}.${parts.patch + 1}`;
  if (bump === "minor") return `${parts.major}.${parts.minor + 1}.0`;
  if (bump === "major") return `${parts.major + 1}.0.0`;
  throw new Error(`unsupported signer bump: ${bump}`);
}

export function reconcileStableVersions({ githubVersion, yandexVersion }) {
  if (!githubVersion && !yandexVersion) return { kind: "empty" };
  if (!githubVersion && yandexVersion === SIGNER_DISTRIBUTION_BASELINE) {
    return { kind: "aligned", version: yandexVersion };
  }
  if (githubVersion === yandexVersion) return { kind: "aligned", version: githubVersion };
  throw new Error("signer stable channels disagree; run repair before publishing");
}
```

- [ ] **Step 4: Run the focused test.**

Run: `node --test tools/signer-release/test/version.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the version-state unit.**

```bash
git add tools/signer-release/version.mjs tools/signer-release/test/version.test.mjs
git commit -m "feat(signer-release): derive stable versions in workflow"
```

---

### Task 2: Canonical release directory and evidence

**Files:**

- Create: `tools/signer-release/prepare.mjs`
- Create: `tools/signer-release/test/prepare.test.mjs`
- Modify: `tools/signer-release/manifest.mjs`

**Interfaces:**

- Consumes: `signerArtifactNames(version)` and `buildSignerManifest(...)`.
- Produces: `prepareSignerRelease({ version, sourceRepository, sourceSha, bundleDir, outputDir, pubDate }): Promise<PreparedSignerRelease>`.
- Produces: `verifyPreparedSignerRelease({ directory, version }): Promise<PreparedSignerRelease>`.
- `PreparedSignerRelease` contains exact paths and SHA-256 values for installer, signature, `latest.json`, `SHA256SUMS`, and `release-evidence.json`.

- [ ] **Step 1: Add a test that prepares a fixture bundle and verifies the complete asset set and source evidence.**

```js
test("prepares one self-verifying release directory", async () => {
  const prepared = await prepareSignerRelease({
    version: "0.1.5",
    sourceRepository: "thevladbog/markiro",
    sourceSha: "a".repeat(40),
    bundleDir,
    outputDir,
    pubDate: "2026-09-01T12:00:00.000Z",
  });
  assert.deepEqual((await readdir(outputDir)).sort(), [
    "SHA256SUMS",
    "latest.json",
    "markiro-signer-0.1.5-windows-x86_64-setup.exe",
    "markiro-signer-0.1.5-windows-x86_64-setup.exe.sig",
    "release-evidence.json",
  ]);
  assert.equal(prepared.evidence.source.sha, "a".repeat(40));
  await verifyPreparedSignerRelease({ directory: outputDir, version: "0.1.5" });
});
```

- [ ] **Step 2: Run the focused test and confirm `prepare.mjs` is missing.**

Run: `node --test tools/signer-release/test/prepare.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement deterministic naming, updater-manifest generation, sorted checksums, evidence, and exact verification.**

```js
const evidence = {
  schemaVersion: 1,
  product: "signer",
  channel: "stable",
  version,
  source: { repository: sourceRepository, sha: sourceSha },
  assets: Object.fromEntries(assetHashes),
};
await writeFile(join(outputDir, "release-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
await writeFile(
  join(outputDir, "SHA256SUMS"),
  `${assetHashes.map(([name, hash]) => `${hash}  ${name}`).sort().join("\n")}\n`,
);
```

`verifyPreparedSignerRelease` must reject an extra file, missing file, wrong version, wrong source SHA shape, checksum mismatch, updater URL mismatch, or signature mismatch.

- [ ] **Step 4: Run prepare, manifest, and version tests.**

Run: `node --test tools/signer-release/test/prepare.test.mjs tools/signer-release/test/manifest.test.mjs tools/signer-release/test/version.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the canonical release-directory unit.**

```bash
git add tools/signer-release/prepare.mjs tools/signer-release/manifest.mjs tools/signer-release/test/prepare.test.mjs
git commit -m "feat(signer-release): prepare recoverable release assets"
```

---

### Task 3: Publish prepared bytes and support idempotent repair

**Files:**

- Modify: `tools/signer-release/publish.mjs`
- Modify: `tools/signer-release/object-storage.mjs`
- Modify: `tools/signer-release/test/publish.test.mjs`
- Modify: `tools/signer-release/test/object-storage.test.mjs`

**Interfaces:**

- Consumes: `verifyPreparedSignerRelease({ directory, version })`.
- Produces: `publishPreparedSignerRelease({ version, releaseDir, store, fetchImpl }): Promise<{ manifestUrl; installerUrl; downloadUrl }>`.
- Produces: `store.head(key)` and `store.putImmutable(key, body, contentType, sha256)`; existing immutable keys must match or fail.

- [ ] **Step 1: Change publish tests to use a prepared directory and assert immutable-before-alias-before-manifest ordering.**

```js
assert.deepEqual(operations.map((entry) => entry.kind), [
  "put-immutable",
  "put-immutable",
  "verify",
  "verify",
  "copy-download",
  "verify",
  "put-manifest",
  "verify",
]);
```

Add a repair test where immutable objects already exist with matching hashes and no write occurs, plus a mismatch test that fails before either mutable pointer changes.

- [ ] **Step 2: Run focused tests and confirm the old local-bundle API fails the new expectations.**

Run: `node --test tools/signer-release/test/publish.test.mjs tools/signer-release/test/object-storage.test.mjs`

Expected: FAIL on the changed interface and missing immutable checks.

- [ ] **Step 3: Refactor publication to verify the prepared directory first and make immutable puts compare-before-write.**

```js
const existing = await store.head(key);
if (existing) {
  if (existing.sha256 !== expectedSha256) {
    throw new Error(`immutable signer object differs: ${key}`);
  }
  return;
}
await store.putImmutable(key, bytes, contentType, expectedSha256);
```

The CLI becomes `node tools/signer-release/publish.mjs <version> <prepared-release-dir>` and prints the same three URLs consumed by the workflow.

- [ ] **Step 4: Run all signer release tooling tests.**

Run: `node --test tools/signer-release/test/*.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit exact-byte publication and recovery support.**

```bash
git add tools/signer-release/publish.mjs tools/signer-release/object-storage.mjs tools/signer-release/test/publish.test.mjs tools/signer-release/test/object-storage.test.mjs
git commit -m "feat(signer-release): publish immutable prepared assets"
```

---

### Task 4: Cross-repository publish and repair workflow

**Files:**

- Modify: `.github/workflows/signer-stable-release.yml`
- Modify: `tools/signer-release/test/workflow.test.mjs`
- Modify: `tools/signer-release/test/repair-workflow.test.mjs`

**Interfaces:**

- Consumes: version reconciliation, preparation, verification, and publication CLIs from Tasks 1–3.
- Produces: owner-dispatched `publish` and `repair` paths.

- [ ] **Step 1: Replace workflow-shape expectations with the approved contract.**

```js
assert.match(workflow, /mode:/);
assert.match(workflow, /options: \[publish, repair\]/);
assert.match(workflow, /options: \[patch, minor, major\]/);
assert.match(workflow, /STATION_RELEASE_REPOSITORY: thevladbog\/markiro-station-releases/);
assert.match(workflow, /secrets\.STATION_RELEASE_REPOSITORY_TOKEN/);
assert.match(workflow, /gh release create[^\n]*--draft[^\n]*--repo/);
assert.match(workflow, /\$RUNNER_TEMP\/signer-version-overlay\.json/);
assert.doesNotMatch(workflow, /git (commit|push)/);
```

Assert ordering: draft creation and asset upload precede Yandex publication; Yandex verification and pointer advancement precede `gh release edit --draft=false`.

- [ ] **Step 2: Run workflow tests and confirm they fail against the source-repository workflow.**

Run: `node --test tools/signer-release/test/workflow.test.mjs tools/signer-release/test/repair-workflow.test.mjs`

Expected: FAIL on inputs, repository, token, overlay, draft, and repair assertions.

- [ ] **Step 3: Implement dispatch validation and channel reconciliation.**

The workflow must:

```bash
test "$MODE" = "publish" -o "$MODE" = "repair"
if [ "$MODE" = "repair" ]; then
  test "$BUMP" = "patch"
fi
gh release list --repo "$SIGNER_RELEASE_REPOSITORY" --limit 200 --json tagName,isDraft
curl --fail --silent --show-error --max-redirs 0 --connect-timeout 15 \
  https://releases.markiro.app/signer/stable/latest.json
```

Pass the fetched values to the pure Node reconciliation helper. First-ever distribution publication treats the existing Yandex `0.1.4` as the agreed baseline and calculates `0.1.5`; it must not attempt to recreate historical GitHub releases.

- [ ] **Step 4: Generate and apply the temporary Tauri version overlay before verification and build.**

```bash
overlay="$RUNNER_TEMP/signer-version-overlay.json"
node --input-type=module - "$RELEASE_VERSION" "$overlay" <<'NODE'
import { writeFile } from "node:fs/promises";
import { buildTauriVersionOverlay } from "./tools/signer-release/version.mjs";
await writeFile(process.argv[3], `${JSON.stringify(buildTauriVersionOverlay(process.argv[2]))}\n`);
NODE
pnpm --filter @markiro/signer tauri build \
  --config src-tauri/tauri.stable.conf.json \
  --config "$overlay"
```

Tauri CLI merges repeated `--config` options in order, so the stable endpoint overlay is applied first and the one-key version overlay second. Keep both repository configs unchanged.

- [ ] **Step 5: Implement draft publication and repair.**

`publish` prepares assets, creates `signer-v<version>` as a draft in the distribution repository, and uploads all five files. `repair` locates the single newest matching draft, downloads those five files, calls `verifyPreparedSignerRelease`, and runs the same Yandex publication. Both paths publish the GitHub draft only after Yandex verification succeeds.

- [ ] **Step 6: Run the complete release contract and YAML syntax check.**

Run: `node --test tools/signer-release/test/*.test.mjs`

Expected: PASS.

Run: `pnpm exec prettier --check .github/workflows/signer-stable-release.yml tools/signer-release docs/runbooks/signer-release.md`

Expected: PASS.

- [ ] **Step 7: Commit the workflow migration.**

```bash
git add .github/workflows/signer-stable-release.yml tools/signer-release/test/workflow.test.mjs tools/signer-release/test/repair-workflow.test.mjs
git commit -m "ci(signer): publish stable releases to distribution repo"
```

---

### Task 5: Runbook, contract cleanup, and final verification

**Files:**

- Modify: `docs/runbooks/signer-release.md`
- Modify: `docs/superpowers/specs/2026-08-30-signer-stable-release-design.md`
- Modify: `docs/superpowers/plans/2026-08-30-signer-stable-release.md`

**Interfaces:**

- Consumes: the final workflow contract.
- Produces: an operator procedure that names the new repository, bump input, repair decision, evidence, and privacy boundary.

- [ ] **Step 1: Update the runbook with publish and repair procedures.**

Document these exact decisions:

```text
GitHub distribution repository: thevladbog/markiro-station-releases
Public updater manifest: https://releases.markiro.app/signer/stable/latest.json
Public installer: https://releases.markiro.app/signer/download
Publish inputs: mode=publish, bump=patch|minor|major
Repair input: mode=repair; no rebuild and no new semantic version
```

State that repository privacy does not affect installed clients because they use Yandex.

- [ ] **Step 2: Mark superseded statements in the implemented 2026-08-30 design and plan.**

Replace claims that the source config is the release ledger and that GitHub publication targets `thevladbog/markiro` with a dated extension note pointing to the new spec. Do not rewrite historical implementation steps as though they never existed.

- [ ] **Step 3: Run final checks.**

Run: `node --test tools/signer-release/test/*.test.mjs`

Expected: PASS.

Run: `git diff --check`

Expected: PASS.

Run: `pnpm format:check`

Expected: PASS, or report the pre-existing package-manager/lockfile blocker with the exact command and no claim that formatting ran.

- [ ] **Step 4: Commit documentation and final contract cleanup.**

```bash
git add docs/runbooks/signer-release.md docs/superpowers/specs/2026-08-30-signer-stable-release-design.md docs/superpowers/plans/2026-08-30-signer-stable-release.md
git commit -m "docs(signer): document workflow-owned stable releases"
```
