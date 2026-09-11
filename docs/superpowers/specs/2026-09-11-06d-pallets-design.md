# 06d — Pallets — design spec

**Date:** 2026-09-11

**Status:** Approved in brainstorming on 2026-09-11. Not implemented.

**Scope:** The pallet slice of roadmap contour 06
(`docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`), unblocked by 06c
(`2026-07-29-06c-aggregation-boxes.md`) and reserved by it down to the
extension digit. Covers the server, the line station
(`docs/design-briefs/04-line-station.md` §5–6), the handheld
(`docs/design-briefs/10-tsd-handheld.md` §6) and the cabinet, including pallet
exceptions, the disaggregation document, code search and shift exports.

## Outcome

A shift that has pallets enabled now actually builds them. When a box closes,
it goes onto the terminal's current pallet. When the pallet reaches its box
capacity it closes itself: the device burns one serial from its own pallet
pool, builds the SSCC, renders the pallet label and prints it, recovering from
a failed or unconfirmed print exactly the way a box label already does. The
operator can close a short pallet on purpose, and closing the shift closes any
pallet still open rather than leaving a labelled physical stack that the system
has no record of.

The cabinet lists a shift's pallets next to its boxes, shows which pallet a box
or a code sits on, can disassemble a pallet through a Disaggregation document,
and can export the shift as a two-level GIS MT aggregation.

## Decomposition

One spec, one plan, five dependent steps. Each step leaves the tree green and
the product coherent; none of them ships a half-wired pallet.

| Step               | What it delivers                                                                          | Depends on |
| ------------------ | ----------------------------------------------------------------------------------------- | ---------- |
| **1. Domain + DB** | Capacity rename/migration, `pallets`, `boxes.pallet_id`, `pallet_exceptions`, label model | —          |
| **2. Server**      | SSCC extension digit 1, bundle, ingest, exceptions, `GET /pallets`                        | 1          |
| **3. Station**     | SQLite mirror, close, print recovery, pallet strip, exceptions, shift close               | 2          |
| **4. Handheld**    | Room schema, close, print, pallet strip, batch signature                                  | 2          |
| **5. Cabinet**     | Pallet list, templates, counters, code search, disaggregation, exports                    | 2          |

Steps 3, 4 and 5 are independent of each other and may land in any order.

## What is deliberately not here

- **Pallet exceptions on the handheld.** There is no exceptions screen on the
  handheld at all yet — not for boxes, not for anything (brief 10 §7 is
  undrawn in code). Pallet disassembly and pallet reprint arrive with that
  slice. The handheld does get «Закрыть паллету досрочно», which is an
  ordinary close, not an exception.
- **Pallet on the handheld's code-check screen.** `Routes.SOON` still renders
  `ComingSoonScreen` for the «Проверка кода» tile. The parent pallet appears
  there when that screen exists; the cabinet's code search gets it now.
- **Reverse aggregation** (pre-printed SSCC pool, brief 10 §6a) — a later
  phase for boxes and pallets alike.
- **Pallet building outside a shift**, moving a box between pallets, and
  removing a single box from a pallet. A pallet is built once, by one
  terminal, inside one shift.
- **Kiosk.** The box registry sells boxes; a pallet is invisible to it.

## Decisions

| Question                            | Decision                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| How a box joins a pallet            | Automatically, at box close, onto the closing terminal's own open pallet      |
| Who owns a pallet                   | One terminal. Two terminals in one shift build two pallets                    |
| Unit of pallet capacity             | Boxes. The existing units-valued field is renamed and migrated                |
| Pallet label                        | Full symmetry with the box label: own purpose, own defaults, own shift field  |
| Short pallet at shift close         | Closed by force, with a confirmation naming the box count, and printed        |
| Server model                        | A sibling table of `boxes`, not a level column on `boxes`, not a string on it |
| Disassembling a pallet              | Retires the pallet; its boxes stay intact and keep their `pallet_id`          |
| Pallet level in existing export ids | No. New format ids; existing ones keep emitting exactly what they emit today  |

