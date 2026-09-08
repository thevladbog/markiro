# US-03 — Receiving amendments, voids and current receiving basis

Date: 2026-09-07.

Status: product behavior and written technical specification approved by the owner
on 2026-09-07. The rules/contract foundation, internal lot support-version,
persistent roots, chain metadata and amendment/void/frozen-v3 storage guards are
implemented. Internal detail/history/current-basis reads and QA-controlled
amend/void commands and amendment saving with durable replay are implemented as
of 2026-09-08; existing original-receipt APIs remain compatible. Internal readiness
v4 now checks original/amendment drafts, predecessor bindings, current references
and affected lot support tokens in one read-only snapshot. Internal explicit-v2
finalization now atomically writes v3 and replaces current support with durable
replay and exact audit. Internal live registry reads now implement current/all
history selection, status filtering and snapshot-consistent summary pagination.
The existing original Receiving workflow now uses live reads and versioned
acknowledgements over HTTP, with mandatory current-state recovery in the UI.
Strict lifecycle error and command-specific result/input bridge schemas are
available internally. Internal original-draft create/save writers now produce v2
acknowledgements and replay both stored formats exactly. Internal finalization
also accepts supported original input with v4 readiness, freezes v3 and preserves
exact historical v1/v2 replay. The original create/save/finalize HTTP writers and
consumers are switched together. Explicit amendment commands, QA lifecycle controls,
retained-line editing/comparison, saved checks/finalization and exact revision
history navigation and independent lot-basis cards are connected in the local UI.
Basis loading/error/missing states, bounded pages and exact-revision navigation
preserve lot status and return context. Ordinary TLC native entry now preserves
the full 120-point Unicode boundary without changing shared validation.
Contextual EN/ES explanations now cover changed lifecycle, pending correction
and locked retained-line identity, keeping the existing explicit reload guards.
Cancelled revision non-reuse, multiple independent supports, delayed reads and
QA revoke/restore recovery now have local test coverage. The dated cross-task
verification checkpoint records the remaining visual/external acceptance limits;
reserved downstream dependency presentation is still pending actual consumers.
Client acknowledgement validators for explicit revision commands are connected
with captured pre-command context, including amend target/result distinction,
retained bindings and immutable void content. These local routes/UI do not enable
publication or deployment.
Execution evidence is described in the
[implementation plan](../plans/2026-09-07-us-03-receiving-lifecycle.md).

Baseline: `40a3c72fd2c2f36e463a827db2f027baa1584182`, isolated `codex/us-mvp`.
Read with the [MVP contract](../../us/mvp-contract.md),
[current Receiving behavior](../../us/receiving-browser.md),
[ordinary finalization](2026-09-07-us-03-ordinary-receiving-finalization-design.md),
[exempt Receiving](2026-09-07-us-03-exempt-supplier-receiving-design.md) and
[development isolation](../../us/development-isolation.md).
This supersedes the lifecycle proposals in the historical
[broad US-03 design](2026-09-03-us-03-receiving-and-documents-design.md), not its
separately pending fixed-template CSV scope.

## 1. Approved rule and increment boundary

Voiding a Receiving never deletes its lots or changes their ID, product, TLC,
source, assignment basis or operational status. It never clears the permanent
source lock, releases quarantine or recall, or automatically archives a lot.

Whether a lot has a **current receiving basis** is a separate server-derived
fact. If another current finalized Receiving references that lot, a basis remains.
If none does, display the absence explicitly. Future Transformation and Shipping
cannot treat `active` status alone as evidence of a valid receipt. Manual lot
creation is not a Receiving event.

This increment adds QA-controlled amendments and voids, revision history,
current-basis reads, and the matching EN/ES office workflow. It also includes a
bounded correction of the ordinary TLC field's incompatible native UTF-16 cap:
the existing 120-code-point contract and exact stored values do not change.

Out of scope: CSV, other CTE implementations, persisted genealogy, inventory
balances, case/SSCC links, trace/export packages, automatic cascades, new lot
status transitions, Station, dependency upgrades and release enablement. Those
remain on the roadmap. No claim of hosted or regulatory acceptance is added.

## 2. Architecture choice and current constraints

Three approaches were considered:

