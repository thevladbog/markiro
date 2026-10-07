# Standalone agent instructions

These instructions supplement the [root AGENTS.md](../../AGENTS.md) for
`apps/standalone`, the cloud-less product described in
[the design](../../docs/superpowers/specs/2026-09-26-standalone-station-design.md)
and [stage 1](../../docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md).

## Layout

- `host/` — `markiro-host`, the LAN service: HTTPS on port 45710 and the
  master SQLite; migrations in `host/migrations`.
- `src-tauri/` — the station and office shell; the local SQLite and every
  network call to the host live here.
- `proto/` — wire types (serde) and JSON fixtures; `src/host/protocol.ts`
  mirrors them with Zod.
- `src/` — the React webview.

## Single site, no tenants

One installation serves one site. Schemas have no `tenant_id`, so the root
rule about composite tenant keys does not apply here; isolation is the
separate installation.

## Three identities

Office users (login and password, a session bound to a device), operators
(PIN and badge, verified on the device) and devices (a per-device key) never
grant each other's rights. A device key alone never opens office routes.

## Local pairing trust

`POST /v1/local-pair` and `POST /v1/bootstrap` accept only loopback peers, and
loopback is their only gate: any process on the host PC can pair a device.
That is acceptable because the host PC is the site's trusted machine; the
app pins the certificate it observed over loopback.
Devices on the network pair only with a one-time code. An administrator creates
it (`POST /v1/office/pairing-codes`); it lives 10 minutes, is stored as a hash,
is claimed once (`POST /v1/pairing/claim`, 10 attempts a minute per address)
and dies after 5 failed claims — a wrong code counts against every live code,
since the hash cannot tell which one was meant. The answer carries the code's
`id` and `createdAt`. «Новый код» sends the previous `id` as `{ replaces }`,
and a live code the same administrator created then expires at once: a claim
with it answers `pairing_code_expired`. A `replaces` that names anything else
— another administrator's code, an unknown, used, expired or exhausted one —
is ignored, and the new code is issued anyway. A request without `Content-Type`
has no body (axum treats it as none even if bytes are sent), so a `replaces`
sent without the header is ignored, not refused. The claiming device pins the
fingerprint from the scanned payload, or one a person compared with the office
screen: `host_claim` refuses a malformed fingerprint (`invalid_request`) and a
code that cannot be a code (`pairing_code_invalid`, checked with
`markiro_proto::pairing::normalize`, so a code of the wrong length or with a
symbol outside the alphabet never reaches the host) before any I/O, observes
`hello` and stops unless the observed fingerprint equals the confirmed one, and
sends the canonical code only through a client that pins it. A refused claim
comes back as `pairing_code_invalid`, `pairing_code_expired` or `rate_limited`;
anything else is `pair_rejected`.

The webview checks a typed code with `normalizePairingCode` and reads the
office's DataMatrix payload with `parsePairingPayload`
(`src/host/pairing-code.ts`), including a payload a keyboard-wedge scanner
typed under the Russian layout. `normalizePairingCode` is
`markiro_proto::pairing::normalize` rewritten: `proto/fixtures/pairing-codes.json`
holds the cases both must answer alike, and the Rust and Vitest suites check
every one, so changing either rule means changing the fixture.

Pairing with a host in the network (`src/app/NetworkPairing.tsx`) sends
the code only to a confirmed host: a scanned payload is probed on every
address at once (`findHost`), and the code goes only to the address whose
certificate matches `f`; a typed address and code show the observed
fingerprint (`formatFingerprint`) and send the code only after a person
confirmed it against the office screen. A code that cannot be a code never
leaves the device, and a refused claim is never retried on its own — nor
sent again from the same screen: the screen remembers a code the host
already refused there and repeats the same refusal for it without probing
or claiming again. A typed code in Cyrillic is refused with a hint to
switch the layout, not read by key position like a scan: a Cyrillic letter
typed for its Latin look-alike would become another valid symbol. A typed
address's Cyrillic characters are read by key position under the Russian
layout, and everything else is kept — nothing counts against an address and
the fingerprint is confirmed — and a comma reads as a dot (the keypad's
decimal key).

## Audit

Every office change, login outcome, pairing and initialization writes one
`audit_log` row. Action names come only from `audit::actions`; a new writer
adds its name there. Every `denied` row carries `details.reason` from
`audit::reasons`. An update row carries `details.changed` (field names) and
`{ from, to }` for each changed field (`audit::update_details`), except `pinPhc`
and a template's `spec`: they are named in `changed` without a value
(`audit::update_details_hiding`), a hash because it is a secret and a layout
because it may be 256 KB.
Details never hold pairing codes, keys, tokens, passwords, salts or hashes, and
a refused login never records the typed login. An attempt refused by a rate
limiter writes no row, so a flood cannot fill the log. An office write the host
refuses (`validation_failed`, `forbidden`, `not_found`, `stale_revision`,
`conflict`) changed nothing and writes no row either, as for every office
writer since plan 1b1: the `denied` rows are refused sign-ins, password
changes and pairing claims. `office_user.password` covers
both an administrator's reset and a user's own change (`actor_id ==
target_id`). Tests assert the exact actor, action, target, result and parsed
details.

## Databases

DDL lives only in `host/migrations` and `src-tauri/migrations`. An applied
migration is never edited — add a new one; sqlx verifies checksums at start.

## Local database

`src-tauri/src/local_db.rs` keeps `standalone-station.db` in the app's local
data directory, next to `device.json`: WAL, `synchronous=FULL`, foreign
keys, a 5 s busy timeout, migrations in `src-tauri/migrations`. The webview
reads it with `local_query` — one `SELECT` or `WITH` statement on read-only
connections, rows as objects keyed by column name — and writes it only with
`local_transaction`: up to 32 statements of at most 64 KB and 256 values
each, run in one `BEGIN IMMEDIATE` transaction on the single writer
connection and rolled back whole on any error or `expectedChanges`
mismatch. `changes`/`expectedChanges` are meaningful only for `INSERT`,
`UPDATE`, `DELETE` and `REPLACE`: SQLite does not reset its changed-row
count for a non-writing statement, so a `SELECT` in a batch reports the
connection's last real write count, not zero. Statements carry literals as
parameters (no `;`, `--` or `/*`), never control transactions, connections
or the schema (`BEGIN`, `END`, `PRAGMA`, `ATTACH`, `CREATE`, `DROP`, `ALTER`,
`ANALYZE`, …; a statement may not start with `END`, since SQLite treats it
as `COMMIT`, but `CASE … END` mid-statement is unaffected) and never read
BLOBs. A large reference page goes in as one JSON parameter per entity
through `json_each`, so the limits bound SQL, not rows, and never the size
of one value: a feed revision larger than a page's 1 MiB (a template delete
that clears thousands of products, or a wizard request near axum's default
2 MiB body limit; the app's own stock templates take about 31 KB) comes as a
parameter of up to several MiB and passes whole (`tests/local_db.rs` pins it).
Rejections are bare codes: `local_db_unavailable` (the database did not
open; the app starts anyway), `invalid_statement`, `unsupported_value`,
`statement_failed`, `changes_mismatch`.

A forget (`clear_copies`) empties every table, `floor_sign_in_failures`
included, so it resets every lockout counter of the station and of its
operators, and a station on the host's PC re-pairs itself. Whoever can reach
a «Подключить заново» or «Сбросить подключение» control (the
device-rejected, other-host and config-error screens) therefore wipes the
counts; those screens are not reachable from a working floor (they come only
when the host refused the device or its config is unreadable), and kiosk mode
(plan 1f2, see "App shell") leaves them reachable on purpose.

The webview reaches it only through `LocalExecutor` (`src/local/executor.ts`);
Vitest runs the same migrations on node:sqlite behind the same interface
(`test/support/local-db.ts`), so SQL in tests never drifts from the schema.
That file also mirrors `local_db.rs`'s statement rules and limits; a rule
change there means updating `test/support/local-db.ts` too and adding a case
to `src-tauri/tests/fixtures/local-sql.json`.

The catalog's copies come from `src-tauri/migrations/0004_catalog.sql`:
`ref_products`, `ref_templates` (the layout as JSON text, the categories as a
JSON array, NULL for every category) and `ref_template_defaults` (keyed
`<code>:<purpose>`, as the feed keys them), and the organization's three
default templates as columns of `ref_org`. They keep the feed's flags
(`archived`, `enabled`, `status`) and filter nothing: the station chooses
among them later (plan 2a). They have no foreign key and no uniqueness
besides the key, for the reasons the migration gives, and because an archived
product keeps a GTIN that a product in use may hold too; `ref_products_gtin14`
is a plain index for plan 2a's lookup of a scanned product. `0001`'s header
still says products and templates «join with plans 1d and 1e», which `0004`
did; an applied migration is never edited.

`device_forget` clears the local copies before it removes `device.json`:
`LocalDb::clear_copies` deletes every row of every table but
`_sqlx_migrations`, in one writer transaction with foreign keys checked at
the commit. The tables come from `pragma_table_list` (`type IN ('table',
'virtual')`), so one a later migration adds is covered, PIN and badge hashes
included (`ref_operators`, `ref_operator_badges`). The writer runs with
`secure_delete`, so a deleted row is zeroed where it stood, and the clear
ends with `wal_checkpoint(TRUNCATE)`, which moves those pages into the file
and empties the WAL that still held the frames written before the delete:
no hash of the old pairing stays in either file (`VACUUM` would only shrink
the file). That is true of the two files only: the checkpoint, and the
removal of an unopened database, free blocks without overwriting them; the
file system's free space, SSD wear levelling and shadow copies or backups can
keep old bytes (a 4–6-digit PBKDF2 PIN is cheap to brute-force); and bytes a
writer freed before it ran with `secure_delete` (a development database from
before that setting) are not scrubbed, so for that database `VACUUM` would do
more than shrink the file, and nothing here runs it. A reader holding an
older snapshot keeps the checkpoint from finishing, and the call then fails;
the delete stays committed and a retry repeats only the checkpoint. A local
database that did not open is removed instead, with its `-wal`, `-shm` and
`-journal` files (`LocalDbState::remove_unopened`), since it may still hold
hashes. Every table here is disposable: the copies of the host's data, and
`floor_sign_in_failures` (`src-tauri/migrations/0005_floor_sign_in_failures.sql`,
plan 1f), this device's own failed sign-ins. A forget clears that table with
the copies on purpose (a new pairing brings a new roster), and
`tests/local_db.rs` pins it; the sync's wipe for another pairing leaves it
alone on purpose, because it is no copy of the host's data and a wipe is no
sign-in. That half holds by construction (`WIPE` in
`src/local/reference-sync.ts` names only the copies, the quarantine and
`sync_state`); no test pins it. The first plan that adds data this device
must keep — the scan journal, boxes, the outbox (the design's §6.2,
"Логическая модель") — must exclude those tables from `clear_copies`, keep
`remove_unopened` from deleting them, and block or confirm a forget while
unsynced records exist, not extend this list silently. If clearing or
removing fails, the command fails with `storage` and the pairing stays for
another try.

## Writes

- Every multi-statement write uses `db::begin_write` (`BEGIN IMMEDIATE`), not a
  deferred `pool.begin()`: a deferred transaction that reads then writes can
  hit `SQLITE_BUSY` on a stale WAL snapshot before `busy_timeout` gets a
  chance to help.
- One `next_revision` per changing transaction, stamped on every row that
  transaction changes. A device's line change is the one revision with no
  row to stamp: devices have no `rev` column and are not feed data, so
  `PUT /v1/office/devices/{id}` takes a revision only to wake the streams,
  and only when the line really changes.
- A transaction that called `next_revision` commits through
  `db::commit_with_revision`, which wakes change-stream subscribers only
  after the commit: a device that reacts at once already reads the new rows.
  The commit and the notification are one uncancellable unit: both run in one
  spawned task (`db::commit_and_notify`, which `commit_with_revision` wraps),
  because hyper drops a handler's future when the client hangs up, and a drop
  between COMMIT and the notification would land the write without its
  wake-up, leaving a station on a deactivated operator or a revoked badge
  until some later commit. A writer never `.await`s between the commit and
  the notification, and never announces a revision from a drop guard: a guard
  could announce a rolled-back revision, and `rev > latest` would then
  suppress the real commit that reuses that number. A device revocation
  commits through `commit_and_notify` too (its wake-up is
  `AppState::revocations`), and revoking an already revoked device wakes the
  streams once more, which recovers a wake-up an earlier attempt lost.
