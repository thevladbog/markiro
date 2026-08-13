# Kiosk Touch Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current kiosk screens with the approved dark, fully touch, fixed-viewport flow for pairing, branded badge login, mixed KM/SSCC cart, operation choice, confirmation, and honest server/offline outcomes.

**Architecture:** Keep scanner parsing and business rules in pure session reducers, make `App` a small explicit state machine, and render each approved screen as a focused component over shared kiosk primitives. CSS uses `@markiro/ui` dark tokens with orientation-based grids; large collections page rather than scroll. Queue/journal semantics remain authoritative for offline recovery, while the UI maps server, transport and quarantine outcomes to distinct semantic states.

**Tech Stack:** React 19, Vite, TypeScript strict mode, `@markiro/ui`, i18next, IndexedDB, HID/Web Serial scanner sources, Vitest + Testing Library, Playwright/browser acceptance.

**Spec:** `docs/superpowers/specs/2026-08-13-kiosk-self-service-redesign-design.md`

**Depends on:**

- `docs/superpowers/plans/2026-08-13-kiosk-policy-and-branding.md`
- `docs/superpowers/plans/2026-08-13-kiosk-sscc-orders.md`

## Global Constraints

- Supported minima: 480×800 portrait and 800×480 landscape.
- `html`, `body`, `#root`, shell and active screen stay fixed to `100dvh`; no page scroll.
- Cart pages show 5 rows at 480×800 and 3 rows at 800×480.
- Primary action is neutral light-on-dark; green only after server acceptance, amber for queued, red for refusal.
- Every semantic status includes icon and text; never encode status by color alone.
- Pair code is exactly 8 digits with a touch keypad and scanner input.
- Login landscape uses equal columns: centered animation left, left-aligned copy right.
- Company logo falls back to bundled Markiro; all fonts/assets are bundled.
- A box is one non-expandable line with no partial quantity control.
- Operation choice happens after cart creation and is skipped when `canWriteoff=false`.
- Final CTA copy is `Подтвердить N бутылок`, never `Отправить`.
- Respect `prefers-reduced-motion`, keyboard focus, RU/EN localization and 48 px touch targets.

---

### Task 1: Introduce an explicit kiosk session state machine

**Files:**

- Create: `apps/kiosk/src/session/flow.ts`
- Create: `apps/kiosk/test/flow.test.ts`
- Modify: `apps/kiosk/src/App.tsx`
- Modify: `apps/kiosk/test/app.test.tsx`
- Modify: `apps/kiosk/test/app-view.test.ts`

**Interfaces:**

- Produces `KioskFlowState`, `KioskFlowAction`, `kioskFlowReducer`.
- Separates `pairing`, `login`, `cart`, `operation`, `reason`, `confirmation`, and `outcome` states.
- Cart/session data survives Back transitions but is cleared on confirmed cancel/logout/idle reset.

- [ ] **Step 1: Write failing reducer transition tests**

```ts
it("skips operation choice for an employee without writeoff permission", () => {
  const state = inCart({ canWriteoff: false, lines: [bottleLine] });
  expect(kioskFlowReducer(state, { type: "continue" })).toMatchObject({
    screen: "confirmation",
    reason: "buy",
  });
});

it("requires a reason before confirming a writeoff", () => {
  const state = inOperation({ canWriteoff: true, lines: [boxLine] });
  const writeoff = kioskFlowReducer(state, { type: "chooseOperation", reason: "writeoff" });
  expect(writeoff.screen).toBe("reason");
  expect(kioskFlowReducer(writeoff, { type: "continue" })).toBe(writeoff);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/kiosk exec vitest run test/flow.test.ts test/app.test.tsx test/app-view.test.ts
```

Expected: FAIL because `session/flow.ts` does not exist.

- [ ] **Step 3: Implement the discriminated state and pure transitions**

