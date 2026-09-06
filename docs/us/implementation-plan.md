# Markiro U.S. Traceability: implementation plan

> Read the [shared MVP contract](mvp-contract.md) first. It resolves cross-slice scope and safety rules and supersedes conflicting draft recommendations below. Target design is not a completion claim; dated increment records below describe verified implementation scope.

- Source: MUS-001 v0.1 (2026-09-03), sections 11, 11.1, 11.2 and 15
- Status: US-00, US-01 and US-02 in progress as of 2026-09-06; no slice complete
- Owner: Vladislav Bogatyrev

![Architecture scope](diagrams/architecture_scope.png)

Figure 1. Architecture scope of the U.S. adaptation as a bounded context inside the existing Markiro repository.

This plan breaks the U.S. adaptation into slices US-00..US-12 and defines an intentionally bounded MVP. Slice status is maintained here; per-requirement status is maintained in [requirements-traceability.md](requirements-traceability.md). Requirements themselves are in [requirements.md](requirements.md), acceptance gates and the MVP checklist in [acceptance.md](acceptance.md), the demo dataset in [demo-scenario.md](demo-scenario.md), the regulatory reasoning in [regulatory-basis.md](regulatory-basis.md), non-goals in [limitations.md](limitations.md), and the working protocol for coding agents in [agent-master-prompt.md](agent-master-prompt.md).

The original 115–156-hour estimate is unvalidated and does not include a proven deployment boundary. Re-estimate after US-00; eight weeks is not a commitment. Deliver the office workflow first. LOT-010/TRN-010 server-side links and synthetic cases are P0 under MUS-CR-001; all new Station behavior remains P1. US-11 owns required screenshots and video; US-12 owns optional landing and supplementary assets.

The requirement matrix owns per-requirement status and slice assignments. A boundary requirement assigned to US-00 is not evidenced until its implementing consumer passes the corresponding test.

## 1. Slices

| Slice | Result                                   | Requirements                        | Hours | Depends     | Status      |
| ----- | ---------------------------------------- | ----------------------------------- | ----- | ----------- | ----------- |
| US-00 | Deployment boundary + baseline + profile | REG-001..012, PRO-001..003, NFR-016 | 5–7   | -           | In progress |
| US-01 | Parties and locations                    | LOC-001..008                        | 8–10  | US-00       | In progress |
| US-02 | Product FTL profiles and TLC lots        | PRD-001..010, LOT-001..009          | 12–15 | US-01       | In progress |
| US-03 | Receiving CTE                            | REC-001..008, DOC-001..002          | 8–10  | US-02       | In progress |
| US-04 | Transformation and P0 server case bridge | TRN-001..014, LOT-010               | 14–18 | US-02/03    | Not started |
| US-05 | Shipping CTE                             | SHP-001..010                        | 8–11  | US-04       | Not started |
| US-06 | Trace graph, search, completeness        | TRC-001..010                        | 9–12  | US-03/04/05 | Not started |
| US-07 | FDA-aligned XLSX adapter                 | EXP-001..012                        | 12–16 | US-06       | Not started |
| US-08 | Traceability Plan                        | PLN-001..010                        | 7–10  | US-00/02    | Not started |
| US-09 | Trace request / mock recall              | RQ-001..008                         | 8–11  | US-06/07/08 | Not started |
| US-10 | Station/label lot link                   | STN-001..009                        | 8–12  | US-02/04    | Not started |
| US-11 | Demo seed, screenshots/video, release    | EVD-001..012                        | 10–14 | US-09       | Not started |
| US-12 | Optional landing and extra assets (P1)   | demo assets                         | 6–10  | US-11       | Not started |

Slice status values: Not started, In progress, Done. A slice is Done only when its Definition of Done from MUS-001 §10.2 is met and its verification report (see [acceptance.md](acceptance.md)) is filed.

### US-00 first increment — 2026-09-05

The [domain foundation plan](../superpowers/plans/2026-09-05-us-00-domain-foundation.md) implements explicit edition parsing, immutable profile allow-lists and feature policies, and edition-specific interface locale selection in `@markiro/domain`. Its 47 focused tests and the full 532-test domain suite pass, along with both domain typechecks and the build. The [design baseline](../design-briefs/us/08-design-baseline.md) contains 128 screens in 18 sections.

The separate US development API now consumes edition parsing and locale policy. Its validated entry rejects unsafe local configuration and production mode; the RU entry rejects explicit US configuration before auth/database setup. Metadata and liveness work, while business readiness deliberately remains unavailable. This is a metadata-only boundary, not an implemented office application. Persistent profiles, provisioning, authorization, frontend/build attestation and infrastructure verification remain open. No deployment or publication is included.

The [development isolation boundary](development-isolation.md) is now prepared locally on `codex/us-mvp`: inherited operational workflows are locked, check-only US CI is defined, and a separate synthetic dependency stack is configured. The [runtime entry plan](../superpowers/plans/2026-09-05-us-00-runtime-entry.md) records this runnable API increment and its limits. It does not complete end-to-end edition isolation or establish hosted infrastructure. US-00 remains In progress.

### US-00 profile persistence increment — 2026-09-05

The [profile persistence plan](../superpowers/plans/2026-09-05-us-00-profile-persistence.md) adds the profile table, a strict initial-provisioning contract and an internal transactional US settings store. It requires a current tenant-settings membership, an explicit US profile and an IANA timezone. The store serializes concurrent initial requests and writes profile, timezone and audit together. Identical retries do not create another audit event; different initial settings conflict. Profile switching and edits are not exposed by this provisioning operation.

