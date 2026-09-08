# US development isolation

Status: development-only, release locked. Approved 2026-09-05.

## Branch boundary

Develop on `codex/us-mvp` in the existing isolated worktree. The directory may retain its original name, `.worktrees/us-docs-audit`. Do not merge this branch into `main`, create release tags, publish images/installers, or deploy it until development is complete and the owner explicitly approves a separate release-enablement change.

Bring reviewed updates from `main` into this branch, never the reverse while the lock is active. Preserve local edits before synchronizing. No automatic merge or release is configured. The main checkout and its production workflows are not changed by this work.

## Release lock

Every job in the ten inherited operational workflows has an unconditional false job condition. This includes production image publication, web deployments, Station/Signer publication and repair, infrastructure, administrator provisioning and production diagnostics. Their concurrency groups use a US-only prefix so a manual dispatch cannot cancel or occupy the main production queue.

The ordinary CI and dependency review remain read-only. `US development isolation` runs on pushes to `codex/us-mvp`, pull requests and manual dispatch. It validates the lock and tests the shared domain foundation and isolated API entry without production environments, secrets, publication or deployment. A pull request targeting `main` fails the isolation check. New executable operational workflows, re-enabled jobs, write tokens and secret-bearing check jobs fail validation.

Run locally from this worktree:

```sh
node tools/us-development/check-isolation.mjs
node --test tools/us-development/test/*.test.mjs
```

This is a versioned workflow guard against accidental publication, not a security boundary against a maintainer deliberately editing workflows or running deployment scripts directly. Do not run inherited production/infra/release scripts from this worktree. GitHub rulesets, environment branch restrictions, required checks and repository settings have not been changed or verified remotely. Publishing the branch requires separate authorization; the lock is local until the changed files are committed and pushed. Release-enablement must be a reviewed code change, not a dispatch input or environment-variable override.

In particular, never dispatch the infrastructure workflow from `main` with a US commit in `target_sha`. The inherited main workflow can check out that explicit SHA without consulting this branch's job conditions; its dispatch-ref and checkout-SHA checks are not an ancestry restriction. Closing that repository-wide path requires a separately scoped change to main and/or remote protections. The branch-local lock does not claim to close it.

## Isolated local dependencies

Use only synthetic data. Never copy the primary checkout's `.env`, database, volumes, backups or credentials. `deploy/us-development/compose.yml` is a standalone dependency stack, not an overlay on production or the normal development stack:

| Surface               | US local endpoint | Isolation                                                   |
| --------------------- | ----------------- | ----------------------------------------------------------- |
| PostgreSQL            | `127.0.0.1:55432` | Database `markiro_us_dev`, separate user and project volume |
| S3-compatible storage | `127.0.0.1:19000` | Bucket `markiro-us-development`, separate project volume    |
| Storage console       | `127.0.0.1:19001` | Loopback only                                               |
| SMTP capture          | `127.0.0.1:11025` | Mailpit, no external SMTP delivery                          |
| Mail UI               | `127.0.0.1:18025` | Separate project volume, loopback only                      |

The fixed Compose project is `markiro-us-development`. Do not override it with `-p`, `COMPOSE_PROJECT_NAME`, external volumes, or additional Compose files. Do not run the normal `docker-compose.dev.yml` for US work. After local validation, dependencies can be started explicitly with:

```sh
docker compose --env-file /dev/null -f deploy/us-development/compose.yml up -d postgres mailpit minio
docker compose --env-file /dev/null -f deploy/us-development/compose.yml run --rm minio-init
```

`local.env.example` in the same directory contains matching synthetic loopback settings. A personal copy belongs at the ignored `.env.us-development`; never overwrite an existing file. Application ports are reserved as API `3100`, admin `5174` and platform admin `5474`. No containers or application servers are started by the isolation checker itself; the separately invoked runtime smoke test starts and stops a loopback-only API.

## Local API entry

The US executable is separate from the RU application composition. It requires explicit matching US edition settings, development/test mode and the isolated loopback addresses above. It rejects missing or incompatible values before creating the application. The existing RU executable rejects an explicit US edition before auth or database setup; its legacy unset-edition behavior is preserved.

Build and run from the US worktree root using Node 24 or newer:

```sh
pnpm turbo build --filter '@markiro/api...'
env -i "$(command -v node)" --env-file=deploy/us-development/local.env.example apps/api/dist/main.us.js
```

