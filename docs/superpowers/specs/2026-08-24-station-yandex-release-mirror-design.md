# Markiro Station Yandex Release Origin and GitHub Mirror

**Date:** 2026-08-24

**Status:** approved for implementation planning

**Scope:** Windows x64 beta and stable Station installers, Tauri update
manifests and bundles, a primary Yandex-hosted release origin, a GitHub
fallback mirror, migration of existing GitHub-only installations, release
publication, recovery, and acceptance

## Context

Markiro Station currently publishes signed Windows installers and Tauri updater
artifacts only through GitHub Releases. Beta clients embed the mutable
`station-beta-channel/latest.json` GitHub URL. Stable clients use the equivalent
`station-stable-channel/latest.json` URL through the stable Tauri configuration
overlay. The release toolkit also requires every updater bundle URL to belong to
the repository's GitHub Releases namespace.

This makes GitHub a runtime dependency for both first installation and every
update check and download. Some customer and factory networks block GitHub or
its release-delivery network, so a successfully published Station version may
be unreachable even while the Markiro production service is healthy.

The existing release properties remain valuable and must not be weakened:

- GitHub Actions builds the Windows binary from a verified source revision;
- a single Tauri keypair signs updater artifacts;
- beta and stable are independent fixed channels;
- versioned releases are immutable by workflow contract;
- stable is rebuilt only from an explicitly selected and accepted beta source;
- installation remains manual and is prohibited during an active shift;
- automated publication evidence remains distinct from physical Windows,
  scanner, printer, touch, and offline acceptance.

The delivery origin changes. The build authority and accepted-beta provenance
do not.

## Decision summary

- Keep GitHub Actions as the Windows build, signing, and release orchestrator.
- Add a dedicated public Yandex Object Storage bucket as the primary Station
  release origin.
- Serve it over HTTPS at `releases.markiro.app` through Yandex Cloud CDN,
  Certificate Manager, and Cloud DNS.
- Keep GitHub Releases as a complete fallback mirror.
- Publish the same signed binaries to both origins and generate origin-specific
  manifests, checksums, and evidence around them.
- Make initial stable installation available at
  `https://releases.markiro.app/station/download` and explicit beta installation
  at `https://releases.markiro.app/station/beta/download`.
- Replace the direct JavaScript use of the Tauri updater with a narrow Station
  Rust adapter that can fall back during both metadata checks and package
  downloads without accepting a caller-controlled URL.
- Migrate GitHub-reachable installations through a transitional beta. Use one
  manual install-over from `releases.markiro.app` for installations whose
  embedded GitHub-only endpoint is already blocked.

## Goals

- Remove GitHub from the primary user path for first installation and updates.
- Preserve GitHub as a useful fallback when Yandex is unavailable and GitHub is
  reachable from the station network.
- Publish one build to two origins without allowing their signed binaries,
  version, source identity, or channel to diverge.
- Prevent a partially uploaded release from becoming visible through either
  mutable updater channel.
- Preserve beta and stable provenance, manual update controls, station data,
  offline continuity, and rollback boundaries.
- Make publication and recovery testable without claiming that automated tests
  prove Windows or hardware behavior.

## Non-goals

- Moving Windows builds, Tauri signing, source hosting, or CI away from GitHub.
- Removing GitHub Releases or the current versioned release tags.
- Adding a runtime beta/stable channel selector.
- Allowing an operator, tenant, webview, environment variable, or remote API to
  supply an updater URL.
- Automatic download, installation, restart, downgrade, forced update, or line
  lockout.
- Adding a Station download button or other new call to action to the public
  landing site in this project.
- Adding Authenticode signing or removing the Windows SmartScreen warning.
- Linux, macOS, ARM, MSI, Microsoft Store, or managed-enterprise distribution.
- Treating CDN availability, CI publication, or signature verification as
  physical workstation acceptance.
- Making release objects confidential. Installers, manifests, signatures,
  checksums, notes, and bounded release evidence are intentionally public.

## Target architecture

### Build and publication boundary

GitHub Actions remains the only beta and stable publisher. It builds and signs
one canonical Windows x64 artifact set:

- NSIS installer;
- Tauri updater bundle;
- Tauri updater signature;
- release notes and source/provenance inputs.

The publisher derives two distribution trees from that one staged set:

1. a Yandex tree whose manifest points to the immutable
   `releases.markiro.app` bundle;