- **Separate revision rows and a small Receiving root record — recommended.**
  The root coordinates the chain; each revision retains its own ID, content and
  finalization history. This costs one coordination table but keeps historical
  payloads separate from changing current/pending pointers.
- **Use the original event row as the mutable root.** Fewer tables, but every
  later command must mutate an otherwise historical row and special-case its
  immutability guard. This is not selected.
- **Update one event in place and rely on audit reconstruction.** This obscures
  historical IDs and pinned snapshots and conflicts with the MVP contract.

At the design-time baseline, the schema permitted only revision 1 and
draft/finalized states. Its unique tenant/event-number index prohibited same-number
revisions, and SQL guards rejected every mutation of a finalized header or its
children. Tasks 1–3 address those constraints through additive migrations; the
new lifecycle commands are internal and not yet HTTP-accessible.

The finalizer currently interprets `create_on_finalize` as a new lot insertion.
Finalized lines retain that mode alongside their assigned lot IDs. Copying those
lines into the existing draft validator either fails validation or creates an
identity collision. Retained lines therefore need an explicit predecessor binding.

Frozen v1/v2 snapshots and saved operation results are already persisted. Their
validators and exact historical content must remain readable; a new current-state
response must not rewrite an old command receipt to look current.

## 3. Revision lifecycle

An event number identifies one Receiving root; an event UUID identifies one
specific revision. The number and original timezone remain stable. Revision
numbers increase monotonically and are never reused, including after an abandoned
amendment. Draft saves increment `draftVersion`, not the event revision.
The root lifecycle version changes when current/pending pointers change, not for
an ordinary draft-content save. Exhausted revision/version counters fail without
partial writes; they never wrap or reuse an identity.

| Action                          | Result                                                              | Effective Receiving           |
| ------------------------------- | ------------------------------------------------------------------- | ----------------------------- |
| Create original draft           | Revision 1, draft                                                   | None                          |
| Finalize original draft         | Revision 1, finalized                                               | Revision 1                    |
| Start amendment                 | New draft linked to the current finalized revision                  | Predecessor remains effective |
| Finalize amendment              | Predecessor becomes amended; successor becomes finalized atomically | Successor only                |
| Void amendment draft            | Draft becomes void; pending pointer cleared                         | Predecessor remains effective |
| Void current finalized revision | Revision becomes void; current pointer cleared                      | None for this root            |
| Void original draft             | Draft becomes void                                                  | None                          |

Only one pending draft is allowed per root. A duplicate request with a different
operation key returns a conflict naming the existing draft, not another revision.
Starting an amendment requires the exact current finalized revision. Historical
amended/void rows cannot be edited, amended, voided again or resurrected.

Approved safety choice: voiding a current finalized revision while an amendment
draft exists is blocked. QA must explicitly void that draft first. There is no
hidden cancellation. After a finalized root is voided, any new receipt is a new
event number, not a reopening of the voided revision.

The normative current predicate remains
`status = finalized AND superseded_by_event_id IS NULL`. Root pointers are
transactional coordination data and must agree with this predicate; they cannot
make a draft or void revision effective. Current is not the highest revision
number: the highest row can be an abandoned draft.

## 4. Editing an amendment

Approved permission boundary: current `traceability.qa.manage` is required to
start, save, finalize or void an amendment draft. Ordinary revision-1 drafting
keeps the existing receiving-write permission. Readers can inspect all revisions.
The server reloads membership, role, profile and MFA at every protected boundary,
including retries; client capabilities are presentation only.

Starting an amendment copies the predecessor's saved inputs and document IDs,
not reconstructed live labels. It captures a mandatory reason (trimmed nonempty
text, at most 2,000 characters under the existing text policy). The reason is
shown before creation and remains fixed for that draft; a mistaken reason requires
explicit cancellation and a new amendment. The side-by-side original uses frozen
snapshots. Readiness and a new finalization recheck current references.

Each retained draft line carries `previousLineNo`, referencing the immutable line
of the immediate predecessor. The server derives its lot ID and original link
mode from that exact tenant/root/revision/line, never from array position, a
matching TLC, or client-supplied origin claims. Bindings must be unique. Reordering
changes current `lineNo` but preserves `previousLineNo`. Separate predecessor
lines referencing the same existing lot remain distinguishable.

