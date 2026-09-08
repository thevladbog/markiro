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

Amendment saving, QA amend/void, revision history, registry and current lot-basis
methods are implemented. The development-only API now exposes amend/void/history
and lot-basis endpoints and accepts strict explicit revision save/finalize inputs.
The browser client and exact proxy paths now support these commands and bounded
history/basis reads. QA lifecycle dialogs now start a correction, cancel a saved
draft or void a current receipt, with explicit current-state recovery. The amendment
editor now supports retained-line edits, frozen comparison, saved-data checks and
explicit QA finalization. Exact revision navigation and bounded history controls
and lot-basis cards are connected. Explicit revision commands require the
record captured before sending and correlate root, predecessor, reason, versions,
saved data and lot bindings. Missing, mismatched or stale context is rejected
before sending; the client clones it before its first await. Validated structured
conflicts retain their bounded context, not raw server errors. Commands do not
automatically retry or GET; the connected dialog owns explicit retry and the
required current-state read. The registry defaults to current selection and now
exposes all-history and four-status filters, with a separate revision column.
Current QA users can edit and explicitly save amendment drafts; receiving-write alone does not grant that access.
No hosted or released API is enabled by these local changes.

## Revision navigation and history — 2026-09-08

Saved receipt views show their revision, correction reason and explicit links to
current, pending and previous records when those differ from the displayed record.
History loads only on request, with 50-row pages and a 100,000 offset bound.
Rows distinguish revision/status and correction/void reasons; the displayed
revision is marked separately. Opening a row fetches its exact ID and verifies
the receipt root, number and time zone. It never redirects a historical revision
silently to the current one. Existing detail views keep original finalization
facts separate from amendment/void actor, time and reason.

The registry exposes `current`/`all` selection and all four statuses. Selecting
Amended explicitly selects all history; choosing current selection clears that
incompatible status. Other statuses filter the selected history without widening
it. Search and filters survive returning from an opened revision, and changing a
filter resets its bounded page.

Navigation reuses the workspace lock and dirty-input confirmation. A declined or
failed navigation keeps local input and the displayed receipt intact. Retry sends
only the selected GET, never a mutation. History loading, failed validation and
an empty later page are distinct. Obsolete responses are discarded on unmount;
read/session denial is delegated to existing access recovery. No persistent cache,
automatic polling, write permission, API route or release surface is added.

The connected regression suite covers exact historical/current navigation,
failed-read recovery, unrelated history rejection, dirty-input preservation,
current/all selection, bounded paging, 401/403 and late replies. Real browser
proof extends the owned MFA/API/PostgreSQL fixture through
`tools/us-development/test/receiving-history-flow.mjs`. Detailed check totals and
safe screenshot evidence are recorded in the execution plan. Existing Markiro
components/tokens and EN/ES light/dark layouts are retained; no `.pen` change.
At this checkpoint, lot-basis cards, contextual conflict presentation and wider
Task 5 acceptance remained open. The subsequent basis increment below supersedes
only the first item. This is local development evidence, not release acceptance.

Verification: full admin 1393/1393 in 118 files without skips; typecheck/lint,
primary and US builds, 19 isolation/browser-entry checks and release guard pass.
After the final mobile token adjustment, focused regression passed 34/34 and
the US build passed again. The complete Chromium journey passed in 51.46 seconds
(54.05 total), including 44px mobile button targets in EN/ES light/dark and
horizontal-overflow checks at 1440/1024/390. Safe screenshots are under
`/var/folders/1t/vr4lx9_x5zj65f1bhlk6q5b40000gn/T/markiro-us-browser-aXmhid`;
the final ES dark mobile image was personally inspected. Existing five primary
hook warnings and known JSDOM/module/chunk notices remain. No native mobile,
screen-reader, fluent Spanish or hosted/external acceptance is claimed.

## Amendment check and finalization — 2026-09-08

QA can explicitly check a saved, unchanged correction and finalize that exact
revision. The check must match the root, predecessor and lifecycle/draft versions;
edits, reloads and QA changes invalidate transient results. Lifecycle conflicts
block another command until an explicit current-record reload.

Confirmation distinguishes retained, newly created and newly linked lots and
explains replacement of the effective receiving basis. Retained identities and
the frozen predecessor remain unchanged. Exempt lines require a fresh per-revision
review: closing/reopening confirmation clears its checkboxes. A retained own TLC
is labelled previously assigned, never presented as a new assignment.

