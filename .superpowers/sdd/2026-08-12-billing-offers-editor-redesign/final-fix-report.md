# Final fix report — billing and offer editors

## Status

`DONE_WITH_CONCERNS`

All six final-review findings were reproduced or confirmed in the current
`099ae14e` tree and fixed without a schema change. The affected focused tests,
full UI and SaaS-admin suites, package typechecks, lints, and builds pass. The
full API suite cannot be treated as green in this worktree because it has no
`.env`: environment-dependent suites failed before product assertions, and two
loopback suites were denied by the sandbox. The focused affected API unit tests
pass.

## Behavior changed

- Catalog-backed offer draft lines retain `catalogUnitPrice` and an optional
  `priceOverrideReason`. Changing the agreed price exposes a localized reason
  field, blocks offer submission until the reason is non-blank, and serializes
  both values to the offer API. Catalog-less/custom invoice snapshots retain
  null catalog metadata and do not acquire an override requirement.
- `PlatformOffersService.create` validates every referenced catalog version
  inside the creation transaction before any insert. Missing, wrong-kind, or
  non-published references fail with stable code
  `offer_catalog_version_invalid`; a shared row lock closes the validation to
  retirement race for the duration of the insert transaction.
- Source-offer invoice drafts remain catalog-backed only when the currently
  published version has the same kind, Russian and English names, and unit as
  the stored offer snapshot. Any mismatch or unavailable publication becomes a
  `custom` invoice line with a null catalog reference, preserving literal line
  fields. Ordinary lines newly selected from the invoice catalog remain
  catalog-backed.
- Quantity, price, and price-override inputs now point through
  `aria-describedby` to their exact inline validation errors.
- `Combobox` requires caller-supplied `loadingText`; all SaaS-admin callers use
  localized copy.
- Prettier was run on the three requested branch-owned failures:
  `documentDraft.ts`, `document-draft.test.ts`, and `Combobox.tsx`. The four
  unrelated existing plan/spec formatting failures were not modified.

## TDD evidence

- Offer draft metadata and snapshot mapping RED: focused SaaS-admin run failed
  five assertions because catalog price/reason were absent and published-ID
  snapshots stayed catalog-backed. GREEN: 3 files / 30 tests passed.
- Combobox localization RED: loading test expected caller text but rendered the
  hard-coded English string. GREEN: 1 file / 6 tests passed.
- Accessible inline errors RED: the override reason field was absent and
  quantity/price errors had no described-by relationship. GREEN is included in
  the 30-test focused SaaS-admin run.
- Backend retirement regression: the focused test verifies a retired version
  returns `offer_catalog_version_invalid` and the insert boundary is never
  reached. The backend snapshot characterization verifies a custom invoice
  line persists the literal offer name and unit.

## Automated verification

| Command | Result |
| --- | --- |
| `CI=true pnpm --filter @markiro/saas-admin exec vitest run test/document-draft.test.ts test/document-composer.test.tsx test/offer-editor.test.tsx` | PASS — 3 files, 30 tests |
| `CI=true pnpm --filter @markiro/ui exec vitest run test/combobox.test.tsx` | PASS — 1 file, 6 tests |
| `CI=true pnpm --filter @markiro/api exec vitest run test/platform-offers.service.test.ts test/billing-offer-snapshot.test.ts` | PASS — 2 files, 2 tests |
| `CI=true pnpm --filter @markiro/saas-admin test` | PASS — 12 files, 102 tests |
| `CI=true pnpm --filter @markiro/ui test` | PASS — 7 files, 140 tests |
| `pnpm --filter @markiro/saas-admin typecheck` | PASS |
| `pnpm --filter @markiro/ui typecheck` | PASS |
| `pnpm --filter @markiro/api typecheck` | PASS after building `@markiro/db`, `@markiro/domain`, and `@markiro/email` |
| affected package lints | PASS — API, SaaS-admin, UI |
| affected package builds | PASS — API, SaaS-admin, UI |
| scoped Prettier check for every changed source/test file | PASS |
| `git diff --check` | PASS |
| `CI=true pnpm format:check` | FAIL only on four pre-existing unrelated plan/spec Markdown files listed below |

