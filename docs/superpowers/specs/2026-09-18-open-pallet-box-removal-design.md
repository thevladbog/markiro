# Taking a box off an open warehouse pallet — design

**Status:** accepted by the owner 2026-09-18 (chat). Supersedes the «Removing
a box» bullet of §3.2 in
[2026-09-17-warehouse-pallet-aggregation-design.md](2026-09-17-warehouse-pallet-aggregation-design.md).

## Problem

In the handheld's «Паллеты» mode a scanned box joins the open warehouse
pallet as a `pallet_memberships` row, and the view model nudges sync at once.
On a live network the row is `sent` and then `accepted` within seconds, and
«Убрать с паллеты» is offered only while the row is still `pending`. An open
pallet has no SSCC, so neither disassemble route (handheld or cabinet) can
reach it, and the server has no operation that takes a box off an open
pallet. The only exit after a wrong scan is «Закрыть паллету досрочно», which
burns an extension-1 serial and prints a label for a stack that was never
meant to exist, followed by a disassembly of that pallet.

## Outcome

- «Убрать с паллеты» works for every box on the open pallet, whatever its
  membership status, online or offline.
- Removing the last box makes the open pallet disappear on the device and on
  the server. No serial is burned and nothing is printed.
- Other handhelds learn that the box is free again through the ordinary box
  registry delta.
- Old devices keep working: the new batch field is optional and its absence
  keeps every pinned batch digest unchanged.

## Decisions

- **An open warehouse pallet is a draft.** It has no SSCC, no label and no
  export, so nothing physical or documentary refers to it. A draft that
  empties is deleted, not marked `disassembled`: a row with `closed_at IS
NULL AND disassembled_at IS NOT NULL` would be a third pallet state the
  cabinet, the registry and the ingest rules would all have to learn.
- **Removal is a sync record, not a REST call.** The pallets mode is
  offline-first; a removal is queued locally exactly like the membership it
  undoes and rides the same `POST /station/scans` batch.
- **Every removal is queued, whatever the row's status.** A `pending` row's
  batch may already have reached the server with its response lost; queuing
  the removal regardless costs one harmless `not_found`/`replayed` answer and
  closes that gap. The pre-pass never creates a pallet row for a removal.
- **`boxes.pallet_id` may be cleared** by a removal from an open warehouse
  pallet owned by the same device. This is the second relaxation of the 06d
  «never cleared» rule (the first: overwrite when the old pallet is
  disassembled). It is limited to the draft state above.
- **Order inside the batch: removals before memberships.** A box removed and
  re-scanned onto the same pallet before the next sync sends both records in
  one batch; applying the removal first makes the membership `accepted`
  rather than `replayed`-then-cleared.
- **Same cap as memberships.** `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH`
  bounds the new list too; no new constant, no fixture regeneration.

## 1. Database

Migration `0165_pallet_membership_removal_quarantine`: widen
`station_sync_quarantine_record_kind_check` with `'pallet_membership_removal'`.
Nothing else changes; the pallet row deletion needs no schema.

## 2. Server — `POST /station/scans`

**`palletMembershipRemovals[]`** — new optional record kind, `.default([])`:

```ts
{
  palletId: string; // device-local, max 64
  boxSscc: string; // 18 digits
  removedAt: string; // device clock
  operatorId: string | null;
}
```

Capped by `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH`; each `(palletId, boxSscc)`
at most once per batch. Folded into `payloadDigest` only when non-empty.

**Response** gains `membershipRemovals?: { palletId, boxSscc, status }[]`, one
entry per submitted record in submission order, present when the batch
carried any. `status`:

| status                   | meaning                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| `removed`                | `boxes.pallet_id` cleared                                                      |
| `replayed`               | the box is not on that pallet (already removed, or never accepted)             |
| `not_found`              | no such warehouse pallet of this device, or no such box                        |
| `pallet_closed`          | the pallet is closed or disassembled on the server; the box stays, disassemble |
| `subscription_read_only` | denied and quarantined, like a membership                                      |

**Ingest order** inside the existing transaction: items → box closures →
**removals** → pallet pre-pass + memberships → **prune emptied drafts** →
pallet closures → box exceptions → pallet exceptions. The membership pre-pass
runs inside the memberships block, after the removals, so a removal naming a
pallet that only a membership in the SAME batch creates answers `not_found`
rather than `replayed` — both terminal on the device, which deletes the row
either way.