The explicit v2 command captures the predecessor, lifecycle/draft versions,
readiness digest, review set and operation key. Unknown delivery retries exactly
that command; an acknowledged result with failed current-state read retries GET
only. No automatic retry, persistent approval or new API surface is introduced.

Seven focused connected UI tests cover captured commands, wrong-predecessor
checks, QA loss, typed conflicts, exact retry, GET-only recovery and retained TLC
review labels. Full admin tests pass 1384/1384 across 117 files without skips;
typecheck, lint, primary and isolated US builds pass. The existing five primary-app
hook warnings and environment/build notices remain.

The real local MFA/API/PostgreSQL companion
`tools/us-development/test/receiving-amendment-finalization-flow.mjs` proves fresh
review, committed-but-lost finalization/exact replay, unchanged lot records and
frozen predecessor, replaced receiving basis and one exact before/after audit.
EN/ES light/dark layouts pass at 1440/1024/390. Safe screenshots from the first
successful full journey (44.24 seconds; 45.89 total) are under
`/var/folders/1t/vr4lx9_x5zj65f1bhlk6q5b40000gn/T/markiro-us-browser-1LcEdY`.
Its EN light desktop and ES dark mobile confirmation images were personally
inspected. These are local Chromium checks on fixture-owned synthetic databases,
not hosted, native-device, screen-reader or fluent Spanish acceptance.
The unchanged-source journey passed again in 42.20 seconds (43.70 total), with
safe screenshots under
`/var/folders/1t/vr4lx9_x5zj65f1bhlk6q5b40000gn/T/markiro-us-browser-m0yTti`.

This supersedes the check/finalize exclusion in the earlier editor checkpoint
below. History navigation followed in the subsequent checkpoint above; basis cards
and contextual conflict presentation remain pending. Tasks 4/5 and US-03 remain
partial. No release or deployment is enabled.

## Amendment editor and frozen comparison — 2026-09-08

Opening a correction reads its current record and exact frozen predecessor before
enabling editing. Root, event number, revision, time zone and active pending-pointer
context must agree. Failed or mismatched reads leave only explicit reload/back.
QA loss destroys transient editor state; restoring QA reads saved state again.

Retained lines expose quantity, unit, supplier reference, notes and (for exempt
receipts) rationale/evidence. Lot/product/TLC/source identity, original link mode
and exemption handling remain frozen summaries. Own assignments retain the absent
received TLC and original proposal, independent of current header location.
Reordering preserves `previousLineNo`; added lines carry null; removing a line
does not remove it from the original comparison. Reference-document links and
non-identity header facts remain editable. A new exemption review is required
before eventual correction finalization, not inherited from the original.

Explicit save sends the captured lifecycle/draft versions and stable operation
key. Unknown delivery retries the same payload; acknowledged saves with failed
current reads retry GET only. Saving does not alter the current receipt or its
lot support. At this earlier checkpoint, correction checking and finalization
were not connected; the subsequent checkpoint above supersedes that restriction.

Comparison is alongside the editor at 1440 and uses keyboard-operable tabs at
1024/390 without losing unsaved input. Existing Markiro branding/components/tokens
and light/dark themes are preserved. The real local MFA/API/database journey
proved committed-but-lost amendment save/replay, a single draft-version advance,
stable reordered bindings, unchanged frozen original and subsequent cancellation.
It passed twice: 42.08 seconds (43.79 total) and 44.43 seconds (46.16 total).
Safe screenshots are under
`/var/folders/1t/vr4lx9_x5zj65f1bhlk6q5b40000gn/T/markiro-us-browser-spu6wo` and
`/var/folders/1t/vr4lx9_x5zj65f1bhlk6q5b40000gn/T/markiro-us-browser-PdcvKl`.
The first run's EN light desktop editor and ES dark mobile comparison were
personally inspected. These are Chromium viewport checks, not native mobile or
screen-reader acceptance. No hosted/external acceptance or release is implied.

## Lifecycle dialogs and recovery — 2026-09-08

Current QA users can start a correction from the effective finalized receipt or
void that receipt/saved pending draft. A required reason, captured live record,
lifecycle version and (for draft void) draft version belong to one explicit
operation key. The workspace mutation lock is held from opening the dialog until
the operation's current-state read settles or the user explicitly abandons it.
Duplicate confirmation, navigation and dismissal during requests are blocked.
Unknown outcomes offer the exact same command; acknowledged operations with failed
GET offer only a current-read retry. Rejected commands require a fresh read before
another operation. QA/session loss clears the protected confirmation, and restored
QA does not restore the reason or operation. No persistent cache or automatic retry
is introduced.

