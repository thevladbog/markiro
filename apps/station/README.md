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
  event row to `scan_events_mirror` second. These are deliberately two
  independent statements, not one transaction: `tauri-plugin-sql` hands a
  possibly different pooled connection to every call, so a `BEGIN` on one
  call and a `COMMIT` on another are not actually one transaction, and can
  fail outright under real overlapping DB work. Instead, `codes_mirror`'s
  `PRIMARY KEY` on `code_hash` is the real backstop: a constraint violation
  on the code insert **is** the duplicate verdict (reported back as
  `alreadyPresent`), not a write failure. The event row is always appended
  regardless, and records the verdict the operator actually saw — journalled
  as `"duplicate"` when the code insert hit `alreadyPresent`, even if the
  caller predicted `"ok"`. Failure semantics: if the event write fails after
  the code row already landed, the code stays accepted without its audit
  row — deliberately preferred over losing the code itself.
- **Signal** (`src/lib/signal-sound.ts` + `src/ui/SignalOverlay.tsx`): the
  verdict drives a full-screen colored flash plus a tone synthesised with
  WebAudio (no audio assets, nothing fetched from a CDN). Mute and volume
  are persisted in `station_meta` (`loadSoundSettings`/`saveSoundSettings`).

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
