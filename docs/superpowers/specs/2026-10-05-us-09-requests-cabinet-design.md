# US-09 — Requests cabinet and local browser design

**Status:** Owner-approved written specification, 2026-10-05. The owner approved
the in-chat structure, existing API without server expansion, and then this
written specification. The implementation plan remains a separate review gate;
implementation has not started.

**Scope:** EN/ES Requests in the existing isolated US cabinet, its typed client,
strict local browser proxy, and an owned synthetic browser journey. No server
contract, database schema, worker, publication protocol or artifact format change.
No commit, push, PR, merge, release, provisioning, deployment or real-data use.

## 1. Intent and source of truth

An authorized processor user can record a request, save its scope, inspect fresh
validation, explicitly prepare a response, follow its processing, and download
the immutable result. An auditor can inspect and download permitted results
without mutation controls. The workflow prepares files; it does not deliver them
to an external recipient, fulfil a request automatically or assert compliance.

Use the [current HTTP design](2026-10-05-us-09-requests-http-design.md), current
strict contracts and implementation before older screen concepts. Read with the
[MVP contract](../../us/mvp-contract.md),
[current request design](2026-10-04-us-09-trace-request-current-design.md), and
[brief 05](../../design-briefs/us/05-plan-and-trace-request.md).
This specification supersedes conflicting Requests list/preview concepts in that
brief; it does not redesign Plan or the cabinet shell.

The source worktree is `codex/us-mvp` at unchanged HEAD
`f06aaef2b923a7ae902c0fabacfd0c4712c127c3`, with accepted uncommitted HTTP and
worker-runtime work that must be preserved. Requests UI/client/proxy do not yet
exist. Existing US navigation, capability refresh, dirty-editor guards, Plan
patterns, `UsBrandMark` and `@markiro/ui` remain authoritative. There is no local
Graphify graph to update.

The previous complete API run remains non-green; eight primary-environment setup
blockers are known and untreated. Scoped HTTP acceptance is not whole-package or
operational readiness. The existing dirty build refuses checked publication;
adding a UI must neither relabel it clean nor fabricate completed packages.

## 2. Accepted approach and boundaries

Use one Requests section with a bounded list, a selected request card with four
steps, and selected immutable run detail/history. Keep in-cabinet navigation;
do not add a router, copyable deep-link promise, RU entry or separate application.
Reuse the current mark, bundled typography, tokens, light/dark themes, tables,
tabs, forms, dialogs, focus/return and guarded navigation patterns.

The alternative of enriching the list API for every older brief column is not
selected. The list contract contains request number, lifecycle, revision and
timestamps only. It does not contain requester, latest run, scope or availability.
Do not hydrate every list row with N+1 detail calls or use a loaded page to
invent global readiness counts. Those facts appear only in an authorized card.

Three states are independent: request `open`/`closed`, validation evidence, and
run `queued`/`processing`/`ready`/`failed`. A ready run is Export-ready only when
the server's `exportReady` is true. Incomplete is a separate response mode, not
an error bypass, legal verdict or competing request lifecycle.

No overview aggregate, due-before filter, full-search-results handoff, live scope
preview endpoint, run cancellation, reopening, deletion, external submission,
email, notifications, QA sign-off, generic-profile export, new artifact kind or
background worker starts in this slice.

## 3. Navigation, authority and privacy

Place Requests alongside Search, Trace and Plan in `MasterDataWorkspace`.
Show it only for `US_FSMA204_PROCESSOR` with `traceability.read`; retain a safe
unsupported/denied state if access changes while it is mounted. The existing
session/MFA and edition attestation remain prerequisites. No client tenant,
actor or provenance field grants authority.

