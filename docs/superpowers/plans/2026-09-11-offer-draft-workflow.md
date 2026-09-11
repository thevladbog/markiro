# Offer draft workflow implementation plan

**Goal:** Make saved proposals editable, expose actions and recovery guidance, and use the shared calendar in document creation.

**Architecture:** Reuse the document composer and catalog validation for draft replacement. A platform-only update uses optimistic concurrency and the billing mutation journal; published snapshots remain immutable. Preview reads saved data independently of issuance eligibility.

**Spec:** User-approved direction in this task, supplementing `../specs/2026-09-10-offers-registry-preview-design.md` and `../specs/2026-09-10-commercial-p0-design.md`.

**Constraints:** Preserve tenant, family, revision, request links and issued snapshots. Keep current acceptance/payment rules. Use `@markiro/ui`, RU/EN copy and platform capability boundaries. Commit, push and PR are authorized; deployment remains outside scope.

## 1. Draft persistence and preview

- [x] Add isolated Postgres regressions to `apps/api/test/offer-preview-documents.test.ts`: legacy draft previews without publication; update keeps identity, recalculates totals, audits exact change, rejects stale writers and issued offers, retries once without duplicate audit.
- [x] Run the focused suite with the local development environment and observe the missing operation / legacy preview failure.
- [x] Add a strict `platformOfferDraftContracts.update` request (expected timestamp, idempotency key, editable fields; no tenant or status), route inventory and protected endpoint.
- [x] Extract shared draft preparation from `platform-offer-draft.ts`; use it for create and transactional update under seller/family/offer locks.
- [x] Keep issuance validation on publish; allow marked draft previews to show saved legacy lines.

## 2. Editing and recovery

- [x] Add UI regressions for edit navigation, preserved saved values, save failures, explicit blockers and preview retry.
- [x] Add `/offers/:offerId/edit`, load the saved offer into `DocumentComposer`, lock tenant identity and submit through the update contract. Keep the exact retry payload and key on uncertain network results.
- [x] Show row-level legacy terms guidance with a catalog link; allow explicit replacement by removing the old line and adding a reviewed catalog version. Never silently refresh terms or prices.
- [x] Keep state-relevant action buttons visible with reasons, add an explicit open link to the registry, and preserve server authority for every mutation.

## 3. Custom controls and verification

- [x] Add a rendered calendar regression; replace the native date input in `DocumentSummary.tsx` with shared `DatePicker`, including locale, clear and keyboard labels. Verify existing selectors already use custom `Select`/`Combobox`.
- [x] Build changed contracts before consumer checks. Run affected contracts/API/SaaS tests, typecheck, lint and builds, then diff/format checks.
- [x] Exercise the editor and blocked/ready drafts in the browser on desktop and mobile; inspect the default light theme and capture screenshots. Report mocked browser data separately from production checks.
- [x] Update the local Graphify graph and review the final diff before publication.

## Implemented behavior

- `PATCH /platform/offers/:id/draft` requires `billing.write` and a platform session. The strict request rejects tenant/status/revision changes. Only the latest draft can be edited; `expectedUpdatedAt` rejects concurrent edits and an idempotency key replays the exact committed result.
- Draft preparation uses the same catalog and price validation as creation. Saved commercial snapshots are not hydrated from the current catalog. An operator explicitly replaces a legacy line with a reviewed catalog version. Issued offers retain their existing revision and decision workflow.
- Preview renders saved draft lines even when commercial terms are incomplete. Publishing still validates parties, the seller tax policy, all commercial terms and the preview fingerprint.
- The editor retains entered values and its original concurrency token through background refreshes, source errors and uncertain retries. An uncertain save locks changes until the exact attempt is resolved.
- The shared document summary now uses `DatePicker`; tenant, account, catalog, VAT and activation controls use the existing custom components. This also updates the date control in invoice and act creation.

## Verification record

- Contracts: 158 tests passed; typecheck, lint and build passed.
- SaaS-admin: full suite passed (334 tests); after the final source-refresh fix, all 66 affected-form tests passed. Typecheck, lint and build passed.
- API: 23 isolated Postgres tests passed, including draft update/replay/conflict and HTTP authorization. Five OpenAPI contract tests, two route-policy tests and all four subscription/route-inventory tests passed. Typecheck, lint and build passed. Full isolated API suite: 3511 passed, 3 failed, 51 skipped (317 files, 844 seconds). The three failures were the two missing-key Signer cases and the new route inventory entry; both failing files passed their focused reruns after the respective environment correction and inventory fix. The entire suite was not rerun after those focused corrections.
- Browser: local production build with explicit demo API fixtures, 1440 px desktop and 390 px mobile. Confirmed old-term guidance, edit navigation, line replacement/save/return, preview enabling publish, custom selectors, calendar selection and keyboard navigation. Native select/date controls: zero. No page overflow at 390 px; the position table retains its existing local horizontal scrolling. Narrow toolbar wrapping verified.
- Screenshots are in the task visualization directory: `offer-blockers.png`, `offer-editor-calendar.png`, `offer-editor-mobile.png`, `offer-creation-calendar.png`.
- Dark theme was not exercised: the application bootstraps `ThemeProvider` with light theme and provides no theme switch. Production, external object storage and final release were not exercised; deployment was not requested.
- Scoped formatting and `git diff --check` passed. Repository-wide formatting also scans pre-existing untracked `exports/android-brand-options-2026-09-11/` files; their formatting warnings are outside this change and those files were preserved.
- Graphify AST update completed. Its existing extraction warnings concern unrelated Kotlin/Astro files; no semantic API call was used.

- The full-suite Signer failures were reproduced as missing `CHZ_TOKEN_ENCRYPTION_KEY`; all seven Signer tests pass on a separate temporary database with a generated ephemeral test key. No production key or repository environment file was changed.

- The seven wholly skipped API files require opt-in configuration: `CHZ_TOKEN_ENCRYPTION_KEY` (Signer tasks/scheduler and ChZ exports), `INVENTORY_TEST_DATABASE_URL` (two inventory integration suites), `LOCAL_INFRA_SMOKE=1` (Mailpit/MinIO), or live National Catalog configuration. Their external behavior is not claimed as verified.

## PR base reconciliation

Rebased onto `8cc3c7a92` after Commercial V3 landed in main. Kept the upstream catalog representation guard in shared draft preparation and passed the negotiated version through draft creation and editing. Added regressions that V1/V2 clients reject P1 selections and V3 can update the draft; the SaaS editor sends the current V3 header. Updated the OpenAPI schema inventory to 163. After reconciliation, 37 API tests (including V3, previews and route inventories), 66 form tests and the draft schema test passed.
