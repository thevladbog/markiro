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

## Receiving CSV storage boundary — 2026-09-08

The [CSV preview storage checkpoint](../superpowers/plans/2026-09-08-us-03-receiving-csv-storage.md)
adds migration0127 and an independent tenant-anchored preview table. It retains
original bytes/hash, original header, findings and nullable proposed draft/digest,
with a 256 KiB byte cap and exactly 24 hours of apply lifetime. File hashes are
not unique; expired evidence is not automatically deleted. Migration generation
adds no extension and changes no existing table. Only fixture-owned disposable
US databases are migrated by verification, never the base or primary database.

This is a storage seam, not an exposed import feature. Full JSON validation,
current authorization, tenant reference resolution, preview audit and atomic
apply/result binding still belong to the next server increments. The storage
checks do not prove those service boundaries. No CSV HTTP route or browser proxy
path is registered, no body limit is changed, and startup never migrates or
imports. The check-only US workflow includes the bounded input and new storage
tests; operational workflow locks and deployment permissions are unchanged.

## Receiving CSV internal preview service — 2026-09-08

The subsequent [preview service checkpoint](../superpowers/plans/2026-09-08-us-03-receiving-csv-preview-service.md)
implements internal create/read operations over migration0127. Both reload current
Receiving-write membership and the US profile before parsing inputs or reading a
preview. Creation resolves exact IDs/canonical GTIN within the tenant, locks
references in the existing Receiving order, and stores the preview with a
metadata-only audit in one repeatable-read transaction. Invalid files/rows and
missing or inactive references retain findings without an applicable proposal.
No receiving event, lot, operation receipt or finalization is created.

Reads validate saved parser evidence, row bindings and normalized proposal/digest;
corruption fails closed without repair or raw-data errors. An expired preview can
still be inspected under current writer authority. Reopening never retargets a
saved GTIN to today's catalog entry and does not certify current apply eligibility.
The apply command must separately revalidate expiry and references.

This supersedes the storage checkpoint's unimplemented preview-service boundary,
not its HTTP/release restrictions. The service is not registered in a controller
or runtime module; CSV HTTP/proxy paths remain closed. Session/MFA integration,
HTTP body limits, atomic apply/replay, browser confirmation and CSV output are not
established by internal-service tests. Operational jobs remain unconditionally
locked; the existing check-only job selects the new tests.

## Receiving CSV apply binding storage — 2026-09-08

The [apply binding checkpoint](../superpowers/plans/2026-09-08-us-03-receiving-csv-apply-storage.md)
adds migration0128 and `receiving_csv_applications`. It binds one preview to an
existing `receiving.csv.apply` operation using composite tenant/content foreign
keys. A preview without a proposal, another tenant's row or a different digest
cannot satisfy the binding. Identical files can still have independent previews
and operation keys; multiple same-content previews can refer to one saved result.
The existing operation primary key and event FK remain unchanged. No historic
preview, receipt, draft or frozen snapshot JSON is rewritten.

Only the SQL command allowlist is extended; current Receiving acknowledgement
unions and runtime commands are unchanged. This is a storage prerequisite, not
the atomic apply service. The following service checkpoint must authorize and
lock, validate receipt JSON, check first-application expiry and current references,
create the draft through shared transaction primitives, then store the receipt,
binding and exact audits together. SQL intentionally does not prohibit retaining
expired evidence or implement time-dependent first-application validation.

The relation has no runtime writer or automatic cleanup. HTTP/proxy paths,
body limits, browser behavior, MFA boundaries, dependencies and operational locks
are unchanged. The existing check-only US job selects the new migration tests.
Verification migrates only fixture-owned disposable US databases. Base/primary
databases, hosted infrastructure and production workflows remain untouched.

## Receiving CSV internal atomic apply — 2026-09-09

The [atomic apply service checkpoint](../superpowers/plans/2026-09-09-us-03-receiving-csv-apply-service.md)
implements `applyPreview` internally over migration0128. Current Receiving-write
membership/profile is reloaded before parsing, locking or replay. First application
checks saved evidence/digest and expiry, resolves current tenant references, and
rejects changed resolution rather than retargeting a GTIN. An additional expiry
check before returning from the transaction prevents lock waits from extending
first-apply eligibility. Failure rolls back the complete transaction.

Original draft creation now uses a shared transaction-level helper. The CSV
command commits root/header/ordered children, canonical operation receipt,
preview binding, draft-created audit and metadata-only import-applied audit
together. Existing legacy/versioned Receiving endpoints retain their command
contracts and replay behavior. No automatic finalization or lot assignment occurs.

Successful replay ignores today's expiry/catalog/lifecycle state but still
validates saved evidence and the original result/binding under current authority.
The same key/content can bind another preview to that result; a different key on
an already-applied preview returns the original receipt without another operation
or audit. Contradictory already-committed key/preview results conflict. The private
receipt retains its original key and preview ID; it is not a transport-level
acknowledgement of a new key or a substitute for a live-record GET.

No controller/module registration, HTTP/proxy route, body limit, UI, dependency,
migration or hosted resource is added. Public acknowledgement correlation,
session/MFA transport checks, browser recovery and CSV output remain unimplemented.
The existing check-only US workflow selects the new tests; operational locks and
publication permissions remain unchanged.

## Receiving CSV isolated HTTP — 2026-09-09

The [HTTP checkpoint](../superpowers/plans/2026-09-09-us-03-receiving-csv-http.md)
supersedes the previous internal-only registration boundary. Only the US runtime
now exposes preview POST, saved GET and apply POST under
`/traceability/receiving/imports`. Every route requires real US session/MFA and
current Receiving WRITE capability. The preview-only JSON cap is 512 KiB with a
256 KiB decoded-file cap; apply and unrelated import paths remain at 16 KiB.

Public preview responses contain bounded saved findings and normalized proposal,
not file bytes or original raw header. Apply responses separate current request
correlation from the unchanged original receipt, including different-key and
alias-preview retries. Clients must GET the live event after acknowledgement;
the response does not assert the event remains a draft. Raw data/SQL never appears
in error bodies. Real HTTP tests use disposable synthetic databases and MFA.

Browser routes/proxy, confirmation/recovery UI and safe CSV output remain open.
The check-only workflow includes the shared HTTP contract suite and existing
Receiving HTTP suite. Operational locks, dependencies, migrations and release
permissions are unchanged; no hosted settings were modified or verified.

## Separate request worker runtime — 2026-10-05

The [local runtime increment](../superpowers/plans/2026-10-05-us-09-worker-runtime.md)
adds an explicit worker executable, checked build descriptor and serial polling
outside the HTTP process. Tasks 1–4 have independent acceptance; Task 5 local
checks are complete. Task and final review acceptance are tracked in the execution
ledger and owner handoff. The API
does not start this worker and business readiness remains closed. The subsequent
Requests HTTP checkpoint below supersedes the earlier HTTP/download/manual-retry
exclusion; EN/ES cabinet integration remains pending.

Build from this isolated worktree using Node 24+ and repository-pinned pnpm:

```sh
corepack pnpm@11.22.0 --filter @markiro/db build
corepack pnpm@11.22.0 --filter @markiro/domain build
corepack pnpm@11.22.0 --filter @markiro/platform-contracts build
corepack pnpm@11.22.0 --filter @markiro/api build:us-request-worker
```

The dedicated build writes `apps/api/dist/us-request-build.json`, recording the
actual Git SHA, dirty state, lock digest, renderer versions and complete compiled
API/shared output/font inventory. It may compile dirty development output, but
the publication entry refuses `dirty: true`. This current uncommitted checkout
therefore cannot publish through the real command; an owner-authorized source
commit and rebuild are required separately. Clean fixture builds used in tests
do not waive this gate or attest the dirty product source as committed.

After that separate gate, an explicit local invocation is:

```sh
env -i "$(command -v node)" --env-file=.env.us-development apps/api/dist/main.us-request-worker.js
```

The ignored personal environment must contain the matching synthetic US settings
and separately configured existing private package storage using all six
`US_REQUEST_PACKAGE_S3_*` fields documented in `local.env.example`. No bucket or
credentials are provisioned here. Missing package storage exits 2 before a claim;
invalid configuration/build/schema or fatal/forced termination exits 1, graceful
stop exits 0. Optional Plan storage uses only `US_PLAN_ARTIFACT_S3_*`; absent
storage permits genuinely absent frozen Plans, while unreadable pinned Plans
retain their durable per-run failure. General S3 settings are never substituted.

Startup checks current schema read-only and never migrates or seeds. The process
has one active invocation, one-second normal polling and five-second invocation
error delay. Accepted lease/renewal/deadline/retry policy stays 120/30/300 seconds
and three attempts with 10/60-second persisted delays. SIGINT/SIGTERM stop new
claims and allow a 30-second cooperative drain, then terminate nonzero if work
remains; synchronous CPU work can delay Node handlers. Shutdown does not reset a
run, release a lease or grant deletion authority. Cleanup remains bounded to the
accepted invocation fences, with no global historical orphan sweep.

The check-only job builds shared packages and the descriptor before six exact
build/loop/runtime/process suites, with explicit synthetic US PostgreSQL and
`--maxWorkers=1`, plus direct compiled-entry refusal/no-listener smoke. It retains
its 30-minute limit and operational locks; no secrets, upload or service is added.
Accepted subprocess tests use real Node PIDs and disposable PostgreSQL, including
the unchanged wall-clock 120-second lease and private bytes preserved immediately
after SIGKILL before recovery starts. Storage is an explicitly named parent-owned
transport double. These checks do not prove real MinIO/S3, OS reboot, hosted
recovery/residency, backup/restore, browser, hardware, remote CI or release readiness.

The six-file CI-equivalent selection passes 93/93 tests with zero skips in
229.39 seconds, including the unchanged lease/drain. A separate union of existing
worker, Requests/package and Plan/export regressions passes 834/834 in 38 files,
zero skips; those invocations do not overlap. API typecheck/lint/build pass.
The complete API command with both DB variables unset remains non-green: 416
files (8 setup-failed / 195 passed / 213 skipped), 1,986 tests passed and 3,259
skipped, zero failed assertions. The eight primary-environment setup files and
three secondary teardown diagnostics remain documented in the local checkpoint;
primary configuration was deliberately not loaded. These results do not imply
new remote CI success; the existing 30-minute job limit is unchanged.

## Requests HTTP local checkpoint — 2026-10-05

The [Requests HTTP plan](../superpowers/plans/2026-10-05-us-09-requests-http.md)
adds the spec's exact 13 business routes under `/traceability/requests` and
`/traceability/export-runs`. Tasks 1–6 have independent local acceptance; Task 7
and whole-increment review are tracked separately in the execution ledger.
This supersedes earlier internal-only read/download and pending HTTP boundaries
only for those exact routes. There is no Requests browser proxy or EN/ES UI yet.
The existing CORS `OPTIONS` 204 protocol response dispatches no business service.

Actual loopback tests exercise US sessions and MFA. Tenant/actor come from the
session and membership/profile authority is reloaded in each transaction. Reads
require `traceability.read`; CRUD requires `traceability.qa.manage`;
Validate/acknowledgement/Prepare/retry require QA plus `traceability.export.read`;
download requires export without QA. Lists omit requester contact and private
state. Pagination defaults to 25, caps at 50, and bounds canonical offset to
0–10000; duplicate, unknown and noncanonical parameters are rejected.

Only Requests POST collection and PATCH UUID item accept 256 KiB uncompressed
JSON; their commands retain 16 KiB, with Host/Origin/MFA/no-store and no inflation
preserved. Validate checks the locked expected revision; first Prepare also
checks the validation digest. Matching idempotency replay compares frozen
preconditions after drift or close. Saved validation is labelled `not_rechecked`;
ready incomplete is not export-ready. Closing preserves accepted runs.

Missing/invalid/dirty build identity leaves CRUD/reads/API startup available but
refuses Validate/Prepare. A checked clean build permits Validate without storage;
Prepare/retry/download need separately configured private package storage using
only the six existing `US_REQUEST_PACKAGE_S3_*` fields. There is no Plan/general
S3 fallback. The current uncommitted build remains dirty and publication-refused.

Downloads buffer only verified committed winner bytes, reauthorize after I/O,
and commit the exact release audit before releasing bytes. They expose fixed
safe filenames/MIME, length, no-store and nosniff; no key, public URL or provider
error. The six artifact kinds are `xlsx`, `plan_pdf`, `validation_report`,
`request_report`, `manifest`, `package_zip`; `SHA256SUMS` stays inside the ZIP.
ZIP/workbook/validation/Plan/report/manifest caps remain 64 MiB/16 MiB/16 MiB/
8,000,000 bytes/4 MiB/1 MiB. HEAD, Range, aliases and conditional responses cannot
bypass authorization or audit. Storage/provider doubles prove local behavior;
no real MinIO/S3, browser, hosted, OS reboot, backup/restore, remote CI, regulatory
or release acceptance is established. Operational locks and business readiness
remain closed; US-09 remains In progress.

Check-only CI owns the exact public contract suite and eight API suites directly,
unconditionally and serially after shared builds and the dedicated descriptor.
All existing Request/worker/Plan/export gates, including the earlier Plan/OpenAPI
selection, remain selected. The job retains 30 minutes with no new service,
secret, upload, release or deployment capability. Local final evidence is recorded
in the linked plan; local timings do not establish remote CI readiness.

Local full contracts pass 1,020 tests; the original new-eight API selection
passes 106 tests with zero skips. The separate 44-file regression recorded
937 passed / 2 old Plan-query ordinal failures, zero skips; its compatibility
correction passes the full 20-test file separately. No single 939-test green run
is claimed. Compiled API/owner/worker smoke passes 5/5 with descriptor restored.

The controller's one default API run with both DB variables unset recorded
423 files (23 failed / 185 passed / 215 skipped), 5,366 tests (76 failed /
1,954 passed / 3,336 skipped), 408.75 seconds. Eight prior primary setup files,
eleven loopback EPERM files and four new absence-gating DB suites are distinct.
The bounded eleven-file loopback rerun passes 63/63. The accepted four-file test
correction passes 74 with the explicit US URL, zero skips (131.87 seconds),
skips 74 when unconfigured, and refuses a nonempty invalid URL before I/O.
The complete API was not repeated or called green; its original failure counts
remain recorded, and eight known primary setup blockers remain untreated.
Task 7 and whole-increment review remain pending in the ledger. Formatting,
static and isolation results describe local checks; no primary env was loaded.

### Requests HTTP final-fix checkpoint — 2026-10-05

The whole-increment review identified missing configured CI ownership for four
owned HTTP lifecycle cases. Separate unconditional serial commands now run
`deployment-entry.test.ts` (36 configured passes, zero skips) and the new
`us-request-build-fixture.test.ts` (2 passes, zero skips), with the exact synthetic
US URL after existing dependency builds. The earlier entry gate and exact eight
HTTP-suite command remain unchanged; all 42 tooling contracts pass, zero skips.
Build acquisition now removes only its newly owned root on failure, preserving
the original error. Shared HTTP setup and teardown have guarded file ownership;
filtered first/second runs pass 9/4 cases respectively (4/9 intentional filter
skips), and the complete HTTP file passes 13 with zero skips. Each configured
HTTP run checks its exact database/root removal and listener closure. The helper
consumer selection passes 63 cases, zero skips; these are separate covering runs.

Independent scoped re-review remains pending. The original complete API result
remains non-green, with eight primary setup blockers untreated; no new full API,
old regression matrix or fabricated green union is claimed. M1 historical
attempt chronology and M2 native-loader warning remain deferred. No remote CI,
real provider, browser or release acceptance is added. EN/ES Requests UI and an
owned browser journey remain next; US-09 stays In progress and release stays locked.

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

## Requests cabinet owned browser verification — 2026-10-06

The [Requests cabinet](../superpowers/plans/2026-10-05-us-09-requests-cabinet.md) uses existing
US-only HTTP routes and the local proxy's exact method/path/query policy. Its real browser test
requires explicit `US_TEST_DATABASE_URL` for the reserved loopback US database; no primary
`DATABASE_URL` fallback exists. Unconfigured DB tests explicitly skip; a configured invalid URL
or missing pinned browser executable fails. API Vitest supplies the Nest source transform.

