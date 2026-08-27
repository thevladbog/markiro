# Tenant Admin Billing Experience Design

**Status:** Approved on 2026-08-27

**Product surface:** `apps/admin`, the customer cabinet used by a tenant's owner and
administrators. This is not the platform operator application in `apps/saas-admin`.

**Design source:** `docs/design-briefs/tenant-admin-billing.pen`

## 1. Relationship to the billing foundation

This specification defines the tenant-facing billing information architecture, access model,
request workflow, and user experience. It complements
`docs/superpowers/specs/2026-08-11-tenant-billing-documents-design.md`, which remains the source of
truth for operator-issued invoices, immutable invoice snapshots, payment reconciliation,
document rendering, and subscription application.

This experience expands the earlier MVP in three deliberate ways:

- the tenant cabinet exposes subscriptions, limits, invoices, confirmed payments, acts,
  commercial offers, and tracked service requests in one section;
- commercial offers may precede an invoice and support tenant acceptance or a request for
  changes;
- the UI can represent a confirmed partial payment and remaining balance when the billing model
  gains partial-payment support. Until that backend expansion exists, the client must not infer a
  partial payment from incomplete or unconfirmed data.

## 2. Goal

Give authorized tenant administrators a trustworthy, read-mostly billing workspace where they
can understand the organization's current commercial position and initiate a structured request
without contacting Markiro through an untracked external channel.

The section must answer five questions quickly:

1. What subscription and services are assigned to this tenant?
2. When do they expire and how close is the tenant to each limit?
3. Which invoices exist and which payments has Markiro confirmed?
4. Which acts and commercial offers are available?
5. What does Markiro currently need from the tenant, and how can an administrator request a
   renewal, additional capacity, a service, a document, or another change?

## 3. Boundaries

### In scope

- A `Биллинг` navigation item in the tenant admin under `Организация`.
- Owner- and administrator-only access enforced in both navigation and server authorization.
- Overview, subscription and limits, invoices and payments, documents, and requests.
- Tenant acceptance of the current offer version or a tracked request to change it.
- Structured service requests with a compact event history and Markiro clarifications.
- Links between a request, offer, invoice, payment, act, subscription change, and ordered service.
- In-product attention states and tenant-administrator notifications.
- Empty, loading, error, forbidden, expired, overdue, and superseded-version states.

### Out of scope

- An open tariff store or unreviewed self-service purchase.
- Tenant-side subscription, entitlement, invoice, payment, or act mutation.
- A standalone chat or general support messenger.
- Treating a tenant-provided payment receipt as confirmed payment.
- Automatic production blocking solely because an invoice is overdue.
- Platform operator billing management inside `apps/saas-admin`; that is a separate surface.
- Legally significant EDI or electronic signature workflows.

## 4. Audience and access

The section is visible only to tenant members with the tenant-owner or tenant-administrator role.
Other cabinet roles do not see the navigation item and receive a server-authorized forbidden
response if they attempt to open a route directly.

Authorization must be re-evaluated at protected boundaries from current membership and role
state. The client must not be the enforcement boundary. Every query, document download, request,
offer action, attachment, and event is tenant-scoped, with focused cross-tenant denial tests.

Within the section, financial and subscription records are read-only. Authorized tenant actors
may only:

- create a request;
- provide requested clarification or an attachment;
- accept the current commercial-offer version;
- request changes to an offer.

Every action records the tenant, actor, action, target, result, and bounded relevant metadata.

## 5. Information architecture

`Биллинг` appears in the existing `Организация` group after `Доступ в кабинет` and before
`Настройки`.

The section contains five tabs:

1. `Обзор`
2. `Подписка и лимиты`
3. `Счета и оплаты`
4. `Документы`
5. `Заявки`

The tab structure preserves the current tenant-admin shell, organization context, account
controls, typography, density, and `@markiro/ui` tokens. It must not inherit the navigation or
visual hierarchy of the platform SaaS administration application.

## 6. Overview

