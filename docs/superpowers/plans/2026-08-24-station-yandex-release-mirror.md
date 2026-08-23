# Markiro Station Yandex Release Origin and GitHub Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `releases.markiro.app` the primary download and update origin for Markiro Station while retaining GitHub Releases as a complete fallback mirror, preserving one signed Windows build, immutable release provenance, manual installation, and recoverable channel promotion.

**Architecture:** Keep GitHub Actions as the sole Windows build and signing authority. Stage two origin-specific metadata trees around one byte-identical installer, updater bundle, and signature; publish immutable objects to GitHub and Yandex before changing either mutable channel; then route Station update checks and pre-install downloads through a fixed-origin Rust adapter that verifies origin agreement and falls back only for eligible transport failures. Provision a dedicated public Yandex release bucket, CDN, certificate, DNS record, and publisher identity without granting any runtime service access.

**Tech Stack:** GitHub Actions, Node.js 24 ESM and `node:test`, pnpm 11, AWS SDK for JavaScript v3 against Yandex Object Storage S3 API, Terraform 1.15/Yandex provider 0.215, Yandex Object Storage/CDN/Certificate Manager/Cloud DNS/IAM, Tauri 2, Rust, TypeScript/React/Vitest, NSIS, SHA-256, and Tauri updater signatures.

**Spec:** `docs/superpowers/specs/2026-08-24-station-yandex-release-mirror-design.md`

## Global Constraints

- GitHub Actions remains the only release orchestrator. Do not add a developer-laptop or production-VM publishing path.
- Build and sign Windows x64 once. The installer, updater bundle, detached signature, version, publication date, source SHAs, and stable provenance must match between origins byte-for-byte where applicable.
- Origin-specific `latest.json`, `SHA256SUMS`, and evidence may differ only because their embedded URLs and their own hashes differ.
- Versioned GitHub assets and Yandex objects are immutable by workflow contract: detect collisions before upload and never overwrite or delete them.
- Mutable promotion order is GitHub channel, Yandex channel, then Yandex installer alias. Back up every mutable object first and restore all changed mutable state if any later promotion or public verification fails.
- Before normal dual-origin promotion is enabled, seed and publicly verify a complete Yandex rollback baseline from an already accepted GitHub release. Normal workflows must refuse to mutate a Yandex channel or installer alias whose backup is absent. This makes first-run rollback possible without granting the publisher delete permission.
- `promote-existing` may repair mutable pointers only after revalidating both immutable origin trees. It must never upload, overwrite, or repair an immutable object.
- Yandex is primary and GitHub is fallback. A valid primary `no update` response is authoritative; do not query GitHub to seek a different version.
- Fallback is allowed only for network/HTTP/metadata parse failures during discovery and network/HTTP failures before installation during package download. Never fall back after signature/integrity failure, local I/O failure, policy denial, or installer launch.
- Publication validation and any package fallback must prove that both origins agree on channel, version, publication date, target, and signature. A valid primary check does not contact GitHub merely to compare metadata.
- Keep updater origins compiled and fixed. The webview, operator, tenant, environment, API, or remote metadata cannot inject an endpoint.
- Preserve manual-only check/download/install/restart behavior, active-shift denial, no automatic downgrade, Station application identity, SQLite data, pairing, settings, journals, exceptions, and outbox.
- The release bucket is intentionally public for object read but not listing or configuration. App VMs and runtime service accounts receive no access. The publisher may put/read/copy only the required release keys and cannot delete objects.
- Do not expose plaintext static-key material in Terraform state, workflow logs, artifacts, command arguments, or repository files. Terraform may emit only a PGP-encrypted publisher secret; a human transfers the decrypted credentials into protected GitHub Environment secrets via stdin.
- Terraform apply, DNS activation, GitHub secret changes, beta/stable publication, and physical Windows rollout are separate approval-bearing external operations. Code completion does not authorize them.
- Automated checks do not prove Yandex public reachability from a restricted factory network, Windows/SmartScreen behavior, WebView2, scanner, printer, touch, install-over data retention, or production-line acceptance.

## File and responsibility map

| File or area                                   | Responsibility                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `tools/station-release/origins.mjs`            | Closed origin/channel URL and object-key model                                                   |
| `tools/station-release/artifacts.mjs`          | Origin-specific staging, evidence, checksums, validation, and cross-origin equality              |
| `tools/station-release/object-storage.mjs`     | Narrow injectable Yandex S3 transport and public read-back                                       |
| `tools/station-release/yandex-publisher.mjs`   | Bounded immutable publication, baseline seeding, mutable backup/promotion/rollback CLI           |
| `tools/station-release/promotion.mjs`          | Dual-origin accepted-beta evidence and stable provenance validation                              |
| `tools/station-release/test/*.test.mjs`        | Artifact, storage, workflow, docs, and adversarial release contracts                             |
| `infra/yandex/modules/station-releases/*`      | Dedicated bucket, CDN, certificate, DNS, publisher identity, and least-privilege policy          |
| `infra/yandex/production/*`                    | Production module wiring, inputs, guarded outputs, and rollout flags                             |
| `infra/yandex/test/infra-contract.test.mjs`    | Isolation, public surface, IAM, state-secret, and no-app-access contracts                        |
| `.github/workflows/yandex-infrastructure.yml`  | Explicit release-infrastructure inputs and guarded apply                                         |
| `.github/workflows/station-beta-release.yml`   | Dual-origin beta build, immutable publish, channel transaction, and recovery                     |
| `.github/workflows/station-stable-release.yml` | Dual-origin stable rebuild from accepted beta and channel transaction                            |
| `apps/station/src-tauri/tauri*.conf.json`      | Ordered primary/fallback channel endpoints and shared updater public key                         |
| `apps/station/src-tauri/src/updater.rs`        | Fixed-origin metadata agreement, download fallback, signature verification, and install boundary |
| `apps/station/src-tauri/src/lib.rs`            | Registration of the narrow updater command surface                                               |
| `apps/station/src/lib/tauri-updater.ts`        | Typed webview adapter for Station-owned Rust commands                                            |
| `apps/station/src/lib/use-station-updater.ts`  | Manual controller state and operator-visible origin/fallback result                              |
| `apps/station/src/pages/UpdateCenter.tsx`      | Non-blocking origin/fallback status in the manual update screen                                  |
| `apps/station/src/i18n/{ru,en}.json`           | Operator copy for primary, fallback, mismatch, and failure states                                |
| `docs/runbooks/station-*.md`                   | Provisioning, secret transfer, seeding, publish, repair, rollback, and migration procedures      |
| `docs/acceptance/station-*.md`                 | Transitional beta, stable, restricted-network, and physical-device evidence                      |

