# Markiro Station Stable Release Flow

**Date:** 2026-08-20

**Status:** approved for implementation planning

**Scope:** Windows x64 stable releases for Markiro Station, promotion from an
accepted beta, a dedicated stable updater channel, release changelogs, manual
installation, rollback, and release acceptance

## Context

Markiro Station already has a protected manual beta publisher. It builds an
exact `main` revision as a signed Tauri updater bundle and Windows NSIS
installer, publishes an immutable prerelease such as
`station-v0.1.0-beta.19`, and promotes
`station-beta-channel/latest.json` only after the versioned release verifies.
Installed beta clients remain bound to that beta channel.

A stable release cannot be created by renaming beta assets. The application
version and embedded updater endpoint are part of the packaged binary. Stable
must therefore rebuild the exact product source accepted in beta with a stable
version and `station-stable-channel` endpoint. This preserves the distinction
between beta and stable clients without introducing a runtime channel switch.

The Windows installer does not yet have Authenticode signing. Stable releases
are allowed for controlled manual distribution with an explicit unknown
publisher and SmartScreen warning. Tauri updater signing remains mandatory and
protects updater integrity, but it does not establish a Windows publisher.

## Goals

- Promote only an explicitly selected and accepted immutable station beta.
- Rebuild the accepted beta source as the corresponding stable SemVer version.
- Keep beta and stable updater channels independent.
- Publish immutable stable installers, updater bundles, signatures, checksums,
  release evidence, and hybrid changelogs.
- Preserve the existing manual-only update policy and active-shift guard.
- Make channel-promotion failures recoverable without mutating a versioned
  release.
- Preserve station configuration and durable operational data across manual
  beta-to-stable installation, stable updates, and rollback.
- Keep automated evidence separate from Windows and physical-hardware
  acceptance.

## Non-goals

- Automatically declaring the newest beta stable.
- Building stable from unaccepted current `main` instead of the selected beta.
- Relabeling or copying beta binaries as stable binaries.
- A runtime beta/stable channel selector.
- Automatic download, install, restart, forced update, or production lockout.
- Automatic downgrade or remote rollback.
- Authenticode signing in the first stable-release slice.
- Linux, ARM, MSI, Microsoft Store, or managed-enterprise distribution.
- Treating CI, browser tests, or GitHub publication as physical line
  acceptance.

## Release model

### Separate orchestration with shared release primitives

A new manual workflow, `.github/workflows/station-stable-release.yml`, owns
stable publication. The existing beta workflow retains its current inputs,
channel, environment, and behavior.

Both workflows use channel-aware release modules for canonical tag parsing,
source-version mutation, artifact naming and validation, updater manifest
generation, checksums, evidence, and changelog sanitization. Stable-specific
orchestration remains separate so a stable change cannot silently alter the
tested beta transaction.

The stable workflow uses:

- GitHub Environment `station-stable`, with no required reviewers;
- a dedicated `station-stable-release` concurrency group with
  `cancel-in-progress: false`;
- the same Tauri signing keypair as beta, copied into the stable environment;
- only `actions: read` and `contents: write` job permissions;
- `VITE_STATION_API_URL=https://admin.markiro.app`;
- a Windows-hosted build job for Windows x64 NSIS and updater artifacts.

The environment isolates stable deployments, signing secrets, and history even
though it does not require approval by a second user. A repository collaborator
with Actions permission initiates each release manually.

### Workflow inputs

The workflow accepts these inputs:

| Input                  | Type          | Required | Meaning                                                               |
| ---------------------- | ------------- | -------- | --------------------------------------------------------------------- |
| `mode`                 | closed choice | yes      | `publish` or `promote-existing`                                       |
| `source_beta_tag`      | string        | yes      | exact canonical tag such as `station-v0.1.0-beta.19`                  |
| `acceptance_confirmed` | boolean       | yes      | explicit owner confirmation of beta acceptance and known limitations  |
| `highlights`           | string        | no       | short curated release highlights placed above the generated changelog |

