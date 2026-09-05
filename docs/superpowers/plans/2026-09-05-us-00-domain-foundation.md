# US-00 domain foundation implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution and test-driven-development for the code increments. This is the first bounded increment, not the whole US-00 slice.

**Goal:** Provide deterministic, tested edition/profile and interface-locale policy for the U.S. consumers.

**Architecture:** Framework-independent helpers in `@markiro/domain`. Explicit edition parsing has no implicit Russian fallback. The API/build integrations will consume these rules in the next increment; no runtime wiring is claimed here.

**Tech Stack:** Existing TypeScript, Vitest and DomainError. No new dependencies.

**Spec:** `docs/us/mvp-contract.md`, `docs/superpowers/specs/2026-09-03-us-00-regulatory-profile-design.md`, `docs/design-briefs/us/08-design-baseline.md`.

## Global constraints

- Separate US/RU instances, same codebase; no cross-edition data copying.
- US profiles: `US_FSMA204_PROCESSOR`, `US_GENERIC_LOT_TRACEABILITY`; RU profile: `RU_CHZ`.
- US locales: `en-US` (default), `es-US`. Separate RU locale behavior remains unchanged.
- No new package, database migration, production configuration, deployment or publication in this increment.
- Preserve existing uncommitted documentation and the canonical Pencil file.

## Task 1: Edition and profile policy

Files: create `packages/domain/src/traceability/profile.ts`, `packages/domain/src/traceability/deployment-edition.ts`; extend `packages/domain/src/index.ts`; test `packages/domain/test/traceability-foundation.test.ts`.

Interfaces:

```ts
type DeploymentEdition = "RU" | "US";
type TraceabilityProfileCode = "RU_CHZ" | "US_FSMA204_PROCESSOR" | "US_GENERIC_LOT_TRACEABILITY";
parseDeploymentEdition(value: unknown): DeploymentEdition;
allowedProfiles(edition: DeploymentEdition): readonly TraceabilityProfileCode[];
assertProfileAllowed(edition: DeploymentEdition, value: unknown): asserts value is TraceabilityProfileCode;
profileFeatures(profile: TraceabilityProfileCode): Readonly<{
  traceability: boolean;
  ftrClaims: boolean;
  ruRegulatory: boolean;
  cteSet: readonly ("receiving" | "transformation" | "shipping")[];
}>;
```

- [x] Add table-driven behavioral tests through the public domain export. Reject absent, lowercase and malformed editions with `invalid_deployment_edition`. Reject unknown profiles with `invalid_traceability_profile`, cross-edition profiles with `profile_not_allowed_in_edition`.
- [x] Run the focused test and observe missing behavior fail.
- [x] Implement explicit literal parsing and frozen profile allow-lists. Guard profile input before lookup. Freeze feature objects and CTE arrays: RU has no traceability CTEs; FSMA and generic have the three supported CTEs, but only FSMA enables FTR claims.
- [x] Rerun the focused test. Mutating an exposed list must not widen later decisions. Check RU and US negative paths independently.

## Task 2: Interface locale policy

Files: create `packages/domain/src/traceability/locale.ts`; extend the same export and test files.

Interfaces:

```ts
type InterfaceLocale = "ru-RU" | "en-US" | "es-US";
allowedInterfaceLocales(edition: DeploymentEdition): readonly InterfaceLocale[];
resolveInterfaceLocale(edition: DeploymentEdition, preference: unknown): InterfaceLocale;
```

- [x] Test literal decisions: US + `es-MX` gives `es-US`; US + `ru-RU` gives `en-US`; absent/malformed preferences fall back to the edition default; RU + `es-US` gives `ru-RU`; RU + `en-GB` gives `en-US`.
- [x] Run the tests before implementation.
- [x] Parse valid string preferences with `Intl.Locale`; map supported base languages into the edition allow-list. Ignore nonstrings and malformed tags. No input object, stored record, timezone or quantity is modified.
- [x] Run focused tests, full domain tests, typecheck, lint and build. Run formatting and diff checks. Use the repository-pinned installed tools if the package-manager launcher cannot start; do not regenerate the lockfile.

## Verification — 2026-09-05

- Before implementation: 47 focused assertions failed because the public functions did not yet exist.
- After implementation: 47 focused tests pass; full domain suite passes 532 tests in 37 files (485 tests before this increment).
- Source and test TypeScript checks, ESLint, build, built public-export smoke, scoped Prettier check and `git diff --check` pass.
- Documentation audit passes: 172 requirements, priority/slice consistency, 166 question mirrors, local links and policy invariants.
- Independent read-only review found no issues and independently reran all 47 focused tests successfully.
- Used the installed pinned tools directly with Node 24 after the pnpm launcher stalled; no dependency or lockfile changes.
- API, browser, mail, database, deployment and hardware checks were not run: no consumers or runtime configuration changed in this pure-domain increment. The audit worktree has no local Graphify graph to update.

## Completion boundary

Keep the branch local. Report the domain increment independently of US-00 integration. Next: validated API/build edition selection, startup mismatch rejection, registration of edition-specific modules and provisioning/authorization tests. Do not mark REG/NFR boundary requirements complete until consumers enforce them.