2. a GitHub tree whose manifest points to the immutable versioned GitHub
   Release asset.

The binary bytes and updater signature must be identical across both trees.
Origin-dependent metadata is allowed to differ only where the public URL or a
digest of origin-dependent metadata requires it.

The API, production application VM, and Caddy deployment do not proxy release
downloads. An application outage therefore does not remove access to Station
installers or update manifests.

### Yandex release infrastructure

The Yandex production Terraform stack owns dedicated release resources:

- one globally unique Station release bucket;
- Object Storage versioning enabled;
- `force_destroy = false` and Terraform `prevent_destroy = true`;
- anonymous object reads enabled;
- anonymous bucket listing and configuration reads disabled;
- no automatic expiration of current or immutable versioned release objects;
- a dedicated release-publisher service account and S3-compatible access key;
- a bucket policy limited to required object operations in this bucket;
- Yandex Cloud CDN distribution with the bucket as its origin;
- a Certificate Manager certificate valid for `releases.markiro.app`;
- a managed DNS record connecting `releases.markiro.app` to the HTTPS
  distribution surface.

The existing private media, audit, and Terraform-state buckets are neither
reused nor granted to the release publisher. The application runtime service
account receives no access to the release bucket. Public readers cannot write,
delete, list, or inspect bucket configuration.

The publisher may replace the small channel objects and download aliases. S3
`PutObject` permission cannot by itself distinguish creation from replacement,
so immutable-path protection is a release-tooling contract backed by collision
checks, no delete permission, bucket versioning, public read-back verification,
and audit evidence. This project does not claim WORM or Object Lock semantics.

### Credentials and ownership

The release-publisher access key and secret live only in the protected
`station-beta` and `station-stable` GitHub Environments. They are not repository
secrets available to unrelated jobs. Both environments may reference the same
dedicated release-publisher identity, but no other workload receives that
identity.

Workflow steps must not print credentials, place them in command arguments,
write them into release material, or upload them as Actions artifacts. Bounded
temporary credential configuration is removed in an `always()` cleanup step.
The environment continues to hold the Tauri signing key separately from the S3
publisher key.

## Public object model

### Paths

Yandex stores beta objects under:

```text
/station/beta/releases/<beta-version>/...
/station/beta/latest.json
/station/beta/download
```

Stable uses:

```text
/station/stable/releases/<stable-version>/...
/station/stable/latest.json
/station/download
```

Examples:

```text
/station/beta/releases/0.1.0-beta.23/markiro-station-0.1.0-beta.23-windows-x86_64-setup.exe
/station/beta/releases/0.1.0-beta.23/markiro-station-0.1.0-beta.23-windows-x86_64.nsis.zip
/station/beta/releases/0.1.0-beta.23/markiro-station-0.1.0-beta.23-windows-x86_64.nsis.zip.sig
/station/beta/releases/0.1.0-beta.23/latest.json
/station/beta/releases/0.1.0-beta.23/SHA256SUMS
/station/beta/releases/0.1.0-beta.23/release-evidence.json
/station/beta/releases/0.1.0-beta.23/release-notes.md
```

Canonical filenames continue to come from the Station release toolkit. The
path version must equal the version encoded in filenames, manifest, evidence,
source, and release tag.

### Immutable releases and mutable aliases

Every object below `releases/<version>/` is immutable by release contract. A
pre-existing key, unexpected object, non-canonical name, or mismatched public
object aborts publication. Retrying an already published version never uploads
or replaces its immutable objects.

Each channel has one mutable `latest.json`. The stable download alias
`/station/download` contains the current stable NSIS bytes with an attachment
filename that contains the stable version. `/station/beta/download` does the
same for the current beta. The publisher creates these aliases through a
server-side copy from the already verified immutable installer; it does not
upload another local binary.

Bucket versioning and an explicit pre-promotion backup make mutable objects
recoverable. Their prior versions are retained according to a deliberate
channel-recovery policy, not the media-bucket lifecycle policy.

### Cache policy

Immutable version objects use long-lived immutable caching. Mutable objects use
a policy that forces revalidation and prevents a CDN from retaining an old
channel or installer alias as an unbounded cache entry:

- `releases/<version>/*`: public long max-age plus `immutable`;
- channel `latest.json`: `no-cache` or an equivalently strict revalidation
  policy;
