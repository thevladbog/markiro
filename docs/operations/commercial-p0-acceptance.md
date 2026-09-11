# Commercial P0 acceptance map

Scope: [approved P0](../superpowers/specs/2026-09-10-commercial-p0-design.md), implementing the P0
portion of MKR-FR-COMMERCIAL-002 v1.2. Rows identify actual test assertions and local evidence;
a deferred portion is not a passing acceptance claim. Task reviews and the final whole-change
review, including its scoped fix re-review, completed on 2026-09-11. Run results, command logs and
browser artifacts are recorded in the local SDD task/final-fix reports and browser checklist;
this table is the durable requirement-to-evidence index.

Test paths below are relative to their stated package. API means `apps/api/test`, SaaS means
`apps/saas-admin/test`, domain means `packages/domain/test`, contracts means
`packages/platform-contracts/test`, and DB means `packages/db/test`.

Final review correction evidence for AC-06/AC-10/AC-40 and FR-CAT-04:
`commercial-terms.test.ts` and `document-draft.test.ts` exercise all four ordered two-plan
combinations and reject three-or-more plans. API `commercial-paid-period.test.ts` covers the
issuance validator and both paid paths, active/scheduled consecutive years, exact per-line audits,
retained invoice payment on invalid composition, historical partial successes, selection/retry
ordering, a real PostgreSQL advisory/row-lock wait, and accepted-offer invoice ownership.
The allowed pair is `on_application`, then `after_current`; other issued compositions require
review without changing snapshots or purchased terms. SaaS `catalog.test.tsx` covers 100 +20%=120,
included VAT, numeric zero, Without VAT, divergent fractional kopecks and stale price/period refresh.
UI browser acceptance and the final full gate are separate recorded results, not inferred here.

