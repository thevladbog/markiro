# US-09 — Requests HTTP integration design

Status: owner-approved written specification, 2026-10-05. The subsequent
implementation plan has its own owner review gate. This is a design, not an
implementation or acceptance record.

Scope: expose the existing request, validation, Prepare and durable-run services
through the isolated US HTTP runtime. EN/ES cabinet integration follows in a
separate increment. No commit, push, PR, merge, release, provisioning, deployment,
base-database migration or real-data use is authorized by this document.

## 1. Intent and agreed boundaries

An authorized US processor user can record a trace request, inspect and validate
its saved scope, explicitly prepare either an export-ready candidate or an
incomplete response, inspect immutable run history, request a retry and download
published private artifacts. Preparation does not submit files externally,
automatically close the request or assert regulatory compliance. Synthetic origin
and distinct incomplete outcomes remain visible.

The owner approved these conversational sections:

- Requests HTTP first, then EN/ES cabinet; the worker remains a separate process.
- Use `/traceability/requests` and `/traceability/export-runs`, matching the actual
  US API. The older `/api/us/traceability/...` wording is superseded for this slice;
  no compatibility alias is opened at an unimplemented path.
- Missing, invalid or dirty checked build identity does not stop the whole API.
  Request creation/editing and authorized reads remain available; Validate and
  Prepare refuse without a checked clean descriptor.
- Without configured private package storage, Validate remains available with a
  checked build; Prepare, manual retry and artifact download are unavailable.
- Current MFA, tenant membership, processor profile and operation capabilities
  govern every boundary. A download does not require mutation permission.
- Validate uses the captured request revision; Prepare additionally uses the
  captured validation digest. Stale intent conflicts rather than silently acting
  on newer data. Same-key Prepare replay returns the original frozen run.
- Downloads verify private published bytes, reauthorize and audit before release.
  Closing a request preserves history/downloads; no public storage URL is returned.

This supplements the [current US-09 design](2026-10-04-us-09-trace-request-current-design.md)
and [selection/freeze design](2026-10-04-us-09-selection-freeze-design.md). It retains
the package/core/worker contracts and the [checked runtime design](2026-10-05-us-09-worker-runtime-design.md).
The [US isolation boundary](../../us/development-isolation.md) remains mandatory.
Persisted production data and infrastructure must remain outside the Russian
Federation; this local increment creates no hosted infrastructure.

## 2. Current implementation baseline

Current code, not historical plan checkboxes, defines the starting point:

- `UsRequestStore` implements create/update/close with current QA authorization,
  expected revision, default elapsed-24-hour deadline, tenant-unique request
  number and exact atomic audit. It has no public list/detail projection.
- `UsRequestValidationStore` validates and acknowledges warnings in a locked,
  consistent transaction. Validate currently has no expected-revision argument.
- `UsRequestPrepareStore` freezes complete bounded evidence and allocates a run.
  Its existing command digest covers the request ID and mode; same-key replay
  already precedes live lifecycle/source checks after current authorization.
- `UsRequestWorkerLifecycle.retry` has durable idempotency, lifecycle-version
  control and authorization of the caller and original initiator. Its `read`
  method is an internal evidence seam, not a cabinet authorization boundary.
- The package store reads bounded bytes and checks content type, length and hash.
  It is not itself a user-authorized download service.
- `UsDevelopmentModule` and `UsRuntime` mount existing US controllers/stores,
  including Plan, but no request controller or request package client. Requests
  response/read/list schemas and public retry contracts are still missing.
- The checked descriptor requires clean source and binds actual shared-package
  resolution to inventoried output. The API must use the same default loader;
  environment version/SHA fields or mutable Git reads are not substitutes.

Existing uncommitted worker-runtime changes are preserved. No source commit is
created to make its publication gate pass. Clean, owned fixtures may exercise
positive integration; they do not label the dirty product tree publishable.

## 3. Composition and availability

Add focused US request controllers, authorized read/download services and public
contracts; compose them only through `UsRuntime`/`UsDevelopmentModule`. Reuse the
existing US database pool, request core and private storage configuration loader.
Do not import the RU app module, scheduler, broker, pg-boss or RU storage providers.
The HTTP process never claims work or instantiates a polling worker.

Build availability is operation-local, not a prerequisite for metadata/liveness,
auth, existing Plan routes or request CRUD. Validate/Prepare use the checked
default descriptor and its immutable build stamp. Invalid/missing/dirty or mixed
output gives a sanitized unavailable result, without partial command writes.
Recheck the relevant checked build boundary for an operation; a permanent cached
success must not authorize later changed output. No public root/path/identity
override or production test seam is added.

