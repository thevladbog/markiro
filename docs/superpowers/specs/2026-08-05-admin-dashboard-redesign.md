# Admin dashboard redesign

## Status

Approved for implementation. This document records the redesign direction accepted after the
current admin screenshot was reviewed against `docs/design-briefs/03-admin-panel.md` and the
high-fidelity admin handoff.

## Goal

Turn the current empty dashboard stub into a useful production overview while preserving the
accepted Markiro "instrument" design language, current routes, authorization model, light and
dark themes, and RU/EN support.

## Design read

This is a redesign-preserve of a regulated B2B production admin for factory managers. The visual
language is calm, dense, operational, and based on the existing `@markiro/ui` tokens rather than a
new third-party design system.

- Design variance: 4
- Motion intensity: 2
- Visual density: 8

## Data boundary

The first version uses existing tenant-scoped admin queries only:

- products, including active and draft status;
- shifts, including planned, active, and closed status;
- production lines;
- unreviewed conflicts.

It must not invent unit counts, box counts, terminal throughput, marking-code stock, or export
results. Those metrics require a dedicated server summary contract and are outside this change.

## Dashboard states

### Loading

Render a static skeleton matching the final information hierarchy. Do not replace the whole page
with a circular spinner.

### Error

Show a contextual error panel and one retry action. A partial success is not presented as a
complete overview because the counts would be misleading.

### First-run onboarding

Until the first shift has been started or closed, show a setup path instead of an inert empty
state:

1. Add a product.
2. Plan the first shift.
3. Open the shift on a line station.

The primary action points to the first incomplete step. Users without write capability receive a
read-only link rather than copy promising an unavailable mutation.

### Operational overview

Once at least one shift has been started or closed, show:

1. A compact summary strip for active shifts, planned shifts, ready products, and unreviewed
   conflicts.
2. A "Needs attention" area only when draft products or unreviewed conflicts exist.
3. Active shifts with product, line, mode, plan, and start time.
4. Upcoming planned shifts sorted by planned date, then creation time.
5. Clear inline empty states when there are no active or planned shifts.

All numbers come from current API results. Number typography uses the existing mono font and
tabular numerals.

## Navigation

Keep route paths stable. Group visible links under translated section labels:

- Production: Overview, Shifts, Boxes, Conflicts, Self-pickup.
- Reference data: Catalog, Counterparties, Operators and employees, Labels.
- Equipment and exchange: Kiosks, Integrations.
- Organization: Cabinet access, Settings.

The sidebar remains capability-filtered. Empty groups are omitted automatically. The navigation
list scrolls independently when viewport height is constrained, while the profile footer remains
reachable.

## Visual rules

- Preserve IBM Plex Sans and IBM Plex Mono.
- Preserve the monochrome surfaces and existing semantic status colors.
- Use one 8/12px radius system already defined by Markiro tokens.
- Prefer one divided summary surface over four unrelated decorative cards.
- Use no decorative animation. Hover, active, and keyboard focus feedback are sufficient.
- Keep the content width bounded for readability while allowing tables to scroll horizontally.
- At widths below 1024px, summary columns wrap to two columns; below 768px, they become one
  column and page padding is reduced.

## Accessibility

- Sidebar groups are visible text, not clickable pseudo-links.
- Keyboard focus uses the tokenized `:focus-visible` ring.
- Dark sidebar muted text must reach WCAG AA contrast for 12px text.
- Dashboard headings follow a semantic hierarchy.
- Loading and error states have explicit accessible labels.
- Links and actions retain descriptive RU and EN names.

## Deliberate exclusions

- No new dashboard backend endpoint.
- No fake charts or sample metrics in production.
- No route or URL changes.
- No profile-menu/header control migration because the approved custom-controls effort owns that
  surface in a separate change.
- No replacement of `@markiro/ui` with Carbon, Fluent, shadcn, or another design system.

## Verification

- Dashboard tests cover onboarding, operational data, loading, error, and translated output.
- Sidebar tests cover group labels and group omission after capability filtering.
- Admin shell tests cover updated labels and links.
- Run focused tests first, then `@markiro/ui` and `@markiro/admin` test, typecheck, lint, and build.
- Run `git diff --check` and a source audit for visible em-dash characters introduced by this change.
- Browser confirmation in light and dark themes is reported separately from automated DOM tests.