# Kiosk Fullscreen Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every kiosk state occupy one fixed touch viewport, keep overflow inside explicit bounded regions, restore shared IBM Plex typography, and bring pairing and scanner commissioning up to the core pickup flow's visual standard without changing any business or offline behavior.

**Architecture:** Add a kiosk-only layout layer (`KioskLayout` plus `kiosk.css`) that owns the `100dvh` shell, remaining-height screen slot, responsive commissioning grids, and touch feedback. Keep `@markiro/ui`, every screen's state machine, scanner ownership, IndexedDB stores, API calls, and i18n copy intact; screen components only gain structural landmarks/classes and replace their duplicated `100vh` sizing. Add a small pure product-monogram helper so the cart can render an offline-safe placeholder without catalogue or API work.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Vitest 4 with jsdom and Testing Library, native CSS, existing `@markiro/ui` tokens/components, bundled IBM Plex Sans/Mono.

## Global Constraints

- `html`, `body`, `#root`, and the kiosk shell fill exactly `100dvh`.
- The page itself never scrolls at the target sizes 1180x800 and 800x1180.
- Persistent bars and headers consume space inside the shell. The active screen receives the remaining height through `flex: 1` and `min-height: 0`.
- Only bounded content regions may scroll when their data genuinely exceeds the available area, such as a product list, conflict list, or long setup details.
- Primary actions remain visible without page scrolling.
- The kiosk keeps bundled fonts and assets. No runtime CDN or new dependency is introduced.
- Offline queueing, badge verification, daily limits, device identity, and sync behavior remain unchanged.
- Preserve the existing dark Markiro theme, routes, visible RU/EN copy, form field order, scanner semantics, focus behavior, and touch targets of at least 44 px (56-84 px for primary floor controls).
- `DESIGN_VARIANCE: 3`, `MOTION_INTENSITY: 2`, `VISUAL_DENSITY: 7`. Add only pressed/focus/state feedback; no automatic decorative motion.
- Do not create commits unless the user or execution coordinator explicitly authorizes them. End each task with a diff/review checkpoint instead.

---

## Design and file map

This is a redesign-preserve pass for an operational, multi-step touch product. `design-taste-frontend` is outside its primary landing-page scope here, so only its applicable redesign rules are carried forward: audit first, preserve the existing design system and copy, use one dark theme and one radius/token language, keep controls tactile and accessible, avoid decorative motion, and run the relevant pre-flight checks.

### Create

- `apps/kiosk/src/ui/KioskLayout.tsx`: pure structural component for the fixed shell, optional status strip, and remaining-height screen slot.
- `apps/kiosk/src/kiosk.css`: kiosk-only viewport lock, shared screen/layout classes, responsive pairing/setup composition, bounded local overflow, product monogram, and touch/focus states.
- `apps/kiosk/src/screens/product-monogram.ts`: deterministic one-code-point product placeholder helper.
- `apps/kiosk/test/kiosk-layout.test.tsx`: focused structural contract for the shell and screen slot.

### Modify

- `packages/ui/src/styles.css`: generic browser reset only: body margin, shared UI font, page paint, and inherited form-control typography. Do not lock overflow here because admin/station pages may legitimately scroll.
- `apps/kiosk/src/main.tsx`: import kiosk styles immediately after `@markiro/ui/styles.css`.
- `apps/kiosk/src/ui/KioskShell.tsx`: compose `KioskLayout`, put `StatusStrip` in its status slot, and give the loading screen the shared screen class.
- `apps/kiosk/src/ui/StatusStrip.tsx`: add a kiosk class hook while preserving role, chip wrapping, and status semantics.
- `apps/kiosk/src/screens/Idle.tsx`, `Blocked.tsx`, `Done.tsx`: replace `minHeight: "100vh"` with shared full-slot classes; make long Done conflicts the only local overflow.
- `apps/kiosk/src/screens/Cart.tsx`: fill the slot, keep only the product list and write-off reason area bounded, remove the conflicting flex shorthand/`flexShrink` pair, add semantic list/footer hooks, and render the monogram.
- `apps/kiosk/src/screens/Pairing.tsx`: keep all state and effects intact while splitting the form into named details and keypad regions.
- `apps/kiosk/src/screens/ScannerSetup.tsx`: keep credential and scanner behavior intact while composing the gate and unlocked setup as header/workspace/fixed-actions layouts.
- `apps/kiosk/test/cart-screen.test.tsx`: pin the monogram helper and rendered placeholder.
- `apps/kiosk/test/pairing-screen.test.tsx`: pin the named details/keypad regions and touch primary action.
- `apps/kiosk/test/scanner-setup.test.tsx`: pin the named credential, transport, test-scan, and fixed-action regions.

### Explicitly untouched

