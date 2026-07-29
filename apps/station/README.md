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

1. In the admin panel, create a station device (`POST /station-devices`) and
   copy the one-time api-key.
2. Launch the station, enter the server URL + api-key on the enrollment screen.
3. The station probes `GET /shifts` (200 = the key resolves a tenant), persists
   the config, and routes to operator sign-in (`OperatorLogin`) — not
   directly to shift selection, since an operator still has to authenticate
   locally by PIN/badge first.

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

```bash
pnpm --filter @markiro/station test    # vitest (jsdom); uses node:sqlite
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```
