# US-11 Shipping prerequisite journal batch

Status: independent design review approved; implementation plan prepared.
No implementation or full-budget acceptance implied.

## Source and measured boundary

Shipping's private `execute` currently reads the guarded header, parses the
chain selector, reads References/Receiving/Transformation/Cases in four separate
guarded repeatable-read transactions, validates those prerequisites, and only
then reads Shipping. The journal already has `readStagesInTransaction`, which
independently validates the actual database/user, original owner and current
profile, required header, bounded addresses, and strict selected stage rows.

The read-only design investigation estimates a source opportunity of 36 driver
calls, including repeated transaction/guard/header work. This is not an actual
differential measurement, a wall-time improvement or an under-900-second claim.
One terminal proof already checks each ancestor once; this change does not
remove any ancestor, final verifier or read-model proof.

## Selected boundary for review

Add a normal independently guarded `UsDatasetJournalStore.readStages(context,
datasetId, requests)` entry. It owns one repeatable-read transaction and delegates
to the existing `readStagesInTransaction`; it accepts ordinary bounded addresses,
not a transaction, authorized context, proof, receipt, cache or callback. Reuse
the exact existing address limit, allowed pairs, context/header guards, parsing,
ordered nullable results and duplicate-address behavior. No new fallback,
filtering, schema, lock or capability policy.

Shipping replaces only the four prerequisite reads with one call in the same
address order. Header-before-selector, prerequisite checks, later Shipping read,
intent capture, actual atomic-stage reauthorization/application/final proof,
operation/root/lot/document/support locks, receipt publication and awaited
COMMIT stay unchanged. Existing standalone journal entries remain independent.

The four separately timed preflight snapshots become one coherent snapshot.
This observation change is explicit and limited to ordinary preflight reads.
It does not promise current facts at completion or permit carrying authority
into later writes: capture and the atomic stage recheck actual current state.
A real change after preflight must still deny or fail that later guarded work,
with no accepted stale Shipping receipt. Preserve original driver errors and
ordinary prerequisite/corruption namespaces; inspect simultaneous-fault ordering
before claiming identical statement scheduling.

Intent capture remains a separate committed mutation. If capture succeeds but
later atomic work rejects changed state, the pending revision-1 intent and its
original operation key may remain. Assert atomic business rollback against the
post-capture snapshot or account for exactly that journal delta; do not move
capture into the atomic stage to satisfy a blanket pre-initialize no-write test.

## Required evidence

Add native reader coverage for exact ordered results, nulls, duplicate addresses,
empty/max/overflow bounds, malformed addresses, header/definition/row corruption,
wrong tenant/database/user/actor/profile and denial before hostile addresses.
Use actual saved journal rows and native guards, not mocked checked results.
Add Shipping tests for each missing/pending prerequisite and actual drift or
membership/profile change committed between preflight and atomic work. Assert
the exact error, intent/key semantics, complete rollback or no writes and all
public-table snapshots. Retain existing Shipping seed/verify/projection/locks
and origin-status assertions, writer barriers and deadlines.

Compare actual forwarding query counts, outputs, guard calls, phase times and
no-write replay against the scalar predecessor on equivalent owned fixtures at
indices 0/1/181/259 and a small populated range. Counts must include transaction
and reference costs; raw SQL parameters and credentials must not be logged.
Record early-failure paths, uncertainty and every failed run. Normal owned-child
drain/drop/independent absence and strict native CI selection are mandatory.

Implementation requires its own reviewed plan and serial source/native slot
after current Cases acceptance. No change to original full262 test/fixtures,
900000/60000 or other deadlines, checks, public routes, dependencies, environment
files, RU/main/Station, Requests, PR, release or hosting. The full Trace gate
remains RED until its unchanged actual execution passes at the changed SHA.
