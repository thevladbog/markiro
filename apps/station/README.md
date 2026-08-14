# @markiro/station

Markiro line station — a Tauri 2.11 + React 19 floor-mode app. Reuses
`@markiro/ui` (dark floor theme) and `@markiro/domain` (GTIN normalization).

## Offline model

The station is offline-first. At enrollment it stores a device api-key + server
URL in a `0600` `station.json` (OS app-config dir). A shift is downloaded in
full via `GET /shifts/:id/bundle` into a local SQLite mirror
(`tauri-plugin-sql`, schema from `@markiro/db` `STATION_MIGRATIONS`). Operators
sign in **offline** by PIN/badge, verified locally against `operators_mirror`
(PBKDF2 PHC verifiers) — a PIN is never sent to the server.

Interrupted-print recovery uses `GET /shifts/:id/reference-bundle` instead.
That response refreshes the mirrored shift/product/template references with
`sscc: null`; it never allocates server serial state and the recovery mirror
never calls the device's local `addRange` path.

## Dev run (macOS)

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d   # API + Postgres for enrollment
pnpm --filter @markiro/api dev                    # http://localhost:3000
pnpm --filter @markiro/station tauri dev          # launches the desktop webview
```

The Windows installer is produced in CI (see `.github/workflows/ci.yml`); a
`tauri build` is not required on macOS for development.

## Enrollment

1. In the admin panel, create a station device and copy its one-time pairing
   code.
2. Launch the station and enter or scan that code. The station redeems it at
   the API base embedded at build time, then persists the returned device
   credential and roster before it routes to operator sign-in (`OperatorLogin`).
3. The manual URL + API-key screen is retained only as a service recovery
   path; it probes `GET /shifts` before persisting a credential.

### Pairing API base and CORS

`VITE_STATION_API_URL` is a **build-time** setting for the station Vite build.
It must be the canonical HTTP(S) API origin (no path, query, fragment, or
userinfo). Fresh pairing is intentionally disabled when it is absent or
invalid; a packaged station must never infer an API target from its webview
URL. After a credential is cleared, the persisted trusted `server_url` is used
for re-pairing instead.

Set the API deployment's `STATION_ORIGIN` to the exact station webview origin.
The shipped Windows Tauri 2 build uses `http://tauri.localhost`; this exact
value must be present in the production API runtime before a Station release.
The API allows it only on the documented station method/path pairs, never on
cabinet, auth, platform, or kiosk endpoints. `tauri://localhost` is the
non-opaque custom-protocol origin used by other Tauri platforms, not the
deployed Windows value. Never configure opaque `null`.

Before building or publishing the Windows installer, verify the deployed API
with `pnpm verify:station-production-cors`. The check sends the real pairing
preflight to `https://admin.markiro.app/station/pair` and fails unless the API
returns HTTP 204 and echoes `http://tauri.localhost` exactly.

`clear_credential` retains the machine, device, and trusted server identities
but removes the API key and tenant/place metadata. It deliberately does not
seal an actively running station on HTTP 401; Task 11 owns that runtime
boundary. It also does not touch the local SQLite operational journal.

## Operator credential hash contract

`operators_mirror` stores PIN/badge verifiers as a PHC-like string:
`pbkdf2$sha256$<iterations>$<saltBase64>$<hashBase64>`, computed by
`apps/station/src/lib/crypto.ts` with WebCrypto `SubtleCrypto`
PBKDF2-SHA256. The format string alone underspecifies interop — the
server-side hasher (`apps/api/src/lib/pin-hash.ts`, which mints these hashes
for `operator_credentials`) MUST also match these pinned constraints:

- **Derived key length is EXACTLY 32 bytes** (`dkLen=32` / 256-bit).
- **Base64 is STANDARD, WITH padding** (`btoa`/`atob`, RFC 4648 §4) — **NOT**
  the PHC-spec unpadded B64 (RFC 4648 §5). A stock PHC encoder/decoder will
  break interop here.
- **Salt is 16 bytes.**
- **Iterations ≥ 100000 for newly minted hashes** (the station's own
  `hashSecret` always mints at 100000; older/foreign hashes with a lower
  count still verify, but nothing new should be minted below that floor —
  `verifySecret` also rejects any hash below a 10000-iteration floor
  outright, so anything under that is simply invalid).

`apps/station/test/crypto.test.ts`'s known-vector test (cross-checked
byte-for-byte against Node's `pbkdf2Sync`) is the **executable spec**: the
server's hasher must reproduce that exact vector, not just satisfy the prose
above.