- Never touch `state.pool` while a write transaction is open. Read through
  the transaction (`&mut *tx`) instead of acquiring a second pooled
  connection: the pool has only 4 connections, and a second acquire can wait
  behind another writer's `busy_timeout` instead of returning at once.
- Hash passwords (PBKDF2) before `begin_write`, off the async runtime: inside
  a handler, with `secrets::hash_password_blocking`. `change_password`'s
  verify-then-hash is one `spawn_blocking` closure of its own. Never hold the
  write lock across that work.
- Return no-ops before `next_revision`: no revision bump, no row write, no
  audit row for a request that changes nothing.
- Free text (names, roles, labels, device registration fields) is checked in
  one place, `validate.rs`: trimmed, counted in characters (not bytes), and
  refused when it holds any control character (`char::is_control`). A NUL
  is not whitespace, so `str::trim` keeps it while SQLite's `length()` stops
  at it and a table `CHECK` fails (a 500 instead of `validation_failed`); a
  control character inside a name would let two names that look identical
  both be active. The webview's forms check the same rule before sending
  (`isPlainText` and `plainTextRule` in `src/lib/rules.ts`): the office forms,
  the wizard and the device name at pairing. The trim sets of JavaScript and
  Rust differ in exactly two characters (U+0085, a NEL, is trimmed only by
  Rust; U+FEFF, a BOM, only by JavaScript), and a form is never more lenient
  than the host only because it sends the trimmed value it validated. A lone
  surrogate is refused as well: no Rust string holds one, `JSON.stringify`
  writes it as an escape serde_json rejects, and the IPC call would fail
  before the host as a lost connection. `plainTextRule`, and
  `optionalTextRule` for a role or a label that may be blank, says a wrong
  length in the field's own words and a control character or a lone
  surrogate with `rules.controlCharacter`: a tab pasted from a spreadsheet is
  invisible, and a length message would not explain it. The wizard's line
  names call `isPlainText` directly and keep their one message. Fields that
  are not free text refuse a lone surrogate themselves (`isTransferable`):
  every password (`rules.passwordCharacter`), and the sign-in's login.
- Admin writes re-check rights with `OfficeContext::require_admin_in` inside
  the transaction, in addition to the early `require_admin` rejection. The
  extractor's role and active flag are read before the request hashes a
  password; re-checking inside the transaction stops a write a demotion or
  deactivation ended in that window. Self-service writes any office user may
  make on their own record (their own password) re-check the same way with
  `OfficeContext::require_session_in` instead; admin writes keep using
  `require_admin_in`. Catalog writes — products, label templates and their
  defaults, which administrators and technologists make (spec §4.8,
  `editCatalog`) — check `require_catalog` early and `require_catalog_in`
  inside the transaction; `auth::edits_catalog` names the roles, with no
  wildcard arm, so a new role does not compile until it is placed.

## Change feed

`GET /v1/changes?since=<rev>&limit=<n>` (`routes/changes.rs`) returns the
station-visible reference records changed after a device's revision:
`org_profile`, `site` (badge salt and block sizes), `lines`, `operators`,
`operator_badges`, `products`, `label_templates`,
`category_template_defaults`, plus deletions from `tombstones`. Pages are
ordered by `(rev, entity, id)` and never split a revision; with
`hasMore = false`, `rev` is the host's current revision, so revisions that
changed only office data still move a device forward; an office line
assignment for a device is one of those (see «Device key and office
session»). A page holds at most `limit` records and ends before the
revision that would take its items past `MAX_PAGE_BYTES` (1 MiB) of JSON,
since a template's `spec` may be 256 KB; a revision larger than either
bound still comes whole when it starts the page, so the feed always moves
on.
`GET /v1/changes/stream` sends the current revision as its first event, then
an event whenever the revision grew: events are strictly increasing, so a
burst of commits collapses into one, and an event means "fetch since your
revision", not "a commit happened"; a comment heartbeat keeps the connection
alive every 15 s, and streams end when the host stops or when their device
is revoked: a revocation raises `AppState::revocations` after its commit,
and every open stream re-reads its own device then. A new feed entity
needs a branch in `FEED_KEYS` and in `record`, its proto record type, Zod
schema and fixture, a tombstone wherever it is deleted or stops granting
access, the station's local table, an index on the new table's `rev` (as
`lines_rev`), and that re-creating a key deletes its tombstone. Writers use
`feed::remove` and `feed::restore` for both.

A change that removes access rides the feed as a tombstone, never as a
flag. The records that grant access — `site`, `operators` and
`operator_badges` — are read with `z.strictObject` and format checks (a
canonical 16-byte badge salt, `canonicalSaltSchema`; a personnel number of
3–12 digits; `isPinPhc` and `isBadgePhc` in `src/lib/credentials.ts`): a
record with an unknown key, or with a salt or a hash no station could use,
fails closed into the quarantine rather than being kept, so a field a newer
host adds never just drops away on an older station. `org_profile`, `lines`
and the catalog's records (`products`, `label_templates`,
`category_template_defaults`) are read with `z.object`, which drops unknown
keys; a value this build cannot read (an unknown purpose or status, a GTIN
of other than 14 digits, a template id that is no UUID) still quarantines
the record. An operator is in the feed only while active: a deactivation
writes a tombstone for its id, and a reactivation drops the tombstone and
sends the record again with a new `rev`. A badge is in the feed only while
not revoked: a revocation writes a
tombstone, and a revoked badge never comes back — a new badge gets a new id.
A PIN change is a record update carrying the new `pinPhc`, so the station
replaces the hash and the old PIN stops working. A badge record never grants
access on its own: the station's sign-in (`src/floor/sign-in.ts`) requires the
record of its `operatorId`.

The catalog grants no access, so its flags stay flags: an archived product
and a disabled template ride the feed with `archived` and `enabled`, since a
station keeps them for history and leaves them out of its pickers. A
product is never deleted and never has a tombstone; a deleted template
leaves as one. A category default is keyed `<code>:<purpose>` (`8:box`,
`markiro_proto::category_default_id`, the same text `FEED_KEYS` builds in
SQL), and clearing it writes a tombstone of that key. The organization's
three defaults ride its record (`defaultBoxTemplateId`,
`defaultPalletTemplateId`, `defaultDuplicateTemplateId`, `null` when unset).
A template's `spec` travels as JSON, not as text. Within one revision a
deleted template's tombstone comes before the products whose defaults the
delete cleared (entities sort by name), and a template a copy refers to may
sit in the quarantine, so the station's copies take no foreign key from a
product or a default to a template.

On the device side a new entity also needs its entry in `ENTITIES`
(`src/local/reference-sync.ts`), which derives `ENTITY_SET`; a new entity
there changes `ENTITY_SET` and makes every device sync from zero once. It
also adds three statements to the worst-case page batch (see "Reference
sync"), which must stay within the shell's 32: the eight entities kept
since plan 1e2 take 30, so a ninth needs a smaller batch first.

## Operators and badges

Operators sign in on stations with a personnel number and a PIN, or with a
badge (plan 1f). The office hashes both with `@markiro/domain`, so the host
never sees a PIN or a badge code (the one field a code could reach is a
badge's label, and the add dialog guards it as described under «Бейджи» in
"Office pages"). It stores PHC strings and checks their format with
`secrets::parse_phc` — canonical base64, a 16-byte salt, a
32-byte digest and 10 000–1 000 000 iterations, since a station verifies
with the count the hash carries. A badge hash must also carry exactly the
domain's 100 000 iterations and the site's badge salt
(`GET /v1/office/badge-salt`, the same value as the `site` record's
`badgeSalt`), as the cloud hashes badges: one badge code then always gives
one string — `parse_phc` refuses a leading zero in the count, so `0100000`
is not a second spelling of `100000` — and the partial unique index
`operator_badges_active_phc` keeps it on one operator (`conflict` with
`constraint: badge` and, when the holder is found, `operatorId`, the operator
who holds it, read in the same transaction; only administrators reach the
route, and they see every operator anyway). The office never gets a hash
back: operator reads carry
`hasPin` and each badge's `id`, `label`, `createdAt` and `revokedAt`.
Revoking a badge is `DELETE …/badges/{badgeId}`, and revoking it again
changes nothing. Operators, badges and the salt are for administrators only,
reads included.

The office's side lives in `src/lib/credentials.ts`: `hashPin` takes 16
fresh random salt bytes and the domain's `PHC_ITERATIONS`, `hashBadge` the
site's salt and exactly `BADGE_ITERATIONS` (100 000, the host's
`secrets::BADGE_ITERATIONS`), both in the domain's format, standard base64
with padding; `test/credentials.test.ts` reproduces `operator-create.json`
and `badge-create.json` byte for byte. The forms' rules (`src/lib/rules.ts`)
follow the host's for a personnel number of 3–12 ASCII digits, kept as text
with its leading zeros, a role of up to 120 characters and a label of up to
100, both blank for none. The PIN rule, 4–6 ASCII digits, mirrors the
cloud's (`apps/api/src/modules/operators/dto.ts`): the host never sees a
PIN. A badge code is what a scanner types: trimmed, 1–256 printable ASCII
characters, and hashed exactly so. A keyboard-wedge scanner presses keys,
and a station types the same badge through its own layout, so a code in
Cyrillic is refused with a hint to switch the layout, never read by key
position.

A station keeps its copies in `ref_operators` and `ref_operator_badges`
(`src-tauri/migrations/0003_operators_badges.sql`), with no foreign key from
a badge to its operator — the feed keeps the badge of an operator who was
turned off, and a badge can come in a page before its operator — and no
uniqueness besides the key: the host keeps personnel numbers and active
badges unique, and a copy that refused a row would abort its whole page and
stop the sync for good.

The station's sign-in (plan 1f; `src/floor/sign-in.ts`, the screen
`src/floor/OperatorSignIn.tsx`) never calls the host. It reads these copies
only on the floor of a paired device that is not rejected, and only while
they are this pairing's copies that a sync has begun to fill (`copiesReady`:
`sync_state`'s `host_id` and `device_id` name this pairing, its `entity_set`
is this build's and a `last_rev` is there). Every applied page writes that
`last_rev`, so readiness is not completeness: a first sync interrupted after
its first page leaves partial copies that read as ready until the next run
finishes it. The hashes already on disk stay when the host revokes the
device or its certificate changes, and only a forget clears them, so such a
device keeps showing no floor: `nextShellView` puts the rejected-device
screen first. A record waiting in `sync_quarantine` signs nobody in,
whatever its revision (fail-closed).