The overview is an action-oriented summary, not an analytics dashboard. It contains:

- the current subscription, state, end date, price period, and next expected invoice date;
- the current actionable commercial offer, if one exists;
- the four most relevant limits with used and assigned values;
- recent invoices, confirmed payments, and acts;
- the most recent active request and the latest Markiro event;
- one primary action, `Создать заявку`.

Only items requiring a tenant decision receive warning emphasis. Historical or informational
records remain visually quiet. All statuses use both text and color.

## 7. Subscription and limits

The subscription view shows:

- plan name and state;
- start and end dates;
- billing period and displayed price;
- assigned add-ons and services;
- applicable renewal or scheduled-change information;
- each entitlement limit as `used / assigned`, with a textual state.

Limit states are normal, approaching, reached, and exceeded. Thresholds are provided by the
server or a shared domain policy; the client must not invent independent business thresholds.
Approaching and reached limits offer `Создать заявку` with the relevant request type and context
preselected. They do not silently change entitlements.

## 8. Invoices and payments

The invoices and payments view provides a tenant-scoped chronological registry with filters by
period and state. Each row or card shows number, issue date, due date, amount, currency, status,
and confirmed paid amount when applicable.

Supported presentation states include draft only when deliberately exposed, issued, overdue,
partially paid, paid, and cancelled. `Оплачен` is shown only after Markiro's authoritative payment
reconciliation confirms it. A receipt uploaded by the tenant may become an attachment to a
request but never changes invoice state.

An invoice detail view exposes its immutable commercial snapshot and downloadable rendered
artifact. A confirmed partial payment, once supported by the billing foundation, shows paid
amount and remaining balance explicitly. Invoice state and payment records remain distinct.

An overdue invoice does not automatically block production. If Markiro assigns a separate future
restriction or grace-period policy, the cabinet must display its effective time and consequence
explicitly before it takes effect.

## 9. Documents and offers

The documents view contains acts and commercial offers, filterable by type, period, and state.
Invoices remain discoverable through `Счета и оплаты` to avoid duplicating the primary registry,
but linked invoice documents may also appear in a request or entity detail.

An act becomes available after the related service is delivered or the accounting period is
closed. Downloading a document does not change its state.

A commercial offer has a human-readable number, creation date, expiration date, immutable
version, amount, currency, line details, and state. Tenant actions are:

- `Принять`: accepts only the current, non-expired version;
- `Запросить изменения`: creates an event and returns the offer to Markiro for revision without
  deleting or silently rejecting its history.

Acceptance is idempotent, immediately reflected in the UI, and cannot be repeated. A superseded
or expired version is read-only. Markiro creates the invoice after the accepted offer is processed;
the tenant cannot issue one.

## 10. Requests

### Request creation

An administrator starts with `Создать заявку` and selects one of:

- renewal;
- change limits or capacity;
- additional service;
- request documents;
- other.

The form collects a description, desired date when relevant, and optional attachments. A request
opened from a limit, subscription, invoice, offer, or document carries that context explicitly.
Submission returns a human-readable request number and creates the first immutable event.

### Request states

- `Новая`
- `На рассмотрении`
- `Нужно уточнение`
- `Подготовлено предложение`
- `Ожидается оплата`
- `В работе`
- `Выполнена`
- `Отменена`

State transitions are owned by server-side workflow rules. Tenant clarification and offer actions
create events; they do not let the client choose an arbitrary state.

### Request detail

The detail view includes the request type, description, desired date, state, responsible side,
attachments, linked commercial offer, invoice, confirmed payment, act, subscription change, and
ordered service when they exist.

Communication is a compact chronological event history rather than a chat. Events identify the
actor side, time, action or clarification, and related object. The tenant may respond only while
the workflow explicitly awaits clarification or another tenant action.

### End-to-end flow

```text
tenant request
  -> Markiro review
  -> optional clarification
  -> commercial offer
  -> accept or request changes
  -> Markiro invoice
  -> confirmed payment
  -> service or subscription work
  -> act after delivery or period close
  -> completed request with retained history
```