- `download` aliases: no-cache/revalidation and explicit attachment metadata.

Publication validation checks the public response status, content length where
known, content type, content disposition for aliases, cache metadata, and exact
downloaded bytes. A successful Object Storage API write is not sufficient.

## Origin-specific metadata

### Two manifests for one release

The Yandex and GitHub `latest.json` files intentionally differ in the updater
bundle URL:

- the Yandex manifest uses the immutable `releases.markiro.app` URL;
- the GitHub manifest uses the immutable versioned GitHub Release URL.

They must otherwise agree on:

- channel and version;
- canonical publication timestamp;
- Windows x64 target identity;
- updater filename;
- Tauri signature;
- source and release provenance represented in evidence.

The mutable channel pointer on each origin must be byte-identical to that
origin's immutable version manifest. Cross-origin manifest byte identity is no
longer an invariant because their URLs differ.

### Checksums and evidence

Because `latest.json` differs, its digest and any checksum or evidence document
covering it also differ. Each origin receives an origin-specific
`SHA256SUMS` and `release-evidence.json`.

Both evidence files record a common release identity and equal hashes for the
installer, updater bundle, signature, and release notes. They additionally
record:

- `origin`: `yandex` or `github`;
- exact channel and version base URL;
- origin manifest SHA-256;
- origin checksum-file SHA-256 where the schema includes it;
- the common installer, updater bundle, and signature SHA-256 values;
- beta or stable source provenance already required by the current workflow;
- the peer origin identity and the assertion that common binary hashes match.

The validator compares the two validated trees and rejects any cross-origin
difference outside the explicit origin-dependent fields. It does not normalize
arbitrary JSON or ignore unknown keys.

## Publication transaction

### Preconditions

The existing beta or stable workflow first performs all current source,
version, CI, CORS, accepted-beta, signing, changelog, and collision checks. It
then verifies that the release bucket, public HTTPS domain, and credentials are
present and correspond to the expected environment.

Infrastructure creation and DNS exposure are separate protected infrastructure
changes. Release workflows never create or reconfigure buckets, CDN resources,
certificates, DNS records, service accounts, or access keys.

### Publish mode

Publication follows this order:

1. Build and sign the common Windows artifact set once.
2. Generate isolated Yandex and GitHub metadata trees from that set.
3. Validate each tree and the cross-origin equality contract locally.
4. Publish the immutable versioned GitHub Release using the current protected
   draft/finalization transaction.
5. Upload the immutable Yandex version prefix only after proving every target
   key is absent.
6. Download all GitHub assets and all Yandex objects through their public HTTPS
   URLs into separate new directories.
7. Re-run per-origin structural, signature, size, hash, provenance, and secret
   scans, then re-run the cross-origin comparison.
8. Save bounded backups of the current GitHub channel manifest, Yandex channel
   manifest, and the relevant Yandex download alias.
9. Promote the GitHub channel manifest first and verify it publicly.
10. Promote the Yandex channel manifest and verify it publicly.
11. Server-side-copy the verified immutable Yandex installer to the relevant
    download alias and verify its public bytes and response metadata.
12. Emit a release summary naming both origins, both manifest hashes, common
    binary hashes, source identity, promotion results, and remaining external
    acceptance.

If a mutable update or its public verification fails, the workflow restores
every mutable object already changed in this transaction and verifies the
restored state. The immutable version may remain published but is reported as
not promoted. It is never deleted, overwritten, or silently presented as a
complete channel release.

### Promote-existing mode

Promotion recovery does not rebuild or modify immutable assets. It downloads
and validates both existing immutable origin trees, verifies their common
release identity, takes new mutable backups, and repeats only the coordinated
channel and alias promotion.

It must not:

- infer a different beta, stable, or newest version;
- upload a missing immutable object;
- repair mismatched binary bytes by copying one origin over the other;
- overwrite a tag, versioned GitHub asset, or Yandex release-prefix object;
- bypass accepted-beta provenance for stable.

A missing or invalid immutable origin requires a new explicitly authorized
recovery operation outside `promote-existing`.

## Station updater behavior

### Why a Station adapter is required

`tauri-plugin-updater` 2.10.1 iterates configured endpoints while checking
metadata, but after accepting one valid manifest its update handle contains one
download URL. A package download failure does not make that handle retry the
next endpoint.

