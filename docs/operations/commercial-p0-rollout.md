# Commercial P0 rollout and recovery

This guide covers the [approved P0 design](../superpowers/specs/2026-09-10-commercial-p0-design.md).
It does not authorize a production deployment or historical data correction. Module enforcement,
offline licensing grants and device admission changes belong to P1; recurring service accounting
belongs to P2. National Catalog is not a separately sold module. P0 does not implement the new
combined Chestny ZNAK/National Catalog enforcement policy.

## Deployment order and API compatibility

1. Back up the production database and record the exact source, migration journal, artifact
   manifest and current client versions using the established protected deployment workflow.
2. Apply additive migration `0128_commercial_terms.sql`. Keep existing nulls and frozen snapshots;
   do not derive an annual term from a printed unit or a seller tax regime from legal form.
3. Deploy the compatible API before updated SaaS clients. Confirm platform authorization,
   capabilities, tenant denial and recovery routes with the normal release checks.
4. Upgrade every platform client that consumes catalog, tenant plan/add-on selectors, billing
   requests, profiles, offers or invoices before publishing the first zero-quota plan. Verify
   request and response negotiation, including nested models. Inventory custom integrations
   separately; the database report cannot prove which client binaries are deployed.
5. Run and review the read-only impact report. Review seller policy and each new catalog version
   explicitly. Publish only approved terms under the current seller revision, then exercise a
   controlled invoice/offer and payment application with separately authorized production actors.

Updated clients send `X-Markiro-Commercial-Version: 2`. Omission selects the strict legacy body
and response; unknown version values fail with `400 commercial_version_unsupported`. Legacy
positive quotas and null unlimited values remain truthful, and introduced metadata is omitted
from legacy projections. Historical snapshots and audit before/after payloads remain opaque.
Zero cannot be represented by the legacy contract: affected reads or writes return
`409 client_update_required`, before business mutation. Zero is never converted to null.
The current OpenAPI declares the header and both schema representations; the header selects the
applicable branch, so an `anyOf` in generated documentation is not permission to mix versions.

Invoice and offer calculated prices, line subtotals, VAT and document totals must fit
`numeric(14,2)` (maximum RUB 999999999999.99). Schema-valid unit prices can still overflow after
quantity, VAT or summation. Such input returns `400 commercial_amount_out_of_range` and the
transaction leaves no partial document. Invoices retain their existing truncation of fractional
kopecks; offers retain half-up rounding. Accepted offer conversion copies its validated frozen
breakdown. This change does not reprice or normalize historical money.

New document plan composition is zero/one line or exactly two in frozen order
`on_application` then `after_current`, with quantity one each. Additional add-ons/services remain
supported. Other sequences fail draft validation or issuance review. Existing issued documents
remain readable; `commercial_plan_sequence_review_required` blocks entitlement mutations without
rewriting their lines. Select the first plan before the renewal when applying a partial invoice.
If a previous partial application already delivered the later term, preserve it and obtain an
explicit commercial correction; do not cancel it by applying an earlier immediate line. Actual
invoice payments and existing application successes remain recorded; unfulfilled lines retain the
established failed-application/retry audit flow. Direct-offer payment remains transactional.

The catalog review shows one-unit price, VAT and payable total per period. Invoice and offer totals
are separately labeled where their established rounding differs, including an included-VAT split.
Refresh stale reviewed price/period/tax data before confirming publication.

## Read-only impact report

Run with an explicitly selected, authorized database environment. Local verification uses only
isolated fixtures. The wrapper builds the API and dependencies before executing the standalone
CLI; it does not start the application or background jobs:

```sh
corepack pnpm --filter @markiro/api report:commercial-p0-impact
```

The report executes one PostgreSQL repeatable-read, read-only transaction. Output is JSON with
`version: 1` and categories containing `count` and sorted `ids`. It emits no names, amounts, tax
identifiers, banking fields, contacts, tokens or connection strings. Failures emit a fixed safe
message and a nonzero exit status. No repair argument exists. Restrict storage/access to even
these row identifiers and record the source SHA and observation time outside the report.