`source_beta_tag` is never inferred from the newest prerelease. It must match
the canonical station beta grammar exactly. `acceptance_confirmed` must be
`true` for both publication and channel-recovery modes. The evidence records
the confirmation as an operator assertion, not as proof that hardware checks
ran.

`highlights` may be empty. When present, it has a conservative UTF-8 byte limit,
rejects control characters and secret-like text, is handled as data rather than
shell syntax, and is written through a bounded temporary file. It is not
evaluated or interpolated into commands.

## Selecting and verifying the accepted beta

The publisher resolves `source_beta_tag` through GitHub Releases and verifies
all of the following before creating stable source:

1. The tag is canonical and includes a positive `beta.N` prerelease.
2. The release exists, is published, is marked Pre-release, and is not a draft.
3. The release tag resolves to the same immutable release commit described by
   its evidence.
4. Every required beta asset downloads into a fresh bounded directory.
5. Asset names, sizes, SHA-256 values, updater signature, manifest version,
   platform URL, publication date, `baseSha`, and `releaseSha` pass the existing
   release validators.
6. `baseSha` is a 40-character commit reachable from current `main`.
7. The repository CI workflow completed successfully for that exact `baseSha`.
8. The beta release commit differs from `baseSha` only by the deterministic
   beta version changes allowed by the beta publisher.
9. The beta `baseSha` already contains the reviewed stable Tauri build overlay
   and stable-release tooling introduced by this project.

This makes the selected beta evidence the authorization boundary and its
`baseSha` the product-source boundary. A newer commit on `main` cannot enter the
stable build accidentally. Consequently, a beta published before the stable
flow lands cannot become the first stable release; one new beta from the merged
stable-flow baseline must be published and accepted first.

## Stable versioning and source identity

The target stable version is derived by removing the beta suffix:

| Accepted beta   | Stable result |
| --------------- | ------------- |
| `0.1.0-beta.19` | `0.1.0`       |
| `0.1.1-beta.4`  | `0.1.1`       |
| `0.2.0-beta.3`  | `0.2.0`       |

The workflow has no free-form target-version input. It rejects promotion when:

- the matching stable tag or release already exists;
- the derived version is not newer than the highest canonical station stable
  version;
- the selected beta base version is older than or equal to the current stable;
- a malformed or unrelated station-like tag would affect ordering;
- any candidate branch, tag, release, or asset collision is present.

For `publish`, the workflow checks out the verified `baseSha` and creates a
local release commit whose parent is that exact base. The commit changes only:

- the version in `apps/station/src-tauri/tauri.conf.json`, when it differs;
- the version in `apps/station/src-tauri/Cargo.toml`, when it differs.

The stable updater endpoint lives in a reviewed, committed stable Tauri config
overlay. The workflow selects that fixed overlay for the build and validates
the merged effective config; it never generates an untracked endpoint config
from workflow input. If the derived stable version already equals both source
versions, the owned stable release commit is intentionally empty. This gives
the stable tag a unique audited release identity without pretending that the
accepted product source changed.

The release tree must verify as product-equivalent to the accepted beta tree
after normalizing the beta/stable version and updater endpoint fields. The
stable tag points to this stable release commit. `main` is not changed by the
release workflow.

## Updater channels and GitHub Releases

### Immutable stable releases

Each stable version has:

- tag `station-v<stable-version>`, for example `station-v0.1.0`;
- title `Markiro Station <stable-version>`;
- a normal GitHub Release, not a Pre-release and not a draft after
  finalization;
- immutable versioned assets and notes;
- no overwrite or force-push path.

GitHub's ordinary latest-release behavior may therefore resolve to the newest
versioned stable release.

### Mutable stable channel

A service release/tag named `station-stable-channel` is marked Pre-release and
owns only the current stable `latest.json`:

```text
https://github.com/thevladbog/markiro/releases/download/station-stable-channel/latest.json
```

The Pre-release flag prevents this mutable service release from becoming
GitHub's normal latest stable release. Its manifest points only to immutable
assets under the selected `station-v<stable-version>` release. Version,
publication date, Windows x64 URL, filename, and signature must match the
versioned release exactly.

