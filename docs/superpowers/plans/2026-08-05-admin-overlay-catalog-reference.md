# Admin Overlay and Catalog Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add accessible side-panel and confirmation primitives to `@markiro/ui`, then migrate Catalog create, edit, and delete interactions as the first route-backed reference implementation.

**Architecture:** A private overlay layer in `@markiro/ui` owns the shared portal host, stack order, background inertness, document scroll locking, focus containment, focus restoration, and the DOM container used by nested Radix portals. Catalog remains the mounted parent route while `/catalog/new` or `/catalog/:productId/edit` renders a guarded `ProductPanelRoute` through `<Outlet>`; the feature owns dirty-form confirmation and mutation state, while the form keeps its existing validation and payload mapper.

**Tech Stack:** React 19, React Router 8 declarative routing, TanStack Query 5, React Hook Form 7, Zod 4, Radix Select/Popover, react-i18next, Vitest 4, Testing Library, `@markiro/ui` CSS variables.

## Global Constraints

- Implement only shared overlay primitives and the Catalog reference migration from the approved specification; later page waves require separate plans.
- Do not change backend endpoints, DTOs, audit behavior, tenant scoping, or query-cache identity boundaries.
- Do not add dependencies or migrate the router, form library, query library, fonts, or icon library.
- Preserve the merged custom-control contracts from PR #51: `Select` remains generic and controlled through `onValueChange`, `DatePicker` keeps its ISO-date contract, and both keep their current Radix keyboard/focus behavior.
- Preserve the exact Catalog create/update payload null and omission semantics, GTIN validation, stale-response protection, integration unlink permissions, query invalidation, and success toasts.
- `/catalog/new` and `/catalog/:productId/edit` require `operations.write`; an unauthorized direct URL renders the established forbidden page and must not mount create, update, delete, or unlink mutation hooks.
- Keep the current `Modal` export for unmigrated consumers; do not add panel or confirmation modes to it.
- Use only the three panel sizes `compact` (480 px), `standard` (640 px), and `complex` (720 px); Catalog uses `standard`.
- At widths below 768 px, panels occupy the viewport with `100dvh`, no outer corner rounding, and safe-area padding; at 1024 px a panel must not exceed `64vw`.
- Preserve RU/EN, light/dark, semantic status colors, keyboard operation, visible focus, and `prefers-reduced-motion` behavior.
- A pending mutation blocks Escape, backdrop, close-button, Cancel, and navigation dismissal; failed mutations retain form input and render a persistent inline error.
- An Escape consumed by an open Radix Select or DatePicker closes only that child overlay; it must not also close the containing SidePanel.
- Write each focused failing test before its production change, run the narrowest test during iteration, and commit only the files listed in that task.

---

## File map and boundaries

- Create `packages/ui/src/components/OverlayLayer.tsx`: private portal/stack/focus infrastructure plus an internal Radix portal-container context. It exports only to sibling UI components, never from the package barrel.
- Create `packages/ui/src/components/SidePanel.tsx`: public data-work surface and its close-reason contract.
- Create `packages/ui/src/components/ConfirmDialog.tsx`: public concise decision surface; it composes the same private overlay layer.
- Create `packages/ui/test/overlays.test.tsx`: behavioral contract for both public overlays, including nested layers.
- Modify `packages/ui/src/components.css`: overlay, panel, dialog, responsive, safe-area, and reduced-motion classes.
- Modify `packages/ui/src/tokens.css`: named legacy-modal, panel, popover, dialog, and toast z-index tokens.
- Modify `packages/ui/src/components/Modal.tsx` and `packages/ui/src/components/Toast.tsx`: replace hard-coded z-index numbers only; legacy behavior remains unchanged.
- Modify `packages/ui/src/components/Select.tsx` and `packages/ui/src/components/DatePicker.tsx`: mount Radix portals into the active overlay layer when present and replace hard-coded `zIndex: 1000` with the shared popover token.
- Modify `packages/ui/src/components/index.ts`: export the two public primitives and their public types.
- Modify `packages/ui/test/components.test.tsx` and `packages/ui/test/date-picker.test.tsx`: retain the merged custom-control contract while asserting tokenized fallback portal levels.
- Modify `apps/admin/src/app.tsx`: make Catalog a parent route with write-guarded `new` and `:productId/edit` children.
- Create `apps/admin/src/pages/catalog/ProductPanelRoute.tsx`: resolve route data, own create/update mutations, close fallback, dirty guard, and load/error states.
- Modify `apps/admin/src/pages/catalog/ProductForm.tsx`: render form content inside `SidePanel`, publish dirty state, group fields, and show persistent submission errors without changing `toCreateInput`.
- Modify `apps/admin/src/pages/catalog/index.tsx`: keep list/filter state in the parent, open route-backed panels, provide outlet data, and replace product deletion with `ConfirmDialog`.
- Create `apps/admin/src/pages/catalog/catalog.css`: Catalog page, filter row, action region, panel section, and narrow-layout styles.
- Modify `apps/admin/src/i18n/ru.json` and `apps/admin/src/i18n/en.json`: panel sections, dirty confirmation, panel load failures, and result summary copy.
- Create `apps/admin/test/catalog-routing.test.tsx`: nested-route, history, dirty guard, direct-link, load-error, and authorization tests.
- Modify `apps/admin/test/catalog.test.tsx`: preserve and adapt current form/payload/unlink/delete coverage to route-backed panels.
- Modify `apps/admin/test/access-routing.test.tsx`: assert direct write-route denial through the real `AppRoutes` tree.

---

### Task 1: Shared SidePanel overlay contract

**Files:**

- Create: `packages/ui/src/components/OverlayLayer.tsx`
- Create: `packages/ui/src/components/SidePanel.tsx`
- Create: `packages/ui/test/overlays.test.tsx`
- Modify: `packages/ui/src/components.css`
- Modify: `packages/ui/src/tokens.css`
- Modify: `packages/ui/src/components/Modal.tsx`
- Modify: `packages/ui/src/components/Toast.tsx`
- Modify: `packages/ui/src/components/Select.tsx`
- Modify: `packages/ui/src/components/DatePicker.tsx`
- Modify: `packages/ui/src/components/index.ts`
- Modify: `packages/ui/test/components.test.tsx`
- Modify: `packages/ui/test/date-picker.test.tsx`

**Interfaces:**

- Consumes: React `createPortal`, the existing CSS tokens, and caller-supplied translated labels.
- Produces:

  ```ts
  export type OverlayDismissReason = "close-button" | "escape" | "backdrop" | "navigation";
  export type SidePanelSize = "compact" | "standard" | "complex";

  export interface SidePanelProps {
    open: boolean;
    title: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
    footer?: ReactNode;
    status?: ReactNode;
    size?: SidePanelSize;
    busy?: boolean;
    closeLabel: string;
    className?: string;
    onClose: (reason: OverlayDismissReason) => void;
  }
  ```