Package configuration uses only the six existing `US_REQUEST_PACKAGE_S3_*`
fields. Missing/invalid package configuration blocks package operations, not
unrelated API functionality. Do not fall back to Plan/general S3, invent a bucket,
start a service or persist credentials. Retain the base US environment's strict
edition/loopback policy. Existing Plan configuration behavior is not redesigned.

| Operation                                         | Checked clean build needed | Package storage needed |
| ------------------------------------------------- | -------------------------- | ---------------------- |
| List/detail/create/edit/close; run history/detail | No                         | No                     |
| Validate                                          | Yes                        | No                     |
| Acknowledge saved warnings                        | No                         | No                     |
| Prepare, including same-key HTTP replay           | Yes                        | Yes                    |
| Manual retry                                      | No                         | Yes                    |
| Download a previously published artifact          | No                         | Yes                    |

Acknowledgement only names a saved digest; it does not assert fresh validation.
Retry preserves the existing frozen execution/checkpoint compatibility policy;
it does not promise that the currently installed worker can execute every older
checkpoint. Only a checked clean worker can publish, independently of HTTP.
Availability returned to the cabinet is descriptive, never authorization.
If build availability has not been checked, label it unknown rather than
available. A checked availability read may catch descriptor refusal without
failing the authorized detail response; the next command still checks afresh.

Default storage clients created by the runtime are owned and destroyed at
shutdown. Explicit test-injected transports remain caller-owned. Unavailable
composition creates no worker, claims or startup migration. Add read-only schema
preflight for the request/run/artifact/attempt/checkpoint/retry columns needed by
the new surface; do not migrate or repair them on startup.

## 4. Canonical routes and public contracts

IDs use the existing UUID schema and lowercase canonical UUID paths. Guards must
check the actual method/path, not merely successful UUID parsing. Extra segments,
case aliases, trailing-slash aliases, encoded path aliases, unknown methods and
unsupported query fields stay closed. Head-to-GET fallback is not a download API.

This inventory describes business operations. The existing trusted-origin CORS
`OPTIONS` preflight remains a protocol response (204), not a business route or
authorization grant. It must not dispatch a request command or perform the
business database preflight; supported mutation methods still require the
existing session/MFA, Host and Origin boundaries.

| Method and path                                        | Input and result                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `GET /traceability/requests`                           | Bounded summary list                                                                  |
| `POST /traceability/requests`                          | Existing strict create body; command acknowledgement                                  |
| `GET /traceability/requests/:id`                       | Current request detail and saved validation/availability                              |
| `PATCH /traceability/requests/:id`                     | Existing strict partial update + `expectedRevision`; acknowledgement                  |
| `POST /traceability/requests/:id/close`                | `expectedRevision`; acknowledgement                                                   |
| `POST /traceability/requests/:id/validate`             | `expectedRevision`; saved validation response                                         |
| `POST /traceability/requests/:id/acknowledge-warnings` | `expectedRevision`, `digest`, `reason`; acknowledgement                               |
| `POST /traceability/requests/:id/prepare`              | `expectedRevision`, `validationDigest`, `mode`, `idempotencyKey`; run acknowledgement |
| `GET /traceability/requests/:id/runs`                  | Bounded immutable run-history summaries                                               |
| `GET /traceability/export-runs/:id`                    | Authorized safe run detail                                                            |
| `GET /traceability/export-runs/:id/attempts`           | Bounded safe attempt-history summaries                                                |
| `POST /traceability/export-runs/:id/retry`             | Existing `expectedLifecycleVersion`, `reason`, `idempotencyKey`; receipt              |
| `GET /traceability/export-runs/:id/artifacts/:kind`    | Verified binary artifact response                                                     |

Request-list query permits only optional exact `requestNumber`, `status`
(`open`/`closed`), `limit` and `offset`. Default limit 25, maximum 50; canonical
offset is 0–10000. History uses the same bounded pagination without other filters.
Reject duplicate/noncanonical/unknown parameters. Request order is due time then
ID; run history is run revision descending, attempt history is attempt number
descending. Attempt history accepts only the same `limit`/`offset` pagination.
None is a complete export scope.
Detail, command and artifact routes permit no query. No standalone run collection,
DELETE, reopen, sign-off, public download token or arbitrary object-key route.

Use strict shared Zod contracts and explicit OpenAPI entries. The internal
Prepare body/receipt digest remains compatible; introduce a distinct public HTTP
envelope rather than redefining the old saved command shape. Public responses
are explicit projections, not Drizzle rows or raw worker state.

Create/PATCH alone allow a 256 KiB uncompressed JSON body, using the established
large-draft parser and exact path/method selection. This accommodates the existing
bounded Unicode TLC lists without widening other command routes; commands retain
16 KiB. Host, trusted mutation Origin, JSON-only/no inflation, server correlation
ID and no-store rules remain in force. There is no browser proxy opening in this
backend increment.

