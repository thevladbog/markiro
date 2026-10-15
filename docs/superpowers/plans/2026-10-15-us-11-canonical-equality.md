# US-11 canonical equality implementation plan

Spec: `docs/superpowers/specs/2026-10-15-us-11-canonical-equality.md`.
Base: `042f77bf961e353b19b4ed14f67665bade6aaf26`.

1. One implementer adds focused failing domain tests, then the pure equality
   helper/export. Keep canonical serialization and digest implementations intact.
   Convert only direct digest-vs-digest equality in US demo sources; preserve
   every persisted hash and mismatch/error boundary. No other optimization.
2. Implementer runs domain tests/typecheck/lint/build, changed-source formatting
   and API typecheck/lint/build serially. Report exact RED/GREEN evidence and the
   changed paths. No broad native run, commit or push from implementer.
3. Independent scoped review checks input-validation equivalence, call-site
   substitutions and unchanged stored-digest/SQL/test boundaries. No repeated
   whole-branch review or parallel builds/database tests.
4. Controller runs original whole12/whole17 once on the changed candidate.
   Only if their original deadlines pass proceed to affected regressions/full API,
   scoped US push and exact-SHA CI including original full262. If still red,
   preserve evidence and reject completion; no unchanged retry or deadline change.

No main/RU/Station changes, release/deployment, unrelated cleanup or excluded-doc
changes. Preserve all prior raw evidence and the three untracked user documents.

After the first28/29 result, extend only digest import routing to the existing
server helper. Implementer writes RED routing coverage, changes imports only,
runs existing canonical differential tests and API statics, and hands off a scoped
delta review. No serializer/hash body or original test edits. Controller adds new
routing plus existing Node canonical tests to the current pure-recipe CI step,
preserving its previous selections and ownership/mutation checks. Only then run
unchanged whole12/whole17 once for this further-changed candidate. No broad/full262
run or push while any original short acceptance remains red.

The routing candidate remains28/29. A reviewed one-shot current-worker CPU capture
justifies one narrow Special record-ID increment under the appended design. Add
one RED native witness with an actual parsed result for private provenance,
exact IDs, fresh frozen arrays and untrusted clone/proxy/frozen/mutated rejection;
implement only the result provenance and record-ID extraction branch in the
Special module. Both parsers keep their full validation/fresh-copy behavior.
Run the new test and unchanged adjacent codec tests, API statics, then
independent delta review. Do not broaden to mutable reference outputs or database
freshness. The extra filtered M11 run failed with a cold owner4232ms versus2796ms
in the original whole-suite workload; it is not a like-for-like performance gate.
Retain that failure, but use the unchanged original whole29 once on this changed
candidate for acceptance before broader API and exact-SHA CI. Do not repeat either
failed invocation unchanged or alter original deadlines.

Following the failed changed whole29 and rejected slower JSON prototype, implement
only the appended owned-canonical-byte design. One executor writes failing pure
ownership/cache/context/intrinsic differential tests, then the server helper,
existing-owned-copy substitutions and imports-only server routing. Keep other
declarations and all original tests intact. Run unchanged frozen canonical tests,
new tests and API statics serially; independent review the exact new delta. New
pure tests stay in the already-added routing test file so CI ownership stays
unchanged. Controller runs original whole29 once only after this substantive
increment and review; no additional cold filtered gate or serializer probe.

## Local acceptance, 2026-10-15

- Independent source review approved the final owned-byte increment.
- Canonical differential/routing/cache tests: 3 files, 83 passed. Domain package:
  67 files, 1434 passed. CI tooling: 186 passed. API typecheck, lint and build passed.
- Original composition/coordinator files: 29/29 passed in 105.48 seconds, with
  unchanged deadlines and assertions. M11's complete body took 4933.985 ms against
  its original 5000 ms limit; this is a narrow local margin, not CI acceptance.
- Full API validation in an invocation-owned database: 331 files / 4779 tests
  passed; 189 files / 3952 opt-in tests skipped. Exit 0, 145 migrations applied,
  normal DROP verified, zero new databases remaining, service listener closed.
- Original full 260-chain verification and the complete prepared-services group
  remain separate exact-SHA GitHub CI gates. No release or deployment is included.
