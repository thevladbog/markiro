# Task 10 report — production inventory document acceptance

## Implementation summary

- Added a DB-backed API acceptance scenario that switches the injectable test registry to
  `productionInventoryDocumentGeneratorRegistry` and selects exactly
  `inventory_xml_gismt_aggregation` v1 plus `inventory_xml_gismt_disaggregation` v1.
- Seeded representative repack source rows for eligible and protected KMs, old boxes, printed new
  boxes, and repack-item positions. The protected snapshot row carries the exact
  `sourceState: "MOVING_BY_UD"` boundary.
- Drove the real result loader and `InventoryDocumentRunnerService` from closed result revision 7
  through two stored XML artifacts, SHA-256 verification, individual presigned downloads, ZIP byte
  inspection, and exact `manifest.json` entries. The test verifies that the protected KM and both
  of its old/new SSCCs are absent from both XML files.
- Proved lifecycle behavior by reopening, invalidating both revision-7 artifacts, observing revision
  8 and old-download denial, closing again, regenerating both formats, downloading the revision-8
  ZIP, acknowledging the files, and completing the inventory.
- Corrected stale acceptance and architecture claims that the production registry was empty. Both
  documents now distinguish the approved XML slice from the still-unapproved and absent TXT, CSV,
  and XLSX formats; neither document claims complete v1 or external portal compatibility.
- No production implementation, schema, migration, OpenAPI snapshot, or unapproved format was
  added or changed.

## RED/GREEN evidence

### RED

After adding the production-lifecycle acceptance scenario, its registry assignment was deliberately
left as an empty `InventoryDocumentGeneratorRegistry`. The focused test reached the real
`POST /inventories/:id/document-runs` boundary and failed at the first functional assertion:
expected HTTP 201, received HTTP 400 because the two production format/version pairs were not
available from the injected registry. This was a test failure, not a TypeScript or fixture-loading
error.

### GREEN

The empty registry was replaced with the real `productionInventoryDocumentGeneratorRegistry`.
The identical focused command then passed 1/1, the complete document endpoint file passed 15/15,
and the production-format domain and runner regression suites passed 12/12 and 16/16 respectively.

An initial attempt before RED did not load the test because fresh-worktree workspace package output
had not been built. `corepack pnpm --filter '@markiro/api^...' build` restored the documented
workspace precondition; it is not counted as RED evidence. A separate early full-API attempt omitted
required `PLATFORM_*` test variables and consequently failed during environment loading; the
corrected full run below supplied the complete test environment.

## Exact test commands and outcomes

All database-backed commands used the disposable PostgreSQL 16 container
`markiro-inventory-doc-acceptance-task10` on loopback port 36091. Fresh databases were migrated
through the repository journal. No shared or production database was used. The disposable
container was removed after the final DB-backed verification.

