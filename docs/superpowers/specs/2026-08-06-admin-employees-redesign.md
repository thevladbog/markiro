# Admin Employees Redesign

## Status

The design was approved during the 2026-08-06 review. It is ready for implementation planning
after final review of this written specification.

## Context

The completed Dashboard, Catalog, Counterparties, and Shifts stages establish the Markiro Admin
interaction language: bounded pages, visible row actions, route-backed side panels, persistent
inline errors, semantic confirmations, RU/EN copy, and light/dark themes.

The Employees page still uses centered `Modal` surfaces and inline styles. Its edit form combines
three resources in one 529-line component:

1. employee profile data;
2. employee badges;
3. line-station access.

Those resources have different mutations and failure modes, but the current surface presents them
as one undifferentiated form. Badge and station-access failures primarily rely on toasts, the
operators query mounts even when the related edit section is not needed, and the list loses the
route and state-preservation contracts established by the previous redesign stages.

This specification is the focused Employees half of staged-delivery item 4 in
`docs/superpowers/specs/2026-08-05-admin-interaction-redesign-design.md`. Kiosks are intentionally
deferred to a separate specification and pull request because pairing-secret lifecycle, product
availability, and write-off reasons form an independent workflow.

## Goals

1. Align the Employees list with the completed Admin page language.
2. Move create and edit into nested route-backed side panels while keeping the list mounted.
3. Separate Profile, Badges, and Station access into understandable resource sections.
4. Preserve exact existing API paths, request bodies, query invalidation, capability checks, and
   station-access safety behavior.
5. Make every mutation failure persistent and recoverable in its owning section.
6. Protect unsaved input and block dismissal during any active employee-panel mutation.
7. Add explicit confirmation for irreversible badge and station-access revocation.
8. Preserve keyboard, focus, responsive, RU/EN, and light/dark contracts.

## Non-goals

- No backend, DTO, database, audit, or tenant-scope changes.
- No dependency, framework, router, form-library, query-library, font, or icon migration.
- No Kiosks, Team, Settings, Profile, Labels, Auth, or operational-page redesign.
- No employee search because the current Employees API supports only status filtering.
- No bulk employee actions, restore-from-archive workflow, badge import, or station roster changes.
- No persistence, logging, analytics, or URL exposure of badge or PIN input.
- No removal of the shared legacy `Modal`; other Admin consumers still use it.

## Chosen direction

Use a route-backed side panel with local section navigation and continuously mounted sections.
Three alternatives were reviewed:

- one uninterrupted stack, which lacks orientation in a long multi-resource panel;
- tabs, which hide neighboring resource state and complicate cross-section dirty/error visibility;
- local navigation plus sections, which preserves overview and gives errors and statuses stable
  locations.

The third option was selected. On desktop, edit uses a compact navigation rail beside the scrolling
sections. On mobile, the rail becomes a horizontally scrollable sticky section bar. Navigation
scrolls the panel body to a section; it does not mount and unmount section content.

## List page

`/employees` remains a table and adopts the shared `AdminPage`, `FilterBar`, and `RowActions`
primitives.

### Header and filters

- Keep the translated page title and capability-gated Add employee action.
- Add one status filter with All, Active, and Archived values.
- Default to All to preserve the current list behavior.
- Use the existing `GET /employees?status=` contract for filtered states.
- Show a translated result count only after the current query succeeds.
- Expose Reset only when the status differs from All.
- Do not add client-only search or filter already-fetched records.

### Table

Preserve the existing columns and meanings:

- full name;
- role, with the established missing-value fallback;
- semantic employee status;
- active badge count;
- actions.

Use tabular figures for the badge count. Keep Edit as the first visible action. Show Archive only
for active employees. Read-only users retain the table and filters but receive no mutation controls
and mount no mutation hooks.

### Page states

- Loading uses a table-shaped state rather than a generic centered modal spinner.
- Load failure uses a persistent page Alert and Retry.
- Empty All state explains how to add the first employee when write access exists and provides
  read-only guidance otherwise.
- Empty filtered state explains that no employees match the selected status and offers Reset rather
  than repeating the create action.

## Routes and authorization

Use nested routes under the existing list:

- `/employees/new` for creation;
- `/employees/:employeeId/edit` for editing.

Both nested routes require `operations.write`, matching the originating controls. A read-only
direct URL renders the established forbidden page and must not mount employee, badge, or
station-access mutation hooks.

Opening from the list records background location. Browser Back closes the panel without losing
the status filter, list scroll, or current query data. Closing a directly entered panel URL replaces
the location with `/employees` instead of navigating outside Admin.

The route panel receives the current employee list through `<Outlet>` context. It renders:

- a shape-matched panel skeleton while the list is initially loading;
- a panel-level load error with Retry and Close when the employee list fails;
- a translated not-found state when `employeeId` is absent from a successful response;
- the form only after the required employee data is available.

## Create panel

