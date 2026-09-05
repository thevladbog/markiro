# US-02 Product Profile Rules and Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Preserve the existing isolated worktree and uncommitted catalog changes. No commit or publication is authorized by this plan.

**Goal:** Add testable P0 product-description/snapshot and manual FTL-review rules plus strict transport contracts, without registering a route or changing persistence.

**Architecture:** Pure rules live in `@markiro/domain`; `@markiro/platform-contracts` reuses them at untrusted boundaries. Profile context is a separate trusted argument, never a client-selected request field. This is the next foundation increment of the approved US-02 design, not delivery of the profile workflow.

**Tech Stack:** Node >=24, repository pnpm 11.22.0, TypeScript, Zod 4.4.3, Vitest. No dependency changes.

**Spec:** `docs/superpowers/specs/2026-09-03-us-02-product-profiles-and-lots-design.md`, governed by `docs/us/mvp-contract.md`.

## Global Constraints

- Work only in `.worktrees/us-docs-audit` on `codex/us-mvp`; preserve release locks and primary checkout.
- No automatic legal classification, inferred exemption, network lookup or category mapping from RU CHZ.
- `unknown` and `exemption_review_required` block the coverage prerequisite; a reviewed classification alone never implies a package is export-ready.
- Generic traceability makes no FTR assessment. RU/unknown profile context fails closed.
- Packaging uses exact positive decimal strings within numeric(12,3), paired with a versioned unit; no number coercion, rounding or conversion.
- Reviewer/time are server-owned; contracts accept them only in records, not mutation input. Authorization, metadata stamping, audit and concurrency belong to the persistence/API increment.
- Snapshots copy component values, preserve nullable GTIN, omit coverage assertions and never retain live object references.
- P1 ingredient/evidence/review-due fields, lots, events, HTTP, database and UI are excluded.

## Task 1 — Pure description and coverage rules

Files: create `packages/domain/src/traceability/products/{description,coverage,snapshot}.ts`, `packages/domain/src/traceability/uom.ts`; export from `packages/domain/src/index.ts`; create `packages/domain/test/us-product-profile.test.ts`.

Interfaces: `ProductDescriptionInput` contains productName, nullable brandName/commodity/variety/packagingSizeValue/packagingSizeUom/packagingStyle/defaultQuantityUom. `CoverageReviewInput` contains coverageStatus and nullable coverageRationale/ftlCategory/ftlSourceUrl/ftlSourceVersion. `validateProductDescription` and `validateCoverageReview` return field/code issues. `assessCoverageReview` additionally checks server review metadata and returns reviewed/blocked/not_assessed, not export readiness. `buildProductSnapshot({id,gtin14}, description)` returns a discriminated snapshot/issues result.

- [x] Write failing behavior tests using literal fixtures. Cover every coverage status and both US profiles, invalid profile contexts, missing rationale/category/source/version and reviewer/time, exact packaging boundaries/pairs/units, GTIN-less and canonical snapshots, normalization and input independence. Example:

```ts
expect(
  validateProductDescription({ ...description, packagingSizeValue: "0", packagingSizeUom: "oz" }),
).toContainEqual({ field: "packagingSizeValue", code: "format" });
expect(
  assessCoverageReview({ ...review, coverageStatus: "unknown" }, "US_FSMA204_PROCESSOR").state,
).toBe("blocked");
```

- [x] Run `pnpm --filter @markiro/domain exec vitest run test/us-product-profile.test.ts`; confirm missing behavior is RED.
- [x] Implement deterministic validators: name required, optional text nonblank/bounded, size positive plain decimal with <=9 integer/3 fraction digits, exact supported units; HTTP(S) source without credentials/control characters, no fetching. Require rationale for non-unknown status, and category/source/version for covered/contains_ftl_same_form. Generic input must remain unknown with empty classification fields. Reviewed statuses also require a valid paired server reviewer/time for assessment.
- [x] Build snapshots with stable explicit property order, trimmed component strings, copied nested packaging, canonical optional GTIN and snapshotVersion=1. Invalid input returns field issues; no invented description fields.
- [x] Rerun focused tests and domain test/typecheck/lint/build.

## Task 2 — Strict product-profile transport contracts

Files: create `packages/platform-contracts/src/traceability/products.ts`, `packages/platform-contracts/test/us-product-profile.test.ts`; export from `packages/platform-contracts/src/index.ts`.

Interfaces: `upsertProductTraceabilityProfileSchema` requires the full editable document, excluding tenant/profile/reviewer/timestamps; `productTraceabilityProfileSchema` adds productId and server review/created/updated timestamps; `productDescriptionSnapshotSchema` validates persisted snapshotVersion=1/component fields/canonical nullable GTIN/sourceProductId. Schemas reuse domain validators and enforce `.strict()` at each object boundary.

- [x] Write failing tests for omitted/extra fields, malicious source schemes, invalid pairs/precision/UOM, nullable GTIN and snapshot identity/version, server-owned metadata injection and malformed persisted review metadata. Example:

```ts
expect(
  upsertProductTraceabilityProfileSchema.safeParse({ ...input, reviewedBy: "actor" }).success,
).toBe(false);
expect(upsertProductTraceabilityProfileSchema.safeParse(input).data).toEqual(input);
```

- [x] Run `pnpm --filter @markiro/platform-contracts exec vitest run test/us-product-profile.test.ts`; confirm RED.
- [x] Implement strict schemas and inferred types, reusing field validation from Task 1. A mutation schema does not authorize the supplied classification: future service must validate with trusted tenant profile, reload permissions, compare field groups and stamp review metadata transactionally.
- [x] Run focused and full contracts tests/typecheck/lint/build; then existing catalog consumer tests, US build and isolation checks.
- [x] Request scoped independent review, close actionable findings, update dated progress/design status without marking PRD rows or US-02 complete, run formatting and diff checks. Leave all changes local and uncommitted.

## Verification record

Completed locally on 2026-09-05. RED: 62 domain and 60 contract cases failed on missing exports/behavior; GREEN: all 122 focused cases pass. Full domain: 689 tests/42 files; full contracts: 238 tests/16 files, no skips. Both package typechecks (including tests), lint and builds pass. API typecheck/build and 45 deployment/composition checks pass; the composition test initially hit sandbox loopback EPERM and passed after authorized local-listener access. The pre-existing Vite config-loader warning remains.

The existing US admin client/component regression passes 71 tests, the US browser build passes, and 17 isolation contracts plus the local release-lock checker pass. Full-worktree formatting and diff checks pass. Scoped independent review reports no Critical, Important or Minor findings. No graph exists in this worktree, so no Graphify update was run.

No new browser/DB/HTTP product-profile workflow was exercised: none is added by this foundation. No provider access, source fetch, hardware checks, deployment, main mutation, commit or push was performed. API persistence, fresh authorization/QA field checks, audit stamps and concurrent full-document write protection are the next integration boundary. Prior catalog/storage changes remain uncommitted and preserved.