Beta builds continue to embed
`station-beta-channel/latest.json`. Stable builds embed only the stable endpoint.
No client-side preference, environment variable, remote flag, or persisted
setting can switch channels at runtime.

## Build outputs and release evidence

Stable publishes the same bounded Windows x64 artifact set as beta, with a
stable version:

- NSIS installer for first installation, beta-to-stable transition, and manual
  rollback;
- Tauri Windows updater bundle;
- updater signature;
- versioned `latest.json`;
- `SHA256SUMS` covering installer, updater bundle, signature, and manifest;
- `release-notes.md`;
- `release-evidence.json`.

The stable artifact validator accepts canonical stable SemVer and rejects beta
or other prerelease versions. It computes and compares hashes for every
declared binary and manifest, validates evidence keys and values, and rejects
extra files, unsafe names, symlinks, oversized files, malformed dates, future
dates, unexpected hosts, non-HTTPS URLs, and secret-like text.

Stable evidence includes:

- stable version and publication time;
- selected beta tag, beta version, beta release SHA, and beta evidence digest;
- accepted product `baseSha` and stable `releaseSha`;
- `acceptanceConfirmed: true`;
- previous stable version and base SHA when one exists;
- changelog start and end SHAs;
- stable asset SHA-256 values;
- channel name and endpoint identity;
- `authenticode: false` and a physical-acceptance status.

## Hybrid changelog

Release notes combine optional curated highlights with deterministic generated
history.

For the first stable release, the generated section says that this is the first
stable release, names the selected beta, and summarizes the accepted beta line.
Its range starts at the parent of the earliest verified beta `baseSha` in the
same `major.minor.patch` line and ends at the selected beta's `baseSha`. If that
parent is unavailable, the earliest beta `baseSha` is named as the baseline and
the generated list starts after it. For later releases, the range starts at the
previous stable release's `baseSha` and ends at the selected beta's `baseSha`.

The generator uses merged PR titles when GitHub supplies a complete,
unambiguous range and falls back to commit subjects from the verified Git
history. The generated list includes changes whose file set intersects the
explicit Station release scope maintained by the release tooling: Station,
Station release workflows and tools, Station runbooks, Station SQLite code, and
server or shared-package changes accompanied by a Station consumer or Station
test change. The full repository compare URL remains available for excluded
monorepo work. It groups included entries into Russian sections:

- **Что нового** for product-facing `feat` changes;
- **Исправления** for `fix` changes;
- **Прочие изменения** for remaining meaningful merged work.

It excludes deterministic station version-preparation commits, release
candidate commits, merge noise already represented by a PR title, and duplicate
entries. Ordering is deterministic. The notes include a full GitHub compare URL
even when a category is empty.

When `highlights` is non-empty, a **Главное в релизе** section appears before
the generated groups. Omitting highlights never blocks publication and does not
create an empty heading. Human-facing release notes and generated section copy
are Russian. Machine-readable evidence keys, versions, SHAs, hashes, and URLs
remain language-neutral.

The final notes also state the previous stable version, selected beta, stable
version, base and release SHAs, lack of Authenticode, acceptance assertion, and
manual installation and rollback boundaries.

## Release transaction and recovery

### Publish mode

The transaction is ordered as follows:

1. Validate inputs, current `main`, selected beta, acceptance assertion,
   signing environment presence, and remote release state.
2. Download and fully verify the selected beta release and evidence.
3. Resolve the stable version, previous stable release, and changelog range;
   reject every collision or non-monotonic transition.
4. Create and verify the stable release tree from beta `baseSha`.
5. Install locked dependencies and run release and Station gates.
6. Verify the production API origin and Windows Tauri CORS surface.
7. Build signed updater and NSIS artifacts on Windows.
8. Generate changelog, notes, evidence, manifest, and checksums in a new bounded
   staging directory.
9. Validate the complete staged release and scan text artifacts for secret-like
   content.
10. Create a draft versioned release and upload exact staged assets.
11. Download all uploaded assets into another new directory and repeat release
    validation and hash comparison.
12. Finalize the immutable normal stable release and its tag without overwriting
    any existing object.
13. Replace and download-verify
    `station-stable-channel/latest.json` only after the versioned release is
    complete.
