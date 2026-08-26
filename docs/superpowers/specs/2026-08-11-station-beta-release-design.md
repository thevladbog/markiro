# Markiro Station Beta Releases and Manual Updater

**Date:** 2026-08-11

**Status:** approved for implementation planning

**Scope:** Windows x64 line-station beta build, GitHub release channel, manual
Tauri updates, and release acceptance

## Context

The line station is already implemented as a Tauri 2 Windows application and
CI builds an NSIS installer. The current delivery path is not a release path:
CI does not publish the installer, the application version is fixed at
`0.1.0`, the updater is only a skeleton, and no GitHub Releases exist. The
installer will not have a Windows Authenticode signature during the beta, so
Windows can show an unknown-publisher or SmartScreen warning.

Automated and browser acceptance does not replace physical acceptance. The
existing station UI and Rust suites have passed previously, but the packaged
application still needs real Windows, scanner, printer, sound, offline,
restart, and update testing.

The first delivery is an internal beta tested by the owner against the
production API. It is not a general production rollout.

## Goals

- Produce a reproducible Windows x64 NSIS installer from an exact `main`
  commit.
- Publish immutable, versioned beta releases in the public Markiro GitHub
  repository.
- Let an installed station discover, download, and install an update only
  after explicit operator action.
- Keep update discovery non-blocking and safe during offline line operation.
- Preserve station configuration, SQLite data, scan journal, and outbox across
  update, restart, and manual rollback.
- Make beta version increments convenient through a manual workflow dropdown.
- Establish channel boundaries that can later support stable releases without
  migrating already installed beta clients.
- Record automated release evidence separately from real Windows and hardware
  acceptance.

## Non-goals

- Windows Authenticode signing or removal of SmartScreen warnings.
- Automatic download, automatic installation, forced restart, or a minimum
  supported-version block.
- Shipping a stable channel in this slice.
- A dedicated release domain, CDN, Object Storage bucket, or release API.
- Linux, ARM, MSI, Microsoft Store, or managed-enterprise deployment targets.
- Silent remote administration of a station.
- Treating CI or browser results as physical line acceptance.

## Release architecture

### Source and release identity

A new manual GitHub Actions workflow, `station-beta-release.yml`, is the only
beta publisher. It can run only from `refs/heads/main`; the dispatch SHA is the
exact base source revision. Before building, the workflow verifies that the
base SHA belongs to `main` and that the repository's CI workflow completed
successfully for that SHA.

The workflow accepts a closed `bump` choice:

| Choice            | Example result                   |
| ----------------- | -------------------------------- |
| `next-beta`       | `0.1.0-beta.1` -> `0.1.0-beta.2` |
| `next-patch-beta` | `0.1.0-beta.2` -> `0.1.1-beta.1` |
| `next-minor-beta` | `0.1.1-beta.3` -> `0.2.0-beta.1` |

The current released version comes from the highest valid immutable tag whose
full name matches `station-v<semver>`. Near-matches, stable versions, malformed
versions, tags from another application, and untrusted user text do not enter
the calculation. With no station tag, `next-beta` produces
`0.1.0-beta.1`.

The workflow updates the version in both `apps/station/src-tauri/tauri.conf.json`
and `apps/station/src-tauri/Cargo.toml`, verifies that they match exactly, and
creates a local release commit with the selected `main` SHA as its parent. The
release commit contains only those deterministic version changes. The station
is built and tested from that exact tree. Only after all required checks pass
does the workflow push the immutable `station-v<version>` tag, which transfers
the release commit and makes the exact released source retrievable without
changing `main`.

An existing version or tag is never overwritten. A failed or incorrect release
is followed by a new version.

### Production API binding

The beta is built with:

```text
VITE_STATION_API_URL=https://admin.markiro.app
```

The value is a build-time constant and is validated as an exact HTTPS origin
without path, query, fragment, userinfo, or trailing slash. Fresh pairing uses
this origin. The production deployment currently serves the admin and station
API routes from the same origin. Beta testing uses a dedicated test tenant and
station identity; it does not weaken tenant or device isolation.

The workflow must not silently fall back to localhost or an absent value.

### Build outputs

The initial target is Windows x64. Tauri produces:

- an NSIS installer for first installation and manual rollback;
- the Windows updater bundle required by Tauri;
- the Tauri signature associated with the updater bundle;
- a channel `latest.json` in the standard Tauri updater format;
- a SHA-256 checksum file covering every published binary and manifest;
- generated release notes containing the version, base `main` SHA, release
  commit SHA, publication time, installation warning, and acceptance status.

The application bundle enables updater artifacts explicitly. The embedded
updater configuration contains a beta-specific endpoint and a fixed public
Tauri signing key.

## GitHub release channels

### Immutable versioned releases

Each beta has:

- tag `station-v<version>`;
- title `Markiro Station <version> - Internal Beta`;
- the GitHub Pre-release flag;
- immutable versioned assets;
- installation and rollback notes that state that Authenticode is absent.

