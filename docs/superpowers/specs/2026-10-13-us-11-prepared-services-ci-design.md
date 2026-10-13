# US-11 prepared services: explicit native CI ownership

Status: selected for implementation under the user's standing implementation approval. Source review and actual same-SHA CI acceptance remain separate gates.

## Intent and evidence

Complete the isolated synthetic demo without weakening its verification. Independent review of Request creation at `153a8341c` approved the service implementation but identified an Important missing native CI selector. Inspection of `.github/workflows/us-development.yml` at that commit confirms four new suites have no explicit fixture-enabled selection:

- `test/us-plan-draft-transaction.e2e.test.ts`
- `test/us-dataset-prepared-intent.e2e.test.ts`
- `test/us-dataset-plan-seed.e2e.test.ts`
- `test/us-request-create-transaction.e2e.test.ts`

Their local native results are not substitutes for CI coverage. Ordinary API collection intentionally skips these suites without `US_TEST_DATABASE_URL`.

## Selected boundary

Append exactly one `dataset_prepared_services` job to the US workflow. It depends on successful `isolation`, owns a fresh PostgreSQL 17 service and selects exactly these four suites serially. Preserve the six original matrix segments, all 82 original steps, existing Trace job, release guards, pinned actions, deadlines and assertions.

Adding the files to the existing full Trace command would couple unrelated service evidence to its constrained execution budget. Adding them to a matrix segment would alter the historical ownership boundary. A separate job makes ownership explicit without increasing any timeout.

The new job follows the existing dedicated Trace job's pinned checkout/pnpm/Node 24 setup, frozen install, contracts build before Node tooling, release-isolation check, all Node tooling tests, and API dependency build before native execution. Its timeout is 30 minutes. Add PDF text extraction before native execution using the existing installation command because the approved Plan suite exercises real PDF bytes. No production environment, secrets, deployment, retries, `always()`, `continue-on-error`, fixture aliases, test-name filters or fail-open collection.

Native command:

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-plan-draft-transaction.e2e.test.ts test/us-dataset-prepared-intent.e2e.test.ts test/us-dataset-plan-seed.e2e.test.ts test/us-request-create-transaction.e2e.test.ts --maxWorkers=1
```

Only native-step environment:

```text
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
```

Service credentials and localhost port match the existing disposable CI fixture; no `DATABASE_URL`, existing/shared business database or external provider is selected.

## Strict historical normalization

Create `support/prepared-services-owner.mjs` with the complete exact parsed job and raw appended block. `withoutPreparedServicesOwner(workflow)` returns a clone, removing the job only when the entire job is exact. `withoutPreparedServicesOwnerBytes(source)` removes only the unique complete exact block at EOF after verifying its parsed job. Malformed, duplicate or altered additions remain visible.

Compose this removal before existing Trace removal in `parallel-segments.mjs`. In the Trace ownership test normalize only this exact reviewed addition before its historical job-key, byte and parsed predecessor assertions. Preserve global Trace selector uniqueness over the actual complete workflows. Do not relax Trace's own normalizer, rewrite predecessor hashes or allow arbitrary third jobs. Tests must reject a malformed prepared job through both new ownership and historical checks. Removing the exact prepared block must recover the entire `153a8341c` workflow bytes unchanged.

## Independent executable ownership proof

Create `dataset-prepared-services-ownership.test.mjs`. Independently pin the four filenames and literal command, complete job, order, unique global job/step/explicit file selectors, disposable service, environment and historical predecessor. Do not derive expected selectors only from the helper under test.

Prove denial for missing/foreign/duplicate/renamed owner, missing/duplicated/filtered suites, changed dependencies, failure bypass, build-order reversal, unsafe environment or service, changed actions, extra properties, larger budgets, old matrix/Trace/release changes and altered raw bytes. Pure Node failures are the meaningful RED; no local heavy native rerun is required just to wire already-executed native suites.

Verify each actual suite has exactly one `describe.skipIf` fixture gate. Permit either direct `process.env.US_TEST_DATABASE_URL` or a unique top-level const identifier initialized exactly from that expression; resolve identifiers structurally, never by accepting arbitrary expressions. Exercise missing and present environment evaluation and negative source mutants. Keep ordinary API aggregate collection fixture-free. Reuse a narrow shared gate helper only if it removes duplication while preserving all previous Trace assertions; extracting it is not permission for broad test refactoring.

## Acceptance and non-goals

All Node tooling tests, exact workflow normalization, focused formatting and diff checks must pass. Independent task and complete selected-plan source reviews must approve. Actual same-SHA GitHub native execution must pass before closing the Request coverage finding or claiming these services accepted remotely. A current successful predecessor run cannot cover a subsequently added job.

No backend semantics, native test bodies, migrations, test budgets, package/dependency configuration, RU/main/Station, release workflows, PR, deployment or hosting changes. A failed new job requires exact log diagnosis, not assertion weakening, timeout expansion or unchanged retries.
