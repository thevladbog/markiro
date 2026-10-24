# Immutable Release Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, serially in the existing worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and serve releases on Timeweb without allowing replacement of any previously published file, even though the provider ignores conditional PUT.

**Architecture:** PostgreSQL binds each public path to an exact S3 VersionId, SHA256, size and MIME. A verified cache serves only those bindings; durable local and S3 receipts preserve occupied names and channel history across database recovery. Existing publishers and SaaS uploads register complete releases through authenticated catalog operations before changing a channel by revision CAS.

**Tech Stack:** Node 24, TypeScript, NestJS, Zod, Drizzle/PostgreSQL, AWS SDK v3, Caddy, existing Node/Vitest suites. Use the repository's Corepack pnpm 11.22.0; no lockfile hand edits.

**Spec:** `docs/superpowers/specs/2026-10-24-immutable-release-catalog-design.md` (owner approved, including exact catalog-key permissions).

## Current evidence and execution boundary

- Research base: `origin/main` = `4cf3c8be9963942288b2fef86bbec0100c14c395`, exact CI `40040299441` passed. Existing worktree branch `codex/timeweb-explicit-recovery` merged it without reset as `8afee5967`; tracked tree equals that main.
- Live prerequisite passed once: 15 catalog capability checks, including exact old-version reads after replacement, full hashes and scope-denial checks. Evidence: `.superpowers/sdd/2026-10-24-release-preparation/catalog-capability-result.json`. Do not rerun the probe or recreate keys.
- Existing release baseline: Autonom **1.0.0**, not legacy online Station 2.x. All nine baseline files and its ES256 update signature were independently verified. Autonom 1.1.0 remains a candidate, not a published release.
- No implementation, migration, catalog rollout or release publication is claimed by this plan. Existing protected deployment and release approvals remain separate operational gates.
- Implement inline, one task/test operation at a time. Retain a progress ledger in `.superpowers/sdd/2026-10-24-immutable-release-catalog/`. Preserve operational evidence rather than deleting it at completion. One independent final review follows implementation; do not launch parallel builders.

## Global Constraints

- У зарегистрированного immutable public path нельзя изменить или удалить binding.
- У одной product/channel/version не может появиться второй набор байтов.
- Новый физический VersionId с теми же байтами не перепривязывает существующий путь.
- Полный набор файлов версии и audit фиксируются одной DB-транзакцией.
- Чтения текущей версии S3 и fallback при ошибке каталога не существует.
- Не доверять metadata sha256: сервер считает hash полных байтов точной версии S3.
- Runtime/publishers receive no deletion, bucket-administration or DDL rights. Catalog credentials stay API-only; publisher credentials do not move into runtime.
- Preserve existing source/provenance/signature/version/compatibility checks. Source product SHA and reviewed tooling SHA remain distinct.
- Before visibility, persist an exclusive/fsynced local receipt and a version-pinned, fully read-back S3 receipt. This applies to publications, historical reservations and channel changes.
- Recovery starts with writers fenced off. Prepared receipts reserve names but do not prove a pointer CAS committed. Ambiguous channels remain closed.
- Unknown historical upper bounds close the affected namespace. Current heads, current GitHub listings and nightly snapshots are not proof of complete issued history.
- Existing public URLs and update payloads remain compatible. No raw VersionId, private storage URL or secret enters the public response or audit.
- No actual release writes, production changes, DNS changes, support message or old migration/retirement operation during local implementation.
- Keep all old copies, technical object versions, partial transfers and operation journals. Never overwrite them or upload a recovery/signing key.

## Review Focus

1. A still-valid presigned PUT is used after registration: old public bytes remain exact (Tasks 3, 6, 7).
2. A commit succeeds but its connection/response is lost: retry returns the existing binding and audit, with no new physical binding or channel revision (Tasks 2, 4, 6).
3. An old DB snapshot is restored while ledger contains newer and ambiguous operations: names stay reserved; affected pointers and writers stay closed (Tasks 4, 9).
4. Equivalent-looking encoded paths, case differences, duplicate files or a caller-supplied bucket/key bypass a guard: reject before storage access, never normalize into a different published name (Tasks 1, 5, 7).
5. Partial downloads, low disk, a symlink or concurrent cache fills produce a truncated 200: no response bytes before complete validation; failure is uncacheable (Tasks 3, 7).

## File map and interfaces