Removal statement, one per record, sorted by `(palletId, boxSscc)`; the pallet
is resolved first by `(tenant_id, device_id, device_pallet_id) WHERE kind =
'warehouse'`:

```sql
UPDATE boxes b
   SET pallet_id = NULL, updated_at = now()
  FROM pallets tp
 WHERE b.tenant_id = :tenant AND b.sscc = :sscc
   AND tp.tenant_id = b.tenant_id AND tp.id = b.pallet_id AND tp.id = :pallet
   AND tp.closed_at IS NULL AND tp.disassembled_at IS NULL
RETURNING b.id
```

Zero rows: no pallet row or no box row → `not_found`; `b.pallet_id <>
:pallet` (or null) → `replayed`; pallet closed/disassembled → `pallet_closed`.
Removed box ids go to `advanceBoxRegistryVersion` with the memberships' ids.

**Prune.** After memberships, for every pallet a removal touched with
`removed`: delete its `pallet_membership_rejections`, then `DELETE FROM
pallets WHERE id = :id AND kind = 'warehouse' AND closed_at IS NULL AND
disassembled_at IS NULL AND NOT EXISTS (SELECT 1 FROM boxes WHERE pallet_id =
:id)`. An open pallet has no exceptions and no exports, but one other row can still
reference it: a RIVAL device's `already_on_pallet` rejection stores this draft
as its `winning_pallet_id`, and that row hangs off the rival's own pallet. Both
FKs are `ON DELETE NO ACTION`, so the prune first runs `UPDATE
pallet_membership_rejections SET winning_pallet_id = NULL WHERE tenant_id =
:tenant AND winning_pallet_id = :id` — the rival keeps its record of what it
scanned, and the pointer is meaningless once the draft is gone. The device's
own rejection rows are its record of those refusals; the cabinet had a card for
a pallet that no longer exists.

**Read-only subscription.** Removals are denied and quarantined exactly like
memberships (`recordKind: "pallet_membership_removal"`, `shiftId: null`), and
reported `subscription_read_only` positionally.

Cabinet API and admin need no change: a deleted draft simply leaves the list.

## 3. Handheld

### 3.1 Storage (Room 18 → 19)

New table, the removal queue:

```
pallet_membership_removals(id INTEGER PRIMARY KEY AUTOINCREMENT,
  palletId TEXT NOT NULL, sscc TEXT NOT NULL, removedAt TEXT NOT NULL,
  operatorId TEXT, status TEXT NOT NULL); index (status, id)
```

Rows are events, not a per-box state: a box can be removed, re-scanned and
removed again, and a removal already `sent` belongs to a pinned batch that
must resend it unchanged, so a later removal of the same box is a NEW row.
A `pending` removal for the same `(palletId, sscc)` is reused instead —
the membership between the two removals never left the device — so a batch
never carries the same key twice. `status` is `pending` or `sent`, with the
same pin/revert life as `pallet_memberships`. `MIGRATION_18_19` is a plain `CREATE TABLE IF NOT
EXISTS` plus the index. New DAO methods: `PalletMembershipDao.delete(palletId,
sscc)` and `deleteForPallet(palletId)`; `PalletDao.delete(palletId)`;
`BoxRegistryDao.clearPallet(sscc)` (sets `palletId`, `palletSscc` to null and
`palletActive` to false).

### 3.2 Removing

`WarehousePallets.remove(palletId, sscc, operatorId)` under lease → lock →
transaction:

1. The membership row must exist and not be `rejected`; otherwise `false`.
2. Delete the membership row; `release(sscc)` and `clearPallet(sscc)` on the
   registry mirror (optimistic: the server will say the same once the
   removal lands).
3. Queue the removal: reuse a `pending` row for the same `(palletId, sscc)`
   if one exists, otherwise insert a new `pending` row (even when a `sent`
   one exists — see 3.1).
4. If `countOnPallet(palletId) == 0` and the pallet is still open: delete the
   pallet row and its remaining (rejected) membership rows. `observeOpen()`
   then emits null and the screen returns to «Отсканируйте короб».

`attach` gains one exemption: the «already on an open pallet of another
device» refusal (`palletActive` with null `palletSscc`) is skipped while a
removal for that SSCC is still queued — the registry may still show the
device's own claim that the queued removal undoes.