## Operator roster

During initialization — right after enrollment, and again on every later
app start while online — the station pulls `GET /station/operators` (device
api-key, callable before any operator has signed in) into `operators_mirror`;
see "Operator credential hash contract" above for the verifier format stored
there. The same roster, produced by the same server-side service method,
also rides along with every `GET /shifts/:id/bundle` download, so opening a
shift refreshes the mirror too. Sign-in is by personnel number + PIN, or a
badge scan, checked locally against whatever is currently in the mirror. An
operator hired, or newly granted station access, while the device is offline
cannot sign in until the next successful roster sync — a successful sync
replaces the whole mirror, so a revoked or deactivated operator likewise
stops authenticating offline as soon as the device reconnects.

## Scan loop (validation)

The floor screen (`WorkScreen`) is a pipeline: source → queue → domain
verdict → journal → signal.

- **Source** (`src/lib/scan-source.ts`) is a `ScanSource` seam with two
  implementations: `createKeyboardWedgeSource`, the default, which
  accumulates HID keydown events and flushes on Enter — most USB barcode
  scanners are HID keyboards, so the station works with no configuration —
  and `createHardwareScanSource`, which adapts the Tauri-backed
  `HardwareContract`'s serial `onScan` event to the same seam.
- **Queue** (`src/lib/scan-queue.ts`): `createScanQueue` processes exactly
  one scan to completion before starting the next. This is what makes
  duplicate detection honest (two scans processed concurrently could both
  pass the check before either is written) and avoids contending for
  `tauri-plugin-sql`'s connection pool across BEGIN/COMMIT. A scan that
  arrives mid-flight is buffered, never dropped.
- **Verdict**: each raw payload is classified and validated by
  `@markiro/domain` (`classifyScan`, `validateShiftScan`) against the
  shift's expected GTIN and an in-memory `Set` of accepted code keys.
  That set is loaded once by `loadCodeKeys` (`src/lib/journal.ts`) from
  `codes_mirror` and kept **device-wide, not shift-scoped**: `code_hash`
  is a global primary key, and a KM identifies one physical item, so the
  same code scanned under a different shift is still a duplicate.
- **Journal** (`src/lib/journal.ts`): `recordScan` writes the code row to
  `codes_mirror` FIRST — only for an accepted scan — then always appends the
  event row to `scan_events_mirror` second, then enqueues the scan into the
  outbox third (see "Sync" below). These are deliberately independent
  statements, not one transaction: `tauri-plugin-sql` hands a possibly
  different pooled connection to every call, so a `BEGIN` on one call and a
  `COMMIT` on another are not actually one transaction, and can fail outright
  under real overlapping DB work. Instead, `codes_mirror`'s `PRIMARY KEY` on
  `code_hash` is the real backstop: a constraint violation on the code insert
  **is** the duplicate verdict (reported back as `alreadyPresent`), not a
  write failure. The event row is always appended regardless, and records the
  verdict the operator actually saw — journalled as `"duplicate"` when the
  code insert hit `alreadyPresent`, even if the caller predicted `"ok"`.
  Failure semantics: if the event write fails after the code row already
  landed, the code stays accepted without its audit row — deliberately
  preferred over losing the code itself. If the outbox insert then fails,
  `recordScan` still rethrows so the operator sees it — but first, if this
  call is the one that just stored a new code row, that row is best-effort
  deleted from `codes_mirror`, so the operator's rescan lands as a clean
  accept instead of a phantom duplicate that can never reach the server (the
  code would otherwise be stuck "accepted" locally with nothing queued to
  send it).
- **Signal** (`src/lib/signal-sound.ts` + `src/ui/SignalOverlay.tsx`): the
  verdict drives a full-screen colored flash plus a tone synthesised with
  WebAudio (no audio assets, nothing fetched from a CDN). Mute and volume
  are persisted in `station_meta` (`loadSoundSettings`/`saveSoundSettings`).

## Sync

Every scan `recordScan` journals is also enqueued into the outbox, and a
separate engine drains that queue to the server. The two halves are
deliberately decoupled: a scan is accepted or rejected locally, instantly,
with no network involved, and delivery to the server is a background concern
that can lag arbitrarily far behind without blocking the floor.