```ts
export type KioskScreen =
  "pairing" | "login" | "cart" | "operation" | "reason" | "confirmation" | "outcome";

export type KioskOutcome =
  | { kind: "accepted"; orderNo: string; bottleCount: number; totalKopecks: number | null }
  | { kind: "queued"; deviceSeq: number; bottleCount: number }
  | { kind: "rejected"; title: string; message: string; bottleCount: number | null }
  | {
      kind: "partial";
      orderNo: string;
      acceptedBottleCount: number;
      rejectedLines: KioskCartLine[];
    };

export interface KioskEmployee {
  id: string;
  fullName: string;
  limitMode: "limited" | "unlimited";
  dayLimit: number;
  canWriteoff: boolean;
}

export interface ActiveKioskSession {
  employee: KioskEmployee;
  cart: KioskCartState;
  reason: "buy" | "writeoff";
  writeoffReasonId: string | null;
}
```

`continue` branches on `employee.canWriteoff`; `chooseOperation(writeoff)` goes
to reasons; `back` returns confirmation → reason/operation/cart without losing
lines; `finish`, confirmed cancel, and idle reset return to `login`.

- [ ] **Step 4: Re-run reducer and app tests**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/flow.test.ts test/app.test.tsx test/app-view.test.ts
pnpm --filter @markiro/kiosk typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the flow model**

```bash
git add apps/kiosk/src/session/flow.ts apps/kiosk/src/App.tsx apps/kiosk/test/flow.test.ts apps/kiosk/test/app.test.tsx apps/kiosk/test/app-view.test.ts
git commit -m "refactor(kiosk): model self-service screen flow"
```

---

### Task 2: Redesign pairing and branded login

**Files:**

- Create: `apps/kiosk/src/ui/MarkiroLogo.tsx`
- Create: `apps/kiosk/src/ui/BadgeScanAnimation.tsx`
- Create: `apps/kiosk/src/store/branding.ts`
- Modify: `apps/kiosk/src/screens/Pairing.tsx`
- Modify: `apps/kiosk/src/screens/Idle.tsx`
- Modify: `apps/kiosk/src/store/cache.ts`
- Modify: `apps/kiosk/src/kiosk.css`
- Modify: `apps/kiosk/src/i18n/ru.json`
- Modify: `apps/kiosk/src/i18n/en.json`
- Modify: `apps/kiosk/test/pairing-screen.test.tsx`
- Modify: `apps/kiosk/test/idle-screen.test.tsx`
- Create: `apps/kiosk/test/branding.test.ts`

**Interfaces:**

- `loadCachedBranding(): Promise<{organizationName:string; logoBlob:Blob|null; revision:string|null}>`.
- Pairing owns an eight-cell code plus keypad actions `digit`, `clear`, `backspace`.
- `BadgeScanAnimation` has no visible «scan zone» label and disables motion through CSS media query.

- [ ] **Step 1: Write failing pairing, fallback, cache, and landscape-alignment tests**

```tsx
it("enables pairing only after exactly eight digits", async () => {
  renderPairing();
  const submit = screen.getByRole("button", { name: "Подключить киоск" });
  expect(submit).toBeDisabled();
  for (const digit of "48120735") await user.click(screen.getByRole("button", { name: digit }));
  expect(submit).toBeEnabled();
  expect(readPairCode()).toBe("48120735");
});

it("uses bundled Markiro when the cached company logo cannot be decoded", async () => {
  seedBranding({ organizationName: "Северная вода", logoBlob: brokenBlob });
  renderIdle();
  expect(await screen.findByLabelText("Маркиро")).toBeVisible();
  expect(screen.getByText("Северная вода")).toBeVisible();
});
```

- [ ] **Step 2: Run focused screen/store tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/pairing-screen.test.tsx test/idle-screen.test.tsx test/branding.test.ts
```

Expected: FAIL with missing keypad/branding components.

- [ ] **Step 3: Implement keypad state, same-origin logo cache, and login grid**

```ts
export function nextPairCode(
  current: string,
  action: { type: "digit"; digit: string } | { type: "clear" } | { type: "backspace" },
): string {
  if (action.type === "clear") return "";
  if (action.type === "backspace") return current.slice(0, -1);
  return current.length < 8 && /^\d$/.test(action.digit) ? current + action.digit : current;
}
```

Use `.kiosk-login__center` as a one-column portrait grid and a two equal-column
landscape grid. Place animation in column 1 with `justify-self:center`; place
eyebrow/title/copy in column 2 with `justify-self:stretch;text-align:left`.
Fetch a changed logo revision after bootstrap, verify `image/webp`, persist the
blob, and keep the previous valid blob when refresh fails.

- [ ] **Step 4: Re-run tests, reduced-motion assertion, and typecheck**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/pairing-screen.test.tsx test/idle-screen.test.tsx test/branding.test.ts test/i18n.test.tsx
pnpm --filter @markiro/kiosk typecheck
```