- Private `OverlayLayer` props:

  ```ts
  interface OverlayLayerProps {
    open: boolean;
    kind: "panel" | "dialog";
    busy: boolean;
    initialFocus: "first-editable" | "cancel";
    onEscape: () => void;
    children: (surfaceRef: RefObject<HTMLDivElement | null>) => ReactNode;
  }
  ```

- Private sibling contract, exported from `OverlayLayer.tsx` but not from `components/index.ts`:

  ```ts
  export function useOverlayPortalContainer(): HTMLElement | undefined;
  ```

  `Select` passes the returned element to `RadixSelect.Portal container`; `DatePicker` passes it to `RadixPopover.Portal container`. Outside SidePanel/ConfirmDialog the hook returns `undefined`, preserving Radix's current `document.body` fallback.

- `OverlayLayer` creates one `.mk-overlay-root` under `document.body`, creates one child layer per open overlay, provides that child layer as the nested Radix portal container, and removes the root after the final layer closes. A Select/DatePicker opened inside a panel therefore remains inside the panel's stacking and inert boundary. `SidePanel` emits the three pointer/keyboard reasons; route features feed `navigation` into the same feature-owned close state machine when their blocker activates.

- [ ] **Step 1: Add failing portal, dismissal, and public-type tests**

  Create `packages/ui/test/overlays.test.tsx` with a small trigger harness and these assertions:

  ```tsx
  function PanelHarness({
    onClose = vi.fn(),
  }: {
    onClose?: (reason: OverlayDismissReason) => void;
  }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open product</button>
        <SidePanel
          open={open}
          title="New product"
          description="Product fields"
          closeLabel="Close panel"
          onClose={(reason) => {
            onClose(reason);
            setOpen(false);
          }}
          footer={<button>Save</button>}
        >
          <label>
            Name
            <input />
          </label>
        </SidePanel>
      </>
    );
  }

  it("portals a labelled panel to body and removes the host after close", async () => {
    const user = userEvent.setup();
    render(<PanelHarness />);
    await user.click(screen.getByRole("button", { name: "Open product" }));

    const panel = screen.getByRole("dialog", { name: "New product" });
    expect(panel.closest(".mk-overlay-layer")?.parentElement).toBe(
      document.querySelector(".mk-overlay-root"),
    );
    expect(panel.getAttribute("aria-describedby")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".mk-overlay-root")).toBeNull();
  });

  it.each([
    [
      "close-button",
      async (user: UserEvent) => user.click(screen.getByRole("button", { name: "Close panel" })),
    ],
    ["escape", async (user: UserEvent) => user.keyboard("{Escape}")],
    [
      "backdrop",
      async (user: UserEvent) =>
        user.click(document.querySelector(".mk-side-panel__scrim") as HTMLElement),
    ],
  ] as const)("reports %s dismissal", async (reason, dismiss) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PanelHarness onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Open product" }));
    await dismiss(user);
    expect(onClose).toHaveBeenCalledWith(reason);
  });
  ```

  Import `SidePanel` and `type OverlayDismissReason` from `../src/components/index.js`. In `afterEach`, call `cleanup()`, assert `.mk-overlay-root` is absent, and restore `document.body.style.overflow = ""` so one failure cannot contaminate the next test.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `pnpm --filter @markiro/ui exec vitest run test/overlays.test.tsx`

  Expected: FAIL because `SidePanel` and `OverlayDismissReason` are not exported.

- [ ] **Step 3: Implement the minimal private portal host and Escape stack**

  In `OverlayLayer.tsx`, keep module state private and deterministic:

  ```ts
  interface LayerRecord {
    id: symbol;
    element: HTMLDivElement;
    onEscape: () => void;
    busy: boolean;
  }

  const layers: LayerRecord[] = [];
  let host: HTMLDivElement | null = null;
  let restoreBodyOverflow: string | null = null;
  const inertSnapshot = new Map<HTMLElement, boolean>();
  ```

  `ensureHost()` appends `.mk-overlay-root` to `document.body`. Register one child `.mk-overlay-layer` per open overlay and remove both the child and host when their counts reach zero. At this RED/GREEN boundary, implement only portal lifecycle and topmost Escape dispatch; Step 6 adds inertness, scroll locking, focus containment, and restoration under their own failing tests.

  Install one bubble-phase document `keydown` listener while the stack is non-empty. For Escape, first return when `event.defaultPrevented` is already true or when the event target is inside `[data-mk-nested-overlay]`; `Select` and `DatePicker` add that private attribute to their Radix Content nodes, guaranteeing that Escape closes only the child listbox/calendar. Otherwise read the last record at event time; call only its `onEscape` when `busy === false`, prevent default, and stop propagation. Update the record's `busy` and callback without unregistering the layer.

- [ ] **Step 4: Implement SidePanel markup and exports**

  `SidePanel` returns `null` when closed. When open, compose `OverlayLayer` and render:

  ```tsx
  <div
    className="mk-side-panel__scrim"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose("backdrop");
    }}
  >
    <section
      ref={surfaceRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      tabIndex={-1}
      className={cn("mk-side-panel", `mk-side-panel--${size}`, className)}
    >
      <header className="mk-side-panel__header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </div>
        <IconButton
          type="button"
          size="compact"
          variant="secondary"
          aria-label={closeLabel}
          icon={<span aria-hidden="true">✕</span>}
          disabled={busy}
          onClick={() => onClose("close-button")}
        />
      </header>
      <div className="mk-side-panel__body">{children}</div>
      {footer || status ? (
        <footer className="mk-side-panel__footer">
          {status ? <div className="mk-side-panel__status">{status}</div> : null}
          {footer ? <div className="mk-side-panel__actions">{footer}</div> : null}
        </footer>
      ) : null}
    </section>
  </div>
  ```

  The close control reuses the merged `IconButton`, uses `closeLabel`, reports `close-button`, and is disabled while busy. The body is the only region with `overflow-y: auto`; header and footer remain fixed within the panel grid.

  Export `SidePanel`, `SidePanelProps`, `SidePanelSize`, and `OverlayDismissReason` from `components/index.ts`. Do not export `OverlayLayer`.

  Run: `pnpm --filter @markiro/ui exec vitest run test/overlays.test.tsx`

  Expected: PASS for portal cleanup and the three close reasons; the advanced focus/inert tests do not exist yet.