Void previews read the current server-derived basis for each distinct frozen lot
and identify those losing their last support. A failed preview disables confirmation
until an explicit successful retry. The preview is advisory; the server rechecks
concurrency and dependencies. Cancelling an amendment preserves the effective
receipt and basis. Voiding the effective receipt preserves lot identity, status,
source lock and frozen history. Existing Markiro components/tokens, EN/ES copy and
light/dark themes are reused without a new visual system.

The connected UI suite covers eight cases, including duplicate-send locking,
same-command retry, GET-only recovery, failed basis preview, QA loss/restoration,
401/403 boundaries and rejected-command recovery. The real Chromium companion
`tools/us-development/test/receiving-lifecycle-flow.mjs` extends the existing MFA
fixture with committed-but-lost amend delivery, exact replay, draft cancellation,
effective receipt void, failed current GET/retry, exact audit payloads and unchanged
lot business records. EN/ES light/dark dialogs were exercised at 1440/1024/390.
The complete journey passed 1/1 in 39.35 seconds (41.08 total). Safe screenshots
are under `/var/folders/1t/vr4lx9_x5zj65f1bhlk6q5b40000gn/T/markiro-us-browser-20aCJw`;
the ES dark mobile void dialog and EN light desktop correction layout from this
successful run were personally inspected. No native mobile,
screen reader, hosted environment or external service was tested.

This dialog checkpoint preceded the editor increment above; Task 5 is still partial.
Revision links and history filters followed in the checkpoint above. Remaining
work includes lot basis cards and contextual conflict presentation.
The current receipt's actions are hidden while an amendment is
pending; the pending draft can be opened from the existing current registry and
cancelled. US-03 remains partial and release locked.

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

## Cancellation and void-retry acceptance — 2026-09-08

The existing real-MFA Chromium fixture now creates and cancels correction 2, then
creates correction 3 with a different ID. Both cancelled revisions remain in
history and can be opened through their exact UI links with their own reasons.
The current finalized receipt, lot records and complete receiving-basis response
remain unchanged by either cancellation.

For final-receipt void, the fixture lets the server commit and then drops the
response. The UI preserves the reason and retries the exact same command. Both
HTTP 200 acknowledgements are identical. A separate failed GET after the replay
offers only a current-state read retry. Five exact lifecycle audits cover two
amendments, two draft cancellations and one final-receipt void; the retry adds
none. The last-basis token advances once and lot business fields do not change.

This increment extends browser acceptance only; no product/UI/server contract,
dependency, migration or release behavior changed. It does not establish hosted,
screen-reader or native-device acceptance. Remaining Task 5 browser coverage
includes multiple simultaneous receiving supports and delayed-read/authorization
recovery scenarios, followed by cross-task final gates before CSV.

## Contextual lifecycle conflicts — 2026-09-08

Save, saved-draft checks, finalization and amendment/void dialogs retain validated
structured conflict context. EN/ES explanations distinguish a changed lifecycle,
an existing pending correction and locked retained-lot identity, with exact
reported line numbers and translated field labels. Server messages, arbitrary
fields and raw exception text are not rendered. Existing generic notices remain
the fallback for other or unavailable context; the reserved downstream dependency
contract does not enable a dependency browser or correction operation.

The presentation adds no requests, retry mechanism or persistent cache. Existing
reload confirmation preserves dirty input if declined; a successful explicit read
clears obsolete context. A failed read retains the reason and conflict details.
Pending correction recovery uses the existing sequence: reload the receipt, then
explicitly open the now-current pending-correction link. It does not navigate
using an unverified conflict pointer or automatically cancel another draft.

Focused connected tests cover save-input preservation, declined reload, typed
readiness/finalization conflicts and EN/ES pending-conflict read recovery. The
owned Chromium journey creates a real concurrent amendment while the dialog holds
an older lifecycle, receives HTTP 409, preserves the entered reason, then reaches
the pending draft with GET-only recovery and an unchanged saved record. New EN
light conflict screenshots at 1440/390 were inspected. This is not hosted,
native-device, screen-reader or fluent Spanish acceptance. Wider Task 5 acceptance
remains open; the MVP is not ready for release.

## Ordinary TLC native input — 2026-09-08

The ordinary line editor no longer imposes a 200-unit HTML `maxLength`, which
previously cut supplementary Unicode characters off at 100 points. Entry preserves
the complete input; the existing shared TLC contract still accepts at most 120
Unicode code points and rejects invalid/control characters. Save reports the
invalid line/TLC without silently truncating the user's text or sending a write.
There is no change to lot identity rules, draft versions or server validation.