## 11. Notifications and attention states

The overview and relevant tab surface items that require a tenant decision. A billing attention
count includes only actionable tenant states, such as requested clarification, a new current
offer, or an approaching payment deadline. It does not count every new historical event.

Tenant owners and administrators may receive notifications for:

- a new or revised offer;
- a new invoice or approaching due date;
- confirmed payment;
- a new act;
- a Markiro clarification or status update requiring action.

Notification delivery preferences use the application's established notification mechanism and
are not encoded independently in the billing domain.

## 12. Visual and interaction direction

The approved Pencil direction uses the existing tenant-admin `Прибор` office system:

- light paper workspace and compact 224-pixel navigation;
- IBM Plex Sans and IBM Plex Mono;
- existing neutral, border, status, and focus tokens from `@markiro/ui`;
- one primary dark or green action accent;
- compact cards and controls with borders preferred over decorative shadows;
- no glass effects, cinematic motion, oversized marketing typography, or SaaS-platform chrome.

Keyboard operation, visible focus, semantic controls, useful labels, and non-color-only statuses
are required. At narrower widths, cards stack into one column. Dense registries preserve their
key fields and open complete information in a detail surface instead of becoming unreadable.

## 13. Conceptual domain additions

Implementation planning should reconcile the following concepts with the existing billing and
subscription schema rather than duplicate them:

- tenant billing request;
- request event and clarification;
- request attachment;
- versioned commercial offer and offer lines;
- tenant offer decision;
- links from request to offer, invoice, payment, act, ordered service, and subscription event;
- tenant-action attention state.

All mutations require idempotency appropriate to browser retries. Attachments use private object
storage and tenant-authorized short-lived downloads. Human-readable numbers are server-assigned;
stable UUIDs remain the internal identifiers.

## 14. Failure and concurrency behavior

- An expired or superseded offer cannot be accepted, even from a stale browser tab.
- Two administrators accepting the same offer produce one decision and an idempotent result.
- A failed request submission leaves entered content recoverable and clearly indicates whether
  the server accepted it.
- A failed document render remains visible and retryable without changing the financial state.
- Missing object storage does not erase invoice, request, offer, payment, or act metadata.
- A removed administrator loses access at the next protected boundary.
- A linked object that is not yet ready is represented as pending, never as absent or paid.

## 15. Acceptance criteria

1. Only current tenant owners and administrators can discover or open `Биллинг`; server tests
   deny other roles and cross-tenant access.
2. The overview accurately summarizes the assigned subscription, term, limits, recent billing
   operations, current offer, and active request without inferring unconfirmed financial state.
3. The subscription view exposes assigned services and `used / assigned` limits and can create a
   contextual capacity request without mutating entitlements.
4. Tenant administrators can list, inspect, and download only their tenant's invoices and acts.
5. Payment status comes from Markiro reconciliation; a tenant attachment cannot mark an invoice
   paid.
6. A tenant can accept only the current valid offer version or request changes, with idempotent
   server enforcement and exact audit events.
7. A tenant can create and follow a structured request through clarification, offer, invoice,
   payment, delivery, act, and completion, with a retained chronological history.
8. Acts appear only after delivery or accounting-period closure according to server state.
9. Empty, loading, failure, forbidden, overdue, expired, and stale-version states are usable and
   accessible.
10. The production implementation uses the existing tenant-admin shell and `@markiro/ui` tokens
    and is visually verified separately from automated component and API tests.

## 16. Approved decisions

- Requests are structured and tracked; there is no unreviewed self-service purchase.
- Billing is visible only to the tenant owner and administrators.
- Communication is a status and event history with Markiro clarifications, not a separate chat.
- A tenant may accept an offer or request changes; Markiro creates the invoice.
- Payments are read-only and shown only after authoritative Markiro confirmation.
- Acts appear after delivery or accounting-period closure.
- The approved visual direction is the tenant-admin design in
  `docs/design-briefs/tenant-admin-billing.pen`.
