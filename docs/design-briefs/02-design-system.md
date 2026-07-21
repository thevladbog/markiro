# Design Brief 02 — Design System (UI Kit)

> Second stage. Built on the approved brand (brief 01). Deliverable: a Figma
> library both product briefs (03, 04) are assembled from.

## One system, two modes

|                  | Office mode              | Floor mode                     |
| ---------------- | ------------------------ | ------------------------------ |
| Used by          | Admin panel, landing     | Line station                   |
| Reference feel   | Linear / Stripe / Vercel | Industrial HMI done tastefully |
| Density          | Regular SaaS             | Oversized                      |
| Min touch target | 40px                     | **64px** (gloved finger)       |
| Base font size   | 14–16px                  | **18px+**, counters 48–96px    |
| Readability test | Laptop at desk           | Tablet at 1.5–2 m, side glance |
| Primary theme    | Light (dark supported)   | **Dark** (light supported)     |

Both modes share tokens, iconography, semantic colors and component DNA —
a floor-mode button is recognizably the office button scaled for the shop
floor, not a different product.

## Tokens (Figma variables)

- **Colors:** brand, neutrals, semantic statuses (green OK / red error /
  amber duplicate-attention / blue syncing) — every token defined for
  **light and dark** themes. Statuses must hold contrast on both.
- **Typography scale:** office ramp (12–32px) and floor ramp (18–96px),
  tabular numerals for all counters and codes.
- **Spacing / radius / elevation** scales shared by both modes.
- All tokens as Figma variables so themes switch without redrawing.

## Core components (both modes unless noted)

- Buttons (primary/secondary/destructive; floor variant: full-width, 64px+)
- Inputs, selects, date pickers (office); numeric PIN pad (floor)
- Tables with sorting/filters/pagination (office)
- Cards, badges/status chips, tabs, breadcrumbs
- Toasts and inline alerts; full-screen signal overlays (floor — see brief 04)
- Modals (office) / full-screen dialogs (floor — no small modals on touch)
- Progress: bars, ring counters, and the **box-fill visual** (grid of cells
  filling up, e.g. 14/20) — a signature component of the product
- Status bar with connectivity/sync/hardware indicators (floor)
- Empty / loading / error / offline state patterns for every surface
- Navigation: sidebar (office), top-level task switcher (floor)

## Component states matrix

Every interactive component: default / hover (office only) / pressed /
focused / disabled / loading. Hover must never be the only affordance —
floor mode is touch-first.

## Iconography

Extend the brand icon direction into a working set (~40 icons): navigation,
statuses, hardware (printer, scanner, agent), aggregation (unit, box, pallet,
disassemble), sync/offline, users/shift. Icons always paired with labels in
floor mode.

## Accessibility

- WCAG AA contrast in both themes; floor mode targets AAA for status signals.
- Color-blind safety: status = color + icon/shape + text, never color alone.
- Focus states visible for keyboard use in the admin panel.

## RU/EN resilience

Components must tolerate Russian string lengths (typically 1.3–1.5× English).
Show worst-case RU strings in component specs; no truncation of status words.