New API modules live in `apps/api/src/modules/release-catalog/`, split into `catalog-types.ts`, `catalog-policy.ts`, `catalog-repository.ts`, `catalog-service.ts`, `catalog-config.ts`, `catalog-store.ts`, `catalog-cache.ts`, `catalog-ledger.ts`, `catalog-recovery.ts`, `catalog-oidc.ts`, `catalog-publisher.guard.ts`, `catalog-publisher.controller.ts`, `catalog-resolver.controller.ts`, and `release-catalog.module.ts`.

Wire schemas live in `packages/platform-contracts/src/release-catalog.ts`; SQL schemas in `packages/db/src/schema/release-catalog.ts`. Node workflow clients live in `tools/release-catalog/`. Existing product validators remain in their current packages/tools; new product-policy adapters call them, not weaker reimplementations.

Shared names used below:

- `ReleaseProduct = 'station' | 'handheld' | 'standalone' | 'signer'`; `ReleaseChannel = 'beta' | 'stable'`. Signer permits historical read/import only, no publisher route.
- `ReleaseIdentity = { product, channel, version }`; product-specific validators determine accepted version grammar and order.
- `ReleaseFileSpec = { name, sha256, sizeBytes, contentType }`; `PublicationRequest = { identity, sourceSha, files, evidence }`. `evidence` is a strict product-discriminated shape preserving existing validators; never arbitrary metadata.
- `VerifiedInputFile = { spec: ReleaseFileSpec, sha256: string, sizeBytes: number, read(maxBytes: number): Promise<Uint8Array> }`; `VerifiedInputFiles = ReadonlyMap<string, VerifiedInputFile>`. Validators read only bounded manifests/proofs; installer validation uses the independently verified full digest/size. Task 1 defines these interfaces; Task 3 implements their verified byte source.
- `PinnedObject = { publicPath, bucket, key, versionId, sha256, sizeBytes, contentType }` is internal only. `Publication` contains identity, immutable id, complete sorted file set and product-validated metadata.
- `PublisherPrincipal` discriminates platform actor from GitHub actor. The latter binds repository/owner IDs, environment, workflow ref, tooling SHA, run ID and attempt; it has no platform capabilities.
- `CatalogFault.code` is one of `invalid_request`, `forbidden`, `conflict`, `not_found`, `not_ready`, `unavailable`; adapters retain existing product error codes where equivalent. Conflict maps 409, unavailable/not_ready 503 with no-store.
- `Intent` contains UUID, epoch, owner fingerprint, idempotency key, canonical request digest, fixed staged file keys, expiry and state. Digest sorts file descriptors and includes identity/source/evidence; physical VersionIds are excluded from semantic idempotency.
- `ChannelSnapshot = { identity: {product,channel}, revision: string, publicationId: string|null, readable: boolean }`; decimal-string revisions avoid JavaScript integer overflow.
- `VerifiedReceipt = { operationId, sha256, ledgerKey, ledgerVersionId }` is returned only after both durable copies are verified. Its type is declared in Task 1; Task 4 supplies the runtime proof. A receipt is evidence of prepare, never an assertion that DB commit happened.

---

### Task 1: Strict publication and path contracts

**Files:** Create `packages/platform-contracts/src/release-catalog.ts`, `packages/platform-contracts/test/release-catalog.test.ts`, `apps/api/src/modules/release-catalog/catalog-types.ts`, `apps/api/src/modules/release-catalog/catalog-policy.ts`, `apps/api/test/release-catalog-policy.test.ts`. Modify `packages/platform-contracts/src/index.ts`.

**Interfaces:** Produce `releaseIdentitySchema`, `releaseFileSpecSchema`, `publicationRequestSchema`, `channelSnapshotSchema`, `publicationIntentRequestSchema`, `publicationCommitRequestSchema`, `channelChangeRequestSchema`; TypeScript types inferred from strict schemas. Produce `derivePublicPath(identity, name): string`, `deriveUploadKey(product, intentId, name): string`, `canonicalPublicationDigest(request): string` and `assertProductPublication(request: PublicationRequest, verifiedFiles: VerifiedInputFiles): Promise<PublicationMetadata>`. `PublicationMetadata` is a discriminated union: standalone contains the existing validated standalone release record; handheld contains the existing validated handheld manifest; station contains the existing validated updater manifest and origin proof; signer is import-only. Reuse their existing schema types and validators rather than admitting untyped JSON.