Expected: PASS; no string «Зона сканирования»/«Scan zone» remains.

- [ ] **Step 5: Commit pairing and login**

```bash
git add apps/kiosk/src/ui/MarkiroLogo.tsx apps/kiosk/src/ui/BadgeScanAnimation.tsx apps/kiosk/src/store/branding.ts apps/kiosk/src/store/cache.ts apps/kiosk/src/screens/Pairing.tsx apps/kiosk/src/screens/Idle.tsx apps/kiosk/src/kiosk.css apps/kiosk/src/i18n apps/kiosk/test
git commit -m "feat(kiosk): add touch pairing and branded login"
```

---

### Task 3: Replace the cart reducer with mixed atomic lines

**Files:**

- Modify: `apps/kiosk/src/domain-guard/classify.ts`
- Modify: `apps/kiosk/src/session/cart.ts`
- Create: `apps/kiosk/src/session/pagination.ts`
- Modify: `apps/kiosk/test/classify.test.ts`
- Modify: `apps/kiosk/test/cart.test.ts`
- Create: `apps/kiosk/test/pagination.test.ts`

**Interfaces:**

- `KioskScan` gains `{kind:"sscc"; sscc:string}` from shared `classifyScan`.
- `KioskCartLine = LooseKmLine | BoxLine` and state property is `lines`.
- `pageSizeFor(width,height)` returns 5 portrait and 3 landscape at supported minima.
- `remainingBottles` returns `number | null`, where `null` means unlimited.

- [ ] **Step 1: Write failing box/loose overlap, limit, remove, and pagination tests**

```ts
it("rejects the whole new box when one member is already loose", () => {
  const state = withLines([looseLine({ kmKey: "member-2" })]);
  const next = cartReducer(
    state,
    { type: "scanBox", box: boxLine({ contentKeys: ["member-1", "member-2"] }) },
    unlimitedContext,
  );
  expect(next.lines).toEqual(state.lines);
  expect(next.notice).toEqual({ kind: "duplicate-box" });
});

it("rejects a twelve-bottle box when only five remain", () => {
  const next = cartReducer(emptyCart(), { type: "scanBox", box: twelveBottleBox }, limitedFive);
  expect(next.lines).toEqual([]);
  expect(next.notice).toEqual({ kind: "limit", requested: 12, remaining: 5 });
});

it.each([
  [480, 800, 5],
  [800, 480, 3],
])("uses %i×%i page size", (width, height, expected) => {
  expect(pageSizeFor(width, height)).toBe(expected);
});
```

- [ ] **Step 2: Run focused pure tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/classify.test.ts test/cart.test.ts test/pagination.test.ts
```

Expected: FAIL because state contains loose `items` only.

- [ ] **Step 3: Implement discriminated lines and bottle-based calculations**

```ts
export interface LooseKmLine {
  kind: "km";
  rawKm: string;
  kmKey: string;
  gtin14: string;
  serial: string;
  productId: string;
  name: string;
  unitPrice: string | null;
  bottleCount: 1;
}

export interface BoxLine {
  kind: "box";
  boxId: string;
  sscc: string;
  productId: string;
  name: string;
  bottleCount: number;
  unitPrice: string | null;
  contentKeys: readonly string[];
  registryVersion: string;
}