- A personnel number (3–12 digits, never padded) must name exactly one copy;
  a number two copies share is refused as ambiguous, after the same one
  verification against the dummy hash. The PIN (4–6 digits) is checked with
  the domain's `verifyPhc`, which compares in constant time, at the count the
  hash carries (the sync accepted 10 000–1 000 000). Every well-formed
  attempt that is not answered by a lockout or by unready copies costs one
  full PBKDF2: an unknown number is verified against `DUMMY_PIN_PHC` (the
  domain's 100 000 iterations), so the answer's time does not tell numbers
  apart — but only when the stored hash has exactly 100 000 iterations too,
  which the office always writes; another count the host accepts takes
  another time. An existing number can still be told from an unknown one, by
  the operator's own lockout answer after five wrong PINs and by extra SQL
  round-trips (a personnel number is no secret). The operator's copy is read
  again after the verification, and a PIN change, a turn-off or a quarantine
  that landed meanwhile wins.
- A scan with a GS1 group separator (`\u001d`) is a product's code, not a
  badge; a Cyrillic one is refused with the hint to switch the layout, never
  read by key position; anything else that is not 1–256 printable ASCII
  characters after trimming (as `badgeCodeRule` trims a code) is no badge.
  None of these is hashed or counted. A badge is found by hashing the trimmed
  scan once with `ref_site.badge_salt` at exactly `BADGE_ITERATIONS` and
  comparing whole strings, and it signs in only with the record of its
  `operatorId`; a badge that matches more than one operator is refused as
  ambiguous, never resolved to the first.
- Lockouts live in `floor_sign_in_failures` (`src/floor/lockout.ts`), so a
  restart does not reset them. Ten failures on the station
  (`STATION_LOCKOUT`; wrong PINs, unknown numbers and unknown badges alike)
  pause every sign-in for one minute, and five wrong PINs for one operator
  (`OPERATOR_LOCKOUT`) lock that operator's PIN for five minutes; the
  operator's badge still signs them in. The station's count decays: it
  starts again from one when the failure before is older than
  `STATION_QUIET_MS` (ten minutes; exactly ten still counts), and a
  successful sign-in does NOT clear it, so someone with a valid credential
  gains no guesses; only the signed-in operator's own row is cleared. An
  operator's row does not decay: it counts until that operator signs in or a
  lockout ends it. A lockout is answered before any hashing; after one runs
  out the next failure counts as the first; a failure recorded while one
  runs is a no-op (neither the count nor the start moves). The sustained
  ceiling follows: when a station lockout ends the count restarts at one,
  with no escalation, so a patient guesser gets about ten guesses per 70
  seconds, roughly 500–600 an hour from the station alone (per-operator PIN
  guessing is further bounded at five per five minutes per operator);
  escalation is an open owner question. Time is this
  computer's clock: moved back behind a lockout's start, it starts the
  lockout again from now, never longer than its duration; moved forward, it
  shortens a lockout, and ten minutes forward between two guesses resets the
  station's count. The counter is keyed by operator id, never by a typed
  number. The lockout message names its minutes as of the attempt and is not
  refreshed until the next one.
- Attempts are serialized (`oneAtATime`): a lockout is read before an
  attempt hashes and written after it, so overlapping attempts would all pass
  the same read, and a stack of scanner codes gets no more tries than a
  keypad. An attempt that never settles (a local database call whose IPC
  never answers) holds every later attempt until the app restarts, on
  purpose: a timeout that let the next attempt in would overlap the running
  one, the very bypass the queue closes. The screen also runs one check at a
  time (a scan during a check, or a second press, is dropped) and drops an
  answer that lands after it was unmounted or after the pairing or the line
  changed; `App` keys it by `hostId:deviceId:lineId`, so a number or PIN typed
  under another pairing or line is not kept. «Офис» stays enabled during a
  check (the keypad and «Назад» do not), so a check that never settles does
  not trap the station on the screen; leaving unmounts it, and its answer is
  dropped. The leave notice (idle, removed, line changed) stays until the
  first attempt, which dismisses it for good.
- A refusal `wrong` (an unknown credential, a wrong PIN, a copy that changed
  under the check) or `not_ready` asks for a reference sync (the cloud
  station refreshes its roster before refusing); the next attempt reads what
  it brought. The asks go through a gate in `App` (`SIGN_IN_SYNC_GAP_MS`,
  2 s: the first at once, asks inside the wait fold into one more sync at its
  end), so a burst of stray scans does not hammer the host.
- The name search (plan 1f2; «Найти себя по имени»,
  `src/floor/operator-search.ts`) only fills in a personnel number: the PIN
  is then checked by `signInWithPin` like a typed one, under the same
  lockouts, and «Назад» on the PIN goes back to the search. It reads
  `readOperatorRoster` (`src/floor/sign-in.ts`: this pairing's copies once
  `copiesReady`, none waiting in quarantine, id, personnel number and name
  only, never a hash) when the step opens and after every sync, and offers
  nothing until the query has two letters (any alphabet; digits and spaces
  do not count), and then at most five names, by name and then id, each with
  its personnel number so that two operators with one name are told apart.
  An operator whose number the keypad could not type (3–12 digits) is never
  offered. While the name field has the focus, the keyboard-wedge source takes
  no scan (`setManualTextEntryActive`, which also drops the keys typed so
  far): typed letters and their Enter stay the field's, and a badge scanned
  into the field signs nobody in. The scanner is given back when the field
  loses the focus and by a cleanup tied to the field's presence in
  `OperatorSignIn` (a layout effect on whether the field is shown), so a
  field that disappears without a blur (a sync turned the step into a notice,
  the screen left, a name was chosen) cannot leave the scanner deaf;
  `toStage` only drops the pending keys.
- The signed-in operator lives only in the shell's memory
  (`ShellState.operator`): identity, never a hash. The reducer stores a fresh
  object per sign-in, and the sign-out callbacks (the idle timer, the check
  after a sync, «Сменить оператора») are bound to that stored object, so a
  late timer of an earlier session of the same operator cannot end the next
  one. The session ends when the office opens (any way in,
  the bootstrap wizard's too), on a new pairing, a forget, a rejected device,
  another host, a change of the station's line, and on any host probe
  (`host_probed`, which runs only at start-up, on a retry and after a forget:
  a blocked version screen never leaves a session behind); and by
  «Сменить оператора», after ten minutes without a touch
  (`OPERATOR_IDLE_TIMEOUT_MS`, the cloud station's) and after a sync that
  leaves the operator out of the copies (the host turned them off, or their
  record waits in quarantine). That check fails open: an unreadable or
  unready copy signs nobody out, so a removed operator stays signed in until
  the next successful sync reads the copies. The link going down signs
  nobody out: the floor works offline. `operator_signed_in` carries the
  device id, the line id the check began on and the address; the reducer
  refuses it when the device or the line differs, the view is not a floor, an
  operator is signed in already, the device is rejected or on another host
  or the office is open, so a late answer signs nobody in. What an operator
  may do on the line is plan 2a's; stage 1 shows a stub, which shows the name
  and role as of sign-in (a later sync that changes them is not reflected;
  plan 2a refreshes them together with an explicit session counter).

The precondition plan 1d4 named holds: the sync's guard is scoped to the
pairing (`pairingGuard`, see «Reference sync»), so a page fetched before a
`device_forget` cannot land after a re-pair to the same host and bring back a
record a tombstone deleted.

Not verified, and open. No real window ran any of it: Windows,
WebView2/Tauri, a keyboard-wedge scanner under RU and EN layouts and Caps
Lock, PBKDF2 time on a factory PC and the touch layout wait for a manual
check. The wedge source (`src/floor/scan-source.ts`) calls `preventDefault`
on every Enter, so a keyboard user cannot press Enter on a focused button
(Space works). It reads Ctrl+] as the GS separator (so a product's code is
refused as one) and drops every other key held with Ctrl or Meta, but keeps
what AltGr types, which Windows reports as Ctrl+Alt. It has no timing
threshold between a scan and typing, and what `key` a real wedge scanner
produces for GS (Ctrl+] in WebView2) is unverified. An owner decision is
open: nothing tells a stray product barcode (an EAN-13, a single-AI SSCC)
from a badge typed by hand, so ten of them pause the station for a minute
(`test/operator-sign-in.test.tsx` documents it); the lockout numbers are the
plan's proposal too. Every button of the sign-in screen, «Офис» and
«Повторить» included, is the floor's 64 px (`size="floor"`), and
`test/operator-sign-in.test.tsx` checks every step. Real focus and blur of a
physical wedge scanner in WebView2, and how the search step and the status
bar lay out on a real screen and touch panel, are unverified (the styles were
not looked at in a browser). Kiosk mode and the floor's status bar are under
"App shell".

## Catalog and label templates

The ЧЗ product groups are the cloud's static lookup: host migration `0008`
copies the 51 rows of `packages/db/migrations/0099_chz_product_groups.sql`.
`host/tests/product_groups.rs` compares the host's rows with that file and
fails when any other cloud migration writes the table, so a cloud migration
that changes the lookup cannot go unnoticed once the standalone jobs run.
Those jobs run when standalone files or the shared domain or ui packages
change; a cloud-only change does not schedule them (`tools/ci/affected.mjs`
sends `packages/db/**` to the station and cloud jobs, not to the standalone
ones), so the guard fires at the next standalone run. Every office role reads
the groups (`GET /v1/office/product-groups`, by code); nothing writes them,
and they are not in the station feed.

Products (`GET/POST/PUT /v1/office/products`): every office role reads
them, archived ones included (by `archived, name, id`, bytewise on the name
itself; lines sort by a lowercased key); administrators and technologists
write them. `PUT` takes every field with `expectedRev`, as a counterparty's,
so an optional field left out is cleared (a missing `gtin14`, `name`,
`archived` or `expectedRev` is refused); archiving is `archived: true`, and a
product is never deleted. The host
checks `gtin14` for its shape only — 14 ASCII digits after trimming; the check
digit is the UI's (`normalizeToGtin14`), and the UI only compares the prefix,
for the owner hint (`gtinMatchesPrefix`) — and keeps it unique among products in
use (`products_active_gtin14`: `conflict` on `gtin14` when a product is created,
its GTIN changed or it comes back from the archive); an archived product keeps
its GTIN without reserving it. `status` is a generated column (`active` with a
product group and both capacities, `draft` before, as the cloud's
`computeStatus`) that nobody sends. A name is 1–200 characters, a
print name up to 200 or none, a box holds 1–100 000 units and a pallet
1–10 000 boxes (`MAX_BOX_CAPACITY`, `MAX_PALLET_BOX_CAPACITY`: the cloud caps
neither, so these only keep a typing slip out of production), a shelf life
is 1–3650 days (the cloud's bound), and a product group must exist. The
office's rules in `src/lib/rules.ts` mirror these before it sends (the three
caps are constants of the same names as the host's; that a product group
exists stays the host's check): a GTIN of 8, 12, 13 or 14 ASCII digits with a
valid check digit (`gtinRule`; the domain throws one `GTIN_INVALID` for a
wrong length and a wrong check digit, so the rule checks the length itself
and says each in its own words), sent as its 14 digits (`toGtin14`), and
counts typed as text and taken only as whole numbers without a sign, a
leading zero, a point or an exponent (`countRule`), blank for none. The
default box and pallet templates are preferences: the host checks that each
names a template of the slot's purpose; whether that template is enabled
and covers the product's group is the domain's rule, which the office
applies when it offers templates and the station will before it uses one
(plan 2a), so a template disabled or narrowed later never blocks editing or
archiving the product. A product form opened before its preferred template
was deleted sends the old id with the older `expectedRev`, and the answer is
`validation_failed` on `defaultBoxTemplateId` or `defaultPalletTemplateId`
(the references are checked before the revision), not `stale_revision`:
nothing is written, and the office's product dialog takes it as a stale
write: «Загрузить заново» reads the products again at once, and the
template list is read again whenever a dialog opens. The station will
choose a template by the product's preference if it still fits, then the
category's default, then the organization's, then the operator's choice
(plan 2a); the comment in migration `0008_catalog.sql` names only the
category's default and the organization's and omits the product's
preference, and an applied migration is never edited. (The
cloud has no per-product template since its 2026-09-02 spec; these follow the
stage-1 spec.) National-catalog links, photos, EGAIS
codes, prices and default counterparties are not part of the standalone
catalog yet.

Label templates (`GET/POST/PUT/DELETE /v1/office/templates`): every office
role reads them — the list as summaries without the layout, whose size,
resolution and language come from the stored `spec` as they stand (`null`
where it has nothing of the right type: a resolution counts only as an
integer that fits a `u32`, and the numbers are read as JSON text, never as
SQLite values, so one stored layout cannot make the list fail for everybody),
and `GET …/{id}` with it; administrators and technologists write them. The
host keeps `spec` a JSON object of at most 256 KB written compactly and at
most 64 levels deep (`validate::template_spec`, `MAX_SPEC_BYTES` and
`MAX_SPEC_DEPTH`; an object or an array is a level, a scalar none), its
object keys in byte order, and never checks the layout: that is
`labelTemplateSpecSchema` in the UI. The depth bound exists for the feed: a
page wraps a layout in four more levels (the page object, `items`, the item,
`data`) and the station shell parses every host answer with
`serde_json::from_slice`, which stops at 127 levels, so a layout nested 124
deep would be stored and served by `GET …/{id}` while the page that carries
it failed as `invalid_response`
and was refetched from the same revision for ever, and no later reference
change would reach any station. A name is 1–200 characters;
`chzProductGroupCodes` is `null` (every category) or 1–100 codes without
repeats, each a product group. A purpose never changes: `PUT` has no
`purpose` field, so one sent is `validation_failed`. `PUT` changes only what
it sends, with `expectedRev`, and `chzProductGroupCodes: null` widens a
template to every category. A stock template (the wizard's) keeps its name,
purpose and layout and is never deleted (`conflict` on `stock_template`);
it may be disabled or narrowed, and a copy is an ordinary `POST` of its
layout. The organization's default of a purpose stays an enabled template
for every category, and a category's default an enabled template covering
that category: a change that would break either, and any delete of a
default, is `conflict` on `template_is_default` with `organizationDefault`
and `categoryDefaults` (codes), as the cloud's `LABEL_TEMPLATE_IS_DEFAULT`.
The rule for a slot is `templates::fits`, the domain's
`isBoxLabelTemplateEligible` rewritten. The webview's `templateFitsSlot`
(`src/lib/template-eligibility.ts`) asks the domain for a box or a pallet
slot and checks a product duplicate, for which the domain has no rule, the
same way. `proto/fixtures/template-eligibility.json` holds the cases the
rules must answer alike, and `host/tests/templates.rs` and
`test/template-eligibility.test.ts` both read every one.
Deleting a template clears every product preference that names it at the
delete's revision, so those products ride the feed again, and leaves a
tombstone; a delete repeated after a lost answer finds the tombstone and
answers 204 again, and an id that never existed is `not_found`.

The defaults are one document (`GET/PUT /v1/office/template-defaults`): the
organization's default of each purpose (`defaultBoxTemplateId`,
`defaultPalletTemplateId`, `defaultDuplicateTemplateId`) and every
category's (`categories`, by code then purpose). Every role reads it;
administrators and technologists replace it whole, so an organization
default left out is none and a category default left out of `categories` is
cleared. Its `rev` is the newest revision of the organization's record, a
category default and a cleared category default's tombstone: any change of
the defaults, and any change of the organization's record, through
`PUT /v1/office/org` too, makes a write over an older `rev`
`stale_revision`. Every default must fit its slot (`templates::fits`):
`validation_failed` on `defaultBoxTemplateId` and its siblings, on
`categories.{i}.templateId`, on `categories.{i}.chzProductGroupCode` for an
unknown group, and on `categories.{i}` for a slot given twice. A change of
the organization's defaults rewrites its record at the new revision, so it
rides the feed, and a profile form's `PUT /v1/office/org` over the record's
older `rev` is `stale_revision` too (after a reload nothing visible has
changed, because `GET /v1/office/org` does not show the defaults); a
category default set, changed or cleared rides the feed under its
`<code>:<purpose>` key, a cleared one as a tombstone that setting it again
drops. An unchanged document writes nothing, and the audit row
(`template_defaults.update`, target `template_defaults`/`1`) carries the
changed parts with `{ from, to }`, `categories` as whole lists.

The wizard (`POST /v1/bootstrap`) takes the stock templates as an optional
`templates` list, so a wizard from before plan 1e3 still works: at most 32
(`MAX_STOCK_TEMPLATES`), each a name, a purpose and a layout checked as any
template's, stored enabled, for every category and `stock`, in the wizard's
one transaction, so a refusal creates nothing. The app's wizard sends them
since plan 1e3: `stockTemplates` (`src/wizard/wizard-form.ts`) builds the
domain's box, product-duplicate and pallet sets (20 templates today;
`test/wizard-form.test.ts` reads the counts from the builders and keeps the
total within `MAX_STOCK_TEMPLATES`, which `wizard-form.ts` mirrors), and the
review step says how many of each purpose it creates. `orgDefault: true` on
one template of a purpose makes it the organization's default of that purpose,
so the request names no id it does not have yet; a second of the same purpose
is `validation_failed` on `templates.{i}.orgDefault`. The wizard sets it on
the dated box 58×40 (`DEFAULT_BOX_LABEL_TEMPLATE_NAME`) and the pallet 100×150
(`PALLET_LABEL_TEMPLATE_NAME`), as the cloud seeds a new tenant, and leaves it
out everywhere else: the cloud has no duplicate default, and whether the
standalone sets one is an owner question. The whole request must stay under
axum's default 2 MiB body limit (about eight maximum-size layouts): a larger
body is `validation_failed` without `details.field`. No route-level
`DefaultBodyLimit` is set, and plan 1e3 keeps it so: the wizard's body is
about 31 KB, and `test/wizard-form.test.ts` holds it under 256 KiB, an eighth
of the limit, so only a stock set that grows toward the limit reopens the
question. The `host.bootstrap` row counts them (`templateCount`).

Plan 1e1 built the host's side and plan 1e2 the webview's: Zod schemas for
every catalog shape and a builder for every office request body of the catalog
(`test/protocol.test.ts` reads every fixture of plan 1e1,
`test/template-eligibility.test.ts` the slot rule's), the station's copies of
products, templates and category defaults («Reference sync», «Local
database») and the office's «Товары» page («Office pages»). Plan 1e3 added
the wizard's stock templates (above) and the office's «Шаблоны» and
«Умолчания шаблонов» pages («Office pages»), which call `listTemplates`,
`updateTemplate`, `getTemplateDefaults` and `updateTemplateDefaults`. Plan
1e4 added the template editor («Office pages»), which calls `getTemplate`,
`createTemplate`, `updateTemplate` with a layout and `deleteTemplate`, and
checks a layout against `labelTemplateSpecSchema` before it saves. Its second
part (1e4b) draws layouts: the editor's preview, the ZPL and TSPL downloads
and the list's thumbnails. The text rasterizer (`src/labels/rasterizer.ts`, a
port of the cloud's that must behave as it does, so a previewed template
prints the same bitmap) and the font coverage check
(`src/labels/font-coverage.ts`, with `opentype.js` 2.0.0 and the hand-written
`opentype.d.ts`) live outside the office: the station's printing (plan 2a) is
to take the rasterizer too. The domain's generators and the GS1 raster (which
bring bwip-js, about 0.9 MB) and the font check (opentype.js, about 0.2 MB)
load on demand as chunks of their own (`label-print.ts`,
`BROWSER_LABEL_RENDERING`), so the main chunk stays near 876 kB.

