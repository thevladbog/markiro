# Commercial P0: approved design

Approved by the product owner on 2026-09-10 after review of the three [interface alternatives](../../design-briefs/2026-09-10-commercial-p0-interface-options.md). Binding requirements: [MKR-FR-COMMERCIAL-002 v1.2](2026-09-10-catalog-entitlements-functional-requirements.md). Baseline: `9cdd7f634949fde28528f4ca172ac8ed9769796a`.

## Scope

Deliver P0 across catalog contracts/storage, SaaS administration, offers, invoices, confirmed payment application and generated commercial documents. Preserve current authentication, authorization, locking, audit and document ownership. P1 module enforcement/offline grants and P2 service accounting are separate projects; this change does not switch on those restrictions or publish live plans.

One `chzIntegration` commercial module includes National Catalog access. Start has a paid add-on; Workshop/Production include it in the illustrative fixtures. Operational capabilities and release eligibility remain distinct. No separate National Catalog commercial switch is introduced.

## Boundaries

Use explicit operations on existing services: edit a draft, review/publish a catalog version, issue a reviewed invoice, apply confirmed payment. Existing routes may gain negotiated representations; there is no second catalog or billing subsystem. Shared pure calculations belong in `@markiro/domain`; runtime request/response authority remains `@markiro/platform-contracts`.

The catalog owns published terms. Commercial lines own frozen descriptions, exact prices, taxes, seller-policy provenance and license activation intentions. Existing lifecycle and application journals own activation. Both invoice application and legacy paid-offer application must use the same paid-license rules. There must be one fulfillment of a sold line even when an offer also produces an invoice.

## Quotas and quantities

Resource quotas are nonnegative PostgreSQL integers or null. Zero means not included; null means unlimited. Trial days remain positive integers or null, where null disables automatic trial configuration. Add-on increments stay strictly positive. Plan line quantity is exactly one; add-on quantity counts resources rather than subscription periods. Services retain their one-time quantity/unit behavior.

Forms explicitly choose Not included / Limited / Unlimited. Empty Limited inputs fail; no empty-to-unlimited conversion. Requests, responses, database checks and all consumers share the meanings. New migrations preserve existing null values and historical records.

A sale may contain zero or one plan line, or exactly two plan lines in frozen document order:
`on_application`, then `after_current`. Add-ons and services do not count toward this pair.
Other multiple-plan sequences require correction before creating/issuing a new document; neither
reordering nor replacing frozen activation intentions is permitted. Partial application must apply
the first purchased plan before its renewal. Under the tenant timeline and subscription row locks,
a line cannot replace or cancel another purchased term from the same sale. Already-issued
ambiguous/partially applied sales stay readable and require explicit commercial review; invoice
payment facts and existing success records remain intact while remaining lines record failure.

## Calendar and activation

New paid intervals are `[startsAt, endsAt)` in `Europe/Moscow`. Persist the original anchor, billing period, cycle and policy version. Each boundary is derived from that anchor; clamp an absent day to month end without changing the original day. January 31 renews through February 28 to March 31; a February 29 annual anchor returns to February 29 in a leap year.

Immediate activation starts at the server time of applying confirmed payment. Delayed manual application does not backdate the purchased term to the bank payment date. After-current activation starts at the current term end. Repeated application returns the same stored interval. A new monthly add-on on an annual plan has its own paid interval while effective new-work permission remains within its base subscription. Never derive calendar terms from `unit`.

Before an unknown activation date, issued documents contain the agreed period and activation rule. Once activation occurs, its immutable record stores exact dates linked to the sold line; later views/documents can show them. Issued document snapshots never change. Historical records without authoritative term data are legacy; inspect them and require an explicit future correction rather than infer a year from a unit label.

## Seller policy and document wording

The seller profile gains explicit versioned tax policy. Existing records without policy remain unconfigured until reviewed; do not infer a tax regime from legal form or silently assign it in a migration. NPD permits Without VAT in the covered scope, distinct from zero-rated VAT. Other supported configurations contain explicit allowed/default VAT values. The editor loads defaults from this profile.

Catalog versions have separate Russian/English document names and a sale subject (`software_license`, `service`, `development_work`). Plan/add-on subjects are licenses. Existing versions retain readable legacy fallbacks with a review marker; new publications require valid Russian document naming, explicit seller policy and consistent terms. English document generation requires an English document name. Controlled descriptions never execute user-entered templates.

Publication and document issuance re-read current state under established locks. Preview/revision mismatch fails with a structured conflict. A changed seller policy requires explicit review, not automatic repricing or tax replacement. Snapshots include the resolved line name, subject and tax-policy provenance. Reprints use those bytes/data even after catalog or seller changes.

## Compatibility and rollout

Keep a truthful legacy representation and negotiate the commercial representation for updated clients. A legacy parser must not receive unknown fields or unsupported zero values; zero must never become null. For an unrepresentable operation return an explicit update-required error using the existing safe envelope. Preserve safe historical reads and device recovery.

Use nullable additive columns and versioned snapshots, with strict runtime validation and relevant database checks. Do not rewrite issued snapshots or existing subscription terms. A read-only impact report identifies annual-label/monthly-term anomalies, missing seller policy/document names, null-ended paid subscriptions and clients requiring an upgrade. New corrected sales are enabled only after consumers are ready; production rollout/data migration is not authorized by local implementation.

## UI and error behavior

Extend existing drawers/pages using `@markiro/ui` and current Russian/English translations. Display actual billing period alongside price, derive license unit labels, preserve entered values on validation failures and dirty-close behavior. Show publication/issuance validation before mutation; server validation remains decisive. Seller-policy absence leads to a configuration explanation, never a fallback hardcoded tax rate.

Catalog live summaries and publication review show price, VAT and payable amount for one unit of
the displayed period. Existing invoice fractional-kopeck truncation and offer half-up rounding
remain distinct: when VAT or totals differ, label both invoice and offer results explicitly.
A stale review refreshes the price, period and calculated amounts together.

No unrelated redesign. Catalog names, document names, period, quota modes and tax choices are the changes necessary for P0. Service recurrence remains unavailable until P2.

## Verification

Focused failing tests precede each rule change. Cover exact calendar boundaries, leap years, malformed values, zero/null/trial distinction, annual totals, quantity semantics, seller-policy changes, naming, immutable reprints, both payment paths, retries and concurrency. Verify exact audit actor/tenant/target/result. Run contracts and migration tests, isolated database-backed API tests and relevant full package gates. Rebuild shared exports before consumers.

Browser checks exercise create/edit/clone, publication and document issue flows at desktop and narrow widths in both locales; document rendering is checked separately. Production, real payments, tax eligibility, provider access and hardware are external acceptance, not inferred from local tests.

## Authorized working scope

Implement and verify in `codex/catalog-entitlements`. Preserve the original checkout and unrelated work. Commit, push, PR, deployment and cleanup require their separately authorized scope; this approval does not authorize those actions.
