# Tenant Billing, Invoices, Payments, and Documents Design

**Status:** Approved for MVP design on 2026-08-11

**Scope:** Direct tenant invoices with catalog-linked lines, immutable billing history,
rendered downloadable documents, one operator profile, one tenant billing profile, and
manual or imported bank-payment matching.

## 1. Goal

Allow the Markiro platform operator to issue an invoice directly to a tenant, attach catalog
plans, add-ons, services, or free-form lines, record and reconcile payment, and preserve an
auditable history of every commercial and document operation. The same issued document must be
downloadable by the operator and, later, visible and downloadable by the tenant in the customer
cabinet.

The MVP is not an EDI, accounting-system, or bank-API integration. It produces ordinary
downloadable billing documents and supports import of a bank statement in the 1C ClientBankExchange
family of formats, with deterministic parsing and manual conflict resolution.

## 2. MVP boundaries

### In scope

- One operator billing profile for Markiro.
- One current billing profile for each tenant.
- Profile types: individual, self-employed, sole proprietor, and legal entity.
- Direct invoice creation without a preceding commercial offer.
- Invoice lines for a catalog plan, catalog add-on, catalog service, or free-form item.
- Exact catalog version references for plan/add-on/service lines.
- Frozen line names, descriptions, units, prices, VAT rate, VAT-included flag, and totals.
- Per-invoice application policy for plan/add-on lines.
- Manual payment recording.
- Bank statement import, parsed rows, automatic matching, and manual matching/rejection.
- Immutable invoice and payment history.
- Rendered PDF as the primary document and a printable HTML representation for preview/fallback.
- Private object-storage persistence with short-lived operator/customer download URLs.
- Customer-cabinet invoice list/detail/download access scoped to the tenant.
- Audit events for profile changes, invoice lifecycle, document generation, import, matching,
  payment confirmation, and subscription application.

### Out of scope

- EDI/Диадок or other legally significant electronic document exchange.
- Automatic bank API polling.
- Partial payments, refunds, chargebacks, credit notes, or payment allocation across multiple
  invoices in one payment.
- Recurring invoice generation.
- Accounting ledger, revenue recognition, tax reporting, or fiscal receipt issuance.
- Multiple operator legal entities or multiple tenant legal profiles in the MVP.
- Automatic DaData enrichment as a source of truth. Address suggestions may be added behind an
  adapter, but saved normalized data remains operator-confirmed.

## 3. Parties and profile history

`operator_billing_profile` is a singleton containing the current Markiro seller details. A tenant
has one `tenant_billing_profile` marked current. Profile records are versioned rather than edited
in place after they are used by an issued invoice.

Supported profile kinds:

| Kind | Required MVP fields |
| --- | --- |
| `individual` | display name, INN when supplied, address, bank details, contact |
| `self_employed` | full name, INN, address, bank details, contact |
| `sole_proprietor` | full name, INN, OGRNIP, address, bank details, contact |
| `legal_entity` | legal name, INN, KPP, OGRN, legal address, bank details, contact |

The schema uses nullable type-specific fields plus validation rules at the API boundary. It keeps
the original address string and a normalized address object; an external DaData adapter can fill
suggestions but cannot silently overwrite confirmed fields.

Every issued invoice stores a complete seller and buyer snapshot. Later profile changes therefore
never alter a historical invoice or its rendered document.

## 4. Invoice model and lifecycle

An invoice is created directly for one tenant and receives a server-assigned human-readable number
from a transactional sequence. The immutable business snapshot is created at issue time, not at
download time.

Lifecycle:

`draft -> issued -> paid`

Terminal alternatives:

- `draft -> cancelled`
- `issued -> cancelled`
- `issued -> overdue` (a derived/reporting state, never a rewrite of amounts)

Only drafts can be edited. Issuing an invoice freezes:

- invoice number and issue date;
- operator and tenant profile snapshots;
- all line fields and catalog version IDs;
- subtotal, VAT total, grand total, currency;
- application policy and requested activation timing.

Cancellation is a visible event and does not delete the invoice or document. Payment cannot be
recorded against a cancelled invoice. A paid invoice cannot be cancelled silently; a future credit
workflow is explicitly out of scope.

### Line kinds

- `plan`: exact published catalog plan version; application creates/replaces/schedules the tenant
  subscription according to the invoice policy.