Migration and store tests use randomly named disposable databases on the separate local US PostgreSQL. Existing RU defaults remain unchanged. At that increment the US HTTP composition had no profile endpoint or session adapter; the later increment below adds that integration. Requirement rows are not marked complete by storage-only proof.

### US-00 session and HTTP increment — 2026-09-05

The [session foundation](../superpowers/plans/2026-09-05-us-00-session-foundation.md) and [HTTP integration record](../superpowers/plans/2026-09-05-us-00-http-integration.md) add independent US cookies, mandatory per-session MFA, guarded organization selection and initial profile provisioning over the local US API. Real HTTP tests verify fresh membership/capability enforcement, exact profile audit, retry behavior, request boundaries, unavailable schema and safe database cancellation/shutdown.

The server never migrates or provisions users at startup. Overall business readiness stays unavailable; browser integration, recovery and remaining US-00 acceptance are still open. Explicit local synthetic-user provisioning is covered by the increment below. Release locks remain active. This is not completion of the slice or proof of hosted data-location requirements.

## 2. Dependency sequence

### Local owner increment — 2026-09-05

The [local synthetic-owner command](local-owner-provisioning.md) supplies explicit local identity bootstrap with atomic audit, collision/retry safeguards and no MFA bypass. It does not migrate or seed on startup, provision a profile or enable public signup. Tests use disposable US databases. The next US-00 integration surface is the edition-specific browser login/MFA/profile workflow; recovery, auth-event audit and hosted safeguards remain open.

### Browser client increment — 2026-09-05

The [US browser client foundation](browser-client-foundation.md) adds the isolated typed transport for login/MFA, organization selection and initial profile setup, with a shared strict response contract and real HTTP integration coverage. It is not imported by the RU entry. The subsequent browser increment below supplies the separate entry/build, proxy wiring and EN/ES screens; the current RU admin must not be pointed at the US API.

### Browser entry increment — 2026-09-05

The [local US browser flow](browser-entry.md) now supports password login, authenticator enrollment/challenge, backup-code login, organization selection and initial profile provisioning/readback. An independent Vite root outputs `dist-us`, imports no RU screens or translations, refuses non-US configuration, and attests the server before login. Real Chromium checks use the actual Vite proxy and disposable PostgreSQL, including cookie-safe logout during a held MFA request. English and Spanish, desktop/mobile and light/dark states were inspected. This is local access/profile functionality, not completion of US-00 or the operational MVP.

MUS-CR-001 confirms fixed-template Receiving CSV import/output (US-03), two response outcomes (US-07/09), and P0 server case links (US-04/06/11). Implement through the prerequisites below; do not build an isolated substitute pipeline. Retention calculation is implemented in the domain helper (36 tests); storage/hold enforcement and destructive-path checks remain tracked separately. Remaining US-00 acceptance includes recovery, auth-event audit and hosted safeguards. The explicit local owner command has not been applied to the base development database. Business work next follows US-01/02 without enabling deployment or declaring those remaining gates complete.

### US access increment — 2026-09-05

The [isolated US role matrix](access-foundation.md) now resolves the five traceability roles and the existing cabinet identities without extending RU capabilities. Current MFA principals reload role state, stored profile reads accept `traceability.read`, and initial provisioning remains owner/admin-only under a transactional membership lock. This is the first consumer of the policy; event/QA/export endpoints and role administration still need their own enforcement and denial tests. PRO-006 remains in progress.

### US-01 server increment — 2026-09-05

The [master-data foundation](master-data-foundation.md) adds separate US parties/locations, description snapshots, strict contracts, additive migration0115 and US-only CRUD/list/archive routes. Both profiles allow incomplete drafts; QA/manager/owner/admin can edit, other recognized US roles can read. Transactions reload permissions, validate the US profile, enforce tenant/parent boundaries and write full audit snapshots atomically. The remaining OpenAPI 400 union defect is corrected with full-schema regression coverage. The typed browser client, exact local proxy routes and connected EN/ES lists/forms are implemented. The office increment passes 1,071 admin tests and real Chromium CRUD/archive/read-only and held-request scenarios. Scoped final re-review is complete with no remaining Critical or Important findings; Minor picker-reselection residual US01-UI-01 is explicitly deferred in the foundation record. LOC-001/002/004/006 remain partial because finalized CTE consumers and historical exports are not delivered here. No deployment or publication is included.

The subsequent US01-UI-01 correction retains freshly resolved parent states across selection and search, closing the deferred picker defect. Full admin now passes 1,073 tests; focused master-data/app/client tests pass 66, and the existing real-browser flow passes. Independent scoped review has no remaining findings. No shared product schema was changed by this correction.

### US-02 catalog contract increment — 2026-09-05

Implemented `normalizeCatalogGtin` in the domain package and strict US product create/update/read schemas in platform-contracts. The package suites pass 627 domain tests and 166 contract tests, including 28 and 35 focused catalog tests respectively, with no skips. Typecheck, lint and builds pass for both packages. These are pure-rule/contract checks, not database or browser acceptance of a catalog workflow.