For a retained line, lock lot ID, product, exact effective TLC, complete source
tuple, original link mode and receipt handling (ordinary, preserved TLC, or own
assignment). A reference source includes its exact kind/value and resolved
location; the latter is not silently refreshed. An own-assignment line retains
its null received TLC and original assigned proposal. Changing the receiving
location cannot reinterpret that lot's source. Return `409 lot_identity_locked`
with the affected line/fields for attempted identity changes.

QA may correct quantities/UOM, civil receipt date, non-identity header fields,
supplier reference, notes and document links. On an exempt retained line, QA may
correct rationale/evidence but must freshly review that line at finalization;
previous approval is never inherited. An amendment cannot convert an existing
ordinary lot assignment into an exempt assignment or vice versa.

Lines may be added, removed or reordered, subject to the dependency rules below.
An added line without a predecessor binding follows the existing explicit
create/link rules. An existing identity must be linked explicitly, not silently
resolved or inserted again. Removed lots remain intact; removing a line may remove
their current receiving basis. A later explicit link can reference that same lot
without claiming to create or assign it again.

Retained lines are corrections of historical facts, not new uses of stock. Their
lot status alone must not block a documentary amendment, including for consumed,
shipped, quarantined, recalled or archived lots. Identity, references, coverage,
dependency and QA checks still apply, and status never changes. Newly added
existing-lot lines keep the current active-lot requirement. This distinction must
be explicit in both domain and SQL validation, not an exemption from all checks.

## 5. Effect classification and downstream boundary

Before finalization, compare the saved amendment to its predecessor using its
validated line bindings. Do not compare only array indexes or live master labels.

- Documentary changes: notes, supplier reference, document links/order, exemption
  rationale/evidence, and line reordering without changing line identity/content.
- Material changes: adding/removing/rebinding lines, quantity or UOM changes,
  receipt date, receiving location or immediate previous source changes. Treat
  exact quantity-spelling changes conservatively as material; never round values.
- Identity changes on retained lines remain forbidden regardless of dependencies.

For a material correction, identify the affected old and new lots; header changes
affect every line. A void affects every lot of that revision. If finalized
downstream consumers depend on the affected receipt, refuse with
`409 receiving_downstream_dependencies`. Return tenant-safe blocking event IDs,
numbers, revisions and the downstream-first correction order. An independent
Receiving of the same supplier lot is another supporting receipt, not automatically
a consuming dependency. It must not be falsely reported as a Transformation.

An unrelated receipt is not permission to rewrite history pinned by a downstream
consumer. No command silently rebinds consumers, reopens their drafts or deletes
their history. Even documentary amendments retain old revisions for pinned reads;
future consumer views distinguish their original pinned provenance from the
current root revision.

There are no persisted Transformation/Shipping consumers or balance effects in
the baseline. This increment must not invent a fake empty dependency service and
claim to have verified them. Implement the deterministic change/dependency rules
and the complete Receiving-only current-basis query. Unsupported stored event
kinds fail closed. Before another CTE is enabled, its implementation must register
real dependencies, use the common lot coordination protocol, validate receipt
basis and prove correction/void races against its actual database writes. Pure
synthetic dependency tests here are contract proof only, not that later acceptance.

No genealogy or balance records are emitted in this increment. When introduced,
their amendments must remove the predecessor's active effects for validation and
replace them atomically, retaining historical edges as the MVP contract requires.

## 6. Current receiving basis

For a tenant-owned lot, a current basis exists when at least one current finalized
Receiving item references its exact UUID. Return the supporting root/revision IDs,
event numbers and line numbers, with bounded pagination. Preserve evidence of the
original creation separately: the historical first `create_on_finalize` binding is
not overwritten by a later receipt or confused with the current supporting set.

The response distinguishes `present` from `missing`, includes an authoritative
count of supporting revisions (not line count) and a basis-version token. Each
support entry lists its matching lines and explicitly indicates whether more
supporting revisions remain. Never infer absence from an empty page. A failed or corrupt
read is unavailable, not missing. History is accessed through revision links;
ordinary lot reads do not load unbounded event history.

