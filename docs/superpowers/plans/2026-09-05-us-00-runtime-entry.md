# US-00 isolated runtime entry implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this tightly coupled runtime increment; follow test-driven-development. The user authorized continuous execution. No publication or merge is authorized.

**Goal:** Start a loopback-only US development API without constructing the RU application or its workers, and reject a US configuration at the RU entry point.

**Architecture:** Separate `main.us.ts` and `UsDevelopmentModule` in the existing API package. Share the domain edition parser, but keep the existing RU composition unchanged. A public metadata endpoint identifies the edition; liveness proves the process, while readiness reports the unfinished business application explicitly as unavailable.

**Tech Stack:** Existing NestJS, Express, Zod, Vitest and TypeScript. No new dependency.

**Spec:** `docs/us/mvp-contract.md`, `docs/us/development-isolation.md`, `docs/superpowers/specs/2026-09-03-us-00-regulatory-profile-design.md`.

## Global constraints

- Branch `codex/us-mvp`; preserve all existing edits and release locks.
- US startup requires explicit `MARKIRO_DEPLOYMENT_EDITION=US`, `NODE_ENV=development` or `test`, and the isolated loopback dependency configuration. Production startup is prohibited until release enablement.
- Do not register RU controllers, Better Auth, database connections, schedulers or outbound clients in this first boundary increment. Their US integration requires subsequent profile/auth work, not a permissive fallback.
- UI locales are `en-US` and `es-US`; metadata contains no secrets or infrastructure URLs.
- Existing RU entry retains its unspecified-edition legacy behavior, but an explicitly supplied edition must be RU. US never receives that fallback.
- This increment does not implement the login UI, tenant provisioning, persistent profiles, business routes or hosted data-location verification. It is a runnable isolation boundary, not a completed US-00 slice.

## Task 1: Validated entry-point configuration

Files: create `apps/api/src/deployment/entry-policy.ts`, `apps/api/test/deployment-entry.test.ts`; modify `apps/api/src/main.ts`.

Interfaces:

```ts
assertRuEntryEdition(value: unknown): void;
loadUsDevelopmentEnv(raw: NodeJS.ProcessEnv): Env;
```

- [x] Write literal tests: US with missing/invalid edition fails; production mode fails; a primary database, storage or SMTP address fails; explicit RU entry plus US fails; the tracked synthetic US example passes.
- [x] Run `pnpm --filter @markiro/api exec vitest run test/deployment-entry.test.ts` and observe the missing behavior fail.
- [x] Reuse `parseDeploymentEdition`; validate the critical raw fields before `loadEnv` can supply legacy defaults. For every URL assert loopback host, exact scheme/port/database or bucket, and no query/fragment; never include input values in thrown errors.
- [x] Call `assertRuEntryEdition(process.env.MARKIRO_DEPLOYMENT_EDITION)` before `loadEnv` and `setupAuth` in the RU bootstrap. Rerun focused and existing env tests.

Example behavior:

```ts
expect(() => assertRuEntryEdition("US")).toThrow();
expect(() => assertRuEntryEdition(undefined)).not.toThrow();
expect(() => loadUsDevelopmentEnv({ ...fixture, NODE_ENV: "production" })).toThrow();
```

## Task 2: Runnable US composition and HTTP proof

Files: create `apps/api/src/deployment/us-development.module.ts`, `apps/api/src/deployment/us-bootstrap.ts`, `apps/api/src/main.us.ts`, `apps/api/test/us-development.e2e.test.ts`; add explicit API development/start scripts in `apps/api/package.json`.

Interfaces:

```ts
createUsDevelopmentApplication(raw: NodeJS.ProcessEnv): Promise<INestApplication>;
```

- [x] Write HTTP tests using the existing one-listener loopback helper: metadata identifies US and EN/ES without secrets; liveness is 200; readiness is 503 with `us_business_modules_not_ready`; RU routes and auth routes return 404 for representative methods and paths.
- [x] Run the tests before implementation.
- [x] Create a standalone Nest module with only deployment metadata and development health controllers; `NestFactory.create` is reached only after configuration validation. Bind the executable to `127.0.0.1`, enable shutdown hooks and close on startup failure. No RU module imports.
- [x] Run focused tests, API typecheck/lint/build, existing env and health tests, domain regressions, workflow isolation check, full formatting and diff checks. Verify a compiled child process answers HTTP and rejects invalid configuration before listening. Report unavailable infrastructure gates separately.

Example HTTP expectations:

```ts
await request(server).get("/deployment").expect(200);
await request(server).get("/health/ready").expect(503);
await request(server).post("/1c_exchange").expect(404);
await request(server).get("/api/auth/get-session").expect(404);
```

## Completion boundary

Keep everything local and unreleased. Next work is persistent US profile/provisioning and a US-specific auth/session composition, followed by the EN/ES entry and tenant shell. Do not point the existing RU admin at this API or claim production readiness from its liveness endpoint.

## Verification — 2026-09-05

- The initial test runs failed to resolve the not-yet-created entry/module. Subsequent configuration assertions exposed missing frontend-edition validation, and the HTTP test exposed a permissive CORS response header; both were corrected before the green run.
- 98 tests pass across deployment entry, US HTTP, environment, mail environment, storage environment and existing health suites. Of these, 45 exercise the new configuration and HTTP boundary.
- All 3 compiled-executable smoke tests pass: RU rejects US before setup, US rejects production/missing edition, and the loopback API answers with the expected metadata and shuts down cleanly. No database or outbound clients are required.
- API typecheck, lint and build pass; scoped tool lint, full-worktree formatting and diff checks pass. Domain regression passes all 532 tests; all 11 release-isolation tests and the checker pass.
- The full API run is **not green**: 165 files passed, 8 failed and 103 skipped; 1,484 tests passed and 1,411 skipped. Existing database/auth suites evaluate missing required environment settings, with a secondary uninitialized cleanup failure. The shared environment loader and those tests were not changed. No primary credentials or database were used to force this gate green. An isolated database-backed run remains required before profile/auth integration can be accepted.
- Independent read-only source review found no actionable runtime issues. No frontend/browser, persistent database, hosted region or live workflow verification is claimed. No commit, push, merge, release or deployment was performed.