14. Emit a concise job summary with release URL, source beta, stable version,
    SHAs, hashes, changelog range, and channel status.

The implementation must use the GitHub-supported tag and draft-release order
that preserves source identity. It may use an owned temporary candidate ref,
but always cleans it and never force-pushes.

### Promote-existing mode

This mode performs no build and modifies no versioned release. It derives the
stable version from `source_beta_tag`, then verifies:

- the selected beta and acceptance assertion;
- the existing stable tag, release flags, source tree, and complete assets;
- all hashes, signature, manifest, evidence, beta provenance, and changelog
  metadata;
- absence of a newer stable release that would make the requested promotion a
  downgrade.

Only then may it replace the stable channel manifest. It downloads the new
channel asset and compares it byte-for-byte with the verified versioned
manifest.

If channel upload or verification fails, the workflow restores the previous
manifest when one existed. A versioned stable release that published before a
channel failure remains valid and immutable; the job reports "published, not
promoted" for an explicit `promote-existing` retry.

## Signing and secret handling

Beta and stable use the same Tauri updater keypair so the embedded public key
and updater trust chain do not rotate. The private key and password are copied
into the protected `station-stable` Environment under the existing secret
names. Only the public key remains committed.

The workflow normalizes and validates the private key before build, writes it
to a mode-restricted temporary file, and deletes that file through failure-safe
cleanup. Secret values never appear in command arguments, output files,
release notes, artifact names, evidence, job summaries, or debug logs.

The signing key backup and recovery obligations from the beta runbook continue
to apply. Stable publication is not a signing-key rotation event.

Stable NSIS and executable files are not Authenticode-signed in this slice.
Every release notes file and manual-installation instruction states this. A
future Authenticode project may add publisher signing without changing the
stable updater channel or Tauri key.

## Installed application behavior

Stable retains the current updater policy:

- an automatic check after the shell and SQLite are ready, no more often than
  once per 24 hours;
- an explicit manual check that bypasses the throttle;
- one in-flight check;
- no automatic download, install, restart, or work interruption;
- installation disabled during an active shift;
- informational reminders below 7 days, persistent yellow reminders from 7
  through 29 days, and prominent red reminders from 30 days;
- reminder color accompanied by text and shape/icon, never a production block;
- durable outbox warning without destructive cleanup;
- retryable network, manifest, download, signature, and install failures.

The only behavioral difference is the embedded stable channel endpoint. The UI
does not need a new channel selector or a separate stable update state model.

## Installation, migration, and rollback

An installed beta moves to stable only when an operator manually installs the
stable NSIS over it. The application identifier and Tauri data directory remain
unchanged. The acceptance procedure verifies preservation of:

- pairing identity and credentials;
- station SQLite database and migrations;
- active and historical operational state allowed by the install guard;
- scanner and printer configuration;
- scan journal, open and closed box state, exceptions, and outbox;
- updater check history where compatible.

After transition, stable checks only the stable channel. Returning to beta
requires a manual beta installer and is an explicit operator procedure, not a
runtime toggle.

The updater accepts only newer versions. Stable rollback uses a retained older
immutable NSIS installer. Every stable release remains downloadable. Schema
changes must stay compatible with the documented rollback window or explicitly
block and document rollback before release; deleting local state is never a
rollback strategy.

## Failure handling and security invariants

- A failure before immutable publication leaves the current stable channel and
  releases untouched.
- A failure after immutable publication but before channel promotion leaves the
  prior channel authoritative and reports an explicit recovery mode.
- No retry overwrites a versioned tag, release, asset, or evidence file.
- A selected beta cannot supply arbitrary URLs, filenames, shell text, or
  repository identity.
- Only the fixed Markiro repository and exact versioned release URL pattern are
  accepted.
- Source provenance follows beta evidence to a CI-successful commit on `main`.
- Changelog text and operator highlights are untrusted data and never enter
  shell evaluation.
- Stable publication does not change production API authorization, tenant
  isolation, Station credentials, or offline data contracts.
- Logs and summaries contain no secrets, pairing codes, raw badge/PIN values,
  API keys, or private signing material.