Build domain/contracts/DB/UI and `@markiro/api build:us-request-worker` before the fixture.
It copies and checks actual compiled bytes into an owned clean synthetic build; it never rewrites
the actual dirty descriptor or claims a clean production build. Do not rebuild while it is alive.
Fixture-owned random databases, child worker, private in-memory object map, returned streams,
API3100 and Vite5174 close in nested cleanup, including partial acquisition failures. Occupied
ports fail; existing processes and old database leftovers are not removed. The same seeded actor
owns the browser session and request. Plan PDFs come from actual fixture Plan approval and are
the bytes read by HTTP and the child worker.

The separately pinned `tools/production-browser` runtime is loaded through its existing package
root. Local execution installs nothing. Disposable check-only CI may install that workspace with
its frozen lockfile and Chromium. No credential/session/enrollment screenshot or trace is captured;
only post-MFA synthetic Requests screenshots are retained for visual review. Browser traffic is
restricted to the fixture origin. Local synthetic acceptance is separate from provider, residency,
backup/restore, hosted reboot/recovery, remote CI timing, deployment and regulatory acceptance.

## Before release enablement

The [Receiving CSV browser checkpoint](../superpowers/plans/2026-09-09-us-03-receiving-csv-browser.md)
adds only the grouped import UI/client, exact existing-route proxy entries, tests
and documentation. Real browser verification uses disposable synthetic US
databases and temporary loopback listeners. The check-only workflow includes the
new client/UI suites; no operational workflow lock or deployment permission is
changed. The base database and primary checkout remain untouched. CSV output and
release enablement still require their separate decisions.

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

## US-11 journal foundation — 2026-10-06

The immutable demo descriptor and internal guarded journal are development-only
bookkeeping. The store requires exact trusted database identity, `markiro_us` as
the actual current user, the original reserved synthetic owner with intact
provisioning provenance and current owner membership, and the processor profile
with `America/Los_Angeles`. Future callers must derive expected DB identity from
their validated environment; caller-supplied target trust is not an HTTP feature.
No CLI, HTTP route, module registration or authorization policy is added.

The check-only workflow runs descriptor/codecs, migration0141/schema and real API
journal boundary suites serially after building dependencies. The journal fixture
uses `US_TEST_DATABASE_URL` only to create/drop its own random child DB and never
falls back to `DATABASE_URL`. It provisions the genuine reserved owner/profile
through existing services. Actual-user rejection uses an existing PostgreSQL
builtin role on a second connection to that same owned child DB; no role/grant or
cluster state is changed, and secondary pools close before disposal.

An exact replay changes no rows; a divergent stage/operation/receipt conflicts.
All denial cases compare full persisted row digests before/after, including
journal, business and owner/audit tables, without printing credentials. Receipts
do not finalize business records or certify a complete demo. This foundation
does not seed the business scenario, create a viewer or Plan/package, initialize
the base DB, run a browser demo, dispatch CI or unlock a release. Hosted and
external acceptance remain separate.

## US-11 references-only atomic seed — 2026-10-06

The subsequent internal reference stage uses the same guarded original-owner,
actual-database/user and processor-profile boundary. It captures an immutable
complete reference recipe before business mutation, then composes native service
transactions for 3 parties, 3 locations, 2 catalog products, 2 product profiles and
6 metadata documents with 18 audit facts and one canonical receipt. Synthetic
coverage commands are manual demo review inputs; real actor/time stamps belong
to the existing profile service. Null GTINs and all accepted civil dates are
preserved. No attachment, CTE, lot, genealogy, case, Plan, request or run is created.

First application fails on nonempty tenant reference tables rather than adopting
names/numbers. Exact retries reauthorize and compare every bound UUID's complete
current response to frozen evidence. They write nothing; drift fails without
repair. Verification never creates missing journal or business state. Apply,
audits, verification and receipt persistence share one transaction, while a failed
apply retains the separately committed intent for an exact retry.

The existing check-only workflow owns the exact nine-file serial reference,
atomic-stage, journal and service regression command after shared builds with an
explicit isolated US URL. The fixture creates, migrates and disposes only its own
random child DB, verifies disposal, and never mutates the base or uses primary
configuration. Pure recipe cases run even when database cases explicitly skip.
Existing foundation/Requests/browser gates, permissions, budget and release locks
are unchanged. No runtime registration, CLI, shared-base invocation, credential
change, dependency, migration, worker build or publication is included. Remaining
demo data/orchestration/viewer and remote CI/browser/provider/storage/hosting/
release acceptance are separate work.

## US-11 large dataset progress foundation — 2026-10-06

The separate internal dataset journal stores bounded immutable root evidence and
per-unit stage progress for `us-processor-six-month-v1`. It preserves the compact
journal and uses the same tenant advisory lock with explicit READ COMMITTED
mutation transactions and migration0142 mutual header guards. Initial freshness
covers US references, event roots/history, lots, cases, Plan, Requests and compact
headers. Every call rechecks actual database/user, reserved original owner,
provenance, current owner/QA access, processor profile and timezone.

The check-only workflow owns exact dataset codecs, schema/migration and paged
journal tests after existing dependency builds. Fixtures provision owner/profile
only within their own random child databases and dispose them; no base seed runs
or publication are added. Stage receipts are bookkeeping, not canonical business
verification or a complete-demo assertion. Six-month generation, orchestration,
viewer, browser, remote CI, hosting and deployment remain separate work.

## US-11 six-month recipe — 2026-10-06

The pure recipe defines 23 fictional parties/locations, 16 products, 260 bounded
regular chains, correction/orphan examples and three stable Request selections.
Its parsed immutable definition has 267 ordered units and pins all expansion
parameters, the original compact Scenario A and a synthetic unallocated SSCC
namespace. Independent expansion verifies 964 event roots, 963 current finalized
events, 785 lots and 15,700 distinct boxes; these are recipe counts, not stored
business records. Combined identity and per-unit inputs retain the 256 KiB bound.

The existing serial check-only workflow owns exactly
`test/us-six-month-references.test.ts`, `test/us-six-month-chains.test.ts` and
`test/us-six-month-definition.test.ts` after shared/API builds. The test-only Node
child loads the compiled API recipe and compares digest/census with current
Vitest source under UTC, Los Angeles and Tokyo. No token, new environment or
operational job is introduced. Local recipe verification does not dispatch CI.

US-11 remains partial: business generation and service orchestration are not
implemented by this recipe; actual correction/void history, Plan approval,
Request 500-revision/16 MiB prevalidation and artifacts remain future service
gates. No viewer/browser or deployment/hosting acceptance is established.

## US-11 dataset atomic stage seam — 2026-10-06

The internal `UsDatasetJournalStore.runAtomicStage` now composes trusted apply
and mandatory canonical verification callbacks with receipt persistence in one
database transaction. The intent must already be captured durably. Every apply
and completed replay rechecks actual database/user, original reserved owner,
synthetic provenance and US profile; replay verifies current callback-owned
business facts before returning the existing receipt and performs no apply.
Failed apply, verification or receipt persistence rolls back the stage's business
writes and audits while preserving its previously captured intent. The journal
checks validated within-unit predecessor receipts; future orchestrators must
verify actual cross-unit business prerequisites.

The existing check-only dataset-progress step owns both
`test/us-dataset-journal.e2e.test.ts` and
`test/us-dataset-atomic-stage.e2e.test.ts` once, unconditionally and serially after
shared/API builds. Its explicit `US_TEST_DATABASE_URL` supports fixture-owned
disposable children only. It adds no public entrypoint, token, environment, job
or base-database population, and local ownership checks do not prove remote CI.

This seam is ready for later service composition; the six-month generator remains
unimplemented. Reference expansion, native catalogue/Receiving seams,
Transformation, Cases, Shipping, correction/void examples and Plan/Request
artifact orchestration remain subsequent increments. PostgreSQL atomicity does
not span PDF/object storage or publication. Full-volume generation, measured
Request bounds, viewer/browser, hosting, backup and deployment are unverified.
The preceding full API run was nongreen (eight failed files and 3,528
skipped/pending tests); narrow seam checks do not clear that package gate.

## US-11 six-month shared catalogue stage — 2026-10-06

The subsequent internal reference orchestrator installs the pinned
`us-processor-six-month-v1` catalogue: 23 fictional parties, 23 party-owned
locations, 16 products and 16 manually reviewed synthetic profiles. Its recipe
retains `2026-04-01` through `2026-09-30` and `America/Los_Angeles`; creation,
audit and review timestamps come from the real services at installation time.
The shared stage creates no reference documents. Chain documents belong to
later bounded chain stages.

A canonical 256 KiB-bounded intent precedes native service writes. The exact
stage reader retrieves the persisted `references` unit/stage; simultaneous
initializers retain only the winning canonical operation identity. Native
catalogue writes, all 94 exact audit facts, mandatory verification and the
receipt commit together. A failed write, audit, verifier or receipt rolls them
back while preserving the pending intent for retry. Replay locks and verifies
owned current facts and saved canonical evidence, returning the same 62 business
IDs without extra audit. Changed, archived, missing, cross-tenant or forged owned
references fail closed; unrelated later references remain allowed. Unknown
initial records and populated compact installations conflict without adoption
or repair. Verify does not initialize an absent dataset.

The existing pure codec owner adds
`test/us-dataset-reference-contract.test.ts` once. The existing reference-service
owner adds `test/us-dataset-reference-seed.e2e.test.ts` once, retaining its prior
nine suites, explicit fixture-only `US_TEST_DATABASE_URL` and `--maxWorkers=1`.
The separate dataset-progress owner retains exactly its journal and atomic-stage
suites. Parsed ownership/mutation checks require unconditional steps after
shared/API builds, reject duplicate/missing suites and unsafe database or failure
handling, and preserve the check-only release boundary.

Local new-suite evidence is 12 pure contracts and 52 configured disposable
PostgreSQL scenarios, all passing without skips. The four configured dataset,
atomic, compact-reference and transaction-seam regression files passed 149 tests
without skips; child database disposal is asserted by the fixtures. These are
focused local results, not a full API or remote CI acceptance claim. The preceding
full API gate was nongreen; missing auth/origin variables were established only
for billing, and other causes remain unestablished by this increment.

This implements shared catalogue orchestration only. Chain documents, Receiving,
Transformation, Cases, Shipping, correction/void examples and Plan/Request
orchestration remain separate increments. No shared-base population, runtime,
CLI or HTTP registration, full-volume generation, measured Request limits,
artifact publication, viewer/browser, hosting, backup, deployment, physical or
regulatory acceptance is established.

## US-11 Receiving native transaction foundation — 2026-10-06

The subsequent internal foundation exposes supplied-transaction draft creation,
current command finalization, revision readiness, live record, lot Receiving basis
and exact lot reads. Existing reference-document service methods compose chain
documents with draft/root/rows, finalized snapshots, lots, source locks, operation
receipts and native audit facts in the caller's transaction. Caller abort or an
actual write/audit/operation failure rolls back that composition; native commands
do not retry a partially failed transaction. Existing public authorization,
parser precedence, replay bytes, repeatable-read readers and bounded three-attempt
command retries remain unchanged. Multi-statement native readers require
caller-owned repeatable read or a sufficient explicit lock protocol; reading
fresh local writes does not promise general read-committed consistency.

The existing persistence CI step adds
`test/us-receiving-transaction-seams.e2e.test.ts` once to its revision-finalization
command, after its two prior suites in their original order, with
`--maxWorkers=1`. That command runs unconditionally after shared/API builds using
only the existing fixture `US_TEST_DATABASE_URL`. All other prior commands and
reference/dataset owners remain selected in order. Parsed command and mutation
checks reject missing/duplicate execution, guarded/ignored failures, shell
suppression, database fallback, wrong/missing fixture URLs and execution before
builds. The check-only job retains read-only permissions, its 30-minute budget
and inherited operational release locks. Local isolation checks pass 37/37 with
zero skips; this does not establish remote CI execution.

The accepted Task 1 local evidence is 24 passing configured transaction scenarios
and 249 passing existing public regressions, with zero configured skips, plus
API build/typecheck/lint. The separate full API gate remains nongreen from the
preceding checkpoint; these focused results do not clear it. Historical native
acknowledgement replay remains distinct from current finalized origin after
amendment or void. The previously accepted shared catalogue stage remains valid.

Dataset Receiving intent/receipt orchestration, cross-unit prerequisite reading,
canonical current-origin verification and owned-root/lot lock ordering still
require a subsequent reviewed increment. This foundation implements no new
dataset receipt codec, correction/void seed stage, runtime/CLI/HTTP registration,
shared-base seed or full-volume generation. Actual generation, Plan/Request
artifacts and measured limits, viewer/browser, remote CI, hosting, backup,
deployment and physical/regulatory acceptance remain separate gates.

## US-11 regular dataset Receiving stage — 2026-10-06

The approved internal Receiving increment now applies one regular chain at a
time through native services and the dataset journal's atomic stage. It binds
the unchanged descriptor and installed shared-reference receipt to one durable
intent, creates two reference documents, one original finalized Receiving
root/revision and two source-locked inbound lots, and commits their bounded
receipt with the business writes and exact native audit/operation evidence.
Capture races reuse the winning operation key; rollback retains the pending
intent and lost commit acknowledgement recovers the completed stage.

Completed replay verifies current owned origin under explicit root/event/lot,
catalogue and document locks, without changing receipt bytes, counters or
timestamps. Forged receipts, altered dependencies, amendment/void, archive and
extra or changed origin fail without adoption or repair. Legitimate downstream
consumption remains valid because current stock and mutable technical tokens
are not immutable Receiving facts. Representative tests cover April, a varied
middle-period chain and unchanged Scenario A at index259, including real public
writer lock contention and real downstream Transformation consumption. This is
one regular stage's contract and representative coverage, not complete demo
generation.

The pure codec owner adds `test/us-dataset-receiving-contract.test.ts` once.
A separate check-only owner runs the stage-read, current-verifier, lock and seed
suites once, unconditionally after shared/API builds with `--maxWorkers=1` and
the exact fixture-only `US_TEST_DATABASE_URL`. Parsed ownership checks and fresh
workflow mutations preserve every prior step/command/order and reject skipped
owners/builds, ignored or suppressed failures, duplicate/omitted suites, wrong
URLs, `DATABASE_URL` fallback and parallel fixtures. Read-only permissions, the
30-minute budget and inherited operational release locks remain intact. Local
workflow checks do not establish remote CI execution.

The shared base remains unseeded and the demo is not populated. Transformation,
Cases, Shipping, stage-aware correction/void and Plan/Requests orchestration,
explicit initializer/CLI/runtime registration, full 260-chain generation,
measured resources/Request limits, artifacts, viewer/browser, cloud, backup,
deployment and physical/regulatory acceptance remain separate work. The preceding
full API package gate remains nongreen; only billing's missing auth/origin
variables have an established cause. Three earlier overlapping five-second
timeout failures have no proven cause. The existing Vite module-loader warning
and generic profile/covered-product mismatch returning 503 remain separate
limitations. Final combined API gates and whole-increment review are controller
owned; no merge/deploy readiness follows from focused results.

## US-11 Transformation native transaction foundation — 2026-10-07

Four internal store methods now accept the supplied native transaction:
`createDraftInTransaction`, `checkReadinessInTransaction`,
`finalizeInTransaction` and `getRecordInTransaction`. They compose existing
reference-document methods with draft creation, locked readiness, finalization,
output lots, source locks, genealogy, commandVersion 1 receipts and native audits.
They start no independent transaction and perform no inner retry; the caller owns
commit, rollback and any fresh whole-transaction retry. Public capabilities,
validation and denial order, operation digests, historical replay bytes,
repeatable-read isolation, three-attempt retries and the three named lot-conflict
mappings remain unchanged.

Native multi-query reads require caller-owned repeatable read or a sufficient
explicit lock protocol. The existing root-before-header and sorted affected-lot
locking remain in place. Reading fresh local writes does not certify arbitrary
read-committed composition against existing origins. The later dataset
Transformation orchestrator must separately establish its cross-stage
Receiving/reference/Transformation lock protocol and canonical current-origin
verification; historical command replay is not current-origin acceptance.

