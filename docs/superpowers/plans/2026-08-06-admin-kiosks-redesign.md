# Admin Kiosks Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign Admin Kiosks as a state-aware list with route-backed create, edit, and pairing panels plus a separate inline-managed Write-off reasons view.

**Architecture:** Keep `/kiosks` mounted while nested create/edit/pair routes render `SidePanel` surfaces through `<Outlet>`, and render `/kiosks/reasons` as a sibling view using the same feature-local page shell. Split profile, product availability, pairing reveal, and reasons into components that own their queries, mutations, errors, and dirty state. Keep pairing plaintext outside TanStack Query and mutation caches by using a direct request function and mounted panel-local state only.

**Tech Stack:** React 19, React Router, TanStack Query, react-hook-form, Zod, i18next, Vitest, Testing Library, vanilla CSS, `@markiro/ui`.

**Source specification:** `docs/superpowers/specs/2026-08-06-admin-kiosks-redesign.md`

## Global Constraints

- Preserve the current Kiosks, Products, and Pickup reasons API paths, request bodies, null-versus-omitted rules, query invalidation, capability checks, and success toasts.
- Keep `operations.read` on `/kiosks` and `/kiosks/reasons`; require `operations.write` for create, edit, kiosk archive, and reason mutations; require `credentials.manage` for `/kiosks/:kioskId/pair`.
- Keep the kiosk list mounted behind create, edit, and pairing panels so local filter, scroll position, and query data survive Back and explicit close.
- Opening a pairing route must never issue a code. Only an explicit Issue action may call `POST /kiosks/:id/pairing-code`.
- Keep pairing plaintext only in mounted feature-local state. Never write it to route state, TanStack query or mutation caches, browser storage, logs, analytics, error reporting, or toast copy.
- Closing, Back, Done, expiry, regeneration start, unmount, or reload must remove the visible plaintext. A failed or ambiguous regeneration must not restore the previous code.
- Failed profile, products, pairing, kiosk archive, reason create/edit, and reason delete mutations must preserve the current surface and show a persistent owning-surface error; toast-only failure handling is insufficient.
- Dirty close button, Cancel, Escape, backdrop, and Back require discard confirmation; an owning mutation in flight blocks dismissal and duplicate submission.
- Do not add a dependency, alter `pnpm-lock.yaml`, change backend or database code, remove the shared legacy `Modal`, or include Integrations or later Admin waves.
- Use matching RU and EN keys, current design tokens, IBM Plex typography, visible focus, semantic headings, tabular figures, and no color-only status.
- Use Node 24 or newer and the repository-declared pnpm 11 version through Corepack.
- Automated DOM tests do not count as browser, screen-reader, real-kiosk, or mobile-keyboard confirmation; report those separately.

## File and Responsibility Map

- `apps/admin/src/pages/kiosks/kioskState.ts`: deterministic Archived/Awaiting pairing/Online/Offline derivation and filter types.
- `apps/admin/src/pages/kiosks/KiosksLayout.tsx`: feature-local page header and route-backed Kiosks/Write-off reasons navigation.
- `apps/admin/src/pages/kiosks/index.tsx`: kiosk query, shared clock, derived-state filter, result count, table, row actions, archive confirmation, and Outlet context.
- `apps/admin/src/pages/kiosks/KioskProfileForm.tsx`: profile schema, exact payload normalization, clean-only reseeding, validation, and dirty reporting.
- `apps/admin/src/pages/kiosks/KioskProductsSection.tsx`: active-products query, local name/GTIN filter, selection baseline, exact PUT mutation, and section errors.
- `apps/admin/src/pages/kiosks/KioskSectionNav.tsx`: edit-panel desktop rail/mobile bar for Profile and Available products.
- `apps/admin/src/pages/kiosks/KioskPanelRoute.tsx`: create/edit route lookup, direct-entry fallback, profile mutations, dirty/busy aggregation, and panel-level states.
- `apps/admin/src/pages/kiosks/PairingCodeReveal.tsx`: grouped digits, lazy barcode, reserved placeholder, countdown, Copy, expiry, and local copy error.
- `apps/admin/src/pages/kiosks/KioskPairingPanelRoute.tsx`: safe pairing entry, explicit direct API request, one-time reveal ownership, regeneration, and plaintext destruction.
- `apps/admin/src/pages/kiosks/ReasonsPage.tsx`: reasons list states, one-at-a-time inline create/edit, discard handling, and delete confirmation.
- `apps/admin/src/pages/kiosks/kiosks.css`: page shell, local navigation, list, skeletons, panels, sections, pairing reveal, reasons, and responsive styles.
- `apps/admin/src/pages/kiosks/api.ts`: existing query/mutation hooks plus a direct, uncached `issueKioskPairingCode` request.
- `apps/admin/src/pages/kiosks/KioskForm.tsx`: temporary edit-modal composition during Tasks 3-4; delete in Task 5.
- `apps/admin/src/pages/kiosks/PairingCodeModal.tsx`: replace with `PairingCodeReveal.tsx` and delete in Task 6.
- `apps/admin/src/pages/kiosks/ReasonsEditor.tsx`: replace with `ReasonsPage.tsx` and delete in Task 2.
- `apps/admin/src/app.tsx`: reasons sibling route and nested capability-gated create/edit/pair routes.
- `apps/admin/src/i18n/{ru,en}.json`: lockstep navigation, state, panel, product, pairing, reason, confirmation, and error copy.
- `apps/admin/test/kiosks.test.tsx`: list state, local filtering, page states, archive, capability, and retained API regressions.
- `apps/admin/test/kiosks-routing.test.tsx`: nested create/edit routes, direct entry, Back, dirty/busy, load, not-found, and section navigation.
- `apps/admin/test/kiosk-products.test.tsx`: product query states, filtering, selection, exact save body, and dirty/error behavior.
- `apps/admin/test/kiosk-pairing.test.tsx`: safe entry, explicit issue, reveal lifecycle, regeneration, expiry, cache exclusion, and routing.
- `apps/admin/test/kiosk-reasons.test.tsx`: reasons route, read-only state, inline create/edit, refetch protection, validation, discard, and delete.
- `apps/admin/test/kiosks-pairing-placeholder.test.tsx`: deterministic lazy-barcode placeholder regression against `PairingCodeReveal`.
- `apps/admin/test/access-routing.test.tsx`: direct child-route denial and privileged-hook/request isolation.
- `docs/superpowers/plans/2026-08-06-admin-kiosks-redesign.md`: implementation checklist and verification evidence.

---

### Task 1: Align the kiosk list, operational state, and archive flow