- [ ] Write tests: duplicate names reject; files reordered give the same digest; a changed digest/size/MIME/source changes it. Reject empty/literal `null` VersionId, traversal, percent-encoded segments, slash/backslash names, controls, absolute URLs and unexpected properties. No caller-supplied bucket/key/publicPath in intent requests. Assert exact existing Station/handheld `/releases/` and standalone non-`/releases/` layouts.
- [ ] Run `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/release-catalog.test.ts`; expect RED for missing new contracts, not unrelated setup errors.
- [ ] Implement strict product-discriminated requests. Preserve standalone numeric semver, Station's existing beta grammar and handheld version/code rules. Reuse current product validators through adapters; file-set and evidence limits are explicit and bounded. VersionId is opaque, nonempty, non-`null`, maximum 1024 UTF-8 bytes and no control characters; encode with SDK parameters, never URL interpolation.
- [ ] Build affected dependencies, run the new contract/policy suites and existing standalone contracts. Expect all PASS; no production network.
- [ ] Commit only these scoped contracts/adapters/tests after `git diff --check`.

### Task 2: Durable schema, uniqueness and runtime permissions

**Files:** Create `packages/db/src/schema/release-catalog.ts`, `packages/db/test/release-catalog-schema.test.ts`, `packages/db/test/release-catalog-migration.test.ts`, `apps/api/src/modules/release-catalog/catalog-repository.ts`, `apps/api/test/release-catalog-repository.integration.test.ts`. Modify `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`; generate the next unused migration and metadata through Drizzle. Add guard SQL to that new, unapplied migration only.

**Interfaces:** Consume Task 1 types. Produce `CatalogRepository.reserveIntent(principal, idempotencyKey, request): Promise<Intent>`, `getIntent(principal,id): Promise<Intent>`, `commitPublication(intentId, epoch, publication, receipt, audit): Promise<{outcome:'registered'|'unchanged',publication:Publication}>`, `readPath(path): Promise<PinnedObject|null>`, `readChannel(product,channel): Promise<ChannelSnapshot>`, and `commitChannelChange(change, receipt, audit): Promise<ChannelSnapshot>`.

- [ ] Write actual PostgreSQL tests for two concurrent conflicting registrations (one success, one 409), identical retries (one publication/audit), duplicate paths across releases, complete-set atomic visibility, pointer composite FK rejecting another product/channel, and rollback on audit failure. Fault-inject a lost response after COMMIT; retry must return the same publication.
- [ ] Run those tests on a new task-owned isolated database/container, never a shared or production database. Expect RED for missing schema/repository. Record endpoint identity without credentials. No skipped DB tests count as a pass.
- [ ] Define tables `release_catalog_epochs`, `release_catalog_intents`, `release_catalog_publications`, `release_catalog_objects`, `release_catalog_reservations`, `release_catalog_channels`, `release_catalog_channel_events`, `release_catalog_receipts` and `release_catalog_oidc_bindings`. Unique publicPath and product/channel/version; composite FKs bind files/events/pointers to the correct publication namespace. Prepared intents reserve identity; expired/failed intents never release an occupied name for different bytes. Channels use bigint revisions, initially unreadable until activation/reconciliation.
- [ ] Generate migration with `corepack pnpm --filter @markiro/db db:generate`; retain generated filename in ledger. Immutable publications/objects/reservations/events/receipts use UPDATE/DELETE and TRUNCATE guard triggers. Revoke UPDATE/DELETE/TRUNCATE from PUBLIC and existing `markiro_app` when that role exists; retain SELECT/INSERT. Tests create isolated migrator/app roles and assert real denial for all three verbs; no new production credentials. Keep mutable intents/epochs/channels distinct.
- [ ] Implement short transactions with lock/statement timeouts (5s/15s), uniqueness as final arbiter and parameterized advisory/row locks. No network or file hashing inside transactions. Recheck active writer epoch immediately before mutation; stale epoch cannot publish after recovery. Return explicit retryable failures for lock timeout/deadlock, never fabricated success.
- [ ] Run schema, migration and repository suites, then DB package gates/build. Expect PASS including real race and runtime-role ACL tests. Commit scoped schema/migration/repository/test files.

### Task 3: Exact-version storage and verified bounded cache

**Files:** Create `apps/api/src/modules/release-catalog/catalog-store.ts`, `catalog-cache.ts`, `catalog-config.ts`; create `apps/api/test/release-catalog-store.test.ts`, `release-catalog-cache.test.ts`, `release-catalog-config.test.ts`.

