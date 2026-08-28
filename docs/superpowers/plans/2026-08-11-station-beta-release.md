# Markiro Station Beta Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish reproducible Windows x64 station betas from `main` and let a station discover and manually install signed Tauri updates without disrupting an active line.

**Architecture:** A small Node release toolkit owns SemVer calculation, deterministic release trees, canonical artifacts, and manifest validation; one protected Windows GitHub Actions workflow builds and publishes immutable version releases before promoting a channel manifest. Inside the station, a typed updater port and persisted `station_meta` state feed a fixed-viewport update center; checks are throttled and non-blocking, while download, install, and restart require explicit action outside an active shift.

**Tech Stack:** Node.js 24 `node:test`, GitHub Actions and `gh`, Tauri 2.11, `@tauri-apps/plugin-updater` 2.10.1, `@tauri-apps/plugin-process` 2.3.1, Rust, React 19, TypeScript 6, Vitest 4, `tauri-plugin-sql`, NSIS.

## Global Constraints

- The release target is Windows x64 NSIS only.
- Every release starts from an exact commit on `main` with a successful CI run for that SHA.
- The build-time station API origin is exactly `https://admin.markiro.app`; missing, malformed, localhost, path-bearing, or fallback values fail the release.
- Beta tags are immutable and named `station-v<semver>`; existing tags, versions, and versioned assets are never overwritten or force-pushed.
- The updater channel is `station-beta-channel`, not GitHub's global Latest release.
- Beta version releases are GitHub Pre-releases; their assets are immutable.
- Automatic checks happen after station initialization and no more than once per 24 hours; a manual check bypasses the throttle.
- Discovery never downloads, installs, restarts, blocks work, or clears a previously known valid update.
- Download, installation, and restart require explicit confirmation and are disabled while a shift is active.
- Update age is informational below 7 days, yellow at 7–29 days, and red at 30 days or more; color is never the only signal.
- Station configuration, SQLite, scan journal, boxes, exceptions, and outbox survive update, restart, reinstall, and the documented rollback window.
- The installer is not Authenticode-signed during beta; documentation must state that Windows can show an unknown-publisher/SmartScreen warning.
- Tauri updater signatures are mandatory. Only the public key is committed; private key material and password never enter Git, command arguments, logs, artifacts, or release notes.
- The private updater key has an encrypted offline backup outside GitHub before the first beta is published.
- RU and EN copy stay in lockstep. Floor actions remain at least 64 px, base floor text remains at least 18 px, and supported station viewports have no page scrolling or clipped controls.
- Automated, browser, Windows-packaged, and physical hardware evidence are reported separately.

## File and responsibility map

- `tools/station-release/version.mjs` — strict station-tag parsing, beta bump calculation, and exact Tauri/Cargo version-file mutation.
- `tools/station-release/artifacts.mjs` — canonical asset names, Tauri `latest.json`, checksums, staged/downloaded asset validation, and safe CLI entrypoints.
- `tools/station-release/test/version.test.mjs` — version and deterministic source-tree contract.
- `tools/station-release/test/artifacts.test.mjs` — manifest, signature, URL, hash, path, and malformed-input contract.
- `tools/station-release/test/workflow.test.mjs` — parsed/static security and ordering contract for the GitHub workflow.
- `.github/workflows/station-beta-release.yml` — protected manual Windows build, draft verification, immutable release publication, and beta-channel promotion.
- `apps/station/src/lib/update-state.ts` — validated persisted metadata, 24-hour policy, age severity, and state transitions.
- `apps/station/src/lib/tauri-updater.ts` — narrow adapter around Tauri updater/process plugins.
- `apps/station/src/lib/use-station-updater.ts` — single-flight startup/manual checks and manual install lifecycle.
- `apps/station/src/pages/UpdateCenter.tsx` — touch-safe update status, progress, confirmation, active-shift denial, and retry UI.
- `apps/station/src/ui/StatusBar.tsx` and `FloorShell.tsx` — persistent update indicator and entry point.
- `apps/station/src/App.tsx` — starts updater only after migrations/config load and routes the global update surface without retiring the active shift.
- `apps/station/src/dev/*` and `ui/persistent-station-states.ts` — exhaustive update gallery fixtures and viewport evidence.
- `apps/station/src-tauri/tauri.conf.json`, `Cargo.toml`, `lib.rs`, and `capabilities/default.json` — fixed channel endpoint, updater artifacts/public key, process restart plugin, and least capability.
- `docs/runbooks/station-beta-release.md` — key custody, release, retry, partial-state, install, rollback, and stable-channel extension procedure.
- `docs/acceptance/station-beta-release.md` — automated evidence plus beta.1-to-beta.2 real acceptance record.
- `docs/hardware-acceptance-checklist.md` and `apps/station/README.md` — packaged update/hardware cases and operator/developer guidance.

---

### Task 1: Strict beta version engine and deterministic release tree

**Files:**

- Create: `tools/station-release/version.mjs`
- Create: `tools/station-release/test/version.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces: `STATION_TAG_PREFIX = "station-v"`.
- Produces: `parseStationBetaTag(tag: string): StationBetaVersion | null` where `StationBetaVersion` is `{ major: number; minor: number; patch: number; beta: number; text: string }`.
- Produces: `nextStationBetaVersion(tags: readonly string[], bump: "next-beta" | "next-patch-beta" | "next-minor-beta"): string`.
- Produces: `readStationSourceVersion(root: URL): Promise<string>` and `writeStationSourceVersion(root: URL, version: string): Promise<void>`.
- Produces CLI: `node tools/station-release/version.mjs prepare <bump> <github-output-path>`; it obtains tags with `execFile("git", ["tag", "--list", "station-v*"])`, updates both source files atomically, and writes only `version=...` and `tag=...` to the explicit GitHub output file.

- [ ] **Step 1: Write failing SemVer and source-mutation tests**

```js
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  nextStationBetaVersion,
  parseStationBetaTag,
  readStationSourceVersion,
  writeStationSourceVersion,
} from "../version.mjs";

test("accepts only canonical station beta tags", () => {
  assert.equal(parseStationBetaTag("station-v0.1.0-beta.7")?.text, "0.1.0-beta.7");
  for (const tag of [
    "v0.1.0-beta.7",
    "station-v0.1.0",
    "station-v01.1.0-beta.1",
    "station-v0.1.0-beta.0",
    "station-v0.1.0-beta.1-extra",
    "station-v999999999999999999999.1.0-beta.1",
  ])
    assert.equal(parseStationBetaTag(tag), null, tag);
});