---

### Task 1: Closed origin model and dual release trees

**Files:**

- Create: `tools/station-release/origins.mjs`
- Create: `tools/station-release/test/origins.test.mjs`
- Modify: `tools/station-release/artifacts.mjs`
- Modify: `tools/station-release/test/artifacts.test.mjs`

**Interfaces:**

```ts
type StationReleaseChannel = "beta" | "stable";
type StationReleaseOrigin = "github" | "yandex";

stationReleaseLocation(input: {
  channel: StationReleaseChannel;
  origin: StationReleaseOrigin;
  version: string;
}): {
  origin: StationReleaseOrigin;
  channelUrl: string;
  releaseBaseUrl: string;
  immutablePrefix: string | null;
  mutableManifestKey: string | null;
  mutableInstallerKey: string | null;
};

stageStationRelease(input: ExistingStageInput & {
  origin: StationReleaseOrigin;
}): Promise<StationReleaseEvidence>;

compareStationReleaseOrigins(input: {
  githubDirectory: string;
  yandexDirectory: string;
  channel: StationReleaseChannel;
  version: string;
}): Promise<void>;
```

- GitHub locations remain `https://github.com/thevladbog/markiro/releases/download/<tag>/<asset-name>` and mutable `station-<channel>-channel/latest.json`.
- Yandex locations are exactly `https://releases.markiro.app/station/<channel>/releases/<version>/<asset-name>`; mutable keys are `station/<channel>/latest.json`, with `station/download` and `station/beta/download` installer aliases.
- `stationReleaseLocation` accepts only canonical channel, origin, and version combinations and never accepts a base URL.

- [ ] **Step 1: Add failing origin and cross-tree tests**

Test exact URLs/keys, beta/stable version rejection, no scheme/host/path injection, and a successful pair whose common binary bytes match:

```js
assert.deepEqual(
  stationReleaseLocation({ channel: "beta", origin: "yandex", version: "0.2.0-beta.7" }),
  {
    origin: "yandex",
    channelUrl: "https://releases.markiro.app/station/beta/latest.json",
    releaseBaseUrl: "https://releases.markiro.app/station/beta/releases/0.2.0-beta.7",
    immutablePrefix: "station/beta/releases/0.2.0-beta.7/",
    mutableManifestKey: "station/beta/latest.json",
    mutableInstallerKey: "station/beta/download",
  },
);
```

Assert `compareStationReleaseOrigins` rejects a changed bundle, signature, installer, version, `pub_date`, target, or signature field, while allowing the two canonical bundle URLs and corresponding checksum/evidence digests to differ.

- [ ] **Step 2: Run the focused tests and record RED**

```bash
node --test tools/station-release/test/origins.test.mjs tools/station-release/test/artifacts.test.mjs
```

Expected: FAIL because the origin model and origin-aware staging do not exist.

- [ ] **Step 3: Implement the closed origin table**

Use module constants, canonical version parsers from `version.mjs`, and `URL` construction only after validation. Return frozen value objects. Do not expose a generic URL builder.

- [ ] **Step 4: Make artifact staging origin-aware**

Remove the hard-coded GitHub prefix from `artifacts.mjs`. Add the exact distribution block to beta evidence schema 2 and stable evidence schema 3:

```js
distribution: {
  origin,
  channelUrl: location.channelUrl,
  releaseBaseUrl: location.releaseBaseUrl,
}
```

Keep support for reading the existing GitHub-only beta evidence schema solely for the one-time baseline migration. Require the new dual-origin schema for all newly staged releases and stable promotion candidates.

- [ ] **Step 5: Implement strict cross-origin comparison**

Validate each directory independently, then compare the bytes/digests of installer, bundle, signature, notes, source SHAs, stable provenance, version, date, target, and signature. Explicitly exclude only origin-specific manifest URL, manifest digest, `SHA256SUMS`, evidence digest, and `distribution` fields.

- [ ] **Step 6: Run artifact and release contracts**

```bash
node --test tools/station-release/test/origins.test.mjs tools/station-release/test/artifacts.test.mjs
pnpm test:station-release:contract
```

Expected: PASS with the legacy GitHub evidence compatibility test and all new releases emitting origin-specific evidence.

- [ ] **Step 7: Commit the origin model**

```bash
git add tools/station-release/origins.mjs tools/station-release/artifacts.mjs tools/station-release/test/origins.test.mjs tools/station-release/test/artifacts.test.mjs
git commit -m "feat(station): model dual release origins"
```

---

### Task 2: Transactional Yandex object publisher

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `tools/station-release/object-storage.mjs`
- Create: `tools/station-release/yandex-publisher.mjs`
- Create: `tools/station-release/test/object-storage.test.mjs`
- Create: `tools/station-release/test/yandex-publisher.test.mjs`

**Interfaces:**

Add exact root development dependency `@aws-sdk/client-s3` at the same repository-pinned version used by `apps/api` (`3.1114.0`). The publisher CLI receives credentials only from standard masked environment variables and accepts no credential flags.

```ts
createStationObjectStore(input: {
  client: S3ClientLike;
  bucket: string;
  publicBaseUrl: "https://releases.markiro.app";
  fetchImpl?: typeof fetch;
}): {
  assertAbsent(key: string): Promise<void>;
  putImmutable(key: string, file: string, contentType: string): Promise<void>;
  getMutable(key: string): Promise<null | { bytes: Uint8Array; contentType: string }>;
  putMutable(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  copyImmutableToAlias(input: {
    immutableKey: string;
    aliasKey: string;
    attachmentFilename: string;
  }): Promise<void>;
  readPublic(key: string): Promise<Uint8Array>;
};

type PromotionBackup = {
  schemaVersion: 1;
  channel: "beta" | "stable";
  objects: Array<{ key: string; contentType: string; sha256: string; backupPath: string }>;
};
```