**Files:**

- Create: `apps/admin/src/pages/kiosks/kioskState.ts`
- Create: `apps/admin/src/pages/kiosks/kiosks.css`
- Modify: `apps/admin/src/pages/kiosks/index.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/kiosks.test.tsx`

**Interfaces:**

- Produces:

```ts
export type KioskOperationalState = "archived" | "awaiting-pairing" | "online" | "offline";
export type KioskStateFilter = "all" | KioskOperationalState;
export const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;
export function getKioskOperationalState(
  kiosk: Pick<KioskDto, "status" | "enrolled" | "lastSeenAt">,
  nowMs: number,
): KioskOperationalState;
export function formatRelativeLastSeen(iso: string, nowMs: number, language: string): string;
```

- Consumes: existing `useKiosks`, `useArchiveKiosk`, `AdminPage`, `FilterBar`, `RowActions`, and `ConfirmDialog.error`.
- Preserves temporarily: current create/edit/pairing modals, product query, and embedded Reasons editor until later tasks.

- [ ] **Step 1: Replace the broad Response helper and add failing state/filter tests**

Use native responses in `kiosks.test.tsx`:

```ts
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

Add deterministic tests for all four operational states and the exact filter contract:

```tsx
it("distinguishes awaiting pairing from an enrolled offline kiosk", async () => {
  const now = Date.parse("2026-08-06T10:00:00.000Z");
  vi.setSystemTime(now);
  stubFetch({
    kiosks: [
      { ...OFFLINE_KIOSK, id: "awaiting", enrolled: false, lastSeenAt: null },
      {
        ...OFFLINE_KIOSK,
        id: "offline",
        enrolled: true,
        lastSeenAt: new Date(now - ONLINE_THRESHOLD_MS - 1).toISOString(),
      },
    ],
    products: [],
    reasons: [],
  });
  renderPage();

  expect(await screen.findByText("Ожидает привязки")).toBeDefined();
  expect(screen.getByText("Не в сети")).toBeDefined();
});

it("filters the fetched rows without adding query parameters", async () => {
  const fetchMock = stubFetch({ kiosks: [ONLINE_KIOSK, OFFLINE_KIOSK], products: [], reasons: [] });
  const user = userEvent.setup();
  renderPage();

  await chooseOption(user, "Состояние", "В сети");
  expect(screen.getByText(ONLINE_KIOSK.name)).toBeDefined();
  expect(screen.queryByText(OFFLINE_KIOSK.name)).toBeNull();
  const kioskCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/kiosks"));
  expect(kioskCalls).toHaveLength(1);
  expect(kioskCalls[0]?.[0]).toBe("/api/kiosks");
});
```

Also cover Archived precedence, an enrolled recent kiosk at the exact threshold, Never activity,
Reset, filtered empty state, and a shared clock tick moving a row from Online to Offline.

- [ ] **Step 2: Add a failing persistent archive-error test**

```tsx
it("keeps kiosk archive confirmation open with the server error", async () => {
  stubFetch({
    kiosks: [ONLINE_KIOSK],
    products: [],
    reasons: [],
    onPost: (_path, init) =>
      init?.method === "DELETE"
        ? jsonResponse(409, { message: "Kiosk has pending pickup work" })
        : undefined,
  });
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole("button", { name: "В архив" }));
  const dialog = screen.getByRole("alertdialog", { name: "Отправить киоск в архив?" });
  await user.click(within(dialog).getByRole("button", { name: "В архив" }));

  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "Kiosk has pending pickup work",
  );
});
```

- [ ] **Step 3: Run the focused list tests and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/kiosks.test.tsx`

Expected: FAIL because unenrolled is shown as Offline, there is no state filter/shared clock, and archive still uses `Modal` with toast-only failure.

- [ ] **Step 4: Implement deterministic state derivation and one shared clock**

Create `kioskState.ts`:

```ts
import type { KioskDto } from "./api.js";

export type KioskOperationalState = "archived" | "awaiting-pairing" | "online" | "offline";
export type KioskStateFilter = "all" | KioskOperationalState;
export const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

export function getKioskOperationalState(
  kiosk: Pick<KioskDto, "status" | "enrolled" | "lastSeenAt">,
  nowMs: number,
): KioskOperationalState {
  if (kiosk.status === "archived") return "archived";
  if (!kiosk.enrolled) return "awaiting-pairing";
  if (!kiosk.lastSeenAt) return "offline";
  return nowMs - new Date(kiosk.lastSeenAt).getTime() <= ONLINE_THRESHOLD_MS ? "online" : "offline";
}

export function formatRelativeLastSeen(iso: string, nowMs: number, language: string): string {
  const seconds = Math.round((new Date(iso).getTime() - nowMs) / 1000);
  const locale = language.startsWith("ru") ? "ru-RU" : "en-US";
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}
```

In `KiosksPage`, keep one timer and reuse its timestamp for rows, count, and filter:

```tsx
const [nowMs, setNowMs] = useState(() => Date.now());
useEffect(() => {
  const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
  return () => window.clearInterval(timer);
}, []);

const visibleItems = items.filter((kiosk) => {
  if (stateFilter === "all") return true;
  return getKioskOperationalState(kiosk, nowMs) === stateFilter;
});
```

- [ ] **Step 5: Adopt shared page primitives and state-aware table copy**

Use `AdminPage data-testid="kiosks-page"`, `FilterBar`, a state `Select`, result summary, Retry,
all-empty and filtered-empty states, a table-shaped skeleton, and `RowActions`. Show state with
`StatusChip`; render `formatRelativeLastSeen` inside `<time dateTime={lastSeenAt}>`, with absolute
`formatCreatedAt(lastSeenAt, i18n.language)` available as its title and accessible supporting copy.
Render translated Never when no timestamp exists. Use tabular figures for daily limit.

Keep the temporary modal create/edit/pair controls functional. Do not alter their request paths or
payloads in this task.

- [ ] **Step 6: Replace kiosk archive Modal with ConfirmDialog**

Keep mutation ownership inside the authorized row action and use persistent local state:

```tsx
<ConfirmDialog
  open={archiving}
  title={t("pages.kiosks.archiveConfirmTitle")}
  description={t("pages.kiosks.archiveConfirmBody", { name: kiosk.name })}
  entity={kiosk.name}
  error={archiveError}
  cancelLabel={t("pages.kiosks.cancel")}
  confirmLabel={t("pages.kiosks.archiveConfirmAction")}
  tone="destructive"
  busy={archiveMutation.isPending}
  onCancel={cancelArchive}
  onConfirm={() => void handleArchive()}
/>
```