### Why a terminal owns its pallet

A shift-wide pallet would need the server to arbitrate which terminal's box
lands on which pallet and what number that pallet carries. An offline terminal
could not close and print a pallet without asking — which is precisely the
guarantee the station and the handheld exist to keep. Per-terminal ownership
also matches the floor: each packing station has its own stack.

This is the same reasoning 06c already applied to boxes, and it reuses the same
identity shape: a pallet is `(tenant, shiftId, terminalId, devicePalletId)`.

### Why a sibling table, not a level on `boxes`

Generalising `boxes` into containers with a `level` and a `parent_id` is the
prettier model and the wrong trade. `boxes` is a hot table with a settled
ingest path, the kiosk's registry cursor, the disaggregation document and every
shift export keyed to its current semantics. Rewriting all of that to add one
level buys nothing this product needs today.

A string column (`boxes.pallet_sscc`) is cheaper still and gives the pallet no
life cycle: no print recovery, no disassembly, no card, no document line. The
chosen scope rules it out.

### Why `boxes.pallet_id` and not a join table

`box_items` is a join table because a code can be claimed by two boxes and the
earlier `scannedAt` wins (06b) — the losing membership row must survive as
evidence. A box cannot be claimed by two pallets: it belongs to one terminal,
which has one open pallet. A nullable column makes that a structural
invariant instead of an invariant somebody has to remember.

## 1. Domain and database

### 1.1 Pallet capacity becomes a box count

`products.pallet_capacity` and `shifts.pallet_capacity` are renamed to
`pallet_box_capacity`, along with the TypeScript field (`palletCapacity` →
`palletBoxCapacity`), the station's SQLite mirror columns
(`shift_mirror.pallet_capacity`, `product_mirror.pallet_capacity`) and the
handheld's `ShiftEntity.palletCapacity`.

Renaming the column, not just the label, is the point: every reader breaks at
compile time instead of silently counting units as boxes.

Migration of existing values:

```sql
UPDATE products
   SET pallet_box_capacity = floor(pallet_capacity / box_capacity)
 WHERE pallet_capacity IS NOT NULL
   AND box_capacity IS NOT NULL
   AND box_capacity > 0
   AND floor(pallet_capacity / box_capacity) >= 1;
-- everything else lands as NULL
```

The same for `shifts`. A units figure left sitting under a «boxes» label would
be a wrong value, not a preserved one; NULL truthfully says «unknown, enter it
again». Nothing printed or reported depends on this field today — pallets have
never functioned — so there is nothing to preserve.

New server validation, absent today: `palletsEnabled = true` requires
`palletBoxCapacity >= 1` and `boxCapacity >= 1`, on create, on update and at
shift open. Right now a shift can enable pallets with no capacity at all, which
with a working flow would mean a pallet that never fills.

`packages/domain/src/product-attributes/readiness.ts` keeps its
`PRODUCTION_PALLET_CAPACITY_REQUIRED` reason code — it reads on the renamed
field and still says what it means.

### 1.2 `pallets`

A mirror of `boxes`, minus `registry_version` (the kiosk registry sells boxes;
pallets are invisible to it):

| Column                                  | Notes                                                   |
| --------------------------------------- | ------------------------------------------------------- |
| `id` uuid pk, `tenant_id`               |                                                         |
| `shift_id` uuid not null                | composite FK `(tenant_id, shift_id)` → `shifts`         |
| `terminal_id` text null                 |                                                         |
| `device_pallet_id` text not null        | the device's own id, as `device_box_id` is for a box    |
| `sscc` char(18) null                    | assigned at close only                                  |
| `operator_id` uuid null                 | composite FK → `employees`, MATCH SIMPLE skips null     |
| `opened_at` not null                    |                                                         |
| `closed_at` null                        | device clock                                            |
| `closure_received_at` null              | server `now()`, written in the same statement as `sscc` |
| `print_verified_at`, `print_skipped_at` | mutually exclusive, as on boxes                         |
| `disassembled_at` null                  | retires the pallet; its SSCC is never reissued          |
| `updated_at`                            |                                                         |

