# US-11 sequential owner provenance in one transport call

Status: architectural direction approved by independent review, for planning;
not implementation or performance acceptance. The rejected single-snapshot
alternative remains rejected.

## Goal and rejected alternative

Keep every owner-provenance check, fresh observation, share lock, early denial
and original5000/full900000 test budget while reducing transport overhead in the
isolated US demo. Current composed chain0 forwards2816 native driver calls and
remains RED. Native stages account for2519, real read models210; these counts are
not a whole-budget forecast.

Five provenance reads cannot become one joined statement snapshot: a duplicate
credential/audit inserted while the organization lock is awaited changes the
original denial into success. That design is rejected and must not be implemented.
Nor may callers supply proof, transaction caches or skip flags.

## Selected scope revision

Keep the five logical database reads sequential, but execute their short-circuit
control flow in one versioned PL/pgSQL function call. This reduces client/server
round trips, NOT the number of server-side validation reads.

Unlike the rejected migration-free proposal, this requires a new additive
database-function migration and lifecycle tests on the isolated US branch. The
existing migration journal is shared; there is no edition-filtered installer.
US-only describes branch/caller scope, not a separate migration mechanism. This scope revision is explicit;
it does not alter business tables, records, routes, roles, membership rules or
data semantics. The standing user authorization covers scoped implementation,
but no migration is applied to a shared/live database, no release/deploy occurs,
and independent reviews/native proof remain mandatory. Current unit-composition
Task1 stays incomplete/frozen until this separate prerequisite is accepted.

## Function and security boundary

Create versioned `public.us_development_owner_provenance_v1`, called only by
the existing locked synthetic-owner verifier. It is PL/pgSQL, explicitly
`VOLATILE`, `PARALLEL UNSAFE`, `SECURITY INVOKER`, `CALLED ON NULL INPUT`, and uses explicit schema-qualified
relations and a fixed `pg_catalog` search path. It must contain no business
writes, dynamic SQL, external calls, transaction control or exception swallowing.
Return the built-in jsonb type; declarations use built-in scalars/generic RECORD,
not table %ROWTYPE/%TYPE or return composites that resolve later relations before
the relevant sequential branch is reached.

Exact signature: `public.us_development_owner_provenance_v1(pg_catalog.text,
pg_catalog.jsonb) RETURNS pg_catalog.jsonb`. CREATE and exact-signature REVOKE
PUBLIC execute occur atomically in the ordinary migration transaction. Pin the
effective ACL, including unexpected default grants, not only absence of PUBLIC.

Do not grant PUBLIC execution or new read/write privileges. Revoke PUBLIC on the
new signature; execution belongs to its existing migration owner, which must be
the declared local synthetic US runtime role in native fixtures. A different
future deployment migration/runtime role needs an explicit separately reviewed
grant, not a default-public privilege or SECURITY DEFINER workaround.

Public TypeScript interfaces are unchanged. `verifyLockedTrustedSeed` still
checks finite verifiedAt before any SQL, executes fresh on every invocation and
returns only the original safe seed metadata/null. Unlocked verification and
password/provisioning paths remain unchanged. No captured proof or result feeds a
later invocation. Actual database/user check and capability/profile guard stay
as independent original operations, in their original order.