## 5. Authorization, reads and privacy

Every business operation first verifies the actual US session/MFA and resolves
tenant/actor server-side. Reload membership and processor profile inside the
protected service transaction; client tenant/role/capability fields are rejected.

| Boundary                                                    | Required current capability                        |
| ----------------------------------------------------------- | -------------------------------------------------- |
| Request and run reads                                       | `traceability.read`                                |
| Create/update/close request                                 | `traceability.qa.manage`                           |
| Validate, warning acknowledgement, Prepare and manual retry | QA + `traceability.export.read`                    |
| Artifact download                                           | `traceability.export.read`, without QA requirement |

All routes require `US_FSMA204_PROCESSOR`. Wrong-tenant IDs resolve as not found;
generic/RU profiles are unsupported. Retry also retains original-initiator
authorization. Session/projection capability lists do not waive transaction checks.

Lists exclude requester contact and raw frozen content. Authorized request detail
may contain saved requester/contact and scope; run detail uses its immutable
request revision/scope, not the mutable current request. Detail may expose bounded
saved findings with source IDs/line references, warning acknowledgement metadata,
the latest safe attempt summary, lifecycle version, timing, artifact names/types/sizes/hashes
and recognized failure codes. Never expose lease tokens, private object keys,
credentials, checkpoint models, raw input snapshots or provider errors. The
separate attempts route paginates summaries rather than returning an unbounded
history across retry cycles; it never fabricates missing pre-worker attempts.

Public run reads require an authorized consistent read and checked persisted
evidence; do not expose internal `lifecycle.read` output without authorization or
use a separate stale pre-read to grant access. A corrupt row fails unavailable,
without repair. Immutable v1/v2 compatibility follows the existing verifier.
No HTTP read refreezes, reconciles leases or silently updates a saved run.

Keep request lifecycle, last saved validation and run status separate. Saved
validation time/digest does not prove that live source/Plan/build values are still
current; freshness is rechecked during Validate/Prepare. A ready incomplete run
is not export-ready. A historical ready run does not certify a later request
revision. Unknown worker/publication timings remain unknown, not invented elapsed
human effort. Closing does not delete or cancel already accepted runs.

Compatibility clarification from measured execution: request creation uses DB
clock defaults, while the existing update/closure producer uses JavaScript clock
samples. Preserve these recorded technical instants; do not require update or
closure to be chronologically after creation across unsynchronized clocks. No
historical facts are recalculated. Lifecycle/nullability, business deadlines and
existing worker publication timing proofs remain enforced. A future monotonic
clock protocol is not introduced by this HTTP increment.

## 6. Commands, races and replay

All public preconditions are checked inside the same transaction and locked
boundary that performs the command, after current authorization. A controller
read followed by an independent write is not sufficient.

- Validate rejects a mismatched expected request revision before changing saved
  validation. It retains one consistent source selection and the accepted digest.
- Warning acknowledgement checks expected revision and the exact saved digest
  under the request lock; a reason cannot waive blocking errors.
- First Prepare checks expected revision and validation digest against the locked
  request, then performs the existing fresh capture/digest comparison and mode
  eligibility checks before allocating a run. Capture retains 500 revisions and
  16 MiB snapshot limits; no truncation or scope retargeting.
- Same-key Prepare replay still requires current authority and the agreed build/
  storage gates. Verify the saved immutable run first, then compare request, actor,
  mode and its frozen request revision/scoped-content digest to the HTTP envelope.
  Matching replay returns the original run even if live sources changed or the
  request is now closed. Divergent revision/digest/mode/request conflicts; never
  allocate a new run for that key.
- Preserve existing command digests, old v1/v2 snapshots and receipts. The extra
  HTTP preconditions are represented by already frozen revision/digest evidence;
  do not rewrite old rows or require live data to reinterpret successful replay.
  Compatible internal callers retain their existing command behavior.
- Retry delegates to the existing durable lifecycle transaction. Expected
  lifecycle version applies to new intent; an identical recorded receipt replays
  after current caller/initiator authorization even if processing has begun.
  Another response is a new Prepare/run, not retry with live scope.
- CRUD retains current semantics: duplicate request number conflicts; unchanged
  current update creates no revision; divergent stale update conflicts. Create
  has no invented operation-key replay. An ambiguous CRUD response is recovered
  by an authorized read, not an automatic repeated mutation.

Acknowledgements identify server correlation ID, target ID, accepted revision or
receipt, and mode/key/digest where applicable. They do not assert the target still
has that live state. Public clients must GET again before further editing; exact
run detail is the authority for asynchronous status.

## 7. Private bounded downloads and audit