Constraints, named and reasoned as their box counterparts:

- `pallets_tenant_id_uq (tenant_id, id)` — lets other tables target a
  same-tenant row with a composite FK.
- `pallets_tenant_sscc_uq (tenant_id, sscc)` — two devices holding overlapping
  pools is the one situation nothing else would reveal.
- `pallets_device_pallet_uq (tenant_id, shift_id, terminal_id, device_pallet_id)`
  **with `NULLS NOT DISTINCT`**. This is load-bearing, not cosmetic, for
  exactly the reason spelled out on `boxes_device_box_uq`: `terminal_id` is
  nullable, and a plain unique index treats every NULL as distinct, so the
  upsert's conflict arbiter would never fire for a null-terminal device and
  every batch would insert a new pallet row. Unlike `boxes`, this table is new,
  so the constraint is written correctly in its own `CREATE TABLE` rather than
  hand-patched into an existing migration.

There is deliberately no `box_count` column: the count is derived from `boxes`,
the same way `boxes` derives its item count from `box_items`, so it cannot
disagree with what the pallet holds.

`contentsChangedAfterClose` for a pallet is derived by comparing a member box's
`disassembled_at` against the pallet's `closure_received_at` — never against
`closed_at`, which is a device clock with no skew bound, for the same reason
the box-level flag already avoids it.

### 1.3 `boxes.pallet_id`

Nullable uuid, composite FK `(tenant_id, pallet_id)` → `pallets (tenant_id, id)`,
backed by an index on `(tenant_id, pallet_id)`.

Set at box close, never earlier: an open box is not yet on any physical pallet.
Never cleared: when a pallet is disassembled the membership stays as the
historical fact that this box was on that pallet, mirroring `box_items`, which
are marked rather than deleted.

### 1.4 `pallet_exceptions`

A separate table rather than a widened `box_exceptions`. That table's `box_id`
is NOT NULL with an FK and its `kind` payload CHECK already has three branches;
making the column nullable to fit pallets would weaken a hot audit table for
no gain.

| Column                                   | Notes                                           |
| ---------------------------------------- | ----------------------------------------------- |
| `id` uuid pk, `tenant_id`                |                                                 |
| `kind` text                              | CHECK `in ('disassemble', 'reprint')`           |
| `pallet_id` uuid not null                | composite FK → `pallets`                        |
| `shift_id`, `terminal_id`, `operator_id` | as on `box_exceptions`                          |
| `reason` text not null                   | both kinds require one, as box disassemble does |
| `disaggregation_document_id` uuid null   | set when the cabinet did it, not an operator    |
| `occurred_at`, `recorded_at`             |                                                 |

The `disaggregation_document_id` FK is hand-spelled in the migration, not in
the Drizzle definition, for the same import-cycle reason `box_exceptions`
documents: `disaggregation.ts` imports from `platform.ts`, not the other way.

«Закрыть паллету досрочно» is **not** an exception. It is an ordinary close of
a short pallet, exactly as closing a partial box is an ordinary close.

### 1.5 Pallet label

- `label_templates.purpose` gains `'pallet'`; the
  `label_templates_purpose_check` CHECK is extended.
- `LABEL_FIELDS` gains `qty.boxes` — the number of boxes on the pallet. The
  existing `qty` on a pallet label means units on the pallet.
- A stock pallet template joins `packages/domain/src/labels/defaults.ts`, dpi
  neutral like the reissued box set.
- Defaults mirror the box ones exactly: `org_profiles.default_pallet_label_template_id`,
  a per-category `org_pallet_label_template_defaults` table, and
  `shifts.pallet_label_template_id`. Resolution at shift creation is category
  default → organisation default → none, as for boxes.
- The resolved spec rides the shift bundle as `palletLabelTemplate` and lands
  in `shift_mirror.pallet_label_template_spec` on the station and the
  equivalent Room column on the handheld.