## Reference sync

`src/local/reference-sync.ts` keeps the local copies in step with the host
(stage 1 spec §5.4). `syncReferences` reads `sync_state` (`last_rev`,
`host_id`, `device_id`, `entity_set`) and fetches
`GET /v1/changes?since=<last_rev>` (`HostApi.getChanges`, the device key
only) until `hasMore` is false. Each
page is one `local_transaction`: a `pairingGuard` statement first (below),
then per entity one conditional delete for its tombstones and quarantined
records (only rows older than them) and one `json_each` upsert for its
accepted records (only when the revision is newer), then one quarantine
upsert, one quarantine lift and the page's revision. Every live record is
checked with its Zod schema before anything is written. A record that
fails it (damaged, or newer than this build reads) fails closed (owner
decision 2026-09-27): it is not applied, its local copy goes if the
record's revision is newer (the tombstone rule), and it waits in
`sync_quarantine` while the rest of the page applies and the revision
advances. A readable record or a tombstone at least as new lifts
the quarantine; so does a build that reads the record, since it syncs
from zero. `reason` holds Zod issue paths and codes only
(`archived: invalid_type`, at most 200 characters), never a value:
operator records carry PIN and badge hashes. That is safe only because
every record schema has fixed keys: a schema with a dynamic-key `z.record`
would put keys taken from the data into the paths. A template's layout is
therefore one opaque object (`templateSpecSchema`, one `custom` issue),
never checked at sync time: the station checks it where it prints (plan
2a). A copy's `spec` is the text `JSON.stringify` gives for the parsed
layout, which puts integer-like keys first, so it is not the host's
byte-ordered text: whatever digests a layout (plan 2a's layout snapshots)
canonicalizes it first. `seen_at` is a parameter from the webview's clock,
never SQL time. Entities this build does not keep are skipped, not
quarantined, and applying a page again changes nothing. A successful run
reports the quarantine's size
(`quarantined`). A feed that breaks its own contract (it went back twice
in one run, or claims `hasMore` without moving past the revision it was
fetched at) fails the run with `SyncFeedError`, not a silent infinite
loop.
For E kept entities a page batch holds at most 3E + 6 statements: the
guard, a deferred wipe (E copy tables, the quarantine, the sync state),
two per entity, the quarantine upsert and lift, and the sync state. That
is 30 for the eight entities kept today, the most the shell's 32 takes: a
ninth entity needs a smaller batch first. A test builds the worst-case page.
`ENTITY_SET` names the kept entities and `SYNC_SCHEMA_VERSION`
(`"org_profile,site,lines,operators,operator_badges,products,label_templates,category_template_defaults;v4"`):
raise the version whenever a record schema or the meaning of a copy table
changes, so every device syncs from zero once and gets back what an older
build quarantined or kept differently.
The upserts of operators, badges and the catalog's copies (products, label
templates and category defaults) also skip a record whose newer revision
waits in the quarantine (`notQuarantinedNewer`): the insert would otherwise
bring back what the quarantine's fail-closed delete took away, an access
for a person or an older layout or default for the catalog. The
`org_profile`, `site` and `lines` upserts have no such guard (plan 2a).
The feed never sends an older revision after a newer one; a stale run's
page could (one fetched before `device_forget` that lands after a new
pairing with the same host), and `pairingGuard` (below) stops it since plan
1f: `notQuarantinedNewer` stays as a second line of defence.
The copies, and the quarantine with them, start from zero when `sync_state`
names another pairing (another `host_id`, or another `device_id` with the
same host: the host gives every pairing a new device id), when
`entity_set` is not this build's `ENTITY_SET`, or when the feed answers
`rev < since` (the host went back to an older copy; once per run). The
last two drop the old copies in the transaction of the first new page, so
a failed fetch keeps them. Another pairing wipes at once, in the transaction
that stamps this run's pairing (`host_id` and `device_id`) before the first
fetch, since another pairing's records must not stay usable, with no
`last_rev`: the copies still read as unsynced. A state without a complete
stamp — this device's very first sync, or a state an older build left with
`host_id` alone — gets the stamp before the first fetch as well, and loses
its `last_rev` with it, so copies nobody can tie to this pairing read as
unsynced (`copiesReady`) until the first page replaces them. The
continuing branch (this run's `hostId` and `deviceId` already stored, with
a matching `entity_set` and a `last_rev`) leaves the stamp alone, since
every applied page writes it together with `last_rev` and `entity_set`.
`pairingGuard` (`UPDATE sync_state SET value = value WHERE (key = 'host_id'
AND value = ?) OR (key = 'device_id' AND value = ?)` with
`expectedChanges: 2`, first in every batch, before any statement that could
touch the rows it reads) requires that stamp to still be there and still
name this run's pairing: it aborts a stale in-flight sync for the wrong
pairing with `changes_mismatch` once its page finally arrives, in every
ordering — including two first syncs racing each other before either has
stamped anything. `SyncScheduler.stop` cannot cancel a request already
sent, and without this guard a late page for the old host would win
`excluded.rev > rev` against the new host's rows under the same ids
(`ref_org`/`ref_site` are keyed `'1'` on every host). The same guard
catches a page that outlives `device_forget`'s `clear_copies`
(`clear_copies` deletes the stamp along with everything else), and a page
of the old pairing that lands after a new pairing with the same host
stamped `host_id` to the same value again: its `device_id` no longer
matches, so it cannot bring back a record a tombstone of the new pairing
deleted (a turned-off operator, a revoked badge) nor move `last_rev` back.
The station's sign-in reads the copies, so this guard is its precondition.
A feed from another host than the paired one stops the sync with
`other_host` and applies nothing. `createSyncScheduler` runs one sync at a time: triggers during a
run ask for exactly one more, and a failed run waits for the next trigger;
`run` must report its own failure, since the scheduler swallows every
rejection. A host restored from a copy that has already passed the
device's revision goes unnoticed until the feed carries an epoch (plan 5).

## Protocol

Changing a wire shape means changing `proto`, the Zod schemas and the
fixtures together; the Rust tests parse every fixture, and the Vitest suite
parses every fixture whose shape crosses the IPC boundary. An office request
body the webview has built since plan 1d3 has one builder in
`src/host/requests.ts`, which names every field it sends;
`test/protocol.test.ts` checks that each builder produces its fixture exactly.
The catalog's builders (plan 1e2) cover the template routes too, which plan
1e3's pages call (`templateUpdate` for a flag or categories,
`templateDefaultsUpdate`) and plan 1e4's editor calls (`templateCreate`, a
layout through `templateUpdate`): `productCreate` and `productUpdate` send every
field, `null` for a blank one; `templateCreate` sends the name, the purpose,
the flag, the categories (`null` for every category) and the layout;
`templateUpdate` sends the name, the flag and the categories that differ from
the loaded template and a layout whenever one is given, its categories in
three states (left out keeps them, `null` is every category, a list is those,
and a reordered list is a change), and never `null` for a name, a flag or a
layout, which the host would read as «keep»; `templateDefaultsUpdate` sends
the whole document.
The older forms (users, the organization, SSCC, sign-in and the own-password
change) build their bodies inline, field by field, as does the wizard; its
`templates`, built by `stockTemplates` since plan 1e3, are typed by the strict
`bootstrapRequestSchema`, against which `test/protocol.test.ts` parses
`bootstrap-request-templates.json`. Raise `PROTOCOL_VERSION` for an incompatible
change; the host keeps accepting the previous version. Response types, which
devices of different versions read, tolerate unknown fields; request types,
which the host parses, reject them with `deny_unknown_fields`. The feed records
that grant access or carry the salt (`site`, `operators`, `operator_badges`) are
the exception: a station reads them strictly, so an additive field on one is
breaking for older stations, which quarantine the record and delete their copy
(fail-closed): an operator edited after a host upgrade cannot sign in on a
station that has not been updated, and `site` takes the badge salt and the block
sizes with it. The policy (versioning, or lenient additive fields) is carried to
plan 5, and the coupling of the block sizes to a fail-closed record to plan 2a
and the owner. The `product`, `protocol` and `minProtocol` fields of `hello`
never change shape: read `HelloEnvelope` first and decide compatibility
(`host_too_old`, `app_too_old`) before parsing the rest.

