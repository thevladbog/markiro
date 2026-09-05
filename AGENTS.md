# AGENTS.md

## US development branch boundary

This checkout is the unreleased US development line, `codex/us-mvp`. Read
`docs/us/development-isolation.md` before running or integrating changes.
Keep all US implementation in this worktree, not the primary checkout. Preserve
the unconditional operational-workflow locks. Do not merge into `main`, publish
images/installers, create release tags, or run production/infra/release scripts
until the owner separately approves release enablement after development.
Do not dispatch a workflow from `main` with a US commit as its target SHA.
Use synthetic data and the standalone `deploy/us-development/compose.yml`;
never copy production or primary-development env files, databases or volumes.
The US lock must not be removed as part of synchronizing updates from `main`.

## Purpose and scope

These instructions apply to the entire repository unless a closer `AGENTS.md`
overrides them.

Markiro is a production-workflow platform for Russian manufacturers. It covers
SSCC and label generation, scan traceability, office administration, self-service
pickup kiosks, and offline line stations. Treat factory continuity, tenant
isolation, audit accuracy, and recoverability as product requirements, not
implementation details.

## Sources of truth

Use sources in this order:

1. Direct user instructions and the issue or acceptance criteria for the task.
2. The nearest applicable `AGENTS.md`.
3. Current code, tests, package manifests, migrations, and runtime configuration.
4. `README.md` and `docs/architecture.md`.
5. The relevant file under `docs/superpowers/specs/`,
   `docs/superpowers/plans/`, or `docs/design-briefs/`.

Plans describe intent, but code and tests may have moved since a plan was
written. Before changing behavior, inspect the scoped implementation, its tests,
and recent commits. For issue fixes, retrieve the full issue and look for
analogous fixes before editing.

## Repository map

- `apps/api`: NestJS backend, Better Auth, REST/OpenAPI, jobs, integrations,
  Postgres persistence, and server-side authorization.
- `apps/admin`: React/Vite office application.
- `apps/kiosk`: React/Vite installable PWA with IndexedDB-backed offline pickup
  flows and device authentication.
- `apps/station`: React/Vite line-station UI plus the Tauri/Rust hardware shell in
  `src-tauri` for scanners, printers, local storage, and updates.
- `apps/signer`: React/Vite tray UI plus a Tauri 2 shell over the `signer-core`
  Rust crate. Runs on a tenant's UKEP machine and keeps a fresh Chestny ZNAK
  True API token in the cloud by signing the auth challenge with a GOST
  certificate. Windows-only; its Cargo workspace is `signer-core` + `src-tauri`.
- `apps/saas-admin`: platform operator panel for tenants, catalog, billing,
  acts, payments, offers, legal documents, platform team, and audit. It has its
  own auth boundary and client; it is not a tenant-admin route set.
- `apps/landing`: Astro public site with localized content, SEO, the demo form,
  and published legal artifacts.
- `packages/domain`: shared GS1/KM/GTIN/SSCC validation, label models,
  ZPL/TSPL, rasterization, and other framework-independent rules.
- `packages/db`: Drizzle models, Postgres migrations, the station SQLite mirror,
  and runtime migration helpers.
- `packages/platform-contracts`: shared Zod schemas for the platform, tenant,
  and agent APIs, including catalog, commercial, tenant, platform-auth, and
  CHZ-signer contracts.
- `packages/email`: React Email templates and rendering helpers.
- `packages/ui`: shared design tokens, styles, themes, and React components.
- `packages/legal-documents`: controlled legal-document sources plus DOCX/PDF
  artifact generation, manifests, and verification.
- `deploy/production`: production Compose, images, preflight, deployment, smoke,
  and contract tests.
- `deploy/yandex`: runtime inventory, remote deployment, and diagnostics for the
  Yandex Cloud host.
- `infra/yandex`: Terraform for Yandex Cloud — IAM, network, compute, managed
  Postgres, object storage, and station-release buckets, plus the production
  stack's variables and outputs.