A new check-only step owns both native transaction suites exactly once in one
command, unconditionally after successful shared/API builds, with
`--maxWorkers=1` and the exact synthetic fixture-only `US_TEST_DATABASE_URL`.
Parsed workflow contracts and 34 fresh mutations reject omitted or duplicate
suites, split commands, guarded owners/jobs/builds, ignored or suppressed
failures, missing or reordered builds, parallel workers, wrong or missing fixture
URLs and `DATABASE_URL` fallback. Hash checks preserve every prior step, command,
selection, order and setting. Read-only permissions, the 30-minute budget and
inherited operational locks are retained. Local isolation checks pass 41/41 with
zero skips; remote CI execution and the full job's elapsed budget are unmeasured.

At this tooling handoff, the controller reports the two new configured native
suites passing 33 tests without skips after the cleanup repair. This is one
local run, separate from earlier public-regression runs. Final API
build/typecheck/lint, the frozen combined 19-file configured selection, full
unconfigured API result and independent whole-increment review remain controller
gates. The preceding full API gate remains nongreen; these results do not clear
its setup failures, skips or the existing Vite module-loader warning.

US-11 remains partial. The shared base is unseeded and the demo is not populated.
This increment adds no dataset Transformation codec, orchestrator or verifier,
Cases/Shipping or correction stages, Plan/Requests artifacts, initializer,
CLI/runtime registration or full 260-chain generation. Measured resource limits,
viewer/browser, remote CI, hosting, backup, deployment and physical/regulatory
acceptance remain separate work.

## US-11 regular dataset Transformation stage — 2026-10-07

The subsequent [approved per-chain increment](../superpowers/specs/2026-10-07-us-11-dataset-transformation-design.md)
implements strict Transformation intent/result codecs, native atomic application
and canonical current-state verification for one regular chain at a time. It
requires installed shared references and the same chain's completed Receiving;
it creates two metadata documents, one original finalized Transformation, one
output lot and two exact input-to-output genealogy edges. Business writes,
native operations/audits, verification and the bounded receipt commit together.
The separately captured intent survives rollback; capture races and lost commit
acknowledgement reuse the winning key and receipt. April–September 2026,
`America/Los_Angeles`, the 256 KiB bounds and Scenario A's 500 lb + 500 lb →
100 case remain unchanged, without inferred conversion or edge allocation.

Replay validates both prerequisite identities, locks the owned Receiving and
Transformation roots/revisions before the sorted inbound/output lot union, then
verifies reference/document facts. It returns identical receipt bytes without
writes. Real PID-observed public lifecycle, lot and reference writer schedules
exercise both directions and the root-before-lot inversion-sensitive case.
Legitimate later consumption is accepted without pinning stock or mutable
technical versions. Amendment/pending draft/void, archive, forged evidence and
extra or altered origin/genealogy fail without adoption or repair. Tests cover
actual transactional failure boundaries, concurrent capture/application,
ambiguous acknowledgement, and runner cancellation before readiness and while
blocked. Cleanup releases gates before draining workers, attempts independent
resource cleanup and verifies each owned child's disposal.

One unconditional check-only owner runs all four
`us-dataset-transformation-{contract,verify,locks,seed}` suites exactly once in
one command after shared/API builds, with `--maxWorkers=1` and only the exact
synthetic fixture `US_TEST_DATABASE_URL`. Parsed executable ownership/mutation
tests reject missing/duplicate selections, conditions, suppressed/ignored
failures, missing/reordered builds, parallel workers, wrong fixture targets and
`DATABASE_URL` fallback. Whole-step and whole-workflow hashes retain all prior
commands, order and settings; historical hashes exclude only this new owner.
Read-only permissions, 30 minutes and inherited operational locks remain.
Local isolation passes 43/43, zero skips; remote CI and its elapsed budget are
unmeasured.

At this tooling handoff, independently approved Task 1 reports 58 pure passes.
Task 2's final five-file configured run reports 123 total (121 ordinary passes
and two expected runner timeouts), no skips. Task 3's final eight-file configured
run reports 370 total (368 ordinary passes and two expected runner timeouts),
no skips, with temporary diagnostic telemetry. After telemetry removal the seed
suite passed 55/55; the later test-only Los Angeles event-year correction passed
three focused repetitions. These are separate runs, not an invented final union.
The two earlier Task 3 five-second timeouts have no established cause; deadlines
were unchanged and a passing retry does not prove a causal fix. A read-only
catalogue observation found 29 unidentified test databases and zero backends;
their provenance is unknown. Exact owned disposals were verified; no deletion or
global-clean claim follows.

Fresh final API build/typecheck/lint, the controller's configured 34-file
regression selection, the separate unconfigured full API and whole-increment
review remain controller-owned and pending at this handoff. Historically the
preceding full API gate was nongreen with eight setup-failed files; only billing's
missing auth/origin configuration had an established cause. The existing Vite
module-loader warning is retained. Focused results do not clear those gates or
establish a warning-free full package.

US-11 remains partial. The shared base is unseeded and the demo is not populated.
Full 260-chain execution, Cases/Shipping and correction/orphan stages,
Plan/Requests artifacts, initializer/CLI/runtime registration, measured resource
and Request limits, viewer/browser, providers/cloud/hosting, backup, deployment
and physical/regulatory acceptance remain subsequent unrun gates.

## US-11 Case native transaction foundation — 2026-10-07

The [approved native Case foundation](../superpowers/specs/2026-10-07-us-11-case-transaction-foundation-design.md)
now composes the existing manual link command in a supplied transaction through
`linkCasesInTransaction` and `UsCaseStore.linkInTransaction`. It authorizes before
parsing or historical replay, uses only the supplied transaction and propagates
original driver errors without an internal retry. The caller owns rollback and
fresh whole-transaction retry; sufficient isolation or a separately verified lock
protocol remains required. Public commandVersion 1 digests, saved receipt bytes,
repeatable-read retries, audit fields and link ordering remain unchanged.

Minimal synthetic support rows are visible to the native command before commit.
Box provenance remains distinct from `linkSource: manual`; this increment
implements no `demo_seed` mode or dataset Cases executor/verifier. Support rows
contain no fabricated closure, print or scan facts. Tests establish caller abort
and injected dependency/link/audit/operation rollback, exact raw error identity
and one native attempt, current authorization on replay and tenant denial.
PID-observed public/native link, unlink, void and amendment-finalization schedules
cover both winner orders. The original persisted link row and exact active link
IDs survive amendment finalization. Actual runner cancellation, worker drainage,
owned child disposal and preservation of the primary error across cleanup failure
are separately exercised.

At this handoff, Task 2's combined 11-file run passed 84 ordinary assertions plus
two expected runner timeout cases, with zero skips. Its later 15-line original-row
assertion repair passed the full lock suite: 14 ordinary assertions plus two
expected runner timeout cases, zero skips. These are separate runs; the combined
run is not relabeled after the repair. Controller fresh API typecheck, lint and
build exited 0. The pre-repair configured 14-file selection passed 151 assertions
with zero skips; the post-repair final configured selection remains pending.
The separate full API run with both database variables unset is in progress and
has no final result here. Earlier full API preparation failures, historical
timeouts and unidentified database provenance remain unresolved; only the earlier
billing configuration cause was established. The Vite warning is retained.

One unconditional check-only CI owner, `Check US Case native transaction foundation`,
runs the two native suites exactly once across workflows in a single exact
`corepack pnpm` command after successful shared/domain/API builds, serially with
`--maxWorkers=1` and only the exact synthetic `US_TEST_DATABASE_URL`.
Local parsed isolation tests pass 45/45 with zero skips and reject 35 fresh
workflow mutations at their intended assertions. Removing only this owner
reconstructs the exact previous steps and whole workflow hashes; historical hash
pins are unchanged. Read-only permissions, the 30-minute budget and inherited
release locks remain. Remote CI and its elapsed budget are unmeasured.

US-11 remains partial and the shared base is unseeded. Dataset Cases/provenance,
Shipping, correction/orphan stages, Plan/Requests artifacts, full 260-chain
generation, initializer/CLI/runtime registration and measured resource limits
remain later acceptance. No manual browser, hardware, scanner, printer, Windows,
provider/private-storage, hosting, backup, deployment, physical-production or
regulatory validation is claimed. Final controller regressions, formatting,
source-byte inventory and independent whole-increment review remain separate
gates.

### Case foundation: final local verification checkpoint

After the original-link preservation assertion repair, the controller's serial
PostgreSQL selection passed **151 tests in 14 files, zero skips**, including the
two intentionally expected runner-cancellation cases. API typecheck, lint and
build passed; the repair also passed a subsequent API typecheck. US tooling
passed 66/66 (including 45 isolation tests and 35 workflow mutations); the local
isolation checker, repository formatting and diff whitespace checks passed.

The separate full API run with both database variables unset was **not green**:
454 files, 2,312 passed assertions, zero failed assertions, 3,965 pending/skipped
tests and 16 failed suites across eight files. Billing accounts reported six
missing auth/origin/pepper settings. The other seven failing files supplied empty
failure messages; their causes are not established. A matching older failure set
does not prove harmlessness. The Vite config-loader warning remains. No environment
or unrelated product fixes were made. Whole-increment review is still pending at
this checkpoint; remote CI and all external acceptance above remain unverified.

## US-11 regular dataset Cases stage — 2026-10-08

The [approved Cases design](../superpowers/specs/2026-10-08-us-11-dataset-cases-design.md)
and [execution plan](../superpowers/plans/2026-10-08-us-11-dataset-cases.md)
now implement the internal Cases stage for one regular chain at a time. Installed,
completed references, Receiving and Transformation are required. No prerequisite
is implicitly installed. Both strict intent and result retain the 256 KiB limit.
The executor durably captures one operation key, actual UTC capture time and
support identities; retry reuses them and a capture loser reconciles the winner.

The journal's supplied transaction creates one planned aggregation shift, exact
regular-chain boxes and dataset/version markers. Markers describe synthetic box
provenance; they do not describe how a manual link was created. The existing public
and native manual command remains `linkSource: manual` with its commandVersion 1
digest, historical bytes and public schema. The separate internal demo entry uses
`linkSource: demo_seed` and service-owned links, dependencies, native audit and
command receipt. There is no public source selector. Operation arbitration precedes
prerequisite roots/revisions, then the sorted lot union and references, then ordered
shift/box/marker locks. Native composition has no independent pool read, transaction,
commit or inner retry.

Mandatory verification compares exact captured intent and dependency identities,
current upstream origin, minimal support/defaults, complete owned-box history and
output active-link set, native operation/audit and canonical result/digests/record
IDs. Fresh verification applies only inside the successful atomic callback;
completed initialize/verify replay performs no writes and refuses drift without
repair. Caller abort rolls back support, markers, links, dependencies, audit,
operation and dataset receipt together while the captured intent survives. Actual
lost acknowledgement after journal commit reconciles the completed receipt.

Independent spec and quality reviews approved Tasks 1–4. These are separate local
runs, not a combined count of unique assertions:

| Task                              | Final local evidence                                                                          | Retained boundary                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1: strict contracts               | 109 ordinary passes, one file, zero skips; compiler correction and fresh API typecheck passed | Pure codecs do not prove database authorization/current facts           |
| 2: native demo entry/preparation  | 94 ordinary passes plus 2 expected runner cancellation cases, 8 files, zero skips             | Physical support and durable executor were later Tasks 3/4              |
| 3: support/locks/current verifier | 126 ordinary passes plus 2 expected runner cancellation cases, 4 files, zero skips            | Positive scan-row mutation could not run without a fixture partition    |
| 4: durable executor/regressions   | 494 ordinary passes plus 6 expected runner cancellation cases, 15 files, zero skips           | Earlier four ordinary 5-second timeouts still have no established cause |

Expected runner cancellation cases deliberately fail under Vitest's expected-fail
mechanism; ordinary following tests prove signal reason, barrier release, worker
drain and exact owned backend absence. They are not ordinary assertion passes.
Controller's later fresh seed-only run passed 58 ordinary assertions plus 2 expected
cancellation cases (60 total, zero skips), and its fresh API typecheck exited 0.
These checks do not clear the earlier timeout cause or historical full API result.

The new unconditional check-only owner,
`Verify regular US dataset Cases on disposable databases`, runs exactly the six
Cases suites in one exact `corepack pnpm` command after the existing successful
shared/domain/API builds, with `--maxWorkers=1` and only the synthetic
`US_TEST_DATABASE_URL`. Parsed YAML checks reject 68 fresh mutations at their
intended assertion messages, including duplicate quoted/`./test/...` aliases across
workflows. The actual owner command remains exact. Removing only this owner restores
preincrement steps SHA256
`f3b34bfe35b442908b8696fce4b424f96d5ce02859124094ce3ac7f8cd579f1b`
and whole-workflow SHA256
`c221c71b470554b13d1d5010affb6ed33a74664c843ab3bba969dbb44b40787c`.
Old selections/order/settings/hash pins, read-only permissions, services, release
locks and 30-minute budget remain. Remote CI and its elapsed budget are unmeasured.
Local safe Node tooling passed 68/68 without skips, including 47 isolation checks;
the isolation checker also passed. This is local workflow/proxy evidence.

US-11 remains partial. The April–September 2026 recipe, Los Angeles business timezone,
260 regular chains and 15,640 regular boxes are recipe definitions, not stored demo
population. Unchanged Scenario A is index 259 with 100 boxes. The later corrected
chain's additional 60 boxes toward 15,700 remain unimplemented. Only invocation-owned
disposable children were populated and disposed; the shared base remains unseeded.
No box items, scans, pallet contents, print jobs or physical counters are generated;
technical creation clocks are actual instants, not backdated recipe business dates.

The positive scan-row mutation remains unrun because the existing fixture lacks a
scan partition; the production rejection predicate and exercised item/default
checks remain. Vite's ESM-in-CommonJS config-loader warning remains. The historical
full API nongreen result above is not cleared, including seven empty-message failure
causes that remain unestablished. Final controller API lint/build, configured 24-file
regression, separate full API, repository formatting and independent whole-increment
review are separate pending gates at this checkpoint. Shipping orchestration,
correction/orphan stages, Plan/Requests artifacts, full-volume execution,
initializer/CLI/runtime/HTTP registration, viewer/browser, measured resource limits,
remote CI, hosted storage outside RF, hosting/backup/deployment, hardware/scanner/
printer/Windows, physical-production and regulatory acceptance remain unrun.

## US-11 Shipping native transaction foundation — 2026-10-08

Four internal `UsShippingStore` entries now accept the caller's transaction:
`createDraftInTransaction`, `checkReadinessInTransaction`,
`getRecordInTransaction` and `finalizeInTransaction`. The existing finalization
module also exports `finalizeShippingInTransaction`. Native document creation,
Shipping draft/readiness/finalization/history, balances, automatic status effects,
dependencies, receipts and audit can compose atomically in that transaction.
Authorization precedes input parsing and replay. Native calls start no independent
pool read, nested transaction, commit or inner retry; original driver/cause errors
propagate. Public signatures, repeatable-read wrappers, three-attempt retry policy,
commandVersion 1 digests, saved replay bytes, capabilities and HTTP remain intact.

General multi-statement reads require caller-owned repeatable read or a separately
proved locking schedule. Read-committed coverage establishes visibility of the
caller's fresh uncommitted composition only; it does not establish general
multi-read safety. Existing root → Shipping-header, sorted-lot →
references/status locking order remains. Caller abort and injected failures roll
back composed business rows, stock/status effects, dependencies, audit and receipts.
Replay preserves original finalized bytes after public void and does not certify
current lot stock. Minimal synthetic support belongs to disposable tests; this
foundation adds no dataset Shipping executor, verifier or cross-stage protocol.

Reviewed local evidence remains separate:

| Run                                                       | Files | Ordinary passes | Expected runner cancellation cases | Total | Skips |
| --------------------------------------------------------- | ----- | --------------- | ---------------------------------- | ----- | ----- |
| Task 1 fresh seams and Shipping regressions               | 11    | 75              | 0                                  | 75    | 0     |
| Task 2 configured seams/locks plus ten old Shipping files | 12    | 90              | 2                                  | 92    | 0     |
| Controller fresh frozen native suites                     | 2     | 44              | 2                                  | 46    | 0     |

Vitest counts deliberately expected runner-cancellation cases as passed; these are
not ordinary assertion passes. Following ordinary assertions prove the actual
signal phase/reason, rollback, barrier release before worker drainage and exact
owned backend disposal. PID-observed native/public finalization, amendment, void,
readiness/current-balance and recall schedules cover the tested winner orders.
Historical reads remain on one repeatable-read snapshot. Independent spec and
quality reviews approved Tasks 1 and 2; controller fresh API typecheck exited 0.