test("applies every approved beta bump and ignores unrelated tags", () => {
  const tags = ["v9.9.9", "station-v0.1.0", "station-v0.1.0-beta.2"];
  assert.equal(nextStationBetaVersion([], "next-beta"), "0.1.0-beta.1");
  assert.equal(nextStationBetaVersion(tags, "next-beta"), "0.1.0-beta.3");
  assert.equal(nextStationBetaVersion(tags, "next-patch-beta"), "0.1.1-beta.1");
  assert.equal(nextStationBetaVersion(tags, "next-minor-beta"), "0.2.0-beta.1");
  assert.throws(() => nextStationBetaVersion(tags, "major"), /invalid station beta bump/);
});

test("updates exactly the Tauri and Cargo package versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "markiro-station-version-"));
  await mkdir(join(root, "apps/station/src-tauri"), { recursive: true });
  await writeFile(
    join(root, "apps/station/src-tauri/tauri.conf.json"),
    JSON.stringify({ productName: "Markiro Station", version: "0.1.0" }, null, 2) + "\n",
  );
  await writeFile(
    join(root, "apps/station/src-tauri/Cargo.toml"),
    '[package]\nname = "markiro-station"\nversion = "0.1.0"\n\n[dependencies]\n',
  );

  await writeStationSourceVersion(new URL(`file://${root}/`), "0.1.0-beta.1");

  assert.equal(await readStationSourceVersion(new URL(`file://${root}/`)), "0.1.0-beta.1");
  assert.match(
    await readFile(join(root, "apps/station/src-tauri/Cargo.toml"), "utf8"),
    /version = "0\.1\.0-beta\.1"/,
  );
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test tools/station-release/test/version.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tools/station-release/version.mjs`.

- [ ] **Step 3: Implement strict parsing, safe arithmetic, and exact file writes**

Use a fully anchored regex and safe integers:

```js
const STATION_BETA_TAG = /^station-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/;
const BUMPS = new Set(["next-beta", "next-patch-beta", "next-minor-beta"]);

export function parseStationBetaTag(tag) {
  if (typeof tag !== "string") return null;
  const match = STATION_BETA_TAG.exec(tag);
  if (!match) return null;
  const [major, minor, patch, beta] = match.slice(1).map(Number);
  if (![major, minor, patch, beta].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, beta, text: `${major}.${minor}.${patch}-beta.${beta}` };
}
```

Compare versions numerically, not lexicographically. Reject an unknown bump, integer overflow, missing/multiple Cargo package versions, non-object JSON, mismatched source versions, symlinks, and an already existing output path. Write temporary files in the same directory with mode `0600`, `sync()`, then rename. Do not emit tag lists or rejected input.

Add root script:

```json
"test:station-release:contract": "node --test tools/station-release/test/*.test.mjs"
```

- [ ] **Step 4: Run focused and root contract tests**

Run: `node --test tools/station-release/test/version.test.mjs`

Expected: PASS.

Run: `pnpm test:station-release:contract`

Expected: PASS for the version tests.

- [ ] **Step 5: Commit Task 1**

```bash
git add package.json tools/station-release/version.mjs tools/station-release/test/version.test.mjs
git diff --cached --check
git commit -m "feat(station): add beta version engine"
```

---

### Task 2: Canonical updater manifest and artifact verifier

**Files:**

- Create: `tools/station-release/artifacts.mjs`
- Create: `tools/station-release/test/artifacts.test.mjs`

**Interfaces:**

- Consumes: canonical version strings produced by Task 1.
- Produces: `stationAssetNames(version)` returning exact installer, bundle, signature, manifest, checksum, notes, and evidence names.
- Produces: `createBetaUpdateManifest({ version, pubDate, bundleUrl, signature }): object`.
- Produces: `parseBetaUpdateManifest(text, expected): object` with exact-key and exact-platform validation.
- Produces: `stageStationRelease({ inputDirectory, outputDirectory, version, pubDate, baseSha, releaseSha }): Promise<ReleaseEvidence>`.
- Produces CLI commands `stage`, `validate`, and `checksums`; all failures emit only `invalid station release artifacts`.

- [ ] **Step 1: Write failing manifest and hostile-input tests**

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createBetaUpdateManifest,
  parseBetaUpdateManifest,
  stationAssetNames,
} from "../artifacts.mjs";

const version = "0.1.0-beta.1";
const names = stationAssetNames(version);
const bundleUrl = `https://github.com/thevladbog/markiro-station-releases/releases/download/station-v${version}/${names.bundle}`;

test("creates the exact one-platform Tauri beta manifest", () => {
  const manifest = createBetaUpdateManifest({
    version,
    pubDate: "2026-08-11T12:00:00.000Z",
    bundleUrl,
    signature: "trusted-test-signature",
  });
  assert.deepEqual(manifest, {
    version,
    pub_date: "2026-08-11T12:00:00.000Z",
    platforms: {
      "windows-x86_64": { url: bundleUrl, signature: "trusted-test-signature" },
    },
  });
  assert.deepEqual(
    parseBetaUpdateManifest(JSON.stringify(manifest), { version, bundleUrl }),
    manifest,
  );
});

test("rejects extra platforms, mutable URLs, traversal, symlinks and secret-shaped text", async () => {
  const valid = createBetaUpdateManifest({
    version,
    pubDate: "2026-08-11T12:00:00.000Z",
    bundleUrl,
    signature: "trusted-test-signature",
  });
  assert.throws(
    () =>
      parseBetaUpdateManifest(JSON.stringify({ ...valid, token: "ghp_sensitive" }), {
        version,
        bundleUrl,
      }),
    /invalid station release artifacts/,
  );
  assert.throws(
    () =>
      parseBetaUpdateManifest(
        JSON.stringify({ ...valid, platforms: { ...valid.platforms, linux: {} } }),
        { version, bundleUrl },
      ),
    /invalid station release artifacts/,
  );
  const directory = await mkdtemp(join(tmpdir(), "markiro-station-artifacts-"));
  await writeFile(join(directory, "real"), "bundle");
  await symlink(join(directory, "real"), join(directory, names.bundle));
  assert.equal(await readFile(join(directory, "real"), "utf8"), "bundle");
});
```

Extend the test with these exact denials: invalid/future/noncanonical timestamp, non-HTTPS URL, wrong repository/tag/name, empty or oversized signature, duplicate filename, zero-byte binary, file larger than the configured bound, checksum mismatch, CR/LF filename, unexpected file, symlink, output path already present, and text containing `ghp_`, `github_pat_`, `TAURI_SIGNING_PRIVATE_KEY`, `api_key`, or `pairing_code`.

- [ ] **Step 2: Run the test and confirm RED**

Run: `node --test tools/station-release/test/artifacts.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tools/station-release/artifacts.mjs`.

- [ ] **Step 3: Implement canonical names and strict manifest validation**

Canonical names are:

```js
export function stationAssetNames(version) {
  return {
    installer: `markiro-station-${version}-windows-x86_64-setup.exe`,
    bundle: `markiro-station-${version}-windows-x86_64.nsis.zip`,
    signature: `markiro-station-${version}-windows-x86_64.nsis.zip.sig`,
    manifest: "latest.json",
    checksums: "SHA256SUMS",
    notes: "release-notes.md",
    evidence: "release-evidence.json",
  };
}
```

The manifest has exactly `platforms`, `pub_date`, and `version`; `platforms` has exactly `windows-x86_64`; its value has exactly `signature` and `url`. Use canonical UTC timestamps ending `.000Z`, HTTPS GitHub URLs under `thevladbog/markiro/releases/download/station-v<version>/`, bounded regular files only, `lstat` symlink rejection, `open(..., "wx", 0o600)`, and SHA-256 from streaming reads. `SHA256SUMS` is sorted by filename and excludes itself.

`release-evidence.json` has exact keys:

```json
{
  "baseSha": "40 lowercase hex",
  "releaseSha": "40 lowercase hex",
  "version": "canonical beta semver",
  "publishedAt": "canonical UTC timestamp",
  "assets": {
    "canonical filename": "64 lowercase hex"
  }
}
```

- [ ] **Step 4: Run the hostile-input and full release-contract suite**

Run: `node --test tools/station-release/test/artifacts.test.mjs`

Expected: PASS.

Run: `pnpm test:station-release:contract`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add tools/station-release/artifacts.mjs tools/station-release/test/artifacts.test.mjs
git diff --cached --check
git commit -m "feat(station): validate beta release artifacts"
```

---

### Task 3: Provision updater signing and pin the Tauri release contract

**Files:**

- Modify: `apps/station/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/station/src-tauri/Cargo.toml`
- Modify: `apps/station/src-tauri/Cargo.lock`
- Modify: `apps/station/src-tauri/tauri.conf.json`
- Modify: `apps/station/src-tauri/capabilities/default.json`
- Modify: `apps/station/src-tauri/src/lib.rs`
- Modify: `apps/station/src-tauri/src/commands.rs`
- Create: `apps/station/test/tauri-release-config.test.ts`

**Interfaces:**

- Produces fixed updater endpoint `https://github.com/thevladbog/markiro-station-releases/releases/download/station-beta-channel/latest.json`.
- Produces an actual embedded Tauri public key and `bundle.createUpdaterArtifacts = true`.
- Produces `@tauri-apps/plugin-updater` 2.10.1 and `@tauri-apps/plugin-process` 2.3.1 guest APIs.
- Produces only the restart capability required after explicit installation.
- Removes the runtime `set_update_endpoint` override; release channel selection is build-owned.

- [ ] **Step 1: Write the failing configuration contract**

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const tauriRoot = new URL("../src-tauri/", import.meta.url);

describe("packaged station updater contract", () => {
  it("pins one beta endpoint, updater artifacts, a real public key and restart only", async () => {
    const config = JSON.parse(await readFile(new URL("tauri.conf.json", tauriRoot), "utf8"));
    const capability = JSON.parse(
      await readFile(new URL("capabilities/default.json", tauriRoot), "utf8"),
    );
    expect(config.bundle.createUpdaterArtifacts).toBe(true);
    expect(config.plugins.updater.endpoints).toEqual([
      "https://github.com/thevladbog/markiro-station-releases/releases/download/station-beta-channel/latest.json",
    ]);
    expect(config.plugins.updater.pubkey).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    expect(config.plugins.updater.pubkey).not.toMatch(/replace|example|test/i);
    expect(capability.permissions).toContain("process:allow-restart");
  });

  it("has no operator-controlled updater endpoint command", async () => {
    const [commands, lib] = await Promise.all([
      readFile(new URL("src/commands.rs", tauriRoot), "utf8"),
      readFile(new URL("src/lib.rs", tauriRoot), "utf8"),
    ]);
    expect(commands).not.toMatch(/set_update_endpoint|validate_endpoint_url/);
    expect(lib).not.toMatch(/set_update_endpoint/);
  });
});
```

- [ ] **Step 2: Run the config test and confirm RED**

Run: `pnpm --filter @markiro/station exec vitest run test/tauri-release-config.test.ts`

Expected: FAIL because updater artifacts, plugins config, public key, and process permission are absent.

- [ ] **Step 3: Complete the interactive signing-key gate outside captured logs**

In a local interactive terminal, not through a command whose stdout is captured:

```bash
umask 077
station_release_key_dir="/Users/thevladbog/.config/markiro/release"
mkdir -p "$station_release_key_dir"
pnpm --filter @markiro/station tauri signer generate \
  --write-keys "$station_release_key_dir/station-updater.key"
chmod 600 "$station_release_key_dir/station-updater.key"
```

Enter a new strong password only at the CLI prompt. Record the emitted public key, but do not paste the private key or password into the task, chat, shell history, plan, or Git. Create/protect the GitHub Environment, then supply secrets without command-line values:

```bash
gh api --method PUT repos/thevladbog/markiro/environments/station-beta
gh secret set TAURI_SIGNING_PRIVATE_KEY --env station-beta \
  < "$station_release_key_dir/station-updater.key"
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env station-beta
```

The last command prompts for the password. Copy the encrypted key file to the owner's approved offline backup media and verify its SHA-256 against the source without publishing either path or digest. Pause Task 3 until the owner confirms that backup recovery is possible.

- [ ] **Step 4: Add exact guest/core dependencies and fixed configuration**

Run:

```bash
pnpm --filter @markiro/station add --save-exact \
  @tauri-apps/plugin-updater@2.10.1 \
  @tauri-apps/plugin-process@2.3.1
```

Pin Rust dependencies:

```toml
tauri-plugin-updater = "2.10.1"
tauri-plugin-process = "2.3.1"
```

Add to `tauri.conf.json` using the exact generated public key from Step 3:

```json
"bundle": {
  "active": true,
  "targets": ["nsis"],
  "createUpdaterArtifacts": true,
  "icon": ["icons/icon.ico"]
},
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/thevladbog/markiro-station-releases/releases/download/station-beta-channel/latest.json"
    ]
  }
}
```

Set `plugins.updater.pubkey` to the exact public key printed by the signer in
Step 3 before committing the configuration. The contract test rejects a
missing or sample key, so this external provisioning gate cannot be bypassed by
checking in placeholder material. Register `tauri_plugin_process::init()` in
`lib.rs`, add `process:allow-restart`, and remove the endpoint override command
and its tests. Do not broaden updater or shell permissions.

- [ ] **Step 5: Run config, Rust, dependency, and bundle gates**

Run: `pnpm --filter @markiro/station exec vitest run test/tauri-release-config.test.ts`

Expected: PASS.

Run: `pnpm --filter @markiro/station typecheck`

Expected: PASS.

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml`