The Station requirement is full fallback for both manifest and package
delivery. A narrow Rust adapter therefore owns origin selection while retaining
the Tauri plugin's manifest model, public-key verification, updater signature
verification, and installer implementation.

### Fixed origin contract

Beta and stable builds each contain exactly two reviewed HTTPS endpoints in
order:

1. `releases.markiro.app` for their fixed channel;
2. the existing GitHub Releases service channel for the same fixed channel.

The webview invokes semantic operations such as check, download, install, and
close. It never supplies a URL, channel, target, public key, signature, or
allow-downgrade flag. The Rust adapter maps an internal origin enum to compiled
configuration and rejects unknown origin state.

Beta remains beta-only and stable remains stable-only. No persisted preference,
remote setting, environment variable, command-line flag, or operator action can
cross the channel boundary.

### Update check

The adapter checks the Yandex endpoint first.

- A valid Yandex manifest is authoritative.
- A valid Yandex response that declares no newer version ends the check without
  consulting GitHub.
- A Yandex network failure, timeout, unsuccessful HTTP status, malformed JSON,
  or unsupported response shape permits a GitHub metadata check.
- If GitHub also fails, the check returns a retryable availability error.
- A newer update must still pass the existing version, target, publication-date,
  and downgrade checks before it is persisted or shown.

The controller keeps the previous valid known-update state when both origins
are temporarily unavailable. Checking remains non-blocking and never affects
scanning, printing, local journals, outbox delivery, or shift work.

### Download and install

Installation remains an explicit operator action and remains disabled during
an active shift.

At install time the adapter rechecks the selected target, starting with Yandex,
and requires exact equality of version, target, publication date, and Tauri
signature with the update the operator accepted. It downloads and verifies the
package before invoking the installer.

Fallback from a Yandex package download to GitHub is allowed only when:

- the failure is classified as network, timeout, or unsuccessful HTTP response;
- no installer process has started;
- the primary update handle has been closed and its temporary material cleaned;
- the GitHub manifest announces the exact accepted version, target,
  publication date, and signature;
- downgrade remains disabled.

Fallback is forbidden for:

- Tauri signature or other integrity failure;
- metadata or selected-target mismatch;
- unsupported platform or target;
- local filesystem, permission, or installer failure;
- any failure after installation begins;
- an active shift.

After a successful verified download, the adapter invokes installation once.
It never tries the same installer through a second origin after installation
has started or returned an ambiguous result.

Every update resource is closed on success, cancellation, fallback, component
unmount, and failure. Progress events remain bounded and do not contain URLs,
headers, credentials, or release notes.

### Operator-facing state

Normal use remains unchanged: no automatic download, installation, restart, or
line block is introduced.

When fallback succeeds, the update surface may show calm informational copy:

> Основной сервер обновлений недоступен, используется резервный.

When both origins fail, the surface reports that the update could not be
checked or downloaded and offers a retry. It also makes clear that Station can
continue working. Origin hostnames and low-level errors may be recorded in
bounded local diagnostics, but secret-bearing request data is not.

Integrity or metadata mismatch is reported distinctly from temporary
unavailability. It does not silently fall back or become a routine line alarm.

## First installation and channel policy

### Default stable installation

`https://releases.markiro.app/station/download` is the canonical new-install
URL and always serves the current promoted stable NSIS installer. Its content
disposition includes the exact stable version filename.

Beta remains available only by the explicit
`https://releases.markiro.app/station/beta/download` URL. The release domain
does not infer a channel from cookies, query strings, client state, or referrer.

This project prepares and verifies those URLs but does not add or change a
landing-page download button.

### Migration of existing installations

Already installed Station binaries know only their embedded GitHub endpoint.
No server-side change can teach a client a new origin if that client cannot
reach GitHub.

The migration therefore uses one transitional beta containing the dual-origin
adapter:

- GitHub-reachable beta installations receive it through the existing updater;
- a GitHub-blocked installation downloads the transitional NSIS installer from
  the explicit Yandex beta URL and installs it over the existing application;
- the identifier remains `app.markiro.station` and the established application
  data directory remains unchanged;
- SQLite, station identity, pairing configuration, hardware configuration,
  journals, boxes, exceptions, and outbox data must survive the install-over and
  restart.

Beta-to-stable remains a manual install-over as defined by the stable release
contract. Once stable is installed, it checks only the stable Yandex and GitHub
endpoints.