One new unconditional check-only owner,
`Verify Shipping native transaction foundation on disposable databases`, runs
exactly the seams and lock suites once globally in one exact `corepack pnpm`
command after the existing successful shared/domain/API builds. It uses
`--maxWorkers=1` and only the synthetic `US_TEST_DATABASE_URL`; primary
`DATABASE_URL` fallback is forbidden. Parsed YAML checks pass 49/49, zero skips,
and reject 88 fresh Shipping mutations at their intended AssertionError/messages.
They cover missing/duplicate owners and suites, split commands, quoted/`./test`
aliases locally and across workflows, conditional or suppressed execution,
inherited shell overrides, fixture/worker drift, prerequisite builds and prior
commands/order/settings/services/permissions/budget. The complete safe Node
`*.test.mjs` set passes 70/70 without skips; the local isolation checker and scoped
lint pass.

Removing only the new Shipping owner reconstructs preincrement steps SHA256
`d3144c04106e7bd4e176ec210aee5351c30aab869b625c8969c0f29251a3e8b3`
and whole-workflow SHA256
`849380f0b1b156fa2c7294ab8b7eadaabac2fc36582b2b1329f22836e56feebe`.
Historical hash pins and Cases alias semantics remain. Existing owners, read-only
permissions, services, operational release locks and the 30-minute budget remain.
Remote CI and elapsed budget have not been observed.

US-11 remains partial and the shared base is unseeded. The unchanged
`us-processor-six-month-v1` recipe spans April–September 2026 in
`America/Los_Angeles`: 260 regular chains, 440 Shipping events and unchanged
Scenario A are recipe definitions, not stored demo population. Journal bounds
remain 256 KiB. Shipping dataset orchestration, correction/orphan stages,
Plan/Requests artifacts, full-volume execution, initializer/CLI/runtime/HTTP
registration, viewer/browser and measured resource limits remain later gates.
Controller final configured/full API checks, final source inventory/formatting
and independent whole-increment review remain separate pending gates here.

The prior full API run remains nongreen: eight failed files and sixteen failed
suites, including seven empty-message failure causes that remain unestablished.
Earlier ordinary Cases timeouts also have no established cause. The Vite
config-loader warning and fixture scan-partition gap remain. These focused local
checks do not establish remote CI, hosted storage outside RF, hosting, backup,
deployment, hardware/scanner/printer/Windows, physical-production or regulatory
acceptance. No such external validation was performed by this increment.

## US-11 regular dataset Shipping execution — 2026-10-08

`UsDatasetShippingSeedStore.initialize(context, index)` now completes one regular
chain's Shipping stage after its References, Receiving, Transformation and Cases
receipts exist. Current database, tenant and synthetic-owner authorization precede
caller evidence. The journal captures a stable intent; its one supplied transaction
creates two recipe documents per shipment, creates the native draft, checks fresh
readiness, finalizes it and verifies the actual business rows before publishing the
stage receipt. A second shipment sees the first shipment's writes. There is no
recursive prerequisite installation or inner transaction/retry. Original SQL
failures propagate and all stage writes roll back together.

Completed initialization and explicit `verify` compare current native rows,
commands, digests, documents, audits, case links, status effects and stock against
the frozen receipt without writes. Missing or pending verification fails;
application rejects existing derived Shipping operations or recipe documents.
Fresh verification proves that this transaction owns its writes. Pending native
writes cannot be adopted as completion. Historical readiness digests remain saved
command evidence and are never reconstructed from current stock.

The bounded result retains the original Transformation lot, actual post-Shipping
lot and one or two ordered native shipment responses. It is an owned frozen copy,
limited by the existing 256 KiB journal guard; the existing output lot is not a
newly owned record. The tested recipe outcomes are:

| Chain | Supply | Shipments | Remaining | Current status/revision |
| ----- | ------ | --------- | --------- | ----------------------- |
| 0     | 55     | 22, 23    | 10        | active / 1              |
| 1     | 65     | 26, 39    | 0         | shipped / 2             |
| 258   | 60     | 60        | 0         | shipped / 2             |
| 259   | 100    | 100       | 0         | shipped / 2             |

Transformation/Cases replay accepts full Shipping's precise native
active/revision 1 → shipped/revision 2 transition only when the canonical intent,
derived operations, finalized events, zero balance, last-shipment effect and exact
native audit prove it. Original lot/source/product/TLC facts stay fixed. Manual
status edits, missing/foreign/compensated effects, altered audits or extra
consumption fail. Before a Shipping receipt exists this status proof validates the
finalize digest's shape and native result, but cannot detect a well-formed digest
substitution without historical finalize input. It never certifies completion;
Shipping verification always compares the exact fresh/frozen finalize command
digest before publishing or accepting its receipt.

The read-committed executor locks dataset/stages and operation arbitration before
known Receiving/Transformation/Shipping roots and revisions, then the sorted lot
union, reference/document shares and Cases support. Real PID-observed writers
exercise amendment, void, status, source, case-link and quantity-consumer schedules.
Amendment item insertion's FK `KEY SHARE` blocks behind the lot `FOR UPDATE`;
void of an already pending draft can change only its known root/revision, while
current-finalized void explicitly locks lots. These tested schedules do not imply
an unrestricted multi-read guarantee. Rollback and no-write replay compare all
198 public tables. Test barriers release before actual workers drain and the exact
owned child database is disposed; no production SQL abort API is claimed.

Independent spec and quality reviews accepted Tasks 1–3. The controller's fresh
local checks remain separate: Task 1's pure contracts/recipe gate passed 236 tests;
Task 2's status suite passed 50; Task 3's final seed/verify/locks gate passed 52
with zero skips in 195.95 s. The implementer's separately bounded status/native
regression gate passed 94 ordinary assertions plus two expected cancellation
cases, 96 total with zero skips. Expected cancellations are not ordinary assertion
passes. An earlier controller concurrency test exceeded its 5 s body budget;
registered prerequisite setup and actual-operation drainage were corrected, then
the final 52-test gate passed with the original body timer and no product retry.
Earlier failures remain in their reports and are not represented as final passes.

One unconditional check-only owner,
`Verify regular dataset Shipping on disposable databases`, runs exactly the six
Shipping input/result/status/seed/verify/locks suites once globally in one
`corepack pnpm` command after successful shared/domain/API builds. It uses only the
synthetic `US_TEST_DATABASE_URL` and `--maxWorkers=1`; primary `DATABASE_URL`
fallback is forbidden. Parsed YAML checks pass 51/51 and reject 110 fresh Shipping
mutations at their intended AssertionError/messages, covering quoted/`./test`
aliases across workflows, split commands, conditions, suppression, environments,
builds and predecessor drift. All safe Node `*.test.mjs` checks pass 72/72 without
skips; the local isolation checker and scoped lint/format checks pass.

Removing only the new owner restores the actual complete predecessor steps SHA256
`a36a03e4a4cd5026aeb24f6b6ab8152d5071c76c5dd56caa9fd34f900751b3fc`
and whole-workflow SHA256
`5f20d278eb331aeddad69b12b467a022a860ed6241430cdcaa7e97988f82fe1d`.
Historical pins, old owners/commands/order/settings/services, read-only permissions,
operational release locks and the 30-minute budget remain. Remote CI execution and
elapsed budget have not been observed.

US-11 remains partial. Per-chain execution is verified in invocation-owned
disposable databases; the shared base remains unseeded. The unchanged 260-chain,
440 Shipping events in the April–September 2026 Los Angeles recipe are not full
stored population.
Scenario A remains unchanged. Full-volume execution, correction/orphan stages,
initializer/CLI/runtime/HTTP registration, Plan/Requests artifacts, viewer/browser,
screenshots/video and measured resource limits remain later gates. Controller final
configured/full API and whole-increment review remain separate pending checks at
this checkpoint. The prior broad eight-file/sixteen-suite API failure, old ordinary
Cases timeouts, Vite warning and scan-partition fixture gap are not cleared by these
focused passes. Remote CI, hosted storage outside RF, hosting/backup/deployment,
hardware/scanner/printer/Windows, physical production and regulatory acceptance
were not exercised by this task.

## US-11 sequential regular-chain range — 2026-10-08

The internal `UsDatasetRegularSeedStore` now accepts an explicit
`{ startIndex, count }`: integer start 0–259, count 1–260 and end at most 260.
There is no default full-volume run. Actual database/tenant/owner authorization
precedes descriptor-safe range validation; invalid caller evidence writes nothing.
References runs once, followed by awaited Receiving → Transformation → Cases →
Shipping for each ascending selected index. Every native store rechecks current
business state and retains its own bounded transaction and journal ownership.

The first failure stops the sequence and propagates the original error/cause.
Prior committed stages remain; no later chain starts and no internal retry runs.
Explicit caller initialization verifies/reuses completed stages and resumes pending
work. Explicit verification installs or repairs nothing and rejects missing,
pending or drifted state. Repeated initialization and verification were checked
against all 198 public-table hashes without writes.

The owned frozen summary contains the dataset identity and recipe digest, copied
range and ordered compact rows with the actual Shipping shipment count/result
digest. It is bounded by the existing 256 KiB guard and always reports
`state: selected_regular_shipping_verified`, `datasetComplete: false`.
These are separate transaction-boundary checks, not one simultaneous snapshot or
an atomic range. Later writes can invalidate earlier checked state. Even a range
of 260 covers selected regular Shipping only and does not certify demo completion.

Task 1 passed independent spec and quality review. Its final local two-suite gate
passed 46 tests with zero skips in 73.40 s; the controller's separate fresh exact
two-suite gate passed 46 with zero skips in 72.32 s. Actual disposable databases
covered adjacent chains 0/1, unchanged Scenario A 259, no-write replay, absent and
pending verification, target-guard precedence, chain 1 Shipping failure with
chain 0 preservation and explicit resume, canonical drift, original SQL cause and
drained equal concurrent calls. The earlier timeout and sandbox connection failure
remain recorded in the task report; the inherited Vite config-loader warning remains.

One unconditional check-only CI step,
`Verify regular dataset range orchestration on disposable databases`, runs exactly
`test/us-dataset-regular-contract.test.ts` and
`test/us-dataset-regular-seed.e2e.test.ts` through one dedicated owner after the
actual successful shared/domain/API builds. These two explicit suite path
selections are globally unique in workflow run commands; aggregate API collection
can execute the pure suite too. The existing generic CI command
`pnpm turbo test --filter=@markiro/db --filter=@markiro/api --concurrency=1 --force`
uses the API's `vitest run` script and `test/**/*.test.ts` include. It collects both
suites; the native suite skips without `US_TEST_DATABASE_URL`. This guarantee
does not imply exclusive total execution. A source-derived regression permits
that actual aggregate command, checks glob collection and executes the actual
native skip predicate without importing native tests or acquiring a database.
The dedicated owner's direct `corepack pnpm` command uses only the synthetic
`US_TEST_DATABASE_URL` and `--maxWorkers=1`. Parsed YAML tests reject 121 fresh
ownership, alias, nonexecution, split, duplicate, condition, failure suppression,
environment, build-order and preservation mutations at their intended assertions.
Removing only this owner restores the complete 76 predecessor steps, SHA256
`b46d97f8525f7fc94c447b1a5ef488cd8df28d5f53e47dd3f4d224e4928b2e66`,
and workflow SHA256
`501009445906334f0ad0e7750ba9983184b67f4f92eb860627c57d5cc2a66354`.
Old SHA pins, all prior steps/settings/services, read-only permissions, operational
release locks and the 30-minute budget remain. Remote CI timing is unobserved.
All safe Node `*.test.mjs` checks passed 75/75 without skips; the local isolation
checker, scoped ESLint, five-file Prettier check and diff whitespace check passed.

US-11 remains partial and the shared base remains unseeded. The unchanged
April–September 2026 Los Angeles recipe defines 260 chains and 440 Shipping events;
full 260-chain stored population and resource measurements have not run.
Correction/orphan examples, `trace_readiness`, Plan/Requests/package artifacts,
visitor/browser/screenshots/video, CLI/runtime/HTTP registration and hosting remain
open. Controller full API/static/build checks and final whole-increment review are
separate gates; these focused results do not clear inherited broad API failures,
ordinary Cases timeouts or the fixture scan-partition gap. No remote CI, hosting,
backup/deployment, external storage, hardware/print/Windows, physical production
or regulatory acceptance was exercised by this range increment.

## US-11 Receiving lifecycle transaction foundation — 2026-10-08

Receiving now exposes internal amendment, amendment-save and void methods that
use the caller's supplied transaction. Each extracted native body is identical
to the former public transaction callback; the public wrappers retain their
repeatable-read policy and at most three attempts. Current QA/tenant checks,
parser precedence, operation arbitration, root/revision/lot locks, downstream
denial, digest, receipt and audit rules remain unchanged. There is no new route,
runtime registration, schema or environment setting. The caller owns isolation,
commit/rollback and fresh whole-transaction retry; native commands make one
attempt and propagate the original SQL cause.

The accepted Task 1 suite composes real finalized original → native amendment →
native save → readiness → native re-finalization, retaining both lot identities,
TLC/product/source facts and exact audits while changing only the first quantity
to 300. Genuine void retains the lots and removes current origin basis.
Caller aborts and native audit/operation SQL failures preserve all 198 public
table hashes. Native retryable errors make one nontransactional sequence attempt;
the unchanged public wrapper makes three. No-write replay, unchanged save,
current QA/foreign-tenant denial before hostile input/replay, stale versions,
retained-line identity rejection, downstream blockers and ordered concurrent
public/native commands are covered with actual disposable PostgreSQL children.
Historical receipt replay remains the saved acknowledgement after later
amendment/void; separate live/basis reads establish current state. A historical
receipt alone never proves current origin.

After a review found that an afterEach timeout could allow next beforeEach setup,
the suite added a synchronous prior-work guard and a shipped actual-runner
regression. Deliberate nested body/hook timeouts diagnose the guard, one provision,
unchanged context, actual work drainage and owned-child absence; expected nested
exit1 is distinct from the normal configured parent result. The final worker
suite passed 38/38 with zero configured skips in 26.89 s; the controller's fresh
exact CI command passed 38/38 with zero skips in 33.48 s. With both database
variables unset, the controller collected all 38 and explicitly skipped all 38
in 2.46 s without acquiring a fixture. The earlier unchanged nine public
regression suites passed 165 tests; they were not rerun after this test-only fix
and no combined 203-test gate is claimed. Task 1 passed independent spec and
quality review; whole-increment review is still pending.

One unconditional fixture-only serial CI owner,
`Verify Receiving lifecycle transaction foundation on disposable databases`,
selects `test/us-receiving-lifecycle-transaction.e2e.test.ts` exactly once
explicitly across workflows after the existing successful domain/API builds.
Its direct `corepack pnpm` command uses only synthetic `US_TEST_DATABASE_URL`
and `--maxWorkers=1`. Aggregate API collection remains permitted and the actual
native skip predicate is checked without importing native tests or acquiring a
database. Removing only this owner restores complete predecessor bytes, all 77
predecessor steps (SHA256
`73c46135006754776854fcd884c6e7f02dcdfc082db4658cb1561483dbf06ada`)
and complete workflow AST (SHA256
`70567b2a59615eb965fa3cb136f7dcf7094de9e9a4db8f1a7cfb2883caec23d3`).
Existing hash pins, commands/settings/services, read-only permissions,
operational release locks and the 30-minute budget remain. Remote CI execution
and elapsed budget are unobserved.

The new Node contract rejects 108 fresh parsed-YAML ownership, alias, duplicate,
nonexecution, split, condition, failure-suppression, shell, environment, build
and preservation mutations at intended AssertionError/messages. Three additional
AST-neutral byte mutations fail complete-predecessor byte preservation.
The local safe Node `*.test.mjs` gate passed 79/79 with zero skips in 2.20 s;
the isolation checker and scoped Node lint/format/diff checks passed.

Controller whole API typecheck/lint passed after database drainage; API build
passed on the same unchanged production bytes. The full API run remains
nongreen on the earlier 37-case test snapshot: 471 files, 8 failed, 212 passed,
251 skipped; 7041 tests, 2687 passed, 0 assertion failures, 4354 skipped, exit1
in 477.60 s. The bounded eight-file diagnostic confirmed loadEnv failures from
missing auth/origin/pepper settings (seven also lacked DATABASE_URL), plus three
secondary exchange cleanup failures on undefined db.delete. It passed 3 tests
and skipped 96, exit1 in 19.14 s. This is not a full API pass on the final
38-case test source and says nothing about uninitialized/skipped services.

