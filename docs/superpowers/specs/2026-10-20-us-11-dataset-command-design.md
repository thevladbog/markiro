# US-11: guarded six-month dataset command

Status: implementation design under the owner's standing instruction to continue
without repeated approval questions. The preceding Request-package gate was
reconciled by accepted successor `d712098f247cdde5a91b5dbcbe3915ed67e18847`
(all ten US jobs and Cases passed). Task 2's amended 15-case exact-source native
CI and Task 3's actual compiled acceptance remain separate open gates. This is
not a new release authorization.

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
the fixed recipe, unit/stage diagnostics; exit nonzero and emit no success.
Measurements (elapsed time, peak process RSS, database/artifact bytes) are honest
observations reported separately, never part of stable replay digests. No
unmeasured free-tier or two-minute claim.

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
