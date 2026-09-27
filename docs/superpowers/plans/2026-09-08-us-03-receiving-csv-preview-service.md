# Receiving CSV Preview Service Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven-development. Continue inline under the owner's selected execution mode; preserve prior dirty work and do not commit or publish.

**Goal:** Resolve and persist a tenant-owned CSV preview with metadata-only audit, and reopen it under fresh authorization, without creating receiving events.

**Architecture:** Reuse byte preparation, current Receiving-write authorization and the repeatable-read retry wrapper. Resolve references in the existing product/lot/location/document lock order. Store versioned findings and a deterministic normalized proposal; validate stored evidence before returning it. No controller or module registration is added.

**Tech Stack:** Node 24, pinned pnpm, TypeScript, Zod, Drizzle/PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-us-03-receiving-csv-import-design.md` (approved).

## Constraints

- Only the existing isolated US worktree; release locked, no primary/base DB migration.
- Current membership/profile plus `RECEIVING_WRITE` are required before parsing create/read inputs.
- Exact product ID or canonical GTIN-14; no name/external-reference/location-code fallback.
- Same-tenant active references only. Missing and foreign references have identical findings and disclose no foreign labels.
- Invalid CSV rows remain visible; any file/row/reference error means no applicable proposal.
- Null values allowed by the existing draft contract stay null. Cross-field completeness and QA decisions remain finalization responsibilities.
- Snapshot original bytes/header/findings and resolved product IDs. Use SHA-256 over ordered, schema-normalized version/file-hash/header/draft content; exclude preview ID, filename, clock and actor.
- Preview lifetime remains 24 hours. Reopening expired evidence is permitted; it is not permission to apply.
- No event/lot/operation writes, new dependency, HTTP/proxy route, body-limit change, deletion, apply command or export.

## Task 1: Pure proposal and persisted-evidence validation

**Create:** `apps/api/src/modules/traceability/receiving/us-receiving-csv-preview.ts` and `apps/api/test/us-receiving-csv-preview.test.ts`.

**Interface:** `receivingCsvResolutionSchema` has ordered `{rowNumber,productId,issues}` rows and header issues. Row issues name the original CSV column and `not_found|inactive`; header issues name the field and nullable document index. `buildReceivingCsvProposal(prepared,resolution)` returns `{proposedDraft,previewDigest}`. `receivingCsvPreviewResponse(row)` returns a validated internal record with original/normalized header, parsed content, saved resolution, proposal, hash, actor and timestamps. This is not an HTTP response contract yet.

- [x] Test missing exports, content-only identity, preserved row bindings and rejection of inconsistent stored metadata.
- [x] Run focused tests and observe the missing implementation failures.
- [x] Implement strict resolution parsing and positional/selector checks. Build proposals only when all input/reference checks pass, then parse `receivingDraftSchema` to establish deterministic property order. Hash:

```ts
createHash("sha256")
  .update(
    JSON.stringify({
      templateVersion: prepared.input.templateVersion,
      fileSha256: prepared.fileSha256,
      header: prepared.input.header,
      draft: proposedDraft,
    }),
  )
  .digest("hex");
