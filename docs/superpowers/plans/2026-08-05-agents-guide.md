# Root AGENTS.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a verified root `AGENTS.md` that gives coding agents accurate, actionable guidance for working safely in the Markiro monorepo.

**Architecture:** Create one self-contained repository-wide instruction file. Keep changing implementation details in their existing sources of truth and link to them, while putting stable workflow rules and cross-cutting product invariants directly in `AGENTS.md`.

**Tech Stack:** Markdown documentation for a Node 24, pnpm 11, Turborepo, TypeScript, NestJS, React/Vite, Tauri, Drizzle/Postgres/SQLite monorepo.

## Global Constraints

- Create only one agent instruction file: root `AGENTS.md`; do not add nested instruction files.
- Do not modify application code, configuration, or pre-existing user changes.
- Derive commands from the current root and workspace manifests.
- Do not copy secret values from `.env`; refer to `.env.example` and `.env.production.example`.
- Preserve tenant isolation, offline-first recovery, idempotent synchronization, sensitive-data protection, and exact audit behavior.
- Distinguish automated verification from browser, hardware, printer, Windows/Tauri, and external-infrastructure validation.

---

### Task 1: Create and verify the root agent guide

**Files:**

- Create: `AGENTS.md`
- Reference: `README.md`
- Reference: `docs/architecture.md`
- Reference: `package.json`
- Reference: `pnpm-workspace.yaml`
- Reference: `turbo.json`
- Reference: `apps/*/package.json`
- Reference: `packages/*/package.json`
- Reference: `.env.example`
- Reference: `.env.production.example`

**Interfaces:**

- Consumes: current repository layout, package scripts, architectural decisions, and product invariants.
- Produces: repository-wide instructions automatically discovered by coding agents from `AGENTS.md`.

- [ ] **Step 1: Write the guide**

Create `AGENTS.md` with these concrete sections and requirements:

1. `# AGENTS.md` and `## Purpose and scope`: identify Markiro as a Russian manufacturing platform for SSCC labels, scan traceability, admin workflows, kiosk pickup, and offline line stations; state that these instructions cover the whole repository.
2. `## Sources of truth`: order direct user instructions first, then the nearest `AGENTS.md`, code/tests/manifests, `README.md`, `docs/architecture.md`, and scoped design/spec/plan documents; require agents to inspect the relevant implementation and recent history before changing behavior.
3. `## Repository map`: describe `apps/api`, `apps/admin`, `apps/kiosk`, `apps/station`, `packages/domain`, `packages/db`, `packages/email`, `packages/ui`, `deploy/production`, `tools/production-browser`, and the documentation directories without inventorying every feature.
4. `## Toolchain and setup`: state Node 24+, pnpm 11.10.0 via Corepack, Docker Compose for Postgres/Mailpit/MinIO, `pnpm install --frozen-lockfile`, development compose startup, migration command, and API/admin development commands. Warn that tests using Postgres need `DATABASE_URL` and API startup needs exported `.env` values.
5. `## Working method`: inspect `git status`, preserve unrelated changes, retrieve the issue/spec and comparable fixes, make the smallest coherent change, use TDD for behavior changes, run scoped checks during iteration, and report unverified surfaces honestly.
6. `## Architectural invariants`: cover tenant scoping, separate cabinet and station identities, offline-first station/kiosk operation, append-only/idempotent sync, raw device-local ID resolution before UUID writes, label rendering in clients, shared domain logic, bundled station assets, and explicit degraded-state behavior.
7. `## Database and migrations`: distinguish Postgres and SQLite schemas/migrations; forbid editing old applied migrations; require generated or reviewed migrations plus schema tests; explain that consumers load `@markiro/db/dist`, so rebuild `@markiro/db` before API tests after DB source changes; require checking actual shared Postgres state when e2e failures suggest drift.
8. `## Security and data handling`: prohibit logging or committing credentials, raw badges/PINs/tokens, or production data; preserve backward compatibility for queued offline payloads where required; scrub already-persisted sensitive data during migrations; keep tenant checks at boundaries; use exact audit fields and distinguish malformed external input from retryable infrastructure errors.
9. `## Code conventions`: strict TypeScript, type-only imports, Zod/DTO validation at boundaries, focused modules, existing naming/i18n patterns, React hooks rules, reuse `@markiro/ui` tokens/components, and no CDN/runtime network dependency for the station.
10. `## Tests and commands`: document workspace-filtered build/lint/typecheck/test commands, direct Vitest invocation for one file, the full Turbo gate, `format:check`, production bundle contracts, and browser docs tests. Include the fresh-worktree prerequisite to build `@markiro/domain` and `@markiro/ui` before diagnosing kiosk import failures.
11. `## Change-specific checks`: provide a compact table mapping domain/DB, API, admin, kiosk, station, UI/email, and deployment changes to their minimum relevant checks and environment caveats.
12. `## Dependencies and generated artifacts`: require exact dependency versions, use `pnpm-workspace.yaml` for pnpm policy, do not hand-edit lockfiles or generated artifacts, do not bypass release-age policy globally, and inspect security overrides/patches before changing them.
13. `## Git and completion`: forbid destructive cleanup and unrelated commits, require `git diff --check`, scoped/full checks proportionate to risk, documentation updates when contracts change, and a final report listing changed files, automated checks, and manual/external gaps.

