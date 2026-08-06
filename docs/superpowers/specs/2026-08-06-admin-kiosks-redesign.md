# Admin Kiosks Redesign

## Status

The direction and delivery scope were approved during the 2026-08-06 review. This written
specification is ready for final review before implementation planning.

## Context

The completed Dashboard, Catalog, Counterparties, Shifts, and Employees stages establish the
Markiro Admin interaction language: bounded pages, visible row actions, route-backed side panels,
persistent inline errors, semantic confirmations, RU/EN copy, and light/dark themes.

The Kiosks page still combines four distinct workflows in one long modal-heavy screen:

1. kiosk lifecycle and operational state;
2. kiosk profile settings;
3. the allowed-products list;
4. pickup write-off reasons shared by all kiosks.

Pairing is a fifth, security-sensitive workflow. The API returns an eight-digit plaintext pairing
code exactly once and stores only its hash. The current row action mints that code before showing a
centered modal, so simple activation performs a credential mutation. Create and edit use another
centered modal, product availability is appended to the profile form with a separate Save action,
and write-off reasons are always rendered below the kiosk table as a dense set of simultaneously
editable rows.

This specification completes the Kiosks half of staged-delivery item 4 in
`docs/superpowers/specs/2026-08-05-admin-interaction-redesign-design.md`. It follows the approved
device-commissioning direction in `docs/design-briefs/07-device-commissioning.md` while remaining
within the current kiosk-only API and DTOs. It does not invent a combined Stations and Kiosks API,
device quotas, revocation state, or server behavior that does not exist.

## Goals

1. Align Kiosks with the completed Admin page and side-panel language.
2. Separate kiosk management from global write-off-reason management using route-backed local
   navigation.
3. Move create, edit, and pairing into right-side panels while keeping the originating list
   mounted.
4. Make pairing an explicit two-step action and preserve the one-time plaintext lifecycle.
5. Separate Profile and Available products into understandable edit-panel resource sections.
6. Replace the dense all-rows-editable reasons editor with focused inline create and edit states.
7. Preserve exact existing API paths, payloads, query invalidation, capability checks, and lazy
   barcode loading.
8. Keep every load and mutation failure persistent and recoverable in its owning surface.
9. Preserve keyboard, focus, responsive, RU/EN, and light/dark contracts.

## Non-goals

- No backend, DTO, database, audit, tenant-scope, pairing-TTL, or credential-hash changes.
- No combined Stations and Kiosks device registry.
- No device quota, billing, revoke/unbind, restore-from-archive, or remote health-check workflow.
- No new server-side kiosk search or filter parameters.
- No bulk kiosk or reason actions, drag-and-drop reason sorting, or product creation from the panel.
- No persistence, logging, analytics, query cache, toast copy, or URL exposure of plaintext pairing
  codes.
- No removal of the shared legacy `Modal`; other Admin consumers still use it.
- No Integrations, Labels, Pickup, Team, Settings, Profile, Auth, Station, or Kiosk-app redesign.

## Chosen direction

Use route-backed local navigation plus context-appropriate interactions. Three alternatives were
reviewed:

- a persistent master-detail split, which is efficient for repeated edits but diverges from the
  established Admin interaction model and constrains smaller viewports;
- one long page with expandable sections, which minimizes routing but retains weak information
  hierarchy and mixes global reasons with per-kiosk settings;
- route-backed Kiosks and Write-off reasons views, side panels for multi-step kiosk work, inline
  editing for short reason records, and confirmation dialogs for destructive actions.

The third option was selected. Side panels are used where context, validation, or a multi-step
workflow benefits from retained list context. A one-field reason edit stays inline because a panel
would add navigation cost without adding clarity. The redesign deliberately does not replace every
dialog with a drawer: archive decisions remain `ConfirmDialog` overlays.

## Information architecture and routes

The sidebar keeps one Kiosks destination. Inside that destination, a feature-local navigation bar
contains:

1. Kiosks;
2. Write-off reasons.