```

On persisted reads, reprepare original bytes/header, compare saved parser evidence, validate resolution, reconstruct the proposal, and compare the stored proposal/digest/count/hash. Corruption returns only `receiving_csv_preview_unavailable`, never raw CSV or repair writes.

- [x] Run the pure suite, typecheck and inspect failed-boundary coverage.

## Task 2: Authorized tenant resolution, persistence and audit

**Create:** `apps/api/src/modules/traceability/receiving/us-receiving-csv-references.ts`, `apps/api/src/modules/traceability/receiving/us-receiving-csv-store.ts`, `apps/api/test/us-receiving-csv-store.e2e.test.ts`, `apps/api/test/us-receiving-csv-concurrency.e2e.test.ts`, and the synthetic input helper `apps/api/test/support/us-receiving-csv-fixture.ts`.

**Interface:** `resolveReceivingCsvReferences(tx,tenantId,prepared)` returns the resolution. `UsReceivingCsvStore(db).createPreview(tenantId,actorUserId,input,requestId)` and `.getPreview(tenantId,actorUserId,id)` return the internal validated preview. Tenant/actor are trusted service arguments, never body fields.

- [x] Write real disposable-US-DB tests for success, duplicate files, same/foreign/missing IDs and GTINs, every reference category, archival, current roles/profile, raw failure persistence, exact metadata audit, corruption, expiry reads and zero business writes.
- [x] Run the suite against the missing store before implementation.
- [x] Implement both methods in `receivingTransaction`; call `authorizeUsMasterData(..., US_CAPABILITY.RECEIVING_WRITE)` before parsing or reading a preview. Create locks current referenced rows in sorted product/lot/location/document order. ID queries include archived records to report inactivity; GTIN uses the active record if one exists, otherwise a same-tenant archived match is inactive. Ambiguous active resolution fails closed.
- [x] Insert preview and `traceability.receiving.csv_previewed` audit in one transaction. Audit target is `receiving_csv_preview`; `after` contains only import ID, version, file SHA-256, row count, proposal availability and digest. No filename, raw data or URLs enter audit.
- [x] Test actual audit insertion failure rolls back the preview. Hold real membership/product update locks and verify a waiting preview retries against committed revoked/archived state, rather than persisting a stale applicable proposal.
- [x] Run the complete focused service suite and relevant Receiving regressions; rebuild DB before consumers if schema sources change (none planned here).

## Task 3: Verification and scope record

**Modify:** this plan, `docs/us/development-isolation.md`, and check-only `.github/workflows/us-development.yml` test selection.

- [x] Add pure and disposable-service tests to the existing check-only job without altering permissions/locks.
- [x] Run API typecheck, lint, build, focused pure/service/concurrency regressions, 19 isolation/entry contracts, formatting and diff checks.
- [x] Record exact results and fixture cleanup. Explicitly leave MFA/HTTP, browser, apply/replay and CSV output unproven by this service checkpoint. Full primary API infrastructure tests remain outside the isolated scope.

## Implementation checkpoint — 2026-09-08

Three internal server modules now implement proposal identity/evidence validation,
tenant reference resolution and authorized transactional create/read. No HTTP
module/controller imports the store. The existing repeatable-read retry wrapper
is reused unchanged; every retry reloads authority. GET validates the saved
snapshot without current catalog resolution and never appends an audit or repairs
stored values. Public paths/body limits are unchanged.

TDD: all 29 initial service tests and 10 proposal tests failed against empty
modules before implementation. Further corruption checks demonstrated six real
gaps before fixes: findings referring to absent input fields, repeated findings,
and silently normalized UUID spelling in persisted resolution. Those now fail
closed. A TypeScript discriminated-union access was corrected to narrow directly
on `source.kind`, without a cast or a behavior change.

The seven-file final focused regression passed 158/158, no skips: CSV input (17),
proposal/evidence (15), service (33), actual lock races (4), and existing Receiving
draft/original-command/lifecycle cases (89). API source/test typecheck, full lint
and Nest build passed after the final code changes. The raw input helper, DB
schema/migration and existing Receiving command implementation are unchanged in
this checkpoint. INT-002 stays in progress; atomic apply/replay, HTTP/MFA,
connected UI and safe CSV output remain open.

The subsequent [apply binding storage checkpoint](2026-09-08-us-03-receiving-csv-apply-storage.md)
adds the tenant/content relation to a successful operation without registering
an apply command. Transactional draft creation, replay and live-reference checks
remain the next service increment.

### Wider verification and limits

The full API package was also attempted with `DATABASE_URL` unset and only the
guarded US fixture URL enabled: 2,434 cases passed, 1,411 skipped; eight files
failed during suite setup/declaration (324 files total, 501.62 seconds). This is
**not a green full-package gate**. The failures are in unchanged
`billing-accounts.e2e`, `exchange-credentials.e2e`, `exchange-orders.e2e`,
`exchange-import.e2e`, `exchange-protocol.e2e`, `integrations-delete.e2e`,
`integrations.e2e` and `subscription-route-inventory` tests. Their `loadEnv` calls
require ordinary database/auth/pepper settings before absent-infrastructure skips
can finish; they do not import the new CSV service. A targeted eight-file rerun
reproduced the setup failures. The temporary diagnostic report is
`/tmp/markiro-us-api-env-check.8XCryU/results.json` (suite-hook messages are not
fully represented by Vitest's JSON reporter).

An isolated Billing rerun with six explicit synthetic auth/origin/pepper values
and `DATABASE_URL` still absent completed with its two cases skipped. This
verifies the setup limitation, not Billing functionality. No ordinary database,
credentials or environment file was loaded; no unrelated test or product code
was changed to conceal the failures. Existing Vite config-loader and synthetic
negative-path log output remains visible.

Nineteen isolation/entry tests and the release checker passed with the new
check-only selections. Repository-wide formatting and final scoped checks passed.
Read-only cleanup verification found zero disposable `markiro_us_profile_*`
databases and no preview table in base `markiro_us_dev` after the full run.

No CSV HTTP/session/MFA, browser, spreadsheet, hosted deployment or external
service acceptance is claimed. Those paths remain closed or unimplemented.
Changes stay unstaged in the existing `codex/us-mvp` worktree; no push, PR, merge,
release, primary-checkout edit or base migration was performed.