| UI action                        | Current capabilities              | Additional prerequisite                              |
| -------------------------------- | --------------------------------- | ---------------------------------------------------- |
| List, request/run/attempt detail | `traceability.read`               | Processor profile                                    |
| Create, edit, close              | `traceability.qa.manage`          | Open record for edit/close                           |
| Validate                         | QA and `traceability.export.read` | Saved scope, checked build                           |
| Acknowledge saved warnings       | QA and export                     | Exact saved revision/digest, reason                  |
| Prepare either mode or replay    | QA and export                     | Checked build, private package storage               |
| Manual retry or replay           | QA and export                     | Private storage, existing initiator/lifecycle policy |
| Download published artifact      | `traceability.export.read`        | Ready committed artifact, private storage            |

UI capability checks explain/hide actions; each HTTP boundary remains the source
of current authorization. On 401, stop reads/polling/download release and enter
the existing session-loss flow. On 403, block the rejected action and byte release,
then refresh access through the existing cabinet callback. If read access is lost,
clear request/run projections and drafts; mutation/export-only loss must not
silently discard input that the user remains authorized to read. A transient
access-refresh failure blocks actions and does not establish current authority.
A tenant/organization change unmounts and discards Requests state.

Requester/contact appear only in authorized detail/edit/frozen-run views, never
in the list, notices, diagnostics or logs. No localStorage, IndexedDB, persisted
query cache, analytics payload or console output for requests, contacts, scopes
or downloaded bytes. Only transient component/client memory is used.
Production storage/infrastructure separation and non-RF persistence constraints
remain unchanged; local checks use synthetic disposable data only.

## 4. Typed transport and exact local proxy

Put Requests-specific JSON/binary transport and error mapping in focused modules
under `apps/admin/src/us/requests/`. Compose a typed `requests` subclient into
`createUsBrowserClient`; reuse its injected fetch transport and common safe error
conventions, without duplicating session management or expanding the existing
large client with the whole Requests implementation. Existing client methods
remain compatible. New methods correspond one-to-one to the thirteen operations.

Strictly parse input and successful output with the current shared contracts.
Serialize only supported fields, canonical lowercase IDs and canonical page
numbers. Query input uses schema input types; schema output defaults/numbers
must not be passed back through a string-only query schema. Exact request-number
search is not fuzzy search. Do not send a client correlation/authority override.

The local browser uses `/api/us/traceability/requests` and
`/api/us/traceability/export-runs`; the existing proxy strips `/api/us` to the
canonical API `/traceability/...`. This local prefix is not a server alias.
Extend `vite.us.config.ts` with only the exact thirteen path/method combinations,
their existing query allowlists and duplicate rejection. Reject trailing slashes,
encoded/uppercase ID aliases, extra query fields, arbitrary artifact keys,
HEAD/Range and unknown nested routes before proxying. Keep all other US/RU,
Host/Origin, cookie, edition, no-store and release boundaries unchanged.

Create/PATCH bodies retain 256 KiB; commands retain 16 KiB, measured as actual
UTF-8 JSON bytes. Oversize/invalid input fails locally with useful field feedback,
not truncation. JSON operations retain a 15-second client deadline. Binary
download has a bounded 30-second deadline covering headers and body; these client
limits do not alter server locks, worker deadlines or storage policy.

Decode only known status/code combinations from the actual API. Never retain or
render raw response messages, provider causes or arbitrary structured errors.
Unexpected JSON is an invalid response, not a successful incomplete result.
Revision/digest/lifecycle conflicts lead to reload/revalidation or same-key
reconciliation, not automatic mutation retries. Preserve the existing safe
`UsClientError` behavior for unrelated surfaces.

## 5. List and request card

The list shows number, received instant, due instant/countdown, Open/Closed and
request revision. Filters are exact request number and lifecycle. Default page
size is 25, maximum 50; offset is canonical 0–10000, with `hasMore` governing
Next. Server due-time/UUID ascending order is authoritative. Changing a filter
resets the offset. No invented total, local global sorting or client due filter.

