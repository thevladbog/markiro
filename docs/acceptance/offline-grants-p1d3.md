# Offline grants P1D.3 acceptance ledger

**Scope:** selective two-operator rollback from confirmed strict activation to observe.

## Implemented behavior

- Platform-authenticated candidate, list, detail, prepare, confirm and cancel routes.
- Exact selection of one to 200 active activation IDs; clients cannot supply tenant,
  subscription, device, credential, assignment, configuration or policy authority.
- Thirty-minute immutable preparation, request replay and second-operator confirmation.
- Fresh confirmation-time drift checks and durable `needs_review` without partial mutation.
- Approved observe policy plus terminal rollback provenance for selected activations.
- Active strict priority and hash-verified observe fallback after rollback.
- SaaS Admin selection and recovery of uncertain prepare, confirm and cancel attempts.
- Unchanged tariffs, subscription plan identity, prior grants, task sources and evidence rows.

## Automated evidence

The following checks passed locally on the final worktree:

- `corepack pnpm@11.22.0 --filter @markiro/platform-contracts test`: 33 files and
  333 tests passed;
- `DATABASE_URL=<isolated-postgres> corepack pnpm@11.22.0 --filter @markiro/db test`:
  105 files and 556 tests passed;
- the complete migration chain, including 0155 and 0156, applied to a fresh isolated
  PostgreSQL 17 database; all three additive activation foreign keys were validated;
- seven changed API suites covering route capabilities, OpenAPI inventory, digest
  stability, policy overlays and the database-backed activation-to-rollback flow: 49 tests
  passed with no skips;
- `corepack pnpm@11.22.0 --filter @markiro/api typecheck`, `lint` and `build`;
- `corepack pnpm@11.22.0 --filter @markiro/saas-admin test`: 47 files and 487 tests
  passed, together with package typecheck, lint and build;
- database and platform-contract package typecheck, lint and build;
- `corepack pnpm@11.22.0 test:production-bundle:contract`: 564 tests passed;
- `corepack pnpm@11.22.0 format:check` and `git diff --check`.

A full API run was also attempted. It was not counted as passed: 265 files passed,
100 were skipped and 12 failed because the ad hoc command did not provide the complete
cabinet/platform test environment; one independent commercial-report test also observed
the reused database state. Every API suite changed by P1D.3 was rerun with the complete
test environment and passed as recorded above.

## External gates not run

- production deployment and production database migration;
- selection or confirmation of a real customer cohort;
- authenticated refresh on deployed Station, Handheld or kiosk devices;
- Windows, scanner, printer, kiosk hardware and interrupted-network acceptance;
- customer acceptance and observation of production telemetry.
- full Station, kiosk and Handheld compatibility suites, because the native configuration
  contract is unchanged and no native source changed;
- the broad Turbo workspace gate and Graphify update; this isolated worktree has no local
  `graphify-out` graph.
