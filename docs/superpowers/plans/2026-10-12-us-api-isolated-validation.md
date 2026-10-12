# US branch save and isolated API validation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. The direct request and continuing advance approval govern execution; do not pause for routine artifact approvals.

**Goal:** Save the US branch and run the remaining API checks on disposable infrastructure.

**Architecture:** A test-only launcher creates an owned PostgreSQL child and a clean synthetic environment; existing API tests execute unchanged.

**Tech Stack:** Node 24, Corepack pnpm, PostgreSQL, Drizzle and Vitest.

**Spec:** The direct user request, the boundaries below and the existing CI environment contract.

## Intent and boundaries

Save the existing US implementation to origin/codex/us-mvp, then turn the eight
remaining API setup failures into actual passing checks in a disposable test
environment. Do not release, merge, publish artifacts, weaken assertions, change
timeouts, load the user's .env or mutate a shared database. The user previously
authorized continuous implementation and independent stage review.

## Steps

1. Audit the existing dirty manifest for US scope and sensitive/generated files.
   Check release isolation, staged diff and remote branch ancestry. Commit explicit
   approved paths and push only HEAD:refs/heads/codex/us-mvp, without force or PR.
   Preserve any unrelated work. Record exact local and remote SHA.
2. Read the eight failed suite stacks and analogous CI test environment. Reuse the
   existing loopback US PostgreSQL service as an administrative entry point only:
   validate its identity, create a random invocation-owned child, migrate it and
   pass its URL as DATABASE_URL to the tests. Generate synthetic auth/platform/
   pairing keys in memory and supply local-only origins. Never print credentials.
   Keep US_TEST_DATABASE_URL unset initially to avoid confusing the ordinary API
   database with native fixture ownership. Execute the exact eight whole files,
   then proportionate wider API checks. If another service is genuinely needed,
   use a disposable local fixture, not a real endpoint or weakened check.
3. Diagnose actual failures before changing code. Existing assertions, tenant
   denial, audit facts and deadlines remain binding. New harness behavior needs
   a causal failing safety test before implementation. Product changes, if needed,
   must be minimal and independently reviewed, with affected regressions rerun.
4. Await test exit and all connections before disposing only the owned child.
   Preserve the original failure if cleanup also fails; no FORCE drop, unknown
   process cancellation or broad cleanup. Report explicit skips and unrun gates.
   Verify typecheck/lint/build/format/diff and independent final review. Further
   commit/push to the US branch is authorized; releases remain prohibited.

## Acceptance

- The previous US work is verified on origin/codex/us-mvp.
- All eight previously failed API files execute and pass, rather than skip.
- Wider API evidence is reported precisely, separate from US native 260-chain
  acceptance, remote CI, browser/hardware and deployment.
- Isolated target identity, migration, awaited disposal and no shared writes have
  evidence. No assertion or deadline was relaxed.

## Implementation file boundaries

- Create tools/us-development/api-validation-env.mjs: pure strict input guard and
  clean synthetic child environment construction; no connection or process launch.
- Create tools/us-development/run-api-validation.mjs: guarded base identity,
  invocation-owned child/migrations, fixed remaining/full API modes, awaited exit
  and normal disposal. Never accept a caller database URL as the write target.
- Create tools/us-development/test/api-validation-env.test.mjs: actual safety RED
  for malformed/remote/shared URLs, env contamination and unsafe modes before
  launcher implementation; exact synthetic identity and secret non-disclosure.
- Append docs/us/development-isolation.md with actual environment and results.
- Existing eight tests, production guards/contracts and all deadlines stay frozen
  unless a genuine code bug is reproduced and separately reviewed.

### Evidence-based fixture correction

The first configured whole API run completed with one failure: the existing
platform-billing-requests.service.test.ts billing journey correctly received
`offer_expired` at its requestChanges call. Its fixed offer expires on 2026-09-30,
but the test used the current wall clock. Use the existing protected `now()` seam
through a test-only subclass with the historical journey date (2026-08-28), as
analogous billing fixtures do. All assertions, deadlines and production expiry
checks remain unchanged. Independently review this single additional test path,
exercise adjacent expired-offer denial, and rerun the unfiltered whole API suite.

The eight whole files are billing-accounts.e2e.test.ts, exchange-credentials.e2e.test.ts,
exchange-import.e2e.test.ts, exchange-orders.e2e.test.ts, exchange-protocol.e2e.test.ts,
integrations-delete.e2e.test.ts, integrations.e2e.test.ts and subscription-route-inventory.test.ts.
Use the ordinary CI local origins (localhost ports3000/5173/5473/5373), generated
auth/platform/pairing/encryption keys, NODE_ENV=test and a clean environment rather
than inherited operational settings. Keep all invocation credentials in memory.