Loading, empty, no-filter-match, denied, failed and stale last-success states are
distinct. Failed refresh may retain a clearly labelled stale non-sensitive list;
never label its deadline/readiness projection current. Opening a request obtains
detail independently. A request disappearing after a list read gives safe
not-found, not an empty successful card.

The card contains four keyboard-reachable `DataTabs`:

1. **Requester and timing:** request number/name, optional organization/contact,
   receipt, deadline and agreed alternative reason. Save creates the open shell
   with `scope: null`. Creation does not require a build or artifact store.
2. **Scope:** editable saved selectors, with at least one selector required for
   validation. Saving is revision-checked and invalidates matching local
   validation/action state. The server determines actual resolved selection.
3. **Validation:** explicit fresh Validate, saved findings and reasoned warning
   acknowledgement. Show exact revision, digest, validation time and matched
   revision count, not fabricated lot/location counts.
4. **Package:** two separate preparation actions, latest run state, revision
   history and selected run detail. No automatic preparation after validation.

Keep all four step labels visible; unavailable actions have an explicit reason.
Viewing previously prepared runs is independent of completing an editable card.
Closed requests are read-only, retain their runs/downloads and cannot create new
runs. Close requires confirmation and expected revision; it does not cancel or
claim fulfilment. Auditors see detail/history without editable controls.

Dirty edits and pending commands participate in the existing workspace guard.
Never replace unsaved input with a refresh response. After a definite mutation
receipt, read canonical detail/history rather than presenting an optimistic
merge as live state. On a stale revision, preserve input and offer explicit
discard-and-reload; no silent overwrite or rebasing.

## 6. Time and scope semantics

Form instants are entered and displayed in the tenant IANA timezone, not the
browser's implicit zone. Show a zone/offset adjacent to receipt/deadline controls.
Resolve local wall time before serialization: reject DST gaps; for a repeated
time require an explicit offset choice. Preserve millisecond representability.
No external date dependency, runtime CDN or machine-clock override is required.

Default due is receipt plus exactly 86,400,000 milliseconds; receipt changes
recompute it only while the user still uses the default policy. An edited due
requires an agreed-alternative reason when it differs from that default, and
must follow receipt. The server remains authoritative; a failed save must not
silently change the user's policy. Explicitly optional empty text maps to null;
invalid surrounding whitespace is surfaced rather than silently normalized.

Dates display in the established US conventions in both languages, with timezone
and UTC available in detailed evidence. Language changes do not change stored
instants, identifiers, scope, request revision or frozen English artifacts.
Countdown is a presentation derived from the saved deadline and device clock,
not evidence of elapsed human work. Use neutral at four hours or more, attention
below four hours and overdue text below zero. Closed shows its closure time.
Announce countdown changes at most once a minute, with text/icon, not color alone.

Support the existing scope schema without silently dropping fields: product ID
and text, single/list/range TLC, lot ID, location ID list, source reference value,
document number and civil event-date bounds. Advanced selectors may be collapsed
but stay accessible and visible in summaries. TLC/location lists retain the
50-value limit; incompatible ranges and duplicates give field errors. Do not
translate/reinterpret TLCs or fetch entered source-reference URLs.

Different selectors combine by AND; values in TLC/location lists combine by OR.
No capped Search/Trace page or client quantity sum proves complete export scope.
No live matched-count claim before server validation. A valid zero-match result
is visible and can support an explicitly empty incomplete response; it is not an
infrastructure error or Export-ready. Over 500 revisions/16 MiB fails visibly,
without trimming records. Full-search handoff is deferred; users can select a
specific lot through the existing paginated reference-picker patterns and lot
read client, and review its scope here. The existing product/location picker is
not misrepresented as already supporting a lot selection.

## 7. Validation, ambiguity and preparation

Loaded `savedValidation.freshness = not_rechecked` is historical evidence, not
fresh readiness. Fresh Validate uses the saved expected revision. Only its
current response enables preparation prechecks for that card session; editing,
revision change, failed refresh or a new selection invalidates that local state.
Show saved findings even when build/storage are unavailable. Error, warning and
info groups retain exact source identities/fields; bounded navigation opens an
existing lot/event/revision in the cabinet without inventing a URL or changing
the user's unsaved record silently.

