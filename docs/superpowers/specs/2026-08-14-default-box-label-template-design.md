# Default box-label template — Design Spec

**Date:** 2026-08-14

**Status:** Approved

**Scope:** Organisation-level box-label default, per-shift override, removal of
unused item-label bindings, and recovery of aggregation shifts created by a
station without a box template

**Related:**

- `docs/superpowers/specs/2026-07-29-aggregation-boxes-design.md`
- `docs/superpowers/specs/2026-08-13-station-aggregation-floor-recovery-design.md`
- `docs/hardware-acceptance-checklist.md`

## Decision record

Markiro does not print a unit-level product label in this workflow. The
existing `products.default_label_template_id` and `shifts.label_template_id`
therefore describe a product capability that the station does not use. They
must not be treated as a fallback for box printing: a template intended for a
unit may contain GTIN or DataMatrix content instead of the box SSCC.

Box printing has one explicit inheritance chain:

1. a box-label template selected for the shift;
2. otherwise the organisation's default box-label template.

The resolved template is copied onto the shift when the shift is created. It
is a snapshot, not a live reference to the organisation setting. Changing the
default affects future shifts only. An administrator may select a different
box template for a specific planned shift. A station operator never chooses a
template on the factory floor.

An aggregation shift cannot be created or changed into aggregation mode
without an effective box-label template. A validation-only shift does not
require one.

## Problem

`NewShift` currently posts only `productId` and `mode`. `ShiftsService` writes
`boxLabelTemplateId: null` because no product or organisation default exists.
The shift opens and aggregation continues, but box closing reaches durable
print recovery with `Для смены не выбран шаблон этикетки короба`. Retrying
cannot help because every refreshed bundle still contains no template.

The cabinet currently makes the model more confusing:

- the product form offers `Шаблон этикетки по умолчанию`, although the station
  does not print unit labels;
- the shift form offers both `Шаблон этикетки` and `Шаблон этикетки короба`;
- the organisation has no box-label default even when all lines use one
  standard box layout.

The result is a shift that is operationally valid until the first box closes,
when the missing configuration can no longer be repaired from the station.

## Data model

### Organisation default

`org_profiles` gains nullable `default_box_label_template_id`. A tenant-scoped
foreign key targets `label_templates(tenant_id, id)`, so a profile cannot
select another tenant's template.

`GET /org/profile` and `PUT /org/profile` expose the field as
`defaultBoxLabelTemplateId: string | null`. Omission on update preserves the
current value; explicit `null` clears it. Clearing is allowed, but subsequent
aggregation-shift creation fails until a default or explicit shift override is
available.

Deleting a label template referenced by `org_profiles` returns the same
conflict class used for templates referenced by shifts. The response is
actionable and does not expose tenant identifiers.

### Shift snapshot

`shifts.box_label_template_id` remains the authoritative box-template binding.
At create time:

- an explicit UUID in `boxLabelTemplateId` wins;
- an omitted value resolves from `org_profiles.default_box_label_template_id`;
- explicit `null` means no template before mode validation;
- after resolution, aggregation mode requires a non-null value;
- validation mode may retain null.

Updates apply the same invariant to the merged planned-shift state. Existing
rules that prevent changing an active shift remain unchanged. Opening a shift
does not re-resolve the organisation default and cannot silently change the
template snapshot.

### Retired item-label bindings

The product and shift cabinet/API contracts stop accepting or returning the
unit-label fields:

- `products.defaultLabelTemplateId`;
- `shifts.labelTemplateId` and its joined name/spec.

The corresponding Postgres and station SQLite columns are not dropped or
rewritten in the first release. They remain deprecated compatibility storage
through the beta update horizon, while new application code stops reading or
writing them. The station bundle retains its legacy properties as explicit
`null` values so an older installed station does not fail while mirroring a
newer API response. A later cleanup migration may remove the columns only
after the supported updater horizon closes.

The box fields and `boxLabelTemplate` bundle object remain distinct and become
the only print-template source used by `WorkScreen`.

## Migration and existing data

The migration is tenant-scoped and deterministic:

1. Add `org_profiles.default_box_label_template_id` and its tenant-safe foreign
   key.
2. For an organisation with exactly one label template, create the profile row
   if necessary and assign that template as its default. Existing GLN, INN,
   GS1-prefix, and timestamp data is preserved.
3. For that organisation, backfill only planned or active aggregation shifts
   whose `box_label_template_id` is null. Closed shifts and shifts with an
   explicit box template are not changed.
4. For organisations with zero or multiple templates, leave the default and
   affected shifts unchanged. The cabinet requires an explicit administrator
   decision; the migration never guesses among multiple templates.
5. Do not copy product-level unit-template bindings into box-template fields.

The migration is idempotent in effect and never changes a shift that already
has a box template. Schema and migration tests cover tenants independently so
one tenant's sole template cannot be assigned to another tenant.

For the currently affected active shift, the one-template backfill supplies
the missing snapshot. `Повторить восстановление` reruns the established local
migrations and shift-bundle hydration, downloads the box template spec, and
returns to the same unresolved box and SSCC. Recovery does not allocate a new
box or SSCC. If the station is offline, the screen remains blocked with an
honest connectivity error until it can refresh the bundle.

## API behaviour

### Shift creation and update

`ShiftsService` resolves the default inside the same tenant boundary before
inserting or updating the shift. The selected UUID is still protected by the
existing composite shift/template foreign key.

