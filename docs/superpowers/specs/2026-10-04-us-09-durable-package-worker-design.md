# US-09 — Durable Internal Package Worker and Private Storage

Status: owner-approved written specification, 2026-10-04. The owner approved this written document after all three conversational sections and subsequently approved the separate implementation plan. Tasks 1–8 have independent implementation acceptance. The three Important final-review findings were addressed and independently re-reviewed on 2026-10-05; the local increment is accepted with the recorded verification limits and earlier broad API limitations retained. US-09 remains In progress.

This supplements the [current US-09 design](2026-10-04-us-09-trace-request-current-design.md) and [package-core design](2026-10-04-us-09-package-core-design.md), following the [accepted local package-core checkpoint](../plans/2026-10-04-us-09-package-core.md). Read it with [development isolation](../../us/development-isolation.md). Current code and tests remain the implementation evidence.

## Intent, decisions and scope

An already-authorized, frozen request run needs crash-safe package generation and publication within the separate US instance. Success means verified private bytes, atomically bound artifact metadata and an audited final outcome; an object upload alone is not success. The original request revision, mode, source snapshot and provenance must survive retries unchanged.

The owner approved three conversational sections:

1. Use the existing US PostgreSQL run record as the durable queue, with an internal worker first and no runtime registration.
2. Allow at most three automatic execution attempts, delayed retry for classified transient failures, audited manual retry of the same run, fresh initiator authorization, attempt-specific keys and fencing against stale execution/cleanup.
3. Persist immutable report context/version/input-hash evidence before PDF rendering, separate actual completion times, require reproducibility, use only local synthetic private storage in this increment, and leave tasks unclaimed when storage is unconfigured.

The rejected alternative was a separate broker: it adds another service and requires reconciliation with the already-durable PostgreSQL intent. No RU pg-boss provider or shared scheduler is imported.

Implement only an internal queue/lifecycle service, bounded worker invocation, US-package storage adapter, immutable rendering checkpoint, publication/cleanup protocol and synthetic verification. An invocation handles at most one run. It is callable by an internal test harness, not an endpoint, startup hook, perpetual polling timer, daemon or CLI exposed to users. Bounded per-attempt lease renewal is permitted and must stop when that invocation ends. A later separately reviewed increment will register the worker and its scheduling/shutdown behavior in the US runtime.

Work remains in the existing `codex/us-mvp` checkout. Preserve inherited dirty work and unconditional release locks. No commit, push, PR, merge, cloud provisioning, release, deployment, shared/base database migration, primary environment use or worktree cleanup is included. No production credential or real personal data is used.

## Current baseline and compatibility

- `UsRequestPrepareStore` atomically creates `queued` runs and audit intent. It does not require package storage, run a worker or publish artifacts. Preserve its existing internal contract; the eventual HTTP preparation boundary must enforce storage availability separately.
- `trace_export_runs` already holds frozen input/digests, status, preparation/generation/render/completion instants and an attempt count. It has no lease, attempt history, retry deadline or render checkpoint yet. `trace_export_artifacts` has tenant/run composite identity and six permitted artifact kinds.
- `renderUsRequestPayloads`, `UsRequestPlanReader`, the report-model builder and `assembleUsRequestPackage` provide the accepted internal byte path. These verify evidence but grant no authorization. Use their actual implementations, not replacement workbook/PDF generators.
- Full packages require frozen v2. Verified v1 retains existing validation/XLSX replay; worker execution fails with the existing refreeze-required outcome rather than silently upgrading a saved run. A new authorized preparation is required for a full v2 package.
- US-08 storage is Plan-specific. Preserve its adapter, namespace, approved objects and cleanup rules. A request worker reads the exact frozen Plan through `UsRequestPlanReader`; it never regenerates, cleans up or repoints that Plan.
- The production immutable build-identity provider remains absent. This increment exercises a strictly internal synthetic execution identity seam; it must not enable operational publication or manufacture production identity from Git, package metadata or an environment flag.

## Responsibilities and durable records

Keep four separately testable responsibilities:

1. Lifecycle persistence: claim, renew, recover expired attempts, schedule retry, accept manual retry, save the write-once rendering checkpoint, publish atomically and record cleanup fences.
2. Worker orchestration: acquire trusted tenant/run authority, invoke the existing byte pipeline, compare checkpoint evidence, perform bounded private I/O and submit only fenced outcomes.
3. Package storage: validate configuration/scope, conditionally create private attempt objects, read and hash bounded bytes, and delete only after a committed cleanup fence.
4. Evidence parsing: strictly validate stored attempt/checkpoint/artifact records and finite failures without exposing private content.

