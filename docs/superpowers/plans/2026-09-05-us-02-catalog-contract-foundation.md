# US-02 catalog contract foundation

**Goal:** Establish the approved shared-catalog GTIN policy and strict US catalog boundary without exposing GTIN-less products to existing RU consumers.

**Architecture:** One shared product model remains the target; separate US and RU instances retain independent databases. A pure domain policy validates the resolved profile and supplied GTIN. Additive US transport contracts do not change existing RU DTOs. Nullable persistence and consumer guards must ship together in a later increment.

**Tech Stack:** TypeScript, existing GS1 domain helpers, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-us-02-product-profiles-and-lots-design.md`, approved catalog decision dated 2026-09-05; `docs/us/mvp-contract.md`.

## Global Constraints

- GTIN is optional only for the two known US profiles and required for RU_CHZ. Unknown profiles fail closed.
- A missing GTIN is null, never a fabricated identifier. Supplied GTINs retain exact existing GS1 validation and normalization.
- This increment changes domain rules and additive US contracts only. No nullable database migration, API route, UI, Station change, release, push, or deployment.
- Preserve all existing uncommitted work. Leave this increment uncommitted. Edit only the task's listed files; the controller owns documentation updates.
- Profile selection is not authorization: eventual services must resolve the trusted current profile themselves, never from these client schemas.

## Task 1: Add the catalog GTIN policy and strict US product contracts

**Files:**

- Create `packages/domain/src/traceability/products/gtin.ts`.
- Create `packages/domain/test/traceability-product-gtin.test.ts`.
- Add exports to `packages/domain/src/index.ts` without changing prior exports.
- Create `packages/platform-contracts/src/traceability/catalog.ts`.
- Create `packages/platform-contracts/test/us-catalog.test.ts`.
- Add exports to `packages/platform-contracts/src/index.ts` without changing prior exports.

### Step 1: Write focused failing tests

Follow test-driven-development. Add tests before implementation; record the initial missing-module failure separately from behavioral RED. Use a minimal throwing scaffold if needed to demonstrate behavioral failures before implementing the logic.

Test `normalizeCatalogGtin(profile: unknown, input: unknown): string | null`:

- Every known profile accepts valid GTIN-8 `96385074`, GTIN-12 `036000291452`, GTIN-13 `4006381333931`, GTIN-14 `10012345678902`, with expected canonical outputs `00000096385074`, `00036000291452`, `04006381333931`, `10012345678902`.
- Both US profiles accept null and undefined as null; RU_CHZ rejects both with `GTIN_REQUIRED`.
- Every profile rejects empty strings, whitespace, surrounding whitespace, bad check digits, wrong lengths, letters, numbers, booleans, arrays and objects with `GTIN_INVALID`.
- Unknown, missing, blank, or incorrectly cased profiles reject even valid or missing GTINs with `invalid_traceability_profile`.
- Failure messages do not echo supplied input. Do not silently trim, coerce or invent identifiers.

Test strict US catalog contracts, including omission versus explicit null and unsupported fields:

- `createUsProductSchema`: `{ name, gtin }`, name trimmed, nonempty, at most 200 characters; GTIN accepts valid raw GS1 strings of the four supported lengths or null, defaults to null when omitted. Valid supplied strings stay as entered (normalization belongs to the service/domain boundary).
- `updateUsProductSchema`: optional name, gtin, archived; no defaults; at least one non-undefined value required. Null GTIN explicitly clears it, omitted GTIN remains omitted. False archived is meaningful. Null name and archived are invalid.
- `usProductSchema`: UUID id, trimmed nonempty name of at most 200 characters, nullable validated canonical GTIN-14 under `gtin14`, boolean archived, ISO offset datetime createdAt and updatedAt. All fields required.
- All schemas are strict and reject unknown fields, including tenantId, profileCode, status, chzProductGroupCode and capacities. Responses reject short valid GTINs and invalid check digits; inputs reject numeric, blank, padded or malformed GTINs.
- Public package exports expose the function, three schemas and `CreateUsProductInput`, `UpdateUsProductInput`, `UsProduct` inferred types.

### Step 2: Implement the smallest coherent policy

Parse the profile first using the existing `parseTraceabilityProfile`. Return null for US null/undefined; throw stable `DomainError` codes otherwise. Reuse `isValidGtin` and `normalizeToGtin14` without duplicating the checksum algorithm. Validate before normalization so invalid-value error messages are generic. Add a short comment clarifying that this function is not an authorization gate.

In contracts reuse existing domain `isValidGtin`, the canonical UUID primitive, and master-data conventions for name, timestamp and meaningful patch validation. No query/list schemas, profile review fields, UOM, lots or speculative adapters in this increment.

### Step 3: Verify and self-review

Use Node 24 from `/opt/homebrew/opt/node@24/bin` and pnpm at `/Users/thevladbog/.cache/node/corepack/v1/pnpm/11.22.0/bin/pnpm.cjs`. Work exclusively in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`. No installs or external resources.

Run focused domain tests, then domain test/typecheck/lint/build. Build domain before contract tests because the package consumes compiled exports. Run focused contract tests, then platform-contracts test/typecheck/lint/build. Format the six scoped files using repository Prettier and run `git diff --check`. Report exact passed/failed/skipped counts, commands and TDD evidence. Do not commit.