Versioned releases are never used as mutable channel pointers.

### Mutable beta pointer

GitHub's normal `latest` endpoint excludes releases marked Pre-release and
cannot independently serve future beta and stable channels. Therefore the
station does not use `/releases/latest/download/latest.json`.

A service release/tag named `station-beta-channel` owns only the current beta
`latest.json`. The application reads this stable URL:

```text
https://github.com/thevladbog/markiro-station-releases/releases/download/station-beta-channel/latest.json
```

The manifest points to immutable assets on the versioned beta release. Its
`version`, `pub_date`, platform URL, and signature must exactly match the
versioned release.

The publisher creates and verifies the complete versioned release before it
replaces the beta channel manifest. If the new build, upload, verification, or
publication fails, the existing channel manifest remains authoritative. A
channel-update failure does not delete or mutate the prior versioned release;
the workflow reports the version as published but not promoted and can safely
retry only the promotion step after re-verification.

The same layout later permits `station-stable-channel` and a `promote-stable`
version action without changing beta clients. Stable implementation remains
out of scope for this slice.

## Signing and secret ownership

Tauri updater signing is mandatory even though Authenticode is unavailable.
These signatures protect the updater bundle; they do not make Windows display
a verified publisher.

- Generate a dedicated station updater keypair.
- Commit only the public key in Tauri configuration.
- Store the private key and its password in the protected GitHub Environment
  `station-beta`.
- Restrict the release job to that environment and minimum `contents: write`
  permission; all other permissions are read-only or absent.
- Never pass private key material in command-line arguments, artifact names,
  release notes, captured output, or debug logs.
- Keep an encrypted offline backup of the private key and password outside
  GitHub. The owner must verify recovery from that backup before the first
  beta is considered operationally releasable.

Losing the private key without a backup strands existing clients on the
embedded public key. Key rotation therefore requires an update signed by the
old key before any release signed only by the new key.

## Station update behavior

### Check policy

Update discovery is separate from operational sync and hardware status. It
must never stop scanning, printing, shift work, or outbox delivery.

The station checks:

- after application startup, once SQLite initialization and the main shell are
  ready;
- automatically no more than once in any 24-hour period;
- whenever an operator explicitly selects `Check for updates`.

A manual check bypasses the 24-hour automatic throttle. Only one check may be
in flight. Application shutdown cancels the in-flight UI operation without
changing operational data.

The station stores a small validated JSON update record in `station_meta`. It
contains the last attempt time, last successful check time, and, when an
update exists, its version and publication time. It does not store a private
download credential, arbitrary HTML, or unbounded release notes. Malformed or
future records fail closed to an empty update state without affecting the
station database or line workflow.

A network, GitHub, manifest, clock, or signature error is visible only in the
updates surface together with the last successful check time. It is not a
line alarm and does not clear a previously known valid update.

### Age indicators

When a newer valid beta is known, age is calculated from its signed channel
manifest `pub_date` against current time:

| Release age       | Presentation                 |
| ----------------- | ---------------------------- |
| less than 7 days  | calm informational indicator |
| 7 through 29 days | persistent yellow reminder   |
| 30 days or more   | prominent red warning        |

An invalid or future `pub_date` is treated as update metadata failure rather
than as a negative age. Color is always accompanied by icon/shape and text.
No age level disables station work.

### Manual installation

Discovery never downloads or installs by itself. The update details surface
contains an explicit `Download and install` action. Tauri's download/install
API is called only from that user action and only after a confirmation that
names the current and target versions.

The install action is disabled while a shift is active. Checking and showing
the reminder remain available during a shift. After the operator exits the
shift, installation can proceed even when an outbox is pending because the
outbox is durable and must survive restart. The confirmation shows the pending
record count when it is non-zero.

Download or signature failure returns to a retryable update state. The station
does not discard the local database, credentials, hardware configuration, scan
journal, boxes, exceptions, or outbox. The application restarts only as part
of an explicitly confirmed successful install.

### Rollback

The updater accepts only versions newer than the running application. It does
not provide automatic downgrade or rollback.

Every versioned beta retains its NSIS installer. Manual rollback uses the
installer from an older immutable release. Install, update, reinstall, and
manual rollback must leave the Tauri application data directory and station
SQLite database intact. Schema changes introduced by later station releases
must remain compatible with the documented rollback window or explicitly
block and document rollback before release; deleting local data is not a
rollback mechanism.

## Release transaction and failure handling

The publishing workflow follows this order:

1. Resolve and validate the dispatch SHA, successful CI run, prior station
   version, requested bump, target version, and absence of collisions.
2. Create the local release commit and verify the two source versions.
3. Install from the committed lockfile and run focused station gates.
4. Build the Windows x64 NSIS and updater artifacts with the production API
   origin and Tauri signing environment.
