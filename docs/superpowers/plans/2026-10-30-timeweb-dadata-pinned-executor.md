# Pin the reviewed DaData configuration executor

Status: implementation refinement of the approved configuration successor.
Adding an exact tag to the protected environment source policy requires separate
user authorization after the concrete source, CI and rule are reviewable.

## Observed admission failure

PR #842 merged as `5411be87a6659a84270bf3325cbccca0724f7cd6`.
While its full main-push CI ran, unrelated standalone PR #840 advanced main to
`47b3d9ba7198206f0f48fc69dff7aaad3428dfdd`. No deployment source changed.
The successor requires both the current main tip and a complete platform CI for
that same SHA. A standalone-only push skips the required platform jobs. Neither
an older full run nor a newer skipped job can satisfy this contract.

## Fixed authority

Permit the existing main path and one strict tag form:
`configuration-dadata-<full executor SHA>`. For a tag execution, require all of:

- The exact reviewed executor C was a main-push CI source at attempt 1, with every
  existing required platform job actually successful. Do not reuse CI for another
  SHA, accept skipped jobs, dispatch substitute CI, or rerun production workflows.
- A lightweight tag with that exact name resolves directly to commit C; the
  native workflow dispatch head and checked-out source are also C.
- C remains an ancestor of main. Main may advance without revoking this exact
  reviewed source. A moved tag, nonancestor, annotated tag, arbitrary branch,
  wildcard or source mismatch is rejected before host mutation.
- The native protected environment still independently approves this exact run;
  its reviewers, prevent-self-review and bypass settings remain unchanged.
- All existing private source closure, operation/plan, CI, runtime, host lock,
  container, schema, catalog, retained-worker and rollback checks remain enforced.

The tag points to the new reviewed implementation containing this fix, not the
older main-only implementation. Never relabel old code or CI as new code.

## Implementation and checks

1. Add focused failing tests for exact tag dispatch/source authority and deny all
   malformed, moved, annotated, unrelated and mismatched refs.
2. Add a narrow source-authority verifier and wire it into configuration transport,
   host authorization and workflow ref admission. Avoid expanding legacy bundles
   or changing catalog/upgrade dispatch behavior.
3. Update the runbook and private preparation operator to pin the same reviewed C,
   exact tag and full CI; preserve main behavior for existing tests/callers.
4. Run focused contracts, source-closure tests and production bundle contracts;
   independently review the full diff. Merge through normal required checks, then
   require the new exact main-push CI and CodeQL. Preserve all previous receipts.
5. Prepare the exact lightweight tag and inspect the existing environment rules.
   Present C, CI, tag and the single-rule diff for user authorization before
   writing the environment policy. No wildcard, reviewer or privilege changes.
6. Only after that rule is authorized and verified, stage the immutable DaData
   operation, audit it under the shared lock, and dispatch this exact tag once.
   Obtain independent native approval and complete the existing post-deploy
   compiled-client, invariant and authenticated UI checks.

## Boundary

This refinement changes executor admission, not the accepted product/image,
credentials, database, migration, catalogs, DNS, cloud IAM or nightly schedule.
No production runtime or protected-environment policy has been changed.
