# US-04 — current and pinned genealogy implementation plan

**Status:** Approved by the owner and implemented locally with independent review on 2026-09-26. This plan covers the second delivery increment of the approved [Transformation revisions and genealogy spec](../specs/2026-09-26-us-04-revisions-genealogy-design.md). No commit, push, PR, merge, deployment, public route or office UI was authorized or performed.

## Baseline and boundaries

The first increment provides revisioned Transformation finalization/void, the Receiving downstream guard, immutable revision-attributed edges and snapshots, and an internal `readCurrentTransformationOrigin`. The next increment is read-only genealogy plus richer fixture coverage. Keep it US-only and isolated from Russian releases. Station, cases/SSCC, Shipping, regulatory export and deployment are out of scope.

The graph has two distinct evidence modes:

- `current` selects only each Transformation root's current finalized revision and checks that the root pointer, event status and supersession fields agree. A void output lot remains visible with `currentOrigin: false`.
- `pinned` selects exactly the caller's authorized historical revision IDs in finalized/amended/void state. It returns saved snapshot and edges without replacing IDs with today's current revision or rebuilding descriptions from mutable products/locations.

The public shape is not an export-readiness attestation. Cycle, truncation, inconsistent root/event state and missing evidence must be explicit diagnostics; never label a partial view complete. Each event carries its original input/output lines and quantities/UOM once. Edge rows are provenance links, not quantity allocations, so a 2→2 event has four links but never four copies of each quantity in totals. Mixed units report balance `unknown` with separate unit values; no implicit conversion.

## Task 1 — fixture and contract foundation

**Candidate files:** `packages/platform-contracts/src/traceability/transformation-genealogy.ts`, `packages/platform-contracts/src/index.ts`, `packages/platform-contracts/test/us-transformation-genealogy.test.ts`, `apps/api/test/support/us-transformation-genealogy-fixture.ts`, focused DB/API tests.

Define strict request/response schemas for an internal read service: tenant-authorized start lot ID, `upstream | downstream`, `current | pinned`, explicit selected revision IDs for pinned mode, bounded depth/node limits, deterministic nodes/links/events, and completeness diagnostics. Reject client-supplied tenant and unexpected fields at the boundary. Preserve positive decimal quantity and original UOM values as strings from frozen snapshots; do not define edge-level quantity. A pinned request with an empty selection is valid but produces no invented history. Set explicit max selection/depth/node limits and test zero/overflow/duplicates.

Add finalized fixtures for 2 FTL inputs → 2 outputs (exactly four persisted directed edges) and zero FTL inputs → one output (no persisted edge, non-FTL line retained in snapshot). Test original and amendment revisions, including a voided current revision, and compare frozen snapshot/edge bytes after later edits. Use disposable `US_TEST_DATABASE_URL` databases only. No migration is expected; if fixture work exposes a persistence defect, stop and scope a separate correction before proceeding.

**RED first:** strict contract tests and two fixture assertions fail for the missing read contract/fixtures. **GREEN:** contract package test/typecheck/lint/build and focused DB/API fixture checks.

## Task 2 — pure graph projection

**Candidate files:** `packages/domain/src/traceability/transformation-genealogy.ts`, `packages/domain/src/index.ts`, `packages/domain/test/us-transformation-genealogy.test.ts`.

Build a deterministic, framework-independent traversal/projection over already-selected tenant-safe lots, events, snapshots and edge rows. Traverse both directions, preserve event/revision provenance, deduplicate lot/event/link identities, detect cycles, enforce depth/node caps and return explicit `cycle`, `limit`, `origin_gap` or `inconsistent_evidence` diagnostics. An incomplete result must not be marked export-ready. Include an origin event with zero FTL input edges by linking its output lot to the event snapshot; do not fabricate an input lot. Keep line quantities/UOM on the event snapshot, not on each of the four edges. For mixed UOM, return `unknown` balance plus each unit-specific value; do not infer conversion or regulatory sufficiency.

**RED first:** pure tests for 2→2, zero-FTL input, upstream/downstream determinism, cycle, depth/node limit, origin gap, historical selection, and mixed units. **GREEN:** domain focused/full test, typecheck, lint and build.

## Task 3 — tenant-scoped current and pinned read service

**Candidate files:** `apps/api/src/modules/traceability/transformation/us-transformation-genealogy.ts`, current-origin/query helpers, `apps/api/test/us-transformation-genealogy.e2e.test.ts`.

Implement internal read methods, not HTTP routes. Authorize before target lookup and constrain every lot, event, root, snapshot and edge query by tenant. `current` must query edges through the typed root current pointer and `finalized`/unsuperseded event predicate; pending, amended and void revisions are excluded. Corrupt pointer/status/supersession combinations fail closed with a diagnostic or explicit unavailable error, not fallback to a historical revision. Query current output origins separately so zero-edge events and void origin gaps remain visible. `pinned` must validate the exact selected revision IDs as tenant-owned Transformation events in allowed historical states, then return their stored snapshots and edges exactly; a foreign ID reveals no details. Neither mode may synthesize a source from mutable lot metadata when the current origin is absent.

Fetch by bounded traversal frontier rather than loading all tenant history. Sort IDs before queries and sort final lots/events/links deterministically. Do not lock or mutate events/lots for a read; use a single consistent transaction snapshot so concurrent root switches cannot mix revisions. If the code cannot guarantee that consistency with the existing transaction helper, add a focused read-only transaction wrapper and prove it with an amendment/void race. Treat malformed persisted snapshot/edge rows as incomplete/inconsistent, not successful output.

**RED first:** integration tests for both directions, amended/void current selection, explicit pinned selection, no-edge origin, cross-tenant denial, stale/root corruption, cycle/limit and concurrent switch consistency. **GREEN:** focused API tests and API typecheck/lint/build.

## Task 4 — integrated verification and CI ownership

Add the new domain, contract, DB fixture and API suites to `.github/workflows/us-development.yml` under the existing isolated US database step where required. Check `tools/us-development/test/isolation.test.mjs` so opt-in DB suites cannot silently disappear or run without `US_TEST_DATABASE_URL`. Re-run original 2→1, revision lifecycle/void, Receiving downstream and new 2→2/zero-FTL cases. Run affected package test/typecheck/lint/build, repository `format:check`, isolation, `git diff --check` and independent review. Record skipped RU/full-package infrastructure separately from US-focused results. No browser/hardware/production claim.

## Acceptance and handoff

For both modes, a reviewer can trace every returned link to a stored `(tenant, event revision, input lot, output lot)` row and every quantity to a single frozen event line. A current view never includes pending, amended or void edges; a pinned view never silently changes its revision selection. A voided output lot remains queryable with an explicit current-origin gap. Cycle, cap and inconsistency cases are visibly incomplete. All queries deny cross-tenant leakage, and tests prove a concurrent current-root switch cannot mix snapshots and links.

Execute Tasks 1–4 sequentially with a separate implementer and independent review per stage, as in the preceding lifecycle increment. Owner confirmation has been received. Commit/push/PR/merge/deploy remain separate authorizations.
