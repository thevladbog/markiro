# US-11 locked owner provenance round-trip compression

Status: REJECTED, not an implementation basis. Independent architectural review
identified a READ COMMITTED cardinality race: a duplicate audit/account inserted
while the organization lock is awaited is invisible to the single-statement
snapshot, while existing successive reads reject it. No product implementation
was made. Retained as a rejected alternative, not a default-5/full-900 claim.

## Intent and current evidence

Finish the isolated six-month US demo without weaker verification or larger
timeouts. The composed chain0 diagnostic forwarded2816 driver calls: References491,
Receiving260, Transformation400, Cases574, Shipping794, real Trace/readiness/history210,
entry34 and approximate final residual53. Its original5000ms body remained RED.
Counts identify native work as the main dispatch cost; timing changes between
probes are not evidence of regression or a host-load cause.

The nested native paths repeatedly call the journal target guard. Each guard
checks actual database/user, then original owner provenance, capability/profile,
and journal state. `UsDevelopmentOwnerStore.readTrustedSeed` currently obtains
organization, user, memberships, credentials and provisioning audit using five
sequential native statements and original provenance share locks.

Choose compression of those five locked provenance statements only. Do not
reuse ancestor proofs across application/verification, suppress nested guards,
or expand this into a generic transaction cache. Current Shipping preflight is
already batched; it is not a new optimization in this slice.

## Alternatives and scope decision

1. Selected: one freshly executed, dependency-ordered statement for locked owner
   provenance. Existing guard/public interfaces and all later authorization and
   content checks stay in place. Narrow source scope, with explicit lock risks.
2. Deferred: private same-transaction reuse of immutable ancestor facts. More
   potential savings, but application can change mutable origin/status facts;
   legal reuse and error parity are not established.
3. Deferred: per-shipment content/support batching. Preserves comparators, but
   does not address repeated provenance checks throughout all native phases.

The user explicitly authorized continuing implementation and waived routine
approval prompts. This does not waive independent design/source/native reviews,
security predicates, data isolation, or the stated no-timeout/no-release limits.

## Locked statement ownership and evaluation

Keep `verifyLockedTrustedSeed(tenantId, actorUserId, verifiedAt, transaction)`
unchanged. It performs a new native read on every call, including when the caller
supplies a mutable transaction. No memoization, carried proof, skip parameter,
callback, additional public capability or reused validation object.

Retain the original early finite-Date check with no query on invalid dates.
Keep unlocked `verifyTrustedSeed` behavior and provisioning/password paths
unchanged. The actual database/user check in the journal and the separate
capability/profile guard must still execute in their original order.

Use materialized, explicitly dependent locked relations in this order:

1. Organization selected by the original tenant/slug predicate, `FOR SHARE`.
2. User selected by original reserved email, only after the locked organization
   passes its original metadata/name predicates, `FOR SHARE`.
3. All memberships for that tenant/user, after the original user/name/actor
   predicates, `FOR SHARE`.
4. All credential-provider accounts for the selected user, only after complete
   membership enumeration proves exactly one owner row, `FOR SHARE`.
5. All matching provisioning audit rows, only after complete credential
   enumeration proves exactly one correctly bound nonempty credential,
   `FOR SHARE`.

Do not acquire downstream row locks on an earlier denial. Materialization alone
is not proof of evaluation order: downstream relations must depend on successful
upstream evaluation, including complete membership/credential aggregates.
Preserve the existing audit predicate, not a narrowed successful-row filter:
duplicates and invalid actor/outcome/target/body rows must remain observable.
Schema enforces unique reserved user email and organization ID/slug; do not add
membership/account/audit uniqueness assumptions or filters hiding duplicates.

Return bounded internal facts sufficient for the existing JavaScript acceptance
predicates, not a public proof. Avoid returning/logging credential hashes where
an equivalent nonempty-password boolean suffices. Share canonical acceptance
logic privately between reads if needed; no exported accepts-verified-facts API.
SQL gating and JavaScript acceptance must agree, including exact text comparisons,
duplicate counts, null handling and the original audit JSON serialization check.
Do not replace `JSON.stringify(audit.after)` with a looser JSON containment test.
The original `audit.before === null` accepts driver-decoded SQL NULL and JSON null;
do not accidentally distinguish these in an equivalent SQL predicate.

The expected installed schema is the existing migrated US schema, unchanged.
Single-statement relation resolution can differ from sequential early return if
later relations are physically absent. Treat this as an explicit review point,
not silently asserted parity; no fallback retries or schema changes are allowed.
Driver failures must propagate with original object/cause identity; do not map
infrastructure failures to a trusted/denied success.

Under READ COMMITTED, one statement uses one statement snapshot rather than the
previous five successive snapshots. This is an explicit architectural review
point, not identical concurrency behavior by assertion. Existing row shares do
not prevent insertion of duplicate membership/account/audit rows. Document the
proposed statement-start observation boundary and prove no cache across calls;
test writers before/after that boundary and later protected reads. If an existing
required barrier demands later observation that the joined statement loses,
reject or refine this design rather than waive that test. Do not introduce
predicate-lock or phantom-protection claims absent in the current implementation.

## Native and differential acceptance

Before implementation, retain a focused meaningful RED for the intended reduced
round-trip behavior, using the real isolated native fixture. Keep all original
test assertions, deadlines and cleanup unchanged; new tests use existing defaults
without subsequent increases or moving timed operations out of their bodies.

Use the previous locked implementation as a test-only differential reference,
not an alternate production path or exported flag. Assert exact safe return/null
and failure behavior for original-owner/foreign-actor, invalid date, organization
metadata/name/slug, reserved user/name, absent/duplicate/non-owner memberships,
absent/duplicate/misbound/empty credentials, absent/duplicate/wrong-actor/outcome/
target/before/after audits, including SQL/JSON null and strict metadata variants.
No hashes, passwords, raw SQL parameters or private records in logs/artifacts.

Real two-connection barriers must prove retained shares, lock acquisition order,
no downstream row locks after upstream denial, fresh denial after prior successful
call when same-transaction/native facts are changed, and no hidden lease/repair/
retry. Keep normal transaction commit/rollback behavior and exact driver failure
propagation. Preserve existing owner/target/master-data/native suites and their
protected-boundary denial-before-selector behavior.

Measure actual native driver forwarding counts with and without the change for
standalone locked owner and journal reads, then changed regular indices0/1/181/259
and a small populated range. Separate creation/verify/replay, Reference cost,
native production, terminal verification, actual read models and progress. A
five-to-one local guard count is not proof that chain0 or full262 is GREEN.

## Sequencing and exclusions

Freeze incomplete unit-composition Task1 source as the recorded baseline; no
Task2 coordinator change while its source/native review remains unaccepted.
This prerequisite slice gets its own spec, plan, implementer and independent
review. Existing original full test, fixture, snapshots and900000ms gate remain
byte-identical. Resume Task1 and its full coverage only after this slice is
source/native accepted; carry the existing Shipping221 RED as an open gate.

No schema/migration, dependency/env-policy, routes, production owner provisioning,
RU/main/Station, Requests, PR, release, provider/hosting, process stopping or
unknown-database cleanup. Root owns any scoped commit/push. Full262 still requires
complete-budget evidence and actual same-SHA GREEN, not a query-count forecast.