```bash
corepack pnpm --filter '@markiro/api^...' build
# PASS

DATABASE_URL=postgresql://markiro_test:markiro_test@127.0.0.1:36091/markiro_inventory_documents \
  corepack pnpm --filter @markiro/db db:migrate
# PASS

DATABASE_URL=postgresql://markiro_test:markiro_test@127.0.0.1:36091/markiro_inventory_documents \
BETTER_AUTH_SECRET=insecure-test-placeholder-000 \
BETTER_AUTH_URL=http://127.0.0.1:3000 \
PLATFORM_AUTH_SECRET=insecure-platform-test-placeholder-000 \
PLATFORM_AUTH_URL=http://localhost:3001 \
SAAS_ADMIN_ORIGIN=http://localhost:5473 \
PAIRING_CODE_PEPPER=insecure-test-pairing-pepper \
  corepack pnpm --filter @markiro/api exec vitest run test/inventory-documents.e2e.test.ts \
  -t "runs both approved GISMT XML formats through the closed-revision API lifecycle and excludes MOVING_BY_UD"
# RED: 1 failed; expected 201, received 400 with an intentionally empty registry
# GREEN: 1 passed, 14 skipped after switching to the production registry

DATABASE_URL=postgresql://markiro_test:markiro_test@127.0.0.1:36091/markiro_inventory_documents \
BETTER_AUTH_SECRET=insecure-test-placeholder-000 \
BETTER_AUTH_URL=http://127.0.0.1:3000 \
PLATFORM_AUTH_SECRET=insecure-platform-test-placeholder-000 \
PLATFORM_AUTH_URL=http://localhost:3001 \
SAAS_ADMIN_ORIGIN=http://localhost:5473 \
PAIRING_CODE_PEPPER=insecure-test-pairing-pepper \
  corepack pnpm --filter @markiro/api exec vitest run test/inventory-documents.e2e.test.ts
# PASS: 1 file, 15 tests

corepack pnpm --filter @markiro/domain exec vitest run \
  test/inventory-documents.test.ts test/inventory-document-generators.test.ts
# PASS: 2 files, 12 tests

DATABASE_URL=postgresql://markiro_test:markiro_test@127.0.0.1:36091/markiro_inventory_documents \
  corepack pnpm --filter @markiro/api exec vitest run test/inventory-document-runner.test.ts
# PASS: 1 file, 16 tests
```

Package gates:

```bash
corepack pnpm --filter @markiro/domain test
# PASS: 30 files, 409 tests
corepack pnpm --filter @markiro/domain typecheck
corepack pnpm --filter @markiro/domain lint
corepack pnpm --filter @markiro/domain build
# PASS

DATABASE_URL=postgresql://markiro_test:markiro_test@127.0.0.1:36091/markiro_inventory_documents_full \
  corepack pnpm --filter @markiro/db test
# PASS: 41 files, 258 tests
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/db lint
corepack pnpm --filter @markiro/db build
# PASS

corepack pnpm --filter @markiro/admin test
# PASS: 71 files, 752 tests
corepack pnpm --filter @markiro/admin typecheck
corepack pnpm --filter @markiro/admin lint
corepack pnpm --filter @markiro/admin build
# PASS; lint retained 5 inherited hook warnings and 0 errors

corepack pnpm --filter @markiro/station test
# PASS: 83 files, 1194 tests
corepack pnpm --filter @markiro/station typecheck
corepack pnpm --filter @markiro/station lint
corepack pnpm --filter @markiro/station build
# PASS

corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
# PASS

NODE_ENV=test \
DATABASE_URL=postgresql://markiro_test:markiro_test@127.0.0.1:36091/markiro_inventory_documents_api \
INVENTORY_TEST_DATABASE_URL=postgresql://markiro_test:markiro_test@127.0.0.1:36091/markiro_inventory_documents_api \
BETTER_AUTH_SECRET=insecure-test-placeholder-000 \
BETTER_AUTH_URL=http://127.0.0.1:3000 \
PLATFORM_AUTH_SECRET=insecure-platform-test-placeholder-000 \
PLATFORM_AUTH_URL=http://localhost:3001 \
SAAS_ADMIN_ORIGIN=http://localhost:5473 \
PAIRING_CODE_PEPPER=insecure-test-pairing-pepper \
  corepack pnpm --filter @markiro/api test
# First correct-environment full run: 204 files passed, 1 failed, 1 skipped;
# 2092 tests passed, 1 failed, 2 skipped. The sole failure was an isolated HTTP 404 in
# billing-profiles-http.test.ts.

NODE_ENV=test \
DATABASE_URL=postgresql://markiro_test:markiro_test@127.0.0.1:36091/markiro_inventory_documents_api \
INVENTORY_TEST_DATABASE_URL=postgresql://markiro_test:markiro_test@127.0.0.1:36091/markiro_inventory_documents_api \
BETTER_AUTH_SECRET=insecure-test-placeholder-000 \
BETTER_AUTH_URL=http://127.0.0.1:3000 \
PLATFORM_AUTH_SECRET=insecure-platform-test-placeholder-000 \
PLATFORM_AUTH_URL=http://localhost:3001 \
SAAS_ADMIN_ORIGIN=http://localhost:5473 \
PAIRING_CODE_PEPPER=insecure-test-pairing-pepper \
  corepack pnpm --filter @markiro/api exec vitest run test/billing-profiles-http.test.ts
# PASS: 1 file, 3 tests

NODE_ENV=test \
DATABASE_URL=postgresql://markiro_test:markiro_test@127.0.0.1:36091/markiro_inventory_documents_api_retry \
INVENTORY_TEST_DATABASE_URL=postgresql://markiro_test:markiro_test@127.0.0.1:36091/markiro_inventory_documents_api_retry \
BETTER_AUTH_SECRET=insecure-test-placeholder-000 \
BETTER_AUTH_URL=http://127.0.0.1:3000 \
PLATFORM_AUTH_SECRET=insecure-platform-test-placeholder-000 \
PLATFORM_AUTH_URL=http://localhost:3001 \
SAAS_ADMIN_ORIGIN=http://localhost:5473 \
PAIRING_CODE_PEPPER=insecure-test-pairing-pepper \
  corepack pnpm --filter @markiro/api test
# PASS: 205 files passed, 1 skipped; 2093 tests passed, 2 skipped
# Duration: 305.97 seconds

corepack pnpm format:check
# PASS: all matched files use Prettier formatting
git diff --check
# PASS
graphify update .
# PASS: local ignored AST graph refreshed; existing Astro syntax warnings reported
```