Artifact `kind` is only the published enum: `xlsx`, `plan_pdf`,
`validation_report`, `request_report`, `manifest`, `package_zip`. `SHA256SUMS`
remains inside the immutable ZIP; it has no standalone artifact row and no
fabricated download endpoint. Only ready runs' published rows can release bytes.
Metadata lists do not contact storage or promise current object availability.

Authorize and resolve the tenant/run/artifact before storage access. Verify run
evidence and the artifact's publication/checkpoint binding; a candidate intent,
quarantined object or caller-supplied filename/key is not download authority.
Read through the existing scoped private adapter with its operation timeout and
size/type/SHA-256 checks. Retain authoritative package caps (ZIP 64 MiB, workbook
and validation 16 MiB each, Plan 8,000,000 bytes, report 4 MiB, manifest 1 MiB).
Bound buffering; do not send unverified chunks or hold a DB transaction over I/O.

After I/O, reauthorize current membership/profile and recheck the immutable
published identity in a fresh transaction. Commit the exact successful download
audit before returning bytes. If permission was revoked or audit fails, release
no bytes. Record sanitized failure metadata without leaking foreign/private
facts. An audit records authorized release, not proof the browser received or
saved the complete file. A closed request remains downloadable under current
authority, independently of the installed descriptor's availability.

Binary responses use the fixed stored-safe filename and MIME type, checked length,
attachment disposition, no-store and nosniff; no public URL, redirect, credential
or key. Range/partial-download semantics are unsupported and rejected; HEAD does
not invoke GET. No conditional response may bypass authorization or audit.

Preserve core exact atomic business audits. Add server-generated HTTP correlation
to success/replay/conflict/rejection/download metadata without conflating it with
the business request UUID or rewriting historical audit rows. Metadata includes
tenant, actor, target/action/outcome and relevant revision/mode/digest/artifact hash;
routine logs/errors exclude requester contact, raw payloads and SQL/provider data.
An unchanged update retains the existing no-business-change/no-extra-business-audit
semantics; its HTTP response still has server-generated correlation.
Transport/session failures contain no claimed business action before identity is
known. Audit failures cannot be reported as accepted business mutations.

## 8. Error contract and verification gates

Use stable sanitized categories: malformed input/query 400, absent assurance 401,
current capability/profile denial 403, canonical path or tenant target absent 404,
stale revision/digest/key/state or non-ready artifact 409, body limit 413,
unsupported content 415, dependency/build/storage/corrupt persisted evidence 503.
Technical failures never become successful incomplete findings. Availability
responses disclose categories, not paths, credentials or stacks.

The later implementation plan must stage independently testable work with a
separate executor and independent review, preserving the owner's preference:
contracts/projections, authorized reads, transactional public preconditions/audit,
availability/runtime composition, bounded downloads, controllers/OpenAPI and CI.
No implementation starts before written-spec and subsequent plan approval.

Verification requires focused failing tests before implementation, including:

- Strict contract/body/query bounds and canonical route/method denial; no RU
  registration, path alias or browser proxy opening.
- Real disposable US PostgreSQL reads/mutations with exact tenant/audit assertions;
  foreign IDs, generic profile, revoked memberships/roles and actual MFA HTTP.
- Missing/dirty/tampered/mixed descriptor leaves CRUD/reads available and refuses
  Validate/Prepare without writes; absent package storage still permits Validate
  with an owned clean build fixture and refuses package commands.
- Actual row-lock races for expected revision/digest, changed source/Plan/build,
  same-key concurrency/replay after drift/close, divergent payload and retry
  receipt replay. Preserve existing identity/worker/core regressions.
- Ready/incomplete/empty/no-workbook and failed/corrupt states; safe projections
  contain no keys/tokens/raw snapshots or contact in lists/errors.
- Provider-double bounded downloads: wrong size/type/hash, timeout, missing
  object, revoked membership during held I/O, audit rollback, foreign artifact,
  Range/HEAD denial and current permission after request closure.
- Runtime client ownership/shutdown, no worker startup or claim, strict shared
  build matching and exact unconditional serial check-only CI ownership.

Rebuild affected shared packages before API consumers. Run API/shared scoped tests,
typecheck/lint/build, relevant package gates, isolation/compiled-entry checks,
formatting and diff checks; report the full API's infrastructure skips/failures
honestly. Migrate only random fixture-owned databases, never the base/primary DB.

This HTTP increment has no manual/browser, real MinIO/S3, hosted residency,
OS-reboot, backup/restore, remote CI, release or regulatory acceptance. The
existing full-API setup failures are not fixed by endpoint development. Future
EN/ES UI, exact browser journey and US-11 evidence remain separate. Business
readiness stays closed and operational-workflow locks remain unconditional.
