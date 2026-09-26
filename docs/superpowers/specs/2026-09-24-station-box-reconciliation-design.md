# Station Box Reconciliation — Design Spec

**Date:** 2026-09-24
**Status:** Approved design; implementation pending release
**Affected surfaces:** Station SQLite and sync engine, station-authenticated API,
server aggregation records, device-key surface documentation

## Problem

The Station is offline-first and considers a locally queued delivery complete
after the sync endpoint acknowledges it. A lost response followed by a retry must
therefore be indistinguishable from ordinary idempotent delivery. A historical
batch-identity failure violated that assumption: the server could recognize a
retry by an already accepted batch id while the retry contained a larger set of
boxes. The Station then acknowledged the larger local set although the server had
only applied the original subset.

The observed shift `SEP26-021` demonstrates the operational consequence. The
physical pallet label says 66 boxes, while the cabinet reports 58, and SSCC serial
1575 is not present in the cabinet. The local mirror contains closed, printed and
acknowledged boxes 1575–1582. Queue acknowledgement alone is therefore not enough
evidence that aggregation state on both sides agrees.

Long-running shifts amplify this risk: a discrepancy may remain hidden for days
and only be discovered when the pallet or shift is closed. The Station needs a
separate reconciliation loop that verifies durable server state, repairs safe
delivery gaps automatically, and exposes genuine conflicts without stopping an
offline production line.

## Goals

1. Verify every locally closed and delivered box against authoritative
   tenant-scoped server state.
2. Automatically recover a box that is wholly absent on the server or whose
   otherwise matching record lacks its closure or pallet link.
3. Run incrementally during a shift and perform a full shift audit on pause and
   close.
4. Keep pause and close offline-first: an unavailable server or an incomplete
   reconciliation never prevents the local lifecycle transition.
5. Make pending work and hard discrepancies inspectable without adding more
   counters to the already crowded work-screen header.
6. Preserve restart safety, idempotency, tenant isolation, device identity, and
   the existing scan-conflict rules.

## Non-goals

- The reconciliation endpoint is not a second scan-ingest path.
- It does not silently change box membership, move a box between pallets, or
  resolve duplicate-code ownership.
- It does not make pause or close online-only.
- It does not add a cabinet repair workflow in this slice.
- It does not put raw marking codes into reconciliation requests, responses,
  telemetry, or operator diagnostics.
- It does not replace the existing sync queue, batch idempotency, or box-set
  signature safeguards.

## Chosen approach

Use exact per-box identity reconciliation rather than comparing only shift or
pallet counters. Aggregate counters can say that eight boxes are missing but
cannot identify which local records may be safely replayed. A digest-tree protocol
would reduce payload size for very large datasets, but it adds protocol and
debugging complexity that is not justified for the expected shift sizes.

The Station sends bounded batches of box facts to a dedicated station-only API.
The server compares each box independently and returns one result per requested
local box id. Safe gaps are repaired by re-queuing the affected local production
records through the existing sync engine; the reconciliation API itself never
writes scans or creates boxes.

## Reconciliation identity

Each request item contains:

- local shift id;
- local box id;
- SSCC;
- closed-at instant;
- local pallet id, when present;
- effective local item count;
- a versioned, deterministic digest of the effective member-code identity set.

The digest is computed over the same normalized code identity used by the sync
and registry rules, sorted in a stable order and domain-separated by a digest
version. It is not a digest of display strings or SQLite row order. Displaced or
otherwise ineffective membership is excluded consistently on both sides. The
request contains neither raw codes nor a caller-supplied tenant or terminal id.

The server scopes lookup by the authenticated device and tenant, then verifies
the shift, local box identity, SSCC, membership digest, closure, and pallet
relationship. The device id comes only from the station credential boundary.

Requests are strict and limited to 200 boxes. The response preserves the local
box id correlation and returns one of these statuses:

- `confirmed`: identity, effective contents, closure, and pallet relationship
  match.
- `replay_required`: no conflicting server identity exists and either the whole
  box is absent, or exact contents exist but closure or the expected pallet link
  is missing. Its stable reason code distinguishes these cases.
- `content_mismatch`: a server box exists under the expected identity, but its
  effective member set or count differs.
- `identity_conflict`: the local box id or SSCC resolves to a different shift,
  device-owned box, SSCC, or pallet relationship that cannot be safely filled.

Responses use stable reason codes for storage and tests. User-visible Russian
copy is mapped in the Station and is not returned by the API.

## Safe repair rules

`confirmed` marks the local box as reconciled.