- The label is built by a `pallet-label.ts` beside `box-label.ts`, sharing the
  same value-binding helpers. Preview and print use one model, so Cyrillic and
  barcode output cannot diverge.

Dates on a pallet label follow the shift's effective production date and
`shelfLifeExpiryDate` from `@markiro/domain`, read from the pallet's own
`closed_at` the way a box label reads the box's — so a recovery print of the
same SSCC carries the same «Дата производства» and «Годен до» as the first
attempt.

## 2. Server

### 2.1 The number space

`PALLET_EXTENSION_DIGIT = 1`, beside the existing `BOX_EXTENSION_DIGIT = 0`.
`sscc_counters` and `sscc_blocks` are already keyed
`(tenant, issuer prefix, extension digit)`, and both device pools are already
keyed `(issuerPrefix, extensionDigit, fromSerial)`. No storage changes.

`ShiftBundleDto` gains two fields beside the existing pair:

```ts
palletSscc: { issuerPrefix; extensionDigit; fromSerial; toSerial; consumedThroughSerial } | null;
palletSsccRevokedFrom: number[];
```

An older station ignores them. They are non-null only when the shift has
pallets enabled; `bundleSscc` degrades a pallet block to `null` under exactly
the same conditions it already degrades the box block (no issuer prefix,
exhausted capacity, read-only subscription), and for the same reason: the
device must still get its product, template and roster.

`PALLET_BLOCK_SIZE = 200`, a tenth of `BOX_BLOCK_SIZE = 2000`. A pallet is
consumed `palletBoxCapacity` times more slowly than a box, so 200 pallet
serials match the offline reach of 2000 box serials at a pallet of ten boxes
and exceed it above that — and a device that never fills them has not burned
2000 numbers into the sand.

`recordConsumedSerial` is called with extension digit 1 for a pallet SSCC. Skip
this and a device that loses its local database is handed its pallet block back
from `fromSerial` and reprints serials already standing on pallets — the exact
failure the box-side cursor exists to prevent.

`org-profile` and `counterparties` hard-code `BOX_EXTENSION_DIGIT` in
`counterState` and in the seed route. Both gain a pallet counter alongside,
with the same reseed floor (`seedFloor`) and the same blocker check
(`findSeedBlocker`) so a reseed cannot drop below an already-issued serial.

### 2.2 The sync batch

`POST /station/scans` changes in three backward-compatible ways.

**Box closure** gains `devicePalletId: string | null`, defaulting to `null`.
An older station omits it; its box is simply not on a pallet.

**`pallets[]`**, a new array, independent of `items` and `boxes` for the same
reason box closures are independent of items — a pallet closes long after the
box that filled it:

```ts
{
  palletId: string; // device-local, max 64
  shiftId: string; // uuid
  terminalId: string | null;
  sscc: string; // 18 digits
  closedAt: string; // datetime
  operatorId: string | null;
  printVerifiedAt: string | null; // mutually exclusive with
  printSkippedAt: string | null; // printSkippedAt
}
```

capped by a new `MAX_PALLET_CLOSURES_PER_SYNC_BATCH` exported from
`@markiro/domain`. Both sides must read that constant. If the device's drain
limit and the endpoint's ceiling disagree, a device that reads more closed
pallets than the endpoint accepts has its whole batch rejected every time, and
the drain retries forever — wedging pallet closures, box closures and scans
together. This is written down because the box-side comment had to learn it.

**`palletExceptions[]`**: `{ kind, palletId, shiftId, terminalId, operatorId, reason, occurredAt }`,
`reason` required for both kinds.

### 2.3 Ingest

Inside the existing single transaction, in order: items → box closures → pallet
closures → box exceptions → pallet exceptions.

Pallets are sorted by `devicePalletId` before processing, for the same
40P01-avoidance reason the item upsert and the box-closure loop already sort:
concurrent batches touching overlapping rows must take them in the same order.