Creation uses a standard-size `SidePanel` because only Profile exists before an employee has an ID.
It contains full name and optional role, using the current Zod validation and exact normalization:

```ts
{
  fullName: values.fullName.trim(),
  role: values.role?.trim() || null,
}
```

The footer contains Cancel and Create. A failed `POST /employees` keeps the panel open, preserves
both fields, and shows the server message in a persistent Alert. A success uses the existing query
invalidation and success toast, closes the panel, and restores focus to the originating Add action.

## Edit panel

Editing uses a complex-size `SidePanel`. The header identifies the employee by full name and role
when present. The body contains local navigation and three semantic sections. The sticky footer
contains Cancel and Save profile; it never submits Badge or Station access operations.

### Local section navigation

The navigation contains:

1. Profile;
2. Badges, with the active-badge count;
3. Station access, with Active, Disabled, None, Loading, or Error status.

The active item tracks panel-body scroll and moves focus to the destination heading when activated
from the keyboard. Error state is represented with translated accessible text or an icon plus
accessible label, never color alone.

### Profile section

Profile owns the react-hook-form instance, validation, dirty state, and `PATCH /employees/:id`.
It preserves the current exact payload normalization. Its Save action is the panel-footer primary
action.

A failed update keeps the current input and shows a persistent section Alert. A successful update
closes the panel after established query invalidation and success toast behavior.

### Badges section

Badges come from the existing `EmployeeDto.badges`; this project does not invent a separate badge
query. The section still owns independent local and mutation state:

- active and revoked badges remain distinguishable without color alone;
- issue inputs collect badge code and optional label;
- Issue badge calls the existing `POST /employees/:id/badges` payload exactly;
- success clears only issue inputs and leaves the panel open;
- failure preserves issue inputs and shows the server message in this section;
- Revoke opens `ConfirmDialog` naming the selected badge before calling the existing DELETE;
- revoke failure keeps the confirmation open with a persistent error;
- revoke success closes only the confirmation and refreshes the employee data.

Badge issue inputs are transient component state. They are never written to URL state, persistent
browser storage, logs, analytics, or toast copy.

### Station access section

Mount `GET /operators` only for an authorized edit panel. Preserve the existing distinction between
unknown and absent state:

- Pending shows a section-shaped loading state and no Grant control.
- Error shows a persistent load Alert with Retry and no Grant control.
- Success without a matching operator shows the no-access state and Grant controls.
- Success with a matching operator shows personnel number, Active or Disabled status, reversible
  Enable/Disable, PIN reset, and Revoke access.

Preserve exact mutation semantics:

- Grant uses `PUT /operators/:employeeId` with `{ login, pin }`.
- PIN reset uses `PATCH /operators/:employeeId` with `{ pin }` only; it must not rename the login or
  alter active state.
- Enable/Disable uses `PATCH /operators/:employeeId` with `{ active }` only.
- Revoke access opens `ConfirmDialog` before `DELETE /operators/:employeeId`.

Every failure remains in the Station access section or its active confirmation. A success clears
only the relevant PIN/login inputs, retains the panel, and preserves the established invalidation
and success-toast behavior. PIN input uses password presentation and is never persisted or echoed
in error/success copy.

## Dirty, busy, and dismissal behavior

Aggregate the following into panel dirty state:

- profile form changes;
- non-empty badge issue code or label;
- non-empty station-access login or PIN.

The panel-level guard handles close button, Cancel, Escape, backdrop, and browser navigation:

- clean and idle closes immediately;
- dirty and idle opens the established discard `ConfirmDialog`;
- any employee, badge, or station-access mutation in flight blocks dismissal and duplicate
  submission;
- a successful profile mutation uses the guard's finish path;
- successful badge or station-access mutations clear only their resource input and recompute dirty
  state without closing the panel.

Revoke confirmations render above the panel. The lower panel remains mounted and inert, and only
the topmost confirmation handles Escape.

## Employee archive confirmation

Archive remains a list-owned `ConfirmDialog`, not a side panel. It names the employee and describes
the consequence. Cancel receives initial focus because the action is destructive.

While `DELETE /employees/:id` is pending, dismissal and repeat submission are blocked. Failure
keeps the dialog open and shows the server message persistently. Success closes the dialog,
invalidates the established list queries, keeps the selected status filter, and retains the current
success toast.

## Component boundaries

Use feature-local components because the multi-resource behavior is specific to Employees:

- `EmployeesPage`: list query, filter, result count, row actions, archive confirmation, and Outlet
  context.
- `EmployeePanelRoute`: route lookup, direct-entry fallback, create/update controller, aggregated
  dirty/busy guard, and panel-level load states.
- `EmployeeProfileForm`: profile fields, validation, submit contract, and dirty reporting.
- `EmployeeBadgesSection`: badge presentation, transient issue form, issue/revoke mutations, and
  section errors.