Additive schema changes introduce lease/retry metadata, tenant/run-bound attempt history, one write-once render checkpoint per run and a durable object-intent/cleanup ledger. The implementation plan will map these records to focused schema modules and a new migration. Do not rewrite migration `0139` or backfill invented execution facts.

All relationships use composite tenant keys. Attempts have server-generated IDs, a monotonically increasing lifetime attempt number and a retry-cycle number. The run's existing `attemptCount` remains the lifetime claim count; manual retry never resets or decrements it. Retry-cycle counts are separate. Existing queued runs start with no attempt/checkpoint; no snapshot rewrite is needed.

The lease records its owning attempt/fence token, acquisition and expiry instants. Retry metadata records the next eligible instant and the bounded cycle count. A separate monotonically increasing lifecycle version guards manual retry; it is not the frozen request/run revision. Attempt history preserves actual start/end, outcome and finite failure classification. A rendering checkpoint stores the canonical report model/context, its digest, exact payload descriptors, omissions/render findings, and immutable package/report/execution versions. Its timestamps refer to the attempt that prepared those report data, not a later recovery attempt.

Each planned upload is durably registered before object I/O with tenant, run, attempt, fixed filename/kind, key, expected size/hash and state. This makes partial uploads discoverable after process death. The ledger contains no secret, signed URL or raw requester text. Published artifact rows are distinct from staging intent.

Frozen run identity, actor, command/scoped/input digests, mode, source snapshot, Plan pin and registry stamps cannot be changed by lifecycle commands. Enforce checkpoint write-once and published artifact immutability in persistence, not only TypeScript conventions. No published run/artifact deletion or generic purge path is added.

## Claim, lease and restart behavior

PostgreSQL is the authoritative queue. Eligible work is a due `queued` run or an expired `processing` run; terminal `ready` work is never claimed. Use bounded row selection and transactional locking/conditional updates so simultaneous workers cannot own the same unexpired lease. No transaction spans rendering or storage I/O.

An internal invocation first checks configured storage and its development/test-only execution boundary. If storage is unconfigured, return a finite unavailable result without selecting, claiming, consuming an attempt or changing queued work. Provider failure after claim follows the retry protocol. Database unavailability returns a sanitized infrastructure result; recovery uses durable state, not an in-memory success/failure guess.

Initial technical bounds for the implementation plan are a 120-second lease, renewal at most every 30 seconds while execution is live, and a five-minute attempt deadline. PostgreSQL time decides claim/lease/retry eligibility. Injected deterministic clocks may be used in tests, but production-style code must not trust a requester timestamp. These are safety bounds, not evidence that the maximum package renders within them.

Every renewal, checkpoint save, retry/failure transition and publication verifies the exact current attempt token, unexpired lease and deadline. Renewal cannot revive an expired lease. An overlong or synchronous non-cancellable render may finish computation, but it cannot publish after losing authority. Abort signals and time bounds limit I/O; do not claim JavaScript CPU work is forcibly interrupted by an abort.

A recovery invocation ends the expired attempt as abandoned, then either creates the next eligible attempt or marks retry exhaustion. Claiming consumes one attempt even if the process subsequently dies. No queue message, in-memory map or client retry is required to rediscover committed queued/expired work. Recovery is an explicit bounded internal operation here; no background scheduling is installed.

## Authorization and unchanged source evidence

Before processing, reload the original preparing user's current membership and processor profile through the established US policy, requiring the same `QA_MANAGE` and `EXPORT_READ` capabilities as preparation. Repeat this check in the final publication transaction. Never obtain worker tenant/actor authority from client input, a PDF, a storage key or frozen provenance alone.

Serialize the authorization check with relevant membership/profile changes using the established lock order. A concurrent revocation committed before publication must prevent publication; a stale earlier check is insufficient. The original preparing actor remains distinct from the system execution identity and any actor requesting a manual retry. No session is fabricated for the system worker.

Read business content only from the verified frozen run. Request edits, event amendment/void, current catalog changes, request closure and Plan supersession do not replace previously accepted source evidence. Closure blocks new preparations, not completion of already-accepted work or retention of old packages. Current authorization still applies.

Wrong-tenant IDs, invalid evidence, unsupported profile and lost initiator authority fail closed. An authorization failure is not an incomplete package and is not automatically retried. Retry after restored access rechecks the original initiator; another user cannot take over that identity through a retry command.

## Reproducible rendering checkpoint

