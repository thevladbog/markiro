# US-11 native assembly contract CI ownership

Status: execute under the owner's standing approval, with a separate implementer,
task review and independent final review. No publication is authorized.

## Outcome and boundary

The pure native assembly input contract is currently collected by aggregate API
tests, but US branch pushes run an explicit selection which omits it. Add one
dedicated unconditional check-only owner for this suite to `us-development.yml`.
This is CI wiring, not native assembly or proof of installed demo data.

The owner is named `Verify pure native dataset assembly input` and runs exactly
`corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-native-assembly-contract.test.ts --maxWorkers=1`.
It has only `name` and `run`, no environment, condition or ignored failure. Put it
after the existing shared/domain and API dependency builds. Preserve all other
workflow bytes, read-only permissions, triggers, release locks and the 30-minute
budget. Do not add a database URL or execute native suites in this new owner.

## Ownership evidence

Add a focused parsed-YAML ownership contract which rejects removal, duplication,
conditional or non-executable commands, ignored failure, added environments,
wrong build ordering, permissions or budget drift. Explicit selection is globally
unique; aggregate API collection remains allowed and is not exclusive execution.
Mutate fresh parsed workflows and assert the intended diagnostic for each break.
Removing only the new raw owner must restore the exact current predecessor bytes
and parsed workflow, pinned before implementation. Historical ownership suites
may strip this one new owner when checking their predecessor, but their original
hashes and all existing mutation assertions must remain unchanged.

The full Node suite identified seven additional historical predecessor checkers
inside `tools/us-development/test/isolation.test.mjs`. Apply the same exact-owner
normalization there, without repinning hashes or weakening any mutation assertion.

Avoid copying the hundreds-of-lines historical ownership implementations. A small
focused checker with table-driven mutations is sufficient. If normalization is
shared, it must remove only this exact complete new owner, never broadly filter
unknown future steps. The new owner has its own exact and negative evidence.

## Out of scope

Do not change native assembly production code or its existing API test, the shared
JSON guard, DB fixtures, migrations, runtime, HTTP/UI, dependencies, env files or
release workflows. The previously noted combined-size negative case can fail for
multiple reasons; it is not isolated mutation evidence for the byte guard. Keep
that limitation explicit rather than adding mocks or claiming new native proof.
Full native coordinator, six-month population, trace/readiness, Plan and Requests
acceptance remain subsequent work. No push, PR, deployment or cleanup.