The clean child environment prevents inherited primary credentials, Node preload options or shell settings from overriding the synthetic example. Do not load the primary `.env`. Metadata and liveness start without dependency containers; auth and profile operations require the isolated PostgreSQL schema. Startup never migrates or seeds it. The process binds to `127.0.0.1:3100`; stop it with Ctrl-C. Use the configured `BETTER_AUTH_URL` hostname for auth/profile requests: `localhost` and `127.0.0.1` are not interchangeable authorities or cookie scopes.

| Endpoint                                            | Result                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /deployment`                                   | US edition, release disabled, `en-US` / `es-US` locale metadata                                       |
| `GET /health/live`                                  | 200, process alive                                                                                    |
| `GET /health/ready`                                 | 503, `us_business_modules_not_ready`                                                                  |
| Allowed `/api/us-auth/*` methods                    | US session/MFA and organization selection; no public signup                                           |
| `GET /traceability/profile`                         | MFA and US read capability; absent profile returns 503 only to settings administrators, otherwise 403 |
| `PUT /traceability/profile`                         | Initial profile provisioning; identical retry returns the original                                    |
| RU business, auth and not-yet-implemented US routes | 404                                                                                                   |

The subsequent [master-data foundation](master-data-foundation.md) also registers GET/POST collections and GET/PATCH UUID items for `/traceability/parties` and `/traceability/locations`. These require a verified US session, current capability and a valid persisted profile. There are no DELETE routes. The presentation-only `GET /traceability/access` returns the fresh principal's capability list after session/MFA verification; it may be read before profile setup and neither authorizes a business operation nor signals that setup is required. The local browser proxy permits only that exact route and the exact master-data paths in addition to the access/profile routes above; other business paths remain closed.

The catalog increment additionally registers GET/POST `/traceability/catalog/products` and GET/PATCH `/traceability/catalog/products/:id` in the US API. These routes require the same current session, membership and valid US profile; no DELETE route exists. The subsequent [catalog browser increment](catalog-browser.md) permits only these exact collection/UUID item paths in the local browser proxy and adds the connected Products workspace.

The [product-profile persistence increment](../superpowers/plans/2026-09-05-us-02-product-profile-persistence.md) registers GET/PUT `/traceability/products/:productId` in the US API only. Reads return revision 0 defaults until the first explicit save; PUT requires the full editable document and `expectedRevision`. Master-data writers can edit descriptions; actual coverage changes additionally require QA permission and stamp the trusted reviewer/time. Divergent stale saves return 409 `product_profile_conflict`; unchanged current saves and identical immediate retries do not create audit entries. Both changes and their full audit snapshots commit atomically. The [2026-09-06 profile UI](catalog-browser.md#product-profile-increment--2026-09-06) opens only the exact UUID item path in the local browser proxy, without query parameters. Profile collections/deletion, nested paths and lot routes remain closed.

The [lot persistence increment](../superpowers/plans/2026-09-06-us-02-lot-persistence.md) adds GET/POST `/traceability/lots`, GET `/traceability/lots/:id` and POST `/traceability/lots/:id/status` to the US API only. Manual creation allows imported assignment, including an incomplete missing source, with tenant/source/TLC duplicate protection. QA status actions require a revision and reason, commit exact before/after audit atomically and recognize only an identical same-actor immediate previous-revision retry. The [source-correction increment](implementation-plan.md#us-02-lot-source-corrections--2026-09-06) adds PATCH `/traceability/lots/:id/source` with creation permission, mandatory revision/reason and exact audit. It preserves ID/TLC/product and rejects corrections after a permanent server-owned source lock. Future finalizers must set that lock under the lot row lock in the same transaction as frozen snapshots; events are not implemented by this storage seam. TLC/product changes, unlock, deletion, events and all browser lot proxy paths remain unavailable. Storage uses additive migrations0118/0119; startup still never migrates it.

The [reference-document increment](../superpowers/plans/2026-09-06-us-03-reference-document-persistence.md) registers GET/POST `/traceability/reference-documents` and GET `/traceability/reference-documents/:id` in the US API only. Read capability permits metadata access; creating requires any receiving/production/shipping write capability, reloaded under the membership/profile transaction locks. Issuers must be active parties of the same tenant. Creation and exact audit are atomic; duplicate type/party/number returns 409 without a second record. Search (`search`), type, party and archival filters use bounded pagination. No document editing, archive/delete command, attachment, event link or browser proxy path is opened. Migration0120 is applied only by explicit migration/testing, never startup.

The [receiving draft increment](../superpowers/plans/2026-09-06-us-03-receiving-draft-persistence.md) registers POST `/traceability/receiving` and GET/PUT `/traceability/receiving/:id` in the US API only. Incomplete drafts have independent `draftVersion` concurrency control; event `revision` remains 1. Tenant-command operation keys replay original successful results after current authorization. Header, ordered rows, document links, command receipt and exact audit commit atomically. Reads preserve saved values; changed saves require current active tenant-owned references. No lot, source lock or inventory is changed. Migration0121 is additive and never applied on startup. Receiving list/search, lifecycle commands, CSV and browser proxy paths remain closed.

Only the US auth/profile/master-data/catalog/product-profile/lot/reference-document/receiving-draft composition and its owned database pool are registered; no RU auth factory, scheduler or outbound client is loaded. Business requests enforce the configured Host, trusted mutation Origin, JSON-only bodies and `Cache-Control: no-store`. The default body limit remains 16 KiB; only exact receiving POST collection and PUT UUID item paths allow 256 KiB, additionally bounded by 100 rows and 100 document links. Forwarding headers are not trusted. Missing/incompatible database tables fail closed with a sanitized 503; no automatic repair runs. The pool uses server-side statement cancellation and closes with the application.

The subsequent [receiving browser increment](receiving-browser.md), 2026-09-07, adds GET `/traceability/receiving` for bounded tenant-scoped summary search and pagination. It opens only exact receiving/reference-document collections (optional query) and UUID items (no query) in the local browser proxy. Receiving list, draft editor and document metadata creation are connected; lifecycle, CSV, attachment and unknown nested paths remain closed. This supersedes the historical list/proxy exclusions in the preceding increment paragraphs without changing the release locks or primary runtime.

The subsequent [saved-draft data check](receiving-browser.md#saved-draft-data-check--2026-09-07) adds only GET `/traceability/receiving/:id/readiness?expectedDraftVersion=N`. It reads saved receiving inputs and current references without mutations or finalization. Its local proxy path accepts exactly the UUID target and canonical version query; extra/nested commands remain closed. A complete check is not release or export readiness.

### Ordinary finalization boundary — 2026-09-07

The [ordinary Receiving increment](receiving-browser.md#ordinary-finalization--2026-09-07) extends that US-only composition with POST `/traceability/receiving/:id/finalize` under the existing 16 KiB limit, current QA/MFA checks, immutable frozen reads and mixed draft/finalized lists. It supersedes older lifecycle/proxy exclusions only for this command. Migration0122 is additive and was exercised only in owned disposable databases; startup still never migrates, and the base development database was not migrated.

The local browser proxy accepts only the exact UUID finalize path without a query and bounded, non-duplicated receiving-list parameters including optional draft/finalized status. Actual proxy/browser checks and all 17 isolation contracts passed. Post-integration receiving DB tests passed 22/22 and affected API tests 284/284. URL semantics remain authoritative in server validation/locked snapshot construction; SQL enforces structural/relational consistency. Corrupt persisted URL references fail closed with 503, not typed 409 business findings. No additional runtime, database extension, external fetch, hosted resource or operational workflow capability was added.

### Exempt receipt boundary — 2026-09-07

The exempt Receiving increment reuses the same exact readiness and finalize routes, 16 KiB command limit, current MFA/membership/QA reload and local proxy allowlist. It adds no endpoint, outbound fetch, profile mutation, browser storage, secret, hosted resource or release capability. Receipt extensions are optional for legacy rows but strict when present; new reviewed finalizations use frozen snapshot v2 while explicit v1 reads/replays remain compatible. The real companion uses the existing owned disposable database and servers, creates only synthetic tenant-scoped rows, and leaves the base database and primary environment untouched.

The 2026-09-08 original-workflow transport switch supersedes the earlier response
formats: existing Receiving create/save/finalize routes now return command-specific
acknowledgements, detail/list GETs return live envelopes, readiness is v4 and new
finalizations freeze v3. Exact old v1/v2 command retries and frozen content remain
unchanged. The proxy permits only bounded, unique search/status/history/limit/offset
fields, with four statuses and current/all history; no amend/void/history/basis
endpoint is added. The original-only finalize body remains strict and 16 KiB;
draft bodies retain their existing 256 KiB limit. Successful acknowledgements
require a separate GET before editing can reopen. A failed recovery GET never
causes another mutation. This changes no host, origin, authorization, persistence,
outbound-service or release permissions.

### Receiving lifecycle HTTP boundary — 2026-09-08

The later [lifecycle dialog increment](receiving-browser.md#lifecycle-dialogs-and-recovery--2026-09-08)
connects QA correction/void actions and explicit retry/current-state recovery in
the local browser only. Its new UI suite is included in the existing check-only
job. Real browser validation uses only the owned disposable synthetic MFA fixture;
it changes no runtime composition, migration, credentials, dependency or deployment
permission. Amendment editing and full history/basis navigation remain incomplete.

The subsequent server increment opens POST `/traceability/receiving/:id/amend`
(201, including replay), POST `/traceability/receiving/:id/void` (200), GET
`/traceability/receiving/:id/revisions` and GET
`/traceability/lots/:id/receiving-basis` only in the isolated development API.
Existing PUT draft and POST finalize paths now accept their strict original or
explicit-v2 command unions. Versioned amendment saves and every finalize/amend/void
reload current QA before parsing or replay; original saves retain receiving-write
capability. Read paths require current read membership and MFA, with strict bounded
`limit`/`offset`. Every mutation retains trusted Origin, Host, JSON, server request
ID and transaction/audit boundaries. New lifecycle bodies remain 16 KiB; only the
existing full-draft replacement keeps 256 KiB. No new outbound clients or migrations.

This supersedes the preceding original-only server input/route restriction, not
the browser boundary: the local proxy still denies amend/void/history/basis paths,
and the active client rejects explicit revision inputs. New browser commands must
connect captured-context acknowledgement checks and fresh-GET recovery together.
No intermediate deployment is permitted; release locks remain unchanged.

The subsequent client-transport increment opens only exact UUID amend/void paths
without queries and UUID revisions/receiving-basis paths with bounded, unique
limit/offset parameters in the local Vite proxy. Unknown, duplicate, noncanonical
and nested paths stay denied. Explicit client writes require a captured live
record before sending and validate their historical acknowledgement against its
immutable copy. This supersedes the preceding proxy/client restriction, not the
release lock. No new interface controls are connected, no automatic mutation retry
or recovery GET is added, and current session/MFA/QA remain server-authoritative.

Service/release readiness deliberately remains unavailable while other business modules are unfinished. The [separate US browser entry](browser-entry.md) now adds an isolated build and server edition attestation; matching environment values alone are not proof of frontend isolation. Local synthetic-owner provisioning is explicit, never automatic. Recovery remains unavailable. Do not connect the RU admin to this API.

Profile tenant and actor are derived from the verified session, never client IDs. Every request reloads membership and resolves the [isolated US capabilities](access-foundation.md); the store checks read/settings capability inside its transaction while locking the membership row. `PUT` accepts only `code`, explicit IANA `timeZone` and optional `retentionYears` (default 5). The server fixes the baseline and timestamps. Identical retries still require settings permission and create no extra audit event; a different configuration returns 409. This is initial provisioning, not profile switching or settings editing. Every HTTP request gets a fresh server-generated request ID; profile creation records that ID in its atomic audit event.

After building, `node --test tools/us-development/test/runtime-entry.smoke.mjs` exercises the actual executables, including rejection and graceful shutdown. It temporarily reserves port 3100; stop a manually running US API before this check.

## Isolated profile persistence tests

The US profile store has both direct persistence and real HTTP integration tests. Start only the US PostgreSQL service above, build `@markiro/db` and `@markiro/platform-contracts`, then run from the US worktree root:

```sh
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/db exec vitest run test/traceability-profile-migration.e2e.test.ts
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/api exec vitest run test/us-profile-store.e2e.test.ts
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/api exec vitest run test/us-http.e2e.test.ts
```

These fixtures never consume `DATABASE_URL`. They validate the loopback port, base database and user, then create their own randomly named `markiro_us_profile_*` databases, apply the migration chain and remove only the databases created by that invocation. They do not migrate or reset the base `markiro_us_dev` database. Without the explicit US test variable, database cases skip. The check-only US workflow supplies its own ephemeral PostgreSQL and runs these cases explicitly.

The local US PostgreSQL service was started for synthetic verification on 2026-09-05. The primary PostgreSQL container was not modified; mail and object-storage services were not started. This is local development evidence, not hosted infrastructure or production-data geography evidence.

All future hosted US persistence and infrastructure must remain outside the Russian Federation, per the shared MVP contract. No hosted environment is created in this increment.

The [connected lot browser](lot-browser.md) adds only exact collection/UUID/source/status paths to the local proxy. No general lot patch, delete, unlock or event route is exposed; the server independently restricts methods and permissions. It uses the same synthetic fixture and release locks.

## US session foundation

The independent auth factory uses `/api/us-auth` and `markiro-us` cookies. It is mounted in the isolated US executable through the allowlisted wrapper and tested over real loopback HTTP against disposable US PostgreSQL. Do not mount the raw Better Auth handler: the wrapper limits paths/methods and requires a trusted Origin for mutations. Raw library error logging is disabled because adapter errors can contain credential-bearing SQL parameters; unexpected failures become a sanitized 503.

- Public signup, organization creation, Station/API keys, RU mail and platform-auth routes are absent from the allowed surface.
- Password-only sessions may enroll a TOTP authenticator. Organization discovery and selection require verified MFA; tenant operations additionally reload active membership and their specific capability.
- Every login requires a fresh TOTP or one-use backup-code challenge. Trusted-device and sessionless verification are disabled. Old password sessions must sign in again after enrollment; they cannot inherit another session's assurance.
- MFA enrollment is insert-only. Concurrent requests cannot replace an existing factor. Replacement, lost-enrollment recovery and account provisioning are not available in this increment.
- Pending enrollment locks for 15 minutes after ten failed codes. Login challenge limits remain enforced by Better Auth. Local request limiting is explicitly enabled; caller-supplied forwarding headers are ignored, so requests share a per-path bucket. The HTTP mount must preserve a reviewed source-IP boundary before changing this local policy.
- Migration `0114_us_session_assurance.sql` adds an opt-in flag to cabinet users and two US-only tables. Existing users default to MFA disabled; existing RU auth behavior is unchanged. Assurance is removed with its session or factor. The separate US database remains mandatory; a cookie prefix is not a substitute for infrastructure or secret isolation.

Run the focused checks after building `@markiro/db`:

```sh
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/db exec vitest run test/us-auth-schema.test.ts test/us-auth-migration.e2e.test.ts
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/api exec vitest run test/us-auth.e2e.test.ts
```

The browser interface and explicit local synthetic-user provisioning were added in subsequent increments; see [browser entry verification](browser-entry.md). Recovery delivery, production TLS/cookies, audit of authentication events, and hosted operation are not proven by these tests. The base development database remains unprovisioned; test fixtures create users only in their own disposable databases. See the [session foundation plan](../superpowers/plans/2026-09-05-us-00-session-foundation.md) and [HTTP integration record](../superpowers/plans/2026-09-05-us-00-http-integration.md) for scope and verification results.

## Verification — 2026-09-05

- 11 isolation tests pass, including mutation cases for re-enabled publication, an unknown operational workflow, privileged checks and a removed/bypassed checker. The initial unprotected configuration failed the new tests before implementation.
- The broader contract run exercised 1,137 tests: 1,125 passed initially; 11 sandbox-dependent failures passed targeted retries with local access (7 HTTP health checks, 3 disposable Caddy adapter checks, 1 pnpm dependency graph check). One disposable S3 bootstrap migration smoke test remains explicitly skipped because the sandbox denied its listener. No real cloud migration was attempted.
- Domain regression: 532 tests in 37 files, source/test typechecks and build pass. Full-worktree formatting, scoped JavaScript lint, documentation consistency and diff checks pass.
- Docker Compose configuration validation passed before startup. The later profile/session increments started only US PostgreSQL, as recorded above. Caddy validation used temporary read-only test config, not a deployed application.
- Independent review found no blocking issues; its main-selected SHA caveat is documented above. Main-checkout workflow diffs are empty; existing CI, dependency-review workflow and dependency manifests/lockfile are unchanged.
- No commit, push, release, cloud configuration or production operation was performed. Migration tests apply SQL only to their own disposable local databases; the base US database is not migrated. Remote enforcement and live workflow execution are not verified.

## Catalog persistence verification — 2026-09-05

The [catalog persistence increment](../superpowers/plans/2026-09-05-us-02-catalog-persistence.md) tests migration0116 and strict legacy GTIN boundaries on disposable US databases. It does not migrate the base development database or primary database. Run the focused checks with the same explicit US test variable described above, after rebuilding `@markiro/db`:

```sh
export US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
pnpm --filter @markiro/db exec vitest run test/us-catalog-schema.test.ts test/us-catalog-migration.e2e.test.ts
pnpm --filter @markiro/api exec vitest run test/us-catalog-operational-boundaries.e2e.test.ts
pnpm --filter @markiro/api exec vitest run test/us-catalog.e2e.test.ts test/us-catalog-http.e2e.test.ts
```

The local checks pass six DB cases, nine operational cases and real store/HTTP catalog cases; current totals and review status are in the [implementation progress](implementation-plan.md#us-02-catalog-persistence-increment--2026-09-05). The shared column permits null, but RU DTOs, Station payloads/mirrors and GTIN-dependent operations retain strict boundaries. The new update timestamp dates pre-existing products to the migration baseline; it is not reconstructed historical activity. No browser, hardware, provider or hosted acceptance is established by these tests. Broader package-test infrastructure limits remain separate from the successful US-specific checks.

## Before release enablement

The 2026-09-08 [amendment editor increment](receiving-browser.md#amendment-editor-and-frozen-comparison--2026-09-08)
adds only US browser editing/comparison, regression selection and local synthetic
browser checks. At that checkpoint it did not enable correction check/finalize in
the UI. It changes no release destination or infrastructure. Its two complete browser runs
used fixture-owned disposable US databases, not the base or primary database.

The subsequent [amendment finalization increment](receiving-browser.md#amendment-check-and-finalization--2026-09-08)
connects saved-data checks and explicit QA revision finalization through existing
US-only endpoints. It changes only the isolated UI, regression selection, local
synthetic browser tests and documentation. No new route, migration, credential,
dependency, release permission or hosted resource is introduced. Release stays
locked; browser fixtures own and dispose of their synthetic databases.

The subsequent [revision navigation increment](receiving-browser.md#revision-navigation-and-history--2026-09-08)
connects existing read-only revision/history endpoints and bounded registry filters.
It changes only US UI, tests, check-only regression selection and documentation;
it introduces no mutation, authorization grant, route, infrastructure or release
capability. Navigation GETs use the existing workspace lock and session recovery.

The subsequent [lot-basis increment](lot-browser.md#current-receiving-basis--2026-09-08)
connects existing read-only support endpoints to lot details and exact receipt
navigation. Changes are limited to US UI, tests and documentation. The existing
check-only job already runs the expanded `us-lots-ui` suite. No server, schema,
dependency, release workflow, credential or hosted resource changes are included.
Real browser verification uses only fixture-owned synthetic databases.

The [local synthetic-owner command](local-owner-provisioning.md) is now implemented as an explicit CLI, not a startup action or HTTP route. It creates only the reserved local identity, organization, membership and audit, with no profile or MFA bypass. Base database initialization and actual invocation against that base were not performed; integration tests use disposable databases. The [browser access/profile flow](browser-entry.md) is implemented locally. Recovery, auth-event audit and remaining business modules are still open.

The subsequent metadata-only API increment is recorded in the [runtime entry plan](../superpowers/plans/2026-09-05-us-00-runtime-entry.md). The [profile persistence plan](../superpowers/plans/2026-09-05-us-00-profile-persistence.md) adds real isolated PostgreSQL verification: all 356 DB tests pass; the broader API run passed 2,861 tests, with two signer configuration failures passing a targeted synthetic-key retry and 50 explicitly skipped cases. These local results do not change the release lock or establish HTTP/session, hosted or external-service readiness.

Complete the P0 acceptance gates; verify runtime edition isolation and every persistent surface; review auth/locales and generated artifacts; approve the target infrastructure and secrets; then design and test a separate US release workflow. Do not restore the inherited RU deployment destinations for a US release. Enabling release and merging shared changes are separate decisions.