GitHub channel assets remain available for the supported legacy-client horizon.
This design does not schedule their removal.

## Failure and recovery behavior

| Condition                                                      | Required behavior                                                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| GitHub blocked, Yandex healthy                                 | Installation, check, and download use Yandex without degradation.                                        |
| Yandex manifest unavailable                                    | Metadata check falls back to GitHub.                                                                     |
| Yandex manifest valid, package request fails before install    | Adapter verifies the exact target through GitHub and downloads the mirror.                               |
| Yandex reports no update                                       | Do not consult GitHub; Yandex is authoritative.                                                          |
| Both origins unavailable                                       | Keep the installed version and operational data; show a retryable update error only.                     |
| Origins announce different version, date, target, or signature | Stop with metadata/integrity error; do not install.                                                      |
| Signature verification fails                                   | Stop; do not fall back or start installation.                                                            |
| Publication fails before channel promotion                     | Existing channel and aliases remain unchanged.                                                           |
| Publication fails during mutable promotion                     | Restore and publicly verify all mutable objects changed by the transaction.                              |
| Immutable release exists but is not promoted                   | Retain it, report it explicitly, and use verified `promote-existing` recovery.                           |
| Channel pointer is rolled back                                 | Not-yet-updated clients see the prior version; already updated clients are not downgraded automatically. |

Manual downgrade uses a compatible immutable installer and the existing rollback
window. Removing SQLite or other station data is never a rollback mechanism.

## Rollout

### Phase 1: provision without traffic migration

Add the release bucket, publisher identity, HTTPS distribution, certificate,
DNS record, Terraform outputs, protected environment inventory, and public
smoke checks. Do not change Station endpoints or current GitHub publication.

The infrastructure plan and live apply remain separate approval-bearing
operations. A Terraform plan or resource creation is not proof that the public
domain, TLS, cache policy, or anonymous object behavior works.

### Phase 2: dual-publish tooling

Make the release toolkit origin-aware, add cross-origin validation, and extend
both workflows to publish and verify immutable objects on both origins. Keep
existing Station clients GitHub-only while release owners validate publication,
promotion recovery, and public downloads.

### Phase 3: transitional beta

Merge the reviewed Station adapter and dual endpoint configurations, then
publish a new beta through the dual-origin workflow. Do not retrofit an old
immutable beta.

Accept the transition on a real Windows station in both paths:

- updater from the previous GitHub-only beta where GitHub is reachable;
- manual install-over from the Yandex beta URL where GitHub is blocked.

Exercise Yandex-primary checks, manifest fallback, package fallback, restart,
offline continuity, and preservation of durable station state.

### Phase 4: first dual-origin stable

Only after the transitional beta is explicitly accepted may it be selected by
the stable workflow. The stable publisher rebuilds the accepted beta source
with the stable version and fixed stable dual-origin configuration, then
publishes and verifies both origins before promoting stable pointers and the
default download alias.

No newer `main` revision enters that stable build. The first stable is not
declared hardware-accepted merely because both origins serve valid files.

## Automated verification

### Release toolkit

Focused Node tests cover:

- canonical Yandex and GitHub URLs for beta and stable;
- origin-specific manifest, checksum, and evidence generation;
- equality of common binary hashes and rejection of any other cross-origin
  drift;
- canonical paths, names, bounded files, regular-file and symlink checks;
- immutable-key collision and unexpected-object rejection;
- mutable backup, coordinated promotion, partial-failure rollback, and public
  read-back verification;
- `promote-existing` changing only mutable pointers and aliases;
- cache and content-disposition metadata;
- sanitization of notes, evidence, job summaries, and error output.

The existing Station release contract suite remains the package-level gate and
is extended rather than replaced.

### Infrastructure

Yandex infrastructure contracts cover:

- a release bucket distinct from state, media, and audit buckets;
- versioning, `force_destroy = false`, and `prevent_destroy`;
- public object read with list and configuration reads denied;
- publisher identity permissions limited to the release bucket;
- application runtime denied release-bucket mutation authority;
- CDN origin, custom hostname, certificate, and DNS wiring;
- required GitHub Environment variables and secrets without exposing values;
- production plan guards and runbook inventory.

Public smoke checks verify HTTPS, certificate hostname, channel response and
cache metadata, bounded installer response, and exact public content. They must
not upload or promote a production channel outside the protected release
workflow.

