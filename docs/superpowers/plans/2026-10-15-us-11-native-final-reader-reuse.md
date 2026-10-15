# US-11 native final-reader reuse plan

Spec: `docs/superpowers/specs/2026-10-15-us-11-native-final-reader-reuse.md`.
Base: `cd8a564746d9a588161e790ac85fe863e6466d6a`.

## Global constraints

All original tests, fixtures, counters, default5000 bodies, 60000 hooks and
900000 full body stay byte-identical. No shared authorization cache, application
reuse, proof injection, skipped validation, release, main/RU/Station or deployment.
Preserve three excluded hosting/worker documents and all ignored prior evidence.

## Task 1: native final-reader integration

Use existing Shipping raw-reader ownership as the implementation reference.
Introduce only private shared mechanics behind named final-verifier entry points.
Wire Receiving, Transformation and Cases final callbacks, including corrected
variants where their actual lock evidence supports it. Keep unsupported Special
observations fresh. Preserve original default lock queries and the closed adapter
inventory. After a successful existing lock, protect only the keys it actually
covered; retain full values on the first original point getter, not from ID rows.
No correction projection or changes to public Trace sequencing in this task.

Production scope: US demo seed/final-verifier/lock/read-contract modules only.
Do not edit general domain serializers, application services, migrations, public
HTTP/runtime contracts or CI selectors. Add a focused test file and, only when
needed for that new source location, additive ownership coverage without
removing any existing mutant/denial case. Controller owns canonical docs and Git.

The meaningful performance RED is the preserved four CI timeout failures.
First write focused reuse/lifecycle tests, then implement. Run focused tests and
API typecheck/lint/build plus exact formatting/ownership checks serially. One
independent delta review follows; no historical packet or unchanged whole-branch
review is repeated. Do not commit, push, spawn agents or launch broad native/API
regressions from the implementation agent.

## Task 2: controller acceptance and delivery

After the scoped source review, run unchanged whole12 and whole17 on this changed
candidate, serially, preserving exact results and normal owned cleanup. Run only
affected regressions before scoped US push. Same-SHA CI provides the original
full260+2 and comprehensive mandatory verification. No green claim before actual
completion, and no increase of any timeout or relaxation of an assertion.