export type KioskCartLine = LooseKmLine | BoxLine;
```

Compute cart bottle count with `sum(line.bottleCount)`, positions with
`lines.length`, box total as `unitPrice * bottleCount`, and overlap through one
`Set` of all accepted content keys. Removing a box filters one line by SSCC;
there is no quantity action.

- [ ] **Step 4: Re-run pure tests and typecheck**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/classify.test.ts test/cart.test.ts test/pagination.test.ts test/day-count.test.ts
pnpm --filter @markiro/kiosk typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit mixed cart rules**

```bash
git add apps/kiosk/src/domain-guard/classify.ts apps/kiosk/src/session/cart.ts apps/kiosk/src/session/pagination.ts apps/kiosk/test/classify.test.ts apps/kiosk/test/cart.test.ts apps/kiosk/test/pagination.test.ts apps/kiosk/test/day-count.test.ts
git commit -m "feat(kiosk): model mixed KM and box cart"
```

---

### Task 4: Build the fixed-viewport scan/cart screen and paging primitives

**Files:**

- Create: `apps/kiosk/src/ui/ItemKindIcon.tsx`
- Create: `apps/kiosk/src/ui/PagedLines.tsx`
- Create: `apps/kiosk/src/ui/CartLineDialog.tsx`
- Modify: `apps/kiosk/src/screens/Cart.tsx`
- Modify: `apps/kiosk/src/kiosk.css`
- Modify: `apps/kiosk/src/i18n/ru.json`
- Modify: `apps/kiosk/src/i18n/en.json`
- Modify: `apps/kiosk/test/cart-screen.test.tsx`
- Modify: `apps/kiosk/test/kiosk-layout.test.tsx`
- Modify: `apps/kiosk/test/i18n.test.tsx`

**Interfaces:**

- `PagedLines<T>` takes `items`, `pageSize`, `page`, `onPageChange`, `renderItem`.
- `ItemKindIcon` renders accessible type label plus decorative SVG.
- `CartLineDialog` removes one loose line or one whole box after explicit confirmation.

- [ ] **Step 1: Write failing UI density, icon, ellipsis, pager, and dialog tests**

```tsx
it("renders five portrait lines and keeps totals visible", () => {
  setViewport(480, 800);
  renderCart({ lines: sixLines });
  expect(screen.getAllByRole("button", { name: /Открыть позицию/ })).toHaveLength(5);
  expect(screen.getByText("1 / 2")).toBeVisible();
  expect(screen.getByRole("button", { name: "Продолжить" })).toBeVisible();
});

it("uses a box icon without exposing SSCC as the type label", () => {
  renderCart({ lines: [twelveBottleBox] });
  expect(screen.getByLabelText("Короб")).toBeVisible();
  expect(screen.queryByText(/^SSCC$/)).not.toBeInTheDocument();
  expect(screen.getByText("12 шт")).toBeVisible();
});
```

- [ ] **Step 2: Run focused component/layout tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/cart-screen.test.tsx test/kiosk-layout.test.tsx test/i18n.test.tsx
```

Expected: FAIL because the current list scrolls and has no box line.

- [ ] **Step 3: Implement the shared list primitives and approved grid**

```tsx
<PagedLines
  items={state.lines}
  pageSize={pageSizeFor(viewport.width, viewport.height)}
  page={page}
  onPageChange={setPage}
  renderItem={(line) => (
    <button
      type="button"
      className="kiosk-line"
      aria-label={t("cart.openLine", { name: line.name, count: line.bottleCount })}
      onClick={() => setSelected(line)}
    >
      <ItemKindIcon kind={line.kind} />
      <span className="kiosk-line__name">{line.name}</span>
      <span className="kiosk-line__count">{line.bottleCount} шт</span>
    </button>
  )}
/>
```

At 480×800 use 30 px statusbar, 65 px session header, 158 px feedback, flexible
basket with five 58 px rows plus pager, and 116 px checkout. At 800×480 use a
45/55 two-column main area, three 55 px rows, and 96 px checkout across both
columns. Hide price elements entirely when `showPrices=false`; do not render a
substitute zero value.