Expected: PASS on the host; report that this is not Windows packaging evidence.

Run: `pnpm --filter @markiro/station tauri build --debug --no-bundle`

Expected: PASS on a supported host. The Windows NSIS bundle remains a CI gate.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/station/package.json pnpm-lock.yaml \
  apps/station/src-tauri/Cargo.toml apps/station/src-tauri/Cargo.lock \
  apps/station/src-tauri/tauri.conf.json apps/station/src-tauri/capabilities/default.json \
  apps/station/src-tauri/src/lib.rs apps/station/src-tauri/src/commands.rs \
  apps/station/test/tauri-release-config.test.ts
git diff --cached --check
git commit -m "feat(station): configure signed beta updater"
```

---

### Task 4: Persisted update state, throttle, and age policy

**Files:**

- Create: `apps/station/src/lib/update-state.ts`
- Create: `apps/station/test/update-state.test.ts`

**Interfaces:**

- Produces `UPDATE_STATE_KEY = "station_update_state_v1"` and `AUTO_CHECK_INTERVAL_MS = 86_400_000`.
- Produces `UpdateSeverity = "none" | "info" | "warn" | "urgent"`.
- Produces `KnownStationUpdate = { version: string; publishedAt: string }`.
- Produces `PersistedUpdateState = { schemaVersion: 1; lastAttemptAt: string | null; lastSuccessfulCheckAt: string | null; available: KnownStationUpdate | null }`.
- Produces `loadUpdateState`, `saveUpdateState`, `automaticCheckDue`, `recordCheckAttempt`, `recordCheckSuccess`, and `updateSeverity`.

- [ ] **Step 1: Write failing state-machine and SQLite tests**

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  automaticCheckDue,
  loadUpdateState,
  recordCheckAttempt,
  recordCheckSuccess,
  saveUpdateState,
  updateSeverity,
} from "../src/lib/update-state.js";
import { sqliteExecutor } from "./support/sqlite-exec.js";

describe("station update state", () => {
  it("uses exact 7-day and 30-day boundaries", () => {
    const now = Date.parse("2026-08-31T00:00:00.000Z");
    expect(updateSeverity(now, null)).toBe("none");
    expect(
      updateSeverity(now, { version: "0.1.0-beta.2", publishedAt: "2026-08-24T00:00:01.000Z" }),
    ).toBe("info");
    expect(
      updateSeverity(now, { version: "0.1.0-beta.2", publishedAt: "2026-08-24T00:00:00.000Z" }),
    ).toBe("warn");
    expect(
      updateSeverity(now, { version: "0.1.0-beta.2", publishedAt: "2026-08-01T00:00:00.000Z" }),
    ).toBe("urgent");
  });

  it("throttles automatic checks but allows state transitions to retain a known update", () => {
    const empty = recordCheckAttempt(null, "2026-08-11T00:00:00.000Z");
    const known = recordCheckSuccess(empty, "2026-08-11T00:00:10.000Z", {
      version: "0.1.0-beta.2",
      publishedAt: "2026-08-10T00:00:00.000Z",
    });
    const failedLater = recordCheckAttempt(known, "2026-08-11T01:00:00.000Z");
    expect(failedLater.available).toEqual(known.available);
    expect(automaticCheckDue(Date.parse("2026-08-11T23:59:59.999Z"), failedLater)).toBe(false);
    expect(automaticCheckDue(Date.parse("2026-08-12T01:00:00.000Z"), failedLater)).toBe(true);
  });

  it("round-trips one bounded record and fails malformed data to empty state", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE station_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const exec = sqliteExecutor(db);
    const state = recordCheckSuccess(null, "2026-08-11T00:00:00.000Z", null);
    await saveUpdateState(exec, state);
    expect(await loadUpdateState(exec)).toEqual(state);
    db.prepare("UPDATE station_meta SET value = ? WHERE key = ?").run(
      "{bad",
      "station_update_state_v1",
    );
    expect(await loadUpdateState(exec)).toBeNull();
  });
});
```

