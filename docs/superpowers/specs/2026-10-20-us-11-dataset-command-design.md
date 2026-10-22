# US-11: guarded six-month dataset command

Status: historical CLI implementation design with a bounded failure-evidence
amendment. The preceding Request-package gate was reconciled by accepted
successor `d712098f247cdde5a91b5dbcbe3915ed67e18847`; native and actual compiled
CLI acceptance subsequently passed on `e5a00d71bf51aedd711269ca1a289749a8d172d8`.
That evidence remains source-specific. Current `567e13af1` compiled initialize
failed at Request September/package/private manifest read; its specific cause is
unknown. The amendment below is evidence-only, not a fix or new acceptance.
All current exact-source and viewer gates remain required; no release authority.

## Intent and scope

Connect the accepted six-month Trace/Readiness owner and the accepted owned
Plan/Request artifact owner to an explicit local command. A single invocation
must initialize or verify the prescribed recipe, never a caller-selected subset.
It must retain the existing journals, native authorization, exact-run worker,
private-byte verification and supported recovery behavior.

This implements the command portion of the approved
[single-tenant design](2026-10-06-us-11-single-tenant-demo-seed-design.md) and
[six-month design](2026-10-06-us-11-six-month-demo-design.md). Viewer provisioning,
browser acceptance, screenshots/video, hosting, release enablement and public
access remain separate. Do not start the shared base dataset during development.

## Existing owners and invariants

- `UsDatasetTraceReadinessSeedStore(db)` initializes/verifies all regular indices
  0..259, then correction and orphan, through actual native and Trace owners.
- `UsDatasetArtifactSeedStore(db, services)` initializes/verifies the owned Plan
  and `request_scenario_a`, `request_april`, `request_september` in recipe order.
  Each Request verifies its actual 1/12/12-chain closure and private publication.
- Both owners independently authorize the actual reserved tenant/original owner,
  database identity and processor profile. The command is not an HTTP session or
  a new source of authorization. Constructor dependencies are concrete stores
  and checked execution identity, not injected success callbacks or proofs.
- Keep recipe `us-processor-six-month-v1` and its current compiled digest.
  Preserve all 260+2 units, 964 roots, 963 current finalized events, 785 lots and
  15,700 boxes; no recipe/version rewrite, source exclusion or reduced sampling.
- All historical V1 facts and new Transformation V2 behavior remain unchanged.
  Request selection remains bounded by 500 revisions and 16 MiB per snapshot.
  Per-stage JSON remains bounded at 256 KiB. No timer or phase-budget increase.

## Command contract

Add a separate `main.us-dataset.ts` executable. It accepts a mode followed by
explicit named pairs (pairs may be reordered, not duplicated):

```text
initialize --confirm-local-synthetic-dataset
  --database-name markiro_us_dev --database-user markiro_us
  --tenant-id <lowercase UUID> --owner-id <lowercase UUID>
  --version us-processor-six-month-v1 --definition-digest <compiled SHA-256>

verify
  --database-name markiro_us_dev --database-user markiro_us
  --tenant-id <lowercase UUID> --owner-id <lowercase UUID>
  --version us-processor-six-month-v1 --definition-digest <compiled SHA-256>
```

There are no positional fallbacks, implicit tenant lookup, digest defaults,
`--reset`, arbitrary DB URL arguments, range selectors, force flags or repair
options. Missing, duplicate, unknown, extra, malformed or mismatched arguments
are refused. Confirmation is required exactly once for initialize and is not
accepted by verify. Whitespace is not normalized into a valid identifier.

Before opening a connection, use `loadUsDevelopmentEnv`, require URL username
`markiro_us`, and validate both separate private Plan and Request storage configs.
Missing storage is an explicit refusal in both modes, not partial success.
Use the existing clean checked build-descriptor loader and runtime execution
identity before business work; no synthetic test identity in the executable.
No environment-selected source roots, descriptor path or credential overrides.
Use Node 24+ and the existing Corepack/pnpm version and dependency graph.