Pallet rows are created by a **pre-pass** over the batch, before the
box-closure loop: every `devicePalletId` named by a box closure or a pallet
closure is upserted `ON CONFLICT DO NOTHING` in one sorted multi-row insert,
then read back into a `(shiftId, terminalId, devicePalletId) → id` map. The
box-closure UPDATE takes `pallet_id` straight from that map, so a box's
membership and its closure are one statement and one fact.

This is the box rule one level up — a box row is created by its first arriving
item, a pallet row by the first closure naming it — and the pre-pass is what
makes it one statement instead of a per-closure round trip. A pallet closure
naming an id no box mentioned still creates the row: that is a pallet closed
with no boxes, the direct analogue of the zero-item box closure the ingest
already handles.

The upsert resolves on `pallets_device_pallet_uq` and writes `sscc`,
`closed_at`, `closure_received_at`, `operator_id` and the print outcomes only
when `sscc` is still null, so a replayed batch is a no-op rather than a second
closure. An SSCC already taken raises `pallets_tenant_sscc_uq`'s 23505 and is
surfaced the way the box-side collision already is.

Setting `boxes.pallet_id` happens in the box-closure statement itself, not as a
second write: the box's membership and its closure are one fact.

The batch response needs no new field. Acceptance of a pallet closure is
implied by acceptance of the batch, as it is for boxes.

### 2.4 `GET /pallets?shiftId=`

Mirrors `GET /boxes?shiftId=`, same guard set, same tenant scoping:

```ts
{
  (id,
    sscc,
    terminalId,
    lineName,
    operatorId,
    boxCount,
    unitCount,
    closedAt,
    disassembledAt,
    contentsChangedAfterClose);
}
```

## 3. Station

### 3.1 Local schema

Appended to the runtime migration list in `packages/db/src/sqlite/migrations.ts`
(the authoritative list; `db:generate:sqlite` is a parity aid):

- `pallets_mirror` — a mirror of `boxes_mirror`, including `print_state` and
  `print_error_code`.
- `ALTER TABLE boxes_mirror ADD COLUMN pallet_id TEXT;` — an ALTER rather than
  a changed `CREATE TABLE`, because installed stations already have the table
  and `CREATE TABLE IF NOT EXISTS` would skip it. This is the established
  pattern here.
- `pallet_exceptions_mirror` — a mirror of `box_exceptions_mirror`: pure facts,
  never updated after insert, so a monotonic id ceiling is enough for ack
  tracking.

### 3.2 The close path

`close-box.ts`, after a box closes successfully, puts it on this terminal's
open pallet for this shift, opening one if there is none, and writes
`pallet_id` onto the box's mirror row in the same statement.

If the pallet now holds `palletBoxCapacity` boxes it closes: `burnSerial` with
extension digit 1, `buildSscc`, identity and closure written in one SQLite
statement, pallet label queued for print immediately after the box label.
`close-pallet.ts` returns the same shaped result `close-box.ts` does, including
`no-serials`, `empty` and `invalid-serial` — an exhausted pallet pool must
block closing a pallet, never scanning a unit.

An exhausted pallet pool, or a bundle that came back with `palletSscc: null`,
therefore leaves the pallet open and over capacity: boxes keep closing and keep
joining that same pallet rather than opening a second one, which would give a
device an unbounded number of open pallets nobody can number. The strip says
«13 / 12 коробов · нет серий для паллеты» in the attention colour, boxes and
scanning are unaffected, and the pallet closes as soon as a bundle brings a
block. This is the box rule one level up: exhaustion blocks closing, never
scanning.

Print state, the deferred queue and recovery are the box mechanism unchanged,
including the rule that an `unknown` attempt is never resent automatically and
that «Напечатать все» skips any SSCC whose last attempt is `unknown`.

### 3.3 UI

- A pallet strip under the box-fill grid: «Паллета 4 · 3 / 12 коробов»,
  present only when the shift has pallets.
