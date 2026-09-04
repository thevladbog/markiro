# Markiro U.S. Traceability - Agent Master Prompt

- Source: MUS-001 v0.1 (2026-09-03), sections 0.2, 10.1-10.5 and the
  companion file `Markiro_US_Agent_Master_Prompt_v0.1.md`
- Status: baseline, not yet implemented
- Owner: Vladislav Bogatyrev

Paste this file at the start of every new agent thread, then append only the
specific slice.

---

You are implementing one approved slice of Markiro U.S. Traceability in
`thevladbog/markiro`.

## Stop condition before any code

Before writing code, confirm that (a) the assigned slice is explicitly approved by Vladislav, and (b) every question in `docs/us/open-questions.md` marked "Blocking? = yes" for that slice has a recorded decision. If either is missing, stop and ask; do not proceed on assumptions.

## Mandatory source order

1. Direct user instruction and the assigned slice.
2. Nearest `AGENTS.md`.
3. `docs/us/requirements.md` (derived from MUS-001 v0.1).
4. Current code, tests, migrations and runtime configuration.
5. `README.md` and `docs/architecture.md`.
6. Historical specs/plans only after confirming current behavior.

## Repository documents for this bounded context

| Document                                    | Path                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Requirement register                        | [docs/us/requirements.md](requirements.md)                           |
| Requirement traceability matrix             | [docs/us/requirements-traceability.md](requirements-traceability.md) |
| Regulatory baseline and source register     | [docs/us/regulatory-basis.md](regulatory-basis.md)                   |
| Limitations, non-goals and language rules   | [docs/us/limitations.md](limitations.md)                             |
| Data dictionary (KDE and CTE fields)        | [docs/us/data-dictionary.md](data-dictionary.md)                     |
| Implementation plan (slices US-00 to US-12) | [docs/us/implementation-plan.md](implementation-plan.md)             |
| Synthetic demo scenario                     | [docs/us/demo-scenario.md](demo-scenario.md)                         |
| Acceptance and test strategy                | [docs/us/acceptance.md](acceptance.md)                               |

## Non-negotiable boundaries

- Do not fork the product. Add a `traceability` bounded context and
  profile/feature gating.
- Do not break or silently rename RU_CHZ workflows.
- P0 CTE scope is Receiving, Transformation and Shipping only.
- Never claim FDA approval/certification or full compliance.
- FTR coverage/exemptions remain a manual reviewed classification, not an
  automated legal conclusion.
- FTR is lot-level and technology-neutral; do not require item serialization,
  barcodes or EPCIS.
- Use synthetic data only for public demo and evidence.
- Preserve tenant isolation, immutable finalized records, audit accuracy,
  offline recoverability and idempotent retries.
- Add a new migration; never rewrite an applied migration.

Do not "improve" the regulatory scope from memory, automatically decide
exemptions, require item-level serialization, make EPCIS mandatory, change
RU_CHZ without a separate assignment, or write in the interface that the
product guarantees FDA compliance. Allowed and prohibited wording is listed in
[docs/us/limitations.md](limitations.md).

## Before coding

1. Run `git status --short` and preserve all existing user changes.
2. Read the assigned requirement IDs and current implementation/tests.
3. Write an ADR or scoped design note if data semantics or boundaries change.
4. State assumptions and exclusions.
5. Write a focused failing test first.

## Required output of every slice

- Code and migration, where applicable.
- Focused unit/integration/e2e tests.
- Tenant denial tests.
- Updated `docs/us/requirements-traceability.md`.
- Browser or generated-artifact evidence where applicable.
- A short verification report separating automated, browser, Windows/hardware
  and external checks, with explicit not-run checks.
- Conventional commit and clean diff.
- No unrelated refactors.

## Minimum verification

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build

pnpm --filter @markiro/db db:generate
pnpm --filter @markiro/db build
pnpm --filter @markiro/db test

pnpm --filter @markiro/api exec vitest run "<focused-test-path>"  # replace the placeholder before running
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm format:check
```

For Station Rust changes also run:

```bash
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

## Slice assignment template

Append exactly one filled-in copy of this template after the master prompt.

```text
Slice: US-XX — <name>
Requirement IDs: <list>
Goal: <one coherent outcome>
Current files to inspect: <paths>
Regulatory source IDs: <FDA/GS1 IDs>
Out of scope: <explicit list>
Data semantics: <entities, immutability, tenancy>
Acceptance criteria: <observable results>
Required tests: <unit/integration/e2e/negative>
Required evidence: <screenshots/export/hash/report>
Do not: <RU regression, overclaim, migration rewrite, unrelated refactor>
```

## Where to look in the current repo

| Task                      | Current paths                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Repository rules          | `AGENTS.md`; nearest scoped `AGENTS.md`                                                              |
| System architecture       | `docs/architecture.md`; `README.md`                                                                  |
| Products/shifts/boxes     | `packages/db/src/schema/platform.ts`; `apps/api/src/modules/products`; `apps/api/src/modules/shifts` |
| Station offline/sync      | `apps/station/src/lib`; `packages/db/src/sqlite`; station tests                                      |
| GTIN/SSCC/labels          | `packages/domain`; `packages/db/src/schema/labels.ts`                                                |
| Admin UI patterns         | `apps/admin/src/pages/catalog`; `shifts`; `inventory`; `code-search`                                 |
| Contracts/OpenAPI         | `packages/platform-contracts`; `apps/api` DTO/controllers                                            |
| Evidence tooling          | `tools/evidence-package`; `packages/legal-documents`                                                 |
| Production/browser checks | `tools/production-browser`; `deploy/production`                                                      |

Proposed placement of the new bounded context (MUS-001 section 5.1):
`packages/domain/src/traceability/`, `packages/db/src/schema/traceability.ts`,
`packages/platform-contracts/src/traceability/`,
`apps/api/src/modules/traceability/`, `apps/admin/src/pages/traceability/`,
`apps/station/src/lib/traceability/`, `tools/us-demo/`.

## Slice response format

1. Requirements implemented.
2. Files changed.
3. Data/migration semantics.
4. Tests run and results.
5. External checks not run.
6. Evidence artifacts produced.
7. Known limitations and next slice.
