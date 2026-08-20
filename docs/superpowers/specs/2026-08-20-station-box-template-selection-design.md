# Station box-template selection at shift creation — Design Spec

**Date:** 2026-08-20

**Status:** Approved for implementation

**Scope:** A template-selection step in the station `NewShift` flow for
aggregation shifts, plus the minimal station-readable API surface it needs.

**Related:**

- `docs/superpowers/specs/2026-08-14-default-box-label-template-design.md`
- `docs/device-key-surface.md`

## Decision record

The 2026-08-14 design deliberately kept template choice off the factory floor:
the station sent no template and the server snapshotted the organisation
default. Product direction now adds an explicit step to the station flow: when
an operator creates an aggregation shift, the station shows the tenant's
box-label templates, preselects the organisation default, and lets the
operator pick a different one before the shift is created.

Unchanged invariants from the 2026-08-14 design:

- the resolved template is still snapshotted onto the shift at creation; the
  station simply supplies the explicit `boxLabelTemplateId` it displayed and
  the operator confirmed;
- an aggregation shift still cannot be created without a template;
- a validation shift prints nothing, so the flow for `Проверка` is unchanged —
  no template step, no template field in the payload;
- label template _specs_ remain closed to station credentials. The station
  learns only summaries (id, name, size, dpi, language); the full spec still
  arrives exclusively through the shift bundle after creation.

## API

New route in `ShiftsController`, declared before the `:id` param route:

```
GET /shifts/box-label-templates
@AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
```

Response:

```ts
interface ShiftBoxLabelTemplatesDto {
  items: Array<{
    id: string;
    name: string;
    widthMm: number;
    heightMm: number;
    dpi: 203 | 300;
    language: "zpl" | "tspl";
  }>;
  defaultBoxLabelTemplateId: string | null;
}
```

- Tenant-scoped listing of `label_templates`; the organisation default (from
  `org_profiles.default_box_label_template_id`) is returned first, remaining
  templates follow ordered by name. Deterministic and paginated client-side.
- No `spec`, no timestamps, no tenant identifiers.
- `GET /shifts/planning-config` is not touched: it remains the cabinet-only
  operations-read boundary with its exact one-field body.
- `POST /shifts` already accepts `boxLabelTemplateId`; no change.
- `docs/device-key-surface.md` and the subscription route inventory gain the
  new route; the "five station routes" wording becomes six.

## Station UX

`NewShift` gains a fourth view, `"template"`:

1. `input` — scan or type GTIN (unchanged).
2. `found` — product card plus the `Проверка` / `Агрегация` toggle
   (unchanged). Pressing `Начать`:
   - validation → create + open immediately, payload unchanged;
   - aggregation → fetch `GET /shifts/box-label-templates` (busy state on the
     button), then show the `template` view. A fetch failure keeps the
     operator on `found` with a localized error and a retriable button.
3. `template` — a paged list (4 per page, `Pager`) of template option buttons:
   template name, `58×40 мм · 203 dpi` meta line, and a `По умолчанию` badge
   on the organisation default. The default is preselected when it exists;
   otherwise nothing is selected and `Начать` stays disabled until the
   operator picks one. Footer: `Начать` (primary, creates + opens the shift
   with the explicit selected id) and `Назад` (returns to `found`, keeping
   product and mode).

The list is refetched on every `found → template` transition, so a template
added or set as default in the cabinet is visible on the next attempt without
restarting the flow.

Empty library: the `template` view shows localized guidance to create a
template in the cabinet; `Начать` is disabled. The existing
`BOX_LABEL_TEMPLATE_REQUIRED` handling stays as the server-side safety net.

New `shifts.*` i18n keys are added to both `ru.json` and `en.json` (parity is
already gated by `apps/station/test/i18n.test.tsx`).

## Failure and security

- The new route is read-only, tenant-scoped, and station-or-cabinet guarded;
  device keys still cannot reach `/label-templates` or template specs.
- A template deleted between listing and creation fails shift creation with
  the existing bounded business error; the operator retries from the list.
- Offline behavior is unchanged: `NewShift` already requires connectivity for
  product resolution and shift creation; the extra GET adds no new offline
  mode.

## Testing

- API e2e: station api-key reads the route (200, default-first ordering, no
  `spec` in the body); cabinet operations-read session also allowed;
  unauthenticated 401; route added to the subscription inventory.
- Station `new-shift.test.tsx`: aggregation start fetches templates and shows
  the picker with the default preselected; switching the selection posts the
  chosen id; keeping the default posts the default id; validation start posts
  no template field and skips the step; empty library disables start; fetch
  failure keeps the found view with an error.

## Non-goals

- template preview/thumbnail rendering on the station;
- changing the template of an existing or active shift from the station;
- exposing template specs, editing, or the `/label-templates` module to
  device keys;
- pallet label templates.