After connecting, compare `current_database()` and `current_user` to the fixed
expected values and check required current schema columns with read-only queries.
Then independently verify reserved original-owner provenance and current
`US_FSMA204_PROCESSOR` / `America/Los_Angeles` profile before the first seed
write. An absent/incompatible owner or profile is a prerequisite failure, never
permission to create/reset/elevate an identity or select a profile.

Do not run migrations, create buckets, change policies, provision users, start
HTTP/Auth, start the general worker loop, import test fixtures or load `.env`
inside the executable. The operator supplies the explicitly isolated environment.
Provider availability may still fail during a later real operation; preflight
configuration validity is not a claim that storage is reachable.

## Complete orchestration

Add `UsDatasetCompleteSeedStore(db, services)` with `initialize(context)` and
`verify(context)`. It constructs the two actual owners above, invokes the
Trace/Readiness owner first and the artifact owner second in the same mode, and
checks their exact dataset/version/digest identity and prescribed ordered units.
Only values produced by those owners inside this invocation may be assembled.
No public `completeFromProof`, caller result, skip flag, hydration or proof cache.

Return an owned deeply frozen bounded result with state
`six_month_seed_stages_verified`, `datasetComplete: false`, exact shared identity,
the verified Trace/native result and the verified artifact result. The false flag
is deliberately retained in this increment: successful sequential seed stages
are not full same-installation viewer/browser acceptance or a globally atomic
current-state snapshot. Earlier stages are checked when reached, not protected
against every later unrelated cabinet write. Do not advertise stronger semantics.

This is the controller's conservative reporting choice, not a new business rule.
The final demo acceptance may define its separate evidence result later; it must
not weaken or reinterpret these constituent proofs. Completion receipts are not
a new prerequisite or permission: no schema change or synthetic final audit row
is needed merely to print success.

`verify` never initializes prerequisites. A fully populated initialize reuses
the existing owners' verification-only paths and makes zero DB/provider writes.
Incomplete initialize resumes original saved intents and Request clocks. Stop at
the first original failure; never skip a unit, loop blindly, claim success for a
queued/retrying run or invoke the general queue to finish an unrelated Request.
Existing stage error/cause metadata remains intact inside the service boundary.

## Resources, output and interruption

Runtime owns its DB pool and both concrete private artifact clients. Await every
operation and dispose resources after settlement on normal success/refusal.
Never close resources underneath unawaited work. Do not implement a scheduler or
a new cancellation/retry protocol. OS interruption is non-success and can leave
valid partial state; a later explicit invocation follows the existing journals
and native lease/publication recovery. It never resets the target.

Emit one bounded JSON success summary only after actual orchestration returns:
synthetic marker, state/false completion flag, dataset/version/digest, canonical
Plan/Request/run IDs and content hashes. No private keys, raw evidence, payloads,
provider messages, SQL, stack traces, URLs, credentials or authentication data.
On failure emit a fixed allowlisted category and, only when validated against
the fixed recipe, unit/stage diagnostics; the reduced Task7 amendment below
permits one strictly finite optional operation tuple at the executable boundary.
Exit nonzero and emit no success.
Measurements (elapsed time, peak process RSS, database/artifact bytes) are honest
observations reported separately, never part of stable replay digests. No
unmeasured free-tier or two-minute claim.

### Finite Request failure propagation amendment (2026-10-21)

The exact `55152433183a797a6f6e65ab98983758eee08971` positive invocation passed
image provenance and provider capability checks, then initialize exited nonzero.
Its underlying cause remains unknown. Conditional interpretation of aggregated
provider counts is not historical stage-completion proof. No timeout, renderer,
checkpoint or performance fix is authorized by that observation.

A separate deterministic, database-free regression is established: actual pure
checkpoint model/byte drift throws `us_request_worker_checkpoint_mismatch`, and
actual descriptor inequality throws `us_dataset_request_conflict`; the existing
command projection loses both finite codes and Request location. A Request's
finite `us_dataset_request_incomplete` likewise becomes generic. Correct this
trusted service/runtime propagation, not the successful seed or its checks.