For an entirely absent server box, the Station first proves that it can
reconstruct every effective accepted member scan from durable local evidence.
The normal `outbox` cannot be reused: it deletes rows on acknowledgement. The
scan journal retains the raw scan, verdict, time, terminal and operator, while
`codes_mirror` retains the member hash, GTIN, serial, time and box id. For older
rows, recovery matches the journal's canonical code hash to the mirror record
and rejects missing or ambiguous matches. New journal rows record code hash and
box id directly so future reconstruction has an exact join key. The Station
then atomically appends only the target box's reconstructed accepted scans to
`outbox`, clears that box's closure acknowledgement, and clears its
reconciliation marker. For a server box with exact contents but only a missing
closure or pallet link, the Station requeues the closure without replaying
member scans. It nudges the existing sync engine. The normal ingest path
reapplies the missing facts with its established idempotency and conflict
handling. After ingest acknowledgement, the box remains due for a control
reconciliation; only that later `confirmed` result completes recovery.

If the journal evidence is absent, ambiguous, or does not match the complete
effective local member set, the Station records a durable local
`replay_evidence_missing` issue and does not send a partial box. This reason is
distinct from the server's four reconciliation statuses. A future retention
policy must preserve the journal evidence and member mirror rows of any box
that is not yet reconciled or has an unresolved issue.

Replaying the member code events is required when the server has no trace of the
box. Replaying only the closure would leave an empty or nonexistent aggregation
record and would not recover the observed class of incident.

The server may fill a missing pallet link on an already closed box only when all
of tenant, authenticated device, shift, local box id, SSCC, and membership digest
match and the existing pallet link is null. It must never overwrite a different
non-null pallet id. A different relationship is `identity_conflict`, not an
automatic move, unless it is a later warehouse link (see the 2026-09-26
revision below). If the named pallet is not yet present, normal closure replay
creates it through the existing ingest pre-pass; a later control reconciliation
can then fill the null link under the same exact-match guard.

`content_mismatch` and `identity_conflict` never cause destructive local or
server mutation. They create or update a durable local issue and remain visible
until a later reconciliation confirms that the underlying discrepancy was
resolved.

## Station persistence

`boxes_mirror` gains an integer reconciliation revision (initially 1), an
integer confirmed revision (initially 0), and a nullable
`server_reconciled_at` timestamp. A delivered box is due when the confirmed
revision is behind the requested revision. Existing closed boxes therefore
become due when the migration is installed, without a one-off list or database
edit. A response confirms only the revision it actually checked; a late
response cannot satisfy a newer full-audit request. The timestamp is for
operator history, not queue ordering.

A separate local issue table stores only hard reconciliation discrepancies,
keyed by box id. It records the shift id, status, stable reason code, local and
server item counts, last checked time, and non-sensitive server identifiers
needed for support. A subsequent `confirmed` result resolves/removes the active
issue. Network failures are retry state, not hard issues.

Pending work is derived from durable box state rather than held only in React
memory. The device-wide sync worker also considers boxes from paused or closed
shifts, so clearing the active work screen cannot orphan reconciliation.

All local state transitions that append a target box's member scans and clear
its closure acknowledgement use `SqlExecutor.atomic` on a held native
connection. A crash must leave either the former acknowledgements intact or
the complete targeted replay pending, never half of the box requeued.

## Scheduling and lifecycle barriers

Only one reconciliation run may execute per device at a time. Additional timer,
reconnect, pause, close, or manual requests coalesce into another run instead of
starting concurrent requests.

Reconciliation and ingest share one delivery critical section. A result may not
clear acknowledgements while an ingest batch is being assembled, posted, or
committed, because that could mutate the row set underneath its pinned ceilings.
The worker waits for the current drain commit, applies the targeted replay
transaction, and then nudges a fresh drain with a newly derived batch identity.
It does not start a second replay for a box while the first replay is queued or
awaiting its control check.

The triggers are:

- every two minutes while a shift is active, for delivered but unreconciled
  boxes;
- immediately after connectivity is restored;
- manually from the synchronization details dialog;
- a full audit of every closed box in the shift when the operator pauses it;
- a full audit of every closed box in the shift when the operator closes it.

A full-audit trigger first increments the requested reconciliation revision
for all closed boxes in the shift in one local statement, before attempting
network work. The request therefore survives an offline pause/close and is
still due after the active shift leaves the screen.

Pause and close use a lifecycle coordinator with a total ten-second online
budget:

1. stop admitting new scans for that lifecycle action and settle the current
   local box/pallet decision;
2. nudge and briefly drain existing sync work;
3. request a full shift reconciliation;
4. nudge any targeted repairs and run a control reconciliation while budget
   remains;
5. persist the requested local pause or close regardless of connectivity,
   timeout, or unresolved hard discrepancies.

The reconciliation request happens before the sync engine is paused. If the
budget expires or the server is unavailable, unreconciled markers and requeued
records remain durable and the device-wide worker resumes them after reconnect or
restart. The lifecycle action is not rolled back.

## Operator experience