CLI commands:

```text
node tools/station-release/yandex-publisher.mjs publish-immutable <tree> <channel> <version>
node tools/station-release/yandex-publisher.mjs validate-public <tree> <channel> <version>
node tools/station-release/yandex-publisher.mjs seed-baseline <tree> <channel> <backup-dir>
node tools/station-release/yandex-publisher.mjs backup-mutables <channel> <backup-dir>
node tools/station-release/yandex-publisher.mjs promote <tree> <channel> <backup-dir>
node tools/station-release/yandex-publisher.mjs rollback <channel> <backup-dir>
```

- [ ] **Step 1: Add the exact AWS SDK dependency**

```bash
corepack pnpm add -Dw @aws-sdk/client-s3@3.1114.0
pnpm check:deps
```

Expected: manifest and lockfile change only for the exact SDK already present in the workspace resolution graph; dependency policy passes.

- [ ] **Step 2: Write failing storage adapter tests**

Use an injected fake client and fake `fetch`; never reach a real bucket. Cover absent/present objects, 403 versus 404, conditional immutable puts, bounded body reads, public non-2xx responses, content-type retention, path traversal, unexpected prefixes, redirects, and error sanitization.

- [ ] **Step 3: Implement the narrow S3 adapter**

Use only `HeadObjectCommand`, `PutObjectCommand`, `GetObjectCommand`, and `CopyObjectCommand`. Set `IfNoneMatch: "*"` for immutable writes. Use server-side copy from the verified immutable installer for an alias, with exact `Content-Type`, versioned `Content-Disposition`, and revalidation `Cache-Control`; never upload a second local installer. Bound downloads to the expected release asset limits, reject symbolic links and non-regular local files, and expose fixed errors without keys, response bodies, credentials, or signed headers.

- [ ] **Step 4: Write failing publisher transaction tests**

Cover:

- immutable upload refuses one pre-existing key before uploading any later key;
- staged tree validation occurs before the first S3 request;
- public read-back revalidates every immutable object;
- `backup-mutables` fails if either required current object is absent;
- `seed-baseline` accepts only a publicly verified, complete dual-origin tree and writes the first known-good channel/alias plus local backup evidence;
- `promote` updates manifest before server-side-copying the installer alias and restores both if verification fails;
- `rollback` verifies backup hashes and never touches immutable prefixes;
- `promote-existing` paths cannot invoke immutable upload;
- no operation issues `DeleteObject`.

- [ ] **Step 5: Implement bounded CLI parsing and transaction state**

Permit only the six commands and canonical channel/version/tree paths. Store backup bytes under a mode-`0700` temporary directory and a mode-`0600` JSON index created with exclusive creation. Refuse normal promotion without a non-empty backup of every mutable key. Use the same artifact validators as Task 1 before and after every upload.

- [ ] **Step 6: Run focused, release, dependency, and formatting checks**

```bash
node --test tools/station-release/test/object-storage.test.mjs tools/station-release/test/yandex-publisher.test.mjs
pnpm test:station-release:contract
pnpm check:deps
pnpm exec prettier --check package.json tools/station-release tools/station-release/test
```

- [ ] **Step 7: Commit the publisher**

```bash
git add package.json pnpm-lock.yaml tools/station-release/object-storage.mjs tools/station-release/yandex-publisher.mjs tools/station-release/test/object-storage.test.mjs tools/station-release/test/yandex-publisher.test.mjs
git commit -m "feat(station): add transactional Yandex publisher"
```

---

### Task 3: Dedicated Yandex release infrastructure

**Files:**

- Create: `infra/yandex/modules/station-releases/main.tf`
- Create: `infra/yandex/modules/station-releases/variables.tf`
- Create: `infra/yandex/modules/station-releases/outputs.tf`
- Modify: `infra/yandex/production/main.tf`
- Modify: `infra/yandex/production/variables.tf`
- Modify: `infra/yandex/production/outputs.tf`
- Modify: `infra/yandex/production/terraform.tfvars.example`
- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `infra/yandex/test/fixtures/production-plan-safe.json`
- Modify: `infra/yandex/test/fixtures/production-plan-unsafe.json`
- Modify if guard address policy changes: `infra/yandex/scripts/guard-production-plan.mjs`

**Module inputs and outputs:**

```hcl
variable "folder_id" { type = string }
variable "dns_zone_id" { type = string }
variable "domain" { type = string }
variable "bucket_name" { type = string }
variable "terraform_service_account_id" { type = string }
variable "publisher_pgp_key" { type = string; sensitive = true }
variable "public_dns_enabled" { type = bool; default = false }

output "publisher_access_key_id" { value = yandex_iam_service_account_static_access_key.publisher.access_key; sensitive = true }
output "publisher_encrypted_secret_key" { value = yandex_iam_service_account_static_access_key.publisher.encrypted_secret_key; sensitive = true }
output "cdn_provider_cname" { value = yandex_cdn_resource.releases.provider_cname }
output "certificate_id" { value = yandex_cm_certificate.releases.id }
```

- [ ] **Step 1: Add failing infrastructure contracts**

Assert one dedicated versioned bucket with `prevent_destroy`, public object read without public list/config, no expiration lifecycle, CDN HTTPS redirect, fixed release host, Certificate Manager DNS challenge, DNS controlled by a separate `station_release_public_dns_enabled` flag, and a dedicated publisher service account. Assert application/runtime service accounts and production VMs have no release-bucket permissions.

Replace the old blanket ban on CDN/certificates/static keys with narrow allowlists for this module only. Keep the direct-VM application delivery architecture assertions unchanged.

- [ ] **Step 2: Run infrastructure contracts and record RED**

```bash
pnpm test:yandex-infra:contract
```

Expected: FAIL because the release module is absent and the prior edge/static-key bans are still broad.

- [ ] **Step 3: Implement the dedicated module**

Create:

- `yandex_storage_bucket.releases` with versioning enabled, public read policy constrained to object ARNs, no public list, and `lifecycle { prevent_destroy = true }`;
- `yandex_iam_service_account.station_release_publisher`;
- bucket policy permissions limited to required `GetObject`, `PutObject`, and bucket-location/list-for-preflight operations over `station/*`; deny/delete permissions are not granted;
- `yandex_iam_service_account_static_access_key.publisher` with `pgp_key = var.publisher_pgp_key`, so Terraform state contains only the encrypted secret;
- `yandex_cdn_origin_group.releases` pointing to the bucket origin;
- `yandex_cdn_resource.releases` with `cname = var.domain`, HTTPS redirect, GET/HEAD only, origin `Cache-Control` handling, and explicit security/content headers; object metadata owns immutable versus revalidation caching;
- `yandex_cm_certificate.releases` with DNS challenge and the exact challenge record sets in the managed DNS zone, independent of the public-release DNS gate;
- the Cloud DNS CNAME only when `public_dns_enabled` is true and only after the certificate/CDN inputs are known.

Do not reuse the private media/audit bucket module and do not add release access to app, deploy, backup, or runtime identities.

- [ ] **Step 4: Wire production inputs and guarded outputs**

Add independently named variables:

```hcl
station_release_bucket_name
station_release_domain
station_release_publisher_pgp_key
station_release_public_dns_enabled
```

Mark the encrypted-secret and access-key outputs sensitive. Do not print them in plan summaries or workflow logs.

- [ ] **Step 5: Extend production plan guarding**

Update safe/unsafe fixtures so the guard accepts creation/update of the exact release resources but still rejects bucket destruction, versioning disablement, public list/config grants, publisher delete grants, app-runtime access, certificate deletion, CDN removal while DNS is live, and unexpected release-domain changes.

- [ ] **Step 6: Format and validate Terraform and contracts**

```bash
terraform fmt -check -recursive infra/yandex
terraform -chdir=infra/yandex/production init -backend=false -lockfile=readonly
terraform -chdir=infra/yandex/production validate
pnpm test:yandex-infra:contract
node --test infra/yandex/test/guard-production-plan.test.mjs
```

Expected: PASS using the pinned provider. No Terraform apply is performed.

- [ ] **Step 7: Commit infrastructure code**

```bash
git add infra/yandex/modules/station-releases infra/yandex/production infra/yandex/test infra/yandex/scripts/guard-production-plan.mjs
git commit -m "feat(infra): provision Station release origin"
```

---

### Task 4: Infrastructure workflow and credential bootstrap runbook

**Files:**

- Modify: `.github/workflows/yandex-infrastructure.yml`
- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `docs/runbooks/yandex-infrastructure.md`
- Modify: `docs/runbooks/yandex-infrastructure-secrets.md`
- Create: `docs/runbooks/station-release-origin-bootstrap.md`
- Modify: `tools/station-release/test/docs.test.mjs`

**Workflow contract:**

- Add a separate boolean dispatch input `enable_station_release_public_dns`; do not reuse `enable_public_dns`.
- Pass release bucket/domain/PGP variables explicitly.
- The apply job may expose only encrypted Terraform outputs to the approved operator. It must not echo plaintext access or secret keys.
- GitHub Environment `station-release` owns `YANDEX_STATION_RELEASE_ACCESS_KEY_ID`, `YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY`, and non-secret bucket/endpoint variables.

- [ ] **Step 1: Add failing workflow and docs contracts**

Assert exact variable inventory, separate DNS gates, masked/sensitive output handling, no static credentials in shell arguments, no secrets in artifacts, explicit Environment protection, and explicit stop points before apply/DNS/secrets.

- [ ] **Step 2: Run the focused contracts and record RED**

```bash
node --test infra/yandex/test/infra-contract.test.mjs tools/station-release/test/docs.test.mjs
```

- [ ] **Step 3: Update the infrastructure workflow**

Validate booleans and target SHA, map `TF_VAR_station_release_public_dns_enabled`, and keep OIDC/state-backend authentication unchanged. Never add the publisher static key to the infrastructure job environment after Terraform creation.

- [ ] **Step 4: Document the protected secret transfer**

The bootstrap runbook must require:

1. approved Terraform plan with release DNS disabled;
2. approved apply;
3. local decryption of the PGP-encrypted secret into a mode-`0600` temporary file;
4. `gh secret set YANDEX_STATION_RELEASE_ACCESS_KEY_ID --env station-release < "$access_key_file"` and `gh secret set YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY --env station-release < "$secret_key_file"`, or equivalent GitHub UI entry, without putting secret values in arguments/history;
5. deletion of the temporary plaintext file through an explicitly confirmed operator step;
6. a permission probe limited to the release prefix;
7. certificate challenge verification;
8. a second separately approved apply for DNS enablement only after the baseline is seeded and public-read tests pass through the provider host.

Do not execute any of these external steps as part of implementation.

- [ ] **Step 5: Run workflow/docs/infra contracts**

```bash
pnpm test:yandex-infra:contract
pnpm test:station-release:contract
pnpm exec prettier --check .github/workflows/yandex-infrastructure.yml docs/runbooks
```

- [ ] **Step 6: Commit workflow and runbooks**

```bash
git add .github/workflows/yandex-infrastructure.yml infra/yandex/test/infra-contract.test.mjs docs/runbooks/yandex-infrastructure.md docs/runbooks/yandex-infrastructure-secrets.md docs/runbooks/station-release-origin-bootstrap.md tools/station-release/test/docs.test.mjs
git commit -m "docs(infra): define release origin bootstrap"
```

---

### Task 5: Dual-origin accepted-beta provenance and baseline seeding

**Files:**

- Modify: `tools/station-release/promotion.mjs`
- Modify: `tools/station-release/test/promotion.test.mjs`
- Modify: `tools/station-release/yandex-publisher.mjs`
- Modify: `tools/station-release/test/yandex-publisher.test.mjs`
- Modify: `docs/runbooks/station-release-origin-bootstrap.md`

**Interfaces:**