Add cases for a future `publishedAt`, invalid ISO strings, extra keys, oversized JSON, beta version without canonical SemVer, wrong schema version, negative ages, missing table/read failure, write failure, and concurrent upserts.

- [ ] **Step 2: Run the test and confirm RED**

Run: `pnpm --filter @markiro/station exec vitest run test/update-state.test.ts`

Expected: FAIL with unresolved `update-state.js`.

- [ ] **Step 3: Implement pure policy plus one `station_meta` row**

Use exact-key validation without broad casts. Canonical timestamps must round-trip through `new Date(value).toISOString()`. Limit stored JSON to 2 KiB and reject future publication dates at the point a check result is accepted. Persist with:

```sql
INSERT INTO station_meta (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
```

`loadUpdateState` returns `null` for absent, malformed, oversized, or unreadable state and never deletes operational rows. `saveUpdateState` propagates write errors so the controller can show a non-blocking diagnostic.

- [ ] **Step 4: Run focused tests, station test, and typecheck**

Run: `pnpm --filter @markiro/station exec vitest run test/update-state.test.ts`

Expected: PASS.

Run: `pnpm --filter @markiro/station test`

Expected: all station tests PASS.

Run: `pnpm --filter @markiro/station typecheck`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add apps/station/src/lib/update-state.ts apps/station/test/update-state.test.ts
git diff --cached --check
git commit -m "feat(station): persist beta update state"
```

---

### Task 5: Tauri updater adapter and single-flight manual controller

**Files:**

- Create: `apps/station/src/lib/tauri-updater.ts`
- Create: `apps/station/src/lib/use-station-updater.ts`
- Create: `apps/station/test/tauri-updater.test.ts`
- Create: `apps/station/test/use-station-updater.test.tsx`

**Interfaces:**

- Consumes Task 3 guest plugins and Task 4 persistence/policy.
- Produces `StationUpdateDownloadEvent = { event: "Started"; contentLength: number | null } | { event: "Progress"; chunkLength: number } | { event: "Finished" }`.
- Produces `StationUpdateHandle = { currentVersion: string; version: string; publishedAt: string; downloadAndInstall(onProgress: (event: StationUpdateDownloadEvent) => void): Promise<void>; close(): Promise<void> }`.
- Produces `StationUpdaterPort = { check(): Promise<StationUpdateHandle | null>; relaunch(): Promise<void> }`.
- Produces `tauriStationUpdater: StationUpdaterPort` using `check({ timeout: 15_000, allowDowngrades: false })` and `relaunch()`.
- Produces `useStationUpdater({ enabled, exec, activeShift, pendingOutbox, port, now }): StationUpdaterController`.
- Produces `StationUpdatePhase = "idle" | "checking" | "downloading" | "installing" | "restarting"` and `StationUpdateError = "check-failed" | "invalid-metadata" | "state-write-failed" | "active-shift" | "target-changed" | "install-failed"`.
- Produces `StationUpdaterSnapshot = { phase: StationUpdatePhase; persisted: PersistedUpdateState | null; severity: UpdateSeverity; error: StationUpdateError | null; downloadedBytes: number; totalBytes: number | null }`.
- Produces `StationUpdaterController = { snapshot: StationUpdaterSnapshot; checkNow(): Promise<void>; install(): Promise<void> }`.

- [ ] **Step 1: Write failing adapter tests**

Mock `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process`, then assert:

```ts
it("maps Tauri date and closes resources without enabling downgrades", async () => {
  checkMock.mockResolvedValue({
    currentVersion: "0.1.0-beta.1",
    version: "0.1.0-beta.2",
    date: "2026-08-11T00:00:00.000Z",
    downloadAndInstall: vi.fn(),
    close: vi.fn(),
  });
  const update = await tauriStationUpdater.check();
  expect(checkMock).toHaveBeenCalledWith({ timeout: 15_000, allowDowngrades: false });
  expect(update).toMatchObject({
    version: "0.1.0-beta.2",
    publishedAt: "2026-08-11T00:00:00.000Z",
  });
});
```

Reject missing/invalid/future `date`, noncanonical beta versions, same/older versions, and malformed metadata. Ensure every rejected Tauri `Update` resource receives `close()`.

- [ ] **Step 2: Write failing controller tests with fake timers**

```tsx
it("checks once after enable, throttles StrictMode remounts, and never downloads automatically", async () => {
  vi.useFakeTimers();
  const port = fakeUpdaterPort({ available: beta2 });
  const { result } = renderHook(() =>
    useStationUpdater({ enabled: true, exec, activeShift: false, pendingOutbox: 0, port, now }),
  );
  await act(() => vi.runAllTimersAsync());
  expect(port.check).toHaveBeenCalledOnce();
  expect(beta2.downloadAndInstall).not.toHaveBeenCalled();
  expect(result.current.snapshot.available?.version).toBe("0.1.0-beta.2");
});