The navigation uses links with current-page semantics, not client-only tabs that disappear from
browser history. It remains visible on both views and wraps or scrolls without clipping in long RU
and EN copy.

Use these routes:

- `/kiosks` - kiosk list;
- `/kiosks/new` - create panel above the kiosk list;
- `/kiosks/:kioskId/edit` - edit panel above the kiosk list;
- `/kiosks/:kioskId/pair` - pairing panel above the kiosk list;
- `/kiosks/reasons` - write-off-reasons view.

Static route ranking must ensure `reasons` is never interpreted as a kiosk ID. Opening a kiosk
panel from the list records background location. Browser Back closes the panel without losing the
status filter, list scroll, or current query data. Closing a directly entered panel URL replaces
the location with `/kiosks` instead of navigating outside Admin.

The two top-level views require `operations.read`. Create, edit, kiosk archive, and reason mutations
require `operations.write`. Pairing requires `credentials.manage`. A direct unauthorized child URL
renders the established forbidden page and must not mount its mutation hook.

## Shared page shell

Both views use the established `AdminPage` width and spacing. The page header keeps the translated
Kiosks title and places the feature-local navigation directly below the title region. Only the
active view contributes a primary action:

- Add kiosk on `/kiosks` for authorized users;
- Add reason on `/kiosks/reasons` for authorized users.

Read-only users see the same information architecture without mutation controls. Each view owns
its query, loading, error, retry, empty, and result-count states so a reasons failure cannot make the
kiosk list appear unavailable and vice versa.

## Kiosk list

`/kiosks` remains a table and adopts `AdminPage`, `FilterBar`, and `RowActions`.

### Derived operational state

Derive one visible state from fields already present in `KioskDto`:

1. Archived when `status === "archived"`.
2. Awaiting pairing when active and `enrolled === false`.
3. Online when active, enrolled, and `lastSeenAt` is within the existing two-minute threshold.
4. Offline when active and enrolled but no recent heartbeat exists.

The state chip always contains text; color is supplemental. The implementation must not label an
unenrolled kiosk Offline because that suggests a previously connected device has stopped
responding. Relative last-activity copy must have a stable absolute date-time equivalent available
to assistive technology or as supporting text.

### Filter and count

Add one local state filter with All, Awaiting pairing, Online, Offline, and Archived values. The
default is All. Filtering occurs over the already-fetched kiosk list because the current endpoint
has no filter contract; it must never alter the `GET /kiosks` request. The derived Online boundary
uses a single shared clock value per render so rows and counts cannot disagree.

Show the filtered result count after a successful query. Expose Reset only when the state differs
from All. Do not add client-only text search.

The view owns one low-frequency clock tick and derives every row state, filter result, and count
from the same timestamp. This lets a kiosk cross the two-minute Online boundary while the page is
open without creating one timer per row or allowing the table and count to disagree. The timer is
paused naturally when the view unmounts and must be cleaned up.

### Table

Use these columns:

- kiosk identity: name with location as supporting text on compact layouts;
- operational state;
- last activity, with a translated Never fallback;
- daily employee limit, using tabular figures;
- price visibility;
- actions.

At wide widths, location may remain a separate column when the established Table layout has room.
At narrower widths, secondary information may stack under identity rather than forcing horizontal
overflow. Edit is the first visible action. Pairing is visible only for active kiosks to credential
managers. Archive is visible only for active kiosks to operations writers. Use `RowActions` for
wrapping and consistent hit targets.

### Page states

- Loading uses a table-shaped state rather than a centered generic spinner.
- Load failure uses a persistent page Alert and Retry.
- Empty All explains how to add the first kiosk when write access exists and provides read-only
  guidance otherwise.
- Empty filtered state explains that no kiosks match the selected state and offers Reset rather
  than repeating Add kiosk.

## Create panel

`/kiosks/new` uses a standard-size `SidePanel`. It contains only the current profile fields:

- name;
- optional location;
- positive integer daily limit;
- Show prices.

