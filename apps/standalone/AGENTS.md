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
The rule is enforced per route and per kind, not only by the office session: `host/src/device_kinds.rs`
lists the kinds that may call each `/v1/device/*` and `/v1/changes*` route, `/v1/office/*` and `/v1/bootstrap`
take a station or an office PC, and a route with no rule is `forbidden`. A handheld's key opens no office
route even with an administrator's password (plan ТСД-Х).

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

A code the office makes for one device (`POST /v1/office/devices/{id}/pairing-code`, stored in
`pairing_codes.device_id`) re-pairs that device with its own `deviceId`: the claim names `recoverDeviceId`, the
host gives the device a new key, ends the old key and the device's office sessions, takes no seat and writes
`device.rekey` (the actor is the administrator who made the code, as design 6.6 says; `details.pairingCodeId`
joins the code's creation row). A new code for a device expires every code still alive for it, and a recovery
spends the rest. A request the old key already authenticated stops at `AuthDevice::require_live_in`, which
checks the key's hash again inside the write transaction. A code for one device used without that id, or an ordinary code with one, is
`pairing_code_invalid` and stays whole.
A station names its device the same way: a forget of «Подключить заново» or «Отвязать станцию»
(`device_forget { repair: true }`, `DeviceState::forget_for_repair`) leaves `repair.json` (`hostId`, `deviceId`, no
secret) beside `device.json`, and `host_claim` sends that `deviceId` as `recoverDeviceId` when the host it observes is
that `hostId`; a successful pairing of any kind removes the file. «Подключить как новое устройство» on the pairing
screen (`asNew`, `claim_as_new_device`) sends no id, so an ordinary code makes a new device; the screen remembers a
refused code per mode. A forget of an unreadable pairing leaves no hint. A station on the host's PC pairs over
loopback (`local-pair`), which has no code and always makes a new device.

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
A product's photo (plan ТОВ) writes `product.photo.set` (`details`: `width`, `height`, `bytes`,
never the picture) and `product.photo.clear` (only when there was one); `product.create` names
`egaisCode` and `defaultCounterpartyId` when either is set, `product.update` both as any field.
Backups (plan РК) write `backup.create` (the host or the office user who asked;
`failed` when a folder did not get the copy), `backup.settings.update`,
`host.restore` (the host), `host.restore.resume` and `sscc.block.register`
(the station). The copy before an upgrade (plan ОБН-1) writes `host.upgrade`
(the host; see «Backups and restore»). The office's start of an update
(plan ОБН-2) writes `app.update.start` (see «Updates from a file»).
Update distribution (plan ОБН-3) writes `update.package.stage` (the
administrator), `update.package.promote` (the host; `failed` with `reason`)
and `update.download` (the device, from byte 0 only). The
license (plan ЛЦ-2) writes `license.load` (the administrator; `denied` for a
refused file with its reason — a foreign or forged file is an event, unlike
other refused office writes; the file itself never enters `details`),
`license.state` (the host, one row per change of state, none for the first
look) and `license.emergency`.
Details never hold pairing codes, keys, tokens, passwords, salts or hashes (the
SHA-256 of a copy's file in `backup.create` and `host.restore`, and of an
installer in `app.update.start`, is a checksum to compare with a manifest, not
a credential hash), and
a refused login never records the typed login. An attempt refused by a rate
limiter writes no row, so a flood cannot fill the log. An office write the host
refuses (`validation_failed`, `forbidden`, `not_found`, `stale_revision`,
`conflict`) changed nothing and writes no row either, as for every office
writer since plan 1b1: the `denied` rows are refused sign-ins, password
changes and pairing claims. `office_user.password` covers
both an administrator's reset and a user's own change (`actor_id ==
target_id`). `shift.export` (plan ЧЗ) and `app.update.start` (plan ОБН-2)
are the two rows that record no change. `shift.export`: the office saved an
export's files and then wrote it (`POST /v1/office/shifts/{id}/exports`),
every office role, no revision, the shift as its target and the record's
fields as its details. The host cannot check those counts against the files:
the row says what the office session reported it wrote. The bytes themselves
are evidence only where the host stored them (`export_files`, migration
`0029`, «Stored files» under «Shifts»), and the row joins them by its `documentId`. `app.update.start` says the same of an
installer the office started (see «Updates from a file»).
`conflict.review` (plan КНФ) is the office user who marked a code conflict
reviewed, target `code_conflict`/`{id}`, details `{ kind, loserShiftId,
loserDeviceId, winnerShiftId }` — never the code nor its hash; both office
roles may, a conflict reviewed already answers as it is and writes no row,
and a review takes a host revision (no feed item) so the stations' streams
wake and ask after their conflicts.
Plan 2b adds `shift.join` and `shift.leave` (the device; `{ number, rejoined }`
and `{ number }`), `shift.part_closed` (the device; `{ number, actualQty,
closedBoxCount, reasonCode }`), `shift.force_closed` (the office user; `{ reason,
notClosed }`), `shift.close_reason` (the office user; `{ reasonCode }`) and
`line.max_stations_changed` (the administrator; `{ from, to }`). A repeated entry
or leave writes none.
Disaggregation (plan ДЗГ) writes `disaggregation_reason.create` / `.update` (target
`disaggregation_reason`; details `{ name, sortOrder }` and the update's `changed`),
and, with the target `disaggregation_document`: `disaggregation.create`
(`{ docNo, reasonId, comment }`), `.update` (header changes), `.lines.add`
(`{ docNo, added, import }`), `.lines.delete` (`{ docNo, lineId, ssccInput }`),
`.cancel` (`{ docNo }`) and `.apply`: `ok` with `{ docNo, boxes, pallets, codes }`, or
`failed` with `{ docNo, invalidLines }` when the apply found a line that is not `ok` —
the one refused office write that DOES write a row (and takes a revision), because the
fresh line statuses are committed with it (the cloud's behaviour); a stale draft pressed
again writes one more such row.
`disaggregation.export` (plan ДЗГ-О) is the third row that records no change, after
`shift.export` and `app.update.start`: the office saved the document's ЧЗ file
«Расформирование упаковки» and then wrote it (`POST /v1/office/disaggregation/{id}/exports`),
administrators and technologists (`require_disaggregation_in`), no revision, the document as
its target, details `{ formatId, formatVersion, packingCount }`. The host checks that the
document is applied (`conflict` `document_not_applied`) and that `packingCount` is the number
of its distinct SSCCs (a refusal writes no row); it never sees the file.
«Удалить демо-данные» writes `demo_data.delete` (the administrator, target `product`/the demo
product's id, details `{ shifts, boxes, pallets, codes }`); the rows of earlier actions on the demo
objects stay. `host.bootstrap` names `demoData` (its production date) when the wizard installed it.
Tests assert the exact actor, action, target, result and parsed details.

## Databases

DDL lives only in `host/migrations` and `src-tauri/migrations`. An applied
migration is never edited — add a new one; sqlx verifies checksums at start.

A migration that rebuilds a table copies every row WITH its rowid
(`INSERT INTO t_rebuilt (rowid, …) SELECT rowid, …`, through a temporary copy
as `rowid AS kept_rowid`): a copy without it renumbers every row past a
deleted one, and a read by insertion order (`ORDER BY rowid`, the station's
«Снять последний код») would then take another row. The host's
`0020_validation_scans.sql` (plan РЕЖ, part A) rebuilds `scans` and
`code_owners` and re-creates `box_items` and `code_conflicts` this way (the
procedure, without `defer_foreign_keys`, is in the file's header; a closing
guard refuses it if a foreign key breaks); `tests/migration_validation_scans.rs`
compares every row with its rowid and the whole `sqlite_master` before and
after. It runs when the service starts: on a Mac NVMe in release, about 22 s
for 1 000 000 scans with 900 000 owners and items (about 50 s with the
machine heavily loaded; `the_rebuild_of_a_million_scans_takes`, `--release --
--ignored`), and it needs free disk of about the database's size again (the
WAL grows by about the rebuilt tables, plus the temporary copies of the
children). Owner check: its time and disk on the client's Windows hardware
with a year of facts.

Since `0021_validation_print.sql` a trigger on another table reads `scans`:
`shifts_mode_frozen` on `shifts` (`EXISTS (SELECT 1 FROM scans …)`), so
`0020`'s «nothing else refers to these four tables» no longer holds. A future
migration that rebuilds `scans` must `DROP TRIGGER shifts_mode_frozen` before
it and re-create it word for word after the rename: with
`legacy_alter_table=OFF` (SQLite's default) the `DROP TABLE scans` + `ALTER
TABLE … RENAME TO scans` pair fails with «error in trigger shifts_mode_frozen:
no such table: main.scans». Check `sqlite_master` for every trigger or view
whose SQL names a rebuilt table, not only its foreign keys.

Host migration `0022_conflict_review.sql` (plan КНФ) adds to `code_conflicts`
its `kind` (`late` | `displaced`; a row written before it takes its kind from
the loser's receipt, which the host keeps for good: `accepted` means it was
displaced, `conflict` that it came late) and `reviewed_by` (an office user,
`CHECK` both or neither with `reviewed_at`), and five indexes:
`code_conflicts_loser`, `code_conflicts_detected (detected_at, id)` (the
office's list and a device's cursor), the partial `fact_receipts_rejected`
and `box_exceptions_shift`/`pallet_exceptions_shift`. None is on `scans` or
`code_owners`: plan РЕЖ rebuilds both tables (and `code_conflicts`, in the
shape of `0010`) and recreates only its own and the code search's indexes.
So РЕЖ's `0020` must run before `0022`, and it does on every database: a
fresh one applies them in order, and a host older than both has neither, so
`0022` adds its columns after the rebuild (`0020` is not edited to carry them).
The constraint is on builds: none may ship `0022` without `0020`, because a
database that applied `0022` first would lose `kind`, `reviewed_by` and the
two indexes when sqlx applies the lower `0020` late, and every fact that meets
a conflict would then fail (a development database that did so is thrown
away). `tests/migration_conflict_review_order.rs` migrates a `0019` database
with a late and a displaced conflict through the whole `MIGRATOR`: every row
stays, `kind` follows the loser's receipt, `reviewed_by` is empty, and the
indexes of both migrations exist.

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

Before this build's pending migrations (plan ОБН-1) `LocalDb::open` copies the
database: `VACUUM INTO standalone-station.pre-<app version>.db.partial`,
`integrity_check` on it read-only, flushed, renamed over a copy of that name,
and every older `standalone-station.pre-*.db` goes with its side files, so one
stays. Between the copy and the end of the migrations the database carries
`PRAGMA user_version` «OBN1» (`UPGRADE_UNFINISHED`); while it does, a copy of
that name that is sound and older than the database (an earlier open of this
version whose first migration committed before a later one failed) stays as
it is: it holds the state before all of them, which the previous app can
open. A copy of that name left by an upgrade that finished (two builds can
share a version: a rebuild of the same release, or a development build) is
replaced. Since plan ОБН-2 `CARGO_PKG_VERSION` is the release version: the
contract `tools/standalone-release/test/versions.test.mjs` keeps
`tauri.conf.json`, the three crates, `package.json` and `Cargo.lock` at one
version. A new file, a failed or an unknown migration take no
copy (sqlx decides as before). A copy that fails runs no migration: the open
fails as `OpenFailure::Other` (the file stays, the app starts without its
local database), except damage the copy met in the database, which stays
`Corrupt`; a failure to read the migrations goes back as it is, so a corrupt
file stays `Corrupt`. A forget removes the copy (beta 3, the owner accepted
the open question Д9): `device_forget` deletes every `standalone-station.pre-*.db`
and `.db.partial` with their `-wal`, `-shm` and `-journal` files
(`LocalDbState::remove_pre_upgrade_copies`) once the database itself is
cleared, since the copy holds the PIN and badge hashes the database held at the
upgrade. A file that cannot go makes the forget answer `storage` and keeps
`device.json`, so it can be tried again; nothing else reads or removes the copy,
and the next upgrade that brings migrations makes a new one.

A forget (`clear_copies`) empties every disposable table (see below),
`floor_sign_in_failures` included, so it resets every lockout counter of the
station and of its operators, and a station on the host's PC re-pairs itself.
Whoever can reach a «Подключить заново» or «Сбросить подключение» control
(the device-rejected, other-host and config-error screens) therefore wipes
the counts; those screens are not reachable from a working floor (they come only
when the host refused the device or its config is unreadable), and kiosk mode
(plan 1f2, see "App shell") leaves them reachable on purpose. A refusal that
arrives while an operator works in a shift waits for them to leave it (see
"Shifts"), so the device-rejected screen never replaces a shift's work screen.
Another host found by the sync (`sync_finished` with `other_host`) waits the
same way since plan 2a6: while an operator works in a shift it is held
(`pendingOtherHost`), the link is stopped and the status bar says why, and the
other-host screen and the forget it offers come only after the operator left
the shift and the work gate drained, so a forget never appears while a write
is in flight (see "Shifts"). While this device holds shift
records the host has not acknowledged, the shell refuses
that forget (`unsent_facts`); since plan 2a5 those screens then say how many
records there are (`countUnsentRecords`, `src/local/outbox.ts`: the pairing's,
or every pairing's when the pairing file is unreadable; a count that cannot be
read says only that there are some) and offer «Сбросить всё равно», which
forgets with `keepUnsent: true` (question В7, exit Б): a rejected device can
send nothing more, so waiting would trap it. The confirmation deletes nothing:
the records stay on this PC's disk, but they carry the old `host_id` and
`device_id`, so they cannot be sent for a new pairing, and the screen says so.

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
`sync_quarantine`, `floor_sign_in_failures` and `floor_restore_epochs` (plan
РК-С: what a pairing owes a restored host is moot for a new one); `DeviceData` — what the
device records itself (plans 2a5–2a8 and ПЛ-Ц: shifts, boxes, scans, the
outbox, the print jobs, the pallets), each row tagged with the pairing that
wrote it; `Workstation` — the PC's own settings (plan 2a7), which outlive any
pairing. Of the 29 tables 12 are `Disposable`, the 8 of migration `0006`,
`floor_print_jobs` of `0007`, the two pallet tables of `0008`, the three warehouse tables of
`0012`, `floor_block_drops` of `0013` and `floor_unit_labels` of `0015` are `DeviceData` (below), and
`workstation_settings` of `0007` is the one `Workstation` table. `floor_shift_participation` (plan 2b, `0022`: a shared shift's figures) is `Disposable`. `tests/local_db.rs` fails on a table without a class and on a class
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
counted fails the forget (`storage`) and is never read as 0. `outbox`
(migration `0006`, plan 2a5) exists in every database that opened; only a
database that did not open can lack it, an older build's, which the read-only
count skips. The headers of the applied migrations `0001`–`0005` still
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
not counted, so it loses its link with no confirmation: the forget screens
must be offered only with no open shift and with the fact writer stopped. A
refusal of the device meets the first condition since plan 2a5 (it waits in
`pendingRejection` until the operator leaves the shift, see "Shifts"), and
another host found by the sync since plan 2a6 (`pendingOtherHost`). The second
condition is real since plan 2a6, which writes the facts: the work screen's
writes are tracked by the work gate, and `App` stops the link, and its fact
sender with it, while a refusal or another host is held or its screen shows.
And the records kept by `keepUnsent: true` carry the old `host_id` and
`device_id`: the fact sender (`sendFactBatch`) reads only the current pairing's
`outbox` rows and never sends them to a new host. The confirm control that calls `forget({ keepUnsent: true })`
is plan 2a5's (above); the count it shows has the predicate of the shell's
`unsent_records` (`acked_at IS NULL`, the pairing's or every pairing's) in a
query of its own, `countUnsentRecords`. The sync's wipe for another pairing (`WIPE` in
`src/local/reference-sync.ts`) names only the copies, the quarantine and
`sync_state`, and leaves `floor_sign_in_failures` alone on purpose, because
it is no copy of the host's data and a wipe is no sign-in; no test pins that
half. A forget on Windows has never run there: the rename of a corrupt
database that was opened and closed, and a forget while another process
holds a file, need a manual check.

This device's own records (`src-tauri/migrations/0006_floor_production.sql`,
plan 2a5; all `DeviceData`): `floor_shifts`, `floor_sscc_blocks`,
`floor_block_requests`, `floor_boxes`, `floor_codes`, `floor_scans`,
`floor_exceptions` and `outbox`. Every row carries the pairing it was written
under (`host_id`, `device_id`), and the floor reads only the current
pairing's rows, so records a forget kept stay on disk for support without
reaching another pairing's screens (`floor_shifts` is keyed by pairing too,
and `floor_codes` as well: a re-pair to the same host sees the same shift
ids). The schema holds what the facts protocol (plan 2a2) needs: an `invalid`
scan keeps no text, only its length and what it looked like (the table has no
column for the text, and `CHECK`s tie the verdict to the kind, decision 15); a
box is open without an SSCC or closed with its SSCC, block and serial; one
open box per shift and pairing; an SSCC on one box under any pairing (a
second box with a printed number is a duplicate label); a block's cursor
(`next_serial`) stays within the block, and its writer (plan 2a6) moves it by
a compare-and-set in the transaction that closes a box; an exception carries
the fields of its kind; an outbox record has its outcome and its receipt
together or neither. `snapshot`, `payload` and `outcome_details` are JSON
objects only, and a single-column text key says `NOT NULL` (SQLite takes NULL
in a plain `TEXT PRIMARY KEY`). `outbox.kind` has no `CHECK`, since the
pilot's pallets add kinds and a SQLite `CHECK` changes only by rebuilding the
table; `seq` is a rowid alias, not `AUTOINCREMENT`, which would add the
unclassified `sqlite_sequence`. Besides the keys there are four read indexes
(`outbox_settled`, `floor_codes_box`, `floor_codes_shift`, `floor_boxes_shift`)
for reads the floor repeats on every scan or box close. `test/floor-schema.test.ts`
pins these rules on node:sqlite, and the repeating reads' query plans exist
twice, because the shell ships SQLite 3.46 and Vitest's `node:sqlite` is 3.53:
in that file and in `tests/local_db.rs`
(`the_floors_repeating_reads_search_an_index`). A new repeated read of a floor
table gets a line in both lists. The header of `0006` says that codes and boxes
have no retention at all; plan 2a8's `RETAINED_TABLES` deletes a shift's codes
and boxes 30 days after the host took its close (see «Floor exceptions and
close»), so the header is out of date on that point. It is left as written: sqlx stores a checksum of the migration file,
and a changed header would refuse a database that already applied `0006`.

Migration `0007_floor_printing.sql` (plan 2a7) adds `floor_print_jobs`
(`DeviceData`, see «Floor printing») and `workstation_settings`
(`Workstation`, the only table of that class: one JSON value per key —
`printers` (the profiles and the purposes' assignments), `scanners`, `sound`,
`verify_printed_label` — with no pairing; a forget keeps it).
`floor_print_jobs.purpose` admits `box` and `pallet` from the start, so the
pallets' plan (ПЛ-Ц) rebuilds no table. `CHECK`s tie a job's state to its
bytes, its printer and its reason code (only a job with bytes can be
`sending`, `sent`, `unknown` or `verified`; a reason code exactly for `failed`
and `unknown`; a `prepared` job has never been sent; `verified` only where
`verify` is 1), and the partial unique index `floor_print_jobs_open` lets one
job of a label wait at a time (`prepared`, `sending`, `failed`, `unknown`, or
`sent` with `verify = 1`) — the rule that `isOpenJob` and the SQL of
`readOpenJob` and `shiftLabelsSettled` repeat word for word.
`test/floor-print-schema.test.ts` pins these rules and `test/floor-schema.test.ts`
the columns and indexes. The jobs' repeating reads (`readOpenJob` before every
close and after it, `shiftLabelsSettled`) have no line in the query-plan lists
above: they rest on `floor_print_jobs_shift`, and nothing pins that yet. A job
keeps its bytes as base64 text with no size bound, and no retention removes
a job in plan 2a7 (decision 31 gave it to plan 2a8, whose `RETAINED_TABLES`
lists `floor_print_jobs`).

Migration `0008_floor_pallets.sql` (plan ПЛ-Ц, «Floor pallets») adds
`floor_shifts.pallet_box_capacity` (`CHECK` above 0) and `pallet_template_id`
(the host's list of a shift with pallets), `floor_boxes.pallet_id` (only on a
closed box, `CHECK`; the partial index `floor_boxes_pallet`), `floor_pallets`
and `floor_pallet_exceptions` (`DeviceData`, both in `RETAINED_TABLES`): a
pallet is open without an SSCC, block, serial or `disassembled_at`, or closed
with its SSCC (18 digits starting with the extension `1`), block and serial;
one open pallet per shift and pairing (`floor_pallets_open`); an SSCC on one
pallet under any pairing (`floor_pallets_sscc`); a pallet's exception is a
`reprint` or a `disassemble`, always with a reason code, words only with
`other`. A pallet's box count is never stored: it is counted from the boxes
that name it and are not taken apart. The migration has one index the plan did
not list, `floor_pallets_shift (host_id, device_id, shift_id)`, for the
retention's delete and the exceptions screen's read of a shift's pallets;
`floor_pallet_exceptions` got its index by shift with migration `0010` (plan
ХП, below). Additive only, `0007` rows stay as they were (a test on Node's SQLite
and one on the shell's own `Migrator` apply `0008` over a database of `0007`).
`test/floor-pallet-schema.test.ts` pins these rules; `test/floor-schema.test.ts`
and `tests/local_db.rs` pin the columns, the indexes and the query plans of the
pallets' reads on both SQLite engines (Node's and the shell's older one).

Migration `0010_shift_indexes` (plan ХП) adds three indexes by shift for the
retention's deletes: `outbox_shift (shift_id, host_id, device_id, acked_at)`,
`floor_exceptions_shift (shift_id, host_id, device_id)` and
`floor_pallet_exceptions_shift (shift_id, host_id, device_id)`. The shift leads
each on purpose: an index led by `(host_id, device_id)` becomes the first step
of the hourly due select on SQLite 3.53 (a walk of every record of the pairing
instead of `outbox_settled`), and with `acked_at` after the shift the status
bar's count of unsent records too. `acked_at` ends the outbox's index, so the
retention's check for an unsent record of a shift reads the index alone.
Additive only: `test/floor-shift-indexes.test.ts` (Node's SQLite) and
`migration_0010_adds_the_shift_indexes_and_keeps_every_row` (`tests/local_db.rs`,
the shell's own `Migrator`) apply it over a database of `0009`. Every delete of
`RETAINED_TABLES` searches an index by shift, pinned in both lists of plans.

Migration `0013_outbox_recovery.sql` (plan ОЧ, «Outbox recovery») adds to
`outbox` the person's resolution of a refused or conflicting record:
`resolution` (`resent` or `dismissed`, checked), `resent_as` (the id of the
record written in its place), `resolved_at` and `resolved_by`, all NULL for a
record nobody resolved; the module writes them together and no check ties
them. It also creates `floor_block_drops` (`DeviceData`; one row per block the
host gave and the station did not take, keyed by pairing and block id,
`reason` `overlap` or `mismatch`). No index was added. The shell's migrations
are `0010` (ХП), `0012` (the warehouse reprint, СКЛ) and `0013` (ОЧ); `0011`
(reserved for the A4 sheets, if they need one) is absent, and gaps in the
numbers are legal (`tests/local_db.rs` journals the migrator's own list and
covers the upgrades from `0009` and `0010` and a database that holds `0012` and
`0013` without `0010`). sqlx applies a version missing from
the journal whatever its order and fails with `VersionMissing` only when the
journal holds a version the binary does not know: a development database that
a build with `0011` already opened cannot be opened by a binary
without that file. That is a hazard of developing on unmerged branches
(use a fresh database), not a field procedure; the runbook names it for
developers only.

Migration `0014_floor_validation.sql` (plan РЕЖ, part A) rebuilds
`floor_codes` and `floor_scans` so that a code and an accepted scan of a
validation shift name no box: `floor_codes.box_id` may be NULL, and the scan's
CHECK `(verdict = 'ok') = (box_id IS NOT NULL)` becomes `box_id IS NULL OR
verdict = 'ok'` (a box still only on an accepted scan). The rule "an
aggregation shift's accepted scan is in a box" is the station's code, not a
CHECK. The rebuild is the usual one (`*_rebuilt`, copy, `DROP`, `RENAME`, so
SQLite records the table's name quoted) and re-creates `floor_codes_box`,
`floor_codes_shift` and `floor_scans_shift` with their own text; nothing
refers to the two tables (no foreign key, trigger or view) and both stay
`DeviceData`. `test/floor-schema.test.ts` (Node's SQLite) and
`migration_0014_lets_a_code_and_an_accepted_scan_have_no_box`
(`tests/local_db.rs`, the shell's `Migrator`) apply it over a database of
`0013`: every row stays, `sqlite_master` changes only by the two intended
texts, and the plans of the reads that search these indexes stay, the work
screen's count of a shift's codes (`SHIFT_CODES_SQL`, its box-less codes
included) on `floor_codes_shift`. Every row keeps its rowid (see «Databases»):
«Снять последний код» reads a box's newest code by it (`LAST_CODE_SQL`), and
`migration_0014_keeps_each_rows_rowid` and its Vitest twin check that the
rowids and that row stay the same over a box with an undone code. It runs in
the shell's setup, before the window appears: about 43 s for 1 000 000 codes
and 1 000 000 scans with `secure_delete` on, on a Mac NVMe, the WAL growing to
about 0.9 GB. Owner check: its time and disk on the station's Windows
hardware.

Migration `0015_floor_unit_labels.sql` (plan РЕЖ, part B) adds
`floor_unit_labels` (`DeviceData`, in `RETAINED_TABLES`): one row per unit
label job of a validation shift that prints the Data Matrix duplicate, holding
the job's current attempt as the domain's projection does
(`ProductLabelProjection`); a reprint moves the row to the next attempt with
its reason and the same bytes, and every event of every attempt is a
`unit_label` fact in the outbox (the attempts' history; «История этикеток»
lists jobs). The CHECKs are the domain's: the attempt states, the policy kept
on the job (`verification_policy`) and the check's outcome
(`not_required` under none, `pending` under a required check, a skip only
after `sent` of a required check, a verification only after
`delivery_unknown` or `sent` of a required check), a reason exactly on an
attempt after the first, an error code exactly in `failed_before_send` and
`delivery_unknown` from the fact's lists, and the bytes, their print identity
and their digests from the preparation on: the domain's `prepared` event
carries them, and a unit is not accepted at all — refused before the
transaction, as the cloud answers `error: "printer"` — while no duplicate
printer is assigned or the label cannot be rendered. The print identity is
`print_mode` (`raw` | `windows_driver`), `language` (`zpl` | `tspl`, none for
the driver's `mono-raster-v1` page) and `dpi` (203 | 300), the domain's
`ProductLabelPrintIdentity`; the job keeps no copy of the printer profile. A
send reads the duplicate's printer at that moment and compares it with the
identity, as the cloud does: none is `failed_before_send`
`printer_unconfigured` (a printer may be removed between the preparation and
the send), another mode, language or dpi `printer_changed`. A label that can
never be printed (no printer of its identity comes back) stays in attention
and keeps its shift from the retention, as in the cloud (an owner question).
The trigger `floor_unit_labels_fixed` refuses a change of a job's origin (keys,
shift, scan, code hash, policy, template, fields, digests, `created_at`), its
print identity and its bytes — a reprint sends the same bytes — and
`MOVE_JOB_SQL` writes only the attempt, its state, the check, the reason, the
error code and the time. `print_mode` is in the trigger for its reader: the
CHECK that ties it to `language` already refuses a change of it alone, so a
mutant without it survives. `test/unit-label-schema.test.ts` walks the
domain's `applyProductLabelEvent` from `prepared` under both policies, every
event kind at every step (reprints included: 14 projections), and checks that
the rows the CHECKs take of the 40 «state × policy × check» are exactly those,
and that the unique index's predicate (`floor_unit_labels_unresolved`,
`UNRESOLVED_UNIT_LABEL_SQL`) is exactly «not completed» of the status the walk
reached. A station has one unresolved job whatever its shift
(`floor_unit_labels_unresolved` on `(host_id, device_id)`, as the cloud's
`PRODUCT_LABEL_BUSY` across shifts; `UNRESOLVED_JOB_SQL` reads it whole, and
the recovery turns a `sending` the app's stop cut into `delivery_unknown`, only
on entering a shift that prints the duplicate, as the cloud's station does;
`UNRESOLVED_REF_SQL` only its gate — no fields, no bytes — for every scan of a
printing shift and every reprint) and one job per accepted unit
(`floor_unit_labels_scan`). So a job a crash left `sending` stays `sending`
while the station works aggregation shifts (or validation shifts without the
duplicate): the host's shift card counts it unresolved, and the retention
keeps its shift, until a printing shift is entered. An id's
shape is not checked, as in every table of the station.
`floor_unit_labels_shift` serves the history and the retention's delete, the
partial `floor_unit_labels_sending` the recovery on entering a printing shift;
the retention's
«no unresolved label of this shift» names `INDEXED BY
floor_unit_labels_unresolved` (one row at most), where the planner would walk
the shift's every job through `floor_unit_labels_shift`. The statements of
`src/floor/unit-labels/unit-label-store.ts` are pinned in both lists of plans
(`the_unit_label_reads_search_an_index`). The full code lives only in the
job's `fields` and bytes (no `unit_label` record carries it; the unit's own
`scan` record carries `code.canonical` by design); the retention deletes the whole row with its shift
and keeps a shift while a unit label of it is unresolved (its outcome may be
unknown), as it does for a waiting label of `floor_print_jobs`.

Migration `0016_conflict_notices.sql` (plan КНФ; `0014`–`0015` are plan
РЕЖ's) adds `outbox.office_reviewed_at` — the host's instant of the office's
review of a record's conflict, NULL for every record before it and only on a
record the station resolved (`CHECK`) — and
`floor_displacements` (`DeviceData`): the scans of this station an earlier
scan elsewhere took the code from, one row per conflict and pairing and one
per record (`floor_displacements_record`, so a conflict a restored host
writes again under a new id stays one row), the winner by its shift's number
and whether it is this station's own (never a device's name), `learned_at`
and `resolved_at` on this computer's clock, `detected_at` and
`office_reviewed_at` the host's, `resolved_by` the operator or NULL for the
office's review — and the shift's number and the box's SSCC as a snapshot taken
when the row is first written (the host's SSCC, or this station's of a box the
host still had open) and never again, so a row stays readable after the
retention deleted the shift's copy and its boxes (the owner's decision; the
queue reads the snapshot first, the live copy only where the snapshot is
empty) (`CHECK`s: a person or the office resolves only with the
instant). It has a `shift_id` but no retention on purpose (rows are few, and
the newest is the cursor of the next read, which must never go back;
`test/retention.test.ts` names that exception). Indexes:
`floor_displacements_cursor` and the partial `floor_displacements_open`; the
statements' plans are pinned on both SQLite builds
(`the_conflict_notices_search_an_index`).

## Writes

- Every multi-statement write uses `db::begin_write` (`BEGIN IMMEDIATE`), not a
  deferred `pool.begin()`: a deferred transaction that reads then writes can
  hit `SQLITE_BUSY` on a stale WAL snapshot before `busy_timeout` gets a
  chance to help.
- One `next_revision` per changing transaction, stamped on every row that
  transaction changes. Two revisions have no row to stamp: a device's line
  change (devices have no `rev` column and are not feed data, so
  `PUT /v1/office/devices/{id}` takes a revision only to wake the streams,
  and only when the line really changes) and a conflict's review (plan КНФ:
  `code_conflicts` is no feed data; the revision wakes the stations, which
  then ask after their own conflicts).
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
product is never deleted and never has a tombstone, except the demo product, which «Удалить
демо-данные» deletes («Demo data»); a deleted template leaves as one. A category default is keyed `<code>:<purpose>` (`8:box`,
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
since plan 1e2 plus the releases' one statement take 31, so a ninth kept
entity needs a smaller batch first (or the way of `ACTION_ENTITIES`).

`code_releases` (plan ДЗГ, migration `0024`) is an entity a station ACTS on
and does not keep: one item per BOX an applied disaggregation document took
apart, keyed by the box id, `data` `{ shiftId, documentId, releasedAt,
codeCount }` (`CodeReleaseRecord`), at the apply's one revision. The unit is
the box, not the code, so a document of 10 000 boxes is 10 000 small items in
one revision (about 3 MB, which the feed sends whole, never split). A release
is never deleted and has no tombstone. The device protocol version does not
grow (a new feed entity is an answer, and an older station skips it), but
`ENTITY_SET` names it (`ACTION_ENTITIES`), so a station that starts acting on
it syncs from zero once and meets the releases it skipped. A release writes no
feed item for the document, its lines or a pallet.

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
- The name search (plan 1f2; «Найти по имени»,
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
  (`ShellState.operator`): identity, never a hash, and the number of the
  session (`sessionId`, plan 2a5, decision 26): the reducer gives every
  sign-in the next number (`lastSessionId + 1`), and the sign-out callbacks
  (the idle timer, the check after a sync, «Сменить оператора») name the
  session they belong to, so a late timer of an earlier session of the same
  operator ends nothing (`operator_signed_out` compares the number). The
  check after a sync also brings a new name or role from the copies
  (`operator_refreshed`, the same session), so the screens show what the
  office changed without a new session. The session ends when the office
  opens (any way in, the bootstrap wizard's too), on a new pairing, a forget,
  a rejected device, another host, a change of the station's line (a refusal
  of the device, another host and another line wait while the operator works
  in a shift, see "Shifts"), and on any host probe
  (`host_probed`, which runs only at start-up, on a retry and after a forget:
  a blocked version screen never leaves a session behind; while the operator
  works in a shift its answer is held, the last one counts, and it is applied
  when they leave the shift, which then ends the session); and by
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
  or the office is open, so a late answer signs nobody in. Any operator
  signed in may enter and create shifts (question В10, "Shifts").

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

The screen's presentation is forked from the cloud station's approved sign-in
(`apps/station/src/pages/OperatorLogin.tsx`, `ui/BadgeScanIllustration.tsx`,
`ui/StationBrand.tsx` and their rules in `station.css`), owner decision of
2026-10-13: «Вход оператора» with the brand, the step's prompt, the badge cue,
the readout and keypad or the name search, and one row of equal actions in the
cloud's order. Its CSS lives beside it (`src/floor/sign-in/operator-sign-in.css`,
cloud class names); the logo is drawn inline, so the screen holds no `<img>`.
The differences are the standalone's own: «Офис» and the scanner chip share the
header's right column on every step; the readout and keypad are centred
together (no gap under the readout); below 900 px of height the keys are the
cloud's compact 80 px, and below 760 px they are 64 px with the readout beside
the keypad, so a 1024×600 panel shows the keypad whole; the number step offers
the name search and the name search the number, as the cloud's steps do. The step texts are the
cloud's (owner decision 2026-10-13: «Ввести табельный номер», «Найти по
имени», «Сброс», «Отсканируйте бейдж для входа», «Введите …»); the PIN
prompts keep the personnel number, which the cloud's «Введите PIN» drops. The
chip (`src/floor/scanner-indicator.ts`) says what the floor honestly knows:
«ready» for the keyboard wedge (it cannot be seen) and for connected COM
scanners, a warning for a part of them or a shell that cannot be asked, an
error for COM scanners off the link, and «Вход приостановлен» while the last
attempt was answered by the station's lockout (an operator's PIN lockout
leaves the badge working and does not count). The watch is the shell's
`watchScanners`, passed by `App`; a watch that throws or answers with no stop
never takes the screen down. Verified in a browser (Chromium, a harness with a
fake local database) at 1280×800, 1920×1080 and 1024×600; not on WebView2, a
real panel or a real scanner.

## Demo data

Spec `docs/superpowers/specs/2026-10-21-standalone-wizard-demo-data-design.md` (owner's decisions
of 2026-10-21: О4 option В, Д1–Д3). The wizard's «Установить демо-данные» sends
`demoData: { productionDate }` (the wizard's today in the organization's zone; the host keeps no
zone database), and `bootstrap` makes the set in its own transaction and revision
(`host/src/demo.rs`): the demo product (`products.demo = 1`, migration `0053`, GTIN
`02900000000018` of restricted circulation, its photo built in with `include_bytes!`), the SSCC
counters of the demo prefix `290000000` (extensions 0 and 1) and a planned demo shift on the first
line with the stock box and pallet defaults. Without both defaults, or with an organization whose
prefix is the demo one, the wizard is `validation_failed` on `demoData` and nothing is created. The
trial starts with the wizard either way.

- `products.demo` is the one flag: a shift is a demo shift when its product is (the product is no
  field of a shift edit). The flag is set only by the wizard; `PUT` of the demo product and of its
  photo is `conflict` on `demo_product`, so a real GTIN can never hide behind it.
- A demo shift's number is drawn from the counter `DEMO` (`DEMO-001`, `/S` from a station;
  `shifts::insert`), and its snapshot's `issuerPrefix` is the demo prefix
  (`shift_snapshot`), so it spends nothing of the organization's numbering. `0053` rebuilds
  `shift_number_counters` (with its rowids) to let the key `DEMO` past its five-character
  `CHECK`. `GET /v1/office/sscc` leaves the demo prefix out while the demo product exists, and its
  `PUT` answers `not_found`; the organization takes no GLN of the demo prefix meanwhile.
- Isolation: the office's export record and the export-file upload refuse a format
  `*_xml_gismt_*` of a demo shift (`conflict` `demo_shift`, `demo::refuse_gismt`); its TXT and CSV
  are saved as `DEMO_…`. Adding a demo box or pallet to a disaggregation document refuses the
  whole addition (`conflict` `demo_box`, `details.ssccs`). Every shift-bound query of
  `usage_stats.rs` leaves demo shifts out (the partial index `products_demo` keeps the plans off the
  catalog), and the office's «Обзор» leaves them out of the figures, the chart, the line cards and
  the first steps.
- `GET /v1/office/demo-data` (every office role) and `DELETE` (administrators) in
  `routes/demo_data.rs`: one transaction and one revision delete every fact, box, pallet, export
  file, warehouse pallet and reprint of the demo shifts, the shifts, the `DEMO` counter, the demo
  prefix's blocks and counters, the photo and the product; the product leaves the feed as a
  tombstone (the only product that ever does). An open demo shift refuses it (`conflict`
  `demo_shift_active`, `details.shifts`). Nothing there answers `present: false` with no
  revision or row. The audit keeps its rows; the delete writes `demo_data.delete`.
- The removed shifts' ids stay in `demo_removed_shifts`: a station's late fact of one is
  acknowledged `accepted` and dropped (`facts::apply`), so its queue drains. The table is business
  data of the cloud import's replacement (`BUSINESS_TABLES`), and a replacement over demo data
  also drops the demo prefix's counters and the `DEMO` counter rather than keep them as floors.
- The station knows a demo shift by its number (`isDemoShiftNumber`): «Демо-код» on the work
  screen feeds the next demo code it holds no scan of (`nextDemoCode`) through the scan gate; a
  label of a demo shift without a printer shows as a preview in the label panel, and «Готово» is
  «Продолжить без этикетки» without its question (a `sent` job needs printer bytes). The shell's
  migration `0021` adds `ref_products.demo`; after a sync and in the hourly pass
  `purgeRemovedDemo` deletes the copies of demo-prefix shifts whose product left the copies once
  their queue is answered.

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
stage-1 spec.) National-catalog links and prices are not part of the
standalone catalog; plan ТОВ added the EGAIS code, the default counterparty
and the photo (below).

The EGAIS code, the default counterparty and the photo (plan ТОВ, host
migration `0023`; parity spec §5.5). `products.egais_code` is the code the
labels print — the cloud's `products.egais_code`, its regulatory profile's
primary code; one code a product (open question ТОВ-2): free text by the
rule every text field shares (`validate::egais_code`: trimmed, 1–64
characters, no control character; 19 digits are not required, as in the
cloud, question ТОВ-3), and only with ЧЗ group 15 (`EGAIS_PRODUCT_GROUP_CODE`,
the domain's `isEgaisApplicable`): `validation_failed` on `egaisCode` for a
code with another group or none, checked before anything is read when the
code is sent, and against the stored code when an update leaves it out (an
office before plan ТОВ: `egaisCode` and `defaultCounterpartyId`, like
`defaultPalletSheetId`, are kept when left out of a `PUT`, so changing such
a product's group away from 15 is refused until the code is cleared).
`products.default_counterparty_id` is a preference the office's new-shift
dialog offers: a counterparty sent must be in use
(`shifts::counterparty_in_use`, `validation_failed` on
`defaultCounterpartyId`); one archived later stays named, an update that
keeps it is not refused, and the dialog never offers it. Neither field is in
the station feed's product record: the code reaches the station only in a
shift's snapshot (`ShiftSnapshotProduct.egaisCode`, `#[serde(default)]`,
frozen when the shift opens; a snapshot of an older host has none), and the
counterparty only the office reads. The office shows «Код ЕГАИС» only for
group 15, keeps a typed code while the field is hidden and sends it only
with group 15 (its rule `egaisCodeRule` applies only while the field
shows); a code of another form than 19 digits gets a note that the A4 sheet
goes without it (below, «Floor printing»). A new shift's product fills an
empty counterparty with its default in use and replaces one an earlier
product offered, never one the person chose; the product waits for the
counterparties. A product's photo is `product_photos` (one row a product):
a JPEG of at most 640 × 640 and 300 000 bytes that the office makes in the
webview (`photo-encode.ts`: a JPEG, PNG or WebP of at most 25 MiB and
8192 × 4096 declared pixels, checked before a byte is decoded; drawn on
white, quality 0.85, 0.7, 0.5 until it fits). The host checks the sides, the
length and the JPEG signature `FF D8 FF` (`validate::product_photo`) and
parses no picture, as the logo. `GET/PUT/DELETE /v1/office/products/{id}/photo`:
every office role reads, administrators and technologists write (the roles
read again inside the write transaction), an unknown product is
`not_found`; the same photo again writes nothing, and the list names it by
`photoChecksum` (SHA-256 of the bytes) without the bytes. A change takes one
host revision (beta 3: the station shows the photo) but not the product's
`rev`, which is the office's `expectedRev` (the dialog uploads a photo and
saves the product after it): host migration `0032` adds `products.photo_rev`,
the feed re-sends the product at that revision (`FEED_KEYS`: `photo_rev > ?1
AND photo_rev <> rev`) with `photoChecksum` in its record (`ProductRecord`, a
record from an older host reads as none), and a station fetches the bytes
with `GET /v1/device/products/{id}/photo` (a device key, `photo: null`
without one; in the license gate's `NEVER`). The station keeps them as
base64 text in `ref_product_photos` (shell migration `0017`, `Disposable`:
a forget empties it; at most 400 000 characters a row), beside
`ref_products.photo_checksum`: `syncProductPhotos` (`src/local/product-photos.ts`)
runs after every successful reference sync, fetches up to 25 photos whose
stored checksum differs from the record's, drops those of products that have
none and never fails the sync (a failed pass is tried again with the sync's
backoff). `ProductPhoto` shows it on the shift card and the new-shift product
card, and falls back to the colour panel's monogram while there is none, on a
failed read and when the picture does not decode. `SYNC_SCHEMA_VERSION` is 5
since then. The dialog writes it at once by its own
buttons, not by «Сохранить». A backup copies the whole database file, so it
holds the photos (a thousand products — up to 300 MB).

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

Organization logo and A4 sheets (plan А4). The organization has one printing logo, `org_logo`
(migration `0016`): a 1-bit bitmap up to 1024 × 512 dots, at most 90 000 characters of canonical
base64, which the office prepares in the browser (`decodeLogoFile` → `logoFromRgba` of the
domain → `logoToWire`, `src/labels/logo.ts`) and the host only checks (size, length, canonical
spelling, zero padding bits of every row — it parses no picture, so no script or external
reference in an SVG ever reaches it). The office's own guards on the untrusted file: a type of
`LOGO_FILE_TYPES` and at most `MAX_LOGO_FILE_BYTES` (4 MiB) before a byte is read — a cap on the
FILE, not on what decoding it costs — and, for PNG, JPEG and WebP, at most
`MAX_LOGO_SOURCE_PIXELS` (8192 × 4096) declared pixels, read once the picture has loaded and
before `decode()` or a canvas (`too_many_pixels`), so a small file declaring a huge picture
does not take the office window down; an SVG is drawn at the logo's size and its declared size
is not counted. `GET/PUT/DELETE /v1/office/org/logo`; the last write wins,
the logo takes no revision and is not in the change feed (a shift freezes it, see «Shifts»).
Without one, every print takes the bundled `src/assets/markiro-print-logo.svg`
(`loadBundledMarkiroLogo`, decoded once in the webview; where it cannot be decoded a thermal
label leaves the `organization_logo` box empty and a sheet does not render). The A4 sheets are a
library of their own, `pallet_sheet_templates`, because every consumer of `label_templates`
reads the layout as a V1 label: a row's `spec` is the domain's `PalletSheetSpecV2` (at most
64 KiB), which the host checks only for `schemaVersion: 2` and `kind: "pallet_sheet"` — the
layout is the domain's to read (`parsePalletSheetSpec`), in the office and on the station.
`GET/POST /v1/office/pallet-sheets`, `PUT/DELETE …/{id}`, `PUT /v1/office/pallet-sheet-default`;
the stock sheets of `buildPalletSheetPresets()` are added by `presetKey` and idempotently, the
main sheet is the organization's default (it cannot be switched off or deleted), and a sheet a
planned shift names cannot be deleted. Sheets are not in the station's feed: the station prints a
sheet only from a shift's snapshot. Preview and print draw through one function,
`renderSheetRaster` (`src/labels/sheet-render.ts`), at A4's nominal geometry.

A4 sheets chosen by default (beta feedback, migration `0019`). A sheet is chosen by default on a
par with the pallet label, at the same three levels: the organization's (`org_profile`'s column of
`0016`), each category's (`category_pallet_sheet_defaults`, one per category) and a product's
preference (`products.default_pallet_sheet_id`). The organization's and the categories' sheets are
part of the templates' defaults document (`defaultPalletSheetId`, `palletSheetCategories` of
`{ chzProductGroupCode, sheetId }`); each must be an enabled sheet (`validation_failed` on
`defaultPalletSheetId`, `palletSheetCategories.{i}.sheetId`, `.chzProductGroupCode`, or
`palletSheetCategories.{i}` for a category given twice). Left out of a `PUT` they are kept (an office
from before them), and a change moves the organization's record, which carries the document's
revision for them (they are not in the feed, so a cleared one leaves no tombstone). A product's
`defaultPalletSheetId` names a sheet, enabled or not, and is the office's only (the feed's product
record does not carry it); left out of a `PUT` it is kept. A pallet document is a thermal label or
an A4 sheet, each in its own slot: every label slot reads `label_templates` and every sheet slot
`pallet_sheet_templates`, so an id of the one is refused where the other is required
(`tests/pallet_sheet_defaults.rs`). Which of the two the station prints stays the pallet printer's
paper (spec §29); the office asks for both and says so. A category's default sheet is held like the
organization's: neither switched off nor deleted (`template_is_default` with `organizationDefault`
and `categoryDefaults`, as a label template's); deleting a sheet clears the products that prefer
it at the delete's revision (`productsCleared` in the audit row, named only when non-zero). A shift
with pallets that names no sheet — an office plan, a station's shift, or an edit's `null` — takes
`default_sheet_for_product` (`PRODUCT_SHEET_SQL`): the product's sheet while enabled, else its
category's, else the organization's, else none; the frozen-snapshot rules are unchanged.

## Cloud import

Plan IMP moves a cloud tenant into a new site (pilot spec §8, §31). Three parts,
tied by one golden file, `proto/fixtures/cloud-export-file.json`:

- `tools/standalone-export` (root `pnpm test:standalone-export`): `export.sql`
  reads one tenant through psql in one read-only REPEATABLE READ transaction
  from a RESTORED COPY of the cloud database (libpq environment, never a
  password argument), and `transform.mjs` turns it into the file. Its
  `payload` passes the host's rules as it stands: what the standalone cannot
  keep is changed or left out there and named in `notes` (the office shows
  them by code). PIN hashes move byte for byte; the tenant's badge salt
  becomes the site's, and a badge whose hash is missing or carries another
  salt is hashed again from its code (trimmed; a code a station cannot read is
  left out), so no badge code ever reaches the file. The SSCC start of each
  prefix and extension is one above the highest serial the cloud handed out
  (counter − 1, any block's end, revoked ones included, and any box's or
  pallet's SSCC, under any prefix), rounded up to the next 10 000; the file's
  `cutover` names the value the cloud's counter moves to (start + 1 000 000
  boxes or 100 000 pallets) for the runbook
  (`docs/runbooks/standalone-cloud-cutover.md`). The organization's GLN prefix
  always has BOTH rows (boxes and pallets), even an extension the cloud never
  issued under (start at its first serial): the standalone issues under both,
  so a rollback must find both cloud counters moved. Any serial another cloud
  tenant holds under the organization's prefix stops the export
  (`sscc_prefix_shared`, the other tenant keeps issuing in the live cloud)
  unless `--accept-shared-prefix`, which adds a note of that code; under a
  counterparty's prefix it is only reported. The cloud's A4 pallet sheets
  (`format = 'pallet_sheet_v2'`) are left out (`template_dropped`, reason
  `pallet_sheet`; their defaults counted in `pallet_sheet_defaults_lost`), and
  the host refuses a template whose spec is a sheet.
  Shift-number counters move for every month the cloud drew a number in; a
  month whose shifts are past its counter (`shift_counter_behind`) or whose
  counter cannot be read (`shift_counter_unreadable`) stops the export. The
  checksum is SHA-256 of the canonical JSON (sorted keys) of the whole file
  without `checksum`; `src/host/cloud-import.ts` computes the same.
  `test/export-sql.test.mjs` runs only with `STANDALONE_EXPORT_TEST_DATABASE_URL`
  (CI's `verify-api-tests`, after the cloud migrations) and seeds two tenants
  of its own. The CLI (`cli.mjs`) needs `--out-dir` (no default: the working
  directory may be a repository, whose `.gitignore` ignores
  `markiro-cloud-export-*.json` anyway) and writes the file whole or not at
  all (`writeWhole`: an owner-only temporary file next to it, fsync, then a
  hard link that never replaces a file, or a checked rename where the file
  system has no hard links; the temporary file is removed on any failure;
  mode 0600 is a no-op on Windows). It prints a summary without a secret on
  stdout and, on stderr, a line for every other cloud tenant that issues SSCC
  under one of this tenant's prefixes (its numbers are NOT in the file) and
  the credential-verifier warning. A file whose cloud was not clean
  (`--rehearsal`) carries `rehearsal: true`.
  The file's format is 2 since plan ТОВ: `export.sql` reads a product's
  EGAIS code and default counterparty as values (raw format 2; the tool
  still reads raw format 1), and `transform.mjs` keeps a code only for ЧЗ
  group 15 and a counterparty only one the file keeps, clearing others
  with `product_value_cleared` (the office words a code of another group,
  `reason: "group"`, and a dropped counterparty by their rule,
  `office.cloudImport.ruleCleared`). A code is never changed: one with a
  control character, a blank one or one past 64 characters is cleared too,
  only the blanks around it go. Photos stay a lost field (`photo`,
  question ТОВ-1: the cloud's pictures live in object storage, which the
  tool does not read). The host and the office read files of formats 1
  and 2 (`CLOUD_IMPORT_FORMAT_VERSIONS`): a format-1 file's products carry
  neither field, and the host checks both by the product route's rules.
- `POST /v1/office/import` (`routes/cloud_import.rs`, administrators, its
  own 32 MiB body limit): its extractor checks the office session and the
  administrator role BEFORE the body is read, and answers every unreadable
  body with a fixed text that quotes nothing. `cloud_import::check` refuses any
  row the office routes would refuse, with the request's JSON path
  (`payload.products.2.gtin14`); inside one `begin_write` transaction the route
  re-checks the administrator, answers a repeat of the same `importId` with the
  stored summary (no write, no revision, no audit row) and any other import
  after one with `conflict` `already_imported`, refuses a site that holds a
  shift, an SSCC block, a category default, a product, a template of its own,
  an operator or a counterparty (`site_not_empty` with `details.entity`; the
  wizard's lines and stock templates may be there) and an organization whose
  GLN is not the file's (`org_gln`), checks the product groups, and then writes
  every row at one revision and wakes the streams. A file line whose name an
  active line has is kept as the wizard made it (`linesPresent`). The
  organization's box and pallet defaults become the file's when it names them;
  the organization's name, INN, GS1 prefixes and time zone are never
  rewritten. The site's badge salt becomes the file's (no badge exists yet, so
  nothing breaks; the `site` record takes it to stations; a file without a salt
  keeps the site's). SSCC and shift-number counters only move forward. `dryRun`
  runs all of it and rolls back: no revision, no wake, no audit row. The audit
  row `import.cloud` (target `site`/`1`, details `importId`, `exportedAt`,
  `rehearsal`, `sourceTenantId` and the summary) is the import's record: a
  repeat reads its summary from there, so it must never be deleted (a future
  audit retention must exclude it), and it holds no hash and no salt. Neither
  import module may log (`no_secrets_in_logs.rs` walks the sources);
  `cloud_import_logs.rs` (outside the sandbox) walks a refused, a tried, a done
  and a repeated import through the process log. Unlike the wizard, the route
  is not loopback-only: any administrator office session can call it (an
  open owner question, runbook §9). It accepts a `rehearsal` file.
- «Сервис → Перенос из облака» (`src/office/import/CloudImportPage.tsx`,
  administrators): reads the file (`readCloudExportBlob` caps the size at the
  host's 32 MiB before it reads; then `readCloudExportFile`: JSON, format,
  version, checksum, then the strict schema), shows its organization (and a
  site GLN that differs), the SSCC table, the shift numbers and the notes,
  sends a check (`dryRun`) and only after a passed check the import, with one
  `importId` per file read, so a retry after a lost answer is the same import.
  The parsed file (verifiers, salt) lives only in a `useRef`: not in React
  state, not in the query or mutation cache (it sends through `call`, not
  `useOfficeMutation`, because a mutation keeps its `variables`), not in a
  log or `console`, and it is dropped when the flow ends, the file is
  replaced or removed, or the page closes. A done import resets the office's
  cached data. A rehearsal file is imported only after a checkbox of the
  confirmation dialog (asked again at each opening; a submit of the form
  without it is refused too), and its done card says to remove the trial
  site; a file exported more than 12 hours before it was read is shown with
  its age.

Never log, store or print a verifier, the salt or a badge code in any of the
three parts; an error names a field path, never a value. The transfer file is
a credential: it lives on the owner's flash drive and machine only and is
deleted after the import.

Not verified: a real cloud copy and its volume, `psql` on the CI runner, the
file chooser in WebView2, a real 32 MiB file and the import of a large catalog
over IPC. The tool's Postgres test ran on a disposable Postgres 17 container
only.

### Imported shift history (cloud → standalone)

Replacement mode (2026-10-18) takes both a catalog and a fully read history
manifest. `CloudImportRequest.replacement.expectedRevision` binds the final
request to the dry-run revision. The administrator explicitly authorizes removal
of test business data; normal empty-site import is unchanged. A dedicated read
connection makes a verified copy in `backups/pre-import` while BEGIN IMMEDIATE
prevents other writers. This subtree is intentionally outside scheduled cleanup
and retention. Backup failure changes no business data; transaction failure
rolls back the replacement and retains the copy. Device identities/keys, office
accounts, licensing files/clock, audit and hardware settings survive. Issued SSCC
and printed document/shift counter floors never move backwards. Device line
assignments are matched to imported normalized names, otherwise cleared.

The same transaction stages the pending history batch and a new
`site.dataset_epoch`, plus durable `replacement_pending` and backup filename.
It clears the previous test dataset's restore epoch/facts hold, superseding them
with the pending-history hold; the old markers remain in the pre-import copy.
Cancel keeps the hold; without its precreated batch, ordinary history upload is
refused until a new explicit replacement or restore. Successful history
completion clears the hold. Imported source/cancellation audit lookups are
scoped to the dataset epoch, while exact importId retries retain their receipts.

`Hello.datasetEpoch` and `x-markiro-dataset-epoch` are separate from
`restoreEpoch`: a replacement discards test queues, never resends the last thirty
days. Business writes check the presented generation at authentication and inside
their transaction; legacy clients cannot write after replacement. Existing change
streams end on a changed generation. Native reconciliation runs before Online,
including a second hello after stream establishment to close the handshake race.
It freezes SQL/network writes and print starts, atomically clears Disposable and
DeviceData tables and stores the generation per host in Installation metadata,
then restarts. Workstation settings and pairing files stay. The process keeps its
old generation/frozen state until restart, so late callbacks cannot refill the
cleared journal. Reconciliation failure blocks floor/office work until restart;
a restored pre-replacement copy's absent epoch also causes reconciliation.
Windows restart and physical printing remain separate acceptance checks.

Catalog formats 1/2 stay unchanged. History is a separate `markiro-cloud-history`
version-1 JSONL: manifest followed by bounded parts (5,000 rows / 4 MiB each).
`CloudHistoryImport` below «Перенос из облака» streams the selected Blob to EOF
before enabling checks, dry-runs every part, resumes by the accepted receipt
inventory and calls complete only after EOF. Blob/code rows stay in local refs,
never mutation variables, persisted caches, logs or storage. Production remains
blocked while pending; only a complete response is shown as ready. Administrators
alone manage state/import/complete/cancel. Cancel names the actual pending batch,
deletes staging, and tombstones its checksum: the same canceled file cannot be
uploaded again; generate a new snapshot, possibly from the same restored copy.

Cloud UI routes are `/cloud-shifts`, `/cloud-shifts/:id`, `/cloud-boxes/:id` and
`/cloud-pallets/:id`, reached from the source links under «Смены». Do not cast an
imported object to `OfficeShift` or synthesize a template, device or scan. Native
`/v1/office/codes` remains a local-only API for older clients. The office `/codes`
page uses additive `/v1/office/code-registry` search/card routes for local journals
and completed cloud snapshots, with an All / Local / From cloud filter. Never
cast cloud provenance to a native scan: missing identity and metadata remain null,
owner-only rows outside the report window stay searchable without dead object
links, and frozen timestamps retain their source zone. Global current ownership
is independent of the display filter. Search pages compact indexed match keys
before batch hydration (50 rows, global 10,000 cap); cloud cards cap occurrences
at 1,000 and signal truncation. Existing accepted imports require no reimport.
GTIN search falls back to the validated canonical AI 01 prefix when a flat-only
record lacks its separate GTIN field; an expression index supports that read key.
This does not rewrite frozen snapshots or populate their nullable metadata.
`CloudOrigin` branches on NIL device provenance:
it links only after the dedicated cloud object resolves, otherwise keeps the
original number/pack provenance as text. Imported disaggregation lines carry
`cloudHistory:true`; their writes require the current administrator, while native
permissions and both office roles' report/conflict-review access are preserved.

Reports use the established domain renderers, `ExportDialog`'s explicit cloud
source adapter and ordinary saved-file controls. Cloud forms use frozen names,
product data, null original logo and original time zone. Cloud shift/box cards
carry `sourceTimeZone`; cloud organization DTOs carry `timeZone`. Shared
`ExportOrganization.timeZone` is optional and omitted in native responses; never
substitute a later local profile zone into a historical form. Closed task blanks
remain unavailable. Missing date and unavailable original disassembled contents
have precise source errors. Flat-only repeats stay in flat TXT/CSV only; a card's
owner count is labeled as current authoritative owners. New files never imply
submission to ЧЗ. Online floor duplicates retain an additive `cloudHistory:true`
outcome from the NIL owner and show cloud origin plus the original shift number;
the native/local outcome, queued journal and ownership behavior are unchanged.

The controlled browser harness `test/harness/cloud-history/index.html` mounts the
real Office, host client schemas, real generators and stored-file checksum reader
against the shared `cloud-history-read.json` fixture using an in-memory transport.
`measure.mjs` exercises import, every shift export, production/warehouse pallet
XML, box/pallet/placard/shift placard forms and file readback. This proves browser
integration, not Rust IPC, WebView2, Windows, printing or external acceptance.

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
For E kept entities a page batch holds at most 3E + 7 statements: the
guard, a deferred wipe (E copy tables, the quarantine, the sync state),
two per entity, the code releases' one delete (plan ДЗГ, below), the
quarantine upsert and lift, and the sync state. That
is 31 for the eight entities kept today, within the shell's 32: a
ninth kept entity needs a smaller batch first. A test builds the worst-case page.
The page's `code_releases` items are acted on, not kept (`ACTION_ENTITIES`):
one `APPLY_CODE_RELEASES_SQL` per page deletes this pairing's `floor_codes` of
the boxes they name, only where this station's box of that id is closed and
of the shift the release names. An open box here is never touched. The
station's copy of the shift is not asked (it lags the host's, for instance
when the office closed the shift while the station was offline, and a release
skipped for that would be lost, the cursor having moved on). The host frees
codes of closed shifts only, so a release names a box it saw closed. The
delete is the station's own disassembly (`box-exceptions.ts`) by box, so
a page applied again, or the whole feed from zero after a restore, deletes
nothing new. An unreadable release is quarantined like any record (the code
stays a local duplicate, fail closed). Its statement is pinned on the shell's
SQLite in `tests/local_db.rs`.
`ENTITY_SET` names the kept entities, the acted-on ones and `SYNC_SCHEMA_VERSION`
(`"org_profile,site,lines,operators,operator_badges,products,label_templates,category_template_defaults,code_releases;v5"`):
raise the version whenever a record schema or the meaning of a copy table
changes, so every device syncs from zero once and gets back what an older
build quarantined or kept differently.
The upserts of operators, badges and the catalog's copies (products, label
templates and category defaults) also skip a record whose newer revision
waits in the quarantine (`notQuarantinedNewer`): the insert would otherwise
bring back what the quarantine's fail-closed delete took away, an access
for a person or an older layout or default for the catalog. The
`org_profile` and `lines` upserts carry the same guard since plan 2a5 (the
floor names them and reads the organization's zone and default template);
`site` has none: its salt never changes after the wizard.
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
rejection. A host restored from a copy answers the revision of the copy plus
one (`markiro-host restore`, plan РК), below what the station last read, so a
station whose cursor passed it sees `rev < since` and starts again from zero.
That alone is best effort (a cursor at or below the copy's next revision sees
nothing), so the station also reads `hello.restoreEpoch` (plan РК-С, "Backups
and restore"): a new epoch writes `from_zero` into `sync_state`
(`FROM_ZERO_SQL`), and the next run fetches from 0 and wipes the copies in the
transaction of its first page, which deletes the mark with the rest of
`sync_state`; until that page lands the copies stay usable.

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
every field, `null` for no plan or no counterparty, the mode (`ShiftInput.mode`,
`"aggregation"` when the input names none, plan РЕЖ) and `palletsEnabled`, so
the host's defaults never decide what was planned; `shiftUpdate` sends what differs from the loaded shift, with its
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
the host keeps accepting the previous version. It is 5 since part B of plan
РЕЖ (the duplicate print: the print policy `validationPrint` of a shift, the
snapshot's frozen `validationPrint` and the `unit_label` fact; 4 since its part
A for shift modes: the body of a shift entry, `ShiftEnter`, and a validation
shift's `ok` scan with `boxId: null`; 3 since plan ПЛ-Х for pallets, 2 since
plan 2a1), 6 since plan ТСД (the handheld on the host) and 7 since plan 2b
(several devices in one shift: a `shift_closed` fact closes a part; app build
1.1.0), with `MIN_PROTOCOL_VERSION` still 1: the host takes the stations of
stage 1, of stage 2a, of pallets and of shift modes (a device of protocol 5 or
older is accepted by a 7 host, since the minimum stays 1), and a station finds a
host of an older protocol too old (`host_too_old` at the probe;
`hello-future.json` stays one protocol ahead, now 8). The owner records each
release in `tools/standalone-release/releases.json` (for 1.1.0: version 1.1.0,
protocol 7, minProtocol 1); the tooling does not enforce it.
The print policy (`markiro_proto::ValidationPrint`, `validationPrintSchema`) is
the cloud's `validationPrint` without its reprocessing of earlier codes (part
C): `{ "mode": "none" }` or `{ "mode": "duplicate_dm", "verification":
"none" | "required", "templateId" }`, each shape with exactly its own fields
(`None {}` is an empty struct variant because serde lets a unit variant of an
internally tagged enum ignore unknown fields). It is an optional field of
`ShiftCreate`, `ShiftUpdate`, `OfficeShift` and `DeviceShift` (left out: none;
a host before protocol 5 sends none), and `ShiftSnapshot.validationPrint`
(`SnapshotValidationPrint { verification, template }`, the duplicate template
whole) is left out unless the shift prints, so a snapshot frozen before part
B reads and writes back as stored (`proto/tests/validation_print.rs`). Zod
adds the cross-field rules: a duplicate only with `mode: validation` (a plan
without a mode is aggregation; an edit without one is the host's to check),
and an entered shift's snapshot froze exactly the shift's policy (same
`verification`, `template.id = templateId`, none when the shift prints none).
The host keeps the policy since task B3 («Shifts»): a shift that prints is
entered only by a station that names both `validation-v1` and
`validation-dm-duplicate-v1` (`station_update` otherwise), and it reads
`unit_label` records («Facts»). `ShiftTotals.unitLabels`
(`markiro_proto::UnitLabelTotals`, `{ sent, verified, skipped, unresolved,
reprints }`) is set only for a shift that prints. Since task B6 the station
enters with `STATION_SHIFT_ENTER` = `["validation-v1",
"validation-dm-duplicate-v1"]` (`shift-enter.json`): it prints unit labels
(«Floor work»); it says why for `duplicate_template_not_fit`.
The host does not look at the protocol of a station that enters a shift (it
records it at pairing only), so a station of protocol 2 could enter a shift
the office planned with pallets and produce boxes without them. The pilot
rules that out by installation, not by a refusal: every station of a site runs
the current protocol (5), installed together with the host's update, and the installer's
check of it is owed to the plan УСТ (it is not done yet; nothing here was run
on a real station). Validation shifts do not rely on that: since protocol 4 a
station names what it works in the body of every entry
(`POST /v1/device/shifts/{id}/enter`, `ShiftEnter.supports` from
`markiro_proto::shift_supports`; the webview sends `STATION_SHIFT_ENTER`,
`{ "supports": ["validation-v1"] }`, through `HostApi.enterShift`), and a
station of protocol 3 sends no body, which reads as naming nothing. The host
refuses a validation shift to a station that does not name `validation-v1`:
`conflict` on `station_update` (`details.constraint`, as every entry
refusal), on the opening and on every entry again, after the shift's own
refusals (`shift_status`, `shift_line`, `shift_busy`) and before anything is
frozen or written; the shift stays planned. The list is bounded like
`shiftEnterSchema` (at most 32 names of 1-64 UTF-16 code units, Zod's string
length, `validation_failed` on `supports`); an aggregation shift needs no
name. A station of protocol 4 or later shows the refusal as
`floor.shifts.refused.station_update` («… Обновите приложение станции.»); an
older one (protocol 3) has no mapping for it and shows its generic
`floor.shifts.refused.failed` («Не удалось открыть смену. Попробуйте ещё
раз.»), so on a site with such a station the office tells the operator to
update the app.
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

### Handhelds on the host

Protocol 6. The capability `handheld-host-v1` is named in `claim` and in `ShiftEnter.supports`; the host
requires it of a handheld on every entry into a shift. A handheld reads the shifts of its line (the office
assigns the line), gets blocks of both extensions, sends facts and closes the shift. Warehouse pallets go through
`POST /v1/device/pallet-events` (five kinds of records, a receipt for each, `device_event_receipts`, codes
`box_not_found`, `box_not_closed`, `box_on_pallet`, `product_mismatch`, `pallet_not_open`,
`pallet_count_mismatch`, `feature_disabled`); the closed boxes are read through `GET /v1/device/box-registry`
(`boxes.changed_at`, window `since..until`, no codes) and the organization's print data through
`GET /v1/device/org/print`. The hold after a restore covers `pallet-events` too. `tests/box_registry_touch.rs`
knows every writer into `boxes`; a new writer must touch `changed_at`.
A touch stamps at least the newest stamp committed so far (`registry_touch::stamp`, under the write lock), and
a walk's `until` is the newest `changed_at` its snapshot holds (not the clock), so a change that commits after
a walk read its snapshot lands in the next window; `since` is inclusive and the boxes at `until` repeat.

### Several devices in one shift (plan 2b)

Protocol 7; host migration `0052_multi_station_shifts.sql` (columns only). A line has
`max_stations` (1–16, default 1; `OfficeLine.maxStations`, `PUT /v1/office/lines/{id}` with
`maxStations`, administrators, never below the live devices of an active shift: `conflict`
`line_stations_in_use` `{ active }`; `line.max_stations_changed` `{ from, to }`). A participant
(`shift_participants`) is `active` (holds a slot), `left` (`POST /v1/device/shifts/{id}/leave`,
frees the slot; repeating changes nothing; `shift.leave` `{ number }`; never entered:
`shift_not_entered`) or `closed`. Each participant row carries `joinedRev` (`shift_participants.joined_rev`, the
host revision of the write that took the slot: a first entry or a return from `left`; migration 0052 backfills
a row already there with its shift's revision) and the wire shape exposes it (`ShiftParticipant.joinedRev`,
optional for older hosts). The leave takes an optional strict body `ShiftLeave { joinedRev }`
(`shift-leave.json`): when the token is not the row's current one (a re-entry came after that leave was sent)
the host answers the shift as it is with no write, no audit row and no revision, so a stale or in-flight leave
cannot undo a re-entry; with no body the leave acts on the current state, as before; a malformed body is
`validation_failed`. A client echoes the `joinedRev` of its own row from its last enter/list answer. A slot is an active participant whose device is not revoked.
Entry into an open shift (`host/src/shift_participants.rs` `decide_entry`): an active participant
enters again (no revision and no audit row, only its last-entered instant is touched); a closed one that names `multi-station-v1` reads the shift back with no write (`myState` `closed`), while a build that does not name it gets `shift_status` `closed` (every old build shows «закрыта»; the read-back's `active` would send it on producing into a closed part); a left or new device
takes a slot while fewer than `max_stations` others hold one (`shift.join`); a new device that does
not name `multi-station-v1` is `shift_busy`. A `shift_closed` fact closes the sender's part; with no
other participant active or left it closes the shift (`closed_by_kind = 'device'`, `closed_by` the
last closer; `closed_at` is the LATEST instant among the device-closed parts, because an offline
station's earlier close may arrive last). A shift opened by an old build can be joined by a capable device (decision D4 checks only the joiner's capability); when the old opener closes its own `shift_closed` only its part closes. Receipts: `partClosed`, `reasonMissing`, `alreadyClosed`. The reason
(`reason_need`, fixture `shift-close-reason-shared.json`): a one-device shift keeps stage 2a's
refusal; in a shared shift only the closing close may need one, by the whole shift's accepted
units against `shifts.planned_qty`, and a close without it closes the shift with
`close_reason_missing`, which the office clears with `PUT /v1/office/shifts/{id}/close-reason`
(`shift.close_reason`). A closed part's later facts are accepted and stamp its `late_data_at`.
Every participant change stamps the shift's `rev` with a revision. `GET /v1/device/shifts` and the
entry's answer carry, for an open or closed shift, `maxStations`, `participants` and `myState`;
`totals { accepted, boxesClosed, pallets, asOf }` and `byDevice` (`host/src/shift_totals.rs`, read
from the facts through `boxes_shift`, `box_items_live`, `pallets_shift`, `code_owners_shift_unboxed`;
a scan takes no revision, so devices read the list again to refresh totals) come in the LIST for an
`active` shift only (a closed shift of the last 30 days would cost a query over its units on every
poll of every device; a client keeps a closed shift's figures from the last answer that had them),
while the answer of one shift (an entry, a leave, a closed shift read back) carries them for any
non-planned status; `OfficeShift` carries
`participants`, `byDevice` and `closeReasonMissing`. The export's `stationClosedAt` is the latest accepted close
instant of the shift's devices (`NULL` when the office closed it).

### Several devices in one shift: the station (plan 2b)

`docs/superpowers/plans/2026-10-20-multi-station-station.md`. Every entry names
`multi-station-v1` (`STATION_SHIFT_ENTER`, `shift-enter-multi.json`). What the host's list and the
answers of an entry and a leave say of a shared shift (`maxStations`, `participants`, `myState`,
`totals`, `byDevice`, and this station's own `participants[].joinedRev` as `joined_rev`) is kept
in `floor_shift_participation` (shell migration `0022`, `TableClass::Disposable`, and in
`RETAINED_TABLES` of the retention pass with a pair in `local_db.rs`;
`src/floor/shifts/shift-participation.ts`): one row per shift, written with the copy in the same
transaction, never recalculated, a read older than the row's `as_of` ignored unless the station
saw the row more than a minute before (a host clock set back); every list read drops the rows of
shifts the pairing no longer keeps. The host's list carries `totals` and `byDevice` for active
shifts only: a closed list item updates the participants and `myState` of a row already there and
keeps its figures (`COALESCE` against the stored row), and makes no row where none is kept (never
zeros). A shift is shared when `maxStations > 1` or more than one device ever entered
(`sharedParticipation`); a solo station on a line of one sees stage 2a.

The hub card joins («Присоединиться», online only), names who works the shift when another
device does, and says a part the host reports closed. When the other devices hold every slot by
the cache it says «Линия занята: N из M» and keeps the join (and the resume of a paused part),
online only (offline the card says «Нужна связь с хостом» in place of the count, which the
participants line still gives) — the hint is advisory and the host decides capacity: the host's list names a revoked
device's part `active`, but a revoked device holds no slot on the host (`active_others`), so a
station that replaces a revoked one gets in although its card counts the line full (PR #775). A
refusal `shift_line_full` is said with its numbers, an entry answered `myState: "closed"` is `part_closed`, enters no copy and caches the
answer's figures; a shared shift's progress is the whole shift's. The work screen's band shows
«Всего в смене» K (the others' part by the host plus this station's own codes, less those the
host counts for no one here — answered `conflict` or `rejected`, or displaced, `readLostCodes`, so a
code two devices took counts once, the earliest scan's; final review I2; `sharedCount`) against the
plan and «Моя станция» N, the group named «Моя станция: N · Всего в смене: K из M»,
and «данные от ЧЧ:ММ» while the link is down; it asks the link for the list every 15 s while
shared and online (`useShiftParticipation`, `HostLinkControls.requestShifts`: another device's
scan takes no revision). The plan notice comes when K reaches the plan.

«Закрыть мою часть» keeps stage 2a's blockers and transaction; the reason follows
`stationReasonRequired` (the host's `reason_need`, fixture `shift-close-reason-shared.json`): a
shift only this station ever worked keeps stage 2a's rule, offline too; a shared close asks it only
online of the last closer, never offline (the host marks it missing). The closed panel says the
part's state from the stored receipt (`readPartState`: `queued`, `waiting`, `shift_closed`,
`reason_missing`, `refused`; `unknown` when the copy is gone or the read fails, said as nothing
rather than as «queued»; a close just written here starts from `queued`, final review m4). The queue screen calls a `shift_closed` record «Закрытие смены станцией».

«Выйти из смены» and a move to another line pause the part (`markLeave`, `leave_requested_at`; a
sign-out does not); the link sends pauses when online (`sendPendingLeaves`,
`HostLinkControls.requestLeaves`) with the body `{ joinedRev }` from `joined_rev` (no body when
none is kept). The sender settles only a permanent refusal (`not_found`, `shift_not_entered`,
`validation_failed`); every other failure keeps the pause queued and does not block the pauses
behind it. An answer whose `myState` is still `active` settles it as already re-entered (the host
saw a later stay and wrote nothing), and any entry, online or offline, drops a pending one.
`SYNC_SCHEMA_VERSION` stays 5.

A station can work a part the host has as `left` (final review I1), deterministically: the operator
leaves with the link up (the host frees the slot), the link drops, and «Продолжить» on the card
(enabled offline for an entered copy) works from the stored snapshot; and by a race: a pause in
flight carries the still-current token (an active part's re-entry stamps no new `joinedRev`), the
entry reaches the host first, and the pause frees the slot after it. Left so, another device could
take the slot and the line would run over `maxStations`. So while the work screen of an active
shift is open (not leaving, not closed by the office), the floor (`FloorApp`, `rejoinLeftPart` in
`src/floor/shifts/shift-rejoin.ts`) enters it again with `STATION_SHIFT_ENTER` whenever the link
is up and the cache says `myState: "left"` with no pause of the operator's own waiting: when the
link comes back and after every read of the host's list (the pause sender's settle asks for one).
The return is tracked by the work gate, so a leave drains it before its pause is written. Decision:
a full line (`shift_line_full`) does not stop the station — it keeps producing, its scans are facts
the host takes from a left part, nothing kept changes — and the work screen says «Линия занята: N
из M» with why and that the station returns by itself (`floor.work.lineFull`); every later read
tries again, and the notice goes once the return is taken. A part closed on the host meanwhile is
kept as closed. A refused key goes to the shell; any other failure waits for the next read.

Known limits and release order:

- Two host reads with the same whole-second `as_of` overwrite each other in arrival order (`>=`),
  so an older read of the same second can land last; the next read after a revision event
  corrects it (final review m1).
- An offline station whose paused part meets a line that looks full in a stale cache cannot
  resume it from the card until the link is back (online the host decides); this follows the
  host's rule (final review m11, PR #775). A press while the link says online whose request finds
  no host falls back to the stored snapshot as every entry does (`enterShift`'s transport case).
- Participant names are cut at one line at 860 px and narrower (tap-to-expand later); the 1280x720
  second card of an unshared pair clips 3 px, outside the guard matrix.
- The shell CSS of the band and cards uses `:has()` (Chromium 105+, WebView2 is newer).
- `test/station-fit.browser.test.ts` takes about 13–23 minutes (`PLAYWRIGHT_CORE`); run it with
  `work-screen-fit.browser.test.ts` when the hub or the band changes.
- Release the host (protocol 7) first; a 1.1.0 station must land before it joins a multi-device
  line, and a station older than that is `shift_busy` on a shared shift.

## Signed documents and trust keys

The license file and the update manifest (spec 2026-10-13, plan ЛЦ-1) are
compact JWS with ES256, checked by `markiro_proto::trust` here and by
`@markiro/domain` (`verifyCompactJws`, `verifyStandaloneLicense`,
`verifyStandaloneUpdateManifest`) in TypeScript. The order is size, form,
`kid`, signature, then the payload, read strictly; both sides refuse a struct
given as a JSON array and an enum given as a one-key object (serde alone would take both; Rust reads through a `Value` and reads `plan` and `channel` from strings only), a byte order mark, a `__proto__` key and a lone surrogate (the
domain's `parseJsonStrict` reads JSON as serde_json does), and keep a
repeated key's last value. Zod still takes `1.0`, `-0`, `1e0` and over-precise forms of an integer that serde refuses; no signer writes them. The license's `tenantId` and `siteId` are opaque
ids the counterparty chooses (`STANDALONE_OPAQUE_ID_PATTERN`,
`trust::is_opaque_id`: 1-64 of `A-Za-z0-9._:-`, compared byte for byte);
`licenseId`, `planVersionId`, `replaces` and `hostId` are lower-case UUIDs.
`packages/domain/fixtures/standalone-license/` holds the shared fixtures: the
signed files with `expectations.json` (the outcome of each, adversarial files
included; an entry may retire kids) and `schema-cases.json` (the field rules),
which `proto/tests/trust.rs` and the domain's Vitest both walk.
`packages/domain/scripts/generate-standalone-fixtures.mjs` makes them with the
TEST keys and never runs in CI: its signatures are random, so a rerun rewrites
every `.jws`. `packages/domain/fixtures/inn-cases.json` holds `normalizeInn`
and the host's `inn::normalize` to the same answers (the JavaScript
whitespace set, not Rust's `trim`).

The keysets a build trusts are `proto/fixtures/trust-keys.json`: public JWKs
only, the license keyset with its issuer's origin (`https://host[:port]`).
Until the owner adds the production keys both keysets are empty and a release
build trusts no license and no manifest. The test keys join them only under
`cfg(test)` or the `test-keys` feature of `markiro-proto`, which only the
host's dev-dependency enables; in a test build the license issuer is the test
one. A unit test of `trust` fails when a production keyset holds a test key's
point under any kid, or the test issuer. `markiro-host trust-keys` prints the
kids of both keysets, and the Windows CI job fails when the release host
prints a `test-…` kid. No tracked file holds a private key but the two test
keys `tools/standalone-release/test/no-private-keys.test.mjs` names; the
production license key lives in the API's environment (plan ЛЦ-0) and the
release key on the owner's machine.

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

Every request of `host_client` (both clients, through `pinned_builder`'s
default headers) carries `x-markiro-app-version`
(`markiro_proto::APP_VERSION_HEADER`, the shell's `CARGO_PKG_VERSION`; plan
ОБН-1). `auth::authenticate` (`AuthDevice`, never `AskingDevice`) writes
`devices.app_version`, `protocol` and `version_seen_at` when the reported
version or protocol differs from the stored one or nothing was reported since
pairing, and takes no write lock otherwise: no revision, no audit row, like
`last_seen_at`. A header that is not plain text of 1–50 characters is ignored;
the protocol is the guard's `ClientProtocol` or, outside the guard, the
header's whole number 1–1000. `GET /v1/office/devices` answers `protocol` and
`versionSeenAt` (optional in Zod: a host of the same protocol before ОБН-1
sends neither; `proto/fixtures/device-record-legacy.json` pins that for Zod
only, the Rust `DeviceRecord` requires `protocol` because only the host writes
it), and «Устройства» shows «0.3.0, протокол 3» or «0.1.0 (при подключении)».

`host_request`, the webview's generic way to reach the host, accepts `GET`,
`POST`, `PUT` and `DELETE`, paths of `[A-Za-z0-9/_.~?=&-]` without `..`, `//` or
a `.` segment, and only the routes `/v1/device[/…]` except `/v1/device/line` and
`/v1/device/update/installer` (plan ОБН-3), `/v1/bootstrap`, `/v1/changes` (not
`/v1/changes/stream`) and `/v1/office/…` except `/v1/office/update-package/…`
(plan ОБН-3).
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
each revision and never opens the stream itself. Before each stream the task
reads `GET /v1/hello` with the same pinned client and no key; the `Online`
status carries its `restoreEpoch` (plan РК-С, absent from the JSON when the
host names none; a host that predates restores answers without it and still
comes online). A failed read ends the attempt before the stream opens — a
transport failure as the link's own error (`unreachable`,
`certificate_mismatch`), any other answer (another status, no body, not a
Markiro host's `hello`, an epoch that does not read) as `stream_refused` — and
the link backs off and tries again, so `Online` always means the host's epoch
is known. A fresh pairing and an unpaired device clear it.

## Hardware

The shell's printers, COM scanners and power request (plan 2a4, ported from
the cloud station's `printer.rs`, `scanner.rs` and `power.rs`) are reached
only through `src/hardware/hardware.ts` (`createTauriHardware`): the floor's
COM scans (plan 2a6, see "Floor work"), and the printers, the scanners'
configuration and the power request (plan 2a7, see "Floor printing").
`src-tauri/tests/ipc.rs` pins the names and arguments, refusals are bare
codes, and the system's own words go to the shell's stderr only.

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
  wrapper ever sends again; the floor's print runtime
  (`src/floor/print/print-runtime.ts`) sends one at a time per address.
  `sent` means every byte left this computer, not that a label printed: a
  network printer sends no receipt, so a paused, out-of-paper or open printer
  that accepted the connection buffers the label and prints it later, and a
  reprint then doubles it; a spooler may take a job for a printer that is
  off. A status query before sending (ZPL `~HS`, a TSPL equivalent) is not
  made: plan 2a7 left it to the owner (`print_bytes` only writes, so it would
  need a read on the same connection and a reply parsed per language, and
  neither a COM printer without flow control nor a spooler queue is known to
  answer one; none of it was tried); the label check by scan is what proves a
  label.
  Other limits, all unverified on Windows: Winsock may count the 5 s over one
  whole `send`, which is why a label goes out in 64 KiB chunks (a multi-MiB
  label to a slow printer stays on the manual list); a printer name that
  needs DNS is looked up on a helper thread and is `not_sent` once the budget
  is spent, but the thread stays until the system's resolver gives up (prefer
  an IP address); a silent first address takes the whole connect budget; a
  spooler job is still ended
  after a failed write, so a half label can reach the printer (whether to
  abort it instead is an owner question); and a COM flush or a trickling
  printer keeps the webview's call pending, so the print runtime answers a
  send it waited `PRINT_SEND_LIMIT_MS` (20 s, queue wait included) for as
  `timeout`, which the job reads as an unknown outcome. The shell's call is
  not cancelled by that: the runtime keeps its address busy until the call
  really ends, so later sends to it end `printer_busy`, and a call that never
  ends keeps it busy until the webview starts again.
- Driver printing (plan ДРВ, `src-tauri/src/printer/{raster,driver,driver_commands}.rs`,
  ported from the cloud station's #696): `supports_windows_printing` answers
  `true` exactly on Windows; `print_windows_raster { queue, payloadBase64, documentName }`
  prints one `mono-raster-v1` page (`@markiro/domain` `encodeMonoRaster`; magic
  `MKRMNO1\0`, 203 or 300 dpi, 10–300 mm, at most 2 MiB, black dots only inside the
  required bounds) to a Windows queue as the document `Markiro:<uuid>`: the driver's
  DEVMODE is set to user paper of the page's millimetres, portrait, one copy, 100 %,
  the page's resolution, and the device context must report that resolution on both
  axes, the paper within one dot, the printable origin inside the page and the required
  bounds inside the printable area (`geometry_mismatch` otherwise), then GDI draws it 1:1 (`StretchDIBits`). It always
  answers `{ ok: true, receipt: { queue, jobId, documentName } }` or
  `{ ok: false, error: { code, phase, receipt? } }`: `before_start` (nothing reached the
  spooler: `unsupported_platform`, `invalid_artifact`, `queue_unavailable`,
  `geometry_mismatch`, `driver_failure`) or `delivery_unknown` (`StartDocW` was called —
  its answer can be lost after the spooler took the job — or a later call failed and the
  document was aborted; a label may come out). `get_windows_print_job { receipt }` answers
  `present` with `statusFlags`, `absent`, `identity_mismatch` or `unavailable` — never a
  printed label. Each runs on a blocking thread with a 30 s limit (`delivery_unknown` /
  `unavailable` past it; the Win32 call is not cancelled, and the print runtime frees the
  queue's address when the command answers at 30 s, so a later label to the same queue can
  start a second GDI job while the first call still runs: labels can come out of order,
  and a reprint of the `timeout` label can double one when the hung one finally prints).
  A failed driver call leaves one stderr line (`standalone: driver print step=` the call,
  `error=` the Win32 code, then numbers; step `geometry` sets the page's dots, resolution and
  bounds against `GetDeviceCaps` and the merged DEVMODE), and a refusal ends with a line
  `standalone: driver print refused code=… phase=…`;
  numbers and call names only, never a label's text, a code, a queue or document name or a
  byte of the page. The lines come from `step_line`/`geometry_line`/`refusal_line`, checked
  on every OS with a fake and `print_logged`; the Windows calls that produce them are
  checked only by the probe crate. The order of the GDI calls lives
  in `submit` over `WindowsPrintApi` and is tested on every OS; `mod native` is
  `cfg(windows)` (feature `Win32_Storage_Xps` for `StartDocW`) and compiles only in
  `standalone-windows-build` — plan ДРВ type-checked it with a probe crate outside the
  repository, and it has never been run. `tests/fixtures/hardware-shapes.json` pins the
  answers for both sides (`windowsPrintOutcomeSchema`, `windowsJobObservationSchema`). The
  wrapper (`createTauriWindowsPrinting`, `windowsPrintResult`) never throws: `before_start`
  maps to `unsupported`, `invalid_payload`, `queue_unavailable`, `geometry_mismatch` and
  `driver_not_started`; a delivery in doubt, a failed IPC call, an answer of no known shape
  and a receipt naming another queue or document (dropped) are `driver_unknown`.
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
  the app lets it go once when the webview starts (`createSystemAwake`,
  `src/hardware/awake.ts`, `reset`); it is idempotent and never fails.
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
  revocation take none. A line change while an operator works in a shift
  waits until they leave it (question В9, "Shifts"). The station keeps the name the host
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
the operator's shifts (`floor_operator`, `src/floor/FloorApp.tsx`, plan 2a5);
see «Operators and badges» and «Shifts».
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

`useHostLink` also reads the station's shifts (`HostApi.getDeviceShifts`, plan
2a5) at the moments it reads the device: once it has subscribed, after every
revision event and on request, one read at a time, retried like the device's
read with a failure count of its own; the answer replaces this pairing's
copies (`replaceShiftCopies`), and `shifts_read` counts the reads that landed
(`ShellState.shiftReads`), so the list reads its copies again after each. A
refused key ends the link as everywhere; any other failure keeps the copies. A
read of the device whose answer could not be kept in `device.json` (`storage`:
the line or the name changed and the file could not be written) sets
`deviceNotSaved`, which the next read of the device that lands clears: the
station works on with the line it has, and the status bar says so. One known
limit of that edge case (an unwritable `device.json`, usually a full disk): the
host lists the device's new line already, so the next read of the shifts drops
the old line's planned copies that were never entered, and the list, which still
asks for the old line, shows only the copies of it that were entered. A new
shift is made on the host's new line. The status bar's warning is the only sign.

The floor's status bar (`src/floor/FloorStatusBar.tsx`, plan 1f2) sits above
the sign-in screen and the shifts, inside one `.floor-frame`, as a labelled
region (`section` with an `aria-label`: inside the app's `main` a `header`
would not be a landmark). It shows the organization and the station's line by
name from this pairing's copies (`readFloorPlace` in
`src/floor/floor-status.ts`: nothing before `copiesReady`; an archived line
is still named, since the station works on it until the office moves it; read
again after every sync, and a failed read leaves the names out), the operator
signed in or «Никто не вошёл», and `HostStatusLine`, which the floor screens
no longer show themselves. Its one control is «Сменить оператора» in a rail on
the right (`OperatorSwitchControl`, the cloud's compact control, 64 px), shown
only with an operator signed in, on every floor screen; the hub keeps no copy
of its own. The bar does not leave by itself: the floor hands the shell its
leave (`FloorApp` `onSignOutReady`), which waits for the work a shift's screen
tracks like every leave, and in a shift the control asks first («Сменить
оператора?», the shift stays open). Its presentation is forked from the cloud station's
one-row header (`apps/station/src/ui/StatusBar.tsx`, `.station-status-*` in
`src/floor/floor-status-bar.css`): the device and the line strong on the first
row, the operator, the shift and the organization quieter on the second (the
labels stay for assistive tech, unpainted), then the link to the host and the
pills (serials, unsent, refused, conflicts, records of an older pairing, and
the scanner, «Клавиатурный» without COM scanners), and the warnings in a
full-width row under it, flat while empty. The same file makes the floor fill
the window edge to edge, as the cloud's `.station-root`. Since plan 2a5 it also names the device
(`DeviceStatus.deviceName`, left out for an older pairing file), the number of
the shift the operator works in (read from the copies, by
`ShellState.floorWork`) and, in a polite region of its own that is on the
screen before either appears, two warnings: while `deviceNotSaved`, and, while
a refusal of the device waits for the operator to leave the shift
(`ShellState.pendingRejection`, the `refusalHeld` prop), «Хост отказал этой
станции: записи не отправляются. Выйдите из смены и подключите станцию
заново». A refusal that comes from a call (a read of the device, the sync or a
read of the shifts; with plan 2a6, a call of the work screen) stops the link
without a status of its own, so `ShellState.link` keeps its last one (an entry
or a creation is not one of those calls: the work screen alone is mounted while
the refusal is held). While `refusalHeld` the bar gives `HostStatusLine` the
link as `offline`, so it says «Нет связи с хостом …» next to the warning
instead of «На связи с хостом», and shows no failed-sync line (that one is
shown only while the host answers).

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

Which PCs lock, and when (owner decision 2026-10-13, after the first Windows
test left a station PC that could neither close the app nor leave the locked
window; it replaced «every PC but an office PC locks whenever no office session
is open» and the host PC's locked first-run wizard):

| Role (`installation.json`)                                      | Station configured | Office session           | Window                                                                 |
| --------------------------------------------------------------- | ------------------ | ------------------------ | ---------------------------------------------------------------------- |
| `office`                                                        | any                | any                      | ordinary, never locked                                                 |
| `host`                                                          | any                | any                      | ordinary, never locked (the wizard, the floor and the office included) |
| `station` or none readable                                      | no                 | any                      | ordinary                                                               |
| `station` or none readable                                      | yes                | none or a technologist's | kiosk mode                                                             |
| `station` or none readable                                      | yes                | an administrator's       | ordinary                                                               |
| any, with `"kiosk": false` in the file or a `--windowed` launch | any                | any                      | ordinary                                                               |

«Configured» is a station paired as a station with a line
(`DeviceStatus.kind === "station"` and `lineId` set): pairing alone leaves the
line to choose, a line is stored only from the host's answer (the line choice
or a read of the device), so it also proves one exchange with the host after
the pairing. Until then — first start, «Служба хоста не отвечает», «Подключение
к хосту в сети», its «Настройки сканера», the line choice — the window has a
frame, a close button and a taskbar button, so whoever sets the PC up can close
the app and reach Windows. A station locks as soon as it is configured and at
every later start (the device is read before anything is decided, so nothing
flickers). Once configured, a line the office clears later keeps the window
locked for that pairing (`configuredDevice` in `App`): the floor does not leave
kiosk mode by having its line taken away; a new pairing (another device id)
starts unconfigured again. A forget (the device-rejected, other-host and
config-error screens' «Сбросить подключение», below) makes the station
unpaired and so ordinary: those screens appear only when the host refused the
device or the config is unreadable, which nobody produces from the floor (an
owner question all the same).

The shell owns what it alone knows (`src-tauri/src/window_policy.rs`): the
role, the file's `"kiosk": false` and the `--windowed` launch, as
`kiosk_permitted`, answered by `kiosk_permitted_now` and enforced in
`lockdown::lock`, which refuses with the bare code `kiosk_off` before any
window property changes (a host PC is never locked, even by a webview that
asks). The rest is the webview's state: `kioskDue` in `src/app/lockdown.ts`
(with `rolePermitsKiosk`, so a shell that cannot answer still never locks a
host or office PC), mirrored by `window_policy::kiosk_due`;
`src-tauri/tests/fixtures/window-policy.json` is the table both sides' tests
read. `App` decides once the role, the shell's answer and the device are known
and sends `enter` or `exit` whenever the decision changes (`exit` sends nothing
for a window that was never locked). An answer `kiosk_permitted_now` cannot
give reads as permitted (the floor's safe side; the role and the configuration
still decide). An office PC is one the installer gave the role «только офис»,
or one paired as a device of kind `office` where the shell gave no role; an
office-role PC never shows the floor, the line choice or the operator sign-in
even if its disk holds a station pairing.

Recovery for an installer who is stuck (both are documented in
`docs/runbooks/standalone-install.md`): `"kiosk": false` added by hand to
`installation.json` (beside the executable under `Program Files`, writable by
administrators only; `installation::InstallationFile`, an optional key, any
other unknown key still refuses the file; the installer rewrites the file, so a
reinstall or an update brings kiosk mode back); and the launch flag
`--windowed` (also `/windowed`, any case). A fresh launch with it never locks;
a second launch while the app runs (`markiro-standalone.exe --windowed` from
Win+R or a console) goes to the single-instance callback
(`window_policy::on_second_launch`), which forbids kiosk mode for the running
app, unlocks the window and sends `standalone://kiosk-permitted` (`false`) so
the webview follows. Every second launch, with the flag or not, also shows,
unminimizes and focuses the window: a locked window has no taskbar button and
is not in Alt+Tab, and starting the app again used to do nothing. Neither is
an authority check: anyone who can run a command on the PC already has
Windows; kiosk mode keeps an operator with a touch screen and a scanner on the
app, it is not a security boundary against a keyboard and Ctrl+Alt+Del.

The office is a mouse-and-keyboard app (owner feedback of the first beta), so
on a configured station an administrator's office session opens in an
ordinary, resizable window by itself (the table's «an administrator's» row);
leaving kiosk mode restores an ordinary window of 1280x800 at most, inside the
monitor's work area and centred (`lockdown::settle_ordinary_window` — the
monitor-sized window kiosk mode left must not stay), and the app also starts
that way (`tauri.conf.json`: centred, not maximized, minimum 960x600). A
technologist's session stays in the locked window; a role taken away during an
administrator's session locks the window then (the table follows the role the
header shows). When the automatic exit failed, the manual way is «Оконный
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
focuses its `main`). Leaving the office locks the window again. The
window mode lasts until a call to the host finds the office session expired
(a page's request, or the header's re-read of the user after a change-feed
revision): the webview has no client idle timer, and the host drops the
session after 30 idle minutes without telling it. An administrator who walks
away from an open office therefore leaves the window framed and closable, with
the office on screen, for anyone on the floor (an open owner question: a
client-side office idle lock on a station PC). Technologists work in the
locked window, so the template import's file chooser and the ZPL/TSPL
`<a download>` saves open under a borderless topmost window; their behaviour
there is unchecked. There is no local maintenance code (one more secret on the
PC; an owner question): on a configured station without the host nobody signs
in to the office, so the ways out are the two recoveries above and Windows' own
Ctrl+Alt+Del (Tauri catches neither it nor Alt+Tab or the Windows key; the
window stays on top, so Task Manager may open underneath it). A failed enter is
logged by the command's name and tried again at the next change of the
decision or restart; nothing on screen says so.

The pairing screen of a station (owner feedback, first Windows test) offers
«Настройки сканера»: `WorkstationSetup` with `scope="scanners"` — the COM
scanners of «Рабочее место» (port, speed, connection, the same storage and the
same `configure_scanners`; printers, sound and the label check are kept as
stored and not shown) plus «Проверка сканера», which says what a scan read
(`src/app/scan-check.ts`: the office's pairing code with its addresses, a
garbled frame — U+FFFD, most often a COM port at the wrong speed — or a length,
a group separator and the Russian layout, never the scan's text). A
keyboard-wedge scanner needs no settings: the pairing payload is read under the
Russian layout and Caps Lock (`parsePairingPayload`). The pairing screen also
hears the shell's COM scanners (`comScans`, `createComScanSource`; only on the
scan form and while nothing is being sent): before, a COM scanner's frame went
nowhere there, since only the focused field took a scan. Its controls are the
floor's 64 px.

The floor's own window control (beta 3, owner decisions): the status bar's rail
holds «Оконный режим» / «Полноэкранный режим» (`FloorWindowControl`, a 64 px icon
button, as on the cloud station) wherever the table locks this PC (`due`, so
never on a host or office PC, in development or on an unconfigured station).
This supersedes «an operator cannot leave kiosk mode» of plan 1f2: an operator
may, but only after a fresh proof of identity (`Reconfirm`), the sign-in's own —
the badge scanned, or the personnel number and the PIN on the keypad
(`signInWithBadge`, `signInWithPin`), so a wrong attempt counts against the same
lockouts and a locked operator or station is refused here too. With an operator
signed in, only their own proof counts; on the sign-in screen any operator's
does. The proof signs nobody in. While the dialog is open the floor's screens are
muted (`createGatedScanSource`: the dialog reads the unmuted source), so a badge is
never taken for a product's code. The way back to full screen needs no proof. An
office administrator's sign-in on this PC opens an ordinary window by itself, as
before, and the office's «Оконный режим» stays. The control sends the same
`enter_lockdown` / `exit_lockdown` as the table's effect; `due` does not change
by it, so the window stays as the person set it until the table decides again.
The same proof guards «Отвязать станцию» in the footer of «Рабочее место»
(`UnpairStation`, mounted there through `UnpairContext`): no shift open, the
dialog says what is lost — the copies with the operators' PIN and badge hashes,
the records not yet sent (they stay on the disk, `keepUnsent`, and never reach
the host) and the blocks a restored host is still owed — and only then the
shell's `device_forget` runs, which now also removes the upgrade's copy of the
database. «Синхронизация» in the same rail (`SyncPanel`) is the cloud's sync
details: the link, when the catalog last arrived since the app started, the
records waiting, the refused, conflicting and displaced ones with the host's
reason in words (the queue screen's own reads and texts), «Повторить сейчас»
(only `requestSync` and `requestFacts`, no protocol of its own) and the same
as plain text to copy.

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

## Installer and service

Plan УСТ ships the app with one NSIS installer for Windows 10/11 x64 and
three roles: `host` (the `MarkiroHost` service and the station), `station`
(a station that pairs with a host on another PC) and `office` (the office
only). The operator's guide is `docs/runbooks/standalone-install.md`; the
pilot spec's «Уточнения плана УСТ» records the decisions and the deviations
from §10. Nothing in this section has run on Windows: the installer, the NSIS
hooks and `smoke.ps1` are covered by text and fake-based tests only, and the
first real run is the `standalone-windows-build` job.

`markiro-host install`, `uninstall`, `stop-service` and `network-check
[--make-private]` (`host/src/main.rs`) are the installer's tools; the first
three refuse outside Windows. `install::install_host` (`host/src/install.rs`)
creates the data directory, then `install::install` makes Administrators the
owner of it, of everything in it (`/setowner *S-1-5-32-544 /T /C`) and of its
parent when that is the `Markiro` folder (a user who made the folder first
would otherwise keep the right to change its access list), and hardens it with
`icacls` by SID — inheritance off, SYSTEM and Administrators full control,
LocalService modify, so no user reads the database or `tls/key.der`, which
hold the PIN and badge hashes and the host's private key; stops a service an earlier version
left running; creates or rewrites `MarkiroHost` («Markiro Хост», own process,
automatic start, `NT AUTHORITY\LocalService`, `"<exe>" service`, restarts
after 5, 30 and 60 s with the count reset after a day, failure actions on a
non-crash exit too, which `service.rs`'s `ServiceSpecific(1)` needs; an
existing service keeps its account — `ServiceSpec.account` is `None` and
ChangeServiceConfigW gets NULL — so an account the customer's IT chose for
the backup share, see `docs/runbooks/standalone-backup-restore.md`, survives
every update, and a service created without one still gets LocalService,
never LocalSystem); replaces the firewall rule `MarkiroHost` (TCP,
`host.json`'s port or 45710 as of that moment, private and domain networks,
`LocalSubnet`, no `-Program`); starts the service and waits up to 30 s. A fresh
install that fails before the start is taken back (service and rule removed);
a failed upgrade keeps the service it found, and a service that was started
and then did not come up stays registered. `uninstall` stops and deletes the
service and the rule and never touches the data directory. The service
manager is behind `install::Services` (`install_windows.rs` on
`windows-service`) and external programs behind `install::Commands`
(`icacls.exe` and `powershell.exe` by their absolute path under
`%SystemRoot%\System32`, and PowerShell takes its script as `-EncodedCommand`,
so no quoting rule can change it), so `host/tests/install.rs` and
`host/tests/network_profile.rs` pin the order of the steps, the exact command
lines and the bounded waits with fakes on any OS; `install_windows.rs`
compiles only for Windows. `network-check` lists `Get-NetConnectionProfile`
(the category as text, UTF-8) and exits 3 while a network is public;
`--make-private` makes the public ones private first. Exit codes: `install` 0
running, 1 failed, 4 registered but did not stay up or still starting after
the 30 s wait (usually an unfinished `restore`: `host.restore-intent` makes
`start` refuse, and Windows keeps retrying every 60 s, so a `restore` may meet
«locked» once and be repeated; or a big first migration);
`network-check` 0, 3, 1; a bad command line 2.

`install_host` first makes the key of the trial's mark (plan ЛЦ-2,
`HKLM\SOFTWARE\Markiro\Standalone\Trial`, `install::trial_key_script`): a
PowerShell script makes it in the 64-bit view of the registry (a 32-bit
PowerShell refuses rather than make it under `WOW6432Node`) and lets
LocalService `ReadKey, SetValue, CreateSubKey` on this key only, without
inheritance (`reg add` opens its key with `KEY_WRITE`, which asks for
`CreateSubKey`); an existing key keeps its values, an uninstall leaves it. A
refusal does not stop the install: `install_host` returns the warning
`install::TRIAL_KEY_WARNING` (no value of the failure), and `main.rs` prints
it as `markiro-host: <warning>`, since the command keeps no log.

The installer build is `tauri build --config src-tauri/tauri.installer.conf.json
--bundles nsis` after `markiro-host.exe` was copied to
`src-tauri/binaries/markiro-host-x86_64-pc-windows-msvc.exe` (ignored by git).
The overlay adds the sidecar (`bundle.externalBin`), the per-machine install
and the Russian installer. Never move `externalBin` into `tauri.conf.json` or
a `tauri.windows.conf.json`: `tauri-build` copies the sidecar at compile time
and reads `tauri.windows.conf.json` on every Windows build, so `cargo test`
would fail without the binary. The hooks (`src-tauri/windows/installer-hooks.nsh`,
UTF-8 with a byte order mark, or NSIS reads the Russian text in the build
machine's code page) take the role from `/ROLE=`, else from
`HKLM\Software\Markiro\Standalone\Role`, else from two questions; a silent
install without a role fails, and a role never changes on reinstall. NSIS
compares strings without regard to case, so the hook maps the role to the
exact lower-case literal before it writes `{"role":"host|station|office"}` to
`installation.json`: that file must carry no other key, or the app's reader
refuses it and the PC becomes a locked-down station. Before files are copied
an existing host binary stops its service; afterwards the host role runs
`install` (a failure fails the installation; exit code 4 is only a warning
with the restore hint) and `network-check`, offering to make a public network
private; the other roles delete `markiro-host.exe`; every role but `office`
opens the app at sign-in (`HKLM\…\Run\MarkiroStandalone`). Uninstalling
ignores Tauri's «delete app data» checkbox (the station's local database may
hold unsent facts); a real uninstall (not Tauri's `/UPDATE`) runs
`markiro-host uninstall` and removes the role, the autostart and
`installation.json`, and an update only stops the service. A failed
`uninstall` or `stop-service` in the hooks is only logged, so files can go
while the service stays registered; the runbook tells the operator to check.
The Tauri template's facts the hooks rely on (hook positions, `$UpdateMode`,
`$DeleteAppDataCheckboxState`, `GetOptions`) come from the signer's hooks, not
from the template, which was not available to read, and no `makensis` has
compiled the hooks.

The app reads its role from `installation.json` beside its executable
(`src-tauri/src/installation.rs`; `Program Files` is writable by
administrators only, so nobody at the station can make it an office PC). A
missing or unreadable file is no role: the app works as a station. An office
PC pairs by code as a device of kind `office` (`DeviceState::claim`) and the
shell refuses its `host_local_pair`, so it can never obtain a station key; its
home is the office sign-in, which has no «В цех», its header says «Выйти»
(`OfficeSessionValue.exitTo`), and nobody signs in on its floor. It still
syncs the reference copies like a station (see «Перенесено» of plan УСТ).

The start screen by role (owner requirement, beta 3.2; `src/app/start-screen.ts`,
`startView`): a `host` PC starts on the office sign-in at every launch (after
the first-run wizard, which still comes first) and reaches the floor on this PC
through «В цех» on that screen; the floor's «Офис» comes back. The choice
(`hostHome` in `App`) lives in the page's memory only and is never stored, so the
next launch starts in the office again; the host office's «Выйти» (not «Выйти в
цех») returns to the sign-in. An `office` PC never shows a floor screen; a
`station` PC, or one whose role the shell could not read, starts as the shell's
view says (pairing and line choice, then the operator sign-in) and keeps the
«Офис» button: the administrator's office session on a configured station is the
documented path above (ordinary window, «Оконный режим»), so it is intentional.
While the role is unknown a floor screen waits («loading»), so a host PC never
flashes the operator sign-in.

`device_change_address` (`DeviceState::change_address`) moves a pairing to
the host's new address: the address is first reduced to `https://host[:port]`
(no user name, password, path, query, fragment or white space, `host_origin`),
and the pairing is kept only when that address presents the pinned
certificate and the host still accepts the device key (`GET /v1/device`), so
the key never reaches another machine; another certificate is
`address_other_host`, a refused key is `key_rejected` (a rejected device), and
nothing changes but `hostAddress` and the connection task's link. The office
sign-in of a pairing with a remote host offers it («Сменить адрес хоста»,
`src/app/HostAddressDialog.tsx`, the address typed as for pairing).

`standalone-windows-build` builds the release host and the installer, runs
`tools/standalone-release/smoke.ps1` on its runner (the three roles and a
silent install without one, the service's account, start mode, restart
policy and a restart after a killed process, the firewall rule, the data
directory's access list, a reinstall that keeps the host's identity and
certificate, a reinstall over an unfinished restore, a refused role change,
uninstalls that keep the data, one with the host running), then
`tools/standalone-release/prepare.mjs` writes the installer under its
release name with `release-evidence.json` (version, commit, roles, hash and
size, `Get-AuthenticodeSignature`'s status) and `SHA256SUMS`, uploaded as
`standalone-installer-<sha>` for 30 days. `pnpm test:standalone-release:contract`
pins the overlay, the hooks, the job's step order and the smoke test's checks.
The installer is not signed (owner question П12); `sign-overlay.mjs` builds
the Tauri overlay for a certificate in the build machine's store, and no
signing material ever reaches CI. Prettier does not cover `smoke.ps1` or the
`.nsh` hooks. The overlay sets `bundle.windows.allowDowngrades: false` (plan
ОБН-1; Tauri's default is `true`), and the release contract pins it: an older
installer over a newer one refuses, so a rollback is an uninstall, the older
installer and `markiro-host restore` of the copy before the upgrade
(`docs/runbooks/standalone-install.md`, «Откат хоста к прежней версии»). How
the NSIS template refuses, with and without `/S`, has not been seen on
Windows. A copy before the migrations that fails is one more cause of
`install`'s exit code 4.

## Updates from a file

Plan ОБН-2 (spec `2026-10-13-standalone-license-and-updates-design.md`, §10,
§22) updates a PC from a package: the installer `prepare.mjs` names and its
signed manifest `markiro-standalone-<version>.update.jws` (compact JWS ES256,
`typ` `markiro-standalone-update+jws`), side by side. CI writes the unsigned
draft (`markiro-standalone-<version>.update-draft.json`: version, commit,
installer, the protocol range of `proto/src/lib.rs`); the owner adds the
channel, the date, `minUpgradeFrom` and the notes and signs it offline with
`tools/standalone-release/sign-update.mjs`: the passphrase from a terminal
only, the key (one encrypted PKCS#8 block) and the result outside any Git
work tree, the installer hashed again against its evidence, and only with a
key the build lists under that kid in `proto/fixtures/trust-keys.json`, not
retired (a package signed by another key would be refused on every site).
Authenticode first, then `prepare.mjs`, then the signing. No key reaches CI;
`test/offline.test.mjs` pins the network crates of the lock and refuses an
updater or HTTP plugin. The shell compares a package with
`app.package_info().version` (`tauri.conf.json`), which `versions.test.mjs`
keeps equal to every crate's version.

The shell (`src-tauri/src/update/`) looks for `*.update.jws` in
`Документы\Markiro\Обновления` (`office_files::UPDATES_ROOT`, not one of the
roots the office writes) and in the root and `Markiro\` folder of removable
drives from `C:` on, no deeper, at most 32 packages, with Windows' «no disk»
window off for the search (an empty card reader is skipped), and verifies
each manifest with `markiro_proto::trust::verify_update_manifest` at once,
read through one handle that follows no link and no further than 64 KiB.
`update_verify` and `update_install` take only a path the last `update_scan`
found. The installer beside a manifest must be named for its version and is
read through a handle that shares reading only and opens no link
(`package::open_installer`); it is started by the final path of that handle
(`GetFinalPathNameByHandleW`), so a junction above it retargeted after the
hash cannot send the start elsewhere, and the handle is kept from the hash
until the app's process ends (`UpdateState::leaving`), while the installer
reopens itself to read its data. `rules::decide` refuses an older version
always (the passive installer would not: `allowDowngrades` stops only `/S`
and the dialog, so this is the only protection on this path), a version
below `minUpgradeFrom`, and, on a PC whose role is not `host`, a protocol
above the host's `hello` (`host_probe::host_versions`, read whatever the
protocol, without pinning the certificate: a number to compare, not a
credential); the same version and a silent host each need a confirmation the
webview sends back, and every one of them must be sent. The launch is
`ShellExecuteExW` with `runas`, the app's window as the prompt's owner (kiosk
mode hides the taskbar a prompt without an owner would flash in) and
`/P /UPDATE /R` behind `launch::Launcher` (a final path of 260 units or more
keeps its `\\?\` prefix and may not start: the office then offers the manual
install; no `/ROLE`: the hooks take it from
the registry; without `/UPDATE` a passive install may uninstall first and the
hooks would drop the role and `installation.json`). Before it the shell
writes `update-pending.json` (`{ from, to, startedAtMs }`); a refused prompt
puts back the mark an earlier attempt left; after a start
`lockdown::release_for_exit` lets the close guard go and the app exits. The
next start reads the mark: «обновлено» (the mark goes), «не завершилось» (it
stays until «Скрыть»), and nothing for a reinstall of the same version, whose
version cannot tell whether it finished.

The office (`src/office/info/UpdateSection.tsx`, after «Лицензия» in
`ABOUT_SECTIONS`) shows the version and the outcome to both roles; only an
administrator searches, checks and installs. On the host's PC it asks the
host for a copy first (`POST /v1/office/backups`, up to 10 minutes) and names
the paired devices whose protocol the new `minProtocol` refuses; it names
this PC's open shift. Then `POST /v1/office/updates/started` writes
`app.update.start` (administrator, the role checked before the fields' form,
after the body's shape: a body the host does not read is a 400 for anyone; the
session's device as the target, `{ from, to, installerSha256, source }`, no
revision — what the office reported, like `shift.export`), and the shell
starts the installer. A host that does not answer the report stops nothing
only when the person confirmed an update without the host. Nothing is
installed while this PC's role is unknown (the host's PC would skip its
copy), the confirmation keeps the report and the role its warnings were
computed for, and an update whose section is left stops before its report
and its launch (`update-flow.ts`, `cancelled`). The installer's
hook asks no network question on an update (`$UpdateMode = 1`). Nothing here
runs on Windows in the macOS tests: the administrator prompt, the handle's
sharing on NTFS, a process started from a held file and the final path
(Windows-only unit tests in `update/package.rs`), removable drives and the
passive update with the hooks (`smoke.ps1` runs `/P /UPDATE` without `/R`)
are checked by the Windows job and by hand.

## Update distribution

Plan ОБН-3 (spec `2026-10-13-standalone-license-and-updates-design.md`,
§10.11, §23) lets every paired PC take the update from the host. An
administrator uploads a package in the office (`update_stage`: the shell
sends the manifest, `POST /v1/office/update-package/manifest`, and streams
the installer from the disk, `PUT /v1/office/update-package/{uploadId}/installer`,
`Content-Length` equal to the manifest's `sizeBytes`, hashed on the fly; the
route reads a `Body`, which no `DefaultBodyLimit` limits, and holds the size
itself). The host keeps at most `updates\staged` (newer than it runs),
`updates\current` (its own version: the only one served) and
`updates\previous`, plus one `incoming-<id>.partial`; the start and an hourly
pass promote `staged` of the running version, the start verifies `current`
whole (`mismatch`, `invalid`, `missing` are not served) and removes
everything else, and a file whose size, change or creation time (inode off
Windows) changed is verified again before it is served (`503
package_verifying`). The packages are no data of the site: no copy holds
them and `markiro-host restore` leaves `updates\` alone.

Review of ОБН-3 (Codex) tightened the store. The promotion hashes `staged`
outside the swap lock and re-checks the folder's identity under it, so an
upload's end never waits for a hash; opening an upload is one step under its
own gate, so a replaced upload is always removed by its id; the package of
the running version is accepted (and promoted at once) only while `current`
is missing, invalid or of another version — the repair of a lost package —
and `package_not_newer` otherwise. The `update.package.stage` row is committed
before the folders move (a failed move writes a second, `failed` row with
`reason: "not_staged"`), and the start writes `update.package.promote` with
`reason: "unrecorded"` for a current package no `ok` promotion row names: a
package never exists without its row, a row may exist without its package.
A download opens the installer and compares the handle (size, times, inode off
Windows) with what was hashed; a write in place that keeps all of them is
caught only by the device's own hash check. The installer limit is 256 MiB.
A paired PC reads the host's `hello` for the final version check through the
pinned connection (`host_probe::pinned_host_versions`); an answer from another
certificate is «host silent» (a confirmation), never a version. Error answers
and upload answers are read to at most 64 KiB, a download's read error is
bounded by the stall limit like a chunk, and the office offer is read again
(bounded: ~2 minutes) while the host says `verifying`.

`GET /v1/device/update` and `GET /v1/device/update/installer` are outside
`protocol_guard` (`server::update_routes`), so a device the host refuses as
`app_too_old` still gets its update, yet both take `AuthDevice`; their
shapes are frozen like `hello`'s. The installer is served whole or as one
`bytes=N-`/`bytes=N-M` range, `If-Range` with another ETag (the SHA-256)
gives the whole file, anything else is `416`; one download per device, three
on the host (`503 update_busy`), 30 update requests a minute per device;
60 s without the client taking a piece cuts it. `update.download` is written
for a download from byte 0 only; `update.package.stage` and
`update.package.promote` (the host) complete the audit. `host_request`
refuses `/v1/device/update/installer` and `/v1/office/update-package/…`:
only `update_fetch` and `update_stage` reach them.

On the device `update_fetch` downloads into `<local data>\updates\<version>\`
over the pinned connection with resume, never past `sizeBytes`, checks the
whole file with `hash_exact`, and the package goes through plan ОБН-2's
`update_verify`/`update_install`, which take that folder's manifest too and
refuse it (`host_differs`) unless the host's `hello` names the package's
very version. The link reports the host's version, protocol and minimum
from every `hello` and `app_too_old`/`host_too_old` instead of
`stream_refused`; the webview offers the update only when the host is newer,
gives a package of its version, this PC is not below `minUpgradeFrom` and
the manifest's signature checked out (`update_check_manifest`). An office
PC paired with a host in the network, whose protocol is outside the window, sees «Приложение и хост несовместимы»; a station
keeps working offline and its line says so off a shift's work. The sign-in
screen offers «Обновить с хоста» (ЛО16) only when the host refuses the
station (`app_too_old`); a station that is merely behind gets the text line
and nothing to press, and the administrator installs the update from the
office. The webview reads the offer through `HostApi.getDeviceUpdate`
(`GET /v1/device/update`, which `host_request` lets through, unlike the
installer route), once per host version and again each time the link comes
online or the host refuses the app; a link flap keeps the offer, and the
dialog keeps the last available one while it is open. Releases keep the window of one
release back: `tools/standalone-release/releases.json` and its contract
(`releases.mjs`; `prepare.mjs` refuses a release outside the window before it
writes a draft). Nothing here ran on Windows or over a real Wi-Fi.

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
  shows it to them alone, between «Сотрудники» and «Устройства». It lists every
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
- «Сотрудники» was removed from the office after beta 3 (owner: an employee
  had neither a login nor a password and the operators live apart). There is
  no navigation entry, no `/employees` route and no «Сотрудник» column or
  dialog in «Операторы»; «Операторы» alone carries the person: name, role
  (position), personnel number, PIN and badges. The host side stays for
  compatibility and is not the office's concern any more: migration `0018`,
  `GET`/`POST`/`PUT /v1/office/employees`, the `employee.*` audit rows, the
  `operators::turn_off_in` cascade on archiving, and the client's
  `listEmployees`/`createEmployee`/`updateEmployee`, schemas and fixtures. A
  cloud import still refuses a site that holds employees (`site_not_empty`,
  entity `employees`).
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
  for a station only, finds the active shift the station works
  (`stationShift`: an active participant, since plan 2b; `ownerDeviceId` only
  for a host before protocol 7), and once another line is chosen, an
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
- «Шаблоны» is one section since the beta feedback (`TemplatesSection`, one menu item): tabs
  «Этикетки» (`/templates`, below), «Листы А4» (`/templates/a4`, `PalletSheetsPage`, which no
  longer sets the default: its list marks the organization's sheet «По умолчанию») and «По
  умолчанию» (`/templates/defaults`, the page below, titled «Шаблоны по умолчанию»). The tabs are
  links drawn with `@markiro/ui`'s data-tab classes; the old addresses `/pallet-sheets` and
  `/template-defaults` redirect. The defaults page offers the organization's «Лист А4 паллеты»
  right after its pallet template, and a category's sheet as a row of its own (tag «Лист А4
  паллеты») added through the same dialog (kind «Лист А4 паллеты», offered once a usable sheet
  exists); the product dialog offers «Лист А4 паллеты» right after «Шаблон паллеты». The choices
  are `sheetChoices` (`src/office/sheet-choice.ts`): enabled readable sheets by name, a held one
  that is off, unreadable or gone kept as a marked choice. The shift dialog's first sheet choice is
  «По умолчанию для товара (…)», named by `defaultSheetFor` as the host resolves it. `Office`
  takes `initialPath` (tests open a page directly).
- Beta 3 office feedback (b3-office): (1) a long selected value (a product group, a
  counterparty) scrolled a dialog sideways because the office's one-column grids
  (`.standalone-form` and its kin in `shell.css`) had an implicit `auto` track that grows to the
  widest value; they now have `grid-template-columns: minmax(0, 1fr)`, so the shared Select
  ellipsizes the value in the closed control (the whole text is its `title`, and each item's) and
  the office's open lists wrap it (a `shell.css` override, the cloud apps keep ellipsis). A new
  one-column grid in a dialog or drawer must join that rule. (2) «Сотрудники» is gone from the
  office (see its note above); «Операторы» carries name, role, personnel number, PIN and badges.
  (3) A product's create and edit form is a drawer (`ProductDrawer` on `EntityDrawer`,
  `src/office/EntityDrawer.tsx`: a `SidePanel` with `FormDialog`'s in-flight guard and, with
  `dirty`, a «Закрыть без сохранения?» confirmation on every way of closing; the pattern for the
  other record forms). Its photo card sits on top: «Загрузить фото»/«Заменить фото»/«Удалить
  фото» and the limits; a saved product's photo is written at once, a new product's is staged in
  the drawer and written right after the create (a failed write leaves the product and a warning
  on the page). The host has no photo rule by group. The list's first column is the thumbnail
  (`ProductThumb`, read per row only for a product with `photoChecksum`, keyed by it). (4) The
  pairing dialog prints and downloads a pairing card: `renderPairingCardHtml`/
  `renderPairingCardFragment` in `@markiro/domain` (A4 or A5: the DataMatrix of the payload, the
  code large, addresses, fingerprint, ten minutes, steps); «Печать» goes through the form printer
  (`usePrintForm`), «Скачать PDF» rasterises the same XHTML fragment through an SVG
  `foreignObject` onto a canvas (200 dpi JPEG) and wraps it in a one-page PDF written by hand
  (`pairing-card.ts`; no PDF library) and saves it with `downloadFile`. The code is one-time and
  secret-like: the card is drawn on a press from the dialog's code and handed to the print frame
  or the download; nothing is stored or logged. Not exercised: `<a download>` and the print
  frame in WebView2, scanning the printed DataMatrix with a real device.

- «Шаблоны по умолчанию» (formerly «Умолчания шаблонов», tab of «Шаблоны») edits the one defaults document
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
  the list does not load, with a note saying why. The number opens the shift's
  card (plan О-Ф, see "Shift card and printed forms"). A shift carries ids, so
  the page names them from `listProducts`, `listLines` and
  `listCounterparties`, an archived record marked «(в архиве)», and one a list
  lacks or that did not load by the first eight characters of its id («Товар
  5e6f7081…»). A lookup that fails leaves the list in place with one warning
  (names that are missing are shown by the start of their codes, and the marks
  of shifts that will not open may be missing) and «Повторить»,
  which reads again only what failed; the retry of a failed list of shifts
  reads the failed lookups too.
- A planned shift a station will refuse to open is marked from the page's own
  lists (`openBlocker`, `src/office/shifts/shift-list.ts`): its product
  archived or a draft (`product_inactive`), or its template switched off,
  narrowed or of another group (`template_not_fit`, by `templateFitsSlot` for
  the product's group), its pallet template so too (`pallet_template_not_fit`)
  or the template of the duplicate it prints so too
  (`duplicate_template_not_fit`, plan РЕЖ part B: «Не откроется: шаблон
  дубликата выключен или не подходит товару»), in the host's order. While a
  list it needs is not loaded, or lacks the
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
  lines; the counterparty is optional. «С паллетами» (plan О-Ф) is offered for
  a product with a pallet capacity: turned on, it takes that capacity and the
  pallet template by the same rule for the purpose `pallet`
  (`suggestPalletTemplate`), both changeable and both required; another
  product chosen takes its own, and one without a pallet capacity turns the
  pallets off. A shift without pallets sends neither field, and a change that
  turns them off sends `palletsEnabled: false` alone (the host clears the
  two). When the template defaults do not load,
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
- «Режим работы» (plan РЕЖ, A8) comes right after the product (`RadioGroup`:
  «Проверка», then «Агрегация», as the cloud orders them; «Агрегация» for a
  new shift, the shift's own for a change). «Проверка» keeps the box template
  with «В режиме проверки этикетки коробов не печатаются» (Р4) and hides the
  box capacity and «С паллетами» with its fields; the form keeps what they
  hold, so «Агрегация» chosen again shows them as they were, and checks none
  of it while hidden (`shiftFieldsSchema` checks the box capacity and the
  pallets for an aggregation only; a refusal of them is cleared when
  «Проверка» hides them). A validation shift sends no pallets
  (`palletsEnabled: false`) and its box capacity as the form holds it (the
  product's, or the planned shift's own: the host keeps the column) when the
  rule takes it, and leaves it out otherwise; a change sends `mode` only when
  it changed. The page opens the dialog for planned shifts only; a shift
  that is no longer planned would show its mode with both choices off (Р1).
  The list and the card call the mode «Проверка» / «Агрегация»
  (`office.shifts.modes`); a validation shift's «Выпуск» is the codes it
  accepted («1 300 шт», `shiftOutput`), its «Итоги» show «Принято кодов»
  without box figures, and its card has no box capacity, pallets or «Короба».
- The dialog's fields come in the cloud's order (Р16, B7), which is also
  `SHIFT_FIELD_ORDER`, the order a refusal takes the focus in: the product,
  «Режим работы», «Печатать дубликат Data Matrix», the date and the plan, the
  line and the counterparty, «Печать дубликата», the box template, then the
  box capacity and the pallets. The flag (plan РЕЖ part B, the cloud
  station's `Checkbox`) shows under «Проверка» only, off for a new shift,
  with «На внешнюю упаковку переносится полный код с продукции. Количество
  продукции не меняется.» under it while off. On, it opens the titled section
  «Печать дубликата» (a `region`): «Шаблон этикетки продукции» offers the
  enabled `product_duplicate` templates covering the product's group
  (`fittingTemplates`, the box template's `templateFitsSlot` mirror), «{{name}}
  · {{widthMm}} × {{heightMm}} мм · {{dpi}} dpi» (the name alone when a size
  is unknown), empty until chosen (no default is suggested, Р16); none
  fitting is an `Alert` (`noTemplates`) and the flag on cannot be saved
  (`templateRequired` under the select, which takes the focus); a planned
  shift's or the form's choice that no longer fits stays, disabled, as
  «Шаблон недоступен — обновите данные»; another product chosen drops a
  template it does not take, with its refusal. «Обязательная проверка этикетки» is off unless
  chosen (the owner's default, the cloud's is on), with the cloud's hint of
  each state, and the cloud's copy hint closes the section. Resets (the
  cloud's): «Агрегация» turns the flag and the check off and clears the
  template and its refusal; the flag turned off clears the template and its
  refusal and keeps the check. The policy goes as the cloud's `toPayload`
  builds it (`toValidationPrint`): `{ mode: "none" }` for an aggregation and
  for «Проверка» without the flag, the duplicate with its `templateId` and
  `verification` with it, sent on every create; a change sends it only for a
  planned shift and only when it differs from the shift's own (`shiftUpdate`;
  a shift without one, from a host before protocol 5, is `none`), so a
  printing shift turned into an aggregation sends `{ mode: "none" }` beside
  `mode`, as the host requires. A host refusal on `validationPrint.templateId`
  goes under the select and reads the templates again. A shift that is no
  longer planned (a guard: the page does not open the dialog for one) shows
  the flag, the template by the name the office knows («Шаблон зафиксирован
  при открытии смены» when it is gone; the office has no snapshot) and the
  check, all disabled, with «Параметры печати и проверки зафиксированы при
  открытии смены.» closing the section, or under the flag when it prints
  nothing. The flag and the check are buttons (Space toggles them), the
  template a native select. The counterparty's hint follows the mode: a validation
  shift prints no box label, so it says «Необязательно», or «Необязательно:
  его название будет на этикетке дубликата» while the flag is on.
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
  and a pasted one is refused with `rules.controlCharacter`, nothing sent. An
  active or closed shift also has «Выгрузка», for every role (plan ЧЗ, see
  "Shift exports"); a closed shift has no other action than «Итоги» and
  «Выгрузка».
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

### Several devices in one shift (office, plan 2b)

- The office reads participation from `OfficeShift.participants`, `byDevice`
  and `closeReasonMissing` and from `OfficeLine.maxStations` (protocol 7). All
  are optional, so a host before it shows the office as it was: a shift with no
  participants has no «Станции» tab, no marks, no «целиком», and a line with no
  limit is a line of one. Every rule about participants lives in
  `src/office/shifts/participation.ts` (`isSharedShift`, `participantLook`,
  `isSilent`, `deviceWorksShift`, `presenceOf`); `ownerDeviceId` is only «who
  opened it» and is never used to find the shift a device works
  (`stationShift`, `installWarnings` use `deviceWorksShift`).
- «Линии»: an active line's «Переименовать» dialog also edits «Максимум станций
  в смене» (`maxStationsRule`, 1–16, `lineUpdate` sends it only when it
  differs from `lineMaxStations(line)`); adding and bringing a line back do not
  carry it. The form refuses a value below the busiest active shift's active
  participants as soon as the shifts are read (`activeStationsOnLine`), and
  maps the host's `conflict` `line_stations_in_use` `{ active }` to the same
  field. When the shifts are not read the client check is skipped and the
  host's refusal is the only guard. The list has a column «Макс. станций».
- «Смены»: the list gains no column. A shared shift's status cell adds one quiet
  line («Устройств: N, закрыли часть: K») and a shift closed without its reason
  the tag «Причина не указана» (`ShiftMarks`). The card gains the tab
  «Станции» (`ShiftStations`) when the shift names participants: device and
  kind, entry, state (a phase tag: working, silent, paused, part closed, closed
  from the office), the units, boxes and pallets of each device from `byDevice`.
  A participant is silent when it is `active` and the host last heard it more
  than ten minutes before this PC's «now». «Итоги» adds «По устройствам»
  (names from `participants`, so a technologist sees them) only when `byDevice`
  has more than one entry; a participant missing from `byDevice` shows a dash.
- Silence is an office-only rule: ten minutes, applied only on lines with
  `maxStations > 1` (the overview card and attention row). The spec §7 states
  it without that limit; the owner is to confirm. The silent mark of «Обзор»
  moves only with its 30-second poll, and `ShiftStations` takes `nowMs` once
  per render (not live). Revoked devices are excluded from «N из M», presence
  and silence, but stay in the «Станции» tab and in the forced-close «Не
  закрыли» list: the host gives a revoked device no slot, yet its open part
  still blocks auto-close.
- «Закрыть смену целиком» (row action, card button, dialog title and submit)
  replaces «Закрыть» for a shift with more than one participant; the dialog
  names `participants.filter(state != "closed")` («Не закрыли: …») from the
  loaded shift and sends the unchanged `{ reason, expectedRev }`: the host
  closes every open part as the office's and audits `shift.force_closed`; a
  preview older than the host's state ends as `stale_revision`.
- «Указать причину» (`planShifts`; row action and card button) is for a closed
  shift with `closeReasonMissing`: a select of the six
  `SHIFT_CLOSE_REASON_CODES` and `PUT …/close-reason`; a reason set meanwhile
  (`close_reason_not_missing`) is an alert in words of its own and a re-read of
  the list. «Обзор» lists such a shift under «Требует внимания»; it reads
  `listShifts` for the planned dates from today minus 6 days to tomorrow
  (`use-overview-data.ts`: `plannedFrom`/`plannedTo`), not «31 days of closed
  ones». A shift closed without its reason therefore leaves the «Обзор» about
  seven days after its planned date, and the default «Смены» list (its own
  31-day window of closed shifts) about 31 days after it; after that it is
  reachable only by widening the period. Follow-up: the host's `list_shifts`
  should also return `close_reason_missing = 1` shifts whatever their date, or
  a dedicated query should list them.
- «Устройства»: the «Линия» cell carries a participation tag under the line's
  name (working, paused, part closed; `presenceOf`); the page reads the shifts
  for it and claims nothing when they do not load. No column was added. The
  page does not poll (its devices list and the «Связь» column are read when it
  opens and after a write, like the rest of the pages but «Обзор» and an active
  shift's card, which read every 30 s), so the tag is as of the last read; the
  revoke dialog names the active shifts the device has an open part in from the
  same read.
- «Обзор»: a line's card says «станций в смене: N из M» only for a line whose
  limit is above one and whose shift names participants (N the active ones); a
  participant of such a line silent for ten minutes is one attention row and
  takes the place of the plain silent-device row of the same device; a shift
  closed without its reason is one row with the way to its card; an active
  shift whose every open part (`active` or `left`) belongs to a revoked device or
  a paused one is one row («ждёт отозванное или приостановленное устройство»,
  `waitingOnAbsentDevices`, with the way to the card's «Станции»): the host
  counts those parts as open, so the shift never closes by itself. A lone
  station that merely paused is not listed. The card's «Станции» tab marks
  «Нет связи» by the host's clock (`useHostClock`, the overview's source) and
  not at all while it is unknown; an active shift's card reads every 30 s.
- The blank: `ShiftTaskFormData.closingRule` is `"each_part"` for the office
  («Каждая станция закрывает свою часть; смена закрывается, когда закрыли все,
  или из офиса.») and absent for the cloud, whose rule (the opener closes) is
  true there. `closingRule` is optional in `packages/domain`, so the cloud's
  bytes and golden parity are unchanged; two each-part snapshot fixtures pin the
  office's sentence, and the office's parity test declares it.
- Exports are keyed by `shift_id` and carry no device: nothing changed, pinned
  by `export-multi-station.test.ts` (codes of both devices in scan order, boxes
  by SSCC, the operation time is the latest device close the host reports).
- Layout: the office rows are pinned by a CSS-text contract test only. No
  office browser harness exists, so 1280×690 has not been measured (see the
  release checklist: «Смены» status cell, «Станции» tab, totals dialog,
  «Устройства» chip, «Обзор» overflow, focus ring; dark and light).

## License in the office and on the floor

- Plan ЛЦ-3 (license spec §9). The host computes the license (plan ЛЦ-2);
  the webview only shows it and never decides a state itself. Every reading
  of the wire's form is in `src/office/info/license/license-view.ts`,
  `license-load.ts`, `license-support.ts` and `src/floor/license.ts`.
- «Информация» → «Лицензия» (`LicenseSection`, the second of
  `ABOUT_SECTIONS`) reads `GET /v1/office/license` (`officeKeys.license`):
  the state in words with the alert's glyph, the terms in the organization's
  zone with the last day inclusive (`lastMomentBefore` of an exclusive end,
  `src/lib/license-dates.ts`), the seats used of the license's (stations
  and handhelds, office users, lines; kiosks are not shown while the host
  does not apply them), the features in words (`customLogo` included), the binding (the file's
  customer and INN, the site's INN and whether they match, the host's id
  with «Скопировать», the certificate's fingerprint, the file's number).
  Every role reads it; the administrator (`useCan("manageLicense")`) loads
  a file, saves the activation request and enables the emergency.
- A file (`.mklic`, at most 16 KiB, read in the webview, never logged or
  cached) is checked by `POST /v1/office/license/preview` and shown as
  «было → станет» (plan, last day, grace, seats, features; the seats a
  smaller file leaves over their limit; a file already expired), and loaded
  by `PUT /v1/office/license` on «Загрузить». A refusal is said in the words
  of spec §9.7 and takes the focus. Without the organization's INN the
  picker is off and the section links to «Профиль организации».
- «Сохранить запрос на активацию» saves the host's request as JSON in a new
  folder `Документы\Markiro\Лицензия\Запрос на активацию <UTC>` (the shell's
  `LICENSE_ROOT`; `json` is one of `FILE_EXTENSIONS`; nothing is opened from
  that root). «Открыть новые смены ещё 3 дня» shows only where the host
  offers it (`emergency.available`: no new shift opens, and the file's or the
  trial's extension is unused), names the host's `effectiveAt` plus 72 hours
  (no PC clock is compared with the host's) and explains `emergency_used` and
  `emergency_not_needed`. A state a newer host adds is named as it is.
- The band above the office's pages (`LicenseBanner` in `OfficeShell`,
  extension point T3) and «Обзор» (one polite region with the copies' warnings,
  T4) show the license's warnings (`licenseNotices`): the trial (neutral, its
  last `warnDays` in the warning tone), the end (subscription and demo), the
  grace, the restriction, the trial's end, another host, a changed INN and the
  host's clock. The light ones hide for the session by kind; the serious ones
  never. The organization's profile is read only for a warning with a date.
  Every revision of the host reads the license again (`Office`). A link to
  `/about#license` focuses that section (`AboutPage`), and `OfficeShell`
  leaves the focus to a page reached by an anchor.
- The support text's «Лицензия» block (`licenseSupportBlock`, the first of
  `SUPPORT_CONTRIBUTORS`, reading through `SupportContext.read`) carries the
  state with its code, the clock flags, the file's short id and sequence,
  its term and issue (UTC), its `kid`, the host's short id, the trial and the
  emergency; never the INN, the customer, the fingerprint or the file.
- The station reads its license with its record (`HostApi.getDevice`,
  `useStationLicense` in `App`): once the link is online and after every
  revision, kept in memory for the pairing (after a restart without the host
  it knows nothing, and opening needs the host anyway). The status bar is
  silent in the trial, while the license runs, in its last weeks and on
  another host; it says the grace with its date (this PC's zone), the
  emergency extension with its end (`emergencyUntil`: then shifts open), and
  that no new shift opens in `restricted`, `trial_expired` and `inn_mismatch`. Then a
  planned shift's card and «Новая смена» give their place to the reason, and
  the new shift's «Создать и открыть» too; the station's own open shift, the
  work, the boxes, the pallets and the close never change. The host's
  refusals `license_restricted` (by `details.state`) and `feature_disabled`
  (pallets by name) have words of their own.
- The shell keeps a pairing's `conflict` on `seat_limit` and
  `feature_disabled` (`license_refusal` in `device.rs`, the local pairing and
  the claim) as codes the pairing screens explain without figures (the
  station cannot read the license before it is paired) and do not remember
  (the code is not spent). An office write over the license says
  «Достигнут предел лицензии: N из M» or the feature it lacks
  (`alertFailure`, `failureValues`).
- Not proven by the tests: WebView2's picker and drag and drop of a `.mklic`,
  the documents folder redirected or on OneDrive, Explorer's «Показать
  папку», the clipboard in WebView2, a screen reader on the band and the
  focus, the floor on the touch panel, the real host's routes (only a fake
  `HostApi`), a real seat refusal of a pairing.

- «Обзор» has a «Лицензия» card (`LicenseCard`: the state in words and the
  link to «Информация»); its warnings share one polite region with the
  copies'.

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
or none (at most `MAX_PLANNED_QTY`, 10 000 000). `mode` is the cloud's shape:
`aggregation` (the default) or, since plan РЕЖ, `validation`, which puts codes
in no box and so has no pallets (`validation_failed` on `palletsEnabled`,
checked before either pallet field, on a create and on an edit alike; without
pallets a shift takes no A4 sheet, the default one included); its box template
and capacity stay, unprinted. A planned shift changes its mode by an edit
(`details.changed` names `mode` with its `{ from, to }`; `shift.create` names
`mode` only for a validation shift, as it names a sheet only for a shift with
one); an active one keeps it (`conflict` on `shift_status`). The order of an
edit's refusals (`update_shift`): the shape of each scalar field first (the
counts and the date); for a planned shift the mode's rule (`check_mode_rules`),
before either pallet field; then the pallet fields' own rules
(`shifts::pallet_request`), for any status: an active shift sent
`palletsEnabled: true` without a template is `validation_failed` on
`palletTemplateId`, as before plan РЕЖ; then the status, so an active shift
sent another mode, or pallets (with a template) its validation mode cannot
have, is `conflict` on `shift_status`, not `validation_failed`; then, for a
planned shift, the line, templates and counterparty that change (the box
template before the duplicate template, as at planning). A station's
own shift (`DeviceShiftCreate`) is created as aggregation, planned until a
station enters it; while it is planned the office may still edit it like any
planned shift, its mode included. A validation shift may print a Data Matrix
duplicate of each accepted code (plan РЕЖ part B, migration `0021`):
`validationPrint` is `{ "mode": "none" }` or `{ "mode": "duplicate_dm",
"verification": "none" | "required", "templateId" }`, stored in
`shifts.validation_print_mode`, `_verification` and `_template_id`. A
duplicate needs mode validation (`validation_failed` on `validationPrint`,
after the mode's own rules; on an edit only for a planned shift, where a
policy left out is the shift's, so a printing shift turned to aggregation must
send `{ "mode": "none" }` in the same edit) and a template of the
`product_duplicate` purpose that is enabled and covers the product's group
(`shifts::check_duplicate_template`, `validation_failed` on
`validationPrint.templateId`, after the box template; on an edit only when the
template changes, a kept one stays like the box template). Left out or `null`,
a plan has none and an edit keeps the shift's (no helper refuses `null`; an
edit reads it as left out, as it reads `mode` and `lineId`; a test pins it). An edit writes the mode and the three policy
columns in one `UPDATE`, which the triggers of `0021` check together; an
active shift's other policy is `conflict` on `shift_status`, the same policy
again no change. `shift.create` names `validationPrint` only when it prints,
`shift.update` names it with its `{ from, to }` (`{ "mode": "none" }` for
none). `OfficeShift` and `DeviceShift` carry the policy only when it prints
(left out: none). A shift with pallets (`palletsEnabled`, plan
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
planned shift names, for its boxes, its pallets or its duplicates (plan РЕЖ
part B), is not deleted (`conflict` on `template_in_use`, with
`details.shiftIds`; `PLANNED_SHIFTS_NAMING` of `routes/templates.rs`, its plan
pinned on `shifts_status_production_date`), since the shift prints with it
once a station opens it;
an open or closed shift has the layout in its snapshot. Disabling or narrowing
such a template is not refused: the shift then does not open, and the office
sees why.

A station reads its shifts with the device key (`GET /v1/device/shifts`;
the shift routes of a device are a station's, and another kind of device is
`forbidden`): the planned and active shifts of its line, and the shifts it
entered that are active or closed within 30 days, by production date; a
station without a line sees only the latter. A shift with pallets also
names `palletBoxCapacity` and `palletTemplateId`; a shift without leaves
both out, so a station of stage 2a reads its list as before. It reads them
when it reads its device record (after it subscribes to the link and after
every revision event), not through the feed: shifts are per line, and an
open one carries up to two layouts (a box's and, with pallets, a pallet's).
A shift's product name and GTIN and its
counterparty's name are the snapshot's once it is open and the records' before
(the station keeps no copy of counterparties); `ownerDeviceId` names the
station that opened it, and another station's id means the shift is busy. A
station creates a shift on its own line while the host answers
(`POST /v1/device/shifts`), under the office's rules, pallets included
(`palletsEnabled`, `palletBoxCapacity`, `palletTemplateId`, all optional and
left out by a station of stage 2a); a station without a line
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
organization's GLN; the counterparty's name; with pallets the pallet
template's id, name, revision and layout as `palletTemplate`, which a shift
without pallets leaves out), makes the station the shift's
owner, adds it to `shift_participants` and takes a revision, so the line's
other stations see the shift busy. The owner enters again with no revision and
gets the same snapshot back, so a station that lost its database recovers it;
a change of the catalog, the template or the GLN never changes it. A pallet
template disabled or narrowed since the plan keeps the shift planned
(`conflict` on `pallet_template_not_fit`, checked after the box template). A
validation shift that prints (plan РЕЖ part B) freezes its duplicate template
the same way, with the verification, as `snapshot.validationPrint` (`{
verification, template }`); one disabled or narrowed since keeps the shift
planned (`conflict` on `duplicate_template_not_fit`, after the pallet
template), and `shift.open` names `validationPrintTemplateId` and
`validationPrintTemplateRev`. A
closed shift is `shift_status` for every station, a shift of another line (or a
station without one) `shift_line`, a shift a device that never entered an open
shift and names no `multi-station-v1` meets `shift_busy` (stage 2a's answer,
kept for older builds), and one that names it `shift_line_full` while every
slot of the line's `maxStations` is held (plan 2b, below). The snapshot is at most
320 KB (a `CHECK` of `0009`, `shifts::MAX_SNAPSHOT_BYTES`): a box layout and a
pallet layout (or a duplicate layout) that together exceed it keep the shift planned (`conflict` on
`snapshot_too_large`, checked at the entry after the templates, before a
revision is taken). The host never checks a layout's content: the station
does, with `labelTemplateSpecSchema`, when it enters. The opening writes
`shift.open`; a later device's first entry, or its return after it left, writes
`shift.join` (`{ number, rejoined }`, plan 2b; the name `shift.enter` foreseen
here was not used).

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

The audit rows of this part are seven, all `ok`: `shift.create` (an office user,
or a station as the device; target `shift`, details `{ number, productId,
lineId, productionDate }`), `shift.update` (an office user; the update details
of `lineId`, `productionDate`, `boxTemplateId`, `boxCapacity`, `plannedQty`,
`counterpartyId`, `palletsEnabled`, `palletBoxCapacity` and
`palletTemplateId`, no row when nothing changed), `shift.delete` (an office
user; `{ number }`), `shift.open` (the station; `{ number, templateId,
templateRev }`, plus `palletTemplateId` and `palletTemplateRev` for a shift
with pallets), `shift.close` (the device whose close closed the shift; plan 2b adds
`participants`, `acceptedTotal`, `reasonMissing` for a shared shift),
`shift.force_closed` (an office user; `{ reason, notClosed }`) and
`sscc.block.issue` (a station; target `sscc_block`; `{ issuerPrefix,
extension, fromSerial, toSerial }`). A refusal writes none.

The office closes an active shift (`POST …/{id}/close`, `{ reason,
expectedRev }`, administrators and technologists), for a station that died or
a shift nobody will finish: the reason is words, 3–500 characters without
control characters (`validate::close_reason`), kept in `close_reason_text`; a
planned or a closed shift is `shift_status`. The close also closes every part still open as the
office's and writes `shift.force_closed` with `{ reason, notClosed: [{ deviceId,
state }] }` (plan 2b; before it the office wrote `shift.close` `{ reason }`,
which old rows keep), `reason` being the trimmed text. The refusals
come in the order of `PUT`: a bad reason is 400 even for an unknown id, then
the lookup (404), then a stale `expectedRev` (`stale_revision`), then
`shift_status`. A station's close is a fact (plan 2a2) with one of the
domain's six reason codes in `close_reason_code`, and the facts of a shift the
office closed are taken and marked late.

SSCC blocks: a station asks for a block of serials
(`POST /v1/device/sscc/blocks`, `{ requestId, issuerPrefix, extension }`,
stations only) when it has none for its shift's prefix or its newest is half
used (plan 2a6). A block is of boxes (`extension` 0) or of pallets (1, plan
ПЛ-Х; `validation_failed` on `extension` otherwise), of a prefix that has a
counter for that extension (`validation_failed` on `issuerPrefix`
otherwise). A block is the counter's next `site.box_block_size` serials (2000
by default) or `site.pallet_block_size` (200; «SSCC → Размеры блоков»), fewer
at the end of the prefix's serials, and then `sscc_exhausted` (409, with the
prefix and the extension). The counter moves past the block with a new
revision in the same
transaction, so every issued serial lies below its counter, `sscc_below_floor`
keeps it from being issued again, and a counter form opened before the issue
meets `stale_revision`. The same `requestId` of the same station answers the
same block, even after others were issued, but only for the same prefix and
extension: the id with another `issuerPrefix` or `extension` is
`validation_failed` on `requestId` and writes nothing. A correct station keeps
the request beside the id and repeats it whole, so a mismatch is its mistake,
and the old block's serials must not be filed under a prefix, or printed on
labels, they were not reserved for (a shift create is lenient the other way,
since a station reads that shift from the answer). The device is read again
inside the write transaction (a station revoked while the request waited
gets 401). A block's use (`consumed_through`) comes with the facts of plan
2a2; revoking blocks and showing them per device with plan 2b. A counter the
last block moved past its last serial (`nextSerial` above `maxSerial`) shows
on the office's «SSCC» page, a box counter and a pallet counter alike, as
«Номера закончились», with no change offered: no number could be valid there
(`isExhausted`, `src/office/sscc/counter-kind.ts`).

The station's side (plan 2a5). After a sign-in the floor is `FloorApp`, a small
machine of its own like the cloud station's: the line's shifts
(`src/floor/shifts/ShiftList.tsx`), a new shift (`NewShift.tsx`) and the work
screen of the shift entered (`src/floor/work/WorkScreen.tsx`: scanning and
boxes, see "Floor work") and, from plan 2a7, the workstation setup (see "Floor
printing"). `App` keys it by the pairing and the session, so nothing
of one operator's screen outlives their sign-out. Any operator signed in may
enter and create shifts (question В10): the station checks no role. The list
shows this pairing's copies of the line's planned and active shifts, one
this station is closing and one the office closed after this station entered
it, until this station closes it («Завершить», plan 2a8; `readShiftCopies`),
never another closed one, so it stays on screen with the host away. Every read of the host's list replaces the
copies (`replaceShiftCopies`): a shift this station never entered goes when
the host stops listing it, and one it entered stays with its snapshot whatever
the list says and never goes back to `planned` (a list read before the
entry). Opening a planned shift and creating one need the host: it freezes
the snapshot and numbers the shift. «Открыть» and «Новая смена» are therefore
disabled without the link, with the reason on screen; «Продолжить» enters an
active shift of this station from its stored snapshot without the host (a
station that keeps no snapshot of it needs the host too), and with the host
re-enters through it and keeps the answer; a shift another station opened is
shown busy, with nothing to press. An entry checks the snapshot
(`checkShiftSnapshot`: the domain's `labelTemplateSpecSchema`, a GTIN-14, the
nine digits of the issuer prefix) and neither keeps nor works one this build
does not read; a request that finds no host although the link was online falls
back to the stored snapshot; the host's refusals (`shift_busy`,
`shift_status`, `shift_line`, `product_inactive`, `template_not_fit`,
`not_found`) are said in words, and a refused key goes to the shell. A station
on a PC away from the host (the pilot spec's variant А) enters its planned
shifts while the link is up and works them later without it. One entry and one
request run at a time, «Сменить оператора» and «Назад» are never held by them,
and an answer that lands after its screen is gone is dropped (`FloorApp`
unmounts `NewShift` on «Назад»).

What `FloorApp` does with an entry is a gate of its own, beyond the entry's
result: `readStoredWork` answers `ready` for any entered shift with a
readable snapshot, a host-closed one (`copy.status === 'closed'`) or one this
station is closing (`localState !== null`) too, so its callers decide.
`enterShift` enters a copy the office closed from the stored snapshot, with
the host or without it (plan 2a8: it is finished on the station, and the host
refuses to enter a closed shift), and refuses one this station is closing.
`FloorApp`
turns back to the list (telling the shell nothing: no `work_entered`, so no
scan can be taken) any shift whose copy is neither active nor closed by the
office, or has a `localState`; a shift the office closed is entered with
`officeClosed` set, in finish mode (see "Floor exceptions and close"), and the
shell is told of the work as for any other shift.

A new shift takes its product from a scan (a GTIN or a code of marking,
`classifyScan`; two products in use with one GTIN are not guessed between) or
a search by name among the products in use, its box template by the rule of
decision 7 (`suggestBoxTemplate`, with a choice only when the rule leaves
several), the production date as today in the organization's zone (moved by
whole days, never typed), an optional plan and the product's capacity. The
`requestId` is one per chosen product: choosing a product, also again after
«Другой товар», mints a new id, and retries of that form repeat it, so a lost
answer makes no second shift. Once the host has answered for it the form is
frozen (fields disabled, the button only enters that shift), because a
repeated id brings the first shift back whatever the form says now; the
returned shift is compared with the request (`isShiftOfRequest`: product,
template, production date, capacity, plan), and one of other fields, an
earlier request's, is not entered in silence: a notice says it existed
already, with its number, date, capacity and plan, and the button opens it.
A matching shift is entered at once. The id is not kept across a restart of
the app: a repeat then makes a second planned shift (`/S`), which the office
deletes.

Leaving the shift — back to the list, a sign-out (the operator's own, idle,
removed), another line — waits for the work the screen
tracks (`createWorkGate`, `src/floor/work-gate.ts`: a failed piece of work
does not hold it, work tracked while it waits does), then tells the shell
(`work_left`). One leave waits at a time: a sign-out outranks a leave that
already waits (the idle lock fires once and then waits for nothing more, so
the wait ends in the sign-out); any other leave that comes meanwhile is
ignored. The office's close of the shift is no leave (plan 2a8): the screen
stays on the shift in finish mode and the operator leaves when done. A leave for another line ends on the list when the move
was undone: a later read of the
device that puts the station back on its line clears `pendingDevice`, so
`work_left` changes nothing and the floor shows the list, where a move that
stands takes the floor away at `work_left`. While the operator works in a
shift (`ShellState.floorWork`, set by `work_entered`), a refusal of this
device (`key_rejected`, `certificate_mismatch`, from the link or a call) waits
in `pendingRejection` (question В8) and another line in `pendingDevice`
(question В9): the link stops at once (`App` treats a waiting refusal as a
refusal for the link), the line finishes its box, and the refusal or the move
takes the floor at `work_left` (a refusal first). The floor leaves the shift
by itself for another line; for a refusal it waits for the operator, and the
status bar shows the held refusal (see "App shell"). A second refusal held
meanwhile replaces the first. The idle wait runs for the whole session, and
`touch` restarts it for a scan that presses no key (a COM scanner, plan 2a6).

Plan 2a6 replaces the body of `WorkScreen` and keeps its props
(`WorkScreenProps`), which it owes the floor (the JSDoc of the type is the
contract; the floor cannot check any of it): every write to the local
database, send to the host and job for the printer goes to `track` before it
starts; no scan is accepted while `leaving`; tracked work is bounded, because
the gate has no timeout of its own (a local write ends in about 35 s at the
most, the shell's hand-over to the printer in 5 s, a code check at the host in
300 ms, a request for a block in up to two host calls of 10 s each), so work
that can wait longer must not be one tracked piece; and the way back to the
list stays on the keyboard while the leave waits (`aria-disabled`, not
`disabled`, or the focus moves to the wait text). A leave that a timer or an
answer started is known to the screen at once through `isLeaving` (the
render's `leaving` lags behind it); both refuse a scan and a close the
operator presses.

Plan 2a6's gate task holds the two things that used to drop the work at once:
another host found by the sync (`sync_finished` with `other_host`) and every
`host_probed` answer wait while the operator works in a shift
(`pendingOtherHost`, `pendingProbe`) and are applied by `endWork` when they
leave it, after the gate drained: a refusal of the device first, then the
other host, then the probe's answer (the last one counts, and it signs the
operator out), then another line. The held other host stops the link
(`linked = null` in `App`, `FloorApp.rejectionPending`), so nothing is
delivered for the rest of the shift and the status bar says why; the operator
keeps working offline. Records made under a replaced host can be delivered
only if the original host returns, otherwise only through the forget's
«Сбросить всё равно» (a host replaced at the same address in the middle of a
shift is plan 2b's). The status bar reads its own three outbox statements, so
`countUnsentRecords` is still called once per forget (`App`); a plan that
calls it repeatedly adds its exact text (`acked_at IS NULL AND host_id = ? AND
device_id = ?`, not the order the Node list pins) to both query-plan lists.

A shift's A4 sheet and organization (plan А4). A shift with pallets may name a sheet
(`palletSheetTemplateId`, only with pallets — a database trigger and the routes refuse it
otherwise; without a request the host takes the main sheet, a shift made on a station always
does). An edit's `palletSheetTemplateId: null` (`ShiftUpdate`, a double option like
`counterpartyId`) is «the organization's main sheet as it is at this edit»: `default_sheet` in the
edit's transaction (none without a main sheet) is stored as the shift's sheet, so a later change
of the main sheet does not reach a planned shift; without pallets `null` asks for nothing and
passes, on an open shift it passes only when it changes nothing (`shift_status` otherwise). The
office always offers «Основной лист организации» (`sheetOptions`) and sends `null` only from a
shift that holds a sheet of its own (`shiftUpdate`). `shifts::snapshot` freezes, when the shift is opened, the sheet (`palletSheet`: id, name,
revision and the whole spec) and the organization (`organization`: name, INN, logo as
`width`/`height`/`pixelsBase64`) into the snapshot beside the layouts, and nothing re-reads them
for that shift: renaming, switching off, deleting the sheet, changing the organization or its
logo changes the NEXT shift only. A sheet switched off after the shift was planned is frozen as
it is; a sheet missing from the table is frozen as none (never replaced by another). The station
reads them in `checkShiftSnapshot` (`palletSheet`, `organization`): a layout or logo the build
does not read is `null`, not a refusal of the shift — the thermal labels still print and an A4
print of that shift ends `render_failed`. The snapshot keeps its bound of 327 680 bytes, so a big
sheet or logo can make the entry `snapshot_too_large`; the station table is unchanged (the
snapshot is the text of `floor_shifts.snapshot`).

## Stored files

Beta 3 owner decision: «файлы должны быть доступны всегда для выгрузки». Every file
the office generates is kept on the host, so a file lost from the office PC's
`Документы\Markiro` folder is still downloadable. What is kept: a shift's and a pallet's
ЧЗ export parts (`shift_export`, `pallet_export`), a disaggregation document's ГИС МТ
file (`disaggregation_xml`) and the printed forms (`form`, format ids `form_box`,
`form_pallet`, `form_placard`, `form_placards`, `form_task`, `form_act`), printed or opened
in the browser alike. Not kept, on purpose: the pairing card (it carries a one-time code),
the support bundle (a diagnostic snapshot) and a label template's ZPL/TSPL/JSON (the
template is the host's data; the file is rebuilt on demand). The cloud's inventory documents
and True API exports have no standalone counterpart (no inventory, no cloud).

- Generators are untouched: `@markiro/domain` renders in the office window exactly as before
  (parity: `test/export-parity.test.ts`, `test/forms-parity.test.ts`); the host never renders
  or reads a file. A new generation hands the bytes to the host FIRST
  (`src/office/exports/stored-files.ts`, `storeExportFiles`), then the shell writes the
  folder copy, then the record is written. A host that cannot keep a file (store full, too
  large, unreachable) never stops an export: the dialog says why and the folder copy is made;
  a folder that cannot be written does not stop it either when the host holds the files (the
  export is recorded and says so). Only when neither has the files is it a failure.
- Transport: Tauri's IPC is JSON, so files go by chunks of at most 1 MiB, base64. A file of
  one chunk goes whole in `POST /v1/office/export-files`; larger ones are begun there, sent by
  `PUT …/{id}/chunks/{seq}` in order (a repeated chunk with the same bytes is fine) and sealed
  by `POST …/{id}/complete`, where the host checks the size and SHA-256 declared at the
  begin. The file's id is derived from `(batchId, partNo)`, so a retry is the same file.
  A half-sent file is never listed or served and is swept after an hour.
- Storage: SQLite, `export_files` (record: kind, target, shift, format and version, name,
  media type, size, SHA-256, generator = the office build, creator, time) and
  `export_file_chunks` (each chunk deflated when that saves a tenth, with its own SHA-256).
  In the database, not beside it, so every copy and `markiro-host restore` carry the files
  with no second place to keep in step. Cost: each copy holds every file stored before it,
  and a copy is a whole database: the store is capped at 2 GiB as it occupies the database
  (`EXPORT_STORE_MAX_BYTES`, refused with `export_store_full` and 507), a file at 256 MiB
  (`export_file_too_large`), an export at 1000 parts. The retention is the administrator's
  setting (`export_settings`, 30–3650 days or «Хранить всегда», the default); a term deletes
  the older files when it is saved and when the next file is stored, and `shift.export.purge`
  says how many.
- Serving: `POST …/{id}/download` re-reads every chunk, checks the whole against the stored
  SHA-256 and size and only then writes `shift.export.download` and answers with the chunk
  count; bytes that no longer match are `export_file_corrupted` with a `failed` row and the
  host serves nothing of the file (a chunk is also checked by its own SHA-256). The office
  checks the SHA-256 again before it saves, byte for byte, into a new folder under
  `Документы\Markiro`. Audit: `shift.export.store` (target = the file's target, details name
  the file, never its bytes), `.download`, `.purge`, `.retention`.
- Routes (every office role unless noted; a device key is `401`; all in
  `license/gate.rs` `NEVER`): `GET`/`POST /v1/office/export-files`, `GET`/`PUT …/settings`
  (`PUT`: administrators), `PUT`/`GET …/{id}/chunks/{seq}`, `POST …/{id}/complete`,
  `POST …/{id}/download`. A disaggregation file is stored by the roles that may
  disaggregate, as its record is. The shift's history (`GET …/shifts/{id}/exports`) names each
  export's stored files (`files`, empty for an export from before `0029`: «Файл не сохранён:
  сформируйте выгрузку заново»); the drawer's «Выгрузки» also lists the shift's forms and the
  retention, and the box, pallet and disaggregation cards have «Сохранённые файлы»
  (`CardFiles`).
- Wire: `proto/src/export_files.rs`, `src/host/export-files.ts` and the `export-file*.json` /
  `export-settings*.json` fixtures; `export_store_full`, `export_file_too_large` and
  `export_file_corrupted` are in `markiro_proto::codes::ALL` and `API_ERROR_CODES`.
  Tests: `host/tests/office_export_files.rs` (byte-equal re-download, corruption refusal,
  device-key denial, restore keeps the files, caps, retention), `test/stored-files.test.ts`,
  `test/shift-stored-files.test.tsx` and the dialogs' suites.

## Shift modes

Plan РЕЖ, part A (`docs/superpowers/plans/2026-10-13-standalone-shift-modes.md`;
pilot spec §32.1). A shift is «Агрегация» (`aggregation`, the default) or
«Проверка» (`validation`); the rules are where they act, this is their map.
The Data Matrix duplicate a validation shift may print (part B) has its own
map, «Unit labels», below.

- The mode is a field of the shift, not of the line. The office chooses it
  when it plans a shift («Режим работы», «Office pages»); the host takes it
  on a create and on an edit of a planned shift only and freezes it when a
  station opens the shift (an active shift's other mode is `conflict` on
  `shift_status`, «Shifts»). A validation shift has no pallets and no A4
  sheet; its box template and capacity stay, unprinted.
- The database holds the freeze too (`0021`, trigger `shifts_mode_frozen`):
  a shift's mode and print policy change only while it is planned, stays
  planned in that statement (the statement that opens a shift cannot move
  them; the entry names none) and has no scan, so `0020`'s box rule never
  meets a shift whose mode moved after it took scans; a write of the same
  value (the office's edit writes every field) is no change. The policy
  triggers compare with `IS`, so a NULL print mode under `OR REPLACE`
  cannot skip them. The print policy (part B,
  `shifts.validation_print_*`) is the wire's pair (`mode` and
  `validationPrint`, not the cloud's columns, which keep the verification
  `none` without a policy where the host keeps NULL): `none` with no
  verification and no template, or `duplicate_dm` in a validation shift
  with both, held by `shifts_validation_print_insert`/`_update` (a template
  id without a foreign key, as the box template's; a planned shift's
  duplicate template is found by `shifts_planned_duplicate_template`). Its
  label events are `unit_label_events` (part B, «Facts»). The office plans
  and edits the policy of a planned shift only, a duplicate only in a
  validation shift with a fitting `product_duplicate` template («Shifts»).
- Entry needs capabilities: since protocol 4 a station names what it works in
  `ShiftEnter.supports`, and a validation shift requires `validation-v1`; a
  station that does not name it (protocol 3 sends no body) is refused with
  `conflict`, `details.constraint = "station_update"`, on every entry
  («Protocol»); a shift that prints also requires
  `validation-dm-duplicate-v1`, and its snapshot freezes the duplicate
  template whole (`duplicate_template_not_fit`, `snapshot_too_large`).
- The box rule by mode has two halves: the host's triggers
  `scans_ok_box_by_mode*` (`0020`) refuse an accepted scan without a box in a
  shift that is not a validation shift, and the host's code
  (`facts/scan.rs`) refuses a box in a validation shift («Facts»). The
  station's tables (`0014`) hold no mode rule; its scan path keeps it
  («Local database», «Floor work»).
- The registry of codes is one for both modes: a code accepted in a
  validation shift is a duplicate in an aggregation shift and the other way
  round, and the earliest scan owns it (`code_owners.box_id` NULL for a
  validation owner, no `box_items` row). The office's code search shows such
  a placement as «Принят без короба» (`checked`, `OfficeCodeItem.boxId`
  null; `routes/office_codes.rs`, `office-code-card-validation.json`). Its
  box cell is «—» without a link (`BoxText`): the box and pallet cards (plan
  КРТ) are opened by an id a box-less scan does not have.
- A validation shift has no exceptions (Р9): no box or pallet facts, their
  labels included (`facts::admits`, `invalid_record` on `shift_mode`), no
  «Исключения» on the station, no SSCC blocks. One that prints the duplicate
  takes `unit_label` facts and has «История этикеток» («Unit labels»).
- Its close counts codes: `actualQty` is the shift's codes, `closedBoxCount`
  is 0 (the host refuses any other), no open box can block it («Floor work»,
  «Facts»); the office's totals are «Принято кодов» from
  `code_owners_shift_unboxed`, and for a shift that prints its labels
  (`ShiftTotals.unitLabels`, «Facts»).
- Its exports are flat only: the office offers `shift_txt_flat` and
  `shift_csv_flat`, the port refuses every box or pallet format
  («Shift exports»).
- A shift made on a station (`DeviceShiftCreate`) is created as aggregation;
  choosing the mode on the station's new-shift steps is part C (owner's
  decision), as are reprocessing codes of earlier shifts and modes on the
  handheld. The duplicate print under «Проверка» is part B («Unit labels»).
- Parity with the cloud is held by `test/scan-verdict-parity.test.ts` (every
  raw scan of the domain's KM fixtures and a line's scanner rows: the same
  verdict and duplicate key as `validateShiftScan`, in both modes; the one
  deliberate difference is a serial over `HOST_MAX_SERIAL_BYTES`, unknown
  here), `test/forms-parity.test.ts` (each task case as a validation shift
  draws the cloud renderer's bytes) and `test/export-parity.test.ts` (a
  validation shift's flat TXT and CSV are the domain's bytes for the codes
  in the cloud's order).

## Unit labels

Plan РЕЖ, part B (`docs/superpowers/plans/2026-10-13-standalone-shift-modes.md`,
«Отклонения при исполнении — часть B»; pilot spec §32.2). A validation shift
may print a Data Matrix duplicate of every accepted unit («Печатать дубликат
Data Matrix»), with the label's check required or not; the cloud station's
product labels are the model. The rules are where they act, this is their
map:

- The policy and the wire: protocol 5 («Protocol»): `validationPrint` of a
  shift (`None {}` or `duplicate_dm` with `templateId` and `verification`),
  the snapshot's frozen `validationPrint` (the duplicate template whole), the
  `unit_label` fact and `ShiftTotals.unitLabels`; a shift that prints is
  entered only by a station that names `validation-dm-duplicate-v1` beside
  `validation-v1`. The shared fixtures are `proto/fixtures/*validation-print*`,
  `fact-unit-label-*.json` and `unit-label-rules.json`.
- The host keeps the policy in `shifts.validation_print_*` (`0021`, «Shift
  modes»: the CHECK triggers, the freeze `shifts_mode_frozen`, no foreign key
  on the template), takes and checks it in the office's plan and edit
  («Shifts»: `check_duplicate_template`, `template_in_use`), freezes the
  template at the entry (`duplicate_template_not_fit`, `snapshot_too_large`,
  «Shifts») and keeps every `unit_label` event as sent in
  `unit_label_events`, with the counts of a printing shift's card («Facts»).
  It runs no state machine of its own.
- The station keeps one row per job with its current attempt in
  `floor_unit_labels` (`0015`, «Local database»: the domain's CHECKs, the
  immutable print identity and bytes, one unresolved job per station across
  shifts, one job per accepted unit, the retention). A unit is accepted with
  its label in one transaction (`acceptWithLabel`) or not at all, and no scan
  is taken while the station's unresolved label waits («Floor work»). The
  label's fields, render and every step — send, check, skip, reprint,
  recovery — are in «Floor printing» (Unit labels); the screen, the
  verification window and «История этикеток» in «Floor work»; the close's
  `label_unresolved` and the retention in «Floor exceptions and close».
- The office: the flag, «Шаблон этикетки продукции» and «Обязательная
  проверка этикетки» under «Проверка» in the shift dialog, a planned shift
  marked `duplicate_template_not_fit` in the list («Office pages»); the card's
  «Печать дубликата» and «Контроль печати», and the shift's blank with the
  shift's own policy («Shift card and printed forms»).
- Parity with the cloud: `test/unit-label-render.test.ts` (the fields and the
  ZPL/TSPL bytes at 203 and 300 dpi against the cloud's duplicate),
  `test/unit-label-work.test.ts` (every station step against the domain's
  `canApplyProductLabelEvent`/`applyProductLabelEvent`),
  `test/unit-label-schema.test.ts` (the CHECKs of `0015` against the domain's
  projections), `test/forms-parity.test.ts` (the blank's «ПЕЧАТЬ ЭТИКЕТКИ» row
  against the cloud's renderer, for both checks). The host's side is held by
  `host/tests/unit_labels.rs`, `host/tests/validation_print.rs` and
  `host/tests/migration_validation_print.rs`; the wire by
  `proto/tests/validation_print.rs` and `test/protocol.test.ts`.
- Deliberate differences from the cloud, each said where it acts: the label
  prints the organization logo the shift froze, else the Markiro logo, in a
  layout with an `organization_logo` box (the cloud's duplicate prints none);
  the host takes the label of a displaced or conflicting scan (the cloud
  quarantines it as `ownership_conflict`); an operator is required only on a
  skip and a reprint's `prepared` (the recovery after a restart writes
  `delivery_unknown` with nobody signed in); the check is off by default (the
  owner's decision; the cloud's is on); the card also counts «Пропущенные
  проверки».
- Not verified here (owner checks): the raster Data Matrix of the full code
  printed on the client's printers and scanned back; a duplicate printer
  through the Windows driver; a crash between `sending` and `sent`; the
  verification window in WebView2; the dead end of an unresolved label of a
  shift on another line.

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
receipt is kept for good. `unit_label` (protocol 5, plan РЕЖ part B,
`markiro_proto::UnitLabelFact`, `unitLabelFactSchema`,
`fact-unit-label-*.json`) is one event of a unit label job: `jobId`,
`codeHash`, `attemptNo`, `event` (the domain's `productLabelEventSchema`
kinds), `reason` (a `ReprintReason`, on the `prepared` event of a reprint
only), `errorCode` (exactly on `failed_before_send`, `delivery_unknown` and
`verification_rejected`, from `UNIT_LABEL_ERROR_CODES`), `payloadDigest`,
`bytesDigest`, `at`; never the full code. The host (`facts/unit_label.rs`,
task B3) takes it only in a validation shift that prints (`invalid_record` on
`shift_mode` in an aggregation shift, by `facts::admits`; on
`validationPrint` in a validation shift that prints nothing), and only for a
code this station accepted in this shift (`subject_unknown`, a receipt code
of protocol 5, otherwise; found through `scans_code_hash`, its plan pinned).
An accepted scan stays the label's subject whatever became of its code: a
scan displaced since by an earlier one, or one answered `conflict`, still
admits its label. This differs from the cloud on purpose (it quarantines such
an event as `ownership_conflict`): the label exists on the floor, and a final
refusal would lose its trace. A decision of the operator names the operator
(`UnitLabelFact::is_operator_decision`): a `verification_skipped` and a
reprint's `prepared` (attempt 2 and later) without the record's `operatorId`
are `invalid_record` on `operatorId`, and `factRecordSchema` refuses to form
such a record on the station. Other events may come without one, because the
station's recovery after a restart writes `delivery_unknown` with nobody signed
in. This also differs from the cloud, which requires `operatorId` on every
event. A job is one station's and prints one code with one text in the same
bytes in every attempt (the domain refuses a reprint of other bytes): an event
whose job the shift already knows (`unit_label_events_shift`) under another
`device_id` is `invalid_record` on `data.jobId`, with another `codeHash` or
`payloadDigest` on `data.codeHash`, with another `bytesDigest` on
`data.bytesDigest`. Only a shift's owner enters it, so the first can come only
from a row the API did not write (its test writes that row directly); a job id
is not checked across shifts. An exact replay keeps
its receipt, and the same event in a new record is taken (a check may arrive
twice). Every rule a row of `unit_label_events` keeps is checked before the write, so
a broken record is `invalid_record` on its field and never a database error
(a 500 would be retried forever and block the station's queue): `jobId` a
client UUID, `at` a device instant, and `UnitLabelFact::check` in proto (the
hex digests, an attempt from 1, the reason only on a reprint's `prepared`,
each error code exactly on its event from `UnitLabelEvent::error_codes`, so
a code a newer station adds is refused). `proto/fixtures/unit-label-rules.json`
holds `UnitLabelFact::check`, `unitLabelFactSchema` and the host's receipts to
the same answers (`proto/tests/validation_print.rs`, `test/protocol.test.ts`,
`host/tests/unit_labels.rs`). The host runs no state machine of its own: it
keeps each event as sent, with the operator, no audit row and no revision.
A printing shift's card counts them (`ShiftTotals.unitLabels`): attempts
`sent` and `verified` (each attempt once), jobs whose check was `skipped`,
`reprints` (attempts after the first) and `unresolved` jobs, whose last event
is not `verified`, `verification_skipped`, or `sent` when the shift requires
no check. A job's last event is ordered by `attemptNo` first, because in the
domain every event of attempt n precedes attempt n+1. Next comes its place in
the domain's order of an attempt (`prepared`, `sending`, the print's outcome,
a rejected check, a check that passed or was skipped). `at` (the device's
clock, which may step back) only breaks ties of the same place: a check
rejected twice, or two outcomes of one print. The station's record id, then
its device, settle an exact tie. The order is not the order the records
arrived in, and not the host's random `id` or a rowid (neither survives
`VACUUM INTO` reliably). Each count takes an attempt once (a job, for a
skipped check), whatever arrived twice. Every read runs on
`unit_label_events_shift` (`routes/office_shifts.rs`, its plan pinned).

A `scan` (`facts/scan.rs`) is a journal row (`scans`) whatever its verdict;
an `invalid` one keeps no code, only what it looked like (`rawKind`) and its
length, since it may have been a badge. An `ok` one carries the GTIN the
snapshot froze (`gtin_mismatch` otherwise). In an aggregation shift it names
a box of this device in this shift: an unknown box id opens the box, another
device's or another shift's is `box_unknown`, a closed one `box_closed`. In a
validation shift (plan РЕЖ, protocol 4) it names none (`boxId: null`); a box
named in the one mode or missing in the other is `invalid_record` on
`data.boxId`. The schema's triggers `scans_ok_box_by_mode*` (`0020`) back one
half of that rule only: an accepted scan of a shift that is not a validation
shift names a box (`scan_needs_box`). That a validation shift's accepted scan
names none is the host's code alone (`facts/scan.rs`). Its code goes to the
registry (`code_owners`, `facts/registry.rs`): the earliest accepted scan since the
code was last freed owns it whatever order the scans arrive in, compared by
their device instants to the millisecond. After an exception released the
code the next scan to ARRIVE owns it, not an earlier displaced item or
conflict loser (re-electing the earliest remaining claim is plan 2b). A
scan earlier than the owner takes the code, and the owner's item leaves its
box (`box_items.displaced_at`; a validation owner has `code_owners.box_id`
NULL and no `box_items` row, and the registry is one for both modes); a later
one, or one at the same instant, is `conflict` with `details.winner` (`CodeOwner`, `sameDevice` when the owner
is the sender's own scan). Both write a `code_conflicts` row, which says how
its loser lost (`kind`, plan КНФ); the office reviews it («Конфликты»), and a
device learns of the review and of its own displaced scans by asking
(`POST /v1/device/conflicts/status`, `GET /v1/device/displacements`, see
«Conflicts and the review of a shift»). A displacement takes no revision
(the facts are not changed for it): a station hears of it at the next
revision or reconnect.

A validation shift has no boxes and no pallets: every `box_closed`,
`box_label`, `box_exception`, `pallet_closed`, `pallet_label` and
`pallet_exception` of it is `invalid_record` with `details.field =
"shift_mode"`, whatever its content, before anything of it is read
(`facts::admits`, from `FactShift.mode`).

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
reason the plan did not call for is kept, as in the cloud. A validation
shift's close counts no boxes: `closedBoxCount` other than 0 is
`invalid_record` on `data.closedBoxCount`. An active shift
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

Pallets (plan ПЛ-Х; `facts/pallets.rs`, `facts/pallet_closed.rs`,
`facts/blocks.rs`; migration `0012_pallets.sql`). In a shift with pallets a
`box_closed` names the station's pallet the box joined as it closed
(`palletId`); a shift without pallets answers it, and every pallet fact,
`no_pallets`. The first closed box that names a pallet opens it on the host
(`opened_at` is that box's `closedAt`); a pallet of another device or
another shift is `pallet_unknown`. The pallet's state never refuses a box:
the station put the box there, and a box whose close comes again under a
new id after a refusal joins the pallet it named, closed or not. A box
closed on one pallet and sent again on another, or without its pallet, is
`box_already_closed`. A `pallet_closed` closes the pallet with an SSCC of 18
digits (its form is checked before its serial is read, which looks at the
first 17 characters only) whose first 17 are the pallet extension `1`, the
snapshot's prefix and `serial`, where `serial` lies in a live pallet block
(extension 1) that the host issued to this device (`sscc_not_issued`), and no
other pallet carries the SSCC or is closed on that serial of that block
(`sscc_taken`; the unique indexes `pallets_sscc` and `pallets_block_serial`
back it, and a box's SSCC starts with `0` from a box block, so boxes and
pallets never meet on one). It keeps the station's `openedAt`, `closedAt`,
`boxCount` (`box_count_reported`) and operator and raises the pallet block's
`consumed_through` (`blocks::consume`, shared with `box_closed`). A pallet
none of whose boxes reached the host opens closed, so its printed SSCC is
held. The same close again is accepted with nothing written; another SSCC
is `pallet_already_closed`. Which boxes a pallet holds is derived — the
closed boxes whose `pallet_id` names it, not taken apart — and never
stored; `box_count_reported` is evidence beside it, which the reports of
plan О-Х compare. One open pallet per station and shift is the station's
rule, not the host's: a second open pallet of a device is kept, since a
refusal would fail a batch the station can never get past. A `pallet_label`
(`facts/pallet_label.rs`) records the check of a closed pallet's label as a
box's (`pallet_state` for an open one, `pallet_unknown` for a pallet the host
does not have), a pallet taken apart included. A `pallet_exception`
(`facts/pallet_exception.rs`) is a `reprint` or a `disassemble` of a closed
pallet not taken apart (`pallet_state` otherwise), always with a reason code
of the box exceptions' list for its kind (`exception_reasons`) and words only
for `other`; one row per record in `pallet_exceptions`. A disassembly sets
`disassembled_at`; the pallet keeps its SSCC, its boxes keep their
`pallet_id` and stay closed, and the pallet no longer counts.

A pallet fact keeps what the station said, and the host orders nothing
between a box and its pallet. `openedAt`, `closedAt` and `boxCount` are
stored as sent; a consumer that needs a pallet's contents derives them from
the box memberships, and `box_count_reported` is only a figure to compare
with the derived count (plan О-Х). So a box whose `closedAt` is later than
its pallet's `closedAt` (a late box on a pallet already closed) joins
silently: the count mismatch is its only trace, and the office reports, the
Honest Sign export (plan ЧЗ) and the printed forms (plan О-Ф) must flag such
a box rather than assume the pallet's `closedAt` ends its membership. A close
of an already closed pallet with the SSCC it holds is accepted and writes
nothing even when its block has been revoked since, as a box's is (a record
already answered keeps its receipt in any case), while a new close of an open
pallet against a revoked block is `sscc_not_issued`. A `pallet_exception`
names its kind in `exception`, not `kind`, which the record's envelope already
has. A pallet that never closed has the `opened_at` of the first box the host
received, not of the earliest box: a box resent after a refusal may arrive
late, and `pallet_closed` replaces the field with the station's own. A
consumer that needs the exact value derives it from the boxes (the smallest
`closed_at` among them, plan О-Х).

Any device asks whether a code is taken (`GET /v1/device/codes/{codeHash}`,
`routes/codes.rs`; 64 lower-case hex digits, `validation_failed` on
`codeHash` otherwise): `{ status: "free" }` or `{ status: "taken", owner }`
with the same `CodeOwner` a `conflict` names. It reads the registry on a
pooled connection outside any write transaction, so it never waits for a
batch being written — a station asks within 300 ms (plan 2a6) — and it
writes nothing: it authenticates through `AskingDevice`, the read-only twin of
`AuthDevice` (same key, revocation and kind checks, no `last_seen_at` update),
so it never waits for a writer, the first request after an idle minute and a
busy station's once-a-minute touch included. With the two reads of a
station's conflicts (`routes/device_conflicts.rs`, plan КНФ) these are the
only writer-free device routes. Every other device route authenticates through `AuthDevice`,
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
«Принято кодов», never «в коробах»; for a validation shift, plan РЕЖ, the
codes it owns, each without a box, through the partial
`code_owners_shift_unboxed` of `0020`: its box and pallet counts are 0),
`unitsInClosedBoxes` (the live items in
boxes closed and not taken apart, as the cloud's `containedUnits`: the
office's «Кодов в закрытых коробах»; a shift closed with a box open shows the
gap to `acceptedUnits`), `closedBoxes`
(closed and not taken apart), `openBoxes` (open boxes that hold a live item: a
box emptied by undos or by displacement is not counted), `lastFactAt` (the
host's clock, whole seconds, at the last receipt of a record that named the
shift and got past the entry check, refused ones included), `deviceIds`
(the shift's participants, first entry first, the id breaking a tie), and with
plan ПЛ-Х `closedPallets` (pallets closed and not taken apart) and
`openPallets` (open pallets that hold a box not taken apart: a pallet whose
boxes were all taken apart is not counted, as an emptied box is not); the
office's label for `lastFactAt` is «Последние данные со станции», and it is no
measure of output or lateness. The eight fields of `totals`, all required and
in every `OfficeShift`: `acceptedUnits`, `unitsInClosedBoxes`, `closedBoxes`,
`openBoxes`, `closedPallets`, `openPallets` (non-negative integers),
`lastFactAt` (an instant of the host's format or `null`) and `deviceIds` (an
array of UUIDs). A planned shift's totals are zeros, `null` and `[]`, and a
shift without pallets has no pallet to count. The subqueries run on the
indexes of `0010` (`boxes_shift`, the partial `box_items_live`,
`fact_receipts_shift`) and `0012` (`pallets_shift`, the partial
`boxes_pallet`); a new column the totals read needs its index in the
same change, since the list runs them once per shift listed.

## Floor work

Stage 2a, plan 2a6 (`src/floor/work`). The work screen of a shift
(`WorkScreen.tsx`) reads the floor's scan source — the keyboard wedge and the
shell's COM scanners at once (`mergeScanSources`, `createComScanSource`; the
spec's decision 25 chose one by the setup, and reading both needs no setup) —
and hands every scan to a queue that runs one job at a time (`work-queue.ts`,
the cloud's `scan-queue.ts`). Each job is given to the floor's work gate
(`track`) before it starts, so leaving the shift waits for it, and every scan
touches the idle wait (`touch`): a COM scanner presses no key.

A scan (`scan-pipeline.ts`, `processScan`) is read once by the domain
(`readScan` over `classifyScan`: the AIM prefixes go, the group separators and
the crypto tail stay). A GTIN, an SSCC or anything else is `invalid` and keeps
only its kind and its length, never its text (a badge is a secret). The one
SSCC the screen reads is a printed label's, and it takes it before the
pipeline while the label's check waits (see "Floor printing"). A code whose
serial is longer than
the host keeps (64 bytes, `HOST_MAX_SERIAL_BYTES`) or holds a control character
reads as unknown, for the host would refuse it. A code of another product is
`wrong_gtin`. A code this pairing holds in any box (`floor_codes`) is a local
duplicate with the time of its first scan, without asking the host. Otherwise,
while the link is `online`, the host is asked within 300 ms (`HostApi.checkCode`,
`CODE_CHECK_TIMEOUT_MS`): another device's scan that owns the code is a host
duplicate with that shift's number; no answer, a failure, `free` or this
station's own scan (its own registry is newer: an undo not yet sent) let the
scan through, and a failure goes to `onHostError`, where the shell acts on a
refused key. An accepted code goes into the shift's open box, which opens with
it, in ONE `local_transaction` with its place in `floor_codes`, its journal row
(`floor_scans`) and its `scan` record in the outbox (`outboxStatement`, which
checks the record against `factRecordSchema` and its size against
`MAX_RECORD_BYTES`, 16 KiB, so that 100 records never pass the host's 2 MiB
body limit, and keeps it whole as the payload it is sent as). The key of
`floor_codes` keeps a code in one box of the pairing at most: a second accept
that the check missed fails whole with `changes_mismatch`, and a box closed
while the scan was on its way fails it too. Refused scans are journalled with
their record the same way. A failed write is a system error: the scan is not
taken, and the work stops until the operator closes the message.

A box (`box-close.ts`, `closeOpenBox`) closes with the next serial of the
earliest block of the snapshot's issuer prefix and the box extension `0` that
has one, its SSCC by the domain's `buildSscc`, in ONE transaction: the serial
spent by comparing the block's cursor with the value read (`UPDATE … WHERE
block_id = ? AND next_serial = ?`, `expectedChanges: 1`), the box closed only
while it is open with the count read, its `box_closed` record
(`boxMembershipDigestV1` of its codes) and what later plans add (`CloseStep` →
`CloseAddition`: statements committed after the close, and fields of the
record, whose own fields win). A guard that no longer holds is `stale`: nothing
is written, and the screen tries again, three times in all (`CLOSE_TRIES`),
before it stops the line. A serial past what the prefix can number, or one that
a box already holds (the SSCC is unique across pairings: a forget keeps the
boxes of a former one), is spent and the box stays open (`invalid_serial`, as in
the cloud); the next close takes the next serial. An empty box spends nothing.
A box closes by itself once it holds the shift's capacity — the screen's
`closeBox(true)` runs in front of every scan, after the scan that fills a box
and when the screen opens, so a station stopped between the scan that filled a
box and its close finds it full — and an incomplete one after the operator
confirms. "Full" is one function, `boxIsFull(itemCount, capacity)` in
`box-close.ts`, which the screen's close and `closeIfFull` (for a caller outside
the screen) both ask. A full box never takes another code: a close that leaves it open stops the line, and
the scan that finds a stop is refused. A close whose write threw may have been
committed all the same; the next close reads the box back from `floor_boxes`
(`readClosedBox`) before it looks for an open one, so that a box which did
close is reported once (`onClosed`, the half rule) and is not closed twice.

Serials come by the half rule (`block-supply.ts`, `createBlockSupply`, ONE
supply per work screen: two would both write the block): when the screen opens,
after every close and when the link comes back, a block is asked for while the
link is online if the pairing has none for the prefix or the newest has less
than half left. The request is kept in `floor_block_requests` before it is sent
and repeated whole, with the same `requestId`, until its block is kept, in the
transaction that removes the request, so a lost answer or a restart never
makes the host issue a second block for one need. A block of another prefix or
extension than asked, or one that shares serials with a block already kept, is
never filed (the request is dropped), and a block already kept is never
overwritten, so a cursor is only moved by a close. The host's refusal of a
request as another prefix's (`validation_failed` on `requestId`) drops it and
sends a new one, once; `sscc_exhausted` drops it. One top-up runs at a time.
Without serials the work stops and says why (no link, the link held until the
operator leaves, the prefix exhausted, the host gave none); a block that arrives
closes the box and the work goes on.

The outbox goes to the host from `useHostLink` (`src/local/facts-sender.ts`,
`sendFactBatch`), a batch at a time: this pairing's oldest records without a
receipt, up to 100 (and within `MAX_BATCH_BYTES`), sent as kept, each send
counted in `attempts` before it goes. The receipts must answer the records — as
many, each with its record's id or none (matched by its place) — or nothing is
kept and the batch goes again. They are applied in one transaction through
`json_each`: the outcome, its code, its details and the time; a scan's
`conflict` sets `floor_scans.conflict` and its box's `needs_fix`; a `rejected`
record stays, with its code, for the queue screen («Очередь отправки», plan
ОЧ; see «Outbox recovery»). The host keeps a refusal for good and answers the
same record id with it again, so a refused record is never sent again under
its id: sending it again is a person's act on the queue screen that writes the
shift's refused records again under new ids, data byte for byte, in their
order. An `accepted` of a scan that was in conflict takes the marks off again
(`receiptStatements`' fourth and fifth operators: the scan's `conflict` and,
when no scan of the box is still in conflict, the box's `needs_fix`). A
`rejected` receipt flags nothing on the floor: a refused scan leaves its code
in the local box, which the host's later `box_closed` then meets as a digest
mismatch (`digest_matches`); the station shows it as the bar's count
«Отклонено хостом» and on the queue screen. Making
a refused scan mark its box as a conflict does is a one-word change in the two
`value ->> 'outcome' = 'conflict'` terms of `receiptStatements`, and an owner decision
(raise it at the pilot review). Any failed send — a transport failure, an
answer other than 200 (a 500; a body over the host's limit is its 400, which a
well-formed batch of at most 100 records of at most 16 KiB cannot reach),
receipts that do not fit — keeps every record and sends the same batch, with the
same ids, again; an unacknowledged record is never purged, skipped or
quarantined (it would break the order the host's checks depend on: a
`box_closed` after its scans), so a batch the host cannot take is retried for
good by design, and the bar says for how long. The shell keeps why the last send
failed (`ShellState.factsFailure`, `factsFailureOf`): the link's own failure
shows on the link's line, the host's and this computer's as words of their own
on the status bar. The link sends after it subscribes, after every revision
event, whenever a screen asks after a local write (`requestFacts`), right away
again after a full batch, and after a failed send by the sync's waits (2, 4, 8,
16, 32 s, then 60 s) while online or at once when the link is back; a screen's
request after a local write does not cut a failed send's pause short
(`factsNow` returns while `factRetry` is set; going online, a revision, the
reconciler and the pause's own end still send at once), so the stuck line's
attempts count retries and not scans (except in the `watchFailed` mode, where
no pause is armed; see «Outbox recovery»); a refused key ends the link. It lives as long as the link: a refusal or another
host that waits for the operator to leave the shift stops the link and the
delivery, and the work screen asks the host nothing meanwhile (`FloorApp`'s
`rejectionPending`). Every local write of the floor and every batch of receipts
dispatch `outbox_changed` (`ShellState.outboxVersion`), and the status bar reads
again the records not sent, refused and in conflict (three statements of their
own, `src/floor/outbox-status.ts`; a record a person resolved on the queue
screen is not counted) and, in a shift, the SSCC serials left for its boxes and
pallets (`readShiftStock`, see «Outbox recovery»); while a send fails or the
serials run below a quarter of the newest block it reads again every 10 s
(`REFRESH_MS`) and says how long the oldest record has waited and how often it
was sent. The reads the screen repeats, and the
receipts' transaction, are pinned in both query-plan lists (see "Local
database").

Each verdict shows in words in the last-scan line under the box and as a
generated tone (`signal-sound.ts`; no audio files). A refusal or a duplicate
also flashes (`SignalOverlay`, which lives in `packages/ui`, for `SIGNAL_MS`,
700 ms) inside a wrapper with `pointer-events: none`, so that what the flash
covers keeps its taps. An accepted scan has no flash: the tone and a lit
last-scan line (`CUE_MS`, 350 ms, `work-screen__last--cue`; the fade runs only
under `prefers-reduced-motion: no-preference`) say it, because an overlay at the
pace of a line would hide the counts and the buttons. An accepted scan is not
announced to a screen reader (the tone and the line only; a polite region for it
is the owner's to ask for); a refusal is announced by its flash, and the stops
and notices share one polite region that is on the screen before any of them.
While a message stops the work — a failed write, no serials, a failed close, a
close to confirm — or the operator leaves, a scan is not taken, and the screen
says so: nothing is dropped silently. The plan notice «План выполнен» comes once
per entry and does not stop the scanning.

What the floor tells the screen beyond the gate (see "Shifts"): `isLeaving()`
answers true synchronously from the moment a leave is asked, where the render's
`leaving` lags, and a scan is then refused and a close the operator presses does
nothing (its buttons carry `aria-disabled`); `linkHeld` is true while a refusal
of the device or another host waits for the end of the shift, and a screen
without serials then says that the link is stopped until the operator leaves,
instead of promising serials. The shell holds `other_host` and every
`host_probed` answer behind the shift (`pendingOtherHost`, `pendingProbe`), so a
forget or a sign-out never appears under a write in flight. `closeSteps` (the
steps of every close, which run after the screen's own label step, see "Floor
printing") and `onClosed` (told once for every box that closed, also one read
back after a lost answer, in the queue's turn after the write) are the
extension points the pallets' plan was written against (joining the station's
open pallet with the `palletId` of `box_closed`, which the host already takes
since plan ПЛ-Х, so the plan adds no protocol version). Plan ПЛ-Ц did not need
`closeSteps` for it: the screen appends its `palletStep` itself after the box's
label step (see «Floor pallets»); plan 2a7's label job is not started from
`onClosed` but written by the screen's own step. Whatever they start goes to `track` before it begins, and
every writer of a box — plan 2a8's exceptions and the pallets' plan too — stays
in the screen's queue: the digest of a closing box is read apart from the box,
and only the queue keeps an undo from changing the box between the two reads. A
box whose lost answer was not read back before the operator left is closed in
the database and told to nobody, but its label job was written by the same
transaction, so the next entry of the screen finds it (`readOpenJob`). The box's
label is «Floor printing»; the exceptions and the shift's close are «Floor
exceptions and close».

A validation shift (plan РЕЖ, A7) is worked on the same screen, which chooses by
`shift.copy.mode` in one place. The scan path is the same up to the box:
`processScan` reads the scan, checks the product, the local duplicate and the
host's, and an accepted code is written without a box — `floor_codes.box_id`
and `floor_scans.box_id` NULL, the `scan` record with `boxId: null`, in the same
ONE `local_transaction` — and answers `{ kind: "accepted", boxId: null,
acceptedCount }` (the shift's codes, `SHIFT_CODES_SQL`, read in the queue's turn
plus one). The screen shows `ValidationPanel` where the box stands: the accepted
codes against the plan, the refused scans by kind (`VALIDATION_COUNTS_SQL` over
`floor_scans_shift`, pinned in both query-plan lists) and this entry's last five
outcomes in words, in the aggregation path's texts but the accept's own
(«Принят: в смене N шт.»), each at its scan's journalled time (every
`ScanOutcome` carries `scannedAt`). Only that list scrolls (it is size-contained
and keyboard-focusable); the panel keeps a min-height. It has no box, pallet,
label or exceptions (Р9), asks for no SSCC block (the screen asks neither supply,
and `createBlockSupply` itself answers `enough` while `BlockContext.mode`, read
from the live copy, is `validation`; the status bar's `readShiftStock` answers
`null` for it), and recovers no label on entry. Its footer keeps «Выйти из смены»
in the middle column and «Закрыть смену» on the right, where an aggregation shift
has them (`work-footer--two`). The plan notice offers «Закрыть смену» beside
«Продолжить», as the cloud station does. The close is the
aggregation close: `actualQty` is the shift's codes, `closedBoxCount` 0, no open
box can block it, and the domain asks a reason when the fact differs from the
plan; the summary and the closed panel name no box (`boxless`). Entering a
validation shift names `validation-v1` (`STATION_SHIFT_ENTER`); a host that
refuses it as `station_update` is said on the list, which stays.

A validation shift that prints the Data Matrix duplicate (plan РЕЖ part B, task
B5; its snapshot's `validationPrint`) goes through the same `processScan`, with
two differences (`src/floor/unit-labels/unit-label-work.ts`). Before the scan is
read at all, `checkUnitAcceptance` refuses it while the station's one unresolved
unit label waits (`canAcceptNext`: `verify` — a required check after `sent`, or
an unknown outcome a scan of the label settles; `wait` — prepared, sending or
failed before its send; `another_shift` — the station's unresolved job is
another shift's) or no duplicate printer is assigned: nothing is journalled, as
the cloud's station takes no scan while it cannot accept. An accepted unit is
taken by `acceptWithLabel`: refused before any write when its code has no
crypto tail (`parseDuplicateKm`, `incomplete_km`) or its label does not render
(`render_failed`), then ONE transaction of its `floor_codes` place, its
`floor_scans` row, its `scan` record, the job `prepared` and the job's
`unit_label` `prepared` record after the `scan` record, so the host knows the
unit before its label (`subject_unknown`). Every refusal rejects with
`UnitLabelRefusedError` (`code` — the gate's kind for a job in the way — and
that job's `UnitLabelRef`); the outcome of an accepted unit carries its job's
`UnitLabelRef` (`label`): neither ever holds the job's fields (the full code)
nor its bytes, and the screen reads the job whole by its id to send it. Such a
scan needs the operator's name for the label (`unitLabel.operatorName`, not
blank): without it `processScan` throws before anything is read. The parity of every station step with
the domain's machine is `test/unit-label-work.test.ts`.

The screen of such a shift (task B6, `src/floor/unit-labels/*.tsx`; the cloud
station's `ProductLabelInstrument`, `ProductLabelVerification` and
`ProductLabelHistory`, its `productLabels.*` texts word for word under
`floor.unitLabels.*`, `attempt` with `{{number}}`) is the validation screen
with three additions, chosen in the same one place by the snapshot's policy
(`unitLabelPolicy` / `printsUnitLabels`). The work on the labels — their state,
the window's settling, sends, checks, decisions and history — is the hook
`useUnitLabelWork` (`src/floor/unit-labels/use-unit-label-work.ts`, as the
cloud's `use-product-label-work.ts`), over the screen's queue, stops and gate;
the screen keeps the scanner and hands it the window's scans (`scanInWindow`)
and the accepted unit's label (`sendAccepted`). `UnitLabelPanel` stands under `ValidationPanel`: the current label's state in
words (none yet, «Отправлено на принтер», «Этикетка подтверждена», «Проверка
пропущена», «Печать требует уточнения», «Этикетка не отправлена», «Печать
этикетки») with its serial's last six characters, and the check — the job's,
or the snapshot's before any job (`requiredHint` / `noneHint`: the cloud's
acceptance found its panel said nothing before the first scan). An accepted
unit's label is sent at once in the scan's turn (`sendUnitLabel`, its first
send); then `settle` reads the station's one unresolved label and, while
there is one, `Stop` `unit_label` opens `UnitLabelVerification`, a
`FullScreenDialog` (dialog semantics, the focus taken and kept, back to the
window itself when a view drops the pressed button; outside the polite
region) over the work and the status bar. Its views: the check after the send
(«Отсканируйте напечатанную этикетку», «Проблема с этикеткой», «Пропустить
проверку» only after `sent` and never in finish mode, with `skipHint`), an
unknown outcome and a send that failed before it left («Напечатать повторно»,
and «Настройки принтера» for the latter), a label prepared before a restart
(«Отправить сохранённую этикетку»: nothing is sent on entry), a send this app
lost (`sending`: «Повторить» recovers it to unknown, nothing sent), another
shift's label (no unit; the view keeps the label and reads that shift's copy:
«Смена N · …суффикс», and where the shift is found — in the list of this line,
`anotherShift` «Вернитесь к выбору смены»; on another line, «Смена другой
линии. Обратитесь в офис.»; in no list, or no copy left (the code's end
alone), «Смену этой этикетки нельзя выбрать на станции…» — the work screen's
shift stands for the station's line, as a move of the station leaves the
screen), no duplicate printer (on entry, not in finish mode: «Повторить»,
«Настройки принтера» — the workstation, by `onSetup`) and a failed read
(`storageError`, «Повторить»). The window's status line is always in it: «Сохраняем
результат…» while a decision or a send runs (a send prepared, a reprint,
«Повторить», a skip), «Ожидаем сканирование этикетки» only where a scan checks
the label. «Пауза» (and Escape) is the way out of the shift, the label kept;
it waits while a decision runs and stays on the keyboard while the leave
waits. A reprint asks the reason first (`UnitLabelReprintReason`: three floor
choices marked by a sign, «Напечатать повторно» held until one is chosen),
writes the new attempt (`reprintUnitLabel`) and sends it at once, as the
cloud's; the reasons belong to the view they were opened in (a view that
changes under them closes them). The scanner stays the screen's: while the
window stands a scan goes to `verifyUnitLabel` when the check is open (a
required check after the send, or an unknown outcome — in finish mode too),
no decision runs and the reasons are not open (the cloud pauses its
verification), its mismatch or unreadable code said in the window and by
tone; any other scan is refused in words — under the window by tone and in it
(«Скан не принят. Сначала завершите этикетку.», announced again for each, gone
with the view) — and nothing is journalled. Every decision is one turn of the work queue,
handed to the gate, with the view's double-tap guard (`VIEW_GUARD_MS`). A
unit's own refusal (`incomplete_km`, `render_failed`) is said as its outcome
(«Не удалось прочитать полный Data Matrix», or the label not prepared for the
duplicate printer); the label in the way or no printer opens the window. The
entry recovers the sends the app lost (`recoverUnitLabels`) and opens the
window of a label left unresolved at once. «История этикеток» replaces
«Исключения» in the footer (three columns again): the shift's labels newest
first (`readShiftUnitLabels` over the pinned `SHIFT_JOBS_SQL`, 100 rows), each
with its state, «Попытка N» and «Напечатать повторно» (with a reason; held
while a decision is saved, a label is unresolved, waits for its send or is on
its way, and in finish mode, as the cloud holds it in a closed shift — said
in words there), the empty text, a failure announced, and «Назад» back to its
button. The close is refused while a label of the
shift is unresolved («Floor exceptions and close»). The screen's tests are
`test/unit-label-screen.test.tsx`.

## Floor printing

Stage 2a, plan 2a7 (`src/floor/print`, `src/floor/setup`, `src/hardware/awake.ts`).
A closing box gets its print job in the close's own transaction (`boxLabelStep`,
a `CloseStep` of plan 2a6, which the screen puts before the `closeSteps` of later
plans): the label's fields are the domain's `boxLabelFields` from the shift's
SNAPSHOT (product, print name, GTIN, shelf life, counterparty — never today's
catalog), the box (SSCC, count, the stored `closedAt`), the shift's number and
production date and the name of the operator who closed it; the bytes are
rendered for the box's printer of the workstation's settings, read at each close:
its language (`generateZpl` or `generateTspl`, loaded on their own) and
resolution (`withPrinterDpi`), the template being the snapshot's revision, whose
id and revision the job keeps along with the fields and a copy of the printer's
profile. Non-Latin text goes through `src/labels/rasterizer.ts`, the office
preview's rasterizer («предпросмотр = печать»), which refuses a canvas over 4096
dots on a side (`RasterTooLargeError`) before it makes it. No printer assigned for
boxes — the job is `failed` `printer_unconfigured`; no render — `failed`
`render_failed` with the printer kept; the box closes either way, and no job
exists for a box that did not close. The shift's number and production date come
from the shift copy as entered (`keepEnteredShift`; the snapshot has neither), and
they are stable: the host refuses to change the production date, the line, the box
or pallet template, the counterparty, the capacity or the pallets of an `Active`
shift (`update_shift`, `host/src/routes/office_shifts.rs` lines 398–432:
`fixed_changed` on an `Active` shift answers `status_conflict`; pinned by
`an_active_shift_takes_only_its_plan_and_a_closed_one_nothing` in
`host/tests/office_shifts.rs`, the `productionDate` case answers 409), the shift's
number is drawn at creation and never updated, and each job stores its `fields`
(date and expiry included), which a reprint replays. So a printed fact is never
recalculated and a box keeps the SSCC and date it was closed with.

A printer profile prints RAW (the printer's language) or through the Windows driver (plan
ДРВ): `mode: "windows_driver"` in the profile's JSON of the `printers` setting, allowed only
for a Windows queue; a profile without `mode` — every profile before the plan and every RAW
one since, the form writes the field only for the driver — is RAW, so stored profiles and
the printer snapshots of jobs read as before (no migration). A driver profile keeps its
last RAW language for switching back, and its resolution is required: the job's bytes are a
`mono-raster-v1` page of the snapshot's template at that resolution (`renderMonoLabel` +
`encodeMonoRaster` in the emitters' chunk) drawn with `rasterizeDriverText`, which refuses
(`render_failed`) rather than freeze a fallback face. The print runtime sends it through
the same per-address queue and 20 s limit as RAW, as `print_windows_raster` with a fresh
`Markiro:<uuid>`; the job walks the same states: `failed` for the driver's `before_start`
codes (`queue_unavailable`, `geometry_mismatch`, `driver_not_started`, `unsupported`,
`invalid_payload`), `unknown` `driver_unknown` for a delivery in doubt, and nothing is
ever sent again without the operator. The spooler receipt of a job's newest driver send is
kept in memory by the runtime (one that answered after the limit too; a new send forgets
it, a restart loses it) for «Проверить очередь Windows» on the label panel (unknown, or a
check waiting; driver printers only), whose answer is diagnostic and decides nothing.
`printAgain` renders again when the way of printing changes, even at one language and
resolution (and when the paper changes, below). The setup offers «Способ печати» for a Windows queue only where
`supports_windows_printing` is `true` (or the profile is already in driver mode), hides the
language in driver mode, says the driver's paper and resolution must match, and prints its
test label either way; the screens name a driver profile's format «Драйвер Windows»
(`printerFormatText`). Not done (plan ДРВ «Перенесено»): receipts in the database, the
saved raster's preview, a separate preflight (A4 sheets are plan А4, next paragraph). Not verified (never run
on Windows or a real printer): the spooler and GDI calls, real drivers' behaviour with
user-size paper and their reported resolution, IBM Plex loading through `document.fonts`
in WebView2 (`rasterizeDriverText` refuses if it does not load), and the ≥64 px
production-browser contract of the new setup controls; the manual list is in
`docs/runbooks/standalone-install.md`.

Paper «Лист А4» (plan А4, `src/floor/print/shift-render.ts`, `src/floor/setup/a4-test.ts`). A
driver profile may carry `paper: "a4"` in the `printers` setting: only with
`mode: "windows_driver"` and `dpi: 300` (`parsePrinterProfile` reads any other combination, and any
other word, as no profile — the form's `settleDraft` keeps the draft consistent and
`profileOf` refuses with `paper`), and only for the purpose «Паллета»: `parsePrinters` reads a
box or duplicate assignment of such a printer as not assigned, `resolvePrinter`,
`printerForAgain` (own, chosen and the purpose's printer alike) and the lists of «Другой принтер»
and of the setup all leave it out of any other purpose. The printer chooses the format, nothing
prints twice (a thermal or driver label of `shiftLabelRender` gets the caller's rasterizer as it
is, so a driver page keeps `rasterizeDriverText` and the bundled face): a pallet job whose
printer is A4 is rendered by `shiftLabelRender` →
`renderShiftSheet` — the sheet, the organization's name, INN and logo (the bundled Markiro logo
when the shift froze none) the SHIFT FROZE, the SSCC and counts of the pallet's label fields, the
shift's production date (never the pallet's close day; the expiry is the domain's, the production
day being day one) — to `mono-raster-v1` bytes, whose required area the shell checks against the
printer's printable area before it sends: a sheet that does not lie inside it is MOVED the few millimetres it takes (an inkjet's bottom edge is often 12.7 mm), or drawn uniformly smaller (to 90 % at the least, `BLACKONWHITE`), and the answer says which (`adjusted`); only a printable area that would take it below that, a paper that is neither A4 (±1.5 mm) nor Letter, or a resolution that is no multiple of 300 dpi is refused (`geometry_mismatch`, a refusal before the spooler) with the measured numbers in `diagnostic`, which the setup's test sheet shows with «Копия диагностики» (beta 3.2). The
job is the ordinary one: `template_id`/`template_rev` are the snapshot's THERMAL pallet template,
`fields` the label's, `bytes_base64` the page, `printer` the profile with its paper, the same
states, check by scan of the pallet SSCC, one job per pallet close (the sheet replaces the
thermal label of the pallet, the box's label goes first as before), and a reprint of a closed
pallet is a new job of the same pallet and SSCC. A shift that froze no sheet or no organization
cannot render one: the pallet closes, the job is `failed` `render_failed` with no bytes, and the
recovery's «Другой принтер» prints the thermal label elsewhere. `printAgain` reuses the job's
bytes only when the mode, the paper, the language and the resolution of the profile are the
job's; otherwise it renders again from the snapshot (a sheet from a label job and the thermal
label from a sheet job alike). The runtime's `send(jobId, target, bytes, mode, paper)` hands
`paper` to `print_windows_raster` only for `"a4"` (a label's call is as it was) and refuses an
A4 sheet bound for RAW as `invalid_target`, sending nothing. The setup's «Бумага» field appears
for a Windows queue in driver mode; «Лист А4» sets 300 dpi and locks the resolution, and a
printer made A4 loses its box and duplicate assignments. «Пробная печать» on an A4 printer
prints the stock portrait sheet of `a4TestSheet` (synthetic SSCC of the company prefix 9999,
the bundled logo, drawn by the same `renderSheetRaster` as a real sheet) through the driver
with the paper A4, shows the very raster at a sixth on a canvas, and takes the scan of the
sheet's SSCC; a change of the printer's paper (or its removal) forgets that test and drops the
answer of one still on its way. The 20 s send limit is the label's: an A4 spool of about 1 MB
can run past it and end `unknown` `timeout`, which the operator decides, and the queue is
freed at 30 s while the Win32 call may run on (plan ДРВ's note). Not verified: see the end of
this file.

A job (`floor_print_jobs`, `print-jobs.ts`) walks `prepared → sending → sent`,
then `verified` or `skipped` when the job asks for the label check (`verify`, the
workstation's setting when the job was made; a `sent` job with `verify = 0` is
done), `failed` (nothing left this computer: `not_sent`, `invalid_target`,
`invalid_payload`, `unsupported`, `printer_busy`) or `unknown` (a label may
exist: `outcome_unknown`, `timeout`, `interrupted`). `sending` and the attempt
are written before the bytes go (`sendLabelJob`), and every move compares the
job's state and attempt with what was read, so a late answer never overwrites a
job moved on. `sent` comes only from the shell's `{ sent: true }`. A send goes
through the app's one `PrintRuntime` (`createPrintRuntime`, in `App`): one at a
time per address (`printerTargetKey`), each answered within `PRINT_SEND_LIMIT_MS`
(20 s from the ask, the wait behind another send included); a send whose limit
ran out while an earlier one to the same address still had the printer is never
given to the shell (`printer_busy`). The queue waits for the shell's call to
really end, not for the limit, so a job whose call outlives the limit stays in
flight and a recovery does not touch it. When the work screen opens, before it
reads a job, every `sending` job of the pairing whose bytes no send of this app
holds becomes `unknown` `interrupted` (`recoverInterruptedJobs`); it runs in the
screen's work queue, never beside a send, and nowhere else but the operator's own
check below. Nothing sends a label twice by itself: a `prepared` job — written
with its box, never sent — is sent once when the screen finds it, after a close
or on entry; every other send is the operator's.

The work screen stops at a label that waits (`Stop` `label`, `LabelPanel`) and
closes no next box while one does (`label_waits`; the unique index
`floor_print_jobs_open` holds one waiting job per label). A failed label:
«Напечатать снова» (the job's bytes again, no reason), «Другой принтер»,
«Настроить принтер» (the setup, after the work settles, and back to the shift),
«Продолжить без этикетки» after a confirmation (`skipped` with a `box_label`
record `skipped`; the record has no field for a reason). An unknown one adds
«Этикетка напечаталась» (`sent`, then the check when asked), and printing it
again needs a reason of `REPRINT_REASONS` (`src/floor/exception-reasons.ts`, the
host's fixture), built from the panel's buttons and written as a `reprint`
exception (`floor_exceptions` and its `box_exception` record, no words) in the
transaction that marks the job `sending`. Before a reprint is confirmed the panel
names the printer it goes to, and says so when the job's own printer was deleted
from the settings and the purpose's printer takes its place (adding, for a label
that may exist, that it may lie at the deleted one; a failed job left the computer
with nothing, so it does not say that). Printing again keeps
the job's bytes when the printer's language and resolution are the job's and
renders again from the snapshot's template revision otherwise (`printAgain`); no
printer or no render changes and sends nothing. A check that waits takes the scan
before the pipeline: the SSCC read by `parseScannedSscc` equal to the job's —
`verified` with its `box_label` record; another SSCC or no SSCC — said under the
label with the error tone, nothing written or journalled; «Пропустить проверку» —
`skipped`, with the record. «Выйти из смены» stays open at every label: the label
waits for the operator's return, and a leave asked while a send is on its way
waits for that send (up to the 20 s limit and two local writes). Once a label is
done with, a box a stop of the station left full closes. A job left `sending`
whose final write failed, with no send of this app holding its bytes, shows
«Итог отправки этикетки не записан» and one button, «Проверить, вышла ли этикетка»:
the operator's own check runs the same recovery as a piece of the work queue (so
it moves every dead `sending` job of the pairing, not only this one) and the
decisions of an unknown label follow; it sends nothing. Every press on the panel
is ignored for 400 ms after the panel changes its view (`VIEW_GUARD_MS`), and the
focus after a change goes to a control that decides nothing (a second tap of a
double tap would otherwise choose a reason, a printer or a decision). A shift
closes only once every label of it is done with (`shiftLabelsSettled`, which
counts rows, so a waiting job this build cannot read keeps the shift open; plan
2a8 asks it first): a `box_label` record after `shift_closed` would mark the
station's own shift late on the host (`late_data_at`).

The workstation setup (`WorkstationSetup.tsx`, one screen, from the list of
shifts and from a label's recovery; any signed-in operator may open it) stores the
printers (`{ id, name, target, language, dpi }`, one per address) and the printer
of each purpose — `box`, `pallet`, `duplicate`; `box` prints, `pallet` in a
shift with pallets (plan ПЛ-Ц), and `duplicate` a unit's warehouse reprint
(plan СКЛ) and the unit labels of a validation shift that prints them (plan РЕЖ) — the COM scanners, the tones' level and the label check (one setting for all
labels), all at once on «Сохранить»: the four keys of `workstation_settings` in
one transaction, then the whole set of scanners to the shell (also when the app
starts, `applySavedScanners`). What would not read back is refused before
anything is written: a printer address twice, a scanner port twice, a port name
or a number of scanners the shell refuses (the shell refuses the whole set), and
one COM port for a serial printer and a scanner (refused only when both are in
the settings). A save whose shell step is refused keeps the settings and keeps
«Сохранить» active to give the shell the set again. «Назад» leaves at once and
says when it drops a change. A scanner's line is «Подключится после сохранения»,
«Проверяем связь…» until the shell's first answer, then connected or not as
`watchScanners` reports (the shell's snapshot has no other state). Every text
field of the setup tells the scan source it takes typing (focus and blur; the
source is told again when the printer form opens or closes or the setup goes, as a
removed field sends no blur), so what is typed there is never a scan, and a test
label that went clears what was typed ahead. The test print
sends a 58 × 40 label of ASCII only («MARKIRO TEST» and a random `MKR-` code in
Code 128, `testLabelSpec`; no product data) through the same runtime and checks
the scan of its code; a scan that is not that code is never shown (it may be a
badge). It is no job: it takes no in-flight slot and queues behind a real send to
the same address, and leaving the setup does not cancel it. The sound level (0 to
100 in steps of 10, or none) is read by `FloorApp` when it opens and again after
a save, and the work screen's tones play at it (`playSignalTone`, level 0 plays
nothing). The work screen keeps the computer awake while it is open
(`SystemAwake.hold`, generation-counted; the app lets any earlier request go once
at start with `reset`).

What plan 2a7 accepted and left open, none of it verified on a printer:

- A reprint's trail does not name the printer the first label may have come out
  on: a rebind overwrites the job's printer and bytes, and neither
  `floor_exceptions` nor the host's `box_exception` has a field for a printer. The
  operator holds the physical labels. A column or an attempts log (a migration) or
  a protocol field is an owner / plan 2b item. Editing the profile of the job's
  own printer (same id) likewise moves where «Напечатать снова» goes; the panel
  names the printer first.
- A stored job this build cannot read (`UnreadableJobError`: damaged printer or
  fields JSON) makes every read of its shift's open job throw. The shift's line
  stays on «Состояние этикетки не прочитано» until the operator leaves the shift,
  and `shiftLabelsSettled` counts the row. Nothing is sent or lost and another
  shift is not affected; a stop whose one action skips the label in SQL by the
  job's id is proposed in the JSDoc of `UnreadableJobError`, an owner / plan 2b
  item.
- `verifyPrintedLabel` is one boolean for every label purpose; a switch per
  purpose is a model change for the pallets' plan. A job keeps the setting it was
  made under, so turning the check off does not release a waiting label.
- Recovery runs only on entering the work screen and by the operator's check
  button. A decision shows the decided job and trusts it instead of reading the
  shift's next waiting job, exact while a shift has one box label at a time; the
  pallets' plan (two labels can open in one close) must read the next job
  (`settleLabel`) and add a test with two open jobs.
- The 20 s limit counts the queue wait, so with pallet labels on the box printer a
  label behind a slow send can end `timeout` or `busy`.
- «Продолжить без этикетки» names the way back: plan 2a8 restored the reference
  to «Исключения» in the text, and a test skips a label and reprints it from
  there (`floor-work-print.test.tsx`).
- A job keeps its label's bytes in `bytes_base64`, and the `CHECK` of `0007`
  requires them in `sending`, `sent`, `unknown` and `verified` (loosening it later
  is a table rebuild). Measured at the final review on a synthetic worst case (every
  text bitmap at its full `maxWidthPx × maxLines`, random bits; real Cyrillic is
  smaller, and a fake rasterizer is no IBM Plex on a WebView2 canvas), stock dated
  templates through `renderLabel`, in base64: 58 × 40 ZPL 20.7 KB at 203 dpi and
  45.2 KB at 300 dpi (TSPL 10.6 and 22.9 KB); 75 × 120 ZPL 34.5 and 73.4 KB;
  100 × 100 and 100 × 150 ZPL 59.9 and 128.6 KB (TSPL 30.2 and 64.5 KB). The
  controller's decision: keep the `CHECK` as it is (the bytes are what «Напечатать
  снова» sends again). At 500 boxes per shift, two shifts a day and the 30 days of
  retention that is up to about 30 000 jobs, roughly 0.6–1.3 GB at the 58 × 40
  sizes, so clearing them is plan 2a8's retention duty, done: it deletes a
  shift's `floor_print_jobs` rows with the shift's other records
  (`RETAINED_TABLES` lists the table).
- A forget (`clear_copies`) keeps the `floor_print_jobs` rows (`DeviceData`), while the
  pairing they belong to is gone, and every job read is pairing-scoped. A label that waited (`failed` or `unknown`)
  when the device was forgotten and paired again stays in the database, shown by no
  screen of the new pairing, and its box has no `box_label` record on the host.
  Nothing is sent twice and no row is lost; it is a recovery nobody can reach.
  Plan 2b should count the pairing's open jobs in the forget's warning beside the
  unsent facts (`count_unsent` counts `outbox` only).
- The panel decides what to show from the job and from `printing.isInFlight` at
  each render. When a send times out and the final write of `unknown` then fails
  with an error that is not a stale one, the job stays `sending` while the stuck
  shell call holds it, and the panel shows the pending view («Этикетка
  отправляется…», no button). When the call ends nothing re-renders it, so the
  stalled check appears only after another render or a leave and a return
  (recovery then finds the job out of flight). «Выйти из смены» stays open and
  nothing is sent. If it is wanted later, `PrintRuntime` can announce a settle.
- `FloorApp` reads the saved sound level once when it opens (a read slower than a
  whole setup visit could overwrite a newer level); a spooler queue whose port is a
  COM port is not known to the app.

Unit labels (plan РЕЖ part B, task B5; `src/floor/unit-labels/`, migration
`0015`, «Local database»). The label of an accepted unit is the snapshot's
duplicate layout (`validationPrint.template`, checked on entry by
`labelTemplateSpecSchema` and the domain's `assertDuplicateTemplate`; a layout
that fails keeps the operator out as `layout`/unreadable) with the cloud's
`duplicateLabelFields` (`unitLabelFields`: the box label's fields of one unit —
`qty` 1, no SSCC — the full canonical code in `km.code`, the shift's number and
production date, the acceptance moment as the label's instant, the operator's
name, the EGAIS code the snapshot froze as the box labels take it, plan ТОВ),
rendered by `unitLabelRender` (the shift labels' logo rule, the code as
the GS1 raster, `kmDataMatrix: "raster"`; a driver page for a printer through
the Windows driver) for the printer assigned to `duplicate` at the acceptance;
`test/unit-label-render.test.ts` holds its bytes to the domain's ZPL and TSPL at
203 and 300 dpi and to the domain's driver page, and holds its fields and bytes
to the cloud station's duplicate (plan РЕЖ, B8; the cloud's
`duplicateLabelFields` and `renderLabelBytes` restated through the domain, not
imported): the same fields for every optional value, the same ZPL and TSPL at
203 and 300 dpi byte for byte for a layout without an `organization_logo` box,
and with one a difference of the logo alone. The job keeps those bytes and
their print identity for good. Each step is one transaction of the guarded
`MOVE_JOB_SQL` and its `unit_label` record (`StaleUnitLabelError` when the job
moved meanwhile, nothing written): `sendUnitLabel` sends a prepared attempt only —
the duplicate printer assigned now must have the job's way of printing,
language (RAW) and resolution, and a driver page needs a computer that prints
through drivers (`supportsWindowsDriver`), else `failed_before_send`
(`printer_unconfigured` without a printer, `printer_changed` otherwise) and
nothing leaves; `sending` is written before the bytes go, then `sent` on the shell's `{ sent: true }` and
`delivery_unknown` `transport_failed` on any other answer, a timeout or `busy`
(the domain has no failure after `sending`, and the cloud records a failed send
so); `verifyUnitLabel` compares the scanned label with the job's code
(`compareDuplicateKm`, full content and crypto tail) when a required check is
open after `sent` or the outcome is unknown: `verified`, or
`verification_rejected` (`mismatch`/`invalid`) written as a guarded no-op step,
so a check of an attempt that moved on is journalled neither way;
`skipVerification` only after `sent` of a pending required check, with the
operator; `reprintUnitLabel` a new attempt with the operator's reason and the
same bytes and date, from the shift the operator works: not while the attempt
is prepared or sending, not another shift's completed label (`shift_mismatch`,
the cloud's `PRODUCT_LABEL_SHIFT_MISMATCH`; another shift's unresolved one may
be), nor beside another unresolved job (its gate's kind). A step whose job did
not move but whose record the outbox refused — this station closed the shift —
is `UnitLabelShiftClosedError` («Смена закрыта на этой станции…» in the window
and the history), never `StaleUnitLabelError`. A send is held in memory per
print runtime (`isUnitLabelSendActive`, the cloud's `activeSends`) from before
its `sending` write to its last write; a second send of it is stale.
`recoverUnitLabels` — at start, on «Повторить», at any load — makes a job left
in `sending` that no send of this run holds (neither active nor in the
runtime) `delivery_unknown` `interrupted` (the record may name no operator) and
sends nothing; a job whose step fails stops none of the others, the first such
failure thrown after them. Nothing sends a label by
itself: only a prepared attempt is sent, by the operator's screen. A `prepared`
record of a reprint and a skip name their operator (`factRecordSchema`). No full
code reaches a record or a log line. The logo follows the station's rule
(`renderLogoLabel`, as the warehouse reprint of a unit), not the cloud's
duplicate, which prints none: only a layout with an `organization_logo` box
prints one.

The EGAIS code (plan ТОВ). The box and pallet labels take `product.egais` from the
shift's snapshot (`snapshot.product.egaisCode ?? null`, `label-render.ts`), as the
cloud station takes it from its frozen grant: the stock box label's bytes equal those
the cloud's `boxLabelFields` make for the same product, in ZPL and TSPL at 203 and 300
dpi (`test/label-egais.test.ts`). A snapshot of a host before plan ТОВ has no code and
prints the field empty. A pallet's A4 sheet takes it too, but the sheet's renderer
(`pallet-sheet-render.ts`) takes only 19 digits: a frozen code of another form is left
off the sheet with one diagnostic line (`EGAIS_NOT_ON_SHEET_LINE`) instead of failing
every sheet of a shift whose code can no longer change; the thermal labels still print
it, and the office warns when the code is typed. The station says so on screen too,
never stopping the work (`sheetWithoutEgais`: a pallet job whose printer prints A4
sheets and a frozen code not of 19 digits): the label panel of such a job carries a
warning, and a sheet sent — by the line or by «Напечатать снова» — leaves a notice in
the work screen's alerts until «Понятно» (`floor.print.egaisOffSheet`): the sheet went
without the code, which must be corrected in the office's product card. Samples — the sheet preview
(`sampleSheetContext`) and the A4 test print (`a4-test.ts`) — print no code.

## Floor exceptions and close

Stage 2a, plan 2a8 (`src/floor/exceptions`, `src/floor/close`,
`src/local/retention.ts`). The work screen's «Исключения» (`ExceptionFlow`,
`Stop` `exceptions`; never while a label waits or the operator leaves) does
four things, each as the line's next piece of work, handed to the work gate,
and each in ONE transaction with the station's `floor_exceptions` row and its
`box_exception` record (`box-exceptions.ts`):

- «Снять последний код» (`undoLastCode`): the code accepted last into the
  open box (the latest row of `floor_codes` by rowid, whatever the clock
  says) leaves it and is free again; the record carries that code's hash and
  the EXACT `scanned_at` of its `floor_codes` row — the text of the scan's
  own record — because the host takes out only the item of that code added
  at that instant (plan 2a2), so an undo that arrives late, or is sent again
  under a new id, never takes out a later scan of the code.
- «Очистить короб» (`clearOpenBox`), after a confirmation: every code of the
  open box is free again and the box stays open; the record's `occurredAt`
  is the moment of the clear, up to which the host takes out the items.
- «Перепечатать этикетку» of a closed box whose label is done with
  (`reprintBox`): a new print job with the SSCC and the fields of the box's
  last job, the snapshot's template of its revision and the box printer of
  now, written with the `reprint` record and its reason, then sent once; a
  label that waits is decided at its panel (`LabelWaitingError`).
- «Расформировать короб» (`disassembleBox`), after a confirmation: the box's
  codes are free again, `disassembled_at` is set, the SSCC stays spent and
  the box no longer counts among the closed ones.

Each guard compares what was read (the box open with the count read; not yet
taken apart), so a scan or another exception that landed meanwhile makes it
`stale` and writes nothing. A closed box is chosen by a scan of its label
(taken before the pipeline, never journalled) or by the last digits of its
SSCC on a pad of 64 px keys — a text field would take a keyboard scanner's
keys. A reprint and a disassembly need a reason of their list
(`exception-reasons.ts`), with words only for «Другая причина»: trimmed, at
most 200 code points, no control character (`reasonWords`, the host's
`validate::exception_reason_text`), refused before anything is written.

«Закрыть смену» (`ShiftClosePanel`, `Stop` `close`) shows the summary — the
product, the plan of the station's copy now, the fact (the codes it holds),
the deviation, the closed boxes and the units per box — read as the line's
next piece of work, so a scan taken before the press is counted. An open box
with codes or a label that waits keeps the shift open (`readCloseSummary`'s
blocker) and sends the operator back to the work, where both are resolved;
the plan not met needs one of the domain's six reasons. The close
(`closeShift`) is local and needs no host: ONE transaction drops the empty
open box, writes the `shift_closed` record (the plan it saw, the fact, the
closed boxes, the reason, the moment) and marks the copy `closing`, but only
while nothing changed since the summary (no waiting label, the same plan as
the copy's now, no code in the open box it drops, the same counts of codes and
closed boxes, which a code scanned or taken out since changes; else `stale`,
and the summary is read again). A unit label of the shift that is not
resolved (plan РЕЖ part B, task B6; the cloud's `PRODUCT_LABEL_UNRESOLVED`)
is a blocker too, `label_unresolved`: the summary says «Сначала завершите
сохранённые задания печати этой смены.» with «Перейти к этикетке», which opens
its window, and the statement that marks the copy `closing` holds the same
rule itself (`NOT EXISTS` through `INDEXED BY floor_unit_labels_unresolved`),
so a label that becomes unresolved after the summary's read leaves the close
`stale` and never lets a closed shift stand with such a label, which the
retention would keep forever. The summary's read of it
(`SHIFT_UNRESOLVED_UNIT_LABEL_SQL`) is pinned in both lists of plans with the
unit label reads. From then on the
shift takes no record: `outboxStatement` inserts a record only while its
shift has no `local_state`, so its whole transaction is refused otherwise
and `shift_closed` is always the shift's last record (the host marks the
station's own shift late for anything after it). The screen then says «Смена
закрыта на этой станции. Данные будут отправлены автоматически» with the link
and without it, takes no scan again, and «К списку смен» leaves. «Назад к
работе» and «Выйти из смены» are never held, but while the close writes. The
receipt `accepted` of the record — `alreadyClosed` too — makes the copy
`closed` (the fourth statement of `sendFactBatch`); a refused close stays
`closing`, its card in the list says the host's code, and the office closes it
there. The list reads its copies again after every write and every batch of
receipts (`ShellState.outboxVersion`).

A shift the office closes while the station works in it (or before the
station closed it) stays on the work screen to be finished, in finish mode
(`WorkScreenProps.officeClosed`): no new code is taken (the scan is said,
never journalled), while the box, its label, the exceptions and the shift's
close work as usual; the office's close is no leave and starts no wait. In the
list it is «Закрыта в офисе» with «Завершить», which enters it from the
stored snapshot without the host. Its records are late for the host, which
takes them, and its close gets `alreadyClosed`. The station's own close is
never undone by the host's list: `replaceShiftCopies` never touches
`local_state`.

The retention (`purgeAcknowledged`, decision 31) runs when the app starts and
every hour (`scheduleRetention`, never two passes at a time): a shift of the
pairing that this station closed, whose close the host accepted at least 30
days ago (the instant of the receipt, `acked_at <= now − 30 × 24 h`, so the
30th day itself counts; a fixed span of UTC instants), with every record
answered, no label waiting and no unit label unresolved (plan РЕЖ part B),
goes with all its rows — the tables of
`RETAINED_TABLES` by `shift_id`, then the copy, one shift per transaction,
whose first statement deletes the copy only while that still holds. Only an
ACCEPTED close starts the clock: a refused close, and a shift the office
closed that this station has not closed itself, are never purged here; a shift
the office closed and the station then finished («Завершить», its close
answered `accepted` with `alreadyClosed`) is purged like any other, 30 days
after that receipt. The SSCC blocks stay (a restored host asks for them, plan
РК). The codes of a purged shift go with it, and with them the station's own
registry of them (`floor_codes`): a code of a shift accepted more than 30 days
ago, scanned again while the host is away, is taken locally, and only the host
refuses it afterwards (`conflict`, then `needs_fix` on its box); with the link
up the host's code check refuses it first, and SSCC reuse is not at risk (the
blocks and their cursors stay). A later plan's table of a shift's records joins
`RETAINED_TABLES`: a test fails for any table with a `shift_id` that the list
does not name. The rows of a pairing that was forgotten (`clear_copies`) are
never purged: the passes are pairing-scoped, and a new pairing does not see
them. That is a known limit, not a bug of the pass.

Known limits of the retention, and who carries each:

- Every delete of a purged shift searches an index by shift (migration `0010`,
  plan ХП; before it `outbox`, `floor_exceptions` and `floor_pallet_exceptions`
  were read whole: 176 ms against 37 ms at 600 000 outbox rows). What stays is
  the cost of `secure_delete`: the WAL grows by about 31 MB per 1000 deleted
  print jobs (138 ms on NVMe; on eMMC or SATA under `synchronous = FULL` likely
  0.5–2 s of stalled floor writes, once or twice a day, with no risk to data).
  The zeroing is kept: it is what takes deleted codes off the disk.
- A refused or conflicting record keeps its shift until a person resolves it
  on the queue screen (plan ОЧ): `DUE_SHIFTS_SQL` and `PURGE_COPY_SQL` take a
  shift only when none of its `rejected`/`conflict` records has
  `resolved_at IS NULL`. The outbox has no quarantined state; the reference
  copies' `sync_quarantine` is not a shift's and the retention never reads it.
  The clause `r` that says so plans on the index `outbox_shift`, which is not
  covering, so the hourly pass reads the rows of every shift a refusal holds.
  Measured in the final review (node:sqlite 3.53, no `ANALYZE`, `DUE_SHIFTS_SQL`
  over 600 000 records): about 0.2 µs per record of a held shift — 131 ms
  without `r` against 289 ms with it when all 12 shifts of 50 000 records are
  held, 132 against 200 ms with 10 of 300 shifts of 2 000 held, and 57 against
  117 ms at 300 000 records with none held. The base of about 130 ms is plan
  ХП's walk of every accepted record (`outbox_settled`) and dominates either
  way. The pass runs at start and at most once an hour, on a reader connection
  of the WAL pool, so it never blocks a floor write. A covering partial index
  on `outbox (shift_id, host_id, device_id)` over the unresolved refused and
  conflicting records (160 ms in the worst case above) needs a new shell
  migration and is deferred: take it with the next one, together with the
  receipt's index below.
- The receipt's fifth statement (it clears `needs_fix` of a box none of whose
  scans is in conflict any more) checks `NOT EXISTS … conflict` through
  `floor_scans_shift (host_id, device_id, shift_id)`, which walks the box's
  whole shift for each marked box: 0.4 ms with no box marked, about 10 ms per
  marked box in a shift of 100 000 scans (995 ms for a batch of 100 accepted
  scans of 100 marked boxes), inside the single-writer receipt transaction.
  Realistic only after a restore re-sends scans that conflicted before, so for
  few boxes. Not done: an index `floor_scans (box_id) WHERE conflict = 1` with
  the next shell migration.
- A station clock set forward purges early (the cutoff is the clock's);
  checking the clock is not part of plan РК-С and stays open.
- A pass that fails leaves no trace but the next pass trying again: plan 2b or
  РК, with the process log of stage 5.

One shift on one PC is checked end to end on both sides of the protocol:
`test/floor-scenario.test.ts` runs it with the webview's own modules — codes,
three boxes with checked labels, every exception, the host away, the close,
a send that finds no host, one whose answer is lost — and compares the
records and sends with `proto/fixtures/floor-scenario.json`;
`host/tests/floor_scenario.rs` sends those batches to the host's router,
which must answer every record `accepted` and end with the station's
numbers, the digest of every box matching, the shift closed by the station
and not late (and with the office's close first: every record taken, the
shift late, the close `alreadyClosed`). A change of what the station writes
changes the fixture, and both tests read it. Since plan ПЛ-Ц the scenario is a
shift with pallets (see «Floor pallets»).

## Outbox recovery

Plan ОЧ. «Очередь отправки» (`src/floor/queue/QueueScreen.tsx`) opens from
the shift list beside «Рабочее место» (never from the status bar, which holds
nothing to press), so no work of a shift runs while it writes. It shows the
link (`HostStatusLine`), this pairing's records waiting for the host by kind
with the oldest one's wait, its refused records by shift with the reason in
words (`floor.queue.code.*`, one per `FACT_RECEIPT_CODES` entry; a test fails
for a code without words) and its conflicts — never a code of marking, only the
SSCC of the box or pallet a record names — and the records an older pairing
left unsent. Each shift lists its first `QUEUE_LISTED_PER_SHIFT` (20) refused
records and as many conflicts, then «…и ещё N»: the list is numbered per shift
and outcome in SQL (`QUEUE_SETTLED_SQL`, a window over the partial index
`outbox_settled`; only the rows within the bound are joined and their payloads
read) and the counts come from their own statement (`QUEUE_TALLY_SQL`), both
pinned on both SQLite builds. A restored host refuses a shift its copy does
not know on every record, thousands, and the screen reads again on every batch
of receipts.

A person resolves them (`src/floor/queue/outbox-recovery.ts`, migration
`0013`), always after a confirmation that says what follows and takes the
focus, and the row keeps who and when (`resolution`, `resolved_by`,
`resolved_at`, written together; a press guard of 400 ms follows the question):

- «Отправить снова» (`resendRefused`) writes every unresolved refused record of
  the shift again under a new id, its payload byte for byte but the id, after
  everything kept and in the old `seq` order, in parts of `RESEND_CHUNK` (50);
  each old record is marked `resent` with `resent_as` in the transaction that
  writes the new one. The insert goes past `outboxStatement`'s check: a record
  sent again after its shift's close is late by definition (the host marks the
  shift late). A refused close goes the same way and its `accepted` makes the
  shift `closed`. A record this build cannot carry unchanged
  (`UnreadableRecordError`) stops the whole shift before anything is written; a
  record resolved meanwhile is a `StaleQueueError` and the screen reads again.
  A late exception is harmless only because the host matches an undo by its
  `targetScannedAt` and a clear by its cutoff (plan 2a2).
- «Снять с очереди» (a refused record) and «Разобрано» (a conflict) —
  `dismissRecord` — mark the record `dismissed`; a shift's close cannot be
  taken off (its card names the refusal). The office can close a shift the
  host knows; a close refused `unknown_shift` or `not_entered` after a restore
  names a shift the host does not have, so nobody can close it there and
  sending it again is refused again: it stays on the station, holds the shift
  from the retention and counts on the status bar. Whether such a close may be
  taken off is an open owner question; the runbook sends the engineer to the
  developer.
- «Снять с очереди все отказы смены» (`dismissShiftRefusals`) takes off every
  unresolved refused record of one shift but its close, of this pairing only,
  in one guarded `UPDATE` (`DISMISS_SHIFT_SQL`, `outbox_settled`) that writes
  `resolution`, `resolved_at` and `resolved_by` together. Its confirmation
  names the shift and the count, says the close stays and that it cannot be
  undone; the count is the statement's `expectedChanges`, so a refusal that
  arrived since or one resolved meanwhile writes nothing (`StaleQueueError`),
  and a count below one is never a success. Conflicts are never taken off with
  it.

A resolved record no longer counts on the status bar, is not named as a
refused close, is not reopened by a restore's reconciliation (`REOPEN_SQL`),
and no longer holds its shift from the retention. A scan sent again under a new
id leaves the floor's marks of the original as they were.

What the host tells the station of its conflicts (plan КНФ,
`src/local/conflict-notices.ts`) is read by the link's own scheduler
(`noticeReader`, `src/app/host-link.ts`) at the link's first watch, at every
revision and on reconnect, retried like the other reads; a host without the
routes (`not_found`) is no failure. First the displacements from the start of the
newest second kept (`GET /v1/device/displacements` with the nil id: the host
stamps whole seconds and random ids, so a conflict committed later in that
second may sort first), a page at a time after each page's last row, each
kept once (the same record under a restored host's new conflict keeps its
row and resolution and moves to the newer conflict, so the cursor moves on;
one the office reviewed already comes resolved); then, of every record whose
conflict or displacement nobody resolved, in parts of 200, the ones the
office reviewed (`POST /v1/device/conflicts/status`): the record is resolved
by the station itself (`dismissed`, `resolved_at` its clock, `resolved_by`
NULL — no operator of this station did it, the three identities stay apart,
and `office_reviewed_at` the host's instant), so the status bar, the queue
screen and the retention stop counting it. The queue screen lists the open
displacements under «Вытесненные коды» (the box's SSCC and when the host saw
it, the winning shift's number), at most 100, each settled by «Разобрано»
after the same confirmation and 400 ms guard (`dismissDisplacement`), and
the status bar counts them («Вытеснено кодов»). The floor's own marks
(`floor_codes`, `floor_scans.conflict`, `floor_boxes.needs_fix`) are left as
they were, and a station's «Разобрано» never reaches the host (as in the
cloud). Known limits: a displacement is heard at the next revision or
reconnect, not at once; a host clock that goes back can still hide one; a
restored host no longer knows the conflicts after its copy, so those rows can
only be settled on the station.

The status bar also warns of the serials left (`readShiftStock`): the boxes'
and, in a shift with pallets, the pallets', at a quarter and a tenth of the
newest block of that prefix and extension — inclusive, so the words say
«четверть блока или меньше» / «десятая часть блока или меньше» — at the last
serial and at none (pilot spec §9.3); it says how many blocks the host gave that the station did
not take (`floor_block_drops`: a block that shares serials with one kept —
`overlap` — or is not the one asked for — `mismatch`; written with the drop of
its request, `TableClass::DeviceData`), and names, as an item, the records an
older pairing left unsent (read once per pairing). A screen's request to send
after a local write does not cut a failed send's pause short, so the stuck
line's attempts count retries.

Known limits of the queue screen, none of it hidden by a green test:

- Its writes run outside the work gate and the work queue (it is opened from
  the list, when no work runs, like the list's own entry writes). An idle
  sign-out while a decision is written unmounts the screen; the write still
  completes (the module is crash-safe and its parts are resumable) and the
  status bar is told. Judged against N9/N13 and accepted.
- For the same reason the queue screen is a fact writer that the forget's
  conditions («Two windows stay by design»: the fact writer stopped) do not
  cover: neither the work gate tracks it nor stopping the link stops it. A
  refusal of the device while it is open ends the session at once (`reject`
  with `floorWork` null) and unmounts it, while a resend may still be writing
  its parts. The forget counts and clears in one `BEGIN IMMEDIATE`
  transaction, so the only window is a part committed between that clear and
  the removal of `device.json`: those copies stay under the old pairing (an
  older pairing's records, named on the status bar), their originals are
  marked `resent`, and the device was refused anyway. Harmless; accepted.
- Offline scans do not count attempts: the outbox sends nothing while the link
  is not `online` (plan РК-С), and an attempt is counted only when a send goes.
- In the degraded `watchFailed` mode (the app cannot watch the link at all)
  `online` stays false, so a failed send arms no pause (`factRetry`) and every
  screen's request sends at once: there the stuck line's attempts count
  requests again, as before plan ОЧ.
- A second block with the same id keeps the first one's reason in
  `floor_block_drops` (`ON CONFLICT DO NOTHING`); `floor_block_drops` has no
  `shift_id`, so the retention never purges it, and a forget keeps it.
- The records of an older pairing are only counted and named; nothing sends
  them (they stay on the PC's disk; the runbook says what to tell support).
- A queue screen's refusal list cannot send a single record again, nor take
  off a refused close. The office closes a shift the host knows; a close
  refused because the restored host does not know the shift stays (one per
  such shift) until the owner decides whether it may be taken off.
- Not run: Windows, WebView2, a real touch panel (the 64 px of the floor
  buttons is asserted by class in jsdom and pinned by the
  `tools/production-browser` contract, which this plan did not run), a real
  host refusing a record and the same shift sent again after the cause was
  removed.

## Floor pallets

Pilot, plan ПЛ-Ц (`src/floor/pallets/pallets.ts`,
`src/floor/exceptions/pallet-exceptions.ts`; migration
`0008_floor_pallets.sql`). A shift with pallets — `palletsEnabled`, the
copy's `palletBoxCapacity` and `palletTemplateId`, the snapshot's
`palletTemplate`, whose layout `checkShiftSnapshot` reads like the box's (a
stored snapshot of a shift with pallets without one is refused, and the next
entry with the host brings it; an entry whose pallet template no longer fits is
`pallet_template_not_fit`) — fills its open pallet by itself, as the cloud
station does; there is no scan of a box onto a pallet (that is the handheld's,
outside the pilot). `shiftPallets` is `null` for a shift with pallets whose copy
lacks the capacity or the layout, and the work screen then stops
(`pallets_missing`) instead of working boxes alone.

- A box's close joins the shift's open pallet, or opens one whose
  `opened_at` is the box's close, in the box's own transaction
  (`palletStep`, a `CloseStep`), and its `box_closed` names the pallet
  (`palletId`). The box that brings the pallet to the shift's boxes per
  pallet closes it in that same transaction, after the box's record: the
  next serial of the earliest pallet block (extension 1) spent by
  compare-and-set, the SSCC by `buildSscc(1, …)`, the pallet closed only
  while it holds the boxes counted, its `pallet_closed` (`openedAt`,
  `boxCount` — its boxes not taken apart, counted, never stored) and its
  label's print job (`purpose = 'pallet'`, the snapshot's pallet layout, the
  printer of «Паллета», the domain's `palletLabelFields`). A pallet's close
  never happens without its box, nor a box's without its pallet. A rival open
  pallet (the unique index) fails the box's close whole as a write error
  (`close_failed`, «Повторить»; nothing written); the work queue serialises
  closes, so the screen cannot reach it.
- A serial that cannot become an SSCC is lost, not retried for good
  (`freePalletSscc`): one past the prefix's range, or whose SSCC another
  pallet already holds. The same compare-and-set spends that serial alone and
  the close answers `invalid_serial`; the next close takes the next serial. In
  a box's close such a serial leaves the full pallet open and unspent (the box
  still closes and joins), and the pallet closes through `closePalletIfFull`,
  which loses it. The screen's full-pallet close (`settlePallet`) and the early
  close both lose up to three serials in a row (`closeLosingBadSerials`, plan
  ХП): the full pallet then waits with «Номер SSCC паллеты не подошёл и
  пропущен» — never a stop of the line —, the early close stops with
  «Повторить».
- No pallet serial left: the full pallet stays open, the next boxes join it,
  the work screen says «Паллета заполнена, но не закрыта», and it closes as
  soon as serials come (`closePalletIfFull`: on entry, after a box, when a
  pallet block arrives — the block a box's top-up brings queues the close as a
  turn of its own, plan ХП). The message is derived (`palletWaitsNow`): it shows
  only while the open pallet holds at least the capacity, so it goes with the
  pallet's close or when a box is taken off. Pallet blocks are asked for by the
  half rule like box blocks (the block supply with `extension` 1, its own
  waiting request and newest block): on entry, after every close and when the
  link is back.
- «Закрыть паллету досрочно» (`closeOpenPallet`), after a confirmation,
  closes the open pallet with the boxes it holds; an empty one — no box, or
  every box taken apart — is refused before a serial is spent. No serial
  stops the work with its reason (`pallet_no_serials`); three `invalid_serial`
  in a row are the stop `pallet_failed` with «Повторить». The button is off while any stop
  stands or the floor is leaving.
- Labels: `settleLabel` sends every label written and not sent, the box's
  before its pallet's (`readOpenJob` orders jobs of one moment by purpose);
  one that waits stops the work, and the next waits behind it. A pallet's
  label is checked by a scan of its SSCC, skipped, or printed again by the
  same decisions as a box's (plan 2a7), its panel says «паллеты», and its
  records are `pallet_label`; printing again a label that may exist writes
  the `pallet_exception` `reprint` in the transaction that sends it.
- Exceptions: «Перепечатать этикетку паллеты» (`reprintPallet`, a pallet
  whose label is done with: a new job with its last job's SSCC and fields,
  the exception and its record in ONE transaction, then one send) and
  «Расформировать паллету» (`disassemblePallet`: `disassembled_at`, the boxes
  untouched — they keep their pallet, stay closed with their codes, and are
  boxes without a pallet for the exports; the screen asks for the reason and
  then a confirmation, and nothing can be undone). A pallet is chosen by a scan
  of its label (the whole SSCC) or the last digits of its SSCC (every pallet
  that ends alike is listed, up to 12, and the operator presses one); the
  reasons are the box's lists, words only for «Другая причина»
  (`reasonWords`). Both run in the work queue and are tracked. Their
  transactions carry two comparisons (the pallet still closed and whole; for a
  reprint, the job read still the pallet's newest), so a disassembly or a
  racing reprint between the read and the write makes them stale with nothing
  written or sent (`PalletUnavailableError`, `StaleJobError`;
  `PalletTemplateChangedError`, a subclass, when the template moved on).
  The exceptions open only with no label waiting, and the queue's
  `labelWaits()` refuses a reprint or disassembly of any pallet while any
  label of the shift waits, so a pallet is not taken apart under its own
  label's panel. `disassemblePallet`'s transaction refuses it too
  (`PALLET_LABEL_CLOSED_GUARD_SQL` in front of the disassembly: no job of the
  pallet's label open, else `LabelWaitingError` with nothing written), for a
  job written between the read and the write.
- The shift's close: an open pallet with a box not taken apart keeps it open
  (`readCloseSummary`'s blocker `open_pallet`, after an open box and a
  waiting label); an empty open pallet does not, and costs no serial. The
  summary asks «На паллете N из M коробов — закрыть?», and «Закрыть паллету и
  смену» closes the pallet, sends its label and then closes the shift with
  the reason chosen — after the label is decided when it waits. `closeShift`
  takes `openPalletGuard` in its transaction (plan 2a8's `guards`), on every
  close path (`finishClose`). The intention to close the shift is kept only
  over the label of the pallet that this press closed (`pendingClose` carries
  its job id); any other stop, a changed summary or a began leave drops it and
  the operator presses «Закрыть смену» again.
- A new shift on the station offers «С паллетами» / «Без паллет» for a product
  with boxes per pallet (1 to 10 000, `palletCapacityOffered`) and a pallet
  template that is enabled, of the pallet purpose and covers the product's
  group, on by default; the pallet template by decision 7 for the purpose
  `pallet` (`suggestPalletTemplate`), the capacity the product's. A pallets
  form that cannot be made (`palletsOf`) is never sent as a plain shift, and a
  repeated request id that brings back a shift with other pallets than the form
  asked for is the «already created earlier» notice, not an entry.
- Receipts take no new statement: a refused pallet record stays in the
  outbox with its code (plan ОЧ). The shared scenario
  (`proto/fixtures/floor-scenario.json`) is a shift with pallets: two
  pallets, one closed by its second box, one closed early and taken apart,
  a pallet's label printed again; `host/tests/floor_scenario.rs` also checks
  the host's pallets and `closedPallets`.
- Retention: a purged shift's `floor_pallets` and `floor_pallet_exceptions` go
  with its other rows (`RETAINED_TABLES`); a forgotten pairing's rows stay, as
  for the other tables. The pallet blocks and their cursors stay, so an SSCC is
  not reused.

Known limits of the pallets, and who carries each:

- Nothing of it has run on Windows, a printer, a touch panel, WebView2 or a
  real host over a LAN: the model, the screens and the exceptions run under
  jsdom with `node:sqlite` behind `LocalExecutor` and a fake `HostApi`; the host
  met the station's records only through the scenario (`floor_scenario.rs`).
  The by-hand list is under «Verification».
- The intention to close the shift is not kept across a pallet stop (no serial,
  a lost serial, a label error): the operator presses again (question ВЦ3 of
  the plan, recommended answer). After a pallet stop of «Закрыть паллету и
  смену» the shift stays open, and the stop says so («Смена не закрыта…»; the
  stop carries `fromClose`, which «Повторить» and the link-back keep).
- A full pallet waiting for serials never holds the work queue (plan ХП): the
  top-up after each box close asks the host in the background, and a block
  that comes queues the pallet's close (`palletArrived`). The early close
  («Закрыть паллету досрочно», «Закрыть паллету и смену») still asks the host
  inside the queue when no serial is left — up to 2 × 10 s with a hung host, as
  a box close waiting for box serials does: the operator pressed it and waits
  for its answer.
- Pallets of several stations on one shift and the revocation of pallet blocks
  are stage 2b (plan ПЛ-Х, «Перенесено»).

## Warehouse reprint

Plan СКЛ (pilot spec §30) ports the cloud station's «Складские операции →
Повторная печать этикеток» (#693/#695/#697) for one site. «Повторная печать
этикеток» on the list of shifts opens a session inside the operator's floor
session (PIN or badge, offline): its reason (`not_printed`, `damaged`, `lost`)
and a template for each kind of label (unit — `product_duplicate`, box,
pallet), chosen from this pairing's copies (`ref_templates`) with a search and
a sample preview; the organization's default (or the only enabled template)
is chosen at first. A session pauses on «К сменам» and is continued by the
next entry, by any operator; «Завершить сеанс» needs a confirmation and no
waiting job; a finished session is never continued (`wh_sessions_open`).

A scan or a typed code is read by the domain's warehouse rule
(`resolveWarehouseReprintScan`: a KM by its `kmHash`, an SSCC, and the old
TSPL label `!100` + SSCC repaired once, never anything looser) and looked up on
the host, `POST /v1/device/warehouse/lookup` (`routes/warehouse.rs`, a live
STATION only: an office device or a handheld is `forbidden`, on this route and
on the records' one, because the answer carries a unit's full code;
`{ codeHash }` or `{ sscc }`): the code's owner in `code_owners`, a
closed box by `boxes.sscc`, a closed pallet by `pallets.sscc`, of any station
and any shift; the label's fields come from the shift's snapshot, number and
production date, the record's own instant and counts and its operator's name,
and a unit's full canonical code (GS and crypto tail) comes in the answer's
body, never in a record or a log. The station keeps it in the job's frozen
fields (`wh_jobs.fields`, `km.code`) to check a new label against and to render
again, as the floor journal keeps `canonical`; the job's `identity` is the
hash. A pallet's label mixes two eras on purpose (decision Р15): its box count
is the one reported at its close (`box_count_reported`), its unit count the sum
of its boxes not taken apart now. A code freed by an exception is `released`,
a box or pallet taken apart `disassembled`. Without the link nothing is looked
up and the screen says so; an old host (404) is «обновите хост»; a restored
host holds the route (`restore_pending`).

The station makes a job (`wh_jobs`, shell migration `0012`): the operator
checked against the copies, the template checked (enabled, readable, covering
the product's group; a unit's a valid duplicate layout, a box's or pallet's
with the SSCC and no KM), the printer of the kind (`duplicate`, `box`,
`pallet`), the bytes rendered by `renderLabel` (a unit's code as the GS1
raster) — the layout and fields frozen in the job. One job of a session waits
at a time (`wh_jobs_open`); a code the session printed is not printed again
without «Напечатать ещё раз» and a reason. `sending` is written before the
bytes go; a restart turns it into `unknown` (`interrupted`); a failed job is
retried (rendered again only for a printer of another mode, language or
resolution) or cancelled; an unknown one is checked by a scan of the new label
(`compareWarehouseReprintLabel`, which never takes the old `!1` label) or
printed again with a reason. Nothing is ever sent again by itself.

A reprint prints as a shift's thermal label does since plans ДРВ and А4 met it
at the integration merge (`warehouseLabelRender`, `renderLogoLabel`): a layout
with an `organization_logo` box prints the organization logo the station knows
now — that of the newest shift snapshot of the pairing that froze the
organization (`readKnownOrganizationLogo`, `floor_shifts`; the logo is in no
reference copy and no feed) — else the bundled Markiro logo, else an empty box
with `LOGO_UNAVAILABLE_LINE`; the bytes go through the floor's `PrintRuntime`
in the printer's mode (`printerMode`, the profile's `paper` too), so a
driver profile gets a `mono-raster-v1` page drawn only with
`rasterizeDriverText` and never RAW bytes. A printer of A4 sheets is no
printer for a reprint: a pallet's job fails `printer_a4` («Принтер паллет
настроен на листы А4…», with «Рабочее место») and a retry or a new attempt onto
one is refused before anything is written; a box's or unit's purpose never
has one (`printsPurpose`). The A4 sheet prints only from a shift's own pallet
close (`test/warehouse-print-a4-logo.test.ts`).

Each attempt's outcome (`sent`, `unknown`, `failed`, `verified`,
`cancelled`) writes a record in `wh_outbox` in the same transaction; the link
sends them after the facts (`sendWarehouseBatch`) to `POST
/v1/device/warehouse/reprints`, which keeps one row per record in
`warehouse_reprints` (host migration `0015`): receipts as the facts', with
`invalid_record`, `payload_mismatch` and `subject_unknown`. A failed send of
the records has a count and a retry of its own (`warehouseRetry` in
`host-link.ts`, 2 s … 60 s, dropped when the link goes down or ends): it never
shows as a failure of the facts and never pauses them, a scan's send of the
facts does not ask the records' route again before that retry, and a pause of
the facts neither cuts nor stretches it (the retry's end sends only when no
retry of the facts runs; that one sends the records after the facts). Only
`restore_pending` — the host holds both routes — holds the facts too
(`factsHeld`, 60 s). A record names a
code's hash or an SSCC, never a full code; reprint records write no audit row
and take no revision, and change no box, pallet, code or SSCC. A finished
session whose records were all accepted goes 30 days after its finish
(`purgeWarehouseSessions`, in the hourly retention pass).

On the floor (`FloorApp`) the reprint is a view of its own, `warehouse`, beside
the shifts' `work`: the list shows its button only when the app hands the floor
`warehouseLookup` (`HostApi.warehouseLookup`). It is no shift, so the shell is
told of no `work_entered` / `work_left` (`floorWork` names a shift): a refused
device, another host or another line therefore takes the floor at once and does
not wait for a reprint as it waits for a shift's work. What the screen has
written survives that (a job left in `sending` reads as `unknown` at the next
opening); nothing is sent again. Its writes and sends go through the same work
gate as a shift's (`track`, N9): «К сменам», «Рабочее место» (it comes back to
the same session), a sign-out, the idle lock and a host-removed operator all
wait for the work in hand and ask `isLeaving` for any scan meanwhile. The
screen keeps the 400 ms press guard (`view-guard.ts`) and takes the floor's
default clock: pass it none.

Not done (recorded, not hidden): a record the host refused (`outcome =
'rejected'`) stays in `wh_outbox` with its code, keeps its session through the
retention and is never sent again, but nothing on screen counts or shows it —
only the records still waiting («Записи ждут отправки на хост»). A count needs a
new index (`wh_outbox_unsent` is partial on `acked_at IS NULL`) and so a new
shell migration, which belongs to plan ОЧ («Очередь отправки», «Отправить
снова»); it is left to that plan. The page of the office with the history of
reprints and an A4 sheet printed again from the warehouse are also not here
(the driver path and the logo are, see above).

Also recorded: the record of an automatic outcome (`unknown` with
`interrupted` after a restart, a failed write's `unknown`) names the operator
who opened the screen or whose work met it, not necessarily the one who sent:
`wh_jobs` keeps the job's operator, not one per attempt. A session that is
never finished, or one left open under a pairing since replaced, is never
purged (the retention takes finished sessions only), so its jobs and records
stay; a later stage carries that.

The lookup's `product` is the record's shift snapshot as it stands, its EGAIS code
included (plan ТОВ): a reprint prints the code the first label printed, whatever the
office changed since, and a record of a shift opened by an older host prints none.

## Shift exports

Plan ЧЗ ports the cloud's shift exports into the office; the bytes of every
file are the cloud's for the same facts, and that is the acceptance rule.

- The host only reads and records. `GET /v1/office/shifts/{id}/export-source`
  (`routes/office_exports.rs`, every office role) answers `ShiftExportRows`
  in one read transaction: the shift with its number, status, production
  date, the product's name now (the cloud's export joins the live product),
  `closedAt` (the host's whole seconds) and `stationClosedAt` (the accepted
  `shift_close_events.closed_at`, the device's instant), the organization's
  name and INN, the codes the shift owns with their owning scans' canonical
  text, every box, the live items of those boxes only and every pallet. A
  validation shift (plan РЕЖ, Р11) has codes and no box, item or pallet; the
  port renders its codes flat and refuses every format with boxes or pallets
  (`BOX_COVERAGE_INCOMPLETE`: no box covers its codes), so a box or pallet
  file of it is never written with empty groups. The office's export dialog
  offers a validation shift the flat TXT and CSV alone (`offeredFormats` with
  the dialog shift's mode, plan РЕЖ's A8: the source carries no mode), so
  that refusal, whose text is written for an aggregation shift («Не все коды
  смены распределены по закрытым коробам.»), is never shown for it. The
  codes come by their scan instant, then their hash, the order the port sorts them in. Each
  query searches by an index (`every_query_of_the_source_searches_by_an_index`
  runs `EXPLAIN QUERY PLAN` on them), so a year of facts costs one shift's
  export nothing. `GET …/boxes` and `…/pallets` (`routes/office_boxes.rs`)
  list a shift's boxes and pallets with their live units and boxes, derived
  as the cloud's pallet card derives them, for the card of plan О-Ф; a taken-
  apart pallet still lists its boxes there (the box→pallet link stays on the
  host), so a consumer shows `disassembledAt`, not those counts.
- The office ports the cloud's source (`src/office/exports/export-source.ts`,
  the cloud's `shift-export-source.service.ts`) and its runner's mapping of
  failures (`run-export.ts`), and renders through `@markiro/domain`
  (`renderShiftExport`, `renderPalletAggregationExport`). Two rules are the
  standalone's own and change no cloud byte: `operation_date_time` is the
  station's close instant when a station closed the shift (the cloud's
  `shifts.closed_at` is that instant; the host keeps whole seconds), and the
  pallets taken apart that a pallets format still writes are counted for a
  warning. The cloud writes such a pallet as a pallet (its pallet query reads
  no `disassembled_at`), so the port does too, contrary to plan ПЛ-Х's
  contract; a single pallet's document refuses it (`PALLET_DISASSEMBLED`).
  Whether that stays is an OWNER DECISION still open: if the owner wants
  «boxes without a pallet», the cloud and the port change together, one line
  in each (the cloud's `toPalletsSource`, the port's `palletsSource`), or the
  golden below drifts.
  A failure that is not a domain refusal becomes `GENERATION_FAILED` with a
  `reason` (the domain's code, or the error's kind such as `RangeError`,
  never its message); the dialog shows it and nothing logs it.
- Parity is a test on both sides over the same cases:
  `packages/domain/test/fixtures/shift-export-parity/cases.json` holds the
  facts, `golden.json` the cloud's bytes (text, length, SHA-256), file names,
  counts and refusals. `apps/api/test/standalone-export-parity.test.ts` runs
  the cloud's own source and runner over them (no database), and
  `test/export-parity.test.ts` runs the office's port over the same facts as
  the host would answer them. A legitimate change of the cloud's export
  regenerates the golden from the cloud's test alone
  (`EXPORT_PARITY_WRITE=1`), and the port follows in the same change. The
  location under `packages/domain` makes `tools/ci/affected.mjs` run both
  suites on any change of the cases.
  A new cloud format is a host change too: the host takes only the formats of
  `SHIFT_FORMATS` (`routes/office_exports.rs`) and `proto/fixtures/export-formats.json`,
  which `test/protocol.test.ts` compares with `SHIFT_EXPORT_FORMATS` (order
  included) and the host's `the_formats_the_host_takes_are_the_fixtures` with
  the Rust list. Both now carry the eleven shift formats, among them
  `shift_txt_boxes_reversed` (1), the cloud's #681 (the codes of a box, then
  its SSCC); the golden's 218 older entries did not change when its 21 keys
  were added.
- The dialog (`ExportDialog.tsx`, from «Смены» and from the shift's card)
  offers the cloud's formats (the pallets formats only for a shift with
  pallets), each with what its source would refuse now, the line limit
  (2–1 000 000, 2000 by default), the warnings (late data, boxes on a pallet
  still open, pallets taken apart in the document, a pallet's count that
  differs from its boxes, and the shift's unreviewed code conflicts —
  `unreviewed_conflicts`, plan КНФ, every shift format, never a refusal, left
  out when their list does not load) and a ЧЗ document for each closed
  pallet, also of an active shift. A late box and a taken-apart pallet are shown as two facts:
  `late_boxes` also counts a box on a taken-apart pallet, which is still
  written as a pallet. Forming reads the rows
  again, saves the parts and only then records the export; a record the host
  did not take is said, with «Записать снова», and the files stay.
  `document_id` is a new UUID each time and `file_date_time` the moment of
  forming, so two exports of one shift are two documents. The late-data
  warning cannot see a code that an earlier scan of another shift took after
  the close (displacement marks no shift late, as in the cloud). A box closed
  later than its pallet (the host joins it silently, plan ПЛ-Х) is named by
  the `late_boxes` warning of the pallets formats and of that pallet's own
  document, so it is not taken for a part of the pallet as it closed.
- The dialog yields to the interface between steps (one format check, the
  counts, the forming of one document) and can be cancelled until the files
  start to be saved. A single step still blocks as long as it takes: about
  0.5–2 s at 200 000 codes, measured in jsdom on a loaded machine, and so
  does the Zod parse of the host's answer, which is tens of megabytes at that
  size. A worker is the real fix and is not done; the answer's size over
  WebView2's IPC is not measured. The dialog uses the office's `md` and
  `compact` controls, not the 64 px of the floor and station screens; an
  office on a touch panel is a cross-cutting change the owner may want.
- Files go through the shell (`src-tauri/src/office_files.rs`):
  `save_office_files` writes them, byte for byte, into a new folder
  `Документы\Markiro\Выгрузки\<номер смены>\<дата_время>_<формат>` (the
  number as a file name's segment, the moment in the organization's zone; a
  folder that exists gets « (2)»), checks every name before writing and
  takes the folder back on a failure; `open_office_folder` shows it in
  Explorer. No file dialog and no new dependency (pilot question П16).
  `Формы` is the second root (plan О-Ф uses it, see "Shift card and printed
  forms"). A name is a short allowlist
  (plain characters, the extensions csv, txt, xml and html, at most 150
  characters, no link or look-alike character, at most 8 segments); a name or
  a path over 240 UTF-16 units is `invalid_request`, which a long product
  name under a long Documents path reaches, and the dialog says so in plain
  words. `COM0` and `LPT0` are accepted as plain names, and a partial file is
  cleaned by removing the call's own folder, not by writing to a temporary
  file and renaming. None of this is verified on Windows: Explorer's quoting,
  junctions, OneDrive-redirected «Документы» and a path near MAX_PATH ran
  only on macOS temporary folders.

## Shift card and printed forms

Plan О-Ф gives the office the card of a shift and the cloud's printed forms
of a shift (pilot spec §5.5): «Бланк смены», «Состав короба», «Состав
паллеты», «Ярлык паллеты» (A4 or A5) and «Ярлыки паллет смены». The forms
are `@markiro/domain`'s `print-forms`, the cloud's own renderers, so what
makes a standalone form the cloud's for the same facts is the data and its
mapping; the bytes are the acceptance rule.

- The card (`src/office/shifts/ShiftCardPage.tsx`, route `shifts/:id`,
  opened by the number in «Смены») reads the shift afresh (`getShift`) and
  shows its fields, its status and marks as the list does, its boxes
  (`GET …/boxes`, fifty a page, filtered by the SSCC's last digits; the state,
  the pallet, the label check the station sent last, a close whose digest did
  not match) and its pallets (`GET …/pallets`; a station's count that differs
  from the boxes standing is marked, never fixed). «Итоги» opens
  `ShiftTotalsDialog`, «Выгрузка» `ExportDialog` (plan ЧЗ) and «Закрыть»
  `CloseShiftDialog` (`planShifts`), all as the list opens them; a close
  reads the card and every list again. The SSCC of a box and of a pallet there
  link to their own cards (plan КРТ, «Box and pallet cards»). A validation
  shift's card says
  «Печать дубликата»: «Выключена», «Включена, проверка обязательна» or
  «Включена, проверка необязательна» (plan РЕЖ part B, B7); one that prints,
  once open, has «Контроль печати» with what the host counts of its unit
  labels (`ShiftTotals.unitLabels`): «Отправки на принтер», «Проверенные
  этикетки», «Пропущенные проверки» (the standalone's own words: the cloud's
  card does not count them), «Требуют завершения», «Повторные попытки», the
  cloud's warning that a send is not a print, and «Есть этикетки, которые
  требуют внимания» while some are unfinished. Every role prints. The card does not
  refresh itself: an active shift's lists are as of opening, and the pallet
  list is not paged (fine at hundreds; page it at about a thousand).
- The host only reads, one snapshot a route, each query by an index
  (`EXPLAIN QUERY PLAN` in `host/tests/office_reports.rs`):
  `GET /v1/office/boxes/{id}/report-data` (`BoxReportRows`) gives a box's
  codes as the cloud's `boxReportData` prints them — the live items, and of a
  box taken apart the items its disassembly took out (`removed_at` equal to
  the box's `disassembled_at`: the host writes both from the fact's one
  instant), through the scans of the box's shift, since no index names a
  box's items that are no longer live — each with its scan's GTIN, serial and
  canonical text, by GTIN and serial byte for byte (the cloud sorts by its
  database's collation: a serial of mixed case may stand elsewhere there);
  `GET /v1/office/shifts/{id}/pallet-report-data` (`PalletReportRows`) gives
  the shift's number, date and product now and every pallet with every box
  that stood on it (closed first, then by id), a box's units its live items
  (a box taken apart has none; no form prints or counts them). Both name the
  organization. The product is the one now, as the cloud joins it. A box
  still open on a pallet cannot be reached on the host (a box joins the
  pallet as it closes). A box's request for a box of a shift of a hundred
  thousand scans reads the shift's scans (about 0.14 s measured under load);
  an index on the box's items is a host migration, not made.
- The office maps these rows to the cloud's inputs
  (`src/office/forms/form-data.ts`) and draws with `renderForm`
  (`render-form.ts`): SSCCs with `00`, the state as the cloud derives it, no
  logo (pilot question П15) and no photo; times in the organization's zone
  (`formTimeZone`, this PC's when it is not known), except «Сформирован» of
  the blank, which the domain always prints in Moscow time (the cloud's bytes
  are the same). The cloud's refusals stay: a placard needs a closed pallet
  with an SSCC (one taken apart prints with the watermark), «Ярлыки паллет
  смены» print the closed standing pallets closed first and need one, «Бланк
  смены» is for a planned or an active shift and takes the shift's one date as
  both its dates (stage 2a spec, question В3). Its row «ПЕЧАТЬ ЭТИКЕТКИ» of a
  validation shift is the shift's own policy (`validationPrintMode`,
  `validationPrintVerification`; none without one), held against the cloud's
  renderer for both checks in `test/forms-parity.test.ts`.
- Parity: `packages/domain/test/fixtures/print-forms-parity/cases.json` holds
  each case's input as the cloud's loader returns it (`cloud`) and the same
  facts as the host answers them (`host`); `golden.json` the HTML the cloud's
  controllers answer for `cloud`
  (`apps/api/test/standalone-forms-parity.test.ts`, which writes it with
  `FORMS_PARITY_WRITE=1`), and `test/forms-parity.test.ts` draws `host`
  through `renderForm` to the same bytes. The cloud's loaders themselves are
  not run (they are SQL against Postgres): their rules are ported and held by
  the host's tests. A change of a cloud form regenerates the golden in the
  same change; a change of a cloud loader is ported by hand.
- Printing (`print-form.ts`, `PrintFormDialog.tsx`): each press reads the
  rows again (the blank its five records) and draws the form from them, so a
  dialog left open never prints a box as it was; only the card's button for
  the shift's placards decides from the card's cached pallet list, while the
  dialog itself reads fresh. «Печать» writes the HTML into one
  hidden same-origin frame of the office's window and prints that frame
  (WebView2's print dialog, the paper by the form's `@page`); «Открыть в
  браузере» saves it, UTF-8, into a new folder
  `Документы\Markiro\Формы\<номер смены>\<дата_время>_<форма>` and the
  shell's `open_office_file` opens it in the default browser
  (`explorer.exe`, a `.html` of the office's folder only, so no file the
  webview names starts as a program). Both are offered side by side: a print
  dialog that did not open cannot be seen. The forms load nothing from the
  network (inline SVG barcodes, system Arial). The saved HTML carries no
  Content-Security-Policy (the bytes are the domain's, for parity) and relies
  on the domain's escaping of the data. The domain draws synchronously: a box
  of thousands of codes freezes the window for seconds (about 8 ms a code in
  jsdom under load), and a press already inside `openInBrowser` cannot be
  cancelled by closing the dialog; a worker is the real fix.
- «Бланк смены» prints the product's photo (plan ТОВ). The domain's
  `ShiftTaskFormData` takes an optional `imageSrc`: the office passes the photo
  as `data:image/jpeg;base64,…` with its checksum as `imageChecksum`; left out,
  the cloud's relative link is drawn by the same expression, so the cloud's
  bytes and the parity golden are unchanged. The card waits for the photo of a
  product that has one (`officeKeys.productPhoto`), a press reads it again, and
  a photo that does not read leaves the form without it — a photo never stops
  the form.
- `render-form.ts` draws a fifth, shift-less form for plan ДЗГ-О: the kind `act`,
  «Акт дезагрегации» of a disaggregation document (see «Disaggregation in the office»).
  `paint()` moved with it from `PrintFormDialog.tsx` to `print-form.ts` and the act's dialog
  (`DisaggregationActDialog`) is a smaller copy of the dialog's flow without a shift.

## Box and pallet cards

Plan КРТ (parity spec §5.3, rows П-14…П-17; the cloud's `BoxCard`, `PalletCard`,
`pages/pallets` and `pages/boxes` are the references). «Поиск кодов» is one office
section of three parts and two cards, all under `/codes`: `/codes` «Коды»,
`/codes/boxes?shift=` «Короба», `/codes/pallets?…` «Паллеты», `/codes/box/:id` and
`/codes/pallet/:id`. One menu item (`NavLink` without `end` keeps it lit on all of
them).

- **Host routes** (`routes/office_cards.rs`, `routes/office_pallets.rs`; every office
  role, the license gate's `NEVER`): `GET /v1/office/boxes/{id}`,
  `GET /v1/office/pallets/{id}` and `GET /v1/office/pallets` (the list across shifts).
  Read only: one read transaction each, rolled back, no audit row, every query by an
  index (`every_card_query_searches_by_an_index`, `the_list_is_read_in_its_order_through_an_index`).
  The device protocol does not grow (office reads). A card never carries a full code: an
  item is its hash, GTIN and serial (`01<GTIN>21<serial>`); the full text is the code
  card's and `report-data`'s only. The shift's box list also names the operator who
  closed each box (`operatorName`, П-14).
- **Items.** A box card lists every accepted scan into the box (`scans_ok_box`), newest
  first, each with the state it stands in: `removed` before `displaced`, then
  `packed`/`open_box` by the box's close (the code search's order). Rows are capped at
  `CARD_ROW_LIMIT` (10 000, `itemsCapped`/`membersCapped`). A pallet card lists every box
  that joined it, taken apart or not (the evidence that a labelled pallet left a box
  short); its `boxes` and `units` count the closed boxes not taken apart and their live
  items, as the shift's pallet list does.
- **Pallet list.** Open pallets first, then closed newest first, 100 a page, keyed by
  `(ifnull(closed_at, '~'), id)` through `pallets_list_order` (migration `0025`), which
  also re-creates `scans_ok_box` if a rebuild of `scans` lost it. The cursor is
  `o~<id>` after an open pallet and `<milliseconds>~<id>` after a closed one (characters the
  shell's `validate_path` lets through); a pallet that closes between two pages neither
  skips nor repeats a row. Filters: product and line (the SHIFT's, not the station's
  current line), station, a period of closing, an SSCC. The page carries the stations (the
  device list is the administrator's). No warehouse pallets and no «Вид» until the
  handheld stage.
- **«Состав изменился после закрытия»** is `palletCountDiffers` (the station's count at the
  close against the boxes standing now), the same sign as the shift card's, not the
  cloud's server-time comparison.
- **Documents.** Both cards read the applied disaggregation documents whose `ok` line names
  them (`d.status = 'applied'`, `l.status = 'ok'`: a draft, a cancelled document and a line
  that found the box taken apart are not): the readers' union of «Disaggregation
  documents», office branch. The office's disassembly writes no station exception, so
  the cards show the station's exceptions and the documents as two sections. In the
  composition an item that left at the instant of the box's disassembly is marked «по
  документу …». A number links to `/disaggregation/:id` (plan ДЗГ-О).
- **«Расформировать»** (`PackDisassembly.tsx`, `pack-disassembly.ts`): for a closed,
  not disassembled box or pallet with an SSCC of a CLOSED shift (ПР-1; before that a quiet
  line), for both roles. It makes a draft with no reason (a reason is asked of an applied
  document only), adds the SSCC as its line and opens the document; a press while the first
  works sends nothing (a ref: the mutation's own pending flag arrives a tick late). When the
  draft was made and the line was not, the alert names the draft with a link to it.
- **Office.** `CodesSection` keeps the memory of the parts in its own state: the last
  `?…` of each part (`RegistryTabs` writes it in an effect) and the last part, for a card's
  «← Назад» when it was opened with no page before (`location.key === "default"`);
  otherwise it takes the page before. A tab chosen on one page takes the focus again on
  the next, after the shell's own focus move. `useOfficeInfiniteQuery` reads the list;
  the filters live in the address (`pallet-query.ts`), the days in the organization's zone.
  Printing is `PrintFormDialog` with the same targets as the shift's card; «XML паллеты»
  is `ExportDialog` with `palletId` (the dialog reads the shift's whole source and lists
  that pallet only: slow on a big shift, not wrong).
- **Not run.** The cards, the list and the dialogs ran under jsdom and `TestApp` only: no
  WebView2, no printer, no ЛК ЧЗ acceptance of the pallet's XML, no real database of a
  year's work for the list's time (the plan's owner check 10).

## Conflicts and the review of a shift

Plan КНФ (parity spec §5.2, pilot spec §7).

- Host: `GET /v1/office/conflicts?shift=&reviewed=&page=` and `POST
/v1/office/conflicts/{id}/review` (`routes/office_conflicts.rs`); `GET
/v1/office/shifts/{id}/exceptions` and `…/rejections`
  (`routes/office_shift_review.rs`); every office role reads, both roles
  review (`auth::reviews_conflicts`, no wildcard arm). The list is newest
  detection first, 50 a page, at most 200 pages (`pageCount` is capped,
  `total` exact). The shift filter is the LOSING shift's, as the cloud's: the
  winner's box on the host matches what was packed. A conflict names its code
  by `codeHash`, GTIN and serial only: the canonical text with its crypto tail
  never leaves the host this way (a test looks for the fixture's tail). Both
  sides carry shift (number), station (name), operator, the device's instant
  and the box (SSCC, `null` while open, no box at all for a validation shift).
  A review is kept once with its reviewer, an audit row and a revision; a
  repeat answers the conflict as it is.
  The office reads both sides live: the host never deletes a shift or a box
  its scans name (foreign keys; only a planned shift can be deleted), so they
  stay readable without a snapshot, unlike the station's copies.
  A scan with no box (a validation shift's, plan РЕЖ) takes part on either
  side: the loser's cell says «Без короба», offers no «Короб проигравшего»
  link (the shift's own link is there), and a displacement of one reads «этот
  скан его потерял», not «из короба он ушёл» (`conflictKindKey`). On the
  station, `floor_displacements.box_id` is NULL for it and the queue screen
  says «Без короба» and «проверьте изделие» (`DisplacedRecord.boxed`), where a
  boxed one says «проверьте короб». A validation shift's card shows its
  refused records and conflicts but not «Исключения»: box and pallet
  exceptions it cannot have.
- A shift's exceptions and refused records each answer at most 500 rows,
  newest first, with `total`. An undo's serial is its code's (any scan of the
  hash). Refusals the host could not tie to a shift (`unknown_shift`,
  `not_entered`, an unreadable record) are in no shift's list, and a refused
  record the station sent again under a new id stays (the host does not link
  the two); the section's hint says both.
- Device: `POST /v1/device/conflicts/status` (1–200 record ids, the device's
  own scans only, answers the reviewed ones with `reviewedAt`) and `GET
/v1/device/displacements?afterAt=&afterId=` (its displaced scans after the
  cursor, oldest first, 100 a page with `more`; the cursor is the host's own
  spelling of an instant and a conflict id, both or neither). Both are
  writer-free (`AskingDevice`) and not held by a restore. No
  `PROTOCOL_VERSION` bump: new routes are no new fact kind or `data` field.
- Office: «Конфликты» in «Производство» (`src/office/conflicts`), its
  filters in the address (`?shift=&state=&page=`), «Отметить разобранным»
  (one press, the notice takes the focus, every list of conflicts reads
  again). The loser's box links to the box's own card (`/codes/box/:id`, plan КРТ;
  `loserBoxLink`); a scan with no box has no such link on the page (its shift's link is in the scan's cell); the older `?box=<SSCC>` link still
  fills the shift card's SSCC filter. The shift card adds «Исключения», «Отклонённые
  записи станции» and «Конфликты» (the losing shift's, «Не разобрано: N из M»
  and «Все конфликты смены») after the boxes and pallets, each loading on its
  own, paged by 50, with «Показаны последние N из M» past 500. The export
  dialog warns of the shift's unreviewed conflicts (ПР-12: a warning only).
- The station's part is in «Outbox recovery» and «Local database».

## Disaggregation in the office

Plan ДЗГ-О (parity spec §5.1, owner decisions ПР-1…ПР-3, ПР-2: the ЧЗ file) gives the office
the pages of plan ДЗГ's documents, «Акт дезагрегации» and the file «Расформирование
упаковки». No migration, no `PROTOCOL_VERSION` bump: the new routes are office-only.

- **Pages** (`src/office/disaggregation`, «Производство» after «Конфликты»): the list
  `/disaggregation` (filters status, reason, number after 300 ms, period; the host filters,
  the office turns «С»/«По» into host instants in the organization's zone — `to` is the last
  second of its day, the host compares `<=`; pages of 50), the document `/disaggregation/:id`
  (header form on a draft, paste or file import, lines table, apply and cancel behind a
  `ConfirmDialog`), the reasons `/disaggregation/reasons` (a static route above `:id`; a reason
  is archived, never deleted). Every write is `useCan("planShifts")` — the roles of the host's
  `auth::disaggregates` (administrator and technologist); reads are open to every office role.
  The page never applies a document that has a line that is not `ok` or no reason, and it
  re-reads the document after every write; the host re-checks everything under its lock.
- **Input.** Pasted text splits on `[\s;,]+`, a `.txt`/`.csv` file on `[\r\n;,]+` (trimmed,
  empties dropped, duplicates kept — they become `duplicate` lines), at most 10 000 tokens
  and 1 MiB. The BOM Excel writes is dropped (`sscc-input.ts`); the cloud does not, and its
  first token then becomes `not_found` — deliberate difference. Each token goes to the host as
  `{ input, sscc: parseScannedSscc(input) }` (the host only checks the shape) in parts of 500
  (`DISAGGREGATION_MAX_LINES_PER_REQUEST`), in order, stopping at the first part that fails;
  the page says how many went in (`importPartial`) and reads the document, so a half-imported
  file leaves draft lines that can be deleted.
- **Act.** «Акт дезагрегации» is `@markiro/domain`'s `renderDisaggregationReportHtml`, moved
  from `apps/api/src/modules/disaggregation/report.ts` with `git mv` after a characterisation
  lock (`packages/domain/test/fixtures/print-forms/disaggregation-act-*.html`, written by the
  cloud's renderer BEFORE the move). Two additive parameters with defaults that keep the cloud's
  bytes: `timeZone` (UTC) and `operationNote` (the cloud's «передаются в ГИС МТ
  автоматически»). The office passes the organization's zone and
  `DISAGGREGATION_MANUAL_UPLOAD_NOTE` (the standalone sends nothing to ГИС МТ). Chain of
  evidence: the cloud's snapshots → the fixtures `disaggregation-report-rows-*.json` →
  `test/disaggregation-act.test.ts`. `GET /v1/office/disaggregation/{id}/report-data?variant=
boxes|full` (every office role) reads in one snapshot (rolled-back transaction, hook
  `after_query`): the lines with an SSCC in order, the product's name now, the codes of a box
  by the rule of «Состав короба» (read once per SHIFT of the document through `scans_shift`,
  never per box) and a pallet's boxes not taken apart; the short variant reads no codes.
  `render-form.ts` draws it as the form kind `act` (never refused: the cloud prints an act of
  any status); `paint()` now lives in `print-form.ts`; the files go to
  `Формы\Дезагрегация\<номер>\<дата_время>_act_<вариант>` (`actFolder`).
- **ЧЗ file.** `renderGismtDisaggregationXml` (`packages/domain/src/gismt-disaggregation.ts`)
  is the inventory's generator, now shared (its golden `disaggregation.golden.xml` is
  unchanged). The office forms it for an APPLIED document from every SSCC, boxes and pallets;
  an empty INN is refused (`ORG_INN_MISSING`), the INN's form is the generator's (9, 10 or 12
  digits — softer than the shift aggregation's 10; the owner accepted it); saves to
  `Выгрузки\Дезагрегация\<номер>\<дата_время>_disaggregation_xml_gismt\disaggregation-<номер>.xml`
  and only then records it. A record the host refuses leaves the saved file and offers
  «Записать снова» (same record, no second save). The file is uploaded to the Честный знак
  cabinet by hand.
- **The stitch with plan КНФ.** An applied document's box or pallet is now listed where a
  station's exception is: the shift's «Исключения» (`OfficeShiftException` got `source`
  `station|office`, nullable `deviceId`/`deviceName`, and `documentId`, `documentNo`,
  `officeUserName`; the document's reason is `reasonText`) and the code card (`removed` events
  carry `documentId`, `documentNo`, `officeUserName`; exception `disassemble`). The office
  arms of `EXCEPTIONS_SQL` start from the shift's boxes/pallets with `CROSS JOIN`
  (`boxes_shift`/`pallets_shift`, then `disaggregation_lines_box`/`_pallet`): never from every
  applied document; `host/tests/office_shift_review.rs` forbids a table scan in the plan.
- **From the conflicts page.** `OfficeConflictScan` got `shiftClosed` and `boxDisassembled`;
  the loser's closed box of a closed shift has «Расформировать короб», which makes a draft
  with its SSCC through plan КРТ's helper `src/office/codes/pack-disassembly.ts`
  (`startPackDisassembly`, the same as the cards' «Расформировать») and opens it. The conditions are a hint: the host checks.
- **Not checked.** Everything here ran under jsdom, fake hosts and `TestApp`: never the
  print dialog of WebView2, an A4 printer, the DataMatrix of the full act read by a scanner,
  a 200-box full act's time, the acceptance of the XML by the Честный знак cabinet (for a box
  and for a pallet SSCC, and a 12-digit INN), a CSV from Excel on Windows.

## Disaggregation documents

Plan ДЗГ (parity spec §5.1, owner decisions ПР-1 and ПР-3; the cloud's
`apps/api/src/modules/disaggregation` is the reference). The office takes closed
boxes and pallets of CLOSED shifts apart from a document; the office pages, the act
and the XML «Расформирование упаковки» are plan ДЗГ-О.

- **Tables (migration `0024`).** `disaggregation_reasons` (five defaults with fixed ids
  `d15a0000-…-00000000000N`: «Не тот товар», «Неверное количество», «Повреждена
  упаковка», «Брак по качеству», «Другое»; archived, never deleted),
  `disaggregation_doc_counters` (the one counter of `DSG-YY-NNNN`, the year of creation
  in UTC, never reset by year), `disaggregation_documents`, `disaggregation_document_lines`
  and `code_releases` (the feed's source). The fact tables are NOT rebuilt:
  `box_exceptions` and `pallet_exceptions` stay a device's records, so an applied
  document's line is itself the record of the office's action.
- **Routes** (`routes/disaggregation.rs`, `routes/disaggregation_reasons.rs`; roles
  `auth::disaggregates`, administrators and technologists, no wildcard arm; the reasons'
  and documents' reads are open to every office role). A document is a draft until it is
  applied (for good) or cancelled; header, lines and cancel change a draft only
  (`conflict` `document_not_draft`). `PUT`, apply and cancel take `expectedRev`; adding or
  deleting a line takes a revision too, so the card's `rev` moves. Limits: 1–500 lines a
  request, 10 000 a document, an input of 1–64 characters, a comment of at most 500, a
  reason name of at most 120; an unchanged header or reason writes nothing. The list is
  newest first, at most 1 000, filtered by `status`, `reasonId`, `from`/`to` (host
  instants against the creation moment) and `q` (a piece of the number).
- **Lines.** The webview reads the SSCC out of what was typed or imported (the marking
  rules live in `@markiro/domain`) and sends `{ input, sscc }`; `sscc` is 18 digits or
  `null`. The host checks the shape and what the SSCC names, box first, then pallet:
  `not_found` → `not_closed` → `shift_open` → `already_disassembled` → `ok`, plus
  `duplicate` for a repeat within the document (stored with `sscc = NULL`, so a repeat
  stays one even after its original line is deleted, as in the cloud). A line without an
  SSCC is `not_found`. `not_closed` and `written_off` do not occur today (an SSCC exists
  only for a closed box or pallet; the standalone has no write-off).
- **Apply** (`apply_document`). One transaction under `begin_write`, the lock of the
  facts' batch: the role, the draft, the revision and EVERY line are checked again under
  it. A line that is not `ok` (a late fact took its box apart, a shift reopened…) keeps its
  fresh status, the document stays a draft and the answer is `conflict` `invalid_lines`
  with `details.invalidLines`; the card has the lines. Otherwise each box is taken apart
  as a station's `disassemble` does it: every live item gets `removed_at`, the code its scan
  owns is freed (a set-based form of `facts::registry::release`: keep the two in step),
  `boxes.disassembled_at` and the items' `removed_at` are ONE instant in the form of a
  device (`rules::device_text`, 24 characters), so «Состав короба» still finds the
  items by equality; and a `code_releases` row (the code count is the items taken out).
  Each pallet gets `disassembled_at`, its boxes and their codes stay (open them by adding
  their boxes as lines). Every shift touched is marked late (`late_data_at`, once, with the
  apply's revision) as a station's late exception marks it: a file exported before no
  longer describes the shift. The whole apply is one revision, one audit row, and runs on
  its own task, so a client that hangs up never cuts it. Late facts afterwards see the
  result: an exception of the box is `box_state`, a scan of a freed code is accepted, a
  repeated `box_closed` changes nothing.
- **Readers.** The exports, «Состав короба», the lists of boxes and pallets and the
  warehouse reprint need no change: they read `disassembled_at` and `removed_at`. A
  reader of a box's history (the shift review's exceptions, the code card, plan КРТ)
  must also read the applied documents; the join to use:

  ```sql
  SELECT 'station' AS source, e.kind, e.box_id, e.occurred_at AS at, e.reason_code,
    e.reason_text, e.device_id, e.operator_id, NULL AS document_id, NULL AS office_user_id
  FROM box_exceptions e WHERE e.box_id = ?1
  UNION ALL
  SELECT 'office', 'disassemble', l.box_id, b.disassembled_at, NULL, r.name, NULL, NULL,
    d.id, d.applied_by
  FROM disaggregation_document_lines l
  JOIN disaggregation_documents d ON d.id = l.document_id AND d.status = 'applied'
  JOIN boxes b ON b.id = l.box_id
  LEFT JOIN disaggregation_reasons r ON r.id = d.reason_id
  WHERE l.box_id = ?1 AND l.status = 'ok'
  ORDER BY at
  ```

  The same for a pallet through `pallet_exceptions` and `l.pallet_id`. Plan ДЗГ-О did the
  join for the two readers that needed it: the shift review's «Исключения» and the code card
  (see «Disaggregation in the office»). The shift card's «Данные после закрытия» chip and its
  warning also appear after an office disassembly (the shift is marked late — owner decision,
  kept in plan ДЗГ-О).

- **Station.** `code_releases` of the feed (see «Change feed» and «Reference sync»): the
  station deletes its `floor_codes` of the box, so a code freed by a document is accepted
  in a new shift on the same station. Without it the code stays «Дубль (локальный)» for the
  30 days a closed shift's codes are kept. Only `floor_codes` change: the station's
  `floor_boxes.disassembled_at` stays empty, so while its copy of the shift is still active
  (the office closed it offline) the work totals and the close summary count the box with
  fewer codes, and reprint and disassemble are still offered; the host answers them with
  `box_state`, visible in the queue. Rolling out: `ENTITY_SET` changes, so a station that
  starts on the new build syncs from zero before its reference copies are ready (nobody
  signs in until then): upgrade stations while the host is reachable. A restore's hold
  (`site.facts_held_since`) keeps device facts out, and since plan ДЗГ-О an apply too: read
  under the write lock, right after the role check, an apply during the hold answers `409`
  `conflict` with `details.constraint = "restore_hold"` (and `since`) and takes nothing apart —
  it would work on a copy that lacks the stations' later facts. Drafts can still be edited,
  read and cancelled; once an administrator resumes the facts the same draft applies.
- **Not done.** A document of 10 000 boxes holds the write lock for as long as the apply
  takes; stations' fact batches wait up to the 5 s `busy_timeout` and then retry from their
  queue. Measure it on a real volume (the plan's owner check 5).

## Backups and restore

Plan РК (`docs/superpowers/plans/2026-10-09-standalone-rk-backups.md`, the
pilot spec's §11 and §22; the procedure is
`docs/runbooks/standalone-backup-restore.md`). One worker task
(`backup/worker.rs`, started by `crate::start`) makes every copy of the
master database, one at a time, on a connection of its own:

- a copy is `VACUUM INTO <name>.db.partial` while the host runs (a reader:
  it waits for no writer and holds no uncommitted change), then
  `PRAGMA integrity_check` on that file opened read-only and immutable, its
  size and SHA-256, the rename to `markiro-host-<UTC time>-<tag>.db` and a
  manifest `<name>.json` beside it (`backup/copy.rs`; the copy is flushed
  before its rename through `copy::sync_file`, a handle opened for writing,
  because Windows' FlushFileBuffers refuses a read-only one — the restore
  uses the same helper); a failure leaves
  nothing of the copy behind, and a copy never replaces one of its name. On
  Unix the copy, the manifest and the second folder's replica are `0600`
  (they hold what `host.db` holds: PIN and badge hashes, pairing keys); on
  Windows they take the folder's ACL, which is the installer's job for the
  data folder and the administrator's for the second folder;
- beside each copy the worker puts the host identity (plan I1,
  `backup/identity.rs`): `<name>.identity` holds `host.json`'s `hostId` and
  port and the TLS certificate and PKCS#8 key (JSON, base64 DER, format 1),
  and the manifest names it (`identity { fingerprint, sizeBytes, sha256 }`,
  optional: an older manifest or build reads on, and the format stays 1). It
  is created empty as `.partial` (owner-only), closed by a `KeyFileGuard`
  (Unix `0600`; Windows `icacls /inheritance:r /grant:r` SYSTEM,
  Administrators and OWNER RIGHTS — the service's account) BEFORE the key is
  written, renamed, and only then is the manifest written. The key goes
  through the handle that created the file, never through its name
  (`backup/key_file.rs`, std only so a probe crate type-checks it for
  Windows): on Windows that handle is unshared (`share_mode(0)`), so nobody
  opens, deletes or renames the file while the host writes it; on Unix a file
  moved away and replaced while the guard ran fails the device and inode
  check, its key is wiped and the copy goes without the identity. The worker reads the
  data folder's identity before every copy and leaves it out when it does not
  read or names another host. A guard or write that fails leaves the copy
  without it (that folder's manifest names none; the office warns
  `localNoIdentity`/`secondNoIdentity` when a folder's newest copy lacks it,
  and lists «Ключ хоста» per copy, which the host sets from "the manifest
  names an identity and a file of its size lies beside the copy"): the copy
  never fails for the identity. The second folder's replica is checked against
  the manifest and closed by that folder's guard; rotation deletes it with its
  copy (manifest, database, identity last), cleaning removes an `.identity`
  beside no manifest. An `.identity` (or its `.partial`) that cannot be
  removed is logged (path and io error) and skipped, never failing `rotate`
  or `clean`: it is the only copy file with its own ACL, so after a change of
  the service's account or from a new PC on the same share the service may no
  longer delete it, and a sticky second-folder failure would cost more than
  the orphan (runbook section 2: an administrator deletes it). The file IS the host's private key: whoever reads it can answer
  the stations as their host, so it is protected like the copy's PIN hashes,
  never encrypted (no key to keep outside the copies; pilot spec §26).
  `HostIdentity`'s `Debug` prints the host id, port and fingerprint only;
- scheduled: at most one copy per UTC hour, in the first minute of an hour
  in which the database changed since the last good copy
  (`PRAGMA data_version` of the worker's connection, which the worker's own
  audit row does not move) or in which today (UTC) has no copy yet;
  a host that starts copies at once; «Сделать копию сейчас» wakes the worker
  at once. One attempt per hour: a failed hour is not retried before the next.
  A clock that goes back starts the schedule over without a copy of its own;
- the local folder is `<data dir>/backups`; the second folder is the office
  setting `backup_settings.second_dir` (`0011`). A copy reaches the second
  folder only after the local one checked out: copied as `.partial`, synced,
  read back and compared with the manifest by size and SHA-256, then renamed;
  the host never creates the second folder, so an unplugged drive or a share
  that is off is `destination_unavailable`, not a new folder somewhere. A
  failing replica removes only what it wrote, never a replica already there;
- each folder keeps the newest 24 copies, the newest copy of each of the 14
  newest days and of each of the 12 newest months (UTC; `backup/retention.rs`),
  and loses only names that start with `markiro-host-`. Rotation runs only
  after a verified copy joined the folder. A `.partial` file and a `.db`
  without its manifest are leftovers of a broken copy; the worker removes them
  before each copy, in both folders (the only caller of `folder::clean`, and
  one task, so it never meets a copy in flight). Retention is relative to the
  copies' own times, so `folder::rotate` takes the copy the run just made and
  never deletes it: with the clock set back, the copies made before are newer
  and the rule alone would drop the fresh one first. The office warns
  `clockBehind` when the newest copy of either folder is more than an hour
  later than the host's clock;
- a run's outcome per folder is in memory (`Backups::state`, the office's
  `GET /v1/office/backups`: gone after a restart until the first copy) and in
  one `backup.create` audit row (the host as the actor for a scheduled copy,
  the office user for a manual one; `failed` when any folder did not get the
  copy; `details` hold the failure codes, never an error text). A run is a
  task of its own, so a panic is that run's `internal` failure and the worker
  goes on (a panic in the folder task leaves the copy lists the status holds); a host that stops waits up to 10 s for a copy in progress, and
  `shutdown_runtime` (`main.rs`, `service.rs`) then waits at most 5 s more for
  a blocking thread stuck on a dead share. The host does not check free space
  (it would need a dependency): a full disk is a `disk_full` failure of that
  copy.

The office (`routes/backups.rs`): every role reads the state; administrators
ask for a copy (`202`, `conflict` on `backup_running` while one runs or
waits; the request itself writes no audit row, the worker's run does; the
settings and the hold are read before the copy is queued, so a failed read is
a 500 with no copy behind it, and the answer is built from memory) and set or
clear the second folder with
`expectedRev`. A folder is tried before it is saved, off the async threads and
for at most 8 s: missing, not a folder, no right to write, unwritable, timed
out, or inside the data folder is a `conflict` on `backup_dir` with
`details.reason`; a path that is not absolute, has a control character, a `..`
part or a Windows device namespace (`\\?\`, `\\.\`) is `validation_failed` on
`secondDir` (so a share is named `\\PC\Share`, never `\\?\UNC\…`), and the path
is never echoed back. A service sees no mapped drive letters, so a share is
named by its UNC path. A probe thread stuck on a dead share cannot be cancelled.
«Резервные копии» (`src/office/backups/`) shows both folders, the copies on
the host and the held restore; it reads the state with its own polling loop
(1 s while a copy runs, slower when idle, paused while the window is hidden)
and writes times in the organization's zone. «Обзор» repeats the warnings (a
held restore, a failed copy, no copy, a newest copy older than 26 hours by the
host's clock, a host clock behind the newest copy, a copy
running for more than 30 minutes). No second folder is not among them: a fresh
install has none, so «Резервные копии» says so as a calm hint beside the
folder's form (`secondNotSetHint`), and only a second folder that is set and
refused the last copy (`secondFailed`) is an error. The page lists per station whether it
sent its blocks back (`reconciled`, plan РК-С); the host sets the flag on the
last part of a station's blocks (`more` absent), which is empty for a station
that never got a block.

`markiro-host restore <copy> [--data-dir] [--without-manifest]` runs with the
service stopped (the data folder's lock says so; the lock is let go slightly
before the process ends, so the runbook waits for `STATE: STOPPED`) and
changes nothing until the copy checked out: the manifest's size and SHA-256,
`integrity_check`, every migration known to this build with its checksum, a
finished wizard (a copy with a WAL beside it is refused with a manifest and
read with the WAL folded in, in a private folder, without one). It reads the
current database read-only if it opens (retrying a lock; a WAL a stopped host
left counts too; a `-wal` or `-shm` that reading created is removed again; a
database another program holds is refused, not treated as lost), and every
`restore-*/host.db` too. Then it builds the new database BESIDE the current
one (`host.db.partial`: the copy, migrated by this build, changed in one
transaction on one connection that is closed before the swap):

- every SSCC counter is raised to two blocks of its extension above the
  highest serial either database knew (counter, block ends, box and pallet
  serials; never past the prefix's last serial); when the current database is
  not the copy's known history it is also at least 100 000 above the copy's,
  rounded up to 10 000 (about 1 % of a 9-digit prefix's serials per restore).
  The history is known only when the current database was read, its wizard
  was done (`site.initialized_at`) and its `host.json` is the copy's host's: a
  new PC's installer starts the host once and leaves a migrated database
  without a wizard, and another host's numbers say nothing of what the copy's
  host issued. Otherwise the audit sequence also jumps by 1 000 000, no
  revocations are carried and the summary says «the current database is not
  this copy's history»; the live numbers still count as floors; every month's shift
  number is raised by 10 above both, from the copy's month to the current one,
  and so is the disaggregation document counter (`DSG-YY-NNNN`, plan ДЗГ:
  the larger of the counter and the highest `seq` of either database, plus 10; a
  counter at zero in both stays at zero), so a number printed on an act after the
  copy is never issued twice. A document applied after the copy is lost with
  the restore, while the stations have already freed its codes: apply it again
  from its act (repeating the feed from zero deletes nothing new), and look at
  the conflicts that appear;
- the revision is the copy's next one, BELOW what the current database
  reached: a station whose cursor passed it sees the host go back and starts
  again from zero. Best effort until the stations read the epoch. The audit
  sequence is raised above both databases (an audit id never names two
  events);
- the revocations of the current database are carried over (a device and a
  badge stay revoked, an operator and an office user stay turned off; nothing
  the copy lacks comes back); every office session is ended; a password
  changed after the copy is not carried; the copy's devices are not revoked
  when it came from another host. When the current database was not read or
  is not the copy's history, the summary says what is active again;
- the license (plan ЛЦ-2), under the same condition as the revocations: the
  `licenses` rows the current database loaded with a `sequence` above the
  copy's highest are carried as they are (`INSERT OR IGNORE`), and the
  license clock is merged by `restore::carried_clock` so that a restore never
  buys a fresh trial nor gives back a spent extension: the later mark of the
  time (one out of range is none), the earlier trial start with its own INN
  (a start out of range reads as over and is carried; a copy without one, made
  before the license, takes the current one), the current database's
  emergency extension when it took one (else the copy's), the current
  database's wrong-host sighting when there is one (the 30-day window goes
  on); `last_state` stays the copy's, so the first look writes one
  `license.state` row. The license is read apart (`read_license`): a value
  that does not read (text in an INTEGER column) carries no file and no clock
  and fails nothing else — the revocations and numbers still count, and a
  database set aside counts with its numbers only (`read_floors_at`). The
  summary says how many files were carried; else that the previous
  database's license could not be read, that the copy's files are bound to
  another host (the copy made by another host), that the copy holds the files
  up to its time (no previous database, or the copy's identity put in place),
  or (the current database not read, not the copy's history) that files
  loaded after the copy must be loaded again in the office;
- a new `site.restore_epoch` (a UUID), `site.facts_held_since`, one
  `host.restore` row (the host as the actor; `carried`, `licensesCarried` — a
  number, or `null` when nothing could be carried — and `sessionsEnded` are
  part of its details).

The intent marker `host.restore-intent` is written (synced) after the new
database is checked and before the first rename, and removed after the last.
The swap moves the current files into `restore-<UTC time>/` (never deleted),
renames the new database into place (each rename retried against a virus
scanner, the folders synced) and puts everything back if a rename fails.
`crate::start` refuses while the marker is there (`restore::refuse_unfinished`,
before the database opens): the next `restore` rolls back, finishes or, when
the files fit neither, refuses and leaves them for support. The host
identity (plan I1, `identity_plan`): a copy without one keeps the data
folder's (or creates a new one in a folder without `host.json`: every device
pairs again); a folder that already has the copy's identity changes nothing;
a folder without one, or whose database is absent or read without a wizard
(the new PC's installer), gets the copy's; a working host of another
identity (wizard done, or unreadable) is refused unless `--take-identity`
(its files are kept in `restore-<time>/identity/`); `--keep-identity` never
takes the copy's; a damaged identity beside the copy is refused unless
`--keep-identity`; `--without-manifest` reads none. The copy's identity is
staged in `identity.partial/` before the marker (`Intent.identity`) and
renamed into place after the database — key, certificate, `host.json` last —
so the host (refused while the marker is there) never serves a certificate
without its key; a cut-off restore finishes it first (`finish_interrupted`
now runs before `host.json` is read). `foreign` — and with it
`history_known`, the 100 000 margin and the carried revocations — is of the
identity the folder had BEFORE the restore: a restored identity never makes
the installer's or another host's database the copy's history. The
`host.restore` row names `identity` (`same`, `restored`, `kept`, `created`).
Two limits of an interrupted restore: the run that finishes it reads the
database the first run put in place, whose `host.json` is now the copy's, so
its summary says «revocations carried over … 0» where the lost first
summary said what was active again (the runbook sends the engineer to its
check 3 after «it had finished»); and a cut before the marker leaves
`identity.partial/` (0700/0600) until the next restore. `markiro-host
verify-copy` runs the same checks and prints the identity (a damaged one
fails it).
`restore_crashing` and `CrashPoint` are `#[doc(hidden)]` test hooks that stop
the real restore dead after a rename; production passes `None`.

`hello` names `restoreEpoch` once there was a restore. A station that sees it
change sends every block it holds (plan РК-С, below) to `POST
/v1/device/sscc/blocks/known` (`routes/known_blocks.rs`): a block the host
has is `known`, or `refused` `block_mismatch` if it differs; a lost one is
`registered` under the station with its own id as the request id and moves its
counter forward, unless it names no counter (`prefix_unknown`; an extension
above 9, which no serial can carry, is `range_invalid`), is no range of its
prefix (`range_invalid`) or shares a serial with any block, revoked ones
included (`block_overlap`). One revision when anything was registered, one
`sscc.block.register` row per block; the station is marked for the epoch
(`devices.known_blocks_epoch`) on the LAST part (the request without `more`),
whatever became of each block. Only a station, only after a restore (`conflict`
on `no_restore`), 0–64 blocks, none only in the last part (an empty part with
`more` is `blocks`); every part but the last says `more`, which the last never
writes. An older host reads the last part of a new station only:
`KnownBlocksRequest` is `deny_unknown_fields`, so a host built before plan ОЧ
refuses a part with `more: true`, which only a station holding more than 64
blocks sends; host and stations ship in one version. An empty last part
(a station that never took a block, plan ХП) only marks the station.

A receipt is kept for good (plan 2a2), and a copy may lack the shift, the
participant row or the block a station's fact names. So from a restore until
an administrator resumes (`POST /v1/office/backups/resume`, «Возобновить
приём данных станций»), a layer over the whole router answers
`POST /v1/device/facts` and `GET /v1/device/codes/{…}` with `restore_pending`
(503, `Retry-After: 60`, `details.since`) before any route or device check,
and the station sends them again a minute later (`RESTORE_HOLD_RETRY_MS`);
blocks, shifts and the feed are not held. The office lists every unrevoked station and whether it sent its blocks
back; resuming is the administrator's call, behind a dialog that asks for an
explicit confirmation of the runbook's SSCC checks (a station on a dead
computer never returns blocks), and writes one `host.restore.resume` row with
how many did.

The station's side is plan РК-С. The shell's link reads `hello` before every
stream and the `Online` status names `restoreEpoch` ("Connection to the
host"). `useHostLink` notes a new one for the pairing in `floor_restore_epochs`
(migration `0009`, `noteRestoreEpoch`) before anything asks whether blocks are
owed: the row is the obligation and survives a restart. The outbox sends
nothing while the link's latest status is not `online` (only an online status
names the epoch; when `watch` itself failed there is no status to wait for,
and it goes as before), and going online sends it, so no record leaves before
the station knows whether the host was restored. While the obligation is not
settled (`reconciled_at` NULL) the outbox sends nothing (`restoreDue`), and
`reconcileRestore` — at once, at every link event, retried like the reads —
sends every block of `floor_sscc_blocks` of the pairing, used up ones too,
oldest first, 64 to a request and as the host issued it; a refused block gets
its cursor past its end in the transaction after that answer, so no box closes
with a serial the host refused (the box close keeps the other blocks and asks
for a new one by the half rule); `conflict` on `no_restore` means nothing is
owed. Then ONE transaction writes `from_zero` for the sync, puts the records
acknowledged in the last 30 days (`RESEND_WINDOW_MS`, equal to `RETENTION_MS`,
decision 31) back in the outbox — and the warehouse reprint's records the
host accepted in those days back in `wh_outbox` (`WAREHOUSE_REOPEN_SQL`, plan
СКЛ: only `accepted` ones, the refused stay as they are; index
`wh_outbox_accepted`), so the restored host gets its `warehouse_reprints`
trail back; they go after the facts, as always — and settles the epoch with
the count of refused blocks, only if the epoch is still the one read (a later restore noted
meanwhile fails it with `changes_mismatch` and the next run settles that one);
which blocks were refused, each with the host's code, are kept beside the count
(`refused_blocks`, a JSON list for support; a new epoch empties it, and nothing
on screen shows it).
The host answers a record it has with the receipt it keeps, so nothing is
applied twice. A send answered `restore_pending` is the failure `held` and
waits `RESTORE_HOLD_RETRY_MS` (60 s, the host's `RESTORE_RETRY_AFTER_SECS`,
which a test reads in `server.rs`: the shell passes the webview no headers);
while that minute runs no other trigger sends (`factsHeld`), or each scan would
knock a held host. The floor scans and closes boxes offline meanwhile, and code
checks that meet the hold let the scan through as any failed check does. The
status bar says, in its polite region, that the host holds the records, that
blocks are owed, and how many the host refused (the stuck-delivery line is
silent while the hold or the debt explains the wait, and after a settled
restore it counts from the reconciliation, `RECONCILED_AT_SQL`, not from a
reopened record's creation). Before a forget the refused and other-host
screens ask `restoreDue`: owed blocks are said (`shell.restoreOwed`), and the
pairing is forgotten only on «Сбросить, не вернув блоки»; the question of the
unsent records comes after it. The office's hold card shows per station
whether it gave its blocks back (`reconciled`) and the dialog how many of how
many.

Left open, none of it hidden by a green test:

- A station paired again leaves its former device's row (from the copy) «Не
  вернула» until that device is revoked; the office's texts say so
  (`blocksNote`, `confirmNotReturned`).
- The host sets `reconciled` on the last part it answers, even when it refused
  every block of it (the count shows only on the station's status bar); a run
  that fails between parts leaves the obligation open and the next run sends
  everything again, the host answering `known` for the blocks it took. A
  station of an older build never sends `more`, so the host marks it after the
  first part, as before (mixed fleets keep the old guarantee only).
- The 30-day window is per record, not per shift: with a copy older than the
  window a shift can be split (its close goes again, scans acknowledged before
  the window do not).
- The refused-blocks line of the status bar stays until the next restore;
  nothing acknowledges it, so days later it is not a fresh problem.
- The marks a `conflict` receipt left on scans and boxes stay when the record
  goes again. A shift a station opened or created after the copy has no
  re-registration (its facts are refused once the facts resume:
  `unknown_shift`, `not_entered`); the records of a shift it CLOSED after the
  copy go again with the 30 days and are refused for good the same way (the
  receipt is kept). That is more honest than the silent «accepted» before, but
  such records cannot be resent.
- A host error on the blocks that never resolves (a 4xx, a `conflict` other
  than `no_restore`, an answer that does not answer the blocks) keeps the
  obligation open and the outbox waiting: the status bar keeps «станция
  возвращает…», and support reads the station's database.

A restore on a NEW PC keeps the stations' pairing when the copy carries the
host identity (owner decision 2026-10-11, plan I1): the same `hostId`,
certificate and device keys, so everything above applies unchanged. The
stations learn the new address by the PC taking the old one's IP or name, or
by «Сменить адрес хоста» (plan УСТ, `device_change_address`, which keeps the
pairing only where the pinned certificate answers and the host takes the
key; an office session ends with the restore, so the office signs in again);
the certificate is not reissued — devices pin its SHA-256, not its names.
The flip side: a device revoked after the copy is valid again on a new PC
(revocations are not carried, the certificate is the same) and reconnects by
itself once the service answers at the old address, so the runbook (section 6
step 7, check 3) re-revokes under another address first and gives the new PC
the old IP only then.
Still lost on a new PC: stations paired after the copy (the copy does not
know them, their key is refused, they pair again; as on any restore), and
the station that ran on the dead host PC itself. A copy without the identity
(older, from a folder that could not be closed, or `--keep-identity`) keeps
the old limit: every device pairs again, and what the old pairing did after
the copy never reaches the restored host (its records acknowledged after the
copy, its unsent records — they stay on the disk, `device_forget` refuses
with `unsent_facts` until confirmed — its open shift's boxes and its
post-copy SSCC blocks); SSCC uniqueness then rests on the +100 000 margin and
the runbook's check 1, which is mandatory. Two hosts with one identity on one
network would split the stations: the runbook disables the old PC's service.
The same loss hits, on ANY restore (the same PC included), every station
paired after the copy; its SSCC is safe only when the previous database was
read (runbook check 4). The checks that make up for all of this are the
runbook's, done by a person before the resume.

Plan ОБН-1 adds the copy before an upgrade. `crate::start` opens the master
database through `db::open_upgrading`: the pool opens without migrations,
`upgrade::pending` compares `_sqlx_migrations` with the build's migrations,
and when the build brings any the database lacks (on top of at least one it
has; a new file, a failed or an unknown migration are left to sqlx as before;
checksums are not compared) `upgrade::prepare` makes a verified copy through
`backup::copy` (`VACUUM INTO`, `integrity_check`, the manifest, the host
identity when it names this host) into the local folder, named
`markiro-host-<UTC time>-pre-upgrade-<from>-<to>.db` (`from` the newest
migration the database has, `to` the build's newest), and only then do the
migrations run. One `host.upgrade` row: the host as the actor, target `backup`
and the copy's name, details `from`, `to`, `migrations`, `file`, `reused`,
`code`, `appVersion`. A copy that fails runs no migration and the host does not
start (`upgrade::OpenError::Copy`, whose text gives the advice its code calls
for; the service exits, `install` answers 4, Windows retries every 60 s); its
`failed` row is written once while the same failure repeats. A migration that
fails after a good copy writes `failed` with `code: "migration_failed"` and the
copy's name. The next start uses that copy again (`reused: true`, and the row
names the copy's own `from` and `migrations`) when the newest audit row is
that failed row towards the same `to` with a `from` no newer than the
database's (a migration that committed before a later one failed moves the
database on, the copy still holds the state before all of them), and the
copy's manifest reads with the same schema, host and size; so a crash loop
does not fill the disk. The proof that nothing wrote in between rests on every
start writing rows at once (the worker's first `backup.create`) and a restore
writing `host.restore`: a change there must keep it. The manifest says
`trigger: "scheduled"` on purpose: an older build's `read_manifest` and an
older office's `backupTriggerSchema` refuse an unknown trigger, and the
rollback needs the older `restore` to read this copy; the name is the mark
(`upgrade::is_pre_upgrade`, the copy's UTC time and `-pre-upgrade-`).
A copy made of a database already half migrated (the failed row could not be
written, or the power went) is named with a larger `from`: the rollback takes
the copy with the smallest `from` for the upgrade's `to`, the only one the
older `restore` accepts (runbook «Откат хоста к прежней версии»).
`retention::keep_anchored` keeps such a copy while it is no more than 14 days
older than the copy the run just made (`rotate`'s `keep_also`; the folder's
newest without one), whatever the other rules say, so a copy dated ahead by a
clock once set forward does not void it; it is not replicated to the second
folder. `db::open` (no copy) stays for a new database and the restore's own
staging.

Migration `0011` may be applied after `0012` on a database that already had
it (sqlx accepts a lower version not yet applied; the test builds a
`Migrator` from doc-hidden fields, which a sqlx upgrade may touch).

What no automated test shows: the Windows service and its account writing to
another PC's share, UNC and USB behaviour, antivirus against a rename, folder
flush and ACL inheritance, `sc start` refusing while the marker is there, a
really full disk, WebView2 for the page. The runbook's last section lists them
as the manual test.

## License

Plan ЛЦ-2 (`docs/superpowers/plans/2026-10-13-standalone-lc2-host-license.md`,
the spec `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`,
§3, §4, §7, §8 and §19). Only the host decides the license's state
(`host/src/license/`); devices read it in `GET /v1/device` (`license`, a word
and its dates, optional and never in the strict `site` feed record; a license
the host cannot read leaves the record without it, it never costs a station
its record).

- A file is a compact JWS ES256 (`markiro_proto::trust`, plan ЛЦ-1), at most
  16 KiB as sent, checked in the order of §4.3 (`license/verify.rs`) before
  anything is written: form, key, signature, payload and issuer, this host's
  `hostId`, the file's INN against the organization's (`license_inn_missing`
  without one), a `sequence` above the highest stored row, read or not (the
  same `licenseId` again changes nothing). `licenses` only grows; the file in
  force is the highest `sequence` whose `validFrom` came. A row whose times
  are out of range is not used; a row whose terms do not decode is read again
  from its signed text, else not used; each is logged by its id once a
  process.
- The state (`license/state.rs`, a pure function): `wrong_host` (until 30 days
  from when it was first seen or the file's own term and grace, whichever is
  first, then `restricted`) before `inn_mismatch` before the file's term
  (`active`, `expiring` at `min(30, ⌊term/3⌋)` days, `grace`, `restricted`);
  without a file, the 14-day trial from the wizard (`trial`, `trial_expired`,
  no grace). The time (`license/clock.rs`): the PC's clock, never below the
  last known time (`license_clock.max_seen_at`, written hourly and at every
  change, never before the wizard: a PC's wrong clock then must not become
  the floor, and the wizard starts the time afresh from the PC's clock) nor
  below a loaded file's issue less a day, never faster than the process's
  monotonic time while it runs, at most 400 days ahead at a start. A stored
  trial start after the trusted time counts from it; it is written back only
  when the PC's own clock is behind it too (a clock set ahead at the wizard,
  then back), never when the clock was put right ahead while the host ran.
- What the state closes (`license/gate.rs`, `require_new_shifts`): in
  `restricted`, `trial_expired` and `inn_mismatch` only a planned shift's
  first entry and a station's new shift (`conflict` `license_restricted`, no
  row), checked on the shift's writer transaction; a license that cannot be
  read at all closes them too (500, fail-closed). The owner's entry again,
  facts, blocks, closes, exports, copies, pairing and the office never. Every
  router route is in `GATED` or `NEVER`, and `tests/license_routes.rs` fails
  on a route in neither; `LIMITED` names the routes that refuse additions.
  The emergency extension opens new shifts for 72 hours once per file and
  once for the trial (also in `inn_mismatch`, an open question in the spec's
  §19). Its end keeps the state's word but closes new shifts: the look
  compares `opensNewShifts` with its last look in this process (the
  extension's route sets it) and takes a revision without an audit row, so
  the stations read `GET /v1/device` again; after a restart there is nothing
  to compare with, and the first look wakes nobody.
- Seats and features (`license/seats.rs`) refuse additions only, in any state
  and inside the writer's transaction (`conflict` on `seat_limit` or
  `feature_disabled`, no row): stations and handhelds share `stations`
  (pairing, checked after the pairing code and before it is used up; an
  office PC takes no seat), `cabinetUsers` are active office users, `lines`
  lines not archived — the cloud import too, which refuses (and rolls back
  whole) an import whose new lines would go over; `handheld` (pairing a
  handheld), `pallets` (plans and a station's new shift with pallets, pallets
  turned on in a plan) and `labelEditor` (a new template, a new name or
  layout; not the A4 pallet sheets, not the cloud import). Nothing that runs
  is disconnected, even over the limit.
- The trial's mark outside the database: `HKLM\SOFTWARE\Markiro\Standalone\Trial`
  (`StartedAt`, `HostId`, `Inn`) through `reg.exe … /reg:64`
  (`license/trial_mark.rs`), read once at the service's start within 5 s
  (`MARK_TIMEOUT`); a key that cannot be read (any code but 0, no start, no
  answer in time) is neither used nor written. Only a key read without a
  start gets the database's trial (its start, never after the trusted time,
  and its INN; `StartedAt` last). The trial starts at the earlier of the
  database's and the mark's start, with that start's INN (a mark's start
  without a valid INN takes the database's). `markiro-host
install` makes the key ("Installer and service"). Other systems have no
  mark.
- `markiro-host restore` carries the files the current database loaded after
  the copy and merges its license clock, only when it is the copy's history
  and its license reads ("Backups and restore", `licensesCarried`).
- The log holds a file's id, the state and a refusal's code: never the file,
  its signature, the activation request, the INN or the customer's name
  (`no_secrets_in_logs.rs` loads an accepted and a refused file, asks the
  activation request and counts the license's logging calls per module).

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
arbitrates but does not reimplement them.

## Logs

The routes of a shift's exports and of its forms' data answer with codes and
SSCCs and log none of them; `no_secrets_in_logs.rs` reads the export source,
both lists, a box's and the pallets' form data and records an export; the form
data it reads must hold the walk's own code, serial and SSCCs, or the walk
would prove nothing about these routes. The shell's file commands log a
failure by its code and the I/O error's kind, never a path (it names the
Windows user), and the export dialog logs nothing.

Never log device keys, session tokens, pairing codes, passwords, PINs, badge
codes (a scan is one: the sign-in neither logs nor keeps it, and
`test/floor-sign-in.test.ts` and `test/operator-sign-in.test.tsx` check the
console stays silent), any hash or the TLS private key. A label template's
layout is no secret, but at up to 256 KB it stays
out of the log as it stays out of audit details; `no_secrets_in_logs.rs`
walks a stock and an office layout through the template routes, the
defaults and the feed, and a shift's snapshot that carries a layout (and,
since plan ПЛ-Х, a pallet template's) through
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
words (the first shift has pallets since plan ПЛ-Х: a box on a pallet, the
pallet's close under its SSCC of a pallet block, its label check, a reprint
with words and a refused second close under another SSCC, answered
`pallet_already_closed`), a resend, a mismatched resend, a station's close of a
shift and a late scan after it, a batch the host cannot write (a 500, its
failing record second in the batch), the code check and the totals, and asks
that the host kept them and the log has none. The
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
- Plan КРТ (box and pallet cards): `cargo test -p markiro-host --test office_cards --test office_pallets
--test office_boxes` and, in `src/`, `registry-tabs`, `boxes-tab`, `pallets-tab`, `box-card-page`,
  `pallet-card-page`, `pack-disassembly`, `pallet-query`, `pack-cards-protocol` tests; the Vitest page
  tests also run under a 3 ms delayed `setImmediate` (see the vitest effect-race notes).
- Plan КНФ (conflicts and the review of a shift): the host's routes ran only
  against `TestApp` (and the loopback walk of `no_secrets_in_logs`), the
  office's page, card sections and warning only in jsdom, and the station's
  notices and queue section only on node:sqlite with a fake `HostApi`. Not
  run: Windows, WebView2, two stations over a LAN with one offline, a real
  restore of the host, the keyboard order in a real browser.
- Plan ТОВ by hand, on the client's printers and Windows 10/11: a beer label (ЧЗ group 15
  with an EGAIS code) in ZPL and TSPL at 203 and 300 dpi — the «ЕГАИС» row whole and
  legible on the box and pallet labels and on the A4 pallet sheet (a long code on a
  58 × 40 label is the cloud's risk too); an exception reprint and a warehouse reprint
  after the code changed in the office print the frozen code; a shift opened before the
  update prints the row empty, without an error, and a new one prints it; the product
  dialog in WebView2 (the field appears and goes with the group, the default counterparty
  fills a new shift, Tab/Enter/Esc); photos from a phone (JPEG, PNG and WebP of 4000 ×
  3000 and 5 MB) compressed and shown, «Бланк смены» with the photo on an A4 printer and
  in «Открыть в браузере», and without it after a delete; the transfer from a copy of the
  client's cloud — beer with its code, default counterparties in place, the notes in
  words, and a format-1 file made earlier still accepted. The encoder ran in desktop
  Chromium (a 4000 × 3000 PNG became a 640 × 480 JPEG of 147 KB), never in WebView2.
- The floor's shifts (plan 2a5) by hand, on Windows 10 and 11: the list, the
  new shift and the work screen on the real screen and touch panel (64 px
  controls, a long product name on a card); a product scanned on the new
  shift with the keyboard wedge (its code of marking with a GS) under the RU
  and EN layouts; the Windows on-screen keyboard over the name search in kiosk
  mode; with the host on another PC over Wi-Fi, a planned shift entered while
  the link is up, then the access point switched off, «Продолжить» from the
  stored snapshot, and the shift's work and leave; the office moving the
  station to another line and revoking it while the operator is in a shift.
  Until then these have run only under jsdom, with node:sqlite behind
  `LocalExecutor` and a fake `HostApi`: no WebView2, no real host, no scanner
  and no Windows has shown the list, the new shift, the entry or the leave.
- The warehouse reprint (plan СКЛ) by hand, on Windows 10 and 11, with the
  client's printers and scanners. None of it has been run (the screen, the
  work and the delivery have run only under jsdom with `node:sqlite` behind
  `LocalExecutor`, a recording canvas and a fake `HostApi`; the host's routes
  only against `TestApp`): no Windows, WebView2, real host over a LAN, printer
  or scanner has met them, and the Data Matrix of a unit is raster drawn by
  `renderLabel` on a canvas that jsdom does not have. Check at least:
  - a unit's label on the duplicate printer (ZPL and TSPL, 203 and 300 dpi):
    the printed Data Matrix scanned back gives the full code with its GS and
    crypto tail; a box's and a pallet's label with the original dates;
  - an old box label with `!1` scanned with the client's scanner: the new
    label carries the same SSCC without `!1`, and a scan of the old label
    does not confirm an unknown print;
  - the host's PC switched off: the screen says the code cannot be looked up;
    a print cut by pulling the printer's cable: «Неизвестно, вышла ли
    этикетка», the check by a scan of the new label, the records reaching the
    host once the link is back;
  - the template list on the touch panel with the on-screen keyboard over the
    search, and the screen at 1024 × 768 and 1280 × 800 (64 px controls).
- The floor's pallets (plan ПЛ-Ц) by hand, on Windows 10 and 11, with the
  client's printers. None of it has been run; check at least:
  - the pallet label on the client's pallet printer (its language and
    resolution, 100 × 150 or the client's size), printed right after the
    box's label of the box that filled the pallet, and checked by a scan;
  - a full pallet with the host's PC switched off and no pallet serials
    left: the message, the next boxes on it, its close once the link is
    back;
  - «Закрыть паллету и смену» with the label check on, and a pallet's
    reprint and disassembly chosen by a scan of its label;
  - a new shift with pallets on the touch panel, and the office's totals
    of its pallets.
- The floor's exceptions and close (plan 2a8) by hand, on Windows 10 and 11.
  None of it has been run; check at least:
  - each exception on the touch panel, a box chosen by a scan of its label
    with the client's scanner and by the last digits on the pad, and the
    words of «Другая причина» typed with the on-screen keyboard while a
    keyboard scanner is plugged in;
  - the close of a shift with the host's PC switched off: the words after
    the close, the status bar's unsent count, the list's «Закрывается», and
    the close reaching the host once it is back (the office sees the shift
    closed by the station with the same numbers);
  - the office closing a shift while the station works in it: the work
    screen's message, the box and its label finished, the station's close,
    and «Завершить» in the list after a restart of the app;
  - the PC switched off in the middle of a close: on return the shift is
    either open or «Закрывается», never in between;
  - the retention on a real station database after 30 days (the test moves
    the clock, it does not wait).
- The floor's work (plan 2a6) by hand, on Windows 10 and 11. None of it has
  been run; check at least:
  - codes of marking with a GS and a crypto tail scanned on the work screen
    by a keyboard-wedge scanner (RU and EN layouts, Caps Lock) and by a COM
    scanner (`]d2` prefix on and off), both plugged in at once;
  - 3–5 scans a second on a factory PC, with the host on this PC and on
    another PC over Wi-Fi (the 300 ms check of a code at its worst);
  - the access point switched off in the middle of a box: the box closes on
    the block the station holds, the status bar counts the unsent records,
    and once the link is back every record reaches the host once (the
    office's totals equal the station's);
  - the PC switched off right after a scan: the code is still there, and a
    full box closes when the work screen opens again;
  - the 2 000th box of a block: a new block arrives before the first runs out
    (the half rule), and without a link the screen says «Нет номеров SSCC»;
  - the tones on the PC's speakers, the lit last-scan line and the flash of a
    refusal on the real screen and touch panel (a tap through the flash), and
    the work screen's layout at 1024 × 768 and 1280 × 800 (64 px controls).
  - what the tests show so far: the work screen, the pipeline, the closes and the delivery have
    run only under jsdom and node:sqlite behind `LocalExecutor`, with a fake
    `HostApi`: the real host's receipts (`conflict`, `sscc_not_issued`) have not
    met them. `test/floor-offline-line.test.ts` plays the whole offline promise
    over the real modules and a database file, with a fake host that is as
    strict as the real one (a batch over 100, a record seen twice, a block asked
    for twice under one request id): a host that vanishes and comes back,
    restarts, answers lost and a request replayed. `test/app.test.tsx` plays two
    stretches of it through the real screen and the link (a restart finds the
    request, the full box and the records). Neither shows a real host, a real
    scanner or a real Windows.
- The floor's printing (plan 2a7) by hand, on Windows 10 and 11, with the
  client's printers. None of it has been run: the print jobs, the runtime, the
  label panel and the setup have run only under jsdom, with node:sqlite behind
  `LocalExecutor`, a fake canvas and `fakeHardware`: no printer, COM port,
  spooler, WebView2 canvas or audio, Windows or screen reader has met them.
  Check at least:
  - the box label on a Zebra (ZPL) and a TSC (TSPL) at 203 and 300 dpi over
    TCP 9100, a COM port and a USB spooler queue: the label's size and
    position, a long Cyrillic name (IBM Plex through the WebView2 canvas,
    including a canvas near 4096 dots), the dates, and the printed SSCC and
    barcode read back by the client's scanner and equal to the box's (since the
    cloud's #692 the domain writes the TSPL SSCC as the native `EAN128` barcode
    holding `00` and the 18 digits, no longer a `128` with a literal `!1`: on
    a TSC the scan must read `00` + the SSCC and no `!1`; ZPL is unchanged;
    no TSC has been tried); the same
    template matches the office preview; the size of a stock label's stored
    base64 at each resolution;
  - the test print and its scan back on each printer and each connection;
  - a printer switched off, out of paper, paused and unplugged before and in
    the middle of a label: «не напечатана» or «неизвестно» as the shell
    answers, never a second label without the operator; a spooler that takes
    a job for a printer that is off; a COM printer that stops reading (the 20 s
    limit, then «Принтер не ответил вовремя», and the next send to it ending
    «ещё занят»);
  - the PC switched off in the middle of a send: on return the label is
    «Печать прервалась», and the operator's decisions work (printed, print
    again with a reason, another printer, continue without a label); the
    reprint's `box_exception` reaches the host once the link is back;
  - the label check with the client's scanners (an SSCC with and without the
    `]C1` prefix, a badge or a code of marking scanned by mistake),
    «Пропустить проверку» and the reprint with a reason;
  - the work screen's layout with a label panel at 1024 × 768 and 1280 × 800 on
    the touch panel (64 px, a double tap on a view change), and the setup's;
  - `powercfg /requests` while a work screen is open and after it closes, and
    after the window was reloaded during a shift;
  - the COM scanners of the setup: the port list, a scanner added and removed,
    its status, a refused set, and the scanners again after a restart;
  - the kiosk window with the setup open: the Windows on-screen keyboard over
    the printer's fields, the USB printer list, no way out of the locked
    window, and the idle sign-out from the setup.
- The station after a restore of the host (plan РК-С) by hand, on two
  Windows PCs: the runbook's section 10, item 9 — a station closing boxes
  while the host is restored from an hourly copy, the blocks it got after the
  copy registered again, the hold's line and its one-minute retries, nothing
  lost, no `sscc_not_issued` and no repeated SSCC after the resume, and the
  copies of the station equal to the office's; a restore on a new PC from a
  copy with the host identity, the stations keeping their pairing at the new
  address, and one without it, the stations paired again (item 9, third and
  fourth runs; the key file's ACLs, item 11). Until then it has run only
  under jsdom and node:sqlite with a fake `HostApi`; the shell's `hello` read
  ran against a real host on 127.0.0.1 whose `site.restore_epoch` a test
  wrote, never against `markiro-host restore`, and nothing of it has met
  Windows, WebView2, two stations or a real printer.
- The outbox recovery (plan ОЧ) by hand, on Windows 10 and 11, with a host on
  another PC. None of it has been run: the queue screen, the status bar's stock
  and drop lines and the restore's last-part mark have run only under jsdom and
  node:sqlite (and the shell's SQLite 3.46 in the `local_db` test) with a fake
  `HostApi`; the 64 px of the screen's buttons is asserted by class, not
  measured. Check at least: a real refusal (`unknown_shift` after a restore
  from an older copy) shown with its reason, «Отправить снова» after the cause
  was removed and the same shift accepted, the confirmation's focus and the
  buttons on the touch panel, a host restored from a copy while the station
  holds several blocks and the office's «Вернула» appearing only after the last
  part (runbook, section 10), and the records an older pairing left unsent
  named after «Подключить заново» on a new PC.
- Shift modes and unit labels (plan РЕЖ) by hand, on Windows 10 and 11 with
  the client's printers and scanners. They have run only under jsdom with
  `node:sqlite` behind `LocalExecutor`, a fake `HostApi`, a recording canvas
  and the host's `TestApp`; check at least:
  - the host's migration `0020` on a site's real database against the
    service's 30 s StartPending (the installer's exit code 4 and warning) and
    about twice the database's size of free disk; the station's `0014` before
    its window appears;
  - a validation shift entered by a station of the previous version: refused,
    with its own words;
  - a unit's duplicate (ZPL and TSPL, 203 and 300 dpi): the raster Data
    Matrix of the full code printed and scanned back; a duplicate printer
    through the Windows driver; a crash between `sending` and `sent`;
  - the verification window in WebView2 on the touch panel, and the dead end
    of an unresolved label of a shift on another line (an owner question).
- The Windows service and DPAPI run only in the `standalone-windows-build`
  job: it compiles the service and the Tauri app for Windows, and its cargo
  tests round-trip a key through DPAPI. Since plan УСТ it also builds the
  installer and runs its smoke test on the runner (see «Installer and
  service»). A real Windows user profile, two PCs over Wi-Fi, kiosk mode and
  the installer's windows still need a manual check on Windows
  (`docs/runbooks/standalone-install.md`, «Ручная проверка на Windows»); a run
  on macOS proves none of it.
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
  - the window-mode table (owner decision 2026-10-13, «App shell»): a host
    PC and an office PC never lock (the host's first-run wizard, the floor,
    the office, «Выйти в цех»); a fresh station is an ordinary window with a
    frame, a close button and a taskbar button on «Служба хоста не отвечает»,
    the pairing, «Настройки сканера» and the line choice, and closes; it
    locks as soon as its line is set (chosen there or by the office) and at
    every later start; a configured station locks again after «Выйти в цех»
    and after the office session ends; a line cleared by the office keeps it
    locked until a restart;
  - the recovery: `"kiosk": false` added to `installation.json` by an
    administrator keeps a configured station ordinary after a restart, and a
    reinstall brings kiosk mode back; `markiro-standalone.exe --windowed`
    from a console or Win+R while the station is locked unlocks the running
    window at once and brings it to the front, and a fresh launch with it does
    not lock; check also that Win+R and a console are reachable at all with
    the topmost window on screen (Ctrl+Alt+Del → Task Manager → «Запустить
    новую задачу» may open underneath it);
  - «Настройки сканера» before pairing: a COM scanner added there connects,
    the scanner check names the pairing code, a wrong speed shows the garbled
    warning, and the office's code scanned by that COM scanner on the pairing
    screen pairs; a keyboard-wedge scanner under the RU and EN layouts and with
    Caps Lock pairs without any settings;
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
    «Выйти из системы» may be the only way out on a configured station;
  - Win+D, or a minimize any other way, with the window locked: a window
    without a taskbar button is not in Alt+Tab either; starting the app again
    must now bring it back (`window_policy::on_second_launch` shows,
    unminimizes and focuses `main`, which the mock runtime cannot show);
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
  opened by a real station (the station's side, plan 2a5, ran only against a
  fake `HostApi`); a station moved to another line while it works on a shift
  (the dialog's sentence describes what plan 2a5 builds, which no real station
  has shown); and the list against a host with months of shifts or a period
  of 366 days. The «Итоги» window and the «Выпуск» column have run only
  against fixture totals: never against a host's subqueries over real facts,
  nor with the time of the last fact written by WebView2's `Intl`.
- The shift's card and its printed forms (plan О-Ф) have run only under jsdom,
  printing into a mock: never WebView2's print dialog for the hidden frame,
  A4 and A5 paper by `@page` on a real printer, the default browser that
  `explorer.exe` opens for a form's `.html`, Cyrillic and DataMatrix on paper,
  nor a card of thousands of boxes; «Бланк смены»'s DataMatrix scanned by a
  station is plan 2a5's.
- A4 sheets (plan А4) have run only under jsdom, fake hosts and the Rust code of the
  shell on the development machine (pure arithmetic and a fake driver): never a real laser or
  inkjet printer on Windows — `DMPAPER_A4` taken by a real driver, orientation, simplex and
  copies, the 1:1 whole-number scale of `StretchDIBits` (a driver that answers 0 for a scaled
  blit would end every sheet `delivery_unknown`), the printable area against `GetDeviceCaps`,
  margins and the 0.5 mm guard measured with a ruler, a 1 MB spool, a driver refusal, paper out, an
  unavailable queue, a restart in the middle of a job, and the SSCC of both halves of the two-A5
  sheet scanned after cutting. Not run either: the decoding of the logo images (PNG, JPEG,
  WebP, SVG) and of the bundled Markiro SVG in WebView2 (jsdom decodes none; the tests give a
  decoder), IBM Plex loading for `rasterizeSheetText` offline in WebView2 and the office
  preview matching the station's print on one PC, the Windows branches of the shell
  (`#[cfg(windows)]` compiles only in a Windows job — type-checked by a probe crate, never built
  by CI here), and the legibility of the 1-bit logo on a real 203/300 dpi thermal label.
- Plan ДЗГ (disaggregation documents, code releases on the station): the host's routes ran
  only against `TestApp`, the station's release only on node:sqlite and the shell's SQLite.
  Not run: a real scanner and a real repack on Windows (a code freed by a document accepted in
  a new shift on the same station, without «Дубль (локальный)»), a station offline while a
  document is applied (the release arrives with its next sync, also when the office closed the
  station's shift meanwhile), the XML of a shift after an office disassembly in the ЧЗ
  cabinet, a pallet document and the pallet's label and sheet, a document of about 2 000 SSCCs
  (the apply's time under the write lock, stations' facts meanwhile, the stations' sync after),
  and a restore after an apply (the document is gone, the next number is above the last printed
  one, applying it again by its act leaves the stations whole).
- Plan ДЗГ-О (disaggregation in the office, the act, the ЧЗ file): by hand on Windows 10/11 —
  (1) the act, both variants, «Печать» and «Открыть в браузере» for a document of two boxes and
  a pallet: the number, the date and time of the apply in local time, the status, the reason,
  the comment, the author and the one who applied it, and at the bottom the text about the
  manual upload; (2) the full act's DataMatrix read by a station or a ТСД equals the code on
  the bottle (with the GS), the Code128 SSCC reads; (3) a document of 200 boxes of 20 codes in
  the full variant: page numbers, no lone box row at a page bottom, the window not hanging
  for more than a few seconds (write the time down); (4) upload the XML of an applied
  document to the Честный знак cabinet under the organization's INN: accepted, the boxes (and
  the pallet) disassembled there — and what the cabinet answers for an SSCC whose aggregation
  was never filed; a 12-digit INN of an individual entrepreneur; (5) a `.csv` from Excel (UTF-8
  with BOM, `;`) and a `.txt` from 1С: every SSCC added, the first not `not_found`; a file of
  2 000 SSCCs goes in parts in a reasonable time; (6) keyboard only through the list, the
  document, the reasons and both dialogs (Tab, Enter, Esc), the focus visible and, after an
  apply, on the message; (7) a technologist creates, applies, prints, forms the XML and edits
  reasons; (8) «Расформировать короб» on «Конфликты» for a closed box of a closed shift;
  (9) an apply during a restore's hold is refused with the hold's message, and works after
  «Возобновить».

## Shift date (beta 3)

A shift has its own date beside the production date: `shifts.planned_date`
(host migration `0028`), the cloud's `plannedDate`, labelled «Дата смены» — the
working day the shift takes place. A civil date `YYYY-MM-DD`, not an instant.
The shift's NUMBER (`MONYY-NNN`) is still drawn from the production date. The
migration gives every shift already there its production date and a trigger
(`shifts_planned_date_default`) gives the same to an insert that names none; the
column is nullable only for that reason, the answers read
`COALESCE(planned_date, production_date)`. `OfficeShift.plannedDate` is always
present; `DeviceShift.plannedDate` is optional (a host before beta 3 sends none);
`ShiftCreate`, `ShiftUpdate` and `DeviceShiftCreate` take it as an optional field,
so a body of an earlier build reads as before (`proto/fixtures/*-planned-date.json`
beside the older fixtures, which stay). `PROTOCOL_VERSION` is not raised: a station
sends `plannedDate` only to a host updated before it, as the installer's order
already requires. A planned shift's date is edited in the office (`ShiftDialog`);
an open or closed shift's is fixed like the production date. The create audit row
names `plannedDate` only when it differs from the production date, the update row
as any changed field. The office list has a «Дата смены» column and a shift-date
period (`plannedFrom`/`plannedTo`, both ends, narrowing the production-date period)
served by `shifts_planned_date`; the card shows it and the task form prints it. The
station keeps the date: shell migration `0018` adds the nullable
`floor_shifts.planned_date` (`ShiftCopy.plannedDate`, `null` for a copy a host before
beta 3 sent or one made before the migration; no default, a refresh fills it). The
hub's shift card shows «Дата смены» beside the production date when it has one and
nothing extra when it has none. The new-shift form (`NewShift`) has a second DatePicker,
«Дата смены», today in the organization's zone to begin with (`civilToday`) and editable
like the production date (cleared, it keeps the date shown); `isShiftOfRequest` compares
it only when both the host's answer and the body name one. The work screen shows neither
date, and the station prints no shift task form, so nothing else shows it.

## Usage statistics in the support text (beta 3)

`GET /v1/office/usage-stats` (`routes/usage_stats.rs`, administrators only,
read-only, in `license::gate::NEVER`) answers `markiro_proto::usage_stats::UsageStats`:
counts by calendar month for the last twelve months — shifts by mode, origin,
print policy and pallets; scans by verdict; boxes (and the codes their stations
reported, so the average per box), pallets, exceptions by kind, conflicts by kind and
review, warehouse and duplicate-label reprints, applied disaggregation documents,
refused records — and the paired devices by kind. Counts and month keys only; the
types deny a field beyond the allowlist. A shift's rows belong to the month of the
shift's own date, the host's instants to the UTC month of the instant. Every query is
a grouped aggregate driven by an index (`tests/usage_stats.rs` reads each plan and
fails on a scan of a table of facts), so no migration was needed for `scans`;
`warehouse_reprints` and `disaggregation_documents` are read whole (a handful of rows).

The webview asks for it at the click of «Сформировать и скопировать»
(`SupportSection`) and puts it into the support text only ENCRYPTED
(`office/info/support-usage.ts`, `support-crypto.ts`): the payload is copied field by
field from the answer (`usagePayload`), deflated when the webview can, and sealed for
the maker's public key — ephemeral ECDH P-256, HKDF-SHA256, AES-256-GCM — into
`MKS1.<kid>.<base64url>`. The text shows a neutral label and that one token; a build
whose keyset is empty (`proto/fixtures/support-keys.json`, public JWKs only, in the
shape of `trust-keys.json`; the current bundle includes `sup-d11c3182`)
says «недоступна в этой сборке» instead of printing counts, and so does a role that is
not an administrator or a host that did not answer. `tools/standalone-support/decrypt.mjs`
opens a token with the private key (`--key support-private.pem`, a whole support text on
stdin or a file) and prints the JSON and a table; its Node contract
(`pnpm test:standalone-support:contract`) uses an independent writer, and
`test/support-crypto.test.ts` opens the webview's own token with the tool, with tamper
tests on the key id, flag, ephemeral key, nonce and ciphertext. The test keys are made
when the tests run; no private key is committed (`no-private-keys.test.mjs`).

Owner's steps when rotating/provisioning a key (the private key stays private):

```bash
openssl ecparam -name prime256v1 -genkey -noout -out support-private.pem
node tools/standalone-support/decrypt.mjs --public-jwk --key support-private.pem
```

then put the printed `{ kid, jwk }` into `keys` of `proto/fixtures/support-keys.json`
and build. A key that must stop being used goes into `retiredKids` (an old text still
opens with its file); the newest key that is not retired is the one the build uses.

## License request usage statistics (2026-10-18)

Saved activation exports add optional `supportToken` to the legacy activation
request through `standaloneActivationExportSchema`; the strict native activation
protocol is unchanged. The exporter collects fresh usage counts and encrypts the
same `usagePayload` as support text via shared `createUsageToken`. An unavailable
key/read/encryption leaves a usable legacy request and an explicit saved-without-
statistics warning. Never fall back to plaintext statistics.

Platform file and JSON-paste inspection reuse diagnostics ingestion. Require
v2 token hostId to match the activation hostId before writes; preserve tenant
ownership, explicit unbound-host acknowledgment, deduplication and newer-snapshot
rules. A same-tenant registered host can update stats even when registration is
blocked as already registered. Do not save supportToken in site snapshots/audit;
inspect/register mutations have immediate GC and close/unmount resets. Legacy
requests stay valid. Roll out API/admin support and the matching diagnostics
private-key configuration before distributing enriched request files to clients;
older strict admin/API builds cannot read the added field.

## Office user photos

Plan АВА (host and protocol; the profile dialog and the `Avatar` component come in a later
phase). Migration `0046_user_avatars.sql`, `host/src/avatar.rs`, `host/src/routes/user_avatars.rs`.

- **Routes** (all office routes: a station or an office PC with an office session, a handheld
  never; `license/gate.rs` `NEVER`, no gate): `GET /v1/office/users/{id}/avatar` (every role, any
  user; JSON `{ avatar: UserAvatar | null }`, the picture as base64 because the shell passes JSON
  only; an unknown user is `not_found`), `PUT` (`{ dataBase64 }`, the owner only), `DELETE` (the
  owner, or an administrator for someone else's) and `GET …/avatar/image` (the raw bytes: the true
  `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, the checksum
  as a strong `ETag`, `Cache-Control: private, no-cache`, `If-None-Match` answered `304`;
  `404 avatar_not_found` without a photo). No path is built from input: the picture is a BLOB and
  the id a bound parameter; a file name is never read.
- **What the host accepts**: JPEG (baseline, extended or progressive Huffman, 8-bit, one or three
  components), PNG or WebP, decided by the first bytes, never by the client; at most 2 MiB; each
  side 128..=4096 dots and the picture square; no animated PNG or WebP; a WebP's extended
  canvas must equal its bitstream's own sides. The sides come from the
  header only (`inspect`), so a decompression bomb costs nothing. The host stores the cropped
  picture as the office sent it (no re-encoding, so EXIF a client leaves in is kept: the office's
  canvas crop drops it). Limits: `markiro_proto::avatar` and `proto/fixtures/avatar-limits.json`
  (mirrored by `AVATAR_*` in `protocol.ts`).
- **Errors**: `avatar_too_large` 413, `avatar_unsupported_type` 415, `avatar_too_small` /
  `avatar_dimensions_too_large` / `avatar_not_square` / `avatar_corrupt` 422, `avatar_not_found`
  404, `forbidden_replace_other` 403 (another user's `PUT`, an administrator's too, and an unknown
  id alike), `rate_limited` 429 (ten uploads a minute per address, refused ones counted, no row).
  A malformed body is `validation_failed`. The body of this route is limited to
  `avatar::MAX_BODY_BYTES` (the base64 of 2 MiB and a kilobyte): the router's 2 MiB JSON limit is
  below it, so the route has a ceiling of its own; a body past it is `avatar_too_large` too.
- **Version**: `avatarVersion` (integer or `null`; absent from a host before the photos, which
  reads as `null`) is on `OfficeUser` (`/me`, sign-in, wizard) and `OfficeUserRecord` (the
  administrator's list). It is the host's time of the change in milliseconds, raised above the
  row's previous one if the clock stood or went back while the row lives (a clearing takes the
  row and its floor, so a clock set back after a clearing can repeat an older version; the raw
  route's checksum `ETag` cannot); a restore does not repeat one the way a revision counter would. A change takes no host revision and reaches no station.
- **Audit**: `office_user.avatar.set` (details `width`, `height`, `bytes`, `mediaType`,
  `replaced`) and `office_user.avatar.clear` (`{}`), target `office_user`/`{id}`; the actor tells
  the owner from an administrator. The same picture again, a clearing of none and every refusal
  write no row. The backup and the restore carry the table with the file
  (`tests/user_avatars_backup.rs`); a copy from before `0046` restores with no photos.
- **`PROTOCOL_VERSION` stays 6**: new office routes and one additive, defaulted field; the
  compatibility window (`MIN_PROTOCOL_VERSION` 1, `tools/standalone-release/releases.json`) is
  untouched, and a newer webview reads an older host's user with `avatarVersion: null`. The first
  host that answers `GET …/avatar` is the first that stores one: against an older host that call
  is `not_found` (the host's router has no such route), which the UI phase must read as "no photo".
- **Webview**: `HostApi.getUserAvatar` / `putUserAvatar` / `deleteUserAvatar` and the Zod
  `userAvatarStateSchema`, `userAvatarPutSchema` (strict); the texts of the codes are in
  `errors.api.*` (the profile dialog will override them with its own).

App versions are never compared (office, stations and handhelds are separate version lines): the
office raises no warning, chip or attention item from `appVersion` against the host's or another
device's. «Устройства и версии» shows each device's version number and judges only its protocol
against the host's window (`compatible`, `incompatible`, `host_older`, `unknown`). The only
version rules left are the update offer's (a newer host with a signed package, `minUpgradeFrom`)
and the protocol window (`app_too_old` / `host_too_old`).

## Load and soak harness

`apps/standalone/loadtest` (crate `markiro-loadtest`, a dev and acceptance tool, never shipped; its version stays `0.0.0`) is the
harness of spec 2026-10-20 §8. It drives the real `markiro-host` over HTTPS with simulated devices (one per station or handheld:
`engine.rs` is a pure state machine, `device.rs` its network tasks) in one shared shift. A ledger of receipts is the oracle: at
the end the host's totals and its database (read-only, from outside) must equal it exactly. Six drills (`drills.rs`) are the ways a
shared shift ends: close in three orders, force-close from the office, close with no reason, and a stale `leave` that must not undo
a re-entry. They are **not** fault injection. A backup is taken under load and at the end; the last is restored into a folder of its own
(`probes.rs`). After the main run, nine multi-station scenarios (`scenarios/`, plan `docs/superpowers/plans/2026-10-22-multi-station-load-test-scenarios.md`) run one by one, each on a fresh host and site in the run's host mode with its own metrics (its deliberate 409/401/refused connections never reach the main thresholds; its latencies are recorded, not judged): `line-full`, `capability`, `leave-reenter`, `closed-part`, `close-races`, `lines`, `backup-mid-close`, and, with `--host spawn` only, `kill-restart` and `outage` (not judged in-process or attached: a verdict warning). A failed scenario check is a correctness failure. `Profile.scenarios` (`--set scenarios=all|none|a,b`): all for tiny and smoke, none for soak. A file-only WAL observer (`wal_watch.rs`, 100 ms, the WAL header's checkpoint sequence and the wal-index) adds `walWatch` to the report; the harness never checkpoints. The owner's runbook is `docs/runbooks/standalone-load-test.md` (Russian).

- Commands: `markiro-loadtest run --profile tiny|smoke|soak [--set field=value]… [--out DIR] [--keep-data] [--host spawn|in-process|attach]`,
  `compare OLD.json NEW.json`, `summary REPORT.json`. Exit 0 pass, 1 failed verdict or regression, 2 the run could not be made.
  Profiles and thresholds live in `profile.rs` (`Thresholds::for_profile`): tiny is a 20 s self-test (2 stations + 1 handheld,
  latencies four times looser), smoke 4 stations + 2 handhelds × 5 scans/s for 3 minutes, soak the same × 10 scans/s for 4 hours with
  three backups. Spec §8 gives no numbers; they are starting values, to be calibrated.
- Host modes: `in-process` listens on 127.0.0.1 only; `spawn` (the default) starts `markiro-host` as a child, which has no bind option
  and listens on `0.0.0.0`, so it refuses to start without `--accept-network-exposure` (trusted or isolated network only; the CI
  workflow never passes it); `attach` uses a running throwaway host (credentials from `MARKIRO_LOAD_OFFICE_DEVICE_KEY`,
  `MARKIRO_LOAD_ADMIN_LOGIN`, `MARKIRO_LOAD_ADMIN_PASSWORD`, never the command line) and has not been exercised.
- Unavailable probes are warnings, not failures: an `in-process` run does not judge host memory, descriptors or the host log; an
  empty check list does fail. Whether an unavailable probe on a `spawn` host should fail is an open owner decision.
- Outputs go only under `--out` (`$MARKIRO_LOAD_OUT`, default `~/markiro-load`); a folder inside a git checkout is refused. Reports are
  redacted (`redact()` with the run's secrets) before writing; they are still internal results.
- Gate: unit tests and `tests/write_review.rs` run with the workspace (`standalone-rust` and the Windows job, routed by
  `tools/ci/affected.mjs`); `tests/self_run.rs` is `#[ignore]`. The load itself is manual or the opt-in
  `.github/workflows/standalone-load.yml` (`workflow_dispatch` only, in-process, never required, never run on GitHub yet). Run a smoke
  after changing a hot write path (facts, SSCC blocks, entry, leave, close, backup, restore) or `db.rs`.
- Payloads are built from `markiro-proto` types, so a renamed wire field breaks the build. The plan-2b names `maxStations`,
  `participants`, `totals`, `byDevice`, `closeReasonMissing`, `partClosed`, `reasonMissing`, `multi-station-v1` appear as strings in
  `engine.rs`, `device.rs`, `drills.rs`, `run.rs` and `site.rs`; change them together with the fixtures.
- `tests/write_review.rs` is spec §8's write review: hot write paths (`receive_facts`, `issue_block`, `enter_shift`) call
  `begin_write`, no function reads on a deferred `pool.begin()` and then writes (a textual scan that recognises only `pool.begin()`),
  the code check holds no transaction, a facts batch is one transaction of at most 100 records, a backup is one `VACUUM INTO`. A new
  write route takes `begin_write`.
- Observed (one macOS debug build, in-process host): smoke 180 s, 5403 scans, facts p99 about 34 ms, `sscc_block` p99 112 ms, WAL
  backlog about 997 frames, 168 of 168 checks. The backlog sits just under SQLite's 1000-frame auto-checkpoint: it is the ceiling of
  the checkpoint sawtooth, not a load measure. This is not a performance validation.
- Observed with the scenarios (one macOS release build, one machine, plan 2026-10-22 acceptance): smoke in-process 5394 scans, facts p99
  17.9 ms, `sscc_block` p99 67 ms, 168 of 168 checks, 7 scenarios held and `kill-restart`/`outage` not judged; smoke spawned 5402
  scans, facts p99 29.7 ms, `sscc_block` p99 94 ms, 168 of 168, all 9 scenarios held. The WAL watch shows the automatic checkpoint keeps
  up (log restarts every 1-2 s on average, at most about 10 s apart, backlog above 1000 frames in 0.2-0.7 % of samples and at most
  1100), but the log file grows to about twice the trigger (7-9 MiB; no `journal_size_limit`); no explicit checkpoint was needed.
- Not simulated: label checks, box exceptions, validation shifts, disaggregation, warehouse pallets, the handheld's warehouse and
  pallet-event routes, printers, scanners, a real LAN, the Windows service. Exercised by the scenarios, not by the main load:
  `shift_line_full` and revoked devices, a build without `multi-station-v1` (the host answers `shift_busy`, and `shift_status` for a
  closed part, never `protocol_unsupported`, which comes only from the protocol-version header; wizard-created lines default to limit
  1, so scenarios set it), leave and re-entry under load, late facts of a closed part and two closers at once, N closes at once and
  the office racing a device, three lines and shifts at once, a copy in the middle of the closes, and on a spawned host a `kill -9`
  with WAL recovery and a stop with device back-off. Still not exercised: a host 5xx (no host test hook, so the device back-off is
  tested against refused connections only), the stations' and handhelds' own back-off (the harness's device model is), a power cut,
  the office closing after a device closed the LAST part, a kill landing inside a flush (`committedButUnacknowledged` was 0 in every
  run, so the resend-after-crash stored-receipt path is unexercised), the process scenarios in-process or in the workflow.
  Windows-only and unverified: reading `host.db-shm`, retry of the restore's `os error 32`, PowerShell vitals, restarting a host on
  the same port. Release-build numbers are one macOS machine; `soak`, `attach`, Linux, a real LAN or handhelds, and the workflow
  (never run on GitHub) have never run. Harness fixes made on the way: `api.rs` error classes (`net_*` metric keys) and `strip_ansi`
  in `scan_log` (the host log's colour codes hid ERROR lines).
