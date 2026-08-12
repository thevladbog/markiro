# Admin Select and Production Lines Redesign

## Status

The direction and scope were approved on 2026-08-12. This written specification is ready for
final review before implementation planning.

## Context

The main tenant Admin mixes the shared custom `@markiro/ui` select with explicitly native browser
selects on the device list and device drawer. This makes visually related controls behave and look
different, especially when the operating system opens a native popup.

The device drawer asks an installer to assign a station to a production line, but the Admin has no
screen for creating or managing lines. The API already supports tenant-scoped list, create, rename,
and delete operations, and subscription policy already limits line creation. The missing cabinet
surface makes the term and the setup sequence unclear.

Two adjacent defects reinforce the unfinished feel: the Conflicts filters do not share a stable
vertical grid because only one filter has a long hint, and the pairing barcode is a transparent SVG
whose black bars lose contrast on a dark panel. The print-only document already gives the barcode a
white background, but the on-screen reveal does not.

This change applies only to `apps/admin` and the shared Select presentation needed by that cabinet.
It does not replace native selects in `apps/station`, `apps/kiosk`, or `apps/saas-admin`, and it does
not change station hardware behavior.

## Goals

1. Use the shared custom dropdown for every select rendered by the main Admin.
2. Make dropdown menus visually consistent, keyboard accessible, and usable with long option lists.
3. Add an understandable, complete production-line management surface.
4. Explain what a production line means at the point where a station is assigned.
5. Align the Conflicts filters in light and dark themes at ordinary desktop widths.
6. Give every on-screen pairing barcode a permanent high-contrast scan surface.
7. Preserve tenant authorization, subscription limits, localization, and existing device behavior.

## Non-goals

- No changes to `apps/saas-admin`, `apps/station`, or `apps/kiosk` selects.
- No removal of the shared Select's `native` compatibility mode.
- No API, database schema, migration, or line-identity changes.
- No inline line creation inside the device drawer in the first delivery.
- No station-to-line authorization boundary; line assignment remains operational metadata and the
  station's default production context.
- No redesign of unrelated Admin pages, typography, navigation, or tables.
- No claim of physical scanner acceptance from browser or component tests.

## Chosen direction

Add a dedicated `Production -> Lines` page and point station setup to it. This was selected over
inline-only creation because lines also need renaming and safe deletion, and over placement in
organization settings because lines belong to day-to-day production planning.

Keep `@markiro/ui` as the one visual Select implementation. Remove `native` only from Admin call
sites. Preserve the compatibility path for non-Admin consumers.

## Shared Select behavior

All `apps/admin` call sites render the Radix-backed Select. The current device list filters and the
device drawer's device-type and line fields must stop opting into native rendering.

The dropdown must:

- match at least the trigger width while still fitting inside the viewport;
- use the existing surface, border, radius, type, focus, and accent tokens in both themes;
- cap its viewport height and scroll internally for long lists;
- retain selected, highlighted, disabled, focus-visible, Escape, and arrow-key behavior;
- position with collision avoidance and a small trigger offset;
- keep the empty-string option mapping already used by filters and optional fields;
- work inside existing modal, drawer, and overlay portal containers without escaping their z-index
  and dismissal boundaries.

No new component library or parallel select implementation is introduced.

## Production Lines page

Add `/lines` under the Production navigation section, guarded by `OPERATIONS_READ`. The page title
is `Production lines`. Introductory copy explains that a line is a named production area used to
group shifts and to give a stationary terminal its default workplace.

The read state contains a compact table with line name and creation date. Users with
`OPERATIONS_WRITE` can create, rename, and delete; read-only users see the same reference data
without mutation controls.

Create and rename use a focused route-backed side panel consistent with existing Admin entity
editing. The only field is a required trimmed name of at most 200 characters. Submit is disabled
for an empty value, duplicate submissions are blocked while pending, server errors remain visible,
and success invalidates the shared lines query before closing the panel.

Delete uses the existing confirmation dialog and identifies the line by name. A successful delete
removes it from the shared query cache. A `409` response is translated into a direct explanation
that the line is used by one or more shifts and cannot be deleted; the dialog stays open so the
user does not mistake the failure for success. Other server failures use the established request
error handling.

The empty state explains why lines are useful and offers `Create line` only to authorized users.
Loading, retryable error, empty, populated, pending mutation, success, and mutation-error states are
all explicit. API tenant scoping and subscription quota enforcement remain authoritative.

## Device assignment guidance