On the first attempt that obtains valid payload/Plan inputs, use its recorded execution start as canonical UTC-millisecond `workerStartedAt` and capture `reportDataPreparedAt` after obtaining those inputs. Construct the actual bounded report model and save the complete checkpoint under the active attempt fence before rendering the report PDF. Use the package-core chronology rules. Do not put execution context into `inputSnapshot` or repurpose `reportRenderedAt` as report-data preparation.

Saving a checkpoint is atomic and first-write-wins. A lost or ambiguous commit must be resolved by reading the persisted checkpoint; do not overwrite it with a later clock value. A stale attempt cannot create or replace it. Before checkpoint acceptance, a failed input acquisition may be retried; after acceptance, all checkpoint facts, including an allowed incomplete workbook omission, are fixed.

A later attempt uses the saved context/model and pinned renderer/execution identities. It reconstructs upstream inputs through the real frozen-input renderer and exact Plan reader and compares actual hashes, lengths, descriptors, findings and omissions against the checkpoint. It never silently changes an omitted workbook to a present one, or the reverse. An incompatible execution version, absent pinned Plan, changed bytes or inconsistent model fails execution. Compatibility with a future renderer upgrade requires a separate supported-version decision, not today's renderer relabelled as the old one.

After the first complete package has been verified, save its expected file and ZIP digests/sizes durably before upload. They are write-once extensions bound to the checkpoint. Recovery compares reconstructed package bytes to those expectations; if verified staging bytes remain available, they may be reused only after the same authority, scope and hash checks. Loss of staging storage alone does not authorize different bytes.

The PDF retains the first accepted report-data preparation timing. Actual rendering completions and upload/commit recovery events belong to attempt history. `reportRenderedAt` on a successful run records the actual completion for its published package, while `completedAt` records the database publication boundary. Neither is backfilled into the PDF. A recovered upload can refer to its recorded earlier render completion; it must not invent a new render.

A `ready` run returns its persisted identity/evidence and is never regenerated or overwritten. The package remains exactly the saved response, not a new response with current timestamps. Session/system elapsed measurements are not trained-human effort or legal deadline acceptance.

## Private synthetic storage boundary

Provide a package-specific adapter/configuration loader, without modifying the Plan storage contract or loading RU providers. Configuration is optional and all-or-none. Accept only explicit US edition, development/test mode and the isolated loopback S3 endpoint `http://127.0.0.1:19000` or the equivalent already-allowed loopback host. Reject production mode, remote endpoints and reuse of configured primary S3 credentials/bucket. Validate configuration through an internal authority-bearing loader, not a structurally similar object from a caller.

Tests use isolated synthetic transport or fixture-owned keys in the separate local US store. This spec does not authorize starting/provisioning hosted storage, changing existing credentials, migrating the base US database or treating local residency as hosted non-RF proof. Operational use requires the separate immutable build provider and reviewed non-RF storage, access, retention and recovery configuration.

Keys use only server-owned tenant/run/attempt UUIDs and fixed safe basenames under a dedicated `us/requests/` prefix. Never include requester names, request numbers, contacts or client paths. No ACL/public-read option, presigned URL or general object browser is added. Object-store SDK failures become finite sanitized codes with no URL/key/credential/provider body in ordinary logs or exceptions.

Conditionally create objects without overwriting existing keys. Verify bounded actual bytes by reading back and checking content type, size and SHA-256; ETag and HEAD metadata alone are not byte verification. Apply the existing package limits: 16 MiB each workbook/validation, 8,000,000-byte Plan, 4 MiB report, 1 MiB manifest, 16 KiB sums inside ZIP only, 48 MiB total entries and 64 MiB ZIP. Use bounded streaming and allocation, with 15-second individual storage-operation limits.

Upload only after complete package/hash/ZIP verification. Persist individual available workbook, Plan copy, validation, report, manifest and ZIP objects; the existing six artifact kinds suffice. `SHA256SUMS` remains inside ZIP only. An absent optional payload has no fabricated object/artifact row. The package's Plan copy is not the original US-08 Plan object and never acquires authority to delete it.

## Atomic publication and cleanup fencing

After verified upload, take the established tenant/authorization locks and the run publication lock, recheck current initiator authority, the active attempt/lease, immutable evidence/checkpoint and durable verified-upload evidence for every expected object. Perform object read-back outside the transaction; no storage I/O is moved under the database locks. Honor all permanent never-publish fences. Commit the exact artifact set, run `ready`, `exportReady` derived strictly from its frozen mode, successful attempt timing and publication audit together. Incomplete mode remains incomplete even if it includes all optional files. Do not close or fulfil the request.

