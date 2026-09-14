# Recurring services P2A: paid monthly periods and service allowance ledger

**Status:** approved product direction

**Date:** 2026-09-14

**Source requirements:** MKR-FR-COMMERCIAL-002 revision 1.3, FR-SVC-01–06,
FR-ADM-03–04 and AC-43–48

**Depends on:** Commercial P0 and the existing invoice payment-application flow

## 1. Goal

P2A lets Markiro sell a monthly recurring service package, create exactly one
paid service period from an applied payment, record delivered work against an
explicit minute allowance and show the customer a complete, understandable
ledger.

The first supported recurring-service policy is deliberately narrow:

- monthly billing and monthly allowance replenishment;
- no carryover between periods;
- no automatic overage charge;
- no service allowance without an applied payment;
- excess work only after an externally obtained approval has been registered in
  Markiro with its reference and approved minute limit.

One-time services keep their current catalog, offer, invoice and fulfilment
behavior. A service package grants no software module, device slot or other
license entitlement.

## 2. Chosen model

Use three separate durable concepts:

1. `ordered_services` remains the immutable fulfilment link created for a paid
   commercial line.
2. A recurring line additionally creates one period-bound service entitlement
   containing the exact commercial and allowance snapshot paid for.
3. An append-only service ledger records delivered work and compensating
   corrections. A separate append-only approval ledger adds only the externally
   approved excess capacity.

The available balance is derived from the period snapshot, active external
approvals and posted ledger deltas. It is not stored as a mutable counter.
Posting locks the service-period row before reading the ledgers, so two concurrent
requests cannot both spend the same remaining minutes.

This model is preferred to adding a mutable balance to `ordered_services`, which
would weaken audit and correction semantics. Service minutes are not added to the
software entitlement resolver because service delivery is not a product feature
or runtime permission.

## 3. Supported catalog product

### 3.1 Recurring service terms

A service version may use either the existing one-time form or the new monthly
recurring form. The recurring service payload contains:

```ts
interface MonthlyServiceTerms {
  cadence: "month";
  includedMinutes: number; // integer, 1..100_000
  carryover: "none";
  excessPolicy: "external_approval";
  scopeRu: string; // 1..4_000 trimmed characters
  scopeEn: string | null; // required before an English commercial document
  operatingHoursRu: string | null;
  operatingHoursEn: string | null;
  schedulingTermsRu: string | null;
  schedulingTermsEn: string | null;
}
```

For this form `billingMode` is `recurring` and `billingPeriod` is `month`.
Annual recurring service versions remain unpublishable until billing and
allowance replenishment cadences are independently represented and tested.

The publication preview shows the monthly price, included minutes, scope,
operating hours, scheduling terms, no-carryover rule and external-approval rule.
Names or free text never imply a minute limit, response time, 24/7 availability
or permission to bill excess work.

### 3.2 Compatibility

Commercial catalog, offer, invoice and tenant billing contracts add negotiated
version 4 through `X-Markiro-Commercial-Version: 4`. Version 4 includes all V3
fields and the recurring-service terms. Legacy, V2 and V3 create/update schemas
remain unchanged and can continue creating one-time services.

Older reads must not remove or reinterpret a recurring line. If an older
negotiated representation would include a recurring service that it cannot
express, the API returns `client_update_required`. Existing clients therefore
remain unchanged until a recurring service is actually used, and never receive
a misleading one-time projection.

## 4. Commercial line and period activation

A recurring-service offer and invoice line stores the complete service-version
snapshot, including allowance terms. Its quantity is one service package. The
API rejects a quantity other than one in P2A; multiple packages or pooled package
quantities require a later explicit design.

The line activation rule is `after_current`:

- if no paid period exists for the same tenant and catalog service item, the
  period starts at the server time when payment is successfully applied;
- otherwise it starts at the latest paid period's end;
- it ends one calendar month later in `Europe/Moscow`, using the existing
  commercial calendar-boundary rules and renewal anchor behavior.

This rule permits advance renewal without overlapping allowances. The resolved
timestamps are written exactly once during payment application. Reapplying the
same payment, regenerating a document or retrying a notification returns the
existing period and never creates another allowance.

