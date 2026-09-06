# US-03 Receiving Input Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this tightly coupled increment sequentially. Steps use checkbox syntax for tracking.

**Goal:** Validate receiving draft payloads and reference-document metadata without exposing an unfinished event workflow.

**Architecture:** Pure civil-date and decimal validation in the domain package feeds strict shared Zod contracts. Existing TLC/source/UUID/UOM contracts remain authoritative. Snapshot contracts validate without transforming stored document identifiers.

**Tech Stack:** TypeScript, existing Zod/Vitest, Node 24, repository pnpm 11.22.0; no dependencies added.

**Spec:** `docs/us/mvp-contract.md` sections 4–5, `docs/us/p0-change-decision.md` CR-04, and the input/document subset of `docs/superpowers/specs/2026-09-03-us-03-receiving-and-documents-design.md`.

## Global constraints

- Work only in the existing `codex/us-mvp` worktree; preserve prior uncommitted work and all release locks. No commit, push, merge, provisioning or release in this increment.
- English (`en-US`) and Spanish (`es-US`); the current US logo and UI are unchanged.
- Drafts may be incomplete. Schema success is neither completeness, authorization nor finalization.
- No API route, database table, CSV import/export, attachment, lifecycle transition, TLC assignment or snapshot publication is introduced here.
- Quantities are positive exact decimal strings, at most 3 fractional digits and 15 integer digits (the designed `numeric(18,3)` range). No numeric coercion, exponent, grouping separator, sign, rounding or conversion. Entry trims surrounding whitespace but preserves fractional digits.
- Civil dates are exact `YYYY-MM-DD`, years 0001–9999, valid Gregorian days, without timezone conversion.
- Reference identifiers retain case, leading zeroes and formula-looking text; serialization/CSV safety is a later boundary, not permission to alter identifiers here.
- Persisted snapshot reads never trim or normalize stored values.

## Task 1: Shared scalar rules

Files: create `packages/domain/src/traceability/quantity.ts`, `civil-date.ts`, and `test/traceability-receiving-values.test.ts`; update `src/index.ts`.

Produces `parseTraceabilityQuantity(value: string): string` and `isTraceabilityCivilDate(value: string): boolean`.

- [x] Add failing table tests through the public package source entry:

```ts
expect(parseTraceabilityQuantity(" 500.000 ")).toBe("500.000");
expect(parseTraceabilityQuantity("999999999999999.999")).toBe("999999999999999.999");
expect(() => parseTraceabilityQuantity("1.2345")).toThrow(DomainError);
expect(isTraceabilityCivilDate("2000-02-29")).toBe(true);
expect(isTraceabilityCivilDate("1900-02-29")).toBe(false);
```

- [x] Run the focused test and verify missing-function failures.
- [x] Implement string validation using `^(?:0|[1-9]\d{0,14})(?:\.\d{1,3})?$` and at least one nonzero digit; throw `DomainError("QUANTITY_INVALID", ...)`. Civil validation uses a fixed month-day table and Gregorian leap-year arithmetic, not `Date`.
- [x] Run focused tests, domain typecheck and build before contract consumers.

## Task 2: Strict document and receiving-draft contracts

Files: create `packages/platform-contracts/src/traceability/event-values.ts`, `documents.ts`, `receiving.ts` and `test/us-receiving-inputs.test.ts`; update `src/index.ts`.

Consumes the Task 1 functions plus `UOM_CODES_V1`, `platformUuidSchema`, `tlcSchema` and `traceabilityLotSourceSchema`.

Produces `traceabilityQuantitySchema`, `traceabilityCivilDateSchema`, `referenceDocumentInputSchema`, `referenceDocumentSnapshotSchema`, `receivingDraftItemSchema` and `receivingDraftSchema`, with inferred public types.

Document input fields are `type`, `typeOtherLabel`, `number`, `partyId`, `issuedOn`, `notes`. Types: bol/po/asn/work_order/invoice/database_record/batch_log/production_log/other. Number is nonblank, max 128; other label is nonblank max 200 iff type is other; party/date/notes are nullable, notes max 2000. Reject control/surrogate characters in identifiers and labels. Snapshot adds `snapshotVersion: 1` and `documentId`; its strings are validated without transforms.