Failure uses `ApiRequestError.message` or a translated persistent fallback. Success retains the
current invalidation and toast and does not reset the selected filter.

- [ ] **Step 7: Add lockstep copy, CSS, and run GREEN checks**

Add RU/EN state labels, filter label/options/Reset, result pluralization, last activity/Never,
filtered empty, Retry, and persistent archive fallback. Put page, filter, table skeleton, identity,
activity, count, and responsive rules in `kiosks.css` using existing tokens.

Run: `pnpm --filter @markiro/admin exec vitest run test/kiosks.test.tsx`

Run: `pnpm --filter @markiro/admin typecheck`

Expected: PASS for derivation, clock transition, filter/no-query-parameter behavior, read-only hook isolation, states, and archive success/failure.

- [ ] **Step 8: Commit the list foundation**

```bash
git add apps/admin/src/pages/kiosks/kioskState.ts apps/admin/src/pages/kiosks/kiosks.css apps/admin/src/pages/kiosks/index.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/kiosks.test.tsx
git commit -m "style(admin): align kiosk list with admin pages"
```

---

### Task 2: Split Write-off reasons into a route-backed view

**Files:**

- Create: `apps/admin/src/pages/kiosks/KiosksLayout.tsx`
- Create: `apps/admin/src/pages/kiosks/ReasonsPage.tsx`
- Modify: `apps/admin/src/pages/kiosks/index.tsx`
- Modify: `apps/admin/src/pages/kiosks/kiosks.css`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Delete: `apps/admin/src/pages/kiosks/ReasonsEditor.tsx`
- Create: `apps/admin/test/kiosk-reasons.test.tsx`
- Modify: `apps/admin/test/kiosks.test.tsx`
- Modify: `apps/admin/test/access-routing.test.tsx`

**Interfaces:**

- Produces:

```ts
export interface KiosksLayoutProps {
  actions?: ReactNode;
  children: ReactNode;
  onViewNavigate?: (to: "/kiosks" | "/kiosks/reasons") => void;
}
export function KiosksLayout(props: KiosksLayoutProps): ReactElement;
export function ReasonsPage(): ReactElement;
```

- Route contract: `/kiosks/reasons` is a sibling of the nested-panel `/kiosks` branch and is protected by `operations.read`.
- Capability contract: mutation hooks mount only inside an `AuthorizedReasonsEditor` child rendered for `operations.write`.

- [ ] **Step 1: Write failing route/navigation and query-isolation tests**

Create a memory-router harness using the real route tree and native Response objects. Assert:

```tsx
it("moves reasons to a route-backed sibling view", async () => {
  const fetchMock = stubFetch({ kiosks: [ONLINE_KIOSK], reasons: [REASON_A] });
  const { router } = renderKiosksRouter("/kiosks");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("link", { name: "Причины списания" }));
  expect(router.state.location.pathname).toBe("/kiosks/reasons");
  expect(screen.getByRole("link", { name: "Причины списания" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(await screen.findByText(REASON_A.name)).toBeDefined();
  expect(screen.queryByText(ONLINE_KIOSK.name)).toBeNull();
  expect(fetchMock).not.toHaveBeenCalledWith("/api/kiosks", expect.anything());
});
```

Also assert the kiosk view no longer fetches `/pickup-reasons`, Kiosks uses `end` matching so it is
not current on `/kiosks/reasons`, and a direct read-only reasons URL mounts no reason mutation hooks.

- [ ] **Step 2: Add failing inline create/edit/delete tests**

Cover one-at-a-time editing, exact payloads, persistent errors, and dirty-draft protection:

```tsx
it("keeps a failed reason edit in its row with the exact payload", async () => {
  stubReasonPatch(409, { message: "Reason is referenced" });
  renderKiosksRouter("/kiosks/reasons");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Изменить" }));
  await user.clear(screen.getByLabelText("Название"));
  await user.type(screen.getByLabelText("Название"), "Повреждение упаковки");
  await user.clear(screen.getByLabelText("Порядок"));
  await user.type(screen.getByLabelText("Порядок"), "7");
  await user.click(screen.getByRole("button", { name: "Сохранить" }));

  expect(fetch).toHaveBeenCalledWith(
    `/api/pickup-reasons/${REASON_A.id}`,
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "Повреждение упаковки", sortOrder: 7 }),
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain("Reason is referenced");
  expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe(
    "Повреждение упаковки",
  );
});
```

Add cases for whitespace-only name, blank/non-finite order validation, query refetch not overwriting
a dirty row, switching edits opening discard confirmation, a non-empty create draft guarding local
view navigation, create sending exactly `{ name }`, and delete failure remaining in `ConfirmDialog`.

- [ ] **Step 3: Run reasons and access tests and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/kiosk-reasons.test.tsx test/kiosks.test.tsx test/access-routing.test.tsx`

Expected: FAIL because reasons are embedded, every row is simultaneously editable, errors are toast-only, and there is no route navigation.

- [ ] **Step 4: Implement the feature-local layout and sibling route**

`KiosksLayout` is a presentational wrapper used by both pages:

```tsx
import type { MouseEvent as ReactMouseEvent } from "react";

export function KiosksLayout({ actions, children, onViewNavigate }: KiosksLayoutProps) {
  const { t } = useTranslation();
  const handleClick =
    (to: "/kiosks" | "/kiosks/reasons") => (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (!onViewNavigate) return;
      event.preventDefault();
      onViewNavigate(to);
    };
  return (
    <AdminPage className="mk-kiosks-page">
      <PageHeader title={t("pages.kiosks.title")} actions={actions} />
      <nav className="mk-kiosks-view-nav" aria-label={t("pages.kiosks.views.label")}>
        <NavLink end to="/kiosks" onClick={handleClick("/kiosks")}>
          {t("pages.kiosks.views.kiosks")}
        </NavLink>
        <NavLink to="/kiosks/reasons" onClick={handleClick("/kiosks/reasons")}>
          {t("pages.kiosks.views.reasons")}
        </NavLink>
      </nav>
      {children}
    </AdminPage>
  );
}
```

Wrap `KiosksPage` in this component and remove `<ReasonsEditor />`. Register a separate
`kiosks/reasons` route under `operations.read`.

- [ ] **Step 5: Implement focused inline reason state**

Use one create draft and one edit draft, not a map for every row:

```ts
type ReasonDraft = { name: string; sortOrder: string };
const [createOpen, setCreateOpen] = useState(false);
const [newName, setNewName] = useState("");
const [editId, setEditId] = useState<string | null>(null);
const [editDraft, setEditDraft] = useState<ReasonDraft | null>(null);
```

Validate trimmed name and finite integer order before mutation. Seed the edit draft only when edit
starts or after successful save/cancel, so background refetch cannot overwrite dirty input. Keep
create, edit, and delete errors in their row/dialog. Disable competing mutation controls while any
reason mutation is pending.

- [ ] **Step 6: Add discard and delete confirmations**

When another Edit or local-view navigation would replace a non-empty create draft or dirty edit
draft, show the established discard `ConfirmDialog`. Derive one `hasDirtyDraft` value from the
trimmed create name and the active edit draft versus its server baseline. `ReasonsPage` passes
`onViewNavigate` to `KiosksLayout`; a clean request navigates immediately, while a dirty request
stores the destination and navigates only after confirmation. Delete uses:

```tsx
<ConfirmDialog
  open={deleteTarget !== null}
  title={t("pages.kiosks.reasons.archiveConfirmTitle")}
  description={t("pages.kiosks.reasons.archiveConfirmBody", { name: deleteTarget?.name })}
  entity={deleteTarget?.name}
  error={deleteError}
  cancelLabel={t("pages.kiosks.cancel")}
  confirmLabel={t("pages.kiosks.reasons.archiveConfirmAction")}
  tone="destructive"
  busy={archiveMutation.isPending}
  onCancel={cancelDelete}
  onConfirm={() => void confirmDelete()}