it("denies install during a shift and installs only after explicit invocation", async () => {
  const port = fakeUpdaterPort({ available: beta2 });
  const view = renderHook(
    ({ activeShift }) =>
      useStationUpdater({ enabled: true, exec, activeShift, pendingOutbox: 7, port, now }),
    { initialProps: { activeShift: true } },
  );
  await expect(view.result.current.install()).rejects.toThrow("active shift");
  expect(beta2.downloadAndInstall).not.toHaveBeenCalled();
  view.rerender({ activeShift: false });
  await act(() => view.result.current.install());
  expect(beta2.downloadAndInstall).toHaveBeenCalledOnce();
  expect(port.relaunch).toHaveBeenCalledOnce();
});
```

Add tests for manual throttle bypass, one in-flight check, scheduled next check after a long-running app, network failure retaining known metadata, persistence write failure, restart with a persisted known update, re-check-before-install, changed target version, signature/download failure, no relaunch on install failure, progress byte accumulation, unmount/late completion, and `close()` in every terminal path.

- [ ] **Step 3: Run adapter/controller tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/station exec vitest run \
  test/tauri-updater.test.ts \
  test/use-station-updater.test.tsx
```

Expected: FAIL with unresolved updater modules.

- [ ] **Step 4: Implement the narrow adapter and controller**

The adapter owns Tauri resource lifetime. The controller stores only serializable metadata; it never stores the Tauri handle in SQLite. `install()` always calls `port.check()` again, confirms the result is at least the displayed target, and invokes `downloadAndInstall()` only from that method. It then invokes `relaunch()`. If no update is returned, it records success with `available: null` and does not restart.

Use a ref-held single-flight promise and a generation token so StrictMode and late completions cannot run two checks or publish retired results. Compute the next automatic `setTimeout` from `lastAttemptAt`; cap each timer delay at the platform maximum and reschedule until due. Manual `checkNow()` ignores the timestamp but joins an in-flight check.

- [ ] **Step 5: Run focused and station gates**

Run the two focused files again.

Expected: PASS.

Run: `pnpm --filter @markiro/station test`

Expected: all station tests PASS.

Run: `pnpm --filter @markiro/station typecheck`

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add apps/station/src/lib/tauri-updater.ts \
  apps/station/src/lib/use-station-updater.ts \
  apps/station/test/tauri-updater.test.ts \
  apps/station/test/use-station-updater.test.tsx
git diff --cached --check
git commit -m "feat(station): add manual updater controller"
```

---

### Task 6: Fixed-viewport update indicator and manual update center

**Files:**

- Create: `apps/station/src/pages/UpdateCenter.tsx`
- Create: `apps/station/test/update-center.test.tsx`
- Modify: `apps/station/src/ui/StatusBar.tsx`
- Modify: `apps/station/src/ui/FloorShell.tsx`
- Modify: `apps/station/src/App.tsx`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/src/station.css`
- Modify: `apps/station/src/ui/persistent-station-states.ts`
- Modify: `apps/station/src/dev/gallery-fixtures.ts`
- Modify: `apps/station/src/dev/StationScreenGallery.tsx`
- Modify: `apps/station/test/status-bar.test.tsx`
- Modify: `apps/station/test/App.test.tsx`
- Modify: `apps/station/test/i18n.test.tsx`
- Modify: `apps/station/test/screen-gallery.test.tsx`
- Modify: `apps/station/test/fixed-viewport-source.test.tsx`

**Interfaces:**

- Consumes `StationUpdaterController` from Task 5.
- Produces `UpdateIndicatorModel = { severity: UpdateSeverity; label: string; glyph: "↻" | "!"; available: boolean }`.
- Produces `UpdateCenterProps = { controller: StationUpdaterController; activeShift: boolean; pendingOutbox: number; onBack(): void }`.
- Extends `StatusBarProps`/`FloorShellProps` with `update`, `onOpenUpdates`.
- Adds persistent gallery update states `update-current`, `update-info`, `update-warn`, `update-urgent`, `update-error`, and `update-active-shift`.

