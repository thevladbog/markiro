# Handheld release flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get a signed ТСД build onto a customer's terminals, repeatably, with
the device able to tell that a newer build exists — direct distribution only, no
app store.

**Architecture:** The station's release shape, transplanted to Android. One
immutable object per version plus a mutable channel pointer in the same Yandex
Object Storage bucket the station already publishes to, served from
`releases.markiro.app`. A dispatch-gated workflow builds, signs, proves the
signature, publishes, and only then moves the pointer. The app reads the channel
manifest, compares `versionCode`, and offers the operator a one-tap install —
Android cannot update itself unattended without device-owner rights, so the
operator's confirmation is part of the design, not a gap in it.

**Tech Stack:** Kotlin 2.2, AGP 8.11.1, Gradle 8.14.3, GitHub Actions, Yandex
Object Storage (S3 API), Node scripts under `tools/`.

## Global Constraints

- `minSdk = 28`, `targetSdk/compileSdk = 35`. Gradle project at `apps/handheld`,
  outside the pnpm workspace. CI job `handheld-android`.
- **The release signing key can never change.** Android identifies an app by its
  signature: a rebuilt or lost key means every installed terminal must be
  uninstalled and re-paired, losing queued scans. The key lives only in the
  `handheld-release` environment and on the owner's offline copy.
- **`versionCode` must grow and is never reused.** It is what the installer
  compares; `versionName` is only shown to people.
- Distribution is **direct only** (decided 2026-09-12). No RuStore, no Google
  Play. Nothing in this plan may assume a store is reachable from a terminal.
- Publication and deployment are separate acts from merging, per
  [AGENTS.md](../../../AGENTS.md). A workflow run is dispatched by the owner, not
  triggered by a merge.
- Every artifact the app will install must be reachable offline-tolerant: a
  terminal on factory Wi-Fi may lose the network mid-download and must resume or
  fail cleanly, never half-install.

## Prerequisites the owner must do first

Not code, and nothing below runs without them:

- [ ] Create the `handheld-release` GitHub environment.
- [ ] Generate the release keystore with `keytool` (command in
      [apps/handheld/README.md](../../../apps/handheld/README.md), section
      «Релизная сборка и подпись»). Never done by an agent: it takes passwords.
- [ ] Add `MARKIRO_HANDHELD_KEYSTORE_BASE64`, `MARKIRO_HANDHELD_STORE_PASSWORD`,
      `MARKIRO_HANDHELD_KEY_ALIAS`, `MARKIRO_HANDHELD_KEY_PASSWORD` to it.
- [ ] Store the `.jks` and its passwords offline, in two places.

## Status

Tasks 1–4 are implemented (`tools/handheld-release/`, wired into
`.github/workflows/handheld-release.yml`). Tasks 5–9 are not started.

## What already exists

`.github/workflows/handheld-release.yml` (PR #521) builds, signs, proves the
signature with `apksigner verify`, and uploads the APK as a run artifact. It
stops there on purpose. This plan continues from that artifact.

---

### Task 1: Decide and pin the release manifest

**Files:**

- Create: `tools/handheld-release/manifest.mjs`
- Test: `tools/handheld-release/test/manifest.test.mjs`

**Interfaces:**

- Produces: `buildManifest({ versionName, versionCode, sha256, bytes, url, notes, releasedAt, sourceSha })` and `parseManifest(text)`, which throws on anything it does not recognise.

The manifest is the contract between the workflow and the app, and both sides
must refuse a malformed one rather than guess.

- [x] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, parseManifest } from "../manifest.mjs";

test("a manifest round-trips and pins every field the installer needs", () => {
  const manifest = buildManifest({
    versionName: "0.2.0",
    versionCode: 2,
    sha256: "a".repeat(64),
    bytes: 67_000_000,
    url: "https://releases.markiro.app/handheld/stable/0.2.0/markiro-tsd-0.2.0.apk",
    notes: "Первая раздача",
    releasedAt: "2026-09-12T10:00:00.000Z",
    sourceSha: "b".repeat(40),
  });
  assert.deepEqual(parseManifest(JSON.stringify(manifest)), manifest);
});

test("a manifest without a digest is refused", () => {
  assert.throws(() => parseManifest(JSON.stringify({ versionCode: 2, versionName: "0.2.0" })));
});

