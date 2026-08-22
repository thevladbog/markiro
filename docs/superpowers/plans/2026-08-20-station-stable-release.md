# Markiro Station Stable Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a protected manual workflow that rebuilds one explicitly accepted Station beta as the corresponding immutable Windows stable release, publishes a separate stable updater channel, and generates a verified Russian stable-to-stable changelog.

**Architecture:** Keep beta and stable orchestration separate while extending the existing release modules with channel-aware version, artifact, provenance, and changelog primitives. The stable workflow verifies the selected beta release and its exact `baseSha`, builds that source with a committed stable Tauri overlay, publishes the immutable stable release first, and promotes `station-stable-channel/latest.json` last.

**Tech Stack:** GitHub Actions, Node.js 24 ESM scripts and `node:test`, pnpm 11, Tauri 2, Rust/Cargo, Windows x64 NSIS, GitHub Releases, SHA-256, Tauri updater signatures, Markdown runbooks.

**Spec:** `docs/superpowers/specs/2026-08-20-station-stable-release-design.md`

## Global Constraints

- Stable source is always an explicitly selected canonical beta tag; never infer the latest beta and never add newer `main` changes.
- Derive stable by removing `-beta.N`; reject duplicate, equal, older, malformed, or non-monotonic stable versions.
- Beta clients remain on `station-beta-channel`; stable clients embed only `station-stable-channel`.
- Use GitHub Environment `station-stable` without required reviewers and reuse the existing Tauri signing keypair through environment secrets.
- Keep update discovery and installation manual-only: no automatic download, install, restart, forced update, or active-shift installation.
- Publish immutable versioned stable assets before mutating the stable channel pointer; never overwrite a versioned tag, release, asset, or evidence file.
- Stable NSIS remains without Authenticode in this slice; release notes and runbooks must state the unknown-publisher/SmartScreen boundary.
- Human-facing changelog copy is Russian; evidence keys, versions, SHAs, hashes, and URLs remain language-neutral.
- Preserve pairing, Station SQLite, scanner/printer settings, journals, boxes, exceptions, and outbox across beta-to-stable installation and rollback.
- Never log or persist private signing material, API keys, pairing codes, raw badge/PIN values, or unbounded workflow input.
- Automated checks do not prove Windows, WebView2, SmartScreen, scanner, printer, or physical-line acceptance.

## File and responsibility map

| File                                            | Responsibility                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `tools/station-release/version.mjs`             | Canonical beta/stable parsing, SemVer ordering, promotion derivation, and source-version writes    |
| `tools/station-release/promotion.mjs`           | Pure validation of selected beta metadata/evidence/tree and stable promotion output                |
| `tools/station-release/artifacts.mjs`           | Channel-aware manifests, canonical asset trees, hashes, notes, and beta/stable evidence validation |
| `tools/station-release/changelog.mjs`           | Bounded Russian highlights and deterministic Station-scoped generated changelog                    |
| `apps/station/src-tauri/tauri.stable.conf.json` | Reviewed stable updater endpoint overlay                                                           |
| `.github/workflows/station-stable-release.yml`  | Stable-only manual orchestration, publication transaction, and channel recovery                    |
| `tools/station-release/test/*.test.mjs`         | Pure release, workflow, documentation, and adversarial contract tests                              |
| `docs/runbooks/station-stable-release.md`       | Operator setup, publish/retry, unsigned install, and rollback procedure                            |
| `docs/acceptance/station-stable-release.md`     | Honest beta-to-stable and stable-to-stable acceptance record                                       |

---

### Task 1: Canonical stable version and promotion model

**Files:**

- Modify: `tools/station-release/version.mjs`
- Modify: `tools/station-release/test/version.test.mjs`

**Interfaces:**

- Consumes: existing `parseStationBetaTag(tags)`, `nextStationBetaVersion(tags, bump)`, `readStationSourceVersion(root)`, and `writeStationSourceVersion(root, version)` behavior.
- Produces:

```ts
parseStationStableTag(tag: unknown): null | {
  major: number;
  minor: number;
  patch: number;
  text: string;
};

stablePromotionFromBeta(
  tags: string[],
  sourceBetaTag: string,
): {
  sourceBetaTag: string;
  betaVersion: string;
  version: string;
  tag: string;
  previousStableTag: string | null;
};

writeStationSourceVersion(root: URL, version: string): Promise<void>;
```

- `writeStationSourceVersion` accepts canonical beta or stable Station versions and still rejects unrelated SemVer forms.
- CLI addition: `node tools/station-release/version.mjs set-stable <version> <output-path>` writes exactly `version=<version>` and `tag=station-v<version>` after atomically setting the Tauri and Cargo versions.

- [ ] **Step 1: Add failing canonical stable and promotion tests**