- `tools/station-release`: station release artifacts, changelog, promotion, and
  object-storage/GitHub mirror contracts.
- `tools/evidence-package`: evidence package init, seal, and verification.
- `tools/production-browser`: isolated Playwright checks for production docs,
  the landing site, kiosk touch flows, and station inventory.
- `docs/architecture.md`: accepted system-level decisions and invariants.
- `docs/design-briefs/`: product/UX reference. HTML handoff artifacts are
  reference material; production design tokens live in `packages/ui`.
- `docs/superpowers/specs/` and `docs/superpowers/plans/`: scoped decisions and
  implementation history. Confirm their status before relying on them.

## Toolchain and local setup

Use Node 24 or newer and the repository-declared pnpm version through Corepack.
Docker is required for the development Postgres, Mailpit, and MinIO services.

```bash
corepack enable
pnpm install --frozen-lockfile
if [ ! -e .env ]; then
  cp .env.example .env
fi
docker compose -f docker-compose.dev.yml up -d
```

Do not overwrite an existing `.env`. It may contain local credentials. Treat
`.env.example` and `.env.production.example` as the variable inventory; never
copy their development values into production.

Drizzle Kit reads `DATABASE_URL` in the package process. Load the development
environment before migrations and API commands:

```bash
set -a
source .env
set +a
pnpm --filter @markiro/db db:migrate
pnpm --filter @markiro/api dev
```

Run the admin separately:

```bash
pnpm --filter @markiro/admin dev
```

Database-backed tests require `DATABASE_URL`; some API tests also use the auth,
origin, pairing, mail, and object-storage variables declared in the example env
files. Tests that cannot safely run without infrastructure should skip explicitly,
not silently use production resources.

## Working method

1. Run `git status --short` before editing. Existing changes belong to the user;
   preserve them and never reset, overwrite, or include them in an unrelated
   commit.
2. Read the issue/spec, affected code, adjacent tests, migrations, and comparable
   history. Confirm actual behavior before diagnosing it.
3. State assumptions when evidence is incomplete. Ask before making a choice that
   materially changes scope, data semantics, compatibility, or external state.
4. Make the smallest coherent change. Avoid speculative abstractions and unrelated
   refactors.
5. For features and bug fixes, write or update a focused failing test first. Make
   it pass, then refactor without weakening the assertion.
6. Run the narrowest relevant checks during iteration and proportionate final
   gates before claiming completion.
7. Report automated checks separately from browser, hardware, printer, Windows,
   1C, mail, object-storage, DNS, and other external validation. Never claim a
   surface was verified when the environment did not exercise it.

## Architectural invariants

### Tenancy and identity

- Every server-side business query and write must be tenant-scoped. Preserve
  composite tenant foreign keys and test cross-tenant denial, not only happy paths.
- Cabinet users authenticated through Better Auth are not production operators.
  Station operators use synced offline PIN/badge credentials; kiosks use paired
  device credentials. Do not collapse these trust domains.
- Reload authorization-relevant membership and role state at protected boundaries.
  Do not trust tenant, role, or ownership identifiers supplied only by a client.

### Offline operation and sync

- Station and kiosk recovery flows are offline-first. Do not replace queued local
  operations with online-only REST actions unless the requirement explicitly
  changes the product guarantee.
- Local journals/outboxes must survive restart and reconnect. Synchronization must
  be retry-safe, idempotent, and explicit about accepted, rejected, quarantined,
  and conflicting records.
- Preserve device sequence and terminal/kiosk identity semantics. Resolve raw
  device-local identifiers to server UUIDs before writing UUID columns; retain
  tests using real device payload shapes.
- A server conflict must be visible and recoverable without stopping an offline
  production line. Model degraded and partial-connectivity states deliberately.
- The station must bundle fonts, icons, sounds, and runtime assets. Do not add a
  CDN or a runtime network dependency to an offline factory path.

### Domain and labels

- Put reusable GS1, KM, GTIN, SSCC, label, and print-format rules in
  `@markiro/domain`, not independently in multiple apps.