The EN/ES controlled line-editor regression proves 120-point preservation and
121-point contract rejection. The real browser companion
`tools/us-development/test/receiving-tlc-input-flow.mjs` enters native key events,
saves 120 points exactly, then enters a 121st and verifies a visible TLC error,
zero mutation requests and the complete unchanged saved record. It runs after
the existing lifecycle scenarios in the owned synthetic fixture, retaining the
exempt-TLC native-input proof. The new focused test is included in check-only CI.

## Lot receiving basis and return navigation — 2026-09-08

The [lot detail](lot-browser.md#current-receiving-basis--2026-09-08) now reads current
receiving support independently of lot identity/status. Its count describes
supporting revisions, not receiving lines. Exact revision links fetch and validate
the selected record's ID, root, number, revision and referenced lot/line bindings.
If the revision became historical after the basis read, its exact frozen content
is still shown; navigation never silently substitutes the current revision.

Failed reads keep the lot visible with explicit retry. Receipt views entered from
a lot offer Back to lot; a further receipt-to-lot visit retains the receipt return
and original lot context, including failed lot lookups. Existing dirty-editor
confirmation, pending-operation lock and access/session callbacks remain in use.
There is no persistent navigation cache, polling, automatic mutation or new route.
The real read-only browser companion verifies unchanged complete lot/receipt DTOs,
zero business writes, failure recovery and EN/ES light/dark responsive layouts.
Detailed verification and remaining Task 5 scope are recorded in the execution plan.

## Multiple receiving supports — 2026-09-08

The synthetic browser companion
`tools/us-development/test/receiving-multiple-basis-flow.mjs` creates and finalizes
a second independent receipt linked to the same lot through real authenticated
commands, then voids both receipts through their exact lot-card links. Support
counts move from two to one to none. Before the first void the selected lot is
absent from the last-basis warning; before the second it is present. The remaining
revision link stays exact after the first void and disappears after the last.

Both operations preserve the complete lot record and frozen receipt content.
Basis and lifecycle versions advance once per applicable operation; exactly two
void commands produce two exact tenant/actor/target/before/after audit records.
This verifies existing rules and adds no product behavior. The complete browser
journey passed twice, with new EN light captures at 1440/390; desktop and all three
mobile support states were inspected. No new Spanish-specific multiple-support,
native-device, screen-reader or hosted acceptance is claimed. Delayed-read and
lifecycle authorization recovery remain open before cross-task final gates.

## Delayed reads and lifecycle access recovery — 2026-09-08

The synthetic `receiving-access-recovery-flow.mjs` companion holds an actual
successful detail response until the user has left Receiving for Products. Its
delivery cannot reopen the departed receipt, and returning to Receiving requires
an explicit selection. The lifecycle companion also holds the successful
current-state read after an acknowledged void: retry, navigation and dismissal
stay blocked until the read settles, without another mutation.

For correction and void, the owned fixture revokes QA after the confirmation
dialog has opened. The real command returns 403; current access is refreshed,
the dialog/reason/retry state is cleared and navigation is released. Restoring
the original role and explicitly re-entering the workspace reloads capabilities;
the next dialog is empty and cannot submit without a new reason. The two rejected
commands leave the complete receipt and tenant audit rows unchanged. Role changes
are test setup in the owned disposable database and are restored in `finally`,
not a new product permission-management workflow.

A connected component test additionally resolves an old acknowledged read after
QA loss/restoration and opening a new dialog. It cannot replace the view, clear
the new reason or release the new dialog's lock. These are test-only acceptance
additions for existing rules, not polling or automatic authorization refresh on
external membership changes. New recovery scenarios use EN; hosted, native-device,
screen-reader and fluent Spanish acceptance remain separate. Cross-task final
gates and acceptance-document reconciliation are still required.

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

Receiving amendment/void, exact revision history and independent lot support are
implemented locally, with the dated recovery/browser evidence above. Cross-event
completeness, actual downstream-consumer validation, Transformation, Shipping,
genealogy, CSV, trace, balances and export remain unfinished. US-03 and the MVP
remain partial. No hosted environment, real data, mail, object storage, hardware,
native mobile device or screen reader was tested. Fluent Spanish review remains
required before operational use. The full primary API/infrastructure suite is not
an acceptance gate for this isolated increment and its previously recorded
environment gaps remain unresolved. No `.pen` edits, primary-checkout edits,
commit, push, merge, publication or deployment are included.