Errors never become waived warnings. Acknowledge uses the exact saved digest,
revision and explicit reason; it does not revalidate. Export-ready prechecks
require no blocking errors, nonempty complete scope and the server-checked Plan.
Incomplete preparation remains separately labelled and may retain those
documented gaps; technical failures/permission denial never become incomplete.
Prepare rereads and validates the digest atomically, so a matching local display
does not guarantee current sources or a successful package.

Availability is descriptive, not authorization or provider health. Missing,
invalid or unknown checked build disables Validate/Prepare with explicit copy.
Private storage unconfigured/invalid blocks both preparation modes, retry and
downloads but not editing/reads; Validate works with a checked build without
storage. Acknowledging saved warnings does not require a checked build.
Do not reuse Plan storage availability as package availability.

Each explicit Prepare allocates a UUID operation key and freezes its mode,
expected revision and validation digest in memory until resolved. Double-clicks
share that key/body. Network timeout, ambiguous 5xx or an invalid success receipt
offers retry of the exact command, not a new key/current digest. Successful replay
can return an earlier accepted run after source edits/closure, subject to the
same current build/storage/authority gates. Only an explicit new-response action
uses a new key. Do not infer acceptance from the latest unrelated history row.

CRUD has no invented idempotency key. After an ambiguous create, reconcile by an
authorized exact-number list/detail read; do not POST automatically. Ambiguous
edit/close reloads canonical state without changing it again. Reloading the page
does not automatically restart a command: unsaved input and unresolved in-memory
keys are not promised durable. Warn before discarding unresolved command state
and require inspecting history/revalidating before an explicit new operation.

## 8. Run detail, polling, retry and downloads

Run history uses server run-revision descending pages; attempts use the existing
bounded attempt history. Render the run's frozen requester/scope/revision, never
the live card fields. Show mode, server status/exportReady, creator, digests,
attempt/cycle counts, lifecycle version, safe failure code and nullable timing.
Missing workbook/Plan are explicit missing-file rows with supplied reasons,
never fabricated files or hashes. Trusted synthetic provenance has a persistent
demo/non-operational mark; `not_verified` never becomes synthetic or verified
because of a domain name, local mode or UI flag. Requests retains a visible
local-development/non-operational boundary even before a run exists.

Display only timing present in the response: preparation start, worker start,
report rendered and publication completion. Unknown stays unavailable. Report
data preparation appears inside its immutable PDF; no public run field exposes
that instant, so do not reconstruct it. Completed system elapsed is completion
minus preparation start; running elapsed is a clearly labelled local estimate.
Neither is active human effort or a completion-time promise.

Poll only the selected queued/processing run, every two seconds with no overlap,
while Requests is mounted and the document is visible. Stop on terminal state,
selection/tenant/session change, three consecutive transient failures, or five
minutes of a continuous polling window; provide explicit refresh/resume and the
last successful update time. Visibility return may refresh and start a new
bounded window. Do not poll every history row, claim a worker is alive from a
queued row, or turn a paused view into a failed server run.

Manual retry preserves the same frozen run. Offer only for a failed run to a
currently permitted original initiator; send captured expected lifecycle version,
reason and a stable UUID key. Same-key ambiguous retry keeps the original body.
Server policy and fresh authority decide admissibility; receipt means accepted
retry intent, not Ready. New response revision is separate from retry.

