# Admin interaction and page redesign

## Status

The design direction was approved during the 2026-08-05 review. This written specification is
ready for final user review before implementation planning.

## Context

The redesigned dashboard establishes the intended Markiro admin language: bounded content,
operational density, monochrome surfaces, IBM Plex Sans and Mono, semantic status colors, RU/EN,
and light/dark themes. The remaining admin pages still use a single `Modal` component for several
different interaction types.

At `origin/main` commit `0199b09`, `apps/admin` has 24 `Modal` call sites. They cover long CRUD
forms, one-field row actions, temporary credentials, status transitions, deletion confirmations,
and unsaved-change guards. Treating all of them as centered dialogs obscures the difference between
working with data and making a critical decision.

This specification defines a semantic interaction model for the remaining pages and a staged page
redesign. It does not authorize a simultaneous rewrite of the entire admin application.

## Goals

1. Keep list and entity context visible while users create or edit records.
2. Reserve centered dialogs for short, consequential decisions.
3. Use inline disclosure for operations that need only one small input.
4. Preserve dedicated routes for self-contained workspaces such as the label editor.
5. Standardize page spacing, filter bars, row actions, loading, empty, error, and responsive states.
6. Preserve existing API payloads, tenant scope, capability checks, query invalidation, and audit
   behavior.
7. Make panel state navigable with browser history and direct URLs.

## Non-goals

- No backend endpoint or DTO changes.
- No framework, router, form library, query library, font, or icon-library migration.
- No invented dashboard metrics or production data.
- No floor-mode change for the station or kiosk applications.
- No replacement of the label editor's full-page canvas with a side panel.
- No visual rewrite of the completed dashboard.
- No requirement to migrate all pages in one pull request.

## Chosen interaction model

Use a semantic hybrid:

- **SidePanel:** data entry, inspection, and contextual workflows.
- **Inline disclosure:** a single short operation owned by one table row.
- **ConfirmDialog:** irreversible, security-sensitive, or state-ending decisions with no form.
- **Dedicated page:** multi-pane or independently navigable workspaces.

The container follows the task. A destructive button does not automatically require a centered
dialog if the user must first complete a larger workflow; conversely, a two-sentence confirmation
does not become a side panel merely for consistency.

## SidePanel

### Structure

`SidePanel` is a new `@markiro/ui` primitive. It renders through a portal into `document.body` and
contains three regions:

1. A sticky header with title, optional description or entity identity, and translated close
   control.
2. The only vertically scrollable body, divided into named sections when the form has more than one
   concern.
3. A sticky footer with optional dirty/busy status and right-aligned actions.

The component supports only three size tokens:

| Size       | Maximum width | Intended use                                     |
| ---------- | ------------- | ------------------------------------------------ |
| `compact`  | 480 px        | Short forms, invitations, pairing details        |
| `standard` | 640 px        | Normal entity create/edit forms                  |
| `complex`  | 720 px        | Conditional forms and multi-resource entity work |

At desktop widths, the panel is right-aligned and the underlying page remains visible beneath a
quiet scrim. At viewport widths below 768 px, it occupies the full viewport, uses `100dvh`, removes
outer corner rounding, respects safe-area insets, and keeps the footer visible above the virtual
keyboard where the browser allows it. At 1024 px it must not exceed 64 percent of the viewport.

### Close behavior and data safety

The component reports close intent with a reason: close button, Escape, backdrop, or navigation.
The feature owns dirty-state policy because only the feature understands whether data changed.

- A clean, idle panel closes for every close intent.
- A dirty panel opens `ConfirmDialog` before discarding data.
- A pending mutation blocks close controls and navigation-driven dismissal until the request
  settles.
- Failed mutations keep the panel open, preserve all user input, and show the error inside the
  relevant section.
- A successful mutation invalidates the established queries, closes the panel, and returns focus
  to the originating row or action. Existing success toasts may remain.

The panel must never open another panel. A critical decision inside a panel may open a
`ConfirmDialog` above it. The lower panel remains mounted and inert while that dialog is active.

### Navigation

Entity panels use nested routes so the list page remains mounted behind the panel. Examples:

- `/catalog/new`
- `/catalog/:id/edit`
- `/shifts/new`
- `/shifts/:id/edit`
- `/counterparties/:id/edit`
- `/employees/:id/edit`
- `/kiosks/:id/edit`