**Interfaces:** Produce `CatalogStore.readVersion(object, signal): Promise<Readable>`, `writeReceipt(operationId, bytes): Promise<{key,versionId}>`, `listReceiptVersions(cursor): Promise<{versions,nextCursor}>`; product upload clients remain separate. Produce `VerifiedCache.acquire(object): Promise<VerifiedFile>` (`VerifiedFile` owns an open descriptor, size/hash and a `close()` method). Config contains fixed endpoint/bucket, private cache/journal directories, positive finite byte/disk-reserve limits, maximum object size and concurrency.

- [ ] Write fake-S3 tests where repeated same-key PUT always returns 200/new version. After pinning A then writing B, exact-version read still yields A. Wrong hash/size, missing version, timeout or truncated stream must reject with no final cache entry. Cache hit still requires a fresh DB binding lookup in Task 7.
- [ ] Run `corepack pnpm --filter @markiro/api exec vitest run test/release-catalog-store.test.ts test/release-catalog-cache.test.ts test/release-catalog-config.test.ts`; expect RED before new modules exist.
- [ ] Implement SDK GetObject with mandatory VersionId and fixed endpoint/bucket. Catalog key never performs current-object GET or product PUT; machine commit supplies VersionIds from its own upload response, while standalone can capture HEAD through its existing product key. Derive keys server-side from the saved intent, not from caller data. Full hash is streamed and bounded; ignore ETag/claimed metadata hashes.
- [ ] Implement private, no-symlink cache: exclusive temporary files, bounded downloads (maximum two), space reservation before transfer, streamed size/hash verification, file fsync, exclusive hardlink to the binding-identity/hash name, directory fsync, then serve through the verified descriptor. Revalidate pre-existing cache files before reuse in a new process; concurrent same-binding fills converge without overwriting. Reject unsuitable ownership/mode and unsafe directories. Remove only this operation's cache temporary file on failure, never release or evidence objects.
- [ ] Test ENOSPC before/during write, symlink attacks, interrupted finalization, concurrent fills, eviction while a descriptor is held, and S3 outage with a verified cache hit. Config absent/invalid disables the feature; do not invent production disk capacity. Run new suites plus existing storage tests; expect PASS. Commit scoped files.

### Task 4: Durable receipts and conservative recovery

**Files:** Create `apps/api/src/modules/release-catalog/catalog-ledger.ts`, `catalog-recovery.ts`; create `apps/api/test/release-catalog-ledger.test.ts`, `release-catalog-recovery.test.ts`, `release-catalog-recovery.integration.test.ts`.

**Interfaces:** Produce `CatalogLedger.prepare(operation): Promise<VerifiedReceipt>`, `confirmCommitted(operationId, dbResult): Promise<VerifiedReceipt>`, `scanRecovery(input): Promise<RecoveryPlan>`. `operation` is a strict discriminated union of publication, path/range reservation, channel-change prepare and commit-confirmation; every receipt has its own UUID and schema version. Confirmation references the prepared operation and DB publication/revision. `RecoveryPlan` contains reserved paths/ranges, exact bindings, channel states and explicit blocking reasons; it cannot itself activate writers.

- [ ] Write tests at every boundary: crash before local fsync, after local-only receipt, after S3 PUT with lost response, after exact S3 readback, after DB COMMIT before confirmation. Publication retries retain the same semantic intent. Pointer prepare without corroborated commit blocks that channel. Prepared file bindings reserve names even without visibility.
- [ ] Run new ledger/recovery suites; expect RED. Keep all storage fake/local and isolated DB fixtures.
- [ ] Persist canonical nonsecret receipt bytes with exclusive local create, fsync file and directory. Put `_publication-ledger/<UUID>.json`, then read its exact returned VersionId and verify full bytes/hash before returning VerifiedReceipt. On ambiguous PUT inspect all versions for that exact operation key and compare bytes; never silently repeat the write or accept mismatching receipts. Distinct valid physical versions with identical receipt bytes are deduplicated by semantic operation, not by latest-head selection.
- [ ] Recover from all pages/all versions, checking cursor progress, duplicates, malformed/deleted records, bounds, schema and hashes. Only the already reserved `_publication-ledger/_storage-readiness/<UUID>.txt` technical format is excluded; unknown keys or malformed canonical receipts block recovery. Cross-check independent local/backup receipt inventory and writer fencing. API pagination completion alone is not proof no receipt was administratively deleted.
- [ ] Rebuild union reservations and bindings; conflicts fail closed. Replay channel events only with consistent expected/new revision and corroborated commit, never from prepared intent alone or an S3 latest object. Missing proof produces blocked namespace/channel. Reusing an old DB snapshot cannot resurrect old writer epoch or free a known path.
- [ ] Run recovery with an actual restored older isolated PostgreSQL snapshot and newer ledger; assert reuse 409, ambiguous pointer unavailable and stale executor refused. Expect PASS for all unit and integration suites. Commit scoped files.