The station line field remains optional and preserves the `No line` value. Its hint explains that
the selected production line becomes the station's default workplace and groups its shifts.

The field also exposes an `Manage lines` link to `/lines`. When no lines exist, the hint directly
says that lines are created in `Production -> Lines`; authorized users receive the same link as the
recovery action. The first delivery does not open a nested line editor from the device drawer,
avoiding conflicting overlay and unsaved-form states.

The device list's type and status filters, the device type field, and the station line field all use
the custom Select. Existing values, URL filter semantics, permissions, create/reassign requests,
and optional line assignment remain unchanged.

## Conflicts filter layout

Replace the bottom-aligned flex row with a responsive filter region. At desktop widths, the two
labels and controls share a two-column CSS Grid and align on the same rows. The explanatory shift
copy sits beneath its control and does not change the vertical position of the Status control.

At narrow widths the filters stack in document order and fill the available width. The controls
use sensible maximum widths on desktop but no hard width that creates horizontal overflow. Existing
filter values and query semantics do not change.

## Pairing barcode contrast

The reusable on-screen barcode box owns an opaque white background, dark barcode foreground,
internal quiet-zone padding, and a subtle neutral boundary that remains visible on light surfaces.
The barcode is treated as a scanning artifact, not as theme-colored decoration, so it stays black
on white in both themes.

The loading placeholder reserves the same dimensions and background to avoid layout shift. Print
output keeps its existing monochrome treatment and exact encoded value. Both station-device and
kiosk pairing components that consume the shared Admin barcode box receive the contrast fix, but
no kiosk application code is changed.

## Localization and accessibility

Add matching Russian and English copy for navigation, descriptions, actions, empty states,
validation, success, and error messages. Visible wording uses `production line` / `производственная
линия` when explanation is needed and the shorter `Line` / `Линия` in established field labels.

Every panel has a labelled heading, every form control keeps its programmatic label and associated
hint or error, and all actions are semantic buttons or links. Dropdown focus remains visible and
all select and line-management flows must be operable by keyboard.

## Data and error flow

Extend the existing Admin lines mini-client rather than adding another cache key. It gains create,
update, and delete mutations over the existing endpoints:

- `GET /lines`
- `POST /lines { name }`
- `PATCH /lines/:id { name }`
- `DELETE /lines/:id`

Mutations invalidate the shared `LINES_QUERY_KEY`, so the Lines page, shift forms, dashboard, and
device drawer converge on the same server state. Client code sends no tenant identifier; the
authenticated API boundary remains responsible for tenant selection and capability checks.

## Testing and acceptance

Use test-first regression coverage for each behavior:

1. Admin device filters and drawer fields expose custom comboboxes without native `select`
   elements and preserve their current value changes and requests.
2. Shared Select menu sizing, scrolling hooks, portal containment, empty option mapping, disabled
   options, and keyboard behavior remain intact.
3. Lines routing and navigation honor read/write capabilities.
4. Lines loading, error, empty, create, rename, delete, quota/server failure, and referenced-line
   `409` states produce the specified UI and requests.
5. The device drawer explains line meaning and links to `/lines`, including the no-lines state.
6. Conflicts filters render in the dedicated aligned layout without changing query filters.
7. The pairing barcode and lazy placeholder both use the opaque scan-surface class/style in dark
   and light theme-independent markup.
8. RU and EN keys exist for every added user-visible string.

Final automated gates are focused UI/Admin tests during iteration, then `@markiro/ui` and
`@markiro/admin` tests, typecheck, lint, and build, plus formatting and `git diff --check`.
Rendered browser checks should cover the Lines page, device drawer, select menus, Conflicts filters,
and pairing reveal in light and dark themes at representative desktop and narrow widths. Physical
scanner readability remains a separate manual check and must be reported as unverified unless a
real scanner is used.

## Acceptance criteria

- No `apps/admin` production call site opts into native Select rendering or declares its own native
  `<select>`.
- Admin dropdowns have a styled, bounded menu with consistent keyboard and overlay behavior.
- A user can discover what a line is and create, rename, or safely delete it from the Admin.
- Station creation and reassignment link directly to line management and remain usable with no
  lines configured.
- Conflicts filter controls align at desktop widths and stack without overflow at narrow widths.
- Pairing barcodes remain black on opaque white in both themes without changing their encoded data.
- Read-only permissions, subscription quota failures, referenced-line deletion, localization, and
  existing device/shift behaviors remain intact.
