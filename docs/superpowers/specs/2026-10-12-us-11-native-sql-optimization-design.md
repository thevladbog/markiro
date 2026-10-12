# US-11 native SQL-read optimization

## Intent and acceptance

Optimize repeated SQL reads in the existing native six-month demo execution, then
pass the existing complete 260-chain coordinator test. The user explicitly approved
implementation without further routine prompts. This approval does not authorize
commit, push, PR, deployment or mutation of shared business databases.

Keep all existing assertions and the 900,000 ms full-phase deadline. Success means
actual late-special failure, explicit resume, independent full counts, unchanged
regular facts, successful no-write verify/replay and drift rejection, not just
completion of initial generation. Dataset completion remains false.

## Evidence and selected approach

The previous full phase exceeded its deadline after 140 complete regular Shipping
receipts. Isolated chain0 diagnostics recorded 7021 initialization SQL calls and
3134 verification calls. Current source shows repeated nested reference proof:
ordinary per-row getters reload membership, tenant profile and organization profile
for every party/location/product/profile. These functions also issue individual
business-row reads. Repeated prerequisite traversal multiplies these costs.

Select bounded native batch getters and retain every canonical comparison. They
reload authorization once per batch invocation, read only requested tenant-owned
rows, and use the same response projections as ordinary getters. This removes
redundant collection queries without memoizing authorization or proof results.

Rejected alternatives: cross-transaction caches risk stale authority/business
facts; transaction-local proof caches require additional invalidation rules for
own writes; parallel chains change lock/error/partial-commit behavior. None is
part of this first optimization. If batching alone is insufficient, measure again
and design the next attributable optimization before editing additional code.

## Native batch contracts

Add `getPartiesInTransaction`, `getLocationsInTransaction`,
`getProductsInTransaction`, and `getProfilesInTransaction` to their existing native
stores. Parameters: existing transaction, tenantId, actorUserId, and unknown ID
collection. Return the existing response types in requested ID order.

Validate IDs using existing UUID/input-error schemas, cap each collection at 256,
allow empty and repeated IDs, and do not mutate caller input. Empty batches still
authorize. Missing or foreign IDs use the corresponding existing not-found error;
report the first missing requested ID, without exposing foreign facts. Duplicate
IDs preserve requested order/results. This is an internal store API, not a route.

Every invocation reloads current authorization through `authorizeUsMasterData`.
No shared or transaction-local cache. Ordinary getters keep their response/error
semantics and protected boundaries. Reuse established row projections and response
mappers; avoid a demo-specific SQL copy of business projection rules.

Profile batches must check existence and share-lock requested products in sorted
ID order before reading profiles. Missing stored profiles use existing defaults,
and invalid stored profiles fail through existing validation. Do not change the
write/update lock behavior of current profile commands.

## Reference proof integration

`verifyUsDatasetReferences` retains receipt/input/digest/record-ID/schema checks,
fixed share-lock order (parties, locations, products), and every expected-versus-
saved-versus-current row comparison. Replace only its ordinary per-row reads with
four actual native batches. No verifier traversal or target guard is removed.
Get fresh rows on every invocation, including after writes inside the same
transaction. Do not skip independent reference proof in downstream stages.

## Verification

Before production edits, add an actual-driver reference-proof SQL-count regression:
direct `verifyUsDatasetReferences` in a native owned transaction must use no more
than 32 SQL calls. Observe its assertion RED on the existing implementation. The
budget includes transaction-control calls if instrumentation encompasses them;
do not hide expensive queries by changing the counter or measured boundary.

Native regressions cover output parity with ordinary getters; unordered, duplicate,
empty, malformed, oversized, missing and foreign ID input; current role/profile
denial; fresh rows after same-transaction edits; and unchanged exact table hashes.
Adapt the existing reference share-lock pause witness to the real batch getter,
retaining actual lock-timeout and concurrent-drift assertions.