## Network and TLS

The webview never performs HTTP: every call to the host is a shell command.
Rust calls the host with the aws-lc-rs provider selected explicitly
(`src-tauri/src/tls.rs`). `host_client` trusts only the certificate whose
SHA-256 was saved at pairing (`FingerprintPolicy::Pin`); it uses no proxy,
follows no redirects, speaks HTTPS only and gives up after 2 s to connect.
`PinnedClient` also gives up after 10 s per request; `StreamClient` (the
change stream, "Connection to the host" below) has no per-request limit and
instead treats 45 s of silence as a lost connection. A pin mismatch is
recognized per request from the error chain (`tls::FingerprintMismatch`) and
reported as `certificate_mismatch`, never as `unreachable`. `host_probe`
observes a fingerprint without trusting it (`FingerprintPolicy::Observe`)
and exists only to discover a host before loopback, a person or a pairing
code confirms it.

`host_request`, the webview's generic way to reach the host, accepts `GET`,
`POST`, `PUT` and `DELETE`, paths of `[A-Za-z0-9/_.~?=&-]` without `..`, `//`
or a `.` segment, and only the routes `/v1/device[/…]` except
`/v1/device/line`, `/v1/bootstrap`, `/v1/changes` (not `/v1/changes/stream`)
and `/v1/office/…`. The line goes through `device_select_line`, which also
keeps the host's answer in `device.json`, so the station opens on its line
with the host away; `device_refresh` reads `GET /v1/device` again and keeps
a line the office changed the same way; the change stream belongs to the
connection task.
Pairing routes return a new device key, so they stay behind their own
commands (`host_local_pair`, `host_claim`) and the key never reaches the
webview. `%` is refused because an encoded `..` would slip past the route
check; a `.` segment is refused for the same reason, since the URL parser
would normalize it past the route checks. Add a route the webview needs to
that list deliberately; never let a listed prefix cover a route whose response
carries a credential the webview must never hold (a device key, a password
hash, another session's token).

The webview's IPC contract — command names, argument names such as
`officeToken`, the `{ status, body }` answer and bare-string rejections — is
pinned by `src-tauri/tests/ipc.rs` through Tauri's mock runtime. Change it
together with `src/host/client.ts`, `src/host/device.ts`, `src/host/probe.ts`,
`src/host/connection.ts` and `src/local/executor.ts`.

## Connection to the host

`src-tauri/src/connection.rs` runs one background task per app. It follows
the pairing (`DeviceState::watch_link`). While paired it holds
`GET /v1/changes/stream` with the device key and the pinned certificate
(`host_client::StreamClient`: no overall timeout, but 45 s of silence —
three missed heartbeats — drops the connection) and reconnects after a
pause of 1 s doubling to 30 s, back to 1 s after a stream that was online.
While unpaired it stays offline and tries nothing. It emits
`standalone://host-status` (`{ state: online | connecting | offline,
lastContactAt, lastError, seq }`, `lastError` one of `unreachable`,
`certificate_mismatch`, `key_rejected`, `stream_refused`, `stream_ended`)
and `standalone://host-revision` (for every `rev` event, the first one
after each connect included). `connection_status` answers the latest
status; `seq` grows with every status, so the webview subscribes first,
then asks, and keeps whichever is newest. A heartbeat advances
`lastContactAt` without publishing a new status (no new `seq`), so
`connection_status` can report a newer contact time than the last event the
webview received; an event's own `lastContactAt` is always the value
current when that event was published. The webview syncs reference data on
each revision and never opens the stream itself.

## Device key and office session

- The device key lives only in `device.json` in the app's local data
  directory (`app_local_data_dir`, `%LOCALAPPDATA%` on Windows):
  DPAPI-protected for the Windows user on Windows, plain in an owner-only
  (0600) file elsewhere. Never move it to a roaming directory: a roaming or
  redirected profile would carry the key and the pinned fingerprint to
  another PC and clone the device. The key never crosses IPC: the webview
  gets `DeviceStatus`, and `host_request` attaches the key in Rust. A file
  written on another system or for another Windows user is
  `config_unreadable`; the app offers to reset and pair again.
- An administrator revokes a device with `POST /v1/office/devices/{id}/revoke`:
  its key is refused at once (`unauthorized` with `credential: device`), its
  office sessions are deleted in the same transaction and its open change
  streams end. It stays in `GET /v1/office/devices` with `revokedAt`, and
  revoking it again changes nothing. `PUT /v1/office/devices/{id}` renames a
  device or sets its line (`lineId: null` clears it; only a station's, only
  an active line; re-sending the line the station is already on keeps it,
  even if that line has been archived since, so a full-form save can still
  rename the station). Devices have no `rev` and are not in the feed, so the
  last office write wins. A change of a device's line takes one host
  revision without a feed item, so open streams wake and the station reads
  `GET /v1/device` again (`device_refresh`, see "App shell"); a rename, a
  repeat of the same line and a revocation take none. How a line change
  meets a running shift is plan 2a's decision; stage 1 has only the floor
  stub.
- The office session token lives only in webview memory. «Выйти в цех» ends
  the session at once: the app returns to the floor, drops the token and
  tells the host in the background. There is no hidden session (owner
  decision 2026-09-26), so coming back to the office always asks to sign in.
- Every office user, the technologist included, changes their own password
  with the current one (`PUT /v1/office/me/password`); the user's other
  sessions end and the current one stays.
- Screens pick text by error code (`src/host/errors.ts`). An `unauthorized`
  answer names its `details.credential`: `device` (and a
  `certificate_mismatch`) sends the app to re-pairing, `session` to the office
  sign-in, `password` stays a form error.
- UI text goes through `src/i18n/ru.json`; controls come from `@markiro/ui`
  (ESLint bans native form elements in `src/`); forms check the host's and
  `@markiro/domain` rules before sending.

## App shell

`src/app/shell.ts` holds the screen state; `nextShellView` picks the screen
in a fixed order: the device config, pairing, a rejected device, another
host, the local host's version and identity, then the office or the floor.
The floor is the operator sign-in (`floor`), or, with an operator signed in,
stage 1's stub (`floor_operator`, `src/floor/FloorOperatorScreen.tsx`); see
«Operators and badges» for both.
While a host is paired, `useHostLink` (`src/app/host-link.ts`) follows the
shell's link and syncs reference data at start and after every revision
event; it stops when the pairing ends, is rejected or turns out to belong
to another host (`other_host`, which only a new pairing clears). At the
same moments it reads this device's record again (`device_refresh`): a line
the office sets or clears takes a revision but no feed item, so only the
record carries it. `DeviceState::refresh` reads `GET /v1/device` under the
pairing lock, like `select_line`, and writes `device.json` only when the
line changed. One read runs at a time and events during it ask for exactly
one more; its answer replaces the device status (`device_refreshed`) only
for the same pairing. A refused key or a changed certificate is a rejected
device, as on every host path. Any other failure keeps the station on the
line it has (offline first), and the read is tried again like a failed sync
(below), with a failure count of its own: a station must not stay on a line
the host no longer has until some unrelated event. A read that finds no pairing
(`not_paired`) is not retried. A failed run (neither another host nor a rejected
device) is retried while the link is online: after 2, 4, 8, 16 and 32 s, then
every 60 s (`nextSyncRetryMs`). A successful run starts the count again; any
other run replaces the pending retry; a status that is not `online` drops it (a
run that failed while the link was already not `online` never armed one); and an
`online` status after a failed run with no retry pending — dropped, or never
armed — syncs at once. Reads follow the same rules, but a failed read of the
device shows no message of its own: it is retried quietly, and the sync state's
`failure`, below, belongs to the sync alone. `requestSync` asks for a sync and a
read together: from the line-selection screen's «Повторить» and after a
`line_rejected` (`LineSelect.tsx`). The sync run's error sets the sync state's
`failure`: `local` for a `LocalDbError`; `feed` for an answer this build cannot
read (a `HostError` with code `invalid_response`), a `SyncFeedError` or anything
else; `host` for every other `HostError`. It stays through the retry's own run,
so a warning does not flicker; a successful run clears it and sets `quarantined`
from `readQuarantineCount` (`src/local/reference-sync.ts`, also used by a
successful run itself, so the query lives in one place). A failed run whose
error is not a rejection reads the same count and carries it too, so a restart
with the host permanently away still shows how many records are quarantined
instead of a bare zero; `readQuarantineCount` returns `null` if the read itself
fails, and the reducer takes `null` as "keep whatever count is already shown"
rather than resetting it — only a number replaces it. A link `lastError` of
`key_rejected` or `certificate_mismatch` is a rejected device, exactly like the
same answer to an office call. A new revision re-reads the signed-in user
(`Office`, `hostRevision`); it does not reload an open page, so a form keeps
what was typed and a save over a newer record meets `stale_revision`. Pages read
fresh data whenever they open (`staleTime` 0), except the site's badge salt and
the ЧЗ product groups, which never change and are not read again while they are
cached (`staleTime: Infinity`, see «Office pages»).

A paired station without a line chooses one (`LineSelect`) among the active
lines of the local copies (a line the office clears brings the station back
here, and a line the office sets moves it on), read only after a sync in this
session brought them up to date and again after every sync, so a previous
pairing's lines never show; the host's answer goes to `device.json` through
`device_select_line`. A refused device key or a changed certificate from that
call is a rejected device — `key_rejected` or `host_changed` — exactly as on
every other host path.
`HostStatusLine` shows the link on the floor (inside the floor's status bar,
below), on the line screen and in the office header — online, connecting, or
silent since the last contact, with the
reason — as a phase tag with words in a polite live region. In the same region
it warns, while the link is online, that the copies did not update and will be
retried, with the failure's reason (`errors.sync.<failure>`), and at any link
state how many feed records the copies did not accept (`quarantined`); the
office header reads the sync state next to the link (`OfficeLinkProvider`).
The line screen's alert names a failed sync by its class in the same words
(its own host wording for `host`, `errors.sync.local` and `errors.sync.feed`
otherwise) and a copy it cannot read as this computer's failure; while no
lines are listed yet (`lines` is `null`), its status line is given the sync
state without `failure` and repeats only `quarantined`, so the alert is the
one place that names the failure. A failed sync's alert stays through the
automatic retries, with «Повторить» showing the run in progress, until a
sync succeeds: the alert is a live region, so a screen reader hears one
failure once, not again at every retry. There is no
blocking overlay while the host is away: office pages explain their own failed
requests and offer a retry.

The floor's status bar (`src/floor/FloorStatusBar.tsx`, plan 1f2) sits above
the sign-in screen and the stub, inside one `.floor-frame`, as a labelled
region (`section` with an `aria-label`: inside the app's `main` a `header`
would not be a landmark). It shows the organization and the station's line by
name from this pairing's copies (`readFloorPlace` in
`src/floor/floor-status.ts`: nothing before `copiesReady`; an archived line
is still named, since the station works on it until the office moves it; read
again after every sync, and a failed read leaves the names out), the operator
signed in or «Никто не вошёл», and `HostStatusLine`, which the floor screens
no longer show themselves. It holds nothing to press, so the 64 px rule has
nothing to apply to. The device's own name is not in it: `DeviceStatus` has
none, and adding one is a shell change (`device.rs`, the `device.json` format)
outside plan 1f2.