## Automated verification

### Version and provenance contracts

- canonical stable and beta tag parsing;
- beta suffix removal for patch and minor lines;
- safe SemVer ordering and monotonic stable promotion;
- malformed, unrelated, duplicate, equal, downgrade, and collision rejection;
- exact selected-beta release flags and asset inventory;
- beta evidence hashes and `baseSha`/`releaseSha` verification;
- accepted product source equivalence after normalizing version and channel;
- successful CI for the exact beta `baseSha`.

### Changelog contracts

- first-stable behavior;
- previous-stable to selected-beta base SHA range;
- deterministic grouping, ordering, de-duplication, and release-commit
  exclusion;
- compare URL construction;
- optional empty highlights;
- bounded, sanitized highlights and secret-like text rejection;
- fallback behavior when GitHub PR metadata is unavailable or incomplete.

### Workflow and artifact contracts

- manual-only trigger and closed inputs;
- `station-stable` environment, minimum permissions, and dedicated
  non-canceling concurrency;
- exact production API origin and stable updater endpoint;
- common signing key inputs without job-wide secret exposure;
- channel-aware artifact and manifest validation;
- ordinary immutable stable release plus Pre-release service channel;
- channel-last ordering, backup, byte verification, and recovery;
- `publish` and `promote-existing` behavior;
- no force-push, overwrite of immutable assets, self-hosted runner, elevated
  token permission, or secret output.

### Required package gates

- focused `tools/station-release` tests;
- complete station-release contract suite;
- `pnpm --filter @markiro/station test`;
- Station typecheck, lint, and build;
- affected `@markiro/db` tests/typecheck/lint/build if persistence contracts
  change;
- `cargo test --manifest-path apps/station/src-tauri/Cargo.toml`;
- Windows x64 Tauri/NSIS CI build;
- relevant format checks and `git diff --check`.

Automated checks do not prove Windows SmartScreen behavior, packaged WebView2,
scanner, printer, sound, fullscreen, power recovery, or physical-device update
acceptance.

## Stable acceptance

The first stable acceptance uses the exact beta selected by the workflow:

1. Record the selected beta tag, installer hash, beta evidence, Windows version,
   target station, and known hardware limitations without recording secrets.
2. Confirm the beta acceptance or explicitly document which physical checks the
   owner accepts as pending.
3. Publish stable through the protected workflow.
4. Verify the stable installer hash and the expected unknown-publisher path.
5. Install stable manually over beta while no shift is active.
6. Verify the stable version and stable updater endpoint.
7. Verify pairing, station configuration, SQLite, scanner, printer, journal,
   boxes, exceptions, and pending outbox retention.
8. Exercise offline work, reconnect, restart, printing, scanning, and recovery.
9. For the next stable version, verify stable-to-stable discovery without
   automatic download or restart, the active-shift install guard, explicit
   installation, and post-restart data retention.
10. Exercise manual rollback with the preceding immutable stable installer when
    its schema compatibility window permits it.

Before physical steps pass, the release status is "stable artifacts published;
physical acceptance pending." Publication alone is not evidence of line
readiness.

## Documentation changes

Implementation updates:

- a stable release runbook covering environment setup, source beta selection,
  inputs, changelog, publish, recovery, unsigned installation, rollback, and
  key backup;
- Station README channel and beta-to-stable transition guidance;
- hardware acceptance checklist cases for beta-to-stable and stable-to-stable;
- release-contract documentation for both mutable channels;
- release notes that link the acceptance checklist without exposing secrets.

The existing beta runbook remains beta-specific and links to the stable runbook
for promotion rather than duplicating stable procedures.

## Completion criteria

The stable flow is complete when:

- an accepted beta can deterministically produce the corresponding immutable
  stable release without including newer `main` work;
- beta and stable clients remain on separate updater channels;
- hybrid changelog and provenance evidence verify against exact source ranges;
- a channel failure can be recovered with `promote-existing` without mutating
  the versioned release;
- all automated gates pass;
- environment setup and operator procedures are documented;
- the first packaged Windows acceptance is recorded separately and honestly.