- [ ] **Step 5: Add failing focus, inert, scroll-lock, busy, and size tests**

  Extend `overlays.test.tsx` with exact assertions, importing the current `Select` and `DatePicker` exports alongside `SidePanel`:

  ```tsx
  it("focuses the first editable field, traps focus, and restores the exact trigger", async () => {
    const user = userEvent.setup();
    render(<PanelHarness />);
    const trigger = screen.getByRole("button", { name: "Open product" });
    await user.click(trigger);
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));

    screen.getByRole("button", { name: "Save" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close panel" }));

    await user.click(screen.getByRole("button", { name: "Close panel" }));
    expect(document.activeElement).toBe(trigger);
  });

  it("makes the app inert, locks scroll, and restores both exactly", async () => {
    document.body.style.overflow = "clip";
    const user = userEvent.setup();
    const { container } = render(<PanelHarness />);
    await user.click(screen.getByRole("button", { name: "Open product" }));
    expect(container.inert).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    await user.click(screen.getByRole("button", { name: "Close panel" }));
    expect(container.inert).toBe(false);
    expect(document.body.style.overflow).toBe("clip");
  });

  it("blocks every dismissal path while busy", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SidePanel open busy title="Saving" closeLabel="Close" onClose={onClose}>
        Body
      </SidePanel>,
    );
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.keyboard("{Escape}");
    await user.click(document.querySelector(".mk-side-panel__scrim") as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(["compact", "standard", "complex"] as const)("applies the %s size token", (size) => {
    render(<SidePanel open size={size} title="Panel" closeLabel="Close" onClose={() => {}} />);
    expect(screen.getByRole("dialog").classList.contains(`mk-side-panel--${size}`)).toBe(true);
  });

  it("keeps Radix child portals in the panel and lets each child consume Escape first", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SidePanel open title="Panel" closeLabel="Close" onClose={onClose}>
        <Select label="Product" value="milk" options={[{ value: "milk", label: "Milk" }]} />
        <DatePicker label="Planned date" value="2026-08-06" calendarLabel="Calendar" />
      </SidePanel>,
    );

    await user.click(screen.getByRole("combobox", { name: "Product" }));
    expect(screen.getByRole("listbox").closest(".mk-overlay-layer--panel")).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Planned date" }));
    expect(
      screen.getByRole("dialog", { name: "Calendar" }).closest(".mk-overlay-layer--panel"),
    ).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Calendar" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
  ```

  Run: `pnpm --filter @markiro/ui exec vitest run test/overlays.test.tsx`

  Expected: FAIL on initial focus, inertness, body overflow, busy dismissal, and/or size classes until Step 6 is implemented.

- [ ] **Step 6: Complete focus/inert and Radix-portal behavior, then add panel CSS, motion, responsive behavior, and z-index tokens**

  On first layer registration, save `document.body.style.overflow`, set it to `hidden`, snapshot every other direct body child's `inert` value, and set those children inert. When a nested layer registers, set all earlier layer elements inert; when it unregisters, make only the new top layer interactive. When the final layer unregisters, restore the exact body overflow, restore and clear the inert snapshot, then remove the host.

  Capture `document.activeElement` immediately before registration. After unregistering and removing the layer, restore focus only when the captured element is an attached `HTMLElement`; this restores the originating row/action but does not focus detached direct-link content.

  Create an internal React context whose value is the registered layer element. Wrap the layer's portaled children in its provider and implement `useOverlayPortalContainer()` as the sibling-only consumer. Update `Select` and `DatePicker` to pass that container to their Radix `Portal`; omit the `container` prop when the hook returns `undefined` so existing standalone and legacy-Modal behavior is unchanged. Add `data-mk-nested-overlay=""` to `RadixSelect.Content` and `RadixPopover.Content`; this is an internal Escape-routing marker, not a public selector contract.

  Within the top layer, trap Tab and Shift+Tab using this selector. Query the registered layer element, not only the panel surface, so an owned Radix listbox/calendar is inside the same focus boundary:

  ```ts
  const FOCUSABLE_SELECTOR = [
    "a[href]",
    "button:not([disabled])",
    "textarea:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    '[tabindex]:not([tabindex="-1"])',
  ].join(", ");
  ```

  On mount, focus `[aria-invalid="true"]`, then the first enabled editable control for `first-editable`, then any focusable control, then the surface. For `cancel`, focus `[data-overlay-cancel]` before the generic fallback.

  Add tokens to the final spacing/elevation `:root` block:

  ```css
  --z-modal-legacy: 100;
  --z-overlay-panel: 400;
  --z-overlay-popover: 420;
  --z-overlay-dialog: 440;
  --z-toast: 500;
  ```

  Add CSS with these exact layout constraints:

  ```css
  .mk-overlay-root {
    position: relative;
  }
  .mk-overlay-layer {
    position: fixed;
    inset: 0;
  }
  .mk-overlay-layer--panel {
    z-index: var(--z-overlay-panel);
  }
  .mk-overlay-layer--dialog {
    z-index: var(--z-overlay-dialog);
  }
  .mk-side-panel__scrim {
    position: fixed;
    inset: 0;
    display: flex;
    justify-content: flex-end;
    background: var(--surface-overlay);
  }
  .mk-side-panel {
    width: min(100%, var(--mk-panel-width));
    height: 100dvh;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    background: var(--surface-card);
    border-left: 1px solid var(--line);
    box-shadow: var(--shadow-3);
    outline: none;
    animation: mk-panel-in 200ms ease-out;
  }
  .mk-side-panel--compact {
    --mk-panel-width: 480px;
  }
  .mk-side-panel--standard {
    --mk-panel-width: min(640px, 64vw);
  }
  .mk-side-panel--complex {
    --mk-panel-width: min(720px, 64vw);
  }
  .mk-side-panel__body {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--sp-6);
  }
  @media (max-width: 767px) {
    .mk-side-panel {
      --mk-panel-width: 100vw;
      border-left: 0;
      border-radius: 0;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .mk-side-panel {
      animation: none;
    }
    .mk-side-panel__scrim {
      animation-duration: 1ms;
      transition-duration: 1ms;
    }
  }
  ```

  The root must not create a stacking context: each fixed layer owns its global z-index, so a dialog layer at 440 remains above a panel-owned popover while a standalone popover at 420 remains above a legacy modal at 100. Complete the header/footer spacing, focus-visible close control, scrim fade keyframes, and X-only transform keyframes using existing tokens. Do not animate width, height, inset, or other layout properties.

  Replace `Modal.tsx`'s `zIndex: 100` with `zIndex: "var(--z-modal-legacy)"`, `Select.tsx` and `DatePicker.tsx`'s `zIndex: 1000` with `zIndex: "var(--z-overlay-popover)"`, and `Toast.tsx`'s `zIndex: 200` with `zIndex: "var(--z-toast)"`. Make no other legacy/custom-control behavior changes.

  In the existing `components.test.tsx` Select suite and `date-picker.test.tsx`, open each control outside an overlay and assert its content has `style.zIndex === "var(--z-overlay-popover)"`. Their existing click, keyboard, disabled, error, value, and focus-restoration assertions must stay unchanged.