Kiosk mode (plan 1f2). `src-tauri/src/lockdown.rs` ports the cloud station's
`enter_lockdown` and `exit_lockdown`: no frame, no taskbar button, above every
window, fullscreen, and on Windows `SetWindowPos(HWND_TOPMOST)` over the
monitor's `rcMonitor` (`cover_current_monitor`; elsewhere fullscreen is all
there is). Entering sets the flag only once every property held and rolls
every property back on a failure, so a window that is not fully locked can
still be closed; leaving clears the flag first and always, then restores what
it can, so an operator is never trapped in a window that will not close.
While the flag is set, `refuse_close_while_locked`, which `run` installs with
`.on_window_event`, refuses every close request (the frame's button, Alt+F4,
the taskbar); it checks the flag at the event, not through `set_closable`,
which Linux does not honour. Refusals are bare codes, `no_window` and
`window_failed`; the window system's text never crosses IPC. The webview's
`src/app/lockdown.ts` (the cloud's `createLockdownLifecycle`) runs the
commands one after another, sends nothing for a mode already asked for, and
nothing at all in development (`import.meta.env.DEV`: `tauri dev` and the
tests, which pass `createLockdownLifecycle({ dev: false, invoke })` with a
recording `invoke` when they want to see commands). A command that never
answers holds the later ones, as the sign-in queue does: the commands are
synchronous in the shell, so the window itself is hung then, and a timeout
that let the next command overlap could leave the window locked while the
webview believes it is not.

`App` enters kiosk mode whenever no office session is open: at start, when
the office closes («Выйти в цех») and when its session ends. That covers every
screen that is not the office, the first-run wizard and the repair screens
(pairing, host not found, pairing failed) included: on a fresh install, or
while the host service is down, nothing inside the app leads out of the
locked window until setup is finished and an administrator signs in. An
office session opens with the window still locked; the way out is «Оконный
режим» (`src/office/WindowModeButton.tsx`, in the office header), shown only
to an administrator while the window is locked and never in a build that does
not lock it. It asks first (`FormDialog`), reads the user from the host again
(`GET /v1/office/me`) and opens the window only if the host still says
administrator; if the role was taken away meanwhile, it says so, refreshes
the user and does not open the window. After a demotion the dialog simply
goes with the button once the refreshed role lands: the header shows the
technologist role, and the message is on screen for one round trip only.
After a successful exit the focus falls to the page body (the button that
held it is gone). Leaving the office locks the window again; a role taken
away after the window opened does not lock it before the session ends, as
the window mode lives exactly as long as the administrator session that
turned it on. Non-administrator office users (technologists) work in the
locked window too, so the template import's file chooser and the ZPL/TSPL
`<a download>` saves open under a borderless topmost window; their behaviour
there is unchecked. There is no local maintenance code (one more secret on
the PC; an owner question). Without the host nobody signs in to the office,
so the app cannot leave kiosk mode then: Windows' own Ctrl+Alt+Del stays,
and Tauri catches neither it nor Alt+Tab or the Windows key (the window
stays on top, so Task Manager may open underneath it). A failed enter is
logged by the command's name and tried again at the next office close or
restart; nothing on screen says so.

The device-rejected, other-host and config-error screens show in kiosk mode
too, with «Подключить заново» and «Сбросить подключение»: that forget empties
the copies and the lockout counters with them (`clear_copies`). Those screens
come only when the host refused the device or its config is unreadable, which
nobody produces from the floor, and a station on another PC pairs again only
with an administrator's code; a station on the host's PC pairs again on its
own (loopback trust), so there the counters start from zero after such a
forget (an owner question: whether to guard those buttons in kiosk mode, for
example to the office only). The buttons of these shell screens are of
ordinary size, not 64 px, although kiosk mode shows them on the station.

## Office pages

- Every office request goes through `session.call` with `session.api`
  (`useOfficeQuery`, `useOfficeMutation` in `src/office/office-query.ts`).
  `call` routes an ended session to the sign-in and a rejected device to
  re-pairing, and re-reads the user on `forbidden`. Pages never call
  `invoke`, `HostClient` or `createHostApi` themselves.
- React Query keeps one cache per office session (`Office` is keyed by the
  session token), with no retries, no refetch on window focus or reconnect,
  and `networkMode: "always"`: calls go over IPC to the host, and the
  webview's online flag says nothing about whether the host answers. A host
  error is an answer the page explains, with a retry button.
- Every update of a revisioned record sends the loaded record's
  `expectedRev`. Creates and password routes carry none. On `stale_revision`
  the page offers to load the data again and drops the user's edits; it
  never retries with `details.currentRev`.
- A success notice is an `Alert` on the page or dialog; it goes away when
  the next save starts (or the next dialog opens).
- A dialog around one form is a `FormDialog` (`src/office/FormDialog.tsx`):
  the title, the fields, «Отмена» and the submit button. From the submit
  until its promise settles it cannot be closed and a second submit is
  dropped, so a double click sends nothing twice. `writeFailure` (`src/office/form-errors.ts`)
  sorts a refused write: a `validation_failed` field or a `conflict`
  constraint the form names (`line_name`, `login`, `badge`, `gtin14`) goes under
  that field, `stale_revision` offers to reload, and so does a
  `validation_failed` on a field the form names as out of date (`staleFields`:
  a product's template preferences), anything else is an alert
  (`WriteFailureAlert`). A `FormDialog`'s `onSubmit` must never reject: it
  sorts every failure itself, and a rejection would only surface as an
  unhandled one, so a caller's bug is not hidden. Only the awaited write sits
  in the `try`, with the hashing that builds its body where there is one (a
  PIN, a badge code); the callback after a saved write (`onSaved`, `onRevoked`, …)
  and whatever else follows a success run after the `try/catch`, whose `catch`
  ends with `return`, so a throw there is never shown as a failed write (a
  retry would add a second counterparty: the host keeps no uniqueness). The
  archive, revoke and turn-off confirmations use the `destructive` submit
  variant although archiving and turning off can be undone: here it means an
  action that takes a record out of use. Whether a page shows a form or a
  read-only view comes from `useCan` (`src/office/access.ts`), the table of
  spec §4.8.
- Request bodies are built field by field, never spread from form values, so
  nothing the form holds reaches the host by accident; ids go into the path
  only.
- Lists of archivable records (counterparties, lines, products) show active
  records before archived ones, each by name in Russian order with numbers by
  value, then by id (`activeFirstByName` in `src/office/records.tsx`, with
  `Intl.Collator("ru", { numeric: true })`); the host sorts bytewise, which
  puts «Линия 10» before «Линия 2». Templates take the same order on
  «Шаблоны» and in every template choice (`byNameThenId`), so two templates of
  one name, which a copy or a rename can make, keep one order everywhere.
- «Контрагенты» is read by every role and changed by administrators. An edit
  sends the whole record with `expectedRev`; archiving is the dialog's «В
  архиве» box, and there is no delete. The host keeps no uniqueness for
  counterparties (an owner question), so the page checks no duplicates; a
  second click while the request is on its way sends nothing.
- «Линии» lists every line, archived ones included; every role reads it and
  administrators change it. A name an active line already has, compared
  without case, answers `conflict` on `line_name` when adding, renaming or
  bringing a line back from the archive, and goes under the name: bringing a
  line back is a dialog with its name, so it can take another one. Archiving
  asks first and says that stations already on the line stay there: the host
  does not touch devices when a line is archived.
- «Операторы» is for administrators only: `RequireRole`, and `OFFICE_NAV`
  shows it to them alone, between «Линии» and «Устройства». It lists every
  operator, those turned off included: active ones first, each group by
  personnel number as text, as the host orders them (leading zeros are part
  of the number, so no numeric collator), with the role, whether a PIN is
  set, the badges in use and the access in words. A new operator takes a
  personnel number, a name, an optional role and a PIN typed twice. An edit
  changes the name and the role and shows the number, which never changes:
  a cleared role goes as `role: null`, an untouched one not at all.
  «Сменить PIN» replaces the PIN, which is never shown. «Выключить» asks
  first and says that the operator can no longer sign in on the stations
  once they sync; «Включить» asks too, lightly. Every change sends only what
  differs (`operatorUpdate`) with the loaded revision, and the record the
  host returns replaces the row in place. A dialog hashes the PIN
  (`hashPin`) inside its `onSubmit` and then builds the body: the
  `FormDialog` guard covers the hashing too, and the mutation's variables,
  which the query cache keeps, hold only the hash. There is no delete, and
  the page offers none.
- «Бейджи» on an operator's row lists that operator's badges, revoked ones
  too, dimmed and marked «Отозван»: they are the record of what was issued.
  «Добавить бейдж» reads the site's salt (`GET /v1/office/badge-salt`;
  `not_found` means a host before its wizard) with `staleTime: Infinity`: it
  is not read again while it is cached, so a dialog opened again soon reuses
  it, and it is read again once the cache has dropped it (about five minutes
  without an add dialog, the default `gcTime`), which is harmless, since it
  never changes. The dialog focuses the code, which a keyboard-wedge scanner
  types and submits with Enter, hashes it with the salt (`hashBadge`) and
  sends only the hash. The code field is read-only (still focusable) until
  the salt is read and again while a submit is in flight
  (`formState.isSubmitting`, which spans the validation, the hashing and the
  request, where `add.isPending` would miss the hashing), so a scan typed
  then is not taken and cannot be glued to the code being sent; once the
  answer is in, a success closes the dialog and after a failure the field is
  editable again. One residual stays: a scan that straddles the moment the
  field becomes editable loses its head, which a read-only field does not
  take, and sends its tail, which `badgeCodeRule` accepts. The moment is the
  salt's arrival, on an opening that reads the salt (the first, or one after
  the cache dropped it, see above), and the end of a failed submit (`scanAgain`
  empties and focuses the field inside the callback, while `readOnly` drops
  only when React renders `isSubmitting: false`). Nothing
  detects it: the badge then matches no station, and the remedy is to revoke
  it and add it again (the station's sign-in is the first place it shows). It
  is accepted, since a scan of about 0.1 s has to straddle a boundary. The
  answer is the new badge, not its operator, so the badge
  goes into the cached operator at once (`useChangeList` with `withBadge`,
  which replaces a badge by its id: the same badge twice is one badge). A
  `badge` conflict names the holder under the code when `details.operatorId`
  is a UUID of an operator in the list, and otherwise says only that the
  badge is taken. The code field is masked and a scanner types after
  whatever it holds, so a code that did not go through must not stay in it: a
  retry is a new scan, never a press of the button over the old code. What a
  refused add does:

  | Failure                                                             | Code field | Focus goes to | Message appears        |
  | ------------------------------------------------------------------- | ---------- | ------------- | ---------------------- |
  | The form refuses the code (layout hint, empty, too long, not ASCII) | emptied    | code          | under the code         |
  | A `badge` conflict                                                  | emptied    | code          | under the code         |
  | `validation_failed` on `badgePhc`                                   | emptied    | code          | under the code         |
  | The request fails, answered by an alert                             | emptied    | code          | alert above the fields |
  | The form refuses the label (too long, control character)            | kept       | label         | under the label        |
  | `validation_failed` on `label`                                      | kept       | label         | under the label        |
  | The label has the code or its Russian-layout form (`labelHasCode`)  | emptied    | label         | under the label        |

  A message under a field stays until the next input into it, an alert until
  the next submit the form accepts (`setFailure(null)` runs before the label
  guard, so a `labelHasCode` refusal clears it although nothing is sent, while
  a refusal by the form itself leaves it). A refusal of the label alone, by
  the form or by the host, keeps the code, and the label is corrected beside
  it. One residual stays with those two rows: the focus is on the label, so a
  reflex re-scan lands there, but a deliberate click into the masked code
  field and a scan would glue the two scans and save a badge that no station
  matches. Nothing leaks and it is accepted; emptying the code on every
  refusal would close it, at the cost of one more scan after such a refusal.

  The last row is the exception, and the guard against the one way a code
  could leave the webview in clear text by accident: a label typed first, with
  the focus left in it, takes the scan, and the second scan into the code
  field would send it as the label, which the host stores, writes to the audit
  row, lists and sends to every station, and revoking the badge takes back
  none of it. Once the form accepts both fields, and before anything is hashed
  or sent, a label that has the code is refused. The guard empties the code
  (`setValue`, without validating) but leaves the focus on the label
  (`setError` with `shouldFocus`; `scanAgain` would take it to the code field),
  because a re-scan into a kept code would be glued to it
  («MRK-000742MRK-000742»), the label would then no longer hold that string,
  and the label would go out with a hash no station matches. Once the label is
  corrected the code is scanned again; an empty code is refused, and
  `scanAgain` focuses the field.

  The label is read three ways and the comparison ignores case: as typed, as
  the Russian layout types it, and as it types it with Caps Lock on. A wedge
  scanner presses keys, and a label typed in Russian needs that layout, so it
  takes the scan in Cyrillic («MRK-000742» arrives as «ЬКЛ-000742»,
  «123,45678» as «123б45678»); the code field refuses that form with the
  layout hint, and once the layout is switched the next scan arrives in Latin.
  So the label is also read back to the keys with the two readings the pairing
  scans use (`src/host/pairing-code.ts`): `fromRussianLayout`, the layout
  mapping, and the same after `withCyrillicCaseSwapped`, the reading for Caps
  Lock. Under the Russian layout the keys of the comma, the period, the
  semicolon, the apostrophe, the square brackets and the grave accent are the
  letters б ю ж э х ъ ё, so Caps Lock capitalizes them («123,45678» arrives as
  «123Б45678», which the mapping alone reads as `123<45678`), while the
  English layout leaves them alone. Caps Lock also changes the case of the
  Latin letters (a scanner that corrects for it types «mrk,742» as
  «ьклБ742»), so the comparison ignores case. The three tests are plain
  substring tests of the two trimmed values, so they also refuse a label that
  repeats the number printed on the card on purpose, and a very short code
  that is a substring of the label by coincidence: both are accepted costs,
  which the mapped readings and the comparison without case widen slightly.
  The guard covers the Russian layout and Caps Lock as long as the state is
  the same for the label scan and the code scan. It does not recognise a
  layout or Caps Lock state that changed between the two scans, any other
  layout, or a label edited after the scan.

  «Отозвать» asks first and says that the badge stops opening the stations
  once they sync and never comes back; after the host's 204 the badge shows
  as revoked at once, and the list is read again.

- `@markiro/ui` has English defaults: `Table` shows «No data» without
  `empty`, and `Modal` names its × «Close» without `closeLabel`. Every
  office table passes a localized `empty`, and every dialog passes
  `closeLabel={t("office.common.close")}`.
- Roles (spec §4.8) are enforced by the host. The office hides menu items by
  role (`OFFICE_NAV`) and wraps administrator-only routes in `RequireRole`,
  which shows «Нет доступа» when a role changes mid-session. An
  administrator's own row in «Пользователи» changes only the name — a UI
  rule: the host itself guards only the last active administrator, so
  another administrator changes one's role or access, and one's own
  password goes through «Сменить пароль» with the current password.
- An ended session unmounts the office: unsaved edits are lost, and the next
  sign-in starts at «Обзор».
- «Устройства» lists `GET /v1/office/devices` and names lines from
  `GET /v1/office/lines`, the list its edit dialog offers, so a line added a
  moment ago can be chosen at once; an archived line is marked «в архиве».
  `lastSeenAt` is «Последний раз», never «на связи»: the host touches it at
  most once a minute and a stream only when it opens. One dialog renames a
  device and sets a station's line, sending only what changed
  (`deviceUpdate`): only an active line can be chosen, and a station's
  current line stays on the list even when archived. A revoked device is a
  dead record and offers no controls; revoking asks first, names the device
  and says it cannot be undone, then the list is read again. The row of this
  PC — the device the office runs on, whose `deviceId` `App` passes into
  `Office` (`useThisDeviceId`) — is marked «Этот ПК», and revoking it asks
  more: the app on this PC disconnects and has to be paired again. Nothing
  stops it; the host then refuses the key, and the shell shows the
  rejected-device screen. A claim raises
  no revision, so the pairing-code dialog reads the list every 3 s
  (`DEVICE_POLL_MS`) and closes once a device paired after the code was
  created appears. «Новый код» sends the code on screen as `{ replaces }`
  (no code on screen, no body), and a second click while a code is on its
  way asks for nothing. The DataMatrix encoder loads lazily
  (`PairingDataMatrix`); when it fails, the typed code, the fingerprint and
  the host's addresses stay the way to pair. The countdown takes the code's
  lifetime from the host (`codeLifetimeMs`: `expiresAt − createdAt`) and
  counts it on this PC's clock from the moment the code was requested: the
  host and the office PCs on a cloud-less LAN are not promised to agree on
  the time, so no host timestamp is compared with this PC's clock, and join
  detection compares host timestamps only.
- «Товары» (section «Каталог») lists every product, archived ones included,
  and every role reads it: active ones before archived ones, each by name
  (`activeFirstByName`), with the GTIN, the print name as a second line when
  it differs from the name, the product group's name from
  `GET /v1/office/product-groups` (its code when the lookup lacks it or did not
  load; a failed lookup leaves the list in place and offers to read it again,
  but when the products fail too, only their error shows, and its «Повторить»
  reads both again), the box capacity and the state in words (draft, active,
  archived).
  The host sends the whole list, so the search (name, print name or GTIN,
  without case, a GTIN's spaces ignored), the state filter and the pages of
  25 work in the page, and a new search or filter goes back to the first
  page. The groups are a static lookup, not read again while cached
  (`staleTime: Infinity`). Both roles add and change products
  (`useCan("editCatalog")`; no role lacks it, so the page has no read-only
  view). One dialog adds and changes a product: an edit sends the whole
  record with the loaded revision, archiving is its «В архиве» box, and
  there is no delete. The GTIN may change: a GTIN another product in use
  holds is `conflict` on `gtin14` under the GTIN, on adding, on a change and
  on coming back from the archive. Once the GTIN is valid the dialog shows
  the 14 digits it is saved as when they differ from what was typed, and
  whose GS1 prefix it has: the organization's, else the first counterparty's,
  else nobody's, like the cloud's `checkGtinOwner`, except that counterparties
  go active first, by name (the host keeps no creation time). That never
  blocks a save and is left out while the organization or the counterparties
  do not load. While the form lacks the group or either capacity, a note says
  the product stays a draft (the host makes it `active` only with all three).
  The group select offers the lookup by name and keeps the product's own
  group when the lookup lacks it; while the lookup does not load it is off
  and the group goes out unchanged. The two default templates offer what
  `templateFitsSlot` accepts for the form's group and the slot, by name, and
  «Не выбран». A preference that no longer fits (disabled, narrowed, or the
  group changed in the form) stays a choice marked «не подходит» and goes out
  unless changed, since the host takes it; a change of the group never resets
  a choice. An id the list lacks stays a choice, shown by its first eight
  characters («Шаблон a3b4c5d6… — нет в списке»; without the suffix while the
  list is not loaded). While the template list does not load both selects are
  off and the preferences go out unchanged. A `validation_failed` on
  `defaultBoxTemplateId` or `defaultPalletTemplateId` reads as a stale write
  (`PRODUCT_STALE_FIELDS`): the form was opened before its template was
  deleted. «Загрузить заново» closes the dialog and reads the products again;
  the templates are read again whenever a dialog opens.
- «Шаблоны» (section «Каталог») lists every label template, disabled ones
  included, and every role reads it: a table, not the cloud's cards, with a
  thumbnail beside each name (below), by name with numbers by value
  (`templatesByName`). A row shows the purpose as a word on a category tag (the
  cloud's tones: box violet, pallet magenta, product duplicate teal), the size
  («58 × 40 мм») and the layout's resolution («203 dpi») as the summary has
  them, «—» where it has none, the categories (every category, one group's name,
  or «Категорий: N» with the names in a `title` and, for a screen reader, in
  the cell (`VisuallyHidden`, « (names)»; only where the count has names to
  give, so not for an empty list); a code where the lookup lacks the group or
  did not load, and a failed lookup leaves the list in place and
  offers to read it again, but when the templates fail too, only their error
  shows, and its «Повторить» reads both again), the state in words («Включён»,
  or «Выключен» as `retired`) and a «Типовой» tag on a stock template. The host
  sends the whole list, so the search (by name, without case), the purpose
  filter and the state filter work in the page; there are no pages, since a site
  keeps tens of templates. The templates are read whenever the page opens; the
  groups are a static lookup, not read again while cached
  (`staleTime: Infinity`). Both roles switch a template on and off and change
  its categories (`useCan("editCatalog")`; no role lacks it, so there is no
  read-only view). «Выключить» asks first, with the `destructive` submit, and
  says the template is no longer offered for products and defaults and the
  stations get the change; «Включить» asks lightly. Only the flag goes, with the
  opened row's revision (`templateUpdate`), and the answer goes into the cached
  row in place (`withTemplateChange`: the name, the flag, the categories,
  `stock` and the revision; the size, the resolution and the language stay, and
  the layout stays out of the cache), without reading the list again. Switching
  off a default is refused (`template_is_default`), and the dialog says whose
  default the template is (the organization's, the categories by name, a code
  where the lookup lacks the group or did not load) and that another template
  must be chosen on «Умолчания шаблонов» first; `stale_revision` offers
  «Загрузить заново», which closes the dialog and reads the list again.
  «Категории» opens a dialog on `CategoryScopeField`
  (`src/office/templates/CategoryScopeField.tsx`, which the template editor
  reuses): «Все категории» or «Только выбранные», the product groups by
  name with a search and a live count of the chosen ones; the chosen codes stay
  while «Все категории» is picked, so switching back brings them back, and while
  the lookup loads or fails the field keeps them and says why it lists nothing.
  A chosen code the lookup lacks is listed after the groups as a «Код N»
  checkbox, so it can be unticked, and after a successful «Повторить» inside the
  field focus moves to the search box, so Escape and Tab stay in the dialog.
  The search box cancels Enter: the field sits inside form dialogs, and the
  browser would otherwise submit the form and save a half-made choice. The
  dialog sends `null` for every category or the chosen codes ascending
  (`scopeCodes`: `templateUpdate` takes a reordered list as a change, a new
  revision and the layout to every station again), with the opened row's
  revision; «Сохранить» stays off while the categories are the row's in any
  order, and «Только выбранные» needs at least one category. Narrowing a
  template out of a category whose default it is, or narrowing the
  organization's default at all, is refused as switching it off is, in the same
  words; a saved answer goes into the row in place. «Создать шаблон» (both
  roles) opens the editor, and a row's last action is «Изменить» (the editor)
  or, for a stock template, «Копировать» (a copy in the editor). Either dialog
  refused with `not_found` (the template was deleted on another workstation)
  says the template is gone, stays open and reads the list again, which drops
  the row. The thumbnail (`TemplateThumb`, after the cloud's) draws the layout
  with the purpose's sample data, fitted into a 64 × 48 px box: it is read with
  `getTemplate` only once its row comes near the screen (`whenVisible`, an
  `IntersectionObserver` 200 px ahead) and kept by id and revision
  (`useTemplateLayout`, `officeKeys.templateLayout`, `staleTime: Infinity`:
  any write gives a new revision), so the list's cache never holds a layout and
  a layout read once is drawn again at once. Until then, and for a layout that
  does not load or does not read, the box stays empty; a failed read is not
  kept, so the row asks again the next time the page opens. It is decorative
  (`aria-hidden`): the name beside it says what it is.
- The template editor (plan 1e4; `/templates/new`, `/templates/:id` and
  `/templates/:id/copy`, pages without a menu item of their own, so the
  sidebar's «Шаблоны» stays highlighted there and «Умолчания шаблонов» does
  not: the `NavLink` has no `end`) follows the cloud's `LabelEditorPage`,
  whose sources it ports into `src/office/templates/` (`label-geometry.ts`,
  `label-samples.ts`, `import-analysis.ts`, `ImportCodeDialog.tsx`,
  `ImportFieldsPanel.tsx`) instead of importing them: the apps stay
  independent, and the label rules themselves stay in `@markiro/domain`. Both
  roles use it. A template is a name (trimmed, 1–200 characters,
  `templateNameRule`), a purpose, a flag, its categories
  (`CategoryScopeField`, with the cloud's warning that the EGAIS field prints
  empty on categories without beer) and a layout, which only an import puts
  on the label and the preview shows as it prints (`PreviewPane`, after the
  cloud's): drawn at 3 px per millimetre with the purpose's sample data and
  again whenever the layout changes (`drawLabel`), every text the print
  rasterizes (anything but printable ASCII, Cyrillic above all) covered with
  the print's own bitmap, asked of the rasterizer with the options the
  domain's generators give it and painted where the printer puts it
  (`compositeTextRasters`: the element's estimated box and the bitmap's own
  rectangle go white first, since the printer's bitmap is opaque, then its
  black dots, in whole printer dots); codes are schematic, except a product
  duplicate's, which is the station's raster (`paintCodeRasters`). All of it
  is at the layout's own resolution; the cloud station prints at its
  printer's (`withPrinterDpi`, `apps/station/src/lib/print-label.ts`), so
  the preview matches a printer of the layout's resolution. While the
  layout has such text the editor checks that the bundled font has Cyrillic
  (`checkFamilyCoverage`: opentype.js reads the app's own IBM Plex `.woff`
  files, the Latin and the Cyrillic subset, since 2.0.0 cannot read WOFF2; no
  network) and warns when it lacks it or could not be checked; the check does
  not run again for every change of the layout, a successful answer is kept
  per family (a failed one is not, so the next ask reads the files again),
  and a warning is the answer of the check that is running: it goes when that
  check ends (the layout lost its Cyrillic text) and does not show again
  before the next check answers. The canvas is an image named by the label's
  size. The office draws through `LabelRendering`
  (`Office`'s `labels`: a canvas context, the rasterizer, the font check and
  the thumbnails' `whenVisible`), the webview's own by default; tests pass
  `quietLabelRendering` or a recording canvas, since jsdom has no canvas
  (`test/setup.ts` quiets its `getContext`) and fetches no font file. The
  import dialog takes ZPL or TSPL at a chosen resolution or the model's own
  JSON (`{ name, purpose, spec }` or a bare layout), checks it
  (`analyzeImport`: the domain's parsers, then every element moved inside the
  label, measured with the purpose's sample data), lists the lines or
  properties it drops for an acknowledgement and replaces the layout; a
  JSON's name names a template that has none yet, and the field list copies
  each field's token (`navigator.clipboard`; a failed copy says to copy by
  hand). The parser's own messages are shown as they are, in English.
  «Изменить размер» opens the size form: a preset or a typed size of 10–300
  mm with a comma or a point, and the layout's resolution; every element is
  moved inside the new label (`resizedSpec`), and a size an element does not
  fit is refused and the layout stays. An axis the user has not touched keeps
  its exact value, which its field shows rounded, until a preset or typed
  text replaces it; «Свой размер» only leaves the fields to be typed over, so
  on a preset size choosing it changes nothing. A product duplicate's layout
  must keep the domain's duplicate rule (`assertDuplicateTemplate`): while it
  does not, «Сохранить» is off (a form submitted another way sends nothing)
  and the editor offers the domain's duplicate 58×40 back. «Скачать ZPL»,
  «Скачать TSPL (TSC)» and «Скачать JSON» save through a blob URL and
  `<a download>` under a file name made of the template's name, Cyrillic
  letters kept. A code file is the domain's `generateZpl` or `generateTspl` of
  the layout, with the sample data, the render options and the rasterizer the
  preview uses, so it is what a station would send to a printer of the
  layout's own resolution (a station prints at its printer's), its Cyrillic
  as the print's bitmaps, written byte for byte (`latin1Bytes`, the station's
  `latin1ToBytes`: a `Blob` of the text would write each character from 0x80
  up, TSPL's bitmap bytes among them, as two). The domain's emitters do not
  reject a character above U+00FF in a code's data (a `{ literal }`, or a
  field bound to one, such as a QR of the product name) and `latin1Bytes`
  makes it a control byte, as the station's does; that limit is the domain's
  (`packages/*`), not this app's. Both code downloads are off while a file is
  being made and while a duplicate breaks its rule; a file that could not be
  made (any failure of the generators, the bitmaps or the chunk's load) is not
  saved, and an alert above the buttons says «Файл не собран. Попробуйте ещё
  раз.» in those words for every failure. While a duplicate breaks its rule
  and both buttons are off, that alert is not shown. The JSON is
  `{ name, purpose, spec }`. Only jsdom has run the downloads, not the
  Tauri webview (WebView2, WKWebView), so a webview that refuses them would
  need a save-file command of the shell. Nothing reaches the host before
  «Сохранить»: the layout goes as `labelTemplateSpecSchema` makes it
  (`checkedSpec`), the categories as `null` or ascending. A new template or a
  copy is a create (`templateCreate`); a new blank template's untouched
  starting layout follows its purpose (a box an empty 58×40, a duplicate the
  domain's duplicate, a pallet the stock pallet 100×150), and a copy keeps its
  layout under «<name> — копия». A template opened for a change is read
  whenever the page opens and shown only once read on this visit (until then
  «Загрузка…», never a failure of an earlier visit); its purpose is fixed,
  «Сохранить» is off until something changed, and the save sends what differs
  and the layout with the opened revision (`templateUpdate`). A stock
  template is not opened for a change (its row offers «Копировать», and its
  address explains and offers a copy), nor is a layout the domain cannot read;
  a template deleted elsewhere is said to be gone. The form is off while a
  save is on its way, and so are «Копировать» and «Удалить»; a save or a
  delete answered after the user left through the menu does not take them back
  to «Шаблоны» (the cached list is reset all the same, with `resetQueries`, so
  a list page the user left for meanwhile reads it again). A refusal goes
  under the name or the categories, which then take focus, or above the form
  (`editorFailure`): a
  default the change would break says whose default it is, `stale_revision`
  offers «Загрузить заново», which reads the template again and starts the
  editor afresh without the edits, and `not_found` says the template is gone.
  The editor measures the layout before it sends it (`specTooLarge`: the
  bytes of its compact JSON in UTF-8, as the host counts them), and a layout
  over 256 KB is refused above the form with a way out, «Сократите тексты или
  импортируйте код поменьше»; one of exactly 256 KB goes. The host's own
  `validation_failed` on `spec` stays the backstop and is worded the same
  way. «Удалить» asks first, with the `destructive` submit, and says that the
  stations stop getting the template, that the products preferring it lose
  the preference and that there is no undo; a default or a stock template is
  refused in words (`deleteFailure`). A save or a delete returns to «Шаблоны»
  with a notice and drops the cached list, which holds no layouts, so it is
  read again; a delete also drops the cached products, since the host cleared
  the preference of every product that used the template. Leaving the page
  with unsaved changes («К шаблонам», the menu, «Копировать») asks first
  (`useBlocker`), except right after a save or a delete; the end of the
  session unmounts the office without asking, and closing the window is not
  guarded either (that would be the shell's). Plan 1e4b's drawing has run only
  under jsdom, where tests check a recording context's calls, not pixels, and
  stand-ins replace the rasterizer, the font check and the observer; never run
  in a real window are the canvas pixels and their sharpness at 3 px per
  millimetre, `document.fonts.load` of Cyrillic and the rasterizer in WebView2
  and WKWebView, fetching the `.woff` files and the on-demand chunks over
  Tauri's protocol, `IntersectionObserver` there, `<a download>` for all three
  downloads, and printing a downloaded file on a real Zebra or TSC printer.
- «Умолчания шаблонов» (section «Каталог») edits the one defaults document
  (`GET/PUT /v1/office/template-defaults`): the page reads it whenever it opens
  (`useTemplateDefaults`, `staleTime` 0), with the template list, which it reads
  once per visit, and the product groups, a static lookup read once while cached
  (`staleTime: Infinity`), and passes both to the form, since the form remounts
  on every new revision. Both roles change it (`useCan("editCatalog")`), so
  there is no read-only view. The organization's three defaults are selects of
  «Не выбран» and the enabled templates of their purpose for every category
  (`templateOptions` with category `null`), by name; a default the list does not
  offer, the loaded one or the current one, stays a marked choice («— не
  подходит», «— нет в списке»). The category defaults are rows by category name,
  then purpose (the page sorts what it shows and sends its own order): the
  group's name (its code, «Код N», where the lookup lacks it or did not load),
  the purpose on its tag and a select of the templates that fit that category
  and purpose, which keeps a template the list does not offer as a marked choice
  in the same way and has no «Не выбран», since «Убрать» clears a category
  default. «Добавить умолчание категории» (off while the groups or the templates
  do not load) asks for a category that still has a purpose without a default, a
  purpose that category has no default of yet and a template that fits both
  (`CategoryDefaultDialog`; when nothing fits, the no-fit text stays the
  template field's error after «Добавить»), and adds the row to the page's
  document. While the template list loads or has failed, the selects (the
  organization's and the rows') and «Убрать» are off and the defaults go out as
  stored; a template the list does not show appears by the first eight
  characters of its id («Шаблон a3b4c5d6…»; «— нет в списке» follows once the
  list is loaded without it). A failed list shows a warning with «Повторить»,
  and a failed group lookup one of its own. Edits stay in the page: a live note
  says there are unsaved changes, «Отменить изменения» brings back the loaded
  document, and «Сохранить», off until something changed, sends the whole
  document with the loaded revision (`templateDefaultsUpdate`: `null` for «Не
  выбран», every category default the page holds), drops a second click while
  the save is on its way, with every control of the page off until the answer,
  and puts the answer in the cache, which starts the form afresh. A
  `validation_failed` goes under the control it names (`defaultsFailure`): an
  organization default's select, or the row of the category default the page
  sent at that index (`categories.{i}`, `.templateId`, `.chzProductGroupCode`),
  in words for each: a template that no longer fits (disabled, narrowed or
  deleted while the page was open: the host checks the defaults before the
  revision), a category the host did not take, a default given twice. The
  template list is then read again so a refused choice shows as marked, and a
  change of that control, or the removal of that row, takes the message away.
  Focus moves to the refused select, so its error is read, and a refusal naming
  a row the page no longer holds is the general alert; after «Убрать» focus
  moves to the next row's «Убрать», else the previous row's, else «Добавить
  умолчание категории». `stale_revision` offers «Загрузить заново» in words of
  its own, since a change of the organization's profile moves the document's
  revision too, and the reload drops the edits.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
arbitrates but does not reimplement them.

## Logs

Never log device keys, session tokens, pairing codes, passwords, PINs, badge
codes (a scan is one: the sign-in neither logs nor keeps it, and
`test/floor-sign-in.test.ts` and `test/operator-sign-in.test.tsx` check the
console stays silent), any hash or the TLS private key. A label template's
layout is no secret, but at up to 256 KB it stays
out of the log as it stays out of audit details; `no_secrets_in_logs.rs`
walks a stock and an office layout through the template routes, the
defaults and the feed. Kiosk mode's failures are logged by the command's name
alone (`standalone: enter_lockdown failed`), never by what the shell answered.

## Verification

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` —
  the workspace is rustfmt-clean and CI enforces it.
- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace`. The
  Tauri crate needs `apps/standalone/dist`: build the webview first with
  `pnpm turbo run build --filter='@markiro/standalone...'`.
- Host integration tests share `host/tests/support/app.rs`: `admin()` is a
  host after the wizard with its administrator signed in on the station that
  ran it (`Admin::call`, `call_as`, `technologist`), `audit_trail` reads the
  exact audit rows of one action and `Admin::row` builds the expected `ok`
  row, `host_revision` reads the revision. Add a helper there before copying
  one into a second test file.
- `pnpm --filter @markiro/standalone test`, `typecheck`, `lint`, `build`.
- The Windows service and DPAPI run only in the `standalone-windows-build`
  job: it compiles the service and the Tauri app for Windows, and its cargo
  tests round-trip a key through DPAPI. A real Windows user profile, the
  service at runtime and kiosk mode still need a manual check on Windows; a
  run on macOS proves none of it.
- Kiosk mode in tests: `src-tauri/tests/lockdown.rs` drives the commands and
  the close guard on Tauri's mock runtime, which accepts every window property
  and never calls a builder's window-event handler, so the test hands each
  close request to the guard itself; it opens no socket and runs in the
  sandbox. The close-guard tests re-request the close up to a bound and then
  destroy the window, so a guard that never lets go fails the assertion
  instead of hanging. Three things stay green when broken, because the mock
  cannot reach them: deleting `.on_window_event(...)` in `run`, deleting the
  rollback in `enter_lockdown`'s error path, and the `cfg(windows)` code. The
  last needs the `windows-sys` features `Win32_Graphics_Gdi` and
  `Win32_UI_WindowsAndMessaging` and compiles only in
  `standalone-windows-build`, where the one test that touches it
  (`on_windows_a_refused_enter_leaves_the_flag_off`) also runs.
- Kiosk mode by hand, on Windows 10 and 11 with a build from that job. None
  of it has been run; check at least:
  - the window locks at start, again after «Выйти в цех» and after the office
    session ends; it also locks on the first-run wizard and the repair
    screens, where nothing in the app leads out (a fresh install; the host
    service stopped);
  - Alt+F4, closing from the taskbar and the frame keep the window open
    (this is the only test that `run` installs the close guard);
  - the window stays above every other window and covers its whole monitor,
    the taskbar included, on a second monitor too;
  - an enter that fails leaves an ordinary window that closes (the rollback;
    reachable only by making a window property fail);
  - «Оконный режим» is offered to an administrator and not to a technologist,
    asks first, and brings back the frame and the taskbar button; focus after
    it falls to the page body; a restart locks again; leaving the office
    locks again; an administrator demoted on the host while the dialog is
    open sees the button go and the technologist role in the header;
  - Ctrl+Alt+Del: Task Manager may open underneath the topmost window, so
    «Выйти из системы» may be the only way out; try it on the setup screens;
  - a technologist's template import (file chooser) and ZPL/TSPL download
    inside the locked window;
  - a real keyboard-wedge scanner signs in under the EN and RU layouts and
    with Caps Lock; real focus and blur of the name field in WebView2, and a
    name typed into it is not scanned; a product's code scanned on the
    sign-in screen; sign-in time by badge and PIN on a factory PC;
  - the layout of the name-search step and of the status bar, and the 64 px
    controls, on the real screen and touch panel (and the Windows on-screen
    keyboard for typing a name).
