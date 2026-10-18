# Timeweb Offline Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a tested platform-only server package for the offline product, ready for later Timeweb migration without touching deployed systems.

**Architecture:** Keep the current stack and historical data. Add an explicit `SERVER_PROFILE=platform-only` composition for API, jobs and deployment, with `legacy` retained for old tests/recovery. The SaaS build selects the matching `VITE_SERVER_PROFILE=platform-only`; both production profile values are pinned by the new delivery recipe.

**Tech Stack:** NestJS, TypeScript, PostgreSQL, pg-boss, React/Vite, Astro, Caddy, Docker Compose, Node contract tests and Vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-timeweb-offline-control-plane-design.md` (approved 2026-10-18).

## Global Constraints

- No server/DNS/production changes, provisioning, publication, push, merge or release dispatch.
- Existing mail for `markiro.app` is in Timeweb; no MX changes or credentials in source.
- `v-b.tech` is not required in the new delivery package. CRM / n8n / Chatwoot migration and landing redesign are later work.
- Preserve historical PostgreSQL data and applied migrations; no destructive schema cleanup.
- Preserve license formats, issuer/kid/trust, issuance sequence, diagnostic decryption and tenant isolation.
- No new dependency or lockfile changes. Use Node 24 and `corepack pnpm`.
- Legacy routes/workers must be absent in platform-only, including direct API access. Platform capability guards remain enforced.
- Prepare explicit opt-in delivery files while existing deployed legacy recipes remain reproducible; no implicit change to a running host.
- Review uncommitted changes without committing unless the user subsequently authorizes commits. Shared checkout has unrelated work; use the existing clean task worktree.

## Review Focus

- Restored mail jobs already enqueued before switching must not send cabinet links; test at delivery consumption, not only enqueue (Task 2).
- Valid platform admin manually invokes cabinet-grant/proposal endpoints despite hidden UI; test backend rejection and no mutation (Task 1).
- A new process boots against a restored DB containing cloud cron and jobs; no cloud reconciliation/worker execution, valid platform readiness (Task 2).
- Wrong/missing build/runtime profile accidentally exposes legacy UI/API; new bundle pins profile and rejects unknown values (Tasks 1, 3, 4).
- Historical statistics mistaken for current offline usage, and existing licenses no longer trusted; preserve values with explicit source/date, test issuance/diagnostics unchanged (Tasks 1, 3).

## Task 1: Platform API composition and protected write boundaries

**Files:** Create `apps/api/src/server-profile.ts` and profile-focused tests. Modify `env.ts`, `main.ts`, `app.module.ts`, `auth/auth.setup.ts` / `auth.module.ts` as needed, platform tenant and support controllers/services. Read `apps/api/AGENTS.md`.

**Interfaces:** `ServerProfile = "legacy" | "platform-only"`; `Env.SERVER_PROFILE` validated enum with legacy default for existing tests/tools. New deployment pins platform-only. `isPlatformOnly(profile: ServerProfile): boolean` is the shared predicate if useful; no independent ad-hoc env reads in controllers. Provide profile through DI for runtime guards. Main selects composition before mounting auth/parsers/OpenAPI.

- [x] Add failing tests: platform-only env starts without cabinet auth/pepper; unknown profile fails; legacy still requires its secrets.
- [x] Add failing route tests: no cabinet/device/public-integration endpoints in actual platform composition; platform/license/diagnostics/public form remain; cabinet creation, grant and owner-activation renewal rejected with safe `410` code before mutation; support proposal POST rejected, reads/retry-sync remain.
- [x] Split DB/pool provisioning from cabinet auth construction enough to avoid building/mounting cabinet auth in platform-only. Reuse guards, services and existing DB tokens rather than duplicating commercial rules.
- [x] Register only required modules in platform-only: auth, tenants/catalog/commercial/license/diagnostic/report/operations, storage/mail/demo/subscriptions, platform support reads. Exclude national-catalog actions and old grant-readiness/device modules.
- [x] Keep boot tests executable using synthetic external dependencies; update route inventory and OpenAPI assertions for each profile.
- [x] Run focused env/profile/routes tests; typecheck. Record any temporary jobs integration dependency for Task 2, not a claim of ready bootstrap.

## Task 2: Platform workers, recovered mail and readiness

**Files:** Modify `apps/api/src/jobs/jobs.module.ts`, health wiring, mail module/jobs, support-chat module/jobs as needed; add focused platform jobs/mail tests. Prefer a separate `platform-jobs.service.ts` over expanding the already large cloud runner.

**Interfaces:** Consume `Env.SERVER_PROFILE`. Health and consumers resolve a minimal job service contract with `checkReady(): Promise<void>` and required platform enqueue methods. Preserve existing `PgBossService` injection token where consumers depend on it via provider alias/factory; no unsafe runtime casts.

- [x] Write failing tests capturing registered worker/cron names and boot repair calls. Platform set includes mail delivery/dispatch/reconcile/retention, subscription state, platform report build/repair, and optional support transcript sync only. Cloud jobs are never registered or replayed.
- [x] Implement separate platform composition using the same queue names for allowed jobs; ensure stale cloud schedules cannot execute and document lifecycle without deleting queued history.
- [x] Add failing recovered-mail tests for cabinet activation, invitation/reset/verification and cabinet billing links. Allow platform activation/reset and landing notifications. Disambiguate shared kinds using validated payload destination and/or existing ownership metadata, never a permissive fallback.
- [x] At consumption, cancel disabled intents durably with `server_profile_disabled` reason and existing audit/event pattern, retaining historical metadata. Enqueue/reconcile must not resurrect cancelled deliveries. Keep advisory locks/idempotence and encryption handling.
- [x] Disable cloud support delivery/escalation repair while allowing transcript sync/retry. Preserve pending proposal history without auto acceptance/execution.
- [x] Readiness counts the exact allowed workers and verifies DB, SMTP and storage as before. Run actual platform app bootstrap test after Tasks 1+2 together.
- [x] Run focused jobs/mail tests, API tests and typecheck/lint/build. DB tests use an isolated disposable database if available; never shared `.env`/DB.

## Task 3: SaaS interface and minimum landing navigation

**Files:** `apps/saas-admin/src/server-profile.ts` (new), Vite env declarations/config as needed, tenant creation/detail controls, support proposal UI, national-catalog routes/navigation, relevant RU/EN i18n and tests. Landing links only where currently leading to disabled cabinet.

**Interfaces:** Build-time `VITE_SERVER_PROFILE` validated as legacy/platform-only, legacy fallback for existing development/test recipe; new edge pins platform-only. Backend remains authoritative. Do not alter strict principal capability shapes.

- [x] Add failing UI tests for platform-only creation payload `cabinetAccess: none`, absence of grant/renew activation and support proposal controls, unavailable national catalog direct route, readable old support episode. Hide legacy offline-station grant readiness/activation/rollback panels in `CatalogPage.tsx` (these are cloud-connected Station grants, not standalone licenses); retain standalone issuance and commercial catalog editors.
- [x] Implement profile-aware UI with localized retirement/historical notices. Preserve license sites, issuance, diagnostic source/timestamp, billing/catalog and document operations.
- [x] Explicitly label persisted cloud metrics as historical; retain separate offline snapshot values and unknown state. Do not rewrite existing API metrics or invent live values.
- [x] Remove/replace broken cabinet CTAs for the platform-only landing build, without redesigning content. Keep locale, legal links and primary landing domain.
- [x] Run SaaS focused and full package tests/typecheck/lint/build; landing affected tests/build. Verify profile via targeted rendered UI/browser where feasible.

## Task 4: Portable delivery package, CI and runbook

**Files:** Add dedicated files under `deploy/platform/` for Compose, Caddy, edge Dockerfile, env example, preflight and smoke contracts. Reuse immutable release/manifest tooling from `deploy/production`; modify `.github/workflows/release-images.yml`, `deploy-production.yml`, `tools/ci/affected.mjs` and tests only as required to build/verify/select the new bundle. Add `docs/runbooks/timeweb-platform-preparation.md`.

**Interfaces:** Package explicitly pins `SERVER_PROFILE=platform-only` and `VITE_SERVER_PROFILE=platform-only`; requires API/edge digest, private DB/S3 and existing SMTP parameters. Runtime secrets come from explicit protected env file/mount, not metadata/Lockbox. A separate versioned platform manifest and platform-edge image identity bind profile/source/tooling; the existing exact-key legacy manifest parser must reject it. Existing legacy publishing/deploy stays reproducible. Host executor is deferred until target infrastructure is approved: this stage prepares and verifies a portable bundle, not a production deployment command.

- [x] Write failing contract tests for only SaaS/landing assets, old API retirement responses, no public DB/API ports, no vbtech dependency, no Yandex secret retrieval, required/invalid profile rejection, fail-closed digest/config checks.
- [x] Build platform edge from SaaS/landing only, preserving legal artifact verification and hardened container settings. Add restricted old-domain retirement page/API responses; unknown paths do not become successful API responses.
- [x] Add protected-file env validation and portable preflight with no server mutation; checks should avoid exposing secrets. Use configurable S3 origin in CSP where needed and pin exact permitted origins.
- [x] Integrate preparation/build/test into CI and affected routing. Preserve existing release publishing/deploy behavior; verify platform artifacts cannot enter legacy deploy. Document future protected platform dispatch, cross-profile `api-only` rejection and profile-aware rollback gates. Do not add an unverified host executor or run deployment/publish artifacts.
- [x] Document future isolated restore, allowed queue activation, one writer, immutable key continuity, Timeweb SMTP verification, DNS/rollback gates, optional vbtech retirement and deferred CRM sizing.
- [x] Run contract suites, whole formatting/diff checks and relevant package gates. Generate a concise evidence list with failures/skips explicitly separated from external tests not run.

## Completion

- [x] Fresh independent review of the complete diff against the approved spec; fix confirmed findings with focused regression tests.
- [x] Preserve task branch/worktree until review and future authorized merge. Remove only temporary resources created by this task after recording evidence; never old backups/releases or unrelated worktrees.
- [x] Report code changes, tests, outstanding external migration checks, and confirm no servers were changed.

## Local progress (2026-10-18)

- Tasks 1–2: implemented; independent source review approved. Actual HTTP/DB/pg-boss and licensing/diagnostic tests passed. Stable broad API run passed 5057 tests with 98 explicit skips; isolated support/inventory follow-ups bring verified unique coverage to 5146/5155. Nine remain: four resource-heavy National Catalog cases omitted after a PostgreSQL OOM and five external/browser harness checks; source assertions are preserved.
- Task 3: implemented and independently reviewed; full SaaS suite 696 passed / 10 conditional skips, final focused tests 31 passed, both profile builds and nine fixture browser scenarios passed. No broken landing navigation was found, so no landing content change was needed.
- Synthetic PostgreSQL restore verified row hashes for 264 tables / 5979 rows, 775 index definitions and four sequence states. This is not a production or Timeweb restore rehearsal.
- Task 4 code and CI wiring are implemented. Platform contracts 12/12, production contracts 591/591 and CI policy 62/62 passed. Final independent source review approved after correcting duplicate database query parameters and signing-key instructions. Exact API/edge Docker builds exceeded the local VM memory limit. The isolated stack passed using explicitly local derived images with host-compiled application output and the original Linux runtime/dependency/security layers: migrations twice, 77 HTTP checks, direct API authorization/retirement checks, exact queues and Chromium login/landing. The exact legal-verification stage independently passed for 34 committed artifacts without networking. Exact release image builds remain a separate CI gate; local derived images are not release evidence.

- Cleanup verified: task PostgreSQL/dump, both isolated Compose projects, their volumes/networks, both derived images and temporary contexts/env files were removed. Task branch/worktree and sanitized review evidence remain; shared caches and unrelated resources were preserved. No commits, publication, deployment, server, DNS or MX changes were made.