- **Outbox** (`src/lib/outbox.ts`, the `outbox` table) is a device-local
  transport queue, separate from `codes_mirror` on purpose: `codes_mirror`
  exists for offline duplicate detection and will be purged on a retention
  schedule, while the outbox holds transport state that must survive until
  the server has actually confirmed a scan. If delivery state lived in
  `codes_mirror` instead, a retention purge could silently discard a scan
  that was never delivered. Its `id` is `INTEGER PRIMARY KEY AUTOINCREMENT`,
  not a bare `INTEGER PRIMARY KEY`, for the same reason: an ordinary SQLite
  rowid is reused after a delete, so once purges start, a plain rowid could
  let a new scan take an id at or below one the server already acknowledged;
  `AUTOINCREMENT` guarantees ids are never reused.
- **Drain** (`src/lib/sync.ts`, `createSyncEngine`) reads the oldest
  `BATCH_SIZE` (200) queued scans and posts them to `POST /station/scans` as
  one batch — small enough to survive a flaky plant network link and cheap to
  retry. The batch id is
  `<machineId>:<installId>:<highest outbox id in the batch>`, not random.
  `installId` (`src/lib/install-id.ts`) is a random identifier generated once
  and persisted in `station_meta`, read back on every later call rather than
  regenerated per process — it survives an app restart but NOT
  `station-mirror.db` being deleted and recreated, since it is itself a row
  in that database. That is deliberate: `station.json` (which holds
  `machineId`) and the mirror database are separate files, so a support
  action that deletes only the corrupt local database would otherwise keep
  `machineId` while the outbox's ids restart at 1, reproducing a batch key
  the server had already recorded and silently deleting brand-new scans (the
  server would answer `alreadyApplied: true` for a batch it had genuinely
  never seen) — `installId` gives a fresh database a fresh keyspace instead.
  The `<highest outbox id in the batch>` component is pinned once a batch is
  posted (`pendingCeiling` in `sync.ts`) and held across every retry of that
  same batch — including one a later nudge triggers while the previous
  attempt is still outstanding, AND one issued by a brand-new engine after an
  app restart, crash, or update — rather than re-read fresh each time: while
  the queue holds fewer rows than `BATCH_SIZE` (the ordinary state on a
  continuously-draining line), a fresh read would otherwise pick up rows
  queued since the failed attempt and post them under a new key the server
  has never seen, applying the original rows a second time. The ceiling is
  persisted in `station_meta` (the same key/value table `hardware_config`,
  the roster slot pointer, and the install id already use) with a
  single-statement upsert BEFORE the batch is sent, and cleared with a single
  statement once the server confirms — never a multi-statement device-side
  transaction, since `tauri-plugin-sql` pools connections and a `BEGIN`/
  `COMMIT` sent as separate calls would not actually group them. A brand-new
  engine — built by a fresh process, which starts with nothing in memory —
  seeds its in-memory ceiling from that persisted value on its very first
  drain, so the exact row range a dead process pinned survives the restart
  intact; without that, the fresh engine would fall back to a plain prefix
  read of whatever the queue holds by then, which is exactly the growth this
  mechanism exists to prevent. That is what actually makes at-least-once
  delivery safe: a batch is acknowledged — and its rows permanently deleted
  from the outbox — only once the server has actually confirmed it, so a
  response lost in transit just means the same batch, under the same key,
  gets resent, whether that resend comes from the same process or a new one.
  Before acknowledging, the engine
  also checks that the response actually has the shape
  `{ applied, alreadyApplied }` (number, boolean): a captive portal or other
  proxy on the plant network answering `200 {"status":"ok"}` parses as JSON
  but isn't this endpoint's contract, and acknowledging on the strength of
  that would destroy scans the server never saw.
- **Server side**
  (`apps/api/src/modules/station-scans/station-scans.service.ts`) applies a
  batch and records its idempotency key in a single Postgres transaction, so
  a resent batch is either fully applied or a no-op, never applied twice and
  never partially applied. Before opening that transaction it ensures the
  Postgres partitions the batch's `scanned_at` values need actually exist —
  a device can be offline across a month boundary, or have a dead clock — so
  a missing partition never surfaces as an uncaught 500. That ordering
  matters here specifically: every error from this endpoint is treated as
  retryable by the drain above, so a request that always fails the same way
  would otherwise wedge that station's queue forever — and, with the
  ceiling above now persisted across a restart, that station cannot even
  escape the wedge by re-splitting the batch on its own. The number of
  distinct months one batch may span is capped
  (`MAX_DISTINCT_MONTHS_PER_BATCH`, currently 24) deliberately far above
  anything a contiguous, oldest-first drain could legitimately produce — a
  low-volume or standby station can plausibly sit offline across many month
  boundaries with only a few scans each, and a device with a dead RTC and no
  NTP can contribute one more distinct wrong month per reboot — while still
  bounding the worst case to a few dozen `CREATE TABLE ... PARTITION OF`
  statements. A batch over that cap is rejected with a 400 before a single
  partition is created, so a corrupt or hostile `scannedAt` cannot turn into
  an ACCESS EXCLUSIVE-lock storm on the shared `codes`/`scan_events` parents
  (those locks are global, so that storm would otherwise degrade ingest for
  every tenant, not just the offending one).
