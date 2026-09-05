# US development isolation

Status: development-only, release locked. Approved 2026-09-05.

## Branch boundary

Develop on `codex/us-mvp` in the existing isolated worktree. The directory may retain its original name, `.worktrees/us-docs-audit`. Do not merge this branch into `main`, create release tags, publish images/installers, or deploy it until development is complete and the owner explicitly approves a separate release-enablement change.

Bring reviewed updates from `main` into this branch, never the reverse while the lock is active. Preserve local edits before synchronizing. No automatic merge or release is configured. The main checkout and its production workflows are not changed by this work.

## Release lock

Every job in the ten inherited operational workflows has an unconditional false job condition. This includes production image publication, web deployments, Station/Signer publication and repair, infrastructure, administrator provisioning and production diagnostics. Their concurrency groups use a US-only prefix so a manual dispatch cannot cancel or occupy the main production queue.

The ordinary CI and dependency review remain read-only. `US development isolation` runs on pushes to `codex/us-mvp`, pull requests and manual dispatch. It validates the lock and tests the shared domain foundation and isolated API entry without production environments, secrets, publication or deployment. A pull request targeting `main` fails the isolation check. New executable operational workflows, re-enabled jobs, write tokens and secret-bearing check jobs fail validation.

Run locally from this worktree:

```sh
node tools/us-development/check-isolation.mjs
node --test tools/us-development/test/*.test.mjs
```

This is a versioned workflow guard against accidental publication, not a security boundary against a maintainer deliberately editing workflows or running deployment scripts directly. Do not run inherited production/infra/release scripts from this worktree. GitHub rulesets, environment branch restrictions, required checks and repository settings have not been changed or verified remotely. Publishing the branch requires separate authorization; the lock is local until the changed files are committed and pushed. Release-enablement must be a reviewed code change, not a dispatch input or environment-variable override.

In particular, never dispatch the infrastructure workflow from `main` with a US commit in `target_sha`. The inherited main workflow can check out that explicit SHA without consulting this branch's job conditions; its dispatch-ref and checkout-SHA checks are not an ancestry restriction. Closing that repository-wide path requires a separately scoped change to main and/or remote protections. The branch-local lock does not claim to close it.

## Isolated local dependencies

Use only synthetic data. Never copy the primary checkout's `.env`, database, volumes, backups or credentials. `deploy/us-development/compose.yml` is a standalone dependency stack, not an overlay on production or the normal development stack:

| Surface               | US local endpoint | Isolation                                                   |
| --------------------- | ----------------- | ----------------------------------------------------------- |
| PostgreSQL            | `127.0.0.1:55432` | Database `markiro_us_dev`, separate user and project volume |
| S3-compatible storage | `127.0.0.1:19000` | Bucket `markiro-us-development`, separate project volume    |
| Storage console       | `127.0.0.1:19001` | Loopback only                                               |
| SMTP capture          | `127.0.0.1:11025` | Mailpit, no external SMTP delivery                          |
| Mail UI               | `127.0.0.1:18025` | Separate project volume, loopback only                      |

The fixed Compose project is `markiro-us-development`. Do not override it with `-p`, `COMPOSE_PROJECT_NAME`, external volumes, or additional Compose files. Do not run the normal `docker-compose.dev.yml` for US work. After local validation, dependencies can be started explicitly with:

```sh
docker compose --env-file /dev/null -f deploy/us-development/compose.yml up -d postgres mailpit minio
docker compose --env-file /dev/null -f deploy/us-development/compose.yml run --rm minio-init
```

`local.env.example` in the same directory contains matching synthetic loopback settings. A personal copy belongs at the ignored `.env.us-development`; never overwrite an existing file. Application ports are reserved as API `3100`, admin `5174` and platform admin `5474`. No containers or application servers are started by the isolation checker itself; the separately invoked runtime smoke test starts and stops a loopback-only API.

## Local API entry

The US executable is separate from the RU application composition. It requires explicit matching US edition settings, development/test mode and the isolated loopback addresses above. It rejects missing or incompatible values before creating the application. The existing RU executable rejects an explicit US edition before auth or database setup; its legacy unset-edition behavior is preserved.

Build and run from the US worktree root using Node 24 or newer:

```sh
pnpm turbo build --filter '@markiro/api...'
env -i "$(command -v node)" --env-file=deploy/us-development/local.env.example apps/api/dist/main.us.js
```