For example, voiding the only supporting receipt leaves an active lot active but
shows “No current receiving basis.” If a second current receipt supports it, the
basis stays present. Voiding an amendment draft does not remove the predecessor's
basis. Finalizing a revision swaps the contributing revision atomically. Removing
the last line for a lot can remove its basis without deleting that lot.

An explicitly entered new Receiving may establish a basis for an imported lot or
one whose earlier receipt was voided, under normal permissions and identity checks.
This does not resurrect the old receipt, duplicate the lot or clear its source
lock. It is a new attested receipt, not an automatic recovery operation.

This is receipt provenance, not stock quantity, availability, proof of exemption,
export readiness or a compliance verdict. Future consumers must apply their own
operational and coverage checks as well. Transformed output origins belong to
US-04 and must not be incorrectly required to have an input-style Receiving.

## 7. Persistence and immutable history

Use an additive, next-free migration after inspecting the migration journal.
Do not reserve a number in this document or rewrite migrations 0121–0123.

- Add a tenant-owned `receiving_event_roots` coordination table: root ID, stable
  event number, lifecycle version, next revision number, current finalized ID and
  pending draft ID. For existing records the root ID equals the existing event ID.
- Add `root_event_id`, `previous_revision_id`, `superseded_by_event_id`, amendment
  reason, supersession actor/time and void reason/actor/time to event rows.
  Keep finalization actors/times and content update metadata unchanged when a
  finalized row is superseded or voided; lifecycle metadata has separate fields.
- Replace tenant/event-number uniqueness on revisions with tenant/root/revision
  uniqueness; event-number uniqueness moves to the root. Composite tenant FKs
  bind all pointers. Commit-time constraints enforce same-root predecessor and
  successor links, monotonic acyclic history and agreement of status/pointers.
  At most one finalized and one draft row per root are enforced in storage.
- Add nullable `previous_line_no` to receiving items. Validate it against the
  parent event's immutable predecessor and freeze it at finalization. Legacy
  rows have no predecessor binding. Protect finalized/void children from writes.
- Add an internal `receiving_basis_version` counter to lots. Change it only when
  support/provenance coordination changes; do not represent that as a lot status
  action or rewrite source-correction retry hints. Initial basis tokens are
  deterministic, including for manually imported lots with no receipt.
- Extend operation command kinds to `amend` and `void`. New command receipts
  have an explicit version; existing keys, digests, result JSON and audit rows
  are not migrated to a new interpretation.

Backfill roots and pointers without modifying historical snapshot JSON, event IDs,
actors, dates, line identities or command results. Add constraints after validating
the backfill. A failed migration must roll back as a unit; recovery is a reviewed
forward fix, not dropping stored events. Runtime never auto-migrates.

The existing header trigger needs explicit draft-to-void and finalized-to-amended/
void transitions. The latter may change only the named lifecycle fields, and only
with a coherent root/chain transition at commit. They must not rerun live product
or document validation against a historical snapshot. A lifecycle action cannot
change frozen payloads, receipt children or original finalizer metadata, even via
raw SQL. Arbitrary DELETE and direct insertion of finalized history stay denied.

New finalizations use snapshot v3 and a new readiness rule version. V3 explicitly
records whether a line creates a lot, links an existing lot, or retains a precise
predecessor binding; original receipt handling and current QA review remain
distinct. Retained own assignments reuse the original lot, not the v2 insertion
assumption that the lot must still be at revision 1. V1/v2 readers/validators remain
version-pinned and lossless. Validation-only projections may reuse unchanged
checks; never store a projected replacement of old history.

## 8. Commands, reads and concurrency

Keep the current singular route prefix `/traceability/receiving`.

