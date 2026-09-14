# Recurring services P2A operations

This runbook covers monthly paid service packages, their immutable paid periods,
append-only usage ledger, external excess approvals and billing-act snapshots.
It does not publish a package, create a commercial offer, issue an invoice or
activate a customer's period by itself.

## Release boundary

Recurring services use commercial contract V4. Existing V1-V3 clients keep their
current response shapes and one-time services keep `billingMode: one_time`.
Deploy all database migrations before any API binary that reads recurring service
fields or service-period tables:

1. Back up PostgreSQL, record the restore point and run the normal production
   preflight.
2. Apply migrations in journal order:
   `0157_recurring_services`, `0158_validate_recurring_services`,
   `0159_recurring_commercial_terms`,
   `0160_validate_recurring_commercial_terms`, and
   `0161_service_usage_acts`.
3. Deploy the V4-capable API.
4. Deploy SaaS Admin, then tenant Admin.
5. Run the read-only checks below and verify the existing V1-V3 commercial flows.
6. Explicitly create, review and publish the first monthly service version in
   SaaS Admin. Publication is a separate operator action.

Migrations 0158 and 0160 validate constraints that were added `NOT VALID` in the
preceding additive migrations. Do not start a V4-capable API between either
addition and its validation migration. No migration, seed or deployment command
creates a production catalog version, commercial document, payment, service
period or ledger entry.

## Read-only verification

Confirm the migration journal reached 0161 and inspect constraint validation:

```sql
select hash, created_at
from drizzle.__drizzle_migrations
order by created_at desc
limit 5;

select conname, convalidated
from pg_constraint
where conname in (
  'catalog_item_versions_kind_check',
  'ordered_services_commercial_terms_check',
  'commercial_offer_lines_commercial_terms_check',
  'invoices_commercial_terms_check',
  'invoice_lines_commercial_terms_check',
  'service_periods_no_overlap'
)
order by conname;
```

All listed constraints must be present and validated. Confirm that the additive
tables exist before the API starts reading them:

```sql
select to_regclass('public.service_periods') as service_periods,
       to_regclass('public.service_usage_entries') as service_usage_entries,
       to_regclass('public.service_excess_approvals') as service_excess_approvals,
       to_regclass('public.billing_act_service_usage') as billing_act_service_usage;
```

After application deployment and before first publication, verify that SaaS Admin
can open the catalog and service-period workspace, tenant Admin can open
**Billing → Service packages**, and existing offers, invoices and acts still open.
An empty service-period list is expected before a recurring service invoice is
paid.

## First publication and activation

Create the first package as a service with monthly billing and quantity one.
Review the exact included minutes, no-carryover rule, external-approval excess
policy, scope, operating hours and scheduling terms before publication. Annual or
another unsupported cadence is rejected.

Payment application creates one immutable period for each paid recurring-service
invoice line. Retry the same payment application with its original identity; do
not create a replacement invoice or alter the paid line to repair an uncertain
response. Advance renewals serialize into consecutive, non-overlapping periods.
An unpaid future invoice provides no allowance.

For each posted work entry, keep the original request ID and payload until the
server returns a definitive result. A lost response is recovered by sending the
same request. Product-defect work records actual time with zero allowance
consumption. Corrections append signed deltas and never edit the original entry.
Work above the available balance requires a bounded external approval recorded by
an operator with `billing.write`.

When issuing an act, select eligible customer-service usage from one ordered
service and preserve the resulting snapshot. An entry can belong to at most one
active act. Cancelling the act releases only those act links; it does not change
or delete the service ledger.

## Rollback and recovery

Before the first V4 recurring service is published and before any service period
is created, application rollback is allowed while leaving the additive schema in
place. Restore the previous compatible API and UIs; do not reverse the migrations
or delete empty tables during an incident.

After the first V4 publication or service-period creation, rollback to an older
writer is prohibited. The older application does not understand the stored V4
commercial snapshots and period ledger. Roll forward with a corrected V4-capable
release instead. Preserve catalog versions, offer and invoice snapshots, payment
application events, periods, usage, approvals and act links.

For an uncertain usage, correction, approval or act request, recover with the
original request ID and byte-equivalent business input. If the server reports a
stale revision, reload the period, reconcile the visible immutable entries and
submit a deliberate new operation with a new request ID. Never update balance
columns, rewrite ledger rows or remove an act link directly in PostgreSQL.

## Evidence boundary

Repository tests and browser fixtures prove contracts, persistence rules,
authorization, retry behavior and rendered workflows against synthetic data.
Production migration, a real payment, real operator access, customer acceptance
and production monitoring remain separate release gates and must be recorded when
they are actually performed.