Only those three additional literal codes may survive command projection.
Existing command-category precedence and unknown fallback remain. Read only own
data `message` or own data `response.code`; do not invoke `getResponse`, getters,
inherited values or serialize the raw response/error/cause. Keep this runtime
projector's output fields exactly `code` and optional canonical `unitKey`/`stage`,
with the existing bounded cause traversal and recipe validation. This runtime
projection does not allow arbitrary worker,
database or provider codes, new fields, raw messages, URLs, stacks or evidence.

After its existing unit validation, the Request service may best-effort attach
the trusted Request unit and `request` or `package` location to the same original
extensible Error. Preserve its class, identity and cause, frozen/opaque errors,
and any valid lower-level canonical location, including an own-data cause.
Do not clobber unsafe existing location descriptors or execute accessors. Before
a trusted unit exists, do not invent a location. Request/package location is a
failure boundary, not proof of completion or measured internal-stage duration.

Keep every query, action, worker result/reconciliation, replay, clock, byte/hash
assertion, deadline, output limit and resource-disposal order unchanged. No
successful owner/proof injection, new retry, provider/fixture diagnostic loop or
fixture-only substitute for the production correction. The original runtime
implementer owns this follow-up; its production/API gates and independent review
are separate from tooling proof. Root owns the single final ordinary API run,
user-identity commit/push and exact-source CI. Actual whole initialize/verify and
all other acceptance gates remain required; viewer acceptance remains afterward.

### Reduced outer-operation diagnostic amendment (2026-10-21, Task7)

Root approved the independent review's reduced nine-path design, not the broad
leaf/classifier or failure-only DB census/replay proposals. Actual exact338 CLI
initialize failed with generic root code at `request_september/package`; its
cause remains unknown. Native prepared September and full-sequence15/15 test
execution passed with normal owned disposal, but the complete job was CANCELLED
at45minutes, not green. These observations authorize no success, timeout,
provider, renderer or performance claim and no automatic CI retry.

The original `usDatasetCommandDiagnostic` and its12 categories, precedence,
own-data/cause rules, output and self-contained three-declaration extractor
remain byte-identical. Only the real executable may append:

```text
verificationFailure: { operation: <closed literal>, artifact?: <closed filename> }
```

Emit this tuple only for existing root `us_dataset_command_failed` and matching
canonical `request_scenario_a`, `request_april` or `request_september` / `package`
location from that invocation. Recognized root categories retain their exact
prior output. No origin, native failure taxonomy, exception/cause inspection or
wrapper transfer is allowed. The tag means the **last entered operation boundary**,
not the throwing instruction, cause, completion, chronology or successful read.
Residual ambiguity within read_plan/bind_inputs/assemble_package is accepted.

The exact19 operations are:

```text
package_stage, validate_request, prepare_package,
probe_before_worker, run_worker, probe_after_worker,
render_payloads, read_plan, bind_inputs, check_checkpoint, assemble_package,
compare_manifest, compare_entries, compare_archive,
read_private_object, compare_private_object, verify_private_archive,
final_publication_probe, commit_package_receipt
```

`read_private_object` and `compare_private_object` require exactly one artifact
from `manifest.json`, `package.zip`, `plan.pdf`, `records.xlsx`,
`request-report.pdf`, `validation.json`, using the existing validated published
name, never an object key/path. `verify_private_archive` requires `package.zip`.
Every other operation forbids artifact. No other tuple keys/values are accepted.

#### Private frame and consumption algorithm

1. After existing Request unit validation, create one private opaque frame with
   only finite Request-unit/lifecycle/operation state, no dataset/body/error values
   or authority. Every helper first looks up frame identity in a private registry
   before reading any frame state; forged, proxy or accessor-bearing handles do
   not cause property/prototype/getter/trap access. Helpers are best effort and
   cannot throw into business work.