### 3.3 Sync

The removal channel mirrors the membership channel in `SyncEngine`: pinned
rows are the `sent` ones, a fresh batch re-reads `pending` inside the pin
commit, the set is folded into the batch-id signature as a seventh
component, the count is kept under `SYNC_PENDING_MEMBERSHIP_REMOVAL_COUNT`,
`clearPending` reverts `sent` to `pending`, and the queue indicator counts
them. Wire DTO `PalletMembershipRemovalDto(palletId, boxSscc, removedAt,
operatorId)` on `SyncBatchRequest.palletMembershipRemovals`.

Response guard: a batch that carried removals is acknowledged only when
`membershipRemovals` has exactly one entry per row, in order. On every
terminal status the removal row is deleted; on `removed`/`replayed`/
`not_found` the registry mirror row gets `clearPallet` again (the server's
state is now exactly that); `pallet_closed` and `subscription_read_only`
are dropped after a comment (the engine has no logging idiom) and leave the
mirror alone for the next refresh.

`SyncEngine.MAX_PALLET_MEMBERSHIP_REMOVALS = 100`, pinned to
`maxPalletMembershipsPerSyncBatch` by `SyncLimitsFixturesTest` the way
`MAX_PALLET_EXCEPTIONS` is pinned to the closure cap.

### 3.4 Screen

`MemberRow` offers «Убрать с паллеты» for every non-rejected row. No new
strings. The README's pallets section and `CHANGELOG.md` describe the change.

## 4. Errors and races

- **Removal of a `sent` row whose batch is in flight.** The membership row is
  deleted locally; the pinned batch resends the membership DTOs snapshotted at
  pin time, so a local delete cannot change its bytes. That snapshot is
  `SYNC_PENDING_MEMBERSHIP_SNAPSHOT`, written under the same commit as the
  batch id and the `markSent` marks, and it — not a live `sent()` re-read — is
  what a retry sends and what the response is matched against positionally.
  Without it the identical `batchId` would go out with fewer memberships and
  the server would answer `station_batch_mismatch` (409) forever, wedging every
  channel on the terminal. The outcome handler's `markAccepted`/`markRejected`
  then find no row, which is a no-op. The removal rides the next batch. Server
  order across batches is membership then removal: correct. Removals need no
  such snapshot: a removal row is never deleted until it is acknowledged, so
  its `sent()` re-read is already stable.
- **Removal queued, box re-scanned onto a new draft.** Locally the old draft
  is gone and a new one opens with a new device-local id. The batch carries
  `removal(old, box)` and `membership(new, box)`; removals apply first, the
  pre-pass created `new`, the membership is `accepted`.
- **Two devices.** A removal names the device's own pallet only; another
  device's pallet is never touched. A foreign box on a foreign open pallet
  still refuses as today.
- **Prune vs. a membership in a later batch.** Impossible from the same
  device: the draft is deleted locally only when no non-rejected membership
  row remains, and a queued membership is such a row.
- **Compatibility.** A device without this release never sends the field,
  and a batch without removals hashes exactly as before. `syncBatchSchema`
  is strict, so a device WITH this release needs the server deployed first:
  the handheld release follows the production deploy, as for every additive
  channel before it.

## 5. Verification

- **DB**: migration test asserts the widened CHECK.
- **API**: DTO tests (default, cap, per-batch uniqueness); e2e in
  `station-scans-warehouse-pallets.e2e.test.ts` for `removed`, `replayed`,
  `not_found`, `pallet_closed`, the prune (pallet row and its rejections
  gone, registry delta shows the box free), removal + re-attach in one
  batch, digest stability of a batch without removals, and the read-only
  denial/quarantine of a removal. OpenAPI coverage gate stays green.
- **Handheld**: `WarehousePalletsTest` (remove any status, draft deleted when
  empty, attach exemption); `SyncPalletMembershipRemovalsTest` (pin, signature,
  outcome application, malformed answer wedges); migration test for 18 → 19;
  `PalletsScreensTest` («Убрать» on a sent row); `SyncLimitsFixturesTest`.
  Gates: `testDebugUnitTest lintDebug assembleDebug`.
- Not covered by automation: a real terminal and a real network drop between
  scan and removal.