The function accepts ordinary tenant text and actor identity encoded as a JSON
scalar, not expected/verified facts, callbacks, skip modes or receipts. SQL NULL
for the actor argument represents the old undefined/absent actor; a JSON string
represents the unchanged string identity; JSON null represents a supplied invalid
non-string identity. The adapter checks typeof without serializing or invoking
getters on hostile non-string values. Preserve the existing runtime distinction
between undefined actor (old private reader's optional check) and a supplied null
or malformed actor; this is compatibility, not a new optional protected-boundary
mode. Journal context validation continues to reject missing actor normally.
Do not introduce UUID casts that turn an original text mismatch into a parser error.
Strings containing NUL or unpaired UTF-16 surrogates cannot equal a PostgreSQL UTF8
text user ID. Encode them as the same invalid JSON-null identity, without sending
invalid jsonb escapes or returning early in JavaScript: organization/user reads
and their failure/lock order still happen before actor denial as in the legacy
reader. All other strings retain exact identity, without normalization/trimming.
Versioned reserved seed constants must match the current source and have explicit
contract tests; no caller-selected alternate seed definitions.

## Sequential reads and canonical predicates

Inside the function use separate sequential SQL statements, preserving this order:

1. Original tenant/slug organization selection under `FOR SHARE`; validate its
   exact original metadata/name before executing any user statement.
2. Original reserved-email user selection under `FOR SHARE`; validate exact
   name/actor before executing membership statements.
3. Enumerate and share-lock ALL original matching memberships; only after the
   complete scan accept exactly one owner row. Do not use `LIMIT`, `EXISTS`,
   successful-row filtering or early duplicate short-circuit.
4. Enumerate and share-lock ALL original credential-provider accounts; only after
   complete scan accept exactly one account bound to the selected user with a
   nonempty password. Whitespace remains nonempty. Do not return credential hashes.
5. Enumerate and share-lock ALL original provisioning-action audit rows; preserve
   duplicates and invalid actor/outcome/target/body records for rejection.

SQL gates must exactly match upstream JavaScript predicates, including byte-exact
text identity, null/empty handling and no normalization/coercion. Return bounded
private raw facts/counts and the sole audit's decoded before/after value where
needed for the unchanged canonical JavaScript validation. Keep the existing
`JSON.stringify(audit.after)` check in JavaScript; do not replace it with jsonb
containment, jsonb textual equality or caller-supplied booleans. The original
before===null allows driver-decoded SQL NULL and JSON null.

Do not export a facts-accepting authority API. Recheck returned facts with shared
private canonical predicates before returning safe metadata, so SQL control-flow
translation alone cannot make an invalid seed trusted. Counts may bound returned
payload; scans and locks must still cover all matching rows.

## Observation and failure contract

PostgreSQL17 documents fresh snapshots for queries executed by a VOLATILE
procedural function. This is the design rationale, not native proof:
[volatility snapshots](https://www.postgresql.org/docs/17/xfunc-volatility.html).
STABLE/IMMUTABLE, a joined CTE or one internal SQL query is forbidden.

PL/pgSQL analyzes SQL paths when first executed, allowing upstream denial before
unreached relations are read/locked. Require native evidence, including on a fresh
and reused connection; do not assume plan caching or relation-lock behavior:
[PL/pgSQL planning](https://www.postgresql.org/docs/17/plpgsql-implementation.html#PLPGSQL-PLAN-CACHING).

Native function errors propagate with the original driver object/cause identity;
no catch/convert-to-null, retry, repair, fallback implementation or installation
on demand. Missing/unexecutable function is an infrastructure error, not denial or
success. Function installation must precede use via ordinary migration lifecycle.
Existing row-lock retention, lock order, transaction commit/rollback, denial before
selector and current capability/profile behavior must remain unchanged.

## Required differential/native proof

Retain the previous sequential locked reader as a test-only differential reference,
never as a production fallback. First a real isolated-fixture RED for unchanged
safe result plus desired transport reduction; then implement migration/function
and adaptation, without increasing any test/hook deadline or moving timed work.

Compare full exact safe result/null across every original provenance predicate,
duplicates, malformed actor, finite/nonfinite date, SQL/JSON null, exact metadata
and audit serialization variants. No secrets/rows/SQL parameters in reports.

Mandatory two-connection schedule: writer locks organization FOR UPDATE; candidate
reader is observed blocked; writer inserts duplicate audit, credential or
membership and commits; both legacy and candidate must deny. Add selected-row
updates/deletion/replacement and rows changed into/out of later selectors during
lock waits. Test complete shares and no later relation/row locks after an upstream
denial, including later-table ACCESS EXCLUSIVE and unreachable missing relation.
No timing sleeps or timeout enlargements to manufacture race coverage.

Prove current same-transaction mutations are re-read on subsequent calls, no
write-on-verify, exact failures/causes, invoker permission denial/no PUBLIC grant,
search-path shadow denial, function attributes and migration journal/runtime
parity. Original owner/target/master-data and scoped native consumer suites stay
intact; old test interception changes require separately reviewed equivalent proof.

Measure client driver dispatches and server-side logical reads separately. A
five-to-one transport count must not be described as eliminating four validation
reads. Test guard/journal alone, regular indices0/1/181/259 and small populated
range creation/verify/replay, specials and unchanged full snapshots. Task1 and
Shipping221 still need GREEN; full262 waits measured G+2V+3R+H with margin and an
actual unchanged original gate at the exact reviewed SHA.

## Exclusions and integration

No RU/main/Station, public HTTP, dependency/env policy, Requests/worker, shared/live
DB, provider/account, PR, release, process stopping or unknown-resource cleanup.
Only new migration/function, its runtime lifecycle contracts, locked US owner
adapter, differential/consumer tests and exact required US CI selectors. Root
owns commits/push; do not trigger unmeasured full CI solely to rerun it.
