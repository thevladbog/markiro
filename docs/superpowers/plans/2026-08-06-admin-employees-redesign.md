# Admin Employees Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Employees Admin page as a bounded, filterable list with route-backed create/edit panels and independently recoverable Profile, Badges, and Station access sections.

**Architecture:** Keep `/employees` mounted while nested create/edit routes render `SidePanel` surfaces through `<Outlet>`. Extract the current multi-resource modal into feature-local Profile, Badges, Station access, and section-navigation components; aggregate their dirty and busy state in the edit route controller while each section retains its own queries, mutations, errors, and save actions. Reuse the shared Admin page, overlay, confirmation, and route-guard contracts without changing backend APIs or DTOs.

**Tech Stack:** React 19, React Router, TanStack Query, react-hook-form, Zod, i18next, Vitest, Testing Library, vanilla CSS, `@markiro/ui`.

**Source specification:** `docs/superpowers/specs/2026-08-06-admin-employees-redesign.md`

## Global Constraints

- Preserve every current Employees and Operators API path, request body, null-versus-omitted rule, query invalidation, capability check, and success toast.
- Keep `operations.read` on `/employees`; require `operations.write` on `/employees/new` and `/employees/:employeeId/edit`.
- Direct read-only panel URLs must render the established forbidden page and must not mount employee, badge, or station-access mutation hooks.
- Keep the base list mounted behind each panel so status filter, scroll position, and query data survive Back and explicit close.
- Failed profile, badge, station-access, archive, and revoke mutations must preserve the current surface and show a persistent owning-surface error; toast-only failure handling is not sufficient.
- Dirty close button, Cancel, Escape, backdrop, and Back require discard confirmation; any employee-panel mutation in flight blocks dismissal and duplicate submission.
- Keep badge code and PIN input transient: never write them to URL state, persistent browser storage, logs, analytics, or toast copy.
- Do not add a dependency, alter `pnpm-lock.yaml`, change backend code, remove the shared legacy `Modal`, or include Kiosks or later Admin waves.
- Use matching RU and EN keys, existing design tokens, visible focus, semantic headings, tabular figures for identifiers/counts, and no color-only status.
- Automated DOM tests do not count as browser, screen-reader, or mobile-keyboard confirmation; report those separately.
- Fresh-worktree setup currently requires `pnpm install --lockfile=false` because the pre-existing overrides configuration does not match the frozen lockfile; do not modify configuration or lockfile in this feature.

## File and Responsibility Map

- `packages/ui/src/components/ConfirmDialog.tsx`: optional persistent error content for failed confirmed mutations.
- `packages/ui/src/components.css`: confirmation error spacing; existing overlay and panel behavior remains unchanged.
- `packages/ui/test/overlays.test.tsx`: shared confirmation error rendering and pending-state regression.
- `apps/admin/src/pages/employees/index.tsx`: Employees list, status filter, result count, row actions, archive confirmation, navigation, and Outlet context.
- `apps/admin/src/pages/employees/EmployeePanelRoute.tsx`: create/edit route controllers, close fallback, entity lookup, panel load states, dirty/busy aggregation, and composition.
- `apps/admin/src/pages/employees/EmployeeProfileForm.tsx`: profile schema, exact payload normalization, stable clean-only reseeding, validation, and dirty reporting.
- `apps/admin/src/pages/employees/EmployeeBadgesSection.tsx`: badge list, issue inputs, issue/revoke mutations, confirmation, persistent errors, and dirty/busy reporting.
- `apps/admin/src/pages/employees/EmployeeStationAccessSection.tsx`: operators query, Retry, grant/reset/toggle/revoke actions, confirmations, persistent errors, and dirty/busy/status reporting.
- `apps/admin/src/pages/employees/EmployeeSectionNav.tsx`: feature-local desktop rail/mobile bar, active anchor, badge count, access status, and error markers.
- `apps/admin/src/pages/employees/employees.css`: list, skeleton, profile grid, section, navigation, row, and responsive styling.
- `apps/admin/src/pages/employees/EmployeeForm.tsx`: temporary composition wrapper during Tasks 3-5; delete after edit-route migration.
- `apps/admin/src/app.tsx`: nested write-capability routes.
- `apps/admin/src/i18n/{ru,en}.json`: lockstep list, route, section, state, confirmation, and error copy.
- `apps/admin/test/employees.test.tsx`: list, filters, archive, profile payload, and retained feature regressions.
- `apps/admin/test/employee-badges.test.tsx`: badge section issue/revoke/error/dirty/busy behavior.
- `apps/admin/test/employee-station-access.test.tsx`: operators query states and exact access mutations.
- `apps/admin/test/employees-routing.test.tsx`: nested route, direct entry, Back, dirty/busy, load, not-found, and section-navigation behavior.
- `apps/admin/test/access-routing.test.tsx`: direct read-only panel-route denial and privileged-hook isolation.
- `docs/superpowers/plans/2026-08-06-admin-employees-redesign.md`: implementation and verification evidence.

---

### Task 1: Add persistent errors to ConfirmDialog

**Files:**

- Modify: `packages/ui/src/components/ConfirmDialog.tsx`
- Modify: `packages/ui/src/components.css`
- Modify: `packages/ui/test/overlays.test.tsx`