Preserve the current Zod limits, default values, and exact normalization:

```ts
{
  name: values.name.trim(),
  location: values.location?.trim() || null,
  dayLimitPerEmployee: Number(values.dayLimitPerEmployee),
  showPrices: values.showPrices,
}
```

The footer contains Cancel and Create. A failed `POST /kiosks` keeps the panel open, preserves all
fields, and shows the server message in a persistent Alert. A success invalidates the established
kiosk query and shows the current success toast.

After creation:

- a user without `credentials.manage` closes to `/kiosks`;
- a credential manager transitions in the same panel shell to a success choice with Done and Set up
  pairing;
- Set up pairing replaces the current route with `/kiosks/:kioskId/pair`; it does not open a second
  panel or mint a code automatically.

Closing the post-create choice returns to `/kiosks` and restores focus to Add kiosk. The created
kiosk cannot be submitted twice.

## Edit panel

`/kiosks/:kioskId/edit` uses a complex-size `SidePanel`. The header identifies the kiosk by name and
shows its derived operational state. The body uses local section navigation and continuously
mounted sections:

1. Profile;
2. Available products, with a selected count or Loading/Error state.

On desktop, the navigation is a narrow rail beside one scrolling content region. On mobile, it
becomes a horizontally scrollable sticky section bar. Activating an item scrolls to a focusable
section heading without mounting or unmounting content.

### Route data states

The list query and Outlet context are the source for kiosk lookup. The route renders:

- a shape-matched complex-panel skeleton during initial list loading;
- a panel-level load failure with Retry and Close when the kiosk list has no usable data;
- a translated not-found state when `kioskId` is absent from a successful response;
- the edit content only after the kiosk exists.

An archived kiosk may still be opened for inspection and profile editing because the current UI
allows this. It receives no Pair or Archive action inside the edit panel.

### Profile section

Profile owns react-hook-form, validation, dirty state, and `PATCH /kiosks/:id`. Save profile is the
panel-footer primary action. Preserve the exact current payload normalization.

A failed update keeps all input and shows a persistent section Alert. A successful update closes
the panel after established invalidation and success toast behavior.

### Available products section

Mount `GET /products?status=active` only for an authorized edit panel, not for the kiosk list or
create panel. The section is independent from Profile:

- Pending shows a section-shaped skeleton and no save control.
- Error shows a persistent Alert with Retry and must not represent products as an empty list.
- Empty success explains that the catalog has no active products and links or points to Catalog; it
  does not offer product creation inside this panel.
- Success shows active products with name and GTIN, selected count, and checkboxes.

For a long catalog, provide a local name-or-GTIN filter over the already-loaded active products.
This filter is presentation state and must not issue a request on every keypress. Selected product
IDs remain selected when hidden by the local filter.

Save list calls the existing `PUT /kiosks/:id/products` body exactly:

```ts
{
  productIds;
}
```

Product changes have their own dirty state, Save list action, pending state, and persistent section
error. A success updates the kiosk query, resets only the product baseline, keeps the panel open,
and retains the current success toast. It must not submit or close the Profile form.

## Pairing panel and one-time secret lifecycle

`/kiosks/:kioskId/pair` uses a standard-size `SidePanel`. It is available only to
`credentials.manage` users and only for active kiosks.

### Safe entry state

Opening the route never calls `POST /kiosks/:id/pairing-code`. The initial state identifies the
kiosk and explains that issuing a new code invalidates any unredeemed code previously issued for
that kiosk. The primary action is Issue pairing code. This explicit step makes direct links, Back,
and accidental activation safe.

The panel uses the same list-backed loading, error, retry, and not-found rules as Edit. An archived
kiosk shows a persistent unavailable state and Close; it mounts no pairing mutation.

### Live reveal state

After a successful explicit issue, show:

- the numeric code grouped as four plus four digits;
- the same code as a lazily loaded Code 128 barcode;
- a wall-clock-derived `mm:ss` countdown using the server `expiresAt` value;
- Copy;
- Issue a new code;
- Done.