| Category                                               | Identifier and interpretation                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `annualUnitMonthlyPeriod`                              | Catalog version ID with structured month period and a recognized annual unit hint (`year`, `annual`, `yearly`, `год`, `года`, `лет`, `г.`); review candidate, never an inferred correction. Other free-form unit spellings need manual review. |
| `missingDocumentNameRu`, `missingDocumentNameEn`       | Catalog version ID lacking the respective document name. Current P0 document renderers are Russian-only; an English name is retained for future English generation and is not required for Russian issuance.                                   |
| `missingCatalogReview`                                 | Catalog version ID missing subject or seller-policy revision.                                                                                                                                                                                  |
| `missingSellerPolicy`                                  | Existing seller-profile revision row ID with null policy. No seller rows means configuration must still be created; a zero count is not seller readiness. Historical revisions stay unchanged.                                                 |
| `nullEndedPaidSubscriptions`                           | Subscription ID with an explicit paid invoice/offer source and no end. Manual source does not prove payment and is not classified as paid.                                                                                                     |
| `legacyUnrepresentablePlans`                           | Plan version ID containing at least one zero resource quota. These are upgrade candidates, not observed client versions or a count of installed clients. Includes drafts so rollout can precede publication.                                   |
| `legacyLicenseInvoiceLines`, `legacyLicenseOfferLines` | Plan/add-on line IDs lacking authoritative commercial terms. Never infer a period from their unit label.                                                                                                                                       |
| `frozenOfferAmountMismatch`                            | Frozen print snapshot ID where subtotal plus VAT disagrees with total, or all saved line totals are numeric and their sum disagrees with the saved total.                                                                                      |
| `frozenOfferTaxReview`                                 | Frozen print snapshot ID with taxable lines lacking saved line VAT/subtotal, or a non-array line snapshot. Insufficient tax evidence is not proof of the correct replacement amount.                                                           |

Categories can overlap; their counts must not be summed into a count of affected sales. A clean
report does not prove legal tax eligibility, all possible malformed legacy representations,
absence of other free-text unit anomalies, client deployment or P1 enforcement readiness.

## Historical documents and operator recovery

Issued invoice snapshots, offer print snapshots and stored PDF/HTML bytes are immutable. Do not
regenerate them from today's catalog/profile or rerun application with a new date to repair a
legacy anomaly. A paid interval uses application time for immediate activation, or the current
term end for after-current activation; original calendar anchors are persisted and reused on
retry. Trial configuration stays positive-days-or-null and is independent of resource zero.

Old offer publication could save subtotal equal to total and VAT equal to zero even when line
amounts carried exclusive VAT. Conversion validates the frozen source; conflicting or
insufficient historical terms return `409 commercial_source_review_required` before new writes.
Keep the original document and payment evidence, record the safe row IDs, and have the responsible
commercial/accounting owner approve a correction procedure separately. Do not edit the old
snapshot, bypass customer acceptance, silently guess tax, or submit the same sale through the
other application path. `commercial_sale_already_fulfilled` protects cross-path ownership;
repeated successful application returns its original interval rather than granting twice.

`commercial_review_stale` requires refreshing the current seller/catalog review and asking the
operator to review the changed terms. It does not authorize automatic tax replacement. Preserve
entered draft fields on an error. Existing customer read/export, profile maintenance and
eligible station/kiosk recovery policies remain in force; subscription expiry does not turn every
POST into prohibited new work. Production restrictions and recovery acceptance must still be
verified through the affected surface's release checks.

## Rollback limits

Migration 0128 is additive but loosens resource checks to permit zero and introduces nullable
metadata and frozen period evidence. An older API cannot truthfully serve zero quotas. Do not
roll back consumers behind an already published zero-quota catalog, drop new columns, rewrite
snapshots or restore strictly-positive constraints while zero rows exist. Archive/retirement does
not erase referenced historical versions and is not a schema rollback.

Pause new commercial publication/issuance through the established operational process, retain the
compatible API, and deploy a forward fix when new values have been used. Preserve payment and
application journals, sold-line ownership, pending work and stored document objects. A database
restore is a separate disaster-recovery decision requiring reconciliation of payments and work
accepted after the backup; it is not a safe routine downgrade. No strict enforcement toggle is
introduced or enabled by this local implementation.

## Acceptance boundaries

The [P0 acceptance map](commercial-p0-acceptance.md) names automated tests and local browser/PDF
observations. Full workspace checks use an explicitly owned local environment; conditional
infrastructure smoke is not production proof. Production rollout, real bank/provider access,
actual NPD eligibility, legal approval, hardware, offline grants and factory installation remain
separate approval and acceptance gates. Final task and whole-branch review must finish before
calling this change ready for publication.