Draft header fields: nullable `dateReceived`, `locationId`, `previousSourceLocationId`, `receivedAtNote`, `notes`; ordered `items` and unique `documentIds`, each max 100 as a bounded request guard, never truncating input. Each item has nullable `productId`, `lotId`, `tlc`, typed `source`, `exemptReason`, `supplierLotReference`, `quantity`, `unitOfMeasure`, `notes`; `lotLinkMode` create_on_finalize/link_existing and `exemptSupplier` boolean. All fields must be explicit; null represents missing input. Preserve incomplete pairs for the future completeness checker; do not infer source, product, TLC, exemption review or unit. Reject client tenant/actor/status/snapshot/assignmentBasis fields at every object boundary.

- [x] Add failing tests for empty explicit drafts, two-line synthetic receipts, invalid present values, unknown nested fields, source URL restrictions, all document types, other labels, identifier preservation, duplicate document IDs, bounded arrays and lossless snapshot validation.

```ts
expect(receivingDraftSchema.safeParse({ ...draft, status: "finalized" }).success).toBe(false);
expect(receivingDraftItemSchema.parse({ ...item, quantity: " 500.000 " }).quantity).toBe("500.000");
expect(referenceDocumentSnapshotSchema.parse(snapshot).number).toBe("  =0001  ");
```

- [x] Run focused tests and verify failures before implementation.
- [x] Implement `.strict()` objects and scalar adapters; quantity catches only `DomainError` and reports a Zod issue, unknown errors propagate. Reuse domain date checks and existing structured source validation. No fetch, default identity, `.coerce.number()` or silent field stripping.
- [x] Run focused and full contracts tests, typecheck, lint and build.

## Task 3: Integration evidence and handoff

Files: update this plan, `docs/us/implementation-plan.md`, `docs/us/requirements-traceability.md`, append a current input-foundation note to the US-03 design spec, and include the new contract test in the existing check-only `.github/workflows/us-development.yml` selection.

- [x] Run full domain and contract gates, affected existing US admin client tests/typecheck and isolated API contract-consumer tests/typecheck. No database required for these new schemas; do not load primary env.
- [x] Run 17 release-isolation contracts, isolation checker, full formatting and `git diff --check`.
- [x] Review the scoped increment independently; verify any findings against current source and rerun affected checks.
- [x] Record results and remaining work. REC/DOC remain in progress: persistence, live completeness, atomic snapshots/finalization, revisions, UI and fixed CSV are separate increments. No UI/hardware/hosted behavior is claimed by schema tests.

## Verification — 2026-09-06

- TDD: 51 scalar tests first failed on missing exports, then passed; 58 contract tests first failed on missing schemas, then passed. Additional boundary tests bring the focused contract suite to 64 tests. The added snapshot UUID test first reproduced a case transformation, then passed after removing transforms from snapshot UUID reads only.
- Domain: 865 tests across 46 files, typecheck, lint and build pass.
- Contracts: 381 tests across 19 files, typecheck, lint and build pass.
- Existing US admin clients: 68 tests across five files and admin typecheck pass.
- Isolated API entry/environment/health: 59 tests across four files and API typecheck pass. Loopback HTTP was exercised; no database was required or changed. A Vite configuration compatibility advisory remains, not a test failure.
- All test counts above have zero skips. Independent read-only review reran both focused suites and found no outstanding scoped issues after the snapshot fix.
- All 17 isolation contracts and the local release-lock checker pass; remote repository settings were not checked.
- Repository `format:check` and `git diff --check` pass. The existing US worktree and prior edits are preserved; no commands changed the primary checkout or its branch.
- No browser, actual receiving API/persistence/finalization, full primary-system regression, hardware, hosted or external-service acceptance is claimed. No local Graphify graph exists. No commit, push, merge or deployment was performed.