test("a versionCode that is not a positive int32 is refused", () => {
  for (const bad of [0, -1, 2 ** 31, 1.5, "2"]) {
    assert.throws(() => buildManifest({ versionCode: bad }), undefined, `accepted ${bad}`);
  }
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `node --test tools/handheld-release/test/manifest.test.mjs`
Expected: FAIL, `Cannot find module '../manifest.mjs'`.

- [x] **Step 3: Implement `manifest.mjs`**

A plain object, validated field by field. `url` must be `https:` and under the
release origin. `sha256` is 64 lowercase hex. `bytes` is a positive integer.
`sourceSha` is 40 hex — it is what ties an installed build back to a commit.

- [x] **Step 4: Run the test to green.**
- [x] **Step 5: Commit** — `feat(handheld-release): pin the update manifest contract`.

---

### Task 2: Refuse a versionCode that does not grow

**Files:**

- Modify: `tools/handheld-release/manifest.mjs`
- Test: `tools/handheld-release/test/manifest.test.mjs`

**Interfaces:**

- Produces: `assertSupersedes(previousManifestTextOrNull, next)`.

The dispatcher types `version_code` by hand. A repeat or a decrease produces an
APK that no installed terminal will accept, and nothing today notices until a
device refuses it in a factory.

- [x] **Step 1: Write the failing test**

```js
test("publishing must raise the versionCode", () => {
  const published = JSON.stringify(buildManifest({ versionCode: 5 /* … */ }));
  assert.doesNotThrow(() => assertSupersedes(published, buildManifest({ versionCode: 6 })));
  for (const bad of [5, 4]) {
    assert.throws(() => assertSupersedes(published, buildManifest({ versionCode: bad })));
  }
});

test("the first release supersedes nothing", () => {
  assert.doesNotThrow(() => assertSupersedes(null, buildManifest({ versionCode: 1 })));
});
```

- [x] **Step 2–4:** fail, implement, green.
- [x] **Step 5: Commit.**

---

### Task 3: Publish to object storage

**Files:**

- Create: `tools/handheld-release/publish.mjs`
- Test: `tools/handheld-release/test/publish.test.mjs`
- Read first: `tools/station-release/object-storage.mjs` (key shapes, size caps)

**Interfaces:**

- Consumes: `buildManifest`, `assertSupersedes` from Tasks 1–2.
- Produces: `publish({ apkPath, manifest, channel, s3 })`.

Layout, mirroring the station's:

| key                                                              | mutability              |
| ---------------------------------------------------------------- | ----------------------- |
| `handheld/<channel>/<versionName>/markiro-tsd-<versionName>.apk` | immutable               |
| `handheld/<channel>/<versionName>/manifest.json`                 | immutable               |
| `handheld/<channel>/latest.json`                                 | the pointer, moved last |

- [x] **Step 1: Write the failing test** with a fake S3 client recording puts.
      Assert: the APK and its immutable manifest are written **before**
      `latest.json`, and that a failure writing either leaves `latest.json`
      untouched. A pointer moved first would send every terminal to a 404.
- [x] **Step 2: Run it and watch it fail.**
- [x] **Step 3: Implement**, refusing to overwrite an existing immutable key.
- [x] **Step 4: Green.**
- [x] **Step 5: Commit.**

---

### Task 4: Wire publication into the release workflow

**Files:**

- Modify: `.github/workflows/handheld-release.yml`
- Modify: `apps/handheld/README.md`

- [x] **Step 1:** Add a `publish` input (`false` by default) so the workflow can
      still produce an artifact without publishing. A release that only builds is
      the safe default.
- [x] **Step 2:** After «Prove the artifact is signed», add a step that fetches
      the current `latest.json`, runs `assertSupersedes`, then `publish.mjs`.
- [x] **Step 3:** Publish credentials come from the `handheld-release`
      environment, never from repo-wide secrets. Reuse the station publisher's
      key only if it is scoped to the same bucket; otherwise the owner adds a new
      one.
- [x] **Step 4:** Print the published URL and sha256 into the job summary.
- [x] **Step 5: Commit.**

**Owner step, once:** grant the publisher key write access to the `handheld/`
prefix (`infra/yandex/modules/station-releases/`, wired in
`infra/yandex/production/main.tf`). Terraform change, applied by the owner.

---

### Task 5: The device learns an update exists

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/update/UpdateCheck.kt`
- Create: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/update/UpdateCheckTest.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/settings/SettingsScreens.kt`

**Interfaces:**

- Produces: `suspend fun check(): UpdateState` — `UpToDate`, `Available(manifest)`, or `Unknown(reason)`.

Read-only first: the app learns and reports, it does not download yet. This is
shippable on its own and is what turns «какая у вас версия?» into something the
operator can answer.

- [ ] **Step 1: Write the failing tests** with MockWebServer: a newer
      `versionCode` gives `Available`; an equal or lower one gives `UpToDate`; a
      malformed manifest and an unreachable host both give `Unknown` **and never
      throw** — a failed update check must not touch the work screen.
- [ ] **Step 2–4:** fail, implement, green.
- [ ] **Step 5:** Show it in Settings → «Об устройстве», beside the version.
- [ ] **Step 6: Commit.**

---

### Task 6: One-tap install

**Files:**

- Modify: `apps/handheld/app/src/main/AndroidManifest.xml` (add
  `REQUEST_INSTALL_PACKAGES`, a `FileProvider`)
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/update/UpdateInstaller.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/update/UpdateInstallerTest.kt`

**Android reality, stated once:** an app without device-owner rights cannot
install silently. The operator confirms the system dialogue. Anything else needs
the vendor's MDM (Honeywell Enterprise Provisioner and equivalents), which is a
customer-side decision and out of scope here.

- [ ] **Step 1: Write the failing test:** a download whose sha256 does not match
      the manifest is **deleted and never handed to the installer**. This is the
      assertion that matters — a truncated APK on factory Wi-Fi must not become
      an install prompt.
- [ ] **Step 2:** Also assert the download resumes or restarts cleanly after an
      interruption, and that a queued outbox is never cleared by an update.
- [ ] **Step 3–4:** implement, green.
- [ ] **Step 5:** Offer it from Settings only — never from the work screen, and
      never while a shift is open with a non-empty queue. Losing queued scans to
      an install is worse than running an old build.
- [ ] **Step 6: Commit.**

---

### Task 7: Release notes an operator can read

**Files:**

- Create: `apps/handheld/CHANGELOG.md`
- Modify: `tools/handheld-release/manifest.mjs` (`notes` sourced from it)
- Test: `tools/handheld-release/test/manifest.test.mjs`

- [ ] **Step 1:** Russian, one line per change, newest first, versioned by
      `versionName`. The station's `tools/station-release/changelog.mjs` is the
      precedent — read it before inventing a format.
- [ ] **Step 2:** The workflow refuses to publish a version with no entry.
- [ ] **Step 3: Commit.**

---

### Task 8: Decide on R8 before the first wide rollout

**Files:**

- Modify: `apps/handheld/app/build.gradle.kts`
- Create: `apps/handheld/app/proguard-rules.pro`

`isMinifyEnabled = false` today and the APK is **67 MB**. Twenty terminals over
one factory Wi-Fi is 1.3 GB per release, and every update after that repeats it.

- [ ] **Step 1:** Enable R8 on a branch, add keep rules for Room, Hilt and
      kotlinx.serialization, and record the size.
- [ ] **Step 2:** Run the full unit suite — it will not catch this. R8 breaks at
      runtime, not at build time.
- [ ] **Step 3: Install on a real terminal and walk a shift end to end:** sign
      in, scan, close a box, print, sync, close the shift. **Do not merge on a
      green build alone.**
- [ ] **Step 4:** If anything is unstable, leave R8 off and record why in the
      build file. A 67 MB APK that works beats a 20 MB one that crashes on a line.

---

### Task 9: Runbook

**Files:**

- Create: `docs/runbooks/handheld-release.md`
- Modify: `apps/handheld/README.md` (link it)

- [ ] **Step 1:** Write the sequence the owner actually performs: pick the
      version, add the changelog entry, dispatch with `publish=true`, verify the
      summary's sha256 against the published object, install on one terminal,
      then tell the customer.
- [ ] **Step 2:** Write the rollback: move `latest.json` back to the previous
      immutable manifest. The old APK is still there — that is why the per-version
      keys are immutable.
- [ ] **Step 3:** Write what to do if the key is lost. There is no recovery;
      the entry exists so nobody discovers that during an incident.
- [ ] **Step 4: Commit.**

---

## Open decisions, deliberately not made here

- **One channel or two.** The station has beta → stable with an acceptance gate.
  With one customer and one terminal, a single `stable` channel is less machinery
  to get wrong; the layout above leaves room for `handheld/beta/` later without
  moving anything. Decide before Task 3 — it is the only task the answer changes.
- **Who tells the operator to update.** The plan makes the device _able_ to know.
  Whether a shift-floor operator should ever decide to install, rather than the
  office pushing via MDM, is a product question that touches how a factory runs.

## Sequencing

Tasks 1–4 give a repeatable publication and are worth doing together; after them
a release exists at a stable URL and the flow is complete from a human's side.
Tasks 5–6 are what make it self-service on the device and can follow separately.
Task 8 should land before the first rollout to more than a handful of terminals.
Tasks 7 and 9 are cheap and pay for themselves the first time someone else runs a
release.