Append focused cases that retain all current beta assertions:

```js
import { parseStationStableTag, stablePromotionFromBeta } from "../version.mjs";

test("accepts only canonical station stable tags", () => {
  assert.equal(parseStationStableTag("station-v0.1.0")?.text, "0.1.0");
  for (const tag of [
    "station-v0.1.0-beta.19",
    "station-v01.1.0",
    "station-v0.1",
    "station-v0.1.0+build",
    "v0.1.0",
  ])
    assert.equal(parseStationStableTag(tag), null, tag);
});

test("derives one monotonic stable version from an accepted beta", () => {
  assert.deepEqual(
    stablePromotionFromBeta(
      ["station-v0.1.0-beta.19", "station-v0.1.0-beta.18"],
      "station-v0.1.0-beta.19",
    ),
    {
      sourceBetaTag: "station-v0.1.0-beta.19",
      betaVersion: "0.1.0-beta.19",
      version: "0.1.0",
      tag: "station-v0.1.0",
      previousStableTag: null,
    },
  );
  assert.equal(
    stablePromotionFromBeta(["station-v0.1.0", "station-v0.1.1-beta.4"], "station-v0.1.1-beta.4")
      .previousStableTag,
    "station-v0.1.0",
  );
});

test("rejects duplicate, downgrade and malformed stable promotions", () => {
  assert.throws(
    () => stablePromotionFromBeta(["station-v0.1.0"], "station-v0.1.0-beta.19"),
    /invalid station stable promotion/,
  );
  assert.throws(
    () =>
      stablePromotionFromBeta(["station-v0.2.0", "station-v0.1.1-beta.4"], "station-v0.1.1-beta.4"),
    /invalid station stable promotion/,
  );
});
```

- [ ] **Step 2: Run the version test and record RED**

Run:

```bash
node --test tools/station-release/test/version.test.mjs
```

Expected: FAIL because `parseStationStableTag` and `stablePromotionFromBeta` are not exported and stable source writes are rejected.

- [ ] **Step 3: Implement shared safe SemVer parsing and comparison**

Add a stable grammar alongside the existing beta grammar and reuse safe integer validation:

```js
const STATION_STABLE_TAG = /^station-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STATION_STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStationStableTag(tag) {
  if (typeof tag !== "string") return null;
  const match = STATION_STABLE_TAG.exec(tag);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, text: `${major}.${minor}.${patch}` };
}
```

Implement `stablePromotionFromBeta` by parsing the exact source tag, deriving `major.minor.patch`, sorting only canonical stable tags numerically, rejecting an existing target and any target not newer than the highest stable, and returning the exact interface above. Do not compare tag strings lexicographically.

- [ ] **Step 4: Extend atomic source writes and the CLI**

Permit `readStationSourceVersion` and `writeStationSourceVersion` to accept canonical beta or stable versions. Add the closed `set-stable` command and keep `prepare` beta-only. Reserve the output file with `open(..., "wx")`, remove it on failure, and never accept the output path from release metadata.

- [ ] **Step 5: Run focused and complete release version tests**

Run:

```bash
node --test tools/station-release/test/version.test.mjs
pnpm test:station-release:contract
```

Expected: all tests PASS; existing beta transitions remain unchanged.

- [ ] **Step 6: Commit the version model**

```bash
git add tools/station-release/version.mjs tools/station-release/test/version.test.mjs
git commit -m "feat(station): model stable release versions"
```

---

### Task 2: Stable source overlay and accepted-beta provenance

**Files:**

- Create: `apps/station/src-tauri/tauri.stable.conf.json`
- Create: `tools/station-release/promotion.mjs`
- Create: `tools/station-release/test/promotion.test.mjs`
- Create: `tools/station-release/test/channel-config.test.mjs`

**Interfaces:**

- Consumes: `parseStationBetaTag`, `stablePromotionFromBeta`, and canonical evidence fields from the beta artifact validator.
- Produces:

```ts
const STABLE_CHANNEL_URL: "https://github.com/thevladbog/markiro/releases/download/station-stable-channel/latest.json";

validateAcceptedBeta(input: {
  sourceBetaTag: string;
  release: {
    tagName: string;
    isDraft: boolean;
    isPrerelease: boolean;
    targetCommitish: string;
  };
  evidence: {
    version: string;
    baseSha: string;
    releaseSha: string;
    publishedAt: string;
    assets: Record<string, string>;
  };
  diffPaths: string[];
}): {
  sourceBetaTag: string;
  betaVersion: string;
  baseSha: string;
  betaReleaseSha: string;
};
```

- CLI: `node tools/station-release/promotion.mjs validate-beta <release-json> <evidence-json> <diff-paths-file> <output-path>` writes only validated `source_beta_tag`, `beta_version`, `base_sha`, and `beta_release_sha` lines.