The owner approved a shared product model with optional GTIN for the two US profiles and required GTIN for RU, while keeping instances and databases separate. The [first catalog increment](../superpowers/plans/2026-09-05-us-02-catalog-contract-foundation.md) establishes the domain policy and strict US create/update/read contracts. It does not change nullable storage, expose catalog routes or implement FTL reviews/lots. PRD-007 runtime acceptance remains unimplemented until US writes, persistence and consumer denial tests are delivered together. The next increment must audit GTIN-dependent consumers and retain RU validation, operational payloads and barcode behavior before enabling null persistence. No deployment or publication is included.

### US-02 catalog persistence increment — 2026-09-05

The [catalog persistence plan](../superpowers/plans/2026-09-05-us-02-catalog-persistence.md) adds migration0116 and explicit guards for legacy GTIN-dependent consumers. The migration makes the shared product GTIN nullable without changing the active-GTIN unique index or tenant foreign keys. Existing rows receive an `updated_at` migration baseline, not a reconstructed modification history. RU DTOs, Station mirrors and label contracts remain non-null.

The US catalog API is implemented under `/traceability/catalog/products`. It supports bounded literal search, tenant-scoped reads, creation, partial edits and archive/restore. Each operation reloads current membership/profile in its transaction; real mutations write complete before/after audit snapshots atomically. Canonical no-op edits leave timestamps and audit untouched. Active non-null GTIN conflicts return `product_gtin_taken`; changes to GTIN with legacy shift, kiosk-assignment or inventory references return `product_gtin_locked`. Archive/restore preserves product UUIDs. RU readiness and request/response contracts are unchanged; there is no second catalog or exposed RU regulatory field.

Task reviews, the integrated review and one consolidated fix/rereview cycle are complete, with no open findings. The final corrections preserve the existing empty-box and inventory changed-GTIN errors, distinguish corrupt persisted data (sanitized 503) from invalid requests (400), verify every pre-existing product column across migration, and exercise a genuine canonical-GTIN mismatch separately from missing metadata.

Final local verification passes 169 US API tests in ten files without skips, including nine legacy operational-boundary cases, 21 catalog-store cases and nine real catalog HTTP cases, plus session/MFA and master-data regression. The six focused DB schema/migration cases pass on disposable US databases. Domain passes 627 tests; platform-contracts passes 178. The full DB suite passes 236 tests with 141 generic-infrastructure skips. Domain, contracts, DB and API typecheck, lint and build pass; isolation contracts pass 17 tests and compiled executable smoke passes four. No primary or base development database was migrated.

The broader API gate remains incomplete: 1505 tests pass and 1568 skip, while seven generic-DB suites fail setup because `DATABASE_URL` is deliberately unset. Skips and unavailable suites are not passing coverage. The real-pnpm invocation probe passes with Node 24's Corepack shim and the repository-declared pnpm; no toolchain files changed. The existing Vite configuration-loader warning remains visible. These checks establish no browser, hardware, provider or hosted acceptance.

This increment remains local and uncommitted. The catalog browser proxy remains closed; UI, FTL reviews and lots are still pending. US readiness remains 503, and no deployment, main merge or additional push is included.

### US-02 catalog browser increment — 2026-09-05

The [connected catalog workspace](catalog-browser.md) now supplies EN/ES product lists, bounded search, active/archived filters, pagination, current-record detail, creation, partial edits and archive/restore. Blank GTIN is supported, and canonical no-op edits do not send a mutation. Read-only users see no mutation controls. Shared Markiro components and tokens retain the existing light/dark and narrow-screen layouts; there are no RU screen or translation imports. Only exact catalog collection/UUID routes are added to the isolated local proxy.

Async list/detail fencing, mutation ownership through the post-write reload, dirty-close confirmation and translated safe errors protect the workflow. Scoped review identified two gaps, addressed by focused regression tests: successful mutations return keyboard focus to a stable catalog heading after the list settles, and a transient capability-refresh failure preserves the mounted draft while disabling writes. Permissions can be retried inside the form without losing its fields or automatically repeating the write. An explicit read denial still removes protected content, and session expiry exits the workspace. Spanish product status/filter wording uses product-specific forms.

The full admin suite passes 1,103 tests in 97 files without skips. Focused catalog client/component tests pass 30; the combined catalog/master-data regression passes 59. Typecheck, lint, US build and ordinary RU admin build pass. Lint retains five pre-existing RU hook warnings; the RU build retains its existing large-chunk warning. The 17 isolation contracts and local release-lock checker pass. Scoped independent re-review closes both Important findings with no remaining findings.

The real Chromium flow passes against an owned disposable US database with real MFA and HTTP mutations: GTIN-less creation, GTIN validation/canonical edit, conflict recovery, archive/restore with the same UUID, exact audit assertions, auditor read-only detail and keyboard focus/trapping. EN/ES, light/dark and 1440/1024/390px captures have no horizontal document overflow; the 390px auditor panel and its close control remain inside the viewport after its entrance animation. Screenshots were visually inspected. Permission-refresh outage/recovery is covered by component tests, not a fabricated business response in the real-browser scenario.

These checks do not rerun the full API/DB gates from the preceding persistence increment; their infrastructure limitations still apply. There is no hosted, native mobile, hardware or screen-reader acceptance, fluent Spanish review or pixel-level Pencil parity claim. US-02 and PRD-007 remain in progress: FTL review, extended Product Description and GTIN-less lot/CTE consumers are not implemented by this browser increment. No `.pen` edit, base/primary database migration, commit, push, main merge, release or deployment is included.