- **Triggers**: the engine is nudged, never polled — once when it's built, on
  every scan `recordScan` finishes writing (whatever the verdict — a
  duplicate or a rejection queues an event row too), on every `online`
  browser event, and by a 15-second heartbeat (`src/lib/use-sync-engine.ts`)
  that catches a connection recovering silently (e.g. a captive portal
  clearing with no `online` event). Exactly one drain runs at a time; a
  nudge that arrives mid-drain just requests one more pass once the current
  one finishes — unless a retry is already scheduled (see Backoff below), in
  which case the nudge does nothing and the scheduled attempt is left to run
  on its own timing.
- **Backoff**: a failed batch — network error, non-2xx, or an unrecognized
  response shape — is retried with exponential backoff starting at 2s and
  doubling up to a 60s cap. This also covers a batch the server permanently
  rejects (a 4xx): the engine cannot tell "will succeed on retry" from "never
  will," and the owner's decision, recorded in `sync.ts`, is that losing scan
  data is worse than a stalled queue — so a permanently-rejected batch wedges
  that station's queue by design, and the stuck indicator below is what
  surfaces that to an operator instead of the queue failing silently. A
  nudge that arrives while a retry is already scheduled — a scan recorded
  offline, the `online` listener, the heartbeat — never starts a second,
  immediate attempt: doing so would turn the backoff into one POST per nudge
  under scan load. The queued nudge is simply dropped, since the scheduled
  attempt drains whatever is queued by the time it fires anyway.
- **Stuck warning**: the status bar's sync indicator turns "stuck" once the
  queue is non-empty and has gone `STUCK_AFTER_MS` (15 minutes) without a
  success. The rule spans two time domains that are deliberately never
  compared against each other: once the engine has seen at least one
  success, it measures `now() - lastSuccessAt`; before it has ever seen one
  (e.g. right after an app restart facing a long-queued backlog), there is no
  `lastSuccessAt` yet, so it falls back to the real wall-clock age of the
  oldest still-queued scan instead.
- **Engine lifecycle** (`src/lib/use-sync-engine.ts`) owns building and
  tearing down the engine for the life of the app, as a single paired effect
  rather than a memo plus a separate cleanup effect — that pairing is what
  keeps React StrictMode's dev double-invoke from handing a second setup an
  engine the first cleanup already permanently stopped.
- **Shift boundaries**: the outbox belongs to the device, not to a shift or
  an operator. Leaving a shift does not stop the drain and does not close the
  shift — closing a shift from the floor is deliberately not a station action
  (see `docs/device-key-surface.md`). A device that leaves a shift mid-queue
  keeps draining exactly as before.
- **Late data**: the server accepts a batch for a shift that is already
  closed rather than rejecting it — a device can go offline before its
  operator closes the shift on the cabinet side, or take a while to drain a
  backlog after reconnecting. The first such batch stamps
  `shifts.late_data_at` once (a second late batch for an already-stamped
  shift does not move it), and the admin shift list surfaces it as a badge.

## Cross-terminal conflicts

Two terminals can scan the same code — a KM identifies one physical item —
before either has seen the other's data. Ownership is decided server-side,
by the earliest `scanned_at`, and **never** by arrival order: `code_registry`
holds, per code, whichever claim happened earliest in physical time, and the
ingest upsert only ever moves that row for a strictly earlier scan. Replaying
the same batches in any order therefore always converges to the same owner —
a terminal that was briefly offline does not lose an item merely because a
neighbour's link was better. The registry exists, unpartitioned and keyed by
the code alone, because the obvious alternative doesn't work: a unique index
on a partitioned table must include the partition key, and `codes` is
partitioned by `scanned_at`, not by code, so `codes` itself cannot enforce
"one row per code." `code_registry` is the real authority, probed by primary
key so the hot ingest path never has to scan a partitioned table.