### Task 5: Separate machine-publisher authentication

**Files:** Create `apps/api/src/modules/release-catalog/catalog-oidc.ts`, `catalog-publisher.guard.ts`; create `apps/api/test/release-catalog-oidc.test.ts`, `release-catalog-auth.e2e.test.ts`. Modify `apps/api/test/auth-route-policy.test.ts` and the route-policy classifier for the new explicit machine boundary. Controller/module wiring and complete route/OpenAPI inventories belong to Task 6. Add exact `jose@6.2.9` to API through pnpm if still absent; do not edit lockfile by hand.

**Interfaces:** Produce `verifyPublisherToken(token, config, now): Promise<GithubPublisherPrincipal>`. Produce `CatalogPublisherGuard` and an explicit machine-route decorator/policy classification. Exercise the guard through a test-only controller in this task; the real controller is created in Task 6, so this task has no dependency on future implementation. The module remains disabled until complete configuration is present.

- [ ] Write denial matrix for issuer/audience/repo/owner/ref/environment/workflow/tooling SHA, missing claims, nbf/exp/iat, algorithm confusion, forged signature, arbitrary jku, token reused for another intent, cross-product attempts, altered run attempt and tenant/device/cabinet tokens. Valid station publisher can publish only station; handheld only handheld. No signer or platform-admin access.
- [ ] Run OIDC/auth tests with locally generated fixture signing keys/JWKS; expect RED, no GitHub network in tests.
- [ ] Verify JWT with jose using only fixed issuer `https://token.actions.githubusercontent.com`, audience `markiro-release-catalog`, fixed JWKS URL and allowlisted RS256. Require deployment-pinned numeric repository/owner IDs, main ref, exact workflow_ref/workflow_sha, protected environment subject, run_id/run_attempt, jti, actor_id and bounded time claims. If reusable workflow is configured, require its matching pinned job_workflow_ref/SHA as well. No request-selected key endpoint. Live IDs/claims are collected before deployment, never guessed.
- [ ] Store only token jti digest bound to first intent and principal. Creation retries for the same idempotency key can return that intent; the same token cannot bind another intent. A fresh valid token for the same exact run/attempt may resume the same intent, not take another principal's intent. Every mutating step rechecks token/current epoch and principal ownership. Network/JWKS failure yields unavailable, never authorization success.
- [ ] Add explicit machine-route policy classification, not a blanket public bypass. Keep platform capability and tenant subscription policies unchanged. Assert the policy classifier accepts only explicitly machine-guarded routes; tokens never enter logs or ledger. Run all auth inventory and new denial tests; expect PASS. Commit scoped changes.

### Task 6: Publication service and revision-checked channels

**Files:** Create `apps/api/src/modules/release-catalog/catalog-service.ts`, `catalog-publisher.controller.ts`, `release-catalog.module.ts`; create `apps/api/test/release-catalog-service.test.ts`, `release-catalog-publication.integration.test.ts`. Modify `apps/api/src/app.module.ts`, `apps/api/test/auth-route-policy.test.ts` and relevant route inventories/OpenAPI tests to wire the guarded service and current platform audit service.

**Interfaces:** Produce `CatalogService.createIntent(principal,idempotencyKey,request): Promise<IntentView>`, `commitIntent(principal,id,uploadedVersions): Promise<PublicationResult>`, `changeChannel(principal,change): Promise<ChannelSnapshot>`, `getIntent(principal,id): Promise<IntentView>`. IntentView exposes only fixed staged keys/upload targets, expiry and public identity, not catalog credentials. `uploadedVersions` maps only expected file names to VersionIds; standalone captures these internally. `change` includes operation/idempotency key, expectedRevision, targetPublicationId and explicit forward/rollback kind. Expose POST `/release-publisher/intents`, POST `/release-publisher/intents/:id/commit`, GET `/release-publisher/intents/:id`, PUT `/release-publisher/channels/:product/:channel` using the Task 5 guard and Task 1 strict schemas. OpenAPI documents the machine bearer boundary separately from platform sessions.