**Interfaces:**

- Produces: `ConfirmDialogProps.error?: ReactNode`.
- Consumers: employee archive, badge revoke, and station-access revoke in later tasks.
- Compatibility: every existing caller omits `error` and retains identical output and behavior.

- [ ] **Step 1: Write the failing shared overlay test**

Add this case beside the existing ConfirmDialog tests:

```tsx
it("keeps a confirmed mutation error visible without changing dialog actions", () => {
  render(
    <ConfirmDialog
      open
      title="Archive employee?"
      description="The employee will be archived."
      entity="Anna Smirnova"
      error="Archive conflict"
      cancelLabel="Cancel"
      confirmLabel="Archive"
      tone="destructive"
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );

  const dialog = screen.getByRole("alertdialog", { name: "Archive employee?" });
  expect(within(dialog).getByRole("alert").textContent).toContain("Archive conflict");
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDefined();
  expect(within(dialog).getByRole("button", { name: "Archive" })).toBeDefined();
});
```

- [ ] **Step 2: Run the overlay test and verify RED**

Run: `pnpm --filter @markiro/ui exec vitest run test/overlays.test.tsx`

Expected: FAIL because `error` is not part of `ConfirmDialogProps` and no alert renders.

- [ ] **Step 3: Implement the minimal optional error slot**

Extend the public props and render the established Alert between entity and footer:

```tsx
export interface ConfirmDialogProps {
  // existing props unchanged
  error?: ReactNode;
}

{
  error ? (
    <div className="mk-confirm-dialog__error">
      <Alert tone="error">{error}</Alert>
    </div>
  ) : null;
}
```

Import `Alert` from `./Alert.js`. Add only:

```css
.mk-confirm-dialog__error {
  margin-top: var(--sp-4);
}
```

- [ ] **Step 4: Run shared UI verification and verify GREEN**

Run: `pnpm --filter @markiro/ui exec vitest run test/overlays.test.tsx`

Run: `pnpm --filter @markiro/ui typecheck`

Expected: PASS; existing focus, Escape, backdrop, busy, and nested-overlay tests remain green.

- [ ] **Step 5: Commit the shared contract**

```bash
git add packages/ui/src/components/ConfirmDialog.tsx packages/ui/src/components.css packages/ui/test/overlays.test.tsx
git commit -m "feat(ui): keep confirmation errors visible"
```

---

### Task 2: Align the Employees list and archive flow

**Files:**

- Create: `apps/admin/src/pages/employees/employees.css`
- Modify: `apps/admin/src/pages/employees/index.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/employees.test.tsx`

**Interfaces:**

- Consumes: `AdminPage`, `FilterBar`, `RowActions`, `ConfirmDialog.error`, and `useEmployees({ status? })`.
- Produces: shared-list visual/state behavior and a list query that later exposes employees through Outlet context.
- Preserves: existing centered create/edit `EmployeeForm` temporarily; route migration happens in Tasks 5-6.

- [ ] **Step 1: Add failing list/filter/archive tests**

Update the Employees render harness to return its QueryClient and add tests with native `Response` objects. Cover these observable contracts:

```tsx
it("uses the shared page/filter layout and requests the selected status", async () => {
  const fetchMock = vi.fn(async () => jsonResponse(200, { items: [JANE] }));
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  renderPage();

  expect(await screen.findByTestId("employees-page")).toBeDefined();
  expect(screen.getByRole("group", { name: "Фильтры сотрудников" })).toBeDefined();
  await chooseOption(user, "Статус", "Активные");

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/employees?status=active", expect.any(Object)),
  );
  expect(screen.getByText("1 сотрудник").getAttribute("aria-live")).toBe("polite");
});

it("keeps archive confirmation open with the server error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? jsonResponse(409, { message: "Employee has an active shift" })
        : jsonResponse(200, { items: [JANE] }),
    ),
  );
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole("button", { name: "В архив" }));
  const dialog = screen.getByRole("alertdialog", { name: "Отправить сотрудника в архив?" });
  await user.click(within(dialog).getByRole("button", { name: "В архив" }));

  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "Employee has an active shift",
  );
  expect(screen.getByRole("alertdialog", { name: "Отправить сотрудника в архив?" })).toBeDefined();
});
```

Also assert All is the default `/api/employees` request, Reset returns to All, a filtered empty
state offers Reset, and read-only mode mounts no write hooks.

- [ ] **Step 2: Run the Employees test and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/employees.test.tsx`

Expected: FAIL because the page has no shared wrapper/filter/result summary and archive still uses
`Modal` with toast-only failure.

- [ ] **Step 3: Implement list state and shared page primitives**

Use the existing API type directly:

```tsx
type StatusFilter = "all" | EmployeeStatus;

const [status, setStatus] = useState<StatusFilter>("all");
const query = useEmployees(status === "all" ? {} : { status });
const items = query.data ?? [];
```

Render `AdminPage data-testid="employees-page"`, PageHeader, and:

```tsx
<FilterBar
  label={t("pages.employees.filters.label")}
  resultSummary={
    !query.isPending && !query.isError
      ? t("pages.employees.resultCount", { count: items.length })
      : ""
  }
  {...(status !== "all"
    ? {
        resetLabel: t("pages.employees.filters.reset"),
        onReset: () => setStatus("all"),
      }
    : {})}