US-11 remains partial and the shared base remains unseeded. Next scope is genuine
special-example seed execution: the existing correction recipe's finalized
Receiving first quantity 250 → amended 300, plus genuine orphan void, each with
atomic business/journal receipt publication and current-origin verification.
No special seed/receipt/verifier or corrected downstream data is installed here.
Full 260-chain/440-Shipping population, trace_readiness, Plan/Requests/package
artifacts, initializer/CLI/runtime/HTTP, viewer/browser/screenshots/video,
resource measurements and hosting remain open. Inherited Vite loader warning,
ordinary Cases timeout cause and fixture scan-partition coverage gap remain.
No remote CI, hosting/backup/deployment, outside-RF storage, hardware/print/Windows,
physical production or regulatory acceptance was exercised by this increment.

## 2026-10-09 special Receiving execution and check-only handoff

This entry supersedes the preceding “next special seed” statement without
rewriting that evidence chronology. The prior native Receiving lifecycle
whole-increment review subsequently finished Approved. The special codecs and
executor now have independent spec/quality acceptance, including the orphan
support correction; final whole-increment review of this special increment is
still pending.

Only the Receiving portions of the immutable six-month special recipe are
executed: `us-processor-six-month-v1`, April–September 2026,
`America/Los_Angeles`, with its existing definition digest. `correction_0001` finalizes 250/400 lb on 2026-06-10, then changes only
the first saved quantity to 300 lb and finalizes revision 2. Its original frozen
250/400 content and two lot identities remain; the root has two revisions,
current revision 2 and lifecycle version 4. `orphan_0001` finalizes 200/200 lb
on 2026-08-10 and voids its original; both active source-locked lots remain
without current Receiving basis, with current/pending null. Original and
lifecycle stages use separately captured UUIDs, exact existing reasons,
references and TLCs. No recipe version/digest/date/timezone, public command,
journal policy, regular codec, dependency, schema or runtime setting is changed.

The store exposes original `initializeReceiving/verifyReceiving` and complete
Receiving-example `initialize/verify` for correction/orphan after target/owner
authorization. Native document/Receiving business, exact operation/audit evidence
and each bounded receipt commit together. A later-stage failure retains its
original receipt and pending lifecycle intent; an explicit rerun resumes that
exact key. Completed replay verifies actual joint current/history state and
returns unchanged historical receipt bytes without new business/journal writes.
The candidate lifecycle receipt is verified explicitly before its journal row
becomes completed. Actual root, ordered revision and sorted affected-lot locks
remain through commit and block genuine public mutation.

Correction replay tolerates genuine downstream consumption's technical token
changes while rejecting business/history drift. The fixed orphan example rejects
Transformation input/output, Shipping items, case-link history and genealogy
edges in either direction, including draft/historical support, under the same
lot locks at candidate completion and replay. That strict synthetic invariant
does not change public void rules. Negative actual orphan downstream consumption
rolls back the demonstration draft; the seed itself creates no downstream events,
cases or case links.

The corrected configured three-suite gate passed **132/132** with zero skips
(codec 20, seed 104, locks 8). The worker's stable-byte run took 219.00 s; the
controller's separate fresh run of the literal CI command took 241.28 s. SQL
business/audit/operation/receipt failures, lost acknowledgement, no-write replay,
drift denial and actual PostgreSQL writer blocking are exercised on invocation-
owned random fixture children. Failure/replay comparisons cover all 198 persisted
table hashes; acquired children/workers/failpoints are drained and independently
disposed. The earlier eight-suite 297/297 in 148.48 s remains pre-fix unchanged-code
evidence. The earlier unconfigured 19 passed/98 DB-skipped of 117 describes the
pre-fix 117-case source, not current 132 runtime coverage.

One unconditional direct serial fixture-only CI owner,
`Verify special dataset Receiving examples on disposable databases`, selects
`test/us-dataset-special-contract.test.ts`,
`test/us-dataset-special-seed.e2e.test.ts`, and
`test/us-dataset-special-locks.e2e.test.ts` once explicitly across workflows,
after the existing successful domain/API build steps. Its exact `corepack pnpm`
command uses only synthetic `US_TEST_DATABASE_URL` and `--maxWorkers=1`.
Aggregate API collection remains allowed; all three actual DB skip predicates
are checked without importing native suites or acquiring a DB.

Removing only the new owner restores complete actual predecessor bytes
(SHA256 `8979a73cb508749c575524c95da1f69fc63818ec88736a2719fd7e9e8a4be7f2`),
all 78 predecessor steps
(`d549fb32a14d1b00deb55fab0c4bdccd97a7c9650700e1e9e4aec4bddad46795`)
and the complete workflow AST
(`ce467895d986b54e617fa564b124e775568c728169cfa3b1d5b0c1b008b781c8`),
including comments/newlines. Every older literal pin, command/setting/service,
release lock, read-only permission and the 30-minute budget stays unchanged.
The new Node contract rejects 146 fresh parsed-YAML mutations at intended
AssertionError/messages plus 3 AST-neutral byte mutations. Local safe Node passed
83/83, zero skips, in 2.14 s; isolation checker and scoped Node lint/format/diff
checks passed. Remote CI execution and job elapsed budget remain unobserved.
Domain/shared source and compiled dependencies are unchanged; a fresh domain
build is not claimed.

Controller whole API typecheck, lint and build all exited 0 after database work
drained. The fresh full API run used unfiltered collection with both
`DATABASE_URL` and `US_TEST_DATABASE_URL` explicitly unset: exit 1 in 450.28 s,
474 files (8 failed, 213 passed, 253 skipped), 7174 tests (2706 passed,
0 assertion failures, 4468 skipped). The eight failed files are the unchanged
legacy `billing-accounts.e2e`, `exchange-credentials.e2e`,
`exchange-import.e2e`, `exchange-orders.e2e`, `exchange-protocol.e2e`,
`integrations-delete.e2e`, `integrations.e2e`, and
`subscription-route-inventory`. Each failed setup at `loadEnv`
(`src/env.ts:334`) for missing auth/origin/pepper settings; seven also lacked
`DATABASE_URL`. Exchange import/orders/protocol additionally reported secondary
cleanup failures on undefined `db.delete`; these do not add a ninth failed file.
The fresh failure cause matches the prior baseline; no broader green is claimed.

Within that same full run, the three current special suites contributed codec 19
passed/1 DB-skipped, locks 8 DB-skipped and seed 104 DB-skipped: 19 passed and 113
explicit DB skips. This is a current aggregate-collection subset, not an
additional standalone three-suite gate or configured DB coverage. The actual
7174-test JSON agrees with the CLI totals; its describe-container count is not
a file count. Skipped database/service surfaces and legacy setup failures remain
unverified. Inherited Vite ESM/CommonJS warning and expected legacy negative-test
Nest warnings were retained, not suppressed.

US-11 remains partial; no special unit or dataset completion is asserted, and the
shared base remains unseeded. Next scope is the corrected special chain's real
Transformation/Cases/Shipping stages. Full 260-chain/440-Shipping population,
trace_readiness, Plan/Requests/package artifacts, initializer/CLI/runtime/HTTP,
viewer/browser/screenshots/video, resource measurements and hosting remain open.
The inherited Vite loader warning, ordinary Cases timeout cause and fixture
scan-partition coverage gap remain. No remote CI, external hosting/backup/
deployment, outside-RF storage, cloud-cost measurement, hardware/print/Windows,
physical production or regulatory acceptance was exercised by this increment.

## 2026-10-09 corrected Transformation execution checkpoint

This development-only increment executes `correction_0001/transformation`
through the native document/Transformation services and dataset journal after
completed references, original Receiving and its amendment. The unchanged
`us-processor-six-month-v1` recipe uses 2026-06-11, Los Angeles timezone,
retained inbound lots at 300/400 lb and output 60 case. Historical Receiving
250/400 content and the original/amended identities remain intact. The stage
creates two documents, one original finalized Transformation, one output lot
and two genealogy edges. It creates no Cases or Shipping dataset stage.

The corrected result codec shares mechanically extracted Transformation
business evidence with the regular wrapper while preserving the regular input
contract. It returns a frozen owned copy and rejects aliases to upstream
Receiving identities. Corrected initialization authorizes the actual target and
owner before reading evidence, uses the persisted amendment, captures a durable
intent separately, then commits native business, exact operations/audits,
mandatory current-history proof and receipt in one transaction. Failed stage
writes roll back while the intent survives; lost acknowledgement replays the
exact committed receipt. Completed initialize/verify writes nothing and cannot
adopt, repair or execute preexisting unreceipted business rows.

Operation keys precede Receiving root/ordered revisions, then known
Transformation root/ordered revisions, then the sorted input/output lot union.
Actual PostgreSQL blocker observations exercise public lifecycle writers in both
winner orders and the root-before-lot schedule. Corrected output replay permits
legitimate technical-token changes while rejecting changed business identity.
Only invocation-owned random disposable children were populated; the shared
administrative base remains unseeded.

The following are separate temporal evidence snapshots, not one combined gate.
Task 1's final three-file configured contract selection passed 134/134 with zero
skips in 9.25 s before Task 2: corrected result 49 (48 pure plus one native
witness), regular Transformation 58, special/corrected input 27. Task 2's
ten-file configured regression selection passed 475 ordinary tests plus two
expected inherited `it.fails` cancellation controls (477 collected), zero skips,
in 821.27 s. Six other deliberate cancellation controls passed as ordinary
tests; the expected controls retained their signal reasons and drained their
workers. After the narrow lint callback correction, a separate covering seed
selection passed 3 tests with 68 explicit name-selection skips (71 collected)
in 14.38 s. Its skips are not unconfigured native coverage or a repeated full
ten-file pass. Owned workers/children were drained and disposal verified in
those runs.

The existing special CI owner is expanded from three to six ordered suites and
renamed `Verify special dataset event examples on disposable databases`.
One direct `corepack pnpm --filter @markiro/api exec vitest run` command selects
the original special contract/seed/locks followed by corrected Transformation
contract/seed/locks, with the same fixture environment and `--maxWorkers=1`.
No workflow step is added: 79 remain. Existing successful domain/API build
predecessors, operational locks, read-only permission and 30-minute budget remain.
Explicit paths are globally unique; unfiltered aggregate API collection remains
allowed. All six actual module-level `US_TEST_DATABASE_URL` / `!base` native
gates are inspected and their predicates executed without acquiring a DB.

Replacing exactly the expanded owner with the captured original block restores
this increment's entire 79-step predecessor bytes (SHA256
`aaf3c3138eb67afd09e9d08a89c269a5bbafdba6feeedc803027b44e12ae3419`),
steps (`229fad0677f2dbaa4fa8ec60bb31d3dc1d5bc02223f46e70b8241cbde7588a61`)
and complete YAML AST
(`b44871d1f0cea3e2a4bb1846fc4561ea5f27210a23728fbb1987ccf84a944768`).
Removing the expanded owner still restores the older 78-step predecessor and
all unchanged historical literal pins recorded above. Parsed ownership checks
reject 203 fresh YAML mutations at their intended assertions; both predecessor
proofs reject three AST-neutral comment/newline mutations each. Task 3's local
safe Node run passed 84/84, zero skips, in 2.60 s; the release-isolation checker
and diff whitespace check passed. After scoped formatting, a separate repeat
passed 84/84, zero skips, in 2.92 s; scoped ESLint and seven-file Prettier check
passed.

At this checkpoint, the controller reports API typecheck exit 0 before the
final mechanical callback correction and API lint/build exit 0 after it. The
fresh unfiltered API package run with both DB variables unset, exact expanded
six-suite configured command, final root static/format checks and whole-increment
review remain pending; their results must be appended after completion.
The prior full-package nongreen snapshot and its named legacy setup/secondary
cleanup failures above remain historical evidence, not a current green result.
The inherited Vite configLoader warning, wider shared JSON-walker audit,
ordinary Cases timeout cause and fixture scan-partition limits remain open.

US-11 remains partial. Corrected Cases/Shipping dataset execution, full
260-chain/440-Shipping population, trace readiness, Plan/Requests/package
artifacts, initializer/CLI/runtime/HTTP, viewer/browser/screenshots/video,
resource measurements and hosting remain next. No remote CI/job-budget,
hosting/storage/residency/backup/deployment, hardware/print/Windows, physical
production or regulatory acceptance is claimed. Work stays local; Git
publication and cleanup were not authorized.

### Controller final gate snapshot: corrected Transformation

This later snapshot closes the pending controller test gates above, without
rewriting their chronology. The exact expanded six-suite workflow command ran
serially with only the isolated `US_TEST_DATABASE_URL`: six files and 271/271
tests passed, zero skips, in 477.12 s. Native work drained before other gates;
the fixture close paths verify their own child databases are absent. A read-only
observer during this run saw a test-DB session with no long lock wait at that instant;
it neither altered data nor established a performance guarantee. The shared
base remains unseeded. No remote workflow execution or 30-minute full-job budget
is inferred from this local selection.

Controller API typecheck, lint and build exited 0 on the final production/test
bytes after the two mechanical lint corrections. Safe Node tooling passed
84/84 with zero skips in 2.55 s; isolation and whitespace checks passed. The
203 special, 121 regular-range and 108 Receiving-lifecycle mutation families
are distinct evidence, not additional native tests. Whole-format verification
and final independent review remain separate gates for this prose snapshot.

The fresh unfiltered API run explicitly unset both database variables. Its first
sandbox run was nongreen: 477 files (19 failed, 203 passed, 255 skipped),
7313 tests (2704 passed, two `listen EPERM` assertion failures, 4607 skipped),
507.15 s to the JSON artifact write. After reviewed loopback permission, the
same test selection was rerun without changing source or supplying DB/service
configuration: exit 1, 477 files (eight failed, 214 passed, 255 skipped),
7313 tests (2761 passed, zero assertion failures, 4552 skipped), 496.46 s to
artifact write. JSON describe-container counts are not file counts; test-clock
mocked per-file end times are not used to calculate elapsed runtime.

The eight unchanged failures are `billing-accounts.e2e`,
`exchange-credentials.e2e`, `exchange-import.e2e`, `exchange-orders.e2e`,
`exchange-protocol.e2e`, `integrations-delete.e2e`, `integrations.e2e`, and
`subscription-route-inventory`. A separate bounded eight-file diagnostic
confirmed `loadEnv` at `src/env.ts:334` rejects missing auth/origin/pepper
settings; seven also lack `DATABASE_URL`. Exchange import/orders/protocol
additionally fail cleanup on undefined `db.delete`, not a ninth failed file.
That diagnostic exited 1 with three passed and 96 skipped in 15.93 s. Full API
is not green and skipped service/DB surfaces are not accepted. In the same full
run, the corrected suites contributed 48 pure passes and 84 explicit DB skips
(contract one, seed 71, locks 12), not a second configured native gate.

Inherited Vite loader and expected legacy negative-test Nest warnings were not
suppressed. No browser, artifact viewer, complete dataset population, hosting,
residency, backup, deployment, hardware or regulatory validation is claimed.
Task reviews passed after the codec ownership and append-only documentation
fixes; final whole-increment review is recorded separately in retained local
controller evidence. No Git publication or cleanup occurred.

## 2026-10-09 corrected Cases input boundary

This increment adds only the internal corrected Cases input codec and factory.
They bind saved reference/amendment evidence and completed corrected Transformation
intent/receipt to the same output lot and product, carrying journal revision 2
separately from native event revision 1/lifecycle version 2. The immutable recipe
and regular-chain codecs remain unchanged; no regular index or Receiving alias
is fabricated. No Cases executor, support rows, links, receipt or runtime route
is added yet.

Captured support requires exactly 60 ordered reserved recipe SSCCs, technical
shift sequence 261, the UTC month of actual capture, canonical disjoint shift/box
UUIDs and unique trimmed device IDs. Guarded parsing rejects hostile descriptors,
normalization and contradictory prerequisites before caller code is evaluated,
and returns a deeply frozen owned copy. Stored coherence is not current database
ownership, authorization or locking; the future executor must establish those.

