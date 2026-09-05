# MUS-CR-001 — bounded P0 change decision

Status: owner directed reconciliation on 2026-09-05. CR-01–04 below are accepted for implementation, including the owner's explicit server-side case-link P0 confirmation. This record refines [MUS-CLAR-001](development-clarifications.md), not the entire MVP. Original requirement IDs are preserved.

The supplied MUS-001 v0.1 is a historical baseline, not a replacement for subsequent owner decisions. Keep the dedicated US instance, English/U.S. Spanish, non-RF infrastructure and release isolation. Do not copy older scope/claim wording over the revised repository contract. The external CR's implementation-status statements were report-based, not an independent code audit; current evidence below takes precedence.

## Classification and scope

| Decision | Classification                                                         | Requirements                                                                  |
| -------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| CR-01    | Resolve contradictory connectivity claims                              | INT-007, STN-001, NFR-011, REC-008, STN-002–010                               |
| CR-02    | Keep the agreed policy; track calculation and enforcement separately   | REG-009, PLN-007, NFR-007                                                     |
| CR-03    | Explicit P0 behavioral change: available records, not diagnostics only | REG-003, PRD-003, RQ-003, RQ-006, EXP-006; preserve RQ-007                    |
| CR-04    | Resolve ambiguous P0 CSV commitment with a fixed, implemented path     | INT-002; fixed-template subset of REC-007; expanded REC-007/INT-003 remain P1 |

These are not collectively a zero-scope-change correction. CR-03 changes behavior and CR-04 requires a working import and output, while other priorities remain unchanged unless separately resolved.

## CR-01: server-connected operations

Use the operation matrix in MUS-CLAR-001. Acceptance must block FDA/GS1 access while own services remain available and complete the supported US workflow. With own services unavailable, actions report failure and never falsely claim a save/export. No new US offline queue is required. Existing RU Station regression coverage and Windows/hardware acceptance remain separate.

Owner resolution, 2026-09-05: restore server-side LOT-010/TRN-010 and 100 synthetic case records to P0; Station remains deferred. US-04 owns the tenant-scoped bridge, active-link uniqueness and audited link/unlink history; US-06 owns SSCC lookup and the Cases panel; US-11 creates synthetic boxes and any required supporting rows without asserting real production, scans or printing. US-02/04 remain usable without a live Station or a real shift. No existing RU router is exposed merely to obtain case data. Lot genealogy remains P0. Physical case closure, Station sync, scanners and printing are P1 and not implied by seeded rows.

## CR-02: retention without destructive bypass

Keep the calendar policy in MUS-CLAR-001. Check every application-controlled destructive path when retained entities are introduced: record/plan deletion, tenant deletion and foreign-key cascades, seed/reset, scheduled cleanup and object deletion. Void/amend/archive preserve retained history. Underlying infrastructure destruction is outside an application-level guarantee.

Current foundation registers only metadata/health, allowlisted auth and initial profile provisioning. Source inspection finds no exposed tenant/profile deletion endpoint and no scheduled US purge. The shared schema contains cascading relationships; absence of a mounted route is not proof that future business history is protected. No retained CTE/plan/artifact tables or enforcement workflow are implemented yet. Test route denial separately and keep future schema, cleanup and restore checks open. No purge scheduler or comprehensive hold-management module is introduced.

## CR-03: outcome versus execution failure

Both outcomes use the same tenant, scope and authorization boundary. Export-ready passes scoped product checks, not a legal determination. An incomplete response contains actual retrieved records and explicit gaps; preserve draft/amended/voided state and source revision. Missing effective plan is a finding; never label an unsigned draft as effective.

An empty successful retrieval states “No matching records were retrieved for this scope”, not “No relevant records exist”. Authentication, database, storage, rendering and other execution failures remain failed runs/artifacts, never successful incomplete responses. If a value cannot fit a workbook column, preserve it with its source in an explicit available-records/gaps section or safe lossless companion. If that cannot be published safely, fail the artifact/run explicitly. All authorized in-scope rows must be represented or accounted for.

Record generation and download initiation according to the actual audit model; neither proves human review or receipt. Keep mode, scope, time, actor, request/run revision, validation and manifest. No automatic request fulfilment, event finalization, error waiver or direct FDA submission.

## CR-04: operation identity, not file identity