A station learns about a lost scan **only when it is the one that lost it**,
through its own sync response (`conflicts` in `SyncBatchResponseDto`, folded
into `conflicts_mirror` by `src/lib/conflicts.ts`). It is never told about a
scan it displaced belonging to some other terminal — that terminal's batch
was acknowledged long before this one arrived, and reopening an
already-acknowledged batch would undo slice 06a's at-least-once delivery
guarantee. The cabinet's conflict view (see
[`docs/device-key-surface.md`](../../docs/device-key-surface.md)) is the only
place that other class of loss is ever recorded or reviewed. This also means
a conflict report reaches a device **at most once**: a resend of an
already-applied batch reports `conflicts: []`, because the server decides
conflicts once, at ingest, and never recomputes them for a retry — a device
that drops that report has lost it for good, and the cabinet is the only
backstop for that class.

Conflicts are recorded before the batch is acknowledged locally, on purpose:
`recordConflicts` (writing `conflicts_mirror`) runs strictly before
`ackThrough` (deleting the batch's rows from the outbox) in `src/lib/sync.ts`.
A crash between the two just means the batch resends — the server no-ops it
(`alreadyApplied`) and the conflicts already written locally are untouched,
since `recordConflicts` is an idempotent upsert keyed by `code_hash`. The
other order would risk losing the conflict for good: acking first and then
crashing before the write would delete the outbox rows that were the only
local record a conflict existed, with no resend left to carry it again.
Recording is also isolated in its own `try`/`catch`, separate from the one
guarding the network call: a failure there has nothing to do with whether the
server received the batch (it already did, durably), so the accepted
trade-off is a silently under-reported count on this device rather than a
terminal that stops delivering scans over a courtesy feature.

On the floor this is deliberately **not an alarm**: nothing competes with a
scan verdict, so the count (`conflictCount`, shown quietly in the status bar)
is something an operator checks on their own initiative via the reachable
`ConflictList` (`src/pages/ConflictList.tsx`), never a popup or a sound.

**Recorded for plan 09:** `code_registry` grows one row per code ever
accepted and is unpartitioned, so it becomes as large as `codes` without
sharing its retention story. Scoping it per shift instead was considered and
rejected: because a KM identifies one physical item, the same code scanned
under two different shifts is still the same real duplicate and a genuine
error worth catching — a per-shift registry would stop seeing that class of
conflict entirely. Plan 09 inherits this trade-off rather than re-deriving
it.

## Aggregation: boxes

Slice 06c lets a shift in `aggregation` mode group scanned items into
transport boxes identified by an SSCC, print and optionally verify the
label, and have the server record the box hierarchy.

- **Aggregation follows ownership.** 06b's rule — the earliest `scanned_at`
  owns a code — does not stop at cross-terminal conflicts: a box only ever
  counts the items its own scan still owns. `box-membership.ts`'s
  `displacedHashes` (server) marks a box item `displacedAt` the instant
  ingest discovers its code's ownership belongs to a different scan, in
  either direction — this batch's own box losing a code it just boxed, or an
  incumbent recorded in some earlier batch's box losing to this one. The item
  is marked, never deleted: it is the only evidence that two terminals boxed
  what is physically one item, and `BoxesService.listBoxes`
  (`apps/api/src/modules/boxes/boxes.service.ts`) counts a box's `itemCount`
  with `displaced_at IS NULL`, so a displaced item silently stops counting
  without ever disappearing from the row.
- **The issuer prefix, not the issuer's GLN, is the number space's identity.**
  A GS1 member commonly holds several 13-digit GLNs that differ only in their
  location digits and share the same first 9 — `deriveIssuerPrefix`
  (`apps/api/src/modules/sscc/sscc.service.ts`) always takes exactly those 9,
  and `sscc_counters`/`sscc_blocks` (`packages/db/src/schema/platform.ts`) are
  keyed on the prefix, never the GLN. Keying on the GLN instead would give
  two GLNs under one member their own independent counters, and two counters
  both handing out serial 100 under the same prefix produces the identical
  SSCC — exactly the collision one-statement allocation exists to prevent. A
  shift's issuer is `ssccIssuerCounterpartyId`, chosen explicitly in the
  admin shift form — a deliberately different question from `counterpartyId`
  (who the goods are for): packing for a client under one's own SSCCs is
  ordinary, and inferring one field from the other would silently produce a
  wrong number, caught only at the recipient's goods-in.
- **Extension digit 0 is boxes; 1 is reserved for pallets (06d)** — see
  `sscc-pool.ts`'s doc comment. `sscc_counters` is keyed
  `(tenant, issuer_prefix, extension_digit)`; its `nextSerial` is what an
  administrator seeds when migrating off another system that already issued
  SSCCs under the same prefix, so a fresh Markiro counter never repeats a
  serial that system already handed out.
- **Allocation is one statement on both sides, never a read then a write.**
  Server-side, `SsccService.allocate` upserts `sscc_counters.nextSerial` and
  inserts the `sscc_blocks` row in one transaction. Device-side,
  `sscc-pool.ts`'s `burnSerial` is a single `UPDATE ... RETURNING` — necessary
  because `tauri-plugin-sql` hands out pooled connections per call, so a
  SELECT followed by an UPDATE could hand two callers the same serial, and
  two boxes sharing one SSCC is the one failure the server cannot repair. The
  device holds its pool keyed by `(issuerPrefix, extensionDigit)`, one row
  per range received.
- **The bundle allocates a fresh block only when the device holds none for
  that issuer/extension-digit pair** — `SsccService.allocateForBundle` hands
  back the device's existing block's _original_ bounds plus its
  consumed-through cursor on a repeat fetch, not a new block on every shift
  entry, re-entry or app restart (which would burn through a
  10-million-serial space in a few thousand fetches). **The shift bundle is
  the only channel that actually supplies SSCC blocks today.** The sync
  response's `ssccBlock` field (`sync.ts`'s `isBatchSsccBlock`) and
  `SyncState.serialsLeft` are built and tested device-side, but there is no
  server-side counterpart: `station-scans/dto.ts`'s `SyncBatchResponseDto`
  carries no `ssccBlock`, `syncBatchSchema` accepts no `serialsLeft` from the
  device, and neither ingest return site emits a top-up. That device-side
  code is forward-compatible plumbing for a later slice, not a delivered
  feature — a device that exhausts its 2000-serial block mid-shift has no
  server-pushed recovery today. What actually recovers it: **re-entering the
  shift**, which re-fetches the bundle and, thanks to the original-bounds
  fix above, is now a safe, idempotent way to top up the pool without
  reissuing anything. Both `sscc-pool.ts`'s `addRange` call sites (the
  bundle's and the sync response's) feed the same idempotent, cursor-aware
  upsert (primary key on `(issuer_prefix, extension_digit, from_serial)`,
  `next_serial = MAX(...)`), so whichever channel eventually delivers a
  top-up, a replay can never double the pool or reissue a serial.