Keep the current reserved barcode placeholder so lazy loading does not shift the panel. Copy uses
the raw digits, while the visual grouping is presentation only. Copy failure remains a local
message. When the countdown reaches zero, remove the digits, barcode, and Copy action, then show an
expired state with Issue a new code.

The plaintext exists only in mounted feature-local component state. It must never enter:

- route params, query strings, route state, or browser history;
- TanStack Query cache or another shared cache;
- localStorage, sessionStorage, IndexedDB, or persisted form state;
- logs, analytics, error reports, accessible labels that outlive the reveal, or toast copy.

Closing, Back, successful Done, unmount, or page reload destroys the plaintext. Reopening or
directly loading the route returns to the safe entry state and requires a fresh explicit issue.

### Regeneration and ambiguous failure

Issuing a new code invalidates the previous server-side code. When regeneration starts, remove the
previous plaintext from the UI immediately. If the request fails or its outcome is ambiguous, keep
the panel open in a no-code error state and require another explicit issue. Never continue showing
the previous digits after a failed regeneration because the server may already have invalidated
them.

While issuance is pending, dismissal and duplicate submission are blocked. A failure is persistent
inside the panel; a toast may supplement it but cannot replace it. A success replaces the reveal
state rather than stacking histories of secrets.

## Write-off reasons view

`/kiosks/reasons` gives global pickup reasons their own focused table. It does not render or fetch
the kiosk list.

### Table and read-only state

Use Name, Order, and Actions columns. Sort rows by the server-provided order already returned by the
endpoint; do not add client reordering semantics beyond editing the numeric value. Read-only users
see the table without editable controls or mutation hooks.

Loading uses a table-shaped state. Load failure uses a persistent Alert and Retry. Empty success
explains how reasons appear in kiosk write-off flows; Add reason is shown only to authorized users.

### Inline create

Add reason reveals one inline creation row near the table header. It contains a labeled Name field,
Cancel, and Add. Keep creation to the current `{ name }` request so the server retains its default
ordering behavior.

A blank or whitespace-only name is rejected locally. A failed `POST /pickup-reasons` keeps the row
open, preserves the name, and shows the server message in that row. Success clears and closes only
the creation row, invalidates the reasons query, and retains the current toast.

### Inline edit

Only one existing row is editable at a time. Edit replaces that row's display cells with labeled
Name and numeric Order controls plus Cancel and Save. Preserve the current update semantics:

```ts
{
  name: draft.name.trim(),
  sortOrder,
}
```

The order value must be finite. A blank order must not become zero through `Number("")`; either
show a local validation error or retain the current server value, with the chosen behavior covered
by a focused test. The implementation-plan stage should prefer explicit validation because it gives
the operator a clear correction path.

Starting another edit while the current row is dirty asks for confirmation before discarding the
draft. Query refetches must not overwrite an active dirty row. A failed update preserves both
fields and shows a persistent row error. Success exits edit mode after invalidation and toast.

### Archive confirmation

The user-facing action remains Delete because archived reasons disappear from future kiosk choices,
while the implementation preserves the existing `DELETE /pickup-reasons/:id` endpoint. It opens a
list-owned `ConfirmDialog` naming the reason.

While deletion is pending, dismissal and duplicate submission are blocked. Failure keeps the
dialog open and shows the server message persistently. Success closes it, invalidates the reasons
query, and retains the current toast.

## Dirty, busy, and dismissal behavior

The create and edit panels use `useRoutePanelGuard` for close button, Cancel, Escape, backdrop, and
browser navigation.

Create is dirty when any field differs from its initial value. Edit aggregates:

- Profile form changes;
- Available-products selection changes.

The rules are:

- clean and idle closes immediately;
- dirty and idle opens the established discard `ConfirmDialog`;
- any owning mutation in flight blocks dismissal and duplicate submission;
- successful Profile save uses the guard finish path and closes;
- successful product save resets only the product dirty baseline and keeps the panel open.