- [ ] Write tests for complete-set validation, same bytes reordered retry, different bytes conflict, same bytes/new VersionId returning old bindings, foreign intent, expired intent, audit failure and each crash boundary from Task 4. Concurrent conflicting channel CAS: one revision winner, loser409, no partial alias update.
- [ ] Run service and actual-PG publication tests; expect RED before implementation.
- [ ] Implement reserve -> capture versions -> full bounded verification -> existing product acceptance -> durable receipt -> short DB commit with audit. Platform membership/capability is rechecked immediately before commit, not only when an upload URL was issued. Machine run/environment/intent/epoch remains bound. Network work never holds a DB transaction.
- [ ] Before channel receipt/CAS, validate target registered publication, current channel revision, existing product forward/explicit rollback and compatibility rules. Derive latest/download bodies from verified target metadata and existing product serializers. Persist pointer bytes/hash or immutable pointer-object binding with the event; all aliases for one channel resolve one revision. No caller-supplied arbitrary latest JSON or external download URL. Retry by operation ID returns applied revision; a changed request with that ID409.
- [ ] Test server crash after COMMIT before response and before confirmation; read DB state to reconcile, never blindly publish again. Failure to confirm leaves recovery ambiguity explicitly recorded, not a made-up successful receipt. Run complete repository/service/ledger integration suites, expect PASS. Commit scoped files.

### Task 7: Resolver and Caddy integration

**Files:** Create `apps/api/src/modules/release-catalog/catalog-resolver.controller.ts`, `apps/api/test/release-catalog-resolver.test.ts`, `deploy/platform/test/release-catalog-proxy.test.mjs`. Modify `deploy/platform/Caddyfile`, `compose.yml`, `compose.compact.yml`, `env.example`, `preflight.mjs`, `host/config.mjs`, their affected tests, and API module wiring.

**Interfaces:** Internal GET/HEAD `/internal/release-catalog/*` obtains a repeatable-read catalog snapshot then a verified file/pointer body. Return 404 for a known reserved/unpublished path, 503 for unavailable/uncertain catalog/binding, 405 or existing host-compatible 404 for disallowed methods. No storage redirect. Public URL layouts stay unchanged.

- [ ] Write resolver/proxy tests that published A remains A after current S3 object becomes B, including expired-cache/new-process reads. Query/versionId injection cannot select bytes. Ordinary tenant/SaaS/API hosts cannot reach internal routes, including encoded path variants; external direct API ports remain unpublished.
- [ ] Run resolver tests and `node --test deploy/platform/test/release-catalog-proxy.test.mjs`; expect RED.
- [ ] Replace release-host S3 proxy with private API resolver. Strip incoming credentials/query and any internal routing header; reject direct internal paths in every ordinary public host before catch-all proxy. Private API container network is the resolver boundary; test compose host-port and network isolation. Do not treat a caller-controlled Host/header alone as authorization. Keep machine routes separately reachable through their guard, not the internal resolver exception.
- [ ] Confirm binding through DB before every response/cache use; read pointer and referenced metadata in one snapshot. Serve no bytes until cache verification completes. Preserve compatible MIME/disposition/CORS; SHA-based ETag, immutable year cache, mutable pointers revalidated, all errors no-store. HEAD and single-range validate the full object first; reject malformed/multiple/unsatisfiable ranges with416 and no partial200. Do not expose VersionIds.
- [ ] Add private persistent journal mount and bounded cache mount; catalog key/runtime config never appears in rendered logs. Preflight requires fixed endpoint/bucket, cache maximum/object limit/disk reserve, safe mount ownership, writers-disabled bootstrap and explicit OIDC pins. Production numeric capacity is selected from measured free space/largest accepted artifacts in Task 10, not copied from test fixtures.
- [ ] Run resolver/proxy/preflight/host-config and production bundle contracts, including API-down and cached-S3-down cases. Expect PASS. Commit scoped files.

### Task 8: Existing SaaS and workflow publishers use catalog

**Files:** Modify `packages/platform-contracts/src/standalone-releases.ts`, its tests; `apps/api/src/modules/standalone-releases/{standalone-releases.service,release-store,release-runtime,platform-standalone-releases.controller,platform-standalone-releases.module}.ts`; corresponding API unit/e2e/support tests; `apps/saas-admin/src/pages/standalone-releases/api.ts`, `ReleaseUpload.tsx`, `ChannelReleases.tsx`, `StandaloneReleasesPage.tsx`, `errorMessages.ts` and `apps/saas-admin/test/standalone-releases.test.tsx`. Create `tools/release-catalog/client.mjs`, `tools/release-catalog/test/client.test.mjs`. Modify Station publisher/promotion/reseed adapters and tests, handheld `publish.mjs`, `download.mjs`, `resolve.mjs` and tests; `.github/workflows/{station-beta-release,station-stable-release,station-release-reseed,handheld-release}.yml`.