- Pallet close is a full-screen state mirroring box close: «Паллета 4 закрыта»,
  the SSCC, the print block. It dismisses itself on a successful print.
- «Закрыть паллету досрочно» in the overflow menu, with a confirmation naming
  the box count.
- «Расформировать паллету» and «Перепечатать этикетку паллеты» join the
  exceptions section, selected by scanning the pallet label, each requiring a
  reason, each queued to `pallet_exceptions_mirror`.
- Shift close: before draining, if a pallet is open, a confirmation «На паллете
  7 из 12 коробов — закрыть?» and then a forced close with its label. The
  shift-close summary already counts pallets in its copy; now it has something
  to count.

## 4. Handheld

### 4.1 Local schema

A Room migration (`core/storage/Migrations.kt` — `packages/db` does not migrate
the Android database): a `PalletEntity` mirroring `BoxEntity` including
`printState`/`printReason`/`ackedAt`, a `palletId` column on `BoxEntity`, and a
`pallet_exceptions` table left unused until the exceptions slice. `SsccRangeEntity`
already carries `extensionDigit`.

### 4.2 The batch signature

`SyncEngine` folds the box id set and the label event id set into `batchId`
precisely so that a box closing while a batch awaits its answer cannot be
resent under an id the server has already applied and vanish silently.

Pallets must join that signature and get their own `SYNC_PENDING_PALLET_COUNT`
pin, or we reproduce that bug one level up. The pinned pallet set is read back
on retry rather than re-read fresh, exactly as the box set is.

### 4.3 Flow and UI

Same as the station: box closes → joins the pallet → pallet closes at capacity
→ serial burned from the ext-1 pool → label rendered and printed through the
existing `core/print`, with deferred and failed pallet labels riding the
existing label queue.

`hh/PalletStrip` under `hh/BoxFill`; a full-screen «Паллета закрыта» state;
«Закрыть паллету досрочно» in the overflow. The completion signal reuses the
box-complete signal and its short-short vibration — brief 10 §6 states that
pallet completion mirrors box completion.

RU and EN strings ship together, as always.

## 5. Cabinet

- **Pallet list.** In the shift panel beside the box list, from
  `GET /pallets?shiftId=`. The box list gains a «Паллета» column.
- **Templates.** The label library gains the third purpose with its filter and
  badge; the organisation profile gains «Этикетка паллеты по умолчанию» and
  per-category pallet defaults; the shift form gains a pallet template picker,
  shown only when pallets are enabled. The API keeps refusing to disable a
  template that a default points at — now including pallet defaults.
- **SSCC counters.** The organisation profile and the counterparty card gain a
  second «Паллеты (1)» row with the same seed control and the same refusal to
  seed below an already-issued serial.
- **Capacity.** The product card and the shift form read «Коробов на паллете».
- **Code search.** `BoxCard` gains «На паллете: SSCC»; a `PalletCard` shows the
  pallet, its shift, its terminal and a collapsed list of its boxes.

### 5.1 Disaggregation

`disaggregation_document_lines` gains a nullable `pallet_id` with a composite
FK and a CHECK that at most one of `box_id` / `pallet_id` is set. Validation
resolves a line's SSCC against boxes first, then pallets; the existing line
statuses (`ok`, `not_found`, `not_closed`, `shift_open`,
`already_disassembled`, `written_off`, `duplicate`) carry over unchanged.

Applying a pallet line sets `pallets.disassembled_at` and writes a
`pallet_exceptions` row with `kind = 'disassemble'` and the document id.

**The member boxes stay intact and keep their `pallet_id`.** Taking a pallet
apart means taking boxes off a stack, not opening them; the membership remains
the historical fact that this box stood on that pallet, mirroring `box_items`,
which are marked rather than deleted when a box is disassembled. An operator
who also wants the boxes opened adds them as their own lines of the same
document.

The document's snapshot columns (`product_id`, `code_count`) are filled for a
pallet line from the sum over its boxes, and the apply transaction re-derives
everything from live tables, as it already does.

