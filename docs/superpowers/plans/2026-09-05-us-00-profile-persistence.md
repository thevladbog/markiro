# US-00 profile persistence implementation plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven-development for this coupled schema/store increment. The owner authorized continuous local implementation. No commit, publication, merge or release is included.

**Goal:** Persist an explicitly provisioned US profile and timezone atomically, with fresh tenant-settings authorization and exact audit evidence.

**Architecture:** Add the shared profile table without changing existing table defaults. A US-only internal API service validates strict input and authorizes against current membership before reading or provisioning. It is not mounted in the HTTP composition until the separate US session boundary exists.

**Tech Stack:** Existing PostgreSQL 17, Drizzle, Zod, NestJS and Vitest; no new dependency.

**Spec:** `docs/us/mvp-contract.md`, `docs/superpowers/specs/2026-09-03-us-00-regulatory-profile-design.md`, `docs/us/development-isolation.md`.

## Global constraints

- Work only in `codex/us-mvp`; retain every release lock and existing edit.
- Use only the standalone US PostgreSQL on loopback port 55432 and synthetic fixtures. No primary environment, database or credentials.
- Retention is calendar years: default 5, minimum 2; no purge job.
- Reuse `org_profiles.time_zone`; preserve the existing RU default unchanged. Initial US provisioning requires an explicit valid IANA zone.
- US accepts only `US_FSMA204_PROCESSOR` or `US_GENERIC_LOT_TRACEABILITY`; baseline ID is server-owned `US-REG-2026-09-03`.
- This increment provides initial provisioning and idempotent retry, not settings edits or profile switching. A different input against an existing profile conflicts. Later mutation endpoints must enforce record locks and audit changes.
- HTTP remains metadata-only with readiness 503. No login/session, user creation, frontend or hosted persistence is claimed.

## Task 1: Schema and strict provisioning contract

Files: `packages/db/src/schema/traceability.ts`, schema export, Drizzle configuration, next migration and metadata; `packages/platform-contracts/src/traceability/profile.ts`, public export; focused tests in both packages.

Interfaces: `schema.traceabilityProfiles`, `provisionUsTraceabilityProfileSchema`, `ProvisionUsTraceabilityProfileInput`.

- [x] Write tests that reject an absent schema, missing/blank US baseline, retention below two, a second tenant profile, RU input, client-owned baseline/tenant fields and invalid/missing timezone.
- [x] Run focused tests and observe the missing behavior fail.
- [x] Add the table with explicit code (no code default), tenant PK/FK, user FK with SET NULL, timestamps, baseline and retention checks. Generate the next migration; add RU backfill for pre-existing organizations with their creation timestamp. Never rewrite applied migrations.
- [x] Add the strict US input schema with required timezone and optional retention. Example: `provisionUsTraceabilityProfileSchema.parse({ code: "US_FSMA204_PROCESSOR", timeZone: "America/Chicago" })` returns retention 5.
- [x] Run package gates, inspect generated SQL for unrelated changes, and apply the actual migration chain only to the separate synthetic US test database.

## Task 2: Transactional internal provisioning and real database proof

Files: `apps/api/src/modules/traceability/profile/us-profile-store.ts`, `apps/api/test/us-profile-store.e2e.test.ts`, test-only isolated database support if needed.

Interfaces: `new UsProfileStore(db: Db)`; `read(tenantId: string, actorUserId: string)`; `provision(tenantId: string, actorUserId: string, input: unknown, requestId: string)`; both return the persisted profile summary with ISO effective timestamp and timezone.

- [x] Write real database tests: missing profile returns 503; wrong tenant, unknown actor and manager fail settings authorization; initial provisioning stores code/baseline/timezone/retention and exact audit; identical retries and concurrent identical requests produce one profile and one audit; conflicting retries fail without changing data; validation failures leave no partial rows; membership revocation is observed on the next call.
- [x] Run the tests before implementation.
- [x] Inside one transaction reload and lock membership; require existing `tenant.settings.manage`; lock the organization row to serialize first provisioning. Read only tenant-scoped rows. On first write insert profile, upsert timezone and append `traceability.profile.updated` success audit with exact before/after and request ID. Return 409 on nonidentical existing configuration, and 503 when stored profile/timezone is invalid for US. Do not mount a controller or add database providers to the metadata-only runtime.
- [x] Run focused database/API tests, package typecheck/lint/build and runtime/isolation regressions. Add the deterministic US database test invocation to check-only CI, then review the diff and document actual coverage and remaining gates.

Example assertions:

```ts
expect(profile).toMatchObject({
  code: "US_FSMA204_PROCESSOR",
  retentionYears: 5,
  timeZone: "America/Chicago",
});
expect(audit).toMatchObject({
  organizationId: tenantId,
  actorUserId,
  action: "traceability.profile.updated",
  outcome: "success",
  targetType: "tenant",
  targetId: tenantId,
  before: null,
  requestId: "us-profile-test",
});
```

## Verification — 2026-09-05

- The schema test failed on the missing table before implementation; contract/store tests initially failed to resolve their not-yet-created modules. Focused contract coverage passes 14 cases; store coverage passes 17 cases, including a PostgreSQL trigger that forces audit failure and proves rollback of profile and timezone writes.
- Real migration upgrade from 0112 with two historical synthetic organizations passes; full-chain fresh migration also passes. Snapshot comparison confirms only the new table and enum were added, with no semantic changes to existing tables/enums. Applied migrations were not edited.
- Full `@markiro/db` regression: **356 passed, zero failed or skipped, 66 files**, on a disposable US PostgreSQL database. Full contracts: **95 passed, 12 files**. Domain regression: **532 passed, 37 files**.
- Focused API regression after the rollback case: **76 passed, 5 files** (profile store, deployment entry, US HTTP, environment and health). Full API regression on a separate disposable database: **2,861 passed, 2 failed, 50 skipped, 277 files**; this run collected the original 16 profile cases before the added rollback case. Both failures were in existing signer-agent tests because the synthetic US environment intentionally has no CHZ encryption key. A targeted retry with a test-only synthetic key passed all **7 signer-agent tests**. No signer configuration was added to the US runtime or tracked US environment. The original full run is not relabelled as a zero-failure run.
- Remaining API skips include opt-in local mail/storage smoke, live National Catalog, dedicated inventory-test configuration and CHZ/signer suites requiring their own test settings. No external service or hardware acceptance is claimed.
- API, DB and contracts typechecks, lint and builds pass. Full-worktree formatting, diff checks, all 11 release-isolation tests, the release checker and all 3 compiled-runtime smoke cases pass. Check-only CI includes an ephemeral US PostgreSQL service and explicit migration/store tests; hosted CI execution has not been run.
- Independent source review found no actionable findings. All disposable US profile/regression databases were removed; the retained base `markiro_us_dev` database was not migrated or reset. The separate local US PostgreSQL container and its development volume remain available. No primary checkout, primary database, remote settings, commit, push, merge, release or deployment was changed.

## Next boundary

Implement a US-specific session/auth composition and fresh tenant/user provisioning before registering profile HTTP routes. Preserve separate cookies/origins and reject RU sessions; do not reuse the RU auth factory's Station/public API-key plugins or RU mail fallback. Add the traceability role/capability mapping and then the EN/ES application entry. Initial profile provisioning is not a profile-edit endpoint; mutation and record-lock rules remain separate acceptance work.