**Interfaces:** Existing upload returns intentId/expiry and staged URLs; registration takes intentId, not an unbound target. Standalone channel view includes revision, setLatest includes expectedRevision/operation ID and explicit rollback intent. Shared CLI `createCatalogClient(config)` provides `createIntent`, `uploadFile`, `commitIntent`, `getIntent`, `changeChannel`; obtains GitHub OIDC tokens for the fixed audience without logging request credentials or tokens.

- [ ] Write tests for delayed second presigned PUT after registration, removed platform membership before commit, ambiguous UI/network retry preserving operation ID, stale channel screen409, changed manifest/file set, and diagnostics reading catalog rather than mutable latest S3. Existing ES256/signature/minUpgradeFrom and capability-denial assertions remain.
- [ ] Write CLI tests with fake Timeweb accepting every same-key PUT; complete catalog commit still refuses replacement. Assert no pointer move before immutable registration and public full readback. Preserve exact beta-source stable promotion, GitHub mirror provenance, handheld monotonic code and first-channel confirmation `1.6.1 (15)`.
- [ ] Run focused new/affected tests; expect RED for the new intent/CAS protocol.
- [ ] Implement SaaS flow with client-calculated file descriptors, server verification and bound intent ID. Keep presigned TTL15 minutes, current standalone installer256MiB/record64KiB limits and offline owner signing. Never add a signing key to browser/server. Adapt diagnostics to explicit catalog availability; no mutable-S3 fallback.
- [ ] CLI uploads only server-issued staging keys with existing narrowly scoped S3 credentials and captures returned VersionIds. OIDC intent/commit/CAS use reviewed workflow pins, protected environment and `id-token: write`; intent sourceSha is validated separately from workflow tooling SHA. Signer publication stays excluded. Leave legacy putImmutable guards intact for code paths not migrated; do not substitute HEAD+PUT or weaken412 assertions.
- [ ] Run API standalone unit/e2e, contracts, SaaS component suites and all Station/handheld/standalone release Node contracts. Update generated OpenAPI/client artifacts only via repository generators. Expect PASS with explicit actual DB coverage; no Windows/device claim. Commit scoped files.

### Task 9: Historical import, backup and fenced recovery tooling

**Files:** Create `tools/release-catalog/import-history.mjs`, `recover.mjs`, `test/history.test.mjs`, `test/recovery.test.mjs`, `docs/runbooks/release-catalog-recovery.md`. Modify `deploy/platform/backup/{files,definitions,schemas,restore}.mjs` and affected tests, `deploy/platform/host/backup-gate.mjs`, `docs/runbooks/release-hosting.md`, `docs/runbooks/handheld-release.md`.

**Interfaces:** `buildHistoryPlan(evidence): HistoryPlan` returns byte-backed imports, permanent path reservations, trusted ranges and blocked namespaces. `validateRecoveryEvidence(evidence): RecoveryPlan` consumes Task 4 semantics; applying requires explicit writers-disabled epoch, fenced executor proof and exact reviewed plan digest. Import uses the same durable catalog mutation path with operator-scoped, audited authority, not direct unrestricted SQL/S3 publication.

- [ ] Write history tests with missing old installer, deleted mirror release, rollback head below an issued version, prerelease at a reserved semver base and no trustworthy upper bound. Missing bytes -> reserved404/write409. Unknown upper bound -> namespace closed. Current listing completion alone cannot open it.
- [ ] Run history/recovery and backup tests; expect RED for absent ledger inclusion and missing recovery gate.
- [ ] Inventory all current mirror releases plus preserved signing/backup records. Reuse verified Autonom1.0.0 bytes/signature as historical evidence; never regenerate its manifest. Verify old Station origin/tag/assets with existing validators. Keep source evidence and acceptance distinctions in immutable import plan. Do not claim missing history reconstructed from current channel heads.
- [ ] Include local receipt bytes, ledger keys/VersionIds, epochs and committed revision evidence in encrypted backups with size/hash manifests. Recovery verifies complete ledger enumeration and independent anchors, reconstructs all reservations and closes ambiguous channels. Old writers are fenced before enabling any restored writer. Failed proof stops recovery with preserved artifacts.
- [ ] Perform isolated actual dump/restore with a deliberately stale DB and newer receipt set; assert immutable names cannot be reused and no silent channel rollback. Exercise role ACLs after restore. No delete/overwrite of production, backups or evidence. Run relevant backup suites and import/recovery tests, expect PASS. Commit scoped changes.

