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
because it may be 256 KB. A station's writes (shift create and open, SSCC
blocks) carry the device as the actor (`Actor::Device`), and a request a
station repeats (a create, a re-entry, a block) writes no row.
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

A forget (`clear_copies`) empties every disposable table (see below),
`floor_sign_in_failures` included, so it resets every lockout counter of the
station and of its operators, and a station on the host's PC re-pairs itself.
Whoever can reach a «Подключить заново» or «Сбросить подключение» control
(the device-rejected, other-host and config-error screens) therefore wipes
the counts; those screens are not reachable from a working floor (they come only
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

`device_forget` clears the local copies before it removes `device.json`.
Every table of `src-tauri/migrations` has a class in `TABLE_CLASSES`
(`src-tauri/src/local_db.rs`; stage 2a spec §5.2, decision 30):
`Disposable` — the copies of the host's data, `sync_state`,
`sync_quarantine` and `floor_sign_in_failures`; `DeviceData` — what the
device records itself (plans 2a5–2a8: shifts, boxes, scans, the outbox), each
row tagged with the pairing that wrote it; `Workstation` — the PC's own
settings (plan 2a7), which outlive any pairing. All 11 tables are
`Disposable` today; the other two classes stay empty until those plans add
tables. `tests/local_db.rs` fails on a table without a class and on a class
that names no table, so a plan that adds a table classes it in the same
change. The same file forbids any foreign key between local tables
(`no_table_has_a_foreign_key`): a plain key fails the forget at its `DELETE`,
and `ON DELETE CASCADE` or `SET NULL` from a kept table to a disposable one
would change this device's own records without a word.

`LocalDb::clear_copies(guard)` deletes the rows of the disposable tables
only, in one `BEGIN IMMEDIATE` transaction, and in that same transaction
first counts the outbox records without a receipt (`acked_at IS NULL`) of the
current pairing (`host_id` and `device_id`), or of any pairing while
`device.json` is unreadable; with no pairing nothing is counted. Any such
record refuses the forget with `unsent_facts` and changes nothing, until the
records are sent or a person confirms with `keepUnsent: true` (question В7);
the records stay on disk either way. An `outbox` that exists but cannot be
counted fails the forget (`storage`) and is never read as 0. No `outbox`
exists yet: plan 2a5's migration adds it (`host_id`, `device_id`,
`acked_at`), and until then the tests create a table of that shape in a
scratch database. The headers of the applied migrations `0001`–`0005` still
say that `clear_copies` takes every table; an applied migration is never
edited.

The writer runs with `secure_delete`, so a deleted row is zeroed where it
stood, and the clear ends with `wal_checkpoint(TRUNCATE)`, which moves those
pages into the file and empties the WAL that still held the frames written
before the delete: no hash of the old pairing stays in either file (`VACUUM`
would only shrink the file). That is true of the two files only: the
checkpoint frees blocks without overwriting them; the file system's free
space, SSD wear levelling and shadow copies or backups can keep old bytes (a
4–6-digit PBKDF2 PIN is cheap to brute-force); and bytes a writer freed
before it ran with `secure_delete` (a development database from before that
setting) are not scrubbed, so for that database `VACUUM` would do more than
shrink the file, and nothing here runs it. A reader holding an older snapshot
keeps the checkpoint from finishing, and the call then fails; the delete
stays committed and a retry repeats only the checkpoint
(`a_forget_fails_while_a_reader_keeps_the_wal_and_succeeds_after`).

A local database that did not open is a separate case, and the shell keeps
why it failed. Only a corrupt one is ever touched: a SQLite `Database` error
whose primary code is `SQLITE_CORRUPT` (11) or `SQLITE_NOTADB` (26), also
when a migration raises it. Any other failure — a migration this app version
does not know (the app was rolled back), a changed checksum, a busy or
unreadable file, a full disk — leaves a file that may be sound and hold
unsent records, so the forget answers `storage` and moves nothing,
`keepUnsent` or not; such a station cannot forget until the app is updated,
and a confirmed forget for it would be a deliberate extension. A corrupt
database is first read on a read-only connection, without migrations and
without writing the file (that read may create its `-shm`, which moves with
the set): if it still lists an `outbox` with unsent records the same guard
applies, and an `outbox` that cannot be counted also answers `unsent_facts`
(the count is unknown, so it fails closed and `keepUnsent` confirms it). A
file nothing can be read from holds nothing anyone could send and counts 0.
Then it is set aside, not deleted (`LocalDbState::set_aside_unopened`): it
and its `-wal`, `-shm` and `-journal` files become
`standalone-station.db.unreadable-<unix ms>` plus their suffix, so the set
stays openable together for support (plan 5), and a new database opens in its
place without a restart. A file that cannot be moved puts back the ones
already moved; a name already taken is refused (a rename would replace it
silently), and so is a set that an earlier failed put-back left split, so
every later forget answers `storage` until support puts the files together.
Each failure leaves a line on stderr (the error kind and the part of the
set, no path). The set-aside file may still hold PIN and badge hashes: the
accepted price of keeping the device's records. If clearing or moving fails,
the command fails with `storage` and the pairing stays for another try; a
refusal logs its count of unsent records to stderr.

Two windows stay by design. A fact written between the clear's commit and the
removal of `device.json` belongs to the pairing that is still current but was
not counted, so it loses its link with no confirmation: plan 2a5's forget
screen is offered only with no open shift and with the fact writer stopped.
And the records kept by `keepUnsent: true` carry the old `host_id` and
`device_id`: plan 2a5's fact sender reads only the current pairing's `outbox`
rows and must never send them to a new host. That plan also adds the
confirm control that calls `forget({ keepUnsent: true })` (today the repair
screens call `forget()` without options, so a refusal is only a message) and
shows the count with the same predicate as `unsent_records`, not a second
query. The sync's wipe for another pairing (`WIPE` in
`src/local/reference-sync.ts`) names only the copies, the quarantine and
`sync_state`, and leaves `floor_sign_in_failures` alone on purpose, because
it is no copy of the host's data and a wipe is no sign-in; no test pins that
half. A forget on Windows has never run there: the rename of a corrupt
database that was opened and closed, and a forget while another process
holds a file, need a manual check.

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
  wildcard arm, so a new role does not compile until it is placed. Shift
  writes — planning, editing, deleting and closing, which administrators and
  technologists make (stage 2a spec §4.9, `planShifts`) — check
  `require_shift_planning` and `require_shift_planning_in` the same way, and
  `auth::plans_shifts` names their roles, also with no wildcard arm.