```ts
validateAcceptedBeta(input: {
  sourceBetaTag: string;
  release: GitHubReleaseMetadata;
  githubEvidence: StationReleaseEvidence;
  yandexEvidence: StationReleaseEvidence;
  githubTree: string;
  yandexTree: string;
  diffPaths: string[];
}): AcceptedBeta;
```

The one-time seed command takes an explicitly named accepted GitHub beta or stable release, downloads it to a clean temporary directory, constructs the Yandex metadata tree around the same common assets, publishes only absent immutable Yandex keys, publicly verifies them through the storage provider hostname, then creates the initial channel/alias backup before DNS or Station endpoints can use the origin.

- [ ] **Step 1: Add failing dual-evidence tests**

Retain denial for draft/prerelease/SHA/diff mismatch. Add denial for missing Yandex evidence, mismatched source SHAs, common-asset hash differences, channel/version mismatch, or origin fields reversed. The temporary legacy evidence reader is accepted only by `seed-baseline`, never by normal stable promotion.

- [ ] **Step 2: Run promotion and publisher tests and record RED**

```bash
node --test tools/station-release/test/promotion.test.mjs tools/station-release/test/yandex-publisher.test.mjs
```

- [ ] **Step 3: Implement dual-origin provenance validation**

Read regular files only, preserve existing 256 KiB bounds, validate exact schemas, call both artifact validators and `compareStationReleaseOrigins`, and return only canonical tag/version/source values. Do not trust workflow-provided URLs or hashes.

- [ ] **Step 4: Implement the explicit seed gate**

Require `--confirm-empty-channel-bootstrap` as an exact mode token, not a boolean environment default. Refuse if DNS is already enabled in the supplied infrastructure evidence, if any mutable key exists without a complete known-good pair, or if the immutable release does not pass public read-back. Save a signed/hash-bounded bootstrap record as a workflow artifact; never include credentials or response headers.

- [ ] **Step 5: Document beta and stable initial baselines**

Seed both channels separately. Stable alias `/station/download` points to the accepted stable installer; beta alias `/station/beta/download` points to the accepted transitional beta only after that beta is published. The normal release workflows remain disabled until their respective mutable backup preconditions pass.

- [ ] **Step 6: Run release contracts and commit**

```bash
pnpm test:station-release:contract
pnpm exec prettier --check tools/station-release docs/runbooks/station-release-origin-bootstrap.md
git add tools/station-release/promotion.mjs tools/station-release/yandex-publisher.mjs tools/station-release/test/promotion.test.mjs tools/station-release/test/yandex-publisher.test.mjs docs/runbooks/station-release-origin-bootstrap.md
git commit -m "feat(station): verify dual-origin release provenance"
```

---

### Task 6: Dual-origin beta publication transaction

**Files:**

- Modify: `.github/workflows/station-beta-release.yml`
- Modify: `tools/station-release/test/workflow.test.mjs`
- Modify: `docs/runbooks/station-beta-release.md`
- Modify: `tools/station-release/test/docs.test.mjs`

**Workflow sequence:**

```text
build/sign once
  -> stage GitHub tree + Yandex tree
  -> validate each + compare common assets
  -> publish immutable GitHub release
  -> upload absent immutable Yandex objects
  -> public read-back and validate both origins
  -> back up GitHub channel + Yandex manifest/alias
  -> promote GitHub latest.json
  -> promote Yandex latest.json
  -> promote Yandex beta download alias
  -> verify all public mutable URLs
  -> rollback every changed mutable object on any failure
```

- [ ] **Step 1: Rewrite workflow contract tests first**

Assert the exact step order, `station-release` Environment, secret names, single build/sign, two staging directories, immutable collision checks, public read-back, backup completeness, channel order, alias-last, trap-based rollback, no delete calls, no mutable promotion before both immutable validations, and `promote-existing` never invoking build/sign or immutable upload.

- [ ] **Step 2: Run beta workflow tests and record RED**

```bash
node --test tools/station-release/test/workflow.test.mjs
```

- [ ] **Step 3: Stage and validate both trees in the workflow**

Create `$RUNNER_TEMP/station-github` and `$RUNNER_TEMP/station-yandex` from the same build output. Pass only fixed origin identifiers to the staging CLI, then run cross-origin comparison before any publication.

- [ ] **Step 4: Add immutable Yandex publication and public verification**

Map masked secrets to standard AWS SDK environment names only for the publisher steps, use `https://storage.yandexcloud.net`, and unset them in cleanup. Re-download GitHub assets and fetch Yandex public objects to new directories; validate and compare those downloaded trees rather than trusting upload responses.

- [ ] **Step 5: Implement the three-target mutable transaction**

Preserve the existing GitHub backup/restore behavior. Require pre-existing backups for the Yandex manifest and beta installer alias. Promote and verify in the exact sequence above. A single cleanup handler restores all changed mutable objects in reverse order and reports a hard failure if restoration itself cannot be publicly verified.

- [ ] **Step 6: Restrict `promote-existing`**

It must locate and validate both already-published immutable trees, regenerate no binary, upload no immutable object, create complete mutable backups, then rerun only the promotion transaction.

- [ ] **Step 7: Update beta operations documentation**

Document normal publish, mutable-only repair, partial-origin recovery, baseline prerequisite, default stable versus explicit beta installer URLs, restricted-network manual install-over, and the fact that old GitHub-only beta clients require the transitional beta or manual installer.

- [ ] **Step 8: Run beta workflow and release contracts**

```bash
node --test tools/station-release/test/workflow.test.mjs tools/station-release/test/docs.test.mjs
pnpm test:station-release:contract
pnpm exec prettier --check .github/workflows/station-beta-release.yml docs/runbooks/station-beta-release.md
```

- [ ] **Step 9: Commit beta dual publication**

```bash
git add .github/workflows/station-beta-release.yml tools/station-release/test/workflow.test.mjs docs/runbooks/station-beta-release.md tools/station-release/test/docs.test.mjs
git commit -m "feat(station): publish beta to two origins"
```

---

### Task 7: Dual-origin stable publication transaction

**Files:**