- `apps/kiosk/src/api/**`, `credentials/**`, `scanner/**`, `session/**`, `store/**`, `sync/**`.
- `apps/kiosk/src/i18n/ru.json` and `en.json`: existing strings are reused as accessible names; no copy rewrite is needed.
- `packages/ui/src/components/**`: kiosk layout must not fork or change shared control behavior.
- Any product image/API/schema work.

---

### Task 1: Establish the fixed viewport and remaining-height screen slot

**Files:**

- Create: `apps/kiosk/src/ui/KioskLayout.tsx`
- Create: `apps/kiosk/src/kiosk.css`
- Create: `apps/kiosk/test/kiosk-layout.test.tsx`
- Modify: `packages/ui/src/styles.css:1-14`
- Modify: `apps/kiosk/src/main.tsx:1-9`
- Modify: `apps/kiosk/src/ui/KioskShell.tsx:47-48, 819, 977-988`
- Modify: `apps/kiosk/src/ui/StatusStrip.tsx:92-109`

**Interfaces:**

- Produces: `KioskLayout({ status, children }: { status?: ReactNode; children: ReactNode }): React.JSX.Element`.
- Produces: `.kiosk-shell`, `.kiosk-screen-slot`, `.kiosk-screen`, `.kiosk-screen--centered`, `.kiosk-status-strip`, and `.kiosk-control` CSS contracts used by Tasks 2-4.
- Consumes: existing `StatusStrip`, theme tokens, and screen nodes; no state or callbacks move into the layout component.

- [ ] **Step 1: Write the failing shell structure test**

Create `apps/kiosk/test/kiosk-layout.test.tsx` with a test that imports the not-yet-existing component and pins the exact two-level structure:

```tsx
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { KioskLayout } from "../src/ui/KioskLayout.js";

afterEach(cleanup);

describe("KioskLayout", () => {
  it("keeps the status in shell flow and gives the screen its own bounded slot", () => {
    const { container } = render(
      <KioskLayout status={<div data-part="status">Status</div>}>
        <main data-part="screen">Screen</main>
      </KioskLayout>,
    );

    const shell = container.firstElementChild;
    const slot = container.querySelector(".kiosk-screen-slot");

    expect(shell?.classList.contains("kiosk-shell")).toBe(true);
    expect(shell?.children).toHaveLength(2);
    expect(shell?.firstElementChild?.getAttribute("data-part")).toBe("status");
    expect(slot?.parentElement).toBe(shell);
    expect(slot?.firstElementChild?.getAttribute("data-part")).toBe("screen");
  });

  it("omits the status row without changing the bounded screen slot", () => {
    const { container } = render(
      <KioskLayout>
        <main>Screen</main>
      </KioskLayout>,
    );

    const shell = container.querySelector(".kiosk-shell");
    expect(shell?.children).toHaveLength(1);
    expect(shell?.firstElementChild?.classList.contains("kiosk-screen-slot")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/kiosk-layout.test.tsx
```

Expected: FAIL at module resolution because `src/ui/KioskLayout.tsx` does not exist.

- [ ] **Step 3: Implement the pure layout component**

Create `apps/kiosk/src/ui/KioskLayout.tsx`:

```tsx
import type { ReactNode } from "react";

export interface KioskLayoutProps {
  status?: ReactNode;
  children: ReactNode;
}

export function KioskLayout({ status, children }: KioskLayoutProps): React.JSX.Element {
  return (
    <div className="kiosk-shell">
      {status}
      <div className="kiosk-screen-slot">{children}</div>
    </div>
  );
}
```

- [ ] **Step 4: Add the generic typography reset and kiosk-only viewport rules**

Extend `packages/ui/src/styles.css` without setting global page overflow:

```css
body {
  margin: 0;
  background: var(--surface-page);
  color: var(--fg-1);
  font-family: var(--font-ui);
}

button,
input,
select,
textarea {
  font: inherit;
}
```

Start `apps/kiosk/src/kiosk.css` with the exact viewport contract:

```css
html,
body,
#root {
  width: 100%;
  height: 100dvh;
  min-height: 0;
}

body,
#root {
  overflow: hidden;
}

.kiosk-shell {
  width: 100%;
  height: 100dvh;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface-page);
  color: var(--fg-1);
}

.kiosk-screen-slot {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.kiosk-screen {
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--surface-page);
  color: var(--fg-1);
}

.kiosk-screen--centered {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: clamp(12px, 2.5dvh, 28px);
  padding: clamp(20px, 4dvh, 40px);
  text-align: center;
}

.kiosk-control {
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition:
    transform 70ms ease,
    color 120ms ease,
    background-color 120ms ease,
    border-color 120ms ease !important;
}

.kiosk-control:focus-visible {
  outline: var(--focus-ring-w) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.kiosk-control:active:not(:disabled) {
  transform: translateY(1px);
}

.kiosk-control:disabled {
  transform: none;
}
```