- [ ] **Step 1: Write failing update-center behavior tests**

```tsx
it("shows a known version and requires confirmation before install", async () => {
  const controller = controllerFixture({ version: "0.1.0-beta.2", severity: "warn" });
  render(
    <UpdateCenter
      controller={controller}
      activeShift={false}
      pendingOutbox={7}
      onBack={() => {}}
    />,
  );
  expect(screen.getByText("0.1.0-beta.2")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Download and install" }));
  expect(controller.install).not.toHaveBeenCalled();
  expect(screen.getByText("7 operations are still waiting to sync")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Confirm update" }));
  await waitFor(() => expect(controller.install).toHaveBeenCalledOnce());
});

it("allows checks but disables install during an active shift", () => {
  const controller = controllerFixture({ version: "0.1.0-beta.2", severity: "urgent" });
  render(<UpdateCenter controller={controller} activeShift pendingOutbox={0} onBack={() => {}} />);
  expect(screen.getByRole("button", { name: "Check for updates" })).not.toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByRole("button", { name: "Download and install" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByText("Leave the active shift before installing")).toBeDefined();
});
```

Add exact tests for current/no-update, checking, offline error with last successful time, 7/30-day copy, progress, install failure/retry, back navigation, RU copy, accessible status, glyph plus text, and 64 px action classes.

- [ ] **Step 2: Write failing App/StatusBar/global routing tests**

Add a StatusBar test that expects an always-available `Updates` button and `data-update-severity`. Add App tests proving:

1. update initialization does not run before `applyMigrations` and `read_config` finish;
2. opening the update center retains `shift` and the sync engine;
3. an active shift reaches the update center but cannot install;
4. Back returns to the same work screen;
5. no updater call occurs in gallery/dev fixtures unless a synthetic fixture provides it.

- [ ] **Step 3: Run the focused UI tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/station exec vitest run \
  test/update-center.test.tsx \
  test/status-bar.test.tsx \
  test/App.test.tsx
```

Expected: FAIL because the update center and props do not exist.

- [ ] **Step 4: Implement the update center and global entry point**

Call the hook unconditionally in `App`, with `enabled={config !== null}` behavior expressed as a boolean argument. Since `publishConfig` happens after `applyMigrations`, the first check cannot race `station_meta` creation. Add `showUpdates` as a view flag ordered before setup/conflicts/shift rendering; never clear `shift` when opening or closing it.

The StatusBar update control is a semantic `<button type="button">` with a 64 px minimum target, visible focus, glyph, text, and these token mappings:

```ts
const UPDATE_TONE = {
  none: "var(--fg-2)",
  info: "var(--info-fg)",
  warn: "var(--warn-fg)",
  urgent: "var(--err-fg)",
} as const;
```

Do not turn a release reminder into a full-screen scan signal. `UpdateCenter` uses `StationScreen`, `FloorFooter`, `Alert`, and floor buttons. The confirm step names current/target versions and pending count. No release notes HTML is rendered.

Add i18n keys under one `updates` object in both dictionaries, with identical keys. Extend the exhaustive persistent gallery map and add synthetic update fixtures for every long-lived state.

- [ ] **Step 5: Prove fixed viewport and accessibility contracts**

Run focused UI tests and:

```bash
pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/station exec vitest run \
  --config ../../docs/acceptance/station-touch-vitest.config.mjs
```

Expected: all mapped station tests PASS.

Run the existing station gallery/browser matrix at 1280x800, 1024x768, and 1280x1024 for all new update fixtures. Expected for every locale/viewport: document bounds equal viewport, zero page/nested scroll regions, zero clipped interactives, and zero floor targets below 64 px. Store only the repository's established acceptance JSON/screenshots; do not claim physical touch evidence.

- [ ] **Step 6: Run package gates**

```bash
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
```

Expected: all PASS.

- [ ] **Step 7: Commit Task 6**

```bash
git add apps/station/src apps/station/test docs/acceptance
git diff --cached --check
git commit -m "feat(station): add manual beta update screen"
```

---

### Task 7: Protected Windows beta publication workflow

**Files:**

- Create: `.github/workflows/station-beta-release.yml`
- Create: `tools/station-release/test/workflow.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `deploy/production/test/workflow-contract.test.mjs`

**Interfaces:**

- Consumes Task 1 `prepare` and Task 2 `stage`/`validate` CLIs.
- Consumes GitHub Environment `station-beta` with `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Produces manual dropdown values `next-beta`, `next-patch-beta`, and `next-minor-beta`.
- Produces immutable tag/release `station-v<version>` and promotes `station-beta-channel/latest.json` last.
- Produces run summary with only public version, SHAs, hashes, URLs, and PASS/NOT PROMOTED status.

- [ ] **Step 1: Write the failing parsed workflow security contract**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";

const root = new URL("../../../", import.meta.url);
const source = () => readFile(new URL(".github/workflows/station-beta-release.yml", root), "utf8");

test("station beta publication is protected, serialized, main-only and channel-last", async () => {
  const text = await source();
  const workflow = load(text);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["mode", "bump"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, [
    "publish",
    "promote-existing",
  ]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.bump.options, [
    "next-beta",
    "next-patch-beta",
    "next-minor-beta",
  ]);
  assert.equal(workflow.concurrency.group, "station-beta-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.release["runs-on"], "windows-latest");
  assert.equal(workflow.jobs.release.environment, "station-beta");
  assert.deepEqual(workflow.jobs.release.permissions, { actions: "read", contents: "write" });
  assert.match(text, /refs\/heads\/main/);
  assert.match(text, /VITE_STATION_API_URL:\s*https:\/\/admin\.markiro\.app/);
  assert.match(text, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(text, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
  assert.ok(
    text.indexOf("Publish immutable version release") < text.indexOf("Promote beta channel"),
  );
  assert.doesNotMatch(text, /force|:latest\b|pull_request_target|self-hosted|id-token|curl .+\|/i);
});
```

Extend this test to require pinned third-party actions, Node 24, pnpm lockfile install, exact station gates, exact CI-run lookup by SHA/workflow/branch/conclusion, Windows NSIS build, fresh staging/download directories, draft asset download/verification, candidate-ref cleanup, service-channel-only clobber, pre-clobber channel backup, bounded restoration on failed promotion, and summary fields. Deny `continue-on-error`, broad write permissions, arbitrary ref input, user-supplied version, dynamic API origin, shell interpolation of signing secrets, and channel promotion before downloaded verification.

