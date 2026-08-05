# Root AGENTS.md Design

**Date:** 2026-08-05
**Status:** Approved for implementation

## Goal

Create one root `AGENTS.md` that lets coding agents work safely and effectively
in the Markiro monorepo without first reconstructing its architecture, commands,
and non-negotiable product constraints from many files.

The guide is operational documentation. It does not replace product or
architecture documents and does not introduce new engineering policy.

## Scope

Add a single `AGENTS.md` at the repository root. Do not add nested instruction
files under `apps/` or `packages/`, and do not modify application code,
configuration, or existing documentation as part of this change.

The guide will be detailed enough to stand alone while linking to current
sources of truth for material that is likely to evolve.

## Structure

The document will cover:

1. Product purpose and the factory/offline operating context.
2. Monorepo map for `apps/*`, `packages/*`, deployment tooling, and key docs.
3. Source-of-truth precedence and an instruction to inspect scoped code before
   making assumptions.
4. Required toolchain, setup, development, database, and targeted workspace
   commands derived from the current manifests.
5. A change workflow: inspect status and relevant history, understand the issue,
   preserve unrelated work, use focused tests, then run proportionate final
   gates.
6. Architectural and product invariants: tenant isolation, offline-first station
   and kiosk recovery, idempotent sync, local device identifiers, sensitive-data
   handling, exact audit semantics, client-side label rendering, and hardware
   constraints.
7. Database and migration rules for both Postgres and SQLite, including rebuilding
   `@markiro/db` before consumers use changed compiled output.
8. TypeScript, React, API, domain, UI, testing, security, environment, dependency,
   and git conventions evidenced by the repository.
9. A completion checklist that distinguishes automated verification from manual
   browser, hardware, printer, Windows/Tauri, and external-infrastructure checks.

## Content Principles

- Use imperative, concrete instructions and copy-pasteable commands.
- Prefer stable package names and paths over inventories of every feature or
  exact dependency version.
- Do not duplicate secrets or values from `.env`; direct agents to
  `.env.example` and `.env.production.example`.
- Mark commands requiring Postgres or exported environment variables.
- Recommend the narrowest relevant checks during development and the root Turbo
  gate for broad or cross-package changes.
- State known build-order traps explicitly, especially compiled workspace
  packages consumed through `dist`.
- Treat existing uncommitted changes as user-owned and forbid destructive cleanup.
- Require honest reporting when browser, hardware, OS-specific, or external-system
  validation was not performed.

## Verification

After writing `AGENTS.md`:

1. Check that every referenced path exists.
2. Compare all documented scripts with root and workspace `package.json` files.
3. Confirm database and environment guidance against README and Drizzle config.
4. Scan for placeholders, accidental secret values, obsolete package names, and
   contradictions with `docs/architecture.md`.
5. Run Prettier check on `AGENTS.md` if supported by the repository formatter.
6. Review the final diff and confirm that only the intended documentation files
   were changed by this task.

## Non-goals

- Rewriting the architecture or roadmap.
- Creating per-directory agent policies.
- Running the full application test suite for a documentation-only change.
- Resolving pre-existing working-tree changes.
