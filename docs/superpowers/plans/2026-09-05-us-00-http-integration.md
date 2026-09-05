# US-00 local HTTP/session/profile integration

Date: 2026-09-05

Scope: continue the approved US-00 session and profile foundation inside `codex/us-mvp`. This is a local development increment, not release enablement or completion of US-00.

## Implemented boundary

- The separate US application mounts the existing auth allowlist and `GET`/`PUT /traceability/profile`. It does not import the RU auth factory, business modules, jobs or outbound clients.
- The server owns one explicitly configured US pool and closes it during application shutdown. Startup performs no migration, seeding or account provisioning. Metadata/liveness remain independent of PostgreSQL; overall readiness stays 503.
- Business requests enforce the configured Host, exact trusted Origin for mutations, JSON content type, 16 KiB body cap and no-store responses. Forwarded authority headers are removed. Route-case and trailing-slash variants receive the same security checks as Express routes.
- Profiles require a session that passed MFA, fresh active organization membership and transactional settings capability. Tenant, actor, request ID, baseline and timestamps are server-owned. Initial provisioning and identical retries share the existing atomic profile/timezone/audit contract; different configuration returns 409.
- Incomplete database schema or database errors return sanitized unavailable responses. Auth library logs are disabled to prevent SQL/session parameter disclosure. Server-side `statement_timeout` cancels database work; a client-only query timeout is deliberately not used because it can strand rollback behind a still-running query.

## Verification approach

New HTTP tests started red with absent routes. They exercise real loopback sockets and disposable migrated US databases, including password-to-MFA enrollment, organization selection, profile persistence, exact audit attribution, retries, tenant/role denial, malformed/oversized input, untrusted origins/hosts, unavailable schema and pool shutdown.

Two independent review findings were reproduced before fixes: raw auth adapter error logging and client-only SQL timeout leaving a pooled transaction open. Regression tests cover sanitized session/sign-in failures and server-side cancellation followed by a completed rollback. The test transport uses Node HTTP to preserve the configured Host on an ephemeral socket; Node Fetch overrides that header.

## Verification results

- Final focused run: 122 passing tests across eight files, including all 20 real HTTP cases, session/MFA, profile store, entry policy, metadata, environment, health and repository-wide OpenAPI coverage. No focused cases skipped.
- Full DB run: 360 passing tests across 68 files, zero failures or skips, using an isolated disposable database. The optional pool settings do not change RU/default consumers.
- Full API regression: 2,953 passed, one OpenAPI coverage failure and three external-environment skips across 279 files. The missing profile route documentation was then added; the entire OpenAPI coverage gate and all current US tests passed in the final 122-test run. Two review-regression tests were added after the full run collected its 18 HTTP cases; both are included in the final 20-case HTTP run. The full API run was not repeated after these changes and is not reported as an all-green full run.
- API and DB typecheck, lint and build pass. The API and its domain/contracts dependencies were built directly with the exact cached pnpm 11.22.0 launcher after Turbo selected a mismatched host launcher; no manifest or lockfile changes were made to work around that environment issue.
- Release isolation checker and all 11 isolation/mutation tests pass. Compiled runtime smoke: three tests pass, including RU refusal of US configuration, local US startup restrictions, anonymous profile denial, RU route absence and clean shutdown.
- Repository-wide formatting and `git diff --check` pass. Independent review rechecked both fixes and reported no remaining actionable findings for this local increment.
- All disposable test databases were removed; base US PostgreSQL still has zero public tables. The primary checkout retains only its original untracked design/export files. No browser, hosted infrastructure, production TLS, email/object-storage or hardware acceptance was performed.

## Remaining scope

Browser integration, explicit local user provisioning, recovery workflow, authentication-event audit, the remaining US-00 acceptance gates and subsequent business modules remain open. No remote publication, infrastructure provisioning, deployment or release was performed. No changes were made to the primary product checkout or its database. Local base US schema is not initialized by this increment.