- [ ] **Step 4: Re-run component tests and kiosk typecheck**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/cart-screen.test.tsx test/kiosk-layout.test.tsx test/i18n.test.tsx
pnpm --filter @markiro/kiosk typecheck
```

Expected: PASS for 5/3 rows, first/last pager disabled state, long text, hidden
prices, unlimited copy and whole-box removal.

- [ ] **Step 5: Commit scan/cart UI**

```bash
git add apps/kiosk/src/ui/ItemKindIcon.tsx apps/kiosk/src/ui/PagedLines.tsx apps/kiosk/src/ui/CartLineDialog.tsx apps/kiosk/src/screens/Cart.tsx apps/kiosk/src/kiosk.css apps/kiosk/src/i18n apps/kiosk/test/cart-screen.test.tsx apps/kiosk/test/kiosk-layout.test.tsx apps/kiosk/test/i18n.test.tsx
git commit -m "feat(kiosk): build paged touch cart"
```

---

### Task 5: Add operation, reason, and confirmation screens

**Files:**

- Create: `apps/kiosk/src/screens/OperationChoice.tsx`
- Create: `apps/kiosk/src/screens/WriteoffReason.tsx`
- Create: `apps/kiosk/src/screens/Confirmation.tsx`
- Modify: `apps/kiosk/src/App.tsx`
- Modify: `apps/kiosk/src/kiosk.css`
- Modify: `apps/kiosk/src/i18n/ru.json`
- Modify: `apps/kiosk/src/i18n/en.json`
- Create: `apps/kiosk/test/operation-choice.test.tsx`
- Create: `apps/kiosk/test/writeoff-reason.test.tsx`
- Create: `apps/kiosk/test/confirmation.test.tsx`

**Interfaces:**

- `OperationChoice` emits `buy`, `writeoff`, `back`, `cancel`.
- `WriteoffReason` pages active reasons in groups of six and emits one id.
- `Confirmation` emits `back` and `confirm`, shows the operation label exactly once, and reuses `PagedLines`.

- [ ] **Step 1: Write failing branching, reason paging, copy, and duplicate-label tests**

```tsx
it("shows operation mode exactly once on confirmation", () => {
  renderConfirmation({ reason: "buy", bottleCount: 14 });
  expect(screen.getAllByText("Через кассу")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Подтвердить 14 бутылок" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Отправить/ })).not.toBeInTheDocument();
});

it("pages more than six writeoff reasons without scrolling", async () => {
  renderReasons(sevenReasons);
  expect(screen.getByText("1 / 2")).toBeVisible();
  expect(screen.queryByText(sevenReasons[6]!.name)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Далее" }));
  expect(screen.getByText(sevenReasons[6]!.name)).toBeVisible();
});
```

- [ ] **Step 2: Run focused screen tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/operation-choice.test.tsx test/writeoff-reason.test.tsx test/confirmation.test.tsx
```

Expected: FAIL because the screens do not exist.

- [ ] **Step 3: Implement touch cards, reason grid, and final summary**

```tsx
<button type="button" className="kiosk-choice" onClick={() => onChoose("buy")}>
  <span aria-hidden="true">₽</span>
  <strong>{t("operation.buy.title")}</strong>
  <small>{t("operation.buy.description")}</small>
</button>
```

Only mount `OperationChoice` for `canWriteoff=true`. Disable reason continuation
until one active id is selected. Confirmation computes positions, bottles and
money from cart selectors, displays box/loose composition, and disables its CTA
from pointer-down until `enqueueOrder` settles.

- [ ] **Step 4: Re-run screen, app, and i18n tests**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/operation-choice.test.tsx test/writeoff-reason.test.tsx test/confirmation.test.tsx test/app.test.tsx test/i18n.test.tsx
pnpm --filter @markiro/kiosk typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the pre-confirmation flow**

```bash
git add apps/kiosk/src/screens/OperationChoice.tsx apps/kiosk/src/screens/WriteoffReason.tsx apps/kiosk/src/screens/Confirmation.tsx apps/kiosk/src/App.tsx apps/kiosk/src/kiosk.css apps/kiosk/src/i18n apps/kiosk/test
git commit -m "feat(kiosk): confirm cash and writeoff operations"
```

---

### Task 6: Implement honest accepted, queued, rejected, and partial outcomes

**Files:**

- Modify: `apps/kiosk/src/screens/Done.tsx`
- Create: `apps/kiosk/src/screens/Outcome.tsx`
- Modify: `apps/kiosk/src/sync/worker.ts`
- Modify: `apps/kiosk/src/store/journal.ts`
- Modify: `apps/kiosk/src/store/queue.ts`
- Modify: `apps/kiosk/src/App.tsx`
- Modify: `apps/kiosk/src/kiosk.css`
- Modify: `apps/kiosk/src/i18n/ru.json`
- Modify: `apps/kiosk/src/i18n/en.json`
- Modify: `apps/kiosk/test/done-screen.test.tsx`
- Modify: `apps/kiosk/test/sync.test.ts`
- Modify: `apps/kiosk/test/journal.test.ts`
- Modify: `apps/kiosk/test/store.test.ts`

**Interfaces:**

- `JournalEntry` records accepted boxes, box conflicts, employee, kiosk, counts and server outcome.
- Unviewed terminal/partial results are discoverable by employee on next badge login.
- `Outcome` maps accepted→ok, queued→warn, rejected/partial→err without recoloring neutral controls.

- [ ] **Step 1: Write failing semantic-color, queue, rejection, and restart tests**

```tsx
it("never renders queued work as success", () => {
  renderOutcome({ kind: "queued", deviceSeq: 17, bottleCount: 14 });
  expect(screen.getByRole("status")).toHaveAttribute("data-tone", "warning");
  expect(screen.getByText("Это ещё не подтверждённый успех")).toBeVisible();
  expect(screen.queryByText("Товары приняты")).not.toBeInTheDocument();
});

it("describes a rejected box without exposing members", () => {
  renderRejectedBox({ sscc, bottleCount: 12, reason: "duplicate" });
  expect(screen.getByText(/12 бутылок не попали/)).toBeVisible();
  expect(screen.queryByText(memberRawKm)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run focused outcome/sync/store tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/done-screen.test.tsx test/sync.test.ts test/journal.test.ts test/store.test.ts
```

Expected: FAIL because current Done conflates server and offline completion.

- [ ] **Step 3: Persist and render distinct outcomes**

```ts
export type StoredKioskResult =
  | { kind: "accepted"; employeeId: string; orderNo: string; acceptedCount: number }
  | {
      kind: "partial";
      employeeId: string;
      orderNo: string;
      acceptedCount: number;
      rejected: StoredRejectedLine[];
    }
  | { kind: "rejected"; employeeId: string; deviceSeq: number; rejected: StoredRejectedLine[] };
```

Write server results before dequeue, mark them `viewedAt=null`, and show the
oldest unviewed result immediately after the same employee badges in. An online
timeout/network failure remains queued amber because the request may have been
accepted. A terminal conflict moves to quarantine and becomes red; a box
conflict stores SSCC/count/reason only.

- [ ] **Step 4: Re-run focused tests and full kiosk suite**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/done-screen.test.tsx test/sync.test.ts test/journal.test.ts test/store.test.ts test/app.test.tsx
pnpm --filter @markiro/kiosk test
```

Expected: PASS; accepted green appears only when a server result exists.

- [ ] **Step 5: Commit outcomes and recovery**

```bash
git add apps/kiosk/src/screens/Done.tsx apps/kiosk/src/screens/Outcome.tsx apps/kiosk/src/sync/worker.ts apps/kiosk/src/store apps/kiosk/src/App.tsx apps/kiosk/src/kiosk.css apps/kiosk/src/i18n apps/kiosk/test
git commit -m "feat(kiosk): distinguish server and offline outcomes"
```

---

### Task 7: Finish fixed-viewport, accessibility, and browser acceptance

**Files:**

- Modify: `apps/kiosk/src/ui/KioskShell.tsx`
- Modify: `apps/kiosk/src/ui/KioskLayout.tsx`
- Modify: `apps/kiosk/src/ui/StatusStrip.tsx`
- Modify: `apps/kiosk/src/kiosk.css`
- Modify: `apps/kiosk/test/kiosk-layout.test.tsx`
- Modify: `apps/kiosk/test/i18n.test.tsx`
- Create: `apps/kiosk/test/touch-flow.test.tsx`

**Interfaces:**

- Shell exposes one bounded active screen and status live region.
- Below supported minima it renders the diagnostic size screen.
- Browser acceptance covers every state at both exact minimum viewports.

- [ ] **Step 1: Add failing unsupported-size, focus, reduced-motion, and no-scroll tests**

```tsx
it("shows a bounded diagnostic below the supported portrait minimum", () => {
  setViewport(479, 799);
  renderApp();
  expect(screen.getByRole("heading", { name: "Экран устройства слишком мал" })).toBeVisible();
  expect(screen.getByText("479 × 799")).toBeVisible();
});

it("keeps status text alongside every semantic icon", () => {
  renderOutcome({ kind: "accepted", orderNo: "K-1", bottleCount: 1, totalKopecks: 7400 });
  expect(screen.getByRole("status")).toHaveTextContent("Подтверждено сервером");
  expect(screen.getByRole("status").querySelector("svg")).not.toBeNull();
});
```

- [ ] **Step 2: Run layout/touch-flow tests and confirm RED**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/kiosk-layout.test.tsx test/touch-flow.test.tsx test/i18n.test.tsx
```

Expected: FAIL for unsupported-size and new semantic states.

- [ ] **Step 3: Finalize token-only CSS, focus order, live regions, and motion**

```css
html,
body,
#root,
.kiosk-shell {
  width: 100%;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

@media (prefers-reduced-motion: reduce) {
  .kiosk-badge-scan__beam {
    animation: none;
    transform: translateY(31px);
  }
  .kiosk-control {
    transition: none !important;
  }
}
```

Use only `@markiro/ui` surface, foreground, line, semantic, spacing, radius and
focus tokens. Primary CTA uses `--surface-inverse`/`--fg-on-inverse`; do not use
`--accent` for ordinary actions.

- [ ] **Step 4: Run package gates and browser acceptance at exact viewports**

Run:

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/kiosk test
pnpm --filter @markiro/kiosk typecheck
pnpm --filter @markiro/kiosk lint
pnpm --filter @markiro/kiosk build
```

Then run the real Vite app and exercise pairing, login, mixed cart, 100-line
pagination, operation choice, reasons, confirmation, accepted, queued, rejected
and partial states at 480×800 and 800×480. In each state assert:

```js
document.documentElement.scrollHeight === window.innerHeight;
document.querySelector(".kiosk-screen").scrollHeight ===
  document.querySelector(".kiosk-screen").clientHeight;
```

Expected: PASS; 5 portrait and 3 landscape rows, CTA always visible, no clipped
copy or out-of-bounds focus ring.

- [ ] **Step 5: Commit the final UI acceptance slice**

```bash
git add apps/kiosk/src apps/kiosk/test docs/superpowers/plans/2026-08-13-kiosk-touch-flow.md
git commit -m "feat(kiosk): complete fixed touch self-service flow"
```

---

### Task 8: Run cross-package final gates and record external limits

**Files:**

- Verify only; do not add build output or browser caches.

**Interfaces:**

- Consumes all three implementation plans.
- Produces the merge-ready automated result; physical scanner/PWA acceptance remains separate.

- [ ] **Step 1: Run shared dependency builds**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db build
pnpm --filter @markiro/ui build
```

Expected: PASS.

- [ ] **Step 2: Run affected package gates**

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/db test
pnpm --filter @markiro/api test
pnpm --filter @markiro/admin test
pnpm --filter @markiro/kiosk test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/kiosk typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/db lint
pnpm --filter @markiro/api lint
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/kiosk lint
```

Expected: PASS; name and explain every skipped DB test.

- [ ] **Step 3: Run builds and repository hygiene checks**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db build
pnpm --filter @markiro/api build
pnpm --filter @markiro/admin build
pnpm --filter @markiro/kiosk build
pnpm format:check
git diff --check
git status --short
```

Expected: PASS; only intentional source/tests/docs/migrations are tracked.

- [ ] **Step 4: Record manual/external acceptance separately**

Use this exact handoff checklist in the final implementation report:

```text
[ ] Physical 480×800 portrait device
[ ] Physical 800×480 landscape device
[ ] HID scanner with real DataMatrix GS separators
[ ] GS1-128 SSCC label with AIM ]C1
[ ] Web Serial scanner where supported
[ ] Installed PWA restart and seven-day stale-data gate offline
[ ] Real company logo through object storage
[ ] Long-running brightness/burn-in observation
```

Unchecked items must be reported as not run, never inferred from browser tests.

- [ ] **Step 5: Commit any verification-only corrections**

```bash
git add packages/domain packages/db packages/ui apps/api apps/admin apps/kiosk docs/superpowers
git commit -m "test(kiosk): verify self-service redesign"
```

Skip when no correction was required; never create an empty commit.