Import it in `apps/kiosk/src/main.tsx` immediately after shared UI styles:

```ts
import "@markiro/ui/styles.css";
import "./kiosk.css";
```

- [ ] **Step 5: Wire the real shell through `KioskLayout`**

In `apps/kiosk/src/ui/KioskShell.tsx`:

1. Import `KioskLayout` beside `StatusStrip`.
2. Change the loading branch from bare `<main>` to `<main className="kiosk-screen kiosk-screen--centered">`.
3. Build the status node once and pass it via the `status` prop.
4. Replace the outer inline `minHeight: "100vh"` div with:

```tsx
const status =
  view === "idle" || view === "cart" || view === "done" || view === "blocked" ? (
    <StatusStrip online={online} age={age} ageMs={ageMs} quarantined={quarantinedCount} />
  ) : undefined;

return <KioskLayout status={status}>{screen}</KioskLayout>;
```

In `StatusStrip.tsx`, add `className="kiosk-status-strip"` to its existing `role="status"` element. Do not change chip wrapping, copy, or inline sizing.

- [ ] **Step 6: Run the focused test and shell integration tests**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/kiosk-layout.test.tsx test/app.test.tsx
```

Expected: PASS. Existing shell routing, IndexedDB, scanner, queue, and offline behavior tests remain unchanged and green.

- [ ] **Step 7: Review the task diff**

Run:

```bash
git diff -- packages/ui/src/styles.css apps/kiosk/src/main.tsx apps/kiosk/src/kiosk.css apps/kiosk/src/ui/KioskLayout.tsx apps/kiosk/src/ui/KioskShell.tsx apps/kiosk/src/ui/StatusStrip.tsx apps/kiosk/test/kiosk-layout.test.tsx
git diff --check
```

Confirm that `overflow: hidden` appears only in kiosk-owned CSS, the shared stylesheet contains no kiosk selector, and there is no business-state change.

---

### Task 2: Make core pickup screens fill the slot and add the product monogram

**Files:**

- Create: `apps/kiosk/src/screens/product-monogram.ts`
- Modify: `apps/kiosk/src/kiosk.css`
- Modify: `apps/kiosk/src/screens/Idle.tsx:247-359`
- Modify: `apps/kiosk/src/screens/Blocked.tsx:26-92`
- Modify: `apps/kiosk/src/screens/Done.tsx:213-382`
- Modify: `apps/kiosk/src/screens/Cart.tsx:229-748`
- Modify: `apps/kiosk/test/cart-screen.test.tsx:1-180`

**Interfaces:**

- Produces: `productMonogram(name: string): string`, always exactly one Unicode code point.
- Consumes: `.kiosk-screen`, `.kiosk-screen--centered`, and `.kiosk-control` from Task 1.
- Produces CSS hooks: `.kiosk-idle`, `.kiosk-blocked`, `.kiosk-done`, `.kiosk-done__conflicts`, `.kiosk-cart`, `.kiosk-cart__list`, `.kiosk-cart__reason-scroll`, `.kiosk-product-monogram`.

- [ ] **Step 1: Write failing monogram tests before the helper exists**

Add this import and describe block to `apps/kiosk/test/cart-screen.test.tsx`:

```tsx
import { productMonogram } from "../src/screens/product-monogram.js";

describe("productMonogram", () => {
  it("uses the first letter or digit and returns one upper-case code point", () => {
    expect(productMonogram("  молоко 3,2% ")).toBe("М");
    expect(productMonogram("3.2% кефир")).toBe("3");
    expect([...productMonogram("ßbrot")]).toHaveLength(1);
  });

  it("uses a deterministic fallback when a malformed name has no letter or digit", () => {
    expect(productMonogram("  ***  ")).toBe("?");
  });
});
```

Extend the existing `shows a scanned product...` test after its row assertions:

```tsx
const monogram = screen.getByText("М", { selector: ".kiosk-product-monogram" });
expect(monogram.getAttribute("aria-hidden")).toBe("true");
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/cart-screen.test.tsx
```

Expected: FAIL because `src/screens/product-monogram.ts` does not exist.

- [ ] **Step 3: Implement the smallest deterministic helper**

Create `apps/kiosk/src/screens/product-monogram.ts`:

```ts
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function productMonogram(name: string): string {
  const first = [...name.normalize("NFC")].find((character) => LETTER_OR_DIGIT.test(character));
  if (!first) return "?";
  return [...first.toLocaleUpperCase()][0] ?? "?";
}
```

- [ ] **Step 4: Move centered screens from viewport sizing to slot sizing**

Make these root changes without touching callbacks, effects, roles, or copy:

- `Idle`: `<main className="kiosk-screen kiosk-screen--centered kiosk-idle">`; remove the root `minHeight`, duplicated grid centering, padding, box sizing, and text alignment that the class now owns.
- `Blocked`: `<main className="kiosk-screen kiosk-screen--centered kiosk-blocked">`; remove root `minHeight` and duplicated centering/viewport declarations.
- `Done`: `<main className="kiosk-screen kiosk-screen--centered kiosk-done">`; add `className="kiosk-done__conflicts"` to the existing conflicts `role="alert"`; add `className="kiosk-control"` to the reset button.

Append compact operational sizing to `kiosk.css`:

```css
.kiosk-idle,
.kiosk-blocked,
.kiosk-done {
  gap: clamp(14px, 2.5dvh, 28px);
}