| AC    | P0 evidence                                                                                                                                                                                                                                                                                       | Remaining boundary                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01    | Contracts `commercial-terms.test.ts`; API `platform-catalog.e2e.test.ts` “negotiates zero quotas, rejects legacy mutations before writing”; API `subscription-quotas.e2e.test.ts` “denies the first line at zero quota with a truthful limit and preserves read access”; SaaS `catalog.test.tsx`. | New admission/device policies are P1.                                                                                                            |
| 02    | Contracts `commercial-terms.test.ts`; API `subscription-quotas.e2e.test.ts` “allows unlimited quotas”; SaaS `catalog.test.tsx` and `document-draft.test.ts`.                                                                                                                                      | Unrelated existing guards retain their meanings.                                                                                                 |
| 03    | Contracts and DB commercial-terms tests cover negative/fractional/out-of-range quotas; SaaS catalog tests reject empty Limited. API `offer-totals.test.ts` and `commercial-paid-period.test.ts` reject calculated line/VAT/aggregate overflow with 400 and no partial document.                   | Unit-price schema validation alone does not prove calculated totals fit storage.                                                                 |
| 04    | API `commercial-paid-period.test.ts` “retains an add-on purchased interval beyond the base and quantity counts resources”, plus duplicate/cross-path fulfillment tests. Parent browser addon flow: two annual units ×1000 =2000; applied quantity2; base interval unchanged.                      | Full effective-rights display/enforcement is P1.                                                                                                 |
| 05    | Contracts `commercial-terms.test.ts`, `commercial.test.ts`; API catalog tests validate supported effects and duplicate keys.                                                                                                                                                                      | New module registry keys are P1.                                                                                                                 |
| 06    | API `commercial-paid-period.test.ts` annual invoice and directly paid accepted offer, application-time capture, retries and exact audit. SaaS invoice/offer editor tests. Parent real invoice and addon UI payment/application; annual invoice PDF.                                               | Real bank settlement and customer acceptance remain external. Local offer publication was checked; its unaccepted payment correctly returned409. |
| 07    | Domain `commercial-terms.test.ts` monthly original anchor, leap-year restoration, Moscow day, historical overlap and invalid instant tests; API paid-period renewal test.                                                                                                                         | Offline grant expiry is P1.                                                                                                                      |
| 08    | Contracts service/license discriminants; API one-time offer/billing tests; SaaS document tests preserve literal service units.                                                                                                                                                                    | Recurring services and service ledger are P2.                                                                                                    |
| 09    | Domain Without VAT versus numeric zero tests; API `commercial-catalog-review.test.ts` explicit seller policy; SaaS legal/catalog tests and parent real NPD seller UI.                                                                                                                             | Actual NPD eligibility and legal/accounting review remain external.                                                                              |
| 10    | API catalog review tests reject forged VAT, missing names and stale seller/draft revisions; paid-period issuance stale-review test; SaaS `commercial-issuance.test.ts`. Parent stale409 and review/publish browser flow.                                                                          | Server checks are authoritative after UI preview.                                                                                                |
| 11    | DB `commercial-terms-migration.test.ts` retains historical snapshots; API paid-period “preserves frozen invoice bytes”, frozen offer VAT conversion and historical conflict tests; print renderer tests. Parent stored PDF hash unchanged and new PDF visually inspected.                         | Never regenerate old documents to backfill names/policy.                                                                                         |
| 12    | Contracts trial days positive-or-null; API `tenant-owner-activation.e2e.test.ts` exact9-day trial and one activation event; `station-pairing.e2e.test.ts` rotates an active station key without extending a trial, preserves subscription/event rows.                                             | New terminal licensing rules are P1.                                                                                                             |
| 13–23 | No P0 claim of new production/module/device enforcement. Existing guards and recovery suites run as regressions.                                                                                                                                                                                  | P1.                                                                                                                                              |
| 24    | Supported-key validation and one-time service discrimination in contracts/catalog tests.                                                                                                                                                                                                          | Combined CHZ/National Catalog runtime enforcement and full pilot registry are P1.                                                                |
| 25–39 | API paid-period add-on test proves independent purchased interval and base-bound effective interval. Existing subscription-expiry and recovery tests retain prior behavior.                                                                                                                       | New grace/grant/downgrade/device policies are P1; these ACs are not complete.                                                                    |
| 40    | API paid-period repeated application, direct offer versus derived invoice race, cancellation ownership and exact audit/rollback tests.                                                                                                                                                            | New offline grant replay machinery is P1.                                                                                                        |
| 41    | API `subscription-access.guard.test.ts` safe reads and delegated recovery; `subscription-expiry.e2e.test.ts` same-tenant pre-expiry shift recovery, mixed accepted/quarantined subset, kiosk replay and content-bound admission.                                                                  | New recovery policy is P1; no provider/hardware proof.                                                                                           |
| 42    | API catalog/tenant platform authorization and zero-representation tests; catalog stale review and paid issuance tests; platform route/OpenAPI inventories.                                                                                                                                        | Downgrade and future effective-rights previews are P1.                                                                                           |
| 43–48 | P0 contracts reject unsupported recurring service combinations.                                                                                                                                                                                                                                   | P2 service accounting; not complete.                                                                                                             |
| 49    | DB additive migration test compares legacy rows through128 and after129, retaining null quotas and snapshots.                                                                                                                                                                                     | New module-rights migration policy is P1.                                                                                                        |
| 50    | API `report-commercial-p0-impact.e2e.test.ts` exact annual-label/monthly-period, paid null-end, missing names/policy and frozen-offer tax/amount categories. Paid-period tests reject ambiguous legacy application.                                                                               | Production inventory and approved corrections are external; no inferred periods.                                                                 |
| 51    | API commercial-version tests preserve opaque history and reject unknown versions; catalog/tenant tests prove real V1/V2 zero negotiation and write denial; offer details use strict negotiated representations; SaaS `commercial-v2.test.ts`.                                                     | Upgrade all affected platform consumers before zero publication; installed-client inventory is external.                                         |
| 52    | Additive DB migration tests plus [rollback limits](commercial-p0-rollout.md#rollback-limits).                                                                                                                                                                                                     | Data used by newer clients cannot be safely dropped/converted for an older schema. No destructive downgrade was exercised.                       |
| 53    | No external-quota-to-paid-upsell change in this diff.                                                                                                                                                                                                                                             | Provider limits/explanations and access acceptance remain external/P1.                                                                           |
| 54    | Read-only report fixture asserts exact IDs/no payloads, byte-equivalent source rows and deterministic output. PostgreSQL write-attempt probe fails25006 inside the report transaction. CLI invalid arguments produce only the safe error.                                                         | No strict production enforcement toggle; unmanaged-tenant migration readiness is P1.                                                             |

## Local visual and document evidence

Parent-owned browser evidence covers real platform authentication, seller policy save, catalog
create/review/stale conflict/publication/clone/edit, and changed forms in Russian and English at
1440×1000 and390×844. Invoice create/issue/payment/application and offer create/publication were
exercised. An attempted payment of an unaccepted offer remained blocked with readable409 feedback,
retained reference input and no page error. A two-unit annual addon invoice applied once without
changing the base subscription. Parent final money probe returned400 `commercial_amount_out_of_range` for price999999999999.99 ×quantity2, left the invoice list unchanged and retained the entered price/quantity with readable UI feedback. These are synthetic local fixtures, not production sales.

The application-generated annual invoice PDF was downloaded from the owned private local object
store and checked visually/textually for year69000, agreed activation rule, Without VAT and one
unclipped A4 page. Current P0 document renderers are Russian-only; bilingual UI and saved English names do not establish English PDF support. An earlier document's stored bytes remained unchanged. Browser screenshots,
PDFs and exact hashes stay in the parent-owned local evidence package; no private auth files or
customer data are published in this repository.

Final browser acceptance also covered VAT added to price (100 + 20 = 120), included VAT, numeric
zero, Without VAT and the separately displayed fractional-kopeck invoice/offer totals. A stale
review refreshed the payable amount without publishing automatically. Invalid two-immediate-plan
composition showed a readable error and sent no create request. Changing the second line to
after-current produced one paid invoice with an active annual term and the next scheduled annual
term; repeat application preserved both intervals. RU/EN narrow error states remained readable.

An auxiliary screenshot refresh during a dependency rebuild hit a development HMR auth-context
interruption. The local diagnostic records the matching module updates and console errors;
fresh pages after the rebuild passed unchanged assertions. No authentication source was changed
or warning suppressed. The successful browser checks above used settled pages.

## Verification results and external boundaries

Final local checks completed on 2026-09-11. The forced workspace run passed all 13 package test
suites: 745 files and 8,810 tests, with four conditional API skips. It completed 45 of 52 tasks
before an API test-only type error stopped the command. After preserving the same assertion with
a typed invoice-line read, the 33 affected tests, API typecheck, all seven unfinished tasks and
a fresh API lint passed. Product source remained unchanged between these runs. The original
aggregate command's failed exit is retained; these results are combined verification coverage.

Production-bundle contracts passed 542 tests with no skips; workspace format and diff checks also
passed. The initial contract attempt was restricted by local store/container/listener permissions;
the same source passed with those local permissions. Full command logs and source hashes are in
the local final-fix report, with durable completion recorded in the
[implementation plan](../superpowers/plans/2026-09-10-commercial-p0.md#completion-evidence--2026-09-11).

The separate `INVENTORY_TEST_DATABASE_URL` was set only for the test process to the owned
`DATABASE_URL`, so all 22 inventory sync/source tests ran. Three optional `LOCAL_INFRA_SMOKE`
cases remained skipped because their fixed Mailpit HTTP8025 endpoint differs from the owned
sink at55825. One live National Catalog test lacked provider credentials. These four skips are
not infrastructure or provider acceptance. Existing compiler/bundle/runtime warnings and five
hook lint warnings in unchanged Admin pages were preserved, not suppressed.

The actual changed-path CI classifier is evaluated on tracked and untracked scoped files. Its
selected jobs describe ownership, not evidence that remote CI, Station Rust, Windows or hardware
ran. Task and final code reviews are complete. Remote CI, production deployment, real
payments/provider access, English PDF generation, legal/tax acceptance, native device and
physical printing checks were not performed by this local P0 verification.

## Publication integration evidence

Publication required integration with main at `0758ba834`, including its new offer workspace
and clean/signed print variants. Migration 0127 and its snapshot are unchanged; the commercial
migration is 0128, with the same SQL and a new correct snapshot predecessor. Fresh test/browser
databases exercised the combined chain.

Focused integration checks passed 137 API tests, 146 contract tests, five migration tests,
17 workspace tests and 13 editor tests. They cover strict legacy/V2 workspace contracts, frozen
seller policy/terms, preview and issuance consistency, amount bounds and existing paid-period
and print-variant regressions. The workspace can project its saved lines to a truthful legacy
response; zero-quota refusal remains at quota-bearing catalog and tenant boundaries.

Real local browser acceptance passed annual offer creation, workspace display, required preview,
preview-bound publication, and clean PDF download. Eight RU/EN, light/dark, desktop/narrow cases
passed with no page/server/console errors. The one-page A4 PDF preserves the Russian document
name, one-year application rule, RUB 69,000 and Without VAT. The earlier browser evidence remains
separate; no private sessions or signed download URLs enter the repository.

Final publication verification covers all 52 workspace lint/typecheck/test/build tasks and all
13 package suites: 759 passing files, 8,935 passed tests and the same four conditional API skips.
The forced aggregate command stopped after 46 successful tasks on an incoming standalone-invoice
test fixture missing required V2 commercial terms. After correcting that fixture and its
inconsistent source total, all failed/unfinished tasks and the affected SaaS typecheck passed.
Original source-offer, tenant and absent-request assertions remain; exact frozen line values are
now asserted too. This is combined coverage, not a green exit of the original aggregate command.

A second test-only correction points the separate browser tool's model type import at the built
API declaration, avoiding compilation of API implementation under the tool's settings. Its
typecheck and all 19 offer browser tests passed. The browser suite uses mocked APIs and actual
rendered HTML/CSP; actual endpoint/PDF evidence is recorded separately above. Product source
remained byte-identical through these corrections and the passing 546 production-bundle contracts.
Full workspace formatting, final documentation formatting and staged/unstaged diff checks passed.

Integration review and scoped re-review are complete with no open Critical/Important finding.
The reviewed 135-path PR scope was reconciled against current main, and all 4,052 frozen tracked
files matched before this final documentation-only record. Remote CI and the external acceptance
boundaries above remain separate from local verification.

## Agreements integration follow-up

After PR #503 was opened, main advanced to `d6ae5c123` with the agreements registry. Its migration
0128 and snapshot are preserved exactly. Commercial P0 now uses `0129_commercial_terms.sql`;
the SQL is byte-identical to the reviewed commercial migration, and its generated snapshot has
the incoming 0128 snapshot as predecessor. The migration fixture now starts through 0128 and
also compares an existing agreement row before and after 0129, including its exact JSON values.

Both commercial and agreement translations, exports and routes are retained. The combined
OpenAPI inventory contains 154 schemas. Earlier publication checks above describe the prior
integration; follow-up verification is recorded separately for the new main.

Follow-up verification covers all 52 workspace lint/typecheck/test/build tasks and all 13 package
suites: 766 passing files, 9,006 passed tests and the same four conditional API skips. The forced
aggregate run stopped after 30 successful tasks with exit 143/SIGTERM during DB tests, without
an assertion failure; the signal's source remains unknown. All remaining tasks completed in
separate runs. Two initial SaaS parallel first-render waits timed out; timing diagnostics and
the full unchanged suite with `--no-file-parallelism` passed 321/321. Assertions, timeouts and
tracked configuration were not changed. These are combined verification results; the interrupted
aggregate and initial parallel failures remain recorded.

Production-bundle contracts passed 546/546 after workspace builds settled. The earlier concurrent
attempt changed DB output mtimes during its immutability check, with identical file contents;
that failed attempt is retained. Full workspace formatting and final diff checks passed. A fresh
owned PostgreSQL database exercised the complete migration chain through 0129, including the
saved-agreement regression and all 22 inventory tests. The four optional infrastructure/provider
skips retain the boundaries stated above.

The bounded conflict-resolution review found no actionable issues. All 4,082 frozen tracked files
matched after verification, before this documentation-only record. Earlier actual browser/PDF
and separate browser-tool results above belong to the preceding publication integration; browser,
provider, native/Windows and physical acceptance were not repeated for this conflict resolution.
Detailed task, source-hash and diagnostic records remain in the ignored local
`.superpowers/sdd/2026-09-11-pr503-conflicts/` evidence directory.