- Device writes re-check the device the same way, right after
  `begin_write`, since the extractor read it before the request queued for
  the write lock: a station's shift create and entry and an SSCC block call
  `AuthDevice::require_station_in` (a revoked device is 401 with
  `credential: device`, one that is no station 403), and a batch of facts
  calls `AuthDevice::require_live_in` (401 for a revoked device; any kind may
  send), which `require_station_in` builds on.

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
100, both blank for none. Since plan 2a1 the host also refuses a new number
that differs from an existing one only by leading zeros (`042` next to
`0042`, which a keypad mixes up; owner question В13): `conflict` on `login`
with `similarLogin`, the number in the way. Every operator counts, a
deactivated one included; with two numbers in the way the answer names the
same number first, then the lowest. The office's form names it under the
number («Похож на занятый табельный номер 0042: …»; `similarLogin` in
`src/office/operators/operator-forms.ts`) and puts the cursor there; a
`similarLogin` equal to the number typed, or one that is no text, or none,
says the number is taken. The PIN rule, 4–6 ASCII digits, mirrors the
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
  into the field signs nobody in; its code stays in the field as text (up to
  100 characters) until the step is left, as in the cloud station. The
  scanner is given back when the field loses the focus and by a cleanup tied
  to the field's presence in `OperatorSignIn` (a layout effect on whether the
  field is shown), so a field that disappears without a blur (a sync turned
  the step into a notice, the screen left, a name was chosen) cannot leave the
  scanner deaf; `toStage` only drops the pending keys.
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
answers 204 again, and an id that never existed is `not_found`. A template a
planned shift names is not deleted (`template_in_use`, see «Shifts»).

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
The shifts' builders (plan 2a3) follow the same rule: `shiftCreate` sends
every field, `null` for no plan or no counterparty, and `mode: "aggregation"`
and `palletsEnabled: false`, so the host's defaults never decide what was
planned; `shiftUpdate` sends what differs from the loaded shift, with its
revision, and `null` only to clear the plan or the counterparty (the host reads
`null` elsewhere as «keep», and the strict `shiftUpdateSchema` refuses it
there); `shiftClose` sends the reason `closeReasonRule` trimmed, with the
loaded revision. A shift is read loosely (`officeShiftSchema`), its close
reason code as text rather than an enum, so a code a newer host adds does not
fail the list. `HostApi.listShifts` takes an optional period and
percent-encodes both ends in the query; `deleteShift` answers nothing.
The older forms (users, the organization, SSCC, sign-in and the own-password
change) build their bodies inline, field by field, as does the wizard; its
`templates`, built by `stockTemplates` since plan 1e3, are typed by the strict
`bootstrapRequestSchema`, against which `test/protocol.test.ts` parses
`bootstrap-request-templates.json`. Raise `PROTOCOL_VERSION` for an incompatible
change, a new fact kind or a new `data` field of a fact included (see Facts);
the host keeps accepting the previous version. It is 3 since plan ПЛ-Х
(pallets; 2 since plan 2a1), with `MIN_PROTOCOL_VERSION` still 1: the host
takes the stations of stage 1 and of stage 2a, and a station that knows
pallets finds a host of stage 1 or 2a too old (`host_too_old` at the probe).
`src/host/protocol.ts` mirrors it, and `test/protocol.test.ts` ties the
mirror to `hello.json`. Response types, which
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
`POST`, `PUT` and `DELETE`, paths of `[A-Za-z0-9/_.~?=&-]` without `..`, `//` or
a `.` segment, and only the routes `/v1/device[/…]` except `/v1/device/line`,
`/v1/bootstrap`, `/v1/changes` (not `/v1/changes/stream`) and `/v1/office/…`.
The line goes through `device_select_line`, which also keeps the host's answer
in `device.json`, so the station opens on its line with the host away;
`device_refresh` reads `GET /v1/device` again and keeps a line the office
changed the same way; the change stream belongs to the connection task.
`host_request` takes an optional `timeoutMs`, a whole number of 100–10 000 ms
(`request_limit` in `src-tauri/src/device.rs`, plan 2a4): outside that range it
answers `invalid_request` before any I/O, and before the pairing is looked at
(an unpaired station answers `invalid_request`, not `not_paired`).
`src/host/client.ts` checks the same whole number and range and throws the same
`invalid_request` without calling the shell: `NaN` and `Infinity` would reach
the shell as JSON `null`, which means no limit, and a fraction or a negative
number would come back as Tauri's own text, read as `unreachable`. `timeout`, a
transport code of its own, follows the caller's limit: when it ends the request
before anything else does, the answer is `timeout`, whether the request was
still connecting, in the TLS handshake, waiting for the headers or reading the
body. The client's own limits win only when they are shorter: a host that does
not accept the connection (or finish the handshake) within the client's 2 s is
`unreachable`, which only a limit above 2 s lets happen. So under a limit below
2 s, such as the 300 ms code check of plan 2a6, a host that is off, behind a
filter that drops packets or hung is `timeout`, and a refused port is
`unreachable` at once; callers treat both as "no answer". Without a limit a
request ends at the client's own limits, 2 s to connect and 10 s in all, as
`unreachable`, which is what the stage 1 screens read;
`tests/host_request_timeout.rs` pins that for a body that never ends too.
Pairing routes return a new device key, so they stay behind their own commands
(`host_local_pair`, `host_claim`) and the key never reaches the webview. `%` is
refused because an encoded `..` would slip past the route check; a `.` segment
is refused for the same reason, since the URL parser would normalize it past the
route checks. Add a route the webview needs to that list deliberately; never let
a listed prefix cover a route whose response carries a credential the webview
must never hold (a device key, a password hash, another session's token).

The webview's IPC contract — command names, argument names such as
`officeToken`, the `{ status, body }` answer and bare-string rejections — is
pinned by `src-tauri/tests/ipc.rs` through Tauri's mock runtime. Change it
together with `src/host/client.ts`, `src/host/device.ts`, `src/host/probe.ts`,
`src/host/connection.ts`, `src/local/executor.ts` and
`src/hardware/hardware.ts`.

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

## Hardware

The shell's printers, COM scanners and power request (plan 2a4, ported from
the cloud station's `printer.rs`, `scanner.rs` and `power.rs`) are reached
only through `src/hardware/hardware.ts` (`createTauriHardware`); nothing in
the app calls it before plans 2a5–2a7. `src-tauri/tests/ipc.rs` pins the
names and arguments, refusals are bare codes, and the system's own words go
to the shell's stderr only.

- `print_bytes { target, payloadBase64 }` sends a label's bytes to
  `{ kind: "tcp", host, port }`, `{ kind: "serial", port, baud }` or, on Windows
  only, `{ kind: "usb", printer }` (a spooler queue, datatype RAW,
  `src-tauri/src/printer/spooler.rs`). The work runs on a thread for blocking
  work, never on the IPC thread, with one 5 s budget to resolve a name and
  connect (an IP address needs no lookup; the addresses of a name share what the
  lookup left) and 5 s per write: the label goes out in chunks of at most 64 KiB
  (`send_all`, TCP and COM alike), so each write has its own 5 s. The payload is
  standard base64 of 1 byte to 32 MiB. It answers `null` or a bare code:
  `not_sent` (nothing left this computer: the name did not resolve, or not
  within the budget, or the connection, the COM port or the queue did not open,
  or `StartDocPrinter` refused), `outcome_unknown` (the failure came after the
  first write began: a write, a flush, `StartPagePrinter`, `WritePrinter`, a
  short write, `EndPagePrinter`, `EndDocPrinter`, or the send thread died),
  `invalid_target` (any other shape, a host with a space, port or baud 0, an
  over-long name), `invalid_payload` (not base64, empty, or over 32 MiB) and
  `unsupported` (USB off Windows). A call that omits `target` or sends a payload
  that is not a string is refused by Tauri before the command runs, with Tauri's
  text and not a bare code; the wrapper always sends both. `list_usb_printers`
  lists the installed queues (`EnumPrintersW`, local and connections), `USB…`
  ports first and none dropped, empty off Windows, and answers
  `spooler_unavailable` when the spooler does not answer (a printer added
  between its two `EnumPrintersW` calls can make it answer so, unfixed).
- `printBytes` never throws and returns `{ sent: true }` or
  `{ sent: false, code }`. An answer the shell never gives (an unknown code,
  an error object, a failed or throwing IPC call) reads as `outcome_unknown`:
  an unknown outcome must never look like `not_sent`, because only
  `not_sent` makes printing again safe. Bytes the wrapper cannot encode are
  `invalid_payload` before the shell is asked. Neither the shell nor the
  wrapper ever sends again; plan 2a7 owns one send at a time per address.
  `sent` means every byte left this computer, not that a label printed: a
  network printer sends no receipt, so a paused, out-of-paper or open printer
  that accepted the connection buffers the label and prints it later, and a
  reprint then doubles it; a spooler may take a job for a printer that is
  off. A status query before sending (ZPL `~HS`, a TSPL equivalent) is a
  language-specific decision left to plans 2a7 and `@markiro/domain`.
  Other limits, all unverified on Windows: Winsock may count the 5 s over one
  whole `send`, which is why a label goes out in 64 KiB chunks (a multi-MiB
  label to a slow printer stays on the manual list); a printer name that
  needs DNS is looked up on a helper thread and is `not_sent` once the budget
  is spent, but the thread stays until the system's resolver gives up (prefer
  an IP address); a silent first address takes the whole connect budget; a
  spooler job is still ended
  after a failed write, so a half label can reach the printer (whether to
  abort it instead is an owner question); and a COM flush or a trickling
  printer keeps the webview's call pending, so plan 2a7 needs its own limit
  on the awaiting side that answers `outcome_unknown`.
- `configure_scanners { scanners: [{ port, baud }] }` replaces the whole set
  of COM scanners. The argument is read as JSON, so a missing or misshapen
  one is `invalid_scanners` too, and so are more than 32 scanners, a name of
  0 or over 256 characters or with a control character (NUL included), a
  baud rate of 0, and one port twice; a `COM<digits>` name is upper-cased
  first (`com3` is `COM3`, but `\\.\COM3` is another entry that cannot
  open, so names should come from `list_serial_ports`). All of it is checked
  before anything changes. One thread per port opens it (200 ms read
  timeout) and opens it again 2 s after a loss; ports that stay keep their
  connection and a half-read scan. `close_scanners` closes every port, a
  poisoned lock included, and closing twice is no error.