5. Generate release notes, manifest, signatures, and checksums in a fresh
   bounded staging directory.
6. Verify filenames, sizes, hashes, version metadata, URLs, platform entry,
   signature, and that no secret-like content appears in text artifacts.
7. Create a draft versioned release and upload the exact staged files.
8. Download the uploaded files into a new directory and repeat structural,
   hash, and signature verification.
9. Publish the immutable versioned Pre-release and push its immutable tag.
   The implementation must order these operations so neither a public release
   nor a tag can silently point at different source; a failed finalization is
   reported for explicit retry, never repaired by force-push.
10. Replace the `station-beta-channel/latest.json` asset and download it again
    to verify it points only to the just-published immutable release.
11. Emit a concise release summary with URLs, SHAs, hashes, and channel status.

The implementation plan must settle the exact tag-versus-release finalization
sequence supported by GitHub's APIs while preserving the invariant that no
existing tag or versioned asset is overwritten. It may use a draft release and
delayed channel promotion, but it may not use force-push or expose a channel
manifest before its target assets are complete.

Concurrent beta release runs are serialized by one workflow concurrency group
without canceling the active publisher. A retry re-resolves remote state and
fails on unexpected partial state rather than guessing ownership.

## Automated verification

### Versioning and workflow contracts

- initial version and each dropdown transition;
- SemVer prerelease ordering and malformed-tag rejection;
- stable-tag exclusion from beta increment calculation;
- collision and repeat-publication denial;
- exact `main` and successful-CI provenance;
- exact production API build variable;
- minimum workflow permissions, environment use, concurrency, bounded paths,
  and no secret output;
- immutable versioned release plus channel-last publication order;
- exact manifest URL, version, publication time, platform URL, and signature.

### Station behavior

- no automatic check before the shell/database is ready;
- startup check, 24-hour throttle, manual bypass, and single-flight behavior;
- no-update, update-available, offline/error, malformed metadata, future date,
  and persisted-state recovery;
- informational, yellow, and red boundaries at 7 and 30 days;
- color plus text/icon semantics and touch-sized controls;
- download/install invoked only by an explicit confirmed action;
- install disabled during an active shift;
- pending-outbox warning without destructive cleanup;
- local update state and all operational SQLite data survive restart;
- RU and EN dictionaries remain in lockstep.

### Required repository gates

- focused updater and release-contract tests;
- `pnpm --filter @markiro/station test`;
- station typecheck, lint, and build;
- affected `@markiro/db` tests/build if persistence helpers or schema contracts
  change;
- `cargo test --manifest-path apps/station/src-tauri/Cargo.toml`;
- Windows x64 Tauri/NSIS build in GitHub Actions;
- `git diff --check` and relevant format checks.

Automated tests do not prove SmartScreen, packaged WebView behavior, physical
hardware, or a real update between installed versions.

## Real beta acceptance

The first end-to-end updater acceptance requires two releases.

1. Publish and manually install `0.1.0-beta.1` on the target Windows station.
2. Record Windows version, display, station/release/base SHAs, installer hash,
   and the exact SmartScreen/unknown-publisher path.
3. Pair with a dedicated production test tenant and station identity.
4. Exercise fullscreen, touch/gloves, scanner, printer, sound,
   offline/reconnect, restart, and pending-data recovery using the existing
   hardware checklist.
5. Publish `0.1.0-beta.2` through the same workflow.
6. Confirm that beta.1 discovers beta.2 but does not download, install, or
   restart automatically.
7. Confirm that installation is unavailable during an active shift.
8. Exit the shift, start manual installation, and verify the signed update and
   explicit restart.
9. Confirm version, pairing/configuration, hardware configuration, SQLite
   data, scan journal, boxes, exceptions, and pending outbox after restart.
10. Manually install beta.1 to exercise the documented rollback path and
    re-check retained data.
11. Record all results in a station release acceptance document and update the
    hardware checklist with exact PASS/FAIL/NOT RUN evidence.

Before those steps, the honest status is `beta built and published by automated
gates`; it is not `validated on a real line`.

## Documentation and operator guidance

Implementation updates:

- `apps/station/README.md` with version, channel, manual-update, API-origin,
  signing, install, and rollback behavior;
- a release runbook covering environment secrets, offline key backup,
  dropdown semantics, retries, partial publication, and channel promotion;
- the hardware acceptance checklist with beta.1-to-beta.2 update cases;
- release notes with the unsigned-installer warning and a link to the
  acceptance checklist.

No passwords, signing keys, activation URLs, pairing codes, API keys, or other
station credentials may appear in documentation or recorded acceptance.

## Future stable channel

The stable extension adds a `promote-stable` transition, immutable stable
releases, and `station-stable-channel/latest.json`. Stable clients embed only
the stable channel endpoint; beta clients remain on beta. Promotion must build
or select an exact reviewed source revision and pass its own release gates.
The design does not assume that a beta binary can simply be relabeled stable.