There is no successful partial artifact publication. An audit failure rolls back publication. Duplicate completion returns the same committed result only after validating its full identity/artifact bindings; it never inserts another artifact set or success audit.

On unknown commit outcome, reread tenant-scoped run/artifact/attempt references from PostgreSQL. A database connection error is not proof of rollback. If verification is still unavailable, retain objects and pending intent. Recovery distinguishes an already-published winner from retryable staging rather than marking a committed ready run failed.

Cleanup is an internal bounded repair operation over durable intents, not bucket listing or generic retention deletion. Under the same publication lock, check references and ownership, revoke publication eligibility for the abandoned candidate and commit a permanent key fence before DELETE outside the transaction. An attempt still eligible to publish cannot have its candidate objects fenced by cleanup. All publishers honor the fence, including after restart.

Never delete a referenced winning object, another attempt's live candidate, a foreign tenant key or an original Plan object. An uncertain upload whose ownership cannot be proved remains unresolved; do not guess ownership from an exception or delete a colliding pre-existing object. Retry failed deletions from the durable cleanup ledger and audit their finite outcomes. Do not remove the fence after deletion. Failure to clean staging does not turn a successful published package into `failed`.

## Failure and retry policy

Three automatic attempts means one initial execution plus at most two retries per cycle. Lifetime attempts continue increasing across manual cycles. Delay the second claim by 10 seconds and the third by 60 seconds from the recorded recoverable outcome; enforce those deadlines in PostgreSQL. Lease expiry counts as an abandoned attempt, not a free unlimited retry.

Only positively classified transient infrastructure failures, such as bounded storage transport failures/timeouts or retryable database failures, qualify. A failure to record their outcome leaves the lease for recovery rather than assuming the outcome was persisted. Unknown failures fail closed without an automatic retry; do not classify arbitrary exceptions as transient.

Corrupt/unsupported frozen evidence, wrong tenant, revoked authorization, incompatible renderer/build identity, checksum/model/package mismatch, violated size bounds and malformed storage configuration are non-retryable automatically. Preserve existing finite upstream evidence/refreeze/Plan/payload failure codes; do not convert them into successful incompleteness. An originally absent Plan and accepted typed workbook omissions retain the package-core semantics.

After exhaustion, set `failed` with a finite code and completion time, preserving the frozen snapshot, checkpoint and attempt history. Manual retry requires current caller QA/export authority, original initiator authority, expected lifecycle version, a reason and an idempotency key. Its atomic audit/receipt records caller, original initiator and run; it starts a new bounded cycle of the same run without clearing the checkpoint. Concurrent duplicate retry commands cannot create multiple cycles. A changed payload with the same command key conflicts. A ready run cannot be manually requeued.

Retries may recover a transient problem or restored access; they cannot repair a corrupt snapshot or bypass a pinned-version mismatch. Corrected business data requires a newly validated/prepared run revision. Neither automated nor manual retries extend the request deadline or assert response delivery.

## Audit, privacy and verification

Record claims/recovery, meaningful lifecycle transitions, accepted manual retry, publication and cleanup outcomes with exact tenant, system/caller identity, original initiator, request/run IDs, revision/mode, attempt/cycle, named digests, finite failure and relevant artifact hashes. Successful lifecycle changes and their audits are atomic. Routine lease renewals need not create an unbounded audit stream; their durable ownership/expiry remains verifiable. Do not log requester/contact content, frozen JSON, PDF bytes, credentials or object keys. Private ledger data remains in the separate US persistence boundary.

The implementation plan must specify independent implementers/reviews and focused failing tests before code. Required evidence includes:

- Fresh/upgrade migrations, composite tenant denial, lifecycle/checkpoint/artifact constraints, immutable saved fields and old queued/v1 compatibility without snapshot rewrites.
- Real concurrent claims/renewals/expiry, exactly three claims per cycle, due-time backoff, process restart at each durable boundary and bounded explicit recovery.
- No-storage invocations without any claim/attempt/artifact/audit side effects; malformed/production/RU storage rejection before I/O.
- Initiator revocation before claim and after render/before publication, serialized concurrent revocation, wrong tenant/profile, restored-access manual retry and exact retry idempotency/audit.
- Real accepted US-07/US-08/package-core ready and incomplete flows, immutable checkpoint before PDF render, retry context equality, changed payload/omission/version rejection and no current-source/Plan substitution.
- Partial/uncertain conditional upload, actual read-back/hash verification, publication/audit rollback, unknown successful/failed COMMIT and repeated completion with no duplicate rows/audits.
- Stale completion/renewal/checkpoint rejection; cleanup-vs-publication races, stale cleanup, winner retention, restartable deletion and unresolved-upload ownership safety.
- Exact actor/tenant/action/target/result/metadata audit assertions, not row-count-only checks; sanitized failures and no private output.
- Package/schema/API focused and package-wide gates as applicable, affected dependency builds, formatting/diff/isolation checks and check-only CI selection. Run PostgreSQL tests only in fixture-owned disposable US child databases; report skipped and broad setup failures separately.