The pairing panel has no ordinary form dirty state. A live plaintext reveal may close without a
discard confirmation because closure is the deliberate secret-destruction action. Pending issue or
regeneration still blocks dismissal.

Reason create and edit drafts use an inline discard confirmation only when navigation or a competing
edit would destroy non-empty changes. A browser leave warning is not added for the short inline
reason form.

## Archive kiosk confirmation

Kiosk archive remains a list-owned `ConfirmDialog`, not a side panel. It names the kiosk and
describes that the device will no longer be available for active kiosk operation. Cancel receives
initial focus because the action is destructive.

While `DELETE /kiosks/:id` is pending, dismissal and repeat submission are blocked. Failure keeps
the dialog open and shows the server message persistently. Success closes the dialog, invalidates
the kiosk query, keeps the selected state filter, and retains the current success toast.

## Component boundaries

Use feature-local components because kiosk profile, pairing, products, and global reasons have
different security and failure contracts:

- `KiosksLayout`: shared header and route-backed local navigation.
- `KiosksPage`: kiosk list query, derived state filter, result count, row actions, archive
  confirmation, and Outlet context.
- `KioskPanelRoute`: route lookup, direct-entry fallback, create/update controller, dirty/busy
  guard, and panel-level states.
- `KioskProfileForm`: fields, validation, exact payload normalization, and dirty reporting.
- `KioskProductsSection`: active-products query, local filter, selection baseline, save mutation,
  and section errors.
- `KioskPairingPanelRoute`: safe entry, explicit issue, one-time reveal, expiry, regeneration, and
  secret destruction.
- `PairingBarcode`: unchanged lazy barcode boundary.
- `ReasonsPage`: list states, inline create/edit, archive confirmation, and mutation errors.
- `kiosks.css`: page, local navigation, list, panels, pairing reveal, reasons rows, skeletons, and
  responsive behavior.

Reuse `AdminPage`, `FilterBar`, `RowActions`, `SidePanel`, `ConfirmDialog`, and
`useRoutePanelGuard`. Do not add a generic Tabs, secret-state, or editable-table abstraction for a
single feature. Shared primitives may be refined only when an actual Kiosks requirement exposes a
missing contract and the refinement includes focused shared tests.

## Visual and responsive behavior

Use the existing IBM Plex Sans and Mono typography and current design tokens. Do not introduce a
new palette, shadow system, radius scale, or font.

- The page keeps the established bounded 1440 px Admin width and responsive padding.
- The local navigation reads as a quiet secondary level, not another global sidebar.
- The desktop edit panel uses the existing complex width token with a narrow section rail.
- Create and pairing use the standard width; below 768 px all panels use existing full-screen
  `100dvh` behavior.
- Form grids and table identity details collapse before controls become cramped.
- The pairing code uses Mono, tabular figures, generous spacing, and strong contrast without a
  decorative card stack.
- Inline reason rows align display and edit states so activation causes minimal layout shift.
- Sticky footer actions wrap without horizontal overflow and remain above safe-area insets.
- Supporting copy uses a readable measure. Status and errors never rely on color alone.
- Motion continues to use the existing SidePanel contract and reduced-motion behavior.

## Accessibility

- Preserve `SidePanel` dialog semantics, inert background, scroll lock, focus trap, topmost Escape,
  and exact focus restoration.
- Local view navigation uses links with current-page indication; edit-panel section navigation uses
  real buttons or links with translated accessible names.
- Section destinations are focusable headings without disrupting reading order.
- Form and inline-edit inputs retain programmatic labels, error association, and visible focus.
- Table actions remain reachable and identifiable without relying on row hover.
- Pairing digits are readable as one eight-digit code to assistive technology even when visually
  grouped. The barcode has a concise label and is not the only representation of the code.
- Countdown updates must not announce every second. Expiry and mutation errors use a polite live
  status once.