Missing configuration for aggregation returns HTTP 422 with a stable machine
code, `BOX_LABEL_TEMPLATE_REQUIRED`, plus a sanitized human message. The
machine code is the station and cabinet localization boundary; clients do not
match English server prose.

Cross-tenant explicit template IDs continue to fail as a bounded 400-class
business error. Database constraint names and tenant IDs are not returned.

### Bundle

`GET /shifts/:id/bundle` resolves only `shift.boxLabelTemplateId` into
`boxLabelTemplate`. It never consults the current organisation default and
never reads the retired item-label binding. This preserves deterministic
offline printing after the bundle is mirrored.

## Cabinet UX

### Organisation settings

The organisation settings page adds `Шаблон этикетки короба по умолчанию` /
`Default box label template`. Options come from the tenant's existing label
template library. The control includes a link to create or edit templates and
represents an unset value explicitly.

Saving uses the established dirty-form and error patterns. A stale or deleted
selection produces an actionable reload message rather than silently clearing
the field.

### Product form

The `Шаблон этикетки по умолчанию` control is removed from create and edit.
Product DTOs, form schemas, payload builders, tests, and copy no longer imply
that Markiro prints a unit-level product label.

### Shift form

The templates section contains only `Шаблон этикетки короба`. For a new shift,
the untouched state is displayed as
`Использовать настройку организации — <template name>`. Selecting another
template writes an explicit override. Clearing the override returns to
inheritance rather than writing an accidental null.

When no organisation default exists, the inherited option says
`Не настроен`. Aggregation mode shows an inline error and cannot submit until
an explicit template is selected. Validation mode may submit without one.

Editing a planned shift shows its snapshotted template. Returning the control
to the organisation default writes the current default UUID into the shift;
it does not create a live link that changes later.

## Station UX

`NewShift` keeps the floor flow short: scan product, choose validation or
aggregation, start. No template library or selector is exposed to the station
credential.

If the API returns `BOX_LABEL_TEMPLATE_REQUIRED`, the station remains on the
found-product screen and shows localized guidance:

> В админке не настроен шаблон этикетки короба. Настройте его и повторите.

The primary start action becomes available again after the failed request so
the operator can retry once an administrator changes the setting. No planned
shift is left behind by this failure.

`StationApiError` carries an optional sanitized API code in addition to HTTP
status and message. Parsing is bounded to documented scalar fields; response
bodies, credentials, label specs, and raw scanner values are never logged.

The persistent print-recovery screen remains the safety net for printer,
rendering, transport, and legacy data failures. A missing template should no
longer be reachable for newly created aggregation shifts.

## Failure, compatibility, and security

- Organisation-default reads and writes remain cabinet-only and permission
  protected.
- Station credentials do not gain access to the label-template library.
- Every default and override lookup is tenant-scoped and backed by a composite
  foreign key.
- A template change never mutates active or closed shifts.
- A missing or deleted default fails before aggregation shift creation; there
  is no fallback to the first template at runtime.
- Rolling deployment keeps legacy bundle properties present as null and keeps
  obsolete columns intact until the update horizon closes.
- Offline stations continue printing from the mirrored shift snapshot; they do
  not need the organisation settings endpoint.
- Recovery of a backfilled active shift preserves the local box, SSCC, print
  state, scan journal, and outbox.

## Testing and acceptance

### Database

- migration assigns the sole tenant template as the organisation default;
- zero and multiple templates remain unset;
- tenant boundaries cannot cross during backfill;
- planned and active aggregation shifts with null bindings are backfilled;
- explicit bindings, validation shifts, and closed shifts remain unchanged;
- repeated migration execution has no additional effect;
- schema snapshots and migration/runtime-migration tests include the new FK.

### API

- explicit shift override wins over the organisation default;
- omitted override snapshots the default;
- explicit null and absent default reject aggregation with
  `BOX_LABEL_TEMPLATE_REQUIRED` and no inserted shift;
- validation mode remains valid without a template;
- update-to-aggregation applies the same invariant;
- cross-tenant defaults and overrides are denied;
- referenced defaults prevent template deletion;
- bundle uses only the shift snapshot and returns legacy item fields as null.

### Admin

- organisation default loads, saves, clears, and reports stale selections;
- product create/edit no longer renders or submits an item-label field;
- shift create displays inheritance, supports an explicit override, and blocks
  aggregation when neither source exists;
- planned-shift edit preserves the snapshot and can adopt the current default;
- RU and EN copy is covered.

### Station

- station-created aggregation shift sends no template choice and receives the
  server snapshot;
- missing configuration renders localized guidance and does not call open;
- retry is available after configuration is corrected;
- validation shift remains creatable without a template;
- active-shift recovery refreshes the bundle and preserves the same box/SSCC;
- restart and offline recovery remain durable.

Standard DB, API, Admin, Station, UI, Rust, release-contract, production-bundle,
format, and diff gates run before release. Automated tests do not establish
Windows, Tauri updater, physical printer, or scanner acceptance. The packaged
Windows beta checklist must verify both a newly created station shift and the
backfilled recovery case with a real printer before this change is considered
production-ready.

## Non-goals

- choosing templates on the station;
- classifying the entire template library into unit, box, and pallet types;
- changing label rendering, GS1-128 encoding, printer transport, or SSCC
  allocation;
- changing templates on active or closed shifts;
- dropping deprecated columns during the same release;
- inventing a runtime fallback that silently selects the first template.