- Modify: `.github/workflows/station-stable-release.yml`
- Modify: `tools/station-release/test/stable-workflow.test.mjs`
- Modify: `docs/runbooks/station-stable-release.md`
- Modify: `docs/acceptance/station-stable-release.md`
- Modify: `tools/station-release/test/docs.test.mjs`

**Stable-specific invariants:**

- Rebuild only the explicitly accepted dual-origin beta source at its verified `baseSha`.
- Require matching GitHub and Yandex beta evidence before deriving stable.
- Publish the corresponding stable assets once per origin and keep accepted-beta provenance identical.
- Default installer alias `/station/download` changes last, after both stable channel manifests.

- [ ] **Step 1: Add failing stable workflow contracts**

Mirror Task 6 assertions and retain all current accepted-beta, stable version monotonicity, source tree, changelog, release notes, and stable overlay contracts. Assert the default alias is stable and never points to beta.

- [ ] **Step 2: Run stable workflow tests and record RED**

```bash
node --test tools/station-release/test/stable-workflow.test.mjs
```

- [ ] **Step 3: Validate the selected beta at both origins**

Download both beta trees, validate their evidence, compare common assets, verify the GitHub tag target commit, and only then check out/rebuild the accepted `baseSha` with the stable Tauri overlay.

- [ ] **Step 4: Add stable dual staging, immutable publication, and read-back**

Reuse the common modules from Tasks 1-2. Do not duplicate S3 parsing or transaction logic in YAML. Verify both public immutable trees before creating any stable mutable backup.

- [ ] **Step 5: Add stable channel and default-alias transaction**

Promote GitHub stable manifest, Yandex stable manifest, then `/station/download`. Restore all three on error. `promote-existing` validates the already-published stable trees and performs only this transaction.

- [ ] **Step 6: Update stable runbook and acceptance record**

Add dual-origin evidence URLs/hashes, rollback evidence, unsigned-NSIS/SmartScreen boundary, restricted-network install-over, and explicit preservation checks for application identity, SQLite, pairing, settings, journals, exceptions, and outbox.

- [ ] **Step 7: Run stable and full release contracts**

```bash
node --test tools/station-release/test/stable-workflow.test.mjs tools/station-release/test/docs.test.mjs
pnpm test:station-release:contract
pnpm exec prettier --check .github/workflows/station-stable-release.yml docs/runbooks/station-stable-release.md docs/acceptance/station-stable-release.md
```

- [ ] **Step 8: Commit stable dual publication**

```bash
git add .github/workflows/station-stable-release.yml tools/station-release/test/stable-workflow.test.mjs docs/runbooks/station-stable-release.md docs/acceptance/station-stable-release.md tools/station-release/test/docs.test.mjs
git commit -m "feat(station): publish stable to two origins"
```

---

### Task 8: Fixed-origin Rust updater discovery adapter

**Files:**

- Modify: `apps/station/src-tauri/tauri.conf.json`
- Modify: `apps/station/src-tauri/tauri.stable.conf.json`
- Create: `apps/station/src-tauri/src/updater.rs`
- Modify: `apps/station/src-tauri/src/lib.rs`
- Modify: `apps/station/test/tauri-release-config.test.ts`

**Command surface:**

```rust
#[tauri::command]
async fn station_update_check(app: tauri::AppHandle) -> Result<Option<StationUpdate>, StationUpdateError>;

#[tauri::command]
async fn station_update_download_and_install(
    app: tauri::AppHandle,
    request: StationUpdateInstallRequest,
    progress: tauri::ipc::Channel<StationUpdateProgress>,
) -> Result<(), StationUpdateError>;
```

`StationUpdateInstallRequest` contains only the opaque candidate ID returned by `station_update_check`; it contains no URL, channel, version, or signature supplied by the webview. Candidate state is bounded, process-local, expires, and is invalidated after use or a new check.

Rust result model:

```rust
enum StationReleaseOrigin { Yandex, Github }
enum StationFallbackReason { PrimaryUnavailable, PrimaryMetadataInvalid }

struct StationUpdate {
    candidate_id: String,
    current_version: String,
    version: String,
    published_at: String,
    selected_origin: StationReleaseOrigin,
    fallback_reason: Option<StationFallbackReason>,
}
```

- [ ] **Step 1: Update config tests first**

Assert ordered endpoints for beta and stable:

```json
[
  "https://releases.markiro.app/station/beta/latest.json",
  "https://github.com/thevladbog/markiro/releases/download/station-beta-channel/latest.json"
]
```

and the stable equivalent. Assert one unchanged public key, no operator-controlled endpoint command, no environment-selected origin, and the narrow command names only.

- [ ] **Step 2: Add failing Rust unit tests**

Use an internal transport trait/fake and deterministic manifests. Cover primary update without a GitHub request, authoritative primary no-update without a GitHub request, eligible primary failure then fallback, invalid metadata fallback, wrong channel/version/target denial, future date, downgrade denial, timeout, both origins unavailable, and sanitized error serialization.

- [ ] **Step 3: Run focused tests and record RED**

```bash
pnpm --filter @markiro/station exec vitest run test/tauri-release-config.test.ts
cargo test --manifest-path apps/station/src-tauri/Cargo.toml updater
```

- [ ] **Step 4: Implement fixed endpoint selection and agreement**

Keep the fixed endpoints in compiled Tauri configuration and mirror them in a closed Rust channel model selected by build configuration, not IPC. Use the pinned `tauri-plugin-updater` builder with one endpoint at a time. Treat every valid primary result, including `None` and a valid candidate, as final without contacting GitHub. Only an eligible primary transport/HTTP/parse failure permits a fallback metadata check; record that fallback reason with a valid GitHub candidate.

- [ ] **Step 5: Register the narrow commands**

Add only `station_update_check` and `station_update_download_and_install` to `invoke_handler`. Keep the plugin public key and restart permission unchanged. Do not expose plugin resource IDs or arbitrary endpoint construction to TypeScript.

- [ ] **Step 6: Run Rust, config, and Station checks**

```bash
cargo fmt --manifest-path apps/station/src-tauri/Cargo.toml -- --check
cargo test --manifest-path apps/station/src-tauri/Cargo.toml updater
pnpm --filter @markiro/station exec vitest run test/tauri-release-config.test.ts
pnpm --filter @markiro/station typecheck
```

