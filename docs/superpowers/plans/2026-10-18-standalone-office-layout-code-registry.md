# Standalone office layout and code registry implementation plan

> **For agentic workers:** Use the executing-plans/TDD workflow. Independent office-layout and code-registry work may run in parallel through dispatching-parallel-agents; review the integrated branch once at the end.

**Goal:** Correct standalone office layout consistency and make accepted imported codes discoverable in one source-aware search.

**Architecture:** Preserve native code-search contracts; add a typed, read-only registry that pages compact native/cloud match keys and hydrates the final page. Reuse the office's existing list and spacing primitives.

**Tech Stack:** Existing React/Vite, @markiro/ui, Zod, Rust/axum/sqlx and SQLite; no dependencies added.

**Spec:** docs/superpowers/specs/2026-10-18-standalone-office-layout-code-registry-design.md

## Global constraints

- source=all|local|cloud; default all; 50 host rows; global cap 10,000; cloud card cap 1,000.
- Existing /v1/office/codes responses stay local-only; protocol 6/minimum 1 stays unchanged.
- Only completed imports; no invented scans/devices/operators; no reimport required.
- Preserve current UI identity, dark/light, office authorization and privacy of raw codes.
- Worktree: standalone-shift-import/q, branch codex/standalone-office-layout-cloud-codes, base 6eb7aaf4c0c51e75300c3401ffcd7d9fa3700835.

## Review focus

- Owner-only records outside the report window remain searchable without a dead shift link.
- A cloud-owned code with local rejected scans must not be labeled free.
- A criterion resolved only in one source must still find that source.
- Native/cloud tie ordering, source filtering and the 10,000 cap cannot skip/repeat page rows.
- Long notes/paths/names, empty states and scaled viewports must remain readable and usable.

## Task 1: Office layout consistency

Files: src/office/info/{AboutPage,UpdateSection,HostUpdateBlock,DeviceVersionsBlock}.tsx,
src/office/shifts/CloudShifts.tsx, src/app/shell.css, adjacent office components/tests as
the audit demonstrates. All paths are under apps/standalone.

- [ ] Add focused behavioral tests for semantic active source links and reusable list states.
- [ ] Reuse office-stack on real section boundaries; explicitly lay out update report,
      notes, actions and diagnostics. Preserve end-aligned submission rows in other forms.
- [ ] Move imported shifts to ListCard/filter/date/pagination primitives and styled links.
- [ ] Audit representative service/catalog/form screens for the same wrapper issue; fix
      evidenced cases through shared primitives, without blanket descendant CSS changes.
- [ ] Run focused tests, then include these states in Task 4's batched browser inspection.

## Task 2: Unified read contract and indexed host search

Create proto/src/code_registry.rs, src/host/code-registry.ts, and a focused child module
host/src/routes/office_codes/registry.rs (split query/hydration responsibilities as needed).
Modify proto/src/lib.rs, src/host/api.ts, native office_codes.rs only for reused query
primitives, server routing/authorization/path fixtures, and add migrations/0050_code_registry.sql.

Interfaces: CodeRegistrySource, CloudCodeItem, CodeRegistryItem, CodeRegistryPage,
CodeRegistryCard, CodeRegistryQuery; client searchCodeRegistry(token,query),
getCodeRegistryCard(token,codeHash,source?). Row discriminator uses source and item.
Card fields are codeHash, local, cloud, cloudCapped, currentOwner, exactly as the spec.

- [ ] Write failing host tests for new routes, completed/pending imports, all source filters,
      owner-only provenance, absent fields/links, flat repeats, local/cloud criteria, mixed pages,
      caps/ties and released cloud ownership followed by native reuse.
- [ ] Add failing mirror-contract/path tests and query-plan tests for repeated fact lookups.
- [ ] Implement strict criteria and source validation, office authorization and one read
      snapshot for count/page. Keep native legacy routes unchanged.
- [ ] Add driver indexes for cloud GTIN/time and owner time; reuse hash/number/box/pallet
      indexes. Page compact union keys and batch-hydrate at most one host page.
- [ ] Implement cards with independent current-owner lookup and bounded cloud occurrences.
- [ ] Run focused host/proto/client/schema/migration/query-plan tests; record results below.

## Task 3: Shared search table and truthful cards

Files: src/office/codes/{CodeSearchPage,CodeCard}.tsx, new registry rendering helpers,
src/i18n/ru.json, test/code-search-_.test.ts_, controlled browser harness fixtures.

- [ ] Write failing UI tests for source=all default, source URL/reset/page behavior, cloud
      rows, absent metadata, valid cloud links, native and cloud occurrences in one card and
      cloud-owned codes never labeled free. Include host-update-required errors.
- [ ] Use CodeRegistryItem/CodeRegistryPage in the existing host-window pagination adapter.
      Add All / Local / From cloud filter, source badges and stable source-aware row keys.
- [ ] Render global identity/ownership once. Reuse native journal with summary hidden;
      render imported snapshots separately, preserving original timezone and unknown values.
- [ ] Update Russian copy and documentation/AGENTS local-journal invariant for the new UI,
      explicitly preserving legacy /codes API semantics.
- [ ] Run focused component/protocol/API/fixture tests.

## Task 4: Integration and evidence

- [ ] Run standalone package tests/typecheck/lint/build; cargo fmt and host/proto tests,
      workspace Cargo tests where supported; record skips and external limits explicitly.
- [ ] Inspect update, native/imported shift lists, import dialog and mixed code search/card
      in one batched browser pass at 1280x720 dark, reduced viewport and 1920x1080 light.
- [ ] Fix observed defects as a batch; run one confirmation pass and the Impeccable detector
      over changed UI. Initial mechanical scan was empty; layout assessment found real defects.
- [ ] Obtain one fresh whole-diff review and fix still-valid material findings with tests.
- [ ] Run diff/format checks and review complete diff against the accepted spec.

## Execution record

- Preflight: primary checkout has unrelated dirty work and is untouched. Reused clean attached
  worktree on a new task branch. No Graphify graph exists in this worktree.
- User selected shared results table and source filter. Existing snapshot/ownership tables
  contain enough data; source metadata can genuinely be absent on owner-only records.
- Impeccable layout assessment and initial mechanical scan completed independently.
- Ruling: use additive registry routes, preserving older local-only search contracts.

## Task 5: Stable 1.0.0 release

- [ ] Integrate the reviewed change into standalone/pilot-mvp without a PR; preserve
      the exact accepted source SHA and dispatch ci.yml explicitly for that revision.
- [ ] Verify all required CI results and the Windows installer artifact, source SHA,
      manifest, checksum and size. A queued or partially green run is not acceptance.
- [ ] Sign locally with channel=stable and the established encrypted-key procedure;
      never transmit a passphrase through chat, environment variables or CI.
- [ ] Verify the signed manifest and installer bytes, prepare a downloadable update
      archive and tag the accepted source as standalone-v1.0.0.
