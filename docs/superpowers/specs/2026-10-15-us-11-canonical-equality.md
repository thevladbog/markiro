# US-11: exact canonical equality without comparison hashes

## Evidence and scope

At `042f77bf9`, CI `38713518262` passed six isolation jobs but failed prepared
services on six original 5000 ms deadlines and the original full262 deadline.
One reviewed M11-only diagnostic observed exactly2941 owner queries, all settled,
matching the unchanged counter. Owner wall3404.66ms included1494.45ms summed
driver elapsed; this is not server CPU time. Earlier CPU evidence identified
canonical JSON and SHA work. Source has repeated comparisons of two freshly
computed canonical digests throughout the US demo contracts and verifiers.

Do not implement the explored authorization transport or broader read-retention
proposals: neither establishes sufficient benefit, and both expand concurrency
scope. This slice changes no SQL, authority observations, locks or reader lifetime.

## Design

Add pure `canonicalExportEqual(left, right)` beside the existing domain canonical
functions. For two valid JSON primitives, strict value equality is equivalent to
canonical JSON equality, including `0`/`-0`; nonfinite values are not primitives
for this fast path. Otherwise compare the existing canonical JSON strings,
evaluating left before right. Existing serialization, validation, getter/cycle/
prototype rules and root events/findings ordering remain unchanged.

Replace only direct two-value comparisons of freshly computed canonical digests
in US demo modules. Use the helper for already-bound local operands. If operands
are expressions, compare `canonicalExportJson(leftExpression)` and
`canonicalExportJson(rightExpression)` directly: validating the left must still
precede evaluation of the right expression. Do not introduce eager-argument error
reordering or a thunk/factory API. Exact canonical equality avoids false matches;
it does not skip input validation. Persisted input/result/manifest digests, receipt
hashes, byte encoding and cryptographic digest generation remain unchanged.
Do not introduce memoization, cached validation, new native adapters or callbacks.

## Acceptance

TDD covers primitives, signed zero, Unicode, dense arrays, reordered objects,
unordered root selections, nested order and both sides' invalid inputs/error
ordering against the unchanged serializer/digest reference. Existing original
API tests, counters, fixtures, SQL identity assertions and deadlines remain intact.
Run unchanged whole12 and whole17 once on the changed candidate before any broad
gate or CI push. A speedup is not completion; actual original deadlines must pass.

## Remaining server digest routing

The first equality candidate passed28/29 original whole12/whole17 tests. M05,
M06, M10, C02 and C17 now pass, but M11 still exceeded5000ms after its owner
completed2725ms; no unchanged retry is accepted. Retain that RED evidence.

The existing `us-demo-canonical.ts` already hashes the same validated canonical
bytes with Node SHA-256. Existing native/browser differential tests cover exact
outputs, invalid values, Unicode, getters, mutation and byte limits. Route remaining
server-only US demo `canonicalExportDigest` imports to this existing helper, not
to the browser Noble implementation. Do not change either implementation, add
hash caching, alter comparison sequencing or modify stored hash formats.
Add a failing actual-routing witness and enforce ownership of these imports.
Retain the existing frozen differential tests and run them unmodified. This is a
bounded server-backend continuation, not another serializer/cache redesign.

## Validated immutable Special codec copies

The routing candidate still passes28/29; original M11 times out before final
postconditions. One independently reviewed, source-unchanged whole-worker CPU
capture identifies canonical serialization (964ms self), bounded validation
(403ms self), and Special result parsing (782ms inclusive, including275ms under
`usDatasetSpecialRecordIds`). These are sampled diagnostic costs, not acceptance
timings or owner-only measurements. SQL compilation is not the dominant target.

Supersede the no-memoization constraint only for Special record-ID extraction:
the result parser records its own successfully validated, detached, recursively
frozen outputs in a module-private WeakSet. Both parsers themselves always retain
their entire validation and fresh-copy behavior. Record-ID extraction recognizes
only that exact successful result identity instead of parsing it again; retain
exact ID checks and return a fresh frozen array. Unknown identities, caller-frozen
values, proxies, deserialized values and caller clones take the entire unchanged
validation/error path. Do not brand nested values or export a registration API.