- [ ] **Step 7: Commit discovery fallback**

```bash
git add apps/station/src-tauri/tauri.conf.json apps/station/src-tauri/tauri.stable.conf.json apps/station/src-tauri/src/updater.rs apps/station/src-tauri/src/lib.rs apps/station/test/tauri-release-config.test.ts
git commit -m "feat(station): add fixed-origin updater discovery"
```

---

### Task 9: Package fallback, integrity boundary, and installation start

**Files:**

- Modify: `apps/station/src-tauri/src/updater.rs`
- Modify if direct dependencies are required: `apps/station/src-tauri/Cargo.toml`
- Modify if dependencies change: `apps/station/src-tauri/Cargo.lock`

**Download state machine:**

```text
candidate selected
  -> download selected origin
     -> transport/HTTP failure before complete bytes: try fixed peer URL
     -> signature/integrity/local failure: stop
  -> verify with existing Tauri public key
  -> mark install_started
  -> invoke installer exactly once
  -> never fallback after install_started
```

- [ ] **Step 1: Add failing package fallback tests**

Cover exact accepted-target recheck, primary download success, primary network/HTTP failure followed by an equal GitHub manifest and successful package, fallback metadata mismatch denial, fallback network failure, primary bad signature without fallback, local write error without fallback, candidate expiry/reuse denial, version change denial, progress monotonicity across retry, cancellation cleanup, and exactly-once installer launch.

- [ ] **Step 2: Run Rust tests and record RED**

```bash
cargo test --manifest-path apps/station/src-tauri/Cargo.toml updater::tests::download
```

- [ ] **Step 3: Implement download-before-install fallback**

At install time recheck the exact accepted target, starting with Yandex. Retain both fixed package URLs/signatures only after a fallback manifest has been fetched and proven equal in version, target, publication date, and signature. Use the plugin's download and Minisign verification behavior or its public verifier primitives; do not invent a second signature scheme. Classify the pinned plugin's `Reqwest`/network/HTTP errors as eligible and Minisign/base64/signature/local/install errors as terminal. Keep downloaded bytes bounded and clear them on every exit.

- [ ] **Step 4: Seal the install boundary**

Consume the candidate before launching the installer, set `install_started` atomically, emit `Finished` only after verification, and reject any retry/fallback once installation begins. Preserve `allowDowngrades: false` semantically in the Rust version check.

- [ ] **Step 5: Run complete Rust verification**

```bash
cargo fmt --manifest-path apps/station/src-tauri/Cargo.toml -- --check
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/station/src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: PASS on the host. This is not Windows installer or hardware proof.

- [ ] **Step 6: Commit package fallback**

```bash
git add apps/station/src-tauri/src/updater.rs apps/station/src-tauri/Cargo.toml apps/station/src-tauri/Cargo.lock
git commit -m "feat(station): fall back before verified install"
```

---

### Task 10: TypeScript adapter and operator-visible fallback state

**Files:**

- Modify: `apps/station/src/lib/tauri-updater.ts`
- Modify: `apps/station/src/lib/use-station-updater.ts`
- Modify: `apps/station/src/pages/UpdateCenter.tsx`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/test/tauri-updater.test.ts`
- Modify: `apps/station/test/use-station-updater.test.tsx`
- Modify: `apps/station/test/update-center.test.tsx`

**TypeScript contract:**

```ts
type StationUpdateOrigin = "yandex" | "github";
type StationUpdateFallbackReason = "primary-unavailable" | "primary-metadata-invalid";

interface StationUpdateHandle {
  currentVersion: string;
  version: string;
  publishedAt: string;
  origin: StationUpdateOrigin;
  fallbackReason: StationUpdateFallbackReason | null;
  downloadAndInstall(onProgress: (event: StationUpdateDownloadEvent) => void): Promise<void>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write failing adapter/controller/UI tests**

Assert exact Rust command payloads, strict result decoding, no caller URL, origin/fallback persistence only for the current candidate, primary/fallback display, mismatch/integrity failure copy, active-shift denial before a second check, no automatic install, preserved outbox warning, progress behavior, and accessible live status.

- [ ] **Step 2: Run focused Station tests and record RED**

```bash
pnpm --filter @markiro/station exec vitest run test/tauri-updater.test.ts test/use-station-updater.test.tsx test/update-center.test.tsx
```

- [ ] **Step 3: Replace direct JavaScript updater use**

Remove `check` and `Update` imports from `@tauri-apps/plugin-updater`. Invoke only the two Station Rust commands. Keep `relaunch` in the existing process plugin. Decode exact keys/types, canonical date/version, and closed origin/reason enums; close means invalidating the opaque candidate locally/Rust-side, not closing a caller-visible plugin resource.

- [ ] **Step 4: Preserve controller safety and add origin status**

Keep current check throttling, generation cancellation, persisted update state, target recheck, active-shift denial, manual confirmation, and error recovery. Add distinct terminal errors for `origin-mismatch` and `integrity-failed`; do not collapse them into a network retry message. Fallback success remains informational and never blocks work.

- [ ] **Step 5: Add concise RU/EN operator copy**

Display “Источник: Markiro (Yandex)” for primary, “Использован резервный источник GitHub” after fallback, and precise non-alarmist integrity/mismatch failures. Do not expose raw URLs, HTTP codes, stack traces, or internal candidate IDs.

- [ ] **Step 6: Run Station package gates**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/station exec vitest run test/tauri-updater.test.ts test/use-station-updater.test.tsx test/update-center.test.tsx test/tauri-release-config.test.ts
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
```

- [ ] **Step 7: Commit Station UI integration**

```bash
git add apps/station/src/lib/tauri-updater.ts apps/station/src/lib/use-station-updater.ts apps/station/src/pages/UpdateCenter.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/test/tauri-updater.test.ts apps/station/test/use-station-updater.test.tsx apps/station/test/update-center.test.tsx
git commit -m "feat(station): surface resilient update origins"
```

---

### Task 11: Migration, acceptance, and final automated verification

