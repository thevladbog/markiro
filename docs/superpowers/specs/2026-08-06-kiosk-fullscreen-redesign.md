# Kiosk Fullscreen Redesign

## Status

Approved for implementation on 2026-08-06.

## Design read

This is a redesign-preserve pass for a factory touch kiosk used by employees at
a gate or pickup point. The visual language stays dark, direct, and instrument-
like, using the existing Markiro design system and the high-fidelity kiosk
handoff as sources of truth.

- `DESIGN_VARIANCE`: 3. Stable, predictable placement matters more than visual
  surprise.
- `MOTION_INTENSITY`: 2. Motion is limited to immediate pressed and state-change
  feedback.
- `VISUAL_DENSITY`: 7. The interface is operational and compact, while primary
  touch targets remain 56-84 px.

## Goal

Make every kiosk screen fill the available display without page-level scrolling,
restore the intended IBM Plex typography, and bring commissioning screens up to
the visual quality of the core pickup flow without changing offline behavior.

## Hard invariants

1. `html`, `body`, `#root`, and the kiosk shell fill exactly `100dvh`.
2. The page itself never scrolls at the target sizes 1180x800 and 800x1180.
3. Persistent bars and headers consume space inside the shell. The active screen
   receives the remaining height through `flex: 1` and `min-height: 0`.
4. Only bounded content regions may scroll when their data genuinely exceeds the
   available area, such as a product list, conflict list, or long setup details.
5. Primary actions remain visible without page scrolling.
6. The kiosk keeps bundled fonts and assets. No runtime CDN or new dependency is
   introduced.
7. Offline queueing, badge verification, daily limits, device identity, and sync
   behavior remain unchanged.

## Approaches considered

### A. Patch each screen independently

Replace `min-height: 100vh` and add local overflow rules in every component.
This is the smallest diff, but it leaves the same viewport contract duplicated
across seven screens and is easy to break when another persistent bar is added.

### B. Introduce a kiosk layout layer, recommended

Add one kiosk stylesheet with shared shell, screen, setup, control, and product-
placeholder classes. Keep business components and `@markiro/ui` intact, but move
viewport and responsive layout responsibility into this layer. This is slightly
larger than approach A, yet it creates one enforceable fullscreen contract and
removes fragile inline flex combinations.

### C. Rewrite screens on a new component library

This could standardize everything, but it would replace an established design
system, enlarge the dependency surface, and risk offline production behavior.
It is rejected.

## Chosen architecture

### Global base

`packages/ui/src/styles.css` will reset page margin, apply `var(--font-ui)`, paint
the full viewport, and make form controls inherit typography. The reset remains
generic enough for every Markiro app and does not force kiosk-only overflow on
office pages.

`apps/kiosk/src/kiosk.css` will own kiosk-only viewport locking, layout classes,
touch feedback, responsive commissioning grids, and the product placeholder.
It will be imported by `apps/kiosk/src/main.tsx` after shared UI styles.

### Shell

`KioskShell` becomes a `100dvh` flex column with `overflow: hidden`. The status
strip remains in normal flow. A dedicated screen slot receives the remaining
height and hides page-level overflow. Each working screen fills that slot.

The status strip may wrap its chips, but the shell will recalculate the remaining
space naturally. It must not push a second viewport below itself.

### Core pickup screens

- Idle, Done, Blocked, and Loading use a shared full-size centered-screen class.
- Cart fills the remaining slot and keeps scrolling only inside the product list.
- The cart footer and submit button remain fixed within the right or lower panel.
- Portrait and landscape continue to use the existing semantic layouts.

### Pairing

At landscape sizes, pairing becomes a two-column commissioning layout:

- left: title, instruction, entered code, scan action, status/error, service
  actions, and optional server field;
- right: numeric keypad with clear and submit actions.

At portrait sizes the same regions stack inside the display. If an exceptional
combination of error and server details exceeds the available space, only the
left details region may scroll. The keypad and primary submit action remain
visible.

### Scanner setup

The unlocked setup screen becomes a structured header, two-panel work area, and
fixed action footer. Transport selection and test scanning are visually distinct
steps, while still using the current radio semantics and scanner ownership.

The paired credential gate uses the same fullscreen commissioning frame. Its
credential stages remain unchanged.

### Product placeholder

Until bootstrap data carries a real image URL, each product row shows a
deterministic one-character monogram derived from the first letter or digit in
the product name. It replaces the empty dark square without inventing product
imagery or adding a network dependency. The placeholder is decorative because
the adjacent name remains the accessible label.

### Touch and focus behavior

Kiosk-owned controls receive a shared class with:

- `touch-action: manipulation`;
- a one-pixel pressed translation for immediate tactile feedback;
- a visible `:focus-visible` ring;
- no transform when disabled;
- short transitions only for transform, color, background, and border.

Shared `@markiro/ui` controls retain their existing behavior.

## Testing

### Automated

1. Add focused component tests for shared shell/screen classes and the product
   monogram helper.
2. Extend pairing and scanner setup tests to assert the new semantic layout
   regions without testing CSS implementation details.
3. Run the complete kiosk Vitest suite, typecheck, lint, and build.
4. Run `git diff --check` and formatting verification for changed files.

### Browser

Verify the real Vite app at both target viewports:

- 1180x800 landscape;
- 800x1180 portrait.

Exercise pairing, scanner setup, idle, empty cart, populated cart, writeoff
reasons, limit reached, offline done, and blocked. For every state, confirm
`document.documentElement.scrollHeight === window.innerHeight` and that any
scrollable region is local and intentional.

### External limits

Browser verification does not prove behavior on the physical kiosk, with a real
2D scanner, Web Serial port, installed PWA chrome, or the production API. Those
remain separate checks.

## Non-goals

- No change to pickup business rules or API contracts.
- No new theme or light-mode redesign for the kiosk.
- No new animation library.
- No product image upload or catalogue schema work.
- No refactor of unrelated `@markiro/ui` components.