One documented versioned receiving template supports interactive upload → preview → confirmed draft → separate finalization, plus matching receiving CSV output. Preview creates no business records. Import-blocking row errors prevent atomic apply; missing common/header fields allowed by the draft model remain visible and block finalization where required. No unknown-product/location auto-creation or inferred regulatory values.

Scope an idempotency operation key to tenant and command, with a digest covering template version, file content and creation payload. Same key/content retries return the same draft; changed content conflicts. A new explicit operation key can represent a separate delivery with identical file bytes. A file hash is audit/integrity metadata, not a unique identity or permanent reuse ban. Concurrent identical confirmations must create only one draft.

CSV output need not be byte-identical to supplier input: identifiers, leading zeroes, decimal/date/UOM values, source references and lifecycle state must reconcile. Reuse only helpers verified compatible with the US dialect and spreadsheet safety; do not alter historical RU CSV exports. Broader mappings, XLSX imports, all-CTE imports and ERP/EDI remain deferred.

## Development order and evidence

Reconcile these decisions first. Prioritize US-03 fixed CSV and US-07/09 two-outcome export through their existing prerequisites (US-00 identity/capabilities, US-01 references, US-02 lots, event lifecycle). Do not create a parallel import/export subsystem to bypass missing entities. Remaining retention enforcement is tracked in US-00 and the owning future business slices; it does not justify a new deletion feature.

At inspection: branch `codex/us-mvp`, HEAD `b5478b16b`; changes are local and uncommitted. No PR or release was created. Calendar helper is implemented: 36 focused tests, full domain 568 tests pass; typecheck, lint and build pass. Initial 34 tests failed before the helper existed. Independent review found no correctness defects; two exact upper-date boundary tests were added afterward. This verifies pure policy calculation, not persisted holds, cleanup, backup/restore or hosted behavior. The isolation checker and 11 isolation tests pass; remote repository controls are not verified.

Available-record export, fixed CSV, server-connected end-to-end denial checks and retained-history enforcement are not implemented/verified by these results. Browser, Windows/hardware and external acceptance were not performed. The `.pen` visual file and supplied local source files were not modified.

Source mapping: external R1 corresponds to CFR-02/CFR-03 in the repository source register; R2 corresponds to FDA-07. Regulatory anchors are distinct from product-policy choices. No cloud access, publication, customer-data use or release is authorized by this record.

## Local verification record — 2026-09-05

Commands use Node and the repository-declared pnpm 11.22.0 from the installed Corepack cache; `pnpm` below denotes that exact binary, not the mismatched host launcher.

| Check                                                                                                               | Result / limit                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @markiro/domain exec vitest run test/traceability-retention.test.ts`                                 | Initial 34 failures (missing function), then 34 pass; two upper-date boundary cases added and included in full run |
| `pnpm --filter @markiro/domain test`                                                                                | 568 pass in 38 files, including all 36 retention cases                                                             |
| `pnpm --filter @markiro/domain typecheck`                                                                           | Pass, including test types                                                                                         |
| `pnpm --filter @markiro/domain lint`                                                                                | Pass                                                                                                               |
| `pnpm --filter @markiro/domain build`                                                                               | Pass                                                                                                               |
| `pnpm --filter @markiro/api exec vitest run test/us-http.e2e.test.ts` with explicit isolated `US_TEST_DATABASE_URL` | 23 pass, no skipped cases on the final run; disposable test database only                                          |
| `node tools/us-development/check-isolation.mjs` and `node --test tools/us-development/test/*.test.mjs`              | Pass; 11 isolation cases. Local contracts only, no remote enforcement proof                                        |

HTTP verification first hit sandbox `EPERM` before database setup. The authorized local retry ran 22 tests successfully and found one new test-client defect: Node DELETE did not frame the JSON body, so media-type rejection prevented the intended route-denial assertion. The helper now sets byte-accurate Content-Length when a body is supplied; all 23 then passed. Runtime application code was not changed for this test correction. The existing Vite config-loader compatibility warning remains; it is not a test failure.

The new HTTP assertions cover unavailable organization/user-delete routes and authenticated profile deletion, with the tenant still present. They do not prove retention of entities that have not been implemented. No full API/DB/Station rerun, browser test, visual-canvas edit, hardware check, external system test or hosted deployment was performed for this scoped domain/docs increment. The shared domain suite was rerun in full; API checks were scoped to the existing isolated HTTP boundary.