- [ ] **Step 1: Write failing provenance and channel tests**

Use fixed 40-character SHAs and assert exact denial:

```js
test("accepts one published canonical beta with a version-only release tree", () => {
  assert.deepEqual(
    validateAcceptedBeta({
      sourceBetaTag: "station-v0.1.0-beta.19",
      release: {
        tagName: "station-v0.1.0-beta.19",
        isDraft: false,
        isPrerelease: true,
        targetCommitish: "b".repeat(40),
      },
      evidence: {
        version: "0.1.0-beta.19",
        baseSha: "a".repeat(40),
        releaseSha: "b".repeat(40),
        publishedAt: "2026-08-20T10:00:00.000Z",
        assets: {},
      },
      diffPaths: ["apps/station/src-tauri/Cargo.toml", "apps/station/src-tauri/tauri.conf.json"],
    }).baseSha,
    "a".repeat(40),
  );
});

test("rejects draft, non-prerelease, SHA mismatch and extra beta tree changes", () => {
  for (const mutate of [
    (input) => ({ ...input, release: { ...input.release, isDraft: true } }),
    (input) => ({ ...input, release: { ...input.release, isPrerelease: false } }),
    (input) => ({ ...input, evidence: { ...input.evidence, releaseSha: "c".repeat(40) } }),
    (input) => ({ ...input, diffPaths: [...input.diffPaths, "apps/station/src/App.tsx"] }),
  ])
    assert.throws(() => validateAcceptedBeta(mutate(validInput)), /invalid accepted station beta/);
});
```

In `channel-config.test.mjs`, parse the base and overlay JSON and assert the base endpoint is exactly beta, the overlay endpoint is exactly stable, the public keys match after config merge, and neither file contains both endpoints.

- [ ] **Step 2: Run the new tests and record RED**

Run:

```bash
node --test tools/station-release/test/promotion.test.mjs tools/station-release/test/channel-config.test.mjs
```

Expected: FAIL because the module and stable overlay do not exist.

- [ ] **Step 3: Add the fixed stable Tauri overlay**

Create:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/thevladbog/markiro/releases/download/station-stable-channel/latest.json"
      ]
    }
  }
}
```

Do not duplicate or override the updater public key. The base config continues to own the key and beta endpoint; Tauri's config merge replaces only the endpoint for a stable build.

- [ ] **Step 4: Implement pure accepted-beta validation and bounded CLI output**

Validate exact object keys, canonical tag/version equality, release flags, 40-character lowercase SHAs, `release.targetCommitish === evidence.releaseSha`, and exact sorted diff paths:

```js
const ALLOWED_BETA_RELEASE_DIFF = [
  "apps/station/src-tauri/Cargo.toml",
  "apps/station/src-tauri/tauri.conf.json",
];
```

Reject symlinked input files, files over 256 KiB, duplicate output fields, future dates, and pre-existing output paths. Error messages stay fixed and contain no input values.

- [ ] **Step 5: Run promotion, channel, beta artifact, and source-version tests**

Run:

```bash
node --test \
  tools/station-release/test/promotion.test.mjs \
  tools/station-release/test/channel-config.test.mjs \
  tools/station-release/test/artifacts.test.mjs \
  tools/station-release/test/version.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 6: Commit provenance and stable config**

```bash
git add \
  apps/station/src-tauri/tauri.stable.conf.json \
  tools/station-release/promotion.mjs \
  tools/station-release/test/promotion.test.mjs \
  tools/station-release/test/channel-config.test.mjs
git commit -m "feat(station): validate stable promotion source"
```

---

### Task 3: Channel-aware artifacts and stable evidence

**Files:**

- Modify: `tools/station-release/artifacts.mjs`
- Modify: `tools/station-release/test/artifacts.test.mjs`

**Interfaces:**

- Consumes: canonical beta/stable version parsers from Task 1 and validated beta provenance from Task 2.
- Produces:

```ts
type StationReleaseChannel = "beta" | "stable";

createStationUpdateManifest(input: {
  channel: StationReleaseChannel;
  version: string;
  pubDate: string;
  bundleUrl: string;
  signature: string;
}): TauriUpdateManifest;

stageStationRelease(input: {
  channel: StationReleaseChannel;
  inputDirectory: string;
  outputDirectory: string;
  version: string;
  pubDate: string;
  baseSha: string;
  releaseSha: string;
  notesPath?: string;
  stableProvenance?: {
    sourceBetaTag: string;
    betaVersion: string;
    betaReleaseSha: string;
    betaEvidenceSha256: string;
    acceptanceConfirmed: true;
    previousStableTag: string | null;
    previousStableBaseSha: string | null;
    changelogFromSha: string;
    changelogToSha: string;
  };
}): Promise<StationReleaseEvidence>;

validateStationReleaseDirectory(
  directory: string,
  expected: { channel: StationReleaseChannel; version: string },
): Promise<ValidatedStationRelease>;
```