Opening from a list records the background location. Browser Back closes the panel and restores the
list without losing its in-memory filters or scroll position. Opening a panel URL directly renders
the base list and panel together; explicit close from that entry replaces the URL with the base
list route rather than navigating outside the admin.

Confirmations and inline disclosures do not receive URLs.

### Accessibility and focus

- Use `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, and `aria-describedby` when a
  description exists.
- Make the background application inert and lock document scrolling while the panel is open.
- Move initial focus to the first invalid field, otherwise the first editable field, otherwise the
  panel heading.
- Trap Tab and Shift+Tab in the topmost overlay.
- Restore focus to the exact originating control after close.
- The topmost overlay alone handles Escape.
- All close controls have translated accessible names.
- Section headings use semantic heading levels; status is never communicated by color alone.

### Motion

The scrim fades and the panel translates on the X axis over 180–220 ms with an ease-out curve. No
layout property is animated. `prefers-reduced-motion: reduce` removes the translation and shortens
the opacity transition to effectively immediate feedback.

## ConfirmDialog

`ConfirmDialog` is a separate `@markiro/ui` primitive, not a size or tone of `SidePanel`.

- It contains a title, concise consequence text, optional entity identity, Cancel, and one explicit
  action label.
- It does not contain general forms. Existing confirmations do not require typed phrases.
- Destructive actions use the established destructive button token; neutral state-ending actions
  use the normal primary button.
- Initial focus goes to Cancel for destructive decisions.
- Escape and backdrop activate Cancel only while no request is pending.
- While pending, both dismissal and duplicate submission are blocked.
- The dialog renders in the shared overlay layer above an open panel when necessary.

The current `Modal` remains temporarily for compatibility, but new work must use `SidePanel` or
`ConfirmDialog`. Remove `Modal` after the last migration rather than turning it into a component
with conflicting modes.

## Inline disclosure

The integration-candidate "link existing product" operation becomes an expandable table row:

- The triggering control exposes `aria-expanded` and `aria-controls`.
- The expanded region belongs visually and semantically to the candidate row.
- It contains one product select, Cancel, and Link.
- Success removes the resolved candidate through the current query invalidation path.
- Failure leaves the row expanded and shows an inline error without moving focus.
- Only one candidate row is expanded at a time.

Creating a new product from a candidate remains a panel because it creates a durable entity and the
current two-request create-then-link limitation needs enough space for context and recoverable
error guidance.

## Migration map for current Modal call sites

### Move to SidePanel: 11 call sites

| Area                | Current interaction           | Target                                              |
| ------------------- | ----------------------------- | --------------------------------------------------- |
| Catalog             | Product create/edit form      | Standard panel with named form sections             |
| Shifts              | Shift create/edit form        | Complex panel with conditional aggregation section  |
| Counterparties      | Counterparty create/edit form | Standard panel with scoped SSCC section save        |
| Employees           | Employee create/edit form     | Complex panel with Profile, Badges, Access sections |
| Kiosks              | Kiosk create/edit form        | Compact create / complex edit panel                 |
| Kiosks              | Pairing code and barcode      | Compact panel with expiry and regeneration state    |
| Integrations        | Create product from candidate | Compact panel with candidate context                |
| Pickup order detail | Punch receipt                 | Unified order-resolution panel                      |
| Pickup order detail | Write-off act and reason      | Unified order-resolution panel                      |
| Team                | Create invitation             | Compact panel                                       |
| Team                | Edit member                   | Compact panel                                       |

The two pickup call sites consolidate into one standard "Resolve order" panel. It shows the order
identity and offers Punch or Write off as mutually exclusive modes. The final action remains
explicit and disabled until its required receipt or act data is valid.

### Move inline: 1 call site

| Area         | Current interaction                | Target               |
| ------------ | ---------------------------------- | -------------------- |
| Integrations | Link candidate to existing product | Expandable table row |

### Replace with ConfirmDialog: 12 call sites

| Area                | Decision                 |
| ------------------- | ------------------------ |
| Catalog             | Delete product           |
| Shifts              | Delete planned shift     |
| Shifts              | Close active shift       |
| Counterparties      | Delete counterparty      |
| Employees           | Archive employee         |
| Kiosks              | Archive kiosk            |
| Kiosks              | Archive write-off reason |
| Integrations        | Revoke API key           |
| Pickup order detail | Cancel order             |
| Team                | Remove member            |
| Team                | Cancel invitation        |
| Label editor        | Discard unsaved changes  |

## Page redesign audit

### Wave 1: repeated CRUD pages

#### Catalog

Keep the current searchable, status-filtered table. Use the dashboard's bounded page container and
shared filter bar. Move create/edit into a standard panel and group the form into Basic identity,
Aggregation and pricing, and Defaults. Keep GTIN ownership and integration-link warnings adjacent
to the GTIN or linkage fields. Collapse row buttons into a consistent action region without hiding
the primary Edit action from keyboard users.

#### Shifts

Keep status and date filters, but present them as one compact filter bar with a visible reset state.
The complex panel groups Product and mode, Planning, Production assignment, Templates, and
Aggregation. Preserve all existing touched-field omission semantics and disabled product editing.
Active-shift closure remains a confirmation, not part of edit.

#### Employees

The current form combines three resources in one long centered modal. Use a complex panel with
local section navigation for Profile, Badges, and Station access. Each resource keeps independent
loading, error, and mutation states. Revoking a badge or station access remains an explicit action
inside its section and must not submit the profile form.

#### Counterparties

Use a standard panel. Separate the counterparty form and SSCC counter into named sections with
their own save actions and explanatory copy. Saving SSCC must never run profile validation. Preserve
the unavailable-prefix state instead of presenting it as a query failure.

#### Kiosks

Split the page into Devices and Write-off reasons views using page-level tabs or equivalent nested
routes. Do not stack the reasons editor below the device table. Kiosk create uses a compact panel;
edit uses a complex panel with General settings and Product availability. Pairing uses its own
compact panel so the table remains visible while the temporary code is scanned.

### Wave 2: operational pages

#### Pickup orders and rejections

Keep the list table and bulk-export mode, but separate filter state from bulk actions. On order
detail, keep warnings and item data visible while the resolution panel opens. Put Punch and Write
off in one panel, keep Cancel as a confirmation, and keep Print as a direct non-mutating action.
Rejection rows retain inline expansion; strengthen reason, acknowledgement state, and the link back
to the source order.

#### Integrations

The channel page becomes a workspace with clear Settings, Candidates, Journal, and API keys
sections or tabs, subject to channel capability and availability. Do not render unsupported
credential controls. Candidate linking is inline; candidate creation uses a panel; key revocation
uses a confirmation. One-time credentials remain inline in their owning section because leaving
the page could lose the only display of the secret.

#### Conflicts

Do not treat Review as an unexplained one-click table mutation. Expand the selected row or show a
context region that exposes the conflicting code data, shift, detection time, and the exact effect
of marking it reviewed. Preserve the current tenant-scoped mutation and audit semantics.

#### Boxes

This read-only page needs only the shared page container, filter bar, adaptive table behavior, and
an empty state that explains why a shift must be selected. It should not gain a panel without a new
inspection requirement.

### Wave 3: settings and specialized workspaces

#### Team

Members remain the primary table. Invitations are a secondary section with delivery and access
states. Invitation create and member edit use compact panels; member removal and invitation
cancellation use confirmations. Owner and current-user restrictions remain visible and enforced.

#### Organization settings and profile

Keep these as inline forms on dedicated pages. Add section navigation where useful, constrain text
width, and make each save action's resource scope explicit. Improve the profile avatar upload
control and narrow-layout stacking; do not move these forms into panels.

#### Label library and editor

Keep the library's preview-card layout and improve metadata hierarchy, action alignment, and
responsive sizing. Keep the editor as a dedicated full-page workspace with palette, canvas,
preview, and properties. Its only centered dialog is the unsaved-change confirmation.

#### Authentication and invitations

Keep authentication, owner activation, organization creation/selection, and invitation acceptance
as focused linear pages. They do not use side panels. Audit their typography, error placement,
loading states, and cross-step navigation separately.

## Shared page primitives

Introduce only the primitives that remove repeated page-level code:

- `AdminPage`: bounded content width and responsive page padding.
- `FilterBar`: labelled filters, optional result summary, reset, and narrow-layout wrapping.
- `RowActions`: consistent spacing, keyboard order, and overflow behavior for table actions.
- `SectionHeader`: page-internal title, supporting copy, status, and section action.
- Shape-matched table and panel skeletons.

These primitives belong in `@markiro/ui` only when they have more than one real consumer. Feature
specific content, queries, validation, and permissions remain in `apps/admin`.

## Overlay architecture

Use one internal overlay layer manager in `@markiro/ui` for portals, inert state, document scroll
lock, focus restoration, and topmost Escape handling. Establish tokenized overlay, panel, and
dialog z-index levels instead of the current hard-coded `zIndex: 100`.

The layer manager is an internal implementation detail. Feature code consumes `SidePanel` and
`ConfirmDialog`, not overlay-stack APIs.

## Data and authorization invariants

- Keep all existing tenant-scoped hooks and endpoints.
- Do not derive write access from whether a panel route is reachable; mutation controls remain
  capability-gated and the server remains authoritative.
- Create and edit panel routes require the same write capability as their originating controls.
  An unauthorized direct URL renders the established access-denied behavior and must not mount
  privileged mutation hooks. This project does not introduce a read-only edit panel.
- Preserve exact create/update payload omission and null semantics.
- Preserve query cache isolation by authentication identity and organization.
- Preserve exact audit behavior for conflict review, status transitions, credential revocation,
  membership changes, and other sensitive operations.

## Loading, empty, error, and partial states

- Panel entry renders a shape-matched skeleton when entity or dependency data is loading.
- A panel-level load failure shows Retry and Close. It never renders an empty editable form as if
  the entity had no data.
- Field and mutation errors remain inline. Toasts supplement but do not replace persistent errors.
- Multi-resource panels render each section independently. Failure to load badges, station access,
  SSCC, or product availability must not be represented as an empty successful state.
- Empty list pages keep a task-specific next action when the user has the required capability and
  read-only guidance otherwise.

## Verification strategy

### Shared UI tests

- Portal rendering and cleanup.
- Initial focus, Tab/Shift+Tab trap, topmost Escape handling, and exact focus restoration.
- Background inert state and document scroll lock across nested ConfirmDialog-over-SidePanel use.
- Close reasons, busy dismissal blocking, and translated accessible names.
- Compact, standard, complex, and full-screen responsive classes.
- Reduced-motion behavior.

### Admin feature tests

- Nested route open, Back close, direct-link close fallback, and list state preservation.
- Dirty-form close confirmation for button, Escape, backdrop, and navigation.
- Existing validation, request payloads, query invalidation, success, and failure behavior.
- Capability-filtered rendering and denial for direct panel URLs.
- Independent section loading and errors in employee, counterparty, kiosk, and integration panels.
- Inline candidate-link keyboard behavior and error retention.
- Unified pickup resolution modes and unchanged API action payloads.

### Visual and manual checks

- Light and dark themes at 1440, 1024, and 768 px plus one narrower mobile viewport.
- Long RU and EN titles, validation messages, and action labels.
- Body-only scrolling, sticky footer, virtual-keyboard behavior, and no horizontal overflow.
- Focus visibility, screen-reader naming, and reduced-motion preference.
- Underlying list scroll and filter preservation after panel close.

Automated DOM tests do not count as browser confirmation. Report any untested browser, assistive
technology, or mobile-keyboard behavior explicitly.

## Staged delivery

This document is an umbrella interaction design, not one implementation-plan scope. The first
implementation plan covers the shared overlay primitives and Catalog reference migration only.
Each later numbered stage receives its own focused plan after the preceding consumers validate the
shared contracts. Specialized operational pages may receive a narrower design addendum when their
workflow needs more detail than this system-level specification provides.

1. Add overlay internals, `SidePanel`, and `ConfirmDialog` with shared UI tests.
2. Migrate Catalog as the reference implementation, including nested routes and product deletion.
3. Migrate Counterparties and Shifts, covering scoped saves and conditional forms.
4. Migrate Employees and Kiosks, covering multi-resource sections and pairing.
5. Redesign Pickup, Integrations, Conflicts, and Boxes using their specialized patterns.
6. Migrate Team confirmations and panels; align Settings, Profile, Labels, and Auth surfaces.
7. Audit `apps/admin/src` for legacy `Modal` use, remove the component after the final consumer,
   and run the complete admin and UI gates plus browser review.

Each stage must be independently reviewable and preserve production behavior. A stage may improve
the shared primitives when a real consumer exposes a missing contract, but it must not bundle the
next page wave merely to eliminate all legacy usage faster.
