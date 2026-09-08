# US receiving browser

Status: connected locally on 2026-09-08; development-only, release locked. US-03 remains partial.

The [approved lifecycle design](../superpowers/specs/2026-09-07-us-03-receiving-lifecycle-design.md)
and [execution plan](../superpowers/plans/2026-09-07-us-03-receiving-lifecycle.md)
now have a coordinated original-workflow transport increment. Existing create,
save and finalize routes return versioned acknowledgements for new commands and
exact historical results for authorized retries. Record/list reads use the live
lifecycle envelope, readiness is v4, and new finalizations freeze v3. The client
correlates acknowledgements with the captured command and always reads current
state after success. Frozen v1/v2 snapshots are still read without conversion.

Internal amendment saving, QA amend/void, revision history, registry and current
lot-basis methods are implemented. Their new command/history/basis endpoints,
amendment editor, lifecycle controls and history/basis navigation remain pending.
Explicit revision acknowledgement validators are now prepared: they require the
record captured before sending and correlate root, predecessor, reason, versions,
saved data and lot bindings. The active client still rejects explicit revision
inputs before transport; connecting these validators to new commands and their
current-state recovery remains a coordinated follow-up. The current registry uses the
server's default current selection; all-history and four-status query contracts
are available over HTTP, but their complete UI controls are a later increment.
No amendment or void command is enabled through the browser or public routes.

## Available behavior

Receiving joins the isolated US workspace. The registry lists drafts and finalized ordinary or exempt receipts, with an optional status filter, 50-row pagination and literal, bounded event-number search. It does not search product names or TLC. Opening an event always reads its current server record. The editor groups receiving details, ordered product/lot lines and reference documents; only the selected line's detailed controls are mounted. Finalized details use frozen snapshots. Existing Markiro branding, shared components and tokens are retained, with EN-US/ES-US and light/dark layouts.

Read access and receiving write access are independent server capabilities; finalization additionally requires current QA access. An incomplete draft may contain nullable fields and up to 100 lines and 100 unique, ordered document links. Users explicitly choose existing references or enter missing receipt information. Quantity spelling, opaque TLC and civil dates are preserved by the shared contracts. Source type changes require confirmation before clearing populated source details. Saving and checking do not create lots or finalize events; the separate confirmed command below creates/links lots and latches sources. Inventory accounting remains outside this increment.

Active reference pickers provide bounded search and pagination for products, locations, lots, parties and document metadata. Selected IDs are resolved independently of the current search page. Saved archived/missing references are not silently removed; a changed save must satisfy the existing server reference checks. Source URLs remain text, never fetched. Document metadata supports all nine types, including an explicit custom label for Other. Creating metadata and attaching its ID are distinct from saving the receipt. Detaching a document changes only the local link list, not the reusable metadata record. Binary attachments and document edit/delete/archive commands are absent.

## Save and recovery boundary

There is no autosave or automatic retry. A save captures an immutable command with a UUID operation key and, for an existing event, the loaded draft version. While a command is settling, mutation/navigation controls are blocked. A lost or invalid acknowledgement retains input and freezes editing; an explicit retry sends the same command. The client rejects even schema-valid responses whose draft does not match the normalized command. A successful server replay does not create another event or audit entry.

Every successful create/save/finalize acknowledgement is followed by a fresh GET,
including first success and exact historical replay. If the operation is known
to have succeeded but GET fails, the browser retains the acknowledgement, labels
current state unconfirmed and blocks edits, checks and writes. “Retry current
state” repeats only GET; it never resubmits the operation. The fresh record may
already be amended or void, which is displayed separately from its unchanged
frozen content. Void draft content is read-only. V3 retained lot bindings are
identified as retained, not newly created at this revision.

The client also checks the acknowledged version: creation returns version 1;
saving returns the expected version for a no-op or its immediate successor for a
change. Any other version is an invalid acknowledgement, not permission to replace
input with a later server state. These checks do not turn historical results into
current-state reads.

A version or operation-key conflict never overwrites input. Reloading the saved event requires explicit confirmation; failed or cancelled reload keeps the draft and conflict block. An operation conflict before an event ID is known directs the user back to the registry before creating another event. Unknown document creation results similarly retain the same metadata for explicit retry; duplicate metadata guidance directs the user to search for the existing record.

Dirty navigation and page unload warn before discarding input. Language and theme changes preserve the mounted draft. Permission denial refreshes capabilities; session expiry or read-access revocation exits protected content under the existing account-isolation boundary. Unsaved input and pending operation keys are not retained across logout, session loss, page reload or browser closure. After an uncertain result and a new session, inspect the saved receiving registry before creating another event. Cross-session draft recovery is not implemented.

