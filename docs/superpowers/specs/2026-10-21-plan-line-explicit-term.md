# Plan line with an explicit term (dates + fixed amount)

Status: approved by the owner and implemented on 2026-10-21 (branch
`claude/saas-invoice-quantity-tariff-14690c`, not pushed). «Вручную» = the existing manual
application of an issued invoice.

## Problem

In the platform-admin invoice/offer composer a base-plan line has quantity locked to 1 and its
unit is the catalog billing period («Месяц»). Operators cannot sell a plan for an arbitrary term
and amount, e.g. 70 000 ₽ for 01.11.2026 – 27.05.2027. «1 × Месяц» is also wrong for such a line.

The lock is deliberate (commercial-p0 design: «plan line quantity is exactly one»; catalog
requirements: multiple terms need an explicit period selection, not quantity multiplication). It
is enforced in the composer, `freezeCommercialLineTerms`, `validateCommercialIssuance`, the
lifecycle service and DB checks. So the fix is a new explicit term, not an unlocked quantity.

## Decisions (owner, 2026-10-21)

1. Term is an inclusive civil date range in `Europe/Moscow`: «по 27 мая» = access through the end
   of 27 May.
2. Start of access is chosen on the line: automatic (applied on payment) or manual (operator
   applies), as today's activation rules; the date range is authoritative either way.
3. No cap on length, no ban on a start date in the past.
4. Renewal re-enters dates and amount; no proration, no auto-renew.
5. Quantity stays 1. The unit of a custom-term line is «период» / `term`, never «мес.».

## Design

### Terms and period (domain, contracts)

- `CommercialLineTerms` gets `version: 3` for plan lines with an explicit term:
  `billingPeriod: "custom"`, `termStart`, `termEnd` (`YYYY-MM-DD`, `termEnd >= termStart`),
  `billingTimezone: "Europe/Moscow"`, `activationRule` as today. Versions 1 and 2 are unchanged.
  Lines without dates keep version 1 and the catalog month/year behavior.
- `CommercialPeriod` gets a variant `billingPeriod: "custom"` with
  `startsAt = Moscow midnight of termStart`, `endsAt = Moscow midnight of termEnd + 1 day`, `cycle: 0`,
  `anchorAt = startsAt`. New domain helper `resolveExplicitCommercialPeriod`; the schema's
  refine re-derives boundaries from the stored dates like it does for month/year. Tests cover one-day,
  leap-year and month-end terms.
- Only `plan` lines may carry version 3 in this change. Add-ons keep month/year because their
  `endsAt` is bounded by the subscription term; revisit separately.

### Persistence

- New migration widening `commercialLineTermsCheck` (version 3 branch, `quantity = 1` for plan)
  and `commercialPeriodCheck` (`custom` branch) on invoice/offer lines and subscription periods.
  Existing rows are untouched; do not edit applied migrations. Update schema and migration tests.

### API

- Invoice and offer line input carries the term inside `commercialTerms` (version 3 with
  `termStart`/`termEnd`) on plan lines. Absent ⇒ current behavior. `freezeCommercialLineTerms` freezes it as version 3; supplied terms that disagree
  with the resolved terms still yield `commercial_review_stale`.
- `agreedUnitPrice` is the whole-term amount (quantity is 1). Offers keep requiring the price override reason when the price differs from the catalog (invoices
  never did); the catalog month price is shown only as a
  hint.
- `paidPeriod` in the lifecycle service returns the explicit period for version 3 (no cycle
  arithmetic); start/end of the subscription come from it. `after_current` with a custom term
  schedules from the dates and must not overlap the current term (`subscription_timeline_changed`
  style conflict), not silently shift them.
- Print model: unit «период»; description/term text prints «с 01.11.2026 по 27.05.2027» instead of
  «1 мес.»/«1 год». Stored snapshots of old documents are replayed unchanged. The stored line unit is `period`.
- Audit entries for issuance/application include the term dates.

### saas-admin

- Plan line shows «Действует с / по» date inputs (prefilled from catalog month on add, so the
  default flow is unchanged), the amount field, the activation selector, and unit «период» when
  dates are custom. Quantity stays disabled with a hint. Validation: both dates required, end ≥
  start. i18n in ru/en. Offer composer shares `DocumentLinesTable`.
- Offer-sourced invoices keep inheriting terms from the offer line.

### Out of scope

Proration, auto-renewal, add-on custom terms, tenant-cabinet billing display beyond showing the
dates, any change to the quantity rule for add-ons/services.

## Verification plan

Failing tests first: domain period helper; contracts schema (strict, version 3, bad ranges);
db check/migration; API freeze/issuance/lifecycle for 01.11–27.05 at 70 000 incl. cross-tenant and
exact audit assertions; print model snapshot; saas-admin composer test and the
`tools/production-browser` saas-admin offers/invoice specs (UI behavior change). Package gates:
domain, platform-contracts, db (build before consumers), api, saas-admin. Real payment/activation
and PDF rendering are not verified by these automated checks.

## Implementation notes

- A start date in the past activates immediately at the term's own start; a future start is
  `scheduled`. A term overlapping the current base term or an already scheduled one is rejected
  (`subscription_term_overlaps_current`, `subscription_schedule_exists`).
- The existing 10-year ceiling of `validateTerm` still applies; no new cap was added.
- Not exercised by automated checks: browser run of saas-admin and its `tools/production-browser`
  specs, real payment/activation, PDF rendering.

## Open points for the owner

- «Вручную» for a custom term: confirm it maps to the existing manual application of an issued
  invoice (operator picks when to apply) rather than a new status.
- Should a paid custom-term plan be allowed to start before today (backdating) without extra
  confirmation? Decision 3 says yes; the UI will only show a notice.