- Preserve `createBetaUpdateManifest` and `parseBetaUpdateManifest` as compatibility wrappers until the beta workflow and its tests migrate to the generic functions.

- [ ] **Step 1: Add failing stable manifest and evidence tests**

Add a stable fixture and assert exact URL/version/evidence behavior:

```js
const stableVersion = "0.1.0";
const stableNames = stationAssetNames(stableVersion);
const stableBundleUrl =
  `https://github.com/thevladbog/markiro/releases/download/` +
  `station-v${stableVersion}/${stableNames.bundle}`;

test("stages and validates stable artifacts with beta provenance", async () => {
  const evidence = await stageStationRelease({
    channel: "stable",
    inputDirectory: input,
    outputDirectory: output,
    version: stableVersion,
    pubDate: "2026-08-20T10:00:00.000Z",
    baseSha: "a".repeat(40),
    releaseSha: "c".repeat(40),
    notesPath,
    stableProvenance: {
      sourceBetaTag: "station-v0.1.0-beta.19",
      betaVersion: "0.1.0-beta.19",
      betaReleaseSha: "b".repeat(40),
      betaEvidenceSha256: "d".repeat(64),
      acceptanceConfirmed: true,
      previousStableTag: null,
      previousStableBaseSha: null,
      changelogFromSha: "e".repeat(40),
      changelogToSha: "a".repeat(40),
    },
  });
  assert.equal(evidence.channel, "stable");
  assert.equal(evidence.sourceBetaTag, "station-v0.1.0-beta.19");
  await validateStationReleaseDirectory(output, {
    channel: "stable",
    version: stableVersion,
  });
});
```

Add adversarial mutations for beta version passed as stable, stable version passed as beta, wrong immutable URL, missing/false acceptance, beta evidence digest mismatch shape, unknown evidence keys, notes hash mismatch, extra asset, and checksum text that does not match file bytes.

- [ ] **Step 2: Run artifact tests and record RED**

Run:

```bash
node --test tools/station-release/test/artifacts.test.mjs
```

Expected: FAIL because stable versions and provenance are not accepted.

- [ ] **Step 3: Generalize canonical version and manifest validation**

Replace the beta-only `ensureVersion` boundary with `ensureChannelVersion(channel, version)`. Keep the immutable bundle URL format fixed to `station-v<version>` and require the version grammar associated with the channel.

Keep the one-platform Tauri shape exact:

```js
{
  version,
  pub_date: pubDate,
  platforms: {
    "windows-x86_64": { url: bundleUrl, signature },
  },
}
```

- [ ] **Step 4: Add a versioned stable evidence schema without weakening beta v1**

Keep current beta evidence readable exactly as published. Emit stable evidence with `schemaVersion: 2`, `channel: "stable"`, the fixed provenance fields above, and the existing asset hash map. Validate exact key sets for each schema instead of optional loose fields. Hash copied notes and include the notes hash in stable evidence; do not add notes to `SHA256SUMS`, whose canonical binary/manifest set remains unchanged.

- [ ] **Step 5: Extend the CLI with closed channel arguments**

Use these exact forms:

```text
node tools/station-release/artifacts.mjs stage beta <input> <output> <version> <pubDate> <baseSha> <releaseSha>
node tools/station-release/artifacts.mjs stage-stable <input> <output> <version> <pubDate> <baseSha> <releaseSha> <notesPath> <provenanceJsonPath>
node tools/station-release/artifacts.mjs validate beta <directory> <version>
node tools/station-release/artifacts.mjs validate stable <directory> <version>
```

Update the beta workflow in Task 5 only after tests prove the compatibility wrapper and new CLI preserve its output.

- [ ] **Step 6: Run artifact and full release contracts**

Run:

```bash
node --test tools/station-release/test/artifacts.test.mjs
pnpm test:station-release:contract
```

Expected: all tests PASS, including unchanged beta fixtures.

- [ ] **Step 7: Commit channel-aware artifacts**

```bash
git add tools/station-release/artifacts.mjs tools/station-release/test/artifacts.test.mjs
git commit -m "feat(station): validate stable release artifacts"
```

---

### Task 4: Russian hybrid stable changelog

**Files:**

- Create: `tools/station-release/changelog.mjs`
- Create: `tools/station-release/test/changelog.test.mjs`

**Interfaces:**

- Consumes: verified previous/selected base SHAs and a repository-local Git history.
- Produces:

```ts
type ChangelogEntry = {
  sha: string;
  subject: string;
  body: string;
  files: string[];
};