## Saved-draft data check — 2026-09-07

The read-only `GET /traceability/receiving/:id/readiness?expectedDraftVersion=N` checks the saved draft and current tenant-owned references in one repeatable-read transaction. Current read capability, membership, profile and MFA remain required. A stale draft version returns a conflict; invalid input or unavailable storage cannot become a successful result. The response identifies the event, draft version, check time, rule version and SHA-256 input digest. The digest includes the saved record, profile and current reference data, not just the draft version.

Findings are grouped into header, one-based receiving lines and documents. Checks cover date and quantity validity, receiving/previous/TLC-source location descriptions, active records and owners, the receiving location's `receive_at` role, product description and reviewed coverage, source/TLC/product consistency with an explicitly linked lot, and new-lot identity collisions with another line or an existing tenant lot. A reference URL is validated but never fetched. Selected inactive documents or inactive issuers block the check. FSMA-profile drafts require a reference document; the generic profile treats an absent document as a recommendation and explicitly leaves FTR applicability unassessed.

An exempt-supplier checkbox alone is not a reviewed receiving basis. Every exempt line requires receipt-specific rationale, a safe supporting URL and an explicit choice to preserve its received TLC or propose an own TLC when none arrived. Readiness returns the exact one-based exempt review set but never approves, assigns or replaces an identity.

Users explicitly check a saved, unchanged draft. New or edited drafts must be saved first. Any local edit, including edit-and-revert, save attempt, document change or reload invalidates the previous result. Late responses cannot revive it. A version conflict preserves input and offers explicit reload; session loss or revoked read access clears protected results. Results are transient, never automatically polled or persisted. External reference changes are detected on the next explicit check, not monitored in the background.

`Complete` means only that this saved-data check found no blockers at its recorded time. It does not confirm finalization, export readiness or regulatory compliance. No draft, operation receipt, audit entry, lot, source lock or inventory record is written by checking. Future finalization must independently revalidate its authoritative inputs and capture required frozen snapshots in its own transaction.

## Draft/readiness verification — 2026-09-07 (preceding increment)

The new GET collection endpoint returns tenant-scoped summary rows, counts and stable created-time/ID ordering without loading every draft's full body. It adds no audit writes. Store and real HTTP tests cover membership/profile/MFA guards, cross-tenant denial, literal search, pagination, nullable/incomplete rows, archived references and request validation. No additional migration is needed beyond the preceding draft persistence increment.

Focused browser-client and component tests cover safe errors, strict responses, explicit retry identity, conflicts, read-only access, stale reference requests, session cleanup, EN/ES, metadata creation, duplicate links and destructive-source confirmation. The real Chromium journey in `tools/us-development/test/receiving-flow.mjs` creates two lines and a document, loses the first save response after a real database commit, retries without duplication, reloads the application, reopens the draft, and exercises a second writer's version conflict. It verifies exact tenant/actor/target/before/after audit data and captures both locales/themes at 1440, 1024 and 390 pixels. The combined flow also checks page errors, external requests and unexpected browser persistence.

The readiness increment adds pure-rule, strict-contract, browser-client and connected-panel tests plus real disposable-database and MFA HTTP checks. Tests cover current authorization, stale draft versions, unchanged persisted state, changing reference digests, snapshot consistency during a concurrent reference update, archived issuers, malformed/failed reference reads, generic warnings and source/TLC identity conflicts at the 100-line limit. The real browser additionally checks explicit requests, edit-and-revert invalidation, repeated digests, saved-version changes and the readability of every finding above the sticky save bar. No external reference URL is fetched.