Meaningful stub RED preceded implementation. The configured disposable-US
three-contract selection passed 260/260 with zero skips in 17.24 s. A subsequent
test-only UUID inference correction passed its focused native rerun (one passed,
123 filtered/skipped, 6.41 s). The actual saved Transformation journal stage came
from the existing executor, not a fabricated native receipt. Snapshot equality
and zero Cases support/link counts demonstrate that the codec does not write
business data. Only unique owned child databases were provisioned and disposed;
the shared base was not migrated, truncated or otherwise changed.

API typecheck, lint, build, scoped formatting and isolation checker passed.
Safe CI/isolation tooling passed 63/63 with zero skips in 2.47 s. The existing
Vite loader warning remains; it was not suppressed. Full API package results and
independent review acceptance are recorded separately after those gates finish.
Next: native corrected Cases support/link execution and current-state verification,
then Shipping 50 of the 60 cases. Complete population, browser and hosting remain
unverified. No push, deployment, dependency/schema/environment change or cleanup
was performed.

## 2026-10-09 corrected Cases native execution checkpoint

The internal corrected Cases executor now captures and atomically applies the
fixed `correction_0001/cases` unit after actual completed special Receiving and
corrected Transformation. It creates a planned synthetic aggregation shift,
60 synthetic boxes/markers and 60 native links, using reserved SSCC serials
15641–15700 and support sequence 261. Journal revision 2 and native event
revision 1/lifecycle version 2 remain separate. Regular Cases keeps its strict
codec and command behavior; shared structural helpers do not select or authorize
another recipe. No runtime route, CLI, schema, dependency or environment was added.

The configured disposable-database evidence recorded for the executor is 44/44
native tests passed, zero skips, followed after the declaration/holder refactor
by all five covering contention tests passed with 39 explicitly filtered skips.
Real support/link rows, amended 300/400 lb origin/history, exact native audit,
rollback after business writes, unchanged replay snapshots and PID-observed
operation/origin lock ordering are exercised. These fixtures create, migrate,
drain and dispose only owned child databases; the shared base stays unseeded.
The lost-acknowledgement scenario simulates post-commit delivery loss.

The configured corrected contract selection passed 200/200 with zero skips.
Focused regular Cases regressions passed 11 tests with 134 explicitly filtered
skips. The earlier wider 164-test regular selection remains nongreen: 159 passed,
four expected negative tests and the existing chain-259 timeout (5000 ms limit,
5163 ms observed). Its focused retry passed, but the wider timeout's cause is
unresolved; no old assertion or timeout was changed.

Check-only CI now has one unconditional `Verify corrected dataset Cases on
disposable databases` owner after successful shared/domain/API builds. It uses
the exact two-suite serial command and step-only synthetic loopback fixture.
The pure contract has no native gate; the native seed has one module-level gate.
Removing only this exact owner restores all 34,241 predecessor bytes, 79 steps
and their complete parsed workflow. Historical predecessor projections omit
only the new owner; their hash constants and mutation families are retained.
Local ownership/isolation checks passed 67/67, zero skips: 132 new corrected
Cases mutations plus the preserved 203 special, 121 regular-range and 108
Receiving-lifecycle families, together with existing isolation mutation families.
The isolation checker passed; release jobs remain locked and permissions read-only.
Local workflow proof does not establish a remote CI run or the full 30-minute budget.

Controller API typecheck, lint, build, whole-format and isolation gates passed
before this CI/documentation increment. Fresh full API package results and final
independent review remain separate pending gates at this checkpoint. Existing
Vite warnings remain visible. This is bounded fixture evidence, not complete
six-month population or physical, scanner, printer, browser, hosting, residency,
backup, production or regulatory acceptance. Next: corrected Shipping of lot
quantity 50 case from the 60-case output; this does not allocate 50 specific SSCC
boxes. No push, deployment or cleanup was performed.

### Corrected Shipping input checkpoint (2026-10-09)

The distinct `us-dataset-corrected-shipping-input-v1` parser/factory binds the
validated corrected Cases input and completed Cases journal identity, including
the exact input/result digests, operation key, request ID and 121 ordered owned
record IDs. It validates the bounded combined prerequisite envelope before caller
property reads, reuses the accepted upstream validators and factory, and rejects
contradictory evidence before classifying coherent pending stages as incomplete.
Returned inputs and plans are owned deeply frozen copies. Regular Shipping and the
recipe descriptor remain unchanged.

The plan contains one lot shipment: 50 case on 2026-06-12 from processor to
recipient_02, with BOL then invoice and a recipe forecast of 60 available/10
remaining. These figures are not current stock evidence or allocation to 50
specific SSCC boxes. No Shipping events or stock effects are written here.

Local pure new Shipping/regular Shipping/corrected Cases contracts passed 180/180
with both DB variables unset, zero skips. The configured touched native Cases
suite passed 45/45, zero skips, including one actual completed-journal Shipping
witness. The subsequent review fix's focused witness passed one with 44 filtered
skips, covering three coherent pending variants and 27 contradictory mutations,
including pending support shift/box aliases to completed Transformation records.
All factory calls preserve complete unchanged database snapshots. The existing one gate,
assertions, timers and child-fixture cleanup remain in place. The native run used
only the synthetic loopback fixture and its owned disposable child database.
The initial sandbox socket EPERM was retried with the authorized identical command.
Scoped ESLint and diff whitespace checks passed; the inherited Vite warning remains.

The unchanged aggregate API test glob owns the new pure file, while the existing
corrected Cases native CI owner selects the extended suite. Controller API
typecheck, lint and build passed after the native DB worker ended. Fresh full API
package results, whole-format/ownership checks, independent final review and remote
CI remain separate gates at this checkpoint. The unresolved regular
chain-259 wider-run timing limitation remains recorded above. Next: guarded atomic
native corrected Shipping with current ownership, lock ordering and actual stock
verification. No full population, browser/hardware, hosting/residency/backup,
production or regulatory validation, push, deployment or cleanup occurred.

### Corrected Shipping native execution checkpoint (2026-10-09)

The dedicated corrected Shipping executor now consumes completed actual amended
Receiving, corrected Transformation and 60 Cases evidence, authorizes the installed
database/owner/tenant/profile and current Shipping capability before capture, and
writes two recipe documents plus one native finalized shipment atomically. It
ships 50 case on 2026-06-12 to recipient_02. Actual current balance is verified as
known case supply 60, used 50 and remaining 10; the output lot remains active and
unchanged. This does not allocate the shipment to 50 specific SSCCs.

Initialize resumes only its own pending intent and accepts a compatible race
winner. Initialize replay and read-only verify recheck exact persisted evidence,
current origins, native rows, documents, audits, consumer and status effects.
Neither entry point installs prerequisites. Native operation arbitration and all
owned roots/revisions precede sorted lot locks, then reference/profile/document
shares precede Cases support locks. Fresh proof checks this transaction's private
native rows before receipt publication. Native failure or post-finalization proof
failure rolls back business writes while leaving the captured intent resumable.
The regular Shipping adapter delegates one extracted native content proof with
its existing input, result and lifecycle semantics retained.

Task 2 recorded an actual completed-Cases semantic RED assertion, then a positive
atomic/replay/verify GREEN. Its first broader selection passed 25 tests and failed
two new fixture tests: the profile SQL named a nonexistent table, and deliberate
post-finalization item drift hit the native immutable-child guard before proof.
The fixes use current org_profiles and a same-transaction negative failpoint in
the owned child with USER guards restored before statement completion. The
focused repair/fresh/lock run passed 9 tests with 69 filtered tests. No production
guard or old test timer/assertion was changed.

The final serial native touched suite plus unchanged regular Shipping seed,
verify and locks regressions passed 131/131 across four files, zero skips,
561.85 seconds. The touched single-gate suite contains its old 45 tests plus 34
new tests. It covers current drift, actual lifecycle/extra consumption, rollback,
pending/concurrent execution and six bounded PID-observed lifecycle lock probes.
Audited fixtures created/migrated/drained/disposed only randomized owned loopback
child databases; the shared base was not migrated, seeded or reset. Default
socket EPERM was retried with the identical authorized local-child command.

After the native DB worker ended, pure corrected/regular Shipping input/result
and corrected Cases contracts passed 489/489 across five files with both DB
variables unset, zero skips. Diff whitespace passed. Controller full API,
typecheck/lint/build/format/isolation/ownership gates and independent review remain
separate pending gates at this checkpoint. The earlier wider regular chain-259
timing failure remains unresolved despite the current serial regressions passing.
CLI/full-dataset wiring and trace_readiness remain subsequent increments. No
remote CI, browser/hardware, hosted/residency/backup/recovery, physical/customer,
production or regulatory acceptance, publication, deployment or cleanup occurred.

### Special native chains orchestration checkpoint (2026-10-09)

The internal `UsDatasetSpecialChainsSeedStore` now composes References, correction
Receiving/amendment, corrected Transformation, corrected Cases, corrected Shipping,
and orphan Receiving/void in order. It validates the actual target and owner before
any stage. Each native store retains its own transaction and evidence checks;
there is no whole-run atomic transaction or globally atomic snapshot claim.

The owned frozen summary contains only dataset identity/version/digest, correction
and orphan result digests and correction shipment count. Its state is
`special_chains_shipping_verified`, with `datasetComplete: false`. Read-only verify
does not install missing or pending stages. Initialization resumes completed
amendment or Cases evidence, and Shipping drift stops before orphan work. Original
error identity and existing native unit/stage annotations are retained.

An actual native assertion RED observed 0 lots/0 boxes/0 Shipping against literal
5/60/1 expectations before implementation. The new focused suite passed 18/18
with 79 inherited cases filtered. The complete serial touched native suite passed
97/97, zero skips, in 470.92 seconds. It verified amended correction Receiving,
void orphan, current known case supply 60/used 50/remaining 10 and active output,
exact digests/frozen copies, unchanged public-table hashes on replay/verify,
read-only incomplete/pending refusal, resume, target/owner denial, native drift
and error identity. All original 79 tests, hooks and timers remain unchanged.
The existing owned-child acquisition, work-drain and verified-disposal assertions
passed; only randomized synthetic loopback child databases were migrated or changed.
The shared base was not migrated, seeded or reset. The initial sandbox socket
EPERM was retried in the authorized owned-child scope. Vite's inherited config-loader
warning remains.

Controller API package/static/build/format/isolation/ownership gates remain separate
at this native checkpoint. No endpoint, CLI, full population, trace_readiness,
browser/hardware, hosted/residency/backup/recovery, remote CI, physical/customer,
production or regulatory acceptance, publication, deployment or cleanup is claimed.

Controller special-orchestration gates subsequently passed API typecheck/lint/build,
isolation and 67/67 named ownership checks; the independent native fresh witness
passed one case with 96 cases name-filtered. Two source reviews accepted the
increment without blocking implementation findings. The new plan's initial format
violation was mechanically corrected and the whole format recheck passed.

The full API run remains red: eight legacy environment setup failures plus seven
unchanged request-resources cases failing around 5000 ms; its focused 13/13 retry
does not identify the broader-run cause. No assertion/timer, environment, shared
database or runtime boundary was changed to obtain green. Scope does not extend
to full-package/demo/hosting acceptance. The supplemental catalog's 29 matching
test DB names are unattributed to this run; own-child disposal was verified
separately and none of those other databases were deleted.

### Request resource test lifetime checkpoint — 2026-10-09

The request-resource suite now owns each complete asynchronous test body through
a test-only phase scope. Its unchanged resource and filesystem cleanup finishes
before `afterEach` restores mocks. `beforeEach` refuses setup while prior work
remains live; `afterAll` drains as a fallback. Existing test and hook budgets,
all eight body implementations and their 13 cases remain unchanged. This repairs
the confirmed secondary test-lifecycle defect without changing API behavior.

A deterministic cancellation-shaped behavioral RED produced six assertion
failures before ownership was implemented; the two table-argument cases passed.
The helper then passed all eight cases, including held asynchronous cleanup,
cleanup-before-restoration ordering, prior-work refusal, original error identity,
no unhandled owned rejection, new work during drain and independent scopes.
The five-file helper/resources/build-descriptor/build-fixture/package-artifacts
selection passed 105/105, zero skips, in 8.27 seconds with both database variables
unset. The inherited Vite config-loader warning remains. No database, native,
browser, hardware, hosted or remote CI checks ran in this bounded repair.

The original seven broader-run resource timeouts still have no established cause.
Focused passes establish lifetime ownership, not a timeout-cause fix or full API,
demo or release acceptance. Controller package/static/build/format checks and
independent review remain separate gates. Release remains locked.

Controller lint subsequently rejected a direct throw in the new cleanup witness's
`finally` (`no-unsafe-finally`). The witness now awaits a real rejecting cleanup
operation, retaining exact error identity and all drain-order assertions. The
same five-file selection passed 105/105, zero skips, in 12.41 seconds; scoped
ESLint passed for all three test files. Both database variables remained unset.

Final controller API typecheck, lint, build, whole-repository format, 51/51
isolation checks and diff whitespace passed. Independent review accepted this
bounded increment without findings requiring changes. The uninstrumented post-fix
full API run finished with 3096 passed and 4650 skipped across 482 files:
218 passed, eight failed legacy environment setups, 256 skipped. Resource cases
13/13 and helper cases 8/8 passed; no assertion failures or original resource
timeouts reproduced. The package still exits 1 because of those setup failures,
including three follow-on undefined-database cleanup errors. Both database
variables remained unset; the original latency cause remains unresolved.
No browser/external validation, shared-data changes, push or deployment occurred.

### Full native assembly input checkpoint (2026-10-12)

The new pure codec validates complete regular and special summaries against the
pinned six-month recipe. It requires all 260 ordered regular rows with 440 recipe
shipments, one corrected shipment, matching canonical dataset identity, exact
shapes and distinct shipping digests. The combined descriptor-safe 256 KiB guard
precedes schema reads; custom array prototypes are rejected without executing
caller getters. Accepted evidence is independently owned and recursively frozen,
with `state: native_assembly_input_validated` and `datasetComplete: false`.

Behavioral TDD recorded 138 assertion failures against the unimplemented interface,
then 138 focused passes. The final nine-file regular/recipe/special/corrected
selection passed 503 tests with three existing native witnesses explicitly skipped,
exit 0, in 19.66 seconds. That final command explicitly unset `DATABASE_URL` and
`US_TEST_DATABASE_URL`; no database checks ran. The inherited Vite CommonJS/native
config-loader warning remains. Scoped diff whitespace passed; controller package,
static/build/format/isolation gates and independent review remain separate.

These checks use structural synthetic summaries and establish no database proof,
receipt, installed dataset or full-population readiness. Coordinator/runtime wiring,
trace_readiness, Plan, Requests and volume acceptance remain subsequent work.
No shared-data, dependency/environment/configuration, CI, publication, deployment,
browser/hardware or other external operations occurred in this increment.

Controller API typecheck, lint, build, whole format, isolation 51/51 and diff
whitespace passed. Task and final source reviews accepted the increment without
Critical/Important findings; the overlapping size-rejection witness and inherited
Vite warning remain Minor limitations. Generic PR API CI collects the new pure
suite, but the separate US branch push workflow does not yet select it; no remote
CI verification is claimed and coordinator CI wiring must account for that gap.

The fresh full API run exited 1: 483 files (219 passed, eight failed legacy setups,
256 skipped), 7884 tests (3234 passed, 4650 skipped), 978.55 seconds. All 138 new
cases passed. The same missing auth/database environment caused legacy setup
failures, with three undefined-database cleanup cascades; no assertion failed.
Both actual DB variables were unset. No native, browser, hosted or full-population
acceptance follows. Earlier implementer commands used an incorrect second unset
alias; the corrected final selection above is authoritative and that history
exception remains recorded, not retrospectively represented as compliant.

### Pure native assembly CI ownership — 2026-10-12

The US development workflow now explicitly selects the pure native dataset
assembly input contract immediately after the existing API dependency build.
Its dedicated owner runs the serial Vitest command without an environment,
condition or ignored failure. Parsed workflow mutation checks protect execution,
unique explicit selection, build ordering, read-only permissions and the existing
30-minute budget. Removing only this owner restores the pinned complete
predecessor bytes and AST; historical ownership checks normalize only this exact
addition and retain their existing hashes. Aggregate API collection remains valid.