**Files:**

- Modify: `docs/runbooks/station-beta-release.md`
- Modify: `docs/runbooks/station-stable-release.md`
- Modify: `docs/runbooks/station-release-origin-bootstrap.md`
- Create: `docs/acceptance/station-dual-origin-release.md`
- Modify: `tools/station-release/test/docs.test.mjs`
- Modify if tracked working map references releases: `docs/working-map.md`

**Rollout record must keep four distinct phases:** provision without DNS, dual-publish tooling and seed, transitional beta, first dual-origin stable.

- [ ] **Step 1: Add failing documentation contracts**

Require both public installer URLs, both channel URLs, fixed rollout order, no-retrofit wording for immutable historical releases, GitHub-reachable versus GitHub-blocked migration paths, rollback procedure, first-run baseline, manual-only behavior, active-shift denial, no Authenticode claim, and the physical acceptance matrix.

- [ ] **Step 2: Write the acceptance checklist**

Include evidence fields for:

- exact release tag, `baseSha`, release SHA, both origin evidence hashes, and public URLs;
- Yandex primary check/download with GitHub blocked;
- GitHub fallback check/download with Yandex blocked;
- primary valid no-update authoritative behavior;
- origin mismatch and bad-signature terminal behavior;
- install-over from GitHub-only beta and from Yandex installer;
- application ID and Station SQLite path unchanged;
- pairing, local settings, journals, boxes, exceptions, and outbox retained;
- active shift blocks install but not production work;
- restart/reconnect recovery;
- scanner, printer, sound, touch, WebView2, NSIS/SmartScreen, and offline shift operation;
- stable rollback to the previous accepted stable without data loss.

Every row has `PASS`, `FAIL`, or `NOT_RUN`, operator, UTC timestamp, device/Windows identity, and evidence path/hash. No fabricated results.

- [ ] **Step 3: Run all focused automated gates**

```bash
pnpm test:station-release:contract
pnpm test:yandex-infra:contract
node --test infra/yandex/test/guard-production-plan.test.mjs
terraform fmt -check -recursive infra/yandex
terraform -chdir=infra/yandex/production init -backend=false -lockfile=readonly
terraform -chdir=infra/yandex/production validate
cargo fmt --manifest-path apps/station/src-tauri/Cargo.toml -- --check
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/station/src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
pnpm check:deps
pnpm format:check
git diff --check
```

Record database/infrastructure skips explicitly. None of these commands authorizes Terraform apply, DNS changes, secret creation, a release, or Windows acceptance.

- [ ] **Step 4: Refresh the local code graph after all code changes**

Because `graphify-out/graph.json` exists locally, run:

```bash
graphify update .
```

Keep `graphify-out/` ignored and uncommitted. Use a source query to verify the final dependency path from `UpdateCenter` through the TypeScript adapter to the Rust updater commands and fixed origins.

- [ ] **Step 5: Request independent code review**

Use `superpowers:requesting-code-review` after all automated gates pass. The review must focus on publication rollback completeness, immutable collision handling, Terraform state secrets, IAM isolation, Rust error classification, fallback-after-integrity denial, active-shift behavior, and legacy-client migration.

- [ ] **Step 6: Resolve review findings and rerun affected gates**

Use `superpowers:receiving-code-review`; verify findings against the pinned AWS SDK/Tauri/Yandex provider behavior before editing. Rerun every affected focused test plus the final command set above.

- [ ] **Step 7: Commit final docs and acceptance templates**

```bash
git add docs/runbooks/station-beta-release.md docs/runbooks/station-stable-release.md docs/runbooks/station-release-origin-bootstrap.md docs/acceptance/station-dual-origin-release.md tools/station-release/test/docs.test.mjs docs/working-map.md
git commit -m "docs(station): define dual-origin rollout acceptance"
```

---

### Task 12: Approval-bearing live rollout (not part of code completion)

**External state:** Yandex Cloud, Cloud DNS, GitHub Environments/Secrets, GitHub Releases, customer Windows stations.

This task starts only after Tasks 1-11 are merged to `main`, all automated gates pass, an independent review is resolved, and the user separately authorizes each external phase.

- [ ] **Step 1: Obtain approval and apply infrastructure with release DNS disabled**

Save and review the exact Terraform plan. Confirm no replacement/destruction of production data resources and no application runtime access to the release bucket. Apply only the saved plan after explicit approval.

- [ ] **Step 2: Transfer publisher credentials into the protected Environment**

Follow `docs/runbooks/station-release-origin-bootstrap.md`. Never paste secrets into this chat, logs, command arguments, files under the repository, or artifacts.

- [ ] **Step 3: Seed and verify beta and stable Yandex baselines**

Use explicitly selected accepted releases, verify both origins and rollback backups, and retain the bounded bootstrap evidence. Stop on any mismatch; do not repair immutable keys by overwriting them.

- [ ] **Step 4: Obtain separate approval and enable `releases.markiro.app` DNS**

Verify certificate readiness, CDN/provider-host reads, cache behavior, HEAD/GET only, no bucket listing, and both stable/beta download aliases before enabling DNS. After propagation, repeat the public tests through the final hostname from both normal and GitHub-restricted networks.

- [ ] **Step 5: Publish and physically accept the transitional beta**

Publish a new immutable beta containing the dual-origin updater. Migrate GitHub-reachable stations through normal update. For already blocked stations, perform the documented manual install-over from the Yandex beta URL. Complete the physical acceptance matrix; do not promote stable while any required row is `FAIL` or `NOT_RUN`.

- [ ] **Step 6: Publish and physically accept the first dual-origin stable**

Promote only the explicitly accepted transitional beta source. Verify default stable download, both update origins, fallback, rollback, install-over data retention, scanner/printer/touch/offline behavior, and signed evidence.

- [ ] **Step 7: Report rollout truthfully**

Separate:

- merged code and automated gates;
- provisioned cloud resources and public URL checks;
- GitHub/Yandex publication evidence;
- Windows/physical-device acceptance;
- checks not run and why;
- current rollback points for beta and stable.

Do not mark the feature operationally complete until every required external gate has explicit evidence.