Only the exact receiving/document collection paths with optional queries, UUID item paths without queries and receiving UUID readiness paths with exactly one canonical `expectedDraftVersion` query are added to the local browser proxy. Invalid IDs, nested lifecycle/attachment routes, extra readiness query keys and primary-product paths remain closed. The actual proxy smoke checks anonymous access denial and unknown-path refusal. Follow the [browser prerequisites](browser-entry.md#verification): explicit synthetic `US_TEST_DATABASE_URL`, owned disposable databases, and local ports 3100/5174 only. Check-only CI includes the focused suites; operational workflow locks are unchanged. Check results are recorded in [implementation progress](implementation-plan.md#us-03-saved-draft-data-check--2026-09-07).

## Ordinary finalization — 2026-09-07

This increment supersedes the preceding finalization/proxy exclusions only for ordinary receiving. A current QA user explicitly saves, checks that saved version, and opens a confirmation dialog. It shows the event number, exact civil date and captured timezone, line/create/link counts, exact totals grouped by unit, document type/number/date/issuer and non-blocking warnings. Totals use scaled integers/BigInt, including values beyond JavaScript's safe integer range, without altering saved quantities or combining units.

The strict command sends only an operation UUID, expected saved version and readiness digest to `POST /traceability/receiving/:id/finalize`. Its transaction rechecks current authorization/references, creates or explicitly links lots, latches sources, freezes snapshots and writes exact audit. Acknowledgements must match the event ID, confirmed version and digest. Double submission and pending dismissal are blocked synchronously. Unknown outcomes retain the same command in active memory for explicit retry. A fresh application load reads the current record before showing an editor. Historical create/save replay recovery likewise reads the draft/finalized union. Failed current-record recovery keeps editing/checking blocked until a successful reload.

Edits, document changes, save/reload, recheck and QA loss invalidate confirmation. Restoring QA does not resurrect an earlier check/dialog. Session expiry clears the protected workspace; forbidden responses refresh current capabilities. Typed 409 findings retain line/field context and require recheck or reload. Corrupt persisted references are a fail-closed unavailable/503 boundary, not ordinary typed business findings.

Finalized history displays frozen product/location/source/document labels plus historical actor/time. Opening a current lot is explicit, targets its exact UUID, and has a return to frozen receipt history even if the lot request fails. Live labels are never substituted into the receipt. Amend, Void, Export and attachment placeholders are absent.

The local proxy permits only the exact UUID finalize path with no query. Receiving list parameters are bounded `search`, `limit`, `offset`, and optional `status=draft|finalized`; duplicate/unknown parameters and nested commands are denied. Legacy draft-only client lists explicitly request `status=draft`. Other proxy paths, primary runtime, operational workflow locks and request limits remain unchanged. Check-only CI includes the new contract, migration, API/concurrency/snapshot/URL-boundary and client/UI tests.

Real Chromium proof in `tools/us-development/test/receiving-finalization-flow.mjs` runs inside the existing owned fixture after the draft-only assertions. It passed mixed create/link finalization, exact lot IDs/source latches/audit, a genuinely committed lost-response retry, stale-digest conflict, frozen reads after live reference changes, exact lot/back navigation including failed GET, and receiving-operator denial. Confirmation and history were exercised in EN/ES, light/dark, at 1440/1024/390 pixels with keyboard focus, exact totals, documents and horizontal-overflow checks. The complete existing journey passed in 25.78 seconds; the actual proxy smoke passed separately. Representative confirmation and frozen-history screenshots were inspected by the implementer and controller. No MFA screenshots, traces or HAR files were captured.

Post-integration checks passed 284 API tests across ten affected files, 22 receiving DB tests across three files, and 17 isolation contracts. Admin typecheck, lint, primary build and separate US build passed; the five pre-existing primary-app hook warnings and both builds' chunk-size notices remain. Final full-suite totals are recorded in [implementation progress](implementation-plan.md#us-03-ordinary-receiving-finalization--2026-09-07). The primary environment was never loaded or migrated. Full legacy API testing was not repeated because its eight previously documented primary-environment setup failures are unrelated to this browser increment.

## Exempt-supplier receipt review — 2026-09-07

The connected editor keeps received TLC/source/lot input separate from the receipt-specific exemption extension. QA explicitly chooses `Existing TLC` or `No TLC assigned`; the latter reveals a separate proposal and receiving-site source summary. Choosing it fills the source only when empty or already matching. A conflicting source stays visible until the user explicitly corrects it. Switching paths or hiding the exemption does not erase saved input, and there is no supplier-wide approval, select-all, autosave or automatic code generation.

Final confirmation derives the required lines from the saved receipt and requires exact equality with readiness v3. Each initially unchecked line shows resolved product and location labels, previous source, rationale, safe evidence link, received/proposed TLC and physical source. Product/location reads are deduplicated and run only for exempt confirmations; pending, failed, malformed, stale or mismatched metadata blocks confirmation. Edit, save, reload, recheck, cancellation, QA/session loss and stale replies cannot restore checks. An uncertain response freezes every choice and retries the exact same command.

New finalizations write snapshot v2 with the exact reviewed line set and receipt basis. Existing supplier TLC/source remain unchanged; an own proposal is assigned only at the receiving location and records null received TLC. V1 history remains readable without invented review data. V2 history renders only frozen rationale, evidence, handling, reviewer/time and identity descriptions; supporting links open explicitly and are never fetched or previewed by the app.

The real companion `tools/us-development/test/receiving-exemption-flow.mjs` passed inside the existing owned browser fixture after ordinary finalization. It exercised two exempt lines with distinct previous/receiving locations, a second receipt from the same supplier with no inherited review, a genuine server commit followed by aborted delivery and exact-body retry, persisted lot/audit identities, frozen history after live master-data changes and a real receiving-operator 403. EN/ES light/dark layouts at 1440/1024/390 passed keyboard and horizontal-overflow assertions. Safe screenshots were written under `/var/folders/1t/vr4lx9_x5zj65f1bhlk6q5b40000gn/T/markiro-us-browser-Z4wywV`; original-resolution mobile preserve, own-assignment, bottom/footer confirmation, top-of-dialog confirmation and frozen-history images were personally inspected. After the source-label race fix, the final-source journey passed 1/1 in 33.83 seconds (35.71 seconds including setup/cleanup), retaining the existing Node module-type warning. The editor now displays a resolved physical-source name only for its matching selected location ID; delayed, failed and obsolete replies are covered by connected editor tests. Receiving regression passed 99/99, admin typecheck/lint and the US build passed, and the owned database and loopback servers were confirmed closed. No production source changed after this browser run.

Before the source-label follow-up, scoped gates passed 904 domain tests, 469 contract tests, 337 tests in the exact 13-file API list and 1,245 admin tests across 110 files. The final-source full admin rerun after the fix passed 1,248/1,248 across the same 110 files, including all three new race regressions. Typecheck/lint/build passed for domain, contracts, DB and API; admin typecheck/lint, primary build and the two-variable US build passed. DB reported 406 passes and 141 explicit skips across 27 files: the scoped US disposable-database cases ran, while tests needing other database variables remained skipped. Isolation contracts passed 17/17 and actual proxy smoke passed 1/1. Existing CommonJS/module-type, five RU hook, jsdom canvas/navigation and chunk-size warnings remain visible.

The final UI correction wave removed only the incompatible native UTF-16 cap from the proposed-TLC field while retaining the existing 120-code-point contract validation and 121-point rejection. QA confirmation now shows each saved source kind and, for a reference source, its exact saved URL plus the separately resolved location; the exemption evidence URL remains a distinct link. A current complete readiness result now shows the exact pending-QA line list to QA and non-QA users in EN/ES and disappears on edit or stale reply. Focused correction tests passed 35/35, the covering Receiving set passed 106/106, and the fresh full admin run passed 1,255/1,255 across 110 files. Admin typecheck, lint, the primary build and the separate two-variable US build passed; the existing five RU hook warnings, jsdom canvas/navigation warnings and chunk-size notices remain.

The final existing Chromium journey passed 1/1 in 34.36 seconds (35.91 seconds including setup and cleanup) after all production formatting edits. Native `pressSequentially` entry preserved exactly 120 supplementary Unicode points, retained the saved value, accepted no 121st point at the contract boundary, and never used fill or a programmatic value setter. The same run proved the exact saved reference tuple (`web_url`, URL and resolved location with null physical source), kept evidence separate, displayed the pending line list `1, 2` in both locales, and retained the earlier MFA, finalization, delivery-loss, retry, audit, lot, frozen-history, operator-denial, viewport, theme and safety assertions. Safe final screenshots are under `/var/folders/1t/vr4lx9_x5zj65f1bhlk6q5b40000gn/T/markiro-us-browser-AuCcFK`; the EN desktop and ES mobile source-reference and pending-notice originals were inspected without a material defect. Production source hashes matched before and after the final browser run. The owned database contained no leftover temporary browser database, and ports 3100 and 5174 had no listeners. Unaffected backend, domain and DB suites were deliberately not repeated for this frontend-only correction.

## Limits

Cross-event completeness, revision/amendment/void lifecycle, Transformation, Shipping, genealogy, CSV, trace, balances and export remain unfinished. US-03 and the MVP remain partial. No hosted environment, real data, mail, object storage, hardware, native mobile device or screen reader was tested. Fluent Spanish review remains required before operational use. The full primary API/infrastructure suite is not an acceptance gate for this isolated increment and its previously recorded environment gaps remain unresolved. No `.pen` edits, primary-checkout edits, commit, push, merge, publication or deployment are included.