The expected API skips are the environment-gated local Mailpit/MinIO lifecycle and the explicit
real-command local-infrastructure smoke. The inventory document boundary used in-memory private
storage to inspect exact bytes and presigned paths; it did not exercise a live S3-compatible
service.

## Files changed

- `apps/api/test/inventory-documents.e2e.test.ts`
- `docs/acceptance/inventory-admin.md`
- `docs/architecture.md`
- `.superpowers/sdd/2026-08-24-inventory-admin-reconciliation-documents/task-10-report.md`

## Self-review

- The new acceptance uses the production registry object and production generators, not copied or
  synthetic XML generators.
- Both exact approved IDs and immutable version 1 are selected; no TXT/CSV/XLSX descriptor or
  generator is invented.
- Source evidence contains eligible and protected repack paths, both old and new SSCCs, and an exact
  `MOVING_BY_UD` source state. Positive assertions prove eligible content is emitted; negative
  assertions prove protected content is absent from both outputs.
- Artifact evidence is checked independently in database metadata, stored bytes, individual
  download responses, ZIP entries, manifest fields, SHA-256 digests, and revision lifecycle.
- The injectable registry is restored in `finally`, so existing synthetic failure/lifecycle tests
  remain isolated.
- Documentation preserves explicit automated, browser, storage, portal, Windows, scanner, printer,
  touch, and customer-acceptance boundaries.
- The final diff contains no production behavior, schema, generated output, or unrelated changes.

## Concerns

- Automated XSD and byte-level checks do not prove that the live Chestny ZNAK/GIS MT portal accepts
  the generated XML. Manual portal upload remains release evidence to collect.
- Private publication, presigning, reconciliation, retention, and cleanup were not exercised
  against the deployment's real S3-compatible service.
- Windows packaging, two physical stations, HID/serial scanning, printing and barcode readability,
  offline/restart recovery, touch/gloves, and customer acceptance were not run.
- TXT, CSV, and XLSX inventory contracts remain unapproved and absent, so the wider complete-v1
  document gate remains NOT PASSED.
- The first correctly configured full API run observed one unrelated `billing-profiles-http` 404
  under parallel load. Its immediate focused rerun passed 3/3, and the subsequent full run on a
  second fresh database passed all runnable tests. No task-scoped failure remains, but the isolated
  flake is recorded rather than hidden.