This is pure value provenance, not a business-state certificate. No DB rows,
authorization, receipt reads, locks, lifecycle/origin/balance checks or verification
results are cached. Keep mutable ReferenceResult output and all other codecs
unchanged. Preserve original fixtures, assertions, SQL inventory and deadlines.
The broader input/result-parser fast paths are deliberately not implemented:
their additional benefit is not established by the current profile.

## Owned immutable canonical byte reuse

The changed whole29 still fails only M11. A reviewed pure native-JSON replacement
benchmark was13.8% slower and is rejected; no serializer fast path is adopted.
The remaining increment reuses successful canonical bytes of detached, recursively
frozen codec copies, not database observations or validation of mutable inputs.

The server canonical helper may copy the unchanged reference traversal and add
private per-node memoization. A new owned-copy utility replaces only existing
`freezeOwned(structuredClone(...))` paths in Special/corrected codecs and static
Special recipes. Finish cloning/freezing before admitting only finite plain JSON
subgraphs to a private WeakSet; do not mark caller objects, cycles or subtrees
containing mutable non-JSON state. Preserve fresh return identities. Mutable
reference/receipt outputs and every database reader remain unchanged.

Keep separate root-object, nested/ordered and unordered-array cache contexts.
Unknown nodes execute the exact existing traversal and error order. Cache only
successful bytes, with a minimum worthwhile chunk size and a maximum256KiB entry;
reset the private WeakMap when its8MiB retained-string-payload budget is reached.
This is not an exact JavaScript heap bound. Never cache failures or hashes.

Before each owned cache hit and store, use captured safe descriptor inspection to
verify all mutable intrinsics used by the reference traversal are unchanged,
including JSON stringify, array iteration/from/isArray/sort/map/join, reflection,
finite-number and Set operations/global constructor bindings. New accessors must
not be invoked early. An untrusted Proxy ancestor can modify these during traversal;
an entry-only guard is insufficient. Store only if the same stability condition
held before and after computing the owned chunk. Use captured trusted operations
for private metadata and completing the owned-copy operation.

Frozen reference/native differential tests must cover warmed nested/root selection
contexts, caller mutation, proxies/accessors/error order, intrinsic replacement
including replacement from a Proxy ancestor, aliases/cycles and budget resets.
Route only US server comparison/JSON imports to this helper, preserving expression
evaluation order. Domain reference bodies and persisted byte/hash formats stay
unchanged. Original SQL, authority, lifecycle, balance and freshness checks remain
mandatory; owned JSON provenance is never a business-state certificate.

## Callback-free structural equality

At `ee3a32273`, exact-SHA CI passes the original full262 trace run (62 tests,
791681 ms under the unchanged 900000 ms body) and six isolation groups. Prepared
services remains red on five original 5000 ms deadlines. Retain these failures;
do not retry unchanged. A source-unchanged whole-worker CPU capture identifies
canonical serialization as substantial remaining work. A single pure diagnostic
rejects content-addressed byte caching (1.51--2.34x, inconsistent) and measures
callback-free structural equality at 2.18--2.56x across twelve regular/corrected,
equal/unequal/aliased, both-order workloads, with original reference parity. These
are diagnostic measurements, not end-to-end acceptance.

Change only backend `canonicalExportEqual`. Keep its existing primitive path,
serializer, digests, owned-byte cache, codecs, SQL and authorization unchanged.
For ordinary finite JSON, compare object own-key sets without sorting and arrays
in source order, with exact primitive equality (including canonical `0`/`-0`).
Before any unequal-value shortcut, completely admit both operands using captured
descriptor-only operations. Reject proxies before invoking any traps, accessors,
hidden/symbol properties, nonstandard prototypes/iterators, sparse arrays, cycles
and nonfinite/non-JSON values to the unchanged left-then-right serializer path.
Admit ordinary aliases as values, not identities: per-call active/completed sets
distinguish cycles from completed DAG nodes. Check each root's unordered
`events`/`findings` policy before any completed-node shortcut and fall back when
that policy applies. Do not reuse admission across calls. Bound admission and
comparison work; exceeding a depth/node/step bound must fall back, never introduce
a rejection or skip original validation.

Guard all existing serializer runtime dependencies with captured descriptors.
Use captured safe own-descriptor operations for the new comparison itself, not
inherited lookup or caller hooks. A changed intrinsic executes the original path.
No schema validation result, canonical byte content key, DB observation or
business-state proof is cached. Caller mutation is reread on every invocation.
Original tests, clocks, SQL counts/ownership and error order remain protected.