The requirements above do not establish acceptance; the local checkpoint below records implementation evidence separately. Local fake transport is not a live S3 contract, a PostgreSQL fixture is not hosted recovery, and deterministic package bytes are not browser workflow, Excel interoperability, physical/human-time or regulatory acceptance. Any live local-store test is labelled separately from mocked transport. Production storage/build identity, runtime/scheduling/shutdown, HTTP/OpenAPI, EN/ES cabinet/downloads, hosted backup/restore, remote CI, provisioning and release enablement remain outside this increment.

## Local implementation evidence — 2026-10-05

The [implementer checkpoint](../plans/2026-10-04-us-09-durable-package-worker.md#local-implementer-checkpoint--2026-10-05) records the internal worker/storage/publication/cleanup implementation and independent acceptance of Tasks 1–7. Task 8 adds exact check-only CI ownership with unchanged operational locks and runs the final local gates. Its independent review and final whole-increment review are pending; this specification does not declare whole-increment acceptance.

Selected API 38 files / 809 tests and DB six files / 112 tests passed with zero skips, with selected domain/contracts and typecheck/lint/build/format/diff/isolation gates passing. The full DB invocation passed 780 tests and skipped 141 existing opt-ins. The sole full API invocation passed 3,716 tests, skipped 1,411 and had zero failed assertions, but eight primary-environment setup files failed; exact nine failed-suite groups and twelve loader/teardown diagnostics are documented in the checkpoint. Overlapping selected/full runs are not summed. No primary environment, base migration, runtime registration or release operation was used. Synthetic transport and deterministic-clock/new-instance recovery retain the external limits above; no reused PDF screenshot verifies this worker. US-09 remains In progress.

## Final-review fix evidence — 2026-10-05

The preceding 809-test selected and full DB/API results describe the pre-fix source. Task 8 was subsequently accepted, while final review required three Important corrections. The combined fix now terminalizes one structurally trusted corrupt queued row with exact audit and unchanged frozen facts/counters, without inventing an execution attempt; rejects lease-owned writes after final fresh DB-time checks following all mutations/audit; and prevents renewal from reviving authority after the old persisted expiry/deadline. Unsafe identity/reference ambiguity still fails closed, and healthy original-actor authorization, valid-v1 refreeze and unknown-COMMIT reconciliation remain unchanged. No schema, guard, runtime, storage-adapter or public-interface change was needed.

Twenty-four added regressions include actual compatible-read/conflicting-write PostgreSQL SHARE barriers and the approved deterministic clock seam. Twenty-two primary cases first failed against original source, then passed. Post-fix affected checks pass six files / 146 tests; post-fix request/export/Plan checks pass 38 files / 833 tests, both zero skips. API typecheck/lint/build, full formatting, diff and 19 isolation contracts pass. These overlapping invocations are not summed. The earlier full DB 780/141 and non-green full API 3,716/1,411 with eight setup-failed files precede the three source-module and one test-file changes and were not rerun; no primary settings were loaded. The existing Vite advisory and all synthetic/local-versus-external limits above remain. Independent scoped re-review is pending; neither these checks nor the earlier task approvals establish whole-increment or operational acceptance. See the [final-review fix checkpoint](../plans/2026-10-04-us-09-durable-package-worker.md#final-review-fix-checkpoint--2026-10-05).

## Review handoff

Controller completion record, 2026-10-05: independent scoped re-review confirmed all three findings addressed, with no new Critical/Important breakage, and accepted the local increment. This supersedes the pending-review status in the historical checkpoints above. It does not establish a green full API gate, remote CI, runtime, hosted-storage/recovery, merge or release readiness. No source or test changed during this completion recording.

The owner has approved this written design. Its approval authorizes a written implementation plan only; that plan requires a separate owner review before code. Preserve the agreed separate implementer and independent-review method when presenting the plan. No Git or external operation is implied by either approval.