.kiosk-done__conflicts {
  max-height: min(30dvh, 240px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
```

- [ ] **Step 5: Make Cart a true flex child and keep its actions stationary**

In `Cart.tsx`:

1. Import `productMonogram`.
2. Change the root to `<main className="kiosk-screen kiosk-cart">` and remove `minHeight: "100vh"`.
3. Add `aria-labelledby="kiosk-cart-list-title"` to the existing list `<section>` and `id="kiosk-cart-list-title"` to its `<h1>`.
4. Remove `flexShrink: 0` from the list section because its same style object already sets `flex`; this removes the React warning about mixing `flex` shorthand with `flexShrink`.
5. Add `className="kiosk-cart__list"` to the existing `flex: 1; overflowY: "auto"` product-list div.
6. Replace the empty product square with:

```tsx
<span aria-hidden="true" className="kiosk-product-monogram">
  {productMonogram(item.name)}
</span>
```

7. Add `className="kiosk-cart__reason-scroll"` to the reason label/toggle/sub-reason wrapper so only a very long tenant-provided reason set can scroll.
8. Add `className="kiosk-control"` to the kiosk-owned native buttons: Not me, remove item, reason toggles, write-off reason chips, submit, and modal acknowledgement.

Add the layout hooks to `kiosk.css`:

```css
.kiosk-cart {
  display: flex;
  flex-direction: column;
}

.kiosk-cart__list,
.kiosk-cart__reason-scroll {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.kiosk-cart__reason-scroll {
  max-height: min(22dvh, 176px);
}

.kiosk-product-monogram {
  width: 56px;
  height: 56px;
  flex: 0 0 56px;
  border: 1px solid var(--line);
  border-radius: var(--r-2);
  display: grid;
  place-items: center;
  background: var(--surface-panel);
  color: var(--fg-2);
  font: 600 22px/1 var(--font-mono);
  font-variant-numeric: tabular-nums;
}
```

Do not move the total, daily-limit text, or 84 px submit button into either scroll region.

- [ ] **Step 6: Run the core screen tests**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/idle-screen.test.tsx test/cart-screen.test.tsx test/done-screen.test.tsx test/app.test.tsx
```

Expected: PASS, including the new Unicode/fallback tests and every existing scan, limit, conflict, queue, and auto-reset assertion.

- [ ] **Step 7: Review the task diff**

Run:

```bash
rg -n 'minHeight: "100vh"|minHeight: "100dvh"|min-height: 100vh' apps/kiosk/src
git diff -- apps/kiosk/src/kiosk.css apps/kiosk/src/screens/Idle.tsx apps/kiosk/src/screens/Blocked.tsx apps/kiosk/src/screens/Done.tsx apps/kiosk/src/screens/Cart.tsx apps/kiosk/src/screens/product-monogram.ts apps/kiosk/test/cart-screen.test.tsx
git diff --check
```

Expected search result: no screen-level `100vh`/`100dvh`; only the shell owns the viewport. Confirm that the product name remains adjacent visible text and the monogram remains `aria-hidden`.

---

### Task 3: Recompose pairing into fixed details and keypad regions

**Files:**

- Modify: `apps/kiosk/src/screens/Pairing.tsx:280-496`
- Modify: `apps/kiosk/src/kiosk.css`
- Modify: `apps/kiosk/test/pairing-screen.test.tsx:181-199`

**Interfaces:**

- Consumes: the existing `PairingProps`, state, `PinPad`, submit/retry/scan/server callbacks unchanged.
- Consumes: `.kiosk-screen`, `.kiosk-screen--centered`, and `.kiosk-control` from Task 1.
- Produces: two named regions, `region[name="Connect this kiosk"]` and `region[name="Enter the eight-digit pairing code from the admin panel"]` in the English test locale.
- Produces CSS hooks: `.kiosk-pairing`, `.kiosk-pairing__details`, `.kiosk-pairing__keypad`, `.kiosk-pairing__actions`, `.kiosk-pairing__service`, `.kiosk-pin-pad`.

- [ ] **Step 1: Write the failing semantic layout test**

Add this as the first test in the existing `describe("Pairing")` block, which already runs in English:

```tsx
it("separates commissioning details from the keypad without changing the form", () => {
  render(
    <Pairing
      defaultServerUrl={SERVER}
      subscribe={fakeFanOut().subscribe}
      onPaired={vi.fn()}
      onConfigureScanner={vi.fn()}
    />,
  );

  const details = screen.getByRole("region", { name: "Connect this kiosk" });
  const keypad = screen.getByRole("region", {
    name: "Enter the eight-digit pairing code from the admin panel",
  });

  expect(details.contains(scanButton())).toBe(true);
  expect(details.contains(scannerSetupButton())).toBe(true);
  expect(keypad.contains(submitButton())).toBe(true);
  expect(submitButton().classList.contains("kiosk-control")).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/pairing-screen.test.tsx
```

Expected: FAIL because no named pairing regions exist.

- [ ] **Step 3: Preserve the success state but make it fill the shared slot**

For the `bound` branch, change only its root composition:

```tsx
<main
  role="status"
  className="kiosk-screen kiosk-screen--centered kiosk-pairing-success"
>
```

Remove `minHeight: "100vh"` and duplicated centering/padding declarations. Add `className="kiosk-control"` to the large Start working button. Keep the timer and `role="status"` untouched.

- [ ] **Step 4: Split the active form into the approved two-region composition**

Keep every existing child and handler, but move them into this structure:

```tsx
<main className="kiosk-screen kiosk-pairing" aria-labelledby="kiosk-pairing-title">
  <section className="kiosk-pairing__details" aria-labelledby="kiosk-pairing-title">
    <header>
      <h1 id="kiosk-pairing-title">{t("pairing.title")}</h1>
      <p>{t("pairing.prompt")}</p>
    </header>
    {/* existing code status, busy/error state, scan action and waiting state */}
    {/* existing scanner setup/server controls and optional Input */}
  </section>

  <section className="kiosk-pairing__keypad" aria-label={t("pairing.prompt")}>
    <div className="kiosk-pin-pad">
      <PinPad value={code} onChange={/* existing callback */} maxLength={CODE_LENGTH} />
    </div>
    <div className="kiosk-pairing__actions">{/* existing Clear and Connect buttons */}</div>
  </section>
</main>
```

Apply `className="kiosk-control"` to every `Button` in this screen: Retry, Clear, Connect, Scan code, Scanner setup, Server toggle, and Start working. Preserve button order, `aria-pressed`, loading/disabled conditions, and the existing optional server field.

- [ ] **Step 5: Add landscape and portrait CSS with only local details overflow**

Append:

```css
.kiosk-pairing {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(340px, 0.9fr);
  gap: clamp(20px, 3vw, 48px);
  padding: clamp(20px, 3.5dvh, 36px) clamp(24px, 4vw, 56px);
}

.kiosk-pairing__details {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  gap: clamp(12px, 2dvh, 20px);
}

.kiosk-pairing__details > header {
  display: grid;
  gap: 10px;
}

.kiosk-pairing__details h1,
.kiosk-pairing__details p {
  margin: 0;
}

.kiosk-pairing__keypad {
  min-width: 0;
  min-height: 0;
  border-left: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding-left: clamp(20px, 3vw, 40px);
}

.kiosk-pin-pad {
  display: flex;
  justify-content: center;
}

.kiosk-pairing__actions {
  width: min(100%, 312px);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.kiosk-pairing__service {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

@media (orientation: portrait), (max-width: 899px) {
  .kiosk-pairing {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
    gap: 0;
    padding: 0;
  }

  .kiosk-pairing__details {
    justify-content: flex-start;
    padding: 24px 28px 16px;
  }

  .kiosk-pairing__keypad {
    border-left: 0;
    border-top: 1px solid var(--line);
    padding: 16px 28px 24px;
  }
}
```

The details column may scroll only when error plus scan help plus server field genuinely exceeds it. The keypad, Clear, and Connect remain outside that scroll container.

- [ ] **Step 6: Run the full pairing test file**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/pairing-screen.test.tsx
```

Expected: PASS for the new landmarks and all existing success, retry, scan-listener, server-address, storage-failure, and timed handoff cases.

- [ ] **Step 7: Review the task diff**

Run:

```bash
git diff -- apps/kiosk/src/screens/Pairing.tsx apps/kiosk/src/kiosk.css apps/kiosk/test/pairing-screen.test.tsx
git diff --check
```

Verify that only JSX grouping/classes changed, no effect dependency or request/storage branch changed, and the keypad actions are not descendants of `.kiosk-pairing__details`.

---

### Task 4: Structure the scanner credential gate and unlocked setup

**Files:**

- Modify: `apps/kiosk/src/screens/ScannerSetup.tsx:339-488`
- Modify: `apps/kiosk/src/kiosk.css`
- Modify: `apps/kiosk/test/scanner-setup.test.tsx:191-210, 327-354`

**Interfaces:**

- Consumes: existing `ScannerSetupProps`, operator verifiers, transport state, scanner fan-out, and `PinPad` without signature changes.
- Produces locked-gate named regions from existing strings: `region[name="Personnel number"]` (then `PIN`) and the screen title.
- Produces unlocked semantic regions from existing strings: `group[name="How the scanner is connected"]` and `region[name="Test scan"]`.
- Produces CSS hooks: `.kiosk-credential-gate`, `.kiosk-credential-gate__details`, `.kiosk-credential-gate__entry`, `.kiosk-setup`, `.kiosk-setup__header`, `.kiosk-setup__workspace`, `.kiosk-setup__panel`, `.kiosk-setup__footer`.

- [ ] **Step 1: Write failing semantic tests for both branches**

In the existing unpaired setup test, add:

```tsx
expect(screen.getByRole("group", { name: "How the scanner is connected" })).toBeDefined();
expect(screen.getByRole("region", { name: "Test scan" })).toBeDefined();
const done = screen.getByRole("button", { name: "Done" });
expect(done.closest("footer")).not.toBeNull();
```

In the first paired-gate test, before entering credentials, add:

```tsx
const entry = screen.getByRole("region", { name: "Personnel number" });
expect(entry.contains(screen.getByRole("button", { name: "Next" }))).toBe(true);
expect(screen.queryByRole("group", { name: "How the scanner is connected" })).toBeNull();
```

Use the existing test helpers/props and English locale already present in the file; do not add a parallel fixture.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/scanner-setup.test.tsx
```

Expected: FAIL because Test scan is not a named region, the gate has no named entry region, and the Done action is not inside a semantic footer.

- [ ] **Step 3: Recompose the locked credential gate without changing its security branch**

Keep `if (!unlocked)` as a real branch and arrange its existing elements as:

```tsx
<main className="kiosk-screen kiosk-credential-gate" aria-labelledby="kiosk-gate-title">
  <section className="kiosk-credential-gate__details" aria-labelledby="kiosk-gate-title">
    <h1 id="kiosk-gate-title">{t("scannerSetup.gateTitle")}</h1>
    <p>{t("scannerSetup.gatePrompt")}</p>
    {/* existing role=status display, error Alert, and recovery hint */}
  </section>
  <section className="kiosk-credential-gate__entry" aria-labelledby="kiosk-gate-entry-label">
    <p id="kiosk-gate-entry-label">
      {stage === "login" ? t("scannerSetup.gateLogin") : t("scannerSetup.gatePin")}
    </p>
    <div className="kiosk-pin-pad">{/* existing PinPad */}</div>
    <div className="kiosk-credential-gate__actions">
      {/* existing Cancel, Clear and Next/Sign in buttons */}
    </div>
  </section>
</main>
```

Add `className="kiosk-control"` to Cancel, Clear, Next, and Sign in. Keep the generic failure wording, PIN dots, `busy` gate, stage reset, and recovery text byte-for-byte unchanged.

- [ ] **Step 4: Recompose unlocked setup as header, two-panel workspace, and fixed footer**

Use this structure while keeping the current fieldset/legend and scan-result logic:

```tsx
<main className="kiosk-screen kiosk-setup" aria-labelledby="kiosk-setup-title">
  <header className="kiosk-setup__header">
    <h1 id="kiosk-setup-title">{t("scannerSetup.title")}</h1>
  </header>
  <div className="kiosk-setup__workspace">
    <fieldset className="kiosk-setup__panel">
      <legend>{t("scannerSetup.transportTitle")}</legend>
      {/* existing keyboard/Web Serial choices and port warning */}
    </fieldset>
    <section className="kiosk-setup__panel" aria-labelledby="kiosk-setup-test-title">
      <h2 id="kiosk-setup-test-title">{t("scannerSetup.testTitle")}</h2>
      {/* existing prompt and role=status verdict */}
    </section>
  </div>
  <footer className="kiosk-setup__footer">
    <Button className="kiosk-control" onClick={onClose}>
      {t("scannerSetup.done")}
    </Button>
  </footer>
</main>
```

Add `className="kiosk-control"` to each radio input so focus and touch feedback are visible. Do not add another scanner subscription or move any `useEffect`.

- [ ] **Step 5: Add fixed-workspace and responsive CSS**

Append:

```css
.kiosk-credential-gate {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(340px, 0.8fr);
  min-height: 0;
}

.kiosk-credential-gate__details,
.kiosk-credential-gate__entry {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 16px;
  padding: clamp(24px, 4dvh, 48px) clamp(28px, 5vw, 64px);
}

.kiosk-credential-gate__details {
  overflow-y: auto;
  overscroll-behavior: contain;
}

.kiosk-credential-gate__entry {
  align-items: center;
  border-left: 1px solid var(--line);
}

.kiosk-credential-gate__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
}

.kiosk-setup {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 20px;
  padding: clamp(20px, 3.5dvh, 36px) clamp(24px, 4vw, 48px);
}

.kiosk-setup__header h1,
.kiosk-setup__panel h2 {
  margin: 0;
}

.kiosk-setup__workspace {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  border: 1px solid var(--line);
  border-radius: var(--r-3);
  overflow: hidden;
  background: var(--surface-card);
}

.kiosk-setup__panel {
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 16px;
  margin: 0;
  padding: clamp(22px, 3vw, 40px);
  border: 0;
}

.kiosk-setup__panel + .kiosk-setup__panel {
  border-left: 1px solid var(--line);
}

.kiosk-setup__footer {
  display: flex;
  justify-content: flex-end;
}

@media (orientation: portrait), (max-width: 899px) {
  .kiosk-credential-gate {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }

  .kiosk-credential-gate__details,
  .kiosk-credential-gate__entry {
    padding: 20px 28px;
  }

  .kiosk-credential-gate__entry {
    border-left: 0;
    border-top: 1px solid var(--line);
  }

  .kiosk-setup__workspace {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  }

  .kiosk-setup__panel + .kiosk-setup__panel {
    border-left: 0;
    border-top: 1px solid var(--line);
  }
}
```

The Done/Cancel action stays outside `.kiosk-setup__workspace`; the scanner setup panels may scroll locally if their explanatory text grows.

- [ ] **Step 6: Run scanner tests and the shell paths that open setup**

Run:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/scanner-setup.test.tsx test/app.test.tsx
```

Expected: PASS. In particular, one scanner subscription remains live, the gate remains absent before authorization, transport handoff still occurs once, and Web Serial refusal still preserves keyboard mode.

- [ ] **Step 7: Review the task diff**

Run:

```bash
git diff -- apps/kiosk/src/screens/ScannerSetup.tsx apps/kiosk/src/kiosk.css apps/kiosk/test/scanner-setup.test.tsx
git diff --check
```

Confirm the branch boundary `if (!unlocked)` remains, credential fields have the same order and labels, and the fixed footer is not inside either scrollable panel.

---

### Task 5: Run automated gates and prove the viewport contract in the real browser

**Files:**

- Verify all files changed by Tasks 1-4.
- Do not create screenshots, stores, browser profiles, or generated artifacts inside the repository.

**Interfaces:**

- Consumes: all CSS/semantic contracts from Tasks 1-4.
- Produces: verification evidence for both target viewports and every required screen state; no code interface.

- [ ] **Step 1: Build workspace dependencies before diagnosing kiosk failures**

Run:

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
```

Expected: both builds PASS. This avoids the known fresh-worktree failure where kiosk tests cannot resolve unbuilt workspace outputs.

- [ ] **Step 2: Run focused and complete automated checks**

Run in this order:

```bash
pnpm --filter @markiro/kiosk exec vitest run test/kiosk-layout.test.tsx test/cart-screen.test.tsx test/pairing-screen.test.tsx test/scanner-setup.test.tsx
pnpm --filter @markiro/kiosk test
pnpm --filter @markiro/kiosk typecheck
pnpm --filter @markiro/kiosk lint
pnpm --filter @markiro/kiosk build
pnpm --filter @markiro/ui test
pnpm --filter @markiro/ui typecheck
pnpm --filter @markiro/ui lint
pnpm --filter @markiro/ui build
pnpm format:check
git diff --check
```

Expected: every command PASS with no React shorthand warning from the Cart list section. If an infrastructure check skips or fails for an unrelated pre-existing reason, record the exact command/output and do not describe it as verified.

- [ ] **Step 3: Launch the actual Vite kiosk without changing repository state**

Run in a persistent terminal from the worktree:

```bash
pnpm --filter @markiro/kiosk dev --host 127.0.0.1
```

Open the printed local URL in a real browser. Use a temporary browser profile outside the repository. Begin with cleared site data for the unpaired state; use the development API and a real pairing code, or an already-authorized local development profile, for working states. Do not point the kiosk at production.

- [ ] **Step 4: Check both target viewports mechanically on every state**

For each state below, test at exactly `1180x800` and `800x1180`:

1. Pairing, default.
2. Pairing with scan-waiting state.
3. Pairing with a connection error and expanded server field.
4. Scanner setup before pairing.
5. Scanner credential gate after pairing, both personnel-number and PIN stages.
6. Idle, online and offline strip variants.
7. Empty cart.
8. Populated cart with enough rows to require list scrolling.
9. Write-off cart with enough tenant reasons to wrap.
10. Day-limit reached.
11. Done online.
12. Done offline.
13. Done with enough conflicts to require local scrolling.
14. Blocked with queued orders.

Run this in DevTools after every state/viewport change:

```js
const page = {
  viewport: `${window.innerWidth}x${window.innerHeight}`,
  html: document.documentElement.scrollHeight,
  body: document.body.scrollHeight,
  root: document.querySelector("#root")?.scrollHeight,
  shell: document.querySelector(".kiosk-shell")?.scrollHeight,
};

const localOverflow = [...document.querySelectorAll("*")]
  .filter((node) => node instanceof HTMLElement)
  .filter((node) => node.scrollHeight > node.clientHeight + 1)
  .map((node) => ({
    className: node.className,
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    overflowY: getComputedStyle(node).overflowY,
  }));

({
  page,
  pageFits: page.html === window.innerHeight && page.body === window.innerHeight,
  localOverflow,
});
```

Expected for every state: `pageFits === true`; `#root` and `.kiosk-shell` equal `window.innerHeight`. Any entry in `localOverflow` must be one of the intentional bounded hooks: `.kiosk-cart__list`, `.kiosk-cart__reason-scroll`, `.kiosk-done__conflicts`, `.kiosk-pairing__details`, `.kiosk-credential-gate__details`, or `.kiosk-setup__panel`. `html`, `body`, `#root`, `.kiosk-shell`, `.kiosk-screen-slot`, and `.kiosk-screen` must never appear as scrollable overflow.

- [ ] **Step 5: Prove each primary action stays inside the viewport**

On each interactive screen, select its primary action and run:

```js
const action = document.querySelector("button:not(:disabled)");
const rect = action?.getBoundingClientRect();
({
  label: action?.textContent?.trim(),
  top: rect?.top,
  bottom: rect?.bottom,
  visible: Boolean(rect && rect.top >= 0 && rect.bottom <= window.innerHeight),
});
```

Use the actual primary button if the first enabled button is secondary: Connect, Start working, Next/Sign in, Scanner setup Done, Cart submit, Done reset. Expected: `visible === true` at both target sizes, including connection error/server-expanded pairing, write-off reasons, and conflict-heavy Done.

- [ ] **Step 6: Run the applicable design pre-flight**

Inspect both orientations and confirm:

- IBM Plex Sans is the computed body font and IBM Plex Mono remains used for codes/counters.
- One dark theme and existing Markiro semantic/accent palette are used throughout.
- Existing radius rules remain consistent: 8-12 px controls/panels, pill radius only for chips.
- Every kiosk-owned button/radio has a visible `:focus-visible` ring, an immediate 1 px pressed response, no disabled transform, and readable label/background contrast.
- All touch targets remain at least 44 px; primary floor actions remain 56-84 px.
- No CTA wraps at 1180 px landscape width.
- Motion is limited to direct interaction/state feedback; there is no decorative animation or page transition.
- Loading, empty, error, offline, blocked, and success states remain present and understandable.
- Product placeholders show a meaningful monogram rather than an empty dark square.
- Existing visible copy is unchanged; this operational app intentionally preserves its established punctuation and voice rather than applying marketing-page copy rules.

- [ ] **Step 7: Review the complete diff and report verification limits**

Run:

```bash
git status --short
git diff --stat
git diff -- packages/ui/src/styles.css apps/kiosk/src apps/kiosk/test
git diff --check
```

Report separately:

1. Behavior/layout changed.
2. Files/areas changed.
3. Automated checks and exact results.
4. Browser states/viewports exercised and measured values.
5. Checks not run or not proven: physical kiosk, real 2D scanner, Web Serial hardware, installed PWA chrome, production API/network.

Do not claim the kiosk hardware or scanner is verified from jsdom or desktop-browser results.

---

## Self-review checklist for the implementer

- Every hard invariant in `docs/superpowers/specs/2026-08-06-kiosk-fullscreen-redesign.md` maps to Tasks 1, 2, or 5.
- Pairing landscape/portrait composition and its only exceptional details overflow map to Task 3.
- Scanner header/two-panel/fixed-footer and credential gate map to Task 4.
- The monogram is one deterministic character, decorative, offline-safe, and tested in Task 2.
- No production dependency, API, store, scanner ownership, offline rule, route, or i18n key changes are planned.
- All test-first steps have a specific expected failure and a narrow command.
- The browser gate checks real geometry rather than inferring it from classes or jsdom.