- [ ] **Step 7: Run SidePanel tests and package type checks**

  Run: `pnpm --filter @markiro/ui exec vitest run test/overlays.test.tsx test/feedback.test.tsx test/components.test.tsx test/date-picker.test.tsx`

  Run: `pnpm --filter @markiro/ui typecheck`

  Expected: PASS; the existing `Modal`, Select, and DatePicker behavior remains green, child Escape never closes the panel, and the new overlay host is absent after every test.

- [ ] **Step 8: Commit the SidePanel contract**

  ```bash
  git add packages/ui/src/components/OverlayLayer.tsx packages/ui/src/components/SidePanel.tsx packages/ui/src/components/Select.tsx packages/ui/src/components/DatePicker.tsx packages/ui/src/components.css packages/ui/src/tokens.css packages/ui/src/components/Modal.tsx packages/ui/src/components/Toast.tsx packages/ui/src/components/index.ts packages/ui/test/overlays.test.tsx packages/ui/test/components.test.tsx packages/ui/test/date-picker.test.tsx
  git commit -m "feat(ui): add accessible side panel"
  ```

---

### Task 2: Shared ConfirmDialog and nested overlay behavior

**Files:**

- Create: `packages/ui/src/components/ConfirmDialog.tsx`
- Modify: `packages/ui/src/components.css`
- Modify: `packages/ui/src/components/index.ts`
- Modify: `packages/ui/test/overlays.test.tsx`

**Interfaces:**

- Consumes: private `OverlayLayer` from Task 1 and existing `Button` variants.
- Produces:

  ```ts
  export type ConfirmDialogTone = "default" | "destructive";

  export interface ConfirmDialogProps {
    open: boolean;
    title: ReactNode;
    description: ReactNode;
    entity?: ReactNode;
    confirmLabel: string;
    cancelLabel: string;
    tone?: ConfirmDialogTone;
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }
  ```

- `ConfirmDialog` has no general form slot and no close-X control. Escape and backdrop call `onCancel` only when idle.

- [ ] **Step 1: Add failing confirmation semantics tests**

  Add to `overlays.test.tsx`:

  ```tsx
  it("focuses Cancel and exposes one explicit destructive action", () => {
    render(
      <ConfirmDialog
        open
        title="Delete product?"
        description="This cannot be undone."
        entity="Milk 1 L"
        cancelLabel="Cancel"
        confirmLabel="Delete"
        tone="destructive"
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole("alertdialog", { name: "Delete product?" })).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete" }).className).toContain("destructive");
  });

  it("maps Escape and backdrop to Cancel but blocks dismissal and submit while busy", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ConfirmDialog
        open
        title="Close shift?"
        description="Consequence"
        cancelLabel="Cancel"
        confirmLabel="Close"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(
      <ConfirmDialog
        open
        busy
        title="Close shift?"
        description="Consequence"
        cancelLabel="Cancel"
        confirmLabel="Close"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    await user.keyboard("{Escape}");
    await user.click(document.querySelector(".mk-confirm-dialog__scrim") as HTMLElement);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
  ```

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `pnpm --filter @markiro/ui exec vitest run test/overlays.test.tsx`

  Expected: FAIL because `ConfirmDialog` is not exported.

- [ ] **Step 3: Implement ConfirmDialog through OverlayLayer**

  Render `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby`, and `aria-describedby`. Pass `kind="dialog"`, `initialFocus="cancel"`, and the current `busy` value to `OverlayLayer`. The Cancel button carries `data-overlay-cancel`, the confirm button uses `variant={tone === "destructive" ? "destructive" : "primary"}`, and both buttons are disabled while busy; the confirm button also receives `loading={busy}`.

  Use `onMouseDown` on the scrim and only cancel when `event.target === event.currentTarget`. Keep the consequence and optional entity identity as separate elements so a screen reader announces the consequence through `aria-describedby` without duplicating the title.

- [ ] **Step 4: Add failing nested-layer tests**

  Add a harness with an open `SidePanel` and an open `ConfirmDialog`, then assert:

  ```tsx
  expect(screen.getByRole("dialog", { name: "Edit product" })).toBeDefined();
  expect(screen.getByRole("alertdialog")).toBeDefined();
  expect(document.querySelector(".mk-overlay-layer--panel")?.inert).toBe(true);
  expect(document.querySelector(".mk-overlay-layer--dialog")?.inert).toBe(false);

  await user.keyboard("{Escape}");
  expect(onDialogCancel).toHaveBeenCalledTimes(1);
  expect(onPanelClose).not.toHaveBeenCalled();
  expect(document.body.style.overflow).toBe("hidden");

  rerender(<Harness confirmOpen={false} />);
  expect(document.querySelector(".mk-overlay-layer--panel")?.inert).toBe(false);
  expect(
    screen.getByRole("dialog", { name: "Edit product" }).contains(document.activeElement),
  ).toBe(true);
  ```

  Add a second nested case whose panel contains a controlled `Select`. Open its listbox, rerender the harness with `confirmOpen={true}` without closing the Select, and assert the listbox remains inside `.mk-overlay-layer--panel`, that entire layer is inert, and `.mk-overlay-layer--dialog` is the only interactive layer. This proves the merged Radix portal cannot escape the lower overlay boundary or paint above the confirmation.

  Close the panel last and assert that body inertness, overflow, and trigger focus restore only after the stack is empty.

  Run: `pnpm --filter @markiro/ui exec vitest run test/overlays.test.tsx`

  Expected: FAIL because `ConfirmDialog` is not implemented and the lower panel is not yet made inert by a nested dialog.

- [ ] **Step 5: Complete dialog CSS and make nested tests GREEN**

  Add a centered quiet scrim, a `min(440px, calc(100vw - 32px))` dialog surface, bounded consequence width, entity identity treatment, and a right-aligned action row that stacks below 480 px. Use `--z-overlay-dialog`, existing border/shadow/radius tokens, and the same reduced-motion rule as SidePanel.

  Run: `pnpm --filter @markiro/ui exec vitest run test/overlays.test.tsx test/feedback.test.tsx`

  Run: `pnpm --filter @markiro/ui typecheck`

  Expected: PASS with the dialog alone and above an open panel.

- [ ] **Step 6: Commit ConfirmDialog**

  ```bash
  git add packages/ui/src/components/ConfirmDialog.tsx packages/ui/src/components.css packages/ui/src/components/index.ts packages/ui/test/overlays.test.tsx
  git commit -m "feat(ui): add confirmation dialog"
  ```

---

### Task 3: Catalog nested routes and write-capability boundary

**Files:**