The status header gains no new row of counters. Its existing `Синхр.` status pill
becomes the single synchronization button instead of adding another control:

- normal and fully reconciled: its ordinary state;
- active transfer or reconciliation: the existing busy treatment;
- a hard `content_mismatch` or `identity_conflict`: a small non-numeric attention
  marker on the button;
- ordinary offline or pending work does not become a permanent warning badge.

Pressing the button during an active shift opens a `Синхронизация смены` dialog.
Its primary summary shows:

- `Закрыто коробов локально`;
- `Передано на сервер`;
- `Подтверждено сверкой`;
- `Ожидает проверки`;
- `Требует внимания`.

Below the counters, the dialog explains the current action in operator language,
for example: `8 коробов будут отправлены повторно автоматически`, `Последняя
сверка: 03:58`, `Следующая попытка через 1 мин`, or `Нет связи`. Hard issues list
the affected SSCC and a concise reason. They do not expose batch ids, database
errors, raw marking codes, or stack traces.

The dialog actions are `Сверить сейчас` and `Закрыть`. A collapsed support-only
`Диагностика` section may copy a sanitized report containing ids, counters,
timestamps, state and reason codes, but no credentials or raw marking codes.

The status header also exists outside an active work screen. In that state the
same button opens `Синхронизация станции`: device-wide queue totals first, then
pending or problematic shifts as rows. Selecting a shift shows the same five
box counters and issue list. This keeps reconciliation of a just-closed shift
discoverable after the active shift has been cleared from the screen.

Pause and close never open the dialog automatically. While the bounded barrier
runs, the existing lifecycle surface shows `Сверяем данные смены…`. If it cannot
finish, the transition proceeds with the non-blocking notice `Смена сохранена.
Сверка продолжится после восстановления связи`. Automatically repaired boxes do
not demand acknowledgement from the operator. A hard issue leaves the attention
marker on the synchronization button.

## API and trust boundary

Add a station-authenticated reconciliation route under the existing
`station-scans` surface. It uses the same station-only, tenant and subscription
recovery guard policy as the current station status/release endpoints. The route
must derive device and tenant identity from the authenticated request and reject
or non-disclose records from another tenant, device, or shift.

The route is read-only except for the narrowly guarded late fill of a null pallet
link described above. Production replay remains on the normal scan-ingest route.
The route contract, OpenAPI coverage, route inventory, and
`docs/device-key-surface.md` are updated together.

The server evaluates all items independently. One conflict does not reject or
hide confirmations for the rest of the batch. Infrastructure failures still fail
the request so the Station retries; malformed individual records receive precise
per-item errors according to the established station DTO conventions.

## Observability and support

Structured server logs and metrics record only tenant/device-safe identifiers,
status and reason, batch size, duration, and repair counts. They must make it
possible to distinguish:

- reconciliation endpoint unavailable;
- box absent and queued for replay;
- exact box missing only closure or pallet link;
- content mismatch;
- identity conflict;
- repair replay delivered but not yet control-confirmed.

The Station's sanitized diagnostics use the same stable reason codes. Neither
side logs raw marking codes or secrets.

## Failure handling

- **Offline or timeout:** keep the due state, back off with the existing sync
  connectivity policy, and continue production.
- **Station restart:** reconstruct pending work from SQLite and resume without an
  in-memory token.
- **Duplicate trigger:** coalesce under the single-flight worker.
- **Duplicate response/replay:** idempotent state transition; no duplicate box or
  membership is created.
- **Partial response:** apply only correlated results that pass response
  validation; leave omitted boxes due and retry them.
- **Hard mismatch:** persist the issue, do not overwrite either side, and keep
  production running.
- **Old Station version:** existing ingest remains compatible; reconciliation is
  additive and is simply not called.
- **Old queued payload:** normal sync continues to accept it under the existing
  compatibility rules; the new reconciliation metadata is local-only.

## Testing strategy

### Server contract and integration

- Reproduce the incident shape: six boxes applied, a response effectively lost,
  and eight additional local boxes falsely considered delivered. Reconciliation
  identifies exactly the eight missing boxes; targeted replay plus control
  reconciliation produces 66 confirmed boxes on the pallet, including SSCC
  serial 1575.
- Confirm an exactly matching box without writing aggregation state.
- Classify an entirely absent box as `replay_required` when no conflicting
  identity exists.
- Classify matching contents with missing closure or null pallet link as
  `replay_required`, and fill only the permitted null link.
- Return `content_mismatch` for a different effective set or count and never
  overwrite membership.
- Return `identity_conflict` for reused local ids, SSCCs, non-null different
  pallet links that no later warehouse aggregation explains, or incompatible
  shift/device ownership.
- Confirm, without writing, a box a handheld later put on a warehouse pallet:
  one the Station closed without a pallet, and one whose Station pallet was
  taken apart first.