This is local CI wiring and pure input-contract evidence, not a GitHub run,
native assembly execution or installed demo data. Native coordinator, full-volume
population, trace/readiness, Plan, Requests and viewer acceptance remain pending.
The existing combined-size negative witness still overlaps strict-shape rejection;
this increment does not strengthen the production byte guard or its API test.
No publication, deployment or release capability is enabled.

### Native coordinator acceptance checkpoint — 2026-10-12

The internal native coordinator now requests the full regular range 0–259 before
the special chains, in the same initialize/verify mode, and validates actual
returned summaries with the pure assembly codec. It retains false dataset
completion and adds no startup population, route, CLI or release capability.

Full native acceptance remains failed: the owned fixture run exceeded its
900,000 ms full-phase deadline before completing regular generation. Nine cheap
native cases passed; the full case and its drain hooks timed out. After process
exit, the exact child had no active clients; only its owned failpoint, sequence
and database were removed, and absence was verified. Its partial native census
contained 140 completed regular Shipping receipts and a 60,225,203-byte database
including migrated schema. These are failure-diagnosis measurements, not complete
dataset or hosting evidence. The corrected primary-key query has an upfront
native driver-shape witness; the cheap native selection passes with the full
case explicitly filtered out. The original deadline and full acceptance checks
remain intact; no full-volume success is inferred from pure/static gates.

Dedicated native push-CI ownership, complete volume/recovery/no-write evidence,
trace/readiness, Plan, Requests, artifacts, viewer and hosted acceptance remain
pending. Performance diagnosis and any optimization require their own evidence;
current authorization checks and native proofs must be preserved.

### Native reference batch optimization checkpoint — 2026-10-12

The first optimization adds internal bounded collection reads to existing native
master/catalog/profile stores and uses them only for reference current-row proof.
Each call reloads authorization; profile reads share-lock sorted requested products
before reading stored/default profiles. Receipt/input/schema/digest comparisons,
fixed reference lock order and independent downstream reference proofs remain.

The actual native reference proof, counted transparently from BEGIN through
COMMIT, fell from the observed assertion RED of 333 SQL calls / 325.304 ms to a
GREEN 22 calls / 39.020 ms under a budget of 32. Counter characterization proves
reused pool clients count once, actual query results/errors propagate and wrappers
restore after failure. All four bounded/ordinary store native files passed 75
tests, and the existing reference file passed 55. Native tests covered tenant
denial, current-role/profile reload, empty/duplicate/bounded/malformed input,
ordinary projection parity, same-transaction changes, invalid/default profiles
and actual concurrent 55P03 product-lock denial without modifying writer locks.
Whole-table hashes remained unchanged for the read-only proof witnesses. The
owned batch fixture children drained and were verified absent after closing.

Actual chain0 initialize/verify measurements after batching were respectively
3947 calls / 3383.784 ms and 1615 calls / 1523.081 ms. These measurements support
further targeted profiling; they do not establish an exclusive bottleneck or
complete-volume acceptance. The complete coordinator file and its 900,000 ms
phase remain untouched. Its complete late-special failure/resume/full-verify/
replay/drift gate was not rerun during this increment because bounded timings
predict another over-budget phase. The controller is reviewing a separate next
optimization stage before that complete gate. Bare API/static final gates are
held until the native workload drains and the amended implementation settles.
No shared database, env file, deployment, runtime, schema, recipe, CI or release
capability was changed. Dataset completion and hosted acceptance remain false.

The serial broader native regression phase has now terminated: six files,
282/308 tests passed, 26 failed, no skips. Special seed, special locks and
corrected cases passed; regular and corrected transformation gates include
unchanged deadline failures. The regular body and drain hook timed out, but
actual work later drained. Five exact retained child names were independently
verified absent with zero clients after process termination. The sixth suite
passed its existing fixture cleanup/absence assertions, but its exact child name
was not retained in the truncated final output. No force-drop or backend
cancellation was used. Complete coordinator and final API/static acceptance
remain held for the controller's next independently reviewed optimization stage.

### Native canonical CPU checkpoint — 2026-10-12

The shared canonical serializer is now exposed unchanged as `canonicalExportJson`.
The browser digest still uses Noble; explicitly selected US demo modules use a
server-only Node SHA-256 adapter over the same freshly validated bytes. The bounded
JSON walker reuses descriptors within one object visit and fast-checks ordinary
strings before its unchanged NUL/surrogate scan. It still traverses every input,
enforces 256 KiB/depth 16 and rejects hidden/accessor/secret-key evidence. Only
private immutable expected catalogues and manifest digests are retained. Current
native headers and every proof are rechecked; the public catalogue factory still
returns fresh recursively owned frozen values.

Literal/error differential tests passed, including legacy array behavior, exact
escaped UTF-8 bounds and post-validation mutations. Domain passed 1368 tests and
typecheck/lint/build; the focused API selection passed 624 tests, followed by 45
codec tests after the final lint-compatible string fast-path adjustment. API
typecheck and scoped lint passed. Existing native reference/journal batch suites
passed 39/39, and the added owned-child header witness passed 1/1, detecting a
same-transaction manifest change while preserving constructor ownership. A verbose
budget evidence run passed 3 tests with 36 name-filtered skips: reference 22 SQL,
owner 11 and dependency batch 14, including transaction control. Native fixtures
drained and checked their own child disposal; named supplemental evidence is saved.

Actual five-chain warm timings were initialize 12838 SQL / 21529.356 ms, verify
5852 / 10321.481 ms and replay 5853 / 10217.621 ms, with identical table snapshots
after both read modes. Earlier paired measurements were 22652, 11081 and 11120 ms
at the same query counts. This modest observed improvement is not full-volume
acceptance. The existing 60-second diagnostic phase and 900000 ms complete phase
were not changed. All 26 earlier adjacent failures and full 260-chain acceptance
remain mandatory final-source Task 4 gates; they were not rerun in this checkpoint.

The US admin bundle and 18 browser-entry configuration checks passed with explicit
US edition and both DB variables unset. Source import checks found no demo adapter
in browser consumers. This is build/source evidence, not a manual browser session.
The inherited Vite CommonJS config warning and large-chunk warning remain. Initial
local checks exposed two new lint issues (fixed) and a missing build edition flag
(rerun explicitly); an initial native socket EPERM was retried in the approved
guarded loopback scope. No env file, shared DB, runtime, schema, recipe, CI, release
lock or deployment was changed. Complete API/package and full native acceptance,
browser/hardware/hosted/customer/regulatory validation remain separate gates.

### Ordered native authorization checkpoint — 2026-10-12

Task 4 retains the membership query and JavaScript capability decision, then reads
the traceability profile and its dependent organization profile in one statement.
Materialized profile and lateral organization reads retain sequential row-share
locks; missing profile denies before an organization row can be read or locked.
The existing code-only authorization wrapper and the target guard consume the
same validated native result. The target reuses its timezone within that call;
there is no authority cache, duplicated role policy or ordinary writer change.

Actual pre-change RED was 5 authorization queries against a budget of 4 and 11
target queries against a budget of 9, including BEGIN/COMMIT. Final native evidence
passed 309/309 cases across 11 whole files: authorization, owner, demo/dataset
journals, master data, catalog, product/profile and Task 1/2 batch regressions.
Exact query counts are authorization 4, target 9, reference proof 18 and journal
dependency batch 12. Concurrent tests proved earlier-profile lock ordering,
missing-profile denial with blocked organization, retained row shares, same-
transaction role/profile/timezone reload and native driver-cause identity.
All three whole files containing the prior 26 failures passed 99/99 cases under
unchanged deadlines. Those 26 failures are now re-established as passing.

The unchanged five-chain diagnostic passed result and no-write hash comparisons:
initialize 11303 SQL / 14203.551 ms, verify 5040 / 6808.284 ms and replay 5041 /
6723.728 ms. Task 3 same-boundary values were 12838 / 21529.356 ms, 5852 /
10321.481 ms and 5853 / 10217.621 ms. These measurements still do not establish
full-phase readiness: a simple same-rate projection exceeds 900000 ms before all
required full verification/replay passes. Full 260-chain acceptance, three other
adjacent whole files, further affected shipping/special regressions and final
package gates remain open. Additional expensive execution is held for measured
scope review; the full gate, assertions and deadline are not waived.

Native work drained and owned children were verified absent. Retention 1 was
rejected by the existing SQL CHECK; boundary values 2 and 2147483647 passed native
authorization. Invalid persisted one-year data was not manufactured by disabling
integrity constraints. Initial new-test setup defects were corrected without
changing production semantics. Existing Vite CommonJS configuration and previously
reported bundle-size warnings remain unsuppressed. No shared DB, env file, schema,
recipe, CI, runtime, browser, release lock or deployment changed.

### Private Receiving expectations checkpoint — 2026-10-12

Task 5 retains a single private deeply frozen catalogue and its expected reference
input digest in the Receiving codec. Every incoming stage/input/result still gets
fresh bounded JSON traversal, strict schema and digest/record-ID comparisons;
result objects keep fresh ownership. The unchanged public catalogue factory still
constructs fresh owned data. No native proof, authority or persisted-row cache was
added, and the rejected owner CTE proposal was not implemented.

The real codec regression was RED before production edits: two identity calls
constructed two catalogues; two result parses constructed four, independently for
chains 0, 131 and 259. Transparent factory spies forward original behavior and
restore in finally. The final eight codec/factory files passed 484/484, including
six new expectation/ownership/fresh-input checks. API typecheck, scoped ESLint,
code formatting and diff/scope checks passed.

The unchanged warm5 passed under its original 60000ms bound, including equal
results and exact no-write table hashes for verify/replay. A controller-approved
verbose recapture retained the metrics omitted by the first passing reporter:
initialize 11303 SQL / 19750.144 ms, verify 5040 / 9488.938 ms, replay 5041 /
9471.902 ms. Query counts are unchanged from Task 4, and these wall times are
slower than its 14203.551 / 6808.284 / 6723.728 ms sample; this checkpoint makes
no end-to-end speedup claim. The first passing run remains recorded at 42.74s
total. Initial sandbox connection EPERM occurred before native execution; the
approved guarded loopback run succeeded. Native work drained and the owned
disposable child was verified absent. Existing Vite configuration warnings remain.

This is a bounded source checkpoint. Full 260-chain acceptance, remaining native
regressions and final package gates remain mandatory and unrun here; dataset
completion remains false. No existing tests, fixtures, deadlines, schema, recipes,
CI, env files, shared data, release locks or deployment changed. No browser,
hardware, hosted or other external acceptance was performed.

### Completed regular-chain terminal proof checkpoint — 2026-10-12

Task 6 selects the existing live Shipping -> Cases -> Transformation -> Receiving
-> References proof once for a structurally completed regular chain, including
completed initialize/replay. A guarded repeatable-read projection reads only stage
identity, revision and native receipt presence. This metadata is eligibility,
never business proof. Nested verifiers, native predicates and the global References
proof remain unchanged; terminal denial never initializes or repairs a chain.
Missing/pending chains keep their original ordered stage execution and commits.

Actual driver-budget RED was 1018 queries for completed chain0 verify against the
650-query ceiling. Final source uses 479 queries / 410.852ms for verify and 480 /
402.206ms for replay, with equal summaries and unchanged hashes of all 198 tables.
The first full-row eligibility prototype passed 59 tests but failed an additional
native combined-partial regression: malformed Transformation intent incorrectly
preceded Receiving audit drift. The final metadata projection fixes that observed
failure; exact Receiving-first assertions pass in both modes. No test or deadline
was weakened. Three earlier new-test setup errors were corrected to reach native
proofs without violating unrelated uniqueness/nullability constraints.

Final native matrix: 60/60. Unchanged whole regular, journal, journal-batch,
reference-batch and reference-seed suites: 151/151. Exact unchanged warm5: 1/1,
with fresh initialize 11363 SQL / 9670.254ms, verify 2177 / 2057.320ms and replay
2178 / 2021.377ms; both read modes preserve results and complete table hashes.
The comparable Task 5 clean-host sample was 11303 / 10099.414ms, 5040 / 4646.404ms
and 5041 / 5123.235ms. Fresh eligibility adds 60 queries across five chains;
completed verification/replay remove 2863 queries each. The earlier explicitly
approved termination of 24 unrelated CPU-heavy processes is a separate host change,
not a source optimization or a repeatable throughput guarantee.

API typecheck, scoped ESLint, code formatting and diff checks passed after native
work drained. Each owned disposable database was verified absent; no shared data
or env file was used. The existing References proof does not assert reference
creation audits/operations; Task 6 preserves its actual predicate set and all
Receiving/Transformation/Cases/Shipping audit and operation proofs.

This is bounded evidence only. The byte-identical 11-case full coordinator with
its 900000ms bound, actual 260-chain acceptance, remaining native regressions and
final whole-package gates remain mandatory controller work. Dataset completion
remains false. No browser, hardware, hosted acceptance, schema, recipe, dependency,
CI, release, commit, push, PR, deployment or cleanup is part of this checkpoint.

### Bounded complete dataset snapshot checkpoint — 2026-10-12

Task 7 changes only test-support snapshot memory use: all public tables and all
columns remain covered in one read-only repeatable-read transaction. A single
cursor fetches at most 64 rows at a time, preserving the exact legacy hash for
each complete sorted JSON array. Sorting may spill normally; no PostgreSQL,
Docker, resource or timeout setting changed. Cleanup attempts rollback and release
without masking the original native driver error.

Final native combined verification passed 163/163 across six files in 148.97s:
12 focused snapshot cases and 151 cases from the five unchanged whole journal,
journal-batch, reference-batch, reference-seed and regular-seed suites. The original
aggregate witness was genuinely RED. A new-test setup wrapper error and a scoped
lint finding were corrected before this final combined run. API typecheck,
scoped ESLint, code/doc-append formatting and frozen-source guards passed.
Native work drained, and each successfully acquired test-owned database
was disposed with an absence check. Only guarded loopback synthetic child
databases were used; the base database was not migrated or changed.

The retained failed-full child belongs to the controller and was not touched by
this task. Its prior OOM/recovery failure remains recorded; full-size bounded
snapshot validation, independent task review, unchanged full11 acceptance and
final package gates remain pending. Dataset completion remains false. No shared
data, production implementation, existing tests, nested proofs, env files,
dependencies, schema, workflows, release locks or deployment changed. No browser,
hardware or hosted acceptance is claimed.

### US-11 native coordinator drift boundary — 2026-10-12

The bounded native regression initializes exactly one regular chain, verifies that
the document-notes or reference-party mutation affected real rows, and rejects
both native modes without changing any of the 198 public-table hashes. Recognized
internal semantic mismatches now become `us_dataset_native_drift` only at the full
coordinator boundary. The original Error remains the exact cause, with its
`unitKey` and `stage` retained and its descriptors unchanged. Direct regular and
nested store error namespaces remain unchanged.

Translation is limited to the seven known reference, receiving, transformation,
cases, shipping, special and corrected-transformation mismatch messages. Driver
or network codes anywhere in the cause chain prevent translation. Frozen errors,
unrecognized failures, primitives, accessors, cycles and deep or uncertain cause
chains pass through unchanged. No query, proof, lock, retry or repair behavior
changed.

Actual TDD evidence: the new native file failed three assertions before the fix
(notes/reference namespace and classifier), then passed all five tests. Final
execution passed 21/21 tests including the unchanged whole regular-chain file;
the unchanged coordinator's ten bounded cases also passed, with its full phase
explicitly excluded. A real first-chain SQL40001 fault preserved exact outer Error
identity, cause code/message and annotations, and executed once. Owned native
children drained and were verified absent after disposal. API typecheck, scoped
ESLint and 168/168 unchanged assembly/regular contract tests passed. The initial
sandbox loopback EPERM was rerun with scoped access; it was not a product RED.

The complete eleven-case coordinator and its 900,000 ms deadline remain
byte-identical and full260 acceptance remains open. Final package/build, browser,
hardware and hosted checks were not run in this bounded increment. No shared
database, env file, dependency, schema, workflow, commit, push or release changed.

### US-11 Task 9: printable ASCII scalar encoding

Canonical primitive strings and object keys now bypass generic JSON escaping only
for printable ASCII without quotes or backslashes. The bounded JSON walker counts
those strings as length plus two; controls, DEL and non-ASCII retain the original
validation/escaping path. Traversal, descriptors, legacy array behavior, cloning,
digests, native guards and every proof remain unchanged. There is no value or proof
cache. Two independent frozen-oracle tests cover 262,144 UTF-16 comparisons plus
literal UTF-8/SHA, caller effects, mutation and error/size/depth precedence. Actual
forwarding budgets were RED before the fast paths and GREEN afterward.