A later period requires another applied payment. A scheduler may report an
upcoming or missing period but cannot create it. Cancellation does not rewrite a
paid period or move its boundaries; unused minutes expire at `endsAt` under the
recorded no-carryover policy.

## 5. Persistence

### 5.1 Catalog and paid periods

The catalog-version constraint is extended so `service` accepts either:

- `billing_mode = 'one_time'` with no billing period and the existing empty
  service payload; or
- `billing_mode = 'recurring'`, `billing_period = 'month'` and a valid monthly
  service payload.

Add `service_periods` with:

- `id`, `tenant_id`, `ordered_service_id`, `catalog_item_id` and
  `catalog_version_id`;
- `invoice_id`, `invoice_line_id` and `payment_id` as the authoritative paid
  source;
- `starts_at`, `ends_at`, billing timezone and renewal anchor;
- immutable names, descriptions, subject, monthly price, VAT treatment and the
  full allowance-policy snapshot;
- `included_minutes`, monotonic revision and creation time.

Composite tenant foreign keys bind the period to its ordered service, invoice,
line and payment. A unique source constraint permits one period per paid invoice
line. A tenant, catalog item and interval exclusion rule prevents overlapping
paid periods for the same recurring service. Timestamps must be finite and
`ends_at > starts_at`. Active, upcoming and expired states are derived from these
timestamps; they are not independently mutable.

### 5.2 Usage ledger

Add `service_usage_entries` with:

- tenant and service-period identity;
- `kind: usage | correction`;
- `classification: customer_service | product_defect`;
- work reference, customer-visible description and optional internal note;
- signed actual-minute and allowance-minute deltas;
- work-performance time, platform actor, request ID, posting time and optional
  original-entry identity.

A usage entry has a positive actual-minute delta and a nonnegative
allowance-minute delta. `product_defect` requires a zero allowance-minute delta.
A correction references one earlier entry in the same tenant and period, records
the resulting classification, has at least one nonzero signed delta and does not
edit or delete the original. Its classification may differ from the original so
charged work can be reclassified as a product defect by returning its allowance
minutes. Corrections cannot make cumulative actual time or allowance consumption
negative.

Work may be entered after a period ends, but its `performed_at` must be inside
that period. Late entry never consumes a later period's allowance.

The unique `(tenant_id, request_id)` identity stores a canonical request hash and
response. An exact retry returns the stored response; changed input under the
same request ID returns `SERVICE_USAGE_REQUEST_CONFLICT`.

### 5.3 External excess approvals

Add `service_excess_approvals` with:

- tenant and service-period identity;
- `kind: approval | withdrawal` and a signed approved-minute delta;
- trimmed external reference and optional URL;
- approval date, reason, registering platform actor, request ID and timestamps;
- optional original-approval identity for a withdrawal.

An approval has a positive delta. A withdrawal has a negative delta, references
one earlier approval in the same tenant and period and cannot exceed that
approval's unwithdrawn minutes or reduce total capacity below minutes already
posted. Capacity is the sum of included minutes and all approval-ledger deltas.
Approval identity and exact retry rules match usage entries.
The approval is evidence of externally agreed work; it does not create an
invoice, payment or receivable.

New foreign keys or checks on populated tables are added `NOT VALID` and
validated in a following migration transaction. No historical one-time service
row is converted automatically.

## 6. Authorization

Add platform capabilities `services.read` and `services.write`.

- `platform_admin`: both capabilities;
- `support`: both capabilities, allowing service delivery and correction without
  financial mutation;
- `accountant`: `services.read`; existing `billing.write` permits registering or
  withdrawing an external excess approval;
- posting usage or corrections requires `services.write`;
- registering or withdrawing excess approval requires both `services.read` and
  `billing.write`.

Platform routes always use `PlatformAuthGuard`. Possession of a period, entry or
approval UUID never grants access. Every read and write is tenant-scoped.

Tenant cabinet users authorized by the existing tenant billing read policy may
read their own periods and the customer-visible ledger. They cannot post work,
correct entries, register excess approval or view internal notes and
platform-only audit metadata. Device, public API and kiosk credentials have no
access to service records.

## 7. API contracts

The platform API adds:

| Method | Route                                                                    | Purpose                             |
| ------ | ------------------------------------------------------------------------ | ----------------------------------- |
| `GET`  | `/platform/service-periods`                                              | Cursor-paginated filtered list      |
| `GET`  | `/platform/service-periods/:id`                                          | Period, balance and complete ledger |
| `POST` | `/platform/service-periods/:id/usage`                                    | Post delivered work                 |
| `POST` | `/platform/service-periods/:id/usage/:entryId/corrections`               | Add a compensating correction       |
| `POST` | `/platform/service-periods/:id/excess-approvals`                         | Register external approval          |
| `POST` | `/platform/service-periods/:id/excess-approvals/:approvalId/withdrawals` | Add compensating withdrawal         |

The tenant API adds:

| Method | Route                          | Purpose                     |
| ------ | ------------------------------ | --------------------------- |
| `GET`  | `/billing/service-periods`     | Own period summaries        |
| `GET`  | `/billing/service-periods/:id` | Own customer-visible ledger |

List cursors bind the complete filter and order. Platform filters include tenant,
catalog item, derived state and period boundary. Details expose `included`,
`externallyApproved`, `consumed` and `remaining` minutes from one transactionally
consistent snapshot.

Usage posting accepts the current period revision, actual minutes, allowance
minutes, classification, `performedAt`, work reference, descriptions and request
ID. The server rejects a stale revision, `performedAt` outside the selected
period, an allowance deficit or an invalid defect classification before inserting
a row. It returns
`SERVICE_ALLOWANCE_EXCEEDED` with required, remaining and deficit minutes; it
never silently converts the deficit into a charge.

## 8. Transaction and concurrency rules

Payment application keeps its current invoice and payment lock order, then takes
a tenant-and-catalog-service advisory lock before reading the latest paid period.
It creates the existing `ordered_services` row and the period before recording
line application success. Failure rolls the complete line application back.

Usage and approval mutations lock in this order:

1. tenant service namespace advisory lock;
2. service-period row;
3. referenced usage or approval row when correcting;
4. current usage and approval aggregates;
5. new ledger row and exact audit row.

No external I/O runs under these locks. Concurrent posts serialize on the period.
Every successful usage, correction, approval or withdrawal increments the period
revision in the same transaction. A stale revision or insufficient balance leaves
no ledger or audit-success row. Database and infrastructure failures propagate so
callers can safely retry with the same request identity.

## 9. SaaS Admin

### 9.1 Catalog

The service editor offers `One-time` and `Monthly package`. Choosing monthly
reveals included minutes, scope, operating hours and scheduling terms. The fixed
no-carryover and external-approval policies are displayed explicitly rather than
as editable unsupported options. Annual recurrence remains disabled with a clear
explanation.

All fields preserve dirty state and RU/EN validation. Publication review and
preview show the exact resulting customer terms.

### 9.2 Service workspace

Add a service-period workspace with tenant, service, current period, state and
remaining-minutes filters. The detail drawer shows the paid-source link, period
boundaries, allowance calculation and chronological ledger.

Support users can post work and compensation entries. Product-defect
classification visibly sets allowance minutes to zero. Users with
`billing.write` can register an external approval using its reference, approved
minutes, date, reason and optional URL. Before every mutation the UI shows the
resulting balance and blocks ambiguous duplicate submission.

Uncertain responses retain the original request and request ID. Edits stay
blocked until retry receives a definitive result. Authorization and domain
errors clear only the corresponding recoverable request state according to the
existing platform error-envelope rules.

## 10. Tenant cabinet

The billing subscription page shows active and historical service periods
separately from software entitlements. Each card states the paid interval,
included minutes, externally approved minutes, consumed minutes and remainder.

The detail view lists customer-visible work reference, description, performance
date, posting date, actual minutes, allowance minutes and corrections.
Product-defect work is labelled as not consuming the paid allowance. Internal
notes, platform actor identifiers, approval internals and unrelated tenants never
appear.

An exhausted package says that additional work requires prior agreement and
provides no automatic purchase or upgrade promise.

## 11. Commercial documents and fulfilment

Offer and invoice snapshots include monthly cadence, exact paid price, included
minutes, scope, no-carryover rule and external-approval rule. English documents
require the English service terms. Reprints use stored snapshots.

Payment application creates the period; document generation alone does not.
Recurring service fulfilment remains distinct from software activation.