### US-02 product profile rules and contracts — 2026-09-05

The [product-profile foundation plan](../superpowers/plans/2026-09-05-us-02-product-profile-contracts.md) implements the five manual coverage statuses, profile-sensitive validation, Product Description components, a versioned ten-unit vocabulary and detached version-1 description snapshots. Positive coverage reviews require rationale, category and source URL/version; other non-unknown statuses require rationale. The assessment also requires server review provenance before reporting a reviewed classification. Unknown and exemption-review-required remain blocked prerequisites, and the generic profile never makes an FTR assessment. No rule infers a classification from a product name or RU CHZ group, fetches a source URL or claims package readiness.

Packaging values remain exact positive decimal strings within numeric(12,3), paired with an explicit unit; no coercion, rounding or conversion is performed. Snapshots carry separate copied components and canonical optional GTIN, with no live catalog references or embedded coverage verdict. The strict snapshot read schema preserves pinned text and decimal spelling rather than normalizing an existing artifact.

The full editable profile contract excludes client-selected tenant/profile and reviewer/time fields. Record contracts distinguish unsaved defaults from persisted reviews and reject incomplete provenance. This schema is not an authorization boundary: the next persistence/API increment must revalidate using trusted tenant context, reload capabilities, enforce field-group QA access, protect concurrent full-document writes, and stamp/audit changes transactionally. No profile route or table is added here; `/traceability/products/:productId` remains unavailable and the browser proxy remains closed to it.

Initial focused tests fail before implementation (62 domain and 60 contract cases), then pass. Full suites pass 689 domain and 238 contract tests without skips. Both package typechecks, lint and builds pass; API typecheck/build and 45 deployment/composition tests, the 71-test existing US browser-component/client regression, US browser build and 17 isolation contracts pass. Scoped independent review has no findings; full-worktree formatting and diff checks pass. The plan records the local-listener retry and remaining verification boundaries.

There is no new browser, HTTP, database, event/export, hardware or hosted acceptance in this rules-only increment. Prior browser/database evidence belongs to the dated preceding increments, not to FTL persistence. PRD requirements and US-02 remain partial. Changes stay local and uncommitted; no main edit, push, merge or release is included.

### US-02 product profile persistence and API — 2026-09-05

The [persistence plan](../superpowers/plans/2026-09-05-us-02-product-profile-persistence.md) adds migration0117 and tenant-composite 1:1 profile storage without modifying existing catalog data. The isolated US API exposes GET/PUT `/traceability/products/:productId`, with strict versioned input, server-resolved membership/profile and the existing session/MFA/Host/Origin/JSON boundaries. No RU controller or job is registered, and the browser proxy remains closed to this path.

Reads return revision 0 defaults without creating a row. Explicit saves start at revision 1; the product-row lock serializes concurrent first saves and later edits. Full PUT requires `expectedRevision`; divergent stale writes return 409 `product_profile_conflict`. Identical current saves and immediate retries preserve the entire response, timestamps and audit. Exact packaging values are string-padded to three decimals after strict validation, never rounded or converted. Saved descriptions are independent of later catalog renames.

Managers can edit descriptions but cannot change any coverage field; QA/owner/admin can review or reset coverage. The server stamps actual coverage changes and preserves those stamps for description-only edits. The generic profile rejects classification assertions. Historical reviewer IDs are retained without a live user FK, correcting the draft's deletion behavior so account removal does not erase review attribution. Every mutation and its full before/after audit events commit together; a forced audit failure rolls everything back.

Focused contract/schema tests and the initial HTTP route tests fail before their implementation. Fresh local checks pass 67 focused contract tests, 14 schema/migration tests, and 38 store/HTTP tests. Expanded US API/deployment checks pass 257 tests with no skips. Full contracts pass 245 tests; full DB passes 250 tests with 141 explicit non-US infrastructure skips because `DATABASE_URL` is intentionally unset. DB/contracts/API typechecks, lint and builds pass. Existing US browser-component/client regression passes 67 tests; the US browser build, 17 isolation contracts and four compiled executable checks pass. Review identified one malformed generic-profile provenance case; a failing real-DB regression reproduced it, the correction now rejects it without mutation, and re-review has no remaining findings.

The broad API package run is not green: 1,690 tests pass and 1,411 skip, while eight files fail setup/collection because primary auth/database variables are absent (with follow-on cleanup errors in three files). The final isolated 257-test set and API static/build gates were rerun after the review correction. Full-worktree formatting and diff checks are recorded in the plan; this is not full primary-infrastructure or release acceptance.

No FTL screen, lots, finalized CTE snapshot capture, export readiness, hosted/browser/hardware acceptance or release is included. Migrations were exercised only in owned disposable US databases, never the primary or base development database. Changes remain local and uncommitted.

### US-02 connected product-profile UI — 2026-09-06