Record comparable actual query counts and elapsed stage times after optimization.
Query counters are test-only, forward real results/errors and print no SQL values,
payloads, URLs or credentials. Structural budgets are not cloud cost estimates.

Run actual reference regressions and all relevant native regular/special/coordinator
regressions serially, then the untouched full coordinator file. Retain real SQL
fault, repair-denial and lifecycle witnesses. Run API package/static checks once
after native work drains; disclose intentional DB skips and missing-env failures.

## Isolation and lifetime

Use only `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, `codex/us-mvp`.
Preserve inherited edits, original doc prefixes, HEAD and index. New plan owns
only its `.superpowers/sdd/2026-10-12-us-11-native-sql-optimization` workspace.
Do not read sibling SDD artifacts; canonical docs/source and current-run evidence
are the inputs.

Native base: verified loopback `127.0.0.1:55432`, database `markiro_us_dev`, role
`markiro_us`. Only randomized fixture-owned children may be migrated, provisioned,
mutated and dropped. No `.env` read. Native commands unset DATABASE_URL; pure/static
commands unset both DB variables. Derive fixture configuration in memory from the
tracked workflow without printing it. Drain all owned work before closing/dropping;
timeout is not cancellation. Do not force-drop live or ambiguously owned databases.

No schema changes except Task10's exact audit indexes; no recipe/receipt/dependency/CI/runtime/UI changes. Browser, hosted deployment,
artifacts, hardware and complete-demo acceptance are separate unperformed gates.

## Measured second-stage amendment

Reference batching passed its bounded witness: 333 to 22 SQL calls, unchanged
table hashes. Native ordinary/reference regressions passed. A current chain0
measurement remains 3947 initialize queries / 3383.784ms and 1615 verify queries /
1523.081ms. This is insufficient evidence to launch the complete 900,000ms phase:
it includes initial generation and four full regular verification/replay passes.
The serial adjacent suite also exposed deadline failures; those remain failures
until their exact affected cases pass, not evidence to enlarge deadlines.

Add a second independently reviewed optimization stage before full acceptance.
Two redundant read classes are directly visible in current source:

1. The original-owner guard first locks five identity/provenance tables, then
   verifyTrustedSeed reads those same facts again. Add a native locked owner-proof
   method which reads complete rows once in the same table order and reuses every
   existing owner/provisioning predicate. The current actor must equal that owner's
   ID. Existing unlocked verifyTrustedSeed behavior/return shape stays compatible.
   No caller-provided rows, credential values in output or proof cache. Profile
   authorization and final timezone checks remain unchanged. Driver errors still
   propagate and semantic denial still uses the caller's existing namespace.
2. Contiguous dependency reads repeat the same journal target/header verification
   before every row. Add a guarded readStagesInTransaction batch: same transaction,
   one dataset, requested ordered unit/stage pairs, maximum 256, fresh current
   target/header proof on every invocation, existing unit/row validation and a
   nullable result per requested pair. Duplicate/empty requests are supported;
   empty still validates target/header. Do not retain results across calls.

Only replace contiguous reads with no intervening query/write/lock/raw-input
validation. Preserve preliminary target checks before caller evidence and preserve
all business/operation lock ordering, per-stage proofs and error assertions.
Regular and corrected cases/shipping/transformation dependency groups may use the
batch. Both original single-row reads and new batches must deny changed authority
and observe same-transaction writes on every call.

Structural native witnesses: original-owner proof including transaction control
at most 11 SQL calls (old duplicate-read path must fail); three journal dependencies
including transaction control at most 16 SQL calls after both optimizations. Count
at identical boundaries with transparent driver forwarding. Current native owner,
journal, denial, provenance, drift, lock and adjacent deadline regressions must
pass. The complete coordinator file, assertions and 900,000ms bound remain untouched.

No further optimization is assumed sufficient. Measure again and investigate any
actual remaining failure before another change. Overall acceptance remains open
until the complete final-source native gate and package checks finish.

## Measured CPU and native-read amendment

Actual warm chains 0–4 after reference installation cost 12838 SQL / 22652ms to
initialize, 5852 / 11081ms to verify and 5853 / 11120ms to replay. Exact persisted
hashes were unchanged after both read modes. First-use/reference overhead is
therefore not the only explanation; all earlier acceptance gates remain open.
CPU sampling identified canonical serialization/hashing, bounded JSON descriptor
walking and repeated immutable expected-value construction as material. Sampled
inclusive categories overlap and are not additive or acceptance measurements.

The next increments retain every native proof and comparison:

1. Extract the existing canonical serializer unchanged as `canonicalExportJson`
   in domain. Existing browser-safe `canonicalExportDigest` still uses Noble SHA;
   no Node import enters domain or browser consumers. An API US-only adapter
   hashes that exact validated canonical string with Node SHA-256. Only explicitly
   listed hot US demo imports opt in. No caller-supplied canonical text, algorithm
   copy, changed digest bytes, serialized-value cache or current-proof cache.
2. Preserve the bounded JSON walker interface, every error/precedence and the
   256KiB/depth16 limits. Remove repeated descriptor collection for ordinary
   objects. A NUL/surrogate fast path may reuse the exact existing character scan
   as fallback after an explicit differential/error corpus. Every invocation
   still walks fresh input and proves descriptor safety, keys, bytes and depth.
3. Private module-owned expected catalogues/inputs may be constructed once via
   the unchanged fresh/deep-frozen factory. Keep the factory and fresh-ownership
   tests unchanged. Each journal instance may precompute only its owned immutable
   expected manifest digest; every newly read persisted manifest is still hashed
   and compared. Never cache headers, receipts, native rows or successful proof.
4. Keep native authorization membership query and JS capability check first.
   Then consolidate only profile and org-profile reads into one parameterized
   SQL statement: materialized tenant profile FOR SHARE precedes an explicitly
   dependent org-profile FOR SHARE, which cannot run if profile is absent. Use
   existing validation/error codes and preserve driver failures. A detailed
   internal `{code,timeZone}` result serves the existing code-only wrapper and
   the target guard, removing only its duplicate timezone read in that invocation.
   No generic all-facts join, duplicated SQL authorization policy or later locks
   acquired before an earlier denial. Ordinary writers remain unchanged.

Canonical extraction/native hash must preserve literal bytes and error class/
message: root-only unordered events/findings, lexicographic object keys including
integer-looking keys, nested array order, finite JSON/negative zero, Unicode,
alias/cycle distinction, null prototypes, hidden/symbol/accessor handling and
existing array behavior. Do not tighten unrelated legacy behavior. Serializer
allocation rewrites are not included until a separate proven amendment; extraction
itself is unchanged. Tests retain a test-only frozen baseline for differential
walker/output errors and do not create a second production implementation.

Native authorization structural RED/GREEN is <=4 queries including BEGIN/COMMIT
(old5); target <=9 (current11). Real contention must prove profile locks before
org, missing profile denies without touching blocked org, both shares persist,
role/profile/zone changes are observed on each same-transaction invocation, exact
cross-tenant/error behavior and table hashes. These are not the full-volume gate.

Task2 source checkpoint may be reviewed independently after its actual 30+9+122
bounded native passes, but all 26 prior failures and full eleven-case coordinator
remain deferred mandatory gates for final optimized source, not waived acceptance.
After these increments, measure warm actual chains again and run unchanged full
900000ms phase when ready. If still inadequate, diagnose and explicitly amend
scope rather than delete checks, cache authority, widen deadlines or retry blindly.

## Rejected ordered-owner SQL proposal (not implementation authority)

This proposal was rescinded before production edits. A READ COMMITTED proof can
wait on the owner-user lock while another transaction inserts a second credential
and commits. The original subsequent credential command observes both and denies;
a single CTE statement may retain its earlier snapshot and incorrectly accept.
Ordered row locks alone do not repair this phantom/cardinality risk. Keep the five
native owner commands. The proposed constraints below record the evaluated option,
not authorization to implement it; further optimization needs another amendment.

Task 4 bounded authorization is independently approved: the 26 previously failed
cases now pass in their unchanged whole files (99/99), compatibility is 309/309,
and final authorization is 26/26. Warm5 still costs 14.204s initialize, 6.808s
verify and 6.724s replay, so full acceptance is not established. Fresh CPU sampling
on the frozen source confirms substantial SQL waiting; constant-only CPU work is
insufficient by itself. All pending full and final-package gates remain mandatory.

Add an ordered native SQL implementation ONLY for verifyLockedTrustedSeed. Keep
the unlocked verifyTrustedSeed path unchanged. One parameterized statement uses
materialized row-locking CTEs and explicitly dependent lateral subqueries in the
existing organization -> user -> membership -> credential -> audit order. Every
later CTE must depend on the previous complete semantic predicate. Lock ALL
matching membership/account/audit rows before testing cardinality; never LIMIT 1
or filter invalid rows to manufacture a successful proof. Missing, foreign or
invalid earlier facts must not acquire later row locks. Preserve exact organization
slug/name/metadata, owner email/name/actor, membership role/cardinality, credential
account/password-presence/cardinality and every provisioning-audit predicate.

Use unknown-safe native projections and original JS final validation; do not emit
credential contents, construct caller proof objects or cache current facts. Every
invocation executes real SQL again and holds the same shares until transaction
exit. Native driver errors from executed statements propagate unchanged. Like
the already approved native batches, the single statement reads one consistent
command snapshot; it does not promise the previous multi-command timing for
concurrently changing unowned data. Relation/schema validity remains a runtime
prerequisite: SQL planning errors may occur before row-dependent semantic denial,
not be converted into a successful proof or suppressed. No schema/grant edits.

Before production edits prove actual target budget RED <=5 SQL including BEGIN/
COMMIT (current9). Add real denial/cardinality/early-lock and retained-share tests,
own-write fresh rereads and original driver-cause forwarding. Existing assertions,
all nested verifier traversals, receipt comparisons and deadlines remain untouched.
Measure the same warm5 boundary after native owner/journal regressions. Do not
claim this single optimization suffices; further measured amendments may follow.

## Active remaining Receiving expectation amendment

Fresh Task 4 CPU attribution is retained separately in task5 CPU artifacts; the
one-chain initialize/verify observed 624/314ms exclusive canonical serialization,
307/172ms fresh walker work and 2380/856ms SQL waiting. These overlapping stack
measurements are diagnostic, not acceptance. SQL attribution is 2736 initialize
and 1018 verify commands at the cold one-chain boundary. Both diagnostics retained
unchanged returned results and persisted hashes and disposed their owned children.

Complete the already approved private-immutable-expectation optimization in
us-dataset-receiving-contract only: construct one private frozen catalogue and
expected reference-input digest at module initialization; reuse the catalogue for
document source lookup and compare the newly computed raw intent-input digest with
that owned expected digest. Keep every raw JSON traversal, strict schema check,
record-ID/digest comparison and native current-fact proof. No receipt/native row,
authority, parsed input or proof memoization. The public catalogue factory still
returns fresh deeply owned objects on every call. No serializer/walker rewrite.

Protect the eliminated reconstructions with a new focused test observing real
factory calls only during actual codec execution (RED before production edits),
and existing factory/Receiving/reference/Transformation/Cases/Shipping codecs.
This is a bounded measured increment, not sufficient evidence of full readiness.

## Completed regular-chain terminal proof amendment

The prior prohibition on removing verifier traversal remains binding for nested
native proofs and for fresh/partial initialization. It does not require repeating
the same complete native upstream graph in separate outer completed-stage wrappers.
Current Shipping verification already executes Cases -> Transformation -> Receiving
-> References, including live journal identity, recipe, canonical bytes, native
root/revision/lot/document, operation/audit, genealogy, support and balance proofs.
That path is not a saved-receipt-only check. Completed outer execution currently
visits Receiving4, Transformation3, Cases2, Shipping1 times; the complete terminal
path visits every unique stage once. Preserve every nested verifier and predicate.

For a freshly guarded structurally completed regular chain, use the existing
shipping.verify path once, in both regular verify and completed initialize/replay.
Eligibility is a fresh native read of all four stage rows with revision2/non-null
receipts, using a guarded public readStages wrapper around the existing bounded
transaction batch. Eligibility never certifies business state. Only successful
live terminal proof permits the existing summary. No cached header/receipt/proof/
authority, parallelism, automatic retry, fallback or repair after terminal denial.
Missing/pending chains retain the original four-stage execution, exact order and
partial-commit boundaries; partial Receiving drift still stops before Transformation
or the next chain. Keep the global full References proof before the chain loop.

This is an intentional internal completed-seed diagnostic/scheduling change, not
an HTTP/domain lifecycle change: completed-chain failures are annotated Shipping
and may carry nested Cases/Transformation/Receiving causes; simultaneous completed
defects follow terminal-first error priority. Complete success still requires ALL
native predicates. Fresh/partial error priority is unchanged. Three redundant
outer transaction/auth intervals disappear; existing terminal and nested guards,
row locks and current rereads remain. Do not weaken or rewrite an existing test
if it exposes an unaccounted required predicate or partial-state difference.

Protect with actual forwarded driver-query RED on a completed chain, parity and
no-write hashes for initialize/verify, every upstream intent/receipt/native/audit/
operation layer drift, missing/pending stages, role/profile/tenant/provenance drift,
root/lifecycle, case support and output/balance failures, combined-defect diagnostics,
and unchanged existing regular/native suites. A completed-denial must NOT fall
back to initialization. Full260 remains eleven unchanged cases at900000ms. Measured
clean-host warm5 is10.099/4.646/5.123s, SQL11303/5040/5041, after explicitly approved
termination of24 unrelated CPU-heavy processes; source change and host effect must
be reported separately. No sufficiency claim until actual full acceptance.

### Partial-priority correction before Task 6 acceptance

Actual native RED found a defect in the proposed full-row eligibility read: with
Receiving audit drift, malformed Transformation intent and pending Shipping,
readStages parsed downstream evidence before the partial Receiving native proof
and surfaced journal_invalid instead of receiving_mismatch. Original direct
Receiving verification proves the expected first failure. This is NOT acceptable
as unchanged partial behavior; preserve the assertion and fix the eligibility code.

Replace the newly added public readStages wrapper with a USED guarded metadata-only
readStageCompletions wrapper. It owns repeatable-read, executes current target and
header checks, validates bounded requested unit/stage pairs and uses a tenant/
dataset/pair-scoped projection of unitKey, stage, revision and receipt IS NOT NULL
as receiptPresent. Return ordered nullable fresh projection objects, including
duplicates; empty still authorizes. Do NOT read/parse receipt or intent payloads
merely to choose the branch. Existing readStagesInTransaction stays unchanged.
This narrow boolean metadata never certifies business facts: completed mode still
executes full terminal native proof, partial mode still executes original ordered
stage verification. Keep all drift/no-write/budget tests, add exact combined-partial
regression in both modes, then rerun the final entire matrix and existing suites.

### Task 7 amendment: bounded-memory complete fixture snapshots

Actual unchanged full11 recorded all260 regular receipts then PostgreSQL SIGKILL
while running the fixture's single198-table UNION ALL/jsonb_agg snapshot. Kernel
cgroup memory.events records oom_kill1; PostgreSQL recovery caused57P03 before
resume, not the900000ms deadline. Preserve this failed log; no blind retry or
resource-limit increase. Full fixture cleanup failed during recovery; its exact
owned database remains for diagnosis, with no FORCE drop or unknown-child cleanup.

Permit a TEST-SUPPORT-only amendment to us-dataset-journal-fixture.ts plus one
focused helper and new real-native tests. All production/nested proofs, full11
test body, assertions and deadlines remain byte-identical. Replace the giant
aggregate with a pool-owned client BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY.
Enumerate every public table in that same snapshot, validate every identifier,
then use a server-side cursor ordered by to_jsonb(t)::text for each table. FETCH
bounded64-row batches until exhaustion; do not truncate, skip columns/tables,
filter tenants, sample, or introduce a maximum row count. Hash the exact JSON array
representation incrementally: '[' + comma-separated JSON.stringify(row.body) + ']'.
This must match the old SHA256(JSON.stringify(jsonb_agg-body)) for every table,
including empty, duplicate, null/Unicode/number/key-order rows. Only one cursor
and bounded client batch are live, PostgreSQL ordering may spill normally; do not
increase work_mem, Docker memory, resources or timers. No new dependency.

The same consistent MVCC snapshot covers all tables: concurrent committed changes
must not appear midway. Retain current complete-row comparison and fixture
acquisition/phase/drain/disposal. COMMIT on success; rollback/release on failure,
preserve original driver error identity when cleanup also fails and do not abandon
pending queries. Tests must compare against the original aggregate oracle on a
small real fixture, witness64-bound/non-aggregate forwarding, concurrent mutation
consistency, complete row/table drift and cleanup/errors. Then safely exercise
the new snapshot against ONLY the named owned failed-full database without
rerunning the known OOM query, before restarting unchanged full11 from scratch.

### Task 8 amendment: native coordinator drift namespace

Corrected bounded native probe initializes exactlyone real regular chain, asserts
reference_documents UPDATE affected rows, then confirms both Native modes reject
without changing any198tablehash. Actual messages are us_dataset_cases_mismatch,
so the unchanged full11 /drift|invalid/ assertion fails. This is a real boundary
contract defect, separate from the rejected initial references-only UPDATE0 probe.

Permit only us-dataset-native-seed.ts plus new native drift tests/docs additions.
At the FULL native coordinator boundary translate explicitly recognized internal
dataset semantic mismatch errors into us_dataset_native_drift with ORIGINAL Error
as cause and existing unitKey/stage retained. Do not mutate the original error.
Exact known domain messages: reference, receiving, transformation, cases, shipping,
special and corrected_transformation mismatch. No broad catch-all, repair/retry,
query/predicate change or nested/ordinary-store error rename. Existing target,
incomplete/conflict, arbitrary Error, frozen error, primitive thrown values and
driver/network errors retain original identity. Do not translate an error with
a driver code on itself or its cause chain, even if its text matches a known
domain message. Cyclic/deep cause chains must be handled conservatively.

Native tests must retain the exact full11 regular expression, actual notes/reference
drift/no-write assertions, verify original cause identity through real forwarding
instrumentation, unchanged direct regular/nested errors and exact native SQL40001
identity/cause/metadata without implicit retry. Original full11 body/deadline and
all existing tests remain byte-identical. This internal boundary taxonomy fix is
not an HTTP/API contract or a replacement for the actual full260 acceptance gate.

### Task 9 amendment: cache-free printable-ASCII scalar specialization

Actual V8 self samples attribute335.918ms to canonical serialization and194.997ms
to bounded walking/stringBytes in a1974.964ms three-chain window. Artifact-only
candidate passed196679 exact differential comparisons, including all65536 UTF16
single units/keys, proxy/getter/iterator effects and error precedence.27 genuine
native JSON payloads564784bytes yielded paired median serializer6.87% and walker
29.82% improvement; illustrative whole-window projection only4.1%, not fullGREEN.

Permit ONLY canonical.ts primitive string/key quotation and us-demo-journal-contract
stringBytes specialization plus two new focused oracle tests and appended docs.
For strings without quote, backslash, controls, DEL or nonASCII code units, JSON
bytes are exactly doublequote+text+doublequote and UTF8bytecount text.length+2.
All other values follow the ORIGINAL JSON.stringify / NUL-surrogate/UTF8 fallback.
No cache/map, descriptor/prototype/enumeration/array/ancestor traversal rewrite,
removed validation, clone, hash, query, currentheader guard or error translation.
Preserve legacy Array.from/customiterator/getter semantics, root events/findings
sorting, ordinary array order, numeric-key lexicographic order, null prototypes,
exact -0/Unicode/escaping, raw size/depth/secret-key/error priority and fresh reads.
Arbitrary hostile replacement of global built-ins is not a supported extension
contract; proxy/getter/iterator observations on caller data must remain equivalent.

New tests must retain an independent frozen prechange canonical serializer oracle,
not merely browser/native calls sharing changed helper. Keep literalUTF8/SHA
witnesses and original bounded-walker oracle, shard exhaustive corpus if necessary
without increasing default deadlines. Actual RED may transparently forward/count
native JSON.stringify ASCII work, assert output/hash before budget, restore spy
in finally. Re-run original domain/API codecs, browser-entry boundary and real
native complete-proof/no-write/drift/current-guard tests with same SQL counts.
Measure paired actual unchanged warm5 and retained260 read-only probe; no full
acceptance extrapolation. Wholefull11 remains untouched900000ms and mandatory.

### Task 10 amendment: additive audit access paths

Retained260 after Task9 passes all proofs and all198hashes:106756SQL,
113686.717ms; full900000ms remains OPEN. Native EXPLAIN proves5137-row scans
for tenant/action and tenant/request. Approve exactly two NON-UNIQUE B-tree
indexes on tenant_audit_events: (organization_id,action) and
(organization_id,request_id), via NEW migration0143. No partial/unique index.
No predicate, command, FOR SHARE, duplicate/cardinality, authorization, digest,
transaction, recipe, runtime setting, fixture, assertion or timeout changes.
This is the ONLY exception to earlier no-schema policy; earlier tasks frozen.
Shared-table source changes stay isolated in this US worktree; no RU deployment,
release or shared database migration authorized. Transactional CREATE INDEX can
block writers; deployment needs separate operational review. CONCURRENTLY cannot
run inside this transactional migrator. Physical unordered scan/lock scheduling
may differ; actual duplicate and concurrency denial tests must remain green.
Generate metadata from0142, stop if SQL includes anything beyond the two indexes.
Do not rewrite old migrations; preserve existing schema/journal changes.
Measure actual plans, storage/write cost and proof timing, without promised gain.
Only invocation-owned children may migrate; retained failed child read-only.
Acceptance: schema/SQL RED; fresh and0142-upgrade native/runtime/idempotence tests,
two tenants and duplicate audits unchanged, exact indexes and actual selective
EXPLAIN without planner overrides; DB gates and unchanged API lock/cardinality
regressions; independent review, then actual unchanged full11 under900000ms.

Task10 evidence amendment: actual unchanged native regression195/196 reveals
one existing test assumes physical audit insertion ordering without ORDER BY.
Both expected facts are present; new index changes their unspecified order.
Permit ONLY apps/api/test/us-master-data.e2e.test.ts first-case audit SELECT
to orderBy(desc(tenantAuditEvents.action)), with desc imported. Fake Date ties
created_at and random UUIDs cannot establish insertion chronology. This case
asserts exact audit facts, not chronology; no predicate/expected assertion/row
count/deduplication/timer/full11 change. Preserve failing evidence; rerun whole
affected file and independently review this deterministic query exception.

### Task 11 amendment: exact allocator transitions, immutable business facts

Actual full11 main failed592545ms at receiving_counters preservation after
successful260generation, late40001 and explicitresume; no timeout/OOM. Independent
one-chain actual reproduction11.39s confirms allocator mutation R+2/T+1/S+1,
contiguous new numbers, same preexisting186business-table PK hashes and identities,
unchanged alltable snapshots on failed40001/verify/replay. Ordinary writers must
increment counters for new roots; requiring those rows byte-immutable conflicts
with the accepted new special roots. Never reset counters, reuse numbers, bypass
writers, alter product semantics or omit unchecked allocator tables for GREEN.

Approve ONLY test oracle correction: original full11 production/260/fault/order/
root counts/no-write/drift/frozen-summary/timer assertions stay intact. Counter
preservation now checks exact allowed transition driven by the new actual roots:
2Receiving,1Transformation,1Shipping; contiguous suffixes from previous sequence,
tenant and allocation year derived from original event created_at in saved
event time_zone (not event_date or machine timezone). Whole before/after counter
tables must equal expected keyed state; missing/extra/foreign/year/unrelated field
changes, under/over increments, duplicate IDs/numbers or unknown table reject.
Existing historical business rows remain byte-immutable in every previous table
comparison. Do not normalize/fabricate actual facts or skip allocator comparisons.
Handle legitimate year rollover with new counter row starting1 and oldyear row
unchanged; check across all rows, including those absent from preexistingPK IDs.
Build expected state solely from preserved before counters and independent new
root metadata, never from the observed after sequence. Reject ambiguous/invalid
numbers, dates, timezone or allocation evidence. No existing expected quantities,
counts, driver failures, comparisons or900000ms deadline reduced or removed.

This narrow exception changes the formerly frozen full-test hash, not its260-chain
scope/deadline. Preserve original full file baseline and592545ms failure evidence;
all earlier tasks' source and all other tests frozen. New test-only helper and
focused pure/native tests pin exact transitions and adversarial counter tampering.
Independent review must judge the corrected oracle against ordinary writers and
the no-weaker-checks requirement before fresh all11/260 rerun. No product changes.

### Task 12 amendment: permanent root census and current-event census

The actual Task11 full phase failed at596713ms after the exact counter and
business-PK checks and total964roots/963current-finalized/785lots/15700boxes had
passed. Its next type census joined current_event_id while expecting physical
Receiving262. Ordinary finalized void preserves the root and original event but
clears current_event_id; the orphan therefore correctly contributes to physical
Receiving262 and not current Receiving261. The independent real chain0+259 and
Special40001/resume audit passed every subsequent bounded witness before the old
classifier alone failed: physicalReceiving4 versus currentReceiving3. No product
void, lot, pointer, revision, allocator or persistence change is justified.

Approve only the test-oracle correction in
apps/api/test/us-dataset-native-seed.e2e.test.ts and a new real native regression
apps/api/test/us-dataset-root-census.e2e.test.ts. Classify physical roots by joining
each permanent root.id to its original event.id with matching tenant identity.
Preserve literal physical counts Receiving262/Shipping441/Transformation261.
Add an independent current-pointer census with exact Receiving261/Shipping441/
Transformation261, and assert all current events are finalized. Add an exact
orphan witness: current_event_id NULL, pending_draft_id NULL, latest actual event
ID equal to the void receipt ID, revision1 and status void. Derive latest from
actual root revisions; there is no latest_event_id column. Expected facts must
come from literals and native receipts, never from observed census results.

Keep every other full assertion and source byte, including counters, old business
PK preservation, total964/963/785/15700, all260 real chains, fault40001 and single
attempt, exact quantities, summaries, full-table no-write, drift and900000ms
deadline. No reduction or normalization of expected quantities, fallback pointer
join, source repair or product modification is permitted. The new regression
uses original stores for real regular0 and259, the same late Special fault and
explicit resume, exact Task11 counter checks, physical/current/orphan facts and
the audited remaining bounded witnesses under the existing60000ms bounded phase.
The saved actual audit RED is the causal old-classifier witness; corrected native
GREEN must follow. No synthetic260 result may replace the full coordinator.

Preserve the pre-Task12 full SHA256
2a5d4f8c4ff2b2a8ac085b215829d537f4e917bc8490ca07b6a8f67e3a325743 and all earlier
source/tests; permit only appended canonical amendments and US progress notes.
The reviewed bounded result does not prove the full envelope, full260 verify/
replay, full-size byte limit, final native drift boundary or original deadline.
Fresh independent review precedes the controller's full11 acceptance run.