- Repeat requests and repairs without duplicates or counter drift.
- Deny or non-disclose cross-tenant, cross-device, cabinet-session, and malformed
  requests according to the route policy.
- Verify exact guard metadata, DTO bounds, OpenAPI shape, route inventory, and
  safe structured logging.

### Station persistence and sync

- SQLite runtime migration marks existing closed boxes as due without losing any
  queue state.
- A `confirmed` result records reconciliation and resolves a prior issue.
- `replay_required` atomically requeues only the target box and all its member
  code events, then requires a later control confirmation.
- A crash/restart at each transition preserves a recoverable whole-box state.
- Hard statuses persist across restart and do not mutate box contents or pallet
  identity.
- More than 200 boxes are chunked deterministically.
- Timer, reconnect, manual, pause, and close triggers remain single-flight and
  coalesce correctly.
- Device-wide processing continues for a shift after its work screen has closed.

### Lifecycle and UI

- Pause and close attempt drain, full reconciliation, repair, and control check
  within the shared ten-second budget.
- Offline, timeout, and hard mismatch cases still persist the local pause/close
  and leave durable follow-up work.
- The existing synchronization status pill becomes a button; the header adds
  only its hard-issue marker and no separate counter control.
- The dialog counters are derived consistently from local delivery,
  reconciliation, and issue state.
- After shift close, its unresolved work remains visible in the device-wide
  synchronization dialog.
- `Сверить сейчас` schedules work without creating a parallel run.
- Operator messages distinguish pending, offline, automatically repairing, and
  hard-conflict states without exposing sensitive diagnostics.

### Regression gates

Run focused DB runtime-migration, Station sync/lifecycle/UI, and API station-scan
tests first, then the standard test, typecheck, lint, and build gates for
`@markiro/db`, `@markiro/station`, and `@markiro/api`. Update the local Graphify
index after code changes. Windows, real factory connectivity, scanner/printer
hardware, physical pallet counts, and production deployment remain separate
acceptance gates.

## Rollout and recovery of the current incident

The feature is additive and can be deployed server-first. After a Station build
with the SQLite migration is installed, all existing closed boxes without a
reconciliation marker become due. The first online run therefore audits the
active `SEP26-021` shift. It can replay 1575–1582 automatically only if the
server classifies them as safely absent and the old scan journal can be matched
unambiguously to all local members. Otherwise it exposes the exact box and
reason for targeted investigation.

This is not a substitute for preserving a cold copy of the current Station
database before updating or attempting manual repair. The production incident is
accepted only after server-side box identities, item counts, pallet membership,
and the 66 total are verified; a successful local request or green automated test
alone is not production recovery evidence.

Rollout should watch status/reason metrics and repair volume before widening the
Station release. Any `content_mismatch` or `identity_conflict` for the incident is
an investigation signal, not permission to force data into agreement.

## Alternatives rejected

### Counters only

Comparing local and server totals is cheap but cannot name the missing boxes or
prove that replay is safe. It remains useful as UI summary, not as the repair
contract.

### Full raw-code comparison in the reconciliation API

It would duplicate ingest, enlarge sensitive payloads, and create a second place
that can change code ownership. A count plus versioned identity-set digest detects
composition differences while all actual replay stays in the existing sync path.

### Blocking pause or close until the server confirms everything

This contradicts the Station's offline production guarantee and turns a network
fault into line stoppage. The bounded barrier improves timeliness without making
connectivity a prerequisite.

### Automatic overwrite on mismatch

A differing membership or established pallet relationship can represent a real
duplicate, manual correction, or cross-device conflict. Silent overwrite would
destroy the evidence needed to resolve it.

## Revision, 2026-09-26: later warehouse aggregation

The first release compared the server's current pallet link with the pallet the
Station recorded when it closed the box, and reported any difference as
`pallet_conflict`. That assumed the Station is the only writer of the link. It
is not: a handheld may later put a closed box onto a warehouse pallet when the
box stands on no pallet, or when its pallet has been taken apart. The Station
never learns of that link. A shift closed without pallets and palletised
afterwards on a handheld therefore showed `Привязка к другому паллету` on every
box.

The server now confirms such a box without writing to it:

- the Station reports no pallet and the server links the box to a warehouse
  pallet;
- the Station reports its own production pallet, the server has recorded that
  pallet as disassembled, and the box now stands on a warehouse pallet.

A production link the Station did not report, and a warehouse link while the
Station's own pallet still stands, remain `identity_conflict`: no recorded
event explains how the box left the Station's pallet.

The fix is server-only. A Station re-checks each box with an open issue once
its last check is two minutes old, and a `confirmed` result clears that issue,
so boxes already flagged recover after the API deploy without a Station
release.