The whole domain suite passed 1,395 tests; the API codec selection passed 906 with
three native-only cases explicitly skipped without database configuration. Seven
unchanged native files passed 216/216, including all 60 completed-chain proof
cases, live journal/reference/regular behavior and five coordinator drift cases.
Existing full-table no-write assertions and original timers were retained.
The two unchanged mixed codec files then passed 151/151 with native configuration,
closing all three previously skipped supplements on actual amendment/void facts.

A same-session baseline/current warm5 pair used the exact original test with its
60,000 ms deadline. SQL counts stayed 11,363 initialize, 2,177 verify and 2,178
replay; measured times were respectively 10,540.315/9,807.605 ms,
2,200.037/2,144.619 ms and 2,188.002/2,025.952 ms. Both runs proved unchanged
snapshots after verify/replay. This single pair is bounded evidence, not a stable
performance estimate or full260 acceptance. Twelve owned temporary databases were
verified absent with zero active clients; the retained failed-full child was not
touched. Whole domain/API static gates and the 18 Node browser-entry checks passed.
The unchanged full11 file, 900,000 ms phase, controller retained260 measurement,
independent review and final broad acceptance gates remain required.

### US-11 native SQL Task 10: additive audit indexes — 2026-10-12

Migration0143 adds exactly two nonunique B-tree indexes on tenant audit events:
`(organization_id, action)` and `(organization_id, request_id)`. The existing
tenant-created index, all historical migrations and every production query and
proof remain unchanged. Drizzle generated the SQL and snapshot; structural review
confirmed exactly two index changes and one appended journal entry. This shared
table change is isolated in the US worktree and has not been deployed or applied
to shared/retained databases.

Schema/SQL tests first failed for missing indexes/migration, then passed2/2.
Fresh Drizzle/runtime installation and0142 upgrades with idempotent reruns passed
4/4 native cases. Both upgrade fixtures retained all198 public-table hashes and
12,004 audit rows across two tenants, including duplicate facts; further duplicate
inserts remained legal. Actual selective FOR SHARE plans, without planner overrides,
used the new indexes: two matching rows and6 shared-hit buffers instead of filtering
6,000 other tenant rows with180 shared-hit buffers. On these synthetic fixtures
each new index used958,464 bytes; migration times were38.820/46.477ms. A rollback-only
single INSERT diagnostic increased WAL from3 records/343 bytes to5 records/567 bytes.
These observations do not estimate production throughput or full-seed speed.

Whole DB tests passed260 with730 infrastructure skips when both DB variables were
unset; native migration coverage was exercised separately. DB build/typecheck/lint
passed. The initial seven-file API run passed195/196: one existing test expected
insertion order from an audit SELECT without ORDER BY. The approved correction
adds only explicit descending action ordering to that test query; both exact
expected facts, predicates and deadlines are unchanged. The whole corrected file
passed21/21. Together with the other six passing files and31/31 unchanged tenant
origin/cardinality checks, all227 selected native API cases now have passing
evidence; the original failure log remains retained. Nine logged invocation-owned
children were independently verified absent with zero active clients; the remaining
original fixtures completed normal awaited cleanup. Retained failed-full databases
were not accessed.

Transactional CREATE INDEX can block writers and adds storage/write maintenance;
CONCURRENTLY is incompatible with the existing transactional migrator. Deployment
needs separate operational review. Task9's retained260 result remains historical
pre-index evidence (106,756 SQL,113,686.717ms,198 unchanged hashes). Full11 at the
unchanged900,000ms deadline, post-index full260 acceptance, independent review and
remaining broad gates are still pending. No commit, push, publication, deployment,
browser or hardware acceptance is implied.

### US-11 Task11: exact allocator transition evidence (2026-10-12)

The actual full native run failed at592545ms after260regular chains and explicit
special resume because its old preservation oracle required allocator rows to
remain byte-identical. The independent one-chain diagnosis reproduced that false
expectation. The approved exception changes only test-side counter comparison:
saved before rows plus newly allocated roots' original revision1 creation instant,
saved timezone and exact event number determine the expected state. All three
complete counter relations must match it, including new-year keys; old business
PK hashes retain their original assertion. No production writer, saved fact,
recipe, full-volume quantity, fault predicate or deadline changed.

Focused pure tests passed55/55, covering exact2Receiving/1Transformation/1Shipping,
year rollover independent of three machine timezones, malformed allocation
evidence, missing/extra/foreign keys, incorrect increments and unrelated fields.
The native one-chain40001/resume test passed1/1 in9.463s (12.34s process):189PK
tables checked,186business tables byte-preserved, three exact counter relations,
six transactional tampering probes rejected. Verify/replay retained every table
hash. The random owned child drained and was independently verified absent by its
fixture. API typecheck, scoped lint, build and changed-file formatting passed.

This is a reviewed-oracle candidate, not full acceptance. The original full
baseline and failed run remain retained; the amended full test needs independent
review and a fresh all11/260-chain run at the original900000ms limit. Task1–10
sources, unrelated census, HEAD/index and both prior document prefixes stay
guarded. No commit, push, publication, deployment, browser or hardware claim.

### US-11 Task12: permanent roots versus current events (2026-10-12)

The Task11 full retry failed at596713ms after exact allocator/business preservation
and total964/963/785/15700 had passed. Its type census incorrectly classified
physical roots through current_event_id, omitting the correctly voided orphan.
The approved test-only correction joins each original root.id/event.id with tenant
identity, retaining Receiving262/Shipping441/Transformation261. Independent
current counts261/441/261 require finalized status, and an exact orphan witness
requires null current/pending pointers and the actual latest revision1 void ID.
Product void behavior, physical quantities and all other full checks are unchanged.

The saved real bounded audit was RED only on currentReceiving3 versus physical4,
after every later bounded witness passed. The corrected new native regression
passed1/1 in16010ms (18.84s process) under60000ms: actual regular0 and259, one late
Special40001 and explicit resume, four new roots, exact three counter relations,
189old PK tables, shipping/lifecycle facts and all198 table hashes after each
verify/replay and drift denial. Its owned child drained and was verified absent.
API typecheck, scoped ESLint and build passed. The existing Vite configuration
warning remains visible. No shared database, retained child or env file was used.

The inverse-diff guard restores every pre-Task12 full byte after undoing only the
physical classifier and two added witness blocks. All57 prior allowed non-doc
sources,4354 unrelated files, HEAD/index and four document prefixes are preserved.
Full SHA changes from2a5d4f8c4ff2b2a8ac085b215829d537f4e917bc8490ca07b6a8f67e3a325743
to d8a51519ad75272793e5631342151fd196e32c3d6fdd261dfd9b67b7b49cd0d5.
Fresh independent review and actual full11/260 under900000ms remain required;
full envelope/size, full verify/replay timing and native-boundary drift are not
reproved by bounded components. No commit, push, PR, release, deployment, browser
or hardware acceptance is claimed.

### US-11 full native acceptance result (2026-10-12)

The fresh complete coordinator suite passed all 11 tests and all 260 actual
regular chains. Its main scenario completed in 781725 ms under the unchanged
900000 ms limit; total runner time was 790.42 seconds. It exercised the single
late40001 fault, failed-full verify, explicit resume, exact allocator transitions
and preserved business facts. Physical/current/void witnesses, counts964roots/
963current-finalized/785lots/15700synthetic boxes, exact quantities, frozen bounded
full summary, full-table verify/replay no-write and native drift denial all passed.

Measured resume was 88967.002 ms, verify87499.160 ms and replay87919.116 ms.
The reported generation500070.554 ms includes the initial failure, failed-full
verify and snapshot work; it is not pure generation throughput. Process peak RSS
was1403952 KiB; the isolated child including schema occupied89913011 bytes.
All owned work drained and the fixture verified the child database absent.

This is local native dataset acceptance, not deployment, remote CI, browser,
hardware or external acceptance. Plan/Request execution remains outside this
native chain slice and datasetComplete remains false. Remaining broad gates and
final independent review are tracked separately. No push, PR or release occurred.

Final adjacent native regressions passed465 tests across12 whole files, without
skips. API typecheck/build/lint, formatting and preservation guards passed.
Independent final review approved the scoped optimization with no code blockers.
The no-infrastructure whole API run is not green:3368 passed,4805 skipped and
8 failed files from missing runtime settings; three also report secondary teardown
errors. No unrelated RU test or runtime configuration was changed to bypass this
limitation. No publication or operational acceptance is claimed.

### Isolated ordinary API validation (2026-10-13)

The remaining ordinary API setup checks can now run through a test-only launcher:

```bash
node tools/us-development/run-api-validation.mjs remaining
node tools/us-development/run-api-validation.mjs full
```

The launcher validates the tracked synthetic PostgreSQL entry point at
`127.0.0.1:55432`, database `markiro_us_dev`, user `markiro_us`, including the
server-reported database and role before creating anything. It creates a random
`markiro_us_api_<UUID>` child, verifies that identity, and applies the current
144-migration chain only there. The parent receives administrative queries only.
Caller database URLs, extra test-selection flags, timeout changes and repair
options are not accepted.

Tests receive a clean environment with ordinary `DATABASE_URL` pointing at the
owned child, `NODE_ENV=test`, generated auth/platform/pairing/encryption keys,
and the same localhost origins as ordinary CI (3000/5173/5473/5373).
`US_TEST_DATABASE_URL` stays unset. SMTP and S3 defaults are redirected to an
invocation-owned loopback refusal listener, so existing localhost Mailpit/MinIO
services are not contacted. No optional live-provider credentials are enabled.
Generated keys and the database credential are redacted from subprocess output.

The launcher awaits subprocess exit and closes its migration pool before a normal
`DROP DATABASE`. It never force-drops databases or terminates unknown sessions.
Cleanup errors retain the original test failure status. A before/after database
inventory detects residual nested fixtures without deleting unfamiliar targets.

The first actual remaining run passed all eight whole files and 101 tests with
zero skips in 25.04 seconds. Per-file totals were billing accounts 2, exchange
credentials 13, exchange import 19, exchange orders 9, exchange protocol 20,
integrations delete 6, integrations 28, and subscription route inventory 4.
The child was normally dropped after exit, no new databases remained, and the
owned service listener received zero connections. The original eight test source
hashes are preserved; no assertion, deadline, product code or runtime guard was
changed. This is local API evidence, separate from native 260-chain acceptance,
remote CI, browser/hardware validation and deployment.

The first full ordinary API run was not green: 329 passed files, one failed file,
166 skipped files; 4755 passed tests, one failed test and 3419 skipped tests.
The failing billing-request journey used an offer expiring on `2026-09-30`
against the real October clock and correctly received `offer_expired`.
Its test fixture now uses the service's existing protected clock seam fixed at
August 28, preserving all 77 tests and their assertions, expiry values and production guards.
Both whole billing files passed afterward: 84 tests, including the unchanged
expired-offer rejection. The original eight files again passed 101 tests without
skips under intentionally hostile ambient PG settings.

Parent PostgreSQL configuration is also isolated before driver loading. Deferred
SIGINT/SIGTERM handling spans creation, migration, test execution and disposal.
Eleven Node safety tests cover input/environment checks, actual driver options
and six signal-wrapper cases. A separate real-database interruption smoke sent
SIGINT after CREATE: migration drained, the owned child was normally removed,
no nested databases remained, and Vitest did not start. This returned 130 rather
than killing the launcher before cleanup. SIGKILL or host loss cannot be handled
by JavaScript; the launcher does not attempt broad recovery of unfamiliar DBs.

The final unfiltered API run exited 0 in 642.16 seconds: 330 files passed and
166 skipped (496 total); 4756 tests passed and 3419 skipped (8175 total), with
zero failures. The fresh owned child was normally dropped after subprocess
exit, no new databases remained, and its refusal socket closed after safely
rejecting 24 connection attempts. The skipped cases include 3390 US-named
cases, four US deployment-entry cases, 22 separate inventory-database cases,
two real local-infrastructure cases and one live National Catalog case. Their
explicit opt-ins remained unset; this is not a zero-skip or full-CI claim.

### Fresh-checkout CI dependency order (2026-10-13)

GitHub run 38312499042 failed before API verification: the Node tooling checks
imported the US Vite configuration, whose contracts package exports compiled
`dist/index.js`. The fresh checkout had not built it. Existing local output hid
this ordering defect; the runner reported 92 passed and 12 failed checks.

An unconditional contracts bootstrap now runs after the release isolation checker
and before all Node tooling checks. `pnpm turbo build --filter
'@markiro/platform-contracts...'` builds both contracts and their domain dependency
through the existing dependency graph. All later checks, commands, permissions,
release locks and the 30-minute CI budget remain unchanged.

Three new regressions verify this execution boundary and reject missing, moved,
duplicate, conditional and failure-swallowing bootstrap steps. Historical owner
snapshots remove only the exact ordered additive step; their existing byte/AST
hashes stay unchanged, and malformed additions remain visible. Local checks passed
108/108 without skips, and the real two-package bootstrap build passed. Remote
CI completion is a separate gate to be checked against the pushed source SHA.

The following run passed the bootstrap, Node tooling, corrected Cases and special
dataset checks, then exposed a Receiving timeout-witness reporter mismatch. ANSI
formatting interrupted its exact summary regex and coloured its boolean marker.
The witness now removes terminal control formatting after child closure, before
the same assertions. It deliberately requests coloured child output; local
verification also disabled agent-detection metadata, which otherwise makes Vitest
silently turn colours off. No process-access restriction was changed.

A real coloured runner reproduced the summary failure before normalization. The
entire Receiving lifecycle file then passed 38/38 without skips in 28.66 seconds.
The 50-ms fault budgets, exact child failure/skip counts, no-reprovision guard,
single provision, drain ordering and verified owned-database absence remain
unchanged. This is a test-output correction, not a relaxed timeout or runtime fix.

The next GitHub run verified the corrected bootstrap and Receiving witness, then
reached the existing 30-minute job limit during canonical reference checks. The
unchanged 82-step suite is now partitioned into three parallel matrix segments:
transaction foundations, regular dataset checks, and cabinet/HTTP/browser checks.
Each runner owns its own PostgreSQL service. All three run the original common
setup, release-isolation checker and transitive shared/API builds first. Specialized
steps retain their exact commands and have exactly one segment owner; each job
retains the 30-minute budget, and failures are neither ignored nor fail-fast hidden.

Partition tests pin every predecessor command, property and source byte, reject
missing segments and changed guards, and preserve the earlier historical owner
assertions through strict complete-partition normalization. A local ordinary API
rerun also passed 4,756 tests with 3,419 opt-in skips, followed by normal owned-child
database disposal and zero new databases remaining. Remote matrix completion is a
separate acceptance gate, not established by these local results.

The first three-segment remote run completed foundations in 16m2s, but dataset
and cabinet both reached the unchanged 30-minute job limit. No assertion failure
preceded those cancellations. The partition is refined to five segments with the
same maximum of three concurrent runners: foundations, regular dataset,
references/office, Requests storage/HTTP, and worker/browser. All 82 predecessor
steps and their byte/AST pins remain unchanged. Only the worker-entry build runs
in both Requests and worker/browser, as an explicit failure-propagating prerequisite;
every specialized verification still has exactly one owner. The original
30-minute job and test budgets remain unchanged.

The five-segment run then exposed one 5-second corrected-Transformation test
timeout. Its all-public-table snapshots made hundreds of cursor round trips.
The fixture now streams a single ordered cursor across all catalogued public
tables, within the same read-only repeatable-read transaction and 64-row batches.
Each table still hashes its exact full-row JSON sequence, including duplicates
and empty arrays; no table or column is omitted. Error, rollback and connection
discard behavior stays unchanged. The regression proved unchanged hashes while
reducing one owned snapshot from 614 calls to exactly 9.

All six files of the failing remote stage passed locally: 347/347, without skips.
The separate native snapshot suite also passed 12/12, retaining complete hash
parity, concurrent-commit isolation and actual driver/cleanup failure assertions.
Only its old per-table-cursor shape assertions were replaced with exact single
cursor coverage, total row count and tail-batch checks. No test or job timeout
was increased, and no runtime product behavior changed.