Downloads use the six published artifact descriptors: workbook 16 MiB, Plan
8,000,000 bytes, validation 16 MiB, request report 4 MiB, manifest 1 MiB and ZIP 64 MiB.
Use one authenticated same-origin GET per explicit user action, credentials,
no-store and redirect:error. No presigned URL, arbitrary key, Range, HEAD,
standalone SHA256SUMS or unauthenticated PDF viewer. Validate status200, fixed
filename, expected MIME (JSON may also have `charset=utf-8`; no other parameters), exact
descriptor length and SHA256; bound actual stream bytes before allocation.
Require no-store/nosniff, cancel/release failed readers and revoke Blob URLs.
Allow only one active download per view. Abort/stale-generation/authority loss
prevents opening bytes; a server release audit is not proof of user review.

## 9. State ownership, copy and verification

Separate list/card/editor/validation/command/run/download ownership. Every async
response and post-await action checks generation plus selected IDs and request
revision where applicable; AbortController alone is insufficient. Transient
refresh failure keeps unsaved input but blocks readiness-changing actions.
Callbacks, timers, readers and Blob URLs are disposed on unmount; test acquisition
and disposal stay in the same guarded lifetime with cleanup in finally, including
failed diagnostics. No test-only bypass, auth-clock replacement or client worker.

Both `en-US` and `es-US` cover every label, status, reason and safe error; US
fallback is English only. Existing branding, typography and tokens are reused,
not replaced by a parallel theme. Desktop 1440/adaptive 1024 and narrower layouts
must keep Spanish actions legible, keyboard focus visible and findings/tables
usable. Confirmations explain close/new-revision effects. No CTA says send,
submit or upload to FDA; no compliant/FDA-approved assertion.

Write focused failing tests before implementation. Acceptance covers:

- Typed serialization, strict responses/errors, exact thirteen proxy methods,
  canonical queries/body caps and denied aliases; no widened RU or arbitrary route.
- List paging/filter races, card selection/tenant/session races, stale findings,
  dirty guards, exact command replay/ambiguity and no automatic CRUD retry.
- UTC/default 24h, tenant/browser zone mismatch, DST gap/fold, alternate reason,
  civil dates, TLC/range/list limits and EN/ES parity/expansion.
- Role/profile loss; read-only auditor; build/storage gates; zero matches versus
  technical failure; explicit complete/incomplete states and closed downloads.
- Frozen run facts after live edits, bounded foreground polling/stop/resume,
  initiator retry, all six binary kinds, overflow/truncation/hash/header mismatch,
  safe filenames, cancelled/stale download and Blob cleanup.
- Owned synthetic real browser journey through edition/session/MFA, create/save,
  fresh validation, both outcomes, separate worker execution, immutable history,
  verified download and cleanup. Use existing trusted clean build/storage fixture
  seams only; do not mutate the real dirty descriptor or relabel it clean.

The implementation plan must allocate CI ownership for every new/changed test,
including configured DB/browser prerequisites. Rebuild affected shared packages
before consumer checks. Run focused checks during iteration, proportionate admin
test/typecheck/lint/US build, tooling proxy/isolation and root format/diff gates.
Report skipped infrastructure and default API failures separately. A visual
browser check in both languages/themes is distinct from DOM tests and byte checks.
No new product dependency, dependency-policy change, local installation or
provider provisioning is part of this design. The implementation plan proposes
ordinary frozen bootstrap of the already-pinned separate browser tool and
Chromium in disposable CI, using the existing repository pattern; that setup
awaits plan approval and does not install anything on the owner's machine.

## 10. Next approval and external limits

The owner has approved this written specification. The implementation plan
receives its own approval before execution.
The existing preference is separate executors with independent stage reviews;
it does not bypass either approval gate. No commit accompanies this document.

Real provider availability/policy, production data residency, remote CI/job timing,
hosted recovery, OS reboot, backup/restore, fluent Spanish review, accessibility
device testing, customer/regulatory acceptance and deployment remain external
unrun gates. Source/browser proof never unlocks release or operational readiness.
The prior HTTP M1/M2/N1 observations and possible old fixture DB leftovers remain
recorded separately; this UI spec does not silently repair or authorize deletion
of them. All user/unrelated dirty work, local archives and `.pen` assets remain
untouched.