stationChangeTouchesScope(files: string[]): boolean;

buildStableChangelog(input: {
  version: string;
  sourceBetaTag: string;
  previousStableTag: string | null;
  fromSha: string;
  toSha: string;
  compareUrl: string;
  highlights: string;
  entries: ChangelogEntry[];
}): string;
```

- CLI: `node tools/station-release/changelog.mjs generate <metadata-json> <highlights-file> <output-file>` reads fixed SHAs from metadata, collects first-parent Git history and changed paths without a shell, and writes bounded UTF-8 Markdown with mode `0600`.

- [ ] **Step 1: Write failing changelog tests**

Cover grouping, scope, de-duplication, first stable, and empty highlights:

```js
test("renders optional highlights and deterministic Russian sections", () => {
  const notes = buildStableChangelog({
    version: "0.1.1",
    sourceBetaTag: "station-v0.1.1-beta.4",
    previousStableTag: "station-v0.1.0",
    fromSha: "a".repeat(40),
    toSha: "b".repeat(40),
    compareUrl: `https://github.com/thevladbog/markiro/compare/${"a".repeat(40)}...${"b".repeat(40)}`,
    highlights: "Ускорена работа со сканером.",
    entries: [
      {
        sha: "c".repeat(40),
        subject: "feat(station): add scan queue",
        body: "",
        files: ["apps/station/src/App.tsx"],
      },
      {
        sha: "d".repeat(40),
        subject: "fix(station): recover printing",
        body: "",
        files: ["apps/station/src/pages/WorkScreen.tsx"],
      },
      {
        sha: "e".repeat(40),
        subject: "chore(station): prepare 0.1.1-beta.4",
        body: "",
        files: ["apps/station/src-tauri/Cargo.toml"],
      },
    ],
  });
  assert.match(notes, /## Главное в релизе/);
  assert.match(notes, /## Что нового/);
  assert.match(notes, /## Исправления/);
  assert.doesNotMatch(notes, /prepare 0\.1\.1-beta/);
});

test("omits highlights heading when input is empty", () => {
  assert.doesNotMatch(buildStableChangelog({ ...valid, highlights: "" }), /Главное в релизе/);
});
```

Add rejection cases for more than 8 KiB, NUL/C0 controls other than newline/tab, secret-like patterns, invalid SHA, non-Markiro compare URL, duplicate commits, and entry files outside Station scope.

- [ ] **Step 2: Run changelog tests and record RED**

Run:

```bash
node --test tools/station-release/test/changelog.test.mjs
```

Expected: FAIL because `changelog.mjs` does not exist.

- [ ] **Step 3: Implement explicit Station change scope**

Include a commit only when its changed files intersect one of these reviewed boundaries:

```js
const DIRECT_STATION_PATHS = [
  "apps/station/",
  "tools/station-release/",
  ".github/workflows/station-",
  "docs/runbooks/station-",
  "docs/acceptance/station-",
  "packages/db/src/sqlite/",
];
```

Server/shared-only commits are excluded unless the same commit also touches a direct Station path or Station test. The compare URL exposes the full repository range for audit.

- [ ] **Step 4: Implement deterministic parsing and Russian rendering**

Normalize merge commits to the first non-empty body line when the subject is `Merge pull request #N ...`; preserve squash-merge subjects; strip terminal `(#N)` only for de-duplication, not display. Classify `feat` as **Что нового**, `fix` as **Исправления**, and remaining meaningful entries as **Прочие изменения**. Sort by Git history order, emit each normalized entry once, and exclude `chore(station): prepare`, candidate, and release-only subjects.

- [ ] **Step 5: Implement bounded CLI collection without shell evaluation**

Use `execFile("git", [...])`, 1 MiB output bounds, fixed 40-character SHAs, and NUL-delimited records. Resolve changed files with `git diff-tree --no-commit-id --name-only -r <sha>`. Create output with `open(path, "wx", 0o600)` and delete it on failure.

- [ ] **Step 6: Run changelog and release contract tests**

Run:

```bash
node --test tools/station-release/test/changelog.test.mjs
pnpm test:station-release:contract
```

Expected: all tests PASS.

- [ ] **Step 7: Commit changelog generation**

```bash
git add tools/station-release/changelog.mjs tools/station-release/test/changelog.test.mjs
git commit -m "feat(station): generate stable release changelog"
```

---

### Task 5: Protected stable publication workflow

**Files:**

- Create: `.github/workflows/station-stable-release.yml`
- Create: `tools/station-release/test/stable-workflow.test.mjs`
- Modify: `.github/workflows/station-beta-release.yml`
- Modify: `tools/station-release/test/workflow.test.mjs`

**Interfaces:**

- Consumes: Task 1 version CLI, Task 2 promotion CLI and stable Tauri overlay, Task 3 artifact CLI, Task 4 changelog CLI, existing signing-key normalizer, and `pnpm verify:station-production-cors`.
- Produces: a manual `Publish station stable` workflow with `publish` and `promote-existing` modes and a channel-last immutable publication transaction.

- [ ] **Step 1: Write the failing stable workflow contract**

Parse the workflow with `js-yaml` and assert exact inputs and protection:

```js
assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
  "mode",
  "source_beta_tag",
  "acceptance_confirmed",
  "highlights",
]);
assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, [
  "publish",
  "promote-existing",
]);
assert.equal(workflow.concurrency.group, "station-stable-release");
assert.equal(workflow.jobs.release.environment, "station-stable");
assert.equal(workflow.jobs.release["runs-on"], "windows-latest");
assert.deepEqual(workflow.jobs.release.permissions, {
  actions: "read",
  contents: "write",
});
```

Add source assertions for exact `refs/heads/main`, selected beta release JSON download, full beta asset validation, `git merge-base --is-ancestor "$base_sha" origin/main`, CI query `--commit "$base_sha"`, stable overlay build, normalized signing key file write, normal immutable release without `--prerelease`, Pre-release service channel, publication-before-channel ordering, previous manifest backup/restore, byte-for-byte channel verification, cleanup, and no `force`, `continue-on-error`, `pull_request_target`, `self-hosted`, `id-token`, or secret echo.

- [ ] **Step 2: Run workflow contracts and record RED**

Run:

```bash
node --test \
  tools/station-release/test/stable-workflow.test.mjs \
  tools/station-release/test/workflow.test.mjs
```

Expected: FAIL because the stable workflow does not exist and beta still uses the old artifact CLI form.

- [ ] **Step 3: Add stable input and source-beta resolution steps**

Use closed expressions and temporary files:

```yaml
on:
  workflow_dispatch:
    inputs:
      mode:
        type: choice
        required: true
        default: publish
        options: [publish, promote-existing]
      source_beta_tag:
        type: string
        required: true
      acceptance_confirmed:
        type: boolean
        required: true
        default: false
      highlights:
        type: string
        required: false
        default: ""
```

The first shell step verifies `acceptance_confirmed == true`, validates the tag grammar before using it as a `gh` argument, writes highlights with `printf '%s'` to a bounded temporary file, and obtains release metadata with `gh release view ... --json tagName,isDraft,isPrerelease,targetCommitish`.

- [ ] **Step 4: Verify beta assets, provenance, `main`, and CI before checkout**

Download the exact beta release to a new directory; run `artifacts.mjs validate beta`; hash `release-evidence.json`; obtain exact version-only tree paths using `git diff --name-only "$base_sha" "$beta_release_sha"`; run `promotion.mjs validate-beta`; require the stable overlay/tooling files at `baseSha`; verify `baseSha` is an ancestor of `origin/main`; and reuse the bounded 90-attempt CI loop querying `--commit "$base_sha"`.

- [ ] **Step 5: Prepare a unique stable release commit from accepted `baseSha`**

Checkout `baseSha` detached, run `version.mjs set-stable`, and assert the only working-tree changes are the two version files or no changes when the base already has the target version. Configure release-bot identity and create the release commit with:

```bash
git add apps/station/src-tauri/Cargo.toml apps/station/src-tauri/tauri.conf.json
git commit --allow-empty -m "chore(station): prepare stable $version"
release_sha="$(git rev-parse HEAD)"
```

Verify the stable overlay endpoint and public-key inheritance before running any build.

- [ ] **Step 6: Build and verify stable from the exact release tree**

Run the same dependency, Station, release-contract, production CORS, and diff gates as beta. Build stable using the reviewed overlay:

```bash
pnpm --filter @markiro/station tauri build \
  --config src-tauri/tauri.stable.conf.json
```

Normalize the private key, write the validated `normalized_key` value to the mode-restricted temporary file, export its path, and remove it with an EXIT trap. Do not copy the original unnormalized environment value into the file.

- [ ] **Step 7: Generate changelog, stable evidence, and canonical assets**

Resolve the previous stable evidence when present. For the first stable, derive the earliest verified beta base in the same version line and the range specified by the design. Run `changelog.mjs generate`, build stable provenance JSON from already validated fixed fields, run `artifacts.mjs stage-stable`, then `artifacts.mjs validate stable`.

- [ ] **Step 8: Publish immutable stable release before the channel**

Push only an owned candidate ref using the job-scoped token header, create a draft release targeted to `release_sha`, upload all staged files, download into a new directory, validate again, and finalize without `--prerelease`:

```bash
gh release create "$tag" --draft --target "$release_sha" \
  --title "Markiro Station $version" \
  --notes-file "$RUNNER_TEMP/station-staged/release-notes.md"
gh release upload "$tag" "$RUNNER_TEMP/station-staged"/*
gh release download "$tag" --dir "$RUNNER_TEMP/station-downloaded"
node tools/station-release/artifacts.mjs validate stable \
  "$RUNNER_TEMP/station-downloaded" "$version"
gh release edit "$tag" --draft=false
```

Every `gh` call includes `--repo "$GITHUB_REPOSITORY"`; the abbreviated block above omits repetition only for readability in this plan.

- [ ] **Step 9: Implement `promote-existing` and stable channel recovery**

Derive the target from `source_beta_tag`, download and validate the existing normal stable release and its exact beta provenance, reject a downgrade when a newer stable exists, then upload only verified `latest.json` to `station-stable-channel`. Create the service release with `--prerelease`; back up an existing channel manifest; restore it after upload/download/compare failure; never mutate the immutable stable release.

- [ ] **Step 10: Migrate beta to the explicit channel-aware artifact CLI**

Change only these beta commands:

```text
artifacts.mjs stage beta ...
artifacts.mjs validate beta ...
```

Do not change beta inputs, version calculation, endpoint, environment, release flags, or channel. Update beta workflow assertions to prove behavior remains the same.

- [ ] **Step 11: Run focused workflow and full release contracts**

Run:

```bash
node --test \
  tools/station-release/test/stable-workflow.test.mjs \
  tools/station-release/test/workflow.test.mjs \
  tools/station-release/test/promotion.test.mjs \
  tools/station-release/test/artifacts.test.mjs \
  tools/station-release/test/changelog.test.mjs
pnpm test:station-release:contract
```

Expected: all tests PASS with beta and stable workflows covered independently.

- [ ] **Step 12: Commit workflow orchestration**

```bash
git add \
  .github/workflows/station-stable-release.yml \
  .github/workflows/station-beta-release.yml \
  tools/station-release/test/stable-workflow.test.mjs \
  tools/station-release/test/workflow.test.mjs
git commit -m "feat(station): publish protected stable releases"
```

---

### Task 6: Stable runbook and acceptance contracts

**Files:**

- Create: `docs/runbooks/station-stable-release.md`
- Create: `docs/acceptance/station-stable-release.md`
- Modify: `docs/runbooks/station-beta-release.md`
- Modify: `docs/hardware-acceptance-checklist.md`
- Modify: `apps/station/README.md`
- Modify: `tools/station-release/test/docs.test.mjs`

**Interfaces:**

- Consumes: exact stable workflow names, inputs, environment, channel URL, unsigned-installer boundary, and recovery behavior from Task 5.
- Produces: an operator-complete release procedure and an honest evidence record that keeps external checks distinct from automated gates.

- [ ] **Step 1: Add failing documentation contract assertions**

Extend `docs.test.mjs` to require the new files and exact operational terms:

```js
assert.match(stableRunbook, /station-stable/);
assert.match(stableRunbook, /source_beta_tag/);
assert.match(stableRunbook, /acceptance_confirmed/);
assert.match(stableRunbook, /promote-existing/);
assert.match(stableRunbook, /station-stable-channel/);
assert.match(stableRunbook, /SmartScreen|неизвестн.*издател/i);
assert.match(stableRunbook, /beta.*stable/i);
assert.match(stableAcceptance, /NOT RUN/);
assert.match(stableAcceptance, /stable.*stable/i);
assert.match(readme, /Manual stable updates/);
assert.match(checklist, /Station stable/);
```

- [ ] **Step 2: Run docs tests and record RED**

Run:

```bash
node --test tools/station-release/test/docs.test.mjs
```

Expected: FAIL because stable runbook and acceptance files do not exist.

- [ ] **Step 3: Write the stable release runbook**

Document, in order:

1. Create GitHub Environment `station-stable` without required reviewers.
2. Copy the existing Tauri key and password into the two established secret names without printing them.
3. Merge the stable tooling and publish a new beta from that baseline; older betas are not promotable.
4. Complete or explicitly accept the beta Windows/hardware checklist.
5. Choose exact `source_beta_tag`, set `acceptance_confirmed=true`, optionally provide Russian highlights, and use `mode=publish`.
6. Verify ordinary stable release flags, assets, `SHA256SUMS`, signature, evidence, source beta, compare link, and mutable channel.
7. Install stable manually over beta only outside an active shift and verify retained state.
8. Use `promote-existing` only for a published-but-unpromoted immutable release.
9. Roll back with a retained immutable installer only inside the documented schema window.
10. Treat Authenticode/SmartScreen and physical hardware as external acceptance.

- [ ] **Step 4: Create the stable acceptance record with unchecked evidence**

Include fields for beta tag/hash/evidence, stable tag/hash/evidence, Windows version, target hardware, unknown-publisher path, beta-to-stable retained state, scanner, printer, fullscreen, offline/reconnect, pending outbox, stable-to-stable manual update, active-shift denial, restart, rollback, and final `PASS`/`FAIL`/`NOT RUN`. Initialize all physical items as `NOT RUN`; do not manufacture acceptance.

- [ ] **Step 5: Update existing operator documentation narrowly**

Link beta runbook to stable promotion without duplicating instructions. Add manual stable channel/update/rollback text to Station README. Add beta-to-stable and stable-to-stable rows to the hardware checklist. Keep beta installation and beta acceptance wording intact.

- [ ] **Step 6: Run docs contracts and formatting**

Run:

```bash
node --test tools/station-release/test/docs.test.mjs
pnpm exec prettier --check \
  docs/runbooks/station-stable-release.md \
  docs/acceptance/station-stable-release.md \
  docs/runbooks/station-beta-release.md \
  docs/hardware-acceptance-checklist.md \
  apps/station/README.md \
  tools/station-release/test/docs.test.mjs
git diff --check
```

Expected: docs tests and formatting PASS; physical checks remain explicitly `NOT RUN`.

- [ ] **Step 7: Commit documentation and acceptance contracts**

```bash
git add \
  docs/runbooks/station-stable-release.md \
  docs/acceptance/station-stable-release.md \
  docs/runbooks/station-beta-release.md \
  docs/hardware-acceptance-checklist.md \
  apps/station/README.md \
  tools/station-release/test/docs.test.mjs
git commit -m "docs(station): add stable release operations"
```

---

### Task 7: Cross-cutting verification and release readiness

**Files:**

- Modify only when a gate exposes a defect in files already owned by Tasks 1-6.
- Do not modify: `docs/acceptance/station-stable-release.md` physical results unless a real packaged Windows check was performed.

**Interfaces:**

- Consumes: complete implementation and documentation from Tasks 1-6.
- Produces: reviewable automated evidence and an explicit list of external setup/acceptance gates.

- [ ] **Step 1: Run the complete station release contract suite**

```bash
pnpm test:station-release:contract
```

Expected: all beta and stable release tests PASS with zero failures.

- [ ] **Step 2: Run Station package gates**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/db build
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
```

Expected: every command exits zero. Record exact test counts and any pre-existing warnings separately.

- [ ] **Step 3: Run Rust and production-boundary gates**

```bash
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
pnpm verify:station-production-cors
pnpm test:production-bundle:contract
```

Expected: all commands PASS. This does not claim Windows or hardware coverage.

- [ ] **Step 4: Run repository format and diff checks**

```bash
pnpm format:check
git diff --check
git diff main...HEAD --check
git status --short
```

Expected: format and both diff checks PASS; only intentional branch files are tracked; no signing file, environment file, build output, temporary directory, or release asset is present.

- [ ] **Step 5: Review the final implementation against the spec**

Verify line-by-line that the branch has:

- exact accepted-beta source provenance and CI gate;
- stable suffix removal and monotonic collision denial;
- committed stable endpoint overlay with unchanged public key;
- Russian optional highlights plus deterministic generated changelog;
- immutable ordinary stable release before Pre-release channel mutation;
- `promote-existing` validation and old-channel restoration;
- no second-person reviewer assumption;
- manual-only updater behavior and unsigned installer warning;
- honest external acceptance status.

If a requirement cannot be mapped to code, test, or documentation, add the missing focused RED/GREEN change before review completion.

- [ ] **Step 6: Confirm external setup without exposing secrets**

Using GitHub's environment metadata only, confirm `station-stable` exists and that the expected secret names are present. Do not retrieve, copy, print, or compare secret values. Confirm no required reviewers are configured. If environment setup is absent, report it as a release blocker rather than weakening workflow protection.

- [ ] **Step 7: Request code review and merge only after all automated gates pass**

Prepare a review summary that separates automated evidence from these unrun external checks:

- GitHub-hosted Windows stable build;
- first immutable stable publication;
- SmartScreen/unknown-publisher path;
- beta-to-stable retained data;
- scanner, printer, sound, fullscreen, offline/reconnect, and restart;
- stable-to-stable updater and manual rollback.

Commit only focused corrections found by review; do not squash away task-level evidence until review is complete.

- [ ] **Step 8: Perform the first release only after a new beta baseline is accepted**

This is an operator step after merge and requires a separate explicit release instruction. Publish a new beta containing the stable tooling, complete or accept its beta checklist, then dispatch `Publish station stable` with the exact tag. Do not reuse a beta whose `baseSha` predates the stable overlay. After publication, record real results in `docs/acceptance/station-stable-release.md` through a separate reviewed change.