/>
```

- [ ] **Step 7: Add copy/styles and run GREEN checks**

Add lockstep navigation, page states, Retry, inline validation, edit/cancel/save, discard, and
persistent fallback copy. Style the local nav, reason table, inline row, errors, and mobile wrapping
in `kiosks.css`.

Run: `pnpm --filter @markiro/admin exec vitest run test/kiosk-reasons.test.tsx test/kiosks.test.tsx test/access-routing.test.tsx`

Run: `pnpm --filter @markiro/admin typecheck`

Expected: PASS; kiosk and reason queries are isolated by route and read-only users mount no mutations.

- [ ] **Step 8: Delete the embedded editor and commit**

```bash
git add apps/admin/src/pages/kiosks/KiosksLayout.tsx apps/admin/src/pages/kiosks/ReasonsPage.tsx apps/admin/src/pages/kiosks/index.tsx apps/admin/src/pages/kiosks/kiosks.css apps/admin/src/app.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/kiosk-reasons.test.tsx apps/admin/test/kiosks.test.tsx apps/admin/test/access-routing.test.tsx
git rm apps/admin/src/pages/kiosks/ReasonsEditor.tsx
git commit -m "feat(admin): separate kiosk write-off reasons"
```

---

### Task 3: Move kiosk creation to a nested route panel

**Files:**

- Create: `apps/admin/src/pages/kiosks/KioskProfileForm.tsx`
- Create: `apps/admin/src/pages/kiosks/KioskPanelRoute.tsx`
- Modify: `apps/admin/src/pages/kiosks/KioskForm.tsx`
- Modify: `apps/admin/src/pages/kiosks/index.tsx`
- Modify: `apps/admin/src/pages/kiosks/kiosks.css`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/kiosks-routing.test.tsx`
- Modify: `apps/admin/test/kiosks.test.tsx`
- Modify: `apps/admin/test/access-routing.test.tsx`

**Interfaces:**

- Produces:

```ts
export const KIOSK_PROFILE_FORM_ID = "kiosk-profile-form";
export type KioskFormValues = z.infer<typeof kioskFormSchema>;
export interface KioskProfileFormProps {
  initialValues?: KioskFormValues;
  submitting: boolean;
  submissionError: string | null;
  onSubmit: (input: CreateKioskInput) => void | Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}
export interface KiosksPanelContext {
  kiosks: KioskDto[];
  kiosksPending: boolean;
  kiosksError: boolean;
  kiosksResolved: boolean;
  retryPanelData: () => Promise<void>;
}
export type KiosksPanelLocationState = { kiosksBackground: true };
export function KioskCreatePanelRoute(): ReactElement;
```

- Consumes: `SidePanel`, `useRoutePanelGuard`, current Zod rules, `useCreateKiosk`, and Kiosks Outlet context.
- Temporary behavior: successful create closes to the list in this task; Task 6 adds the credential-manager Set up pairing continuation once the safe pairing route exists.

- [ ] **Step 1: Write failing create-route tests**

Create a memory-router harness with `/kiosks` plus nested `new`. Cover list-origin open, direct-entry
close fallback, initial load failure/Retry, dirty close/Back, pending dismissal blocking, validation,
server error retention, exact payload, focus restoration, and unauthorized direct access.

```tsx
it("creates through the nested panel with the exact normalized payload", async () => {
  const { router } = renderKiosksRouter("/kiosks");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Добавить киоск" }));
  expect(router.state.location.pathname).toBe("/kiosks/new");
  const panel = screen.getByRole("dialog", { name: "Новый киоск" });
  await user.type(within(panel).getByLabelText("Название"), "  Киоск склада  ");
  await user.type(within(panel).getByLabelText("Расположение"), "  Цех 2  ");
  await user.clear(within(panel).getByLabelText("Лимит позиций на сотрудника в день"));
  await user.type(within(panel).getByLabelText("Лимит позиций на сотрудника в день"), "8");
  await user.click(within(panel).getByRole("button", { name: "Создать" }));

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/kiosks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Киоск склада",
          location: "Цех 2",
          dayLimitPerEmployee: 8,
          showPrices: true,
        }),
      }),
    ),
  );
});
```

- [ ] **Step 2: Run routing and access tests and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/kiosks-routing.test.tsx test/access-routing.test.tsx`

Expected: FAIL because `/kiosks/new`, Outlet context, and the route panel do not exist.

- [ ] **Step 3: Extract the profile form with clean-only reseeding**

Move schema, values, translation helper, fields, and normalization from `KioskForm`. Track dirty
before reseeding so same-commit input cannot be reset:

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

Render only `<form id={KIOSK_PROFILE_FORM_ID}>`; the route owns SidePanel/footer. Export a
`toKioskInput` result typed as `CreateKioskInput`, since its complete object is valid for both create
and update. Temporarily compose this form inside edit-only `KioskForm` so profile behavior is not
duplicated.

- [ ] **Step 4: Implement create panel state, guard, and close fallback**

```ts
export function closeKioskPanel(location: Location, navigate: NavigateFunction) {
  if ((location.state as KiosksPanelLocationState | null)?.kiosksBackground === true) {
    void navigate(-1);
  } else {
    void navigate("/kiosks", { replace: true });
  }
}
```

`KioskCreatePanelRoute` shows a standard panel skeleton or persistent load error/Retry when the base
list has no usable data, owns `useCreateKiosk` and its persistent error, and uses
`useRoutePanelGuard`. Cancel calls `guard.requestClose`; Create submits `KIOSK_PROFILE_FORM_ID`;
success calls `guard.finish()` in this task.

- [ ] **Step 5: Register the nested route and expose Outlet context**

Make `/kiosks` a parent route and add:

```tsx
<Route
  path="new"
  element={
    <RequireCapability capability={C.OPERATIONS_WRITE}>
      <KioskCreatePanelRoute />
    </RequireCapability>
  }