2. Activate the frame only at the existing package location transition. Enter
   `package_stage` before the existing first package-stage read. Before each
   existing outer operation, enter its fixed literal, clearing the prior operation
   and artifact first. An invalid transition/combination leaves no usable tag,
   never a stale phase/artifact. Inactive/closed/unknown frames cannot transition.
3. Pass that same frame explicitly as the sole new diagnostic-only argument at
   the one production verifyRequestBytes call. Verification updates only this
   frame before existing calls/checks; it adds no catch/wrapper/promise/await,
   business call, success/proof callback, ambient operation or resource. After
   verification, RequestSeed explicitly enters final_publication_probe or
   commit_package_receipt, clearing any previous artifact.
4. Close/abandon the frame before every existing successful return. Closure
   clears finite state and removes its live registry entry; a successful frame
   cannot later finalize an error. Do not add finally/return changes or I/O.
5. Only the existing RequestSeed catch may finalize. It first verifies the live
   frame identity, then closes it exactly once. If package-active with a valid
   operation, copy its finite state and validated Request/package location into
   a private error-keyed WeakMap. An inactive/invalid finalized frame has no usable
   snapshot but still leaves its private originating identity as an ineligible
   pending record, so it cannot inherit another invocation's tag. Error access is limited
   to key identity/type eligibility, never error properties, prototype, cause,
   native brand, message or response. Preserve the existing annotation/rethrow
   exactly; no error mutation beyond that already-approved annotation.
6. A pending record retains private originating-frame identity and an immutable
   finite snapshot when eligible, or no snapshot when ineligible. Repeated
   finalization by the same now-closed frame is ignored.
   If a second distinct frame finalizes the same error before consumption, replace
   the pending record with an ambiguous sentinel, even if either frame was
   inactive/invalid; further finalizations keep it
   ambiguous. Do not overwrite it with the newest tag. This handles concurrent
   invocations and reused errors without manufacturing provenance.
7. Main obtains the original sanitizer result first, then takes the private
   record by error identity. **Every take deletes it before any eligibility,
   category/location matching or projection check**, including ambiguous,
   malformed, non-generic or mismatched records. Only a single unambiguous valid
   snapshot matching generic root and the same canonical Request/package pair
   may produce a fresh closed tuple. Repeated takes return nothing; reuse after
   consumption needs a newly registered frame. Unsafe/unavailable detail is
   omitted, not fabricated; original errors/disposal cannot be masked.

No public error fields are trusted as frame/evidence. No classifier, cause walk,
wrapper instrumentation, AsyncLocalStorage, timer, process, DB/provider query,
replay, private-byte reread or additional output channel is introduced.

#### Fixture, scope and acceptance

The owned fixture accepts exactly its current canonical root-key forms or those
forms plus verificationFailure. An extension requires parsed code exactly
`us_dataset_command_failed` (not an unknown code sanitized to generic) and canonical
Request/package, exact own tuple keys/literals/artifact combinations and one
canonical JSON line <=4096. Use the original sanitizer and new pure tuple
projector loaded from the **same checked compiled build** at the actual fixture
call site; reconstruct output, never forward parsed/raw objects. Both functions
must be available; a missing projector or malformed extension is unavailable,
not partial acceptance. Preserve duplicate/noncanonical/extra-field rejection,
overflow→unavailable with no parser call, bounded child output, nonzero failure,
GNU-time/observer evidence, original decisions/caps and exact normal cleanup.

Task7's exact manifest is the four API paths, three fixture/test paths and two
documents listed in the plan. Exclude runtime/Request-contract annotation,
payload/Plan/bind/composer/PDF/worker/storage/domain/XLSX modules, workflows,
dependencies and personal environment. Stop for root on any concrete extra-path
need. Preserve both refusal test files and their117 count unchanged; add the new
pure test separately, not as a replacement or successful owner/proof fixture.