- A scan is a frame between CR or LF (CRLF, LFCR and runs count once; an
  empty frame is skipped). A frame of up to 4096 bytes is a scan, decoded as
  UTF-8 with replacement and never trimmed; a longer one is dropped whole
  through its terminator (the cloud station's copy emits the tail of such a
  frame as a scan; `apps/station` was not touched). A scanner must therefore
  be set to send a CR or LF suffix: without one its scans merge until 4096
  bytes and are dropped, and the only trace is a stderr line. A frame cut by
  an unplugged cable is dropped without a trace, the first frame after a
  port opens may be the tail of a scan, and noise before a scan is merged into
  it. A scan with U+FFFD in it was not valid UTF-8: consumers (plans
  2a5–2a7) must read it as unreadable, never as a badge or an identity to
  enrol. The GS byte and an AIM prefix (`]d2`, `]C1`) arrive untouched:
  `@markiro/domain` reads them.
- Scans arrive as the event `standalone://scan` (the raw text) and every change
  as `standalone://scanner-status`
  `{ revision, scanners: [{ port, baud, status }] }`, `status` being `connected`
  or `disconnected`. `revision` grows by 1 with each published change, and every
  `configure_scanners` publishes, even an unchanged set;
  `get_scanner_connections` answers the latest snapshot, so `watchScanners`
  subscribes first, asks second and keeps only a newer `revision` (the first
  snapshot of a fresh app is revision 0 with no scanners). The wrapper's schemas
  are strict and it ignores an event they refuse without a word, so a field
  added to the snapshot must change the shell and `scannerSnapshotSchema`
  together: `tests/hardware_shapes.rs` and `test/hardware.test.ts` both read
  `tests/fixtures/hardware-shapes.json`, so a drift between the two sides fails
  a test. A scan emitted while the webview is reloading or not listening is
  lost; a status is recovered by asking. `list_serial_ports` names the system's
  ports or answers `serial_unavailable`.
- `set_system_awake { awake }` holds one Windows power request (display and
  system required) while `true`, and nothing off Windows; `true` twice holds
  one request, `false` always lets go, a poisoned lock included, and a
  refused request answers `power_request_failed` and holds nothing, so the
  next `true` tries again. Dropping the state releases the request; at exit
  Tauri ends the process without dropping it, and Windows closes the handle
  with the process (unverified). The request survives a webview reload, so
  plan 2a7 calls `setSystemAwake(false)` once when the webview starts; it is
  idempotent and never fails.
- `run()` manages every state through `manage_state` in `setup`: the device,
  the local database, the connection status, the scanner manager, kiosk mode
  and the awake lease. The mock runtime does not run `setup`, so
  `tests/ipc.rs` calls `manage_state` on a mock app and checks that all six
  are there and that `get_scanner_connections` and `set_system_awake` answer,
  and a line deleted from it fails that test. The other mock apps manage
  their own states, a pre-paired device or no database among them.
- Wrapper failures other than `printBytes`: `HardwareError` with a `code`
  from `HARDWARE_ERROR_CODES`: the shell's `invalid_scanners`,
  `serial_unavailable`, `spooler_unavailable` and `power_request_failed`,
  `invalid_response` when an answer fails its schema, and `unknown` for
  anything else, including a failed subscription. Screens choose text by
  code; the message names the command.

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
  device or sets its line (`lineId: null` clears it; only a station's, only an
  active line; re-sending the line the station is already on keeps it, even if
  that line has been archived since, so a full-form save can still rename the
  station). Devices have no `rev` and are not in the feed, so the last office
  write wins. A change of a device's line takes one host revision without a feed
  item, so open streams wake and the station reads `GET /v1/device` again
  (`device_refresh`, see "App shell"); a rename, a repeat of the same line and a
  revocation take none. How a line change meets a running shift is plan 2a's
  decision; stage 1 has only the floor stub. The station keeps the name the host
  has for it in `device.json` (`deviceName`, and `DeviceStatus.deviceName` in
  the webview): the name it paired under, without the padding the host strips,
  then whatever `device_refresh` and `device_select_line` read from
  `GET /v1/device`. It is `null` in a file written before plan 2a4, and a failed
  refresh keeps the stored name, as does a refused key (`tests/line.rs` checks
  the name in memory and in `device.json` for both). A rename in the office
  takes no host revision, so it reaches the station with the next revision or
  reconnection. The file format change is one way: `DeviceConfig` rejects
  unknown keys, so a shell from before plan 2a4 reads a file that has
  `deviceName` as `config_unreadable` and the station must pair again; this
  shell reads an old file and writes the name at the first refresh that finds
  one. The product is unreleased.
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
the office closes («Выйти в цех») and when the session ends (below: when a
call to the host finds it expired). That covers every screen that is not the
office, the first-run wizard and the repair screens (pairing, host not found,
pairing failed) included: on a fresh install, or while the host service is
down, nothing inside the app leads out of the locked window until setup is
finished and an administrator signs in.

Kiosk mode locks EVERY PC that runs the app, not only the floor's stations:
whenever no office session is open, the host's own PC and a PC used only for
the office are behind the borderless, topmost, unclosable window too, and a
technologist cannot leave it (only an administrator can). Stage 1 always pairs
the app as a station (`DeviceKind::Station` in `device.rs`; `DeviceKind::Office`
exists in `proto` and nothing uses it), so the app has no way to tell a floor
station from an office PC. This is the plan's decision («whenever no office
session is open»), not a choice the owner made, and it is an open owner
question to settle before the Windows trial at a customer, where someone will
install the app on the host's PC. Options: accept it; lock only a window that
is a floor station (for example only once the device has a line, or leave the
line-selection screen unlocked); a per-device kiosk switch the administrator
sets in «Устройства» (host, `proto` and `device.json` change); a local
«office PC» flag in `device.json` set by an administrator.

An office session opens with the window still locked; the way out is «Оконный
режим» (`src/office/WindowModeButton.tsx`, in the office header), shown only
to an administrator while the window is locked and never in a build that does
not lock it. It asks first (`FormDialog`), reads the user from the host again
(`GET /v1/office/me`) and opens the window only if the host still says
administrator; if the role was taken away meanwhile, it says so, refreshes
the user and does not open the window. After a demotion the dialog simply
goes with the button once the refreshed role lands: the header shows the
technologist role, and the message is on screen for one round trip only.
After a successful exit the focus moves to the office page (the button that
held it is gone; `OfficeShell` hands `WindowModeButton` a callback that
focuses its `main`). Leaving the office locks the window again; a role taken
away after the window opened does not lock it before the session ends. The
window mode lasts until a call to the host finds the office session expired
(a page's request, or the header's re-read of the user after a change-feed
revision): the webview has no client idle timer, and the host drops the
session after 30 idle minutes without telling it. An administrator who walks
away from an open office therefore leaves the window framed and closable, with
the office on screen, for anyone on the floor (an open owner question: a
client-side office idle lock on a station PC). Non-administrator office
users (technologists) work in the locked window too, so the template import's
file chooser and the ZPL/TSPL `<a download>` saves open under a borderless
topmost window; their behaviour there is unchecked. There is no local
maintenance code (one more secret on the PC; an owner question). Without the
host nobody signs in to the office, so the app cannot leave kiosk mode then:
Windows' own Ctrl+Alt+Del stays, and Tauri catches neither it nor Alt+Tab or
the Windows key (the window stays on top, so Task Manager may open underneath
it). A failed enter is logged by the command's name and tried again at the
next office close or restart; nothing on screen says so.

The trust boundary of the exit is the webview's: the administrator check lives
in `App` and `WindowModeButton`, and `exit_lockdown` itself has no guard in
the shell. The shell trusts its own bundle. App commands are not
permission-scoped (`build.rs` has no app manifest; `capabilities/default.json`
gives window `main` only `core:default`), but there is one window, the CSP is
`default-src 'self'`, and release builds have no devtools (the `tauri`
features are empty), so only a script of the app's own bundle can call the
command. An operator has a touch screen and a scanner, with no URL bar.

