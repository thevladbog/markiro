# US-02 lot domain foundation implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution of this approved US-02 increment. Steps use checkbox syntax for tracking.

**Goal:** Implement the reusable TLC, assignment, manual-status and directed-genealogy rules before adding lot storage and routes.

**Architecture:** Pure functions in `@markiro/domain` own the rules; strict Zod field/status contracts consume them. No database, controller, navigation or release surface changes. This increment does not claim that a lot is finalizable or that a graph is export-ready.

**Tech Stack:** TypeScript, Vitest, Zod; Node 24 and repository-pinned pnpm. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-us-02-product-profiles-and-lots-design.md`, subordinate to `docs/us/mvp-contract.md` sections 4–6.

## Global constraints

- Work only in the existing `codex/us-mvp` worktree; preserve all previous uncommitted increments. No commit, push, merge or release in this task.
- TLC remains opaque and case-sensitive. Entry trims outer whitespace, rejects control characters before trimming, and accepts 1–120 Unicode code points. Never normalize Unicode, parse GS1, remove internal whitespace or reinterpret formula-leading text. Response validation does not repair noncanonical persisted values.
- Manual imported entry cannot manufacture a transformation or exempt-receipt assignment. This context check does not decide whether an existing supplier TLC should be reused: the future event service owns that check.
- Status validation here is for explicit manual actions only. No balance calculations or system-only reopening are introduced; shipping correction semantics remain in US-05.
- A genealogy helper receives caller-selected edges for one revision view; it also filters by tenant. The caller must establish authorization, current/pinned event revisions, completeness and transaction locks. Pure traversal is not proof of those boundaries.
- Source-less drafts, typed source references, complete resolved location descriptions, origin events and identity locking remain requirements for storage/finalization. Do not implement a permissive `assertLotFinalizable` based only on nonblank source text. GLN/FFRN master fields remain P1.

## Task 1: TLC and assignment behavior

**Files:** create `packages/domain/src/traceability/lots/tlc.ts`, `assignment.ts`; add `packages/domain/test/us-lot.test.ts`; update `packages/domain/src/index.ts`.

**Interfaces:** `normalizeTlc(raw: string): string`; `formatDemoTlc({ prefix, date, suffix }): string`; `assertLotAssignmentBasis(basis: unknown, context: unknown)` narrows to P0 assignment bases, or throws `DomainError`. Context is manual, receiving or transformation and must come from the trusted operation, never the body.

- [x] Write literal tests for preservation, invalid input, valid civil dates and the assignment matrix, including reserved bases and unknown contexts.

```ts
expect(domain.normalizeTlc("  =Supplier / Á-01  ")).toBe("=Supplier / Á-01");
expect(() => domain.normalizeTlc("\nSupplier-01")).toThrow(domain.DomainError);
expect(() => domain.assertLotAssignmentBasis("transformation", "manual")).toThrow();
expect(domain.formatDemoTlc({ prefix: "NRF", date: "2026-09-15", suffix: "APL01" })).toBe(
  "NRF-260915-APL01",
);
```

- [x] Run the focused test, observe missing behavior, implement with stable error codes and rerun green. Date formatting has no clock, locale, random or uniqueness side effects.

## Task 2: Manual transitions and tenant-filtered genealogy

**Files:** create `lots/status.ts`, `lots/genealogy.ts`; add `packages/domain/test/us-lot-genealogy.test.ts`; extend the lot tests and domain exports.

**Interfaces:** `assertLotTransition(from: unknown, to: unknown): void`; `ancestorsOf(edges, tenantId, lotId): string[]`; `descendantsOf(edges, tenantId, lotId): string[]`; `wouldCreateCycle(edges, candidate): boolean`. An edge carries `tenantId`, `inputLotId`, `outputLotId`; traversal returns unique IDs in deterministic ordinal order, excludes its starting lot, never mutates input, and terminates on malformed cyclic input.

- [x] Write the exhaustive manual transition matrix and directed graph tests: diamond, disconnected nodes, self-loop, cross-tenant edges, existing cycles, reversed edge, and a long chain.

```ts
expect(() => domain.assertLotTransition("shipped", "active")).toThrow();
expect(() => domain.assertLotTransition("quarantined", "active")).not.toThrow();
const edges = [{ tenantId: "tenant", inputLotId: "a", outputLotId: "b" }];
expect(domain.ancestorsOf(edges, "tenant", "b")).toEqual(["a"]);
expect(
  domain.wouldCreateCycle(edges, { tenantId: "tenant", inputLotId: "b", outputLotId: "a" }),
).toBe(true);
```

- [x] Observe RED; implement adjacency-map traversal with an iterative visited set and the explicit transition table; rerun focused and full domain gates.

## Task 3: Field and status contracts, integration checks

**Files:** create `packages/platform-contracts/src/traceability/lots.ts`, `test/us-lot.test.ts`; update package exports and US-02 status documentation.

**Interfaces:** `tlcSchema` normalizes entry; `preservedTlcSchema` validates stored text without transformation; assignment and status enum schemas; strict `changeLotStatusSchema` accepts only `status` and a trimmed reason of 3–2000 characters. No create/list/response entity contract is exposed until source identity is represented correctly.

- [x] Write failing tests for lossless parsing, limits, reserved P0 assignment rejection, mandatory reason, and rejection of tenant/actor/system-context/unknown body fields.

```ts
expect(contracts.tlcSchema.parse("  +A-1  ")).toBe("+A-1");
expect(contracts.preservedTlcSchema.safeParse(" A-1 ").success).toBe(false);
expect(
  contracts.changeLotStatusSchema.safeParse({
    status: "active",
    reason: "Reviewed",
    context: "system:shipping_recalculation",
  }).success,
).toBe(false);
```

- [x] Rebuild domain exports before contract tests. Implement schemas reusing domain validation, then run full tests, typecheck, lint and build for both packages; check affected API/admin types, isolation contracts, formatting and diff whitespace.
- [x] Request an independent read-only review; fix actionable findings with RED/GREEN checks. Record exact results and uncovered storage/event/browser boundaries. No browser check is needed for this non-UI increment.

## Completion record

Implemented locally on 2026-09-06. Focused RED/GREEN: 107 domain tests and 51 contract tests. Full domain: 796 tests/44 files; full contracts: 296 tests/17 files; no skips. Both packages pass typecheck, lint and build; API/admin consumer typechecks and all 17 local isolation contracts pass. A test table's empty-array type inference was fixed without changing expectations. Independent read-only review found no actionable findings. See `docs/us/implementation-plan.md` for current verification limits.

The check-only US workflow includes the new contracts; no release capability changes, database/browser checks, commit, push or deployment occurred. LOT requirements stay partial until tenant-scoped persistence, event finalization, audit and the lot interface are implemented and verified.