- Create: `apps/admin/src/pages/catalog/ProductPanelRoute.tsx`
- Create: `apps/admin/test/catalog-routing.test.tsx`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/pages/catalog/index.tsx`
- Modify: `apps/admin/test/access-routing.test.tsx`

**Interfaces:**

- Consumes: `RequireCapability`, `CABINET_CAPABILITY.OPERATIONS_WRITE`, `CatalogPage`, and React Router `Outlet`, `useNavigate`, `useLocation`, `useParams`, and `useOutletContext`.
- Produces:

  ```ts
  export interface CatalogPanelContext {
    products: ProductDto[];
    productsPending: boolean;
    productsError: boolean;
    counterparties: CounterpartyDto[];
    counterpartiesPending: boolean;
    counterpartiesError: boolean;
    labelTemplates: LabelTemplateSummaryDto[];
    labelTemplatesPending: boolean;
    labelTemplatesError: boolean;
    retryPanelData: () => Promise<void>;
  }

  export type CatalogPanelLocationState = { catalogBackground: true };
  export function ProductPanelRoute({ mode }: { mode: "create" | "edit" }): ReactElement;
  ```

- `ProductPanelRoute` may initially render a labelled placeholder in this task; Tasks 4 and 5 replace it with the complete panel. It must not call mutation hooks until Task 4.

- [ ] **Step 1: Add failing nested-route and list-state tests**

  In `catalog-routing.test.tsx`, reuse the existing `QueryClientProvider`, `AccessProvider`, and `MemoryRouter` pattern. Use a native response helper with no broad assertion:

  ```ts
  function jsonResponse(status: number, body: unknown): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  ```

  Define the route harness with the same shape as production:

  ```tsx
  function CatalogRouteHarness({ initialEntries = ["/catalog"] }: { initialEntries?: string[] }) {
    return (
      <MemoryRouter initialEntries={initialEntries}>
        <LocationProbe />
        <Routes>
          <Route path="/catalog" element={<CatalogPage />}>
            <Route
              path="new"
              element={
                <RequireCapability capability={C.OPERATIONS_WRITE}>
                  <ProductPanelRoute mode="create" />
                </RequireCapability>
              }
            />
            <Route
              path=":productId/edit"
              element={
                <RequireCapability capability={C.OPERATIONS_WRITE}>
                  <ProductPanelRoute mode="edit" />
                </RequireCapability>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    );
  }
  ```

  Add three tests:

  1. Type `milk` into Search, click `Add product`, assert the pathname is `/catalog/new`, the panel placeholder is present, and the Search value remains `milk`.
  2. From a rendered product row click Edit, assert `/catalog/p1/edit`; use a probe button that calls `navigate(-1)`, then assert `/catalog`, the panel is gone, and Search still contains its prior value.
  3. Start directly at `/catalog/new`, click the placeholder Close button, and assert the location becomes `/catalog` via replacement rather than navigating to the previous `initialEntries` item.

- [ ] **Step 2: Run the route test and verify RED**

  Run: `pnpm --filter @markiro/admin exec vitest run test/catalog-routing.test.tsx`

  Expected: FAIL because Catalog has no child routes or outlet.

- [ ] **Step 3: Add production child routes with the write guard outside the route component**

  Replace the flat Catalog route in `app.tsx` with:

  ```tsx
  <Route
    path="catalog"
    element={
      <RequireCapability capability={C.OPERATIONS_READ}>
        <CatalogPage />
      </RequireCapability>
    }
  >
    <Route
      path="new"
      element={
        <RequireCapability capability={C.OPERATIONS_WRITE}>
          <ProductPanelRoute mode="create" />
        </RequireCapability>
      }
    />
    <Route
      path=":productId/edit"
      element={
        <RequireCapability capability={C.OPERATIONS_WRITE}>
          <ProductPanelRoute mode="edit" />
        </RequireCapability>
      }
    />
  </Route>
  ```

  The guard must wrap `ProductPanelRoute`, not render inside it, so rejected direct URLs cannot mount privileged hooks added in Task 4.

- [ ] **Step 4: Lift editor data into outlet context and replace local edit/open state with navigation**

  In `CatalogPage`, retain the existing query hooks and local search/status state. Build `retryPanelData` with `Promise.all` over the three existing `refetch()` functions and render `<Outlet context={panelContext} />` after the list.

  Replace `AuthorizedCreateProductAction` with a button that calls:

  ```ts
  navigate("new", { state: { catalogBackground: true } satisfies CatalogPanelLocationState });
  ```

  Replace each row Edit handler with:

  ```ts
  navigate(`${product.id}/edit`, {
    state: { catalogBackground: true } satisfies CatalogPanelLocationState,
  });
  ```

  Remove `editingProduct`, local create `open`, `useCreateProduct`, `useUpdateProduct`, and the form instances from `index.tsx`. Leave delete behavior unchanged until Task 5.

  In the initial `ProductPanelRoute`, read the outlet context and render a simple `SidePanel` with the correct title, Close action, and loading/error/not-found text. Implement close fallback exactly:

  ```ts
  function closeCatalogPanel(location: Location, navigate: NavigateFunction) {
    if ((location.state as CatalogPanelLocationState | null)?.catalogBackground === true) {
      navigate(-1);
    } else {
      navigate("/catalog", { replace: true });
    }
  }
  ```

  For edit mode, do not render an empty editor while products are pending, failed, or the requested ID is absent after a successful load.

- [ ] **Step 5: Add direct-route authorization regression tests**

  Extend `access-routing.test.tsx` with:

  ```tsx
  it.each(["/catalog/new", "/catalog/p1/edit"])(
    "forbids the direct write route %s for a read-only operator",
    async (path) => {
      renderAccessRoute(path, OPERATIONS_READ_ONLY);
      expect(await screen.findByTestId("forbidden-page")).toBeDefined();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );
  ```

  In `catalog-routing.test.tsx`, keep the existing hoisted spies for `useCreateProduct`, `useUpdateProduct`, `useDeleteProduct`, and `useUnlinkProduct`; render direct URLs with read-only access and assert every spy remains untouched. The fetch mock may observe the existing read-only list requests, but no write mutation hook may mount.

- [ ] **Step 6: Run route and access tests and verify GREEN**

  Run: `pnpm --filter @markiro/admin exec vitest run test/catalog-routing.test.tsx test/access-routing.test.tsx test/catalog.test.tsx`

  Expected: PASS; existing catalog tests may use the updated route harness but no payload assertion changes.

- [ ] **Step 7: Commit nested routing**

  ```bash
  git add apps/admin/src/app.tsx apps/admin/src/pages/catalog/index.tsx apps/admin/src/pages/catalog/ProductPanelRoute.tsx apps/admin/test/catalog-routing.test.tsx apps/admin/test/access-routing.test.tsx apps/admin/test/catalog.test.tsx
  git commit -m "feat(admin): route catalog editors through nested panels"
  ```

---

### Task 4: Product form panel, sections, mutations, and persistent errors

**Files:**

- Modify: `apps/admin/src/pages/catalog/ProductPanelRoute.tsx`
- Modify: `apps/admin/src/pages/catalog/ProductForm.tsx`
- Create: `apps/admin/src/pages/catalog/catalog.css`
- Modify: `apps/admin/src/pages/catalog/index.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/catalog-routing.test.tsx`
- Modify: `apps/admin/test/catalog.test.tsx`

**Interfaces:**

- Consumes: `SidePanel`, `OverlayDismissReason`, `useCreateProduct`, `useUpdateProduct`, the Task 3 outlet context, and existing `ProductFormValues`/`CreateProductInput` contracts.
- Produces this revised form contract:

  ```ts
  export interface ProductFormProps {
    mode: "create" | "edit";
    initialValues?: ProductFormValues;
    productStatus?: ProductStatus;
    productId?: string;
    externalRef?: string | null;
    counterparties: CounterpartyDto[];
    labelTemplates: LabelTemplateSummaryDto[];
    submitting?: boolean;
    submissionError?: string | null;
    onDirtyChange: (dirty: boolean) => void;
    onSubmit: (input: CreateProductInput) => void | Promise<void>;
    onClose: (reason: OverlayDismissReason) => void;
  }
  ```

- `toCreateInput` remains byte-for-byte behaviorally equivalent: trimmed optional text maps to `null`, numeric capacities map to numbers or `null`, comma decimal maps to dot decimal, and `status` is never sent.

- [ ] **Step 1: Add failing panel-section and form-preservation tests**

  Adapt the Catalog test harness to render production-like nested routes. Keep all current tests for invalid/valid GTIN, owner hints, stale responses, template ID, unit price/EGAIS, draft banner, and unlink permissions.

  Add assertions after opening create:

  ```tsx
  const panel = await screen.findByRole("dialog", { name: "Новый продукт" });
  expect(within(panel).getByRole("heading", { name: "Основное" })).toBeDefined();
  expect(within(panel).getByRole("heading", { name: "Агрегация и цена" })).toBeDefined();
  expect(within(panel).getByRole("heading", { name: "Значения по умолчанию" })).toBeDefined();
  expect(panel.classList.contains("mk-side-panel--standard")).toBe(true);
  ```

  Add a mutation-failure test that fills valid values, makes POST return 500, clicks Create, and asserts the inline `Не удалось создать продукт` alert and entered Name remain visible inside the still-open panel.

- [ ] **Step 2: Run the focused Catalog tests and verify RED**

  Run: `pnpm --filter @markiro/admin exec vitest run test/catalog.test.tsx test/catalog-routing.test.tsx`

  Expected: FAIL because ProductForm still renders `Modal`, has no sections, and closes/errors are not route-owned.

- [ ] **Step 3: Refactor ProductForm presentation without changing payload behavior**

  Remove `open` from `ProductFormProps` and replace `Modal` with a `SidePanel open size="standard"`. Destructure `formState: { errors, isDirty }` and publish it:

  ```ts
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);
  ```

  Reset only when the editor identity changes, not when a live linkage ref changes. Use a `formIdentity` prop or a stable `initialValues` object keyed by mode/product ID, then keep linkage synchronization in its own effect:

  ```ts
  useEffect(() => {
    reset(initialValues ?? EMPTY_VALUES);
    setOwnerHint(null);
    lastCheckedGtinRef.current = (initialValues?.gtin ?? "").trim() || null;
  }, [initialValues, reset]);

  useEffect(() => {
    setLinkedExternalRef(externalRef ?? null);
  }, [externalRef]);
  ```

  Preserve the stale GTIN response comparison against `getValues("gtin")`. Render `submissionError` as `Alert tone="error"` above the first section. Wrap fields in three semantic sections:

  - `basic`: draft/link alerts, GTIN, owner hint, Name, Product group.
  - `aggregation`: Box capacity, Pallet capacity, Unit price, EGAIS code.
  - `defaults`: Counterparty and Label template.

  Use `<section aria-labelledby>` and `<h3>` for each translated heading. Keep the existing `product-form` ID, submit button labels, and field labels so current assistive queries and payload tests remain stable.

  Keep both merged custom Select integrations unchanged: `defaultCounterpartyId` and `defaultLabelTemplateId` continue to use `onValueChange`, not the pre-PR `onChange` callback. Do not reintroduce `HTMLSelectElement`, `<option>`, `fireEvent.change` on a select, or native-select assertions; retain the current `userEvent` `combobox`/`option` helpers in `catalog.test.tsx`.

- [ ] **Step 4: Implement route-owned create/update mutations and load states**

  Split the route by mode so hooks remain explicit:

  ```tsx
  export function ProductPanelRoute({ mode }: { mode: "create" | "edit" }) {
    return mode === "create" ? <CreateProductPanel /> : <EditProductPanel />;
  }
  ```

  `CreateProductPanel` calls only `useCreateProduct`; `EditProductPanel` calls only `useUpdateProduct`. Both keep `dirty` and `submissionError` in local state. On submit, clear the persistent error, await `mutateAsync`, keep the current success toast, and close through the background/direct fallback only after success. On error, set the exact API error message when `error instanceof ApiRequestError`, otherwise use the existing translated generic error; do not close or reset the form.

  For edit, compute `initialValues` with `useMemo` from the product's editable field primitives and exclude `externalRef` from the dependency key. This preserves unsaved input and the existing unlink stale-ref regression when the products query refreshes.

  Use a shape-matched panel loading body while required data is pending. On dependency error, render Retry and Close inside the open panel. If edit data finishes without the requested product, render `pages.catalog.form.notFound` and Close; never render blank editable fields.

- [ ] **Step 5: Add and pass exact payload and stale-link regression assertions**

  Keep the existing create payload assertion exactly:

  ```ts
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/products",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        gtin: "4006381333931",
        name: "Молоко 1л",
        productGroup: null,
        boxCapacity: null,
        palletCapacity: null,
        unitPrice: null,
        egaisCode: null,
        defaultCounterpartyId: "cp1",
        defaultLabelTemplateId: null,
      }),
    }),
  );
  ```

  Keep the current PATCH round-trip assertion for untouched `unitPrice`/`egaisCode` and the current `не восстанавливает плашку связи с 1С после успешного разрыва` test. Add one extra edit assertion: type an unsaved Name, resolve the unlink/refetch, and assert the typed Name is still present.

- [ ] **Step 6: Add Catalog panel and section styles plus bilingual copy**

  Import `catalog.css` from `index.tsx`. Define `.mk-catalog-panel-section`, section heading/supporting-copy styles, a two-column aggregation grid that collapses below 560 px, full-width alerts, and a skeleton whose rows match the three sections. Use only UI tokens.

  Add matching keys to both locale files:

  ```json
  "sections": {
    "basic": "Основное",
    "aggregation": "Агрегация и цена",
    "defaults": "Значения по умолчанию"
  },
  "loadError": "Не удалось загрузить данные продукта.",
  "notFound": "Продукт не найден или больше недоступен.",
  "retry": "Повторить"
  ```

  English values are `Basic`, `Aggregation and price`, `Defaults`, `Could not load product data.`, `Product was not found or is no longer available.`, and `Retry`.

- [ ] **Step 7: Run focused tests and verify GREEN**

  Rebuild the UI package first because Admin imports its compiled export:

  Run: `pnpm --filter @markiro/ui build`

  Run: `pnpm --filter @markiro/admin exec vitest run test/catalog.test.tsx test/catalog-routing.test.tsx test/access-routing.test.tsx`

  Expected: PASS with unchanged request bodies, retained input on failures/refetch, and route close only after a successful mutation.

- [ ] **Step 8: Commit ProductPanel behavior**

  ```bash
  git add apps/admin/src/pages/catalog/ProductPanelRoute.tsx apps/admin/src/pages/catalog/ProductForm.tsx apps/admin/src/pages/catalog/catalog.css apps/admin/src/pages/catalog/index.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/catalog-routing.test.tsx apps/admin/test/catalog.test.tsx
  git commit -m "feat(admin): move product editing to side panels"
  ```

---

### Task 5: Dirty navigation guard and product confirmation dialog

**Files:**

- Modify: `apps/admin/src/pages/catalog/ProductPanelRoute.tsx`
- Modify: `apps/admin/src/pages/catalog/index.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/catalog-routing.test.tsx`
- Modify: `apps/admin/test/catalog.test.tsx`

**Interfaces:**

- Consumes: React Router 8 `useBlocker`, `ConfirmDialog`, `OverlayDismissReason`, and route-owned `dirty`/`submitting` state from Task 4.
- Produces no new package API. Catalog owns two separate confirmations: unsaved-form discard above a panel and product deletion above the list.

- [ ] **Step 1: Add failing dirty-dismissal tests for every close source**

  In `catalog-routing.test.tsx`, parameterize close button, Escape, and backdrop. For each, open create from the list, type a valid change, invoke the close source, and assert:

  ```tsx
  expect(screen.getByRole("alertdialog", { name: "Отменить изменения?" })).toBeDefined();
  expect(screen.getByRole("dialog", { name: "Новый продукт" })).toBeDefined();
  expect(screen.getByTestId("location").textContent).toBe("/catalog/new");
  ```

  Click `Продолжить редактирование` and assert the confirm closes while the panel and field value remain. Repeat once with `Не сохранять` and assert the panel closes to `/catalog`.

- [ ] **Step 2: Add failing Back-navigation and pending-mutation tests**

  From `/catalog`, open `/catalog/new`, dirty the form, and call `navigate(-1)` through the route probe. Assert `useBlocker` keeps `/catalog/new` active and opens the same `ConfirmDialog`. Cancel must call `blocker.reset()`; discard must call `blocker.proceed()` and return to the preserved list.

  Add a POST promise controlled by the test. While it is unresolved, assert the panel close button and Cancel are disabled, Escape/backdrop do nothing, the route probe's Back attempt remains at `/catalog/new`, and Create cannot submit twice. Resolve the request and assert the route closes once.

  Run: `pnpm --filter @markiro/admin exec vitest run test/catalog-routing.test.tsx`

  Expected: FAIL because close intent still navigates immediately and no navigation blocker or discard confirmation exists.

- [ ] **Step 3: Implement one feature-owned close state machine**

  In each create/edit panel controller, derive:

  ```ts
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      (dirty || mutation.isPending) && currentLocation.pathname !== nextLocation.pathname,
  );
  const [pendingDismiss, setPendingDismiss] = useState<OverlayDismissReason | null>(null);
  const confirmOpen = dirty && (pendingDismiss !== null || blocker.state === "blocked");
  ```

  When `blocker.state` becomes `blocked` for a dirty idle form, treat it as `requestClose("navigation")`; the blocker object remains the source of truth for proceeding or resetting the attempted destination.

  Handle panel close intent as follows:

  ```ts
  function requestClose(reason: OverlayDismissReason) {
    if (mutation.isPending) return;
    if (dirty) setPendingDismiss(reason);
    else closeToCatalog();
  }
  ```

  `Continue editing` clears `pendingDismiss` and calls `blocker.reset()` only when blocked. `Discard` clears the local dirty state and then either calls `blocker.proceed()` for navigation or `closeToCatalog()` for a panel-generated dismiss. Never open the confirmation while pending; if a navigation is blocked during pending, immediately reset that blocked transition and leave the panel unchanged.

  Render `ConfirmDialog` after `ProductForm` so it becomes the top overlay. Use destructive tone, Cancel initial focus, and the new translated copy.

- [ ] **Step 4: Add failing deletion confirmation tests**

  In `catalog.test.tsx`, click Delete and assert a standalone `alertdialog` with exact product identity, Cancel, and Delete. Assert Escape cancels without a DELETE request. Reopen, click Delete, keep the DELETE promise pending, and assert both buttons are disabled and duplicate click/Escape/backdrop produce exactly one request. Resolve successfully and assert the dialog closes and the existing success toast remains.

  Add a failure case: return 500, assert the dialog remains open and a persistent inline error is visible. Do not accept a toast-only assertion.

  Run: `pnpm --filter @markiro/admin exec vitest run test/catalog.test.tsx`

  Expected: FAIL because Catalog deletion still uses legacy `Modal`, permits pending dismissal, and has no persistent error content.

- [ ] **Step 5: Replace Catalog delete Modal with ConfirmDialog**

  In `AuthorizedProductRowActions`, retain the capability-owned `useDeleteProduct` hook and local selected product. Replace `Modal` with:

  ```tsx
  <ConfirmDialog
    open={deleting}
    title={t("pages.catalog.deleteConfirmTitle")}
    description={t("pages.catalog.deleteConfirmBody", { name: product.name })}
    entity={product.gtin14}
    cancelLabel={t("pages.catalog.cancel")}
    confirmLabel={t("pages.catalog.deleteConfirmAction")}
    tone="destructive"
    busy={deleteMutation.isPending}
    onCancel={() => setDeleting(false)}
    onConfirm={() => void handleDelete()}
  />
  ```

  Store a local delete error, clear it before a new request, and render it inside the dialog's description content using an `Alert tone="error"` beneath the consequence. Because the public `description` accepts `ReactNode`, no general form slot is needed.

- [ ] **Step 6: Add bilingual dirty/error copy and run focused tests**

  Add exact RU/EN pairs:

  - `discardTitle`: `Отменить изменения?` / `Discard changes?`
  - `discardBody`: `Несохранённые изменения будут потеряны.` / `Your unsaved changes will be lost.`
  - `continueEditing`: `Продолжить редактирование` / `Continue editing`
  - `discardAction`: `Не сохранять` / `Discard`

  Run: `pnpm --filter @markiro/admin exec vitest run test/catalog-routing.test.tsx test/catalog.test.tsx test/access-routing.test.tsx`

  Expected: PASS for all close sources, blocked Back, direct fallback, pending state, deletion success/failure, and exact write-hook denial.

- [ ] **Step 7: Commit Catalog safety and deletion**

  ```bash
  git add apps/admin/src/pages/catalog/ProductPanelRoute.tsx apps/admin/src/pages/catalog/index.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/catalog-routing.test.tsx apps/admin/test/catalog.test.tsx
  git commit -m "feat(admin): guard catalog edits and confirmations"
  ```

---

### Task 6: Catalog page alignment and complete verification

**Files:**

- Modify: `apps/admin/src/pages/catalog/catalog.css`
- Modify: `apps/admin/src/pages/catalog/index.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/catalog.test.tsx`
- Review only: all files changed by Tasks 1-5

**Interfaces:**

- Consumes: completed overlay primitives and route-backed Catalog interactions.
- Produces: one reference CRUD page aligned with the dashboard's bounded layout; no shared `AdminPage`, `FilterBar`, or `RowActions` abstraction until a second page proves reuse.

- [ ] **Step 1: Add failing Catalog layout and bilingual behavior assertions**

  Add stable semantic/class assertions rather than pixel assertions:

  ```tsx
  expect(screen.getByTestId("catalog-page").classList).toContain("mk-catalog-page");
  expect(screen.getByRole("group", { name: "Фильтры каталога" })).toBeDefined();
  expect(screen.getByText("2 продукта")).toBeDefined();
  ```

  Switch i18n to English, render again, and assert `Catalog filters`, `2 products`, `Add product`, and the translated panel close label. Restore RU in `afterEach`.

- [ ] **Step 2: Run the Catalog test and verify RED**

  Run: `pnpm --filter @markiro/admin exec vitest run test/catalog.test.tsx`

  Expected: FAIL because the current page has inline layout styles and no labelled filter group/result summary.

- [ ] **Step 3: Apply the bounded page and filter/action layout locally**

  Replace the page wrapper's inline styles with `className="mk-catalog-page" data-testid="catalog-page"`. Match the dashboard content bound and responsive padding already established in `dashboard.css`; do not introduce a shared primitive from one consumer.

  Wrap Search and Status in `role="group" aria-label={t("pages.catalog.filtersLabel")}` with `.mk-catalog-filters`, add a polite result summary using the existing loaded `items.length`, and keep filter controls labelled individually. Use CSS grid/flex so controls wrap without horizontal scrolling below 768 px.

  Keep Edit as a visible secondary button and Delete as a visible destructive button in a consistent `.mk-catalog-row-actions` region. Do not hide either action in an unlabeled icon or hover-only menu.

  Add i18n pluralization keys compatible with the repository's current i18next configuration:

  ```json
  "filtersLabel": "Фильтры каталога",
  "resultCount_one": "{{count}} продукт",
  "resultCount_few": "{{count}} продукта",
  "resultCount_many": "{{count}} продуктов",
  "resultCount_other": "{{count}} продукта"
  ```

  Add the English `Catalog filters`, `{{count}} product`, and `{{count}} products` forms.

- [ ] **Step 4: Run focused UI and Admin tests**

  Run: `pnpm --filter @markiro/ui exec vitest run test/overlays.test.tsx test/feedback.test.tsx`

  Run: `pnpm --filter @markiro/ui build`

  Run: `pnpm --filter @markiro/admin exec vitest run test/catalog.test.tsx test/catalog-routing.test.tsx test/access-routing.test.tsx`

  Expected: PASS with no React act, duplicate-key, missing-translation, or focus warnings.

- [ ] **Step 5: Run full package gates**

  Run: `pnpm --filter @markiro/ui test`

  Run: `pnpm --filter @markiro/ui typecheck`

  Run: `pnpm --filter @markiro/ui lint`

  Run: `pnpm --filter @markiro/ui build`

  Run: `pnpm --filter @markiro/admin test`

  Run: `pnpm --filter @markiro/admin typecheck`

  Run: `pnpm --filter @markiro/admin lint`

  Run: `pnpm --filter @markiro/admin build`

  Expected: every command exits 0. Report any infrastructure skip separately; a build does not replace DOM or browser verification.

- [ ] **Step 6: Run repository hygiene checks**

  Run: `git diff --check origin/main...HEAD`

  Run: `pnpm format:check`

  Run: `git diff --unified=0 origin/main...HEAD -- packages/ui apps/admin docs/superpowers | rg -n '^\+[^+].*(—|–)'`

  Expected: no whitespace errors, formatting passes, and the final command has no match for newly added dash characters. Existing repository text outside added diff lines cannot fail the audit.

- [ ] **Step 7: Perform browser and accessibility review if local infrastructure permits**

  Run the Admin app with its normal development services and verify both create and edit at 1440 px, 1024 px, 768 px, and one viewport narrower than 768 px in light and dark themes. Check:

  - panel width caps, full-screen mobile layout, safe-area spacing, body-only scrolling, sticky header/footer, and no horizontal overflow;
  - long RU and EN titles, field errors, delete/discard copy, and button wrapping;
  - exact trigger focus restoration, visible keyboard focus, Tab/Shift+Tab containment, topmost Escape, background inertness, and reduced motion;
  - Search/status and list scroll preservation after Back and explicit close;
  - direct `/catalog/new`, direct `/catalog/:id/edit`, not-found ID, read-only denial, request failure, and pending request states.

  Automated DOM tests do not count as this browser confirmation. Record any untested screen reader, mobile virtual keyboard, or browser behavior explicitly in the final report.

- [ ] **Step 8: Review the final diff and commit page alignment**

  Inspect: `git diff --stat origin/main...HEAD` and `git diff origin/main...HEAD -- apps/admin packages/ui docs/superpowers`

  Verify there are no backend, DTO, dependency, lockfile, dashboard, or later-wave page changes.

  ```bash
  git add apps/admin/src/pages/catalog/catalog.css apps/admin/src/pages/catalog/index.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/catalog.test.tsx
  git commit -m "style(admin): align catalog with dashboard layout"
  ```

---

## Completion report contract

The implementation handoff must list separately:

1. Behavior changed: SidePanel/ConfirmDialog semantics, Radix child-overlay containment, Catalog nested routes, dirty guard, deletion, and page alignment.
2. Files or areas changed: `packages/ui` overlays plus Select/DatePicker portal integration, and Catalog-only Admin files.
3. Automated checks: every focused and package command with pass/fail/skip counts.
4. Manual checks: exact themes, viewport sizes, keyboard paths, and direct URLs actually exercised.
5. Checks not run: browser, assistive technology, mobile keyboard, or infrastructure limitations with reasons.

Do not claim later admin pages are redesigned. Their migrations remain staged under `docs/superpowers/specs/2026-08-05-admin-interaction-redesign-design.md`.