- Preserve the GS1 group separator (`\u001d`) and exact barcode normalization
  semantics. Test production-like raw scanner values.
- Label rasterization and ZPL/TSPL generation are client-side. The API validates
  and stores the template JSON; it does not become a rendering service.
- Preview and print/download paths must use the same model so Cyrillic and barcode
  output do not diverge.

## Database and migrations

- Postgres schema modules live under `packages/db/src/schema/`; applied migrations
  and metadata live under `packages/db/migrations/`.
- The station SQLite schema and authoritative on-device DDL live under
  `packages/db/src/sqlite/`. `db:generate:sqlite` is a parity/diff aid; it does not
  replace the runtime migration list.
- Add a new migration for schema changes. Do not rewrite an already-applied
  migration to make a fresh database look green. Review generated SQL, indexes,
  tenant keys, nullability, defaults, rollback/recovery impact, and existing data.
- Some partitioned tables are intentionally hand-migrated and excluded from
  Drizzle generation. Read `packages/db/drizzle.config.ts` before generating.
- Update schema tests and migration/runtime-migration tests together with schema
  changes. For sensitive fields, migrate or scrub already-persisted records, not
  just future writes, while retaining required compatibility with queued offline
  payloads.
- `@markiro/db` exports compiled `dist` files. After changing DB sources, run
  `pnpm --filter @markiro/db build` before API or other consumer tests, or they may
  execute stale output.
- Shared development Postgres state can drift between worktrees. When e2e failures
  report missing relations or columns, inspect the actual migration journal and
  database schema before blaming application code. Never drop or rewrite shared
  data without explicit approval.

Typical database flow:

```bash
pnpm --filter @markiro/db db:generate
pnpm --filter @markiro/db build
pnpm --filter @markiro/db test
pnpm --filter @markiro/api exec vitest run test/relevant-file.test.ts
```

Use `db:generate:sqlite` for SQLite schema parity and inspect the output; do not
commit generated directories unless the repository already tracks them for the
change in question.

## Security and data handling

- Never commit or print production secrets, raw badge/PIN values, session tokens,
  API keys, pairing codes, activation/reset tokens, SMTP credentials, or object
  storage credentials. Avoid putting secrets in shell arguments or captured logs.
- Hash or encrypt sensitive values at the established boundary. Preserve constant-
  time verification and existing key/salt rotation constraints.
- Security migrations must address records already stored in browser, SQLite,
  Postgres, queues, and quarantine stores where applicable. Avoid stale-read plus
  rewrite patterns that can resurrect dequeued offline work.
- Backward compatibility is part of offline safety. When old queued payloads can
  outlive a deployment, accept and safely migrate the legacy representation until
  the queue horizon is closed.
- Validate external identifiers and payloads before passing them to Drizzle or a
  UUID column. Malformed business input should become a precise per-record error;
  transient database/infrastructure failures should propagate so callers can
  retry.
- Audit assertions must verify exact actor, tenant, action, target, result, and
  relevant metadata fields, not only that an audit-row count increased.
- Keep CORS, trusted origins, proxy-hop configuration, object-storage privacy,
  and device authorization deny-by-default.

## Code conventions

- TypeScript is strict and enables `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Do not mask uncertainty with broad casts,
  non-null assertions, or `any`.
- Use `import type` when importing only types. Follow the root ESLint and Prettier
  configuration rather than adding local formatting exceptions.
- Validate untrusted boundaries with the existing DTO/Zod patterns. Keep domain
  functions deterministic and framework-independent where practical.
- Prefer focused modules with one responsibility. Reuse established services,
  guards, query helpers, test builders, and error shapes.
- Follow the app's existing i18n pattern for user-visible text. Do not hard-code a
  new language path into otherwise translated UI.
- Respect React hook rules and dependencies. Avoid effects for state derivation;
  keep asynchronous server state in the established query/client layer.
- Reuse `@markiro/ui` components and tokens. Production UI should not copy styles
  from design-handoff HTML or invent a parallel token system.
- Preserve accessibility: keyboard operation, visible focus, semantic controls,
  labels, useful errors, and non-color-only status communication.

## Tests and commands

Run one package's standard gates:

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
```