- **The serial is assigned at close, not at open.** `close-box.ts`'s
  `closeCurrentBox` burns a serial and builds the SSCC only when the operator
  closes a box that actually has items; an empty box costs nothing, and an
  exhausted pool (`no-serials`) blocks _closing_, never scanning — items keep
  landing in the open box regardless of whether a serial is currently
  available to close it with.
- **A box row is created by its first item, not by its closure.**
  `station-scans.service.ts`'s ingest upserts a `boxes` row
  (`ON CONFLICT DO NOTHING` on `boxes_device_box_uq`) the moment a batch
  carries an item naming a box the server hasn't seen yet; the closure, which
  can arrive in a batch of its own well after the last item drained, only
  ever UPDATEs a row that must already exist. Items are queued ahead of the
  closure and the drain is sequential, so no buffering or out-of-order
  handling is needed for this to hold.
- **Closures are identified by all four of `(tenant, shiftId, terminalId,
deviceBoxId)`** — a bare `deviceBoxId` string is not unique across
  terminals (two terminals can both call a box `"b1"`), and an earlier
  version that matched on fewer columns collided fatally in exactly that
  case. `boxes_device_box_uq` is declared `UNIQUE NULLS NOT DISTINCT` (not a
  plain `UNIQUE`) for the same reason `terminalId` is nullable at all: a
  plain unique index treats every NULL as distinct from every other, so two
  null-terminal boxes in the same shift would never collide in the conflict
  arbiter, scattering one physical box's items across several rows and later
  raising `boxes_tenant_sscc_uq` when a closure tried to write the same sscc
  to more than one of them.
- **`(00)` exists only in the printer emitter.** `box-label.ts`'s
  `boxLabelFields` carries the bare 18-digit SSCC; `zpl.ts`'s
  `renderBarcodeElement` is the one place that prepends the GS1-128
  application identifier, and only for a `code128` element bound to the
  `sscc` field. Storage and transport — `boxes.sscc`, `boxes_mirror.sscc`,
  the sync payload — never carry it; adding it there, or forgetting it in the
  emitter, are both silent failures with no test short of scanning a real
  printed label (see `docs/hardware-acceptance-checklist.md`).
