# US session foundation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a separately configured, locally tested US password/TOTP boundary before exposing tenant data over HTTP.

**Architecture:** Use the existing identity model in the separate US database, but an independent Better Auth factory with no RU auth factory, Station keys, public registration or mail integrations. Store MFA assurance per session and factor, not merely per user. Keep this foundation unmounted until its authentication and tenant boundary have been tested together.

**Tech Stack:** Existing Better Auth 1.6.23, Drizzle/PostgreSQL, Vitest; no dependency changes.

**Spec:** `docs/superpowers/specs/2026-09-03-us-00-regulatory-profile-design.md` and `docs/us/development-isolation.md`.

## Global constraints

- Continue in `codex/us-mvp`; no push, PR, merge, release or deployment.
- Use only synthetic identities and disposable databases on the US loopback PostgreSQL instance.
- English and Spanish are the US interface locales; no RU integration or session acceptance.
- Add migrations; do not rewrite existing migrations or alter the main checkout.

### Task 1: Persist factor and session assurance

**Files:** `packages/db/src/schema/auth.ts`, new `schema/us-auth.ts`, schema export and Drizzle configuration, migration 0114; `apps/api/test/us-auth.e2e.test.ts`.

**Interfaces:** Add `user.twoFactorEnabled` (default false); export `usTwoFactors` and `usSessionAssurances`. Assurance stores session ID and factor ID with cascading foreign keys.

- [x] Write and run focused failing schema tests for the opt-in flag and assurance tables; then exercise the migration on real PostgreSQL.
- [x] Add the additive schema and generate/review migration 0114. Existing identities retain password behavior; only the US factory loads the two-factor plugin.
- [x] Apply the complete migration chain to a disposable database and verify defaults and cascades.

```ts
expect(identity.twoFactorEnabled).toBe(false);
expect(await db.select().from(schema.usSessionAssurances)).toEqual([]);
```

### Task 2: Isolated auth and assured principal

**Files:** new `apps/api/src/modules/traceability/auth/us-auth.ts`, `us-auth-adapter.ts`, `us-auth-error.ts`, `us-principal.ts`; auth integration test and test helper.

**Interfaces:** `createUsAuth(db, { secret, baseURL, trustedOrigins })` returns the independent auth instance; `resolveUsPrincipal(db, auth, headers)` returns `{ userId, tenantId, sessionId }` or a 401/403 error. `handleUsAuth(auth, request)` exposes an exact route/method allowlist and requires a trusted Origin for every mutation.

- [x] Write failing tests for password-only denial, TOTP enrollment and subsequent login, old pre-enrollment sessions, wrong credentials, origin denial and route isolation.
- [x] Implement `/api/us-auth`, `markiro-us` cookies, disabled signup/organization creation, TOTP/backup verification. Record assurance only after successful verification on the actual current/new session.
- [x] Join fresh session, user, verified factor, assurance and active membership when resolving a principal. Never accept a client-supplied actor or tenant. Factor replacement invalidates old assurance through its foreign key.
- [x] Verify revoked sessions/memberships, missing factor, failed OTP and renamed RU cookies cannot authorize access.

```ts
await expect(resolveUsPrincipal(db, auth, passwordHeaders)).rejects.toMatchObject({ status: 403 });
expect(await resolveUsPrincipal(db, auth, verifiedHeaders)).toEqual({
  userId,
  tenantId,
  sessionId,
});
```

### Task 3: Review and verification

**Files:** US CI workflow, development-isolation documentation, this plan.

- [x] Include the auth integration suite in the existing check-only US workflow.
- [x] Run DB/API typecheck, lint and build; focused real database suites; release isolation and compiled runtime tests; formatting and diff checks.
- [x] Obtain an independent security-focused code review and address verified findings.
- [x] Record tested behavior and limits. The running US entry remains metadata-only; provisioning, mounted HTTP auth/profile routes, recovery delivery and browser UI are separate increments. Leave changes local and uncommitted.

## Implementation and verification — 2026-09-05

- The schema tests failed before implementation. Real migration tests insert legacy identities before applying 0114 and verify the new defaults, factor uniqueness and cascading foreign keys. Snapshot comparison confirms only two added tables and one added user field; prior enums and migrations are unchanged.
- All 360 DB tests pass across 68 files with zero skips on an isolated disposable database. The first broader run exposed a historical test using the live user model against migration 0073. Its fixture now inserts only the historical user columns, consistent with its existing historical product/inventory fixtures. No old migration changed.
- Focused API regression passes 101 tests across six files, including 25 real auth tests and 17 real profile-store tests. The DB migration/schema subset passes seven tests. DB/API typecheck, lint and build pass; full-worktree formatting and diff checks pass.
- The broader API run passed 2,911 tests but failed setup of one historical 0094 fixture, which also inserted users through the current model. A targeted reproduction confirmed the missing 0114 column; its fixture now inserts historical columns only. The final retry of this migration plus current US auth/profile suites passes all 43 tests. The original broader run is not claimed as green, and predates the last two explicit-secret tests (covered by the final focused runs).
- The broader run also skipped 25 cases: 22 require `INVENTORY_TEST_DATABASE_URL`, two require local Mailpit/MinIO opt-in, and one requires live National Catalog configuration. The historical fixture's setup failure was reported as another skipped test by the JSON reporter, but is a failure, not an environment skip.
- A separate disposable-database retry supplied `INVENTORY_TEST_DATABASE_URL` and passed all 22 inventory tests with zero skips. Only the two local-mail/object-storage checks and the live National Catalog check remain unexercised; those services were not started or contacted. This targeted evidence does not retroactively change the original broader run result.
- Eleven release-isolation tests and three compiled runtime smoke tests pass. The compiled US entry still exposes metadata/health only and reports business readiness unavailable. Main-checkout changes and the dependency lockfile were not modified by this increment.
- Security review identified authenticated-session MFA attempt bypass and incompatible trusted-device behavior in the installed library. Failing tests reproduced both. Verification now denies enrolled users' old sessions, applies persistent pending-enrollment lockout, rejects trusted-device/sessionless shortcuts, and gates organization discovery/selection on assurance. Repeat review found no blocking issues. Recovery after the 15-minute lock is tested, as is atomic concurrent enrollment and explicit-secret validation.
- The local limiter is deliberately process-local with a shared per-path bucket and no trusted forwarding headers. Multi-instance throttling, reviewed source-IP extraction, account provisioning, auth-event audit, recovery delivery, browser UI and hosted TLS/cookie behavior remain outside this unmounted foundation.
- All work remains local on `codex/us-mvp`. No commit, push, PR, merge, deployment or external account mutation was performed. Temporary test databases are removed by their fixtures; the US PostgreSQL container and its unmigrated base database remain for development.
- Final read-only verification found only `markiro_us_dev` among the US server's `markiro_*` databases and zero public tables in that base database. The primary checkout retains only its pre-existing untracked design/export/screenshot files.