### Task 10: Final gates and protected release preparation

**Files:** Modify `tools/ci/affected.mjs`, its tests, `.github/workflows/ci.yml`, root package scripts as needed for new contract suites, and runbooks above. Record operational evidence only in the existing ignored preparation journal/package; never commit secrets.

**Interfaces:** A scoped reviewed PR and exact-main artifacts feed existing protected platform deployment. Operational evidence reports source SHA, artifact digest, backup/restore, catalog epoch/history state, external byte readback and separately unrun hardware acceptance.

- [ ] Write CI-ownership tests: edits under `tools/release-catalog/` run new contracts plus affected API/DB/platform/Station/handheld consumers; schema/route/Caddy edits cannot skip their required gates. Run RED, implement minimal affected mapping, then PASS.
- [ ] Run serial proportional final gates: contracts/DB/API/SaaS package test, lint, typecheck and build; affected release/production Node contracts; `corepack pnpm format:check`; `git diff --check`. Use isolated DB and record no skipped required tests. No unrelated flake reruns or assertion/timeout weakening.
- [ ] Fetch target main, inspect complete three-dot diff and commit range, preserve unrelated changes, then obtain one independent whole-branch review with the spec, plan, tests and five Review Focus cases. Resolve material findings with reproducing tests; scoped commit/push/PR and exact-head CI, then authorized merge and exact merged-main CI. Do not call CI a live release proof.
- [ ] Prepare concrete protected rollout with fresh backup plus isolated restore and encrypted independent copies. Measure host disk, choose explicit cache budget/object limit/reserve; verify versioning and no current/noncurrent lifecycle expiry for pinned upload/ledger prefixes, exact key rights, private mounts and OIDC pins. Keep writers disabled. Install runtime secrets through the established secure workflow, never arguments/output. Import/reserve approved history before enabling a namespace.
- [ ] Deploy read-only resolver through existing protected platform workflow, provide approval URL only after exact inputs are ready. Switch release DNS only after intended host/TLS/readback is ready. Verify strict TLS, allowed/denied paths, HEAD/range, cache behavior and full pinned bytes. On a unique technical fixture, overwrite current S3 version with different bytes and prove resolver still returns the bound original; retain all technical evidence/versions. Activate writer epoch only for namespaces whose history is proven.
- [ ] Reseed accepted Station history/heads via protected workflow; preserve Autonom1.0.0, sign/register1.1.0 only with valid owner signing custody and existing acceptance gates; publish handheld1.7.0(16) only after real empty-channel proof and authorized `empty_channel_confirmation=1.6.1 (15)`. If history or signing proof is missing, keep that namespace closed and report the exact blocker. Never invent signer release or bypass protected approval.
- [ ] Verify public manifests/installers with full hashes/signatures, revision and source evidence. Report Windows installed-device update, scanner/printer and factory-shift checks as unrun unless actually exercised. Record final state and retained copies; no return to mutable direct-S3 reads on rollback.

## Plan self-review

- Spec coverage: schema/atomicity Tasks1–2/6; pinned read/cache3/7; durable journal/recovery4/9; machine/platform authorization5/6/8; existing publishers/UI8; complete historical reservations9; rollout/backup/CI10.
- Shared interfaces: request/file-set/identity types originate in1; repository2 consumes them; store/cache3 consumes PinnedObject; ledger4 supplies VerifiedReceipt to2/6; auth5 supplies principal to6; service6 supplies state to7/8; recovery9 consumes4 and feeds10. No task uses a prepared receipt as committed-pointer evidence.
- Replay distinction: semantic digest excludes physical VersionId but includes all content/evidence; identical retries return existing binding. Pointer requests are operation-ID and expected-revision bound.
- Five Review Focus cases each have named assertions in the responsible task. Unit tests, actual PG race/restore tests, live S3 probes and Windows/device acceptance remain separate evidence categories.
- Existing environment constraints: use Corepack to invoke pnpm; do not modify dependency policy to fix the global launcher. Existing separate app/migrator roles are reused, not new database credentials. Tests do not use shared production resources.