### Rust updater adapter

Tests use bounded local HTTP fixtures and signed fixture artifacts to cover:

- Yandex metadata success without a GitHub request;
- Yandex no-update response without a GitHub request;
- Yandex metadata network, timeout, HTTP, and parse failure followed by GitHub;
- primary package network or HTTP failure followed by an exact GitHub mirror;
- both origins unavailable;
- mirror version, date, target, or signature mismatch;
- corrupt signature with no fallback;
- unsupported target with no install;
- handle and temporary-material cleanup on every terminal path;
- exactly one installer invocation and no fallback after it begins.

Tests must exercise the pinned `tauri-plugin-updater` contract rather than a
handwritten assumed interface.

### Station UI and state

Vitest coverage verifies:

- fallback copy and retry behavior;
- distinct availability and integrity errors;
- active-shift install denial;
- no automatic download, install, restart, or channel change;
- previous valid update state retained across transient dual-origin failure;
- download progress and resource cleanup;
- current data, outbox, and update-state semantics remain independent.

Final automated gates include the Station focused suites, package test,
typecheck, lint, build, Station release contract, Cargo tests, Yandex
infrastructure contracts, production bundle contracts where affected,
formatting, and `git diff --check`.

## Manual and external acceptance

Automated evidence does not replace these checks on a real supported Windows
workstation:

- GitHub-only beta to transitional beta through the old updater;
- manual transitional beta install-over with GitHub blocked;
- beta-to-beta update through Yandex;
- beta-to-beta package fallback with Yandex package delivery interrupted;
- accepted beta to stable manual install-over;
- stable-to-stable update through Yandex and through fallback;
- application version, station identity, pairing, SQLite schema and contents,
  hardware configuration, boxes, exceptions, journal, outbox, and pending data
  preserved after each install and restart;
- active-shift install denial;
- offline shift continuity before and after the update;
- scanner, printer, touch, sound, fullscreen, taskbar, and installed icon;
- SmartScreen and unknown-publisher behavior recorded separately because Tauri
  signing is not Authenticode;
- public download from representative customer networks where GitHub is
  blocked.

Every result is recorded as `PASS`, `FAIL`, or `NOT RUN`. CI success, public
HTTP success, or downloaded-artifact validation cannot mark a physical item as
passed.

## Documentation and affected areas

Implementation is expected to affect these areas while avoiding unrelated
refactors:

- `infra/yandex/` and its infrastructure contracts;
- `.github/workflows/station-beta-release.yml`;
- `.github/workflows/station-stable-release.yml`;
- `tools/station-release/` and its contract tests;
- beta and stable Tauri configuration;
- a focused Rust updater adapter under `apps/station/src-tauri/`;
- the TypeScript updater port/controller and focused Station tests;
- Station beta/stable runbooks and acceptance records;
- production environment inventory and bounded public smoke checks.

The public landing implementation is not changed. Documentation may name the
canonical download URL without adding a new landing CTA.

## Acceptance criteria

The project is complete only when all of the following are true:

1. A beta release builds once and publishes verified immutable artifacts to
   Yandex and GitHub with identical signed binaries.
2. `releases.markiro.app` serves valid HTTPS beta and stable channel structures
   without involving the Markiro API or application VM.
3. The stable default and explicit beta download aliases serve the exact
   promoted immutable installers.
4. A Station checks and downloads from Yandex by default and completes a
   controlled GitHub fallback for both metadata and pre-install package network
   failure.
5. Integrity, target, and installer-state failures never trigger unsafe
   fallback.
6. A partial publication cannot expose an incomplete release through a mutable
   channel or leave mutable origins divergent without a failed, visible, and
   recoverable workflow result.
7. Existing GitHub-only clients have a documented and accepted automatic or
   one-time manual migration path.
8. Beta and stable channel identity, accepted-beta provenance, manual install,
   active-shift denial, and no-downgrade policies remain intact.
9. Automated gates pass and real Windows/hardware items are reported separately
   with no inferred acceptance.

## Explicit completion boundary

This specification authorizes design and implementation planning only. Writing
or committing it does not create Yandex resources, issue a certificate, change
DNS, add GitHub secrets, publish a Station version, move a channel, or perform
Windows/hardware acceptance. Those external changes occur only through their
reviewed implementation steps and protected workflows.