/>
```

The Add action navigates to `new` with `{ kiosksBackground: true }`. `KiosksPage` renders an Outlet
with list data, resolved state, and `retryPanelData: async () => { await query.refetch(); }`. The
sibling `/kiosks/reasons` route remains outside this parent branch.

- [ ] **Step 6: Add translations/styles and run GREEN checks**

Add panel load/Retry, discard, persistent create error, and direct-entry copy. Add standard-panel
skeleton and profile-grid styles.

Run: `pnpm --filter @markiro/admin exec vitest run test/kiosks-routing.test.tsx test/kiosks.test.tsx test/access-routing.test.tsx`

Run: `pnpm --filter @markiro/admin typecheck`

Expected: PASS for route entry/exit, dirty/busy behavior, exact payload, error retention, and capability denial.

- [ ] **Step 7: Commit the create panel migration**

```bash
git add apps/admin/src/pages/kiosks/KioskProfileForm.tsx apps/admin/src/pages/kiosks/KioskPanelRoute.tsx apps/admin/src/pages/kiosks/KioskForm.tsx apps/admin/src/pages/kiosks/index.tsx apps/admin/src/pages/kiosks/kiosks.css apps/admin/src/app.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/kiosks-routing.test.tsx apps/admin/test/kiosks.test.tsx apps/admin/test/access-routing.test.tsx
git commit -m "feat(admin): move kiosk creation to a side panel"
```

---

### Task 4: Extract independently recoverable product availability

**Files:**

- Create: `apps/admin/src/pages/kiosks/KioskProductsSection.tsx`
- Modify: `apps/admin/src/pages/kiosks/KioskForm.tsx`
- Modify: `apps/admin/src/pages/kiosks/index.tsx`
- Modify: `apps/admin/src/pages/kiosks/kiosks.css`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/kiosk-products.test.tsx`
- Modify: `apps/admin/test/kiosks.test.tsx`

**Interfaces:**

- Produces:

```ts
export interface KioskProductsSectionProps {
  kiosk: KioskDto;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onErrorChange: (hasError: boolean) => void;
}
```

- Consumes: `useProducts({ status: "active" })`, `useSetKioskProducts`, and the exact `{ productIds }` request contract.
- Temporary consumer: edit-only `KioskForm` passes reporting callbacks until Task 5 composes them in the route panel.

- [ ] **Step 1: Write failing product query-state and save tests**

Create a focused QueryClient harness. Cover Pending, Error/Retry, empty success, selected count,
local name/GTIN filtering, hidden selection retention, dirty reporting, and persistent save failure.

```tsx
it("keeps selected ids hidden by the local filter and sends the exact list", async () => {
  renderProductsSection({ ...ONLINE_KIOSK, productIds: [PRODUCT_A.id] }, [PRODUCT_A, PRODUCT_B]);
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText("Поиск по товарам"), PRODUCT_B.gtin14);
  expect(screen.queryByRole("checkbox", { name: PRODUCT_A.name })).toBeNull();
  await user.click(screen.getByRole("checkbox", { name: PRODUCT_B.name }));
  await user.clear(screen.getByLabelText("Поиск по товарам"));
  expect((screen.getByRole("checkbox", { name: PRODUCT_A.name }) as HTMLInputElement).checked).toBe(
    true,
  );
  await user.click(screen.getByRole("button", { name: "Сохранить список" }));

  expect(fetch).toHaveBeenCalledWith(
    `/api/kiosks/${ONLINE_KIOSK.id}/products`,
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ productIds: [PRODUCT_A.id, PRODUCT_B.id] }),
    }),
  );
});
```

Assert deterministic output order follows the active catalog order, not Set insertion accidents.
Assert a 409 preserves selection and displays its server message in the section.

- [ ] **Step 2: Run the product test and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/kiosk-products.test.tsx`

Expected: FAIL because the section does not exist and product errors are toast-only.

- [ ] **Step 3: Implement independent query and selection baselines**

Move the products query into this section so `/kiosks`, `/kiosks/new`, and reasons do not fetch it.
Track selection and a saved baseline:

```ts
const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(kiosk.productIds));
const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set(kiosk.productIds));
const dirty = !sameIds(selectedIds, savedIds);
```

Reseed only while clean and when the kiosk identity/server product IDs change. Filter locally with
normalized lowercase name or exact substring GTIN matching. Build the save array by filtering the
loaded product list by `selectedIds.has(product.id)` so request order is stable.

- [ ] **Step 4: Implement explicit states and success-only baseline reset**

Pending renders a section skeleton and no save. Error renders Alert plus `void query.refetch()` and
no empty list. Empty success explains that Catalog has no active products. Failure preserves
selection and sets a persistent error. Success sets `savedIds` to the submitted IDs, retains the
panel/modal, invalidates through the existing hook, and shows the existing success toast.

Report dirty, busy, and error through effects with stable callback props.

- [ ] **Step 5: Integrate into the temporary edit modal and remove list-level product fetching**

Replace the old checkbox block in `KioskForm` with:

```tsx
<KioskProductsSection
  kiosk={kiosk}
  onDirtyChange={() => undefined}
  onBusyChange={() => undefined}
  onErrorChange={() => undefined}