- `addon`: exact published catalog add-on version and quantity; application attaches it to the
  selected subscription according to the invoice policy.
- `service`: exact published service version when catalog-linked; application creates an ordered
  service record and never changes entitlements.
- `custom`: manually entered commercial line with no entitlement effect.

### Application policy

Each invoice independently chooses `manual` or `automatic` application after payment. For plan and
add-on lines, the invoice also stores a timing policy:

- `immediate`: apply on confirmed payment;
- `after_current`: apply after the current subscription ends when one exists;
- `manual`: leave the paid line pending operator confirmation.

Application uses the existing subscription lifecycle and entitlement locks. It records an exact
before/after event for every line and is idempotent by invoice-line application identity.

## 5. Documents and rendering

Issuing an invoice queues deterministic rendering from its frozen snapshot. The renderer produces:

1. PDF (primary downloadable artifact);
2. HTML print view (preview and fallback).

Each artifact is content-addressed by invoice ID, document revision, format, and renderer version.
The database stores metadata, checksum, byte size, MIME type, object key, and generation status;
the bytes live in the existing private object storage. Re-rendering is a new document revision and
never overwrites an issued artifact.

Document statuses are `pending`, `ready`, and `failed`. A failed render is retryable and visible to
the operator; it does not change invoice or payment state. Download endpoints verify platform
capability or tenant ownership and return a signed URL valid for no more than five minutes.

## 6. Payments and 1C bank import

Manual payment records require invoice ID, paid date, exact amount, currency, bank reference, and
operator actor. They use an idempotency key and cannot be duplicated for one invoice.

The payment registry stores:

- import batch metadata and source checksum;
- each parsed bank row with stable source row identity;
- parser version and raw bounded source fields;
- candidate invoice matches and match reasons/scores;
- final decision: `unmatched`, `suggested`, `matched`, `rejected`, or `needs_review`.

The first parser targets 1C ClientBankExchange text exports. Parsing is strict about encoding,
record boundaries, dates, amounts, currency, and bounded field lengths. A malformed row is retained
as a row-level error; it does not discard valid rows from the batch.

Automatic matching considers exact invoice number/reference first, then tenant identifier,
amount, currency, and payment date. Ambiguous or conflicting candidates never auto-apply. Manual
resolution is explicit and audited. Matching a payment confirms the invoice payment in the same
transaction and emits one immutable payment/application event.

## 7. Access and audit

- Platform admins and accountants can create, issue, download, import, match, and confirm within
  their existing capability policy.
- Support can view operational invoice state only if explicitly granted billing read access; it
  cannot see bank references or perform financial mutations by default.
- Tenant users can list and download only invoices belonging to their tenant, with no platform
  audit, bank-import rows, or other tenants' data.
- Every mutation records actor, tenant, target, action, outcome, and bounded metadata.
- No raw secrets, session tokens, bank credentials, or unbounded imported payloads enter logs or
  audit metadata.

## 8. Data flow

```text
profile -> draft invoice -> issue snapshot -> render PDF/HTML -> download
                                  |
                                  v
                       payment registry (manual or 1C import)
                                  |
                       match / manual resolve / confirm
                                  |
                                  v
                  invoice paid -> apply catalog-linked lines
                                  |
                                  v
                subscription events + ordered services + audit
```

All transitions are transactionally idempotent. Object storage and rendering are retried through
an outbox/job boundary; database state remains authoritative if storage is temporarily unavailable.

## 9. Acceptance criteria

1. An operator can create and issue a direct invoice for a tenant with mixed catalog and custom
   lines, VAT, frozen profiles, and selected application policy.
2. Issued invoice content and its PDF remain unchanged after either party's profile or catalog
   data changes.
3. Manual payment confirmation is idempotent and records exact amount/date/reference.
4. A valid 1C ClientBankExchange import produces parsed rows; exact matches are suggested or
   applied according to policy, while ambiguous rows require manual resolution.
5. A paid invoice applies plan/add-on lines only once and respects immediate/after-current/manual
   policy, with subscription history events.
6. Tenant users can see and download only their own issued invoices; platform users can manage the
   registry according to capability.
7. Failed document rendering or storage does not lose invoice/payment history and is retryable.
8. Cross-tenant access, duplicate imports, duplicate payments, changed snapshots, and malformed
   bank rows have focused tests.
