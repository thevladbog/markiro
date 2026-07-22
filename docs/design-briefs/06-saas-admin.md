# Design Brief 06 — Platform Admin (SaaS Operations Panel)

> Addition to the 00–05 series. Office mode of the approved Markiro design
> system (see brief 02 and the accepted handoff). This is the panel **our
> team** uses to run the SaaS — customers never see it. Web app, desktop-first
> 1440, light theme primary, RU primary + EN. Separate application on its own
> domain (not a role inside the customer admin panel).

## Purpose

Operate the platform: manage tenant organizations and their subscriptions,
run semi-automatic B2B invoicing (bank transfer, the RF default), and watch
platform health. Small team, high-trust surface: clarity and auditability
over density.

## Access & roles

Sign-in: email + password with **mandatory 2FA** (this surface controls every
tenant). Three roles:

| Role           | Tenants & monitoring | Billing    |
| -------------- | -------------------- | ---------- |
| Platform admin | full                 | full       |
| Support        | full                 | — (hidden) |
| Accountant     | read-only            | full       |

Every mutating action is audited (see screen 6) — design affordances that
show "this will be logged" on sensitive actions (block tenant, change plan).

## Screens

### 1. Platform dashboard

- Money row: MRR, revenue this month, invoices awaiting payment, overdue.
- Adoption row: active tenants, trials (with days left), new this month.
- Usage: scans/day platform-wide (chart), top tenants by volume.
- Event feed: new tenant, payment received, invoice overdue, error spike,
  station offline alerts — each linking to its tenant.

### 2. Tenants

- List: name, status chip (trial / active / grace / restricted / read-only /
  blocked), plan, lines count, last activity; filters by status/plan.
- Tenant card:
  - Requisites: legal entity, INN, contacts, own GLN.
  - Plan & limits: current plan, lines/stations limits, feature flags from
    the plan; actions: change plan, extend trial.
  - Subscription & invoices: status timeline, invoice history with statuses.
  - Usage: scans / shifts / active stations per month (12-month sparkline).
  - Status journal: every status change with who/why/when.
  - Danger zone: manual block / unblock — requires a reason (audited);
    visually separated per design-system destructive patterns.

### 3. Plans (tariffs)

- Plan constructor: name, price per line/month, limits (lines, stations),
  feature toggles (label editor, public API, pallets).
- Archiving a plan never touches existing subscribers; archived plans stay
  visible in tenant cards with an "archived" badge.

### 4. Billing

- Invoice runs: calendar-generated drafts per billing period → review list →
  confirm & send (email with PDF; requisites, numbering RU-style).
- Invoice statuses: draft / sent / paid / overdue; manual "mark paid"
  (date + payment reference), bulk actions.
- Reminders: automatic email nudges on overdue (schedule visible per invoice).
- Registry export for accounting: CSV / 1C-friendly file per period.

### 5. Monitoring

- Health map: per-tenant active stations, sync queue depth, error/duplicate
  rates, export job delays, background jobs (queue) and archiving status.
- Alert thresholds with sensible defaults: station offline > 4h during an
  active shift, sync queue growing, error rate spike — surfaced in the
  dashboard event feed.
- Drill-down: tenant → station → recent sync batches (read-only facts;
  support tooling beyond viewing is out of MVP).

### 6. Audit log

- Every platform-team action: who, what, which tenant, when, reason (where
  required). Filter by user/tenant/action/period. Read-only, exportable.

## Overdue policy (soft escalation — core UX rule)

The customer's bottling line must NEVER stop mid-shift because of billing.
Automation with manual override:

- Overdue day 1: banner in the customer admin panel + email.
- Day 14: **new** shifts cannot be created; running shifts finish normally;
  exports keep working. Status → "restricted".
- Day 30: read-only — sign-in and data export always remain available.
  Status → "read-only".
- Full block: manual only, reason required.

Design both sides: the SaaS-admin controls (status timeline, override
buttons, upcoming-transition preview "restriction in N days") and the
customer-side banners (those screens belong to brief 03's admin panel —
add the banner states there as a delta).

## States & constraints

- Every list/detail: empty, loading, error states per design system.
- All destructive/status actions: confirm + reason field + audit note.
- RU string lengths; tabular numerals for all money and counters.
- Money in ₽ with proper formatting (1 234 567,89 ₽).

## Out of MVP (design later, keep navigation room)

- Impersonation into tenant accounts (with audit trail).
- Payment-provider integration (YooKassa auto-charges, 54-FZ receipts).
- Per-tenant feature flags beyond plan toggles; SMS notifications.
- Support tooling: log viewer, operator PIN reset from platform side.