## 6. Shift exports

`ShiftExportBoxMode` becomes `"flat" | "boxes" | "pallets"`. `ShiftExportSource`
gains:

```ts
{ mode: "pallets";
  pallets: readonly { sscc: string; boxes: readonly { sscc: string; codes: readonly string[] }[] }[];
  unpalletizedBoxes: readonly { sscc: string; codes: readonly string[] }[] }
```

Three **new** format ids; the existing five are untouched. The box-level TXT
and CSV formats are consumed by integrations for which the column layout is a
contract, and folding a pallet level into a GIS MT XML a tenant has already
selected would change the document under them. The new formats are offered in
the export dialog only for a shift that has pallets.

In the XML, order is load-bearing: every box `pack_content` with its `<cis>`
children first, then every pallet `pack_content` with its `<sscc>` children.
An aggregate cannot be nested before it exists, and parts are submitted in
part-number order. The XSD already allows this — `pack_content` takes a choice
of `cis` or `sscc` children
(`docs/contracts/inventory-documents/v1/source/aggregation.xsd`), so the schema
does not move, only the renderer.

Splitting by `maxLines` stays per box. A pallet block is `1 + N + 2` lines and
is never split, so no `PALLET_EXCEEDS_LINE_LIMIT` twin of
`BOX_EXCEEDS_LINE_LIMIT` is needed. Unpalletized boxes are emitted with the
other box blocks and appear in no pallet.

## Verification

Standard gates per area, per the root `AGENTS.md`: `@markiro/domain` and
`@markiro/db` built before consumers; `@markiro/api` against a live database;
station, admin and the rest on their own package gates; and from
`apps/handheld`, `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug`.

Tests that must exist, not merely pass:

- Cross-tenant denial on `GET /pallets` and on every pallet write path, and an
  exact audit assertion for pallet disassembly — actor, tenant, action, target,
  result, metadata — not a row count.
- A replayed batch carrying a pallet closure is a no-op; a pallet that closes
  while a batch awaits its answer is not lost (the handheld `batchId`
  signature).
- A box closure from an older station, without `devicePalletId`, behaves
  exactly as before.
- Two devices with overlapping pools collide on `pallets_tenant_sscc_uq` rather
  than writing two pallets with one number.
- A null-terminal device does not get a new pallet row per batch
  (`NULLS NOT DISTINCT`).
- A pallet label print left `unknown` is never resent automatically, and
  «Напечатать все» skips it.
- The capacity migration across all four cases: both values set, only box set,
  only pallet set, neither set.
- Export splitting by `maxLines`, and boxes ordered before pallets.
- One-day, leap-year and timezone cases for the pallet label's expiry date,
  since it is a label rule.

### What these do not prove

Physical printing of a pallet label on a real ZPL/TSPL printer; behaviour on an
actual handheld terminal with a vendor scanner service; and acceptance of the
two-level aggregation document by Chestny ZNAK. All three stay external and
will be reported as not run rather than implied.

## Risks and open points

- **The capacity migration rewrites user-entered values.** It is defensible
  because the field is inert today, but it is still a rewrite and belongs in
  the plan's migration review, with the four cases enumerated above.
- **`PALLET_BLOCK_SIZE = 200` assumes a pallet of at least ten boxes.** Below
  that a device offline for a very long shift could run its pallet pool dry
  before its box pool, landing in the over-capacity state above. That state is
  designed and safe, but if real tenants configure pallets of four or five
  boxes the number should go up.
- **Two-level GIS MT acceptance** is unverified against a live Chestny ZNAK
  submission. The XSD permits the structure; whether the participant's process
  wants pallets aggregated at all is a per-tenant question, which is part of
  why the pallet formats are new ids rather than a change to the existing one.
- **A pallet closed by force at shift close** burns a serial for a short
  pallet. That is the intended trade — the physical stack leaves with a label
  either way — but it means an operator who closes a shift by mistake costs a
  pallet serial. The confirmation names the box count for that reason.