The clean child environment prevents inherited primary credentials, Node preload options or shell settings from overriding the synthetic example. Do not load the primary `.env`. Metadata and liveness start without dependency containers; auth and profile operations require the isolated PostgreSQL schema. Startup never migrates or seeds it. The process binds to `127.0.0.1:3100`; stop it with Ctrl-C. Use the configured `BETTER_AUTH_URL` hostname for auth/profile requests: `localhost` and `127.0.0.1` are not interchangeable authorities or cookie scopes.

| Endpoint                                            | Result                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /deployment`                                   | US edition, release disabled, `en-US` / `es-US` locale metadata    |
| `GET /health/live`                                  | 200, process alive                                                 |
| `GET /health/ready`                                 | 503, `us_business_modules_not_ready`                               |
| Allowed `/api/us-auth/*` methods                    | US session/MFA and organization selection; no public signup        |
| `GET /traceability/profile`                         | MFA and settings capability required; absent profile returns 503   |
| `PUT /traceability/profile`                         | Initial profile provisioning; identical retry returns the original |
| RU business, auth and not-yet-implemented US routes | 404                                                                |

Only the US auth/profile composition and its owned database pool are registered; no RU auth factory, scheduler or outbound client is loaded. Business requests enforce the configured Host, trusted mutation Origin, JSON-only bodies up to 16 KiB and `Cache-Control: no-store`. Forwarding headers are not trusted. Missing/incompatible database tables fail closed with a sanitized 503; no automatic repair runs. The pool uses server-side statement cancellation and closes with the application.

Readiness deliberately remains unavailable while other business modules are unfinished. The [separate US browser entry](browser-entry.md) now adds an isolated build and server edition attestation; matching environment values alone are not proof of frontend isolation. Local synthetic-owner provisioning is explicit, never automatic. Recovery remains unavailable. Do not connect the RU admin to this API.

Profile tenant and actor are derived from the verified session, never client IDs. Every request reloads membership; the store checks settings capability within its transaction. `PUT` accepts only `code`, explicit IANA `timeZone` and optional `retentionYears` (default 5). The server fixes the baseline and timestamps. Identical retries create no extra audit event; a different configuration returns 409. This is initial provisioning, not profile switching or settings editing. Every HTTP request gets a fresh server-generated request ID; profile creation records that ID in its atomic audit event.

After building, `node --test tools/us-development/test/runtime-entry.smoke.mjs` exercises the actual executables, including rejection and graceful shutdown. It temporarily reserves port 3100; stop a manually running US API before this check.

## Isolated profile persistence tests

The US profile store has both direct persistence and real HTTP integration tests. Start only the US PostgreSQL service above, build `@markiro/db` and `@markiro/platform-contracts`, then run from the US worktree root:

```sh
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/db exec vitest run test/traceability-profile-migration.e2e.test.ts
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/api exec vitest run test/us-profile-store.e2e.test.ts
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/api exec vitest run test/us-http.e2e.test.ts
```

These fixtures never consume `DATABASE_URL`. They validate the loopback port, base database and user, then create their own randomly named `markiro_us_profile_*` databases, apply the migration chain and remove only the databases created by that invocation. They do not migrate or reset the base `markiro_us_dev` database. Without the explicit US test variable, database cases skip. The check-only US workflow supplies its own ephemeral PostgreSQL and runs these cases explicitly.

The local US PostgreSQL service was started for synthetic verification on 2026-09-05. The primary PostgreSQL container was not modified; mail and object-storage services were not started. This is local development evidence, not hosted infrastructure or production-data geography evidence.

All future hosted US persistence and infrastructure must remain outside the Russian Federation, per the shared MVP contract. No hosted environment is created in this increment.

## US session foundation

The independent auth factory uses `/api/us-auth` and `markiro-us` cookies. It is mounted in the isolated US executable through the allowlisted wrapper and tested over real loopback HTTP against disposable US PostgreSQL. Do not mount the raw Better Auth handler: the wrapper limits paths/methods and requires a trusted Origin for mutations. Raw library error logging is disabled because adapter errors can contain credential-bearing SQL parameters; unexpected failures become a sanitized 503.

- Public signup, organization creation, Station/API keys, RU mail and platform-auth routes are absent from the allowed surface.
- Password-only sessions may enroll a TOTP authenticator. Organization discovery and selection require verified MFA; tenant operations additionally reload active membership and their specific capability.
- Every login requires a fresh TOTP or one-use backup-code challenge. Trusted-device and sessionless verification are disabled. Old password sessions must sign in again after enrollment; they cannot inherit another session's assurance.
- MFA enrollment is insert-only. Concurrent requests cannot replace an existing factor. Replacement, lost-enrollment recovery and account provisioning are not available in this increment.
- Pending enrollment locks for 15 minutes after ten failed codes. Login challenge limits remain enforced by Better Auth. Local request limiting is explicitly enabled; caller-supplied forwarding headers are ignored, so requests share a per-path bucket. The HTTP mount must preserve a reviewed source-IP boundary before changing this local policy.
- Migration `0114_us_session_assurance.sql` adds an opt-in flag to cabinet users and two US-only tables. Existing users default to MFA disabled; existing RU auth behavior is unchanged. Assurance is removed with its session or factor. The separate US database remains mandatory; a cookie prefix is not a substitute for infrastructure or secret isolation.

Run the focused checks after building `@markiro/db`:

```sh
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/db exec vitest run test/us-auth-schema.test.ts test/us-auth-migration.e2e.test.ts
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev pnpm --filter @markiro/api exec vitest run test/us-auth.e2e.test.ts
```

The browser interface and explicit local synthetic-user provisioning were added in subsequent increments; see [browser entry verification](browser-entry.md). Recovery delivery, production TLS/cookies, audit of authentication events, and hosted operation are not proven by these tests. The base development database remains unprovisioned; test fixtures create users only in their own disposable databases. See the [session foundation plan](../superpowers/plans/2026-09-05-us-00-session-foundation.md) and [HTTP integration record](../superpowers/plans/2026-09-05-us-00-http-integration.md) for scope and verification results.

## Verification — 2026-09-05

- 11 isolation tests pass, including mutation cases for re-enabled publication, an unknown operational workflow, privileged checks and a removed/bypassed checker. The initial unprotected configuration failed the new tests before implementation.
- The broader contract run exercised 1,137 tests: 1,125 passed initially; 11 sandbox-dependent failures passed targeted retries with local access (7 HTTP health checks, 3 disposable Caddy adapter checks, 1 pnpm dependency graph check). One disposable S3 bootstrap migration smoke test remains explicitly skipped because the sandbox denied its listener. No real cloud migration was attempted.
- Domain regression: 532 tests in 37 files, source/test typechecks and build pass. Full-worktree formatting, scoped JavaScript lint, documentation consistency and diff checks pass.
- Docker Compose configuration validation passed before startup. The later profile/session increments started only US PostgreSQL, as recorded above. Caddy validation used temporary read-only test config, not a deployed application.
- Independent review found no blocking issues; its main-selected SHA caveat is documented above. Main-checkout workflow diffs are empty; existing CI, dependency-review workflow and dependency manifests/lockfile are unchanged.
- No commit, push, release, cloud configuration or production operation was performed. Migration tests apply SQL only to their own disposable local databases; the base US database is not migrated. Remote enforcement and live workflow execution are not verified.

## Before release enablement

The [local synthetic-owner command](local-owner-provisioning.md) is now implemented as an explicit CLI, not a startup action or HTTP route. It creates only the reserved local identity, organization, membership and audit, with no profile or MFA bypass. Base database initialization and actual invocation against that base were not performed; integration tests use disposable databases. The [browser access/profile flow](browser-entry.md) is implemented locally. Recovery, auth-event audit and remaining business modules are still open.

The subsequent metadata-only API increment is recorded in the [runtime entry plan](../superpowers/plans/2026-09-05-us-00-runtime-entry.md). The [profile persistence plan](../superpowers/plans/2026-09-05-us-00-profile-persistence.md) adds real isolated PostgreSQL verification: all 356 DB tests pass; the broader API run passed 2,861 tests, with two signer configuration failures passing a targeted synthetic-key retry and 50 explicitly skipped cases. These local results do not change the release lock or establish HTTP/session, hosted or external-service readiness.

Complete the P0 acceptance gates; verify runtime edition isolation and every persistent surface; review auth/locales and generated artifacts; approve the target infrastructure and secrets; then design and test a separate US release workflow. Do not restore the inherited RU deployment destinations for a US release. Enabling release and merging shared changes are separate decisions.