- [ ] **Step 2: Run contracts and confirm RED**

Run: `pnpm test:station-release:contract`

Expected: FAIL because `station-beta-release.yml` is absent.

- [ ] **Step 3: Add the workflow in explicit phases**

Use this top-level contract:

```yaml
name: Publish station beta

on:
  workflow_dispatch:
    inputs:
      mode:
        description: Publish a new beta or retry the unpromoted latest beta
        required: true
        type: choice
        default: publish
        options: [publish, promote-existing]
      bump:
        description: Beta version increment
        required: true
        type: choice
        default: next-beta
        options: [next-beta, next-patch-beta, next-minor-beta]

permissions:
  contents: read

concurrency:
  group: station-beta-release
  cancel-in-progress: false

jobs:
  release:
    if: github.ref == 'refs/heads/main'
    runs-on: windows-latest
    timeout-minutes: 60
    environment: station-beta
    permissions:
      actions: read
      contents: write
    env:
      VITE_STATION_API_URL: https://admin.markiro.app
      TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

Implement phases in this order:

1. checkout the dispatch SHA and verify `github.ref`, 40-character lowercase SHA, ancestry in `origin/main`, clean tree, and exact successful `ci.yml` push run for the SHA via GitHub API;
2. run Task 1 `prepare`, validate changed paths are exactly the two version files, and create a deterministic release commit with fixed release identity and base commit timestamp;
3. install from lockfile, build workspace dependencies, run station test/typecheck/lint/build, Rust tests, release contracts, and `git diff --check`;
4. run `pnpm --filter @markiro/station tauri build` with signing secrets and locate exactly one NSIS installer, updater `.nsis.zip`, and matching `.sig` under `src-tauri/target/release/bundle/nsis`;
5. stage canonical assets through Task 2 in a new `$RUNNER_TEMP` directory and validate them;
6. push the deterministic release commit to an owned candidate ref `refs/heads/station-release-candidate-${{ github.run_id }}` using checkout's ephemeral credential;
7. create a draft Pre-release targeted at that candidate, upload canonical files, download them to a second new directory, and run Task 2 validation/checksums/signature verification again;
8. publish the immutable version release, verify its tag resolves to the release commit and every asset is downloadable with the expected hash;
9. create `station-beta-channel` once if absent, otherwise verify its service-release identity and download its current `latest.json` as a rollback copy;
10. replace only `station-beta-channel/latest.json` with `gh release upload station-beta-channel ... --clobber`, then download the promoted channel manifest and validate it against the just-published immutable release;
11. if replacement or public verification fails, restore the rollback copy with a second bounded upload and fail the workflow; document that GitHub Releases cannot replace an asset atomically, so a brief non-blocking updater 404 is possible during promotion;
12. delete only the candidate ref owned by this run and emit the public summary, including whether rollback recovery was exercised.

An `if: always()` cleanup removes local secret-bearing config/staging files and attempts to delete only the exact candidate ref. It never deletes tags/releases/assets. If publication succeeded but promotion failed, the summary says `published, not promoted`; a later run must detect that exact state and require `mode=promote-existing` rather than incrementing past it.

`promote-existing` accepts no arbitrary version: the toolkit resolves the highest immutable beta release, verifies it is newer than the current channel, downloads and validates every asset, and changes only the channel manifest. Assert that `bump` is ignored in promotion mode.

- [ ] **Step 4: Add the release contract to CI**

Add `pnpm test:station-release:contract` to the ordinary CI job before Windows packaging. Extend `deploy/production/test/workflow-contract.test.mjs` so the repository-wide action pin test includes `.github/workflows/station-beta-release.yml`.

- [ ] **Step 5: Run contract, YAML parse, and package gates**

```bash
pnpm test:station-release:contract
pnpm test:production-bundle:contract
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
```

Expected: all PASS. Do not dispatch the publication workflow in this task.

- [ ] **Step 6: Commit Task 7**

```bash
git add .github/workflows/station-beta-release.yml .github/workflows/ci.yml \
  tools/station-release/test/workflow.test.mjs \
  deploy/production/test/workflow-contract.test.mjs
git diff --cached --check
git commit -m "ci(station): publish protected beta releases"
```

---

### Task 8: Release runbook, unsigned-install guidance, and acceptance record

**Files:**

- Create: `docs/runbooks/station-beta-release.md`
- Create: `docs/acceptance/station-beta-release.md`
- Modify: `docs/hardware-acceptance-checklist.md`
- Modify: `apps/station/README.md`
- Modify: `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`
- Create: `tools/station-release/test/docs.test.mjs`

**Interfaces:**

- Produces an operator-safe release procedure that never includes secrets or pairing data.
- Produces an acceptance template with separate automated, packaged Windows, and physical hardware sections.
- Records beta.1-to-beta.2 update and beta.2-to-beta.1 rollback as real external gates.

- [ ] **Step 1: Write the failing documentation contract**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("station beta runbook documents every destructive and external boundary", async () => {
  const [runbook, acceptance, hardware] = await Promise.all([
    read("docs/runbooks/station-beta-release.md"),
    read("docs/acceptance/station-beta-release.md"),
    read("docs/hardware-acceptance-checklist.md"),
  ]);
  for (const phrase of [
    "Unknown publisher",
    "station-beta-channel",
    "next-beta",
    "promote-existing",
    "encrypted offline backup",
    "published, not promoted",
    "manual rollback",
  ])
    assert.match(runbook, new RegExp(phrase, "i"));
  for (const status of ["PASS", "FAIL", "NOT RUN"]) assert.match(acceptance, new RegExp(status));
  assert.match(hardware, /beta\.1.*beta\.2/is);
  assert.doesNotMatch(
    `${runbook}${acceptance}`,
    /ghp_|github_pat_|pairing code:\s*\d|api[_ -]?key:\s*\S+/i,
  );
});
```

- [ ] **Step 2: Run docs contract and confirm RED**

Run: `node --test tools/station-release/test/docs.test.mjs`

Expected: FAIL because the runbook and acceptance file are absent.

- [ ] **Step 3: Write the runbook and acceptance template**

The runbook must include:

- prerequisites and exact GitHub Environment secret names;
- how to verify the encrypted offline backup without printing it;
- dropdown semantics and examples;
- main/CI provenance and production API binding;
- unsigned NSIS/SmartScreen expectations;
- publish and promotion transaction;
- partial-state classification and `promote-existing` retry;
- channel inspection and immutable artifact/hash verification;
- manual installation only outside an active shift;
- outbox/data preservation and rollback caveat;
- stable-channel extension without repointing beta clients;
- revocation/key-rotation incident procedure requiring an old-key-signed bridge release.