The doc-only amendment/brief was frozen and root-read before source execution
was released. Source work requires genuine service-free forward RED, exact frame/
tuple/fixture tests and original-statement/order preservation proof, unchanged117,
tooling/API statics/build/fullformat/isolation/diff and independent source review.
No automatic local broad API/native/provider/service run. Root owns any separately
justified integration and one authorized exact-source CI with every original
native/full Trace/Cases/compiled initialize/verify/byte/hash/no-write/provider/
ownership/disposal gate and unchanged caps. Prior15/15 execution is not a green
cancelled job. Source diagnosis is not a fix or CLI/viewer acceptance. After a
real result, stop for targeted investigation/ruling, not automatic diagnostic
expansion or repeated CI.

## Verification and sequencing

First implement and independently review the pure strict command/configuration
boundary. It performs no DB/provider I/O and can be completed while the preceding
exact-SHA CI runs; do not commit/push to supersede that source's acceptance.
Then implement/review complete orchestration, followed by executable/resource
composition and actual same-installation acceptance. Keep each task independently
reviewable and use the owner's selected implementer plus independent reviewer.

Pure tests must prove exact recipe pinning, both modes, pair reordering, all
malformed/duplicate/unknown inputs, unsafe editions/remote targets, missing or
invalid private storage and private-safe errors. Native acceptance must preserve
all original full-volume Trace tests and add actual complete command/owner
execution, interrupted-middle resume, zero-write completed initialize/verify,
current-authority denial and missing/corrupt private-byte refusal. Mocked dispatch
tests alone are not native completion proof.

Keep expensive full-volume runs distinct from focused iteration. Use existing
bounded awaited test phases and preserve assertion timers, phase budgets and all
selectors; no added cold-command SLA inferred from a five-second assertion
timer. Assign check-only CI ownership before accepting a new native suite.
Record actual zero-skip execution and exact owned DB disposal. Broader API,
source CI, browser, live provider and hosting evidence remain separate.

## Task8: optional factory-owned private-read evidence — 2026-10-22

An actual generic Request/package failure may additionally emit the optional
primitive `verificationStorageCode`, but only after consuming the existing
same-error invocation frame with strict `read_private_object` and a valid fixed
artifact. Root code/location/frame semantics and success JSON remain unchanged.
No frame, different error, mismatched/non-generic location, other operation or
invalid artifact means no scalar. A reused error cannot reuse consumed evidence.

Only seven existing fixed codes are admissible:

- `us_request_package_storage_scope_invalid`
- `us_request_package_storage_evidence_invalid`
- `us_request_package_storage_timeout`
- `us_request_package_storage_checksum_mismatch`
- `us_request_package_storage_transport_failed`
- `us_request_package_storage_read_failed`
- `us_request_worker_unknown_failure`

The storage module privately associates these codes with errors at its existing
factory using WeakMap identity, consumed once by
`takeUsRequestPackageStorageReadFailure`. It does not inspect alleged error/cause
properties, prototypes or messages, mutate the error, or confer authority from
matching public strings. Its separate
`projectUsRequestPackageStorageReadFailureCode` validates only exact primitive
strings and grants no provenance. Original storage I/O/errors/class/message/
prototype, timers, SDK settings and ordering are retained.

The positive fixture accepts the optional field only with the strict canonical
generic Request/package/private-read tuple and the actual compiled primitive
validator. That validator is loaded after the existing invoked-set declaration,
outside both original byte-pinned segments, without constructing a client/store.
The new argument is optional for legacy callers; old envelopes retain the same
results. Extra keys, aliases, missing validator, invalid combinations, unknown
codes, malformed/oversized/split-overflow output fail unavailable. The scalar
remains visible in the real Node reporter without changing child exit decisions,
measurement, ownership, provider observation, setup or disposal.

This is not an arbitrary exception classifier or root-category expansion. No raw
message, stack, cause, key, URL, header, credential, byte content or timing is
disclosed. Evidence-invalid/read-failed may still have multiple causes; a later
pass does not identify the historical failure. No automatic diagnostic expansion,
replay, blind CI retry, increased cap or product fix is authorized. Independent
source review and eventual exact-source CLI/native/viewer gates remain separate.