- [ ] **Step 2: Verify referenced paths**

Run:

```bash
for path in README.md docs/architecture.md package.json pnpm-workspace.yaml turbo.json apps/api apps/admin apps/kiosk apps/station packages/domain packages/db packages/email packages/ui deploy/production tools/production-browser .env.example .env.production.example; do
  test -e "$path" || { echo "missing: $path"; exit 1; }
done
```

Expected: no output and exit status 0.

- [ ] **Step 3: Verify documented package scripts**

Run a read-only script that parses every manifest and asserts the exact scripts referenced by the guide:

```bash
node - <<'NODE'
const fs = require('node:fs');
const required = {
  'package.json': ['build', 'test', 'typecheck', 'lint', 'format:check', 'test:production-bundle:contract', 'test:production-docs:browser'],
  'apps/api/package.json': ['dev', 'build', 'test', 'typecheck', 'lint'],
  'apps/admin/package.json': ['dev', 'build', 'test', 'typecheck', 'lint'],
  'apps/kiosk/package.json': ['dev', 'build', 'test', 'typecheck', 'lint'],
  'apps/station/package.json': ['dev', 'build', 'test', 'typecheck', 'lint'],
  'packages/db/package.json': ['build', 'test', 'typecheck', 'lint', 'db:generate', 'db:migrate', 'db:generate:sqlite'],
};
for (const [file, scripts] of Object.entries(required)) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const script of scripts) {
    if (!manifest.scripts?.[script]) throw new Error(`${file} lacks script ${script}`);
  }
}
NODE
```

Expected: no output and exit status 0.

- [ ] **Step 4: Check content and formatting**

Run:

```bash
rg -n 'TBD|TODO|FIXME|PLACEHOLDER|password=|secret=' AGENTS.md
./node_modules/.bin/prettier --check AGENTS.md
git diff --check -- AGENTS.md
```

Expected: `rg` finds no matches, Prettier reports the file is formatted, and `git diff --check` exits 0. If `rg` exits 1 solely because it found no matches, that is success.

- [ ] **Step 5: Review scope and accuracy**

Run:

```bash
git status --short
git diff -- AGENTS.md
```

Expected: `AGENTS.md` is the only implementation file added by this task; pre-existing modifications remain untouched. Manually compare every command in the diff with its source manifest and confirm that the guide does not claim browser, hardware, printer, Windows, or external-service verification.

- [ ] **Step 6: Commit the guide**

```bash
git add AGENTS.md
git commit -m "docs: add repository agent guide"
```