The device-rejected, other-host and config-error screens show in kiosk mode
too, with «Подключить заново» and «Сбросить подключение»: that forget empties
the copies and the lockout counters with them (`clear_copies`). Those screens
come only when the host refused the device or its config is unreadable, which
nobody produces from the floor, and a station on another PC pairs again only
with an administrator's code; a station on the host's PC pairs again on its
own (loopback trust), so there the counters start from zero after such a
forget (an owner question: what to do about those buttons in kiosk mode).
Guarding them «to the office only» cannot work: a rejected device cannot open
an office session (the host refuses its key), and a config error leaves no
device config to call the host with, so the station could never be repaired.
The realistic options are to keep them reachable (the current state) and to
keep the lockout counters out of what `clear_copies` empties, so a forget does
not reset them; the second would be one change with making the buttons 64 px.
The buttons of these shell screens are of ordinary size, not 64 px, although
kiosk mode shows them on the station.

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
  shows it to them alone, between «Смены» and «Устройства». It lists every
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
  current line stays on the list even when archived. A station that works on
  an active shift may be moved all the same (owner question В9, option А;
  nothing refuses it): the dialog reads `GET /v1/office/shifts` when it opens,
  for a station only, finds the active shift the station opened
  (`stationShift`: `ownerDeviceId`), and once another line is chosen, an
  empty one included, says in a live region that the station finishes its
  work, signs the operator out and shows the new line's shifts, or, when
  «Не выбрана» is chosen, asks for a line (two texts, chosen by
  `watch("lineId") === ""`), and that the shift stays open, to be closed on
  «Смены». The sentences promise what the station does from plan 2a5 on
  (decision 28). When the shifts do not load the dialog is
  silent: no warning, no alert, and the station still moves (a small note «не
  удалось проверить смены» is left to the owner). A revoked device
  is a dead record and offers no controls; revoking asks first, names the device
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
- «Смены» (plan 2a3; section «Производство», after «Линии») lists what
  `GET /v1/office/shifts` sends, in the host's order (newest production date
  first); both roles read it. A row shows the number, the production date
  (`08.10.2026`), the line, the product with «для: …» and the counterparty
  under it, the mode as a word on a category tag (the cloud's tones:
  aggregation teal, validation violet), the plan («—» for none; thousands
  apart, `Intl.NumberFormat("ru")`) and the status as a phase (a closed shift
  as done), then «Выпуск»: for an active or a closed shift the codes in closed
  boxes and the closed boxes of its `totals` («540 шт · 45 кор.», the cloud's
  `containedUnits` and `closedBoxes`), «—» for a planned one; the column
  follows the status so the columns before it keep their places. Every
  `OfficeShift` carries plan 2a2's required `totals` (`shiftTotalsSchema`, six
  fields; fixture `proto/fixtures/office-shift.json`, read by the Rust fixture
  tests and by «response fixture office-shift.json» in `test/protocol.test.ts`).
  «Итоги» on an active or a closed row, for every role (the writes stay
  `planShifts`), opens `ShiftTotalsDialog`, which reads `GET …/{id}`
  (`getShift`, `officeKeys.shift`) at every opening, since the totals change
  without a revision: the plan, «Принято кодов» (`acceptedUnits`), «Кодов в
  закрытых коробах», the closed and open boxes, «Последние данные со станции»
  (in the organization's zone, or this PC's with a note while the profile does
  not load or names a zone the PC lacks; the zone is fixed when the figures
  first show) and the shift's devices, named from `listDevices` for an
  administrator (a revoked one marked «(отозвано)») and by the first eight
  characters of the id for a technologist, for an id the list lacks or while
  the list does not load, with a note saying why. The full card of a shift is
  stage 4. A shift carries ids,
  so the page names them from `listProducts`,
  `listLines` and `listCounterparties`, an archived record marked «(в архиве)»,
  and one a list lacks or that did not load by the first eight characters of
  its id («Товар 5e6f7081…»). A lookup that fails leaves the list in place with
  one warning (names that are missing are shown by the start of their codes,
  and the marks of shifts that will not open may be missing) and «Повторить»,
  which reads again only what failed; the retry of a failed list of shifts
  reads the failed lookups too.
- A planned shift a station will refuse to open is marked from the page's own
  lists (`openBlocker`, `src/office/shifts/shift-list.ts`): its product
  archived or a draft (`product_inactive`), or its template switched off,
  narrowed or of another group (`template_not_fit`, by `templateFitsSlot` for
  the product's group). While a list it needs is not loaded, or lacks the
  record, nothing is claimed; an archived line does not stop an opening and is
  not marked. A closed shift says why: the office's words («Закрыта в офисе:
  …») or a station's code in words («Причина расхождения: …»; a code a newer
  host adds is shown as it is); late data is an attention tag.
- The search (the number or the product's own name, without case: neither the
  «Товар …» placeholder nor the «(в архиве)» mark that stand in for a missing
  or archived product's name are searched), the
  status and line filters and the pages of 25 (`SHIFT_PAGE_SIZE`, the shared
  `OfficePager`, which «Товары» uses too) work in the page; a new search or
  filter goes back to the first page. Without a period the page shows the
  host's own list and says what it holds. Two date fields (`@markiro/ui`'s
  `DatePicker`) ask for a period of production dates, both ends included, and
  a request goes only once both are set (`periodState`): the period does not
  end before it starts and is at most 366 days (`MAX_PERIOD_DAYS`), which
  bounds what one request reads. While the period is half set or wrong the
  list shown stays and a note or an error under the second field says why.