- Confirmation dialogs identify the exact kiosk or reason affected and use explicit action labels.

## Internationalization

Add matching RU and EN keys for:

- local Kiosks and Write-off reasons navigation;
- result counts, state filter, Reset, last activity, Never, and filtered-empty states;
- Awaiting pairing, Online, Offline, and Archived copy;
- panel loading, retry, not-found, unavailable, discard, and section navigation;
- Profile and Available products section titles, selected counts, local filter, and states;
- safe pairing entry, issue, reveal, expiry, regeneration failure, and one-time-code guidance;
- reason inline create/edit validation, discard, errors, and confirmations.

Do not concatenate translated fragments for status or time sentences. Long RU and EN labels must
wrap without clipping navigation, rows, panels, or footers.

## Verification strategy

### Focused automated tests

- Local view links navigate between `/kiosks` and `/kiosks/reasons` with correct current-page
  semantics.
- Derived state covers archived, awaiting pairing, online threshold, offline, and Never activity.
- The local state filter never changes the exact `GET /kiosks` request.
- Read-only rendering mounts no kiosk or reason mutation hooks; credential-only actions remain
  independently capability-gated.
- Nested create/edit/pair routes support list-origin open, Back close, direct-entry close fallback,
  not-found, load failure, and Retry.
- Dirty close paths cover close button, Escape, backdrop, and Back; pending mutations block each
  path.
- Create and update retain exact payloads and preserve input on server error.
- Create-to-pair transition never mints a code automatically and does not stack panels.
- Product availability covers pending, load error with Retry, empty success, local filtering,
  selection retention, exact PUT body, independent dirty state, and persistent save failure.
- Pair route entry performs no POST until explicit activation.
- Pair reveal covers grouped presentation, raw-digit copy, lazy barcode placeholder, countdown,
  expiry removal, regenerate success, regenerate ambiguous failure, unmount destruction, and reload
  returning to the no-code state.
- Pairing plaintext is absent from query cache, route state, persisted storage, and toast arguments
  in the tested flows.
- Kiosk archive confirmation covers success, pending dismissal blocking, and failure retention.
- Reasons cover independent load states, read-only mode, inline create/edit, blank validation,
  refetch protection for dirty drafts, exact payloads, discard confirmation, and persistent errors.
- Reason deletion confirmation covers success, pending dismissal blocking, and failure retention.

### Package and repository gates

Build workspace dependencies in a fresh worktree, run focused tests during each TDD task, then:

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/db build
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
pnpm format:check
git diff --check origin/main...HEAD
```

Audit the changed Kiosks feature for remaining `Modal` use. The expected result is no Kiosks
`Modal` imports or call sites; repository-wide legacy `Modal` removal remains a later stage.

### Manual and external validation

With an authenticated Admin API, verify light and dark themes at 1440, 1024, 768, and one viewport
below 768 px. Exercise both local views, every state filter, create, edit, products, direct URLs,
not-found, query failure/retry, pairing issue/expiry/regeneration/close/reload, reason inline editing,
all mutation failures, confirmations, Back, Escape, backdrop, keyboard traversal, long RU/EN copy,
reduced motion, and list filter/scroll preservation.

Use a real kiosk only for separate end-to-end confirmation that a displayed code can be redeemed,
regeneration invalidates the previous code, and an expired code is rejected. Automated DOM tests do
not prove real device redemption, screen-reader output, mobile virtual-keyboard behavior, or visual
quality. Report any unperformed external checks explicitly.

## Delivery boundary

This specification produces one independently reviewable Kiosks pull request containing both the
Kiosks and Write-off reasons views. It may refine an existing shared primitive only when this
implementation exposes a concrete missing contract and the refinement includes shared tests. It
must not include Integrations or later Admin waves.

The implementation must preserve the current API surface and one-time secret guarantee. Any need
for combined device management, quota enforcement, unbinding, remote health, or server-filtered
lists becomes a separately specified backend and product change rather than scope creep in this PR.