/>
```

Remove `useProducts` and product props from `KiosksPage`, create action, and row actions. Product
data now loads only when the edit surface mounts.

- [ ] **Step 6: Add copy/styles and run GREEN checks**

Add RU/EN section loading/error/Retry/empty, local search, selected count, and persistent save copy.
Style section state, product list, identity/GTIN, search, selected count, and mobile actions.

Run: `pnpm --filter @markiro/admin exec vitest run test/kiosk-products.test.tsx test/kiosks.test.tsx`

Run: `pnpm --filter @markiro/admin typecheck`

Expected: PASS; base kiosk and create flows make no Products request, while edit retains exact PUT behavior.

- [ ] **Step 7: Commit the product section**

```bash
git add apps/admin/src/pages/kiosks/KioskProductsSection.tsx apps/admin/src/pages/kiosks/KioskForm.tsx apps/admin/src/pages/kiosks/index.tsx apps/admin/src/pages/kiosks/kiosks.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/kiosk-products.test.tsx apps/admin/test/kiosks.test.tsx
git commit -m "feat(admin): separate kiosk product availability"
```

---

### Task 5: Move kiosk editing to the complex route panel

**Files:**

- Create: `apps/admin/src/pages/kiosks/KioskSectionNav.tsx`
- Modify: `apps/admin/src/pages/kiosks/KioskPanelRoute.tsx`
- Modify: `apps/admin/src/pages/kiosks/index.tsx`
- Modify: `apps/admin/src/pages/kiosks/kiosks.css`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Delete: `apps/admin/src/pages/kiosks/KioskForm.tsx`
- Modify: `apps/admin/test/kiosks-routing.test.tsx`
- Modify: `apps/admin/test/kiosks.test.tsx`
- Modify: `apps/admin/test/kiosk-products.test.tsx`
- Modify: `apps/admin/test/access-routing.test.tsx`

**Interfaces:**

- Produces:

```ts
export type KioskSectionId = "profile" | "products";
export interface KioskSectionNavItem {
  id: KioskSectionId;
  label: string;
  meta?: string;
  hasError: boolean;
}
export interface KioskSectionNavProps {
  items: KioskSectionNavItem[];
  activeId: KioskSectionId;
  onActivate: (id: KioskSectionId) => void;
}
export function KioskEditPanelRoute(): ReactElement;
```

- Consumes: `KioskProfileForm`, `KioskProductsSection`, `useUpdateKiosk`, `useRoutePanelGuard`, and Kiosks Outlet context.
- Aggregates: Profile and Products dirty/busy/error state without coupling their save actions.

- [ ] **Step 1: Add failing edit-route and section-navigation tests**

Cover list-origin Edit, direct entry, direct close fallback, list load failure/Retry, not-found,
archived kiosk inspection, exact profile PATCH, persistent error, products remaining mounted, section
navigation, dirty Back, and any-section busy dismissal blocking.

```tsx
it("keeps product work independent when profile update fails", async () => {
  stubKioskPatch(409, { message: "Name already exists" });
  const { router } = renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/edit`);
  const user = userEvent.setup();

  const panel = await screen.findByRole("dialog", { name: "Изменить киоск" });
  await user.clear(within(panel).getByLabelText("Название"));
  await user.type(within(panel).getByLabelText("Название"), "Новый склад");
  await user.click(within(panel).getByRole("button", { name: "Сохранить" }));

  expect((await within(panel).findByRole("alert")).textContent).toContain("Name already exists");
  expect((within(panel).getByLabelText("Название") as HTMLInputElement).value).toBe("Новый склад");
  expect(within(panel).getByRole("region", { name: "Доступная продукция" })).toBeDefined();
  expect(router.state.location.pathname).toBe(`/kiosks/${ONLINE_KIOSK.id}/edit`);
});
```

- [ ] **Step 2: Run route, product, and access tests and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/kiosks-routing.test.tsx test/kiosk-products.test.tsx test/access-routing.test.tsx`

Expected: FAIL because edit remains a centered modal and there is no nested edit route/section navigation.

- [ ] **Step 3: Implement edit route lookup and panel-level states**

Add `KioskEditPanelRoute`, keyed by route ID to avoid cross-entity form reuse. Resolve from Outlet
context and render:

```tsx
if (context.kiosksPending || (context.kiosksError && !context.kiosksResolved)) {
  return <KioskPanelState mode="edit" />;
}
if (!kiosk) {
  return <KioskNotFoundPanel onClose={close} />;
}
return <KioskEditPanelContent kiosk={kiosk} />;
```

Use complex SidePanel and show kiosk name plus derived state in the header area. Archived kiosks may
render profile/products but no Pair or Archive action in the panel.

- [ ] **Step 4: Aggregate independent section state and save paths**

Track flags by section:

```ts
type SectionFlags = { profile: boolean; products: boolean };
const [dirty, setDirty] = useState<SectionFlags>({ profile: false, products: false });
const [busy, setBusy] = useState<SectionFlags>({ profile: false, products: false });
const [errors, setErrors] = useState<SectionFlags>({ profile: false, products: false });
const guard = useRoutePanelGuard(close, mutation.isPending || busy.products);
const setGuardDirty = guard.setDirty;
useEffect(() => {
  setGuardDirty(dirty.profile || dirty.products);
}, [dirty.profile, dirty.products, setGuardDirty]);
```

Profile footer Save submits only `KIOSK_PROFILE_FORM_ID`; successful PATCH uses `guard.finish()` and
closes. Product Save remains inside its section, resets only product dirty state, and keeps the
panel open. Any profile/product mutation blocks dismissal and duplicate owning actions.

- [ ] **Step 5: Implement continuously mounted section navigation**

Build items with Profile and Products selected count/Loading/Error metadata. Section activation
scrolls and focuses its heading:

```ts
function activateSection(id: KioskSectionId) {
  const heading = sectionRefs.current[id];
  heading?.scrollIntoView({ block: "start" });
  heading?.focus({ preventScroll: true });
}
```

Track the active section from panel-body scroll or IntersectionObserver with a deterministic
fallback in tests. Do not conditionally unmount either section.

- [ ] **Step 6: Register route, navigate row actions, and delete the modal wrapper**

Add `:kioskId/edit` under the `/kiosks` parent with `operations.write`. Edit navigates with
`{ kiosksBackground: true }`. Remove all `KioskForm` imports/call sites and delete the file.

- [ ] **Step 7: Add copy/styles and run GREEN checks**

Add RU/EN not-found, section navigation, Profile/Products section titles, selected/loading/error
metadata, and persistent profile fallback. Style complex layout, rail/mobile bar, focusable
headings, section borders, responsive grids, and full-screen behavior.

Run: `pnpm --filter @markiro/admin exec vitest run test/kiosks-routing.test.tsx test/kiosks.test.tsx test/kiosk-products.test.tsx test/access-routing.test.tsx`

Run: `pnpm --filter @markiro/admin typecheck`

Expected: PASS for route fallback, lookup, independent resources, dirty/busy behavior, section navigation, and authorization.

- [ ] **Step 8: Commit the edit panel migration**

```bash
git add apps/admin/src/pages/kiosks/KioskSectionNav.tsx apps/admin/src/pages/kiosks/KioskPanelRoute.tsx apps/admin/src/pages/kiosks/index.tsx apps/admin/src/pages/kiosks/kiosks.css apps/admin/src/app.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/kiosks-routing.test.tsx apps/admin/test/kiosks.test.tsx apps/admin/test/kiosk-products.test.tsx apps/admin/test/access-routing.test.tsx
git rm apps/admin/src/pages/kiosks/KioskForm.tsx
git commit -m "feat(admin): move kiosk editing to a side panel"
```

---

### Task 6: Replace pairing modal with a safe one-time route panel

**Files:**

- Create: `apps/admin/src/pages/kiosks/PairingCodeReveal.tsx`
- Create: `apps/admin/src/pages/kiosks/KioskPairingPanelRoute.tsx`
- Modify: `apps/admin/src/pages/kiosks/api.ts`
- Modify: `apps/admin/src/pages/kiosks/KioskPanelRoute.tsx`
- Modify: `apps/admin/src/pages/kiosks/index.tsx`
- Modify: `apps/admin/src/pages/kiosks/kiosks.css`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Delete: `apps/admin/src/pages/kiosks/PairingCodeModal.tsx`
- Create: `apps/admin/test/kiosk-pairing.test.tsx`
- Modify: `apps/admin/test/kiosks-pairing-placeholder.test.tsx`
- Modify: `apps/admin/test/kiosks-routing.test.tsx`
- Modify: `apps/admin/test/kiosks.test.tsx`
- Modify: `apps/admin/test/access-routing.test.tsx`

**Interfaces:**

- Produces:

```ts
export async function issueKioskPairingCode(id: string): Promise<IssuePairingCodeResult>;
export interface PairingCodeRevealProps {
  code: string;
  expiresAt: string;
  regenerating: boolean;
  onRegenerate: () => void;
  onExpired: () => void;
}
export function KioskPairingPanelRoute(): ReactElement;
```

- Removes: `useIssueKioskPairingCode`; TanStack mutation state must not retain plaintext.
- Consumes: Kiosks Outlet context, `credentials.manage`, direct `apiFetch`, lazy `PairingBarcode`, and the existing reserved box constants.

- [ ] **Step 1: Write failing safe-entry and capability tests**

Assert route activation and direct entry perform only `GET /kiosks` until explicit issue:

```tsx
it("opens the pairing panel without issuing a code", async () => {
  const fetchMock = stubFetch({ kiosks: [ONLINE_KIOSK] });
  const { router } = renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);

  const panel = await screen.findByRole("dialog", { name: "Привязка киоска" });
  expect(within(panel).getByRole("button", { name: "Сформировать код" })).toBeDefined();
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) =>
        String(url) === `/api/kiosks/${ONLINE_KIOSK.id}/pairing-code` &&
        (init as RequestInit | undefined)?.method === "POST",
    ),
  ).toBe(false);
  expect(router.state.location.pathname).toBe(`/kiosks/${ONLINE_KIOSK.id}/pair`);
});
```

Add direct read-only/operations-writer denial, credential-manager allowance, archived unavailable
without request, list-origin Back, and direct-entry Close fallback.

- [ ] **Step 2: Write failing reveal, expiry, regeneration, and cache-exclusion tests**

Cover explicit POST, grouped digits, raw copy, barcode label/placeholder, countdown without per-second
live announcements, expiry removal, Done destruction, reload no-code state, and persistent errors.

The ambiguous regeneration test is mandatory:

```tsx
it("discards the previous plaintext before a failed regeneration settles", async () => {
  stubPairingSequence([
    jsonResponse(201, { code: "12345678", expiresAt: futureExpiry() }),
    jsonResponse(503, { message: "Gateway timeout" }),
  ]);
  renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Сформировать код" }));
  expect(await screen.findByText("1234 5678")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Сформировать новый" }));

  expect(screen.queryByText("1234 5678")).toBeNull();
  expect((await screen.findByRole("alert")).textContent).toContain("Gateway timeout");
});
```

After successful issue, assert `queryClient.getMutationCache().getAll()` and query data contain no
`12345678`, route state contains no code, and local/session storage remain unchanged.

- [ ] **Step 3: Run pairing, routing, placeholder, and access tests and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/kiosk-pairing.test.tsx test/kiosks-pairing-placeholder.test.tsx test/kiosks-routing.test.tsx test/access-routing.test.tsx`

Expected: FAIL because the row action mints immediately, pairing uses a centered modal, and the TanStack mutation can retain returned plaintext.

- [ ] **Step 4: Replace the mutation hook with a direct uncached request**

In `api.ts`, export only the promise-returning request:

```ts
export function issueKioskPairingCode(id: string): Promise<IssuePairingCodeResult> {
  return apiFetch<IssuePairingCodeResult>(`/kiosks/${id}/pairing-code`, { method: "POST" });
}
```

Remove `useIssueKioskPairingCode`. The route controller owns `busy`, `error`, and reveal state with
`useState`; no QueryClient mutation object ever receives the response.

- [ ] **Step 5: Extract a presentation-only live reveal**

Move grouping, countdown, lazy barcode, reserved Suspense placeholder, and Copy into
`PairingCodeReveal`. Keep its interval derived from wall clock. On expiry call `onExpired` once and
render no digits/barcode/Copy. Copy failure uses component-local Alert state, not a toast.

Render the eight digits as one accessible value while keeping the visual `1234 5678` grouping.
Preserve `pairingBarcodeBoxStyle` for identical pending and loaded dimensions.

- [ ] **Step 6: Implement pairing route state machine and secret destruction**

Use explicit states:

```ts
type PairingReveal = { code: string; expiresAt: string } | null;
const [reveal, setReveal] = useState<PairingReveal>(null);
const [expired, setExpired] = useState(false);
const [busy, setBusy] = useState(false);
const [error, setError] = useState<string | null>(null);

async function issue(regenerating: boolean) {
  if (regenerating) setReveal(null);
  setExpired(false);
  setBusy(true);
  setError(null);
  try {
    const next = await issueKioskPairingCode(kiosk.id);
    setReveal(next);
  } catch (cause) {
    setReveal(null);
    setError(
      cause instanceof ApiRequestError ? cause.message : t("pages.kiosks.pairing.issueError"),
    );
  } finally {
    setBusy(false);
  }
}
```

The safe entry shows explanation plus Issue. Live reveal shows Regenerate and Done. Close/Back/Done
calls `setReveal(null)` before route close. Pending blocks close, Escape, backdrop, and duplicate
issue. `PairingCodeReveal.onExpired` sets `reveal` to null and `expired` to true so the route renders
the explicit expired Alert plus Issue new code, rather than returning silently to the initial state.
Unmount relies on component-state destruction and performs no persistence or cleanup write.

- [ ] **Step 7: Register the route and change list Pair to navigation**

Add `:kioskId/pair` under `/kiosks` with `credentials.manage`. The row action navigates with
`{ kiosksBackground: true }` and performs no request. It remains visible only for active kiosks and
credential managers.

- [ ] **Step 8: Complete the create-to-pair continuation**

Update `KioskCreatePanelRoute` to retain only the returned non-secret `KioskDto` after success. For
a credential manager, call `guard.setDirty(false)` and replace the form with Done and Set up
pairing; do not call `guard.finish()` until Done. Set up pairing replaces the URL and preserves the
background marker:

```ts
void navigate(`/kiosks/${created.id}/pair`, {
  replace: true,
  state: (location.state as KiosksPanelLocationState | null)?.kiosksBackground
    ? ({ kiosksBackground: true } satisfies KiosksPanelLocationState)
    : null,
});
```

The transition still does not issue a code. A user without `credentials.manage` follows the existing
success close path. Add tests for both capability branches and double-submit prevention.

- [ ] **Step 9: Add copy/styles and run GREEN checks**

Add lockstep safe-entry, invalidation warning, Issue, reveal, expiry, regeneration failure,
unavailable, Done, Copy failure, and post-create continuation copy. Style the pairing panel,
monospace code, reserved barcode region, countdown, local state, and mobile layout.

Update `kiosks-pairing-placeholder.test.tsx` to render `PairingCodeReveal` and retain exact width,
height, digits, and Copy assertions.

Run: `pnpm --filter @markiro/admin exec vitest run test/kiosk-pairing.test.tsx test/kiosks-pairing-placeholder.test.tsx test/kiosks-routing.test.tsx test/kiosks.test.tsx test/access-routing.test.tsx`

Run: `pnpm --filter @markiro/admin typecheck`

Expected: PASS for safe entry, capability isolation, one-time lifecycle, cache exclusion, create continuation, and lazy barcode behavior.

- [ ] **Step 10: Delete the modal and commit**

```bash
git add apps/admin/src/pages/kiosks/PairingCodeReveal.tsx apps/admin/src/pages/kiosks/KioskPairingPanelRoute.tsx apps/admin/src/pages/kiosks/api.ts apps/admin/src/pages/kiosks/KioskPanelRoute.tsx apps/admin/src/pages/kiosks/index.tsx apps/admin/src/pages/kiosks/kiosks.css apps/admin/src/app.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/kiosk-pairing.test.tsx apps/admin/test/kiosks-pairing-placeholder.test.tsx apps/admin/test/kiosks-routing.test.tsx apps/admin/test/kiosks.test.tsx apps/admin/test/access-routing.test.tsx
git rm apps/admin/src/pages/kiosks/PairingCodeModal.tsx
git commit -m "feat(admin): move kiosk pairing to a safe side panel"
```

---

### Task 7: Run final gates and record verification limits

**Files:**

- Modify only if evidence needs correction: `docs/superpowers/plans/2026-08-06-admin-kiosks-redesign.md`

**Interfaces:**

- Consumes: all feature contracts from Tasks 1-6.
- Produces: a clean, reviewable branch with automated evidence and explicit manual/external limits.

- [ ] **Step 1: Run focused Kiosks tests together**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run \
  test/kiosks.test.tsx \
  test/kiosks-routing.test.tsx \
  test/kiosk-products.test.tsx \
  test/kiosk-pairing.test.tsx \
  test/kiosks-pairing-placeholder.test.tsx \
  test/kiosk-reasons.test.tsx \
  test/access-routing.test.tsx
```

Expected: PASS with no skipped Kiosks cases.

- [ ] **Step 2: Run Admin package gates**

```bash
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
```

Expected: all PASS. Report jsdom canvas or navigation notices separately if they remain non-failing
test-environment limitations.

- [ ] **Step 3: Run format, diff, and scope audits**

```bash
pnpm format:check
git diff --check origin/main...HEAD
rg -n '\bModal\b' apps/admin/src/pages/kiosks
git status --short
git diff --stat origin/main...HEAD
```

Expected: formatting and diff checks PASS; no `Modal` import or call site remains in the Kiosks
feature; status contains only intended tracked changes; no lockfile, backend, database, generated
output, or unrelated Admin wave is present.

- [ ] **Step 4: Review exact security and API invariants in the final diff**

Inspect that:

```text
GET    /kiosks
POST   /kiosks
PATCH  /kiosks/:id
DELETE /kiosks/:id
PUT    /kiosks/:id/products   body: { productIds }
POST   /kiosks/:id/pairing-code only after explicit user action
GET    /pickup-reasons
POST   /pickup-reasons        body: { name }
PATCH  /pickup-reasons/:id    body: { name, sortOrder }
DELETE /pickup-reasons/:id
```

Search the final diff for pairing `code` writes and confirm every occurrence is transient render,
clipboard, barcode, or request-response handling inside the mounted pairing feature. Confirm there
is no code in route state, QueryClient, storage, logging, analytics, or toast calls.

- [ ] **Step 5: Perform manual browser validation when infrastructure is available**

With an authenticated Admin/API, check RU and EN plus light and dark themes at 1440, 1024, 768, and
one viewport below 768 px. Exercise:

```text
Kiosks/Reasons navigation; every state filter; list and filtered empty states;
create/edit/direct URL/not-found/load Retry; Profile and Products independent failures;
dirty close via button/Escape/backdrop/Back; pending close blocking;
safe pairing entry; issue/copy/barcode/expiry/regenerate failure/Done/reload;
reason create/edit validation/refetch protection/discard/delete failure;
keyboard traversal, focus restoration, long RU/EN wrapping, reduced motion, and no overflow.
```

If no authenticated browser is available, record this as not performed. Do not infer visual,
screen-reader, mobile-keyboard, or real-device confirmation from DOM tests.

- [ ] **Step 6: Perform real-kiosk validation only with authorized hardware**

Verify separately that one displayed code redeems, regeneration rejects the prior code, and expiry
is rejected. If hardware or an authorized environment is unavailable, record the check as not run;
do not simulate a claim of device confirmation.

- [ ] **Step 7: Commit any verification-evidence correction**

If this plan document was updated with actual evidence, commit only that file:

```bash
git add docs/superpowers/plans/2026-08-06-admin-kiosks-redesign.md
git commit -m "docs(admin): record kiosk redesign verification"
```

If no file changed, do not create an empty commit.