- **Print verification is the one deliberate exception to "nothing competes
  with a scan verdict."** Opt-in per workstation
  (`hardware_config.verifyPrintedLabel`, off by default), it takes over the
  scan source the instant a box closes and prints: `PrintVerification`
  (`apps/station/src/ui/PrintVerification.tsx`) always offers an exit — a
  mismatched or unreadable scan offers Reprint, a disconnected scanner or a
  ruined label offers Skip — and neither button is ever disabled. A skip is
  recorded (`boxes_mirror.print_skipped_at`), never silently dropped, the
  same way a verified match is (`print_verified_at`).
- **A print-verification outcome can resolve after its box's closure has
  already synced and been acknowledged** — a box is typically acked within
  seconds of closing, well before an operator usually resolves the prompt.
  `markPrintVerified`/`markPrintSkipped` (`boxes.ts`) write the outcome and
  clear that box's `acked_at` in the same statement, which forces exactly
  this box's closure back through the sync engine's boxes-only path on the
  next drain. That resend's batch id must differ from the original send's:
  the server's idempotency guard (`sync_batches`) treats a repeated batch id
  as an already-applied no-op and would silently swallow the resolved
  outcome otherwise. `sync.ts`'s batch-id construction appends
  `printVerifiedAt ?? printSkippedAt ?? ""` to the boxes-only key precisely
  so a resend carrying a newly-resolved outcome gets a distinct id, while two
  resends carrying the _same_ already-resolved outcome still collide on
  purpose (a genuine retry with nothing new, which should keep benefiting
  from the server's idempotency).
- **The cabinet's box list** (`GET /boxes`, `BoxesController`) excludes
  displaced items from `itemCount` (see above) and is guarded by
  `SessionOnlyGuard` alongside `TenantGuard` — a station's device api-key
  resolves a tenant but may not browse another terminal's boxes, the same
  pattern `conflicts.controller.ts` uses.

**Recorded for plan 09 or a later slice, not built here:** `sscc_counters`
and `sscc_blocks` grow without an established retention story, the same gap
`code_registry` already carries (see "Cross-terminal conflicts" above).
Pallets (06d) reuse extension digit 1 and are unblocked by this slice.

## Hardware

`src/lib/hardware.ts` defines `HardwareContract` — scanner and printer
operations shaped like the idento agent's contract, so an external agent
process can provide it later without the UI knowing which implementation is
behind it. Today it is backed by Tauri commands
(`src-tauri/src/scanner.rs`, `printer.rs`); label bytes cross the Tauri IPC
boundary base64-encoded, since that boundary is JSON. Printing transport is
serial and TCP:9100 only — USB/spooler printing was deliberately deferred.
`WorkstationSetup` (`src/pages/WorkstationSetup.tsx`) is where an operator
picks the scanner/printer and proves both work with a test scan and a test
print, and sets the sound level.

Everything about this slice that real hardware — not CI — must confirm is
consolidated in
[`docs/hardware-acceptance-checklist.md`](../../docs/hardware-acceptance-checklist.md).

## Workstation configuration

`WorkstationSetup` persists everything an operator configures once into a
single `hardware_config` entry in `station_meta`
(`src/lib/hardware-config.ts`): the scanner's serial port and baud, the
printer target (serial port + its own baud, or TCP host:port), and the
printer's command language (`zpl` | `tspl`). The serial printer's baud is
independent of the scanner's — they are two separate serial devices, and
nothing ties their rates together.

### Printing renders in the configured language, not the template's

A label template's `spec` is language-neutral geometry; `generateZpl` and
`generateTspl` (`@markiro/domain`) both consume the same spec. The station
never calls either emitter directly for a real print — `renderLabelBytes`
(`src/lib/print-label.ts`) picks the emitter from
`hardware_config.printerLanguage`, i.e. the workstation's own configuration,
and ignores the template's `language` field entirely. That field only
decides what the admin editor previews and downloads. This is deliberate: it
lets a plant run mixed printers off one set of templates, and it means a ZPL
template prints correctly on a TSPL printer (and vice versa) as long as the
workstation is configured for whatever printer is actually attached.
Re-deriving the emitter from the template's `language` instead of the
workstation's configured one is the most likely way this gets
re-implemented wrongly later.

### Scanner: three honest states, generation-counted sessions

The status bar's scanner indicator (`scannerIndicator` in `src/App.tsx`)
shows one of three states:

- `"keyboard"` — no serial scanner is configured; the keyboard-wedge source
  is the default and needs no configuration, but it also can't be detected,
  so this is a statement of "nothing to check", not a claim that a scanner
  is present.
- `"connected"` — a serial scanner is configured **and** the Rust
  `station://scanner-status` event most recently said `"connected"`.
- `"disconnected"` — a serial scanner is configured but the event has said
  anything else, or hasn't arrived yet.

With a scanner configured, only an explicit `"connected"` event counts as
connected. A React effect manages the scanner session lifecycle, keyed on
`hardwareConfig.scanner?.port`, `?.baud`, and a `sessionEpoch` counter: it
resets `scannerStatus` to `null` and closes the previous session before
opening the newly configured one, ensuring a scanner that never actually
opened cannot keep showing a stale `"connected"` left over from whatever
was configured before. The `scannerIndicator` function (exported from
`src/App.tsx`, not a component — it renders nothing itself) reads this
status to show the three states. A green light for a scanner that never
opened is exactly the failure this exists to prevent: an operator scans
into what they believe is a working line and nothing happens.

`sessionEpoch` is bumped whenever the operator leaves the setup screen, via
either Done or Back, which re-runs the effect and closes-then-reopens the
session even when `hardwareConfig.scanner`'s port/baud come out unchanged.
This matters because the effect's dependency array alone cannot see the
difference: the setup screen's own "Connect scanner" button can leave a
different, unsaved port open (a manual test-connect, or a failed attempt
at a nonexistent port), and that session — not the persisted configuration
— is whatever the station is left running when the operator leaves.
Without the epoch bump, pressing Done on an unchanged configuration would
never re-run the effect and would leave the station stuck on that session
until the app is restarted.

Sessions themselves (`src-tauri/src/scanner.rs`) are tracked with a
monotonic generation counter. `open_scanner` opens the port first — with a
bounded retry (`OPEN_ATTEMPTS` × `OPEN_RETRY_DELAY`, roughly a second total,
absorbing the OS's port-busy window right after a close) — so a failed open
never retires a working session: the previous session's thread, port handle
and "connected" status all stay untouched until a new open actually
succeeds. Only once the open succeeds does the generation advance; only
then is the new reader thread spawned, so the previous reader thread (still
running under the old generation) sees the newer generation and exits.

### Operator roster: atomic publish via two alternating slots

`replaceOperatorsMirror` (`src/lib/mirror.ts`) publishes an incoming roster
into whichever of `operators_mirror` / `operators_mirror_b` is currently
INACTIVE — named by `station_meta.operators_slot` — and only once every row
has landed does it flip `operators_slot` to point at the slot it just
filled: a single `INSERT ... ON CONFLICT` statement, the only unit of
atomicity `tauri-plugin-sql`'s pooled connections actually give us. A
refresh that fails partway is therefore never visible: sign-in keeps
reading the last complete roster instead of a half-written one. A
generation column on a single table cannot do this: writing a new
generation means upserting each operator's existing row in place, which
moves that row out of the still-active generation the moment it's
rewritten, so an interrupted refresh would drop exactly the operators it
had already processed. Two alternating tables have no such window — the
live table is never touched until the new one is complete. Refreshes are
serialized through a promise chain (`refreshChain`) so two overlapping
syncs (the initial roster pull, the `online` retry, and a shift bundle
download can all trigger one) can never both resolve the same inactive slot
as their target.

The read side needs the same discipline. `readOperatorsMirror` resolves
which slot is active and reads that slot's rows in a **single SQL
statement** (a `UNION ALL` gated on `station_meta.operators_slot` in a
correlated subquery), not a pointer lookup followed by a separate row query.
The two-query shape has a JS gap between resolving the pointer and reading
the rows, and a publish's flip can land in that gap: a sign-in that resolved
slot "a" before the flip would then read table "a" after it, which by
construction still holds the previous generation — an operator just removed
or deactivated server-side would authenticate anyway. A single statement
closes that gap because SQLite evaluates it against one consistent snapshot,
so the pointer and the rows it names can never come from two different
publishes.

See [`docs/device-key-surface.md`](../../docs/device-key-surface.md) for
what a station's device api-key may reach on the server.

## Tests

### Manual beta updates

The station update center is manual-only. It highlights releases older than 7
days (urgent after 30 days), never downloads or installs in the background, and
blocks installation during an active shift. Review
[`docs/runbooks/station-beta-release.md`](../../docs/runbooks/station-beta-release.md)
before installing a Windows artifact. Pending outbox data remains local across
an update and restart.

```bash
pnpm --filter @markiro/station test    # vitest (jsdom); uses node:sqlite
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```