>
  <Select
    className="mk-employees-filter--status"
    label={t("pages.employees.filters.statusLabel")}
    value={status}
    options={statusOptions}
    onValueChange={(value) => setStatus(value as StatusFilter)}
  />
</FilterBar>
```

Wrap visible row buttons in `RowActions`. Replace inline page/loading/action styles with
`employees.css`. Use separate All-empty and filtered-empty copy; the filtered state resets the
filter and does not duplicate Add employee.

- [ ] **Step 4: Replace employee archive Modal with ConfirmDialog**

Keep archive state and mutation inside the authorized row-action component. Add local
`archiveError`, clear it only on a new attempt/cancel, pass `busy={archiveMutation.isPending}` and
`error={archiveError}`. On failure use `ApiRequestError.message`; on success retain current toast,
close only the confirmation, and let the existing invalidation refresh the filtered list.

- [ ] **Step 5: Add lockstep translations and CSS**

Add matching RU/EN keys for `resultCount` plural forms, filter label/reset, filtered empty title and
hint, list Retry, and archive persistent fallback error. Define only feature styles:

```css
.mk-employees-page {
  min-width: 0;
}
.mk-employees-filter--status {
  width: 200px;
}
.mk-employees-section-state {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.mk-employee-badge-count {
  font-variant-numeric: tabular-nums;
}
@media (max-width: 639px) {
  .mk-employees-filter--status {
    width: 100%;
  }
}
```

- [ ] **Step 6: Run list tests and package checks**

Run: `pnpm --filter @markiro/admin exec vitest run test/employees.test.tsx`

Run: `pnpm --filter @markiro/admin typecheck`

Expected: PASS for All/Active/Archived requests, Reset, result pluralization, empty/error states,
read-only hook isolation, visible row actions, and archive success/failure.

- [ ] **Step 7: Commit the Employees list foundation**

```bash
git add apps/admin/src/pages/employees/index.tsx apps/admin/src/pages/employees/employees.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/employees.test.tsx
git commit -m "style(admin): align employees list with admin pages"
```

---

### Task 3: Extract the independent Badges section

**Files:**

- Create: `apps/admin/src/pages/employees/EmployeeBadgesSection.tsx`
- Modify: `apps/admin/src/pages/employees/EmployeeForm.tsx`
- Modify: `apps/admin/src/pages/employees/employees.css`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/employee-badges.test.tsx`
- Modify: `apps/admin/test/employees.test.tsx`

**Interfaces:**

- Produces:

```ts
export interface EmployeeBadgesSectionProps {
  employee: EmployeeDto;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onErrorChange: (hasError: boolean) => void;
}
```

- Consumes: `ConfirmDialog.error`, `useIssueBadge`, and `useRevokeBadge`.
- Temporary consumer: existing `EmployeeForm` edit modal passes no-op reporting callbacks until
  route composition in Task 6.

- [ ] **Step 1: Write failing section tests**

Create a focused QueryClient test harness that renders the real section. Add separate tests for:

```tsx
it("preserves badge inputs and reports a persistent issue error", async () => {
  stubBadgePost(409, { message: "Badge code already active" });
  renderBadgesSection(JANE);
  const user = userEvent.setup();

  await user.type(screen.getByLabelText("Код бейджа"), "AAA111");
  await user.type(screen.getByLabelText("Метка"), "Резервный");
  await user.click(screen.getByRole("button", { name: "Выпустить бейдж" }));

  const section = screen.getByRole("region", { name: "Бейджи" });
  expect((await within(section).findByRole("alert")).textContent).toContain(
    "Badge code already active",
  );
  expect((screen.getByLabelText("Код бейджа") as HTMLInputElement).value).toBe("AAA111");
});

it("confirms badge revoke and keeps a failed confirmation open", async () => {
  stubBadgeDelete(409, { message: "Badge is in use" });
  renderBadgesSection(JANE);
  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: "Отозвать" }));
  const dialog = screen.getByRole("alertdialog", { name: "Отозвать бейдж?" });
  await user.click(within(dialog).getByRole("button", { name: "Отозвать" }));

  expect((await within(dialog).findByRole("alert")).textContent).toContain("Badge is in use");
});
```

Assert successful issue sends exactly `{ badgeCode: "CCC333", label: null }`, clears only issue
inputs, and reports dirty/busy transitions. Assert successful revoke sends the existing DELETE path.

- [ ] **Step 2: Run the badge test and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/employee-badges.test.tsx`

Expected: FAIL because `EmployeeBadgesSection` does not exist.

- [ ] **Step 3: Implement the section with local state and reporting**

Move badge formatting, list rendering, issue/revoke hooks, and inputs out of `EmployeeForm`. Keep
separate `issueError`, `revokeError`, and `revokeTarget` state. Report aggregate state:

```tsx
const dirty = badgeCode.trim().length > 0 || badgeLabel.trim().length > 0;
const busy = issueMutation.isPending || revokeMutation.isPending;

useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
useEffect(
  () => onErrorChange(issueError !== null || revokeError !== null),
  [issueError, revokeError, onErrorChange],
);
```

Render a labelled `<section role="region">`. On successful issue clear code/label/error and retain
the panel; on failure retain inputs and set the server/fallback error. Revoke uses destructive
`ConfirmDialog` and clears only its target/error on cancel or success.

- [ ] **Step 4: Integrate the section into the existing edit modal**

Replace the old badge block in `EmployeeForm` with:

```tsx
{
  mode === "edit" && employee ? (
    <EmployeeBadgesSection
      employee={employee}
      onDirtyChange={() => undefined}
      onBusyChange={() => undefined}
      onErrorChange={() => undefined}
    />
  ) : null;
}
```

Do not mount badge hooks in create mode. Move every badge inline style into `employees.css`.

- [ ] **Step 5: Add lockstep copy and run GREEN checks**

Add RU/EN copy for issue fallback error, revoke title/body/action, and revoked/active accessible
status. Run:

`pnpm --filter @markiro/admin exec vitest run test/employee-badges.test.tsx test/employees.test.tsx`

Expected: PASS; the existing badge path/body regressions remain exact and failures are section-local.

- [ ] **Step 6: Commit the Badges section**

```bash
git add apps/admin/src/pages/employees/EmployeeBadgesSection.tsx apps/admin/src/pages/employees/EmployeeForm.tsx apps/admin/src/pages/employees/employees.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/employee-badges.test.tsx apps/admin/test/employees.test.tsx
git commit -m "feat(admin): separate employee badge management"
```

---

### Task 4: Extract the independent Station access section

**Files:**

- Create: `apps/admin/src/pages/employees/EmployeeStationAccessSection.tsx`
- Modify: `apps/admin/src/pages/employees/EmployeeForm.tsx`
- Modify: `apps/admin/src/pages/employees/employees.css`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/employee-station-access.test.tsx`
- Modify: `apps/admin/test/employees.test.tsx`

**Interfaces:**

- Produces:

```ts
export type EmployeeAccessSectionStatus = "loading" | "error" | "none" | "active" | "disabled";

export interface EmployeeStationAccessSectionProps {
  employee: EmployeeDto;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onErrorChange: (hasError: boolean) => void;
  onStatusChange: (status: EmployeeAccessSectionStatus) => void;
}
```

- Consumes: `useOperators`, grant/update/revoke hooks, and `ConfirmDialog.error`.
- Temporary consumer: existing edit modal with no-op reports until Task 6.

- [ ] **Step 1: Write failing query-state and mutation tests**

Create focused tests using complete operator response shapes. Cover pending, error, Retry, confirmed
absence, active, and disabled states. Add exact mutation cases:

```tsx
it("does not expose Grant until operators Retry confirms absence", async () => {
  let attempts = 0;
  stubOperators(async () => {
    attempts += 1;
    return attempts === 1
      ? jsonResponse(500, { message: "Unavailable" })
      : jsonResponse(200, { items: [] });
  });
  renderStationAccess(JANE);
  const section = await screen.findByRole("region", { name: "Доступ на станцию" });

  expect(within(section).queryByRole("button", { name: "Выдать доступ" })).toBeNull();
  await userEvent.setup().click(within(section).getByRole("button", { name: "Повторить" }));
  expect(await within(section).findByRole("button", { name: "Выдать доступ" })).toBeDefined();
});

it("preserves PIN and PATCHes only pin after a failed reset", async () => {
  stubExistingAccess({ active: true });
  stubOperatorPatch(409, { message: "PIN policy rejected" });
  renderStationAccess(JANE);
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText("ПИН-код"), "9999");
  await user.click(screen.getByRole("button", { name: "Сменить ПИН" }));

  expect((await screen.findByRole("alert")).textContent).toContain("PIN policy rejected");
  expect((screen.getByLabelText("ПИН-код") as HTMLInputElement).value).toBe("9999");
  expect(fetch).toHaveBeenCalledWith(
    "/api/operators/1",
    expect.objectContaining({ method: "PATCH", body: JSON.stringify({ pin: "9999" }) }),
  );
});
```

Also assert grant sends `{ login, pin }`, toggle sends only `{ active }`, revoke requires
confirmation, revoke failure remains in that confirmation, success clears relevant inputs, and
dirty/busy/status/error callbacks report transitions.

- [ ] **Step 2: Run the station-access test and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/employee-station-access.test.tsx`

Expected: FAIL because the section does not exist.

- [ ] **Step 3: Implement explicit query states and Retry**

Move station-access hooks and state out of `EmployeeForm`. Derive status without collapsing unknown
into absence:

```ts
const access = query.data?.find((item) => item.employeeId === employee.id);
const status: EmployeeAccessSectionStatus = query.isPending
  ? "loading"
  : query.isError
    ? "error"
    : !access
      ? "none"
      : access.active
        ? "active"
        : "disabled";
```

Error renders Alert plus Retry (`void query.refetch()`); Grant controls render only for
`query.isSuccess && !access`.

- [ ] **Step 4: Implement mutation-local errors and success-only clearing**

Use one helper that returns success rather than swallowing failure:

```ts
async function runAccess(action: () => Promise<unknown>): Promise<boolean> {
  try {
    setMutationError(null);
    await action();
    toast("ok", t("pages.employees.toasts.stationAccessSuccess"));
    return true;
  } catch (cause) {
    setMutationError(
      cause instanceof ApiRequestError
        ? cause.message
        : t("pages.employees.toasts.stationAccessError"),
    );
    return false;
  }
}
```

Clear login/PIN only when this returns true. Keep exact PUT/PATCH bodies. Revoke uses destructive
ConfirmDialog with its own error and pending state. Report dirty from non-empty login/PIN, busy from
all three mutations, error from query or mutation/confirmation, and the derived status.

- [ ] **Step 5: Integrate into edit-only EmployeeForm and style it**

Replace the old access block with `EmployeeStationAccessSection` only when mode is edit and an
employee exists. Move access identity, action-row, form-row, skeleton, and responsive styles into
`employees.css`. The PIN input remains `type="password"`, `inputMode="numeric"`, and monospace.

- [ ] **Step 6: Add copy and run GREEN checks**

Add matching RU/EN Retry, fallback error, status, revoke title/body/action, and confirmation error
copy. Run:

`pnpm --filter @markiro/admin exec vitest run test/employee-station-access.test.tsx test/employees.test.tsx`

Expected: PASS for every query state and exact access mutation body, including the existing F1/F4/C4 regressions.

- [ ] **Step 7: Commit the Station access section**

```bash
git add apps/admin/src/pages/employees/EmployeeStationAccessSection.tsx apps/admin/src/pages/employees/EmployeeForm.tsx apps/admin/src/pages/employees/employees.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/employee-station-access.test.tsx apps/admin/test/employees.test.tsx
git commit -m "feat(admin): separate employee station access"
```

---

### Task 5: Move employee creation to a nested route panel

**Files:**

- Create: `apps/admin/src/pages/employees/EmployeeProfileForm.tsx`
- Create: `apps/admin/src/pages/employees/EmployeePanelRoute.tsx`
- Modify: `apps/admin/src/pages/employees/EmployeeForm.tsx`
- Modify: `apps/admin/src/pages/employees/index.tsx`
- Modify: `apps/admin/src/pages/employees/employees.css`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/employees-routing.test.tsx`
- Modify: `apps/admin/test/employees.test.tsx`
- Modify: `apps/admin/test/access-routing.test.tsx`

**Interfaces:**

- Produces:

```ts
export const EMPLOYEE_PROFILE_FORM_ID = "employee-profile-form";

export interface EmployeeProfileFormProps {
  mode: "create" | "edit";
  initialValues?: EmployeeFormValues;
  submitting: boolean;
  submissionError: string | null;
  onSubmit: (input: CreateEmployeeInput) => void | Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}

export interface EmployeesPanelContext {
  employees: EmployeeDto[];
  employeesPending: boolean;
  employeesError: boolean;
  retryPanelData: () => Promise<void>;
}

export type EmployeesPanelLocationState = { employeesBackground: true };
export function EmployeeCreatePanelRoute(): ReactElement;
```

- Consumes: shared `useRoutePanelGuard`, list Outlet context, and current create mutation.
- Preserves: edit remains in the composed `EmployeeForm` modal until Task 6.

- [ ] **Step 1: Write failing create-route tests**

Create a memory-router harness with `/employees` plus nested `new`. Add tests for list-origin open,
direct entry close fallback, load failure/Retry, dirty Back, pending-submit dismissal blocking,
validation, server error retention, exact create payload, and write-capability denial. The main
success test must assert:

```tsx
await user.click(await screen.findByRole("button", { name: "Добавить сотрудника" }));
expect(router.state.location.pathname).toBe("/employees/new");
const panel = screen.getByRole("dialog", { name: "Новый сотрудник" });
await user.type(within(panel).getByLabelText("ФИО"), "Анна Смирнова");
await user.click(within(panel).getByRole("button", { name: "Создать" }));
await waitFor(() =>
  expect(fetch).toHaveBeenCalledWith(
    "/api/employees",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ fullName: "Анна Смирнова", role: null }),
    }),
  ),
);
```

- [ ] **Step 2: Run routing/access tests and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/employees-routing.test.tsx test/access-routing.test.tsx`

Expected: FAIL because `/employees/new`, Outlet context, and the route panel do not exist.

- [ ] **Step 3: Extract the reusable Profile form**

Move schema, `EmployeeFormValues`, translation helper, fields, and normalization from EmployeeForm.
Track `formState.isDirty` and update the dirty ref before the clean-only reseed effect:

```tsx
const isDirtyRef = useRef(false);
useEffect(() => {
  isDirtyRef.current = isDirty;
  onDirtyChange(isDirty);
}, [isDirty, onDirtyChange]);
useEffect(() => {
  if (isDirtyRef.current) return;
  reset(initialValues ?? EMPTY_VALUES);
}, [initialValues, reset]);
```

Render only `<form id={EMPLOYEE_PROFILE_FORM_ID}>`; SidePanel/footer ownership stays in route code.
Keep the existing `toCreateInput` output exact. Update temporary `EmployeeForm` to compose this
profile form for edit mode so no profile behavior is duplicated.

- [ ] **Step 4: Implement create panel route and close fallback**

Add the established location-state contract:

```ts
export function closeEmployeePanel(location: Location, navigate: NavigateFunction) {
  if ((location.state as EmployeesPanelLocationState | null)?.employeesBackground === true) {
    void navigate(-1);
  } else {
    void navigate("/employees", { replace: true });
  }
}
```

`EmployeeCreatePanelRoute` reads Outlet context, shows standard SidePanel skeleton/error/retry,
owns create mutation and persistent error, and uses `useRoutePanelGuard`. Footer Cancel calls
`guard.requestClose`; Create submits `EMPLOYEE_PROFILE_FORM_ID`; successful create calls
`guard.finish()`.

- [ ] **Step 5: Register the route and navigate from the list**

Change `/employees` to a parent route and add:

```tsx
<Route
  path="new"
  element={
    <RequireCapability capability={C.OPERATIONS_WRITE}>
      <EmployeeCreatePanelRoute />
    </RequireCapability>
  }
/>
```

The Add action navigates to `new` with `{ employeesBackground: true }`. EmployeesPage renders
`<Outlet context={... satisfies EmployeesPanelContext} />` and exposes `query.refetch` through
`retryPanelData`.

- [ ] **Step 6: Run create route, list, and access tests**

Run: `pnpm --filter @markiro/admin exec vitest run test/employees-routing.test.tsx test/employees.test.tsx test/access-routing.test.tsx`

Expected: PASS for direct/list entry, Back/dirty/busy, exact payload, persistent error, focus return,
and unauthorized direct URL without privileged hooks.

- [ ] **Step 7: Commit the create panel migration**

```bash
git add apps/admin/src/pages/employees/EmployeeProfileForm.tsx apps/admin/src/pages/employees/EmployeePanelRoute.tsx apps/admin/src/pages/employees/EmployeeForm.tsx apps/admin/src/pages/employees/index.tsx apps/admin/src/pages/employees/employees.css apps/admin/src/app.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/employees-routing.test.tsx apps/admin/test/employees.test.tsx apps/admin/test/access-routing.test.tsx
git commit -m "feat(admin): move employee creation to a side panel"
```

---

### Task 6: Move employee editing to the multi-resource route panel

**Files:**

- Create: `apps/admin/src/pages/employees/EmployeeSectionNav.tsx`
- Modify: `apps/admin/src/pages/employees/EmployeePanelRoute.tsx`
- Modify: `apps/admin/src/pages/employees/index.tsx`
- Modify: `apps/admin/src/pages/employees/employees.css`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Delete: `apps/admin/src/pages/employees/EmployeeForm.tsx`
- Modify: `apps/admin/test/employees-routing.test.tsx`
- Modify: `apps/admin/test/employees.test.tsx`
- Modify: `apps/admin/test/employee-badges.test.tsx`
- Modify: `apps/admin/test/employee-station-access.test.tsx`
- Modify: `apps/admin/test/access-routing.test.tsx`

**Interfaces:**

- Produces:

```ts
export type EmployeeSectionId = "profile" | "badges" | "station-access";

export interface EmployeeSectionNavItem {
  id: EmployeeSectionId;
  label: string;
  meta?: ReactNode;
  hasError: boolean;
}

export interface EmployeeSectionNavProps {
  items: EmployeeSectionNavItem[];
  activeId: EmployeeSectionId;
  onNavigate: (id: EmployeeSectionId) => void;
}

export function EmployeeEditPanelRoute(): ReactElement;
```

- Consumes: Profile form and its ID, Badge/Station sections and reporting callbacks, list Outlet
  context, route guard, ConfirmDialog, and complex SidePanel.
- Removes: the last Employees `Modal` consumer and obsolete composition wrapper.

- [ ] **Step 1: Add failing edit-route and section-navigation tests**

Extend the route harness with `:employeeId/edit`. Cover list-origin edit, direct close fallback,
not-found, load Retry, exact PATCH payload, mutation error retention, dirty Back, and aggregate busy
blocking. Add a multi-resource test:

```tsx
it("keeps all employee resources mounted and navigates between named sections", async () => {
  stubEmployeeAndOperators({ employees: [JANE], operators: [ACTIVE_OPERATOR] });
  const { user } = renderPanel(["/employees/1/edit"]);

  const panel = await screen.findByRole("dialog", { name: "Изменить сотрудника" });
  expect(within(panel).getByRole("region", { name: "Профиль" })).toBeDefined();
  expect(within(panel).getByRole("region", { name: "Бейджи" })).toBeDefined();
  expect(within(panel).getByRole("region", { name: "Доступ на станцию" })).toBeDefined();

  const sectionNav = within(panel).getByRole("navigation", {
    name: "Разделы сотрудника",
  });
  const stationAccessNav = within(sectionNav).getByRole("button", {
    name: /Доступ на станцию/,
  });
  await user.click(stationAccessNav);
  expect(stationAccessNav.getAttribute("aria-current")).toBe("location");
});
```

Add a regression where non-empty badge or PIN input triggers discard even when Profile is clean,
and a pending child mutation blocks panel dismissal.

- [ ] **Step 2: Run route and access tests and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/employees-routing.test.tsx test/access-routing.test.tsx`

Expected: FAIL because the edit route and section navigation do not exist.

- [ ] **Step 3: Implement feature-local section navigation**

Render a `<nav aria-label={...}>` with real buttons. Each button exposes
`aria-current="location"` only when active, visible `meta`, and a translated error marker with an
accessible label. `onNavigate` sets the active id, calls the target heading's
`scrollIntoView({ block: "start" })`, and focuses that heading.

Inside the edit panel, register the `.mk-side-panel__body` scroll root from the first section's
`closest()` result. On scroll, choose the last section whose `offsetTop` is at or above
`scrollTop + 32` and update active id. Remove the listener on unmount. Unit tests set literal
`offsetTop` values before dispatching scroll; manual browser verification covers actual geometry.

- [ ] **Step 4: Compose edit resources and aggregate state**

In `EmployeeEditPanelRoute`, derive stable profile initial values from employee primitives. Track:

```ts
const [dirty, setDirty] = useState({ profile: false, badges: false, access: false });
const [busy, setBusy] = useState({ badges: false, access: false });
const [errors, setErrors] = useState({ profile: false, badges: false, access: false });
const [accessStatus, setAccessStatus] = useState<EmployeeAccessSectionStatus>("loading");

const panelDirty = dirty.profile || dirty.badges || dirty.access;
const panelBusy = updateMutation.isPending || busy.badges || busy.access;
```

Use stable `useCallback` setters for child reports and an effect to call
`guard.setDirty(panelDirty)`. Render all three labelled sections continuously. Section-nav metadata
is active badge count and translated access status. Profile errors come from persistent update
error/validation; child errors come from reporting callbacks.

- [ ] **Step 5: Implement edit submit and panel footer**

Use complex SidePanel. Footer Cancel calls guard request close and Save profile submits
`EMPLOYEE_PROFILE_FORM_ID`. A failed PATCH preserves every resource and sets Profile Alert; a
success retains current toast/invalidation and calls `guard.finish()`. Badge/access successes never
close the panel and recompute aggregate dirty/busy state through their callbacks.

- [ ] **Step 6: Register edit route and replace row edit state**

Add write-capability route `:employeeId/edit` rendering `EmployeeEditPanelRoute`. Row Edit navigates
with Employees background state. Remove local edit mutation/state and delete `EmployeeForm.tsx`
after no imports remain.

- [ ] **Step 7: Complete responsive CSS and copy**

Implement desktop rail plus one scrollable section column, sticky horizontal navigation below
768 px, two-to-one-column Profile grid, wrapping badge/access rows, shape-matched skeletons,
tabular identifiers, semantic headings, and no inline styles in changed Employees components.
Add lockstep RU/EN navigation labels, access statuses, panel identity, load/not-found/discard copy,
and persistent profile fallback error.

- [ ] **Step 8: Run complete focused Employees coverage**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run \
  test/employees.test.tsx \
  test/employees-routing.test.tsx \
  test/employee-badges.test.tsx \
  test/employee-station-access.test.tsx \
  test/route-panel-guard.test.tsx \
  test/access-routing.test.tsx
```

Expected: PASS with no new act, missing-translation, duplicate-key, focus-restoration, or unhandled
request warnings.

- [ ] **Step 9: Audit Employees Modal removal and commit**

Run: `rg -n "\bModal\b" apps/admin/src/pages/employees`

Expected: no matches.

```bash
git add apps/admin/src/pages/employees apps/admin/src/app.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/employees.test.tsx apps/admin/test/employees-routing.test.tsx apps/admin/test/employee-badges.test.tsx apps/admin/test/employee-station-access.test.tsx apps/admin/test/access-routing.test.tsx
git commit -m "feat(admin): move employee editing to side panels"
```

---

### Task 7: Complete verification and record evidence

**Files:**

- Modify: `docs/superpowers/plans/2026-08-06-admin-employees-redesign.md` (checkboxes and evidence only)
- Review: every file changed by Tasks 1-6

**Interfaces:**

- Produces: a review-ready Employees-only stage with explicit automated and external validation
  evidence.

- [x] **Step 1: Verify scope and source audits**

Run: `git diff --name-only origin/main...HEAD`

Expected: only shared ConfirmDialog files/tests, Employees feature/routes/i18n/tests, access routing,
and this spec/plan. No backend, database, dependency, lockfile, Kiosks, or later-wave files.

Run: `rg -n "\bModal\b" apps/admin/src/pages/employees`

Expected: no matches.

Run: `rg -n "badgeCode|accessPin" apps/admin/src/pages/employees`

Review every match manually. Expected: values exist only in transient component/form state and
request construction; no URL, storage, logging, analytics, or toast interpolation.

Evidence (2026-08-06): `git diff --name-only origin/main...HEAD` listed only the shared
ConfirmDialog files/test, the Employees Admin feature/routes/i18n/tests, access-routing test, and
this spec/plan; it contained no backend, database, dependency/lockfile, Kiosk, or later-wave paths.
`rg -n "\bModal\b" apps/admin/src/pages/employees` returned no matches. The badge/PIN source audit
returned only `BadgeDto`/`IssueBadgeInput`, the local badge issue state/request body, and current badge
display/revoke confirmation entity; there were no `accessPin` matches and no URL, storage, logging,
analytics, or toast interpolation of a badge/PIN value.

- [x] **Step 2: Run focused shared and Admin tests**

Run:

```bash
pnpm --filter @markiro/ui exec vitest run test/overlays.test.tsx
pnpm --filter @markiro/admin exec vitest run \
  test/employees.test.tsx \
  test/employees-routing.test.tsx \
  test/employee-badges.test.tsx \
  test/employee-station-access.test.tsx \
  test/route-panel-guard.test.tsx \
  test/access-routing.test.tsx
```

Expected: every test passes with zero failures and zero skips.

Evidence (2026-08-06): UI overlay test passed 1 file / 16 tests (0 failed, 0 skipped). The six
Admin focused files passed 6 files / 80 tests (0 failed, 0 skipped).

- [x] **Step 3: Run package gates**

Run each command separately:

```bash
pnpm --filter @markiro/ui test
pnpm --filter @markiro/ui typecheck
pnpm --filter @markiro/ui lint
pnpm --filter @markiro/ui build
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
```

Expected: every command exits 0. Record pre-existing jsdom, hook-dependency, or bundle-size warnings
separately; do not label them new without diff evidence.

Evidence (2026-08-06): all eight commands exited 0. UI test passed 6 files / 105 tests (0 failed,
0 skipped); UI typecheck, lint, and build were clean. Admin test passed 100 files / 463 tests (0
failed, 0 skipped); Admin typecheck and build passed. Admin test emitted 57 jsdom canvas
`getContext()` and 3 jsdom navigation-not-implemented messages. Admin lint emitted 5 existing
`react-hooks/exhaustive-deps` warnings in Boxes and Conflicts, with 0 errors and no Employees match.
The Admin build emitted its existing >500 kB chunk-size advisory. These warnings were not changed in
the reviewed Employees/UI diff.

- [x] **Step 4: Run repository hygiene checks**

Run:

```bash
pnpm format:check
git diff --check origin/main...HEAD
git diff --unified=0 origin/main...HEAD -- packages/ui apps/admin docs/superpowers \
  | rg -n '^\+[^+]' \
  | rg -n $'\u2014|\u2013'
```

Expected: formatting passes, no whitespace errors, and the added-line dash audit returns no
matches. The audit intentionally scans only added lines so pre-existing prose cannot fail it.

Evidence (2026-08-06): `pnpm format:check` passed; `git diff --check origin/main...HEAD` returned
no whitespace errors; the added-line en/em-dash audit returned no matches.

- [ ] **Step 5: Perform browser and accessibility review if infrastructure permits**

With the normal authenticated Admin API, verify `/employees`, `/employees/new`, and one real
`/employees/:id/edit` route in light and dark themes at 1440, 1024, 768, and one viewport below
768 px. Exercise status filter/reset, list-origin and direct entry, Back, close button, Escape,
backdrop, dirty discard, pending mutation blocking, Profile failure, badge issue/revoke failure,
operators pending/error/Retry, grant, PIN reset, toggle, access revoke, employee archive, section
navigation, focus restoration, long RU/EN labels, reduced motion, and no horizontal overflow.

Record screen reader, mobile virtual keyboard, browser, or infrastructure behavior not exercised.
Automated DOM tests must not be reported as manual confirmation.

Evidence (2026-08-06): the availability probe to `http://127.0.0.1:5173/` was refused. No
authenticated Admin/API infrastructure was available, started, or altered. Therefore all listed
browser, theme, viewport, keyboard, screen-reader, and mobile virtual-keyboard checks remain
unverified. Automated DOM tests are not manual or browser confirmation.

- [x] **Step 6: Review final diff and commit verification evidence**

Review `git diff --stat origin/main...HEAD` and the complete diff. Update only completed checkboxes
and factual evidence in this plan, then:

```bash
git add docs/superpowers/plans/2026-08-06-admin-employees-redesign.md
git commit -m "docs: record employee redesign verification"
```

Evidence (2026-08-06): reviewed `git diff --stat origin/main...HEAD` and the complete scoped diff,
including shared ConfirmDialog, routes, Employees components/styles/i18n, and focused test changes.
The only untriaged observation remains the deferred create-panel cached-empty refetch observation;
Task 7 intentionally does not modify it and the final whole-branch review owns triage.

## Completion Report Contract

The final handoff must list separately:

1. Behavior changed: list/filter/archive, create/edit routes, Profile, Badges, Station access,
   confirmations, dirty/busy behavior, and local navigation.
2. Files or areas changed: shared ConfirmDialog, Employees feature, route tree, i18n, and tests.
3. Automated checks: exact focused/full commands with pass/fail/skip counts.
4. Manual checks: exact routes, themes, viewport sizes, keyboard paths, and mutations exercised.
5. Checks not run: browser, assistive technology, mobile keyboard, or infrastructure limitations
   with reasons.

Do not claim Kiosks, later Admin waves, repository-wide Modal removal, or live factory/device
behavior is complete.