The full environment-less API package run completed with 55 files / 507 tests
passing and 57 files / 706 tests skipped. Eight suites failed during setup:
six groups required missing `DATABASE_URL` and auth/pairing variables, while
health/OpenAPI loopback binding failed with `EPERM`. A second run could not load
`.env` because this isolated worktree has none, so it was stopped rather than
borrowing credentials or database state from another checkout.

## Remaining concerns and external checks

- Repository-wide formatting remains red only for these untouched existing
  files:
  - `docs/superpowers/plans/2026-08-11-tenant-billing-documents.md`
  - `docs/superpowers/plans/2026-08-12-billing-offers-editor-redesign.md`
  - `docs/superpowers/specs/2026-08-11-tenant-billing-documents-design.md`
  - `docs/superpowers/specs/2026-08-12-billing-offers-editor-redesign-design.md`
- No authenticated live API/database or new browser visual pass was performed
  in this final-fix wave. Route payload and interaction behavior are covered by
  the real-component Vitest suites; backend boundary behavior is covered by the
  focused service tests.

## Final fix round 2 — authoritative prices and literal invoice snapshots

### Status

`DONE_WITH_CONCERNS`

Both P1 review findings against `83bad1d9` were reproduced with focused failing
tests and fixed without a database schema change.

### Behavior changed

- The create-offer contract no longer accepts `catalogUnitPrice`; its strict
  line DTO rejects both null and forged client baselines. Inside the creation
  transaction, `PlatformOffersService` locks and loads the published catalog
  version's `unitPrice`, uses it as the persisted baseline, requires a nonblank
  reason when the agreed price differs, trims a valid reason, and persists a
  null reason when prices match.
- Offer detail parsing now retains descriptions, catalog baseline, and override
  reason. Source-offer invoice mapping compares kind, both names, unit, both
  descriptions, catalog baseline, VAT rate, and VAT-included intent against the
  current published version. Any mismatch becomes a custom line with a null
  catalog reference.
- Invoice draft/input handling now carries both descriptions and the literal
  catalog-price snapshot for custom source lines. `BillingService` distinguishes
  an explicitly null VAT rate from an omitted rate, persists null rather than
  `0.00`, and retains literal custom-line descriptions, baseline, prices, and
  totals. Newly selected catalog lines remain catalog-backed and continue to
  use server catalog authority.

### TDD evidence

- Offer authority RED: 7 focused failures proved null/forged client baselines
  were accepted, missing/null/blank reasons reached insertion, and inserted
  baselines/reasons came from the client. GREEN: the API focused run passes 9/9.
- Literal snapshot RED: the backend persisted explicit null VAT as `0.00`, the
  source-offer route retained a catalog reference despite distinct descriptions
  and null VAT, and the converted custom line dropped descriptions and catalog
  baseline. GREEN: the focused API and SaaS-admin runs pass.

### Automated verification

| Command | Result |
| --- | --- |
| `CI=true pnpm --filter @markiro/api exec vitest run test/platform-offers.service.test.ts test/billing-offer-snapshot.test.ts` | PASS — 2 files, 9 tests |
| `CI=true pnpm --filter @markiro/saas-admin exec vitest run test/document-draft.test.ts test/document-composer.test.tsx test/offer-editor.test.tsx` | PASS — 3 files, 31 tests |
| `CI=true pnpm --filter @markiro/saas-admin test` | PASS — 12 files, 103 tests |
| `pnpm --filter @markiro/api typecheck` | PASS |
| `pnpm --filter @markiro/saas-admin typecheck` | PASS |
| affected package lints | PASS — API and SaaS-admin |
| affected package builds | PASS — API and SaaS-admin |
| scoped Prettier check for changed source/test files | PASS |
| `git diff --check` | PASS |

The full API package run was not green in this environment: 55 files / 514
tests passed and 57 files / 706 tests skipped; seven suites failed because the
isolated worktree has no required database/auth environment, and the health and
OpenAPI loopback suites were denied with `listen EPERM`. These failures match the
prior final-fix environment limitation and did not reach changed product assertions.

### Remaining concerns and external checks

- No authenticated database-backed API e2e or live browser pass was available
  in this round. The affected server behavior is covered through real service
  and DTO code with a controlled transaction executor; the route flow is covered
  by the real-component SaaS-admin suite.
- Repository-wide formatting still has the four unrelated pre-existing
  plan/spec failures listed above; all round-two changed files are formatted.