Replace the filter with `@markiro/db`, `@markiro/api`, `@markiro/admin`,
`@markiro/kiosk`, `@markiro/station`, `@markiro/email`, or `@markiro/ui`.

Run a focused Vitest file:

```bash
pnpm --filter @markiro/api exec vitest run test/relevant-file.test.ts
pnpm --filter @markiro/kiosk exec vitest run test/relevant-file.test.ts
```

In a fresh worktree, kiosk tests may fail to resolve workspace packages until
their compiled output exists. Build the dependencies before diagnosing a product
regression:

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/kiosk exec vitest run
```

For broad or cross-package changes, load the required test environment and run:

```bash
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm format:check
```

The concurrency limit reduces contention in database-backed tests. A missing
`DATABASE_URL` can cause intentional skips, so report skips and infrastructure
coverage explicitly.

Production deployment checks are separate gates:

```bash
pnpm test:production-bundle:contract
pnpm test:production-docs:browser
```

The browser suite has its own workspace and Playwright requirements. Contract
tests do not prove that DNS, TLS, registry images, cloud resources, or a live
browser deployment work.

### Minimum checks by change area

| Changed area                     | Minimum relevant verification                                                | Important caveat                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/domain`                | focused test, package test, typecheck, lint, build                           | run affected consumer tests for contract changes                                      |
| `packages/db`                    | focused schema/migration tests, package test, typecheck, lint, build         | apply/inspect migrations in the actual test DB; rebuild before consumer tests         |
| `apps/api`                       | focused Vitest/e2e, package test, typecheck, lint, build                     | database and service env may be required; assert tenant denial and exact audit output |
| `apps/admin`                     | focused component/API-client test, package test, typecheck, lint, build      | automated DOM tests are not visual browser confirmation                               |
| `apps/kiosk`                     | focused IndexedDB/sync/UI tests, package test, typecheck, lint, build        | build domain/UI first in fresh worktrees; exercise offline restart and old queues     |
| `apps/station`                   | focused journal/sync/hardware/UI tests, package test, typecheck, lint, build | Rust, Windows, scanner, printer, sound, and updater behavior need separate checks     |
| `apps/signer`                    | focused UI test, package test, typecheck, lint, build, plus Cargo tests      | host Cargo tests do not prove CryptoAPI signing, DPAPI storage, or Windows behavior   |
| `apps/saas-admin`                | focused component/API-client test, package test, typecheck, lint, build      | assert the platform auth boundary and capabilities separately from tenant routes      |
| `apps/landing`                   | focused test, package test, typecheck, lint, build                           | SEO, Lighthouse, CSP, and legal-artifact publication are separate browser checks      |
| `packages/platform-contracts`    | focused schema test, package test, typecheck, lint, build                    | run affected API and saas-admin consumers; schemas are `.strict()`, so fields break   |
| `packages/ui` / `packages/email` | focused render/component test, package test, typecheck, lint, build          | check consuming surfaces and email-client/browser rendering when material             |
| `packages/legal-documents`       | focused test, package test, typecheck, lint, build, `artifacts:verify`       | regenerating PDFs also means updating the production attestation; see below           |
| `deploy/production`              | production bundle contracts and affected focused Node tests                  | live DNS/TLS/registry/cloud verification remains external                             |

For Rust changes under `apps/station/src-tauri` or in the `apps/signer` Cargo
workspace, also use the appropriate Cargo checks, for example:

```bash
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
cargo test --manifest-path apps/signer/Cargo.toml --workspace
```

Do not claim Windows or hardware confirmation from a host-only Cargo test.
`signer-core` keeps every OS- and network-touching capability behind a trait, so
a green host run proves the runtime loop and nothing about CryptoAPI signing,
DPAPI storage, or a real certificate.