Initialize the acceptance file with automated rows marked only from current evidence and every real Windows/hardware row as `NOT RUN`. Include exact fields for Windows version, display, scanner, printer, release/base SHA, installer hash, current/target version, last successful check, outbox count, and result. Do not insert example credentials or production identifiers.

Update the roadmap item 08 to distinguish implemented beta channel from pending stable/AuthentiCode/hardware acceptance only after the corresponding code exists.

- [ ] **Step 4: Run docs, format, and secret scans**

```bash
pnpm test:station-release:contract
pnpm exec prettier --check \
  docs/runbooks/station-beta-release.md \
  docs/acceptance/station-beta-release.md \
  docs/hardware-acceptance-checklist.md \
  apps/station/README.md \
  docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md
rg -n 'ghp_|github_pat_|TAURI_SIGNING_PRIVATE_KEY=|pairing code:|api[_ -]?key:' \
  docs/runbooks/station-beta-release.md docs/acceptance/station-beta-release.md
```

Expected: tests and formatting PASS; `rg` returns no matches.

- [ ] **Step 5: Commit Task 8**

```bash
git add apps/station/README.md docs/runbooks/station-beta-release.md \
  docs/acceptance/station-beta-release.md docs/hardware-acceptance-checklist.md \
  docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md \
  tools/station-release/test/docs.test.mjs
git diff --cached --check
git commit -m "docs(station): add beta release runbook"
```

---

### Task 9: Final automated gates, review, PR, and first-beta activation checkpoint

**Files:**

- Review all files changed by Tasks 1–8.
- Update: `docs/acceptance/station-beta-release.md` with automated results only.

**Interfaces:**

- Produces a reviewable PR with no release dispatched from an unmerged branch.
- Produces a post-merge activation checklist; actual GitHub beta publication happens only from `main`.

- [ ] **Step 1: Run the full relevant verification matrix from a clean tree**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/db build
pnpm test:station-release:contract
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
pnpm test:production-bundle:contract
pnpm format:check
git diff --check origin/main...HEAD
```

Expected: all PASS. Record exact counts and any intentional skips. A host Cargo pass is not Windows or hardware evidence.

- [ ] **Step 2: Re-run the complete fixed-viewport browser matrix**

Run the committed station acceptance harness for all gallery fixtures/locales at 1280x800, 1024x768, and 1280x1024.

Expected: zero page/nested scrolling, zero clipped interactives, zero sub-64 px floor actions, bundled fonts, and no runtime visual asset network dependency. Record browser evidence separately from hardware.

- [ ] **Step 3: Perform a security and release transaction review**

Inspect:

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- .github/workflows tools/station-release apps/station/src-tauri
git grep -n -E 'ghp_|github_pat_|TAURI_SIGNING_PRIVATE_KEY=|BEGIN (RSA|OPENSSH|PRIVATE) KEY' origin/main..HEAD -- . ':!pnpm-lock.yaml'
```

Verify exact workflow permissions, pinned actions, no arbitrary ref/version/domain, no force operation, immutable version assets, channel-last order, cleanup ownership, signature validation, and no plaintext signing material. The secret grep must return no matches.

- [ ] **Step 4: Update automated acceptance evidence and commit**

Mark only commands actually run as PASS. Leave Windows packaged install, SmartScreen, beta.1-to-beta.2 updater, rollback, scanner, printer, sound, gloves, offline/reconnect, restart, and pending-data cases as `NOT RUN`.

```bash
git add docs/acceptance/station-beta-release.md
git diff --cached --check
git commit -m "test(station): record beta release evidence"
```

- [ ] **Step 5: Request code review and address every accepted finding with focused tests**

Use `superpowers:requesting-code-review`. Review against the approved spec, especially release partial states, Tauri resource cleanup, StrictMode/single-flight behavior, update persistence, active-shift denial, rollback compatibility, and secret handling. For each accepted finding, add a RED test, implement the smallest fix, rerun its package gates, and commit a scoped fix.

- [ ] **Step 6: Push the branch and open a PR against `main`**

```bash
git status --short
git push -u origin codex/station-beta-release
gh pr create --base main --head codex/station-beta-release \
  --title "feat(station): add signed beta releases and manual updates" \
  --body-file /tmp/markiro-station-beta-pr.md
```

The PR body lists behavior, files/areas, exact automated results, browser evidence, external checks not run, signing backup confirmation, and the post-merge beta.1 activation steps. It contains no secrets.

- [ ] **Step 7: After merge, verify main CI before any release dispatch**

Identify the exact merge SHA and wait for `ci.yml`, CodeQL, dependency review, and Windows station build to succeed. Re-check `https://admin.markiro.app/health` and verify the endpoint returns healthy without capturing credentials.

Expected: all required checks green for the exact merge SHA and production health OK.

- [ ] **Step 8: Obtain explicit publication confirmation, then dispatch beta.1**

Before creating public release state, present the exact merge SHA, computed target `0.1.0-beta.1`, unsigned-installer warning, key-backup status, and checks. After owner confirmation:

```bash
gh workflow run station-beta-release.yml --ref main \
  -f mode=publish \
  -f bump=next-beta
```

Wait for completion. Verify the immutable tag/release, asset hashes, signature, channel manifest, and version URLs independently. Do not call beta.1 physically accepted.

- [ ] **Step 9: Hand off beta.1 physical installation, then publish beta.2 for updater acceptance**

The owner installs beta.1 and completes the documented first-install/hardware steps. Only after beta.1 is confirmed installed, dispatch `next-beta` again to produce beta.2. Follow `docs/acceptance/station-beta-release.md` for discovery, no-auto-download, active-shift denial, manual update, data/outbox survival, and manual beta.1 rollback.

Expected final status is one of:

- `beta published, physical update acceptance pending`;
- `beta updater accepted on recorded Windows/hardware`;
- `beta acceptance failed` with exact non-secret evidence and no claim of completion.

---

## Plan self-review checklist

- Every approved spec requirement maps to Tasks 1–9.
- Stable delivery remains an extension; channel separation is implemented now.
- Release publication cannot run from the feature branch and requires an exact green `main` SHA.
- The signing key has a concrete interactive provisioning and backup gate; no fake key is permitted.
- Version, manifest, workflow, runtime, persistence, UI, documentation, Windows build, browser, and physical acceptance have separate tests/statuses.
- Type/interface names are consistent between producer and consumer tasks.
- The plan contains no implementation placeholder accepted as code; human/external gates are explicit and blocking.
