# Dependency security sweep implementation plan

> **For agentic workers:** Execute the tasks inline using systematic debugging, focused failing tests and verification before completion.

**Goal:** Fix compatible open dependency vulnerabilities while preserving authentication, offline operation, update safety and dependency policy.

**Architecture:** Keep exact pins and pnpm-generated lockfiles. Reuse the saved npm/rustls changes on current main, validate Better Auth against both configured auth boundaries, patch deepmerge's prototype writes, and update the signer's direct zip dependency independently of the updater.

**Tech Stack:** Node 24, pnpm 11.22.0, Vitest, PostgreSQL 17, Cargo.

**Spec:** User request to audit all repository vulnerabilities and fix what is possible; root and affected scoped AGENTS.md.

## Global constraints

- Initial implementation phase: no commit, push or PR. The user subsequently authorized commit, push and PR creation on 2026-10-30; merge, deployment and shared database mutation remain out of scope.
- Preserve the old Claude branch and all unrelated work.
- Never edit lockfiles manually; enforce the 10080-minute release-age guard explicitly for pnpm.
- Verify official publication dates before upgrades; do not update the two-day-old updater.
- Report residual alerts and test skips; host tests do not establish Windows or hardware behavior.

## Review focus

- Tenant and platform auth schemas, sessions, organizations, API-key and two-factor isolation must remain compatible.
- Deepmerge must preserve result prototypes for malicious source, target, nested and null-prototype objects, including both distributed entry points.
- Ordinary object, array, symbol and custom-merge behavior must survive the deepmerge patch.
- Signer journal ZIP export must remain readable with unchanged entries.
- Aggregate scripts must report individual command failures, including database test isolation failures.

## Task 1: Revalidate npm/rustls fixes and upgrade Better Auth

- [x] Retrieve all current GitHub Dependabot alerts and npm audit; inspect saved commit and official package metadata.
- [x] Create a task branch from fetched main and apply saved changes without a commit.
- [x] Raise Better Auth/adapter security floors and observe failure before upgrading.
- [x] Compare the old/new auth schemas for the actual tenant/platform plugin sets; upgrade exact pins to 1.7.12 using pnpm.
- [x] Run dependency guards, DB/auth tests and affected frontend checks.

## Task 2: Mitigate deepmerge prototype poisoning

- [x] Add regression tests against all installed CJS/UMD copies and observe failure.
- [x] Use pnpm patch/patch-commit to preserve own properties without invoking prototype setters in source, CJS and UMD entry points.
- [x] Verify malicious and ordinary merges, consuming builds and frozen install; record that upstream version-based alerts persist.

## Task 3: Update signer ZIP and record remaining upstream constraints

- [x] Assert the patched direct zip pin before upgrading; run the failing guard.
- [x] Update direct zip to 9.0.5 with Cargo, retaining reviewed updater versions.
- [x] Run signer export tests and all affected Cargo workspaces; document updater/glib constraints.

## Additional findings from the complete audit

- [x] Reproduce CodeQL alert 175 (`js/polynomial-redos`) with space/letter padding inside the TSPL byte limit, guarded by a VM execution budget; remove overlapping regex paths without changing accepted statements.
- [x] Update the separate production-browser Puppeteer chain within Lighthouse's compatible range, replacing vulnerable zod 3 with zod 4.6.7; do not upgrade the three-day-old Lighthouse release.
- [x] Verify domain gates, label-import consumers, browser tooling and the final separate lockfile audit.

## Task 4: Final verification and evidence

- [x] Run full JS lint/typecheck/test/build with an isolated disposable PostgreSQL, relevant Cargo tests, dependency policy checks, formatting and diff checks.
- [x] Re-run root and production-browser npm audits and classify all remaining GitHub alerts against final resolutions.
- [x] Record exact results, skips and external checks not performed in a reviewable report.