- Both roles plan and change shifts (`useCan("planShifts")`). «Запланировать
  смену» opens a dialog that waits for the organization's profile and starts
  the production date as today in its time zone (`civilToday`); when the
  profile does not load, or names a zone this PC does not know
  (`isKnownTimeZone`), the date is this PC's and the field says so; the date
  and that note are fixed when the dialog opens, so a later read of the profile
  cannot put a note under a date that did not change. The
  product offers what is in use (active, not archived) by name with its GTIN,
  and choosing one sets the box capacity and the template from it
  (`suggestBoxTemplate`: the product's preference, the category's box default,
  the organization's, the first that fits; none, and the person chooses); it
  also clears an earlier refusal of those two fields. The template offers what
  fits the product's group and has no «Не выбран»; the line offers active
  lines; the counterparty is optional. When the template defaults do not load,
  a note under the template says it comes from the product alone. While a write is on its way every
  control of the dialog is off. A refused field takes the focus, the first in
  the form's order (`SHIFT_FIELD_ORDER`), the selects and the date included.
  A record refused on a select (`product_inactive`, `validation_failed` on
  `lineId`, `boxTemplateId`, `counterpartyId`, `productId`) goes under it, and
  that record's list is read again; the form's own product, line, counterparty
  and template stay offered as a marked choice («(в архиве)», a product also
  «(черновик)»), so the select shows the record the host refused rather than
  another one, and the person picks another. The counterparty is never cleared
  to «Не выбран» on the person's behalf: a resend would plan a shift without
  the counterparty that is printed on the box label. A lost answer to a create
  reads the lists of shifts again, since the host may have planned the shift.
- A row's actions follow its status. A planned shift has «Изменить»: the same
  dialog on the shift's own values, the product shown as text because it never
  changes, its own line, counterparty and template kept as marked choices when
  archived, switched off or narrowed, and only what differs sent
  (`shiftUpdate`); an edit that changes nothing closes the dialog and sends
  nothing, and a refusal on `productId`, which this dialog has no control for,
  is the dialog's alert. A planned shift also has «Удалить» (asks first,
  `destructive`; a `not_found` is taken as deleted). An active shift has
  «Изменить план» (the plan alone, blank clears it) and «Закрыть»
  (`destructive`): a reason of 3–500 characters counted in code points as the
  host counts them (`closeReasonRule`), sent trimmed with the loaded revision;
  a line break is a control character, so Enter writes none (the hint says
  «одной строкой»; an Enter that confirms an input method's word is left alone)
  and a pasted one is refused with `rules.controlCharacter`, nothing sent. A
  closed shift has no action.
- Every change and close sends the opened row's revision; a delete sends none
  (the host takes no `expectedRev` on `DELETE`, only the status), so it removes
  a planned shift whatever was changed in it meanwhile, and a create has no
  revision. A saved write says so, the notice takes the focus (the dialog is
  gone, and so may be the row's button), and every list of shifts is read
  again (`officeKeys.shifts`, whatever the period). `stale_revision` offers
  «Загрузить заново», which closes the dialog and reads the list again. The
  host checks the revision before the status, and every open or close of a
  shift takes a new revision, so a change or a close of a shift that a station
  opened or someone closed meanwhile comes back as `stale_revision`, not as
  `shift_status`. The own-words alert (`shiftWriteFailure`: `shift_status` with
  its `details.status`, and `not_found`; a create's `not_found` is not one of
  these) is therefore what a delete of a shift opened or closed meanwhile gets
  (`shift_status`; a delete takes `not_found` as done), and what a change, a
  plan change or a close of a shift deleted meanwhile gets (`not_found`); those
  dialogs keep the `shift_status` branch in case a later host orders its
  checks differently. The list is read again behind the dialog, and the save
  button stays off, since a resend would be refused the same way, until
  «Загрузить заново» closes the dialog. After a lost answer (a transport
  failure) all four dialogs read the lists of shifts again, since the host may
  have done the work; a refusal of the host leaves them alone.
- Known gaps of the page, not closed by plan 2a3: the calendar of
  `DatePicker` is portalled out of the dialog, so Tab from its last button
  leaves the dialog (Escape is held back in `ShiftDialog` by
  `keepCalendarEscape`, a workaround: the cause is `@markiro/ui`'s `Modal`, and
  `packages/*` is not this plan's); a resend after a lost answer to a create
  can plan a second shift: the create has no request id (plan 2a1's design),
  the dialog stays open with «Нет связи с хостом…» and the list behind it is
  read again, but nothing asks the person to look at that list before
  pressing «Запланировать» again, and a duplicate can be deleted though its
  number is spent (a create-specific text such as «ответ хоста не пришёл:
  проверьте список смен за окном» waits for plan 2a4's `timeout` code, which
  decides what a lost answer is); a server-side page of `GET /v1/office/shifts`
  does not exist, and the 366-day bound stands in for it (a carry to a host
  plan); a change or a close of a shift opened meanwhile says the generic
  «Данные изменились…» rather than that the shift is now active, since the
  host answers `stale_revision`.

## Shifts

Stage 2a (`docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`;
plan 2a1 built the host's side). The host numbers a shift: a counter per
month of its production date (`shift_number_counters`), `MONYY-NNN`
(`OCT26-004`), with `/S` for a shift a station created — the domain's
`shiftMonthKey` and `formatShiftNumber` rewritten in `host/src/shifts.rs`.
`proto/fixtures/shift-numbers.json` holds the cases both must answer alike;
`host/tests/shift_numbers.rs` and `test/shift-numbers.test.ts` read every
one, so changing either rule means changing the fixture. A production date is
a civil date `YYYY-MM-DD` of the years 1–9999, as the cloud's
`civilDateSchema`; the domain's month key alone also reads the year 0000 (its
`Date.UTC` takes the years 0–99 as 1900–1999), so the fixture leaves that
year out. A number is drawn once, when the shift is created: an edit of the
production date keeps it, and a deleted shift's number is not drawn again.

The office plans a shift (`POST /v1/office/shifts`; migration
`0009_shifts_sscc_blocks.sql`): an active product that is not archived (a
draft or an archived one is `conflict` on `product_inactive`, an unknown one
`validation_failed` on `productId`), an active line, a counterparty in use or
none, a box template that fits the product (`templates::fits`: enabled, of
the box purpose, covering the product's group), the production date, a box
capacity (the product's when left out; at most `MAX_BOX_CAPACITY`) and a plan
or none (at most `MAX_PLANNED_QTY`, 10 000 000). `mode` is the cloud's shape;
only `aggregation` is taken (`validation_failed` on `mode` otherwise), so
stage 3 needs no new shape. A shift with pallets (`palletsEnabled`, plan
ПЛ-Х, migration `0012_pallets.sql`) names a pallet template that fits the
product (`templates::fits` for the pallet purpose; `validation_failed` on
`palletTemplateId` otherwise, a missing one included) and a pallet capacity of
1–`MAX_PALLET_BOX_CAPACITY` (10 000; the product's when left out); a shift
without pallets sends neither field (`validation_failed` on the one it
sends). `OfficeShift` names `palletBoxCapacity` and `palletTemplateId`
exactly when `palletsEnabled`, which two triggers of `0012` hold in the
table. Every office role reads shifts (`GET /v1/office/shifts`, `GET …/{id}`);
administrators and technologists write them (`planShifts`, «Writes»). The
list without a period holds every planned and active shift and the closed
ones produced in the last 31 days of the host's clock (UTC); `?from=&to=`
(either may be left out) every shift produced in the period, both ends
included; newest production date first. A shift is no feed record, but every
change of one takes a host revision, stamped on its `rev`, with no feed item,
so open streams wake and stations read their shifts again. `OfficeShift`
carries ids, not names: the office names products, lines and counterparties
from its own lists. The office's page is «Смены» (plan 2a3, «Office pages»);
it bounds a period to 366 days, since the host's list has no paging and one
request reads the whole period.

An edit (`PUT …/{id}`, with `expectedRev`) changes only what it sends: a
planned shift every field but its product, which is no field of the request;
an active one only its plan, which neither its label nor its snapshot shows
(another field sent with another value is `conflict` on `shift_status`, with
`details.status`); a closed one nothing. A line, a template or a counterparty
that changes is checked as at planning (a changed template also needs the
product still in use); one that stays is kept even if it was archived,
disabled or narrowed since, and the station's opening refuses it then
(`template_not_fit`). `plannedQty: null` and `counterpartyId: null` clear
them. A planned shift turns pallets on (with a pallet template; the
product's capacity unless the edit names one) or off, which clears the
capacity and the template (sending either then is `validation_failed`);
pallets that stay on keep what the edit does not send, a pallet template
disabled since included, and a changed template is checked. An open shift
keeps its pallets (`shift_status`). Only a planned shift is deleted
(`DELETE …/{id}`, 204; an open or a closed one is `shift_status`); the delete
takes a revision with no row left to
stamp, and a delete repeated after a lost answer is `not_found`. A template a
planned shift names, for its boxes or its pallets, is not deleted (`conflict`
on `template_in_use`, with `details.shiftIds`), since the shift prints with it
once a station opens it;
an open or closed shift has the layout in its snapshot. Disabling or narrowing
such a template is not refused: the shift then does not open, and the office
sees why.

A station reads its shifts with the device key (`GET /v1/device/shifts`;
the shift routes of a device are a station's, and another kind of device is
`forbidden`): the planned and active shifts of its line, and the shifts it
entered that are active or closed within 30 days, by production date; a
station without a line sees only the latter. It reads them when it reads its
device record (after it subscribes to the link and after every revision
event), not through the feed: shifts are per line, and an open one carries a
layout of up to 256 KB. A shift's product name and GTIN and its
counterparty's name are the snapshot's once it is open and the records' before
(the station keeps no copy of counterparties); `ownerDeviceId` names the
station that opened it, and another station's id means the shift is busy. A
station creates a shift on its own line while the host answers
(`POST /v1/device/shifts`), under the office's rules; a station without a line
is `conflict` on `shift_line`, and a line is no field of the request.
`requestId`, a lower-case hyphenated UUID the station made up
(`validate::client_uuid`), makes the create repeatable: the same request of
the same station answers the shift it created, whatever its body says now,
with no revision and no audit row, while that shift exists: shifts keep no
tombstones, so a retry after the office deleted it plans a new shift. Every
device route of stage 2a lives under `/v1/device/…`, which `host_request`
already lets through, and none returns a secret.

A station on the shift's line enters it (`POST /v1/device/shifts/{id}/enter`).
A planned shift opens: the host checks its product (`product_inactive`) and
its template (`template_not_fit`) again, freezes the snapshot
(`ShiftSnapshot`: the product's id, GTIN, names, group and shelf life; the box
template's id, name, revision and whole layout; the issuer prefix of the
organization's GLN; the counterparty's name), makes the station the shift's
owner, adds it to `shift_participants` and takes a revision, so the line's
other stations see the shift busy. The owner enters again with no revision and
gets the same snapshot back, so a station that lost its database recovers it;
a change of the catalog, the template or the GLN never changes it. A closed
shift is `shift_status` for every station, a shift of another line (or a
station without one) `shift_line`, a shift another station opened
`shift_busy`: stage 2a puts one device on a shift. The snapshot is at most
320 KB (a `CHECK` of `0009`), and the host never checks its layout: the station
does, with `labelTemplateSpecSchema`, when it enters. The opening writes
`shift.open`; a second device's first entry (`shift.enter`) comes with plan
2b, since in stage 2a a station's first entry is the opening.

The create and the enter, like the block issue, read the device again inside
the write transaction (`AuthDevice::require_station_in`, first after
`begin_write`): a station revoked while its request waited for the write lock
gets 401 `credential: device`, so a revoked station neither leaves a stray
plan nor becomes the owner of a shift that every colleague on the line would
then find busy. A device that is no station is `forbidden`.

The table holds the lifecycle itself (two `CHECK`s of `0009`): a planned shift
has no snapshot, opening or owner; an active or a closed one has all three; a
closed one has `closed_at`, `closed_by_kind` and `closed_by`, any other has
none of them. A writer that sets only part of them fails with a database
error, so a station's close (plan 2a2) writes its three columns together.
`close_reason_code`, `close_reason_text` and `late_data_at` stay free: that
`close_reason_code` is one of the six codes, that `close_reason_text` comes
only from the office and that `late_data_at` follows a close are held by the
writers (the office's close route, `facts::close_shift` and `mark_late`),
each pinned by exact tests. They are not triggers: a trigger would repeat the
six codes in SQL, need its own parity test against `shift_close_reasons::ALL`
and add churn to `0010` for no new protection (a rebuild `CHECK` is ruled out
by the foreign keys to the table). Reopen the decision if a third writer of
these columns appears; the legacy import writes none. A
SQLite `CHECK` changes only by rebuilding the table, so these are not edited
lightly. The stored snapshot outlives the host that froze it, and the owner's
re-entry reads it through `ShiftSnapshot`: a field added to the struct later
is an `Option` with `#[serde(default)]`, or the shifts opened before cannot be
entered again.

The audit rows of this part are six, all `ok`: `shift.create` (an office user,
or a station as the device; target `shift`, details `{ number, productId,
lineId, productionDate }`), `shift.update` (an office user; the update details
of `lineId`, `productionDate`, `boxTemplateId`, `boxCapacity`, `plannedQty`,
`counterpartyId`, `palletsEnabled`, `palletBoxCapacity` and
`palletTemplateId`, no row when nothing changed), `shift.delete` (an office
user; `{ number }`), `shift.open` (the station; `{ number, templateId,
templateRev }`), `shift.close` (an office user; `{ reason }`) and
`sscc.block.issue` (a station; target `sscc_block`; `{ issuerPrefix,
extension, fromSerial, toSerial }`). A refusal writes none.

The office closes an active shift (`POST …/{id}/close`, `{ reason,
expectedRev }`, administrators and technologists), for a station that died or
a shift nobody will finish: the reason is words, 3–500 characters without
control characters (`validate::close_reason`), kept in `close_reason_text`; a
planned or a closed shift is `shift_status`. The close writes the audit row
`shift.close` with the details `{ reason }` (the trimmed text). The refusals
come in the order of `PUT`: a bad reason is 400 even for an unknown id, then
the lookup (404), then a stale `expectedRev` (`stale_revision`), then
`shift_status`. A station's close is a fact (plan 2a2) with one of the
domain's six reason codes in `close_reason_code`, and the facts of a shift the
office closed are taken and marked late.

SSCC blocks: a station asks for a block of serials
(`POST /v1/device/sscc/blocks`, `{ requestId, issuerPrefix, extension }`,
stations only) when it has none for its shift's prefix or its newest is half
used (plan 2a6). Stage 2a issues box blocks only (`validation_failed` on
`extension` otherwise), of a prefix that has a counter (`validation_failed` on
`issuerPrefix` otherwise). A block is the counter's next `site.box_block_size`
serials (2000 by default, «SSCC → Размеры блоков»), fewer at the end of the
prefix's serials, and then `sscc_exhausted` (409, with the prefix and the
extension). The counter moves past the block with a new revision in the same
transaction, so every issued serial lies below its counter, `sscc_below_floor`
keeps it from being issued again, and a counter form opened before the issue
meets `stale_revision`. The same `requestId` of the same station answers the
same block, even after others were issued, but only for the same prefix: the
id with another `issuerPrefix` is `validation_failed` on `requestId` and
writes nothing. A correct station keeps the prefix beside the id and repeats
its request whole, so a mismatch is its mistake, and the old block's serials
must not be filed under a prefix they were not reserved for (a shift create
is lenient the other way, since a station reads that shift from the answer;
the extension is 0 on both sides until plan 2b). The device is read again
inside the write transaction (a station revoked while the request waited
gets 401). A block's use (`consumed_through`) comes with the facts of plan
2a2; revoking blocks and showing them per device with plan 2b. A counter the
last block moved past its last serial (`nextSerial` above `maxSerial`) shows
on the office's «SSCC» page, a box counter and a pallet counter alike, as
«Номера закончились», with no change offered: no number could be valid there
(`isExhausted`, `src/office/sscc/counter-kind.ts`).

## Facts

Stage 2a, plan 2a2 (`host/src/facts`). A station sends what happened on the
line as facts, and the host keeps them. The rules the host and the webview
must answer alike live in `host/src/facts/rules.rs`, each pinned by a
fixture both read (`host/tests/fact_rules.rs`, `test/fact-rules.test.ts`):
the digest of a box's members (`box-digest.json`, the domain's
`boxMembershipDigestV1`), a device's instant (`device-instants.json`: exactly
what `Date.toISOString` writes, `YYYY-MM-DDTHH:MM:SS.sssZ`, 24 characters, so
comparing the stored text orders the instants) and when a station's close
needs a reason (`shift-close-reasons.json`, the domain's six
`SHIFT_CLOSE_REASON_CODES` and `shiftCloseReasonRequired`) and how the first
17 digits of an SSCC name its extension, prefix and serial
(`sscc-serials.json`, `rules::names_serial`, built by the domain's
`buildSscc`; the check digit is never read). The codes of a
rejected receipt (`proto::receipt_codes`, `fact-receipt-codes.json`) and the
reason codes of box exceptions (`proto::exception_reasons`,
`exception-reasons.json`) are fixtures too; the webview reads them with the
facts sender (plan 2a6) and the exception screens (plan 2a8).

A device sends facts in batches (`POST /v1/device/facts`, `{ records }`,
1–100 records, `validation_failed` on `records` otherwise; migration
`0010_facts.sql`). Any device kind may send, but only a device that entered
the shift — a station, in stage 2a — gets past `not_entered`. The batch is
one `BEGIN IMMEDIATE` transaction, and each record is read from its own JSON
value (`facts::receive`), so a record the host cannot read is answered
`rejected` with `invalid_record` and the others are applied. The answer is a
receipt per record, in their order: `accepted`, `conflict` (with
`details.winner`) or `rejected` with a code of `receipt_codes`
(`details.field` names the field an `invalid_record` broke). A record with a
readable id (a canonical UUID the device made up) keeps its receipt for good
in `fact_receipts`, keyed by the device and the id, with the SHA-256 of the
record's compact JSON (`rules::record_digest`): the same record sent again
gets the same receipt, and other content under the same id
`payload_mismatch`, which is kept nowhere. A record without a readable id
keeps nothing, and its receipt has `id: null`. Every record names a shift
that exists (`unknown_shift`) and that the device entered (`not_entered`),
and an operator by a UUID or `null`, kept as evidence without a foreign key.
A record is checked whole before its first write, so a refusal leaves
nothing but its receipt; a database error is no receipt, it fails the batch
(500, `internal`; the log names the device and the record's position in
the batch, see Logs), and the device sends the batch again. A body over
axum's 2 MiB limit is `validation_failed` (400) like any unreadable body, not
413: a station caps a record at 16 KiB, so 100 records fit, and a 400 on a
well-formed batch can only be a host bug (the station sends the same batch
again). What a batch writes (`received_at`, `displaced_at`, `detected_at`, the
late mark) carries the host's clock read once the batch holds the write lock
and has re-read its device, not the moment it arrived, so a batch that waited
behind the office's close of its shift is stamped after that close. Facts are
production data: they write no audit row and take no revision, but for a
station's close of its shift and a closed shift's first late fact (below).
A new fact kind, or a new field in a kind's `data`, raises `PROTOCOL_VERSION`:
an older host answers the unknown kind or field `invalid_record`, and that
receipt is kept for good.

A `scan` (`facts/scan.rs`) is a journal row (`scans`) whatever its verdict;
an `invalid` one keeps no code, only what it looked like (`rawKind`) and its
length, since it may have been a badge. An `ok` one carries the GTIN the
snapshot froze (`gtin_mismatch` otherwise) and a box of this device in this
shift: an unknown box id opens the box, another device's or another shift's
is `box_unknown`, a closed one `box_closed`. Its code goes to the registry
(`code_owners`, `facts/registry.rs`): the earliest accepted scan since the
code was last freed owns it whatever order the scans arrive in, compared by
their device instants to the millisecond. After an exception released the
code the next scan to ARRIVE owns it, not an earlier displaced item or
conflict loser (re-electing the earliest remaining claim is plan 2b). A
scan earlier than the owner takes the code, and the owner's item leaves its
box (`box_items.displaced_at`); a later one, or one at the same instant, is
`conflict` with `details.winner` (`CodeOwner`, `sameDevice` when the owner
is the sender's own scan). Both write a `code_conflicts` row; telling the
displaced device and the office's review come with plan 2b.

A `box_closed` (`facts/box_closed.rs`) closes a box of this device in this
shift (`box_unknown` otherwise) with an SSCC of 18 digits whose first 17 are
the box extension `0`, the snapshot's issuer prefix and `serial` (the check
digit is the domain's, never checked here), where `serial` lies in the block
`blockId` that the host issued to this device for that prefix and did not
revoke (`sscc_not_issued`), and no other box carries the SSCC or is closed
on this serial of this block under any check digit (`sscc_taken`: one serial
is one label; backed by the unique indexes on the SSCC and on `(block_id,
serial)`). A box already closed with the
same SSCC is the same close sent again (accepted, nothing written); with
another, `box_already_closed`. The close keeps the station's `openedAt`,
`closedAt`, count, digest and operator, raises the block's
`consumed_through` to the highest serial closed (boxes may close out of
order), and compares the station's `membershipDigest` with the digest of
the box's live items (neither removed nor displaced), keeping the result in
`digest_matches` for the shift's card (stage 4): a mismatch refuses
nothing. It is computed once, at close: later exceptions or displacement
change the items without recomputing it, so a report recomputes from the live
items and shows no match for a box taken apart.

A `box_label` (`facts/box_label.rs`) records the check of a closed box's
label (`box_state` for an open one): `verified` sets `print_verified_at`,
`skipped` `print_skipped_at`, each to the station's instant (a reprint and a
second check set them again). A `box_exception` (`facts/exception.rs`) has
the fields of its kind as the cloud's (`box_exceptions_kind_payload_check`):
`undo` names the code and its scan's instant, `clear` nothing, `reprint` and
`disassemble` a reason code of `exception_reasons` for their kind, with
words (`validate::exception_reason_text`, trimmed, 1–200 characters) only
for `other`. `undo` and `clear` take an open box, `reprint` and
`disassemble` a closed box not taken apart (`box_state` otherwise). The
items taken out get `removed_at` (the station's instant): an undo takes the
live item of its code in this box that was added at exactly its
`targetScannedAt` (none when that scan lost the code, the code sits in
another box, or the code was scanned again since: the exception is still
kept, `accepted`); a clear takes the live items added up to its own
`occurredAt` (inclusive, canonical text comparison), never one scanned
after it; a disassembly takes every item. So an exception sent again late
(a new id) never takes out a code scanned after it, and the station's
undo and clear records must carry the exact `targetScannedAt` and
`occurredAt` of the scan and the moment they refer to. The codes of
the items taken out leave the registry (`registry::release`, scoped to the
item's own scan), free for another scan; a disassembly sets
`disassembled_at` and the box keeps its SSCC, which no other box takes. A
reprint changes no state. An item an exception took out never comes back;
an item an earlier scan displaced is not taken out by an exception of its
box (it is no longer in the box). One exception row per record, kept with
the record's shift, device and operator.

A `shift_closed` (`facts/shift_closed.rs`) is a station's close of its
shift, the summary it showed (`plannedQtySnapshot`, `actualQty`,
`closedBoxCount`) and a reason code of `shift_close_reasons`, required when
the plan it saw was set and differs from the fact
(`rules::close_reason_required`; `invalid_record` on `data.reasonCode`); a
reason the plan did not call for is kept, as in the cloud. An active shift
closes: `status = closed`, `closed_at` the station's instant in the host's
format (whole seconds), `closed_by_kind = device`, `closed_by` the station,
`close_reason_code`, and the audit row `shift.close` with the station as
actor and `{ actualQty, plannedQty, closedBoxCount, reasonCode }`. A shift
the office closed first answers `accepted` with `details.alreadyClosed:
true`. Every close is kept in `shift_close_events` (`accepted` or
`already_closed`). Any other fact accepted (or `conflict`) for a closed
shift is taken and marks it late once (`late_data_at`, the host's clock); a
refused one marks nothing. Closing a shift and marking it late change the
shift's row, so the batch takes one host revision for all such changes
(taken on first need, stamped on each changed row) and commits through
`commit_with_revision`, which wakes the streams; a batch that changes no
shift takes none. Only a device that entered the shift closes it (`not_entered`
otherwise, and so for a shift only planned); the shift is read inside the
batch's write transaction, so an office close that commits while the batch
waits for the lock is seen. The office closing a shift the station closed
finds it changed (`stale_revision`) or closed (`shift_status`).

Any device asks whether a code is taken (`GET /v1/device/codes/{codeHash}`,
`routes/codes.rs`; 64 lower-case hex digits, `validation_failed` on
`codeHash` otherwise): `{ status: "free" }` or `{ status: "taken", owner }`
with the same `CodeOwner` a `conflict` names. It reads the registry on a
pooled connection outside any write transaction, so it never waits for a
batch being written — a station asks within 300 ms (plan 2a6) — and it
writes nothing: it authenticates through `AskingDevice`, the read-only twin of
`AuthDevice` (same key, revocation and kind checks, no `last_seen_at` update),
so it never waits for a writer, the first request after an idle minute and a
busy station's once-a-minute touch included. This is the ONLY writer-free
device route. Every other device route authenticates through `AuthDevice`,
which touches `last_seen_at` at most once a minute per device (even an
`UPDATE` that matches no row takes SQLite's write lock, so it runs only when a
minute is up): the first request after each full minute, a scanning station's
too, takes the write lock and can wait behind a writer.

Any accepted fact that follows a station's own `shift_closed` in its queue
marks the shift late, in the same batch too (`entered_shift` reads the status
record by record). So the station closes a shift only after its prints are
settled (plans 2a7 and 2a8), and a report reads `late_data_at − closed_at` as
neither lateness nor output: the device clock meets the host clock there.

Two timestamp formats live in the facts' tables and are never compared with
each other: a device's instant (`scanned_at`, `opened_at`, `occurred_at`, …:
24 characters, `YYYY-MM-DDTHH:MM:SS.sssZ`, kept as sent) and the host's own
(`received_at`, `detected_at`, `displaced_at`: 20 characters, whole seconds,
`clock::format_timestamp`). Text order is instant order only inside one
format, so the registry compares `scanned_at` with `scanned_at` and nothing
else. The schema (`0010`) holds what no row may break: a journal row, a box
exception and a close event per record (`UNIQUE (device_id, record_id)`), the
fields of each scan verdict, the fields of each exception kind, a closed box
whole, and a code live in a box once. A refusal of a record is permanent: its
receipt is kept, and the same record sent again is not looked at again, so a
fact refused for a reason that later changes (a scan of a shift the device had
not entered yet, say) can only be sent again under a new id.

Every `OfficeShift` — the list, `GET …/{id}` and the answer of every office
write — carries `totals` (`ShiftTotals`), read from the facts by subqueries
of `routes/office_shifts.rs` and never stored: `acceptedUnits` (box items
neither removed nor displaced, in open and closed boxes alike; the office's
«Принято кодов», never «в коробах»), `unitsInClosedBoxes` (the live items in
boxes closed and not taken apart, as the cloud's `containedUnits`: the
office's «Кодов в закрытых коробах»; a shift closed with a box open shows the
gap to `acceptedUnits`), `closedBoxes`
(closed and not taken apart), `openBoxes` (open boxes that hold a live item: a
box emptied by undos or by displacement is not counted), `lastFactAt` (the
host's clock, whole seconds, at the last receipt of a record that named the
shift and got past the entry check, refused ones included) and `deviceIds`
(the shift's participants, first entry first, the id breaking a tie); the
office's label for `lastFactAt` is «Последние данные со станции», and it is no
measure of output or lateness. The six fields of `totals`, all required and in
every `OfficeShift`: `acceptedUnits`, `unitsInClosedBoxes`, `closedBoxes`,
`openBoxes` (non-negative integers), `lastFactAt` (an instant of the host's
format or `null`) and `deviceIds` (an array of UUIDs). A planned shift's totals
are zeros, `null` and `[]`. The subqueries run on the
indexes of `0010` (`boxes_shift`, the partial `box_items_live`,
`fact_receipts_shift`); a new column the totals read needs its index in the
same change, since the list runs them once per shift listed.

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
defaults and the feed, and a shift's snapshot that carries a layout through
the plan, the station's entry and list, an SSCC block and the office's
close. Nor do facts reach it (stage 2a spec §4.11): no code of marking, crypto
tail, code hash, SSCC or reason words — a refused record is logged by the
device, its id and its receipt code alone (the two `warn!` calls of
`facts::receive`), and a database error of a batch by SQLite's own words plus
one `error!` of the batch route, `a fact batch failed`, with the device and
the failing record's position in the batch (`position=1` is the second
record), never the record or its id, which is device text.
`no_secrets_in_logs.rs` sends every kind of fact, accepted and refused, with
a code of marking that has a crypto tail, an 18-digit SSCC and reasons in
words, a resend, a mismatched resend, a station's close of a shift and a
late scan after it, a batch the host cannot write (a 500, its failing record
second in the batch), the code check
and the totals, and asks that the host kept them and the log has none. The
test sees `info` and above, what `tracing` writes to the file: `println!`,
`eprintln!`, `dbg!` and `debug!`/`trace!` escape it, so its second test
pins the source: the library prints nothing and the facts path holds exactly
three logging calls, the two `warn!` calls and the batch route's `error!`; a
new one there is a decision for both tests.
Kiosk mode's failures are logged by the command's name
alone (`standalone: enter_lockdown failed`), never by what the shell answered.
The hardware commands (see "Hardware") log a failure to the shell's stderr by
the command's name, the code and the system's own words: never a printer's
address or queue, a label's bytes or a scan (the oversize-frame line names
only the port, and a failed emit names only the event), and a refused forget
logs its count of unsent records. The release build has no console to show
either; a file log is stage 5.

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
- The `windows-sys` features of kiosk mode, the spooler and the power request,
  `serialport`, `base64` for every system and `libudev-dev` in `standalone-rust`
  came with plan 2a4's owner step (its Task 1, which also closed plan 1f2's).
  The shell's `cfg(windows)` code still compiles only in
  `standalone-windows-build`, which has not run on this code: plan 2a4
  type-checked `printer.rs`, `printer/spooler.rs`, `power.rs`,
  `power/windows.rs`, `scanner.rs`, `scanner/runtime.rs` and `lockdown.rs`, with
  their module tests, for `x86_64-pc-windows-msvc` (`cargo check` and
  `cargo clippy --tests -D warnings`) with a probe crate kept outside the
  repository, never the shell itself, whose `aws-lc-sys` needs the Windows SDK.
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
    it is on the office page; a restart locks again; leaving the office
    locks again; an administrator demoted on the host while the dialog is
    open sees the button go and the technologist role in the header;
  - Ctrl+Alt+Del: Task Manager may open underneath the topmost window, so
    «Выйти из системы» may be the only way out; try it on the setup screens;
  - Win+D, or a minimize any other way, with the window locked: a window
    without a taskbar button is not in Alt+Tab either, and starting the app
    again does nothing (the single-instance callback in `run` is empty, as in
    the cloud station), so check what finds the window again (Win+D once
    more, Task Manager «Переключиться»); the fix is a callback that shows,
    unminimizes and focuses `main`, which the mock runtime cannot test;
  - Windows restart, shutdown and sign-out with the window locked, as for a
    Windows Update on a factory PC: whether tao raises a close request then,
    whether `refuse_close_while_locked` refuses it and Windows shows «this app
    is preventing shutdown», and whether «Выйти из системы» still works;
  - a technologist's template import (file chooser) and ZPL/TSPL download
    inside the locked window;
  - a real keyboard-wedge scanner signs in under the EN and RU layouts and
    with Caps Lock; real focus and blur of the name field in WebView2, and a
    name typed into it is not scanned (and a badge scanned while the name
    field has the focus is shown there as text, up to 100 characters, until
    the step is left); a product's code scanned on the sign-in screen;
    sign-in time by badge and PIN on a factory PC;
  - the layout of the name-search step and of the status bar, and the 64 px
    controls, on the real screen and touch panel (and the Windows on-screen
    keyboard for typing a name).
- Hardware in tests: `tests/printer.rs` sends to stub TCP printers on loopback
  (the whole label, every byte value, a long label to a slow printer, a port
  that does not listen is `not_sent`, a connection cut mid-label and a printer
  that stops reading are `outcome_unknown`), each send on its own thread with a
  10 s deadline, so a send that hangs fails instead of hanging the suite; the
  spooler's call order is tested through a recording fake on every system;
  `send_all` (chunks, and `outcome_unknown` from the first write on, for TCP and
  COM) and the bounded name lookup are unit-tested in `printer.rs` with a fake
  writer and a sleeping lookup; `scanner/runtime_tests.rs` drives the scanner
  runtime with fake ports; `tests/ipc.rs` drives every hardware command and both
  scanner events through the mock runtime, the scanners over a fake `COM3`, and
  on Windows its `set_system_awake` test asks for a real power request (a CI
  runner's session may refuse it with `power_request_failed`, and then the test
  cannot fail on a bug in the request; letting go must succeed either way). No
  COM printer is stubbed: macOS refuses a serial port's settings on a
  pseudo-terminal. The webview side is `test/hardware.test.ts` (a fake `invoke`
  and `listen`) and `test/hardware-tauri.test.ts` (Tauri's own defaults).
- Two things stay green when broken: the `cfg(windows)` code, and the Windows
  branch of the awake test above. The COM path of `print_bytes` has no
  automated test that reaches a real port, only `send_all` behind it.
- Hardware by hand, on Windows 10 and 11 (stage 2a spec §7). None of it has
  been run; check at least:
  - ZPL to a Zebra and TSPL to a TSC at 203 and 300 dpi over TCP 9100, a COM
    port and a USB spooler queue: the label matches the office preview, with
    Cyrillic, and its DataMatrix and SSCC read back; a label of several MiB
    to a slow printer (the write limit under Winsock, chunks of 64 KiB);
  - `not_sent` and `outcome_unknown` on real failures: the printer off before
    and during a job, the cable pulled, a paused printer (the label prints
    when it resumes), the spooler service stopped (and `list_usb_printers`
    then answering `spooler_unavailable`); whether the spooler takes a job
    for a printer that is off (then `sent` is not printed), and what a job
    ended after a failed write leaves in the printer; a printer by name
    against one by address with no DNS (the lookup is `not_sent` after 5 s);
  - COM scanners: the port list, CR or LF framing and a scanner set to send
    no suffix, the GS byte, `]d2` and `]C1` prefixes, unplugging and plugging
    back mid-scan, two ports at once, a scan while the window reloads, and a
    com0com pair for repeatable runs;
  - `set_system_awake`: `powercfg /requests` shows the request while awake
    and none after `false` and after the app exits, the domain's screen-lock
    policy, and the answer when the session refuses a request;
  - a device renamed in the office shows its new name after the next
    revision or reconnection;
  - a forget with a corrupt database on Windows (the rename of the set), and
    a shell from before plan 2a4 started on a `device.json` this one wrote.
- The office's «Смены» and the three small items of plan 2a3 («Номера
  закончились», the similar personnel number, the warning in «Устройства»)
  have run only under jsdom, against a fake `HostApi` and fixture shifts; no
  WebView2, no real host and no browser has shown them. Never run: the
  `DatePicker` calendar inside a dialog in WebView2 and in the locked window
  (Tab from the calendar leaves the dialog until `@markiro/ui`'s `Modal` is
  fixed, and Escape is held back only by `keepCalendarEscape`); the
  organization's time zone of a real profile for «today» and a zone the PC's
  ICU lacks (`isKnownTimeZone`); `Intl` output in WebView2 against Node's
  (the no-break space in «1 200», `toLocaleLowerCase("ru")` in the search, the
  `ru` collator behind the name order); a shift planned in the office and
  opened by a real station (the station's side is plan 2a5); a station moved
  to another line while it works on a shift (the dialog's sentence describes
  what plan 2a5 builds); and the list against a host with months of shifts or
  a period of 366 days. The «Итоги» window and the «Выпуск» column have run
  only against fixture totals: never against a host's subqueries over real
  facts, nor with the time of the last fact written by WebView2's `Intl`.