An act may link posted customer-service usage entries from one service period.
Selected entries are snapshotted and cannot appear in two non-void acts. Defect
correction entries may appear for transparency with zero chargeable minutes.
Voiding or reissuing an act does not alter the service ledger or restore an
allowance. The first release does not derive a new monetary charge from excess
minutes.

## 12. Audit and observability

Audit successful and rejected period creation, usage posting, correction,
external approval and withdrawal with exact actor, tenant, request ID, target,
source document, minutes and before/after aggregate values. Internal notes and
external document contents are excluded.

Metrics distinguish period-created, usage-posted, defect-work-posted,
correction-posted, allowance-blocked, excess-approved and approval-withdrawn.
Counts and minutes are separate metrics. An issued invoice, applied payment,
posted work, act and customer acceptance remain separate facts.

## 13. Errors and recovery

Stable domain errors cover unsupported annual recurrence, invalid service terms,
duplicate or overlapping period, stale period revision, performance outside the
selected period, allowance deficit, invalid correction, invalid external
approval, approval withdrawal below consumed capacity and request-ID conflict.

Malformed persisted catalog or period snapshots are surfaced as data-integrity
errors and do not become empty results or zero allowances. Previously created
one-time services remain readable and fulfillable. No recovery path edits a
historical ledger row or creates an unpaid period.

## 14. Migration and rollout

The schema change is additive except for widening the catalog service constraint.
Deploy migrations before code that reads recurring service fields or period
tables. Existing one-time rows satisfy the widened constraint unchanged.

Release the V4 API and updated clients before publishing the first recurring
service. Publishing remains an explicit platform action. No seed creates a paid
service, period, approval or usage entry. Production prices, package scopes and
customer assignments require separate commercial approval.

Application rollback must continue reading existing one-time data. Once a V4
recurring service has been published or a period created, an older application
version is not a faithful writer; deployment runbooks must treat that point as
the compatibility boundary and retain the new reader during rollback.

## 15. Verification

Contract tests cover V1–V4 negotiation, exact strict schemas, one-time
compatibility, monthly fields, annual rejection, document snapshots and
`client_update_required` for unrepresentable older reads.

Database tests cover tenant-composite keys, exact source uniqueness, finite
non-overlapping periods, constraint validation, append-only correction rules,
request replay and fresh migration from both an empty database and fixtures with
historical one-time services.

API tests cover:

- AC-43: one payment creates one monthly period and the configured allowance;
- AC-44: payment and request retries create no duplicate period or ledger row;
- AC-45: posting 45 of 180 minutes leaves 135 with exact actor and work facts;
- AC-46: compensation preserves the original and defect work consumes zero;
- AC-47: concurrent overage is blocked until bounded external approval exists;
- AC-48: no payment means no next allowance and annual publication is rejected;
- cross-tenant, cabinet/platform/device credential and internal-note denial;
- exact audit facts, stale revisions and uncertain-response retries.

SaaS Admin tests cover both catalog modes, publication validation, period lists,
posting, correction, external approval, pagination, dirty-state recovery and
RU/EN copy. Tenant tests cover own-ledger visibility, restricted-subscription
read access and absence of internal fields. Existing offer, invoice, act,
one-time service and subscription tests remain green.

Browser evidence verifies the monthly catalog form, platform service workspace
and tenant ledger at normal and narrow widths in Russian and English. Production
payment, real external approvals, customer acceptance and support operations are
reported separately and remain unverified until exercised.

## 16. Completion criteria

P2A is complete when a published monthly service can be sold through the current
commercial flow, one applied payment creates one non-overlapping paid period,
support can append work without overspending, defects and corrections preserve
history, externally approved excess is bounded and auditable, and the tenant can
read the resulting balance and ledger.

Existing one-time services, software entitlements, offline grants, subscriptions,
prices and historical documents remain unchanged unless explicitly involved in
the new recurring-service transaction.

## 17. Outside P2A

- annual recurring services or different billing and replenishment cadences;
- carryover, pooled allowances, quantity greater than one or shared multi-tenant
  service packages;
- automatic overage invoicing, card charging, refunds or proration;
- support ticketing, SLA timers, staff scheduling, chat or CRM;
- customer approval inside Markiro;
- automatic classification of diagnostics or support conversations;
- changing software entitlements based on service balance;
- production catalog publication, payment application or customer rollout.