The [profile browser increment](catalog-browser.md#product-profile-increment--2026-09-06) connects the existing versioned API to Products. Description, exact decimal packaging and manual coverage review are grouped in one isolated EN/ES form. The generic profile shows not-assessed applicability. QA-only coverage controls, server-owned reviewer/time, read-only inspection, conflict preservation and confirmed reload do not imply event/export readiness. Only the exact UUID item proxy is opened; collections, nested routes, RU routes and release jobs remain closed.

Focused tests were written before the client, proxy and UI implementation. The final full admin suite passes 1,121 tests across 99 files without skips; profile/app/catalog/master-data UI regression passes 75 tests across four files. API profile/store/HTTP regression passes 38 tests on disposable US databases. Admin typecheck and lint pass (zero errors, five existing RU hook warnings); US and RU builds pass with large-chunk advisories, and all 17 isolation contracts pass. JSDOM canvas/navigation warnings are not browser evidence. The broad API suite was not rerun for this frontend-only increment; its previously documented primary-environment failures are not resolved by these checks.

Real Chromium verifies initial GET without insertion, validation, exact decimal PUT, reviewer/time, current revision, saved no-op control, concurrent revision conflict, confirmed reload, exact audit actions and auditor restrictions. It also checks EN/ES and both themes at 1440, 1024 and 390 pixels, with no overflow, unexpected page errors, external requests or new persistent browser draft state. Screenshots were inspected. Only randomly owned fixture databases and loopback listeners were used; the base and primary databases were not provisioned or migrated. Local browser dependencies were reused read-only from the main checkout, and sandbox-local network restrictions required an explicit local verification permission retry.

A real-app regression exposed draft loss when language/theme rerenders changed the session callback identity. Stable callbacks now preserve the draft and avoid an unintended GET. Review found focus loss after access recovery and over-broad draft discard after QA revocation; both were reproduced by failing tests and fixed. Recovery restores the active heading, and a confirmed coverage-only discard retains permitted description/packaging edits without clearing a revision conflict. Re-review reports no remaining actionable findings.

US-02 remains partial: lots, CTE snapshot consumers, export gates, table-wide coverage summaries and history/source suggestions are unfinished. Fluent Spanish review, screen-reader/native-device checks and hosted operation are not covered by local Chromium. Shared frontend skills kept the form on existing components/tokens and made language/theme draft retention part of real-app verification. Changes remain local and uncommitted; no main edit, push, merge, deployment or release is included.

### US-02 lot domain foundation — 2026-09-06

The [lot foundation plan](../superpowers/plans/2026-09-06-us-02-lot-domain-foundation.md) adds pure domain rules and strict field/status contracts, not lot persistence or an interface. TLC entry trims only outer whitespace, rejects controls before trimming, preserves case, Unicode and formula-leading text, and counts the 120-character limit in Unicode code points. Persisted TLC validation does not silently repair a value. Demo suggestions use valid civil dates and make no uniqueness or assignment claim.

Assignment checks separate manual imported entry from receiving and transformation operations; reserved bases and unknown contexts fail closed. Manual status changes follow the complete six-status matrix; shipping recalculation cannot be selected in a client body. Tenant-filtered directed genealogy returns deterministic unique ancestors/descendants, detects a proposed cycle and terminates on existing cyclic input. A 15,000-edge chain is traversed without a depth cutoff. The caller still owns authorization, current/pinned revision selection, transaction isolation and completeness; none are inferred from traversal.

Focused RED/GREEN verification covers 107 domain and 51 contract tests. Full domain tests pass 796 tests across 44 files and full contracts pass 296 across 17 files, without skips. Both package typechecks, lint and builds pass; API/admin consumer typechecks and 17 isolation contracts pass. A test-only empty-array inference error was corrected without changing transition expectations. Independent read-only review found no actionable issues. The check-only US workflow includes the new contract tests; no remote CI run or release setting is claimed.

LOT-002/004/008/009 remain partial. Typed/resolved source identity, source-aware database uniqueness, finalization gaps, origin/snapshot capture, audit persistence, amendment-aware graph storage, routes/UI and case links are not implemented by this increment. The design explicitly removes the earlier nonblank-source shortcut and warns that locking only candidate endpoints cannot in general serialize concurrent graph mutations. No database, browser, hosted or hardware checks were run for this pure domain/contract change; previous dated acceptance remains separate. No local graph exists in this worktree, so Graphify's incremental update is inapplicable. Changes remain local and uncommitted; the main checkout, production data and release gates are untouched.

### US-02 lot persistence and API — 2026-09-06

The [lot persistence plan](../superpowers/plans/2026-09-06-us-02-lot-persistence.md) adds migration0118 and tenant-scoped imported-lot create/list/read plus QA status actions. The strict record contracts retain opaque TLCs and support a location, an exact typed web reference explicitly resolved to a tenant location, or a missing source on an incomplete record. No URL is fetched; scheme case is accepted without normalization. Source completeness is not inferred from a reference/ID. Same tenant/source/TLC is unique independently of product, including after archive; concurrent duplicates return one record/audit and a tenant-safe 409. GTIN-less products work in both US profiles.

QA status actions require current authorization, expected revision and a reason. Data and exact before/after audit commit in one transaction; concurrent divergent writes conflict, and only an identical immediate previous-revision retry by the same actor creates no additional audit. Historical lot actors and audit snapshots survive account deletion. Corrupt stored records, foreign references, archived master data and revoked memberships fail closed. The US controller exposes only four methods with generated OpenAPI; no RU controller or browser proxy path is opened, and readiness stays 503.

Focused RED/GREEN covered domain/source contracts, schema/migration, store and five new authenticated HTTP scenarios. Final lot store plus catalog/profile/lot HTTP regression passes 47 tests without skips; migration/schema checks pass 11 tests on owned disposable databases, including preservation of existing product/profile rows. Full domain tests pass 814 tests across 45 files; contracts pass 315 across 18 files, without skips. Full DB tests pass 261 tests with 141 primary-environment skips. Domain/contracts/DB/API typechecks, lint and builds pass; the admin consumer typecheck also passes. All 17 isolation contracts and three compiled-runtime smoke tests pass; the latter verify production refusal, closed readiness/RU routes and graceful shutdown. Repository formatting and diff checks pass.

The broad API run is not green: 1,724 tests pass and 1,411 skip, with eight failing files / nine failing suites. These are the existing billing, exchange, integrations and subscription-inventory suites that require absent primary DB/auth environment; three teardown errors follow their failed setup. The primary environment was not loaded, and these failures are not presented as US coverage or fixed by this increment. The separate final US API plus deployment/environment/health regression passes all 290 tests across 16 files, without skips.

Independent read-only review found two actionable issues: a current-revision self-transition was treated as a retry, and uppercase HTTP schemes were rejected. Both were reproduced by failing tests and fixed; re-review reports no remaining actionable findings. This increment does not implement lot UI, source/identity corrections, event origin/snapshots, genealogy storage, completeness/finalization, event-derived balances or case links. No new browser, hosted, hardware or external-service acceptance is claimed. Migrations touched only owned disposable US databases, not the base or primary database. No local Graphify graph exists, so no incremental update applies. Changes stay uncommitted in `codex/us-mvp`; the primary checkout and release locks are preserved, with no push, merge or deployment.

### US branch checkpoint — 2026-09-06

Commit `bbe7c1e917cbb89996d9bcecf945eb2388367e46` (`feat(us): checkpoint catalog profiles and lot persistence`) was pushed to `codex/us-mvp` and verified against the remote branch. It contains the preceding catalog/profile/lot increments; their earlier local/uncommitted notes above remain historical. The check-only [US development isolation run](https://github.com/thevladbog/markiro/actions/runs/33996348724) succeeded for this exact commit. No PR, main merge, deployment, release or operational workflow dispatch was performed.

### US-02 lot source corrections — 2026-09-06

The owner approved source-only correction while preserving lot UUID, TLC and product. PATCH `/traceability/lots/:id/source` requires the current revision, a trimmed reason and current `traceability.master_data.write` permission (the same capability as lot creation). It can add, replace or withdraw a source, without claiming completeness. Target locations/references must belong to the active tenant and remain non-archived. All identity, actor, tenant, assignment and lock fields are rejected in the strict body.

Actual changes lock the lot row, increment revision and atomically write exact `traceability.lot.source_changed` before/after audit with reason and server request ID. Unchanged current-revision sources are no-ops; identical same-actor immediate previous-revision retries require the same reason. Status and source changes invalidate each other's retry metadata. Divergent concurrent writes return 409; a conflicting source/TLC correction rolls back through a savepoint and returns only the same-tenant duplicate ID. Audit failure rolls back the source, revision and metadata together.

Additive migration0119 preserves existing rows, adds nullable internal `last_source_reason` and server-owned `source_locked_at`, and guards frozen identity with a hand-maintained trigger. Responses explicitly include `sourceLockedAt`; no API can set, clear or replace it. A nonnull lock blocks every source command, including no-ops/retries, without blocking valid QA status changes. The first latch cannot also replace identity. Future finalizers must use consistent row-lock ordering and latch the unchanged lot in the same transaction as immutable event snapshots; void/amendment must never unlock it. Concurrency tests simulate the lock transaction committing or rolling back, not an implemented event finalizer.

Focused RED/GREEN reproduced the absent source contract/store/HTTP route and missing database lock enforcement. Independent read-only review then found that a combined first-latch/source replacement bypassed the trigger. A failing database test reproduced it; the fix now blocks identity changes whenever either the old or new lock is set. Regression covers source, TLC, assignment basis, product, UUID and tenant replacement, unchanged first latching and later irreversible locking. Re-review found no actionable issues.

Full contracts pass 317 tests without skips. Final DB tests pass 267 with 141 primary-environment skips; the new migration has five passing real-PostgreSQL cases. Contracts/DB/API typechecks, lint and builds pass, as does the admin consumer typecheck. All 17 isolation contracts and four compiled-runtime smoke checks pass. Snapshot comparison confirms that migration0119 changes only the lot table and preserves the snapshot chain. The final isolated US API plus deployment/environment/health regression passes 310 tests across 16 files, without skips. The broad API run has 1,744 passing tests and 1,411 skips, with eight failing files / nine suites requiring absent primary DB/auth configuration and three cascading teardown errors. That environment was intentionally not loaded; this broad gate is not green.

This increment changes contracts, DB schema/migration, the isolated lot store/controller, tests, check-only CI test selection and US documentation. No new browser/UI, finalized-event, hosted or hardware validation is claimed. Only owned disposable US databases were migrated; the base US database and primary checkout/data were untouched. There is no local Graphify graph to update. Source-correction changes remain local and uncommitted after the checkpoint above; release locks stay in place. Lot UI, event integration/completeness, genealogy storage, balances and P0 server case links remain pending.

### US-02 connected lot UI — 2026-09-06

The [lot browser increment](lot-browser.md) connects the registry, imported creation, current detail, approved source correction and QA-only manual status changes. Strict client commands, exact proxy routes, EN/ES shared components, current reference labels and domain transitions remain within the isolated workspace. Historical actor IDs are not invented names; reference labels are explicitly not event snapshots. Source identity and revision rules remain server-owned.

Failing tests preceded client/proxy/UI implementation and review fixes. Review reproduced accidental save on Enter in reference search, cancellation bypassing the known-conflict reload requirement, and a later authentication denial hidden by a faster reference-data failure. Regressions cover each fix, duplicate navigation, held writes, permissions and translated drafts. The real local browser exercises imported creation, source correction, status change and exact audit against its own disposable database, plus responsive EN/ES/light/dark screenshots. Business responses are not mocked in the browser scenario. Final scoped re-review reports no remaining blockers.

Final local verification passes 1,146 admin tests across 101 files without skips, including 25 focused lot client/UI tests. Admin typecheck, lint and both RU/US builds pass; five existing RU hook warnings and chunk-size advisories remain. All 17 isolation contracts, the release-lock checker, root formatting and scoped whitespace checks pass. The final real Chromium scenario and actual Vite/API proxy smoke both pass on owned disposable US databases; desktop EN and narrow dark ES screenshots were visually inspected. JSDOM canvas/navigation warnings are not browser evidence. Full primary API/infrastructure, hosted operation, hardware, native-device/screen-reader and fluent Spanish acceptance were not rerun or claimed.

US-02 remains partial: event consumers/finalization, genealogy storage, balances, case links and export are not implemented. This increment changes only isolated frontend/client/proxy, tests, check-only CI selection and US documentation. Shared frontend design guidance kept the UI on existing components/tokens and the approved grouped layout. Main-checkout state is unchanged; no `.pen` writes, commit, push, merge, release, publication or deployment are included.

### US-03 receiving input foundation — 2026-09-06

The [input-foundation plan](../superpowers/plans/2026-09-06-us-03-receiving-input-foundation.md) adds pure domain rules for exact positive decimal quantities and Gregorian civil dates, plus strict shared contracts for reference-document metadata, lossless snapshot reads and explicitly incomplete receiving drafts. Quantities remain strings within the designed `numeric(18,3)` range; no rounding, timezone conversion, unit conversion or default identity is introduced. Drafts preserve ordered lines, nullable missing values and existing typed TLC/source rules. Unique document links and line/document limits reject malformed requests without dropping entries. Document type and opaque number are first-class data; all nine types are supported without a binary attachment.

RED/GREEN tests preceded scalar and contract implementation. A further regression reproduced UUID case normalization during snapshot reads; the snapshot validator now preserves stored spelling while entry UUID validation remains canonical. Independent read-only review reports no remaining scoped findings. Full domain verification passes 865 tests across 46 files, and full contracts pass 381 across 19 files, with no skips; both packages pass typecheck, lint and build. Existing US browser-client regression passes 68 tests, and isolated API entry/environment/health regression passes 59; both consumer typechecks pass. The new contract suite is included in the existing check-only US workflow.

All 17 isolation contracts, the local release-lock checker, repository formatting and diff checks pass. US-03 remains in progress: this increment adds no API routes, database persistence, live tenant/reference validation, completeness decision, event finalization, frozen snapshot publication, revision lifecycle, UI or CSV workflow. Browser, database, hosted, hardware and external-service acceptance were not exercised by these input tests. Before persistence work, reconcile the old draft's routes/auth composition, nullable draft columns, event timezone, exempt-supplier TLC assignment and downstream revision/void rules against the shared MVP contract and current isolated code. No primary environment was loaded and no database was changed. Work remains local in `codex/us-mvp`, with no commit, push, merge, release or deployment.

### US-03 reference document persistence and API — 2026-09-06

The [document persistence plan](../superpowers/plans/2026-09-06-us-03-reference-document-persistence.md) adds strict record/query/list contracts, the additive `reference_documents` table in migration0120, a transactional store and isolated create/list/detail API. All nine types retain separate type/number data, optional issuer/date/notes and historical attribution. Number identity is tenant/type/issuer-scoped, case-sensitive and retained across archival, with separate null-issuer uniqueness. Duplicate creation returns 409 without overwriting data or adding audit.

Current membership/profile locks protect reads and writes; creation permits receiving, transformation or shipping writers. A supplied issuer must be active and tenant-owned, with a lock through creation and exact before/after audit commit. Audit failure rolls the document back. Filters are bounded, search metacharacters escaped and stored output validated without repair. Actual MFA HTTP tests cover trusted Host/Origin, strict body/query, foreign data, live role changes, server request IDs, safe errors, OpenAPI and still-unmounted event/edit/archive/attachment/RU paths.

Failing tests preceded contracts, schema, store and HTTP implementation. Independent review found PostgreSQL-unsafe search text could return 503 or be rewritten by the driver. Contract/store/HTTP tests reproduced it; the document-local query now rejects NUL/lone surrogates with 400, preserving valid Unicode, trim and length bounds. Re-review reports no remaining actionable findings.

Final contracts pass 400 tests across 20 files without skips. DB tests pass 278 with 141 primary-environment skips; the new schema/migration tests pass all 11 cases on disposable PostgreSQL. Contracts/DB/API typecheck, lint and builds pass, as does the admin consumer typecheck. The isolated US API plus entry/environment/health regression passes 335 tests across 17 files without skips, including 18 document-store and seven new document HTTP tests. All 17 isolation contracts and four compiled-runtime smoke checks pass; release readiness remains closed. Migration snapshot comparison confirms only the new document table/enum and an intact chain.

The broad API run passes 1,769 tests and skips 1,411, but is not green: eight primary-product files fail in setup. A diagnostic rerun confirms nine failed suites caused by absent primary DB/auth configuration and three cascading teardown errors. The primary environment was intentionally not loaded. No new browser/UI, hosted, hardware, attachment or finalized-event acceptance is claimed. Only owned disposable synthetic US databases were migrated; neither the base US nor primary database was migrated. Work remains local and uncommitted in `codex/us-mvp`, with no push, PR, release, merge, deployment or change to operational workflow locks.

Repository-wide formatting and diff checks pass, and the post-format document store/catalog HTTP rerun passes all 46 tests without skips. Receiving persistence, event links, completeness/finalization, frozen snapshots, revision lifecycle, document UI and CSV remain pending. DOC-001/002 and INT-001 stay in progress. The next step is revisioned receiving draft storage using the existing input contracts and tenant-owned reference documents; it must preserve incomplete input and the shared MVP revision/source rules.

1. US-00: edition, provisioning, authorization, data-location inventory and deployment design.
2. US-01/02: parties, locations, product profiles and lots.
3. US-03/04/05: receiving, standalone transformation and shipping.
4. US-06: trace and completeness; US-08 plan can proceed after master data.
5. US-07/09: workbook mapping, immutable request snapshot and package.
6. US-11: reproducible seed, screenshots/video, deployed smoke checks and release evidence.
7. P1: US-10 Station/hardware integration and US-12 landing/extra assets.

Slice hour ranges below are historical planning inputs, not delivery promises. Infrastructure purchase and publication require separate approval.

## 3. Critical path

```text
Profile → locations/products → lots → receiving → transformation → shipping →
trace → export + plan → mock request → release/evidence.
```

Station integration must not block the main critical path. US-10 remains P1: the administrative end-to-end workflow, generated artifacts and repeatable demo already form the MVP.

## 4. MVP boundary

### 4.1 P0: required for the MVP

- this approved specification and the regulatory source register;
- working code for Receiving, Transformation, Shipping, TLC/source, genealogy, plan, request and XLSX;
- reproducible synthetic fresh-cut apple demo;
- tagged public release with commit SHA and hashes;
- CI/test report and limitations;
- architecture/data dictionary/requirement traceability;
- generated XLSX, plan PDF, validation report, request report, manifest;
- 12–18 screenshots and a 5–8 minute English video;
- a dedicated U.S. deployment whose persisted production surfaces are not hosted in the Russian Federation.

### 4.2 P1: product hardening that does not block the MVP

- review by a U.S. food-safety/traceability professional;
- structured feedback from industry practitioners;
- design-partner or limited pilot evaluation;
- Station offline case-to-lot demonstration;
- deeper imports, partner mappings and operational controls.

### 4.3 Future product scope

The MVP does not include all CTEs and exemptions, direct FDA integration, EPCIS, RFID, full EDI, commercial billing, self-service onboarding, multi-region operations or enterprise certification. [limitations.md](limitations.md) records the complete boundary.

### 4.4 Why this remains an MVP

The MVP implements one synthetic processor scenario with three CTEs, one trace path and one export package. It deliberately omits broad integrations, additional supply-chain roles, commercial operations and enterprise hardening. Detailed requirements preserve correctness inside that narrow workflow; they do not turn the MVP into a complete production platform.

## 5. Risks and scope control

P/I = probability / impact.

| ID   | Risk                               | P/I           | Mitigation                                                                            |
| ---- | ---------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| R-01 | Regulatory baseline changes        | Medium/High   | Source refresh per release; versioned adapters; specialist review.                    |
| R-02 | Scope creep into full U.S. ERP     | High/High     | Only CTE/lot/request/export; no accounting/inventory rebuild.                         |
| R-03 | Automatic legal classification     | Medium/High   | Manual reviewed coverage status; disclaimer; no exemptions engine.                    |
| R-04 | Overengineering item serialization | High/Medium   | Lot-level core; SSCC/case optional; no item requirement.                              |
| R-05 | Limited U.S. product feedback      | Medium/Medium | Structured reviews with food-industry practitioners after the MVP works.              |
| R-06 | Export diverges from FDA template  | Medium/High   | Versioned field registry + golden fixtures + source mapping review.                   |
| R-07 | Russian workflow regression        | Low/High      | Feature profiles, additive migrations, full repo gates.                               |
| R-08 | Synthetic demo looks artificial    | Medium/Medium | Coherent quantities/docs; external reviewer; show real Markiro foundation separately. |
| R-09 | Evidence claims exceed tests       | Medium/High   | Verification report separates automated/browser/hardware/external.                    |
| R-10 | Personal/confidential data leak    | Low/High      | U.S.-hosted data plane, synthetic demo, privacy scan, redaction and access audit.     |
| R-11 | Estimate does not cover scope      | Medium/Medium | Station/EPCIS/EDI are P1/P2; protect critical path.                                   |
| R-12 | Product presented as legal advice  | Medium/High   | Claim language matrix and clear product limitations.                                  |

## 6. Final rule

> When the P0 checklist is closed, the MVP release is frozen. New ideas enter P1 or P2 unless they fix a defect or close a regulatory gap in the defined end-to-end workflow.