Regenerating `packages/legal-documents` artifacts is wider than the package.
`deploy/production/verify-legal-artifacts.mjs` pins `RELEASE_ID` and the exact
PDF list, and `deploy/production/legal-artifacts-attestation.json` pins the
manifest sha256 plus a sha256 per PDF. Changing the artifact set or its bytes
means updating both, and the gate is `pnpm test:production-bundle:contract`.

## Dependencies and generated artifacts

- Prefer exact JavaScript dependency versions and preserve `workspace:*` for
  internal packages. Existing range exceptions are not permission to add new
  ranges or perform an unrelated repo-wide cleanup.
- Because those pins are exact, `pnpm update -r` is a no-op and a real sweep needs
  `pnpm update -r --latest`, which crosses majors indiscriminately. Always follow
  such a sweep with `pnpm check:deps` (`tools/check-no-major-bumps.mjs`): it
  compares every manifest against `tools/dependency-baseline.json` and exits
  non-zero naming anything whose breaking version moved — the major at `1.0.0`
  and above, the minor below it. Once the sweep has merged, re-anchor the
  baseline with `node tools/generate-dependency-baseline.mjs` as its own commit,
  so the baseline diff is the reviewable record of what moved.
- The repository currently has install-related keys in `.npmrc` and dependency
  allowlists, overrides, and patches in `pnpm-workspace.yaml`. With pnpm 11, do
  not assume a setting is enforced merely because it appears in a file. Check
  `pnpm config list` and use a bounded, reversible behavioral probe when changing
  dependency policy; restore all probe changes afterward.
- Do not move policy keys between config files as part of an unrelated dependency
  change. If a policy is inert, report it and scope a deliberate fix with its own
  behavioral verification.
- Do not hand-edit `pnpm-lock.yaml`. Use pnpm, review importer and resolution
  changes, and keep manifest/lockfile changes together.
- Do not disable the release-age guard globally or regenerate the lockfile merely
  to make an install pass. A release-age violation can describe pre-existing
  fresh lockfile entries; distinguish policy validation from repository health.
- Read the comments around `overrides`, `patchedDependencies`, and
  `patches/minimatch@3.1.5.patch` before changing security pins. These encode
  compatibility constraints that a superficially newer global override can break.
- Do not edit build output (`dist`, `.turbo`, coverage, Tauri `target`) or generated
  assets unless the repository explicitly tracks that artifact and the task
  requires regeneration.

## Git and completion

- Work on a task branch or isolated worktree for substantive changes. Never use
  destructive cleanup commands on user work.
- Keep commits scoped. Stage explicit paths and inspect the staged diff; do not
  bundle unrelated modifications, local env files, stores, or generated caches.
- Before completion, run `git diff --check`, the relevant checks above, and
  `pnpm format:check` for broad changes. Review the final diff against the issue
  and update public docs/OpenAPI/contracts when behavior changes.
- A green build is not sufficient if tests skipped their database or if the
  change requires browser/hardware/external confirmation. State those limits.
- Final reports must list: behavior changed, files or areas changed, automated
  checks and results, manual/external checks performed, and any checks not run
  with the reason.

## Graphify

The local Graphify knowledge graph lives under `graphify-out/`. That directory is
machine-generated and intentionally ignored by Git; `docs/working-map.md` is the
tracked, curated orientation aid.

When the user types `/graphify`, use the installed Graphify skill or instructions
before doing anything else.

Rules:

- For codebase questions, first run `graphify query "<question>"` when
  `graphify-out/graph.json` exists. Use `graphify path "<A>" "<B>"` for
  relationships and `graphify explain "<concept>"` for focused concepts. Verify
  material findings in current source and tests.
- If `graphify-out/wiki/index.md` exists, use it for broad navigation.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review or when
  query, path, and explain do not surface enough context.
- After modifying code, run `graphify update .` when a local graph exists. This is
  an AST-only incremental update and does not require an API call.
