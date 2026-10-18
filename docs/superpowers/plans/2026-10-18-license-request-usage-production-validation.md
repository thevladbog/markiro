# License request usage statistics: production integration

## Scope

This change ports the reviewed license-request statistics flow from the standalone
work to the current production branch, based on `84f2213057037eb90751c1b91027ab9a8f052192`.
The source change covers API licensing/diagnostics, SaaS-admin registration, and the
shared activation-export contract. It adds no PostgreSQL migration or runtime variable.
The existing offline-assignment issuance path and migrations through `0196` remain intact.

Activation exports may carry an optional encrypted `MKS1` support token. Inspection
ingests it through the existing diagnostics service, updates tenant statistics, and
returns the ingest result. Tenant ownership, platform capability checks, host binding,
explicit acknowledgment for an unbound host, duplicate detection, and snapshot freshness
remain enforced. The token is removed before registration persistence and cleared from
the SaaS-admin mutation cache when the registration dialog closes or unmounts. Legacy
activation requests remain accepted; the strict host activation protocol is unchanged.

## Local validation

All checks use an isolated package installation and a new disposable PostgreSQL 17
container bound only to loopback. The database was migrated with the current runtime
migrator through `0196_invoice_document_variants`. No existing database or `.env` file
was modified. API tests use public `.env.example` defaults with the disposable database
and a public deterministic test-only Chestny ZNAK encryption key.

- Platform-contracts: 41 test files, 419 tests passed; typecheck, lint, build passed.
- Focused API: 6 files, 71 tests passed, including license issuance, site registration,
  diagnostics ingestion, route access, and generated OpenAPI contract checks.
- API typecheck, lint, and build passed.
- SaaS-admin: 66 test files passed, 1 skipped; 676 tests passed, 10 skipped.
  The skips belong to the existing disabled support-chat feature (`support-episodes.test.tsx`);
  they do not exercise this license-request change. Typecheck, lint, and build passed.
- The full API package run is still in progress at commit preparation. This document
  does not claim it passed; the release operator must inspect its completion before merge.
- Repository-wide `pnpm format:check` passed; `git diff --check` passed.

`turbo` initially resolved a globally installed older pnpm executable. Dependency
builds were rerun successfully with direct Corepack package commands using the declared
pnpm 11.22.0. No package-manager policy, dependency manifest, or lockfile was changed.

## Release boundary

Deploy the API and SaaS-admin changes together before publishing a standalone build
that emits enriched activation exports. Verify that production
`STANDALONE_SUPPORT_KEYS_JSON` contains the private key matching the client's bundled
support public key (`sup-d11c3182` for the current build), without displaying secrets.
The existing runtime inventory already supports this optional variable. An absent or
unusable key prevents ingestion; source tests alone do not prove the production key.

Local automated checks do not prove production deployment, live browser behavior,
external services, or Windows and factory hardware. Those checks belong to their
respective release and acceptance procedures.