- `EmployeeStationAccessSection`: operators query states, grant/reset/toggle/revoke actions, and
  section errors.
- `EmployeeSectionNav`: feature-local anchor navigation and section status presentation.
- `employees.css`: Employees list, panel, section, responsive, and skeleton styles.

Reuse `AdminPage`, `FilterBar`, `RowActions`, `SidePanel`, `ConfirmDialog`, and
`useRoutePanelGuard`. Extend `ConfirmDialogProps` with one optional `error?: ReactNode` contract,
rendered as an error Alert between entity content and actions. Employee archive, badge revoke, and
station-access revoke are three concrete consumers that need persistent mutation failure without
closing the confirmation. Existing callers omit the prop and retain identical rendering. Add the
shared component test with the first consumer task. Do not add any other shared component until
another real consumer proves the same contract.

## Visual and responsive behavior

Use the existing IBM Plex Sans and Mono typography and current design tokens. Do not introduce a
new palette, shadow system, radius scale, or font.

- The page keeps the established bounded 1440 px Admin width and responsive padding.
- The desktop edit panel uses the existing complex width token, with a narrow navigation rail and
  one scrollable content region.
- At widths below 768 px, the panel uses the existing full-screen `100dvh` behavior.
- Mobile navigation becomes a sticky horizontal row with overflow scrolling and visible focus.
- Form grids collapse to one column before controls become cramped.
- Badge and access rows wrap actions below identity content when needed.
- Sticky footer actions wrap without horizontal overflow and remain above safe-area insets.
- Numbers and personnel identifiers use tabular figures.
- Section headings use semantic heading levels; supporting copy uses a readable measure.
- Motion continues to use the existing SidePanel transform/opacity contract and reduced-motion
  behavior.

## Accessibility

- Preserve `SidePanel` dialog semantics, inert background, scroll lock, focus trap, topmost Escape,
  and exact focus restoration.
- Local navigation uses real buttons or links with current-section state and translated accessible
  names.
- Section destinations are focusable headings without disrupting normal reading order.
- Form inputs retain programmatic labels, inline error association, and visible focus.
- Loading and mutation progress use established live-region behavior without repeatedly announcing
  the entire panel.
- Status and error indicators include text; color is supplemental.
- Confirmations identify the employee, badge, or access record affected and use explicit action
  labels.

## Internationalization

Add matching RU and EN keys for:

- result counts, status filter, Reset, and filtered-empty state;
- panel load, retry, not-found, discard, and section navigation;
- Profile, Badges, and Station access section titles and supporting copy;
- persistent mutation errors and revoke confirmations;
- loading/error/none/active/disabled section statuses.

Do not concatenate translated fragments for status sentences. Long RU and EN labels must wrap
without clipping the rail, rows, or footer.

## Verification strategy

### Focused automated tests

- List status filtering emits the exact `GET /employees?status=` request and preserves All as the
  default.
- Read-only rendering mounts no employee mutation hooks or operators query.
- Nested create/edit routes support list-origin open, Back close, direct-entry close fallback,
  not-found, panel load failure, and Retry.
- Dirty close paths cover close button, Escape, backdrop, and Back; pending mutations block each
  path.
- Create and update retain exact profile payloads and preserve input on server error.
- Badge issue and revoke retain exact paths and bodies, independent errors, confirmation behavior,
  and local input clearing.
- Station access covers pending, load error with Retry, confirmed absence, grant, PIN-only reset,
  Enable/Disable, revoke confirmation, and persistent mutation errors.
- Archive confirmation covers success, pending dismissal blocking, and failure retention.
- Direct read-only panel URLs render forbidden behavior and do not mount privileged hooks.
- Section navigation exposes active and error states and supports keyboard activation.

### Package and repository gates

Run focused tests during each TDD task, then:

```bash
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
pnpm format:check
git diff --check origin/main...HEAD
```

Audit the changed Employees feature for remaining `Modal` use. The expected result is no Employee
`Modal` imports or call sites; repository-wide legacy `Modal` removal remains a later stage.

### Manual and external validation

With an authenticated Admin API, verify light and dark themes at 1440, 1024, 768, and one viewport
below 768 px. Exercise create, edit, direct URL, not-found, query failure/retry, every section
mutation failure, confirmations, Back, Escape, backdrop, keyboard traversal, long RU/EN copy,
reduced motion, and list filter/scroll preservation.

Automated DOM tests do not count as browser, screen-reader, mobile virtual-keyboard, or real API
confirmation. Report any unperformed external checks explicitly.

## Delivery boundary

This specification produces one independently reviewable Employees pull request. It may refine an
existing shared primitive only when the Employees implementation exposes a concrete missing
contract and the refinement includes shared tests. It must not include Kiosks or later Admin waves.

After this stage is reviewed and merged, Kiosks receive a separate specification covering Devices
versus Write-off reasons navigation, compact create and pairing panels, complex edit and product
availability, one-time code lifecycle, and archive confirmations.