| Surface                                      | Contract                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /:id/amend`                            | Exact current revision; operation key, expected root lifecycle version and reason; returns the created amendment command receipt                  |
| `PUT /:id`                                   | Full draft replacement; ordinary saves retain existing behavior; amendment saves add strict predecessor bindings and expected root/draft versions |
| `GET /:id/readiness`                         | Amendment check additionally binds root version, predecessor and current dependency/basis inputs into its digest                                  |
| `POST /:id/finalize`                         | Existing saved-version/digest/QA confirmation; amendment finalization also requires expected root version and exact predecessor                   |
| `POST /:id/void`                             | Operation key, expected root version, expected draft version when applicable, and mandatory reason                                                |
| `GET /:id/revisions`                         | Bounded, ordered revision summaries for the same tenant/root, including abandoned drafts                                                          |
| `GET /traceability/lots/:id/receiving-basis` | Read-only current support count, version and paginated supporting revision links                                                                  |

Revision and basis lists use bounded `limit`/`offset` pagination (default 50,
maximum 100 rows; offset at most 100,000). Revision history sorts by ascending
revision number; basis entries sort by root ID then revision ID, both stable.
Tokens/counts and each page come from one database snapshot. They do not promise
one immutable snapshot across separate requests; a changed version requires a
fresh read before confirmation.

Use strict discriminated commands so original draft input cannot smuggle an
amendment binding. Version the digest algorithm for new command shapes. Recognize
legacy create/save/finalize replay through its original digest and receipt schema
before applying new state validation; after current authorization, replay returns
the original result. It does not act on a revision a second time.

New live detail/list schemas distinguish current lifecycle from content frozen at
finalization. Include root/revision identity, lifecycle version, predecessor,
successor, current/pending links and relevant lifecycle actor/time/reason. Frozen
v1/v2/v3 content and original finalizer stay separate. Void drafts retain their
saved draft content and never acquire a fabricated finalization snapshot.

All command responses are historical acknowledgements, not guarantees of current
effectiveness. The client rereads current state after success or replay, including
old create/save/finalize receipts. A delayed original finalize response after a
void must not display an effective receipt. If that read fails, show an explicit
unavailable/current-state-unknown state and keep mutations blocked.

Reuse the current repeatable-read transaction and bounded serialization/deadlock
retry policy. Lock in this order: current authorization/profile boundary, operation
key, this command's root, affected lot UUIDs sorted deterministically, then the
existing product/profile/party/location/document reference order. Readiness is
read-only and uses the same scoped inputs without taking mutation locks.

Locking a row without updating it does not refresh a repeatable-read snapshot.
Every support-changing finalization/void must therefore update the affected lot's
basis-version tuple in the same transaction. Concurrent writers then either see
the new basis or retry after a serialization conflict. All reference paths that
change basis participate, including a second ordinary receipt of the same lot.
Future consumers must write the same coordination token when committing or
withdrawing a dependency. They lock their own root and the sorted lots, never
acquire another event-root lock after taking lot locks. This avoids cross-root
lock inversion while protecting origin checks. Prove both transaction schedules.

After locks, reload the target, root, predecessor, complete affected basis and
registered dependencies. Check versions and digest again. An amendment finalizes
only its saved version; create new lots only for unbound create lines, retain all
bound UUIDs, freeze the successor, supersede the predecessor and move root pointers
atomically. Do not clear existing lot-source locks. Audit and command receipt
commit with the state change; any error rolls all effects back.

`amend` and `void` retries use the exact captured body/key. Same key with different
target, reason or version returns the existing operation-conflict family. New
keys against a stale state return typed lifecycle conflicts, not replay success.
Exhausted serialization retries and corrupt storage remain sanitized unavailable
errors, not successful empty results. Bounded dependency responses explicitly mark
truncation and keep the command blocked until all dependencies are resolved.

Audit each command's exact tenant, actor, action, root/target IDs, revision,
reason, result and before/after lifecycle; amendment finalization also records
the predecessor transition and the exact old/new line-to-lot mappings. New lot
creation retains existing lot audit. Voids must not emit invented status/source
changes. Failed commands and successful retries add no duplicate business audit.

## 9. Office workflow

Retain the existing Markiro logo, tokens, grouped Receiving editor and reference
pickers. No new design system or `.pen` changes are needed for this increment.

- A finalized detail shows QA actions **Amend** and **Void**. A reason dialog
  names the exact number/revision and explains the consequence before submission.
- The amendment editor says which revision it corrects and that the previous
  revision still applies. Show a frozen comparison pane on wide screens and
  accessible tabs on narrower screens. Identity fields are readable summaries,
  not misleading editable selectors. Show removed/added/retained bindings clearly.
- Check, review and finalize remain explicit. Exempt-line confirmations start
  unchecked for this revision and reset under the existing edit/reload/QA rules.
  Confirmation separates reused lots from genuinely new lot creation.
- Void confirmation names affected lots and explains that status/identity stay
  unchanged. A current-basis warning says which lots will lose their last receipt
  basis; it never says every lot is automatically unavailable or archived.
- Show lifecycle reasons, actors, times, previous/current/pending links and a
  revision-history list. Historical URLs keep opening their exact revision. The
  default registry (`history=current`) includes each current finalized revision
  and pending draft, including original drafts. A terminal root with neither
  includes its last voided effective revision, or its voided original draft if
  never finalized. `history=all` includes every revision, including abandoned
  amendment drafts. Apply `status=draft|finalized|amended|void` to those selected
  revision rows; it does not silently expand history. The UI selects all history
  explicitly when the user requests amended records. Preserve bounded literal
  number search, pagination and existing stable list ordering.
- Lot details show **Current receiving basis / Base de recepción vigente** and,
  when absent, **No current receiving basis / Sin base de recepción vigente**.
  Distinguish loading/failure from absence and keep operational status separate.

No autosave, automatic retry or persistent browser approval/key storage is added.
Pending commands block duplicate clicks, dismissal and editing synchronously.
An unknown response retains the exact command for explicit retry in active memory.
Conflicts preserve local input and require explicit reload/recheck. Session/read
loss clears protected state; QA loss blocks amendment editing and actions without
restoring earlier confirmation if access returns. Do not silently replay a
pending command after a new session.

Use existing EN/ES patterns, non-color status text, keyboard focus/return, labels
and readable error summaries. Validate light/dark at 1440, 1024 and 390 pixels.
Fix ordinary TLC native entry without trimming, truncating or normalizing a valid
120-code-point value differently from the established contract.

## 10. Verification and delivery boundary

Implementation proceeds through focused failing tests before behavior changes.
The later implementation plan must retain these acceptance cases:

1. Pure lifecycle/change/basis rules: all transitions, abandoned revision gaps,
   retained identity/source/assignment, reorder/add/remove, exact decimals and
   timezone, second-receipt support, dependency classification and incomplete data.
2. Strict contracts: unknown keys, bindings to the wrong line/root/tenant, duplicate
   bindings, legacy operation digests/receipts, frozen v1/v2 fixtures unchanged,
   v3 assignment/reviewer validation, live lifecycle versus historical content.
3. Real disposable-database migrations and raw SQL: legacy backfill, tenant FKs,
   root uniqueness/pointers, parent/child immutability, no direct finalized inserts,
   no snapshot or original-actor mutation during lifecycle changes, rollback.
4. API/store/HTTP: current QA/MFA and cross-role/tenant denial, exact audit,
   no duplicated lots, permanent source locks, no status changes, repeated and
   conflicting commands, single amendment draft, stale save/check/finalize/void,
   simultaneous amend/void/finalize, and both schedules of shared-lot basis races.
5. Recovery: real commit followed by lost acknowledgement for amend, finalize and
   void; exact-body retry; historical replay after later supersession/void; failed
   current-state reread blocks UI mutation; new-session recovery uses live records.
6. Connected UI and local Chromium: QA versus receiving operator, comparison and
   history navigation, reason/conflict dialogs, missing/present basis, cancelled
   amendment, source-reference URL versus evidence, retained exempt assignment,
   all locales/themes/viewports, keyboard/focus and horizontal overflow.
7. Ordinary TLC regression: native keyboard entry of 120 supplementary code
   points preserves the exact 240 UTF-16 units; 121 points are rejected without
   advancing the stored draft version. Repeat existing exemption entry coverage.

Run affected domain/contracts/DB/API/admin package tests, typechecks, lint and
builds, both primary and US admin builds, exact local proxy denial tests, isolation
contracts, formatting and diff checks. Database tests use only the owned synthetic
US fixture; report skips. Inspect browser screenshots separately from DOM tests.

Do not claim real downstream-consumer acceptance until US-04/05 implement and test
their writes. Hosted operation, mail/object storage, hardware, screen-reader and
fluent Spanish acceptance are separate. Keep the primary checkout, deployment
locks and Downloads untouched; commit/push and release remain separate requests.

This document defines the approved behavior, not a completion report. The
[implementation plan](../plans/2026-09-07-us-03-receiving-lifecycle.md) carries the
task sequence and verification checkpoints. Approval does not enable release.
